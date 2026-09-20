// node --test agent/services/stage-matrix.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import {
  STAGES, STAGE_LABELS, FILTER_KEYS,
  loadStageMatrix, setStage, scanStageStrategies, backtestStageStrategies,
  scanFilterOptions, tradeStageGate, manageStageAllows,
  stageMatrixStats, stageMatrixView,
} from './stage-matrix.js'
import { STRATEGY_KEYS } from './strategies.js'

const io = { getState, setState }

test('columns are the four agreed stages, in pipeline order', () => {
  assert.deepEqual(STAGES, ['scan', 'backtest', 'trade', 'manage'])
  assert.equal(STAGE_LABELS.trade, 'Auto Trade & Open')
  assert.equal(STAGE_LABELS.manage, 'Live Tweak & Close')
})

test('defaults: scan analyses EVERYTHING, filters gate nothing at scan', () => {
  const db = initDB(':memory:')
  const m = loadStageMatrix(db, getState)
  // every registry strategy scans, backtests and manages by default
  for (const s of m.strategies) {
    assert.equal(s.stages.scan, true, `${s.key} scan default`)
    assert.equal(s.stages.backtest, true, `${s.key} backtest default`)
    assert.equal(s.stages.manage, true, `${s.key} manage default`)
  }
  // trade column mirrors enabledStrategies default (everything except
  // fib_618_fade — owner 2026-07-27)
  assert.deepEqual(
    m.strategies.filter(s => s.stages.trade).map(s => s.key),
    ['cup_handle', 'inv_cup_handle', 'ema_pullback', 'donchian_breakout', 'rsi_meanrev', 'vwap_trend', 'vp_value', 'rsi2_reversion', 'fib_confluence', 'va_breakout']
  )
  // filters: off at scan (analyse all convictions) and backtest; no manage cell.
  for (const f of m.filters) {
    assert.equal(f.stages.scan, false)
    assert.equal(f.stages.backtest, false)
    assert.equal(f.stages.manage, null)
  }
  // RSI confluence is TRADE-armed by default (kill naked fib); the others off.
  assert.equal(m.filters.find(f => f.key === 'rsi').stages.trade, true)
  assert.equal(m.filters.find(f => f.key === 'vwap').stages.trade, false)
  assert.equal(m.filters.find(f => f.key === 'fvg').stages.trade, false)
  assert.deepEqual(m.filters.map(f => f.key), FILTER_KEYS)
})

test('kill-naked-fib: RSI trade defaults ON, but an explicit OFF still wins', () => {
  const db = initDB(':memory:')
  // Unset → RSI confluence trade-armed (no naked fib).
  assert.equal(loadStageMatrix(db, getState).filters.find(f => f.key === 'rsi').stages.trade, true)
  // Owner opts back into naked fib → the stored value wins.
  setState(db, 'fib_rsi_filter', 'false')
  assert.equal(loadStageMatrix(db, getState).filters.find(f => f.key === 'rsi').stages.trade, false)
})

test('trade column derives LIVE from legacy keys — never from stored JSON', () => {
  const db = initDB(':memory:')
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade', 'cup_handle']))
  setState(db, 'fib_rsi_filter', 'true')
  const m = loadStageMatrix(db, getState)
  assert.equal(m.strategies.find(s => s.key === 'cup_handle').stages.trade, true)
  assert.equal(m.filters.find(f => f.key === 'rsi').stages.trade, true)
  // stored matrix JSON must not shadow the legacy keys
  setState(db, 'stage_matrix_json', JSON.stringify({ strategy: { cup_handle: { trade: false } } }))
  const m2 = loadStageMatrix(db, getState)
  assert.equal(m2.strategies.find(s => s.key === 'cup_handle').stages.trade, true)
})

test('setStage trade writes THROUGH to the legacy keys', () => {
  const db = initDB(':memory:')
  // fib_618_fade is off by default (2026-07-27) — arming it merges into the
  // rest of the default-on set, in registry order.
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: true }, io)
  assert.deepEqual(
    JSON.parse(getState(db, 'enabled_strategies_json')),
    ['fib_618_fade', 'cup_handle', 'inv_cup_handle', 'ema_pullback', 'donchian_breakout', 'rsi_meanrev', 'vwap_trend', 'vp_value', 'rsi2_reversion', 'fib_confluence', 'va_breakout']
  )
  setStage(db, { kind: 'strategy', key: 'cup_handle', stage: 'trade', on: true }, io)
  assert.equal(getState(db, 'cup_handle_enabled'), 'true')
  setStage(db, { kind: 'filter', key: 'vwap', stage: 'trade', on: true }, io)
  assert.equal(getState(db, 'fib_vwap_filter'), 'true')
  setStage(db, { kind: 'filter', key: 'vwap', stage: 'trade', on: false }, io)
  assert.equal(getState(db, 'fib_vwap_filter'), 'false')
})

test('setStage scan/backtest/manage persist in stage_matrix_json only', () => {
  const db = initDB(':memory:')
  setStage(db, { kind: 'strategy', key: 'rsi_meanrev', stage: 'scan', on: false }, io)
  setStage(db, { kind: 'filter', key: 'fvg', stage: 'backtest', on: true }, io)
  const m = loadStageMatrix(db, getState)
  assert.equal(m.strategies.find(s => s.key === 'rsi_meanrev').stages.scan, false)
  assert.equal(m.filters.find(f => f.key === 'fvg').stages.backtest, true)
  // legacy keys untouched
  assert.ok(getState(db, 'enabled_strategies_json') == null)
  assert.notEqual(getState(db, 'fib_fvg_filter'), 'true')
})

test('setStage rejects unknown kind/key/stage and filter×manage', () => {
  const db = initDB(':memory:')
  assert.throws(() => setStage(db, { kind: 'strategy', key: 'nope', stage: 'scan', on: true }, io), /unknown strategy/)
  assert.throws(() => setStage(db, { kind: 'filter', key: 'nope', stage: 'scan', on: true }, io), /unknown filter/)
  assert.throws(() => setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'wat', on: true }, io), /unknown stage/)
  assert.throws(() => setStage(db, { kind: 'wat', key: 'fib_618_fade', stage: 'scan', on: true }, io), /unknown kind/)
  assert.throws(() => setStage(db, { kind: 'filter', key: 'rsi', stage: 'manage', on: true }, io), /no such|no Live Tweak/)
})

test('scanStageStrategies is wide by default and honours scan cells', () => {
  const db = initDB(':memory:')
  assert.deepEqual(scanStageStrategies(db, getState).map(s => s.key), STRATEGY_KEYS)
  setStage(db, { kind: 'strategy', key: 'donchian_breakout', stage: 'scan', on: false }, io)
  assert.equal(scanStageStrategies(db, getState).some(s => s.key === 'donchian_breakout'), false)
})

test('backtestStageStrategies honours backtest cells', () => {
  const db = initDB(':memory:')
  setStage(db, { kind: 'strategy', key: 'cup_handle', stage: 'backtest', on: false }, io)
  const keys = backtestStageStrategies(db, getState).map(s => s.key)
  assert.equal(keys.includes('cup_handle'), false)
  assert.equal(keys.includes('fib_618_fade'), true)
})

test('scanFilterOptions: strict when scan-armed, annotate when only trade-armed, null when off', () => {
  const db = initDB(':memory:')
  setState(db, 'fib_rsi_filter', 'true') // trade-armed, scan off → annotate
  setStage(db, { kind: 'filter', key: 'vwap', stage: 'scan', on: true }, io) // scan-armed → strict
  const opts = scanFilterOptions(db, getState)
  assert.deepEqual(opts.rsiFilter, { mode: 'annotate' })
  assert.deepEqual(opts.vwapFilter, {})
  assert.equal(opts.fvgFilter, null)
})

test('tradeStageGate: strategy trade cell and trade-armed filters both bite', () => {
  const db = initDB(':memory:')
  // cup_handle on by default (2026-07-27 default set)
  assert.equal(tradeStageGate(db, getState, { strategy: 'cup_handle', filtersFailed: [] }).ok, true)
  // strategy off in trade column (fib_618_fade is off by default now)
  assert.match(tradeStageGate(db, getState, { strategy: 'fib_618_fade', filtersFailed: [] }).reason, /OFF in Auto Trade/)
  // trade-armed filter failed at scan → veto (filters gate any strategy, not just fib)
  setState(db, 'fib_rsi_filter', 'true')
  const vetoed = tradeStageGate(db, getState, { strategy: 'cup_handle', filtersFailed: ['rsi'] })
  assert.equal(vetoed.ok, false)
  assert.match(vetoed.reason, /RSI filter failed/)
  // same failure with the filter NOT trade-armed → passes
  setState(db, 'fib_rsi_filter', 'false')
  assert.equal(tradeStageGate(db, getState, { strategy: 'cup_handle', filtersFailed: ['rsi'] }).ok, true)
  // unknown strategy label never trades
  assert.equal(tradeStageGate(db, getState, { strategy: 'mystery', filtersFailed: [] }).ok, false)
})

test('manageStageAllows: gated per strategy, unlabelled always managed', () => {
  const db = initDB(':memory:')
  assert.equal(manageStageAllows(db, getState, 'fib_618_fade'), true)
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'manage', on: false }, io)
  assert.equal(manageStageAllows(db, getState, 'fib_618_fade'), false)
  assert.equal(manageStageAllows(db, getState, null), true)
  assert.equal(manageStageAllows(db, getState, 'legacy-free-text'), true)
})

test('stageMatrixStats aggregates the four ledgers per strategy', () => {
  const db = initDB(':memory:')
  // scan: analyses — 1 reached the bar, 2 below it
  const insA = db.prepare(
    `INSERT INTO analyses (symbol, auto_trade, strategy, analyzed_at) VALUES ('EURUSD', ?, 'fib_618_fade', datetime('now'))`
  )
  insA.run(1); insA.run(0); insA.run(0)
  // backtest: last autopilot verdicts — 2 GO, 1 no-go
  setState(db, 'autopilot_last_verdicts_json', JSON.stringify([
    { strategy: 'fib_618_fade', state: 'go' },
    { strategy: 'fib_618_fade', state: 'go' },
    { strategy: 'fib_618_fade', state: 'no-go' },
  ]))
  // trade: risk_events — 1 approved, 1 veto
  const insR = db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, proposal_json, created_at)
     VALUES ('EURUSD', 'BUY', ?, '{"strategy":"fib_618_fade"}', datetime('now'))`
  )
  insR.run(1); insR.run(0)
  // manage: closed trades — 1 win, 1 loss
  const insT = db.prepare(
    `INSERT INTO trades (symbol, side, status, net_pnl, label_strategy, closed_at)
     VALUES ('EURUSD', 'BUY', 'closed', ?, 'fib_618_fade', datetime('now'))`
  )
  insT.run(12.5); insT.run(-4)

  const stats = stageMatrixStats(db, getState)
  assert.deepEqual(stats['strategy|fib_618_fade|scan'], { ok: 1, fail: 2 })
  assert.deepEqual(stats['strategy|fib_618_fade|backtest'], { ok: 2, fail: 1 })
  assert.deepEqual(stats['strategy|fib_618_fade|trade'], { ok: 1, fail: 1 })
  assert.deepEqual(stats['strategy|fib_618_fade|manage'], { ok: 1, fail: 1 })
})

test('stageMatrixStats never folds unattributed rows into fib_618_fade', () => {
  const db = initDB(':memory:')
  // scan: a row with NO strategy label (legacy/lost attribution)
  db.prepare(
    `INSERT INTO analyses (symbol, auto_trade, strategy, analyzed_at) VALUES ('EURUSD', 1, NULL, datetime('now'))`
  ).run()
  // trade: a risk_event whose proposal_json carries no strategy field
  db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, proposal_json, created_at)
     VALUES ('EURUSD', 'BUY', 1, '{}', datetime('now'))`
  ).run()
  // manage: a closed trade with neither label_strategy nor strategy set —
  // exactly the shape of Edge Health's "Manual / external" autopilot rows
  db.prepare(
    `INSERT INTO trades (symbol, side, status, net_pnl, label_strategy, strategy, closed_at)
     VALUES ('EURUSD', 'BUY', 'closed', 10, NULL, NULL, datetime('now'))`
  ).run()

  const stats = stageMatrixStats(db, getState)
  assert.equal(stats['strategy|fib_618_fade|scan'], undefined)
  assert.equal(stats['strategy|fib_618_fade|trade'], undefined)
  assert.equal(stats['strategy|fib_618_fade|manage'], undefined)
})

test('stageMatrixStats ignores rows older than the 30-day window', () => {
  const db = initDB(':memory:')
  db.prepare(
    `INSERT INTO analyses (symbol, auto_trade, strategy, analyzed_at) VALUES ('EURUSD', 1, 'fib_618_fade', datetime('now', '-45 days'))`
  ).run()
  const stats = stageMatrixStats(db, getState)
  assert.equal(stats['strategy|fib_618_fade|scan'], undefined)
})

test('stageMatrixView bundles columns, matrix, stats and window', () => {
  const db = initDB(':memory:')
  const v = stageMatrixView(db, getState)
  assert.deepEqual(v.columns.map(c => c.key), STAGES)
  assert.equal(v.strategies.length, STRATEGY_KEYS.length)
  assert.equal(v.filters.length, FILTER_KEYS.length)
  assert.equal(typeof v.stats, 'object')
  assert.equal(v.windowDays, 30)
})

// ---------------------------------------------------------------------------
// A GLOBAL OFF IS A KILL SWITCH (owner "go", 02-09-2026). Reproduces the
// 12:36 → 12:50 case: global disarm, account pin still on, strategy trades.
// ---------------------------------------------------------------------------
import { unpinTradeStageEverywhere, armedTradeKeys, acctMatrixKey, acctEnabledKey } from './stage-matrix.js'
import { readFileSync } from 'node:fs'

function withAccounts(db, ids) {
  for (const id of ids) db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')`).run(id, id)
  return db
}

test('global OFF clears the per-account trade pin and the legacy list; global ON leaves pins alone', () => {
  const db = withAccounts(initDB(':memory:'), ['111', '222', '333'])
  setState(db, 'enabled_strategies_json', JSON.stringify(['vwap_trend', 'rsi2_reversion']))
  // 111: overlay pin ON (the production shape); 222: legacy wholesale list;
  // 333: no pin, follows global; 444: not in the registry but carries a pin.
  setState(db, acctMatrixKey('111'), JSON.stringify({ strategy: { vwap_trend: { trade: true, scan: false } } }))
  setState(db, acctEnabledKey('222'), JSON.stringify(['vwap_trend', 'ema_pullback']))
  setState(db, acctMatrixKey('444'), JSON.stringify({ strategy: { vwap_trend: { trade: true } } }))
  // THE DEFECT: the global switch alone changes nothing on a pinned account.
  setState(db, 'enabled_strategies_json', JSON.stringify(['rsi2_reversion']))
  assert.ok(armedTradeKeys(db, getState, '111').has('vwap_trend'), 'pinned account still armed after a bare global write')
  assert.ok(armedTradeKeys(db, getState, '222').has('vwap_trend'))
  assert.ok(armedTradeKeys(db, getState, '444').has('vwap_trend'))
  assert.ok(!armedTradeKeys(db, getState, '333').has('vwap_trend'), 'the unpinned account followed the global')
  // THE FIX.
  const touched = unpinTradeStageEverywhere(db, io, 'vwap_trend')
  assert.deepEqual(touched, ['111', '222', '444'], 'every pin found, registry or not; the unpinned account is not "touched"')
  for (const a of ['111', '222', '333', '444']) assert.ok(!armedTradeKeys(db, getState, a).has('vwap_trend'), `${a} follows the global OFF`)
  // Other cells and other strategies on the same account survive.
  assert.deepEqual(JSON.parse(getState(db, acctMatrixKey('111'))), { strategy: { vwap_trend: { scan: false } } })
  assert.deepEqual(JSON.parse(getState(db, acctEnabledKey('222'))), ['ema_pullback'])
  assert.ok(armedTradeKeys(db, getState, '222').has('ema_pullback'), 'the legacy list keeps its other entries')
  // Idempotent, and a global ON does not re-pin or un-pin anything.
  assert.deepEqual(unpinTradeStageEverywhere(db, io, 'vwap_trend'), [])
  setState(db, acctMatrixKey('333'), JSON.stringify({ strategy: { rsi2_reversion: { trade: false } } }))
  setStage(db, { kind: 'strategy', key: 'rsi2_reversion', stage: 'trade', on: true }, io)
  assert.ok(!armedTradeKeys(db, getState, '333').has('rsi2_reversion'), 'an account that opted OUT keeps its opt-out on a global ON')
})

test('the kill switch lives in the OWNER routes, not in setStage: the adaptive breaker keeps its never-go-dark rule', () => {
  const db = withAccounts(initDB(':memory:'), ['111', '222'])
  setState(db, 'enabled_strategies_json', JSON.stringify(['vwap_trend']))
  setState(db, acctMatrixKey('111'), JSON.stringify({ strategy: { vwap_trend: { trade: true } } }))
  setState(db, acctMatrixKey('222'), JSON.stringify({ strategy: { vwap_trend: { trade: true } } }))
  setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: false, accountId: '111' }, io)
  assert.ok(!armedTradeKeys(db, getState, '111').has('vwap_trend'))
  assert.ok(armedTradeKeys(db, getState, '222').has('vwap_trend'), 'a per-account OFF is scoped, as before')
  setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: false }, io)
  assert.ok(armedTradeKeys(db, getState, '222').has('vwap_trend'), 'setStage alone leaves the pin — the breaker relies on that')
  assert.ok(!armedTradeKeys(db, getState, null).has('vwap_trend'))
  const src = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  const route = src.slice(src.indexOf("router.post('/stage-matrix'"), src.indexOf("router.post('/stage-matrix'") + 2500)
  assert.match(route, /unpinTradeStageEverywhere\(db, \{ getState, setState \}, String\(key\)\)/, 'the matrix route is the owner\'s other kill switch')
})

test('wiring: POST /actions/strategies clears pins for every strategy it turns off and reports them', () => {
  const src = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  const route = src.slice(src.indexOf("router.post('/strategies'"), src.indexOf("router.post('/storage-purge'"))
  assert.match(route, /unpinTradeStageEverywhere\(db, \{ getState, setState \}, k\)/)
  assert.match(route, /unpinned,/)
})

// ---------------------------------------------------------------------------
// OWNER-DECLARED PINS FROM THE REPO (owner order 09-09-2026, §7,522·B·2): the
// rsi2_reversion / rsi_meanrev demo cohort, applied at boot from
// config/strategy-pins.json because the pinning route needs the lost token.
// ---------------------------------------------------------------------------
import { seedStrategyPinsFromConfig, isHandPinned, tradeStageGate as gateFor, disarmStrategyEverywhere } from './stage-matrix.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('strategy-pin seed: pins the named strategies ON for that account only, idempotent, the gates read the pin, junk is skipped by name', () => {
  const db = withAccounts(initDB(':memory:'), ['111', '222'])
  setState(db, 'enabled_strategies_json', JSON.stringify(['vwap_trend'])) // rsi2 OFF globally, as in production 09-09
  const dir = mkdtempSync(join(tmpdir(), 'pins-'))
  const file = join(dir, 'strategy-pins.json')
  writeFileSync(file, JSON.stringify({ _note: 'the file\'s own note, never an account (09-09-2026)', 111: ['rsi2_reversion', 'rsi_meanrev', 'not_a_strategy'], abc: ['rsi2_reversion'], 222: 'rsi2_reversion' }))
  const lines = []
  const a = seedStrategyPinsFromConfig(db, io, { file, log: (m) => lines.push(m) })
  assert.equal(a.error, null)
  assert.deepEqual(a.applied, ['111:rsi2_reversion', '111:rsi_meanrev'])
  // (integer-like keys enumerate first, so 222 precedes abc)
  assert.deepEqual(a.skipped, ["111: unknown strategy 'not_a_strategy'", '222: malformed', 'abc: malformed'])
  assert.equal(lines.length, 2)
  assert.match(lines[0], /strategy pin …111: rsi2_reversion ON for Auto Trade & Open/)
  // The pin is the owner's word: explicit true cell, gate open on 111, still OFF on 222 and globally.
  assert.equal(isHandPinned(db, getState, '111', 'rsi2_reversion'), true)
  assert.equal(isHandPinned(db, getState, '222', 'rsi2_reversion'), false)
  assert.equal(gateFor(db, getState, { strategy: 'rsi2_reversion', accountId: '111' }).ok, true)
  assert.equal(gateFor(db, getState, { strategy: 'rsi2_reversion', accountId: '222' }).ok, false)
  assert.equal(gateFor(db, getState, { strategy: 'rsi2_reversion' }).ok, false, 'the global cell is untouched')
  assert.ok(!armedTradeKeys(db, getState, '111').has('ema_pullback'), 'other cells on the account keep their value')
  // Idempotent: a second boot changes nothing.
  const b = seedStrategyPinsFromConfig(db, io, { file })
  assert.deepEqual(b.applied, []); assert.deepEqual(b.unchanged, ['111:rsi2_reversion', '111:rsi_meanrev']); assert.deepEqual(b.held, [])
  // SEED ONCE (10-09-2026): a guard disarms the pin; the next boot does NOT
  // re-pin it — the file is a declaration, not a setting re-asserted per
  // deploy. Measured: watchdog disarmed three strategies on ACCT-LIVE-1 at
  // 20:59 SGT, boot re-applied five ("strategy pins: 5 applied").
  // PR-B (owner principle 1): a hand pin is held on EVERY scope under the
  // exemption, whichever environment the account is — so the guard's plain
  // disarm (no exemption: a human unpin, or a guard that does not hold pins)
  // is what removes it here. RED if the exemption regains an environment term.
  db.prepare(`UPDATE accounts SET is_live = 1 WHERE account_id = '111'`).run()
  const heldLive = disarmStrategyEverywhere(db, io, 'rsi2_reversion', { neverZero: false, exemptHandPinned: true })
  assert.deepEqual([...heldLive], [], 'a hand pin on a live scope is held like any other')
  assert.deepEqual(heldLive.held, ['111'])
  assert.equal(isHandPinned(db, getState, '111', 'rsi2_reversion'), true)
  const scopes = disarmStrategyEverywhere(db, io, 'rsi2_reversion', { neverZero: false })
  assert.deepEqual([...scopes], ['111'], 'without the exemption the pin is disarmed')
  assert.equal(isHandPinned(db, getState, '111', 'rsi2_reversion'), false)
  const c = seedStrategyPinsFromConfig(db, io, { file })
  assert.deepEqual(c.applied, [], 'the guard-disarmed pin is not re-applied')
  assert.deepEqual(c.held, ['111:rsi2_reversion'])
  assert.deepEqual(c.unchanged, ['111:rsi_meanrev'])
  assert.equal(isHandPinned(db, getState, '111', 'rsi2_reversion'), false, 'the guard\'s word stands across the boot')
  // A key newly added to the file is still applied on its first boot.
  writeFileSync(file, JSON.stringify({ 111: ['rsi2_reversion', 'rsi_meanrev', 'ema_pullback'] }))
  const d = seedStrategyPinsFromConfig(db, io, { file })
  assert.deepEqual(d.applied, ['111:ema_pullback']); assert.deepEqual(d.held, ['111:rsi2_reversion'])
  assert.deepEqual(JSON.parse(getState(db, 'strategy_pins_seeded_json'))['111'].sort(), ['ema_pullback', 'rsi2_reversion', 'rsi_meanrev'])
  // Missing or malformed file: reports, changes nothing.
  assert.match(seedStrategyPinsFromConfig(db, io, { file: join(dir, 'missing.json') }).error, /strategy-pins.json unreadable/)
  writeFileSync(file, '[1,2]')
  assert.equal(seedStrategyPinsFromConfig(db, io, { file }).error, 'strategy-pins.json is not an object')
})

test('strategy-pin seed: _all pins the list on every ENABLED account, a per-id key wins for its id, a disabled account is skipped, and an account enabled later is pinned on its first boot (PR-B, principle 9)', () => {
  const db = withAccounts(initDB(':memory:'), ['111', '222', '333'])
  db.prepare(`UPDATE accounts SET enabled = 0 WHERE account_id = '333'`).run()
  setState(db, 'enabled_strategies_json', JSON.stringify(['vwap_trend']))
  const dir = mkdtempSync(join(tmpdir(), 'pins-all-'))
  const file = join(dir, 'strategy-pins.json')
  writeFileSync(file, JSON.stringify({ _note: 'x', _all: ['rsi2_reversion', 'rsi_meanrev'], 222: ['ema_pullback'] }))
  const a = seedStrategyPinsFromConfig(db, io, { file })
  assert.equal(a.error, null)
  assert.deepEqual(a.applied.sort(), ['111:rsi2_reversion', '111:rsi_meanrev', '222:ema_pullback'].sort(), 'every enabled account from _all; the explicit key wins for 222')
  assert.equal(isHandPinned(db, getState, '333', 'rsi2_reversion'), false, 'a disabled account is not pinned')
  assert.equal(isHandPinned(db, getState, '222', 'rsi2_reversion'), false, 'the per-id key replaced _all for 222')
  // An account enabled AFTER the first boot is pinned on its next boot — RED if _all is read as a note and skipped.
  db.prepare(`UPDATE accounts SET enabled = 1 WHERE account_id = '333'`).run()
  const b = seedStrategyPinsFromConfig(db, io, { file })
  assert.deepEqual(b.applied.sort(), ['333:rsi2_reversion', '333:rsi_meanrev'])
  assert.deepEqual(seedStrategyPinsFromConfig(db, io, { file }).applied, [], 'idempotent')
  // A malformed _all is named, not silently ignored.
  writeFileSync(file, JSON.stringify({ _all: 'rsi2_reversion' }))
  assert.deepEqual(seedStrategyPinsFromConfig(db, io, { file }).skipped, ['_all: malformed'])
})

test('strategy-pin seed: the checked-in file parses — Wave 1 (19-09-2026): `_all` pins only what has earned it, `_off` names the shadow set, `_trial` names ONE account for the momentum book, no bare account-id keys — and index.js applies it at boot after the momentum seed', () => {
  const cfg = JSON.parse(readFileSync(new URL('../config/strategy-pins.json', import.meta.url), 'utf8'))
  const ids = Object.keys(cfg).filter(k => /^\d+$/.test(k))
  assert.deepEqual(ids, [], 'no hardcoded account ids as keys (principle 9)')
  // 20-09-2026 (owner: "retire the intraday paths, keep momentum only"):
  // `_all` is EMPTY and fib_confluence joined `_off`. Its record did not turn
  // (PF 2.72 over 26) — its only producer did: scan_dispatch is retired in
  // lib/entry-producers.js, and principle 6 forbids the UI showing a strategy
  // armed that no producer can trade.
  assert.deepEqual(cfg._all, [], '_all: empty — no intraday strategy has a producer any more')
  assert.deepEqual([...cfg._off].sort(), [...STRATEGY_KEYS.filter(k => k !== 'tsmom_long')].sort(), '_off: every scan strategy is shadow, the momentum book aside')
  assert.deepEqual(Object.keys(cfg._trial), ['tsmom_long'], '_trial: the momentum book only')
  assert.equal(cfg._trial.tsmom_long.length, 1, 'one account per system on trial (07-09 P5 reconciled with P9 in the note)')
  assert.match(cfg._trial_note, /2026-12-19/, 'the trial names its checkpoint date')
  // The 19-09 fib_confluence re-arm is spent AND superseded by the 20-09
  // retirement: the list is empty, the mechanism documented.
  assert.deepEqual(cfg._reseed, [])
  assert.match(cfg._reseed_note, /intraday retirement/)
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(src, /seedMomentumAccountFromConfig\(db, \{ log[\s\S]{0,1500}?seedStrategyPinsFromConfig\(db, \{ getState, setState \}, \{ log/, 'the boot seed runs after the momentum-account seed')
  assert.match(src, /switched off/, 'the boot line reports the OFF orders')
})

function seedShipped(db) {
  return seedStrategyPinsFromConfig(db, io, { file: new URL('../config/strategy-pins.json', import.meta.url) })
}

const TRIAL_ID = JSON.parse(readFileSync(new URL('../config/strategy-pins.json', import.meta.url), 'utf8'))._trial.tsmom_long[0]

test('momentum trial: the SHIPPED pins file arms tsmom_long on the ONE trial account and switches it OFF everywhere else; fib_confluence is ON everywhere; the shadow set is OFF everywhere', () => {
  const db = withAccounts(initDB(':memory:'), ['111', '222', TRIAL_ID])
  setState(db, 'enabled_strategies_json', JSON.stringify(['vwap_trend']))
  // production shape before the seed: the old `_all` had pinned everything
  for (const id of ['111', '222', TRIAL_ID]) for (const k of ['tsmom_long', 'vwap_trend', 'donchian_breakout']) setStage(db, { kind: 'strategy', key: k, stage: 'trade', on: true, accountId: id }, io)
  const r = seedShipped(db)
  assert.equal(r.error, null)
  assert.ok(r.unchanged.includes(`${TRIAL_ID}:tsmom_long:trial`) || r.applied.includes(`${TRIAL_ID}:tsmom_long:trial`), 'the trial account keeps/gets tsmom_long')
  assert.equal(armedTradeKeys(db, getState, TRIAL_ID).has('tsmom_long'), true, 'the trial account trades the book')
  for (const id of ['111', '222']) {
    assert.ok(r.off.includes(`${id}:tsmom_long`), `${id}: tsmom_long switched OFF (on trial elsewhere)`)
    assert.equal(armedTradeKeys(db, getState, id).has('tsmom_long'), false)
    assert.ok(r.off.includes(`${id}:vwap_trend`) && r.off.includes(`${id}:donchian_breakout`), `${id}: the shadow set switched OFF`)
    assert.equal(armedTradeKeys(db, getState, id).has('vwap_trend'), false)
  }
  for (const id of ['111', '222', TRIAL_ID]) {
    // 20-09-2026: fib_confluence is OFF everywhere now — `_all` is empty and
    // it sits in `_off`, because scan_dispatch (its only producer) is retired.
    assert.ok(!r.applied.includes(`${id}:fib_confluence`), `${id}: nothing is armed from _all any more`)
    assert.ok(r.off.includes(`${id}:fib_confluence`) || r.unchanged.includes(`${id}:fib_confluence:off`),
      `${id}: fib_confluence carries an OFF order (written where a hand pin had to be cleared, recorded as unchanged where it was already off)`)
    assert.equal(armedTradeKeys(db, getState, id).has('fib_confluence'), false)
  }
  // Second boot changes nothing (seed-once on every record, ON and OFF alike).
  const again = seedShipped(db)
  assert.deepEqual(again.applied, [], 'idempotent ON')
  assert.deepEqual(again.off, [], 'idempotent OFF')
})

test('momentum trial: an account enabled AFTER the first boot gets the same orders on its first boot (fib_confluence ON, tsmom_long OFF unless it is the trial account); a DISABLED account gets nothing', () => {
  const db = withAccounts(initDB(':memory:'), ['111', '999'])
  setState(db, 'enabled_strategies_json', JSON.stringify(['vwap_trend']))
  db.prepare(`UPDATE accounts SET enabled = 0 WHERE account_id = '999'`).run()
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: true, accountId: '999' }, io)
  const a = seedShipped(db)
  assert.ok(!a.applied.some(t => t.startsWith('999:')) && !a.off.some(t => t.startsWith('999:')), 'a disabled account is not touched at all')
  db.prepare(`UPDATE accounts SET enabled = 1 WHERE account_id = '999'`).run()
  const b = seedShipped(db)
  assert.ok(b.off.includes('999:fib_confluence') || b.unchanged.includes('999:fib_confluence:off'), 'the late joiner gets the OFF order for the retired stack')
  assert.equal(armedTradeKeys(db, getState, '999').has('fib_confluence'), false)
  assert.ok(b.off.includes('999:tsmom_long'), 'and the OFF order for the strategy on trial elsewhere')
  assert.equal(armedTradeKeys(db, getState, '999').has('tsmom_long'), false)
})

test('momentum trial: seed-once holds a HUMAN change made after the seed — a re-armed shadow strategy is not switched off again, and a disarmed trial cell is held', () => {
  const db = withAccounts(initDB(':memory:'), ['111', TRIAL_ID])
  setState(db, 'enabled_strategies_json', JSON.stringify(['vwap_trend']))
  setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: true, accountId: '111' }, io)
  const a = seedShipped(db)
  assert.ok(a.off.includes('111:vwap_trend'))
  // the owner re-arms it by hand after the seed: the next boot leaves it alone
  setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: true, accountId: '111' }, io)
  const b = seedShipped(db)
  assert.ok(!b.off.includes('111:vwap_trend'), 'the OFF order was spent on the first boot')
  assert.equal(armedTradeKeys(db, getState, '111').has('vwap_trend'), true, 'the human re-arm stands')
  // a guard disarms the trial cell: held across the next boot (the seed-once rule)
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: false, accountId: TRIAL_ID }, io)
  const c = seedShipped(db)
  assert.ok(c.held.includes(`${TRIAL_ID}:tsmom_long:trial`), 'a post-seed disarm of the trial cell stands')
})

test('_off and _trial on a scratch file: an explicit per-id ON wins over _off; _trial switches the strategy OFF on every account it does not name; malformed blocks are named and skipped', () => {
  const db = withAccounts(initDB(':memory:'), ['111', '222', '333'])
  const file = join(mkdtempSync(join(tmpdir(), 'pins-off-')), 'pins.json')
  for (const id of ['111', '222', '333']) for (const k of ['vwap_trend', 'tsmom_long']) setStage(db, { kind: 'strategy', key: k, stage: 'trade', on: true, accountId: id }, io)
  writeFileSync(file, JSON.stringify({ _off: ['vwap_trend'], _trial: { tsmom_long: ['222'] }, '333': ['vwap_trend'] }))
  const r = seedStrategyPinsFromConfig(db, io, { file })
  assert.deepEqual(r.skipped, [])
  assert.deepEqual([...r.off].sort(), ['111:tsmom_long', '111:vwap_trend', '222:vwap_trend', '333:tsmom_long'])
  assert.equal(armedTradeKeys(db, getState, '333').has('vwap_trend'), true, 'the per-id ON wins over _off')
  assert.equal(armedTradeKeys(db, getState, '222').has('tsmom_long'), true, 'the trial account keeps the strategy')
  assert.equal(armedTradeKeys(db, getState, '111').has('tsmom_long'), false)
  writeFileSync(file, JSON.stringify({ _off: 'vwap_trend', _trial: ['tsmom_long'] }))
  const bad = seedStrategyPinsFromConfig(db, io, { file })
  assert.deepEqual(bad.skipped.sort(), ['_off: malformed', '_trial: malformed'])
})

test('wiring: momentum-book.js still gates its per-account pass on armedTradeKeys(...).has(TSMOM_STRATEGY) — the predicate the pin moves', async () => {
  // The key itself is checked by VALUE, not by text: the pins file lists
  // 'tsmom_long' and the book's constant must be that same string, or the
  // seed writes a cell the gate never reads.
  const { TSMOM_STRATEGY } = await import('./momentum-book.js')
  assert.equal(TSMOM_STRATEGY, 'tsmom_long')
  assert.ok(STRATEGY_KEYS.includes(TSMOM_STRATEGY), 'and the seed accepts it (unknown keys are skipped by name)')
  // Source-text, comments STRIPPED, and a last resort: the gate is an inline
  // expression inside the pass loop with no injection point of its own, and
  // momentum-book.js is owned elsewhere. If this call site is refactored away,
  // the pin above becomes a repair nothing calls.
  const src = readFileSync(new URL('./momentum-book.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(src, /armedTradeKeys\(db, getState, accountId\)\.has\(TSMOM_STRATEGY\)/, 'the book reads the same overlay the pin writes')
})

// ---------------------------------------------------------------------------
// `_reseed` (PR-V, owner order 17-09-2026): re-issue a pin the bare key has
// already spent. The owner was shown the edge watchdog's fresh verdict on
// tsmom_long (expectancy -$108.48, PF 0) and chose to arm the three accounts
// anyway; these tests pin the mechanism that carries that out, including the
// parts that must NOT change.
// ---------------------------------------------------------------------------
test('_reseed re-arms a cell whose bare key is already spent', () => {
  const db = withAccounts(initDB(':memory:'), ['47790949'])
  const file = join(mkdtempSync(join(tmpdir(), 'reseed-')), 'pins.json')

  // First order: the bare key. Applied once.
  writeFileSync(file, JSON.stringify({ _all: ['tsmom_long'] }))
  assert.deepEqual(seedStrategyPinsFromConfig(db, io, { file }).applied, ['47790949:tsmom_long'])

  // Something disarms it — the watchdog on that account's own record.
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: false, accountId: '47790949', actor: 'edge_watchdog' }, io)
  assert.equal(armedTradeKeys(db, getState, '47790949').has('tsmom_long'), false)

  // The bare key alone must NOT put it back — that is the #870 loop.
  const held = seedStrategyPinsFromConfig(db, io, { file })
  assert.deepEqual(held.applied, [])
  assert.ok(held.held.includes('47790949:tsmom_long'))
  assert.equal(armedTradeKeys(db, getState, '47790949').has('tsmom_long'), false)

  // A `_reseed` entry is a FRESH order and does re-arm it.
  writeFileSync(file, JSON.stringify({ _all: ['tsmom_long'], _reseed: ['47790949:tsmom_long:2'] }))
  const again = seedStrategyPinsFromConfig(db, io, { file })
  assert.deepEqual(again.applied, ['47790949:tsmom_long:2'])
  assert.equal(armedTradeKeys(db, getState, '47790949').has('tsmom_long'), true)
})

test('_reseed is itself seed-once — a second disarm is not fought', () => {
  const db = withAccounts(initDB(':memory:'), ['46130058'])
  const file = join(mkdtempSync(join(tmpdir(), 'reseed-')), 'pins.json')
  writeFileSync(file, JSON.stringify({ _reseed: ['46130058:tsmom_long:2'] }))
  seedStrategyPinsFromConfig(db, io, { file })
  assert.equal(armedTradeKeys(db, getState, '46130058').has('tsmom_long'), true)

  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: false, accountId: '46130058', actor: 'edge_watchdog' }, io)
  const r = seedStrategyPinsFromConfig(db, io, { file })
  assert.deepEqual(r.applied, [], 'the re-order is spent too — an arm that reasserts every boot is a guard that can never hold')
  assert.equal(armedTradeKeys(db, getState, '46130058').has('tsmom_long'), false)
})

test('_reseed does NOT suppress _all for that account — future strategies still inherit', () => {
  // A per-id KEY would suppress `_all` for that id, quietly stopping the
  // account inheriting anything added later. `_reseed` is appended after the
  // `_all` expansion precisely so it cannot do that.
  const db = withAccounts(initDB(':memory:'), ['43097342'])
  const file = join(mkdtempSync(join(tmpdir(), 'reseed-')), 'pins.json')
  writeFileSync(file, JSON.stringify({ _all: ['rsi2_reversion', 'vwap_trend'], _reseed: ['43097342:tsmom_long:2'] }))
  const r = seedStrategyPinsFromConfig(db, io, { file })
  const armed = armedTradeKeys(db, getState, '43097342')
  for (const k of ['rsi2_reversion', 'vwap_trend', 'tsmom_long']) assert.ok(armed.has(k), `${k} armed`)
  assert.ok(r.applied.includes('43097342:tsmom_long:2'))
})

test('a malformed _reseed entry is named and skipped, the good ones still land', () => {
  const db = withAccounts(initDB(':memory:'), ['47790949'])
  const file = join(mkdtempSync(join(tmpdir(), 'reseed-')), 'pins.json')
  writeFileSync(file, JSON.stringify({ _reseed: ['nostrategy', 42, '47790949:not_a_strategy:2', '47790949:tsmom_long:2'] }))
  const r = seedStrategyPinsFromConfig(db, io, { file })
  assert.ok(r.skipped.some(s => /needs <accountId>:<strategy>/.test(s)))
  assert.ok(r.skipped.some(s => /not a string/.test(s)))
  assert.ok(r.skipped.some(s => /unknown strategy 'not_a_strategy'/.test(s)))
  assert.deepEqual(r.applied, ['47790949:tsmom_long:2'])
})

test('the checked-in file carries no 17-09 re-arm (the trial replaced them); its only reseed is the owner\'s 19-09 fib_confluence order', () => {
  const cfg = JSON.parse(readFileSync(new URL('../config/strategy-pins.json', import.meta.url), 'utf8'))
  assert.ok(!cfg._reseed.some(e => /tsmom_long/.test(e)), 'no 17-09 tsmom re-arm')
  // 20-09-2026: emptied with the intraday retirement — the 19-09
  // fib_confluence order is spent and superseded, the key kept so the
  // mechanism stays visible.
  assert.equal(cfg._reseed.length, 0)
})
