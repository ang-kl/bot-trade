// cup-handle-funnel — read the 2.6 million rows we were already writing.
//
// Owner, 05-08-2026: "why strategies are not traded". Cup & Handle and its
// inverted twin produced ZERO signals in seven days while the other armed
// strategies produced ~62,000 between them.
//
// The answer has been recorded the whole time and never read. Every scan runs
// traceCupHandleSearch (fib-strategy.js) alongside the real search and writes
// one row per symbol per cycle into cup_handle_diagnostics, naming the gate
// that stopped the best-progressed candidate. Production held 2,598,961 of
// those rows and no route exposed them, so "hasn't fired in a week" stayed a
// guess when it was already a measurement.
//
// THE FUNNEL IS ORDERED, and reading it in order is the point: each stage is
// reached only by what survived the one above, so the first BIG drop is the
// binding constraint. A flat list of gate counts would not tell you that —
// a gate can show a small count either because it rarely blocks anything or
// because almost nothing ever reaches it, and those call for opposite fixes.
//
// NULL blocked_at IS AMBIGUOUS, and the ambiguity matters. insertCupHandleDiagnostic
// writes NULL both when no candidate was found at all AND when a candidate
// cleared every gate — i.e. "nothing to look at" and "would have fired" are
// the same column value. candidate_json separates them, and the second bucket
// is the alarming one: a would-have-fired trace while the real search emitted
// no signal means the diagnostic twin has drifted from the code it mirrors.
import { GATE_ORDER } from './cup-handle.js'

// Timestamps in this DB come in two shapes — toISOString() writes a 'T',
// datetime('now') writes a space. Comparing them raw matches nothing, which
// would report a busy scanner as idle. Same normalisation strategy-liveness
// uses, and for the same reason: this class of mismatch has already produced
// one false "dead strategy" report in this codebase.
const AT_LEAST = (col) => `REPLACE(${col}, 'T', ' ') >= REPLACE(?, 'T', ' ')`

/** cup_handle is the classic long; inv_cup_handle is the short twin. */
export const BIAS_STRATEGY = { long: 'cup_handle', short: 'inv_cup_handle' }

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{days?: number, bias?: 'long'|'short'|null, now?: number}} opts
 * @returns {{
 *   windowDays: number, bias: string|null, since: string, traces: number,
 *   stages: Array<{key: string, label: string, reached: number, stopped: number}>,
 *   wouldHaveFired: number, symbols: number, deepestReached: string|null,
 *   verdict: string,
 * }}
 */
export function cupHandleFunnel(db, { days = 7, bias = null, now = Date.now() } = {}) {
  const since = new Date(now - days * 24 * 3600_000).toISOString()
  const where = [AT_LEAST('scanned_at')]
  const args = [since]
  if (bias === 'long' || bias === 'short') { where.push('bias = ?'); args.push(bias) }
  const W = where.join(' AND ')

  const row = (sql, extra = []) => db.prepare(sql).get(...args, ...extra) || {}

  const traces = row(`SELECT COUNT(*) AS n FROM cup_handle_diagnostics WHERE ${W}`).n || 0
  const symbols = row(`SELECT COUNT(DISTINCT symbol) AS n FROM cup_handle_diagnostics WHERE ${W}`).n || 0
  // uptrend_ok is named for the classic direction but means "the required
  // trend context holds" in both — above all three SMAs for the long search,
  // below all three for the short one.
  const contextOk = row(`SELECT COUNT(*) AS n FROM cup_handle_diagnostics WHERE ${W} AND uptrend_ok = 1`).n || 0
  const withCandidate = row(
    `SELECT COUNT(*) AS n FROM cup_handle_diagnostics WHERE ${W} AND uptrend_ok = 1 AND candidate_json IS NOT NULL`).n || 0
  const wouldHaveFired = row(
    `SELECT COUNT(*) AS n FROM cup_handle_diagnostics
      WHERE ${W} AND uptrend_ok = 1 AND candidate_json IS NOT NULL AND blocked_at IS NULL`).n || 0

  const byGate = new Map()
  for (const r of db.prepare(
    `SELECT blocked_at AS g, COUNT(*) AS n FROM cup_handle_diagnostics
      WHERE ${W} AND uptrend_ok = 1 AND candidate_json IS NOT NULL AND blocked_at IS NOT NULL
      GROUP BY blocked_at`).all(...args)) byGate.set(r.g, r.n)

  // Walk the gates in the order the search applies them, subtracting as we go,
  // so `reached` is genuinely "got this far" rather than "was counted here".
  const stages = [
    { key: 'scanned', label: 'Scanned', reached: traces, stopped: traces - contextOk },
    { key: 'trend_context', label: 'Trend context holds', reached: contextOk, stopped: contextOk - withCandidate },
    { key: 'cup_candidate', label: 'A cup candidate exists', reached: withCandidate, stopped: 0 },
  ]
  let alive = withCandidate
  for (const gate of GATE_ORDER) {
    const stopped = byGate.get(gate) || 0
    stages.push({ key: gate, label: GATE_LABELS[gate] || gate, reached: alive, stopped })
    alive -= stopped
  }

  // The furthest gate anything actually reached. If this is an early gate, the
  // later ones are untested rather than permissive — a distinction that decides
  // whether loosening them would change anything at all.
  let deepestReached = null
  for (const gate of GATE_ORDER) if ((byGate.get(gate) || 0) > 0) deepestReached = gate
  if (wouldHaveFired > 0) deepestReached = 'cleared_every_gate'

  return {
    windowDays: days, bias, since, traces, symbols,
    stages, wouldHaveFired, deepestReached,
    verdict: verdictFor({ traces, contextOk, withCandidate, wouldHaveFired, stages }),
  }
}

const GATE_LABELS = {
  no_cup_structure: 'Cup shape valid',
  handle_length_ratio: 'Handle length vs cup length',
  round_bottom: 'Cup bottom is rounded',
  handle_range: 'Handle retrace within half the cup',
  handle_volume: 'Handle volume below the leg',
  breakout_not_triggered: 'Price broke the rim',
  breakout_volume: 'Breakout volume confirms',
  rr_floor: 'Reward:risk clears the floor',
}

function verdictFor({ traces, contextOk, withCandidate, wouldHaveFired, stages }) {
  if (!traces) return 'No traces in this window — the scanner has not run cup_handle here.'
  if (!contextOk) {
    return 'The trend context never held: price was never on the right side of all three '
      + 'SMAs at scan time, so the cup search never ran once. Nothing downstream was tested.'
  }
  if (!withCandidate) {
    return 'The trend context held, but no cup-shaped candidate was ever found — the '
      + 'search ran and came back empty. The gates below it are untested, not permissive.'
  }
  if (wouldHaveFired) {
    return `${wouldHaveFired} trace(s) cleared every gate. If no signal was emitted for those, `
      + 'the diagnostic twin has drifted from the search it mirrors — that is a bug, not a market.'
  }
  // Name the gate that stopped the most, since that is where a change pays.
  const gates = stages.filter(s => !['scanned', 'trend_context', 'cup_candidate'].includes(s.key))
  const worst = gates.reduce((a, b) => (b.stopped > (a?.stopped || 0) ? b : a), null)
  return worst && worst.stopped
    ? `Candidates exist and are stopped mostly at "${worst.label}" (${worst.stopped} of ${withCandidate}).`
    : 'Candidates exist but no gate recorded stopping them — check the trace wiring.'
}

/** One line for a log or a Telegram reply. */
export function funnelLine(res) {
  if (!res?.traces) return ''
  const s = res.stages
  const at = (k) => s.find(x => x.key === k)
  return `${res.traces} traces / ${res.symbols} symbols · context ok ${at('trend_context')?.reached ?? 0}`
    + ` · candidates ${at('cup_candidate')?.reached ?? 0} · would have fired ${res.wouldHaveFired}`
    + (res.deepestReached ? ` · deepest ${res.deepestReached}` : '')
}
