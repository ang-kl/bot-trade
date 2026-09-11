// PR-F (owner principle 6): the cockpit header's Manage and Close were
// buttons with no onClick — the red Close even claimed "queues for next
// open", which nothing did. They are now real controls, and they exist ONLY
// when a position is bound (a demo cockpit has nothing to manage or close):
//   Manage → the same PositionManager sheet Desk/Accounts open per row
//   Close  → POST /actions/position-close (the route the sheet's own Close
//            uses), after a confirm naming symbol, side and volume
// On a closed market Close is disabled with the honest reason — the broker
// refuses the order until the market opens; nothing is queued.
// Rendered from props only (no hooks) so it can be pinned with a static
// render.
import { CLOSED_MARKET_CLOSE_TITLE } from './cockpit-session.js'

export default function CockpitActions({ fs, wraps = false, position = null, tradeId = null, marketClosed = false, busy = false, closeReason = null, onManage, onClosePosition }) {
  if (!position || tradeId == null) return null
  const base = { fontFamily: 'inherit', fontSize: fs(11.5), fontWeight: 600, borderRadius: 10, padding: wraps ? '11px 14px' : '4px 12px', ...(wraps ? { flex: 1 } : {}) }
  // `closeReason` (PR-F checker M1): the cockpit's own refusal — e.g. the deep
  // link carries no account, so the close could not be routed honestly.
  const closeDisabled = marketClosed || busy || !!closeReason
  return (
    <>
      <button type="button" onClick={onManage} disabled={busy}
        title={`Manage ${position.sym ?? ''} — size, stop & target, chart, details`}
        style={{ ...base, cursor: busy ? 'default' : 'pointer', color: 'var(--tx)', background: 'var(--acs)', border: '1px solid var(--acc)' }}>Manage</button>
      <button type="button" onClick={onClosePosition} disabled={closeDisabled}
        aria-disabled={closeDisabled}
        title={marketClosed ? CLOSED_MARKET_CLOSE_TITLE : closeReason ? closeReason : `Close ${position.sym ?? ''} ${position.side ?? ''} ${position.lots ?? '—'} lots at market`}
        style={{ ...base, cursor: closeDisabled ? 'not-allowed' : 'pointer', color: closeDisabled ? 'var(--mu)' : 'var(--dn)', background: closeDisabled ? 'var(--acs)' : 'var(--dns)', border: `1px solid ${closeDisabled ? 'var(--mu)' : 'var(--dn)'}`, opacity: closeDisabled ? .7 : 1 }}>{busy ? 'Closing…' : 'Close'}</button>
    </>
  )
}
