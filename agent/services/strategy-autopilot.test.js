// node --test agent/services/strategy-autopilot.test.js
// The policy brain is pure — these tests ARE the automation's contract.

import test from 'node:test'
import assert from 'node:assert/strict'
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
import { recordComboArms, persistVerdictHistory, clearsArmBar } from './strategy-autopilot.js'

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
