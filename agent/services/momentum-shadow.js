// ---------------------------------------------------------------------------
// agent/services/momentum-shadow.js — cross-sectional momentum, SHADOW ONLY
// (owner, 02-09-2026 21:05 SGT: "do ¶A·5").
//
// Ranks the scan universe by trailing return, would-hold the top slice long
// and the bottom slice short, with hysteresis (enter at 20%, stay until 40%)
// and the owner's side rule (a short must earn 1.5× a long's conviction),
// and LOGS every would-be entry, exit and refusal to its own table. It never
// proposes to the gate, never dispatches, never touches a position. This is
// the early-trim precedent (early-trim.js): a feature that writes shadow rows
// is off until asked for, 'log' is the only mode that exists, and every row
// says applied:0 on its face.
//
// WHY A SHADOW AND NOT A STRATEGY. A cross-sectional book has no tp1, and the
// gate only measures R:R on proposals that carry one — a momentum proposal
// would walk past the 3R floor by shape rather than by evidence. So it earns
// its way like everything else: thirty days of logged decisions, read against
// the prior, before an arm is even discussed (and the arm is a separate,
// owner-approved change; nothing here has an act path).
//
// The pure parts (trailingReturn, rankUniverse, stepHysteresis, convictionOf)
// carry the whole rule and are what the tests pin; runMomentumShadow is the
// thin impure wrapper that fetches bars and writes rows.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { shortMinConviction } from './direction-policy.js'

export const MOMENTUM_SHADOW_MODE_LOG = 'log'
export const MOMENTUM_SHADOW_CONFIG_KEY = 'momentum_shadow_json'
export const MOMENTUM_SHADOW_STATE_KEY = 'momentum_shadow_state_json'

export const DEFAULT_MOMENTUM_SHADOW = Object.freeze({
  enabled: false,                 // OFF until the owner turns it on
  mode: MOMENTUM_SHADOW_MODE_LOG, // the only mode that exists
  timeframe: '1d',
  lookback: 60,                   // bars of trailing return (≈ 3 months daily)
  skip: 5,                        // most recent bars excluded (short-term reversal)
  enterPct: 0.2,                  // enter when ranked in the top/bottom 20%
  exitPct: 0.4,                   // stay until it leaves the top/bottom 40%
  longMinConviction: 6,           // the scan's own "hot" threshold
  shortConvictionMult: 1.5,       // owner: shorts must earn 1.5× conviction
  minUniverse: 8,                 // fewer ranked names than this → no decision
  maxSymbols: 120,
  intervalMin: 60,                // one ranking pass per hour is plenty for daily bars
})

const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d)

/**
 * The effective config from a stored blob. Anything malformed falls back to
 * the default, `mode` is forced to 'log', and an unparseable blob leaves the
 * feature OFF — the fail-safe direction for something that writes rows.
 */
export function momentumShadowConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const d = DEFAULT_MOMENTUM_SHADOW
  const enterPct = clamp(r.enterPct, 0.01, 0.49, d.enterPct)
  return {
    enabled: r.enabled === true,
    mode: MOMENTUM_SHADOW_MODE_LOG,
    timeframe: typeof r.timeframe === 'string' && r.timeframe.trim() ? r.timeframe.trim() : d.timeframe,
    lookback: Math.round(clamp(r.lookback, 10, 500, d.lookback)),
    skip: Math.round(clamp(r.skip, 0, 50, d.skip)),
    enterPct,
    // exit band is never tighter than the entry band, or the hysteresis inverts
    exitPct: clamp(r.exitPct, enterPct, 0.5, Math.max(enterPct, d.exitPct)),
    longMinConviction: Math.round(clamp(r.longMinConviction, 1, 10, d.longMinConviction)),
    shortConvictionMult: clamp(r.shortConvictionMult, 1, 3, d.shortConvictionMult),
    minUniverse: Math.round(clamp(r.minUniverse, 2, 1000, d.minUniverse)),
    maxSymbols: Math.round(clamp(r.maxSymbols, 2, 1000, d.maxSymbols)),
    intervalMin: Math.round(clamp(r.intervalMin, 1, 1440, d.intervalMin)),
  }
}

export function loadMomentumShadow(db) {
  let raw = null
  try { raw = JSON.parse(getState(db, MOMENTUM_SHADOW_CONFIG_KEY) || 'null') } catch { raw = null }
  return momentumShadowConfig(raw)
}

// The short floor (longMin × mult, capped at 10) is ONE rule with two
// consumers since PR-D (11-09-2026): this shadow logs refusals against it and
// the momentum book places against it. It lives in direction-policy.js and is
// re-exported here so every existing reader of the shadow keeps its import.
export { shortMinConviction }

/**
 * Trailing return over `lookback` bars ending `skip` bars before the last
 * close: (close[-1-skip] / close[-1-skip-lookback]) − 1. Null when the window
 * is not there — a return computed over fewer bars than asked is a different
 * number wearing the same name.
 */
export function trailingReturn(bars, { lookback, skip }) {
  const list = Array.isArray(bars) ? bars : []
  const endIdx = list.length - 1 - skip
  const startIdx = endIdx - lookback
  if (startIdx < 0 || endIdx < 0) return null
  const a = Number(list[startIdx]?.c), b = Number(list[endIdx]?.c)
  if (!(a > 0) || !(b > 0)) return null
  return b / a - 1
}

/**
 * Percentile rank of each name among those with a return: 0 = weakest,
 * 1 = strongest (ties share the lower rank). Pure.
 * @param {Record<string, number|null>} returns
 * @returns {Record<string, number>} rankPct per symbol WITH a return
 */
export function rankUniverse(returns) {
  const entries = Object.entries(returns).filter(([, r]) => Number.isFinite(r))
  const n = entries.length
  if (n < 2) return {}
  const sorted = [...entries].sort((x, y) => x[1] - y[1])
  const out = {}
  sorted.forEach(([sym, r], i) => {
    // first index with this value, so ties rank together
    let j = i; while (j > 0 && sorted[j - 1][1] === r) j--
    out[sym] = j / (n - 1)
  })
  return out
}

/** Conviction 0–10 from rank strength on the chosen side. Pure. */
export function convictionOf(rankPct, side) {
  const strength = side === 'long' ? rankPct : 1 - rankPct
  return Math.round(Math.max(0, Math.min(1, strength)) * 10)
}

/**
 * One hysteresis step for one symbol. Pure.
 *
 * @param {'long'|'short'|'flat'} held   the shadow's current state
 * @param {number} rankPct               0 weakest … 1 strongest
 * @param {object} cfg                   effective config
 * @returns {{ next:'long'|'short'|'flat', action:'enter'|'exit'|'hold'|'none'|'refused',
 *   side:'long'|'short'|null, conviction:number|null, reason:string|null }}
 */
export function stepHysteresis(held, rankPct, cfg) {
  const { shortMin } = shortMinConviction(cfg)
  const topEnter = 1 - cfg.enterPct, topExit = 1 - cfg.exitPct
  const botEnter = cfg.enterPct, botExit = cfg.exitPct
  if (held === 'long') {
    if (rankPct >= topExit) return { next: 'long', action: 'hold', side: 'long', conviction: convictionOf(rankPct, 'long'), reason: null }
    return { next: 'flat', action: 'exit', side: 'long', conviction: convictionOf(rankPct, 'long'), reason: `rank ${r3(rankPct)} < ${r3(topExit)}` }
  }
  if (held === 'short') {
    if (rankPct <= botExit) return { next: 'short', action: 'hold', side: 'short', conviction: convictionOf(rankPct, 'short'), reason: null }
    return { next: 'flat', action: 'exit', side: 'short', conviction: convictionOf(rankPct, 'short'), reason: `rank ${r3(rankPct)} > ${r3(botExit)}` }
  }
  // flat
  if (rankPct >= topEnter) {
    const c = convictionOf(rankPct, 'long')
    if (c >= cfg.longMinConviction) return { next: 'long', action: 'enter', side: 'long', conviction: c, reason: null }
    return { next: 'flat', action: 'refused', side: 'long', conviction: c, reason: `conviction ${c} < long floor ${cfg.longMinConviction}` }
  }
  if (rankPct <= botEnter) {
    const c = convictionOf(rankPct, 'short')
    if (c >= shortMin) return { next: 'short', action: 'enter', side: 'short', conviction: c, reason: null }
    return { next: 'flat', action: 'refused', side: 'short', conviction: c, reason: `short_rule: conviction ${c} < ${shortMin} (${cfg.longMinConviction}×${cfg.shortConvictionMult})` }
  }
  return { next: 'flat', action: 'none', side: null, conviction: null, reason: null }
}

const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null)
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null)

export function loadShadowState(db) {
  try {
    const s = JSON.parse(getState(db, MOMENTUM_SHADOW_STATE_KEY) || 'null')
    if (s && typeof s === 'object') {
      return {
        holdings: s.holdings && typeof s.holdings === 'object' ? s.holdings : {},
        refused: s.refused && typeof s.refused === 'object' ? s.refused : {},
        lastRunMs: Number(s.lastRunMs) || 0, lastUniverse: Number(s.lastUniverse) || 0,
      }
    }
  } catch { /* fall through */ }
  return { holdings: {}, refused: {}, lastRunMs: 0, lastUniverse: 0 }
}

/**
 * Apply one ranking pass to the shadow book. Pure over (state, ranks,
 * prices): returns the new state and the rows to log. `now` is injected.
 */
export function applyPass(state, { ranks, prices, cfg, now }) {
  const holdings = { ...(state.holdings || {}) }
  // A refusal is logged ONCE per name and side while it persists — the
  // hourly pass would otherwise write the same refusal 24 times a day and
  // the count would measure passes, not decisions.
  const refused = { ...(state.refused || {}) }
  const rows = []
  const symbols = new Set([...Object.keys(ranks), ...Object.keys(holdings)])
  for (const sym of symbols) {
    const h = holdings[sym] || null
    const held = h?.side === 'long' || h?.side === 'short' ? h.side : 'flat'
    const rankPct = ranks[sym]
    if (!Number.isFinite(rankPct)) {
      // Held name dropped out of the ranked set (no bars this pass): keep it,
      // say nothing. A missing bar is not a signal.
      continue
    }
    const step = stepHysteresis(held, rankPct, cfg)
    const price = Number(prices[sym])
    if (step.action === 'enter') {
      holdings[sym] = { side: step.side, entryPrice: Number.isFinite(price) ? price : null, enteredAt: now, entryRank: r3(rankPct), entryConviction: step.conviction }
      rows.push({ symbol: sym, action: 'enter', side: step.side, rank_pct: r3(rankPct), conviction: step.conviction, price: Number.isFinite(price) ? price : null, entry_price: null, ret_pct: null, hold_ms: null, reason: null })
    } else if (step.action === 'exit') {
      const entry = Number(h?.entryPrice)
      const ret = Number.isFinite(entry) && entry > 0 && Number.isFinite(price)
        ? (step.side === 'long' ? price / entry - 1 : entry / price - 1)
        : null
      delete holdings[sym]
      rows.push({ symbol: sym, action: 'exit', side: step.side, rank_pct: r3(rankPct), conviction: step.conviction, price: Number.isFinite(price) ? price : null, entry_price: Number.isFinite(entry) ? entry : null, ret_pct: r4(ret), hold_ms: h?.enteredAt ? now - Number(h.enteredAt) : null, reason: step.reason })
    } else if (step.action === 'refused') {
      if (refused[sym] !== step.side) {
        refused[sym] = step.side
        rows.push({ symbol: sym, action: 'refused', side: step.side, rank_pct: r3(rankPct), conviction: step.conviction, price: Number.isFinite(price) ? price : null, entry_price: null, ret_pct: null, hold_ms: null, reason: step.reason })
      }
      continue
    }
    delete refused[sym]
  }
  return { state: { holdings, refused, lastRunMs: now, lastUniverse: Object.keys(ranks).length }, rows }
}

/**
 * The impure pass: fetch bars for the universe, rank, step, log. Every
 * failure is swallowed into the return value — a shadow must never touch the
 * loop's own cycle. `bars(symbol, symbolId)` is injectable for tests and
 * defaults to the scan's regime-bar cache.
 *
 * @returns {{ ran:boolean, why?:string, universe?:number, ranked?:number, rows?:number }}
 */
export async function runMomentumShadow(db, { symbols = [], symbolMap = {}, bars = null, creds = null, now = Date.now(), loopId = null, force = false } = {}) {
  const cfg = loadMomentumShadow(db)
  if (!cfg.enabled) return { ran: false, why: 'disabled' }
  const state = loadShadowState(db)
  if (!force && state.lastRunMs && now - state.lastRunMs < cfg.intervalMin * 60_000) return { ran: false, why: 'interval' }
  let fetch = bars
  if (!fetch) {
    if (!creds) return { ran: false, why: 'no_credentials' }
    const { getRegimeBars } = await import('./fib-strategy.js')
    fetch = async (_symbol, symbolId) => (await getRegimeBars(creds, symbolId, { preferredTfs: [cfg.timeframe], fallbackTf: cfg.timeframe, count: cfg.lookback + cfg.skip + 5 })).bars
  }
  const names = [...new Set(symbols.map(s => String(typeof s === 'string' ? s : s?.symbol || '').toUpperCase()).filter(Boolean))].slice(0, cfg.maxSymbols)
  const returns = {}, prices = {}
  let fetched = 0
  for (const sym of names) {
    const symbolId = symbolMap[sym]
    if (symbolId == null) continue
    try {
      const b = await fetch(sym, symbolId)
      fetched++
      const r = trailingReturn(b, cfg)
      if (r != null) { returns[sym] = r; prices[sym] = Number(b[b.length - 1]?.c) }
    } catch { /* one symbol's fetch failing is not the pass failing */ }
  }
  const ranks = rankUniverse(returns)
  const ranked = Object.keys(ranks).length
  if (ranked < cfg.minUniverse) {
    setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ ...state, lastRunMs: now, lastUniverse: ranked }))
    return { ran: true, universe: names.length, fetched, ranked, rows: 0, why: `universe ${ranked} < minUniverse ${cfg.minUniverse}` }
  }
  const { state: next, rows } = applyPass(state, { ranks, prices, cfg, now })
  const ins = db.prepare(`INSERT INTO momentum_shadow (symbol, action, side, rank_pct, conviction, price, entry_price, ret_pct, hold_ms, reason, timeframe, universe, applied, loop_id, at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
  const at = new Date(now).toISOString()
  const tx = db.transaction((list) => {
    for (const r of list) ins.run(r.symbol, r.action, r.side, r.rank_pct, r.conviction, r.price, r.entry_price, r.ret_pct, r.hold_ms, r.reason, cfg.timeframe, ranked, loopId, at)
    setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify(next))
  })
  tx(rows)
  return { ran: true, universe: names.length, fetched, ranked, rows: rows.length, holdings: Object.keys(next.holdings).length }
}

/**
 * The read: config, the shadow book, and what the closed shadow trades
 * returned per side. Report only, and it says so.
 */
export function momentumShadowReport(db, { days = 30 } = {}) {
  const cfg = loadMomentumShadow(db)
  const state = loadShadowState(db)
  const since = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString()
  let rows = []
  try { rows = db.prepare(`SELECT * FROM momentum_shadow WHERE at >= ? ORDER BY id ASC`).all(since) } catch { rows = [] }
  const side = (s) => rows.filter(r => r.side === s)
  const stat = (s) => {
    const exits = side(s).filter(r => r.action === 'exit' && Number.isFinite(Number(r.ret_pct)))
    const rets = exits.map(r => Number(r.ret_pct))
    const wins = rets.filter(r => r > 0).length
    return {
      entries: side(s).filter(r => r.action === 'enter').length,
      exits: exits.length,
      refused: side(s).filter(r => r.action === 'refused').length,
      winRate: rets.length ? Math.round((wins / rets.length) * 1000) / 10 : null,
      meanRetPct: rets.length ? r4(rets.reduce((a, b) => a + b, 0) / rets.length * 100) : null,
      sumRetPct: rets.length ? r4(rets.reduce((a, b) => a + b, 0) * 100) : null,
      medianHoldH: exits.length ? r3(exits.map(r => Number(r.hold_ms) || 0).sort((a, b) => a - b)[Math.floor(exits.length / 2)] / 3_600_000) : null,
    }
  }
  const refusedBy = {}
  for (const r of rows.filter(r => r.action === 'refused')) {
    const k = String(r.reason || '').startsWith('short_rule') ? 'short_rule' : 'long_floor'
    refusedBy[k] = (refusedBy[k] || 0) + 1
  }
  const { shortMin, shortRuleAboveScale } = shortMinConviction(cfg)
  return {
    reportOnly: true,
    shadow: true,
    config: cfg,
    shortMinConviction: shortMin,
    shortRuleAboveScale,
    days,
    lastRunAt: state.lastRunMs ? new Date(state.lastRunMs).toISOString() : null,
    lastUniverse: state.lastUniverse,
    holdings: state.holdings,
    rowsInWindow: rows.length,
    long: stat('long'),
    short: stat('short'),
    refusedBy,
    writes: 'momentum_shadow rows, applied=0 — decisions only, nothing is proposed or traded',
  }
}
