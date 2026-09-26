// node --test agent/routes/named-corrections-route.test.js
//
// V3 B2b (docs/v3-integrated-plan-2026-09-26.md §5 row 2.6, §6 OD-12; checker
// fix round N2). Pins that POST /actions/named-corrections reads `apply`
// STRICTLY as the JSON boolean `true` — a string `"true"`, a query-string
// `?apply=true`, and an empty body all read as dry run, and only a body of
// `{ apply: true }` (boolean) writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { EVIDENCE_RULES } from '../services/position-lifecycle-evidence.js'
import actionsRouter from './actions.js'

const TOKEN = 'sess_cccccccccccccccccccccccccccccccccccccccccccccccc'
const DEMO = '46130058'

function serve() {
  const db = initDB(':memory:')
  setState(db, 'device_sessions', JSON.stringify({ [TOKEN]: Date.now() + 86_400_000 }))
  db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,0,1,'active')").run(DEMO)
  // A never-filled candidate (open, non-final rejected-only evidence) —
  const openId = db.prepare(`INSERT INTO trades (account_id, symbol, side, status, ctrader_position_id, opened_at, entry_price, sl_price, volume)
      VALUES (?, 'EURUSD', 'BUY', 'open', '700', datetime('now'), 1.1, 1.05, 1)`).run(DEMO).lastInsertRowid
  db.prepare(`INSERT INTO position_lifecycle_evidence (account_id, position_id, verdict, final, rules, reason, read_at)
      VALUES (?, '700', 'never_filled', 1, ?, 'the broker holds 2 deal(s) and none executed', datetime('now'))`).run(DEMO, EVIDENCE_RULES)
  // A named money correction target — matches NAMED_MONEY_CORRECTIONS' #1253.
  const moneyId = db.prepare(`INSERT INTO trades (id, account_id, symbol, side, status, ctrader_position_id, opened_at, closed_at,
      entry_price, exit_price, sl_price, volume, net_pnl) VALUES (1253, ?, 'GBPUSD', 'BUY', 'closed', '1253', datetime('now','-2 day'),
      datetime('now','-1 day'), 1.2, 1.3, 1.15, 1, 864)`).run(DEMO).lastInsertRowid
  const app = express()
  app.use(express.json())
  app.use('/actions', actionsRouter(db))
  const server = app.listen(0)
  return { db, server, base: `http://127.0.0.1:${server.address().port}`, openId, moneyId }
}

const post = (base, { body, query = '' } = {}) => fetch(`${base}/actions/named-corrections${query}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify(body ?? {}),
})

const rowSnap = (db, id) => db.prepare('SELECT status, net_pnl FROM trades WHERE id = ?').get(id)

test('an empty body writes nothing', async () => {
  const { db, server, base, openId, moneyId } = serve()
  try {
    const before = [rowSnap(db, openId), rowSnap(db, moneyId)]
    const body = await (await post(base)).json()
    assert.equal(body.ok, true, JSON.stringify(body))
    assert.equal(body.dryRun, true)
    assert.equal(body.neverFilled.found, 1)
    // The full built-in NAMED_MONEY_CORRECTIONS list (5 entries) is always
    // evaluated; only #1253 exists in this fixture, so it is the one
    // non-stale row and the other four are "row not found".
    assert.equal(body.money.found, 5)
    assert.equal(body.money.stale, 4)
    const moneyRow = body.money.rows.find(r => r.id === moneyId)
    assert.deepEqual([moneyRow.old, moneyRow.new, moneyRow.stale], [864, 1368.5, false])
    assert.deepEqual([rowSnap(db, openId), rowSnap(db, moneyId)], before)
  } finally { server.close() }
})

test('{ apply: "true" } (a STRING, not a boolean) writes nothing — dry run', async () => {
  const { db, server, base, openId, moneyId } = serve()
  try {
    const before = [rowSnap(db, openId), rowSnap(db, moneyId)]
    const body = await (await post(base, { body: { apply: 'true' } })).json()
    assert.equal(body.dryRun, true, JSON.stringify(body))
    assert.deepEqual([rowSnap(db, openId), rowSnap(db, moneyId)], before)
  } finally { server.close() }
})

test('?apply=true as a QUERY PARAM (with an empty JSON body) writes nothing — the route reads req.body only', async () => {
  const { db, server, base, openId, moneyId } = serve()
  try {
    const before = [rowSnap(db, openId), rowSnap(db, moneyId)]
    const body = await (await post(base, { query: '?apply=true' })).json()
    assert.equal(body.dryRun, true, JSON.stringify(body))
    assert.deepEqual([rowSnap(db, openId), rowSnap(db, moneyId)], before)
  } finally { server.close() }
})

test('{ apply: true } (a JSON boolean) applies the full tier — both the never-filled rejection and the named money correction', async () => {
  const { db, server, base, openId, moneyId } = serve()
  try {
    const body = await (await post(base, { body: { apply: true } })).json()
    assert.equal(body.ok, true, JSON.stringify(body))
    assert.equal(body.dryRun, false)
    assert.equal(body.neverFilled.applied, 1, JSON.stringify(body))
    assert.equal(body.money.applied, 1, JSON.stringify(body))
    assert.equal(rowSnap(db, openId).status, 'rejected')
    assert.equal(rowSnap(db, moneyId).net_pnl, 1368.5)
  } finally { server.close() }
})

test('a dry-run POST logs nothing from THIS handler — only index.js\'s /actions request middleware (mounted before this router in production) logs anything for it', async () => {
  // Same shape as origin-backfill-route.test.js's auth-ordering test: the
  // logging middleware lives in index.js, not in actions.js, so a harness
  // that mounts actionsRouter(db) directly (as this file and that one both
  // do) never sees it — asserting on index.js's SOURCE is the honest way to
  // pin it, rather than re-wiring the middleware into the test and testing
  // the test's own scaffold.
  const { db, server, base } = serve()
  try {
    await post(base)
    // This handler itself writes nothing on a dry run.
    const applyRow = db.prepare("SELECT COUNT(*) AS n FROM action_log WHERE method = 'NAMED_CORRECTION_APPLY'").get()
    assert.equal(applyRow.n, 0, 'no NAMED_CORRECTION_APPLY row on a dry run')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM action_log').get().n, 0, 'this test harness (no index.js middleware mounted) sees no row at all — confirming the row seen in production comes from that middleware, not this handler')

    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    const mw = src.indexOf("app.use('/actions', (req, _res, next) => {")
    const insert = src.indexOf("INSERT INTO action_log (method, path, body, account_id)")
    const mount = src.indexOf("app.use('/actions', actionsRouter(db))")
    const postOnly = src.indexOf("if (req.method === 'POST') {")
    assert.ok(mw > 0, 'the /actions logging middleware moved or was removed in index.js — re-point this test, do not delete it')
    assert.ok(insert > mw && insert < mount, 'the middleware no longer inserts into action_log before the router mounts')
    assert.ok(postOnly > mw && postOnly < insert, 'the middleware no longer gates on POST — it would then also log every GET')
  } finally { server.close() }
})
