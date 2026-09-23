// Empty is evidence only when the requested account's read actually succeeded.
export function scopedPerformanceRows(response, account, alias) {
  if (!response || response.error || String(response.accountId ?? '') !== String(account)) return null
  const rows = response.rows ?? response[alias]
  return Array.isArray(rows) ? rows : null
}
