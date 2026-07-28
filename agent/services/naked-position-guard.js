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
import { getState, setState } from '../db.js'

/** Alert at most this often per position, so a persistent gap does not spam. */
const MUTE_MS = Math.max(60_000, Number(process.env.NAKED_ALERT_MUTE_MS) || 3600_000)

const num = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null))

/**
 * Compare our open book against broker truth.
 *
 * @param {Array} openRows   rows with { id, symbol, trade_id, ctrader_position_id, current_sl, account_id }
 * @param {Array} brokerPositions  [{ positionId, stopLoss, takeProfit }]
 * @returns {{naked:Array, phantom:Array, checked:number, unmatched:number}}
 *   naked   — no stop at the broker: real, live, unprotected exposure
 *   phantom — we show a stop the broker is not holding: the UI is lying
 */
export function auditProtection(openRows = [], brokerPositions = []) {
  const byId = new Map()
  for (const p of brokerPositions || []) {
    if (p?.positionId != null) byId.set(String(p.positionId), p)
  }

  const naked = []
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
    } else if (ourSl != null && Math.abs(brokerSl - ourSl) > Math.abs(brokerSl) * 0.001) {
      phantom.push({
        monitoredId: row.id, tradeId: row.trade_id ?? null, symbol: row.symbol,
        positionId: pid, accountId: row.account_id ?? null,
        ourSl, brokerSl,
        detail: `stop disagreement — we show ${ourSl}, the broker holds ${brokerSl}`,
      })
    }
  }
  return { naked, phantom, checked: openRows.length, unmatched }
}

/** Which findings are due an alert, given the mute window. Pure — testable. */
export function dueForAlert(findings, lastAlertMap, nowMs, muteMs = MUTE_MS) {
  return findings.filter(f => {
    const last = Number(lastAlertMap?.[String(f.positionId)] || 0)
    return !(last > 0) || (nowMs - last) >= muteMs
  })
}

const STATE_KEY = 'naked_position_alerts_json'

/**
 * Run the audit, record it, and alert on anything newly unprotected.
 *
 * Never throws: a protection AUDIT that can crash the loop would remove more
 * safety than it adds.
 */
export async function runProtectionAudit(db, openRows, brokerPositions, {
  nowMs = Date.now(), sendMessage = null, muteMs = MUTE_MS,
} = {}) {
  try {
    const audit = auditProtection(openRows, brokerPositions)

    let lastAlerts = {}
    try { lastAlerts = JSON.parse(getState(db, STATE_KEY) || '{}') } catch { lastAlerts = {} }

    const due = dueForAlert(audit.naked, lastAlerts, nowMs, muteMs)

    for (const f of [...audit.naked, ...audit.phantom]) {
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
          audit.naked.includes(f) ? 'POSITION_UNPROTECTED' : 'POSITION_STOP_MISMATCH',
          '/protection-audit',
          JSON.stringify(f).slice(0, 2000),
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

    // Forget positions that are no longer open, so the mute map cannot grow
    // without bound across a long-running process.
    const live = new Set(audit.naked.map(f => String(f.positionId)))
    for (const k of Object.keys(lastAlerts)) if (!live.has(k)) delete lastAlerts[k]
    try { setState(db, STATE_KEY, JSON.stringify(lastAlerts)) } catch { /* non-fatal */ }

    return { ...audit, alerted: due.length }
  } catch (err) {
    return { naked: [], phantom: [], checked: 0, unmatched: 0, alerted: 0, error: err.message }
  }
}
