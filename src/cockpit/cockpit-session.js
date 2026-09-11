// PR-F (owner principle 6): the cockpit's closed-market header used to
// animate a hard-coded "opens in 4h 23m" — reference demo timing that counted
// down once a minute whether or not any market was about to open. The only
// honest next-open time is the one the symbol-hours schedule serves
// (agent/services/symbol-hours.js nextOpenInfo → the snapshot's
// position.nextOpenAt, the same field /state/market-hours serves the tables).
// With no timestamp the label is "market closed" and nothing else — never a
// fabricated number, not even on the demo route.
import { nextOpenLabel } from '../lib/std-trade-rows.js'

/** "Xh Ym" until `iso`, or null when it is absent, unparseable or past. */
export function opensIn(iso, now = new Date()) {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  const mins = Math.round((t - now.getTime()) / 60_000)
  if (mins <= 0) return null
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

/**
 * The header pill text for a non-open session.
 *  - real position, next-open known:  "MARKET CLOSED · opens (12 09:05) · in 4h 23m"
 *  - real position, next-open unknown: "MARKET CLOSED"
 *  - demo route (no position):         "HKEX CLOSED" — the reference exchange, no countdown
 * `state` is the session axis ('closed' | 'pre' | 'post' | 'halted').
 */
export function sessionLabel({ position = null, state = 'closed', nextOpenAt = null, now = new Date() } = {}) {
  const st = String(state || 'closed').toUpperCase()
  if (!position) return `HKEX ${st}`
  const venue = position.exchange ? String(position.exchange).toUpperCase() : 'MARKET'
  if (st !== 'CLOSED') return `${venue} ${st}`
  const at = nextOpenLabel(nextOpenAt, now)
  const dur = opensIn(nextOpenAt, now)
  return at && dur ? `${venue} CLOSED · opens ${at} · in ${dur}` : `${venue} CLOSED`
}

/** Title for the Close button: the broker refuses a close on a closed market. */
export const CLOSED_MARKET_CLOSE_TITLE = 'market closed — a close is refused by the broker until it opens'

/** Title for the Close button when the deep link carries no account. */
export const NO_ACCOUNT_CLOSE_TITLE = 'account unknown — reopen this position from a table row so the close is routed to its own account'

/**
 * The cockpit's Close, as a pure decision + call (PR-F checker M1/M4):
 * refuses without a bound position, on a closed market, while a close is in
 * flight, or without the account the deep link carries (?tacct=); confirms
 * naming symbol / side / volume; posts { positionId, account } through the
 * injected `post`. Returns { sent, reason } — `sent` only when the post was
 * made. Tested with a stub post; TradeCockpit wires agentPost in.
 */
export async function sendClose({ managed, accountId, marketClosed = false, closing = false, confirm, post }) {
  if (!managed) return { sent: false, reason: 'no position bound' }
  if (marketClosed) return { sent: false, reason: CLOSED_MARKET_CLOSE_TITLE }
  if (closing) return { sent: false, reason: 'a close is already in flight' }
  if (!accountId) return { sent: false, reason: NO_ACCOUNT_CLOSE_TITLE }
  const lots = managed.lots ?? '—'
  if (!confirm(`Close ${managed.symbol} ${managed.side} ${lots} lots at market?\n\nThis sends a real close order to the broker now, on account …${String(accountId).slice(-4)}.`)) return { sent: false, reason: 'not confirmed' }
  const r = await post('/actions/position-close', { positionId: managed.positionId, account: String(accountId) })
  return { sent: true, reason: null, reply: r }
}
