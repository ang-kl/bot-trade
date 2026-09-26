// ---------------------------------------------------------------------------
// agent/services/limit-fill-spread.js — V3 PO-M3: the spread at a limit's fill.
//
// RECORD ONLY. Nothing here decides, gates, sizes or closes anything.
//
// The pre-order evidence (integrated plan §4, "Measure first") has no spread
// on any PRE fill: a market entry records `spread_at_entry` from the spot read
// the spread gate makes before it fires (loop.js), but a resting limit fills
// at the broker with no Node code running, so 0 of 122 PRE rows carry one.
//
// WHAT THIS RECORDS, AND WHAT IT CANNOT. The spread at the fill INSTANT is not
// observable from Node: the sidecar's execution-event ring carries no price
// (cpp-exec event_journal.cpp), and a deal has no bid or ask. What Node can
// read is the FIRST quote after the fill — the fast monitor prices every open
// position from the sidecar's /quotes (or one broker spot read), and a new
// PRE fill is due on its first tick. So each record states:
//   - the bid, the ask, the spread (price units) and the spread in basis
//     points of the mid;
//   - where the quote came from (`sidecar` or `broker`) and when it was read;
//   - the fill time it is measured against, and on what basis: the sidecar's
//     receipt of the fill's execution event (`execution_event`, cpp_events)
//     when that is on record, else the trade row's own opened_at
//     (`row_opened_at` — the adoption time, later than the fill);
//   - the lag between the two.
// A first read later than FIRST_SIGHT_MAX_MS after the fill is not a spread
// at the fill: it is recorded as `not_read` with that reason, never as a
// number. A read that could not be made is `not_read` with its reason too, so
// every new PRE fill carries a record, measured or not (principle 4).
//
// STORED on the trade row: `trades.fill_spread` (REAL, price units, only when
// measured) and `trades.fill_spread_json` (the whole record above). Readers:
// GET /state/trades returns both columns (SELECT *) on every closed row.
//
// "NEW": a row whose opened_at is older than NEW_FILL_MAX_AGE_MS at first
// sight predates this record and is left untouched — writing a days-late
// quote onto an old fill would be a number that was never the fill's.
// ---------------------------------------------------------------------------

export const FIRST_SIGHT_MAX_MS = 15 * 60_000
export const NEW_FILL_MAX_AGE_MS = 24 * 3_600_000
export const FILL_SPREAD_NOTE = 'first quote Node read after the fill (the fill instant is not observable from Node); lagMs says how long after'

/** The resting-limit source (label PRE), the only rows this records. */
export const isPreFill = (pos) => String(pos?.source ?? '') === 'preopen'

const sqliteMs = (s) => {
  if (s == null || s === '') return NaN
  const t = String(s)
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(' ', 'T')}Z`)
}

function fillReference(db, trade) {
  try {
    if (trade.ctrader_position_id != null) {
      const pid = String(trade.ctrader_position_id).replace(/\.0+$/, '')
      const r = db.prepare(`SELECT MIN(ts_ms) AS ms FROM cpp_events
          WHERE position_id = ? AND execution_type IN ('ORDER_FILLED', 'ORDER_PARTIAL_FILL')
            AND (? IS NULL OR account_id IS NULL OR account_id = ?)`)
        .get(pid, trade.account_id ?? null, trade.account_id != null ? String(trade.account_id) : null)
      if (Number.isSafeInteger(r?.ms) && r.ms > 0) return { fillMs: r.ms, fillBasis: 'execution_event' }
    }
  } catch { /* no event table: fall back to the row's own time */ }
  const opened = sqliteMs(trade.opened_at)
  return Number.isFinite(opened) ? { fillMs: opened, fillBasis: 'row_opened_at' } : { fillMs: null, fillBasis: 'unknown' }
}

/**
 * Record the spread at a new PRE fill from the quote the caller already
 * holds. `quote` is {bid, ask} or null; `reason` names why there is no quote.
 * Writes at most once per measurement: a `measured` record is final, a
 * `not_read` one may be replaced by a later measurement inside the window.
 * Never throws; returns what it did.
 */
export function recordLimitFillSpread(db, pos, { quote = null, source = null, nowMs = Date.now(), reason = null } = {}) {
  try {
    if (!isPreFill(pos) || pos.trade_id == null) return { skipped: 'not_pre_fill' }
    const trade = db.prepare(`SELECT id, account_id, ctrader_position_id, opened_at, fill_spread_json FROM trades WHERE id = ?`).get(pos.trade_id)
    if (!trade) return { skipped: 'no_trade_row' }
    let prior = null
    try { prior = trade.fill_spread_json ? JSON.parse(trade.fill_spread_json) : null } catch { prior = null }
    if (prior?.state === 'measured') return { skipped: 'recorded' }
    if (!prior) {
      const opened = sqliteMs(trade.opened_at)
      if (!Number.isFinite(opened) || nowMs - opened > NEW_FILL_MAX_AGE_MS) return { skipped: 'not_new' }
    }
    const { fillMs, fillBasis } = fillReference(db, trade)
    const lagMs = Number.isFinite(fillMs) ? Math.round(nowMs - fillMs) : null
    const bid = Number(quote?.bid), ask = Number(quote?.ask)
    const valid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid
    let rec
    if (valid && lagMs != null && lagMs <= FIRST_SIGHT_MAX_MS) {
      const spread = ask - bid
      const mid = (ask + bid) / 2
      rec = { state: 'measured', bid, ask, spread, spreadBp: Math.round((spread / mid) * 1e4 * 100) / 100,
        source: source ?? null, quoteAtMs: nowMs, fillMs, fillBasis, lagMs, note: FILL_SPREAD_NOTE }
    } else {
      if (prior) return { skipped: 'not_read_recorded' } // the first reason stands; only a measurement replaces it
      const why = !valid
        ? (reason || 'no usable quote')
        : lagMs == null ? 'fill time unknown — a quote cannot be placed against it'
          : `first quote read ${Math.round(lagMs / 60_000)} min after the fill — past the ${FIRST_SIGHT_MAX_MS / 60_000} min window, not a fill-time spread`
      rec = { state: 'not_read', reason: why, source: valid ? source ?? null : null, quoteAtMs: nowMs, fillMs, fillBasis, lagMs, note: FILL_SPREAD_NOTE }
    }
    const r = db.prepare(`UPDATE trades SET fill_spread = ?, fill_spread_json = ? WHERE id = ?
        AND (fill_spread_json IS NULL OR fill_spread_json NOT LIKE '%"state":"measured"%')`)
      .run(rec.state === 'measured' ? rec.spread : null, JSON.stringify(rec), trade.id)
    return r.changes ? { recorded: rec.state, tradeId: trade.id } : { skipped: 'raced' }
  } catch (err) {
    return { skipped: 'error', error: err?.message || String(err) }
  }
}
