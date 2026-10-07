// node --test agent/services/guardian.test.js
//
// Tick guardian: the pure wake decision and the watched-symbol resolution.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  significantMove, watchedSymbolIds, watchlistSymbolIds,
  flagScanPriority, takeScanPrioritySymbols, startGuardian, trailSetDigest,
} from './guardian.js'

test('significantMove: percentage threshold, bad inputs never wake', () => {
  assert.equal(significantMove(100, 100.06, 0.05), true)   // 0.06% ≥ 0.05%
  assert.equal(significantMove(100, 100.04, 0.05), false)  // 0.04% < 0.05%
  assert.equal(significantMove(100, 99.94, 0.05), true)    // moves down count too
  assert.equal(significantMove(null, 100, 0.05), false)
  assert.equal(significantMove(100, NaN, 0.05), false)
  assert.equal(significantMove(0, 100, 0.05), false)
})

test('watchedSymbolIds: active positions with a known id map, sorted, deduped', () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ NATGAS: 2280, EURUSD: 1, MYSTERY: null }))
  const ins = db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, status) VALUES (?, 'BUY', 1, ?)`)
  ins.run('NatGas', 'active')
  ins.run('NATGAS', 'active')   // dedupe across case
  ins.run('EURUSD', 'active')
  ins.run('GBPUSD', 'closed')   // closed → not watched
  ins.run('MYSTERY', 'active')  // no symbolId → skipped, never guessed
  const w = watchedSymbolIds(db)
  assert.deepEqual(w, [
    { symbol: 'EURUSD', symbolId: 1 },
    { symbol: 'NATGAS', symbolId: 2280 },
  ])
})

// ---- watchlist-wide spike-priority (owner, 2026-07-26: "when market
// volume spike, check immediately") --------------------------------------

test('watchlistSymbolIds: enabled symbols with a known id, disabled/force_skip/string-shorthand handled', () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, GBPUSD: 2, XAUUSD: 3, NOMAP: undefined }))
  setState(db, 'autopilot_symbols_json', JSON.stringify([
    'EURUSD',                                   // string shorthand → enabled
    { symbol: 'GBPUSD', enabled: true },
    { symbol: 'XAUUSD', enabled: false },        // disabled → excluded
    { symbol: 'NOMAP' },                         // no symbolId → excluded
  ]))
  assert.deepEqual(watchlistSymbolIds(db), [
    { symbol: 'EURUSD', symbolId: 1 },
    { symbol: 'GBPUSD', symbolId: 2 },
  ])
})

test('watchlistSymbolIds: force_skip excluded, falls back to legacy watchlist_json when autopilot key is absent', () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, USDJPY: 2 }))
  setState(db, 'watchlist_json', JSON.stringify([
    { symbol: 'EURUSD' },
    { symbol: 'USDJPY', force_skip: true },
  ]))
  assert.deepEqual(watchlistSymbolIds(db), [{ symbol: 'EURUSD', symbolId: 1 }])
})

test('watchlistSymbolIds: missing/malformed state never throws, returns empty', () => {
  const db = initDB(':memory:')
  assert.deepEqual(watchlistSymbolIds(db), [])
  setState(db, 'autopilot_symbols_json', 'not json')
  assert.deepEqual(watchlistSymbolIds(db), [])
})

test('flagScanPriority + takeScanPrioritySymbols: round-trips, and consumption clears the flag', () => {
  const db = initDB(':memory:')
  flagScanPriority(db, 'eurusd')
  flagScanPriority(db, 'XAUUSD')
  const first = takeScanPrioritySymbols(db).sort()
  assert.deepEqual(first, ['EURUSD', 'XAUUSD'], 'case-normalized')
  assert.deepEqual(takeScanPrioritySymbols(db), [], 'consumed once — cleared after the first read')
})

test('takeScanPrioritySymbols: expires stale flags past the ttl', () => {
  const db = initDB(':memory:')
  flagScanPriority(db, 'EURUSD')
  // ttl=0 → the flag set "now" is already outside a zero-width window
  assert.deepEqual(takeScanPrioritySymbols(db, 0), [])
})

test('takeScanPrioritySymbols: never throws on a closed db handle', () => {
  const db = initDB(':memory:')
  db.close()
  assert.doesNotThrow(() => flagScanPriority(db, 'EURUSD'))
  assert.deepEqual(takeScanPrioritySymbols(db), [])
})

// ---- every account, one push per side; the backstop sweep (07-10-2026,
// Claude · № 11,596·D·1, ordered № 11,583·D·1) ------------------------------

async function until(pred, ms = 2000) {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(pred(), 'condition not reached in time')
}

function sweepFixture(t, { backstopMs, keeperThrowsFor = null, keeperIncompleteFor = null, symbolMap = { NATGAS: 2280 }, trailPushMinMs = 0, pushOk = () => true, specVersion = { n: 0 } } = {}) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  setState(db, 'symbol_id_map', JSON.stringify(symbolMap))
  db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, status) VALUES ('NATGAS', 'BUY', 1, 'active')`).run()
  const creds = {
    1: { ready: true, accountId: '1', isLive: false },
    2: { ready: true, accountId: '2', isLive: false },
    3: { ready: true, accountId: '3', isLive: true },
    4: { ready: false, accountId: '4', isLive: true }, // no credentials → skipped, never guessed
  }
  const guards = [], keeper = [], pushes = []
  let onTick = null
  const stop = startGuardian(db, () => creds[1], {
    maintMs: 5, cooldownMs: 0, firstAttachMs: 1, backstopMs, trailPushMinMs,
    streamSpots: async (...args) => { onTick = args[6]; return { close() {} } },
    accountRegistry: { getEnabledAccounts: () => [{ account_id: '3' }, { account_id: '1' }, { account_id: '2' }, { account_id: '4' }] },
    credsLib: { credsForRegisteredAccount: (_db, id) => creds[id] ?? null },
    tradeGuard: { runTradeGuards: async (_db, c) => { guards.push(c.accountId); return { slMoves: 0 } } },
    profitKeeper: {
      runProfitKeeper: async (_db, c, d) => {
        keeper.push({ id: c.accountId, deferred: d?.deferTrailPush === true })
        if (c.accountId === keeperThrowsFor) throw new Error(`broker down for …000${c.accountId}`)
        // Codex P1 on #1245: the real keeper never throws; it returns an incomplete list.
        if (c.accountId === keeperIncompleteFor) return { slMoves: 0, errors: ['NATGAS: price fetch failed'], trailSpecs: [], trailSpecsComplete: false }
        return { slMoves: 0, trailSpecs: [{ positionId: Number(c.accountId) * 100 + specVersion.n, ctidTraderAccountId: Number(c.accountId) }] }
      },
    },
    exec: { pushTrailConfig: async (c, specs) => { pushes.push({ side: c.isLive ? 'live' : 'demo', account: c.accountId, specs }); return pushOk(pushes.length) } },
  })
  t.after(stop)
  return { db, guards, keeper, pushes, tick: () => onTick, stop }
}

test('sweep: every enabled registered account on both sides; a failed pass withholds its side\'s push, the other side still goes', async t => {
  // backstopMs huge → only the tick below can fire the sweep after the boot pass.
  const f = sweepFixture(t, { backstopMs: 10 * 60_000, keeperThrowsFor: '2' })
  await until(() => typeof f.tick() === 'function')
  await until(() => f.pushes.length >= 1) // the boot backstop (lastSweepAt starts at 0): the live side only
  await new Promise(resolve => setTimeout(resolve, 20)) // let the boot sweep release its single-flight
  const bootGuards = f.guards.length
  f.tick()({ symbolId: 2280, bid: 100, ask: 100 })
  f.tick()({ symbolId: 2280, bid: 101, ask: 101 }) // +1% → significant
  await until(() => f.pushes.length >= 2)
  assert.deepEqual(f.guards.slice(bootGuards), ['1', '3', '2'], 'the stream account first, then the registry order; …0004 (not ready) skipped')
  assert.deepEqual(f.keeper.slice(bootGuards).map(k => k.id), ['1', '3', '2'])
  assert.ok(f.keeper.every(k => k.deferred), 'every keeper pass defers its push to the sweep')
  // Codex P1 on #1243: …0002 threw, so the demo union is INCOMPLETE and is
  // withheld (a full replace without its specs would wipe its trails); the
  // live side, complete, is pushed every sweep.
  assert.ok(f.pushes.every(p => p.side === 'live'), `no demo push while a demo pass fails: ${JSON.stringify(f.pushes.map(p => p.side))}`)
  assert.deepEqual(f.pushes.map(p => p.specs.map(s => s.positionId)), [[300], [300]], 'one live push per sweep (boot + tick), never one per account')
})

test('backstop: with something held, the sweep runs on its own at least every backstopMs', async t => {
  const f = sweepFixture(t, { backstopMs: 20 })
  await until(() => f.keeper.filter(k => k.id === '1').length >= 3, 1500)
  assert.ok(f.pushes.length >= 4, `pushes accompany every sweep (${f.pushes.length})`)
})

test('backstop: beyond the boot pass, no sweep without a tick when backstopMs is far away', async t => {
  const f = sweepFixture(t, { backstopMs: 10 * 60_000 })
  await until(() => f.pushes.length >= 2)
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(f.keeper.length, 3, 'exactly the boot sweep (three accounts), nothing more')
  const demo = f.pushes.find(p => p.side === 'demo'), live = f.pushes.find(p => p.side === 'live')
  assert.deepEqual(demo.specs.map(s => s.positionId), [100, 200], 'the demo union carries BOTH demo accounts, not the last one to pass')
  assert.equal(demo.account, '1', 'the demo union rides the first demo credentials')
  assert.deepEqual(live.specs.map(s => s.positionId), [300])
})

test('backstop: gated on active rows, not on the symbol map (Codex P1 on #1243)', async t => {
  // No symbol id for the held symbol → no stream, no tick can ever fire; the
  // position is still active, so the backstop must still sweep it.
  const f = sweepFixture(t, { backstopMs: 20, symbolMap: {} })
  await until(() => f.keeper.length >= 3, 1500)
  assert.equal(f.tick(), null, 'no stream was opened (nothing to subscribe)')
  assert.deepEqual(f.keeper.slice(0, 3).map(k => k.id), ['1', '3', '2'])
})

test('sweep: a keeper pass that RETURNS an incomplete spec list withholds its side\'s push, like one that throws (Codex P1 on #1245)', async t => {
  const f = sweepFixture(t, { backstopMs: 20, keeperIncompleteFor: '2' })
  await until(() => f.keeper.filter(k => k.id === '2').length >= 2, 1500)
  assert.ok(f.pushes.length >= 1, 'the live side still pushes')
  assert.ok(f.pushes.every(p => p.side === 'live'), `the demo side is withheld while …0002 returns an incomplete list: ${JSON.stringify(f.pushes.map(p => p.side))}`)
})

// ---- the push cadence cap (Claude · № 11,760 07-Oct, ordered ¶11,758·C·1):
// the sweep runs every pass; the engine is told a side's union only when it
// changed or when trailPushMinMs has passed. ----------------------------------

test('trailSetDigest: the set, distance, digits, direction, symbol, target and entry count; currentSl and peakPrice do not; order does not', () => {
  const a = { positionId: 1, ctidTraderAccountId: 9, symbolId: 2, dir: 1, trailDistance: 0.5, digits: 5, currentTp: 1.2, entryPrice: 1.0, currentSl: 0.9, peakPrice: 1.1 }
  const b = { ...a, positionId: 2 }
  assert.equal(trailSetDigest([a, b]), trailSetDigest([b, a]), 'order-independent')
  assert.equal(trailSetDigest([{ ...a, currentSl: 0.95, peakPrice: 1.15 }]), trailSetDigest([a]), 'the engine keeps its own stop and peak: not part of the digest')
  assert.notEqual(trailSetDigest([{ ...a, trailDistance: 0.6 }]), trailSetDigest([a]), 'a new distance is a new config')
  assert.notEqual(trailSetDigest([a, b]), trailSetDigest([a]), 'a position leaving the set is a new config (full replace must drop it)')
  assert.equal(trailSetDigest([]), '', 'the empty set has a digest too (an empty push clears the engine)')
})

test('push cadence: an unchanged union is pushed once within trailPushMinMs while the sweeps keep running', async t => {
  const f = sweepFixture(t, { backstopMs: 20, trailPushMinMs: 10_000 })
  await until(() => f.keeper.filter(k => k.id === '1').length >= 4, 2000)
  assert.equal(f.pushes.filter(p => p.side === 'demo').length, 1, `one demo push for four sweeps: ${JSON.stringify(f.pushes.map(p => p.side))}`)
  assert.equal(f.pushes.filter(p => p.side === 'live').length, 1)
})

test('push cadence: a changed union is pushed at once, inside the interval', async t => {
  const specVersion = { n: 0 }
  const f = sweepFixture(t, { backstopMs: 20, trailPushMinMs: 10_000, specVersion })
  await until(() => f.keeper.filter(k => k.id === '1').length >= 2, 2000)
  assert.equal(f.pushes.filter(p => p.side === 'demo').length, 1)
  specVersion.n = 1 // a different position set on every account
  await until(() => f.pushes.filter(p => p.side === 'demo').length >= 2, 2000)
  const last = f.pushes.filter(p => p.side === 'demo').at(-1)
  assert.deepEqual(last.specs.map(s => s.positionId), [101, 201], 'the new set went out')
})

test('push cadence: a refused push is retried on the next sweep, inside the interval', async t => {
  // trailPushMinMs far away: only a RETRY can produce the refused side's second push.
  const f = sweepFixture(t, { backstopMs: 20, trailPushMinMs: 10_000, pushOk: (n) => n !== 1 })
  await until(() => f.pushes.length >= 3, 2000) // boot: 2 pushes (the first refused) → the refused side goes again on the next sweep
  const first = f.pushes[0].side
  assert.equal(f.pushes.filter(p => p.side === first).length, 2, `the refused ${first} push was retried: ${JSON.stringify(f.pushes.map(p => p.side))}`)
  assert.equal(f.pushes.filter(p => p.side !== first).length, 1, 'the accepted side was not re-pushed')
})

test('push cadence: after trailPushMinMs the unchanged union is pushed again (a bounded refresh)', async t => {
  const f = sweepFixture(t, { backstopMs: 20, trailPushMinMs: 150 })
  await until(() => f.pushes.filter(p => p.side === 'demo').length >= 2, 2000)
  const demo = f.pushes.filter(p => p.side === 'demo')
  assert.ok(demo.length >= 2 && demo.length <= 4, `one refresh per interval, not per sweep: ${demo.length} demo pushes`)
})
