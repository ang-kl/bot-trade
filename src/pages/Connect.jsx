// Connect — wire the UI to the agent backend, push cTrader credentials,
// and maintain the symbol → cTrader symbolId map.
import { useEffect, useState } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import Input from '../components/common/Input.jsx'
import { getAgentConn, setAgentConn, clearAgentConn, agentGet, agentPost } from '../lib/agent-api.js'

export default function Connect() {
  const conn = getAgentConn()
  const [url, setUrl] = useState(conn.base)
  const [secret, setSecret] = useState(conn.secret)
  const [testResult, setTestResult] = useState(null)

  const [ctrader, setCtrader] = useState({ accessToken: '', accountId: '', isLive: false })
  const [symbolMapText, setSymbolMapText] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    // Pre-fill the symbol map editor from current agent state (best effort).
    agentGet('/state/symbol-map').then(r => {
      if (r?.map) setSymbolMapText(JSON.stringify(r.map, null, 2))
    }).catch(() => {})
  }, [])

  const flash = (msg) => { setStatus(msg); setError(''); setTimeout(() => setStatus(''), 3000) }

  const saveConn = () => {
    setAgentConn({ url, secret })
    flash('Connection saved (stored in this browser)')
  }

  const testConn = async () => {
    setTestResult(null)
    try {
      const base = url.trim().replace(/\/+$/, '')
      const res = await fetch(`${base}/health`)
      const j = await res.json()
      setTestResult({ ok: res.ok, detail: `status=${j.status} loop#${j.loopCount} uptime=${Math.round(j.uptime / 60)}m` })
    } catch (e) {
      setTestResult({ ok: false, detail: e.message })
    }
  }

  const pushCtrader = async () => {
    try {
      if (!ctrader.accessToken) { setError('Access token is required'); return }
      const body = { accessToken: ctrader.accessToken }
      if (ctrader.accountId) {
        body.accounts = [{ accountId: ctrader.accountId, isLive: ctrader.isLive, autopilot: true }]
      }
      await agentPost('/actions/ctrader-config', body)
      setCtrader({ accessToken: '', accountId: '', isLive: false })
      flash('cTrader credentials pushed to agent')
    } catch (e) { setError(e.message) }
  }

  const pushSymbolMap = async () => {
    try {
      const map = JSON.parse(symbolMapText)
      const r = await agentPost('/actions/symbol-map', { map })
      flash(`Symbol map saved (${r.count} symbols)`)
    } catch (e) {
      setError(e instanceof SyntaxError ? 'Symbol map must be valid JSON, e.g. {"EURUSD": 1, "XAUUSD": 41}' : e.message)
    }
  }

  return (
    <div className="space-y-4">
      {error && <Card className="border-[var(--color-down)] text-[13px]">{error}</Card>}
      {status && <div className="text-[13px] text-[var(--color-info-text)]">{status}</div>}

      {/* Agent connection */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-2">Agent backend</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[12px]">
            <span className="text-[var(--color-text-sub)]">Agent URL</span>
            <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://your-agent-host.example.com" />
          </label>
          <label className="block text-[12px]">
            <span className="text-[var(--color-text-sub)]">Agent secret (AGENT_SECRET)</span>
            <Input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder="shared secret" />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={saveConn}>Save</Button>
          <Button size="sm" variant="ghost" onClick={testConn}>Test connection</Button>
          <Button size="sm" variant="subtle" onClick={() => { clearAgentConn(); setUrl(''); setSecret(''); flash('Cleared — falling back to build-time env vars') }}>Clear</Button>
          {testResult && (
            <Badge tone={testResult.ok ? 'up' : 'down'}>{testResult.ok ? `REACHABLE — ${testResult.detail}` : `FAILED — ${testResult.detail}`}</Badge>
          )}
        </div>
        <p className="mt-2 text-[12px] text-[var(--color-text-sub)]">
          Stored in this browser's localStorage. Falls back to the VITE_AGENT_URL / VITE_AGENT_SECRET build-time env vars when empty.
        </p>
      </Card>

      {/* cTrader */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-2">cTrader account</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-[12px]">
            <span className="text-[var(--color-text-sub)]">Access token</span>
            <Input type="password" value={ctrader.accessToken} onChange={e => setCtrader(c => ({ ...c, accessToken: e.target.value }))} placeholder="Spotware OAuth access token" />
          </label>
          <label className="block text-[12px]">
            <span className="text-[var(--color-text-sub)]">ctidTraderAccountId</span>
            <Input value={ctrader.accountId} onChange={e => setCtrader(c => ({ ...c, accountId: e.target.value }))} placeholder="e.g. 41112345" />
          </label>
          <label className="flex items-end gap-2 text-[12px] pb-2">
            <input type="checkbox" checked={ctrader.isLive} onChange={e => setCtrader(c => ({ ...c, isLive: e.target.checked }))} />
            <span>Live account (unchecked = demo)</span>
          </label>
        </div>
        <div className="mt-3">
          <Button size="sm" onClick={pushCtrader}>Push to agent</Button>
        </div>
        <p className="mt-2 text-[12px] text-[var(--color-text-sub)]">
          Get a token from the Spotware Open API portal (openapi.ctrader.com). The token is stored in the agent's database, never in this browser.
        </p>
      </Card>

      {/* Symbol map */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-2">Symbol → cTrader ID map</h2>
        <textarea
          value={symbolMapText}
          onChange={e => setSymbolMapText(e.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={'{\n  "EURUSD": 1,\n  "GBPUSD": 2,\n  "XAUUSD": 41\n}'}
          className="block w-full rounded-[7px] border bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] px-2.5 py-2 text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40"
        />
        <div className="mt-3">
          <Button size="sm" onClick={pushSymbolMap}>Save symbol map</Button>
        </div>
        <p className="mt-2 text-[12px] text-[var(--color-text-sub)]">
          The agent needs each symbol's numeric cTrader symbolId to fetch candles and place orders. Find IDs in the cTrader platform or via the Open API symbol list.
        </p>
      </Card>
    </div>
  )
}
