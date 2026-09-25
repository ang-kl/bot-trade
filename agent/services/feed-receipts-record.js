// ---------------------------------------------------------------------------
// agent/services/feed-receipts-record.js — keeps the per-timeframe bar
// receipts and the last measured feed-latency window (lib/feed-receipts.js)
// across a restart (V3 WEB-9b).
//
// Every merge restarts Node, and the receipts live in the process. Without a
// stored copy the Data-feed card would read "none received" for every
// timeframe after each deploy until the scan refetched — true of the new
// process, and silent about the old one. The stored copy seeds the new
// process at boot; every seeded source is marked `fromPreviousProcess` and
// keeps its own receipt time, so its age says how old it is. It is never
// presented as received by this process.
//
// One agent_state row (`data_feed_receipts_json`), written at most once per
// `everyMs` and only when something was recorded since the last write.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { feedReceiptsChangedAtMs, feedReceiptsForStore, hydrateFeedReceipts } from '../lib/feed-receipts.js'

export const FEED_RECEIPTS_KEY = 'data_feed_receipts_json'
const PERSIST_EVERY_MS = 60_000

let timer = null
let persistedChangeMs = -1

/** The stored snapshot, or null when none (or unreadable). */
export function storedFeedReceipts(db) {
  try { return JSON.parse(getState(db, FEED_RECEIPTS_KEY) || 'null') } catch { return null }
}

/**
 * Write the snapshot when anything was recorded since the last write.
 * @returns {boolean} whether a row was written
 */
export function persistFeedReceipts(db, nowMs = Date.now()) {
  const changed = feedReceiptsChangedAtMs()
  if (changed === persistedChangeMs) return false
  try {
    setState(db, FEED_RECEIPTS_KEY, JSON.stringify(feedReceiptsForStore(nowMs)))
    persistedChangeMs = changed
    return true
  } catch {
    return false
  }
}

/**
 * Boot: seed the in-process record from the stored row, then persist on a
 * timer. Idempotent — a second call does nothing.
 * @returns {{seeded: number}|false}
 */
export function startFeedReceiptsRecord(db, { everyMs = PERSIST_EVERY_MS } = {}) {
  if (timer) return false
  const seeded = hydrateFeedReceipts(storedFeedReceipts(db))
  // Seeding is not a change worth writing back: the row already holds it.
  persistedChangeMs = feedReceiptsChangedAtMs()
  timer = setInterval(() => persistFeedReceipts(db), everyMs)
  timer.unref?.()
  return { seeded }
}

/** Test seam. */
export function _stopFeedReceiptsRecordForTests() {
  if (timer) clearInterval(timer)
  timer = null
  persistedChangeMs = -1
}
