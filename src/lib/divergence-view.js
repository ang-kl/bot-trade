// Formatting for DivergenceCard — kept out of the component file so the file
// exports only components (react-refresh/only-export-components) and so the
// number formatting is testable on its own.
//
// Every formatter renders '—' for null/undefined/NaN. The services deliberately
// emit null where a figure is unrepresentative (a PF with no losses yet is
// null, not ∞ — agent/services/divergence.js liveEdgeOf), and a dash is the
// honest rendering of "not a number", where '0.00' or 'NaN' would each be a
// claim.
const isNum = (v) => v != null && Number.isFinite(Number(v))

export const fmt = (v, dp = 2) => (isNum(v) ? Number(v).toFixed(dp) : '—')
export const pct = (v) => (isNum(v) ? `${Number(v).toFixed(1)}%` : '—')
// U+2212 minus, not a hyphen: the hyphen wraps and reads as a dash in a
// tabular column.
export const money = (v) => (isNum(v) ? `${Number(v) < 0 ? '−' : ''}$${Math.abs(Number(v)).toFixed(2)}` : '—')
export const signed = (v, dp = 2) => (isNum(v) ? `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(dp)}` : '—')
export { isNum }
