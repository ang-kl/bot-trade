import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import { upsertAccount } from '../services/account-registry.js'
import { writeWatchlist } from '../services/watchlists.js'
import stateRouter from './state.js'

const at = '2026-10-06T19:00:00.000Z'
const scans = [
  { symbol: 'EURUSD', strategy: 'ema_pullback', timeframe: '4h', bias: 'long', confidence: 9 },
  { symbol: 'BTCUSD', strategy: 'rsi2_reversion', timeframe: '1h', bias: 'short', confidence: 8 },
]
async function fixture(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  for (const accountId of ['A', 'B']) upsertAccount(db, { accountId, isLive: accountId === 'B' })
  writeWatchlist(db, 'A', ['EURUSD']); writeWatchlist(db, 'B', ['BTCUSD'])
  setState(db, 'last_scan_at', at); setState(db, 'last_scan_results', JSON.stringify({ scans }))
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const read = async account => (await fetch(`http://127.0.0.1:${server.address().port}/state/scans?view=signals&account=${account}`)).json()
  return { db, read }
}

test('Signals is account-specific without shrinking the global price/scan snapshot or stamping history', async t => {
  const { db, read } = await fixture(t)
  const before = db.prepare('SELECT * FROM agent_state ORDER BY key').all()
  const a = await read('A'), b = await read('B'), all = await read('all')
  assert.deepEqual(a.signals?.rows.map(r => [r.account_id, r.symbol]), [['A', 'EURUSD']])
  assert.deepEqual(b.signals?.rows.map(r => [r.account_id, r.symbol]), [['B', 'BTCUSD']])
  assert.deepEqual(all.signals.rows.map(r => r.account_id).sort(), ['A', 'B'])
  assert.deepEqual(all.signals.rows.map(r => r.eligibility), ['scan_only', 'scan_only'], 'both broker hosts use the same account phase rules')
  assert.match(a.signals.rows[0].accountLabel, /^Demo /)
  assert.match(b.signals.rows[0].accountLabel, /^Live /)
  assert.deepEqual(a.lastResults.scans, scans)
  assert.deepEqual((await read('unknown')).signals.rows, [])
  assert.deepEqual(db.prepare('SELECT * FROM agent_state ORDER BY key').all(), before)
})

test('only an exact stored scan→analysis→account trade join supplies an execution receipt', async t => {
  const { db, read } = await fixture(t)
  const insertScan = db.prepare('INSERT INTO scans(symbol,strategy,timeframe,bias,scanned_at) VALUES (?,?,?,?,?)')
  const scanId = insertScan.run('EURUSD', 'ema_pullback', '4h', 'long', at).lastInsertRowid
  const analysisId = db.prepare('INSERT INTO analyses(symbol,strategy,consensus_bias,synthesis,scan_id) VALUES (?,?,?,?,?)').run('EURUSD','ema_pullback','long',JSON.stringify({ timeframe: '4h' }),scanId).lastInsertRowid
  db.prepare("INSERT INTO trades(account_id,symbol,side,status,analysis_id,ctrader_position_id) VALUES ('A','EURUSD','BUY','open',?,'pos-1')").run(analysisId)
  let response = await read('A')
  assert.equal(response.signals?.rows[0].entry?.positionId, 'pos-1')
  assert.equal(response.signals.rows[0].entry.accountId, 'A')
  // A symbol-only or wrong-strategy link must never pretend this signal traded.
  db.prepare("UPDATE analyses SET strategy='rsi2_reversion' WHERE id=?").run(analysisId)
  response = await read('A'); assert.equal(response.signals.rows[0].entry, null)
})

test('a fresh snapshot updates without stale cache and a disarmed account stays scan-only', async t => {
  const { db, read } = await fixture(t)
  await read('A')
  const nextAt = '2026-10-06T19:05:00.000Z'
  setState(db, 'last_scan_at', nextAt)
  setState(db, 'last_scan_results', JSON.stringify({ scans: [{ ...scans[0], confidence: 7, price: 1.123 }] }))
  const response = await read('A')
  assert.equal(response.signals.rows[0].confidence, 7)
  assert.equal(response.signals.lastScanAt, nextAt)
  assert.equal(response.signals.rows[0].entry, null)
  assert.equal(response.signals.rows[0].eligibility, 'scan_only', 'a registered, disarmed account is not approved to enter')
})
