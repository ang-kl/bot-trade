// ---------------------------------------------------------------------------
// agent/services/exit-chain.js — the Markov-chain exit report (02-09-2026
// plan, part 2). A READ-ONLY scaffold: per strategy family, the transition
// counts and probabilities over the position journal's management states
// (opened → be_moved → scaled_out → trail_armed → trail_tightened → closed:*),
// and the as-traded outcome conditioned on the last state before exit.
//
// IT FITS WHEN THE DATA EXISTS AND SAYS SO WHEN IT DOES NOT. Below
// `minClosesPerFamily` stamped closes a family's matrix is still returned —
// with `status: 'insufficient'` — and nothing reads it as advice. A chain
// fitted on eleven trades looks exactly like one fitted on a thousand, which
// is failure mode #3 with a probability table on it.
//
// TWO BIASES THE JOURNAL CARRIES, reported rather than fixed here:
//   1. `trail_armed` is never emitted in production: the rank rule advances on
//      that kind only, so the observed chain skips the state. Its row is
//      present and empty by construction.
//   2. Node-side trails are journaled as `sl_moved` and read as
//      `opened`/`be_moved`; only the sidecar's ratchet reads as
//      `trail_tightened`. The state is a WHO-moved-it reading as much as a
//      what-happened one.
//
// Nothing here is read by the gate, a strategy or the position manager; the
// module writes nothing (exit-chain.test.js pins both).
// ---------------------------------------------------------------------------

import { cleanBotOrigin } from '../lib/trade-origin.js'
import { strategyAttrSql } from '../lib/strategy-attribution.js'
import { familyOf, STRATEGY_FAMILIES } from './strategies.js'
import { MANAGEMENT_STATES, POSITION_EVENTS_RETENTION_DAYS } from './position-events.js'
import { exitCounterfactual } from './exit-counterfactual.js'

/** Stamped closes a family needs before its matrix is read as fitted. */
export const EXIT_CHAIN_MIN_CLOSES = 100

/** The absorbing state every `closed:<kind>` collapses into for the matrix. */
export const CLOSED = 'closed'

/** Row/column order of the matrix: the lifecycle states, then the absorber. */
export const CHAIN_STATES = Object.freeze([...MANAGEMENT_STATES, CLOSED])

export const EXIT_CHAIN_BIASES = Object.freeze([
  'trail_armed is never emitted in production (the rank rule advances on that kind only), so its row is empty by construction.',
  'Node-side trails are journaled as sl_moved and read as opened/be_moved; only the sidecar ratchet reads as trail_tightened.',
])

const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null)

/**
 * Clean bot closes over `days` (capped at the journal's retention — a longer
 * window would count trades whose journal is already pruned as unstamped),
 * each with its ordered state sequence from the journal.
 *
 * @returns {{ days:number, considered:number, sequences:Array<{tradeId, family,
 *   strategy, r, stamped:boolean, states:string[], lastState:string,
 *   rAtTransition:number|null}>, skipped:{not_clean_origin:number, no_r:number} }}
 */
export function stateSequences(db, { days = POSITION_EVENTS_RETENTION_DAYS, cleanOnly = true, accountId = null } = {}) {
  const win = Math.min(POSITION_EVENTS_RETENTION_DAYS, Math.max(1, Number(days) || POSITION_EVENTS_RETENTION_DAYS))
  const since = new Date(Date.now() - win * 86_400_000).toISOString()
  const attr = strategyAttrSql('t.label_strategy', 't.strategy')
  let rows = []
  try {
    rows = db.prepare(`
      SELECT t.id, t.origin, t.account_id, ${attr} AS strategy_attr, pm.r_multiple AS r
        FROM trades t
        JOIN trade_postmortems pm ON pm.trade_id = t.id
       WHERE t.status = 'closed' AND t.closed_at IS NOT NULL AND t.closed_at >= ?
         AND (? IS NULL OR t.account_id = ?)
       ORDER BY t.closed_at DESC
    `).all(since, accountId, accountId)
  } catch { rows = [] }
  const events = (() => {
    try {
      return db.prepare(`SELECT state_to, r_at FROM position_events WHERE trade_id = ? AND state_to IS NOT NULL ORDER BY id ASC`)
    } catch { return null }
  })()
  const skipped = { not_clean_origin: 0, no_r: 0 }
  const sequences = []
  for (const row of rows) {
    if (cleanOnly && !cleanBotOrigin(row.origin)) { skipped.not_clean_origin++; continue }
    const r = Number(row.r)
    if (!Number.isFinite(r)) { skipped.no_r++; continue }
    const evs = events ? events.all(row.id) : []
    // Collapse repeats: a second sl_moved inside be_moved is the same state,
    // not a self-transition worth a probability.
    const states = ['opened']
    let lastState = 'opened', rAtTransition = null
    for (const e of evs) {
      const s = String(e.state_to)
      if (s !== states[states.length - 1]) states.push(s)
      if (!s.startsWith('closed:')) { lastState = s; rAtTransition = e.r_at ?? null }
    }
    const stamped = evs.length > 0
    if (!states[states.length - 1].startsWith('closed:')) states.push(stamped ? 'closed:unjournaled' : 'closed:unstamped')
    const strategy = row.strategy_attr ? String(row.strategy_attr) : null
    sequences.push({
      tradeId: row.id, strategy, family: strategy ? (familyOf(strategy) ?? 'unfamilied') : 'unattributed',
      r, stamped, states, lastState,
      rAtTransition: rAtTransition != null && Number.isFinite(Number(rAtTransition)) ? Number(rAtTransition) : null,
    })
  }
  return { days: win, considered: rows.length, sequences, skipped }
}

/**
 * Fit one family's chain from its sequences: transition counts over
 * CHAIN_STATES (every `closed:*` absorbed into `closed`), row-normalised
 * probabilities, and the outcome by last state before exit — the same shape
 * exit-counterfactual's `byState` reports so the two can be laid side by side.
 * Pure.
 */
export function fitChain(sequences, { minCloses = EXIT_CHAIN_MIN_CLOSES } = {}) {
  const seqs = Array.isArray(sequences) ? sequences : []
  const absorb = (s) => (s.startsWith('closed:') ? CLOSED : s)
  const transitions = {}
  for (const from of CHAIN_STATES) {
    transitions[from] = {}
    for (const to of CHAIN_STATES) transitions[from][to] = 0
  }
  const byState = {}
  let stamped = 0
  for (const seq of seqs) {
    if (seq.stamped) stamped++
    const path = seq.states.map(absorb)
    for (let i = 1; i < path.length; i++) {
      const from = path[i - 1], to = path[i]
      if (transitions[from] && to in transitions[from]) transitions[from][to]++
    }
    const b = byState[seq.lastState] || (byState[seq.lastState] = { n: 0, wins: 0, totalR: 0, rAtTransitionSum: 0, rAtTransitionN: 0 })
    b.n++; if (seq.r > 0) b.wins++; b.totalR += seq.r
    if (seq.rAtTransition != null) { b.rAtTransitionSum += seq.rAtTransition; b.rAtTransitionN++ }
  }
  const probabilities = {}
  for (const from of CHAIN_STATES) {
    const rowN = Object.values(transitions[from]).reduce((a, b) => a + b, 0)
    probabilities[from] = {}
    for (const to of CHAIN_STATES) probabilities[from][to] = rowN ? r3(transitions[from][to] / rowN) : null
  }
  for (const b of Object.values(byState)) {
    b.expectancyR = r3(b.totalR / b.n)
    b.winRate = Math.round((b.wins / b.n) * 1000) / 10
    b.meanRAtTransition = b.rAtTransitionN ? r3(b.rAtTransitionSum / b.rAtTransitionN) : null
    b.totalR = r3(b.totalR)
    delete b.rAtTransitionSum; delete b.rAtTransitionN
  }
  const n = seqs.length
  return {
    n, stamped, minCloses,
    status: stamped >= minCloses ? 'fitted' : 'insufficient',
    transitions, probabilities, byState,
  }
}

/**
 * The report: one chain per family (every declared family present even at
 * n = 0, plus `unattributed`/`unfamilied` when such closes exist), the
 * journal biases, and — over the bars-filtered subset only — the
 * counterfactual's per-state outcome beside the trail replays on the same
 * trades, so the first disagreement between "what the state says" and "what
 * a trail would have done" is visible where it first appears.
 */
export function exitChainReport(db, { days = POSITION_EVENTS_RETENTION_DAYS, minClosesPerFamily = EXIT_CHAIN_MIN_CLOSES, accountId = null, cleanOnly = true } = {}) {
  const minCloses = Math.max(1, Number(minClosesPerFamily) || EXIT_CHAIN_MIN_CLOSES)
  const pop = stateSequences(db, { days, cleanOnly, accountId })
  const grouped = {}
  for (const f of STRATEGY_FAMILIES) grouped[f] = []
  for (const s of pop.sequences) (grouped[s.family] || (grouped[s.family] = [])).push(s)
  const families = {}
  for (const [f, seqs] of Object.entries(grouped)) families[f] = fitChain(seqs, { minCloses })
  const fitted = Object.values(families).filter(x => x.status === 'fitted').length
  const stamped = pop.sequences.filter(s => s.stamped).length
  return {
    reportOnly: true,
    verdict: fitted > 0 ? 'FITTED' : 'INSUFFICIENT',
    days: pop.days,
    minCloses,
    considered: pop.considered,
    n: pop.sequences.length,
    stamped,
    skipped: pop.skipped,
    states: [...CHAIN_STATES],
    families,
    trailComparison: compareToTrail(db, { days: pop.days, accountId, cleanOnly }),
    biases: [...EXIT_CHAIN_BIASES],
    note: fitted > 0
      ? `${fitted} of ${Object.keys(families).length} families reached ${minCloses} stamped closes over ${pop.days}d; the others are returned with status insufficient and are not advice.`
      : `INSUFFICIENT — ${stamped} stamped close(s) across ${Object.keys(families).length} families over ${pop.days}d, none reached the ${minCloses}-close floor. The matrices are returned so the shape can be read; the numbers are not.`,
  }
}

/**
 * The bars-filtered subset (the counterfactual's population): its per-state
 * outcome and the trail_0.5R / trail_1R replays over the same trades.
 * Report only; `null` when the counterfactual cannot run.
 */
export function compareToTrail(db, { days = POSITION_EVENTS_RETENTION_DAYS, accountId = null, cleanOnly = true } = {}) {
  try {
    const cf = exitCounterfactual(db, {
      days, cleanOnly, accountId,
      rules: [{ name: 'trail_0.5R', trailR: 0.5 }, { name: 'trail_1R', trailR: 1.0 }],
    })
    return {
      eligible: cf.eligible,
      minSample: cf.minSample,
      verdict: cf.verdict,
      byState: cf.byState,
      actual: cf.actual ? { usable: cf.actual.usable, winRate: cf.actual.winRate, expectancyR: cf.actual.expectancyR, profitFactor: cf.actual.profitFactor } : null,
      rules: Object.fromEntries(cf.rules.map(r => [r.rule, { usable: r.usable, winRate: r.winRate, expectancyR: r.expectancyR, profitFactor: r.profitFactor }])),
    }
  } catch { return null }
}
