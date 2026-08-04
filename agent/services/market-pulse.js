// ---------------------------------------------------------------------------
// agent/services/market-pulse.js — is this move a TREND, a HERD, or a market
// being HELD?
//
// Owner, 05-08-2026: "since last Thursday USDJPY is defended by US government
// and JPY government to ensure Yen doesn't drop further. Opposite is JPN225
// index move up sharply. How do you assess this and are these part of market
// trending or correlation movement or both or what? Create an algo to
// understand movements and big moves that give more awareness to the symbol
// trading and pending to trade."
//
// THE ANSWER TO THE QUESTION IS "BOTH, AND THE INTERESTING PART IS THE
// DISAGREEMENT". USDJPY and JPN225 are POSITIVELY correlated in the ordinary
// course — a weaker yen lifts the earnings of an export-heavy index, so
// USDJPY up and JPN225 up is the normal joint state. What the owner is
// describing is not that. It is one leg of a correlated pair being HELD while
// the other RUNS: USDJPY pinned by defence, JPN225 trending hard. A single
// number for "correlation" cannot express that, and neither can a single
// number for "trend" — you need both, per symbol, and then the comparison.
//
// So this module measures three independent things and refuses to collapse
// them:
//
//   1. HOW DIRECTIONAL is the move on its own?      efficiencyRatio
//   2. HOW BIG is it for this symbol, over this span? sigmaMove
//   3. HOW MUCH PATH did it spend going nowhere?     pinScore
//   4. HOW WIDE was the band it kept crossing?       traverseRatio
//
// A defended market is the signature that has no name in any single
// indicator: large traded range, small net move, repeated rejection — a lot
// of effort and no distance. It takes (3) AND (4) together: a high
// range-per-distance ratio on its own is ALSO what a market that never moved
// looks like, since small ÷ smaller is a large number too. Measure (4) is
// what says the band was worth fighting over. Both were caught by this
// module's first test run, where a deliberately quiet fixture came back
// classified `defended`.
//
// AND IT IS ADVISORY. Nothing here vetoes, sizes, or closes. The risk gate's
// limits are the owner's to set (CLAUDE.md), and a detector that started
// refusing entries on its own reading would be a risk-limit change nobody
// approved. What it does is ATTACH A READING to a symbol so the entry path,
// the pending-order path and the operator all see the same one.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { loadStoredMatrix, loadCorrelationMatrixConfig } from './correlation-matrix.js'

/**
 * The closed set of readings. Ordered by how much they should change what a
 * human does, most first.
 */
export const PULSE_STATES = Object.freeze([
  'breaking',   // a move large against this symbol's OWN vol, and directional
  'trending',   // directional, ordinary size — the state a trend system wants
  'defended',   // large range, no distance: a level being held. THE FINDING.
  'choppy',     // path spent going nowhere, without a level to point at
  'quiet',      // small range and small move — nothing to say
])

export const DEFAULT_PULSE = Object.freeze({
  // Kaufman efficiency: |net| / sum(|steps|). Above this the move is going
  // somewhere; below it the path is being spent without distance.
  trendER: 0.45,
  chopER: 0.25,
  // The "sharp marker movement" the owner asked for. sigmaMove z-scores the
  // LATEST span against this symbol's other spans, so this fires on an
  // ACCELERATION — not on a steady climb, however steep. A market that has
  // trended at the same rate all week is `trending`, and correctly so; the
  // marker is for the bar where the rate changed.
  sharpSigma: 2.0,
  // Traded range this many times the net move is the defence signature: at
  // 2.5 the close ended within 40% of the band's width of where it started,
  // having crossed that band repeatedly. Reaching this branch already means
  // the move failed the trending test, so what is being asked here is only
  // "did it end INSIDE the band it was fighting over" — and 40% is inside.
  // (Was 4.0, which was picked by eye and rejected a market that had plainly
  // gone nowhere across a band nine bar-ranges wide.)
  pinRatio: 2.5,
  // …and the band has to be worth fighting over. Below this many bar-ranges
  // wide the market is QUIET, not held — see traverseRatio.
  pinTraverse: 4.0,
  // Share of a herd's members that must move the same way for the move to be
  // the herd's rather than the symbol's.
  herdAgreement: 0.6,
  lookback: 60,
})

const num = (v) => (v == null ? NaN : Number(v))
const closeOf = (b) => num(b?.c ?? b?.close)
const highOf = (b) => num(b?.h ?? b?.high ?? closeOf(b))
const lowOf = (b) => num(b?.l ?? b?.low ?? closeOf(b))

/**
 * Kaufman's efficiency ratio: net distance ÷ total path walked.
 *
 * 1.0 = a straight line. 0.0 = ended where it started having travelled a long
 * way. This is the single number that separates "trending" from "being held",
 * and it is why a net-change column cannot: both can print +0.1%.
 *
 * Returns null rather than 0 when there is no path — an undefined ratio is
 * not the same claim as a perfectly inefficient one.
 */
export function efficiencyRatio(bars) {
  const c = (bars || []).map(closeOf).filter(Number.isFinite)
  if (c.length < 3) return null
  const net = Math.abs(c[c.length - 1] - c[0])
  let path = 0
  for (let i = 1; i < c.length; i++) path += Math.abs(c[i] - c[i - 1])
  if (path === 0) return null
  return net / path
}

/**
 * The RECENT move, z-scored against how far this symbol usually travels over
 * the same span. Signed, because direction is half the information.
 *
 * WHY IT IS NOT net ÷ (per-bar sigma × √n), WHICH IS WHAT THIS FUNCTION USED
 * TO BE. That formula reduces algebraically to `efficiencyRatio × √n` — the
 * per-bar deviation IS the path divided by the bar count, so the "sigma"
 * carried no information the efficiency ratio did not already carry, and on a
 * clean ramp (near-zero return variance) it printed 200σ and then 1,116σ. Two
 * names for one number, one of them exploding. Caught by this module's own
 * first test run.
 *
 * What a size measure has to answer is different: is THIS span's move large
 * COMPARED WITH THIS SYMBOL'S OTHER SPANS OF THE SAME LENGTH? So the window is
 * cut into overlapping k-bar moves, and the latest one is z-scored against
 * that distribution. Independent of directedness by construction — a symbol
 * can grind out a large move inefficiently, or snap out a small one cleanly.
 *
 * Returns null when the k-bar moves have no spread at all: a synthetic ramp
 * has nothing to compare against, and inventing a z-score for it would be the
 * old bug in a new shape.
 */
export function sigmaMove(bars) {
  const c = (bars || []).map(closeOf).filter(Number.isFinite)
  if (c.length < 8) return null
  const k = Math.max(2, Math.min(10, Math.floor(c.length / 4)))
  const spans = []
  for (let i = k; i < c.length; i++) {
    if (c[i - k] === 0) continue
    spans.push((c[i] - c[i - k]) / c[i - k])
  }
  if (spans.length < 3) return null
  const mean = spans.reduce((s, x) => s + x, 0) / spans.length
  const varr = spans.reduce((s, x) => s + (x - mean) ** 2, 0) / (spans.length - 1)
  const sd = Math.sqrt(varr)
  if (!(sd > 0)) return null   // no spread to compare against — say nothing
  return (spans[spans.length - 1] - mean) / sd
}

/**
 * How many bar-ranges wide is the band price actually traversed?
 *
 * This is what separates DEFENDED from QUIET, and pinScore on its own cannot:
 * both end near flat, and both therefore show a large range ÷ net-move ratio.
 * The difference is ACTIVITY. A defended level sees price cross a band many
 * bar-ranges wide, repeatedly. A quiet market never leaves one bar's worth of
 * range in the first place — its high ratio is small ÷ smaller, arithmetic
 * rather than a fight.
 *
 * Caught on this module's first test run, where a deliberately QUIET fixture
 * came back classified `defended`.
 */
export function traverseRatio(bars) {
  const rows = (bars || []).filter(b => Number.isFinite(closeOf(b)))
  if (rows.length < 3) return null
  const hi = Math.max(...rows.map(highOf).filter(Number.isFinite))
  const lo = Math.min(...rows.map(lowOf).filter(Number.isFinite))
  const spans = rows.map(b => highOf(b) - lowOf(b)).filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b)
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || spans.length === 0) return null
  const median = spans[Math.floor(spans.length / 2)]
  if (!(median > 0)) return null
  return (hi - lo) / median
}

/**
 * How much range was traded per unit of distance actually covered.
 *
 * A defended level shows up here and almost nowhere else: price is pushed at
 * repeatedly and pushed back, so the high-low envelope is wide while the net
 * change is nearly nothing. Ratio = full traded range ÷ |net move|.
 *
 * Returns Infinity when the net move is exactly zero — that is the extreme of
 * the same quantity, not an error, and callers compare it against a
 * threshold.
 */
export function pinScore(bars) {
  const rows = (bars || []).filter(b => Number.isFinite(closeOf(b)))
  if (rows.length < 3) return null
  const hi = Math.max(...rows.map(highOf).filter(Number.isFinite))
  const lo = Math.min(...rows.map(lowOf).filter(Number.isFinite))
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null
  const net = Math.abs(closeOf(rows[rows.length - 1]) - closeOf(rows[0]))
  const range = hi - lo
  if (range <= 0) return null
  if (net === 0) return Number.POSITIVE_INFINITY
  return range / net
}

/**
 * One symbol's reading.
 *
 * ORDER MATTERS AND IS THE ARGUMENT OF THIS FUNCTION. `defended` is tested
 * BEFORE `quiet`, because both end the window near where they started and a
 * net-change column cannot tell them apart — the difference is entirely in
 * how much range was spent getting nowhere. And `breaking` is tested before
 * `trending` so that a move which is both directional AND large against the
 * symbol's own vol is reported as the rarer, more actionable one.
 *
 * @returns {{state, er, sigma, pin, netPct, dir, sharp, why}|null}
 */
export function classifySymbol(bars, cfg = DEFAULT_PULSE) {
  const c = (bars || []).map(closeOf).filter(Number.isFinite)
  if (c.length < 5) return null
  const er = efficiencyRatio(bars)
  const sigma = sigmaMove(bars)
  const pin = pinScore(bars)
  const traverse = traverseRatio(bars)
  const netPct = c[0] !== 0 ? ((c[c.length - 1] - c[0]) / c[0]) * 100 : null
  const dir = netPct == null ? 0 : Math.sign(netPct)
  const sharp = sigma != null && Math.abs(sigma) >= cfg.sharpSigma

  let state = 'quiet'
  let why = 'small move, ordinary range'
  if (er != null && er >= cfg.trendER && sharp) {
    state = 'breaking'
    why = `directional (ER ${er.toFixed(2)}) and ${Math.abs(sigma).toFixed(1)}σ against this symbol's own vol`
  } else if (er != null && er >= cfg.trendER) {
    state = 'trending'
    why = `directional (ER ${er.toFixed(2)}), ordinary size for this symbol`
  } else if (pin != null && pin >= cfg.pinRatio && traverse != null && traverse >= cfg.pinTraverse && !sharp) {
    // THE ONE WITH NO NAME IN ANY SINGLE INDICATOR. Wide range, no distance:
    // price pushed at a level repeatedly and pushed back each time. BOTH
    // conditions are required — a high pin ratio alone is also what a market
    // that never moved looks like, which is a completely different situation.
    state = 'defended'
    why = `crossed a band ${traverse.toFixed(1)} bar-ranges wide ${pin === Infinity ? 'without moving at all' : `for ${pin.toFixed(1)}× its net move`} and ended where it started — a level is being held`
  } else if (er != null && er <= cfg.chopER && traverse != null && traverse >= cfg.pinTraverse) {
    // Choppy needs the SAME activity floor as defended, and for the same
    // reason: a market that never left one bar's range has a terrible
    // efficiency ratio too, arithmetically, and calling that "choppy" would
    // report a fight where there was only a flat line.
    state = 'choppy'
    why = `path spent without distance (ER ${er.toFixed(2)}), no single level to point at`
  }

  return {
    state,
    er: er == null ? null : Math.round(er * 100) / 100,
    sigma: sigma == null ? null : Math.round(sigma * 100) / 100,
    pin: pin == null ? null : (pin === Infinity ? null : Math.round(pin * 10) / 10),
    traverse: traverse == null ? null : Math.round(traverse * 10) / 10,
    netPct: netPct == null ? null : Math.round(netPct * 100) / 100,
    dir,
    sharp,
    why,
  }
}

/**
 * HERDS — the sectoral read, from the live matrix rather than a hand-written
 * map.
 *
 * A herd is a connected component of the correlation graph at `threshold`:
 * every member is strongly correlated with at least one other, so the group
 * moves as one bet even when no two members are individually paired. That
 * transitivity is the point — the hand-written CORRELATION_CLUSTERS in
 * correlation.js cannot discover a herd that formed this week, and a herd
 * that formed this week is exactly what the owner is asking about.
 *
 * |r| is used, not r: two symbols that move perfectly OPPOSITE are one bet
 * held two ways, which is the same concentration wearing a disguise.
 */
export function herdsOf(matrix, threshold = 0.7) {
  if (!matrix?.m) return []
  const syms = matrix.symbols || Object.keys(matrix.m)
  const seen = new Set()
  const herds = []
  for (const start of syms) {
    if (seen.has(start)) continue
    const stack = [start]
    const members = []
    seen.add(start)
    while (stack.length) {
      const s = stack.pop()
      members.push(s)
      for (const other of syms) {
        if (seen.has(other) || other === s) continue
        const r = matrix.m[s]?.[other]
        if (r != null && Number.isFinite(r) && Math.abs(r) >= threshold) {
          seen.add(other)
          stack.push(other)
        }
      }
    }
    // A herd of one is not a herd — it is a symbol, and it already has a row.
    if (members.length >= 2) herds.push(members.sort())
  }
  return herds.sort((a, b) => b.length - a.length)
}

/**
 * Is this herd MOVING, and are its members moving together?
 *
 * `agreement` is the share of members whose sign matches the majority; a
 * cluster where half go up and half go down is correlated on paper and doing
 * nothing in practice, and calling that a herd move would be the detector
 * lying about its own evidence.
 */
export function herdPulse(members, readings, cfg = DEFAULT_PULSE) {
  const rows = (members || []).map(s => readings[s]).filter(Boolean)
  if (rows.length < 2) return null
  const ups = rows.filter(r => r.dir > 0).length
  const downs = rows.filter(r => r.dir < 0).length
  const lead = Math.max(ups, downs)
  const agreement = lead / rows.length
  const dir = ups === downs ? 0 : (ups > downs ? 1 : -1)
  const movers = rows.filter(r => r.state === 'breaking' || r.state === 'trending').length
  const sharp = rows.filter(r => r.sharp).length
  return {
    members: members.slice(),
    n: rows.length,
    dir,
    agreement: Math.round(agreement * 100) / 100,
    movers,
    sharp,
    // A herd move needs BOTH: enough members agreeing on direction, and
    // enough of them actually going somewhere. Agreement alone is satisfied
    // by a cluster drifting a hundredth of a percent in step.
    moving: agreement >= cfg.herdAgreement && movers >= Math.ceil(rows.length / 2),
  }
}

/**
 * PAIR DIVERGENCE — the USDJPY / JPN225 case, named.
 *
 * Two symbols the live matrix says are strongly related, behaving
 * differently right now: one going somewhere, the other being held. That is
 * neither "a trend" nor "a correlation move" — it is a correlated pair under
 * stress, and it is the state worth knowing before you take a position in
 * either leg, because the relationship the position implicitly relies on is
 * currently not operating.
 *
 * Reported for a HELD leg against a MOVING one specifically. Two legs that
 * are both quiet are not diverging, they are both asleep.
 */
export function pairDivergences(matrix, readings, cfg = DEFAULT_PULSE) {
  if (!matrix?.m) return []
  const mcfgThreshold = cfg.pairThreshold ?? 0.6
  const syms = (matrix.symbols || Object.keys(matrix.m)).filter(s => readings[s])
  const out = []
  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      const a = syms[i], b = syms[j]
      const r = matrix.m[a]?.[b]
      if (r == null || !Number.isFinite(r) || Math.abs(r) < mcfgThreshold) continue
      const ra = readings[a], rb = readings[b]
      const moving = (x) => x.state === 'breaking' || x.state === 'trending'
      const held = (x) => x.state === 'defended'
      let holdLeg = null, runLeg = null
      if (held(ra) && moving(rb)) { holdLeg = a; runLeg = b }
      else if (held(rb) && moving(ra)) { holdLeg = b; runLeg = a }
      if (!holdLeg) continue
      out.push({
        held: holdLeg, running: runLeg,
        r: Math.round(r * 100) / 100,
        note: `${holdLeg} is being held while ${runLeg} runs — these normally move ${r > 0 ? 'together' : 'opposite'} (r ${Math.round(r * 100) / 100}), so the relationship a position in either leg leans on is not operating right now`,
      })
    }
  }
  return out
}

/**
 * The whole read, from bars the caller supplies.
 *
 * `barsBySymbol` is passed IN rather than fetched here for the same reason
 * correlation-matrix.js separates its math from its fetch: the quant phase
 * already pulls these bars for the correlation matrix, and pulling them twice
 * would double the broker traffic to answer a question about the same window.
 */
export function computePulse(barsBySymbol, matrix, cfg = DEFAULT_PULSE, threshold = 0.7) {
  const readings = {}
  for (const [sym, bars] of Object.entries(barsBySymbol || {})) {
    const r = classifySymbol(bars, cfg)
    if (r) readings[String(sym).toUpperCase()] = r
  }
  const herds = herdsOf(matrix, threshold)
    .map(members => ({ ...herdPulse(members, readings, cfg) }))
    .filter(h => h.n)
  return {
    readings,
    herds,
    divergences: pairDivergences(matrix, readings, cfg),
    // Named up front so a reader does not have to scan the map for them.
    sharp: Object.entries(readings).filter(([, r]) => r.sharp)
      .map(([symbol, r]) => ({ symbol, sigma: r.sigma, netPct: r.netPct, state: r.state }))
      .sort((a, b) => Math.abs(b.sigma) - Math.abs(a.sigma)),
    defended: Object.entries(readings).filter(([, r]) => r.state === 'defended')
      .map(([symbol, r]) => ({ symbol, pin: r.pin, netPct: r.netPct })),
  }
}

/** Persist the reading so the UI and the entry path read the SAME one. */
export function storePulse(db, pulse, nowIso = new Date().toISOString()) {
  try {
    setState(db, 'market_pulse_json', JSON.stringify({ ...pulse, builtAt: nowIso }))
    return true
  } catch { return false }
}

/** The stored reading, or null. */
export function loadPulse(db) {
  try {
    const p = JSON.parse(getState(db, 'market_pulse_json') || 'null')
    return p && p.readings ? p : null
  } catch { return null }
}

/**
 * The reading for ONE symbol, for the entry and pending-order paths.
 *
 * Returns `{ known: false }` rather than a neutral-looking reading when there
 * is nothing to say — a caller that treated "no data" as "quiet" would report
 * calm it never measured, which is the failure mode the vol gate already hit
 * once when atr_history was empty and everything read NORMAL.
 */
export function pulseFor(db, symbol, nowMs = Date.now(), maxAgeMin = 120) {
  const p = loadPulse(db)
  if (!p) return { known: false, why: 'no pulse computed yet' }
  if (p.builtAt) {
    const age = nowMs - Date.parse(p.builtAt)
    if (Number.isFinite(age) && age > maxAgeMin * 60_000) {
      return { known: false, why: `pulse is ${Math.round(age / 60_000)}m old` }
    }
  }
  const sym = String(symbol || '').toUpperCase()
  const r = p.readings?.[sym]
  if (!r) return { known: false, why: 'symbol not in the last pulse window' }
  const herd = (p.herds || []).find(h => h.members?.includes(sym)) || null
  const divergence = (p.divergences || []).find(d => d.held === sym || d.running === sym) || null
  return {
    known: true,
    ...r,
    builtAt: p.builtAt || null,
    // The three questions the owner asked, answered per symbol:
    //   is it trending?           → state
    //   is it a correlation move? → herd.moving with this symbol agreeing
    //   or both?                  → both true at once
    herd: herd ? { n: herd.n, dir: herd.dir, agreement: herd.agreement, moving: herd.moving, members: herd.members } : null,
    withHerd: !!(herd?.moving && herd.dir !== 0 && herd.dir === r.dir),
    divergence,
    driver: driverOf(r, herd),
  }
}

/**
 * TREND, HERD, OR BOTH — the owner's actual question, as one field.
 *
 * `herd` wins over `idiosyncratic` only when the symbol AGREES with its herd's
 * direction. A symbol going the other way inside a moving cluster is not
 * being carried by it; it is fighting it, and that deserves its own word.
 */
export function driverOf(reading, herd) {
  const moving = reading.state === 'breaking' || reading.state === 'trending'
  if (!herd?.moving || herd.dir === 0) return moving ? 'idiosyncratic' : 'none'
  if (herd.dir === reading.dir) return moving ? 'both' : 'herd'
  return moving ? 'against_herd' : 'none'
}

/**
 * Compute and store the pulse from bars the caller already has, using the
 * matrix and threshold the correlation job just wrote.
 *
 * The quant phase pulls these bars for the correlation matrix; this reads the
 * same window rather than fetching it again. Same discipline as
 * correlation-matrix.js: the math takes data, the wiring fetches it.
 */
export function computeAndStorePulse(db, barsBySymbol, nowIso = new Date().toISOString(), cfg = DEFAULT_PULSE) {
  let matrix = null
  try { matrix = loadStoredMatrix(db) } catch { matrix = null }
  let threshold = 0.7
  try { threshold = loadCorrelationMatrixConfig(db).threshold } catch { /* defaults */ }
  const pulse = computePulse(barsBySymbol, matrix, cfg, threshold)
  storePulse(db, pulse, nowIso)
  return {
    symbols: Object.keys(pulse.readings).length,
    herds: pulse.herds.length,
    sharp: pulse.sharp.length,
    defended: pulse.defended.length,
    divergences: pulse.divergences.length,
  }
}
