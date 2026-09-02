// node --test agent/services/strategy-autopilot.test.js
// The policy brain is pure — these tests ARE the automation's contract.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decideChanges, isBusyWindow, applyChanges, evaluateAll, loadArmBar } from './strategy-autopilot.js'
import { initDB, getState, setState } from '../db.js'
import { explainVerdict, equitySvg, renderAutopilotReport } from '../lib/autopilot-report.js'

// GO fixture clears the strict arming bar (PF≥1.7, win≥60%, ≥25 trades).
const GO = (strategy, symbol, timeframe, entryMode = 'close') => ({ strategy, symbol, timeframe, entryMode, state: 'go', trades: 25, pf: 1.8, winRate: 65, total: 5, wfActive: 4, wfPositive: 3 })
const NOGO = (strategy, symbol, timeframe, entryMode = 'close') => ({ strategy, symbol, timeframe, entryMode, state: 'no-go', trades: 20, pf: 0.8, total: -3, wfActive: 4, wfPositive: 1 })
const EMPTY = { enabledStrategies: ['fib_618_fade'], autoMatrix: {}, pendingMatrix: {} }

test('fresh close-confirm GO arms the strategy AND its matrix combo', () => {
  const c = decideChanges([GO('ema_pullback', 'GBPUSD', '12h')], EMPTY)
  assert.deepEqual(c.arm.map(a => a.kind).sort(), ['matrix', 'strategy'])
  assert.equal(c.disarm.length, 0)
})

test('touch GO arms the pending matrix, not the strategy list', () => {
  const c = decideChanges([GO('fib_618_fade', 'EURUSD', '3d', 'touch')], EMPTY)
  assert.deepEqual(c.arm, [{ kind: 'pending', strategy: 'fib_618_fade', symbol: 'EURUSD', timeframe: '3d' }])
})

test('already-armed combos produce no changes', () => {
  const cur = { enabledStrategies: ['fib_618_fade', 'ema_pullback'], autoMatrix: { GBPUSD: ['12h'] }, pendingMatrix: {} }
  const c = decideChanges([GO('ema_pullback', 'GBPUSD', '12h')], cur)
  assert.equal(c.arm.length + c.disarm.length, 0)
})

test('armed combo gone NO-GO is disarmed', () => {
  const cur = { enabledStrategies: ['fib_618_fade'], autoMatrix: { US30: ['1d'] }, pendingMatrix: { EURUSD: ['3d'] } }
  const c = decideChanges([NOGO('fib_618_fade', 'US30', '1d'), NOGO('fib_618_fade', 'EURUSD', '3d', 'touch')], cur)
  assert.deepEqual(c.disarm.map(d => d.kind).sort(), ['matrix', 'pending'])
})

test('thin verdicts neither arm nor disarm', () => {
  const cur = { enabledStrategies: ['fib_618_fade'], autoMatrix: { US30: ['1d'] }, pendingMatrix: {} }
  const c = decideChanges([{ strategy: 'fib_618_fade', symbol: 'US30', timeframe: '1d', entryMode: 'close', state: 'thin' }], cur)
  assert.equal(c.arm.length + c.disarm.length, 0)
})

test('change cap: disarms jump the queue, overflow becomes suggestions', () => {
  const verdicts = [
    NOGO('fib_618_fade', 'US30', '1d'),
    GO('ema_pullback', 'GBPUSD', '12h'),
    GO('donchian_breakout', 'EURUSD', '4h'),
    GO('rsi_meanrev', 'USDJPY', '1d'),
  ]
  const cur = { enabledStrategies: ['fib_618_fade'], autoMatrix: { US30: ['1d'] }, pendingMatrix: {} }
  const c = decideChanges(verdicts, cur, { maxChanges: 2 })
  assert.equal(c.disarm.length, 1) // the safety cut got through
  assert.equal(c.arm.length, 1)
  assert.ok(c.suggestions.length >= 4) // the rest wait for the human or the next night
})

test('arming bar: a GO below PF/win/trades is NOT armed (only proven combos)', () => {
  // clears "GO" but marginal — like AUDUSD·4h (PF 1.50, 54%): must not arm
  const marginal = { strategy: 'fib_618_fade', symbol: 'AUDUSD', timeframe: '4h', entryMode: 'close', state: 'go', trades: 40, pf: 1.5, winRate: 54, total: 3, wfActive: 4, wfPositive: 3 }
  const c = decideChanges([marginal], { enabledStrategies: [], autoMatrix: {}, pendingMatrix: {} })
  assert.equal(c.arm.length, 0)
})

test('arming bar: thresholds are configurable', () => {
  const combo = { strategy: 'rsi2_reversion', symbol: 'US30', timeframe: '8h', entryMode: 'close', state: 'go', trades: 30, pf: 1.6, winRate: 58, total: 4, wfActive: 4, wfPositive: 3 }
  // strict default (1.7/60/25) → no arm; loosened → arms
  assert.equal(decideChanges([combo], { enabledStrategies: [], autoMatrix: {}, pendingMatrix: {} }).arm.length, 0)
  const loose = decideChanges([combo], { enabledStrategies: [], autoMatrix: {}, pendingMatrix: {} }, { armMinPf: 1.5, armMinWin: 55, armMinTrades: 20 })
  assert.ok(loose.arm.length >= 1)
})

test('isBusyWindow: US session, NY→Sydney handover, and JPN225 window', () => {
  assert.equal(isBusyWindow(['New York'], 3), true)          // NY live
  assert.equal(isBusyWindow([], 3), true)                    // handover, Asia not open, JPN pre-open
  assert.equal(isBusyWindow(['Sydney'], 3), false)           // Asia open, outside JPN window → calm
  assert.equal(isBusyWindow(['Tokyo'], 9), true)             // 09:00 JST — first trading hour
  assert.equal(isBusyWindow(['Tokyo'], 8), true)             // 08:00 JST — premarket hour
  assert.equal(isBusyWindow(['Tokyo'], 13), false)           // 13:00 JST — window closed
  assert.equal(isBusyWindow(['London'], 15), false)          // London-only midday → calm
})

test('explainVerdict spells out each gate in words', () => {
  const lines = explainVerdict({ trades: 3, pf: 1.5, total: 2, wfActive: 4, wfPositive: 3 })
  assert.equal(lines[0].ok, false)
  assert.match(lines[0].text, /need at least 10/)
  assert.equal(lines[1].ok, true)
})

test('equitySvg renders an inline chart, handles too-few points', () => {
  assert.match(equitySvg([0, 1.2, 0.8, 2.4]), /^<svg/)
  assert.match(equitySvg([1]), /not enough trades/)
})

test('renderAutopilotReport is self-contained html grouped by strategy', () => {
  const html = renderAutopilotReport([{ ...GO('ema_pullback', 'GBPUSD', '12h'), equity: [0, 1, 2] }], { ranAt: 'now' }, 'autopilot-x.html')
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /ema_pullback/)
  assert.match(html, /GBPUSD 12h/)
  assert.ok(!/https?:\/\//.test(html), 'no external resources')
})

// ---------------------------------------------------------------------------
// THE ONE-WAY LATCH. Owner, 05-08-2026: the Desk badge "keeps ⏳ pending armed
// regardless of accounts and stay like that".
//
// It did. `if (Object.keys(pendM).length) setState(db, 'pending_mode_enabled',
// 'true')` set the key and never cleared it, so turning the mode off on Tune
// lasted until the next autopilot pass turned it back on. An automated writer
// that can only ever ARM an operator switch is not a setting, it is a latch.
// ---------------------------------------------------------------------------

test('an emptied pending matrix turns the mode OFF, not just leaves it on', () => {
  const db = initDB(':memory:')
  setState(db, 'pending_mode_enabled', 'true')
  setState(db, 'pending_matrix_json', JSON.stringify({ 'DOW.US': ['1h'] }))

  applyChanges(db, { arm: [], disarm: [{ kind: 'pending', symbol: 'DOW.US', timeframe: '1h' }] })

  assert.equal(getState(db, 'pending_mode_enabled'), 'false',
    'the operator switch must be clearable — this is the whole defect')
  assert.equal(getState(db, 'pending_matrix_json'), null)
})

test('arming a pending row still turns the mode on', () => {
  const db = initDB(':memory:')
  setState(db, 'pending_mode_enabled', 'false')
  applyChanges(db, { arm: [{ kind: 'pending', symbol: 'EURUSD', timeframe: '1h' }], disarm: [] })
  assert.equal(getState(db, 'pending_mode_enabled'), 'true')
})

test('the mode always MIRRORS the matrix — the two can never disagree', () => {
  // Before this, mode could be 'true' with an empty matrix, which is what the
  // badge was reporting: armed, with nothing armed.
  const db = initDB(':memory:')
  for (const arm of [true, false]) {
    applyChanges(db, {
      arm: arm ? [{ kind: 'pending', symbol: 'EURUSD', timeframe: '1h' }] : [],
      disarm: arm ? [] : [{ kind: 'pending', symbol: 'EURUSD', timeframe: '1h' }],
    })
    const matrix = getState(db, 'pending_matrix_json')
    const mode = getState(db, 'pending_mode_enabled') === 'true'
    assert.equal(mode, matrix != null, `mode ${mode} disagrees with matrix ${matrix}`)
  }
})

// ---------------------------------------------------------------------------
// The ARM BAR is a dialable config (owner "go with C", 01-09-2026).
// decideChanges always accepted overrides; nothing wired them — a knob with
// no writer. loadArmBar + the /actions/autopilot armBar field are the writer;
// these tests pin both halves and the clamps.
// ---------------------------------------------------------------------------

test('loadArmBar: defaults are ARM_BAR; stored values override; junk clamps, never loosens to zero', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadArmBar(db), { minPf: 1.7, minWin: 60, minTrades: 25 })
  setState(db, 'autopilot_arm_bar_json', JSON.stringify({ minPf: 1.5, minWin: 55, minTrades: 20 }))
  assert.deepEqual(loadArmBar(db), { minPf: 1.5, minWin: 55, minTrades: 20 })
  setState(db, 'autopilot_arm_bar_json', JSON.stringify({ minPf: 0, minWin: -5, minTrades: 'junk' }))
  const clamped = loadArmBar(db)
  assert.equal(clamped.minPf, 1, 'minPf floors at 1 — a bar below breakeven is not a bar')
  assert.equal(clamped.minWin, 10)
  assert.equal(clamped.minTrades, 25, 'junk degrades to the default, not to zero')
  setState(db, 'autopilot_arm_bar_json', 'not json')
  assert.deepEqual(loadArmBar(db), { minPf: 1.7, minWin: 60, minTrades: 25 })
})

test('a lowered bar arms the combo the default bar refuses', () => {
  const verdicts = [{ strategy: 'ema_pullback', symbol: 'EURUSD', timeframe: '4h', entryMode: 'close', state: 'go', pf: 1.55, winRate: 56, trades: 22 }]
  const current = { enabledStrategies: [], autoMatrix: {}, pendingMatrix: {} }
  const strict = decideChanges(verdicts, current, {})
  assert.equal(strict.arm.length, 0, 'below the default 1.7/60/25 bar nothing arms')
  const eased = decideChanges(verdicts, current, { armMinPf: 1.5, armMinWin: 55, armMinTrades: 20 })
  assert.ok(eased.arm.length >= 1, 'the eased bar must arm it')
})

test('wiring: the production call site passes the configured bar (no orphaned knob)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./strategy-autopilot.js', import.meta.url), 'utf8')
  assert.ok(src.includes('const armBar = loadArmBar(db)'), 'maybeRunAutopilot must load the configured bar')
  assert.ok(src.includes('armMinPf: armBar.minPf'), 'decideChanges must receive the configured bar')
  assert.ok(!/v\.pf \?\? 0\) >= 1\.7/.test(src), 'no hardcoded 1.7 armable headline — it must use armBar')
  const route = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8')
  assert.ok(route.includes("autopilot_arm_bar_json"), '/actions/autopilot must be the writer for the bar')
})

// ---------------------------------------------------------------------------
// The sweep must SHARE the event loop (owner-approved fix, 01-09-2026).
// Measured before it: evaluateAll ran ~3 unbroken CPU-bound minutes on the
// main thread (loopPhaseLag.autopilot worstStallCpuRatio 0.99), starving
// fast-monitor ticks and heartbeats every ~10-min firing. The contract now is
// one setImmediate yield per combo — pinned here by counting macrotask turns
// that manage to run WHILE the sweep is in progress: zero turns would mean
// the block is back.
// ---------------------------------------------------------------------------
test('evaluateAll yields the event loop at least once per combo', async () => {
  const db = initDB(':memory:')
  setState(db, 'autopilot_symbols_json', JSON.stringify([{ symbol: 'EURUSD', enabled: true }]))

  // A concurrent setImmediate pump: each turn it gets is proof the sweep
  // released the loop. FIFO ordering guarantees it runs at every combo yield.
  let turns = 0
  let stopped = false
  const pump = () => { if (stopped) return; turns++; setImmediate(pump) }
  setImmediate(pump)

  let combos = 0
  const bars = Array.from({ length: 400 }, (_, i) => ({ ts: i * 60_000, o: 1, h: 1, l: 1, c: 1, v: 1 }))
  const deps = {
    ws: {
      wsGetTrendbarsBatch: async (_h, _ci, _cs, _t, _a, _sid, tfs) =>
        Object.fromEntries(tfs.map((tf) => [tf, bars])),
    },
    bt: {
      runBacktest: () => { combos++; return { stats: { trades: 0 }, trades: [] } },
      walkForward: () => ({ active: 0, positive: 0, worstMddPct: 0 }),
    },
    credsLib: { getSymbolMap: () => ({ EURUSD: 1 }) },
    remote: async () => null, // force fib down the JS path too
  }
  const before = turns
  let verdicts, errors
  try {
    ({ verdicts, errors } = await evaluateAll(
      db,
      { host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '1' },
      deps,
    ))
  } finally {
    stopped = true // a failure must not leave the pump chain keeping the process alive
  }
  assert.ok(combos > 0, `no combos ran (verdicts ${verdicts.length}, errors: ${errors.join('; ')}) — a yield test over zero combos proves nothing`)
  assert.ok(
    turns - before >= combos,
    `event loop advanced only ${turns - before} turn(s) across ${combos} combos — the sweep is blocking again`,
  )
})

// Wiring pin: the loop must LAUNCH the sweep, never await it. The awaited
// form (even budgeted — the budget only abandons the wait) held every later
// phase behind ~3 minutes of backtests. Both heartbeat paths must survive the
// detachment or a dying sweep becomes silence instead of a failing controller.
test('loop.js autopilot call site is detached, overlap-guarded, and still beats', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  assert.ok(!src.includes("runBudgetedSubPhase(db, 'autopilot'"),
    'autopilot is awaited via runBudgetedSubPhase again — the 3-minute cycle stall returns')
  assert.ok(src.includes("subPhaseInFlight.set('autopilot', true)"),
    'detached launch lost its overlap guard — two concurrent sweeps must be impossible')
  assert.ok(src.includes("subPhaseInFlight.get('autopilot')"),
    'nothing checks the in-flight flag before relaunching')
  const autopilotBeats = (src.match(/hbeat\(db, 'autopilot'/g) || []).length
  assert.ok(autopilotBeats >= 3,
    `expected the per-cycle beat plus the detached ok/fail beats (>=3 call sites), found ${autopilotBeats}`)
  const apSrc = readFileSync(new URL('./strategy-autopilot.js', import.meta.url), 'utf8')
  assert.ok(/for \(const entryMode of modes\) \{\s*\n(\s*\/\/[^\n]*\n)*\s*await new Promise\(\(resolve\) => setImmediate\(resolve\)\)/.test(apSrc),
    'the per-combo setImmediate yield left evaluateAll')
})

// ---------------------------------------------------------------------------
// Divergence tracker (owner "plan #1", 02-09-2026): arms snapshot their
// evidence, disarms close the row and name their strategy, and each sweep
// persists a BOUNDED verdict history.
// ---------------------------------------------------------------------------
import { recordComboArms, persistVerdictHistory, clearsArmBar, backfillComboArmsFromActionLog, parseApplyLine, reconcileComboArmsWithMatrix } from './strategy-autopilot.js'

test('recordComboArms: an arm snapshots its verdict + bar; a disarm closes the row; strategy arms carry no combo evidence', () => {
  const db = initDB(':memory:')
  const verdicts = [
    { strategy: 'ema_pullback', symbol: 'GBPUSD', timeframe: '12h', entryMode: 'close', state: 'go', pf: 1.8, winRate: 65, trades: 25, wfPositive: 3, wfActive: 4 },
  ]
  const changes = decideChanges(verdicts, EMPTY)
  recordComboArms(db, changes, { verdicts, armBar: { minPf: 1.7, minWin: 60, minTrades: 25 } })
  const rows = db.prepare('SELECT * FROM combo_arms ORDER BY id').all()
  assert.deepEqual(rows.map(r => r.kind).sort(), ['matrix', 'strategy'])
  const m = rows.find(r => r.kind === 'matrix')
  assert.equal(m.bt_pf, 1.8); assert.equal(m.bt_win_rate_pct, 65); assert.equal(m.bt_trades, 25); assert.equal(m.bt_wf_active, 4)
  assert.equal(m.bar_min_pf, 1.7)
  const s = rows.find(r => r.kind === 'strategy')
  assert.equal(s.bt_pf, null, 'a strategy-level arm has no single combo verdict — recorded as such')
  // Re-applying the same arm must not duplicate the open row.
  recordComboArms(db, changes, { verdicts })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM combo_arms').get().n, 2)
  // Disarm closes it, naming the strategy.
  const nogo = [{ strategy: 'ema_pullback', symbol: 'GBPUSD', timeframe: '12h', entryMode: 'close', state: 'no-go', pf: 0.7, trades: 20 }]
  const d = decideChanges(nogo, { enabledStrategies: ['ema_pullback'], autoMatrix: { GBPUSD: ['12h'] }, pendingMatrix: {} })
  assert.equal(d.disarm[0].strategy, 'ema_pullback', 'disarm entries must carry the condemning strategy')
  recordComboArms(db, d, {})
  const closed = db.prepare(`SELECT * FROM combo_arms WHERE kind = 'matrix'`).get()
  assert.ok(closed.disarmed_at, 'the open matrix row must be closed')
  assert.equal(closed.disarm_reason, 'autopilot_nogo')
})

test('persistVerdictHistory keeps only bar-clearing or currently-armed verdicts, stamped armable', () => {
  const db = initDB(':memory:')
  const bar = { minPf: 1.5, minWin: 55, minTrades: 20 }
  const verdicts = [
    { strategy: 'a', symbol: 'X', timeframe: '1h', entryMode: 'close', state: 'go', pf: 1.6, winRate: 58, trades: 22 },   // clears
    { strategy: 'b', symbol: 'Y', timeframe: '4h', entryMode: 'close', state: 'no-go', pf: 0.8, winRate: 30, trades: 30 }, // armed combo → kept
    { strategy: 'c', symbol: 'Z', timeframe: '1d', entryMode: 'close', state: 'thin', pf: null, winRate: null, trades: 3 }, // neither → dropped
  ]
  const n = persistVerdictHistory(db, verdicts, { autoMatrix: { Y: ['4h'] }, pendingMatrix: {} }, bar)
  assert.equal(n, 2)
  const rows = db.prepare('SELECT strategy, armable FROM autopilot_verdicts ORDER BY strategy').all()
  assert.deepEqual(rows, [{ strategy: 'a', armable: 1 }, { strategy: 'b', armable: 0 }])
  assert.equal(clearsArmBar(verdicts[0], bar), true)
})

test('backfill: combo_arms is rebuilt once from the action log, then never touched', () => {
  const db = initDB(':memory:')
  const log = db.prepare(`INSERT INTO action_log (at, method, path, body) VALUES (?, 'AUTOPILOT', '/apply', ?)`)
  log.run('2026-09-01 06:41:05', JSON.stringify(['+ armed pending SEKJPY 4h (fib_618_fade)', '+ armed SEKJPY 1d (rsi2_reversion)', '+ armed strategy donchian_breakout']))
  log.run('2026-09-01 08:11:44', JSON.stringify(['− disarmed GBPUSD 1h', '+ armed SAPD.DE 1d (rsi2_reversion)']))
  log.run('2026-09-01 10:13:00', JSON.stringify(['− disarmed SEKJPY 1d (rsi2_reversion)']))
  const r = backfillComboArmsFromActionLog(db)
  assert.equal(r.arms, 4); assert.equal(r.disarms, 2)
  const rows = db.prepare('SELECT * FROM combo_arms ORDER BY id').all()
  assert.equal(rows.length, 4)
  const sek = rows.find(x => x.symbol === 'SEKJPY' && x.timeframe === '1d')
  assert.equal(sek.armed_at, '2026-09-01 06:41:05', 'armed_at must be the log time, not now')
  assert.equal(sek.strategy, 'rsi2_reversion')
  assert.equal(sek.bt_pf, null, 'retroactive evidence is unknowable — stays NULL')
  assert.equal(sek.disarmed_at, '2026-09-01 10:13:00')
  assert.equal(sek.disarm_reason, 'backfill_nogo')
  assert.equal(rows.find(x => x.kind === 'pending').entry_mode, 'touch')
  assert.equal(rows.find(x => x.kind === 'strategy').strategy, 'donchian_breakout')
  // Idempotent.
  assert.equal(backfillComboArmsFromActionLog(db).skipped, 'already populated')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM combo_arms').get().n, 4)
})

test('parseApplyLine covers every shape describe() writes, and rejects the rest', () => {
  assert.deepEqual(parseApplyLine('+ armed strategy ema_pullback'), { action: 'arm', kind: 'strategy', strategy: 'ema_pullback' })
  assert.deepEqual(parseApplyLine('+ armed US500 1d (rsi2_reversion)'), { action: 'arm', kind: 'matrix', symbol: 'US500', timeframe: '1d', strategy: 'rsi2_reversion' })
  assert.deepEqual(parseApplyLine('+ armed pending NXPI.US 4h (fib_618_fade)'), { action: 'arm', kind: 'pending', symbol: 'NXPI.US', timeframe: '4h', strategy: 'fib_618_fade' })
  assert.deepEqual(parseApplyLine('− disarmed pending NZDCAD 30m'), { action: 'disarm', kind: 'pending', symbol: 'NZDCAD', timeframe: '30m' })
  assert.equal(parseApplyLine('no changes — everything armed matches the evidence'), null)
})

test('boot reconcile squares combo_arms with the live matrices: stale rows closed, live pairs without a row recorded as unevidenced', () => {
  // Measured after the backfill deployed (02-09-2026): 74 open rows the live
  // matrix no longer carried, 49 live pairs with no row. Owner: "record them
  // with no evidence, build the reconcile step".
  const db = initDB(':memory:')
  const T = '2026-09-02 00:50:00'
  // Live: auto matrix arms US30 1d and NAS100 1h; pending matrix arms SEKJPY 4h.
  setState(db, 'autotrade_matrix_json', JSON.stringify({ US30: ['1d'], NAS100: ['1h'] }))
  setState(db, 'pending_matrix_json', JSON.stringify({ SEKJPY: ['4h'] }))
  // Recorded: NAS100 1h on a verdict (live — keep), GBPUSD 10m (stale — close),
  // a pending NXPI.US 4h (stale — close), a strategy arm (never touched).
  recordComboArms(db, {
    arm: [
      { kind: 'matrix', strategy: 'rsi2_reversion', symbol: 'NAS100', timeframe: '1h' },
      { kind: 'matrix', strategy: 'vwap_trend', symbol: 'GBPUSD', timeframe: '10m' },
      { kind: 'pending', strategy: 'fib_618_fade', symbol: 'NXPI.US', timeframe: '4h' },
      { kind: 'strategy', strategy: 'donchian_breakout' },
    ], disarm: [],
  }, { at: '2026-09-01 06:41:05', reason: 'backfill' })

  const r = reconcileComboArmsWithMatrix(db, { at: T })
  assert.deepEqual(r, { auto: { stale: 1, added: 1, skipped: null }, pending: { stale: 1, added: 1, skipped: null } })
  const rows = db.prepare('SELECT * FROM combo_arms ORDER BY id').all()
  const by = (sym, tf) => rows.find(x => x.symbol === sym && x.timeframe === tf)
  assert.equal(by('NAS100', '1h').disarmed_at, null, 'a live, recorded pair is untouched')
  assert.equal(by('GBPUSD', '10m').disarmed_at, T)
  assert.equal(by('GBPUSD', '10m').disarm_reason, 'boot_reconcile: not armed live')
  assert.equal(by('NXPI.US', '4h').disarmed_at, T, 'pending rows are squared against the PENDING matrix')
  assert.equal(rows.find(x => x.kind === 'strategy').disarmed_at, null, 'strategy arms have no matrix to square against')
  const us30 = by('US30', '1d'), sek = by('SEKJPY', '4h')
  assert.equal(us30.kind, 'unevidenced'); assert.equal(us30.strategy, null); assert.equal(us30.bt_pf, null)
  assert.equal(us30.entry_mode, 'close'); assert.equal(us30.armed_at, T)
  assert.equal(sek.kind, 'unevidenced'); assert.equal(sek.entry_mode, 'touch')

  // Idempotent: a second run finds nothing to do.
  assert.deepEqual(reconcileComboArmsWithMatrix(db, { at: T }), { auto: { stale: 0, added: 0, skipped: null }, pending: { stale: 0, added: 0, skipped: null } })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM combo_arms').get().n, 6)

  // A verdict arm on US30 1d SUPERSEDES the unevidenced row; a disarm of a
  // pair closes its unevidenced row too.
  recordComboArms(db, { arm: [{ kind: 'matrix', strategy: 'vp_value', symbol: 'US30', timeframe: '1d' }], disarm: [] },
    { verdicts: [{ strategy: 'vp_value', symbol: 'US30', timeframe: '1d', entryMode: 'close', pf: 1.7, winRate: 60, trades: 25 }], armBar: { minPf: 1.5, minWin: 55, minTrades: 20 }, at: '2026-09-02 01:00:00' })
  const us30Rows = rows.length && db.prepare(`SELECT * FROM combo_arms WHERE symbol='US30' ORDER BY id`).all()
  assert.equal(us30Rows.length, 2)
  assert.equal(us30Rows[0].disarm_reason, 'superseded_by_verdict_arm')
  assert.equal(us30Rows[1].kind, 'matrix'); assert.equal(us30Rows[1].bt_pf, 1.7)
  recordComboArms(db, { arm: [], disarm: [{ kind: 'pending', symbol: 'SEKJPY', timeframe: '4h' }] }, { at: '2026-09-02 01:10:00' })
  assert.equal(db.prepare(`SELECT disarmed_at FROM combo_arms WHERE symbol='SEKJPY'`).get().disarmed_at, '2026-09-02 01:10:00')

  // An ABSENT matrix key is not an empty matrix: nothing is touched.
  const db2 = initDB(':memory:')
  recordComboArms(db2, { arm: [{ kind: 'matrix', strategy: 'x', symbol: 'A', timeframe: '1h' }], disarm: [] }, {})
  assert.equal(reconcileComboArmsWithMatrix(db2).auto.skipped, 'no matrix on record')
  assert.equal(db2.prepare('SELECT disarmed_at FROM combo_arms').get().disarmed_at, null)
})

test('wiring: /state/config emits the autopilot dials the action enforces (UI audit 02-09-2026)', () => {
  // The Tune page reads config.autopilot to describe the bar/cap/allowLive;
  // a route that stopped emitting it would silently return the copy to
  // "not reported". Comments stripped so the pin cannot pass on prose.
  const src = readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  assert.match(src, /autopilot: \{\s*arm_bar: loadArmBar\(db\),\s*max_changes: Number\(getState\(db, 'autopilot_max_changes'\)\) \|\| 4,\s*allow_live: getState\(db, 'autopilot_allow_live'\) === 'true',\s*\}/)
  const tune = readFileSync(new URL('../../src/pages/Tune.jsx', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\{\/\*[\s\S]*?\*\/\}/g, '')
  assert.match(tune, /config\?\.autopilot\?\.arm_bar/)
  assert.doesNotMatch(tune, /arms GO combos|never on LIVE accounts|4-change cap/, 'the stale gate description must be gone')
})

// ---------------------------------------------------------------------------
// ONE EVALUATOR (02-09-2026). The backtest sweep and the live breakers used to
// override each other; the disarm floor sat 0.4 PF below the arm bar; and the
// bar compared rounded figures.
// ---------------------------------------------------------------------------
import { loadLiveDisarms, noteLiveDisarm, DISARM_PF_FRACTION, LIVE_DISARM_COOL_OFF_MS } from './strategy-autopilot.js'

const V = (strategy, symbol, timeframe, pf, winRate = 60, trades = 30, state = 'go', entryMode = 'close') =>
  ({ strategy, symbol, timeframe, entryMode, state, pf, winRate, trades })
const EMPTY2 = { enabledStrategies: [], autoMatrix: {}, pendingMatrix: {} }
const BAR = { armMinPf: 1.5, armMinWin: 55, armMinTrades: 20 }

test('a strategy the live evaluators disarmed is NOT re-armed inside the cool-off, and is afterwards', () => {
  const now = Date.parse('2026-09-01T06:25:00Z')
  const liveDisarms = { rsi2_reversion: '2026-09-01T06:01:25Z' } // the breaker's second disarm that morning
  const v = [V('rsi2_reversion', 'US2000', '4h', 2.0)]
  const held = decideChanges(v, EMPTY2, { ...BAR, liveDisarms, nowMs: now })
  assert.equal(held.arm.length, 0, 'the backtest must not vote against live money for a day')
  assert.equal(held.cooledOff.length, 1)
  assert.equal(held.cooledOff[0].strategy, 'rsi2_reversion')
  const later = decideChanges(v, EMPTY2, { ...BAR, liveDisarms, nowMs: now + LIVE_DISARM_COOL_OFF_MS })
  assert.equal(later.arm.length, 2, 'strategy + matrix arm once the cool-off has passed')
})

test('noteLiveDisarm stamps the cool-off AND closes the strategy\'s arm row with the live reason', () => {
  const db = initDB(':memory:')
  recordComboArms(db, { arm: [{ kind: 'strategy', strategy: 'rsi2_reversion' }], disarm: [] }, { at: '2026-09-01 04:54:25' })
  noteLiveDisarm(db, 'rsi2_reversion', 'breaker', { nowMs: Date.parse('2026-09-01T06:01:25Z') })
  assert.equal(loadLiveDisarms(db).rsi2_reversion, '2026-09-01T06:01:25.000Z')
  const row = db.prepare(`SELECT disarmed_at, disarm_reason FROM combo_arms WHERE kind='strategy' AND strategy='rsi2_reversion'`).get()
  assert.equal(row.disarmed_at, '2026-09-01 06:01:25')
  assert.equal(row.disarm_reason, 'breaker_nogo')
})

test('the disarm floor sits at 85% of the arm bar, not at the loose GO bar', () => {
  const cur = { enabledStrategies: ['ema_pullback'], autoMatrix: { GBPUSD: ['1h'] }, pendingMatrix: {} }
  // PF 1.2 is still GO at the loose bar (≥1.1) but below 1.5 × 0.85 = 1.275 → disarm.
  const weak = decideChanges([V('ema_pullback', 'GBPUSD', '1h', 1.2)], cur, BAR)
  assert.equal(weak.disarmMinPf, 1.5 * DISARM_PF_FRACTION)
  assert.deepEqual(weak.disarm, [{ kind: 'matrix', strategy: 'ema_pullback', symbol: 'GBPUSD', timeframe: '1h' }])
  // PF 1.3 is above the floor → kept (absence of a strong verdict is not decay).
  assert.equal(decideChanges([V('ema_pullback', 'GBPUSD', '1h', 1.3)], cur, BAR).disarm.length, 0)
  // A weak GO no longer PROTECTS a row another strategy condemned.
  const both = decideChanges([V('ema_pullback', 'GBPUSD', '1h', 1.2), V('vwap_trend', 'GBPUSD', '1h', 0.8, 30, 30, 'no-go')], cur, BAR)
  assert.equal(both.disarm.length, 1)
})

test('the bar compares UNROUNDED figures: PF 1.495 does not arm at 1.5', async () => {
  const { runBacktest } = await import('../scripts/backtest-fib.js')
  // The engine now returns raw twins; evaluateAll prefers them. Pin both.
  const src = (await import('node:fs')).readFileSync(new URL('./strategy-autopilot.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  assert.match(src, /pf: stats\.profitFactorRaw \?\? stats\.profitFactor \?\? null/)
  assert.match(src, /winRate: stats\.winRatePctRaw \?\? stats\.winRatePct \?\? null/)
  assert.equal(typeof runBacktest, 'function')
  const exact = decideChanges([V('ema_pullback', 'GBPUSD', '1h', 1.495, 55, 20)], EMPTY2, BAR)
  assert.equal(exact.arm.length, 0, '1.495 is below 1.5 — rounding to 1.5 must not arm it')
  assert.equal(decideChanges([V('ema_pullback', 'GBPUSD', '1h', 1.5, 55, 20)], EMPTY2, BAR).arm.length, 2)
})

// ---------------------------------------------------------------------------
// Shrinkage prior (owner plan, 02-09-2026; ML audit): a combo's PF/WR are
// pulled toward the sweep mean with k phantom trades before the bar applies,
// so a 20-trade fluke in a 1,872-combo sweep does not arm.
// ---------------------------------------------------------------------------
import { sweepShrinkPrior, shrinkVerdict, SHRINK_PRIOR_TRADES } from './strategy-autopilot.js'

test('shrinkVerdict: 20 trades at 60% in a 45% sweep reads 52.5; 100 trades reads 57.5; no prior is identity', () => {
  const prior = { k: 20, wrMean: 45, pfMean: 1.0 }
  assert.equal(shrinkVerdict({ pf: 2, winRate: 60, trades: 20 }, prior).winRate, 52.5)
  assert.equal(shrinkVerdict({ pf: 2, winRate: 60, trades: 20 }, prior).pf, 1.5)
  assert.equal(shrinkVerdict({ pf: 2, winRate: 60, trades: 100 }, prior).winRate, 57.5)
  assert.deepEqual(shrinkVerdict({ pf: 2, winRate: 60, trades: 20 }, null), { pf: 2, winRate: 60 })
  assert.equal(shrinkVerdict({ pf: null, winRate: 60, trades: 20 }, prior).pf, null, 'a null PF stays null rather than becoming the prior')
})

test('decideChanges with the prior: the 20-trade fluke is refused, the 100-trade edge arms', () => {
  const shrink = { k: 20, wrMean: 45, pfMean: 1.0 }
  const fluke = decideChanges([V('ema_pullback', 'GBPUSD', '1h', 2.0, 60, 20)], EMPTY2, { ...BAR, shrink })
  assert.equal(fluke.arm.length, 0, 'WR 52.5 after shrinkage is below the 55 bar')
  assert.deepEqual(fluke.shrink, { k: 20, wrMean: 45, pfMean: 1 })
  const proven = decideChanges([V('ema_pullback', 'GBPUSD', '1h', 2.0, 60, 100)], EMPTY2, { ...BAR, shrink })
  assert.equal(proven.arm.length, 2, 'WR 57.5 / PF 1.83 arms strategy + matrix')
  assert.equal(decideChanges([V('ema_pullback', 'GBPUSD', '1h', 2.0, 60, 20)], EMPTY2, BAR).arm.length, 2, 'without a prior the same verdict arms as before')
})

test('sweepShrinkPrior: null under 30 verdicts; PF capped at 5 so a lossless combo cannot lift the prior over the bar', () => {
  const thin = Array.from({ length: 29 }, (_, i) => V('s', `SYM${i}`, '1h', 1.2, 50, 10))
  assert.equal(sweepShrinkPrior(thin), null)
  const wide = Array.from({ length: 30 }, (_, i) => V('s', `SYM${i}`, '1h', i === 0 ? 900 : 1.0, i === 0 ? 100 : 40, 10))
  const p = sweepShrinkPrior(wide)
  assert.equal(p.k, SHRINK_PRIOR_TRADES)
  assert.equal(p.verdicts, 30)
  assert.equal(p.wrMean, 42)
  assert.equal(Math.round(p.pfMean * 1000) / 1000, Math.round(((5 + 29) / 30) * 1000) / 1000)
  // Verdicts without trades are not part of the sweep's picture of a combo.
  assert.equal(sweepShrinkPrior([...wide, ...Array.from({ length: 50 }, (_, i) => V('s', `Z${i}`, '1h', 9, 99, 0))]).verdicts, 30)
})
