// node --test agent/routes/scoreboard-route.test.js
// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
// GET /state/scoreboard: validated before any SQL, scoped by the file's
// requestedAccount rule, read in the report worker (never on the event loop),
// and an unavailable report is the typed 503, never an empty 200.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'

async function fixture(t, { missing = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scoreboard-route-')), db = initDB(join(dir, 'agent.db'))
  db.prepare("INSERT INTO accounts(account_id, broker_label, enabled) VALUES ('111','P',1), ('222','P',1)").run()
  const ins = db.prepare(`INSERT INTO trades(symbol, side, status, account_id, net_pnl, realised_rr, closed_at_ms, source, close_reason)
    VALUES(?,?,?,?,?,?,?,?,?)`)
  const now = Date.now()
  for (let i = 0; i < 25; i++) ins.run('EURUSD', 'BUY', 'closed', '111', i % 2 ? 3 : -2, i % 2 ? 1 : -1, now - (i + 1) * 3_600_000, i % 4 ? 'autopilot' : 'manual', 'tp_hit')
  ins.run('XAUUSD', 'SELL', 'closed', '222', 12, 2, now - 3_600_000, 'autopilot', 'tp_hit')
  ins.run('XAUUSD', 'SELL', 'closed', '222', 50, 2, now - 3_600_000, 'autopilot', 'duplicate_adoption: superseded by trade 1')
  const conn = new Proxy(db, { get(target, key) {
    if (key === 'name' && missing) return join(dir, 'missing.db')
    const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v
  } })
  const app = express(); app.use('/state', stateRouter(conn))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { db, url: p => `http://127.0.0.1:${server.address().port}/state/scoreboard${p}` }
}

test('all accounts: per-account last 20 and window, superseded excluded, no main-thread trades read', async t => {
  const { db, url } = await fixture(t)
  const prepare = db.prepare
  let mainReads = 0
  db.prepare = sql => { if (/FROM trades/i.test(sql)) { mainReads++; throw Error('main-thread trades read') } return prepare.call(db, sql) }
  let res
  try { res = await fetch(url('?account=all&days=30')) } finally { db.prepare = prepare }
  assert.equal(res.status, 200)
  assert.equal(mainReads, 0, 'the scan runs in the report worker')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const body = await res.json()
  assert.equal(body.account, 'all'); assert.equal(body.days, 30)
  const a = body.accounts.find(x => x.accountId === '111'), b = body.accounts.find(x => x.accountId === '222')
  assert.equal(a.label, '…111')
  assert.equal(a.last20.n, 20); assert.equal(a.last20.rows.length, 20)
  assert.equal(a.days30.n, 25)
  assert.ok(a.last20.bot.n <= 20 && a.days30.bot.n < 25)
  assert.equal(b.last20.n, 1); assert.equal(b.last20.net, 12)
  assert.equal(body.excluded.superseded, 1)
  assert.deepEqual(Object.keys(a.last20.rows[0]).sort(), ['close_reason', 'closed_at', 'id', 'net_pnl', 'realised_rr', 'side', 'source', 'strategy', 'symbol'])
})

test('scope: an explicit id reads that account; omitted reads the selected account', async t => {
  const { db, url } = await fixture(t)
  const one = await (await fetch(url('?account=222'))).json()
  assert.deepEqual(one.accounts.map(x => x.accountId), ['222'])
  setState(db, 'ctrader_account_id', '111')
  const selected = await (await fetch(url(''))).json()
  assert.equal(selected.account, '111')
  assert.deepEqual(selected.accounts.map(x => x.accountId), ['111'])
  assert.equal(selected.days, 30, 'days defaults to 30')
})

test('invalid days or account is a 400 before any SQL', async t => {
  const { db, url } = await fixture(t)
  const prepare = db.prepare
  let reads = 0
  db.prepare = sql => { reads++; return prepare.call(db, sql) }
  try {
    for (const q of ['?days=0', '?days=366', '?days=1.5', '?days=abc', '?days=-3']) {
      const res = await fetch(url(`${q}&account=all`))
      assert.equal(res.status, 400, q)
      assert.equal((await res.json()).code, 'scoreboard_invalid_days')
    }
    const bad = await fetch(url('?account=abc'))
    assert.equal(bad.status, 400)
    assert.equal((await bad.json()).code, 'scoreboard_invalid_account')
  } finally { db.prepare = prepare }
  assert.equal(reads, 0)
})

test('a worker failure is the typed 503, never an empty scoreboard', async t => {
  const { url } = await fixture(t, { missing: true })
  const res = await fetch(url('?account=all'))
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const body = await res.json()
  assert.equal(body.code, 'scoreboard_unavailable')
  assert.equal(body.status, 'unavailable')
  assert.equal(body.reason, 'performance_report_worker_error')
  assert.equal('accounts' in body, false)
})
