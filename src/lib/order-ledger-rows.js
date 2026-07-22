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

// Plain price distances from the order's trigger to its planned TP/SL —
// doesn't need a live price at all, since a resting order's own trigger IS
// its reference point (owner: "Set-order ledger: should also have [To
// TP/SL, to TP, to SL]"). Returns nulls when a level or the trigger itself
// isn't set yet.
export function orderTpSlDistance(row) {
  const trigger = orderTriggerPrice(row)
  const tp = row?.tp != null ? Number(row.tp) : null
  const sl = row?.sl != null ? Number(row.sl) : null
  return {
    toTp: trigger != null && tp != null ? Math.abs(tp - trigger) : null,
    toSl: trigger != null && sl != null ? Math.abs(trigger - sl) : null,
  }
}

// Coarser-as-it-grows duration string (m → h → d) — mirrors StdTradeTable's
// fmtDuration so "duration pending" reads the same way everywhere.
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return mins % 60 ? `${hrs}h ${mins % 60}m` : `${hrs}h`
  const days = Math.floor(hrs / 24)
  return hrs % 24 ? `${days}d ${hrs % 24}h` : `${days}d`
}

// How long an order has sat pending: from when it was first seen resting on
// the book, to now (still working) or to when it left the book (gone).
export function orderPendingMs(row, { gone = false } = {}) {
  const start = Date.parse(String(row?.first_seen || '').includes('T') ? row.first_seen : String(row?.first_seen || '').replace(' ', 'T') + 'Z')
  if (!Number.isFinite(start)) return null
  const endIso = gone ? (row?.gone_at || row?.last_seen) : null
  const end = gone
    ? Date.parse(String(endIso || '').includes('T') ? endIso : String(endIso || '').replace(' ', 'T') + 'Z')
    : Date.now()
  if (!Number.isFinite(end)) return null
  return Math.max(0, end - start)
}
