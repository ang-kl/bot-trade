// ---------------------------------------------------------------------------
// agent/services/cluster-conviction.js — correlation clusters used OFFENSIVELY.
//
// Owner (2026-07-29): "Investigate if Correlation clusters can be better use
// as a strategy". Until now both correlation services were purely defensive —
// correlation.js vetoes stacking against a curated cluster map, and
// correlation-matrix.js vetoes against a live rolling Pearson matrix. Neither
// was ever used to FIND anything.
//
// The read this module adds: when most members of a correlated group show the
// SAME directional signal in one scan, that is not N independent setups. It is
// one macro bet appearing N times. The right response is to take the single
// best expression of it with more conviction, not to open all N and discover
// afterwards that they were the same trade.
//
// That is exactly the shape of the 2026-07-29 production day: four
// fib_618_fade entries inside five minutes, −2,317.70 between them.
//
// TWO SOURCES OF GROUPING, because the curated map alone is too narrow. Of
// the 14 symbols actually traded that day it covers 4 (NAS100, NZDUSD,
// SpotCrude, AUDUSD) and is blind to 10 (USDCNH, JPYX, AUDCAD, NatGas, Cocoa,
// BTCUSD, DOW.US, EURCAD, NVDA.US, Corn). So groups come from the curated
// clusters AND from the live matrix, which sees whatever is actually moving
// together this week.
//
// SHIPS LOG-ONLY. `enforce` defaults to false: the agreement is computed and
// recorded so the owner can see what it WOULD have done across real scans
// before it changes a single order. Same staging discipline the vol gate used.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { CORRELATION_CLUSTERS } from './correlation.js'

export const DEFAULT_CLUSTER_CONVICTION = {
  on: true,
  enforce: false,     // false = observe and record only; true = actually bias sizing/selection
  minMembers: 3,      // a group needs at least this many members SIGNALLING to say anything
  minRatio: 0.75,     // ...and at least this share of them pointing the same way
  bonus: 2,           // conviction added to the group's best member when it agrees
  maxConviction: 10,  // conviction ceiling, matching the rest of the stack
  useLiveMatrix: true,
  matrixThreshold: 0.7, // |corr| at/above this groups two symbols
}

export function loadClusterConvictionConfig(db) {
  try {
    const saved = JSON.parse(getState(db, 'cluster_conviction_json') || 'null')
    return { ...DEFAULT_CLUSTER_CONVICTION, ...(saved || {}) }
  } catch {
    return { ...DEFAULT_CLUSTER_CONVICTION }
  }
}

const up = (s) => String(s || '').toUpperCase()
// A signal's direction as ±1. Anything that isn't a clear long/short — 'skip',
// null, a typo — contributes nothing rather than defaulting to long.
export function dirOfBias(bias) {
  const b = String(bias || '').toLowerCase()
  if (b === 'long' || b === 'buy') return 1
  if (b === 'short' || b === 'sell') return -1
  return 0
}

/**
 * Pure: groups derived from the LIVE correlation matrix — symbols joined
 * transitively when |corr| >= threshold. Signed, so a strongly NEGATIVE
 * correlation still groups the pair (a long on one and a short on the other
 * are the same bet); the sign rides on the member so agreement maths can use
 * it the same way the curated betas do.
 *
 * @param {{symbols:string[], matrix:number[][]}} m
 * @returns {Array<{key:string, label:string, members:Record<string, 1|-1>}>}
 */
export function matrixGroups(m, threshold = 0.7) {
  const symbols = m?.symbols || []
  const matrix = m?.matrix || []
  if (symbols.length < 2) return []
  const seen = new Set()
  const groups = []
  for (let i = 0; i < symbols.length; i++) {
    if (seen.has(i)) continue
    // Breadth-first walk over the |corr| >= threshold edges, carrying the sign
    // so a chain A~+B~-C lands C at -1 relative to A.
    const members = { [up(symbols[i])]: 1 }
    const queue = [[i, 1]]
    seen.add(i)
    while (queue.length) {
      const [a, signA] = queue.shift()
      for (let b = 0; b < symbols.length; b++) {
        if (seen.has(b)) continue
        const c = Number(matrix[a]?.[b])
        if (!Number.isFinite(c) || Math.abs(c) < threshold) continue
        const signB = signA * (c >= 0 ? 1 : -1)
        members[up(symbols[b])] = signB
        seen.add(b)
        queue.push([b, signB])
      }
    }
    if (Object.keys(members).length >= 2) {
      groups.push({ key: `live:${up(symbols[i])}`, label: `Live cluster around ${up(symbols[i])}`, members })
    }
  }
  return groups
}

/**
 * Pure: how much one group agrees, given this scan's signals.
 *
 * `signals` is [{ symbol, bias, conviction }] — the shape the scan phase
 * already produces. A member with no signal, or a 'skip', simply isn't
 * counted; agreement is measured over the members that actually spoke.
 *
 * Direction is measured in the group's OWN signed sense: beta × bias. A long
 * on a +1 member and a short on a −1 member both count as +1 for the group,
 * because they are the same underlying position.
 *
 * @returns {null | {key, label, direction:1|-1, agree:number, total:number,
 *   ratio:number, best:{symbol,conviction}, members:Array, others:string[]}}
 */
export function groupAgreement(group, signals, { minMembers = 3, minRatio = 0.75 } = {}) {
  const bySymbol = new Map((signals || []).map(s => [up(s.symbol), s]))
  const voting = []
  for (const [sym, beta] of Object.entries(group.members || {})) {
    const sig = bySymbol.get(up(sym))
    if (!sig) continue
    const d = dirOfBias(sig.bias)
    if (d === 0) continue
    voting.push({ symbol: up(sym), vote: d * (beta >= 0 ? 1 : -1), bias: sig.bias, conviction: Number(sig.conviction) || 0 })
  }
  const total = voting.length
  if (total < minMembers) return null
  const plus = voting.filter(v => v.vote > 0).length
  const minus = total - plus
  const direction = plus >= minus ? 1 : -1
  const agree = direction > 0 ? plus : minus
  const ratio = agree / total
  if (ratio < minRatio) return null
  // The best expression of the bet: the agreeing member with the highest
  // conviction. Ties break on symbol name so the choice is deterministic —
  // a group that flip-flops its pick between scans would churn orders.
  const agreeing = voting
    .filter(v => v.vote === direction)
    .sort((a, b) => (b.conviction - a.conviction) || a.symbol.localeCompare(b.symbol))
  const best = agreeing[0]
  return {
    key: group.key,
    label: group.label,
    direction,
    agree,
    total,
    ratio: Math.round(ratio * 100) / 100,
    best: { symbol: best.symbol, conviction: best.conviction },
    members: voting,
    // Everything the group would rather NOT open separately.
    others: agreeing.slice(1).map(v => v.symbol),
  }
}

/**
 * The whole read for one scan.
 *
 * @param {Array} signals   [{ symbol, bias, conviction }]
 * @param {object} opts     { config, liveMatrix }
 * @returns {{
 *   groups: Array,
 *   bonusBySymbol: Record<string, number>,
 *   supersededBy: Record<string, string>,
 *   enforce: boolean
 * }}
 *
 * bonusBySymbol  — conviction to ADD to that symbol (the group's best member).
 * supersededBy   — symbol → the symbol that expresses the same bet better.
 *
 * Both are advisory unless config.enforce is true. A symbol that is best in
 * one group and superseded in another keeps the bonus and the supersede note;
 * the caller decides, and with enforce off nobody decides anything.
 */
export function clusterConviction(signals, { config = DEFAULT_CLUSTER_CONVICTION, liveMatrix = null } = {}) {
  const cfg = { ...DEFAULT_CLUSTER_CONVICTION, ...(config || {}) }
  const empty = { groups: [], bonusBySymbol: {}, supersededBy: {}, enforce: false }
  if (!cfg.on) return empty

  const groups = [...CORRELATION_CLUSTERS]
  if (cfg.useLiveMatrix && liveMatrix) {
    // Live groups come SECOND so a curated cluster wins the name when both
    // describe the same bet — the curated labels are the ones the owner reads.
    groups.push(...matrixGroups(liveMatrix, cfg.matrixThreshold))
  }

  const found = []
  const bonusBySymbol = {}
  const supersededBy = {}
  for (const g of groups) {
    const a = groupAgreement(g, signals, { minMembers: cfg.minMembers, minRatio: cfg.minRatio })
    if (!a) continue
    found.push(a)
    const bumped = Math.min(cfg.maxConviction, a.best.conviction + cfg.bonus)
    // Keep the LARGEST bonus when several groups agree on the same symbol —
    // two independent groups pointing at one instrument is more evidence, not
    // an excuse to add the bonus twice.
    bonusBySymbol[a.best.symbol] = Math.max(bonusBySymbol[a.best.symbol] ?? 0, bumped - a.best.conviction)
    for (const other of a.others) {
      if (!supersededBy[other]) supersededBy[other] = a.best.symbol
    }
  }
  // A symbol that is itself the best expression of some group is never
  // superseded — otherwise two overlapping groups could cancel each other and
  // suppress the very trade they both argued for.
  for (const sym of Object.keys(bonusBySymbol)) delete supersededBy[sym]

  return { groups: found, bonusBySymbol, supersededBy, enforce: cfg.enforce === true }
}
