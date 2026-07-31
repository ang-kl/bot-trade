// ---------------------------------------------------------------------------
// cockpit-bars.js — PHASE 3 of the cockpit live-wiring prompt: real bars and
// indicators for the snapshot, from the SAME maths every other surface uses.
//
// This module is PURE on purpose: it takes bars the route already fetched
// (through the existing chart data path — wsGetTrendbarsBatch, the same call
// POST /actions/chart makes) and shapes the contract's bars + indicators
// blocks. Purity is what makes the phase gate testable: "chart values can be
// checked against returned bars" means a test hands in known bars and checks
// every derived number against hand arithmetic — no broker, no clock, no mock
// dressed as market data.
//
// The prompt's core rule holds throughout: empty, partial or failed history is
// a STATUS, never synthetic candles. RVOL in particular refuses to answer
// without enough baseline bars — a ratio against a two-bar average is noise
// presented as a fact.
// ---------------------------------------------------------------------------
import { emaSeries, vwapSeries, volumeProfile } from '../lib/indicators.js'
import { tfMs } from '../lib/timeframes.js'

/** Bars needed in the RVOL baseline before a ratio is worth stating. */
const RVOL_MIN_BASELINE = 12

/**
 * Shape the bars + indicators contract blocks from fetched bars.
 *
 * @param {Array<{t:number,o:number,h:number,l:number,c:number,v:number}>} bars
 *   oldest-first, as the chart path returns them. May be empty on failure.
 * @param {{timeframe: string, sinceMs: number|null, source: string,
 *          fetchError: string|null, nowMs?: number}} opts
 * @returns {{bars: object, indicators: object}}
 */
export function buildBarsAndIndicators(bars, { timeframe = '15m', sinceMs = null, source = 'broker-trendbars', fetchError = null, nowMs = Date.now() } = {}) {
  const rows = Array.isArray(bars) ? bars.filter(b => b && Number.isFinite(b.t)) : []
  const asOf = new Date(nowMs).toISOString()

  if (!rows.length) {
    // Failed or empty history: one honest status, no synthetic candles. The
    // error text rides along so the ADVISORY row can say WHY.
    const status = fetchError ? 'unavailable' : 'unknown'
    return {
      bars: { timeframe, since: sinceMs ? new Date(sinceMs).toISOString() : null, rows: [], source, asOf, status, ...(fetchError ? { detail: String(fetchError).slice(0, 200) } : {}) },
      indicators: { status },
    }
  }

  // Partial history is stated, not padded: the caller asked for bars from
  // `sinceMs`, and the first bar we actually hold may be later (a young
  // symbol, a broker cap, a weekend gap at the window edge).
  const partial = sinceMs != null && rows[0].t > sinceMs + (tfMs(timeframe) || 900_000)
  const barsBlock = {
    timeframe,
    since: sinceMs ? new Date(sinceMs).toISOString() : null,
    rows,
    source,
    asOf,
    status: partial ? 'partial' : 'live',
    ...(partial ? { detail: `history starts ${new Date(rows[0].t).toISOString()} — later than the requested window` } : {}),
  }

  // Indicator series ALIGN WITH THE BARS by construction: emaSeries/vwapSeries
  // return one value per bar (null until warm), so indicators[i] describes
  // rows[i] and the gate's cross-check is a straight index walk.
  const ema9 = emaSeries(rows, 9)
  const ema20 = emaSeries(rows, 20)
  const ema50 = emaSeries(rows, 50)
  const vwap = vwapSeries(rows, 0)

  // RVOL: the CURRENT bar's volume against the mean of the prior baseline.
  // Needs a real baseline — with fewer than RVOL_MIN_BASELINE prior bars the
  // honest answer is null, not a ratio over noise.
  let rvol = null
  const prior = rows.slice(0, -1).map(b => b.v || 0).filter(v => v > 0)
  if (prior.length >= RVOL_MIN_BASELINE) {
    const mean = prior.reduce((s, v) => s + v, 0) / prior.length
    const cur = rows[rows.length - 1].v || 0
    if (mean > 0 && cur > 0) rvol = Number((cur / mean).toPrecision(4))
  }

  const vp = volumeProfile(rows, { type: 'composite', buckets: 24 })
  const vpKnown = vp.pocPrice != null

  return {
    bars: barsBlock,
    indicators: {
      ema9,
      ema20,
      ema50,
      vwap,
      rvol,
      volumeProfile: {
        buckets: vp.rows ?? [],
        pocPrice: vp.pocPrice ?? null,
        valueAreaLow: vp.valPrice ?? null,
        valueAreaHigh: vp.vahPrice ?? null,
        status: vpKnown ? 'derived' : 'unknown',
      },
      source: 'agent/lib/indicators.js over the returned bars',
      status: 'derived',
    },
  }
}

/** Bar count needed to cover `lookbackMs` of `timeframe`, bounded like /actions/chart. */
export function barCountFor(timeframe, lookbackMs) {
  const dur = tfMs(timeframe) || 900_000
  return Math.min(300, Math.max(30, Math.ceil(lookbackMs / dur) + 1))
}
