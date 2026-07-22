// chrono-math.js — pure geometry + trade-metric maths for the TradeChronograph.
// Kept framework-free so every dial computation is unit-testable.

export const isLong = (side) => side === 'BUY' || side === 'Long' || side === 'long'

/** SVG point on a circle. 0° = 12 o'clock, clockwise. */
export function polar(cx, cy, r, angleDeg) {
  const a = (angleDeg - 90) * (Math.PI / 180)
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

/** SVG arc path from startDeg to endDeg (clockwise) at radius r. */
export function arcPath(cx, cy, r, startDeg, endDeg) {
  const [x1, y1] = polar(cx, cy, r, startDeg)
  const [x2, y2] = polar(cx, cy, r, endDeg)
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0
  const sweep = endDeg > startDeg ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} ${sweep} ${x2} ${y2}`
}

const clamp01 = (v) => Math.max(0, Math.min(1, v))

/**
 * Current price as a fraction along the SL→TP travel (0 = at stop, 1 = at
 * target), plus where entry sits on that same axis. Direction-aware.
 */
export function priceTravel({ entry, sl, tp, side, price }) {
  if ([entry, sl, price].some(v => v == null || !Number.isFinite(Number(v)))) return null
  entry = Number(entry); sl = Number(sl); price = Number(price)
  const long = isLong(side)
  const tpv = tp != null && Number.isFinite(Number(tp)) ? Number(tp) : (long ? entry + (entry - sl) : entry - (sl - entry))
  const lo = long ? sl : tpv
  const hi = long ? tpv : sl
  const span = hi - lo
  if (!(span > 0)) return null
  const f = (v) => clamp01((v - lo) / span)
  // For a SHORT, "toward target" means price falling, so flip so 1 = at target.
  const orient = (v) => (long ? v : 1 - v)
  return { price: orient(f(price)), entry: orient(f(entry)), sl: orient(f(sl)), tp: orient(f(tpv)), tpValue: tpv }
}

/** R-multiple: signed progress in units of the trade's own risk (entry→SL). */
export function rMultiple({ entry, sl, side, price }) {
  if ([entry, sl, price].some(v => v == null || !Number.isFinite(Number(v)))) return null
  entry = Number(entry); sl = Number(sl); price = Number(price)
  const risk = Math.abs(entry - sl)
  if (!(risk > 0)) return null
  const dir = isLong(side) ? 1 : -1
  return (price - entry) * dir / risk
}

/** Milliseconds in trade since entry. */
export function elapsedMs(openedAt, now = Date.now()) {
  const t = Date.parse(openedAt || '')
  if (!Number.isFinite(t)) return null
  return Math.max(0, now - t)
}

/** Compact H:MM:SS / M:SS for the chronograph centre. */
export function fmtDuration(ms) {
  if (ms == null) return '—'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/** R gained per hour since entry (the tachymeter's rate). null if <30s in. */
export function velocityRPerHr({ r, ms }) {
  if (r == null || ms == null || ms < 30_000) return null
  return r / (ms / 3_600_000)
}

/**
 * Guard the Target sub-dial's "full" R value. When a position's SL sits at
 * or near its entry (a data problem — an untracked/adopted position with no
 * real stop recorded, or a genuine near-zero-risk placeholder), rMultiple's
 * risk denominator collapses toward zero and the ratio to TP1 explodes into
 * a meaningless number like "-384.6R" (owner screenshot: exactly this).
 * Rather than display a number that LOOKS precise but means nothing, this
 * caps what counts as a sane target — anything past ±`cap` R reads as bad
 * SL/TP data, not "a moonshot target".
 */
export function safeTargetR(rTp, cap = 50) {
  return Number.isFinite(rTp) && rTp > 0 && rTp <= cap ? rTp : null
}

/**
 * How close price is to the stop, 0 (at entry or better) → 1 (at the stop).
 * The "danger" sub-dial: 1 means the SL is about to hit.
 */
export function slProximity({ entry, sl, side, price }) {
  const t = priceTravel({ entry, sl, tp: null, side, price })
  if (!t) return null
  // t.sl is 0-ish (at stop) and t.entry is the entry fraction; map price between
  // entry (safe=0) and sl (danger=1).
  const span = t.entry - t.sl
  if (!(Math.abs(span) > 1e-9)) return null
  return clamp01((t.entry - t.price) / span)
}
