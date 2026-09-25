// agent/services/close-capture.js — the one line every close writes into the
// capture queue (V3 V1, owner order 25-09-2026: "every account's closes
// captured and verified").
//
// WHY THIS IS A LEAF MODULE. db.js's closeTradeRow is the seam every close in
// this process passes through — the reconciler's detected closes, its orphan
// sweep, and the position manager's own FULL_EXIT / already-closed paths
// (LIFECYCLE-SPEC §7 W11). Queuing the capture THERE, in the same statement
// sequence as the close, means no writer can close a trade and forget the
// capture — which is exactly what happened: until V1 the only enqueue sat
// behind the SELECTED account's reconcile result, so six of seven accounts,
// and every bot-side close on all seven, never queued anything. Production
// 25-09-2026 21:50 SGT: 45 captured in total, no drain line since 22-09.
//
// It imports nothing, so db.js can depend on it without a cycle
// (position-capture.js → position-history.js → lot-size-registry.js → db.js).
//
// NOTHING HERE IS SILENT. A queue write that throws must never fail the close
// it rides on — the close is the fact, the capture is the record of it — but
// the failure is counted and kept, and /state/position-capture shows it, so a
// broken enqueue cannot read as "no closes".

/** The owner's 30 seconds: the broker's deal history needs a moment to settle. */
export const CLOSE_CAPTURE_DELAY_MS = 30_000

const failures = { count: 0, lastError: null, lastAt: null, unattributed: 0, lastUnattributed: null }
const sourceColumn = new WeakMap()

function hasSourceColumn (db) {
  if (sourceColumn.has(db)) return sourceColumn.get(db)
  let has = false
  try { has = db.prepare('PRAGMA table_info(position_capture_queue)').all().some(c => c.name === 'source') } catch { has = false }
  sourceColumn.set(db, has)
  return has
}

/**
 * Queue one closed position for capture. Deduplicated by position identity:
 * `(account_id, position_id)` is the table's primary key and the insert is
 * `ON CONFLICT DO NOTHING`, so a close reported by the reconciler, by the
 * orphan sweep and by the bot's own close path is one row — and a row that is
 * already capturing, captured or given up is never reset.
 *
 * @returns {{ ok: boolean, queued: boolean, reason?: string }}
 */
export function queueCloseCapture (db, { accountId, positionId, symbol = null, source = null, now = Date.now(), delayMs = CLOSE_CAPTURE_DELAY_MS } = {}) {
  const acct = accountId == null || String(accountId).trim() === '' ? null : String(accountId)
  const pid = positionId == null || String(positionId).trim() === '' ? null : String(positionId)
  if (!acct || !pid) return { ok: false, queued: false, reason: 'no_identity' }
  const sym = symbol == null ? null : String(symbol)
  const due = Number(now) + Number(delayMs)
  const withSource = hasSourceColumn(db)
  const info = withSource
    ? db.prepare(`
        INSERT INTO position_capture_queue (account_id, position_id, symbol, due_at_ms, source)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, position_id) DO NOTHING
      `).run(acct, pid, sym, due, source == null ? null : String(source).slice(0, 40))
    : db.prepare(`
        INSERT INTO position_capture_queue (account_id, position_id, symbol, due_at_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id, position_id) DO NOTHING
      `).run(acct, pid, sym, due)
  return { ok: true, queued: info.changes > 0 }
}

/**
 * The close seam's variant: never throws, counts what it could not do.
 * Called by db.js closeTradeRow after a row actually moved open → closed.
 */
export function queueCaptureForClosedTrade (db, tradeId, { source = 'close', now = Date.now() } = {}) {
  try {
    const t = db.prepare('SELECT account_id, ctrader_position_id, symbol FROM trades WHERE id = ?').get(tradeId)
    // A trade that never had a broker position (an order that never filled)
    // has nothing at the broker to capture — that is not a failure.
    if (!t || t.ctrader_position_id == null) return { ok: true, queued: false, reason: 'no_position' }
    const r = queueCloseCapture(db, { accountId: t.account_id, positionId: t.ctrader_position_id, symbol: t.symbol, source, now })
    // A broker position with no account on the row cannot be pulled from any
    // account's deal history. Counted apart from failures: it is a gap in the
    // row, not a broken queue.
    if (!r.ok) { failures.unattributed++; failures.lastUnattributed = `trade ${tradeId} position ${t.ctrader_position_id}` }
    return r
  } catch (e) {
    failures.count++
    failures.lastError = `trade ${tradeId}: ${e?.message || String(e)}`.slice(0, 300)
    failures.lastAt = new Date(now).toISOString()
    return { ok: false, queued: false, reason: e?.message || String(e) }
  }
}

/** For /state/position-capture: enqueues this process could not make. */
export function closeCaptureFailures () { return { ...failures } }

/** Test seam. */
export function _resetCloseCaptureForTests () {
  failures.count = 0; failures.lastError = null; failures.lastAt = null
  failures.unattributed = 0; failures.lastUnattributed = null
}
