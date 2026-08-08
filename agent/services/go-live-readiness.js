// ---------------------------------------------------------------------------
// agent/services/go-live-readiness.js — one read that answers the go-live
// question, INCLUDING whether the answer can be trusted.
//
// The date itself is DEFAULT_GOAL.deadline (goal-tracker.js), overridable via
// agent_state — deliberately not restated here, because a deadline written in
// two places moves in one of them.
//
// Owner, 08-08-2026: "building is a single /state/go-live-readiness read".
//
// WHY IT HAS THREE VERDICTS AND NOT TWO. This week produced, in order: a
// currency wrong by 158x that made position size meaningless; exit prices
// wrong on four of five close paths; a repair gated on a check that could not
// see its own rows, three times; and a profit factor of 0.84 that turned out
// to be almost entirely one strategy nobody had separated out. Every one of
// those was invisible while a number sat on a screen looking like evidence.
//
// So a two-valued gate — GO or NO — is the wrong shape for this decision. Both
// answers assert that the measurement happened. The failure mode here has
// never been a bar set too low; it has been a bar compared against a number
// that did not mean what it said. This returns:
//
//   GO            the bar is met AND the record is clean enough to believe
//   NO            the record is clean enough to believe, and says no
//   UNMEASURABLE  the record cannot carry the question yet
//
// UNMEASURABLE IS NOT A SOFTER 'NO'. It is a different instruction: NO means
// "the edge is not there", UNMEASURABLE means "fix the ledger before asking
// again". Collapsing them is how 0.84 got quoted for a day as though it were a
// finding about strategy quality.
//
// WHAT IT DOES NOT DO. It does not decide, does not write, and does not move
// the deadline. `deadline.willMakeIt` is arithmetic on the observed trade rate,
// offered so the decision is a number rather than a feeling — and it is
// explicitly a projection, not a promise.
// ---------------------------------------------------------------------------

import { GO_LIVE_BAR, ARM_BAR } from './edge-bars.js'
// The deadline comes from goal-tracker's DEFAULT_GOAL, not a second copy of the
// date. A duplicated literal is how a moved deadline moves in one file and not
// the other, and this module's whole job is to be the ONE place the go-live
// question is answered.
import { DEFAULT_GOAL } from './goal-tracker.js'

const DEFAULT_GOAL_DEADLINE = DEFAULT_GOAL.deadline

/**
 * Share of rows that may be flagged/unattributed before the record stops
 * being able to carry a go-live verdict.
 *
 * These are judgement calls, and deliberately loose. The point is not to
 * find the exact right threshold; it is that SOME threshold exists, because
 * before today there was none and 29.5% self-contradicting rows plus 67%
 * unattributed rows were silently averaged into a gate number.
 */
export const INTEGRITY_LIMITS = Object.freeze({
  maxFlaggedFrac: 0.10,        // pnl_price_mismatch OR exit_price_suspect
  maxUnattributedFrac: 0.40,   // label_strategy null or 'other'
  minDecidable: 30,            // rows with the fields to judge at all
})

const num = (v) => (v == null || v === '' ? NaN : Number(v))

/**
 * Profit factor and win rate over a set of closed rows. Returns nulls rather
 * than zeros on an empty set — a PF of 0 reads as "terrible" where the truth
 * is "no trades", and those must not look alike on a go-live screen.
 */
export function edgeOf(rows) {
  const pnls = (Array.isArray(rows) ? rows : [])
    .map(r => num(r?.net_pnl))
    .filter(Number.isFinite)
  if (!pnls.length) return { trades: 0, wins: 0, winRatePct: null, profitFactor: null, netPnl: 0 }
  const wins = pnls.filter(p => p > 0)
  const grossWin = wins.reduce((s, p) => s + p, 0)
  const grossLoss = pnls.filter(p => p < 0).reduce((s, p) => s - p, 0)
  return {
    trades: pnls.length,
    wins: wins.length,
    winRatePct: r2((wins.length / pnls.length) * 100),
    // No losses at all is not an infinite edge, it is an unrepresentative
    // sample. null says so; Infinity would render as a triumph.
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    netPnl: r2(pnls.reduce((s, p) => s + p, 0)),
  }
}

/**
 * Can this record carry the question? Pure.
 *
 * @param {Array<object>} rows closed trades with the audit columns present
 */
export function integrityOf(rows) {
  const all = Array.isArray(rows) ? rows : []
  const total = all.length
  const flagged = all.filter(r => r?.pnl_price_mismatch === 1 || r?.exit_price_suspect === 1).length
  const unattributed = all.filter(r => {
    const s = r?.label_strategy ?? r?.strategy
    return s == null || String(s).toLowerCase() === 'other'
  }).length
  // "Decidable" in the same sense trade-consistency.js uses it: the row has
  // the fields required to judge it. A row we cannot judge is not a clean row.
  const decidable = all.filter(r =>
    Number.isFinite(num(r?.net_pnl)) && Number.isFinite(num(r?.entry_price)) && Number.isFinite(num(r?.exit_price))
  ).length

  const flaggedFrac = total ? flagged / total : 0
  const unattributedFrac = total ? unattributed / total : 0
  const blockers = []
  if (decidable < INTEGRITY_LIMITS.minDecidable) {
    blockers.push(`only ${decidable} of ${total} closed rows carry the fields needed to judge them (need ${INTEGRITY_LIMITS.minDecidable})`)
  }
  if (flaggedFrac > INTEGRITY_LIMITS.maxFlaggedFrac) {
    blockers.push(`${flagged} of ${total} rows (${pct(flaggedFrac)}) are flagged as disagreeing with themselves — run /state/exit-price-suspects?sweep=1 and let the backfill repair them`)
  }
  if (unattributedFrac > INTEGRITY_LIMITS.maxUnattributedFrac) {
    blockers.push(`${unattributed} of ${total} rows (${pct(unattributedFrac)}) have no strategy attribution, so a per-strategy verdict cannot be formed — these are the 'other' bucket`)
  }
  return {
    total, decidable, flagged, unattributed,
    flaggedFrac: r4(flaggedFrac),
    unattributedFrac: r4(unattributedFrac),
    clean: blockers.length === 0,
    blockers,
    limits: INTEGRITY_LIMITS,
  }
}

/**
 * Per strategy×symbol×timeframe, is the combo armed against ARM_BAR, and if
 * not, how many more trades would it take at the CURRENT win rate?
 *
 * `tradesToArm` is null when the combo's own numbers cannot reach the bar by
 * adding trades — a combo at PF 0.2 does not need more trades, it needs a
 * different idea, and printing a countdown for it would be a lie shaped like
 * a plan.
 */
export function bucketsOf(rows, bar = ARM_BAR) {
  const by = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    const strat = r?.label_strategy ?? r?.strategy
    if (strat == null || String(strat).toLowerCase() === 'other') continue
    const key = `${strat}|${r.symbol}|${r.label_timeframe ?? r.timeframe ?? '?'}`
    if (!by.has(key)) by.set(key, [])
    by.get(key).push(r)
  }
  const out = []
  for (const [key, rs] of by) {
    const e = edgeOf(rs)
    const [strategy, symbol, timeframe] = key.split('|')
    const pfOk = e.profitFactor != null && e.profitFactor >= bar.profitFactor
    const wrOk = e.winRatePct != null && e.winRatePct >= bar.winRatePct
    const nOk = e.trades >= bar.minTrades
    out.push({
      strategy, symbol, timeframe,
      ...e,
      armed: pfOk && wrOk && nOk,
      // Only a SAMPLE shortfall is countable. A combo failing on PF or win
      // rate is not N trades away from arming; it is failing.
      tradesToArm: (pfOk && wrOk && !nOk) ? bar.minTrades - e.trades : null,
      failing: [
        ...(pfOk ? [] : [`profitFactor ${e.profitFactor ?? 'n/a'} < ${bar.profitFactor}`]),
        ...(wrOk ? [] : [`winRate ${e.winRatePct ?? 'n/a'}% < ${bar.winRatePct}%`]),
        ...(nOk ? [] : [`trades ${e.trades} < ${bar.minTrades}`]),
      ],
    })
  }
  out.sort((a, b) => (b.armed - a.armed) || (b.trades - a.trades))
  return out
}

/**
 * The whole answer. Pure — the caller owns every read.
 *
 * @param {{rows:Array, goal:object, nowMs:number, windowDays:number}} a
 */
export function goLiveReadiness({ rows, goal, nowMs = null, windowDays = 30 }) {
  const g = goal || { profitFactor: GO_LIVE_BAR.profitFactor, winRatePct: GO_LIVE_BAR.winRatePct, gateOn: 'profitFactor', minTrades: 30, deadline: DEFAULT_GOAL_DEADLINE }
  const integrity = integrityOf(rows)
  const edge = edgeOf(rows)
  const buckets = bucketsOf(rows)

  const pfMet = edge.profitFactor != null && edge.profitFactor >= g.profitFactor
  const wrMet = edge.winRatePct != null && edge.winRatePct >= g.winRatePct
  const nMet = edge.trades >= g.minTrades
  const barMet = nMet && (
    g.gateOn === 'both' ? (pfMet && wrMet)
      : g.gateOn === 'winRate' ? wrMet
        : pfMet
  )

  // ORDER MATTERS. Integrity is checked FIRST and can override a met bar,
  // because "the bar is met on a record that cannot be believed" is the exact
  // sentence this file exists to prevent anyone saying.
  const verdict = !integrity.clean ? 'UNMEASURABLE' : barMet ? 'GO' : 'NO'

  const deadline = deadlineProjection({
    deadline: g.deadline, nowMs, trades: edge.trades, windowDays,
    tradesNeeded: Math.max(0, g.minTrades - edge.trades),
  })

  return {
    verdict,
    // A one-line answer, because the point of a single read is that a human on
    // a phone does not have to assemble it.
    headline: headlineFor(verdict, edge, g, integrity, buckets),
    gate: {
      on: g.gateOn,
      profitFactor: { value: edge.profitFactor, bar: g.profitFactor, met: pfMet },
      winRatePct: { value: edge.winRatePct, bar: g.winRatePct, met: wrMet },
      trades: { value: edge.trades, bar: g.minTrades, met: nMet },
      barMet,
    },
    integrity,
    edge,
    buckets: { armed: buckets.filter(b => b.armed), all: buckets, bar: ARM_BAR },
    deadline,
    windowDays,
  }
}

/**
 * Days left, and whether the observed trade rate can close the sample gap in
 * time. A PROJECTION on a straight-line rate, labelled as one.
 */
export function deadlineProjection({ deadline, nowMs, trades, windowDays, tradesNeeded }) {
  const dueMs = Date.parse(`${deadline}T00:00:00Z`)
  const now = nowMs == null ? null : Number(nowMs)
  if (!Number.isFinite(dueMs) || now == null || !Number.isFinite(now)) {
    return { date: deadline, daysLeft: null, tradesPerDay: null, tradesNeeded, willMakeIt: null,
      note: 'no clock supplied — days left not computed rather than guessed' }
  }
  const daysLeft = Math.max(0, Math.ceil((dueMs - now) / 86_400_000))
  const tradesPerDay = windowDays > 0 ? r2(trades / windowDays) : null
  const daysToClose = tradesNeeded > 0 && tradesPerDay > 0 ? Math.ceil(tradesNeeded / tradesPerDay) : 0
  return {
    date: deadline,
    daysLeft,
    tradesPerDay,
    tradesNeeded,
    daysToClose,
    // null when the rate is zero: "cannot say" rather than "no". A rate of
    // zero with trades needed is not a slow yes, it is no data.
    willMakeIt: tradesNeeded === 0 ? true : (tradesPerDay > 0 ? daysToClose <= daysLeft : null),
    note: 'straight-line projection on the observed rate — not a promise, and it assumes the rate holds',
  }
}

function headlineFor(verdict, edge, g, integrity, buckets) {
  if (verdict === 'UNMEASURABLE') {
    return `UNMEASURABLE — ${integrity.blockers.length} integrity blocker(s). The ledger cannot carry a go-live verdict yet; this is not a verdict about the edge.`
  }
  const armed = buckets.filter(b => b.armed).length
  const metric = g.gateOn === 'winRate' ? `win rate ${edge.winRatePct}% vs ${g.winRatePct}%`
    : g.gateOn === 'both' ? `PF ${edge.profitFactor} vs ${g.profitFactor} AND win rate ${edge.winRatePct}% vs ${g.winRatePct}%`
      : `PF ${edge.profitFactor} vs ${g.profitFactor}`
  return verdict === 'GO'
    ? `GO — ${metric} on ${edge.trades} trades, ${armed} armed combo(s), record clean.`
    : `NO — ${metric} on ${edge.trades} trades. Record is clean, so this is a real answer about the edge.`
}

const pct = (f) => `${(f * 100).toFixed(1)}%`
function r2(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null }
function r4(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n) * 10000) / 10000 : null }
