// Chart timeframe ladder — TWO rows for the full-chart TF picker (owner
// spec: "date and time should just be two rows"): TIME = intraday (minutes
// + hours), DATE = daily and up. Every tf here is legal server-side
// (agent/lib/timeframes.js parseTimeframe handles synthetic aggregation:
// 2m, 8h, 5d, 2w, 2mo, 6mo, 12mo — cap 1y), and the picker also accepts
// refined free text (e.g. 1.5h, 90m) validated by the same parser.
export const CHART_TF_ROWS = [
  { label: 'time', tfs: ['1m', '2m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h'] },
  { label: 'date', tfs: ['1d', '3d', '5d', '1w', '2w', '1mo', '2mo', '3mo', '6mo', '12mo'] },
]

// Legacy grouped shape — kept for existing tests/readers.
export const CHART_TF_GROUPS = [
  { label: 'min', tfs: ['1m', '2m', '5m', '15m', '30m'] },
  { label: 'hour', tfs: ['1h', '2h', '4h', '8h', '12h'] },
  { label: 'day', tfs: ['1d', '3d', '5d'] },
  { label: 'week', tfs: ['1w', '2w'] },
  { label: 'month', tfs: ['1mo', '2mo', '3mo', '6mo', '12mo'] },
]
