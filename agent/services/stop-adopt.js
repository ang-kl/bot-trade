// ---------------------------------------------------------------------------
// agent/services/stop-adopt.js — make the book tell the truth about stops.
//
// The protection audit reports a `phantom`: our book says the stop is at X,
// the broker is holding Y. naked-position-guard.js calls that "arguably the
// more dangerous state, because the UI shows a stop that will not fire" — and
// then does nothing about it. Account 43097342 has carried `1 stop
// disagreement` on every pass, for days, with the UI lying the whole time.
//
// The broker is the authority on what will actually fire, so the repair is to
// write the broker's number into the book. That is a LOCAL write: nothing is
// sent to the broker, no position is touched, and the position's real
// protection is unchanged either way. What changes is that the screen stops
// lying.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT IS NOT UNCONDITIONAL, AND THIS IS THE WHOLE DESIGN
//
// Adopting every disagreement would silence the alert in exactly the case that
// most deserves it. If one of our amends failed and the broker is still holding
// an OLD, WIDER stop, the position is risking more than the book believed —
// and copying the broker's number in would make the two agree, stop the
// report, and leave the extra risk standing with nothing complaining. That is
// a guard cured by deleting the guard.
//
// So adoption is one-directional. The book is corrected only when the broker's
// stop is at least as PROTECTIVE as ours — tighter or equal, i.e. less risk
// than we thought. A broker stop that is WORSE than the book is left alone and
// left reported, because that one is a real unresolved exposure and the alert
// is the only thing carrying it.
// ─────────────────────────────────────────────────────────────────────────────

import { recordPositionEvent } from './position-events.js'
import { getState } from '../db.js'

const ENABLED_KEY = 'stop_adopt_enabled'

const num = (v) => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function adoptEnabled(db) {
  return getState(db, ENABLED_KEY) !== 'false'
}

/**
 * Should the book adopt the broker's stop for this disagreement?
 *
 * Pure. `row` is the monitored_positions row; `finding` is an audit phantom
 * entry carrying `ourSl` and `brokerSl`.
 *
 * @returns {{action:'adopt', sl:number}|{action:'skip', reason:string}}
 */
export function planStopAdopt(row, finding) {
  const brokerSl = num(finding?.brokerSl)
  const ourSl = num(finding?.ourSl ?? row?.current_sl)
  if (brokerSl == null || brokerSl <= 0) {
    return { action: 'skip', reason: 'no broker stop to adopt' }
  }
  if (ourSl == null) {
    // Nothing recorded to disagree with. Writing the broker's number in is
    // pure gain: the book gains a fact it did not have.
    return { action: 'adopt', sl: brokerSl }
  }
  if (brokerSl === ourSl) return { action: 'skip', reason: 'already agree' }

  const side = String(row?.side || '').toLowerCase()
  const isLong = side === 'long' || side === 'buy'
  const isShort = side === 'short' || side === 'sell'
  if (!isLong && !isShort) {
    // Without a side there is no "tighter", so the safety rule cannot be
    // applied — and a rule that cannot be applied must not be assumed to pass.
    return { action: 'skip', reason: `unrecognised side "${row?.side}" — cannot tell which stop is tighter` }
  }

  // Tighter means closer to the exit on the losing side: HIGHER for a long,
  // LOWER for a short. Equal was handled above.
  const brokerIsTighter = isLong ? brokerSl > ourSl : brokerSl < ourSl
  if (brokerIsTighter) return { action: 'adopt', sl: brokerSl }

  return {
    action: 'skip',
    reason: `the broker's stop ${brokerSl} is WIDER than our ${ourSl} on a ${isLong ? 'long' : 'short'}`
      + ' — this position is risking more than the book believed, so it stays reported',
  }
}

/**
 * Correct the book for every adoptable stop disagreement on one account.
 *
 * @returns {{adopted:number, skipped:Array<string>}}
 */
export function adoptBrokerStops(db, findings, rowsById) {
  const out = { adopted: 0, skipped: [] }
  if (!findings?.length) return out
  if (!adoptEnabled(db)) {
    out.skipped.push(`${findings.length} stop disagreement(s): adoption is switched off (${ENABLED_KEY}=false)`)
    return out
  }
  for (const f of findings) {
    const row = rowsById?.get(String(f.positionId))
    if (!row) { out.skipped.push(`${f.symbol}: no local row`); continue }
    const plan = planStopAdopt(row, f)
    if (plan.action !== 'adopt') { out.skipped.push(`${f.symbol}: ${plan.reason}`); continue }
    try {
      db.prepare("UPDATE monitored_positions SET current_sl = ? WHERE id = ? AND status = 'active'")
        .run(plan.sl, row.id)
      recordPositionEvent(db, {
        accountId: row.account_id ?? null, positionId: f.positionId, tradeId: row.trade_id ?? null,
        symbol: f.symbol, kind: 'sl_moved', fromValue: num(f.ourSl), toValue: plan.sl,
        reason: 'book corrected to broker truth — they disagreed and the broker is what fires',
        source: 'stop_adopt',
      })
      out.adopted++
    } catch (err) {
      out.skipped.push(`${f.symbol}: ${err?.message || err}`)
    }
  }
  return out
}
