// Codex · №11,601·R (ui-followup-2026-10-07) — real producer/receipt regressions.
// Run the unchanged route callback against a real DB. Only the scanner and
// connection-read boundary are replaced; no socket or broker action occurs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { initDB, getState, setState } from '../db.js'
import { upsertAccount } from '../services/account-registry.js'
import { writeWatchlist } from '../services/watchlists.js'
import { enabledStrategies } from '../services/strategies.js'
import { accountSignals } from '../services/account-signals.js'
import { synthesizeFibSignal } from '../services/fib-strategy.js'

// Codex · №11,627·R (ui-followup-2026-10-07) — exercise the actual analysis producer, not a hand-linked analysis.
async function manualAnalyze(db, signal) {
  const source = readFileSync(new URL('./actions.js', import.meta.url), 'utf8')
  const start = source.indexOf("  router.post('/analyze',")
  const end = source.indexOf('  // Granular autopilot toggles', start)
  assert.ok(start >= 0 && end > start)
  let handler, result
  const context = { db, getState, setState, enabledStrategies, synthesizeFibSignal, console,
    getCtraderCreds: () => ({ ready: true }), getSymbolMap: () => ({ EURUSD: 1 }),
    scanSymbolFib: async () => ({ signal, error: null }),
    router: { post: (path, fn) => { assert.equal(path, '/analyze'); handler = fn } },
  }
  vm.runInNewContext(source.slice(start, end), context, { filename: 'actual-actions-analyze-route.js' })
  const res = { status(code) { assert.fail(`unexpected ${code}`) }, json(body) { result = body } }
  await handler({ body: { symbol: 'EURUSD' } }, res)
  assert.equal(result.ok, true)
  return db.prepare('SELECT * FROM analyses ORDER BY id DESC LIMIT 1').get()
}
const strongest = { symbol: 'EURUSD', strategy: 'ema_pullback', timeframe: '4h', bias: 'long', conviction: 9, entry: 1.12, sl: 1.11, tp1: 1.14 }

const scans = [
  { symbol: 'EURUSD', strategy: 'ema_pullback', timeframe: '4h', bias: 'long', confidence: 9 },
  { symbol: 'EURUSD', strategy: 'rsi2_reversion', timeframe: '1h', bias: 'short', confidence: 8 },
]
async function manualScan(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  upsertAccount(db, { accountId: 'A', isLive: false }); writeWatchlist(db, 'A', ['EURUSD'])
  setState(db, 'autopilot_symbols_json', JSON.stringify([{ symbol: 'EURUSD', enabled: true }]))
  const source = readFileSync(new URL('./actions.js', import.meta.url), 'utf8')
  const start = source.indexOf("  router.post('/scan',")
  const end = source.indexOf("  // POST /actions/analyze", start)
  assert.ok(start >= 0 && end > start)
  let handler, result, clock = Date.parse('2026-10-06T22:00:00.000Z')
  // Deliberately advance every clock read: identical millisecond timestamps
  // by chance must not conceal two independent batch stamps.
  class AdvancingDate extends Date { constructor(...args) { super(...(args.length ? args : [clock++])) } }
  const context = { db, getState, setState, enabledStrategies, Date: AdvancingDate, console,
    getCtraderCreds: () => ({ ready: true }), getSymbolMap: () => ({ EURUSD: 1 }),
    runFibScan: async () => ({ scans, hot: [], warm: [], signals: {}, desk_note: 'fixture' }),
    router: { post: (path, fn) => { assert.equal(path, '/scan'); handler = fn } },
  }
  vm.runInNewContext(source.slice(start, end), context, { filename: 'actual-actions-scan-route.js' })
  const res = { status(code) { assert.fail(`unexpected ${code}`) }, json(body) { result = body } }
  await handler({ body: {} }, res)
  assert.equal(result.ok, true)
  return { db, snapshot: JSON.parse(getState(db, 'last_scan_results')), at: getState(db, 'last_scan_at') }
}

test('manual scan rows retain strategy and the exact single batch timestamp', async t => {
  const { db, at } = await manualScan(t)
  assert.deepEqual(db.prepare('SELECT strategy,scanned_at FROM scans ORDER BY id').all(),
    scans.map(s => ({ strategy: s.strategy, scanned_at: at })))
})

test('a real manual scan → analysis → account trade chain appears on Signals without proximity joins', async t => {
  const { db, snapshot, at } = await manualScan(t)
  const scanId = db.prepare('SELECT id FROM scans ORDER BY id LIMIT 1').get().id
  const analysis = await manualAnalyze(db, strongest)
  assert.equal(analysis.scan_id, scanId, 'same-timestamp competing strategy must not steal attribution')
  const analysisId = analysis.id
  db.prepare("INSERT INTO trades(account_id,symbol,side,status,analysis_id,ctrader_position_id) VALUES ('A','EURUSD','BUY','open',?,'manual-fixture-pos')").run(analysisId)
  const read = () => accountSignals(db, snapshot, { accountId: 'A', lastScanAt: at })
  assert.equal(read().rows[0].entry?.positionId, 'manual-fixture-pos')
  assert.equal(read().rows[1].entry, null, 'another strategy/timeframe for the same symbol did not trade')
  db.prepare("UPDATE analyses SET strategy='rsi2_reversion' WHERE id=?").run(analysisId)
  assert.equal(read().rows[0].entry, null, 'a mismatching owned link is refused')
})

test('manual analysis matches timeframe and bias inside the current batch', async t => {
  const { db, at } = await manualScan(t)
  const scanId = db.prepare('SELECT id FROM scans ORDER BY id LIMIT 1').get().id
  const add = db.prepare('INSERT INTO scans(symbol,strategy,timeframe,bias,scanned_at) VALUES (?,?,?,?,?)')
  add.run('EURUSD', 'ema_pullback', '1h', 'long', at)
  add.run('EURUSD', 'ema_pullback', '4h', 'short', at)
  assert.equal((await manualAnalyze(db, strongest)).scan_id, scanId)
})

test('manual analysis with no current matching scan leaves the link unknown', async t => {
  const { db } = await manualScan(t)
  setState(db, 'last_scan_at', '2026-10-06T22:01:00.000Z')
  assert.equal((await manualAnalyze(db, strongest)).scan_id, null, 'an older match is not the retained current batch')
  assert.equal((await manualAnalyze(db, null)).scan_id, null, 'no setup is not another strategy scan')
})

test('the actual ordinary dispatcher links the dispatched strategy, not the timestamp-tied last row', async t => {
  const { db, snapshot, at } = await manualScan(t)
  const { dispatchSymbolSignal, prepareStatements } = await import('../loop.js')
  const s = prepareStatements(db)
  const chosen = { ...strongest, conviction: 5 } // below the alert and trade thresholds: no network or order path
  const result = await dispatchSymbolSignal(db, s, [{ symbol: 'EURUSD', autoTradeThreshold: 8 }], 'EURUSD', chosen)
  assert.equal(result.fired, false)
  const analysis = db.prepare('SELECT * FROM analyses ORDER BY id DESC LIMIT 1').get()
  assert.equal(analysis.scan_id, db.prepare('SELECT id FROM scans ORDER BY id LIMIT 1').get().id)
  db.prepare("INSERT INTO trades(account_id,symbol,side,status,analysis_id,ctrader_position_id) VALUES ('A','EURUSD','BUY','open',?,'dispatcher-fixture-pos')").run(analysis.id)
  assert.equal(accountSignals(db, snapshot, { accountId: 'A', lastScanAt: at }).rows[0].entry?.positionId, 'dispatcher-fixture-pos')
  setState(db, 'last_scan_at', '2026-10-06T22:01:00.000Z')
  await dispatchSymbolSignal(db, s, [{ symbol: 'EURUSD', autoTradeThreshold: 8 }], 'EURUSD', chosen)
  assert.equal(db.prepare('SELECT scan_id FROM analyses ORDER BY id DESC LIMIT 1').get().scan_id, null)
})
