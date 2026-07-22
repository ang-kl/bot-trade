// agent/lib/indicators.js
// MIRROR TWIN: src/lib/indicators.js — the two files must stay byte-identical
// in logic. Pure functions only: no I/O, no imports from agent-only modules
// (math is copied, never imported across the agent/UI boundary), so the
// server-rendered Telegram charts match the app EXACTLY.
//
// Bars are {t(ms), o, h, l, c, v}. All series returned are aligned to `bars`
// (index i of the output describes bars[i]); warmup slots are null.

/** Simple moving average of closes. Array<number|null> aligned to bars. */
export function smaSeries(bars, period) {
  const out = new Array(bars.length).fill(null);
  if (!Number.isFinite(period) || period < 1) return out;
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c;
    if (i >= period) sum -= bars[i - period].c;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average of closes, seeded with the SMA of the first
 * `period` closes (standard convention → identical warmup nulls to SMA). */
export function emaSeries(bars, period) {
  const out = new Array(bars.length).fill(null);
  if (!Number.isFinite(period) || period < 1 || bars.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += bars[i].c;
  let ema = seed / period;
  out[period - 1] = ema;
  for (let i = period; i < bars.length; i++) {
    ema = bars[i].c * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/** Wilder's RSI of a closes array. Array<number|null> aligned to closes, [0,100]. */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (!Number.isFinite(period) || period < 1 || closes.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** MACD: fast/slow EMA of closes (via emaSeries), signal = EMA of the MACD line.
 * Returns {macdLine, signalLine, histogram} arrays aligned to closes. */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const n = closes.length;
  const bars = closes.map((c) => ({ c }));
  const fastEma = emaSeries(bars, fast);
  const slowEma = emaSeries(bars, slow);
  const macdLine = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (fastEma[i] != null && slowEma[i] != null) macdLine[i] = fastEma[i] - slowEma[i];
  }
  const firstValid = macdLine.findIndex((v) => v != null);
  const signalLine = new Array(n).fill(null);
  if (firstValid !== -1 && n - firstValid >= signal) {
    const macdBars = macdLine.slice(firstValid).map((v) => ({ c: v }));
    const sub = emaSeries(macdBars, signal);
    for (let i = 0; i < sub.length; i++) signalLine[firstValid + i] = sub[i];
  }
  const histogram = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (macdLine[i] != null && signalLine[i] != null) histogram[i] = macdLine[i] - signalLine[i];
  }
  return { macdLine, signalLine, histogram };
}

/** Stochastic oscillator. %K from high/low/close over kPeriod, %D = SMA(%K, dPeriod).
 * Returns {k, d} arrays aligned to bars, values in [0,100]. */
export function stochastic(bars, kPeriod = 14, dPeriod = 3) {
  const n = bars.length;
  const k = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (bars[j].h > hi) hi = bars[j].h;
      if (bars[j].l < lo) lo = bars[j].l;
    }
    const range = hi - lo;
    k[i] = range === 0 ? 100 : ((bars[i].c - lo) / range) * 100;
  }
  const d = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (k[i] == null) continue;
    const start = i - dPeriod + 1;
    if (start < 0 || k[start] == null) continue;
    let sum = 0;
    for (let j = start; j <= i; j++) sum += k[j];
    d[i] = sum / dPeriod;
  }
  return { k, d };
}

/** Volume-weighted average price, cumulative from anchor index.
 * Typical price = (h+l+c)/3. Slots before the anchor are null. */
export function vwapSeries(bars, anchorIdx = 0) {
  const out = new Array(bars.length).fill(null);
  const start = Math.max(0, anchorIdx | 0);
  let pv = 0;
  let vol = 0;
  for (let i = start; i < bars.length; i++) {
    const b = bars[i];
    const tp = (b.h + b.l + b.c) / 3;
    const v = b.v || 0;
    pv += tp * v;
    vol += v;
    // Zero-volume run since anchor: fall back to typical price so the line
    // is still drawable rather than NaN.
    out[i] = vol > 0 ? pv / vol : tp;
  }
  return out;
}

/**
 * Session-ANCHORED VWAP: the cumulative sums reset at each real calendar
 * boundary (default the UTC day) instead of at the fetched-window start. A true
 * VWAP resets at a session/day/week anchor — anchoring at index 0 both measured
 * against the wrong baseline (a rolling ~window-length average) AND drifted the
 * absolute level between fetches, because index 0 mapped to a different real
 * timestamp on each scan. Resetting on `floor(t / periodMs)` change fixes both:
 * a fixed real bar always falls in the same period, so its VWAP is stable and
 * reads as the CURRENT session's VWAP. Bars must carry a ms timestamp `t`;
 * without one it degrades to a single-window cumulative (old behaviour).
 */
export function vwapAnchored(bars, periodMs = 86_400_000) {
  const out = new Array(bars.length).fill(null);
  let pv = 0;
  let vol = 0;
  let curPeriod = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const t = b.t ?? b.time ?? null;
    const period = t != null && periodMs > 0 ? Math.floor(Number(t) / periodMs) : 0;
    if (curPeriod === null || period !== curPeriod) { pv = 0; vol = 0; curPeriod = period; } // reset at the anchor
    const tp = (b.h + b.l + b.c) / 3;
    const v = b.v || 0;
    pv += tp * v;
    vol += v;
    out[i] = vol > 0 ? pv / vol : tp;
  }
  return out;
}

/** Anchored VWAP: anchor by TIMESTAMP (ms) — first bar with t >= anchorT. */
export function avwapSeries(bars, anchorT) {
  let idx = bars.findIndex((b) => b.t >= anchorT);
  if (idx === -1) return new Array(bars.length).fill(null); // anchor after data
  return vwapSeries(bars, idx);
}

/**
 * Fair-value gaps (3-bar imbalances).
 * Bull: bar[i-2].h < bar[i].l  → zone [bar[i-2].h .. bar[i].l]
 * Bear: bar[i-2].l > bar[i].h  → zone [bar[i].h .. bar[i-2].l]
 * A zone is "filled" at the first LATER bar whose range trades fully through
 * it (bull: low <= bottom; bear: high >= top). filledIdx null while open.
 * Returns [{dir:'bull'|'bear', top, bottom, fromIdx, filledIdx|null}]
 * where fromIdx is the index of the third (gap-completing) bar.
 */
export function findFvgZones(bars) {
  const zones = [];
  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2];
    const c = bars[i];
    if (a.h < c.l) {
      zones.push({ dir: 'bull', top: c.l, bottom: a.h, fromIdx: i, filledIdx: null });
    } else if (a.l > c.h) {
      zones.push({ dir: 'bear', top: a.l, bottom: c.h, fromIdx: i, filledIdx: null });
    }
  }
  for (const z of zones) {
    for (let j = z.fromIdx + 1; j < bars.length; j++) {
      const filled = z.dir === 'bull' ? bars[j].l <= z.bottom : bars[j].h >= z.top;
      if (filled) {
        z.filledIdx = j;
        break;
      }
    }
  }
  return zones;
}

/**
 * Volume profile.
 * opts: {type:'session'|'visible'|'fixed'|'composite', buckets=24, fromIdx?, toIdx?, sessionMs?}
 *  - session:   profile of the LAST session window (sessionMs, default 24h of bar time)
 *  - visible:   fromIdx..toIdx inclusive (caller passes the visible range)
 *  - fixed:     explicit fromIdx..toIdx — same math as visible; semantic alias
 *  - composite: the whole series
 * Each bar's volume is spread uniformly across the price buckets its h..l
 * range overlaps. Returns {rows:[{price, volume, pct}], pocPrice, vahPrice, valPrice}
 * — rows ascending by price, price = bucket midpoint, pct sums to ~100.
 * VAH/VAL bound the 70% value area grown outward from the POC (standard
 * expansion: repeatedly add the larger neighbouring bucket).
 */
export function volumeProfile(bars, opts = {}) {
  const { type = 'composite', buckets = 24, sessionMs = 24 * 60 * 60 * 1000 } = opts;
  let from = 0;
  let to = bars.length - 1;
  if (type === 'visible' || type === 'fixed') {
    from = Math.max(0, opts.fromIdx ?? 0);
    to = Math.min(bars.length - 1, opts.toIdx ?? bars.length - 1);
  } else if (type === 'session') {
    // Last session window measured back from the final bar's timestamp.
    const cutoff = bars.length ? bars[bars.length - 1].t - sessionMs : 0;
    from = bars.findIndex((b) => b.t > cutoff);
    if (from === -1) from = 0;
  }
  const slice = bars.slice(from, to + 1);
  if (!slice.length) return { rows: [], pocPrice: null, vahPrice: null, valPrice: null };

  let lo = Infinity;
  let hi = -Infinity;
  for (const b of slice) {
    if (b.l < lo) lo = b.l;
    if (b.h > hi) hi = b.h;
  }
  const n = Math.max(1, buckets | 0);
  const span = hi - lo;
  const step = span > 0 ? span / n : 1; // flat series: single-price degenerate case
  const vols = new Array(n).fill(0);

  for (const b of slice) {
    const v = b.v || 0;
    if (v <= 0) continue;
    if (span === 0) {
      vols[0] += v;
      continue;
    }
    // Buckets this bar's h..l range overlaps; spread volume uniformly.
    let b0 = Math.floor((b.l - lo) / step);
    let b1 = Math.floor((b.h - lo) / step);
    b0 = Math.min(n - 1, Math.max(0, b0));
    b1 = Math.min(n - 1, Math.max(0, b1));
    const share = v / (b1 - b0 + 1);
    for (let k = b0; k <= b1; k++) vols[k] += share;
  }

  const total = vols.reduce((s, x) => s + x, 0);
  const rows = vols.map((volume, k) => ({
    price: lo + (k + 0.5) * step,
    volume,
    pct: total > 0 ? (volume / total) * 100 : 0,
  }));

  if (total <= 0) return { rows, pocPrice: null, vahPrice: null, valPrice: null };

  // POC = heaviest bucket.
  let poc = 0;
  for (let k = 1; k < n; k++) if (vols[k] > vols[poc]) poc = k;

  // 70% value area, standard expansion from POC: at each step add whichever
  // neighbouring bucket (above/below the current area) carries more volume.
  const target = total * 0.7;
  let loK = poc;
  let hiK = poc;
  let acc = vols[poc];
  while (acc < target && (loK > 0 || hiK < n - 1)) {
    const below = loK > 0 ? vols[loK - 1] : -1;
    const above = hiK < n - 1 ? vols[hiK + 1] : -1;
    if (above >= below) {
      hiK += 1;
      acc += vols[hiK];
    } else {
      loK -= 1;
      acc += vols[loK];
    }
  }

  return {
    rows,
    pocPrice: rows[poc].price,
    vahPrice: rows[hiK].price,
    valPrice: rows[loK].price,
  };
}
