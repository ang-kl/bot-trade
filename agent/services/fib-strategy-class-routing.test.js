// Claude · № 15,144 16-Oct (owner: "C·2 Policy, build class-aware routing"
// after § 15,128; claude-builder). node --test agent/services/fib-strategy-class-routing.test.js
//
// Class-aware routing at signal selection, through the real scanSymbolFib and
// runFibScan with a stub broker (the module's fetcher seam) and stand-in
// strategies. Expected outcomes: the policy tokens are the owner's choices;
// which candidate survives and where it is recorded is this change's own
// contract (self-derived), pinned here so the dispatcher can never see a
// routed candidate and the record can never lose one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { scanSymbolFib, runFibScan, _setTrendbarFetcherForTests, _resetBarCacheForTests } from './fib-strategy.js'
import { compilePolicy } from '../lib/class-routing.js'
import { _resetBarPathCountersForTests } from '../lib/bar-path-counters.js'
import { rankHotSymbols } from './signal-ranking.js'
import { fairShareSlots } from './analyze-fair-share.js'
import { groupAgreement } from './cluster-conviction.js'

const H = 3_600_000
const CREDS = { host: 'demo.example.com', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '46130058' }
const MS = { '1mo': 30 * 86_400_000, '1w': 7 * 86_400_000, '1d': 86_400_000, '4h': 4 * H, '1h': H, '30m': H / 2, '15m': H / 4, '5m': H / 12 }

function bars(n, ms, lastOpen) {
  const out = []
  for (let i = n - 1; i >= 0; i--) { const t = lastOpen - i * ms; const c = 100 + Math.sin(t / ms) * 2; out.push({ t, o: c, h: c + 1, l: c - 1, c, v: 10 }) }
  return out
}
function stubBroker() {
  return async (_h, _c, _s, _t, _a, _symbolId, periods, count) => {
    const now = Date.now(), out = {}
    for (const p of periods) out[p] = bars(count, MS[p], Math.floor(now / MS[p]) * MS[p])
    return out
  }
}
/** A strategy stand-in: a candidate of `bias` on 1h and 4h with the given conviction. */
function strategy(key, bias, conviction) {
  const compute = (b, tf) => (['1h', '4h'].includes(tf) && b.length
    ? { strategy: key, bias, timeframe: tf, entry: b.at(-1).c, sl: bias === 'long' ? b.at(-1).c - 2 : b.at(-1).c + 2, tp1: bias === 'long' ? b.at(-1).c + 6 : b.at(-1).c - 6, conviction, thesis: `${key} ${bias} on ${tf}` }
    : null)
  compute.minBars = 50
  return { key, compute, minBars: 50 }
}
const POLICY = compilePolicy({
  scanShare: { prioritySlots: 2, priorityMaxRank: 3 },
  classes: { energy: { priority: 5, block: ['va_breakout:long'] }, fx: { priority: 2 } },
  symbols: { NATGAS: { block: ['*:long'] } },
})
const classOf = (sym) => ({ cls: ['NATGAS', 'SPOTCRUDE'].includes(String(sym).toUpperCase()) ? 'energy' : 'fx', source: 'test' })
const STRATS = [strategy('va_breakout', 'long', 8), strategy('donchian_breakout', 'long', 6), strategy('rsi2_reversion', 'short', 5)]

function fresh(t) {
  _resetBarCacheForTests(); _resetBarPathCountersForTests()
  _setTrendbarFetcherForTests(stubBroker())
  t.after(() => { _setTrendbarFetcherForTests(null); _resetBarCacheForTests(); _resetBarPathCountersForTests() })
}

test('scanSymbolFib: a class token removes the (strategy, side) from `signals`; the record keeps it with the token; the winner is chosen among the survivors', async (t) => {
  fresh(t)
  const crude = await scanSymbolFib(CREDS, 'SPOTCRUDE', 11, { strategies: STRATS, classRouting: POLICY, classOf })
  assert.deepEqual(crude.signals.map(s => s.strategy).sort(), ['donchian_breakout', 'rsi2_reversion'])
  assert.equal(crude.signal.strategy, 'donchian_breakout', 'the strongest SURVIVOR wins, not the routed va_breakout')
  assert.equal(crude.routedOut.length, 1)
  assert.deepEqual({ strategy: crude.routedOut[0].strategy, bias: crude.routedOut[0].bias, token: crude.routedOut[0].token, cls: crude.routedOut[0].cls, classSource: crude.routedOut[0].classSource },
    { strategy: 'va_breakout', bias: 'long', token: 'va_breakout:long', cls: 'energy', classSource: 'test' })
  assert.match(crude.routedOut[0].reason, /routed out of class energy/)
  assert.deepEqual(crude.assetClass, { cls: 'energy', source: 'test' })
  // The same bars on an fx symbol: nothing routed, va_breakout wins on conviction.
  const eur = await scanSymbolFib(CREDS, 'EURUSD', 12, { strategies: STRATS, classRouting: POLICY, classOf })
  assert.equal(eur.signals.length, 3); assert.deepEqual(eur.routedOut, []); assert.equal(eur.signal.strategy, 'va_breakout')
  // A symbol token with a side: every long is out, the short stays.
  const gas = await scanSymbolFib(CREDS, 'NATGAS', 13, { strategies: STRATS, classRouting: POLICY, classOf })
  assert.deepEqual(gas.signals.map(s => s.strategy), ['rsi2_reversion'])
  assert.deepEqual(gas.routedOut.map(r => [r.strategy, r.token]).sort(), [['donchian_breakout', '*:long'], ['va_breakout', '*:long']])
  assert.equal(gas.signal.strategy, 'rsi2_reversion')
})

test('scanSymbolFib: an ARMED routed strategy stays routed (routing precedes the armed-beats-unarmed rule); routing off restores the old answer', async (t) => {
  fresh(t)
  const armed = await scanSymbolFib(CREDS, 'SPOTCRUDE', 21, { strategies: STRATS, classRouting: POLICY, classOf, armedStrategyKeys: ['va_breakout'] })
  assert.equal(armed.signal.strategy, 'donchian_breakout')
  assert.ok(!armed.signals.some(s => s.strategy === 'va_breakout'))
  const off = await scanSymbolFib(CREDS, 'SPOTCRUDE', 22, { strategies: STRATS, classRouting: null, classOf })
  assert.equal(off.signals.length, 3); assert.deepEqual(off.routedOut, []); assert.equal(off.signal.strategy, 'va_breakout')
  const offArmed = await scanSymbolFib(CREDS, 'SPOTCRUDE', 23, { strategies: STRATS, classRouting: null, classOf, armedStrategyKeys: ['donchian_breakout'] })
  assert.equal(offArmed.signal.strategy, 'donchian_breakout', 'the unchanged armed rule')
})

test('runFibScan: routed candidates are rows with trade_grade routed, out of hot/warm/signals/signalsByStrategy; the desk note and the result count them; the tiers ride the rotation', async (t) => {
  fresh(t)
  const symbols = [{ symbol: 'NATGAS' }, { symbol: 'EURUSD' }, { symbol: 'SPOTCRUDE' }]
  const symbolMap = { NATGAS: 31, EURUSD: 32, SPOTCRUDE: 33 }
  const r = await runFibScan(CREDS, symbolMap, symbols, { strategies: STRATS, classRouting: POLICY, classOf, cursor: 0, batchSize: 15 })
  const gasRows = r.scans.filter(s => s.symbol === 'NATGAS')
  const routed = gasRows.filter(s => s.trade_grade === 'routed')
  assert.equal(routed.length, 2)
  assert.deepEqual(routed.map(x => x.strategy).sort(), ['donchian_breakout', 'va_breakout'])
  assert.match(routed[0].thesis, /^ROUTED OUT \(class energy\): (va_breakout|donchian_breakout) long — .*token "\*:long"/)
  // Effective bias 'skip' (Codex round 1): consumers that test bias alone never see a routed row as a setup; the side is kept for the record.
  assert.equal(routed[0].bias, 'skip'); assert.equal(routed[0].routed_bias, 'long'); assert.equal(routed[0].routed_token, '*:long'); assert.equal(routed[0].asset_class, 'energy')
  assert.ok(r.scans.filter(s => s.trade_grade === 'routed').every(s => s.bias === 'skip'), 'every routed row reads skip to bias-only consumers')
  assert.ok(gasRows.some(s => s.strategy === 'rsi2_reversion' && s.trade_grade !== 'routed'), 'the short survived as an ordinary row')
  assert.equal(r.signals.NATGAS.strategy, 'rsi2_reversion')
  assert.deepEqual(Object.keys(r.signalsByStrategy.NATGAS), ['rsi2_reversion'], 'the dispatcher never sees a routed candidate')
  const crudeRouted = r.scans.filter(s => s.symbol === 'SPOTCRUDE' && s.trade_grade === 'routed')
  assert.equal(crudeRouted.length, 1); assert.equal(crudeRouted[0].routed_token, 'va_breakout:long')
  // hot/warm: NATGAS's 8-conviction va_breakout is routed, so NATGAS is NOT hot (its survivor scores 5 → warm); EURUSD is hot.
  assert.ok(r.hot.includes('EURUSD')); assert.ok(!r.hot.includes('NATGAS')); assert.ok(r.warm.includes('NATGAS'))
  assert.ok(r.hot.includes('SPOTCRUDE'), 'SPOTCRUDE\'s surviving donchian (6) is still hot')
  assert.equal(r.routing.routedOut, 3); assert.equal(r.routing.enabled, true)
  assert.match(r.desk_note, /3 routed out by class/)
  assert.match(r.desk_note, /\[tiers A 1\/2 slots ~1 runs, B 2\/13 slots ~1 runs\]/)
  assert.deepEqual({ tierA: r.routing.tiers.tierA, tierB: r.routing.tiers.tierB }, { tierA: 1, tierB: 2 })
  assert.equal(r.next_cursor, 1, 'the run counter under the share')
  assert.equal(r.coverage.scanned, 3)
})

test('runFibScan with routing off: no routed rows, the legacy cursor, no tiers', async (t) => {
  fresh(t)
  const symbols = [{ symbol: 'NATGAS' }, { symbol: 'EURUSD' }]
  const r = await runFibScan(CREDS, { NATGAS: 41, EURUSD: 42 }, symbols, { strategies: STRATS, classRouting: null, classOf, cursor: 0, batchSize: 15 })
  assert.equal(r.scans.filter(s => s.trade_grade === 'routed').length, 0)
  assert.ok(r.hot.includes('NATGAS'))
  assert.equal(r.signals.NATGAS.strategy, 'va_breakout')
  assert.deepEqual(r.routing, { enabled: false, routedOut: 0, tiers: null })
  assert.doesNotMatch(r.desk_note, /routed out|tiers/)
  assert.equal(r.next_cursor, 0, 'legacy: (0 + 2) % 2')
})

test('mixed candidates end to end (Codex round 2 on #1390): the downstream consumers read exactly what they would read with the routed rows absent', async (t) => {
  fresh(t)
  const symbols = [{ symbol: 'NATGAS' }, { symbol: 'EURUSD' }, { symbol: 'SPOTCRUDE' }]
  const r = await runFibScan(CREDS, { NATGAS: 51, EURUSD: 52, SPOTCRUDE: 53 }, symbols, { strategies: STRATS, classRouting: POLICY, classOf, cursor: 0, batchSize: 15 })
  // NATGAS: surviving rsi2 short (5) + two routed longs (8, 6); SPOTCRUDE: surviving donchian long (6) + rsi2 short (5) + routed va_breakout long (8).
  assert.equal(r.scans.filter(s => s.trade_grade === 'routed').length, 3)
  const withoutRouted = r.scans.filter(s => s.trade_grade !== 'routed')
  const hot = [...r.hot, ...r.warm]
  // THE CONTRACT: a routed row changes nothing downstream — each consumer's
  // answer over the full row set equals its answer over the surviving rows.
  // (Which surviving row a consumer keeps per symbol is its own, unchanged rule.)
  assert.deepEqual(rankHotSymbols(r.scans, hot), rankHotSymbols(withoutRouted, hot))
  assert.equal(rankHotSymbols(r.scans, hot)[0], 'EURUSD', 'EURUSD (8) first; NATGAS is not lifted by its routed 8')
  const opts = { slots: 3, lastAnalyzed: {}, now: 1_000 }
  assert.deepEqual(fairShareSlots(r.scans, hot, opts), fairShareSlots(withoutRouted, hot, opts))
  assert.ok(!fairShareSlots(r.scans, hot, opts).byStrategy.some(b => b.symbol === 'NATGAS' && b.strategy !== 'rsi2_reversion'), 'NATGAS is attributed to its surviving strategy only')
  const group = { key: 'energy', label: 'energy', members: { NATGAS: 1, SPOTCRUDE: 1, EURUSD: 1 } }
  const votes = (rows) => groupAgreement(group, rows.map(sc => ({ symbol: sc.symbol, bias: sc.bias, conviction: sc.confidence })), { minMembers: 3, minRatio: 0.5 })
  const a = votes(r.scans)
  assert.ok(a, 'every member still votes'); assert.equal(a.total, 3)
  assert.deepEqual(a, votes(withoutRouted))
  assert.equal(a.members.find(m => m.symbol === 'NATGAS').bias, 'short', 'NATGAS votes with its surviving short, not the routed skip')
})
