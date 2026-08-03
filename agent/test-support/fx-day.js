// Test-only helper: a closed_at that is ALWAYS inside the current FX day.
//
// The bug this exists for, found 03-08-2026 at 21:08 UTC: eleven tests failed
// on a clean tree, and passed again twenty minutes later. Their fixtures stamp
// trades with `datetime('now', '-10 minutes')` and the code under test sums
// "today", where today is the FX day that opens at 21:00 UTC. Between 21:00
// and 21:10 UTC, "ten minutes ago" is YESTERDAY, the sum comes back empty, and
// every daily-loss assertion inverts.
//
// That is a ten-minute window every single day in which CI fails for reasons
// that have nothing to do with the change under test — the worst kind of red,
// because the reflex is to re-run rather than to read.
//
// clampToFxDay keeps the intent ("closed N minutes ago") and only overrides it
// when N minutes ago would fall on the other side of the day boundary, in
// which case it returns a moment just after the open. Tests that need a row
// OLDER than a grace window cannot be fixed this way — the FX day genuinely is
// not old enough yet — and those pin an explicit clock instead.
import { fxDayOpenMs } from '../services/risk.js'

const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

/**
 * @param {number} minutesAgo how long ago the trade closed, ideally
 * @param {number} nowMs      injectable clock (tests pin it; default real)
 * @returns {string} 'YYYY-MM-DD HH:MM:SS' inside the current FX day
 */
export function clampToFxDay(minutesAgo, nowMs = Date.now()) {
  const wanted = nowMs - minutesAgo * 60_000
  const open = fxDayOpenMs(nowMs)
  // One second past the open, so a `>= dayStart` comparison cannot miss it on
  // an exact-equality boundary.
  return sql(Math.max(wanted, open + 1000))
}
