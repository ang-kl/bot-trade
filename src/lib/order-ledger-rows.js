// Pure helpers for the resting-order LEDGER view — the durable record of the
// broker's set-orders (working + recently gone). The live "Pending (set)
// orders" table in the broker section shows only what's on the book RIGHT NOW
// and vanishes the moment an order fills; this ledger persists each order with
// its lifecycle, because resting orders fill even when the bot's switches are
// OFF (owner: "keep records of these"). Kept out of the component so the
// parsing is unit-testable.

// A handful of label codes (agent/lib/trade-labels.js's STRATEGIES table)
// don't match the short display code the open-positions table shows for the
// same strategy (src/lib/strategy-labels.js's STRAT_SHORT) — e.g. a donchian
// breakout order's label carries 'DON' but the open-positions table shows
// 'BRK'. Without this, the pending-order ledger and the open-positions table
// disagreed on a live strategy's own short code (owner: "discrepancy ...
// between pending order table and open table"). MIRROR TWIN of the 3
// strategies where the label code and STRAT_SHORT code differ.
const CODE_SHORT = { CUP: 'C&H', DON: 'BRK', RSIM: 'RSI' }

// Strategy short-code carried in a structured bot label ("AP|v1|VP|HI|LDN|4h|
// REGT"). Segment index 2 is the strategy code; manual/foreign orders have no
// structured label, so they report null (rendered as a dash).
export function orderStrategy(label) {
  if (!label || typeof label !== 'string') return null
  const seg = label.split('|')
  if (seg[0] !== 'AP' || seg.length < 3) return null
  const code = seg[2]
  if (!code || code === '-') return null
  return CODE_SHORT[code] || code
}

// Timeframe carried in a structured bot label ("AP|v1|FIB|HI|LDN|4h|REGT").
// Segment index 5 — stored raw (not a coded lookup), so no mapping needed.
export function orderTimeframe(label) {
  if (!label || typeof label !== 'string') return null
  const seg = label.split('|')
  if (seg[0] !== 'AP' || seg.length < 6) return null
  const tf = seg[5]
  return tf && tf !== '-' ? tf : null
}

// Human status for a ledger row. A 'working' order rests on the book; a 'gone'
// order either FILLED or was CANCELLED — the book alone can't always
// distinguish the two, so we label it honestly rather than guess.
export function orderStatusLabel(row) {
  if (!row) return '—'
  return row.status === 'working' ? 'working' : 'filled / cancelled'
}

// ISO week number — the pivot key for the done-orders day→week grouping
// (owner: "group by date and then the week … like a pivot table").
export function isoWeek(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const jan1 = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date - jan1) / 86400000 + 1) / 7)
}

// The entry price a resting order triggers at — limit or stop, whichever the
// order type carries. Returns null when neither is set.
export function orderTriggerPrice(row) {
  if (!row) return null
  if (row.limit_price != null) return Number(row.limit_price)
  if (row.stop_price != null) return Number(row.stop_price)
  return null
}
