// ---------------------------------------------------------------------------
// agent/services/manual-position-guards.js — P2 / gate D11 answered "harden
// both" (owner, 2026-07-26), with the owner's confirmation that cTrader
// permits adding to and reversing an active trade.
//
// THE DEFECTS (audit F-L5-01, F-L5-02, F-L5-03, F-L5-08). Two dashboard routes
// could each create exposure the risk system does not know about:
//
//   position-double  — placed a second market order with `allowNaked: true`,
//     wrote NOTHING to the DB, and had NO CAP: no counter, no check, before or
//     after send. risk.js's `duplicate_symbol` veto does not protect it —
//     that veto lives in the strategy gate, not in this route.
//   position-reverse — closed then opened, so a leg-two rejection left the
//     account FLAT with only a 502 body as the record; the new leg also
//     carried no stop.
//
// Neither had a dedup key, so a client retry after a timeout doubled the add
// or the reversal.
//
// WHAT THIS MODULE DECIDES, and what it deliberately does not.
//
// It answers three questions as pure functions, so each rule is a test rather
// than an inline condition inside an HTTP handler:
//
//   1. May this add proceed?  (cap, counted from BROKER TRUTH)
//   2. What stop must the new leg carry?  (never naked)
//   3. Is this call a duplicate of one seconds ago?
//
// It does NOT invent a weighted-average cost basis. The schema has no
// representation for one (`trades.entry_price` is a single scalar per row),
// and inventing one here would be a second, unaudited source of truth beside
// the broker's. After an add, the reconciler adopts the broker's own view on
// its next pass — that is the basis, and closing the gap properly is P10's
// `position_events` work. This module's job is to stop the exposure being
// created blind, not to model it after the fact.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

export const DEFAULT_MANUAL_GUARDS = {
  // How many EXTRA positions may exist on one symbol+side beyond the first.
  // 1 = the original plus one add. 0 disables adding entirely.
  maxAddsPerPosition: 1,
  // A second identical call inside this window is a retry echo, not intent.
  dedupeSeconds: 30,
  // An add inherits the parent's stop. With no parent stop there is nothing
  // to inherit, and a naked add is the exposure this exists to prevent.
  requireParentStop: true,
}

export function loadManualGuards(db) {
  try {
    const parsed = JSON.parse(getState(db, 'manual_guards_json') || 'null')
    if (parsed && typeof parsed === 'object') return { ...DEFAULT_MANUAL_GUARDS, ...parsed }
  } catch { /* corrupt — defaults, which are the strict end */ }
  return { ...DEFAULT_MANUAL_GUARDS }
}

const sideOf = (td) => (td?.tradeSide === 2 || td?.tradeSide === 'SELL' ? 'SELL' : 'BUY')

/**
 * Positions at the broker on the same symbol AND same side as `pos`,
 * including `pos` itself. Broker truth, not our ledger — the ledger is the
 * thing these routes were failing to write.
 */
export function siblingPositions(brokerPositions, pos) {
  const symbolId = pos?.tradeData?.symbolId
  const side = sideOf(pos?.tradeData)
  return (brokerPositions || []).filter(p =>
    p?.tradeData?.symbolId === symbolId && sideOf(p.tradeData) === side)
}

/**
 * May this add proceed? Counted from the broker's own book, so an add placed
 * by any route — or by hand in the cTrader app — counts against the cap.
 *
 * @returns {{ok:true, existing:number} | {ok:false, reason:string, existing:number}}
 */
export function checkAddCap(brokerPositions, pos, guards = DEFAULT_MANUAL_GUARDS) {
  const existing = siblingPositions(brokerPositions, pos).length
  const cap = Number(guards.maxAddsPerPosition)
  const allowed = (Number.isFinite(cap) ? Math.max(0, cap) : 0) + 1
  if (existing >= allowed) {
    return {
      ok: false,
      existing,
      reason: `add_cap: ${existing} position(s) already open on this symbol/side, cap is ${allowed} (maxAddsPerPosition=${cap}) — not adding`,
    }
  }
  return { ok: true, existing }
}

/**
 * The stop the new leg must carry, inherited from the parent position.
 *
 * An add joins the parent's thesis, so it takes the parent's stop PRICE — one
 * level for the whole exposure, which is also the only stop that stays correct
 * without a weighted basis. A parent with no stop yields a refusal rather than
 * a naked order.
 *
 * @returns {{ok:true, stopLoss:number, takeProfit:number|null} | {ok:false, reason:string}}
 */
export function inheritedBracket(pos, guards = DEFAULT_MANUAL_GUARDS) {
  const sl = Number(pos?.stopLoss)
  const tp = Number(pos?.takeProfit)
  if (!(sl > 0)) {
    if (guards.requireParentStop === false) return { ok: true, stopLoss: null, takeProfit: tp > 0 ? tp : null }
    return {
      ok: false,
      reason: 'no_parent_stop: the position being added to has no stop loss at the broker — set one first (POST /actions/position-protect), or the add would be naked',
    }
  }
  return { ok: true, stopLoss: sl, takeProfit: tp > 0 ? tp : null }
}

/**
 * The mirrored bracket for a REVERSE: the same distances the parent carried,
 * measured from its entry and flipped to the other side. Without this the new
 * leg went out naked (`allowNaked: true`).
 *
 * Returns nulls when the parent had no stop and the guard permits it; refuses
 * otherwise, for the same reason as an add.
 */
export function mirroredBracket(pos, guards = DEFAULT_MANUAL_GUARDS) {
  const entry = Number(pos?.tradeData?.openPrice ?? pos?.price)
  const sl = Number(pos?.stopLoss)
  const tp = Number(pos?.takeProfit)
  if (!(entry > 0)) return { ok: false, reason: 'no_entry_price: cannot mirror a bracket without the parent entry' }
  if (!(sl > 0)) {
    if (guards.requireParentStop === false) return { ok: true, relativeStopLoss: null, relativeTakeProfit: null }
    return {
      ok: false,
      reason: 'no_parent_stop: the position being reversed has no stop loss at the broker — set one first, or the reversed leg would be naked',
    }
  }
  const slDist = Math.abs(entry - sl)
  const tpDist = tp > 0 ? Math.abs(tp - entry) : null
  return { ok: true, slDistance: slDist, tpDistance: tpDist }
}

/**
 * Is this the same manual action we just performed? `recent` is the rows of
 * action_log for this route, newest first, each { body, at } with `at` in ms.
 *
 * A retry after a timeout is the case that matters: the caller saw no
 * response, pressed again, and without this the broker takes two.
 */
export function isDuplicateCall(recent, { route, positionId }, nowMs = Date.now(), guards = DEFAULT_MANUAL_GUARDS) {
  const windowMs = Math.max(0, Number(guards.dedupeSeconds) || 0) * 1000
  if (!windowMs) return { duplicate: false }
  for (const row of recent || []) {
    if (row?.route !== route) continue
    if (String(row?.positionId) !== String(positionId)) continue
    const age = nowMs - Number(row.at)
    if (Number.isFinite(age) && age >= 0 && age < windowMs) {
      return {
        duplicate: true,
        reason: `duplicate_manual_call: ${route} on position ${positionId} was performed ${Math.round(age / 1000)}s ago (${guards.dedupeSeconds}s window) — refusing a second one`,
      }
    }
  }
  return { duplicate: false }
}
