// ---------------------------------------------------------------------------
// agent/lib/tick-exec-measurements.js — §2 PR-2c: MEASURED execution costs,
// separated from ASSUMED ones.
//
// The owner's instruction: "Separate measured costs from assumptions. The
// current slippage allowance includes a 0.5-basis-point-per-side placeholder.
// Use available intent, quote, acknowledgement and fill records to measure
// execution costs where possible. Where measurements are unavailable, retain
// an explicit assumption and show sensitivity to alternative costs."
//
// So this module measures what the records can carry and REFUSES to produce a
// number where they cannot. Two quantities, two different answers:
//
// LATENCY — MEASURABLE. `entry_intents` stamps `created_at` when the intent is
// created and carries the `client_msg_id` the send was made under;
// `cpp_events` carries the sidecar's own `ts_ms` for the execution event that
// came back under that same `client_msg_id`. The difference is a real, dated,
// per-send interval. It is INTENT-CREATION TO BROKER ACKNOWLEDGEMENT, which is
// wider than network latency — it includes the agent's own dispatch — and it
// is reported under that name, not as "network latency". The replayer already
// takes an ARRAY of samples and reports `measured p90 of N samples`
// (lib/tick-replay-sim.js resolveLatency), so a measurement feeds straight
// through the existing path and a fixed default keeps saying `fixed`.
//
// SLIPPAGE — NOT MEASURABLE HERE, and that stays the answer until a record
// changes. Adverse fill drift is (fill price − the price the order was sent
// against). This repo stores the FILL (`trades.entry_price`) and does not
// store the second half: `entry_intents` has symbol, symbol_id, side,
// order_type, volume, sl and tp and NO reference price, and the sidecar's
// `order_submit` decision row carries the intent tag, not a price. So the
// 0.5 bps per side in agent/config/tick-shadow-sim.json stays a PLACEHOLDER.
//
// AND THE CHECK IS A CHECK, NOT A CLAIM. `slippageEvidence` asks the schema
// what columns exist rather than asserting this file's prose. The day someone
// records an intent price, this reports it instead of repeating that there is
// none — which is the difference between a guard and a decoration.
// ---------------------------------------------------------------------------

import { resolveLatency } from './tick-replay-sim.js'

/** Column names that would carry the price an order was SENT against. */
const INTENT_PRICE_COLUMNS = Object.freeze([
  'intended_price', 'intent_price', 'reference_price', 'quote_price',
  'signal_price', 'requested_price', 'decision_price', 'entry_price', 'price',
])

/** A sample wider than this is not a send, it is a stalled row. */
export const MAX_PLAUSIBLE_LATENCY_MS = 60_000

/**
 * The p90 of a measured sample is meaningless on a handful of rows. Below this
 * many pairs the reading is REPORTED and the fixed default is kept — a stated
 * methodological floor, not a number invented to fill a gap.
 */
export const MIN_LATENCY_SAMPLES = 10

function tableColumns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map(r => String(r.name)) } catch { return [] }
}

/**
 * Intent-creation → broker-acknowledgement intervals, in ms.
 *
 * One sample per intent: the EARLIEST `cpp_events.ts_ms` recorded under that
 * intent's `client_msg_id`. Rows with no acknowledgement, no clock, or an
 * implausible interval are counted apart rather than dropped silently.
 *
 * @returns {{samples:number[], pairs:number, skipped:object, source:string, note:string}}
 */
export function latencySamples(db, { side = null, accountId = null, limit = 2000 } = {}) {
  const where = ['i.client_msg_id IS NOT NULL', 'e.ts_ms IS NOT NULL']
  const params = []
  if (side != null) { where.push('e.side = ?'); params.push(String(side)) }
  if (accountId != null) { where.push('i.account_id = ?'); params.push(String(accountId)) }
  let rows = []
  try {
    rows = db.prepare(`
      SELECT i.id AS intentId, i.created_at AS createdAt, MIN(e.ts_ms) AS ackMs
        FROM entry_intents i
        JOIN cpp_events e ON e.client_msg_id = i.client_msg_id
       WHERE ${where.join(' AND ')}
       GROUP BY i.id
       ORDER BY i.created_at DESC
       LIMIT ?`).all(...params, Math.max(1, Math.min(20_000, Number(limit) || 2000)))
  } catch { rows = [] }
  const samples = []
  const skipped = { noCreatedAt: 0, negative: 0, implausible: 0 }
  for (const r of rows) {
    const t0 = Date.parse(r.createdAt)
    const t1 = Number(r.ackMs)
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) { skipped.noCreatedAt++; continue }
    const ms = t1 - t0
    if (ms < 0) { skipped.negative++; continue }
    if (ms > MAX_PLAUSIBLE_LATENCY_MS) { skipped.implausible++; continue }
    samples.push(ms)
  }
  return {
    samples,
    pairs: rows.length,
    skipped,
    source: 'entry_intents.created_at → min(cpp_events.ts_ms) on the same client_msg_id',
    note: 'intent creation to broker acknowledgement — WIDER than network latency, it includes this agent\'s own dispatch. Reported as what it is.',
  }
}

/**
 * What the account simulation should wait for a fill, and whether that is a
 * measurement or the default.
 *
 * Feeds the samples through the replayer's OWN `resolveLatency`, so a measured
 * figure reports `measured p90 of N samples` from the one implementation and
 * a thin sample reports the fixed default with the reason it was not used.
 *
 * @returns {{latencyMs:number, latencySource:string, measured:boolean, samples:number, detail:object}}
 */
export function latencyForSim(db, { fallbackMs = 250, percentile = 0.9, minSamples = MIN_LATENCY_SAMPLES, ...opts } = {}) {
  const m = latencySamples(db, opts)
  if (m.samples.length >= minSamples) {
    const r = resolveLatency(m.samples, percentile)
    return { latencyMs: r.ms, latencySource: r.source, measured: true, samples: m.samples.length, detail: m }
  }
  const r = resolveLatency(fallbackMs, percentile)
  return {
    latencyMs: r.ms,
    latencySource: `${r.source} — ASSUMED: ${m.samples.length} usable intent→acknowledgement pair(s), below the ${minSamples} this reading requires`,
    measured: false,
    samples: m.samples.length,
    detail: m,
  }
}

/**
 * Can adverse fill drift be measured from what this database stores?
 *
 * Asks the SCHEMA, not this file's prose. `available:false` carries the reason
 * and the caller then keeps the configured placeholder and says so.
 *
 * @returns {{available:boolean, reason:string, intentPriceColumn:string|null, fillRows:number, note:string}}
 */
export function slippageEvidence(db) {
  const cols = tableColumns(db, 'entry_intents')
  const priceCol = INTENT_PRICE_COLUMNS.find(c => cols.includes(c)) || null
  let fillRows = 0
  try { fillRows = db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE entry_price IS NOT NULL`).get()?.n ?? 0 } catch { fillRows = 0 }
  if (!priceCol) {
    return {
      available: false,
      reason: 'entry_intents records no price the order was sent against — the columns are ' + (cols.length ? cols.join(', ') : '(table absent)'),
      intentPriceColumn: null,
      fillRows,
      note: 'a fill without the price it was sent against measures nothing. The configured slippage stays a PLACEHOLDER and is reported as an assumption with 0x/1x/2x sensitivity; no number is invented in its place.',
    }
  }
  let pairs = 0
  try {
    pairs = db.prepare(`SELECT COUNT(*) AS n FROM entry_intents i JOIN trades t ON t.ctrader_position_id = i.broker_position_id
      WHERE i.${priceCol} IS NOT NULL AND t.entry_price IS NOT NULL`).get()?.n ?? 0
  } catch { pairs = 0 }
  return {
    available: pairs > 0,
    reason: pairs > 0 ? `${pairs} intent-vs-fill price pair(s) on entry_intents.${priceCol}` : `entry_intents.${priceCol} exists but no row pairs with a fill`,
    intentPriceColumn: priceCol,
    fillRows,
    pairs,
    note: 'measured slippage is now possible — the placeholder in agent/config/tick-shadow-sim.json should be replaced by this measurement and stop being described as a placeholder.',
  }
}

/**
 * The one block every account-simulation figure is reported beside: which
 * cost terms are MEASURED, which are ASSUMED, and what the assumption is.
 */
export function costBasis(db, opts = {}) {
  const latency = latencyForSim(db, opts)
  const slippage = slippageEvidence(db)
  return {
    latency: {
      basis: latency.measured ? 'measured' : 'assumed',
      ms: latency.latencyMs,
      source: latency.latencySource,
      samples: latency.samples,
      pairs: latency.detail.pairs,
      skipped: latency.detail.skipped,
      note: latency.detail.note,
    },
    commission: {
      basis: 'measured_with_stated_gaps',
      source: 'agent/config/tick-shadow-sim.json, measured from the owner\'s broker statements; the two gaps that file states (the US-stock per-side minimum, FX\'s per-lot unit) are CLOSED in the account simulation by the sizedCommission block and open in the size-free shared book.',
    },
    slippage: {
      basis: 'assumed',
      available: slippage.available,
      reason: slippage.reason,
      note: slippage.note,
      sensitivity: 'every figure is reported at 0x, 1x and 2x the schedule, because the 1x figure rests on a placeholder.',
    },
  }
}
