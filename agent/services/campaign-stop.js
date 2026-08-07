// ---------------------------------------------------------------------------
// agent/services/campaign-stop.js — a drawdown limit that spans DAYS.
//
// Owner, 2026-08-07: "proceed" — on the concentrate-to-prove plan, whose one
// requested setting change was this.
//
// THE GAP IT FILLS. `equityStopPct` is null by default, which means "the same
// threshold as dailyLossPct" — and the daily cap is anchored to the FX day
// open, so it RESETS EVERY MORNING. Nothing in this system limits a WEEK.
// Every day the account receives a fresh licence to lose the daily maximum
// again, and a run of ordinary days compounds with nothing counting.
//
// The arithmetic that made this urgent, computed 07-08 against the daily floor
// shipped the same morning:
//
//   43097342   balance ~1,983   cap  200/day   ~10 trading days to ZERO
//   46130058   balance ~46,073  cap 1,842/day  ~25 trading days to ZERO
//
// Before the floor, 43097342 would have taken 33 days. After it, ten. The floor
// was still the right change — a USD 16.16 cap is a shutdown, not a limit — but
// "the cap was too tight" and "the account can be gone in two working weeks"
// are both true at once, and only one of them was in that PR.
//
//   A daily cap with no campaign cap is not risk control. It is a slower way
//   to lose everything.
//
// WHAT THIS IS NOT. Not a second daily cap, not a trailing stop, and not a
// replacement for either. It is one question the system could not previously
// ask: SINCE THE CAMPAIGN STARTED, how much has this account given back?
//
// OFF UNLESS EXPLICITLY ARMED — and armed means three fields, not one. A
// campaign needs a start time and a starting equity as well as a percentage,
// because a drawdown measured from "now" is not a drawdown. Any missing piece
// leaves the check off rather than guessing an anchor, which is the one
// fail-safe direction available here: an invented anchor would either halt a
// healthy account or fail to halt a bleeding one, and there is no way to tell
// which from inside the function.
// ---------------------------------------------------------------------------

export const DEFAULT_CAMPAIGN = Object.freeze({
  maxDrawdownPct: null,   // e.g. 0.08 — null/0 = no campaign stop
  startEquity: null,      // equity when the campaign began
  startAt: null,          // ISO timestamp; realised P&L is summed from here
  label: null,            // free text, e.g. 'concentrate-to-prove'
})

/**
 * Read the campaign config. Every field must be present and sane, or the whole
 * thing is off — see the header on why a partial campaign is worse than none.
 *
 * @param {object|null} raw
 * @returns {{armed:boolean, maxDrawdownPct:number|null, startEquity:number|null,
 *            startAt:string|null, label:string|null}}
 */
export function campaignConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const pct = Number(c.maxDrawdownPct)
  const eq = Number(c.startEquity)
  const at = typeof c.startAt === 'string' && c.startAt.length >= 10 ? c.startAt : null
  const armed = Number.isFinite(pct) && pct > 0 && pct < 1
    && Number.isFinite(eq) && eq > 0
    && at != null
  return {
    armed,
    maxDrawdownPct: armed ? pct : null,
    startEquity: armed ? eq : null,
    startAt: armed ? at : null,
    label: typeof c.label === 'string' ? c.label : null,
  }
}

/**
 * Pure. Has the campaign given back more than it is allowed to?
 *
 * `realisedSinceStart` is the SIGNED sum of realised P&L since `startAt` —
 * negative for a loss. It is passed in rather than queried so this stays a
 * function of its inputs and the caller owns the account scoping, exactly as
 * the daily cap does.
 *
 * A NULL sum is not zero. If the caller could not compute the total, that is
 * the same class of unknown the unknown-P&L veto exists for, and the honest
 * answer is to halt rather than to read silence as safety.
 *
 * @param {{cfg:object, realisedSinceStart:number|null}} a
 * @returns {{halt:boolean, drawdownUsd:number|null, drawdownPct:number|null,
 *            remainingUsd:number|null, reason:string|null}}
 */
export function campaignStopVerdict({ cfg, realisedSinceStart }) {
  const c = cfg || {}
  if (!c.armed) {
    return { halt: false, drawdownUsd: null, drawdownPct: null, remainingUsd: null, reason: null }
  }
  const budgetUsd = c.startEquity * c.maxDrawdownPct
  if (realisedSinceStart == null || !Number.isFinite(Number(realisedSinceStart))) {
    return {
      halt: true, drawdownUsd: null, drawdownPct: null, remainingUsd: null,
      reason: `campaign_stop (${c.label || 'campaign'}): the realised total since ${c.startAt} could not be computed — an unreadable drawdown is not a safe one, so no new entries`,
    }
  }
  // Only losses count against the budget. A campaign in profit has spent none
  // of it, and "negative drawdown" is not a licence to lose more later — the
  // budget is measured from the STARTING equity, deliberately, not from the
  // high-water mark. A high-water anchor would keep moving the line up and
  // silently widen the allowance every time the account had a good day.
  const lostUsd = Math.max(0, -Number(realisedSinceStart))
  const drawdownPct = lostUsd / c.startEquity
  const remainingUsd = Math.max(0, budgetUsd - lostUsd)
  if (lostUsd < budgetUsd) {
    return {
      halt: false,
      drawdownUsd: round2(lostUsd),
      drawdownPct: round4(drawdownPct),
      remainingUsd: round2(remainingUsd),
      reason: null,
    }
  }
  return {
    halt: true,
    drawdownUsd: round2(lostUsd),
    drawdownPct: round4(drawdownPct),
    remainingUsd: 0,
    reason: `campaign_stop (${c.label || 'campaign'}): down ${round2(lostUsd)} since ${c.startAt}, `
      + `which is ${(drawdownPct * 100).toFixed(2)}% of the ${round2(c.startEquity)} it started with `
      + `and at or past the ${(c.maxDrawdownPct * 100).toFixed(2)}% campaign limit — no new entries. `
      + `The daily cap resets tomorrow; this does not.`,
  }
}

/**
 * The readout — the numbers a human needs to see the campaign at a glance,
 * shaped once here so the route, the page and any future alert cannot drift
 * into describing the same campaign differently.
 */
export function campaignReadout({ cfg, realisedSinceStart, nowMs = null }) {
  const v = campaignStopVerdict({ cfg, realisedSinceStart })
  if (!cfg?.armed) return { armed: false, ...v }
  const budgetUsd = cfg.startEquity * cfg.maxDrawdownPct
  const startMs = Date.parse(cfg.startAt)
  const daysIn = Number.isFinite(startMs) && nowMs != null
    ? Math.max(0, Math.floor((nowMs - startMs) / 86_400_000))
    : null
  return {
    armed: true,
    label: cfg.label,
    startAt: cfg.startAt,
    startEquity: round2(cfg.startEquity),
    maxDrawdownPct: cfg.maxDrawdownPct,
    budgetUsd: round2(budgetUsd),
    realisedSinceStart: realisedSinceStart == null ? null : round2(Number(realisedSinceStart)),
    daysIn,
    // The single number worth putting on a screen: how much of the campaign's
    // whole loss budget is gone. 0 = untouched, 1 = halted.
    budgetUsedFrac: v.drawdownUsd == null || !(budgetUsd > 0)
      ? null
      : round4(Math.min(1, v.drawdownUsd / budgetUsd)),
    ...v,
  }
}

function round2(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null }
function round4(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n) * 10000) / 10000 : null }
