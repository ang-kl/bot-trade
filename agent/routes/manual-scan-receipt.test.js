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
  const analysisId = db.prepare('INSERT INTO analyses(symbol,strategy,consensus_bias,synthesis,scan_id) VALUES (?,?,?,?,?)')
    .run('EURUSD', 'ema_pullback', 'long', JSON.stringify({ timeframe: '4h' }), scanId).lastInsertRowid
  db.prepare("INSERT INTO trades(account_id,symbol,side,status,analysis_id,ctrader_position_id) VALUES ('A','EURUSD','BUY','open',?,'manual-fixture-pos')").run(analysisId)
  const read = () => accountSignals(db, snapshot, { accountId: 'A', lastScanAt: at })
  assert.equal(read().rows[0].entry?.positionId, 'manual-fixture-pos')
  assert.equal(read().rows[1].entry, null, 'another strategy/timeframe for the same symbol did not trade')
  db.prepare("UPDATE analyses SET strategy='rsi2_reversion' WHERE id=?").run(analysisId)
  assert.equal(read().rows[0].entry, null, 'a mismatching owned link is refused')
})
