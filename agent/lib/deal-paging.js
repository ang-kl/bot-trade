// agent/lib/deal-paging.js — one walk of the broker's deal history, used by
// every caller that pulls deals.
//
// WHY THIS EXISTS. cTrader's ProtoOAGetDealListReq has TWO limits and the
// code in this repo respected only one of them in two of its three callers:
//
//   1. the WINDOW is capped at a week, so a longer span is walked week by
//      week — every caller did this;
//   2. the RESPONSE is capped at `maxRows` (wsGetDeals sends 500) and sets
//      `hasMore` when it truncated — `broker-history-import.js` and
//      `pnl-backfill.js` never read it.
//
// A week with more than 500 deals therefore came back SHORT, with no error
// and no flag, on both paths. pnl-backfill's figures are money: a silently
// truncated pull there produces a net P&L that is wrong and looks fine.
// `entry-ledger.js` got this right, which is the model this file generalises.
//
// AND THE CURSOR MUST NOT SKIP. Advancing to `last + 1` drops any deal that
// shares the last one's millisecond, which is exactly what a partial fill
// looks like. So the cursor lands ON that timestamp and the overlap is
// dropped by dealId: a duplicate is visible and fixable, a skipped deal is
// neither.
//
// TRUNCATION IS REPORTED, NEVER SWALLOWED. When the walk cannot finish —
// the page cap, or a page that says `hasMore` without advancing — the result
// says `complete: false` and the caller decides. A pull that quietly returns
// what it managed to get is the shape this file was written to remove.

/** cTrader caps one deal-list request at a week. */
export const WEEK_MS = 7 * 24 * 3_600_000

/**
 * Pages per WINDOW, not per walk: a 60-day backfill is 9 windows, each
 * allowed this many pages. 20 pages x 500 rows is 10,000 deals in one week,
 * which is far past anything these accounts produce — reaching it means
 * something is wrong, and that is worth reporting rather than grinding on.
 */
export const DEAL_PULL_MAX_PAGES = 20

const dealField = (d, key) => d?.[key] ?? d?.tradeData?.[key]

/** Execution time in ms, or null. Falls back to createTimestamp. */
export const dealTimestampMs = (d) => {
  const v = Number(dealField(d, 'executionTimestamp') ?? dealField(d, 'createTimestamp'))
  return Number.isFinite(v) ? v : null
}

/**
 * Every deal in [fromMs, toMs), walking windows and following `hasMore`.
 *
 * `getDeals(t0, t1)` resolves to ProtoOAGetDealListRes: `{ deal: [...],
 * hasMore }`. In production that is `wsGetDeals`; tests pass a fake.
 *
 * Returns `{ deals, complete, pages, windows, stoppedAt, reason }`.
 * **`complete` is the field that matters** — `deals` alone cannot tell a
 * caller whether it is looking at the whole record or part of it.
 */
export async function pageDeals(getDeals, fromMs, toMs, { maxPages = DEAL_PULL_MAX_PAGES } = {}) {
  const out = { deals: [], complete: false, pages: 0, windows: 0, stoppedAt: null, reason: null }
  if (typeof getDeals !== 'function') { out.reason = 'no_getter'; return out }
  const from = Number(fromMs), to = Number(toMs)
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) {
    out.reason = 'empty_window'
    return out
  }

  const seen = new Set()
  for (let t0 = from; t0 < to; t0 += WEEK_MS) {
    const windowTo = Math.min(t0 + WEEK_MS, to)
    out.windows++
    let cursor = t0
    let pagesThisWindow = 0

    for (;;) {
      if (pagesThisWindow >= maxPages) {
        out.stoppedAt = cursor
        out.reason = `page_cap_${maxPages}`
        return out
      }
      const chunk = await getDeals(cursor, windowTo)
      out.pages++
      pagesThisWindow++
      const page = (chunk && chunk.deal) || []

      let maxTs = cursor
      let added = 0
      for (const d of page) {
        const ts = dealTimestampMs(d)
        if (ts != null && ts > maxTs) maxTs = ts
        // A deal with no id cannot be deduped, so it is kept — counting it
        // twice is visible in a verdict; dropping it is not.
        const id = dealField(d, 'dealId')
        const key = id == null ? null : String(id)
        if (key != null && seen.has(key)) continue
        if (key != null) seen.add(key)
        out.deals.push(d)
        added++
      }

      if (!chunk?.hasMore) break
      if (maxTs <= cursor || added === 0) {
        // `hasMore` is set but the window did not move and nothing new came
        // back. Following it again asks the identical question forever.
        out.stoppedAt = cursor
        out.reason = 'stalled_with_has_more'
        return out
      }
      cursor = maxTs
    }
  }

  out.complete = true
  return out
}
