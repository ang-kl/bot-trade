import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import { hourlyOpenings } from './hourly-openings.js'
import stateRouter from '../routes/state.js'
import { openingEvidence, openingCountLabel } from '../../src/lib/hourly-openings.js'

const HOUR = 3600_000
const TO = Date.parse('2026-09-22T06:20:00.123Z')
const FROM = TO - 24 * HOUR
const scope = { all: false, accountId: '11', explicit: true }
function fixture(t) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  for (const id of ['11', '22']) db.prepare('INSERT INTO accounts (account_id) VALUES (?)').run(id)
  const insert = db.prepare('INSERT INTO trades (symbol, status, account_id, opened_at, net_pnl, origin) VALUES (?, ?, ?, ?, ?, ?)')
  return {
    db,
    add: ({ status = 'open', account = '11', at = TO - 1, pnl = null, origin = null } = {}) =>
      insert.run('EURUSD', status, account, typeof at === 'number' ? new Date(at).toISOString() : at, pnl, origin),
    read: (s = scope) => hourlyOpenings(db, s, { to: TO, nowMs: TO + 1000 }),
  }
}

test('opening population includes still-open and unpriced closed rows, excludes failed/pending intents', t => {
  const { add, read } = fixture(t)
  for (const status of ['open', 'closed', 'rejected', 'cancelled', 'submitting', 'unconfirmed']) add({ status })
  const report = read()
  assert.equal(report.openedN, 2)
  assert.equal(report.rows.at(-1).openedN, 2)
  assert.equal(report.source, 'local_trade_ledger')
  assert.equal(report.brokerReconciled, false)
})

test('all confirmed openings beyond the journal cap are counted without paging or P&L bias', t => {
  const { db, add, read } = fixture(t)
  db.transaction(() => { for (let i = 0; i < 1205; i++) add({ status: i % 2 ? 'open' : 'closed' }) })()
  assert.equal(read().openedN, 1205)
  assert.equal(read().rows.length, 24)
})

test('half-open millisecond boundaries assign each opening once, with UTC text and offsets', t => {
  const { add, read } = fixture(t)
  for (const at of [FROM - 1, FROM, FROM + HOUR - 1, FROM + HOUR, TO - 1, TO]) add({ at })
  add({ at: '2026-09-22 06:19:59.999' })
  add({ at: '2026-09-22T14:19:59.999+08:00' })
  const r = read()
  assert.equal(r.openedN, 6)
  assert.equal(r.rows[0].openedN, 2)
  assert.equal(r.rows[1].openedN, 1)
  assert.equal(r.rows.at(-1).openedN, 3)
  assert.equal(r.rows.reduce((n, h) => n + h.openedN, 0), r.openedN)
})

test('account isolation retains and names the existing NULL-account convention', t => {
  const { add, read } = fixture(t)
  add({ account: '11' }); add({ account: '22' }); add({ account: '22' }); add({ account: null })
  assert.equal(read().openedN, 2)
  assert.equal(read().legacyN, 1)
  assert.equal(read({ ...scope, accountId: '22' }).openedN, 3)
  const all = read({ all: true, accountId: null, explicit: true })
  assert.equal(all.accountId, 'all')
  assert.equal(all.openedN, 4)
  assert.equal(all.legacyN, 1)
})

test('invalid opening times stay visible as uncertainty; adoption time is not claimed as broker time', t => {
  const { add, read } = fixture(t)
  add({ at: null }); add({ at: 'not-a-time' }); add({ at: null, account: '22' })
  add({ origin: 'reconciler_adopted' })
  const r = read()
  assert.equal(r.unknownTimeN, 2)
  assert.equal(r.openedN, 1)
  assert.equal(r.adoptedN, 1)
  assert.equal(openingCountLabel(r.rows.at(-1).openedN, r.unknownTimeN), '≥1')
  assert.equal(openingCountLabel(r.rows[0].openedN, r.unknownTimeN), 'unknown')
})

test('a successful empty read is zero; a broken ledger query is not', t => {
  const { db, read } = fixture(t)
  assert.equal(read().openedN, 0)
  assert.equal(read().unknownTimeN, 0)
  db.exec('DROP TABLE trades')
  assert.throws(read)
})

test('the real HTTP consumer validates explicit scope/window and handles ledger unavailability', async t => {
  const { db, add } = fixture(t)
  add()
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const get = query => fetch(`http://127.0.0.1:${server.address().port}/state/hourly-openings${query}`)
  for (const q of ['', `?to=${TO}`, `?account=33&to=${TO}`, '?account=11&to=no', `?account=11&to=${Date.now() + HOUR}`, `?account=11&to=${TO}&to=${TO}`]) {
    assert.equal((await get(q)).status, 400, q)
  }
  const report = await (await get(`?account=11&to=${TO}`)).json()
  assert.equal(report.openedN, 1)
  assert.ok(openingEvidence(report, { accountId: '11', to: TO }))
  assert.equal(openingEvidence(report, { accountId: '22', to: TO }), null)
  db.exec('DROP TABLE trades')
  const failed = await get(`?account=22&to=${TO}`)
  assert.equal(failed.status, 503)
  assert.equal((await failed.json()).error, 'opening evidence unavailable')
})
