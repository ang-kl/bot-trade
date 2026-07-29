// Is every open position actually protected RIGHT NOW?
//
// WHY THIS EXISTS (owner report, 2026-07-29). An ETHUSD short closed carrying
// the reason "stopped beyond the SL — gap/slippage through the stop". It had
// no stop loss at all: `sl_price` was NULL, and reconciler.js's classifier
// read `Number(null)` as 0 rather than "absent", so `exit > 0` was true for
// every short and stamped a stop that never existed. That bug is fixed at its
// source. This module addresses the larger gap the owner actually pointed at.
//
// The system had guards for the MOMENT of action and none for the STATE:
//
//   · risk.js refuses to open without a bracket
//   · manual-position-guards.js refuses to ADD to a naked position
//   · /actions/position-protect can attach a bracket on demand
//
// but nothing ever asked, of the positions already open, "is this one still
// protected?" A bracket can go missing after entry — an amend that failed, a
// broker-side cancellation, a position adopted from the broker that never had
// one, a partial close that dropped the remainder's stop. Every one of those
// leaves capital exposed silently, and the ledger's own close reason was
// actively reassuring about it.
//
// BROKER TRUTH, NOT OUR BOOKKEEPING. Reading `monitored_positions.current_sl`
// alone would only prove we THINK there is a stop. What protects money is the
// stop the broker is holding, so `brokerPositions` (already fetched every
// reconcile pass) is the authority, and a disagreement between the two is
// itself reportable — arguably the more dangerous state, because the UI shows
// a stop that will not fire.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TAKE-PROFIT REQUIREMENT, APPLIED TO POSITIONS WE DID NOT OPEN
//
// exec-engine.js refuses a market order with no take profit attached
// (`guard_no_target`, owner-approved 2026-07-22: SL-only was never enough to
// call a trade managed). But that guard fires at SUBMISSION, and an ADOPTED
// position never passes through it — the reconciler takes it from broker
// truth, brackets and all, or brackets and none. So the one rule the owner
// asked for most explicitly was the one rule adopted positions were exempt
// from. The 0003.HK pair found on 2026-07-29 had stops and no targets.
//
// It cannot be enforced retroactively — a position is already open — so the
// equivalent is to detect it and say so. What this deliberately does NOT do:
//
//   · attach a target itself. Choosing a take-profit price is a strategy
//     judgement (structure, R-multiple, session). A guessed one closes trades
//     at a level nothing supports, which is worse than none at all.
//   · report a take-profit DISAGREEMENT the way it reports a stop
//     disagreement. Targets are amended constantly in normal operation — the
//     profit keeper ratchets them, partial ladders move them — so a mismatch
//     check would fire during ordinary work. A check that cries wolf during
//     normal operation trains the owner to ignore it, which is the same
//     outcome as not having it. MISSING is unambiguous; different is not.
// ─────────────────────────────────────────────────────────────────────────────
import { getState, setState } from '../db.js'

/** Alert at most this often per position, so a persistent gap does not spam. */
const MUTE_MS = Math.max(60_000, Number(process.env.NAKED_ALERT_MUTE_MS) || 3600_000)

// A missing target is a management gap, not live unbounded risk — the stop
// still caps the loss. So it alerts on a slower cadence than a naked position,
// and never with the siren.
const TARGET_MUTE_MS = Math.max(60_000, Number(process.env.TARGETLESS_ALERT_MUTE_MS) || 6 * 3600_000)

const num = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null))

/**
 * Compare our open book against broker truth.
 *
 * @param {Array} openRows   rows with { id, symbol, trade_id, ctrader_position_id, current_sl, account_id, source }
 * @param {Array} brokerPositions  [{ positionId, stopLoss, takeProfit }]
 * @returns {{naked:Array, targetless:Array, phantom:Array, checked:number, unmatched:number}}
 *   naked      — no stop at the broker: real, live, unprotected exposure
 *   targetless — stop present, no take profit: the order-time rule, unmet
 *   phantom    — we show a stop the broker is not holding: the UI is lying
 */
export function auditProtection(openRows = [], brokerPositions = []) {
  const byId = new Map()
  for (const p of brokerPositions || []) {
    if (p?.positionId != null) byId.set(String(p.positionId), p)
  }

  const naked = []
  const targetless = []
  const phantom = []
  let unmatched = 0

  for (const row of openRows) {
    const pid = row?.ctrader_position_id == null ? null : String(row.ctrader_position_id)
    const bp = pid ? byId.get(pid) : null
    if (!bp) {
      // No broker position to compare against. NOT reported as naked: the
      // reconciler owns "open here, absent there" and calling it unprotected
      // would double-report a different fault as this one.
      unmatched++
      continue
    }
    const brokerSl = num(bp.stopLoss)
    const ourSl = num(row.current_sl)

    if (brokerSl == null || brokerSl === 0) {
      naked.push({
        monitoredId: row.id, tradeId: row.trade_id ?? null, symbol: row.symbol,
        positionId: pid, accountId: row.account_id ?? null,
        ourSl,
        detail: ourSl != null
          // The worse of the two: our book shows protection, the broker holds
          // none. Anyone reading the UI believes this position is covered.
          ? `we show a stop at ${ourSl} but the broker holds NONE — this position is unprotected and the UI says otherwise`
          : 'no stop loss at the broker and none on record — this position is unprotected',
      })
    } else {
      if (ourSl != null && Math.abs(brokerSl - ourSl) > Math.abs(brokerSl) * 0.001) {
        phantom.push({
          monitoredId: row.id, tradeId: row.trade_id ?? null, symbol: row.symbol,
          positionId: pid, accountId: row.account_id ?? null,
          ourSl, brokerSl,
          detail: `stop disagreement — we show ${ourSl}, the broker holds ${brokerSl}`,
        })
      }
      // Only asked of positions that HAVE a stop. A naked position needs a
      // stop first; adding "and no target either" underneath the siren is
      // noise on top of an emergency.
      const brokerTp = num(bp.takeProfit)
      if (brokerTp == null || brokerTp === 0) {
        const src = row.source || 'unknown'
        targetless.push({
          monitoredId: row.id, tradeId: row.trade_id ?? null, symbol: row.symbol,
          positionId: pid, accountId: row.account_id ?? null,
          source: src, brokerSl,
          detail: src === 'external'
            // Opened by hand at the broker, so it never met the order-time
            // rule and arguably was never meant to. Still reported — the
            // owner asked to see unmanaged exposure, not just the bot's.
            ? `no take profit at the broker (opened outside the bot) — stop at ${brokerSl}, no target`
            : `no take profit at the broker — an order placed through the bot could not have been submitted this way (guard_no_target); this one was adopted, so the guard never saw it`,
        })
      }
    }
  }
  return { naked, targetless, phantom, checked: openRows.length, unmatched }
}

/** Which findings are due an alert, given the mute window. Pure — testable. */
export function dueForAlert(findings, lastAlertMap, nowMs, muteMs = MUTE_MS) {
  return findings.filter(f => {
    const last = Number(lastAlertMap?.[String(f.positionId)] || 0)
    return !(last > 0) || (nowMs - last) >= muteMs
  })
}

const STATE_KEY = 'naked_position_alerts_json'
const TARGET_STATE_KEY = 'targetless_position_alerts_json'

/**
 * Run the audit, record it, and alert on anything newly unprotected.
 *
 * Never throws: a protection AUDIT that can crash the loop would remove more
 * safety than it adds.
 */
export async function runProtectionAudit(db, openRows, brokerPositions, {
  nowMs = Date.now(), sendMessage = null, muteMs = MUTE_MS, targetMuteMs = TARGET_MUTE_MS,
} = {}) {
  try {
    const audit = auditProtection(openRows, brokerPositions)

    const readMap = (key) => {
      try { return JSON.parse(getState(db, key) || '{}') } catch { return {} }
    }
    const lastAlerts = readMap(STATE_KEY)
    const lastTargetAlerts = readMap(TARGET_STATE_KEY)

    const due = dueForAlert(audit.naked, lastAlerts, nowMs, muteMs)
    const targetDue = dueForAlert(audit.targetless, lastTargetAlerts, nowMs, targetMuteMs)

    const KIND = new Map()
    for (const f of audit.naked) KIND.set(f, 'POSITION_UNPROTECTED')
    for (const f of audit.targetless) KIND.set(f, 'POSITION_NO_TARGET')
    for (const f of audit.phantom) KIND.set(f, 'POSITION_STOP_MISMATCH')

    for (const [f, method] of KIND) {
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
          method, '/protection-audit', JSON.stringify(f).slice(0, 2000),
        )
      } catch { /* audit best-effort */ }
    }

    if (due.length && typeof sendMessage === 'function') {
      const lines = due.map(f => `· ${f.symbol} (position ${f.positionId}) — ${f.detail}`)
      try {
        await sendMessage(
          `\u{1F6A8} ${due.length} OPEN POSITION${due.length > 1 ? 'S' : ''} WITH NO STOP LOSS\n${lines.join('\n')}\n\nSet one with POST /actions/position-protect, or close the position.`
        )
        for (const f of due) lastAlerts[String(f.positionId)] = nowMs
      } catch { /* a failed alert must not lose the audit */ }
    }

    // Separate message, no siren: a stop is in place, so this is a management
    // gap rather than an emergency. Batched into one so a book with several
    // targetless positions produces one line per position, not one alert each.
    if (targetDue.length && typeof sendMessage === 'function') {
      const lines = targetDue.map(f => `· ${f.symbol} (position ${f.positionId}) — stop ${f.brokerSl}, no target${f.source === 'external' ? ' · opened outside the bot' : ''}`)
      try {
        await sendMessage(
          `\u{26A0}\u{FE0F} ${targetDue.length} OPEN POSITION${targetDue.length > 1 ? 'S' : ''} WITH NO TAKE PROFIT\n${lines.join('\n')}\n\nThe order path refuses to submit these (guard_no_target) — these were adopted from the broker, so the guard never saw them. Set a target with POST /actions/position-protect {positionId, tp}.`
        )
        for (const f of targetDue) lastTargetAlerts[String(f.positionId)] = nowMs
      } catch { /* a failed alert must not lose the audit */ }
    }

    // Forget positions that are no longer open, so the mute maps cannot grow
    // without bound across a long-running process.
    const prune = (map, findings) => {
      const live = new Set(findings.map(f => String(f.positionId)))
      for (const k of Object.keys(map)) if (!live.has(k)) delete map[k]
    }
    prune(lastAlerts, audit.naked)
    prune(lastTargetAlerts, audit.targetless)
    try {
      setState(db, STATE_KEY, JSON.stringify(lastAlerts))
      setState(db, TARGET_STATE_KEY, JSON.stringify(lastTargetAlerts))
    } catch { /* non-fatal */ }

    return { ...audit, alerted: due.length, targetAlerted: targetDue.length }
  } catch (err) {
    return {
      naked: [], targetless: [], phantom: [], checked: 0, unmatched: 0,
      alerted: 0, targetAlerted: 0, error: err.message,
    }
  }
}
