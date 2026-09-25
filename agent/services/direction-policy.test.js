// node --test agent/services/direction-policy.test.js
//
// PR-D (owner principle 8, 11-09-2026): trade direction is a STATED reason.
// Pinned here: the one direction rule (the 1.5× short floor, capped at 10,
// and trend alignment) and its two consumers; every scan strategy's signal
// carries a `direction_reason` set where its bias is assigned; the synth
// threads it to the proposal and `persistRiskEvent` stores it in
// proposal_json beside the trend reading at evaluation; a watchlist
// override_bias with no override_reason is refused with a decision_log row.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { DEFAULT_DIRECTION_CFG, shortMinConviction, directionFor, normaliseTrend, permittedSides, trendReadingFor } from './direction-policy.js'
import { buildEntrySynth, momentumBookConfig } from './momentum-book.js'
import { shortMinConviction as shadowShortMin, momentumShadowConfig, stepHysteresis } from './momentum-shadow.js'
import { computeDonchianBreakout } from './donchian-breakout.js'
import { computeRsi2 } from './rsi2-reversion.js'
import { computeRsiMeanrev } from './rsi-meanrev.js'
import { computeVwapTrend } from './vwap-trend.js'
import { synthesizeFibSignal, atr } from './fib-strategy.js'
import { persistRiskEvent } from './risk.js'
import { recentDecisions } from './decision-log.js'
import { vwapSeries } from '../lib/indicators.js'
import { runOracle } from '../lib/tick-strategy.js'
import { STRATEGY_REGISTRY } from './strategies.js'

const strip = (s) => s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')

test('directionFor: a long needs the long floor; a short needs ceil(longMin × 1.5) = 9 on the defaults AND a fresh DOWN-trend reading (no reading refuses a short, an up-trend refuses it); longs ignore the reading; both trend spellings are read', () => {
  assert.deepEqual(shortMinConviction(DEFAULT_DIRECTION_CFG), { shortMin: 9, raw: 9, shortRuleAboveScale: false })
  assert.equal(shortMinConviction({ longMinConviction: 8, shortConvictionMult: 1.5 }).shortMin, 10, 'capped at the scale')
  assert.equal(shortMinConviction({ longMinConviction: 8, shortConvictionMult: 1.5 }).shortRuleAboveScale, true)
  assert.equal(directionFor({ side: 'long', conviction: 6 }).ok, true)
  assert.equal(directionFor({ side: 'long', conviction: 5 }).ok, false)
  assert.match(directionFor({ side: 'long', conviction: 5 }).reason, /^long_floor: conviction 5 < 6/)
  assert.equal(directionFor({ side: 'short', conviction: 8 }).ok, false)
  assert.match(directionFor({ side: 'short', conviction: 8 }).reason, /^short_rule: conviction 8 < 9 \(6×1\.5\)/)
  // no reading is NOT a reading for a short (checker MAJOR 2): refused, with the reason
  assert.equal(directionFor({ side: 'short', conviction: 9 }).ok, false)
  assert.match(directionFor({ side: 'short', conviction: 9 }).reason, /^direction_no_trend_reading: a short needs a fresh trend reading/)
  assert.equal(directionFor({ side: 'short', conviction: 9, trendDirection: null }).ok, false)
  assert.equal(directionFor({ side: 'short', conviction: 9, trendDirection: 'sideways' }).ok, false, 'an unreadable trend is no reading')
  for (const up of ['long', 'up']) {
    const r = directionFor({ side: 'short', conviction: 10, trendDirection: up })
    assert.equal(r.ok, false, `against ${up}`); assert.match(r.reason, /^direction_against_trend: short into an up-trend/)
  }
  for (const down of ['short', 'down']) {
    const r = directionFor({ side: 'short', conviction: 9, trendDirection: down })
    assert.equal(r.ok, true, `with ${down}`); assert.match(r.reason, /^tsmom:short conviction 9 ≥ 9 trend down/)
  }
  assert.equal(directionFor({ side: 'long', conviction: 9 }).ok, true, 'a long needs no reading')
  assert.equal(directionFor({ side: 'long', conviction: 9, trendDirection: 'short' }).ok, true, 'a long against a down-trend is the regime gate\'s call, not this rule\'s')
  assert.equal(directionFor({ side: 'flat', conviction: 9 }).ok, false)
  assert.equal(directionFor({ side: 'short', conviction: null }).ok, false)
  assert.deepEqual([normaliseTrend('long'), normaliseTrend('DOWN'), normaliseTrend(null), normaliseTrend('x')], ['up', 'down', null, null])
  assert.deepEqual([permittedSides('long'), permittedSides('short'), permittedSides(null)], [['BUY'], ['SELL'], ['BUY', 'SELL']])
})

test('one rule, two consumers: the shadow imports the SAME shortMinConviction and refuses a short below it on its own config', () => {
  assert.equal(shadowShortMin, shortMinConviction, 'the shadow re-exports the policy\'s function, not a copy')
  const cfg = momentumShadowConfig({ longMinConviction: 6, shortConvictionMult: 1.5 })
  assert.equal(stepHysteresis('flat', 0.18, cfg).action, 'refused') // rank 0.18 → conviction round(8.2) = 8
  assert.match(stepHysteresis('flat', 0.18, cfg).reason, /^short_rule: conviction 8 < 9/)
  assert.equal(stepHysteresis('flat', 0.05, cfg).action, 'enter')
  assert.equal(directionFor({ side: 'short', conviction: 8, cfg, trendDirection: 'down' }).ok, false, 'the book refuses exactly what the shadow refuses')
  assert.equal(directionFor({ side: 'short', conviction: 9, cfg, trendDirection: 'down' }).ok, true)
})

test('trendReadingFor (ONE reader for the book, the account pass and the feeder) honours regime_gate_json: the age bound is maxRegimeAgeMin, the on switch off means no reading, a stale row is no reading', () => {
  const db = initDB(':memory:')
  assert.equal(trendReadingFor(db, 'NATGAS'), null, 'no row')
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('NATGAS', 'trending', 'short', datetime('now', '-30 minutes'))`).run()
  assert.equal(trendReadingFor(db, 'NATGAS'), 'short', 'fresh under the default 240 min bound')
  setState(db, 'regime_gate_json', JSON.stringify({ on: true, maxRegimeAgeMin: 10 }))
  assert.equal(trendReadingFor(db, 'NATGAS'), null, 'the owner\'s 10-minute bound makes a 30-minute row a fossil')
  setState(db, 'regime_gate_json', JSON.stringify({ on: true, maxRegimeAgeMin: 60 }))
  assert.equal(trendReadingFor(db, 'NATGAS'), 'short')
  setState(db, 'regime_gate_json', JSON.stringify({ on: false }))
  assert.equal(trendReadingFor(db, 'NATGAS'), null, 'gate off → no reading (a short is then refused, never gated on a table the owner turned off)')
})

// The strategies: every signal states its direction where the bias is
// assigned. Behavioural on the fixtures that fire deterministically here;
// the registry-wide pin below catches a strategy that drops the field.
const dbar = (c, { spread = 0.5, v = 1000, h, l } = {}) => ({ o: c, h: h ?? c + spread, l: l ?? c - spread, c, v })
function rangeBars(n, lo, hi) {
  const bars = []
  for (let i = 0; i < n; i++) { const phase = i % 12; const frac = phase <= 6 ? phase / 6 : (12 - phase) / 6; bars.push(dbar(lo + frac * (hi - lo))) }
  return bars
}
test('donchian, rsi2, rsi_meanrev and vwap signals carry a direction_reason on both sides, set where the bias was decided', () => {
  const dl = computeDonchianBreakout([...rangeBars(45, 100, 110), dbar(111.5, { h: 111.7, l: 109.5, v: 2000 })], '1h')
  assert.equal(dl.bias, 'long'); assert.equal(dl.direction_reason, 'donchian:close>hi20')
  const ds = computeDonchianBreakout([...rangeBars(45, 100, 110), dbar(98.5, { h: 100.5, l: 98.3, v: 2000 })], '1h')
  assert.equal(ds.bias, 'short'); assert.equal(ds.direction_reason, 'donchian:close<lo20')
  const rbar = (c, hw = 0.4) => ({ o: c, h: c + hw, l: c - hw, c })
  const up = []; let p = 100; for (let i = 0; i < 120; i++) { p += 1; up.push(rbar(p)) } up.push(rbar(p - 5)); up.push(rbar(p - 10))
  const rl = computeRsi2(up, '1h'); assert.equal(rl.bias, 'long'); assert.equal(rl.direction_reason, 'rsi2:close>sma100,rsi2<10')
  const dn = []; p = 300; for (let i = 0; i < 120; i++) { p -= 1; dn.push(rbar(p)) } dn.push(rbar(p + 5)); dn.push(rbar(p + 10))
  const rs = computeRsi2(dn, '4h'); assert.equal(rs.bias, 'short'); assert.equal(rs.direction_reason, 'rsi2:close<sma100,rsi2>90')
  const mbar = (c, s = 0.4) => ({ o: c, h: c + s, l: c - s, c, v: 1000 })
  const ml = []; p = 100; for (let i = 0; i < 30; i++) ml.push(mbar(p)); for (let i = 0; i < 20; i++) { p += 3.5; ml.push(mbar(p)) } for (let i = 0; i < 20; i++) ml.push(mbar(p)); for (let i = 0; i < 6; i++) { p -= 3; ml.push(mbar(p)) } ml.push({ o: p, h: p + 3.1, l: p - 0.5, c: p + 3, v: 1000 })
  const m = computeRsiMeanrev(ml, '1h'); assert.equal(m.bias, 'long'); assert.equal(m.direction_reason, 'rsi:cross_up_30,trend_up')
  const ms = []; p = 300; for (let i = 0; i < 30; i++) ms.push(mbar(p)); for (let i = 0; i < 20; i++) { p -= 3.5; ms.push(mbar(p)) } for (let i = 0; i < 20; i++) ms.push(mbar(p)); for (let i = 0; i < 6; i++) { p += 3; ms.push(mbar(p)) } ms.push({ o: p, h: p + 0.5, l: p - 3.1, c: p - 3, v: 1000 })
  const m2 = computeRsiMeanrev(ms, '1h'); assert.equal(m2.bias, 'short'); assert.equal(m2.direction_reason, 'rsi:cross_down_70,trend_down')
  const HOUR = 3_600_000
  const vb = (i, o, h, l, c, v) => ({ t: Date.UTC(2026, 6, 20) + i * HOUR, o, h, l, c, v })
  const vw = []; for (let i = 0; i < 40; i++) { const mid = 100 + i * 0.1; vw.push(vb(i, mid - 0.5, mid + 1.5, mid - 1.5, mid + 0.4, 1000)) }
  const v = vwapSeries(vw, 0)[vw.length - 1], a = atr(vw, 14)
  vw.push(vb(40, v + 0.2, v + a, v - 0.3 * a, v + 0.6 * a, 1500))
  const vs = computeVwapTrend(vw, '1h'); assert.equal(vs.bias, 'long'); assert.equal(vs.direction_reason, 'vwap:close>rising_vwap')
})

// The signal-building function of each strategy, so the pin reads ONLY that
// function's returned object (checker MAJOR 3, 11-09-2026: a file-wide count
// could not fail for fib_618_fade, cup_handle and tsmom_long, where the
// string appears elsewhere in the file). `fn` is the function whose return
// carries the signal; `next` marks where the source slice ends.
const SIGNAL_FN = {
  fib_618_fade: ['fib-strategy.js', 'export function computeFibSignal(', '\nfunction strategyFns('],
  cup_handle: ['cup-handle.js', 'function searchCupHandle(', '\nexport function computeCupHandleSignal('],
  inv_cup_handle: ['cup-handle.js', 'function searchCupHandle(', '\nexport function computeCupHandleSignal('],
  ema_pullback: ['ema-pullback.js', 'export function computeEmaPullback(', null],
  donchian_breakout: ['donchian-breakout.js', 'export function computeDonchianBreakout(', null],
  rsi_meanrev: ['rsi-meanrev.js', 'export function computeRsiMeanrev(', null],
  vwap_trend: ['vwap-trend.js', 'export function computeVwapTrend(', null],
  vp_value: ['vp-value.js', 'export function computeVpValue(', null],
  rsi2_reversion: ['rsi2-reversion.js', 'export function computeRsi2(', null],
  fib_confluence: ['fib-confluence.js', 'export function computeFibConfluence(', null],
  va_breakout: ['va-breakout.js', 'export function computeVaBreakout(', '\nfunction findConfirmedBreak('],
  fvg_retrace: ['fvg-strategy.js', 'export function computeFvgSignal(', null],
  tsmom_long: ['momentum-book.js', 'export function buildEntrySynth(', '\nexport function loadBookState('],
}
function signalReturn(key) {
  const [file, fn, next] = SIGNAL_FN[key]
  const src = strip(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'))
  const a = src.indexOf(fn); assert.ok(a >= 0, `${file}: ${fn} not found`)
  const b = next ? src.indexOf(next, a) : src.indexOf('\nexport function', a + 1)
  const body = src.slice(a, b > a ? b : undefined)
  // the LAST `return {` of the function is the signal object
  const r = body.lastIndexOf('return {'); assert.ok(r >= 0, `${file}: ${fn} has no object return`)
  return body.slice(r)
}
test('function-scoped pin (comments stripped): every registered strategy\'s signal-building function RETURNS direction_reason; every registry key is listed; tsmom states it on the synth', () => {
  for (const s of STRATEGY_REGISTRY) {
    assert.ok(SIGNAL_FN[s.key], `${s.key}: a strategy joined the registry without a direction_reason pin — add its signal function here`)
    assert.match(signalReturn(s.key), /direction_reason/, `${SIGNAL_FN[s.key][0]} (${s.key}): the signal return carries no direction_reason`)
  }
  const cfg = momentumBookConfig({ enabled: true })
  assert.equal(buildEntrySynth({ symbol: 'X', price: 100, atr: 2, cfg, side: 'long' }).direction_reason, 'tsmom:long_top_band')
  assert.equal(buildEntrySynth({ symbol: 'X', price: 100, atr: 2, cfg, side: 'short', directionReason: 'tsmom:short conviction 9 ≥ 9 trend down' }).direction_reason, 'tsmom:short conviction 9 ≥ 9 trend down')
  const fib = strip(readFileSync(new URL('./fib-strategy.js', import.meta.url), 'utf8'))
  assert.match(fib, /consensus_bias: signal\.bias,\s*direction_reason: signal\.direction_reason \?\? null,/, 'synthesizeFibSignal threads the reason')
  const sig = { strategy: 'donchian_breakout', bias: 'short', direction_reason: 'donchian:close<lo20', conviction: 9, entry: 98.5, sl: 101, tp1: 88, tp2: 83, thesis: 't' }
  assert.equal(synthesizeFibSignal('NATGAS', sig, 8).synthesis.direction_reason, 'donchian:close<lo20')
  assert.equal(synthesizeFibSignal('NATGAS', { ...sig, direction_reason: undefined }, 8).synthesis.direction_reason, null, 'a missing reason is a visible null, never invented')
})

test('proposal_json carries direction_reason and trend_at_evaluation; the loop builds both onto the proposal (pin) and the tick oracle states tick:break_high / break_low', () => {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', '46979908')
  const id = persistRiskEvent(db, { symbol: 'NATGAS', side: 'SELL', strategy: 'donchian_breakout', direction_reason: 'donchian:close<lo20', trend_at_evaluation: { regime: 'trending', trend_direction: 'short', computed_at: 'x', stale: false }, entry: 98.5, accountId: '46979908' }, { approved: false, veto_reason: 'test' })
  const row = db.prepare(`SELECT proposal_json FROM risk_events WHERE id = ?`).get(id)
  const p = JSON.parse(row.proposal_json)
  assert.equal(p.direction_reason, 'donchian:close<lo20'); assert.equal(p.trend_at_evaluation.trend_direction, 'short')
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.match(loop, /const proposal = \{\s*symbol,\s*side,\s*direction_reason: synth\.direction_reason \?\? null,\s*trend_at_evaluation: trendAtEvaluation,/, 'autoTrade puts both on the proposal persistRiskEvent stores')
  assert.match(loop, /const rr = latestRegime\(db, symbol\)/, 'the trend reading is the regime table\'s, read at evaluation')
  // the tick oracle
  const ev = []; let seq = 0, t = 1_000_000, bid = 100_000
  const push = (o = {}) => { seq++; t += 50; ev.push({ seq, recvMs: t, bid, ask: bid + 10, snapshot: false, crossed: false, changed: true, ...o }) }
  for (let i = 0; i < 70; i++) { bid = 100_000 + (i % 7) * 2; push() }
  for (let i = 0; i < 12; i++) { bid += 9; push() }
  const { signals } = runOracle(ev, { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 })
  assert.equal(signals.length, 1); assert.equal(signals[0].side, 'BUY'); assert.equal(signals[0].dirReason, 'tick:break_high')
})

test('a watchlist override_bias with no override_reason is REFUSED (direction_override_unreasoned, auto_trade off, the strategy\'s side kept); with a reason it flips the side and becomes the direction_reason', async () => {
  const { dispatchSymbolSignal } = await import('../loop.js')
  const db = initDB(':memory:')
  const s = { latestScanForSymbol: new Map(), insertAnalysis: { run: () => ({ lastInsertRowid: 1 }) } }
  const signal = { strategy: 'donchian_breakout', bias: 'long', direction_reason: 'donchian:close>hi20', conviction: 9, entry: 111.5, sl: 108, tp1: 121, tp2: 126, thesis: 't', timeframe: '1h' }
  const r = await dispatchSymbolSignal(db, s, [{ symbol: 'NATGAS', autoTradeThreshold: 8, override_bias: 'short' }], 'NATGAS', signal)
  assert.equal(r.synth.consensus_bias, 'long', 'the unreasoned flip did not happen')
  assert.equal(r.synth.auto_trade, false)
  assert.equal(r.synth.direction_reason, 'donchian:close>hi20')
  const rows = recentDecisions(db, { symbol: 'NATGAS', stage: 'watchlist_override' })
  assert.equal(rows.length, 1); assert.equal(rows[0].decision, 'skip'); assert.match(rows[0].reason, /^direction_override_unreasoned override_bias=short/)
  const r2 = await dispatchSymbolSignal(db, s, [{ symbol: 'NATGAS', autoTradeThreshold: 8, override_bias: 'short', override_reason: 'owner: fading the gap' }], 'NATGAS', { ...signal })
  assert.equal(r2.synth.consensus_bias, 'short')
  assert.equal(r2.synth.direction_reason, 'override:owner: fading the gap')
  assert.equal(recentDecisions(db, { symbol: 'NATGAS', stage: 'watchlist_override' }).length, 1, 'a reasoned override is not a refusal')
  assert.deepEqual([r2.synth.sl, r2.synth.tp1, r2.synth.tp2], [115, 102, 97], 'a flip mirrors the bracket about the entry (checker item d): stop above, targets below')
  const r3 = await dispatchSymbolSignal(db, s, [{ symbol: 'NATGAS', autoTradeThreshold: 8, override_bias: 'short', override_reason: '   ' }], 'NATGAS', { ...signal })
  assert.equal(r3.synth.consensus_bias, 'long', 'a blank reason is no reason')
  assert.equal(recentDecisions(db, { symbol: 'NATGAS', stage: 'watchlist_override' }).length, 2, 'the blank reason is a new refusal (the item changed)')
  await dispatchSymbolSignal(db, s, [{ symbol: 'NATGAS', autoTradeThreshold: 8, override_bias: 'short', override_reason: '   ' }], 'NATGAS', { ...signal })
  assert.equal(recentDecisions(db, { symbol: 'NATGAS', stage: 'watchlist_override' }).length, 2, 'the same unreasoned item is logged ONCE, not every cycle (checker item g)')
  // The override runs BEFORE the regime gate, so the gate judges the flipped side (comment-stripped order pin).
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.ok(loop.indexOf("synth.direction_reason = `override:${overrideReason}`") < loop.indexOf('const rg = checkRegimeGate(db, synth.strategy, synth.consensus_bias, sym)'), 'the override block sits above the regime gate')
})

test('the quant phase computes regimes for the momentum universe and the tick universe as well as the scanned symbols (comment-stripped pin; checker MAJOR 2, V3 C4 B3)', () => {
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  // MAJOR 2 intent kept: the momentum universe stays a regime source. V3 C4
  // adds the tick universe (the tick permit feeder's direction filter reads
  // the same rows). The union is regime.js regimeSymbols, whose behaviour is
  // pinned in regime.test.js and loop-regime-symbols.test.js.
  assert.match(loop, /const regimeSymbols = unionRegimeSymbols\(\{ scanned: recentScans\.map\(r => r\.symbol\), universe: regimeUniverse\(db\), tick: tickSymbolNames\(db\) \}\)\.map\(symbol => \(\{ symbol \}\)\)/)
  assert.match(loop, /const \{ regimeSymbols: unionRegimeSymbols, computeRegime \} = await import\('\.\/services\/regime\.js'\)/, 'the helper is imported under another name (a same-name const is a TDZ throw)')
  assert.match(loop, /for \(const \{ symbol \} of regimeSymbols\) \{/)
  assert.ok(!/for \(const \{ symbol \} of recentScans\)/.test(loop), 'the old scanned-only loop is gone')
})
