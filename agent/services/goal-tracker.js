// Goal tracker — am I going to hit the go-live gate by the deadline, per account?
//
// The owner's standing gate for putting real money on this: win rate above 68%
// and profit factor above 1.68, by 12 Aug 2026. Those two numbers already exist
// on the Performance page as tiles. What the tiles cannot answer is the only
// question that matters in the first week of August: *given the record so far
// and the rate trades are actually closing, is that gate still reachable, and
// what would the remaining trades have to look like?*
//
// ===========================================================================
// WHAT THIS COMPUTES, AND WHAT IT REFUSES TO
// ===========================================================================
//
// REACHABILITY, not a forecast. This does not predict a win rate. It inverts
// the arithmetic: with `n` closed trades of which `w` are wins, and `m` more
// expected before the deadline, the aggregate clears the target `T` only if
// the next `m` contain at least
//
//     needWins = ceil(T·(n + m) − w)
//
// wins. If needWins > m the gate is arithmetically OUT OF REACH at this trade
// rate — no run of luck inside the remaining trades gets there, and saying
// "on pace" would be false. If needWins ≤ 0 it is already locked regardless of
// what the remaining trades do. Everything in between is a required hit rate
// on the remaining trades, `needWins / m`, which is a fact about the record
// and not an opinion about the future.
//
// PROFIT FACTOR needs an assumption, and the assumption is stated. PF is a
// ratio of two sums, so "how many more wins" is under-determined — one huge
// winner clears it, ten small ones may not. The tracker holds the CURRENT
// average win and average loss fixed and solves for the number of winners
// among the remaining `m`:
//
//     (GW + k·avgWin) / (GL + (m − k)·avgLoss) ≥ T
//     ⟹ k ≥ (T·(GL + m·avgLoss) − GW) / (avgWin + T·avgLoss)
//
// That is a "if trades keep being the size they have been" statement, flagged
// as such in `assumes`. Without a prior average win or average loss the answer
// is null — not a guess.
//
// TRADE RATE is measured over the observed record, not assumed. `tradesPerDay`
// comes from the account's own closed-trade history across its actual span
// (first close → last close), and `expectedRemaining` is that rate times the
// calendar days left. When an account has closed trades on only one day the
// span is floored at one day, so the rate is that day's count rather than a
// division by zero.
//
// SAMPLE SIZE is reported, never smoothed. Two wins out of two is a 100% win
// rate and it means nothing; `sampleOk` is false below `minTrades` and the
// verdict says `insufficient_sample` rather than `met`. The owner is deciding
// whether to risk real money, and a green light off a 3-trade sample is worse
// than no light.
//
// SCRATCHES COUNT AS LOSSES, consistent with accountAnalytics — a flat trade
// consumed a slot and returned nothing.
import { accountAnalytics } from './account-analytics.js'
import { listAccounts } from './account-registry.js'
import { getState } from '../db.js'
import { GO_LIVE_BAR } from './edge-bars.js'

export const GOAL_STATE_KEY = 'trading_goal_json'

/** The owner's stated gate. Overridable via agent_state, never invented. */
export const DEFAULT_GOAL = {
  // Values live in edge-bars.js, the register of every numeric edge bar, so a
  // change here is visible next to the arming bar and the breaker floor it
  // silently relates to (Risk-Decision Audit 2026-08-03, finding #3).
  winRatePct: GO_LIVE_BAR.winRatePct,
  profitFactor: GO_LIVE_BAR.profitFactor,
  // WHICH METRIC IS THE GATE. Owner 2026-08-03: profit factor alone.
  //
  // It had been an AND of both, and that made the weaker-looking target the
  // binding one for the wrong reason — 68% wins implies PF ~4.0 at the
  // observed payoff, so requiring both meant requiring the far stricter of
  // the two without anyone deciding to. Win rate is still computed and shown;
  // it just no longer vetoes the gate. 'both' restores the old behaviour.
  gateOn: 'profitFactor',
  deadline: '2026-08-12',
  // Below this many closed trades the numbers are noise, not evidence.
  minTrades: 30,
}

/** Goal config: owner's overrides merged over the stated defaults. */
export function loadGoal(db) {
  let saved = {}
  try {
    const raw = getState(db, GOAL_STATE_KEY)
    if (raw) saved = JSON.parse(raw) || {}
  } catch { saved = {} }
  const num = (v, fallback) => {
    const x = Number(v)
    return Number.isFinite(x) && x > 0 ? x : fallback
  }
  const deadline = typeof saved.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(saved.deadline)
    ? saved.deadline
    : DEFAULT_GOAL.deadline
  return {
    winRatePct: num(saved.winRatePct, DEFAULT_GOAL.winRatePct),
    profitFactor: num(saved.profitFactor, DEFAULT_GOAL.profitFactor),
    gateOn: ['both', 'profitFactor', 'winRate'].includes(saved.gateOn) ? saved.gateOn : DEFAULT_GOAL.gateOn,
    deadline,
    minTrades: Math.round(num(saved.minTrades, DEFAULT_GOAL.minTrades)),
  }
}

/** State key holding the last goal this process observed, for change detection. */
export const GOAL_SEEN_KEY = 'trading_goal_last_seen'

/**
 * Write an `action_log` row whenever the effective go-live goal has changed
 * since the last time anything looked at it.
 *
 * WHY A CHANGE DETECTOR AND NOT A LOGGING SETTER. Risk-Decision Audit,
 * 2026-08-03, finding #2: `loadGoal()` accepts an override from `agent_state`
 * with no audit trail, unlike `performance_breaker_json`, "so the go-live gate
 * itself could be silently loosened (e.g. PF target lowered from 1.68 to 1.2)
 * with no forced record of who changed it or when".
 *
 * The obvious fix is a `saveGoal()` that logs. It would not work: there is no
 * `saveGoal()` today, and there never was — the goal is changed by writing
 * `agent_state` directly. An audit trail hanging off a setter records only the
 * writes that go through the setter, which is exactly the set of writes that
 * were never the concern. Detecting the CHANGE catches every path into the
 * key, including the one an operator would actually use.
 *
 * It cannot say WHO changed it — nothing in the write path carries an actor —
 * and it does not pretend to. It records what the gate was, what it became,
 * and when it was first seen to differ. Never throws.
 *
 * @returns {{changed: boolean, from: object|null, to: object}}
 */
export function auditGoalChange(db, goal) {
  const out = { changed: false, from: null, to: goal }
  try {
    const raw = getState(db, GOAL_SEEN_KEY)
    const prev = raw ? JSON.parse(raw) : null
    const same = prev && ['winRatePct', 'profitFactor', 'gateOn', 'deadline', 'minTrades']
      .every(k => prev[k] === goal[k])
    if (same) return out
    // First observation on a fresh database is not a "change" to report — it
    // is the baseline. Recording it as a change would put a spurious edit in
    // the log every time the DB is rebuilt.
    if (prev) {
      out.changed = true
      out.from = prev
      db.prepare('INSERT INTO action_log (method, path, body) VALUES (?,?,?)')
        .run('STATE', `/goal/${GOAL_STATE_KEY}`, JSON.stringify({ from: prev, to: goal }))
    }
    db.prepare(`
      INSERT INTO agent_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(GOAL_SEEN_KEY, JSON.stringify(goal))
  } catch { /* an audit trail must never break the report it rides on */ }
  return out
}

const DAY_MS = 86_400_000

/** Whole days from now to the END of the deadline day (UTC), floored at 0. */
export function daysRemaining(deadline, nowMs) {
  const end = Date.parse(`${deadline}T23:59:59.999Z`)
  if (!Number.isFinite(end)) return null
  return Math.max(0, Math.ceil((end - nowMs) / DAY_MS))
}

/**
 * Wins required among the next `m` trades for the aggregate hit rate to reach
 * `targetPct`. Returns the raw requirement — callers interpret >m as
 * unreachable and ≤0 as already locked.
 */
export function winsNeeded({ wins, trades, remaining, targetPct }) {
  const t = targetPct / 100
  return Math.ceil(t * (trades + remaining) - wins - 1e-9)
}

/**
 * Winners required among the next `m` trades for profit factor to reach
 * `target`, holding average win and average loss at their observed values.
 * null when there is no observed average win or loss to hold fixed.
 */
/**
 * The WIN RATE that reaches a target profit factor, holding the observed
 * payoff ratio fixed.
 *
 * WHY THIS NUMBER MATTERS MORE THAN THE TWO TARGETS DID (owner 2026-08-03).
 * Profit factor is not independent of win rate — it is determined by it and
 * the payoff ratio:  PF = W/(1−W) × (avgWin/avgLoss).
 *
 * With the observed payoff of 1.86 (avg win $224.77 / avg loss $121.07), the
 * 68% win-rate target implies a profit factor near 4.0, not 1.68. The two
 * configured goals were not a pair — one was far stricter, and the strict one
 * was arithmetically out of reach inside the deadline. Meanwhile PF 1.68 at
 * that same payoff needs only ~47.5% wins, which is a real target.
 *
 * So the tracker now prints the win rate the PF target actually implies. It
 * is the difference between "you need 144 winners from 98 trades" and "you
 * need to win 47.5% instead of 36.3%".
 *
 * @returns {number|null} percent, or null when the payoff is unobservable
 */
export function impliedWinRateForPf({ avgWin, avgLoss, target }) {
  if (!(avgWin > 0) || !(avgLoss > 0) || !(target > 0)) return null
  const r = (target * avgLoss) / avgWin
  return round2((r / (1 + r)) * 100)
}

export function winnersNeededForPf({ grossWin, grossLoss, avgWin, avgLoss, remaining, target }) {
  if (!(avgWin > 0) || !(avgLoss > 0)) return null
  const numer = target * (grossLoss + remaining * avgLoss) - grossWin
  const denom = avgWin + target * avgLoss
  if (!(denom > 0)) return null
  return Math.ceil(numer / denom - 1e-9)
}

/**
 * met | at_risk | out_of_reach | insufficient_sample | no_data
 *
 * THERE IS NO "ON TRACK" STATE, and that is not an omission — it is what the
 * arithmetic says. Both metrics are computed from the account's own observed
 * performance, so "carry on exactly as you have been" converges the aggregate
 * to the value it already has. An account below target that keeps performing
 * exactly as it has been NEVER reaches the target; it only gets there by
 * improving. So "below target but on pace" is not a real condition, and a
 * panel that showed it would be telling the owner to wait for something that
 * cannot arrive on its own. Below target is `at_risk`, and the size of the
 * required lift is carried in `requiredRateOnRemaining` next to `value`.
 *
 * `out_of_reach` is the stronger statement: the target is unreachable at this
 * trade rate even if EVERY remaining trade wins. Arithmetic, not pessimism.
 *
 * `insufficient_sample` outranks `met` deliberately: the gate exists to decide
 * whether to risk real money, and 2-for-2 is not evidence.
 */
function verdictFor({ needed, remaining, sampleOk, trades, meetsNow }) {
  if (trades === 0) return 'no_data'
  if (!sampleOk) return 'insufficient_sample'
  if (meetsNow) return 'met'
  if (needed == null) return 'at_risk' // no basis to compute the requirement
  if (needed <= 0) return 'met'
  if (remaining <= 0 || needed > remaining) return 'out_of_reach'
  return 'at_risk'
}

/**
 * Per-account progress toward the go-live gate.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{now?: number, days?: number|null, accountIds?: string[]|null}} opts
 *   days: restrict the statistics to a rolling window (null = whole record).
 * @returns {{goal, now, daysRemaining, accounts: object[], portfolio: object}}
 */
export function goalTracker(db, { now = Date.now(), days = null, accountIds = null } = {}) {
  const goal = loadGoal(db)
  // Every read of the gate is also a chance to notice the gate moved. Hung
  // here rather than inside loadGoal so the loader stays a pure read that
  // tests can call without side effects.
  auditGoalChange(db, goal)
  const left = daysRemaining(goal.deadline, now)

  const all = listAccounts(db)
  const ids = Array.isArray(accountIds) && accountIds.length
    ? accountIds.map(String)
    : all.map(a => String(a.account_id))

  const registry = new Map(all.map(a => [String(a.account_id), a]))
  const accounts = ids.map(id => {
    const reg = registry.get(id) || null
    return buildRow({
      key: id,
      label: reg?.broker_label || null,
      isLive: reg?.is_live === 1,
      enabled: reg?.enabled === 1,
      stats: accountAnalytics(db, { accountId: id, days, now }),
      goal,
      left,
    })
  })

  // The portfolio row is recomputed from every trade, NOT averaged from the
  // per-account rates — two accounts at 50% do not make a 50% portfolio unless
  // they closed the same number of trades.
  const portfolio = buildRow({
    key: 'all',
    label: 'All accounts',
    isLive: null,
    enabled: null,
    stats: accountAnalytics(db, { accountId: null, days, now }),
    goal,
    left,
  })

  return { goal, now, daysRemaining: left, windowDays: days || null, accounts, portfolio }
}

function buildRow({ key, label, isLive, enabled, stats, goal, left }) {
  const trades = stats.trades || 0
  const sampleOk = trades >= goal.minTrades
  // Observed closing rate over this account's own span, floored at one day so
  // an account that closed everything today reports today's count, not ∞.
  const spanDays = stats.firstMs != null && stats.lastMs != null
    ? Math.max(1, Math.ceil((stats.lastMs - stats.firstMs) / DAY_MS))
    : null
  const tradesPerDay = spanDays ? round2(trades / spanDays) : null
  const expectedRemaining = tradesPerDay != null && left != null
    ? Math.round(tradesPerDay * left)
    : null

  const m = expectedRemaining ?? 0
  const wNeed = trades > 0 ? winsNeeded({ wins: stats.wins, trades, remaining: m, targetPct: goal.winRatePct }) : null
  // A record with no losses has no profit factor to compute — grossLoss is the
  // denominator. Requiring 0 more winners is the honest encoding: nothing the
  // remaining trades do can make an all-winning record fail the ratio, and the
  // sample-size guard still governs whether that counts as evidence.
  const noLosses = trades > 0 && stats.losses === 0
  const pfNeed = noLosses ? 0 : trades > 0
    ? winnersNeededForPf({
        grossWin: stats.grossWin, grossLoss: stats.grossLoss,
        avgWin: stats.avgWin, avgLoss: stats.avgLoss,
        remaining: m, target: goal.profitFactor,
      })
    : null

  const winRate = {
    metric: 'winRate',
    target: goal.winRatePct,
    value: stats.winRate,
    gap: stats.winRate != null ? round2(stats.winRate - goal.winRatePct) : null,
    winsNeeded: wNeed,
    // The hit rate the REMAINING trades must clear. >1 means impossible.
    requiredRateOnRemaining: wNeed != null && m > 0 ? round2((wNeed / m) * 100) : null,
    meetsNow: stats.winRate != null ? stats.winRate >= goal.winRatePct : null,
    verdict: verdictFor({
      needed: wNeed, remaining: m, sampleOk, trades,
      meetsNow: stats.winRate != null && stats.winRate >= goal.winRatePct,
    }),
  }

  const profitFactor = {
    metric: 'profitFactor',
    target: goal.profitFactor,
    value: stats.profitFactor,
    gap: stats.profitFactor != null ? round2(stats.profitFactor - goal.profitFactor) : null,
    winsNeeded: pfNeed,
    requiredRateOnRemaining: pfNeed != null && m > 0 ? round2((pfNeed / m) * 100) : null,
    // No losses = no denominator = nothing the ratio can fail on.
    meetsNow: noLosses ? true : (stats.profitFactor != null ? stats.profitFactor >= goal.profitFactor : null),
    verdict: verdictFor({
      needed: pfNeed, remaining: m, sampleOk, trades,
      meetsNow: noLosses || (stats.profitFactor != null && stats.profitFactor >= goal.profitFactor),
    }),
    // The win rate this PF target implies at the CURRENT payoff — the
    // actionable number, and usually far below the configured win-rate goal.
    impliedWinRatePct: impliedWinRateForPf({
      avgWin: stats.avgWin, avgLoss: stats.avgLoss, target: goal.profitFactor,
    }),
    payoffRatio: (stats.avgWin > 0 && stats.avgLoss > 0) ? round2(stats.avgWin / stats.avgLoss) : null,
    // Named so the UI can print it rather than implying the tracker knows the
    // size of trades that have not happened.
    assumes: pfNeed != null
      ? `remaining trades average ${fmt(stats.avgWin)} per win and ${fmt(stats.avgLoss)} per loss, as they have so far`
      : null,
  }

  return {
    accountId: key,
    label,
    isLive,
    enabled,
    trades,
    wins: stats.wins,
    losses: stats.losses,
    sampleOk,
    minTrades: goal.minTrades,
    tradesPerDay,
    spanDays,
    expectedRemaining,
    net: stats.net,
    winRate,
    profitFactor,
    // ONE WORD, from whichever metric the owner made the gate. Both are still
    // computed and returned; `gateOn` decides which one the verdict follows.
    // An AND of the two silently enforced the stricter target — see
    // impliedWinRateForPf for why 68% and PF 1.68 are not the same demand.
    gateOn: goal.gateOn,
    verdict: goal.gateOn === 'winRate' ? winRate.verdict
      : goal.gateOn === 'profitFactor' ? profitFactor.verdict
        : worstOf(winRate.verdict, profitFactor.verdict),
  }
}

const RANK = ['met', 'at_risk', 'insufficient_sample', 'out_of_reach', 'no_data']
function worstOf(a, b) {
  return RANK.indexOf(a) >= RANK.indexOf(b) ? a : b
}
function round2(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null
}
function fmt(v) {
  return Number.isFinite(v) ? v.toFixed(2) : '—'
}
