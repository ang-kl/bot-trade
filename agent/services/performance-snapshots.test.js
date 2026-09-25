// agent/services/performance-snapshots.test.js — plan P1: one snapshot row
// per account plus the pooled row, read STRICTLY by /state/metrics and
// /state/metrics/history, and the loop's call pinned.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { initDB, setState } from '../db.js'
import { writePerformanceSnapshots } from './performance-snapshots.js'

const A = '46130058', B = '47790949'
const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

function close(db, account, pnl) {
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, status, net_pnl, account_id, closed_at) VALUES ('EURUSD', 'BUY', 1.1, 'closed', ?, ?, datetime('now'))`).run(pnl, account)
}

test('writePerformanceSnapshots: one row per account with its own account_id and figures, plus one pooled NULL row', () => {
  const db = initDB(':memory:')
  close(db, A, 100); close(db, A, -50)
  close(db, B, 30); close(db, B, -10); close(db, B, -10)
  const r = writePerformanceSnapshots(db)
  assert.deepEqual(r, { accounts: 2, pooled: true })
  const rows = db.prepare('SELECT account_id, total_trades, winning_trades, losing_trades, profit_factor, total_pnl FROM performance_snapshots ORDER BY id').all()
  assert.deepEqual(rows.map(x => ({ ...x })), [
    { account_id: A, total_trades: 2, winning_trades: 1, losing_trades: 1, profit_factor: 2, total_pnl: 50 },
    { account_id: B, total_trades: 3, winning_trades: 1, losing_trades: 2, profit_factor: 1.5, total_pnl: 10 },
    { account_id: null, total_trades: 5, winning_trades: 2, losing_trades: 3, profit_factor: 1.86, total_pnl: 60 },
  ])
})

test('writePerformanceSnapshots: no closed trades writes nothing', () => {
  const db = initDB(':memory:')
  assert.deepEqual(writePerformanceSnapshots(db), { accounts: 0, pooled: false })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM performance_snapshots').get().n, 0)
})

async function withServer(db, fn) {
  const { default: stateRouter } = await import('../routes/state.js')
  const app = express()
  app.use('/state', stateRouter(db))
  const s = await new Promise(resolve => { const srv = app.listen(0, () => resolve(srv)) })
  try { await fn(`http://127.0.0.1:${s.address().port}/state`) } finally { s.close() }
}

function snap(db, account, total, at) {
  db.prepare(`INSERT INTO performance_snapshots (total_trades, winning_trades, losing_trades, win_rate, profit_factor, total_pnl, account_id, computed_at) VALUES (?, 0, 0, 0, 0, 0, ?, ?)`).run(total, account, at)
}

test('GET /state/metrics is strict: an account gets ITS row, never the pooled NULL row even when newer; all reads the pooled row', async () => {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', A)
  snap(db, A, 11, '2026-09-25 01:00:00')
  snap(db, B, 22, '2026-09-25 01:30:00')
  snap(db, null, 33, '2026-09-25 02:00:00')
  await withServer(db, async (base) => {
    const a = await fetch(`${base}/metrics?account=${A}`).then(x => x.json())
    assert.equal(a.metrics.account_id, A); assert.equal(a.metrics.total_trades, 11)
    assert.equal(a.scope.coverage.unstamped, 0); assert.equal(a.scope.coverage.pooledRowsExcluded, 1)
    const sel = await fetch(`${base}/metrics`).then(x => x.json())
    assert.equal(sel.metrics.account_id, A, 'no ?account falls back to the selected account, strictly')
    const all = await fetch(`${base}/metrics?account=all`).then(x => x.json())
    assert.equal(all.metrics.account_id, null); assert.equal(all.metrics.total_trades, 33)
    const none = await fetch(`${base}/metrics?account=99999999`).then(x => x.json())
    assert.equal(none.metrics, null, 'no row of its own yet: null, not the pooled row')
  })
})

test('GET /state/metrics/history is strict and keeps the rows of the cutoff\'s own calendar day', async () => {
  const db = initDB(':memory:')
  const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
  const now = Date.now()
  // 30 s inside a 1-day window, on the cutoff's own calendar day (except in
  // the day's last 30 s): the old ISO-'T' bound sorted above every row of
  // that day and dropped it
  snap(db, A, 1, fmt(now - 86_400_000 + 30_000))
  snap(db, A, 2, fmt(now - 60_000))
  snap(db, null, 3, fmt(now - 60_000))
  snap(db, A, 4, fmt(now - 3 * 86_400_000))
  await withServer(db, async (base) => {
    const h = await fetch(`${base}/metrics/history?account=${A}&days=1`).then(x => x.json())
    assert.deepEqual(h.snapshots.map(s => s.total_trades), [1, 2])
    assert.equal(h.scope.coverage.total, 2)
    const all = await fetch(`${base}/metrics/history?account=all&days=1`).then(x => x.json())
    assert.deepEqual(all.snapshots.map(s => s.total_trades), [3])
  })
})

test('wiring: the loop calls writePerformanceSnapshots(db) and no longer inserts snapshots inline', () => {
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.match(loop, /import \{ writePerformanceSnapshots \} from '\.\/services\/performance-snapshots\.js'/)
  assert.match(loop, /\n\s*writePerformanceSnapshots\(db\)\n/)
  assert.equal(loop.includes('INSERT INTO performance_snapshots'), false)
})
