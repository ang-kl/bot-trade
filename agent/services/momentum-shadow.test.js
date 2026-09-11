// node --test agent/services/momentum-shadow.test.js
//
// The momentum SHADOW (owner "do ¶A·5", 02-09-2026). Pinned in the order
// that matters: it is OFF by default and has no act path; the hysteresis
// bands and the short rule are the arithmetic the owner stated; a pass
// writes only momentum_shadow rows with applied=0 and never a proposal,
// order or position row; the report reads what was written.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState, getState } from '../db.js'
import {
  DEFAULT_MOMENTUM_SHADOW, momentumShadowConfig, shortMinConviction, trailingReturn, rankUniverse,
  convictionOf, stepHysteresis, applyPass, runMomentumShadow, momentumShadowReport,
  MOMENTUM_SHADOW_CONFIG_KEY, MOMENTUM_SHADOW_STATE_KEY,
} from './momentum-shadow.js'

const cfg = momentumShadowConfig({ enabled: true })

test('off by default — a feature that writes shadow rows must be asked for, and log is the only mode', () => {
  assert.equal(DEFAULT_MOMENTUM_SHADOW.enabled, false)
  assert.equal(momentumShadowConfig(null).enabled, false)
  assert.equal(momentumShadowConfig({ enabled: 'yes' }).enabled, false, 'only boolean true enables')
  assert.equal(momentumShadowConfig({ enabled: true, mode: 'act' }).mode, 'log')
  // Nonsense repairs to defaults; the exit band can never be tighter than entry.
  const c = momentumShadowConfig({ lookback: 'x', enterPct: 0.3, exitPct: 0.1, shortConvictionMult: 9 })
  assert.equal(c.lookback, 60)
  assert.equal(c.enterPct, 0.3)
  assert.equal(c.exitPct, 0.3)
  assert.equal(c.shortConvictionMult, 3)
})

test('the short rule: shorts must earn 1.5× a long\'s conviction, on the 0–10 scale, and an unreachable floor says so', () => {
  assert.deepEqual(shortMinConviction(cfg), { shortMin: 9, raw: 9, shortRuleAboveScale: false })
  assert.deepEqual(shortMinConviction(momentumShadowConfig({ longMinConviction: 8 })), { shortMin: 10, raw: 12, shortRuleAboveScale: true })
  assert.equal(shortMinConviction(momentumShadowConfig({ longMinConviction: 5, shortConvictionMult: 1.5 })).shortMin, 8, '7.5 rounds UP: earn it, do not round into it')
})

test('trailing return skips the most recent bars and refuses a short window', () => {
  const bars = Array.from({ length: 70 }, (_, i) => ({ c: 100 + i }))   // close 100 … 169
  // end = index 69-5 = 64 (close 164), start = 64-60 = 4 (close 104)
  assert.equal(Math.round(trailingReturn(bars, { lookback: 60, skip: 5 }) * 10000) / 10000, Math.round((164 / 104 - 1) * 10000) / 10000)
  assert.equal(trailingReturn(bars, { lookback: 65, skip: 5 }), null, 'window not there → null, not a shorter return under the same name')
  assert.equal(trailingReturn([], { lookback: 1, skip: 0 }), null)
})

test('ranking is a percentile over names WITH a return; ties share the lower rank; conviction follows the side', () => {
  const ranks = rankUniverse({ A: 0.30, B: -0.10, C: 0.05, D: null, E: 0.05 })
  assert.deepEqual(ranks, { B: 0, C: 1 / 3, E: 1 / 3, A: 1 })
  assert.equal('D' in ranks, false)
  assert.deepEqual(rankUniverse({ A: 0.1 }), {}, 'one name is not a cross-section')
  assert.equal(convictionOf(1, 'long'), 10)
  assert.equal(convictionOf(0.85, 'long'), 9)
  assert.equal(convictionOf(0.1, 'short'), 9)
  assert.equal(convictionOf(0.1, 'long'), 1)
})

test('hysteresis: enter in the 20% band, hold through the 40% band, exit past it; refusals name the rule', () => {
  // flat → long needs rank ≥ 0.8 AND conviction ≥ 6 (rank 0.8 → 8: fine)
  assert.equal(stepHysteresis('flat', 0.85, cfg).action, 'enter')
  assert.equal(stepHysteresis('flat', 0.85, cfg).side, 'long')
  assert.equal(stepHysteresis('flat', 0.79, cfg).action, 'none')
  // long holds down to 0.6, exits below it
  assert.equal(stepHysteresis('long', 0.65, cfg).action, 'hold')
  assert.equal(stepHysteresis('long', 0.59, cfg).action, 'exit')
  assert.equal(stepHysteresis('long', 0.59, cfg).next, 'flat')
  // shorts: rank ≤ 0.2 gives conviction 8–10; the floor is 9, so 0.2 (→8) is REFUSED and 0.1 (→9) enters
  const refused = stepHysteresis('flat', 0.2, cfg)
  assert.equal(refused.action, 'refused')
  assert.match(refused.reason, /^short_rule: conviction 8 < 9/)
  assert.equal(stepHysteresis('flat', 0.1, cfg).action, 'enter')
  assert.equal(stepHysteresis('flat', 0.1, cfg).side, 'short')
  // a long at the same distance from the edge is NOT refused: that asymmetry is the rule
  assert.equal(stepHysteresis('flat', 0.8, cfg).action, 'enter')
  // short holds up to 0.4, exits above
  assert.equal(stepHysteresis('short', 0.4, cfg).action, 'hold')
  assert.equal(stepHysteresis('short', 0.41, cfg).action, 'exit')
  // terminal states never regress into the other side in one step
  assert.equal(stepHysteresis('long', 0.05, cfg).next, 'flat')
})

test('applyPass: enters, holds, exits with the signed shadow return; a name without a rank is left alone', () => {
  const t0 = 1_000_000
  let s = { holdings: {}, lastRunMs: 0 }
  let out = applyPass(s, { ranks: { A: 1, B: 0.05, C: 0.5 }, prices: { A: 100, B: 50, C: 10 }, cfg, now: t0 })
  assert.deepEqual(Object.keys(out.state.holdings).sort(), ['A', 'B'])
  assert.deepEqual(out.rows.map(r => [r.symbol, r.action, r.side]), [['A', 'enter', 'long'], ['B', 'enter', 'short']])
  // next pass: A slips to 0.7 (hold), B rallies to 0.5 (exit, short return = entry/price − 1), C absent from ranks
  out = applyPass(out.state, { ranks: { A: 0.7, B: 0.5 }, prices: { A: 110, B: 55 }, cfg, now: t0 + 3_600_000 })
  assert.deepEqual(Object.keys(out.state.holdings), ['A'])
  assert.equal(out.rows.length, 1)
  assert.equal(out.rows[0].action, 'exit')
  assert.equal(out.rows[0].side, 'short')
  assert.equal(out.rows[0].ret_pct, Math.round((50 / 55 - 1) * 10000) / 10000)
  assert.equal(out.rows[0].hold_ms, 3_600_000)
  // a held name that drops out of the ranked set is kept, silently
  out = applyPass(out.state, { ranks: { B: 0.5 }, prices: { B: 55 }, cfg, now: t0 + 2 * 3_600_000 })
  assert.deepEqual(Object.keys(out.state.holdings), ['A'])
  assert.equal(out.rows.length, 0)
  // a refusal is logged once while it persists, again only after it clears
  out = applyPass(out.state, { ranks: { A: 0.7, D: 0.2 }, prices: { A: 110, D: 5 }, cfg, now: t0 + 3 * 3_600_000 })
  assert.deepEqual(out.rows.map(r => r.action), ['refused'])
  assert.equal(out.state.refused.D, 'short')
  out = applyPass(out.state, { ranks: { A: 0.7, D: 0.2 }, prices: { A: 110, D: 5 }, cfg, now: t0 + 4 * 3_600_000 })
  assert.equal(out.rows.length, 0)
  out = applyPass(out.state, { ranks: { A: 0.7, D: 0.5 }, prices: { A: 110, D: 5 }, cfg, now: t0 + 5 * 3_600_000 })
  assert.equal('D' in out.state.refused, false)
  out = applyPass(out.state, { ranks: { A: 0.7, D: 0.2 }, prices: { A: 110, D: 5 }, cfg, now: t0 + 6 * 3_600_000 })
  assert.equal(out.rows.length, 1)
})

function universe(n, seed = 1) {
  // n symbols with distinct trailing returns: symbol S<i> trends by i%
  const syms = Array.from({ length: n }, (_, i) => `S${i}`)
  const symbolMap = Object.fromEntries(syms.map((s, i) => [s, 1000 + i]))
  const bars = async (sym) => {
    const i = Number(sym.slice(1))
    return Array.from({ length: 70 }, (_, k) => ({ c: 100 * (1 + (i - n / 2) / 100) ** (k / 70) * seed }))
  }
  return { syms, symbolMap, bars }
}

test('runMomentumShadow: disabled writes nothing; enabled writes momentum_shadow rows with applied=0 and NO trade, order or risk row', async () => {
  const db = initDB(':memory:')
  const { syms, symbolMap, bars } = universe(20)
  let r = await runMomentumShadow(db, { symbols: syms, symbolMap, bars })
  assert.deepEqual(r, { ran: false, why: 'disabled' })
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM momentum_shadow`).get().n, 0)

  setState(db, MOMENTUM_SHADOW_CONFIG_KEY, JSON.stringify({ enabled: true }))
  const count = () => ['trades', 'pending_orders', 'risk_events', 'monitored_positions', 'position_events', 'decision_log']
    .map(t => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n)
  const before = count()
  r = await runMomentumShadow(db, { symbols: syms, symbolMap, bars, now: 5_000_000, loopId: 7 })
  assert.equal(r.ran, true)
  assert.equal(r.ranked, 20)
  assert.ok(r.rows > 0)
  assert.deepEqual(count(), before, 'nothing but the shadow table moved')
  const rows = db.prepare(`SELECT * FROM momentum_shadow ORDER BY id`).all()
  assert.equal(rows.length, r.rows)
  assert.ok(rows.every(x => x.applied === 0), 'applied=0 on every row')
  assert.ok(rows.every(x => x.loop_id === 7 && x.universe === 20 && x.timeframe === '1d'))
  const enters = rows.filter(x => x.action === 'enter')
  // top 20% of 20 = 4 longs; bottom 20% = 4 candidates but the short rule (floor 9) admits only ranks ≤ ~0.1
  assert.equal(enters.filter(x => x.side === 'long').length, 4)
  assert.ok(enters.filter(x => x.side === 'short').length < 4, 'the short rule refused part of the bottom band')
  assert.ok(rows.some(x => x.action === 'refused' && /short_rule/.test(x.reason)))
  const st = JSON.parse(getState(db, MOMENTUM_SHADOW_STATE_KEY))
  assert.equal(Object.keys(st.holdings).length, enters.length)
  assert.equal(st.lastRunMs, 5_000_000)
  // the interval throttles the next pass; force runs it
  assert.deepEqual(await runMomentumShadow(db, { symbols: syms, symbolMap, bars, now: 5_000_000 + 60_000 }), { ran: false, why: 'interval' })
  const again = await runMomentumShadow(db, { symbols: syms, symbolMap, bars, now: 5_000_000 + 60_000, force: true })
  assert.equal(again.ran, true)
  assert.equal(again.rows, 0, 'same ranks → holds only, and a persisting refusal is not logged twice')
})

test('a universe under minUniverse records the pass and decides nothing', async () => {
  const db = initDB(':memory:')
  setState(db, MOMENTUM_SHADOW_CONFIG_KEY, JSON.stringify({ enabled: true, minUniverse: 8 }))
  const { syms, symbolMap, bars } = universe(5)
  const r = await runMomentumShadow(db, { symbols: syms, symbolMap, bars, now: 9_000 })
  assert.equal(r.ran, true)
  assert.equal(r.rows, 0)
  assert.match(r.why, /universe 5 < minUniverse 8/)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM momentum_shadow`).get().n, 0)
  assert.equal(JSON.parse(getState(db, MOMENTUM_SHADOW_STATE_KEY)).lastRunMs, 9_000)
})

test('the report reads the shadow book and per-side outcomes, and says it is a shadow', async () => {
  const db = initDB(':memory:')
  setState(db, MOMENTUM_SHADOW_CONFIG_KEY, JSON.stringify({ enabled: true }))
  const { syms, symbolMap, bars } = universe(20)
  const now = Date.now() - 3_600_000
  await runMomentumShadow(db, { symbols: syms, symbolMap, bars, now })
  // second pass with the ranking inverted: every holding exits
  const inverted = async (sym) => { const b = await bars(sym); return b.slice().reverse() }
  await runMomentumShadow(db, { symbols: syms, symbolMap, bars: inverted, now: now + 3_600_000, force: true })
  const rep = momentumShadowReport(db, { days: 1 })
  assert.equal(rep.reportOnly, true)
  assert.equal(rep.shadow, true)
  assert.equal(rep.shortMinConviction, 9)
  // 4 longs from pass one. The inverted pass exits them; of the four former
  // bottom names now ranked top, three were held SHORT and only exit this
  // pass (no same-pass flip), so exactly one new long enters: 4 + 1.
  assert.equal(rep.long.entries, 5)
  assert.equal(rep.long.exits, 4)
  assert.equal(rep.short.entries, 3, 'ranks 0, 0.053, 0.105 clear the short floor of 9; 0.158 (→8) is refused')
  assert.equal(rep.short.exits, 3)
  assert.equal(typeof rep.long.winRate, 'number')
  assert.ok(rep.refusedBy.short_rule > 0)
  assert.match(rep.writes, /applied=0/)
  assert.equal(Object.keys(rep.holdings).length >= 0, true)
})

test('source pin: no gate, dispatch, loop or strategy import; only the shadow table is written', () => {
  const src = readFileSync(new URL('./momentum-shadow.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  const imports = [...src.matchAll(/(?:from|import\()\s*'([^']+)'/g)].map(m => m[1])
  // PR-D: the short rule is imported from direction-policy.js (pure; no gate, no dispatch) — one rule, two consumers.
  assert.deepEqual([...new Set(imports)].sort(), ['../db.js', './direction-policy.js', './fib-strategy.js'])
  assert.ok(!/evaluateTrade|autoTrade|dispatchSymbolSignal|placeOrder|persistRiskEvent/.test(src))
  const inserts = [...src.matchAll(/INSERT INTO (\w+)/g)].map(m => m[1])
  assert.deepEqual(inserts, ['momentum_shadow'])
  assert.ok(!/\bUPDATE\b|\bDELETE\b/.test(src))
})

test('wiring pins: the loop runs the shadow after the scan, the state route and the settings routes exist once', () => {
  const loop = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  assert.equal((loop.match(/import\('\.\/services\/momentum-shadow\.js'\)/g) || []).length, 1)
  // §7,386·D1: the shadow ranks the momentum universe AHEAD of the scan's own
  // symbols (breadth is the fuel), so the call takes the unioned list.
  assert.ok(loop.includes('runMomentumShadow(db, { symbols: shadowSymbols, symbolMap, creds: ctraderCreds, loopId: loopCount })'))
  assert.match(loop, /const shadowSymbols = \[\.\.\.new Set\(\[\.\.\.momentumUniverseSymbols\(db\), /, 'the universe must come first in the union')
  const state = readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8')
  assert.equal((state.match(/router\.get\('\/momentum-shadow'/g) || []).length, 1)
  const actions = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8')
  assert.equal((actions.match(/router\.get\('\/momentum-shadow'/g) || []).length, 1)
  assert.equal((actions.match(/router\.post\('\/momentum-shadow'/g) || []).length, 1)
  assert.ok(actions.includes("setState(db, MOMENTUM_SHADOW_CONFIG_KEY"))
})
