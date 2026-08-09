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
// CRYPTO EXEMPTION (owner-approved 01-08-2026 evening): crypto trades a
// real 24/7 market, so a weekend crypto price IS live fundamentals — the
// "Friday's stale close" rationale does not apply to it. During weekend
// quiet the scan therefore narrows to crypto symbols only instead of
// going silent; every other category stays quiet until Monday 01:00 SGT.
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
 * Watchlist entries still scannable during weekend quiet — the crypto
 * exemption. Outside the quiet window the list passes through untouched.
 * Inside it, only crypto survives. `categorise` is injected
 * (lib/sessions.js categoriseSymbol) so this module stays dependency-free
 * and the filter is testable; a categoriser failure counts as NOT crypto —
 * quiet hours fail quiet, never loud.
 *
 * @param {Array<{symbol:string}>} watch enabled watchlist entries
 * @param {(symbol:string)=>string} categorise
 * @returns {{quiet:boolean, symbols:Array<{symbol:string}>}}
 */
export function quietScanSymbols(watch, categorise, nowMs = Date.now(), opts = {}) {
  if (!weekendQuietNow(nowMs)) return { quiet: false, symbols: watch }
  const hoursFor = typeof opts.hoursFor === 'function' ? opts.hoursFor : null
  const preOpenHours = preOpenHoursFrom(opts.preOpenHours)
  const preOpen = []
  const symbols = (watch || []).filter(w => {
    try { if (categorise(w.symbol) === 'crypto') return true } catch { /* not crypto */ }
    if (!hoursFor) return false
    let hours = null
    try { hours = hoursFor(w.symbol) } catch { return false }
    if (!inPreOpenWindow(hours, nowMs, preOpenHours)) return false
    preOpen.push(w.symbol)
    return true
  })
  return { quiet: true, symbols, preOpen }
}

/**
 * PRE-OPEN WINDOW (owner, 09-08-2026): "some markets which open on Monday
 * should start monitoring and set pre-trade 6 hours before and reacts to the
 * market."
 *
 * The blanket weekend rule above and that instruction are in direct conflict:
 * on a Sunday evening, six hours before the Sydney or Tokyo open, quiet hours
 * has already narrowed the scan to crypto, so the symbols about to open are the
 * ones the bot is not looking at. This replaces "it is the weekend" with
 * "nothing is opening soon" — which is what the weekend rule was reaching for.
 *
 * Deliberately per SYMBOL and off the broker's own schedule (symbol-hours
 * nextOpenInfo), not a guessed session table. A symbol re-enters the scan when
 * its own next open is within the window; everything else stays quiet exactly
 * as before. The crypto exemption is untouched and evaluated first, so a 24/7
 * market never depends on having a "next open" at all.
 *
 * WHAT THIS DOES NOT CHANGE, and the caller must not assume otherwise: a setup
 * computed six hours before the open is computed on the PREVIOUS session's
 * closing structure. loop.js's own comment calls that "Friday's stale close
 * dressed up as a signal", and it is still true — the answer is not to hide the
 * symbol but to label what comes out of it (see the pre_open strategy tag) so
 * its edge is measured on its own terms rather than blended into intraday.
 *
 * UNKNOWN HOURS STAY QUIET. `recommendableToday` above fails OPEN on unknown
 * hours because muting a symbol forever is the worse error there. Here the
 * default runs the other way: this function ADDS symbols to a deliberately
 * silenced window, so "we do not know when it opens" must not become "scan it".
 */
export const PRE_OPEN_HOURS_DEFAULT = 6
const MAX_PRE_OPEN_HOURS = 48

/** Clamp the configured window; a bad value falls back rather than disabling. */
export function preOpenHoursFrom(raw) {
  // `Number(null)` and `Number('')` are 0, and 0 would silently switch the
  // whole feature off while looking configured. Reject the empty values by
  // identity before coercing — the same trap that has bitten this codebase in
  // entryBlocker, modelledPnlUsd and impliedUnitValue.
  if (raw == null || raw === '') return PRE_OPEN_HOURS_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return PRE_OPEN_HOURS_DEFAULT
  return Math.min(n, MAX_PRE_OPEN_HOURS)
}

/**
 * Is this symbol inside its pre-open window — closed now, opening within N hours?
 *
 * `hours` is the nextOpenInfo/isSymbolOpenCached shape: {open, next_open_at} or
 * {open, nextOpenAt}. Already-open returns FALSE: open is not pre-open, and the
 * caller's quiet window has its own reason for excluding it.
 */
export function inPreOpenWindow(hours, nowMs = Date.now(), preOpenHours = PRE_OPEN_HOURS_DEFAULT) {
  if (!hours || typeof hours !== 'object') return false
  if (hours.open === true) return false
  const nextRaw = hours.next_open_at ?? hours.nextOpenAt ?? null
  if (nextRaw == null) return false        // unknown → stays quiet, see above
  const nextMs = typeof nextRaw === 'number' ? nextRaw : Date.parse(nextRaw)
  if (!Number.isFinite(nextMs)) return false
  const delta = nextMs - nowMs
  // A next-open already in the past is stale schedule data, not an imminent
  // open — treating it as "opening now" would scan on a timestamp nobody
  // refreshed.
  if (delta < 0) return false
  return delta <= preOpenHours * 3_600_000
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
