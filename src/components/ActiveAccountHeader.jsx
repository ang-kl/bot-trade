// ActiveAccountHeader — WHICH account everything below belongs to.
//
// Owner (2026-07-29): "At the side Bar, above the OVERVIEW state the
// Account · {DEMO 5203012} I am viewing now. Account # in Blue text if
// trading now, Bright Grey is stop trading. Below the Account # is the
// Balance: USD/SGD/EUR ###,###.## now."
//
// Every figure on Performance, Desk, Trade and Risk is scoped to one account,
// and until now the only clue was a highlighted row further down the nav. The
// header states it once, at the top, in the account's OWN deposit currency —
// never a hardcoded "$", because the accounts on this cTID hold SGD as well
// as USD and printing the wrong symbol is worse than printing none.
//
// Colour carries the trading state, per the owner's spec: accent/blue while
// autotrade is armed, bright grey while it is not.
import { useEffect, useState } from 'react'
import { agentGet, agentConfigured } from '../lib/agent-api.js'

// Same session cache AccountSwitcher fills — reading it here costs nothing
// and avoids a second /actions/ctrader-accounts round-trip on every mount.
const CACHE = 'accounts_cache_v1'
const POLL_MS = 30_000

export default function ActiveAccountHeader() {
  const [acct, setAcct] = useState(null)      // { accountId, traderLogin, isLive, balance }
  const [armed, setArmed] = useState(null)    // autotradeEnabled — null until known
  const [ccy, setCcy] = useState(null)        // deposit currency, when the broker has told us

  // The account roster comes from the switcher's cache (same tab, already
  // fetched). Re-read on an interval so a switch made in the switcher shows
  // up here without a page reload.
  useEffect(() => {
    const read = () => {
      try {
        const c = JSON.parse(sessionStorage.getItem(CACHE))
        const sel = c?.accounts?.find(a => a.accountId === c.selectedAccountId)
        if (sel) setAcct(sel)
      } catch { /* private mode / bad JSON — stay blank */ }
    }
    read()
    const id = setInterval(read, 2_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!agentConfigured()) return
    const load = () => {
      agentGet('/state/health').then(h => setArmed(h?.autotradeEnabled === true)).catch(() => {})
      // Deposit currency lives on the cached broker snapshot's positions.
      // No positions → no currency → show the number bare rather than guess.
      agentGet('/state/broker-cache').then(bc => {
        const dep = bc?.snapshot?.account?.positions?.find(p => p.depositCcy)?.depositCcy
        if (dep) setCcy(dep)
      }).catch(() => {})
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [])

  if (!acct) return null

  const label = `${acct.isLive ? 'LIVE' : 'DEMO'} ${acct.traderLogin ?? acct.accountId}`
  const trading = armed === true
  return (
    <div className="mb-4 px-3">
      <div className="text-[9px] uppercase tracking-wide text-[var(--color-text-sub)]">Account</div>
      <div
        className={`text-[11px] font-bold tabular-nums ${trading ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}`}
        title={armed == null
          ? 'checking whether autotrade is armed…'
          : trading ? 'autotrade is ARMED — the bot is trading this account' : 'autotrade is OFF — the bot is not opening new trades on this account'}
      >
        {label}
      </div>
      <div className="text-[9px] text-[var(--color-text-sub)] tabular-nums">
        Balance: {acct.balance == null
          ? '—'
          : `${ccy ? `${ccy} ` : ''}${Number(acct.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
      </div>
    </div>
  )
}
