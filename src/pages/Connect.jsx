// Connect — wire the UI to the agent backend and link a cTrader account.
// The cTrader flow is two taps: paste token → pick an account. The agent
// discovers the accounts from the token and auto-builds the symbol map.
import SectionNavFab from '../components/common/SectionNavFab.jsx'
import { useEffect, useState } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import Input from '../components/common/Input.jsx'
import WatchlistCompare from '../components/watchlist/WatchlistCompare.jsx'
import { getAgentConn, setAgentConn, clearAgentConn, agentGet, agentPost } from '../lib/agent-api.js'
import { writeSelection } from '../lib/selected-account.js'


export default function Connect() {
  const conn = getAgentConn()
  const [url, setUrl] = useState(conn.base)
  const [secret, setSecret] = useState(conn.secret)
  const [testResult, setTestResult] = useState(null)
  const [tgSent, setTgSent] = useState(false)
  const [tgCode, setTgCode] = useState('')

  const [token, setToken] = useState('')
  const [accounts, setAccounts] = useState(null)      // null = not loaded yet
  const [linking, setLinking] = useState(false)
  const [linked, setLinked] = useState(null)          // { accountId, isLive, symbolsMapped }
  const [symbolCount, setSymbolCount] = useState(null)
  const [broker, setBroker] = useState({})        // accountId -> full broker snapshot (positions, orders)
  const [openDetail, setOpenDetail] = useState(null) // accountId whose trade detail is expanded
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    // Show current linkage state (best effort).
    agentGet('/state/symbol-map').then(r => {
      if (r?.map) setSymbolCount(Object.keys(r.map).length)
    }).catch(() => {})
    // If the agent already holds a token, re-list the accounts so the picker
    // is always visible — it must survive reloads and navigation.
    agentPost('/actions/ctrader-accounts').then(r => {
      if (r?.accounts?.length) {
        setAccounts(r.accounts)
        if (r.selectedAccountId) setLinked({ accountId: Number(r.selectedAccountId) })
      }
    }).catch(() => {})
    // Full broker snapshot per account (best effort, slower call) — powers
    // the equity figure, the live/set/profit/loss chips, and the expanders.
    agentPost('/actions/broker-positions').then(r => {
      const m = {}
      for (const acct of r?.accounts || []) m[acct.accountId] = acct
      setBroker(m)
    }).catch(() => {})
  }, [])

  // OAuth callback: Spotware redirects back with ?code=... after the user
  // logs in. Exchange it for a token server-side, hand the token to the
  // agent, and show the account picker — zero manual token handling.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    if (!code) return
    window.history.replaceState(null, '', window.location.pathname)
    ;(async () => {
      setLinking(true)
      try {
        const redirectUri = `${window.location.origin}/link-up`
        const ex = await fetch('/api/ctrader', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'exchange-token', code, redirectUri }),
        }).then(r => r.json())
        if (ex.error) throw new Error(ex.error)
        const r = await agentPost('/actions/ctrader-token', { accessToken: ex.accessToken })
        setAccounts(r.accounts || [])
        flash('cTrader connected — now tap the account the bot should trade')
      } catch (e) {
        setError(`cTrader connect failed: ${e.message}`)
      } finally {
        setLinking(false)
      }
    })()
  }, [])   

  const startOAuth = async () => {
    setError('')
    try {
      const r = await fetch('/api/ctrader?action=auth-url').then(x => x.json())
      if (r.error) throw new Error(r.error)
      window.location.href = r.url
    } catch (e) {
      setError(`Could not start cTrader login: ${e.message}`)
    }
  }

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
      setTestResult({ ok: res.ok, detail: `${j.version ? `v${j.version} ` : ''}status=${j.status} loop#${j.loopCount} uptime=${Math.round(j.uptime / 60)}m` })
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
    // LIVE accounts hold real money — make switching to one deliberate.
    // (Backtests and charts are read-only either way; this gates what
    // autotrade and manual orders would act on.)
    if (a.isLive) {
      const word = window.prompt(
        `⚠ ${a.traderLogin ? `Login ${a.traderLogin}` : `Account ${a.accountId}`} is a LIVE account with REAL money.\n\n` +
        'Backtests and charts never trade — but if you later arm Autotrade or place a manual order, it will use REAL funds on this account.\n\n' +
        'Type LIVE to confirm, or Cancel to pick a DEMO account instead.'
      )
      if (word !== 'LIVE') return
    }
    setLinking(true)
    try {
      const r = await agentPost('/actions/ctrader-select-account', { accountId: a.accountId, isLive: a.isLive, traderLogin: a.traderLogin ?? null })
      // Tell the rest of the app (owner 2026-07-30: "I selected a different
      // account in connect, your header doesn't reflect"). This was the only
      // switch path that never wrote the shared cache, so the header, sidebar
      // and every polling page kept showing the previous account until a full
      // reload. One shared write point now serves both switch paths.
      writeSelection(a.accountId)
      setLinked(r)
      setSymbolCount(r.symbolsMapped)
      setToken('')
      flash(`Linked account ${r.accountId} (${r.isLive ? 'LIVE' : 'demo'}) — ${r.symbolsMapped} symbols mapped automatically`)
    } catch (e) { setError(e.message) } finally { setLinking(false) }
  }

  return (
    <div className="space-y-8">
      <SectionNavFab />
      {error && <Card className="border-[var(--color-down)] text-[9px]">{error}</Card>}
      {status && <div className="text-[9px] text-[var(--color-info-text)]">{status}</div>}

      {/* Agent connection */}
      <Card>
        <h2 className="t-h3 mb-2" id="sec-agent">1 · Agent Backend form</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[9px]">
            <span className="text-[var(--color-text-sub)]">Agent URL</span>
            <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://your-agent-host.example.com" />
          </label>
          <label className="block text-[9px]">
            <span className="text-[var(--color-text-sub)]">Agent secret (AGENT_SECRET) — paste the full secret for order/close/config control; the default here is read-only</span>
            <Input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder="shared secret" />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={saveConn}>Save</Button>
          <Button size="sm" variant="ghost" onClick={testConn}>Test connection</Button>
          {/* Approval-queue item 2: Clear wipes this browser's stored agent
              URL + secret — one mis-tap disconnected the UI from the bot. */}
          <Button size="sm" variant="danger" onClick={() => {
            if (!window.confirm('Clear the saved agent connection from THIS browser? The URL and secret are removed and the UI falls back to build-time defaults — you will need to re-enter them to reconnect. The bot itself keeps running.')) return
            clearAgentConn(); setUrl(''); setSecret(''); flash('Cleared — falling back to build-time env vars')
          }}>Clear</Button>
          {testResult && (
            <Badge tone={testResult.ok ? 'on' : 'off'}>{testResult.ok ? `REACHABLE — ${testResult.detail}` : `FAILED — ${testResult.detail}`}</Badge>
          )}
        </div>
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          <div className="text-[9px] text-[var(--color-text-sub)] mb-1.5">
            Or log in without typing the secret — the bot texts a code to your Telegram:
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!tgSent ? (
              <Button size="sm" onClick={async () => {
                setError('')
                try {
                  const base = url.trim().replace(/\/+$/, '')
                  if (!base) { setError('Enter the Agent URL first'); return }
                  const r = await fetch(`${base}/auth/telegram/request`, { method: 'POST' }).then(x => x.json())
                  if (r.error) throw new Error(r.error)
                  setTgSent(true)
                  flash('Code sent — check your Telegram')
                } catch (e) { setError(e.message) }
              }}>Send login code to my Telegram</Button>
            ) : (
              <>
                <Input value={tgCode} onChange={e => setTgCode(e.target.value)} placeholder="6-digit code" className="w-32" inputMode="numeric" />
                <Button size="sm" onClick={async () => {
                  setError('')
                  try {
                    const base = url.trim().replace(/\/+$/, '')
                    const r = await fetch(`${base}/auth/telegram/verify`, {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ code: tgCode.trim() }),
                    }).then(x => x.json())
                    if (r.error) throw new Error(r.error)
                    setAgentConn({ url: base, secret: r.token })
                    setSecret(r.token)
                    setTgSent(false)
                    setTgCode('')
                    flash('Logged in — this device is authorized for 90 days')
                  } catch (e) { setError(e.message) }
                }}>Verify & log in</Button>
                <Button size="sm" variant="subtle" onClick={() => { setTgSent(false); setTgCode('') }}>Cancel</Button>
              </>
            )}
          </div>
        </div>
        <p className="mt-2 text-[9px] text-[var(--color-text-sub)]">
          One-tap setup link: <code>{'{site}'}/#{'{secret}'}</code> (or full form <code>{'{site}'}/connect#agent={'{agent-url}'}&secret={'{secret}'}</code>). The #fragment never leaves the browser — share it like a password.
        </p>
      </Card>

      {/* cTrader */}
      <Card>
        <div className="flex items-center justify-between mb-2">
          <h2 className="t-h3" id="sec-ctrader">2 · cTrader Account form</h2>
          {symbolCount != null && symbolCount > 0 && <Badge tone="on">LINKED — {symbolCount} symbols mapped</Badge>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={startOAuth} disabled={linking}>{linking ? 'Connecting…' : 'Connect with cTrader'}</Button>
          <span className="text-[9px] text-[var(--color-text-sub)]">— log in with your normal cTrader ID; your accounts appear below.</span>
        </div>

        <details className="mt-3">
          <summary className="text-[9px] text-[var(--color-text-sub)] cursor-pointer">Advanced: paste an access token manually</summary>
          <div className="mt-2 flex gap-2">
            <Input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Spotware OAuth access token" className="flex-1" />
            <Button size="sm" variant="subtle" onClick={loadAccounts} disabled={linking}>Load accounts</Button>
          </div>
        </details>

        {accounts && accounts.length > 0 && (
          <div className="mt-3">
            <div className="text-[9px] text-[var(--color-text-sub)] mb-1.5">Tap the account the bot should trade with:</div>
            <div className="space-y-1.5">
              {accounts.map(a => {
                const b = broker[a.accountId]
                const positions = b?.positions || []
                const orders = b?.orders || []
                const pnlOf = (p) => Number(p.estNetPnl ?? p.estPnlQuote) || 0
                const floating = positions.reduce((s, p) => s + pnlOf(p), 0)
                const winners = positions.filter(p => pnlOf(p) > 0).length
                const losers = positions.filter(p => pnlOf(p) < 0).length
                const detailOpen = openDetail === a.accountId
                return (
                <div key={a.accountId} className={`rounded-[7px] border ${linked?.accountId === a.accountId ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
                  {/* Nested-interactive fix (inventory): the detail chip was a
                      span role=button INSIDE the account-select button —
                      Enter-only, and a mis-tap on its edge selected the
                      account. Now three sibling real <button>s in one row:
                      identity and balance both select (same handler, so the
                      clickable area is unchanged), the chip only toggles
                      detail and gets native Enter AND Space + aria-expanded. */}
                  <div className="flex w-full items-center gap-3 px-3 py-2 text-[9px] rounded-[7px] hover:bg-[var(--color-accent-soft)]">
                    <button
                      type="button"
                      disabled={linking}
                      onClick={() => selectAccount(a)}
                      className="flex flex-1 items-center gap-3 text-left cursor-pointer min-w-0"
                    >
                      <Badge tone={a.isLive ? 'down' : 'info'}>{a.isLive ? 'LIVE' : 'DEMO'}</Badge>
                      <span className="font-semibold">{a.traderLogin ? `Login ${a.traderLogin}` : `Account ${a.accountId}`}</span>
                      {a.brokerTitle && <span className="text-[var(--color-text-sub)]">{a.brokerTitle}</span>}
                    </button>
                    {b && (
                      <button
                        type="button"
                        aria-expanded={detailOpen}
                        onClick={() => setOpenDetail(detailOpen ? null : a.accountId)}
                        className="inline-flex items-center gap-2 text-[9px] glass-inset rounded-[var(--radius-control)] px-2.5 py-1 cursor-pointer hover:shadow-[var(--glow-accent)]"
                        title="Tap for per-trade detail"
                      >
                        <span>{positions.length} live · {orders.length} set</span>
                        {positions.length > 0 && (
                          <span>
                            <span className="text-[var(--color-up)] font-semibold">{winners}▲</span>
                            {' '}
                            <span className="text-[var(--color-down)] font-semibold">{losers}▼</span>
                          </span>
                        )}
                        <span aria-hidden="true">{detailOpen ? '▾' : '▸'}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={linking}
                      onClick={() => selectAccount(a)}
                      className="ml-auto text-right cursor-pointer"
                    >
                      <span className="font-semibold block">
                        {a.balance != null ? `$${(Number(a.balance) + floating).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ''}
                      </span>
                      {positions.length > 0 && (
                        <span className="block text-[9px] text-[var(--color-text-sub)]">incl. open trades ({floating >= 0 ? '+' : '−'}${Math.abs(floating).toLocaleString(undefined, { maximumFractionDigits: 2 })})</span>
                      )}
                      {linked?.accountId === a.accountId && <Badge tone="on">SELECTED</Badge>}
                    </button>
                  </div>
                  {detailOpen && (
                    <div className="px-3 pb-2 text-[9px] border-t border-[var(--color-border)]">
                      {positions.length === 0 && orders.length === 0 && <div className="pt-2 text-[var(--color-text-sub)]">Flat — no open positions or pending orders.</div>}
                      {positions.map(p => (
                        <div key={p.positionId} className="flex flex-wrap items-center gap-2 pt-2">
                          <span className="font-semibold">{p.symbol}</span>
                          <Badge tone={p.side === 'BUY' ? 'on' : 'off'}>{p.side}</Badge>
                          {p.lots != null && <span>{p.lots} lots</span>}
                          <span>in {p.entry} → now {p.currentPrice ?? '—'}</span>
                          {p.estPnlQuote != null && (
                            <span className={`font-semibold ${p.estPnlQuote >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                              {p.estPnlQuote >= 0 ? '+' : '−'}${Math.abs(p.estPnlQuote).toFixed(2)}
                            </span>
                          )}
                          <span className="text-[var(--color-text-sub)]">SL {p.sl ?? '—'} · TP {p.tp ?? '—'}</span>
                        </div>
                      ))}
                      {orders.map(o => (
                        <div key={o.orderId} className="flex flex-wrap items-center gap-2 pt-2">
                          <span className="font-semibold">{o.symbol}</span>
                          <Badge tone="info">{o.type}</Badge>
                          <Badge tone={o.side === 'BUY' ? 'on' : 'off'}>{o.side}</Badge>
                          <span>trigger {o.limitPrice ?? o.stopPrice ?? '—'}</span>
                        </div>
                      ))}
                      <div className="pt-2 text-[var(--color-text-sub)]">Full history and P&L per closed trade: Accounts page (open positions) and Monitor → Recent trades (bot's closed trades).</div>
                    </div>
                  )}
                </div>
                )
              })}
            </div>
            <p className="mt-2 text-[9px] text-[var(--color-warning-text)]">
              Start with a DEMO account. Picking it also downloads the broker's full symbol list automatically — no manual IDs needed.
            </p>
          </div>
        )}

        <p className="mt-2 text-[9px] text-[var(--color-text-sub)]">
          The token is stored in the agent's database, never in this browser.
        </p>
      </Card>

      {/* Copy a curated watchlist onto other accounts (owner, 2026-07-29).
          It lives here because this is where accounts already are — the
          picker above chooses which one trades, this chooses what they
          each trade. */}
      <WatchlistCompare />
    </div>
  )
}
