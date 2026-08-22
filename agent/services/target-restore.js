// ---------------------------------------------------------------------------
// agent/services/target-restore.js — put back a take profit the bot lost.
//
// #748 stopped the four amend paths deleting targets. It could not give back
// the ones already gone: a position stripped before that deploy carries a stop
// and no target at the broker, and will keep doing so until something puts the
// target back. The protection audit has reported exactly that — `1 targetless`
// on every pass — while having no way to act on it.
//
// SO THIS ONLY EVER RESTORES WHAT THE BOT ITSELF RECORDED. The source is
// `monitored_positions.current_tp`: the target the bot placed and wrote down.
// A position with no recorded target is left alone and left reported. This
// cannot invent a level, cannot move an existing one, and cannot act on a
// position it has no record of.
//
// ON A TARGET THE PRICE HAS ALREADY PASSED. cTrader's position snapshot
// carries no current price, so this cannot know whether the market is already
// beyond the recorded target; if it is, the broker fills it on the next tick.
// That is not a hazard, it is the point: the counterfactual is a target that
// was never deleted, in which case the position would ALREADY have closed
// there. Restoring reproduces the world the deletion took away. What it must
// never do is close a position at a level the bot never chose — hence the
// record-only rule above and the direction check below.
// ---------------------------------------------------------------------------

import { recordPositionEvent } from './position-events.js'
import { getState, setState } from '../db.js'

/** How long before the same position may be retried after a failed restore. */
const RETRY_AFTER_MS = 30 * 60_000
/** Most restores attempted in one sweep — a mass event must not become a storm. */
export const MAX_PER_SWEEP = 5
/** Off switch. Absent means ON: the owner asked for this to run. */
const ENABLED_KEY = 'target_restore_enabled'
const ATTEMPTS_KEY = 'target_restore_attempts_json'

const num = (v) => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function restoreEnabled(db) {
  return getState(db, ENABLED_KEY) !== 'false'
}

/**
 * Should this targetless position have its recorded target put back?
 *
 * Pure: every input is passed in, so the decision is testable without a
 * database or a broker. `row` is the monitored_positions row for the finding.
 *
 * @returns {{action:'restore', tp:number}|{action:'skip', reason:string}}
 */
export function planTargetRestore(row, { brokerSl = null } = {}) {
  const tp = num(row?.current_tp)
  if (tp == null || tp <= 0) {
    // The overwhelmingly common case for an externally-opened position, and
    // the one where guessing would be worst. Reported, never invented.
    return { action: 'skip', reason: 'no target on record — nothing to restore' }
  }
  const entry = num(row?.entry_price)
  if (entry == null || entry <= 0) {
    return { action: 'skip', reason: 'no entry price on record — cannot check the target is the right side of it' }
  }
  const side = String(row?.side || '').toLowerCase()
  const isLong = side === 'long' || side === 'buy'
  const isShort = side === 'short' || side === 'sell'
  if (!isLong && !isShort) {
    return { action: 'skip', reason: `unrecognised side "${row?.side}" — cannot check target direction` }
  }
  // A target on the WRONG side of entry is a corrupt record, not a target:
  // sending it would ask the broker to close at a loss the moment it fills.
  if (isLong && !(tp > entry)) {
    return { action: 'skip', reason: `recorded target ${tp} is not above the ${entry} entry on a long — refusing to send it` }
  }
  if (isShort && !(tp < entry)) {
    return { action: 'skip', reason: `recorded target ${tp} is not below the ${entry} entry on a short — refusing to send it` }
  }
  // The stop must survive the amend, so it has to be known. amendPosition
  // would clear it otherwise — the mirror image of the defect this exists for.
  if (num(brokerSl) == null) {
    return { action: 'skip', reason: 'no stop known at the broker — a TP-only amend here would risk the stop' }
  }
  return { action: 'restore', tp }
}

/** Attempt bookkeeping, so a persistently failing amend is not retried forever. */
function readAttempts(db) {
  try { return JSON.parse(getState(db, ATTEMPTS_KEY) || '{}') } catch { return {} }
}
function writeAttempts(db, map) {
  try { setState(db, ATTEMPTS_KEY, JSON.stringify(map)) } catch { /* non-fatal */ }
}

/**
 * Restore recorded targets on the targetless positions of one account.
 *
 * @param {object} db
 * @param {object} creds        broker credentials for THIS account
 * @param {Array} findings      audit.targetless entries
 * @param {Map} rowsById        positionId -> monitored_positions row
 * @param {object} deps         { amend, nowMs, notify }
 * @returns {{restored:number, skipped:Array<string>, errors:Array<string>}}
 */
export async function restoreMissingTargets(db, creds, findings, rowsById, deps = {}) {
  const out = { restored: 0, skipped: [], errors: [] }
  if (!findings?.length) return out
  if (!restoreEnabled(db)) {
    out.skipped.push(`${findings.length} targetless position(s): restore is switched off (${ENABLED_KEY}=false)`)
    return out
  }
  const amend = deps.amend ?? (await import('../lib/exec-engine.js')).amendPosition
  const nowMs = deps.nowMs ?? Date.now()
  const attempts = readAttempts(db)
  let done = 0

  for (const f of findings) {
    if (done >= MAX_PER_SWEEP) {
      out.skipped.push(`${findings.length - done} more targetless position(s) not attempted this sweep (cap ${MAX_PER_SWEEP})`)
      break
    }
    const row = rowsById?.get(String(f.positionId))
    if (!row) { out.skipped.push(`${f.symbol}: no local row`); continue }

    const last = num(attempts[String(f.positionId)])
    if (last != null && nowMs - last < RETRY_AFTER_MS) {
      out.skipped.push(`${f.symbol}: restore attempted ${Math.round((nowMs - last) / 60_000)}m ago, waiting`)
      continue
    }

    const plan = planTargetRestore(row, { brokerSl: f.brokerSl })
    if (plan.action !== 'restore') { out.skipped.push(`${f.symbol}: ${plan.reason}`); continue }

    attempts[String(f.positionId)] = nowMs
    try {
      // BOTH LEGS, ALWAYS. The stop is re-sent alongside the target for the
      // same reason the target is re-sent alongside a stop everywhere else:
      // amend replaces. Sending the TP alone would clear the stop and turn a
      // targetless position into a naked one — this defect, inverted.
      await amend(creds, {
        positionId: parseInt(f.positionId),
        stopLoss: Number(f.brokerSl),
        takeProfit: plan.tp,
        ctidTraderAccountId: row.account_id ?? creds?.accountId ?? undefined,
      })
      done++
      out.restored++
      try {
        db.prepare("UPDATE monitored_positions SET current_tp = ? WHERE id = ? AND status = 'active'")
          .run(plan.tp, row.id)
      } catch { /* the broker is the record that matters */ }
      recordPositionEvent(db, {
        accountId: row.account_id ?? null, positionId: f.positionId, tradeId: row.trade_id ?? null,
        symbol: f.symbol, kind: 'tp_moved', fromValue: null, toValue: plan.tp,
        reason: 'target restored — the broker held none and the book had one',
        source: 'target_restore',
      })
      deps.notify?.(`🎯 ${f.symbol}: take profit restored to ${plan.tp} — the broker was holding none`)
    } catch (err) {
      out.errors.push(`${f.symbol}: ${err?.message || err}`)
    }
  }

  writeAttempts(db, attempts)
  return out
}
