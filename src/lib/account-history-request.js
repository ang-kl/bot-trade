// V3 B3 (P5d-1): the server summarises the whole history window, so the
// Performance panel no longer needs 2,000 raw observations a minute to show
// it. The page only feeds the raw table: ten table pages per request.
export const HISTORY_ROWS_PER_PAGE = 24
export const HISTORY_PAGE_LIMIT = HISTORY_ROWS_PER_PAGE * 10
export const historyPath = (accountId, from, to, before) => `/state/account-history?account=${encodeURIComponent(accountId)}`
  + `&from=${from}&to=${to}&limit=${HISTORY_PAGE_LIMIT}${before == null ? '' : `&before=${before}`}`

/** The report for exactly this account and window, or null: unavailable is not an empty history. */
export async function fetchAccountHistory(get, { accountId, from, to, before = null }) {
  try {
    const r = await get(historyPath(accountId, from, to, before))
    return r?.accountId === accountId && r.from === from && r.to === to && Array.isArray(r.points) ? r : null
  } catch { return null }
}
