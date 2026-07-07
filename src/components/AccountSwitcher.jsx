// AccountSwitcher — the broker accounts, always visible in the left nav.
// One tap switches which account the bot trades (LIVE still requires the
// typed confirmation) — no trip back to the Connect page needed.
import { useEffect, useState, useCallback } from 'react'
import { agentPost, agentConfigured } from '../lib/agent-api.js'

const CACHE = 'accounts_cache_v1'

export default function AccountSwitcher() {
  const [data, setData] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(CACHE)) || null } catch { return null }
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    if (!agentConfigured()) return
    try {
      const r = await agentPost('/actions/ctrader-accounts')
      const next = { accounts: r.accounts || [], selectedAccountId: r.selectedAccountId ? Number(r.selectedAccountId) : null }
      setData(next)
      try { sessionStorage.setItem(CACHE, JSON.stringify(next)) } catch { /* quota — skip */ }
      setErr('')
    } catch { /* not logged in / no token yet — stay hidden or stale */ }
  }, [])

  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t) }, [load])

  if (!agentConfigured() || !data?.accounts?.length) return null

  const pick = async (a) => {
    if (busy || a.accountId === data.selectedAccountId) return
    if (a.isLive) {
      const word = window.prompt(
        `⚠ ${a.traderLogin ? `Login ${a.traderLogin}` : `Account ${a.accountId}`} is a LIVE account with REAL money.\n\n` +
        'If Autotrade is armed, the bot will place REAL orders on it.\n\nType LIVE to confirm.'
      )
      if (word !== 'LIVE') return
    }
    setBusy(true)
    setErr('')
    try {
      await agentPost('/actions/ctrader-select-account', { accountId: a.accountId, isLive: a.isLive })
      await load()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div>
      <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-sub)]">Account</div>
      <div className="flex flex-col gap-0.5">
        {data.accounts.map(a => {
          const active = a.accountId === data.selectedAccountId
          return (
            <button
              key={a.accountId} type="button" onClick={() => pick(a)} disabled={busy}
              title={active ? 'The bot trades this account' : `Switch the bot to this ${a.isLive ? 'LIVE' : 'demo'} account`}
              className={`rounded-[10px] px-3 py-1.5 text-left w-full cursor-pointer transition-all ${
                active ? 'glass-inset shadow-[var(--glow-accent)]' : 'hover:bg-[var(--color-accent-soft)]'
              } ${busy ? 'opacity-60' : ''}`}
            >
              <span className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-text)]">
                <span className={`text-[10px] font-bold ${a.isLive ? 'text-[var(--color-down)]' : 'text-[var(--color-up)]'}`}>{a.isLive ? 'LIVE' : 'DEMO'}</span>
                <span>{a.traderLogin ?? a.accountId}</span>
                {active && <span aria-hidden="true" className="ml-auto text-[var(--color-accent)]">●</span>}
              </span>
              <span className="block text-[11px] text-[var(--color-text-sub)] tabular-nums">
                {busy ? 'switching…' : a.balance != null ? `$${Number(a.balance).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
              </span>
            </button>
          )
        })}
      </div>
      {err && <p className="px-3 pt-1 text-[11px] text-[var(--color-warning-text)]">{err}</p>}
    </div>
  )
}
