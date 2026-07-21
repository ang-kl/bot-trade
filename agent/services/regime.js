// ---------------------------------------------------------------------------
// agent/services/regime.js — classify a symbol's market regime from PRICE,
// not from the bot's own opinion of it.
//
// The audit found the old regime was derived purely from the average
// CONFIDENCE of the bot's recent scans (diluted by every 'skip'), with no
// ADX, no price structure, no real ATR — so it was almost always 'quiet'/
// 'ranging' and the regime gate it feeds blocked almost nothing. Worse, the
// number written into regimes.atr_pct was that same scan-confidence average,
// surfaced to the LLM and the dashboard as "ATR%".
//
// This module computes the regime the textbook way, from OHLC bars:
//   · Wilder ADX(14) for trend STRENGTH, DI+/DI- for DIRECTION
//   · an ATR-expansion ratio (recent ATR vs longer ATR) for volatility state
// and reports a real atrPct (ATR / price). It emits the SAME four regime
// labels the gate already understands (trending / volatile / ranging / quiet)
// so agent/services/regime-gate.js is unchanged:
//   · ADX ≥ 25                 → trending (dir = DI+ vs DI-)   [block fades vs it]
//   · else expansion ratio ≥1.3 → volatile (whipsaw)           [block fades]
//   · else ratio ≤ 0.7          → quiet (dead)                 [block breakouts]
//   · else                      → ranging (the mean-reversion home)
// ---------------------------------------------------------------------------

const PERIOD = 14
const ADX_TREND = 25       // Wilder's classic "a trend is present" line
const VOL_EXPANSION = 1.3  // recent ATR ≥ 1.3× the longer ATR → expanding/whippy
const VOL_CONTRACTION = 0.7 // recent ATR ≤ 0.7× the longer ATR → dead/quiet

const trueRange = (bar, prevClose) => Math.max(
  bar.h - bar.l,
  Math.abs(bar.h - prevClose),
  Math.abs(bar.l - prevClose),
)

/** Simple mean true range over the last `period` bars (matches fib-strategy.atr). */
function meanAtr(bars, period, endIdx = bars.length - 1) {
  const start = Math.max(1, endIdx - period + 1)
  let sum = 0
  let n = 0
  for (let i = start; i <= endIdx; i++) {
    sum += trueRange(bars[i], bars[i - 1].c)
    n++
  }
  return n > 0 ? sum / n : 0
}

/**
 * Wilder ADX with directional indicators. Returns null when there aren't
 * enough bars to warm up both the DI smoothing and the ADX smoothing
 * (needs ~2×period). Behavioural, well-understood, no external deps.
 * @returns {{adx:number, diPlus:number, diMinus:number}|null}
 */
export function adx(bars, period = PERIOD) {
  if (!Array.isArray(bars) || bars.length < period * 2 + 1) return null

  const trs = []
  const plusDMs = []
  const minusDMs = []
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h
    const down = bars[i - 1].l - bars[i].l
    plusDMs.push(up > down && up > 0 ? up : 0)
    minusDMs.push(down > up && down > 0 ? down : 0)
    trs.push(trueRange(bars[i], bars[i - 1].c))
  }

  // Wilder smoothing: seed with the first `period` sum, then roll.
  const wilder = (arr) => {
    let smoothed = arr.slice(0, period).reduce((s, v) => s + v, 0)
    const out = [smoothed]
    for (let i = period; i < arr.length; i++) {
      smoothed = smoothed - smoothed / period + arr[i]
      out.push(smoothed)
    }
    return out
  }
  const trS = wilder(trs)
  const plusS = wilder(plusDMs)
  const minusS = wilder(minusDMs)

  const dxs = []
  for (let i = 0; i < trS.length; i++) {
    const tr = trS[i] || 1e-9
    const pDI = 100 * (plusS[i] / tr)
    const mDI = 100 * (minusS[i] / tr)
    const denom = pDI + mDI || 1e-9
    dxs.push({ dx: 100 * Math.abs(pDI - mDI) / denom, pDI, mDI })
  }
  if (dxs.length < period) return null

  // ADX = Wilder-smoothed mean of DX. Seed with the mean of the first
  // `period` DX values, then roll.
  let adxVal = dxs.slice(0, period).reduce((s, d) => s + d.dx, 0) / period
  for (let i = period; i < dxs.length; i++) {
    adxVal = (adxVal * (period - 1) + dxs[i].dx) / period
  }
  const last = dxs[dxs.length - 1]
  return { adx: adxVal, diPlus: last.pDI, diMinus: last.mDI }
}

/**
 * Classify the regime from bars.
 * @param {Array<{o,h,l,c}>} bars ascending OHLC
 * @returns {{regime:'trending'|'volatile'|'ranging'|'quiet'|'unknown',
 *            trendDir:'long'|'short'|null, adx:number|null,
 *            atrPct:number|null, volRatio:number|null}}
 */
export function computeRegime(bars, { period = PERIOD } = {}) {
  const none = { regime: 'unknown', trendDir: null, adx: null, atrPct: null, volRatio: null }
  if (!Array.isArray(bars) || bars.length < period * 2 + 1) return none

  const di = adx(bars, period)
  if (!di) return none

  const price = bars[bars.length - 1].c || 0
  const recentAtr = meanAtr(bars, period)
  const longerAtr = meanAtr(bars, period * 2)
  const atrPct = price > 0 ? (recentAtr / price) * 100 : null
  const volRatio = longerAtr > 0 ? recentAtr / longerAtr : null

  let regime
  let trendDir = null
  if (di.adx >= ADX_TREND) {
    regime = 'trending'
    trendDir = di.diPlus >= di.diMinus ? 'long' : 'short'
  } else if (volRatio != null && volRatio >= VOL_EXPANSION) {
    regime = 'volatile'
  } else if (volRatio != null && volRatio <= VOL_CONTRACTION) {
    regime = 'quiet'
  } else {
    regime = 'ranging'
  }

  return {
    regime,
    trendDir,
    adx: Math.round(di.adx * 10) / 10,
    atrPct: atrPct != null ? Math.round(atrPct * 1000) / 1000 : null,
    volRatio: volRatio != null ? Math.round(volRatio * 100) / 100 : null,
  }
}
