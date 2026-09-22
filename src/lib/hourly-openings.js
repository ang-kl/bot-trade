// Display freshness only; this does not change any trading threshold.
export const OPENINGS_MAX_AGE_MS = 120_000
const HOUR = 3600_000
const count = n => Number.isSafeInteger(n) && n >= 0

export function openingEvidence(report, { accountId, to, nowMs = Date.now() }) {
  if (!report || report.source !== 'local_trade_ledger'
    || report.accountId !== accountId || report.to !== to || report.from !== to - 24 * HOUR) return null
  const age = nowMs - Date.parse(report.generatedAt)
  if (!Number.isFinite(age) || age < 0 || age >= OPENINGS_MAX_AGE_MS) return null
  if (![report.openedN, report.legacyN, report.adoptedN, report.unknownTimeN].every(count)
    || !Array.isArray(report.rows) || report.rows.length !== 24) return null
  if (report.rows.some((r, i) => r.from !== report.from + i * HOUR || r.to !== r.from + HOUR
    || ![r.openedN, r.legacyN, r.adoptedN].every(count)
    || r.legacyN > r.openedN || r.adoptedN > r.openedN)) return null
  if (report.rows.reduce((n, r) => n + r.openedN, 0) !== report.openedN) return null
  return report
}

export function openingCountLabel(value, unknownTimeN = 0) {
  if (value == null) return '—'
  if (unknownTimeN) return value > 0 ? `≥${value}` : 'unknown'
  return String(value)
}
