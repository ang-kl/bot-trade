// Connect — wire the UI to the agent backend and link a cTrader account.
// The cTrader flow is two taps: paste token → pick an account. The agent
// discovers the accounts from the token and auto-builds the symbol map.
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

  const [token, setToken] = useState('')
  const [accounts, setAccounts] = useState(null)      // null = not loaded yet
  const [linking, setLinking] = useState(false)
  const [linked, setLinked] = useState(null)          // { accountId, isLive, symbolsMapped }
  const [symbolCount, setSymbolCount] = useState(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    // Show current linkage state (best effort).
    agentGet('/state/symbol-map').then(r => {
      if (r?.map) setSymbolCount(Object.keys(r.map).length)
    }).catch(() => {})
  }, [])

  const flash = (msg) => { setStatus(msg); setError(''); setTimeout(() => setStatus(''), 4000) }

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

  const loadAccounts = async () => {
    if (!token.trim()) { setError('Paste your access token first'); return }
    setLinking(true)
    setAccounts(null)
    setLinked(null)
    try {
      const r = await agentPost('/actions/ctrader-token', { accessToken: token.trim() })
      setAccounts(r.accounts || [])
      if ((r.accounts || []).length === 0) setError('Token accepted but no trading accounts found on it')
    } catch (e) { setError(e.message) } finally { setLinking(false) }
  }

  const selectAccount = async (a) => {
    setLinking(true)
    try {
      const r = await agentPost('/actions/ctrader-select-account', { accountId: a.accountId, isLive: a.isLive })
      setLinked(r)
      setSymbolCount(r.symbolsMapped)
      setToken('')
      flash(`Linked account ${r.accountId} (${r.isLive ? 'LIVE' : 'demo'}) — ${r.symbolsMapped} symbols mapped automatically`)
    } catch (e) { setError(e.message) } finally { setLinking(false) }
  }

  return (
    <div className="space-y-4">
      {error && <Card className="border-[var(--color-down)] text-[13px]">{error}</Card>}
      {status && <div className="text-[13px] text-[var(--color-info-text)]">{status}</div>}

      {/* Agent connection */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-2">1 · Agent backend</h2>
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
          One-tap setup link: <code>{'{site}'}/#{'{secret}'}</code> (or full form <code>{'{site}'}/connect#agent={'{agent-url}'}&secret={'{secret}'}</code>). The #fragment never leaves the browser — share it like a password.
        </p>
      </Card>

      {/* cTrader */}
      <Card>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[13px] font-semibold">2 · cTrader account</h2>
          {symbolCount != null && symbolCount > 0 && <Badge tone="up">LINKED — {symbolCount} symbols mapped</Badge>}
        </div>

        <label className="block text-[12px]">
          <span className="text-[var(--color-text-sub)]">Access token (from openapi.ctrader.com — authorize once, paste here)</span>
          <div className="mt-1 flex gap-2">
            <Input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Spotware OAuth access token" className="flex-1" />
            <Button size="sm" onClick={loadAccounts} disabled={linking}>{linking && !accounts ? 'Loading…' : 'Load accounts'}</Button>
          </div>
        </label>

        {accounts && accounts.length > 0 && (
          <div className="mt-3">
            <div className="text-[12px] text-[var(--color-text-sub)] mb-1.5">Tap the account the bot should trade with:</div>
            <div className="space-y-1.5">
              {accounts.map(a => (
                <button
                  key={a.accountId}
                  type="button"
                  disabled={linking}
                  onClick={() => selectAccount(a)}
                  className={`flex w-full items-center gap-3 rounded-[7px] border px-3 py-2 text-left text-[13px] cursor-pointer hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] ${
                    linked?.accountId === a.accountId ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'
                  }`}
                >
                  <Badge tone={a.isLive ? 'down' : 'info'}>{a.isLive ? 'LIVE' : 'DEMO'}</Badge>
                  <span className="font-semibold">{a.traderLogin ? `Login ${a.traderLogin}` : `Account ${a.accountId}`}</span>
                  {a.brokerTitle && <span className="text-[var(--color-text-sub)]">{a.brokerTitle}</span>}
                  <span className="ml-auto font-semibold">{a.balance != null ? `$${Number(a.balance).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ''}</span>
                  <span className="text-[var(--color-text-sub)]">id {a.accountId}</span>
                  {linked?.accountId === a.accountId && <Badge tone="up">SELECTED</Badge>}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-[var(--color-warning-text)]">
              Start with a DEMO account. Picking it also downloads the broker's full symbol list automatically — no manual IDs needed.
            </p>
          </div>
        )}

        <p className="mt-2 text-[12px] text-[var(--color-text-sub)]">
          The token is stored in the agent's database, never in this browser.
        </p>
      </Card>
    </div>
  )
}
