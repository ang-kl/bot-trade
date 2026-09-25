// ---------------------------------------------------------------------------
// agent/services/intent-corrections.js — the X1 record correction (owner-
// approved 25-09-2026 21:30 SGT: "correct the 26 stored resting-order intents
// to 'placed, not filled' (ACCEPTED with brokerOrderId, then the terminal
// state broker evidence shows: filled / cancelled / expired), evidence and
// before/after recorded").
//
// WHAT WAS WRONG. Until X1, exec-engine.settleIntent wrote FILLED whenever the
// placement answer carried a position id, and cTrader's ORDER_ACCEPTED for a
// RESTING limit carries the broker's pre-created position id. So every
// resting-order intent was stored FILLED by 'response' at the moment it was
// placed. Measured 25-09-2026 15:00 UTC (/state/order-lifecycle ORD-04): 25
// such rows have no trade, position, deal or position-history row carrying
// the intent — e.g. i7fgue8t2rgxx CADJPY (pending_fib_orders), FILLED
// 12-09 07:12, cancelled unfilled 25-09 07:47.
//
// WHAT THIS DOES. Step 1 (here): each such row is moved FILLED → ACCEPTED
// ("placed, not filled"), keeping its broker order id; the broker's
// pre-created position id, which never became a position, moves off the row
// into the log. Step 2 (entry-ledger.js reconcileIntents and
// settleAcceptedFromOrderDetails): the broker's evidence settles each one —
// FILLED / RELEASED (cancelled) / EXPIRED / REJECTED — or, after the bounded
// reads, leaves it ACCEPTED with "unresolved: no broker evidence". Each step
// writes one entry_intent_corrections row with the row before, the row
// after, and the evidence. Nothing is deleted.
//
// WHICH ROWS — and why a row WITH fill evidence is left alone. A resting
// order that later filled really is FILLED (the ORD-04 notice
// 'resting_filled_at_placement'); only its timing is the placement's. Only a
// row with NO evidence of a fill is corrected (a row with evidence is logged
// 'kept_filled' with it), and the evidence looked for is
// wider than ORD-04's (the tag on a trade or a monitored position; the
// broker's pre-created position id on a trade, a broker deal or a
// position-history row; a fill event for the order in the sidecar's journal),
// so the correction can only err towards leaving a row as it was.
//
// WHICH ROWS — written by the OLD code only. The first run records a cutoff
// (migrations_applied, `<id>:cutoff`) and only rows created before it are
// candidates, so a resting order the NEW code settles FILLED from a real fill
// answer can never be pulled back. A candidate is judged only once it is
// X1_GRACE_MS past its resolution, so a fill the reconciler has not adopted
// yet is not mistaken for no fill. Once the cutoff is past the grace and no
// candidate remains, a `<id>:done` marker stops the query for good.
// Idempotent: a step is written once (UNIQUE), and a row already moved no
// longer matches.
// ---------------------------------------------------------------------------

import { labelIntentId } from '../lib/trade-labels.js'
import { isMarketOrderType } from '../lib/order-answer.js'
import { X1_CORRECTION_ID, logCorrectionStep } from './entry-ledger.js'

export { X1_CORRECTION_ID }
export const X1_GRACE_MS = 30 * 60 * 1000
// The placement answer lands within the send's 20 s wait; a 'response'
// resolution this long after creation is not a placement answer.
export const X1_ANSWER_WINDOW_MS = 60 * 1000

const iso = (ms) => new Date(ms).toISOString()
const pidForms = (pid) => { const s = String(pid).replace(/\.0+$/, ''); return [s, `${s}.0`] }

function ensureMarkers(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations_applied (
    id         TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    changes    INTEGER
  )`)
}

/** The cutoff the first run recorded (ms), recording it now if absent. */
export function x1Cutoff(db, { now = Date.now(), id = X1_CORRECTION_ID } = {}) {
  ensureMarkers(db)
  db.prepare(`INSERT OR IGNORE INTO migrations_applied (id, applied_at, changes) VALUES (?, ?, 0)`).run(`${id}:cutoff`, iso(now))
  return Date.parse(db.prepare('SELECT applied_at FROM migrations_applied WHERE id = ?').get(`${id}:cutoff`).applied_at)
}

/**
 * Every place a fill of this intent could be recorded locally, looked at and
 * listed. `found` empty ⇔ no evidence of a fill.
 */
export function fillEvidence(db, row) {
  const acct = row.account_id != null ? String(row.account_id) : null
  const tagLike = `%|${row.id}`
  const looked = []
  const found = []
  const q = (name, sql, ...params) => {
    let rows = []
    try { rows = db.prepare(sql).all(...params) } catch (err) { looked.push({ source: name, error: String(err?.message || err).slice(0, 120) }); return }
    looked.push({ source: name, rows: rows.length })
    for (const r of rows) found.push({ source: name, ...r })
  }
  // The tag on a trade / monitored position (label_raw), confirmed by
  // labelIntentId so a longer id sharing a suffix cannot match.
  q('trades.label_tag', `SELECT id, status, ctrader_position_id, label_raw FROM trades WHERE label_raw LIKE ? AND (account_id = ? OR account_id IS NULL) LIMIT 10`, tagLike, acct)
  q('monitored_positions.label_tag', `SELECT id, trade_id, status, label_raw FROM monitored_positions WHERE label_raw LIKE ? AND (account_id = ? OR account_id IS NULL) LIMIT 10`, tagLike, acct)
  const tagged = (r) => !('label_raw' in r) || labelIntentId(String(r.label_raw || '')) === row.id
  if (row.broker_position_id != null && String(row.broker_position_id) !== '') {
    const [a, b] = pidForms(row.broker_position_id)
    q('trades.position_id', `SELECT id, status, ctrader_position_id FROM trades WHERE CAST(ctrader_position_id AS TEXT) IN (?, ?) AND (account_id = ? OR account_id IS NULL) LIMIT 10`, a, b, acct)
    q('broker_deals.position_id', `SELECT deal_id, position_id, opened_at, closed_at FROM broker_deals WHERE CAST(position_id AS TEXT) IN (?, ?) AND (account_id = ? OR account_id IS NULL) LIMIT 10`, a, b, acct)
    q('position_history.position_id', `SELECT trade_id, ctrader_position_id FROM position_history WHERE CAST(ctrader_position_id AS TEXT) IN (?, ?) AND (account_id = ? OR account_id IS NULL) LIMIT 10`, a, b, acct)
  } else {
    looked.push({ source: 'position_id', skipped: 'no position id on the row' })
  }
  if (row.broker_order_id != null && String(row.broker_order_id) !== '') {
    q('cpp_events.fill', `SELECT id, execution_type, order_id, position_id FROM cpp_events WHERE order_id = ? AND (account_id = ? OR account_id IS NULL)
      AND UPPER(COALESCE(execution_type, '')) IN ('ORDER_FILLED', 'ORDER_PARTIAL_FILL', '3', '11') LIMIT 10`, String(row.broker_order_id).replace(/\.0+$/, ''), acct)
  }
  let order = null
  try {
    order = row.broker_order_id != null
      ? db.prepare('SELECT order_id, status, first_seen, last_seen, gone_at FROM broker_orders WHERE order_id = ?').get(String(row.broker_order_id).replace(/\.0+$/, '')) ?? null
      : null
  } catch { order = null }
  // A place that could not be looked at is not a place with nothing in it.
  const errors = looked.filter(l => l.error)
  return { looked, found: found.filter(tagged), errors, brokerOrder: order }
}

/** Old-code rows stored FILLED by the placement answer for a resting order, past the grace, not yet corrected. */
export function x1Candidates(db, { now = Date.now(), cutoffMs = null, graceMs = X1_GRACE_MS } = {}) {
  const cutoff = cutoffMs ?? x1Cutoff(db, { now })
  const rows = db.prepare(`SELECT * FROM entry_intents
    WHERE state = 'FILLED' AND resolution_source = 'response' AND created_at < ? AND resolved_at IS NOT NULL AND resolved_at <= ?
      AND NOT EXISTS (SELECT 1 FROM entry_intent_corrections c WHERE c.intent_id = entry_intents.id AND c.correction_id = ? AND c.step IN ('to_accepted', 'kept_filled'))
    ORDER BY created_at, id`).all(iso(cutoff), iso(now - graceMs), X1_CORRECTION_ID)
  return rows.filter(r => {
    if (isMarketOrderType(r.order_type)) return false
    const c = Date.parse(r.created_at), s = Date.parse(r.resolved_at)
    return Number.isFinite(c) && Number.isFinite(s) && s - c <= X1_ANSWER_WINDOW_MS
  })
}

/**
 * Step 1 of the X1 correction. Returns what it looked at and what it moved.
 * Each row moves inside its own transaction with its log entry, guarded on
 * the row still being FILLED by 'response' — a concurrent writer that moved
 * it first wins, and nothing is logged for a row that did not move.
 */
export function applyX1Correction(db, { now = Date.now(), graceMs = X1_GRACE_MS } = {}) {
  ensureMarkers(db)
  const out = { considered: 0, corrected: [], leftFilled: [], unreadable: [], done: false }
  if (db.prepare('SELECT 1 FROM migrations_applied WHERE id = ?').get(`${X1_CORRECTION_ID}:done`)) return { ...out, done: true }
  const cutoff = x1Cutoff(db, { now })
  const move = db.prepare(`UPDATE entry_intents SET state = 'ACCEPTED', broker_position_id = NULL, resolution_source = 'x1_correction',
      error_code = ?, evidence_attempts = 0, evidence_checked_at = NULL, updated_at = ?
    WHERE id = ? AND state = 'FILLED' AND resolution_source = 'response'`)
  for (const row of x1Candidates(db, { now, cutoffMs: cutoff, graceMs })) {
    out.considered++
    const ev = fillEvidence(db, row)
    if (ev.found.length) {
      // Judged and kept: the fill is on record, so FILLED is true (only its
      // timing is the placement's). Logged with the evidence, so the kept
      // rows are as auditable as the moved ones, and judged once.
      logCorrectionStep(db, {
        intentId: row.id, accountId: row.account_id, step: 'kept_filled', fromState: 'FILLED', toState: 'FILLED',
        before: row, after: row, evidence: { rule: 'a fill of this resting order is on record', cutoff: iso(cutoff), graceMs, ...ev }, now,
      })
      out.leftFilled.push({ intentId: row.id, evidence: ev.found.map(f => f.source) })
      continue
    }
    if (ev.errors.length) { out.unreadable.push({ intentId: row.id, errors: ev.errors }); continue }
    const text = `x1_correction: stored FILLED by the placement answer (${row.resolved_at}) while the ${row.order_type} order rested; `
      + `no trade, monitored position, broker deal, position-history row or fill event carries it — placed, not filled`
      + (row.broker_position_id != null ? `; the broker's pre-created position id ${row.broker_position_id} (never a position) moved to the correction log` : '')
    const tx = db.transaction(() => {
      const r = move.run(text.slice(0, 500), iso(now), row.id)
      if (r.changes !== 1) return false
      const after = db.prepare('SELECT * FROM entry_intents WHERE id = ?').get(row.id)
      logCorrectionStep(db, {
        intentId: row.id, accountId: row.account_id, step: 'to_accepted', fromState: 'FILLED', toState: 'ACCEPTED',
        before: row, after,
        evidence: { rule: 'resting order type, FILLED by the placement response, no local evidence of a fill', cutoff: iso(cutoff), graceMs, ...ev },
        now,
      })
      return true
    })
    if (tx.immediate()) out.corrected.push({ intentId: row.id, accountId: row.account_id, orderId: row.broker_order_id, preassignedPositionId: row.broker_position_id })
  }
  // Every old-code row is past its grace and every one has been judged (moved
  // or kept, each logged): the correction is complete, and the query stops.
  // A row whose evidence could not be read is still a candidate, so it holds
  // the correction open.
  if (now - cutoff > graceMs + X1_ANSWER_WINDOW_MS && x1Candidates(db, { now, cutoffMs: cutoff, graceMs }).length === 0) {
    db.prepare('INSERT OR IGNORE INTO migrations_applied (id, applied_at, changes) VALUES (?, ?, ?)').run(`${X1_CORRECTION_ID}:done`, iso(now),
      db.prepare(`SELECT COUNT(*) AS n FROM entry_intent_corrections WHERE correction_id = ? AND step = 'to_accepted'`).get(X1_CORRECTION_ID).n)
    out.done = true
  }
  return out
}

/** For the report and the PR body: every logged step, oldest first. */
export function x1CorrectionLog(db) {
  return db.prepare(`SELECT id, intent_id, account_id, step, from_state, to_state, at, evidence_json FROM entry_intent_corrections
    WHERE correction_id = ? ORDER BY id`).all(X1_CORRECTION_ID)
}
