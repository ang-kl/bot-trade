// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// GET /state/prices — the newest close per symbol across every scan cycle, the
// base tier of the Desk and Trade price maps (src/lib/latest-prices.js).
//
// Measured 10-10: median 1.2 s, worst 13.4 s, one 45 s client abort. The read
// already runs on a report worker (readLatestPrices), but nothing kept its
// answer: the route's 10 s response cache was emptied by every successful
// POST /actions/* (lib/state-cache.js), and the Desk POSTed on every 5-second
// cycle, so each Desk tab started a fresh worker scan every five seconds and
// queued against the two shared dashboard slots.
//
// Now one answer is kept for LATEST_PRICES_TTL_MS and every caller in that
// window shares it; callers that arrive while it is being built share the one
// build (single-flight — brokerReadCache keeps an unfinished read shared and
// starts the TTL when it completes). A failed read is never kept: the next
// caller tries again, and the route still answers an explicit 503.
//
// WHY 30 s. The source rows are written by the scan loop, once per loop pass
// (minutes, rotating a subset of the watchlist each pass), and both pages
// layer the CURRENT cycle's scan prices on top of this base tier as the
// fresher value. So 30 s is well under one source update for any symbol, while
// collapsing a 5-second Desk poll (x tabs) into at most two worker scans a
// minute. `asOf` says when the kept answer was read, so a reader can say how
// old it is instead of presenting it as live.
import { brokerReadCache } from '../lib/broker-read-scope.js'
import { readLatestPrices } from './performance-populations.js'

export const LATEST_PRICES_TTL_MS = 30_000

/**
 * @param {object} db
 * @param {{ read?: Function, ttlMs?: number, now?: () => number }} [deps]  test seams
 * @returns {() => Promise<{ prices: object, asOf: string }>}
 */
export function createLatestPricesReader(db, { read = readLatestPrices, ttlMs = LATEST_PRICES_TTL_MS, now = Date.now } = {}) {
  const kept = brokerReadCache({ ttlMs, now })
  return () => kept('latest-prices', async () => {
    const prices = await read(db)
    return { prices, asOf: new Date(now()).toISOString() }
  })
}
