// ---------------------------------------------------------------------------
// agent/quant/regime.js — ATR + ADX regime classification
// ---------------------------------------------------------------------------

/**
 * Wilder's smoothing: first value is a simple average, subsequent values use
 *   smoothed = prev - (prev / period) + current
 *
 * @param {number[]} values — raw series (length >= period)
 * @param {number} period
 * @returns {number[]} smoothed series (length = values.length - period + 1)
 */
function wilderSmooth(values, period) {
  if (values.length < period) return [];

  // Seed with SMA of the first `period` values
  let smoothed = 0;
  for (let i = 0; i < period; i++) smoothed += values[i];
  smoothed /= period;

  const result = [smoothed];
  for (let i = period; i < values.length; i++) {
    smoothed = smoothed - smoothed / period + values[i];
    result.push(smoothed);
  }
  return result;
}

/**
 * Compute Average True Range using Wilder's smoothing.
 *
 * TR = max(H - L, |H - prevClose|, |L - prevClose|)
 *
 * @param {Array<{o:number, h:number, l:number, c:number, v:number, t:number}>} bars
 * @param {number} period — default 14
 * @returns {number} — final ATR value
 */
export function computeATR(bars, period = 14) {
  if (bars.length < period + 1) {
    throw new Error(
      `Need at least ${period + 1} bars for ATR(${period}), got ${bars.length}`,
    );
  }

  const trValues = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h;
    const l = bars[i].l;
    const prevC = bars[i - 1].c;
    const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    trValues.push(tr);
  }

  const smoothed = wilderSmooth(trValues, period);
  return smoothed[smoothed.length - 1];
}

/**
 * Compute Average Directional Index (ADX) with Wilder's smoothing.
 *
 * Steps:
 *  1. +DM / -DM from successive bars
 *  2. TR series
 *  3. Wilder-smooth +DM, -DM, TR
 *  4. +DI = smoothed(+DM) / smoothed(TR) * 100
 *  5. -DI = smoothed(-DM) / smoothed(TR) * 100
 *  6. DX  = |+DI - -DI| / (+DI + -DI) * 100
 *  7. ADX = Wilder-smooth DX
 *
 * @param {Array<{o:number, h:number, l:number, c:number, v:number, t:number}>} bars
 * @param {number} period — default 14
 * @returns {{ adx: number, plusDI: number, minusDI: number }}
 */
export function computeADX(bars, period = 14) {
  // We need at least 2*period bars for the double smoothing
  if (bars.length < 2 * period + 1) {
    throw new Error(
      `Need at least ${2 * period + 1} bars for ADX(${period}), got ${bars.length}`,
    );
  }

  const plusDM = [];
  const minusDM = [];
  const trValues = [];

  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h;
    const l = bars[i].l;
    const prevH = bars[i - 1].h;
    const prevL = bars[i - 1].l;
    const prevC = bars[i - 1].c;

    // True Range
    trValues.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));

    // Directional Movement
    const upMove = h - prevH;
    const downMove = prevL - l;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder-smooth all three series
  const smoothPlusDM = wilderSmooth(plusDM, period);
  const smoothMinusDM = wilderSmooth(minusDM, period);
  const smoothTR = wilderSmooth(trValues, period);

  // All three smoothed arrays have the same length; derive DI and DX
  const len = Math.min(smoothPlusDM.length, smoothMinusDM.length, smoothTR.length);
  const dxValues = [];

  let lastPlusDI = 0;
  let lastMinusDI = 0;

  for (let i = 0; i < len; i++) {
    const atr = smoothTR[i];
    if (atr === 0) {
      dxValues.push(0);
      continue;
    }
    const pdi = (smoothPlusDM[i] / atr) * 100;
    const mdi = (smoothMinusDM[i] / atr) * 100;
    const diSum = pdi + mdi;
    const dx = diSum === 0 ? 0 : (Math.abs(pdi - mdi) / diSum) * 100;
    dxValues.push(dx);
    lastPlusDI = pdi;
    lastMinusDI = mdi;
  }

  // Wilder-smooth DX to get ADX
  const adxSeries = wilderSmooth(dxValues, period);

  return {
    adx: adxSeries[adxSeries.length - 1],
    plusDI: lastPlusDI,
    minusDI: lastMinusDI,
  };
}

/**
 * ATR% thresholds by asset class.
 * @type {Record<string, number>}
 */
const ATR_PCT_THRESHOLDS = {
  stock: 2,
  forex: 1,
  crypto: 3,
};

/**
 * Classify market regime from ATR, ATR%, and ADX indicators.
 *
 * @param {number} atr          — raw ATR value
 * @param {number} atrPct       — ATR as a percentage of price (e.g. 1.5 = 1.5%)
 * @param {number} adx          — ADX value
 * @param {number} plusDI        — +DI value
 * @param {number} minusDI       — -DI value
 * @param {string} [assetType]   — 'stock' | 'forex' | 'crypto' (default 'forex')
 * @returns {{ regime: string, trendDirection: string }}
 */
export function classifyRegime(atr, atrPct, adx, plusDI, minusDI, assetType = 'forex') {
  const threshold = ATR_PCT_THRESHOLDS[assetType] ?? ATR_PCT_THRESHOLDS.forex;
  const highATR = atrPct > threshold;
  const direction = plusDI > minusDI ? 'up' : 'down';

  if (adx > 25 && highATR) {
    return { regime: 'trending', trendDirection: direction };
  }
  if (adx > 25 && !highATR) {
    // Steady trend: strong directional movement, contained volatility.
    // NOTE: The DB schema CHECK constraint only allows
    // 'trending','ranging','volatile','quiet'.  We store as 'trending'
    // in updateRegime() but return 'steady_trend' from classification.
    return { regime: 'steady_trend', trendDirection: direction };
  }
  if (adx < 20 && highATR) {
    return { regime: 'volatile', trendDirection: 'flat' };
  }
  if (adx < 20 && !highATR) {
    return { regime: 'quiet', trendDirection: 'flat' };
  }

  // ADX between 20 and 25 — ambiguous zone
  return { regime: 'ranging', trendDirection: 'flat' };
}

/**
 * DB-safe regime value.  The `regimes` table CHECK constraint allows:
 * 'trending', 'ranging', 'volatile', 'quiet'.
 * Map 'steady_trend' → 'trending' for storage.
 */
function dbSafeRegime(regime) {
  return regime === 'steady_trend' ? 'trending' : regime;
}

/**
 * Compute ATR(14) and ADX(14) from bars, classify the regime, and persist
 * the result into the `regimes` table.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} symbol
 * @param {Array<{o:number, h:number, l:number, c:number, v:number, t:number}>} bars
 * @param {string} [assetType] — 'stock' | 'forex' | 'crypto'
 * @returns {{ symbol, atr_14, atr_pct, adx_14, regime, trend_direction, computed_at }}
 */
export function updateRegime(db, symbol, bars, assetType = 'forex') {
  const period = 14;
  const atr = computeATR(bars, period);
  const { adx, plusDI, minusDI } = computeADX(bars, period);

  // ATR as a percentage of the latest close
  const lastClose = bars[bars.length - 1].c;
  const atrPct = lastClose !== 0 ? (atr / lastClose) * 100 : 0;

  const { regime, trendDirection } = classifyRegime(
    atr,
    atrPct,
    adx,
    plusDI,
    minusDI,
    assetType,
  );

  const insert = db.prepare(
    `INSERT INTO regimes (symbol, atr_14, atr_pct, adx_14, regime, trend_direction)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const info = insert.run(
    symbol,
    atr,
    atrPct,
    adx,
    dbSafeRegime(regime),
    trendDirection,
  );

  // Read back the inserted row to include computed_at default
  const row = db
    .prepare('SELECT * FROM regimes WHERE id = ?')
    .get(info.lastInsertRowid);

  return {
    ...row,
    regime,            // return the original classification (may be 'steady_trend')
    trend_direction: trendDirection,
  };
}
