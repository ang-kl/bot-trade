// Volatility gate — Layer 1 (docs/volatility-gate-integration-spec.md §2).
//
// WHAT THIS ANSWERS, AND WHAT IT DOES NOT. There are two different volatility
// questions in this system, and conflating them is the failure the owner
// specifically asked to be designed out:
//
//   "is volatility EXPANDING right now?"   → services/regime.js, which reads
//        recent ATR against a longer ATR on the same symbol and emits
//        trending / volatile / ranging / quiet. A market-CHARACTER label.
//
//   "is volatility HIGH for this symbol?"  → this module, which ranks today's
//        ATR against that symbol's own trailing 252 days and emits
//        LOW / NORMAL / HIGH. A MAGNITUDE label.
//
// Those are genuinely different questions with different answers — a symbol
// can sit at its yearly low (LOW) while expanding fast off that low
// (volatile). Neither is wrong. What would be wrong is TWO ANSWERS TO ONE
// QUESTION, so:
//
//   THE SINGLE-OWNER RULE. This module computes no ATR of its own. It imports
//   `meanAtr` from regime.js — the same function regime.js classifies with —
//   and it reports regime.js's character label verbatim alongside its own
//   magnitude label. A test asserts the character label this module returns is
//   byte-identical to the regimes table's. If anyone later adds a second ATR
//   or a second character classifier, that test fails rather than the two
//   silently disagreeing.
//
// WHY A PERCENTILE AND NOT A FIXED THRESHOLD. The universe spans FX, metals,
// indices, softs, grains and crypto. A fixed "ATR > 150 pips = HIGH" is
// meaningless across those. A percentile against the symbol's OWN year is
// self-normalising. Its cost is that it needs a year of history, which thin
// or recently-added instruments do not have — see `insufficientHistory`.
import { meanAtr } from './regime.js'
import { latestRegime } from './regime-gate.js'

// Spec §2. Deliberately the spec's numbers, not tuned ones — they are an open
// decision (§7) and changing them silently would make the log-only window
// measure something other than what was specified.
export const LOW_PCTL = Math.min(49, Number(process.env.VOL_GATE_LOW_PCTL) || 20)
export const HIGH_PCTL = Math.max(51, Number(process.env.VOL_GATE_HIGH_PCTL) || 80)

// A year of trading days. Below this the percentile is reported but flagged.
export const HISTORY_DAYS = 252
// Under this many days the percentile is too coarse to act on at all — five
// samples can put an ordinary reading at the 100th percentile.
export const MIN_DAYS_FOR_VERDICT = Math.max(20, Number(process.env.VOL_GATE_MIN_DAYS) || 60)

export const ATR_PERIOD = 14

/**
 * Percentile rank of `value` within `sample`, 0-100.
 *
 * Uses the "≤" (weak) rank: the fraction of observations at or below the
 * value. On an all-identical sample every reading is the 100th percentile,
 * which is the honest answer — a flat series has no high or low — and the
 * caller's insufficient-history flag is what stops that being acted on.
 */
export function percentileRank(value, sample) {
  if (!Array.isArray(sample) || sample.length === 0 || !Number.isFinite(value)) return null
  let atOrBelow = 0
  for (const v of sample) if (Number.isFinite(v) && v <= value) atOrBelow++
  return Math.round((atOrBelow / sample.length) * 1000) / 10
}

/** LOW / NORMAL / HIGH from a percentile. Pure, so the cutoffs are testable. */
export function bandFor(percentile, { low = LOW_PCTL, high = HIGH_PCTL } = {}) {
  if (percentile == null) return 'NORMAL'
  if (percentile < low) return 'LOW'
  if (percentile > high) return 'HIGH'
  return 'NORMAL'
}

/** The trailing daily ATR series for a symbol, oldest first. */
export function atrHistory(db, symbol, { days = HISTORY_DAYS } = {}) {
  try {
    const rows = db.prepare(
      'SELECT atr FROM atr_history WHERE symbol = ? ORDER BY day DESC LIMIT ?'
    ).all(String(symbol).toUpperCase(), days)
    return rows.map(r => r.atr).filter(Number.isFinite).reverse()
  } catch { return [] }
}

/**
 * Layer 1. Classify the volatility MAGNITUDE for a symbol, and report the
 * market CHARACTER alongside it, unmodified, from the one module that owns it.
 *
 * @returns {{
 *   regime:'LOW'|'NORMAL'|'HIGH', percentile:number|null, currentAtr:number|null,
 *   sampleDays:number, insufficientHistory:boolean,
 *   characterRegime:string|null, characterTrendDir:string|null, note:string
 * }}
 */
export function classifyVolRegime(db, symbol, { currentAtr = null, days = HISTORY_DAYS } = {}) {
  const sample = atrHistory(db, symbol, { days })
  // The current reading defaults to the newest row in the history, so a caller
  // that has no live bars still gets a coherent answer rather than a null.
  const atr = Number.isFinite(currentAtr) ? currentAtr : (sample.length ? sample[sample.length - 1] : null)
  const percentile = atr != null ? percentileRank(atr, sample) : null

  // Character comes from regime.js via its own DB reader, including its own
  // staleness rule. Reported verbatim — never re-derived here.
  const row = latestRegime(db, symbol)

  const insufficientHistory = sample.length < HISTORY_DAYS
  const tooThin = sample.length < MIN_DAYS_FOR_VERDICT

  // Spec §2: too little history → treat as NORMAL and log the flag. A thin
  // sample producing a confident HIGH is worse than no reading, because a
  // downstream size cut would act on it.
  const regime = tooThin ? 'NORMAL' : bandFor(percentile)

  return {
    regime,
    percentile: tooThin ? null : percentile,
    currentAtr: atr,
    sampleDays: sample.length,
    insufficientHistory,
    characterRegime: row?.regime ?? null,
    characterTrendDir: row?.trend_direction ?? null,
    note: tooThin
      ? `only ${sample.length} of ${HISTORY_DAYS} days of ATR history — treated as NORMAL, percentile withheld`
      : insufficientHistory
        ? `${sample.length} of ${HISTORY_DAYS} days of history — percentile is over a short window`
        : '',
  }
}

/**
 * D5 — the same LOW/NORMAL/HIGH verdict, computed from BARS at a point in time.
 *
 * WHY THIS EXISTS SEPARATELY. classifyVolRegime reads `atr_history`, which
 * holds TODAY's trailing year. A backtest asking it about a bar from eight
 * months ago would be handed a distribution built from data that bar's trader
 * could not have seen — textbook lookahead, and it would flatter the gate
 * precisely where the gate is supposed to be judged. So the backtest derives
 * the distribution from the bars it has already walked past, and nothing else.
 *
 * WHAT IS AND IS NOT THE SAME. The BANDS are identical — this calls the same
 * `percentileRank` and `bandFor`, so a percentile means here exactly what it
 * means live. The SAMPLE is not: live ranks a 14-day ATR against 252 daily
 * readings, while a backtest on H1 bars ranks a 14-BAR ATR against the
 * trailing `lookback` bars. On an hourly series that is a shorter, faster
 * distribution than the live one. Results from this are evidence about the
 * gate's SHAPE — does widening stops in high vol help or hurt — not a
 * prediction of live percentiles. Anyone reading a backtest number as the live
 * number is reading it wrong, which is why it is written here rather than
 * implied.
 *
 * @param {Array} bars    ascending OHLC
 * @param {number} endIdx index of the bar being decided on (inclusive)
 * @returns the same shape classifyVolRegime returns, minus the DB-only fields
 */
export function classifyVolFromBars(bars, endIdx, {
  period = ATR_PERIOD, lookback = HISTORY_DAYS, minSamples = MIN_DAYS_FOR_VERDICT,
} = {}) {
  const none = {
    regime: 'NORMAL', percentile: null, currentAtr: null, sampleDays: 0,
    insufficientHistory: true, characterRegime: null, characterTrendDir: null,
    note: 'no usable bars — treated as NORMAL',
  }
  if (!Array.isArray(bars) || endIdx == null || endIdx < period) return none

  // Every ATR reading strictly at or before endIdx. Nothing after it is even
  // read, so lookahead is structurally impossible rather than merely avoided.
  const first = Math.max(period, endIdx - lookback + 1)
  const sample = []
  for (let i = first; i <= endIdx; i++) {
    const a = meanAtr(bars, period, i)
    if (Number.isFinite(a) && a > 0) sample.push(a)
  }
  if (!sample.length) return none

  const atr = sample[sample.length - 1]
  const percentile = percentileRank(atr, sample)
  const tooThin = sample.length < minSamples

  return {
    // Same rule as the live path: too little history → NORMAL, flag it, and
    // withhold the percentile so nothing downstream acts on a coarse number.
    regime: tooThin ? 'NORMAL' : bandFor(percentile),
    percentile: tooThin ? null : percentile,
    currentAtr: atr,
    sampleDays: sample.length,
    insufficientHistory: sample.length < lookback,
    // Character is regime.js's DB-backed label; a backtest has no regimes
    // table, and inventing one here would be the second classifier the
    // single-owner rule exists to prevent.
    characterRegime: null,
    characterTrendDir: null,
    note: tooThin ? `only ${sample.length} bar-ATR samples — treated as NORMAL, percentile withheld` : '',
  }
}

/** One UTC day key for a bar timestamp. */
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10)

/**
 * Daily refresh of the ATR baseline (spec §2: "recompute the rolling window
 * daily, not per-signal").
 *
 * `fetchDailyBars(symbol, count)` supplies ascending daily OHLC. It is injected
 * rather than imported so this is testable without a broker, and so the caller
 * owns the pacing — daily bars are HISTORICAL requests, capped by cTrader at
 * 5/s and paced to 4/s by ctrader-ws.js's shared token bucket. At ~300 symbols
 * that is roughly 75 seconds once a day; running it per-signal instead would
 * re-create the 2026-07-28 throttling incident exactly.
 *
 * Idempotent: one row per symbol per day, upserted, so a re-run or an
 * overlapping backfill corrects rather than duplicates.
 */
export async function refreshAtrHistory(db, symbols, fetchDailyBars, {
  days = HISTORY_DAYS, period = ATR_PERIOD, onError = () => {},
} = {}) {
  const upsert = db.prepare(`
    INSERT INTO atr_history (symbol, day, atr, close, computed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(symbol, day) DO UPDATE SET
      atr = excluded.atr, close = excluded.close, computed_at = excluded.computed_at
  `)
  let updated = 0
  let failed = 0
  const skipped = []

  for (const raw of symbols || []) {
    const symbol = String(raw).toUpperCase()
    let bars
    try {
      // +period so the earliest ATR in the window still has a full lookback;
      // without it the oldest readings would be computed from a short series
      // and sit systematically low, dragging every percentile upward.
      bars = await fetchDailyBars(symbol, days + period + 1)
    } catch (err) {
      failed++
      onError(symbol, err)
      continue
    }
    if (!Array.isArray(bars) || bars.length < period + 1) {
      skipped.push({ symbol, reason: `only ${bars?.length ?? 0} daily bars` })
      continue
    }

    const rows = []
    for (let i = period; i < bars.length; i++) {
      const atr = meanAtr(bars, period, i)
      if (!Number.isFinite(atr) || atr <= 0) continue
      rows.push([symbol, dayKey(bars[i].t), atr, bars[i].c ?? null])
    }
    if (!rows.length) {
      skipped.push({ symbol, reason: 'no finite ATR values' })
      continue
    }
    db.transaction(() => { for (const r of rows) upsert.run(...r) })()
    updated++
  }
  return { updated, failed, skipped, symbols: (symbols || []).length }
}

/** Prune history past the window so the table cannot grow without bound. */
export function pruneAtrHistory(db, { keepDays = HISTORY_DAYS * 2 } = {}) {
  const info = db.prepare(`
    DELETE FROM atr_history
    WHERE (symbol, day) NOT IN (
      SELECT symbol, day FROM (
        SELECT symbol, day, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY day DESC) AS rn
        FROM atr_history
      ) WHERE rn <= ?
    )
  `).run(keepDays)
  return { deleted: info.changes }
}
