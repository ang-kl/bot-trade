// agent/lib/quiet-hours.js — weekend quiet hours for recommendations.
//
// Owner (01-08-2026, Saturday): "i don't need any Telegram recommendation or
// scan until Monday (1 AM) before Sydney open or day of the market open so it
// is more realistic with the market's fundamentals."
//
// Two rules fall out of that sentence:
//
//   1. WEEKEND QUIET — from Saturday 00:00 SGT until Monday 01:00 SGT
//      (four hours before the Sydney FX open at ~05:00 SGT), the scan phase
//      does not run and no recommendation alert is sent. A weekend scan
//      reads Friday's stale close dressed up as a signal; the owner wants
//      recommendations that face live fundamentals.
//   2. MARKET-OPEN DAY — outside the quiet window, a symbol is only worth
//      recommending on a day its own market actually trades: open now, or
//      opening later the same SGT calendar day. A Monday-morning stock rec
//      is fine (NYSE opens Monday evening SGT — same day); a rec for a
//      market that stays shut all day is not.
//
// Everything else — position monitoring, protection, guards, reconcile,
// P&L backfill — is deliberately UNTOUCHED by this module: quiet hours
// silence the mouth, never the brakes.
//
// SGT is UTC+8 with no DST, so the arithmetic is a fixed offset — no
// Intl formatter needed on this path.

const SGT_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 24 * 3_600_000

/** Day-of-week (0=Sun..6=Sat) and ms-into-day, in SGT. */
function sgtParts(nowMs) {
  const t = nowMs + SGT_OFFSET_MS
  const msIntoDay = ((t % DAY_MS) + DAY_MS) % DAY_MS
  const day = new Date(t).getUTCDay()
  return { day, msIntoDay }
}

/**
 * True inside the weekend quiet window: Saturday 00:00 SGT → Monday 01:00 SGT.
 */
export function weekendQuietNow(nowMs = Date.now()) {
  const { day, msIntoDay } = sgtParts(nowMs)
  if (day === 6 || day === 0) return true            // all of Sat & Sun
  if (day === 1 && msIntoDay < 3_600_000) return true // Monday 00:00–01:00
  return false
}

/** When the current quiet window ends (ms epoch), or null when not quiet. */
export function quietUntilMs(nowMs = Date.now()) {
  if (!weekendQuietNow(nowMs)) return null
  const { day, msIntoDay } = sgtParts(nowMs)
  const daysToMonday = day === 6 ? 2 : day === 0 ? 1 : 0
  const startOfDaySgt = nowMs - msIntoDay
  return startOfDaySgt + daysToMonday * DAY_MS + 3_600_000 // Monday 01:00 SGT
}

/**
 * Market-open-day rule: recommendable when the symbol's market is open now,
 * or opens later within the SAME SGT calendar day.
 *
 * `hours` is the /state/market-hours shape ({open, next_open_at}) or the
 * isSymbolOpenCached result ({open, nextOpenAt}). UNKNOWN hours fail OPEN —
 * a missing schedule must not silently mute a symbol forever.
 */
export function recommendableToday(hours, nowMs = Date.now()) {
  if (!hours || typeof hours !== 'object') return true
  if (hours.open === true) return true
  const nextRaw = hours.next_open_at ?? hours.nextOpenAt ?? null
  if (nextRaw == null) return true // closed but no reopen time known → honest unknown → allow
  const nextMs = typeof nextRaw === 'number' ? nextRaw : Date.parse(nextRaw)
  if (!Number.isFinite(nextMs)) return true
  const { msIntoDay } = sgtParts(nowMs)
  const endOfDaySgt = nowMs - msIntoDay + DAY_MS
  return nextMs < endOfDaySgt
}
