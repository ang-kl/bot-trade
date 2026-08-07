// AccountScopeFab — the account the page is showing, on screen at all times,
// and one tap from being changed.
//
// Owner, 05-08-2026: "Doesn't show the user which account it is looking at or
// looking at the summary. We keep having the problem of understanding the
// page … do you think an Account switcher FAB/Account Total FAB add to the
// navigation FAB be better. can this be done for iPhone or Tablet."
//
// It sits directly above the ☰ nav FAB, in the same fixed stack, so the two
// questions a reader has on any page — "where am I" and "whose numbers is
// this" — are answered in the same corner.
//
// WHAT IT SETS — CHANGED BY THE OWNER, 07-08-2026: "when I change the account
// using FAB, you should fire a refresh on the new selected account as THE
// SELECTED, it still tagged to the cTrader Account as SELECTED."
//
// It now moves BOTH: the view lens AND the traded account
// (POST /actions/ctrader-select-account). Picking an account here re-points
// what the bot trades.
//
// I argued against this and was overruled, which is the owner's call to make;
// what I would not do is ship it without the guard the other switch has. The
// LIVE row therefore carries the SAME typed-word confirmation AccountSwitcher
// uses — a one-tap control that can re-point real money is the exact hazard
// the previous design existed to prevent, and the confirm is what keeps a
// mis-tap from being expensive.
//
// "All accounts" stays VIEW-ONLY, necessarily: there is no such thing as
// trading "all", so that row must never reach the server.
//
// ORDER MATTERS. The server call goes first; the lens and the cached selection
// move only after it succeeds. A failed POST must leave the app showing what
// is actually true, not what was tapped.
//
// ON SIZE. The owner asked for "a small tiny FAB". This is 44px tall, which is
// the HIG minimum this app's own spec pins, and narrow instead — a ~56x44
// pill. Under 44px on a 4.7" screen is a control you miss, and this one
// changes what every number on the page means, so a mis-tap is expensive.
import { useEffect, useState } from 'react'
import { accountRoster } from '../../lib/account-roster.js'
import { fabFace, fabOptions, FAB_ALL } from '../../lib/scope-fab.js'
import { viewedAccountId, selectedAccountId, setViewedAccount, onAccountSwitch, writeSelection } from '../../lib/selected-account.js'
import { agentPost } from '../../lib/agent-api.js'

const readScope = () => {
  try {
    const v = viewedAccountId()
    return v == null ? FAB_ALL : String(v)
  } catch { return FAB_ALL }
}

/**
 * Controlled by SectionNavFab so the two panels in the stack are mutually
 * exclusive — on a 375px screen, both open at once would run off the top.
 *
 * @param {boolean} open
 * @param {(next:boolean)=>void} onToggle
 */
export default function AccountScopeFab({ open = false, onToggle = () => {} }) {
  const setOpen = (next) => onToggle(typeof next === 'function' ? next(open) : next)
  const [accounts, setAccounts] = useState([])
  const [scope, setScope] = useState(readScope)
  const [traded, setTraded] = useState(() => { try { return selectedAccountId() } catch { return null } })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    accountRoster().then(a => { if (alive) setAccounts(a) })
    // The lens can also move from the sidebar, from Connect, or from another
    // tab. The face must follow all of those, not just its own button —
    // a FAB that shows a scope the page is no longer on is worse than none.
    const off = onAccountSwitch(() => {
      if (!alive) return
      setScope(readScope())
      try { setTraded(selectedAccountId()) } catch { /* keep the last known */ }
    })
    return () => { alive = false; off() }
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const f = (e) => { if (e.key === 'Escape') onToggle(false) }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [open, onToggle])

  const face = fabFace(scope, accounts)
  const options = fabOptions(accounts, { tradedId: traded })

  const pick = async (value) => {
    setOpen(false)
    setErr('')
    // "All accounts" is a lens and only a lens — nothing to select at the
    // broker, so it never reaches the server.
    if (value === FAB_ALL) {
      setViewedAccount(FAB_ALL)
      setScope(readScope())
      return
    }
    const row = accounts.find(a => String(a.accountId) === String(value)) || null
    // Already the traded account: move the lens and stop. Re-POSTing a
    // selection that is already in force would churn the server's symbol map
    // and balance for no reason.
    if (row && String(selectedAccountId()) === String(value)) {
      setViewedAccount(value)
      setScope(readScope())
      return
    }
    if (row?.isLive) {
      const word = window.prompt(
        `⚠ LIVE account ${row.traderLogin ? `${row.traderLogin} · ` : ''}${row.accountId} holds REAL money.\n\n` +
        'Picking it here makes it THE account the bot trades. If Autotrade is armed, the bot will place REAL orders on it.\n\nType LIVE to confirm.'
      )
      if (word !== 'LIVE') return
    }
    setBusy(true)
    try {
      await agentPost('/actions/ctrader-select-account', {
        accountId: row?.accountId ?? value,
        isLive: !!row?.isLive,
        traderLogin: row?.traderLogin ?? null,
      })
      // Cache first, lens second. writeSelection moves the TRADING badge and
      // ticks the watcher; setViewedAccount fans out to every page's
      // useAccountSwitch(load). Both are needed: one fixes the labelling, the
      // other fixes the numbers.
      writeSelection(row?.accountId ?? value)
      setTraded(selectedAccountId())
      setViewedAccount(value)
      setScope(readScope())
    } catch (e) {
      // The switch did NOT happen, so nothing moves. Saying so is the whole
      // point — a lens that moved on a failed POST would show one account's
      // numbers under another account's name.
      setErr(e.message || 'switch failed')
    } finally { setBusy(false) }
  }

  return (
    <>
      {open && (
        <div className="glass-panel" role="dialog" aria-label="Account scope"
          style={{ marginBottom: 8, borderRadius: 12, padding: '6px 6px 4px', maxHeight: '60vh', overflowY: 'auto', minWidth: 208 }}>
          <div style={{
            fontSize: 'var(--fs-body)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em',
            color: 'var(--color-text-sub)', padding: '3px 8px 1px',
          }}>Viewing</div>
          {options.map(o => {
            const active = String(scope) === o.value
            return (
              <button key={o.value} type="button" onClick={() => pick(o.value)} disabled={busy}
                aria-current={active ? 'true' : undefined}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--glass-bg)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%', minHeight: 44,
                  textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', background: 'transparent',
                  border: 'none', borderRadius: 6, padding: '4px 8px',
                  fontSize: 'var(--fs-body)', fontWeight: active ? 700 : 500,
                  color: active ? 'var(--color-accent)' : 'var(--color-text)',
                }}>
                {/* A glyph, not a colour — the check is what marks the current
                    scope, and the word LIVE is what marks the live account. */}
                <span aria-hidden="true" style={{ width: 10, flexShrink: 0 }}>{active ? '✓' : ''}</span>
                {o.label}
                {o.live && <span style={{
                  marginLeft: 'auto', flexShrink: 0, fontSize: 'var(--fs-body)', fontWeight: 800,
                  color: 'var(--color-warning-text)', border: '1px solid var(--color-warning-border)',
                  background: 'var(--color-warning-bg)', borderRadius: 'var(--radius-control)', padding: '0 3px',
                }}>LIVE</span>}
                {o.traded && !o.live && <span style={{
                  marginLeft: 'auto', flexShrink: 0, fontSize: 'var(--fs-body)', fontWeight: 600,
                  color: 'var(--color-text-sub)', border: '1px solid var(--glass-edge)',
                  borderRadius: 'var(--radius-control)', padding: '0 3px',
                }}>TRADING</span>}
              </button>
            )
          })}
          {err && (
            <div role="alert" style={{
              fontSize: 'var(--fs-body)', color: 'var(--color-warning-text)', padding: '3px 8px',
              maxWidth: 216, whiteSpace: 'normal',
            }}>{err} — nothing was changed.</div>
          )}
          <div style={{
            fontSize: 'var(--fs-body)', color: 'var(--color-text-sub)', padding: '4px 8px 3px',
            borderTop: '1px solid var(--glass-edge)', maxWidth: 216, whiteSpace: 'normal',
          }}>
            Sets the account the bot TRADES, and what you are looking at.
            A live account asks you to type LIVE first.
          </div>
        </div>
      )}
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
        aria-label={`Account scope: ${face.top} ${face.bottom}`} title={face.title}
        className="glass-fixed"
        style={{
          cursor: 'pointer', fontFamily: 'inherit', width: 56, height: 44, borderRadius: 22,
          border: '1px solid var(--glass-border)', flexShrink: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          lineHeight: 1.15, gap: 1,
          color: face.kind === 'account' ? 'var(--color-accent)' : 'var(--color-text-sub)',
        }}>
        <span style={{ fontSize: 'var(--fs-body)', fontWeight: 600, letterSpacing: '.04em' }}>{face.top}</span>
        <span style={{ fontSize: 'var(--fs-head)', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{face.bottom}</span>
      </button>
    </>
  )
}
