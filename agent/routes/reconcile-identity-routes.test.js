// node --test agent/routes/reconcile-identity-routes.test.js
//
// The reconcile identity guard at the reads that ACT on what they find
// (02-10-2026; № 10,448 follow-up). At 30-09 07:45:55Z one reconcile reply
// asked for …0058 carried …9908's positions and the main loop adopted them and
// closed …0058's own. The main loop's two reads got the guard in #1181; four
// others did not: the exit-volume snapshot (loop.js), findLivePosition
// (position-reverse / position-close) and the close-all and position-double
// routes. close-all closes EVERYTHING in the reply, so a foreign snapshot is a
// flatten of another account's book. Behaviour through the real routes against
// a sidecar that answers a scripted reconcile reply.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import express from 'express'
import { initDB, setState } from '../db.js'
import { upsertAccount } from '../services/account-registry.js'
import actionsRouter from './actions.js'
import { assertReconcileIdentity } from '../services/reconciler.js'
import { invalidateSidecarSession } from '../lib/exec-engine.js'

const ACCOUNT = '22'
const ENV_KEYS = ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'EXEC_ENGINE', 'EXEC_URL', 'EXEC_URL_DEMO', 'EXEC_URL_LIVE', 'EXEC_SECRET', 'EXEC_FALLBACK']
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
after(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

/** A sidecar whose reconcile reply is scripted; every write it receives is recorded. */
async function sidecar(t, reply) {
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      requests.push({ url: req.url, body: raw ? JSON.parse(raw) : undefined })
      const body = req.url === '/positions' ? JSON.stringify(reply()) : '{}'
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(body)
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  Object.assign(process.env, { CTRADER_CLIENT_ID: 'x', CTRADER_CLIENT_SECRET: 'x', EXEC_ENGINE: 'cpp', EXEC_URL: `http://127.0.0.1:${server.address().port}`, EXEC_SECRET: 's', EXEC_FALLBACK: '0' })
  delete process.env.EXEC_URL_DEMO; delete process.env.EXEC_URL_LIVE
  invalidateSidecarSession()
  return { writes: () => requests.filter(r => r.url === '/close' || r.url === '/order' || r.url === '/amend') }
}

async function serve(t) {
  const db = initDB(':memory:')
  const token = 'sess_cccccccccccccccccccccccccccccccccccccccccccccccccc'
  setState(db, 'device_sessions', JSON.stringify({ [token]: Date.now() + 60_000 }))
  setState(db, 'ctrader_account_id', ACCOUNT)
  setState(db, 'ctrader_access_token', 'tok')
  upsertAccount(db, { accountId: ACCOUNT, isLive: false })
  const app = express(); app.use(express.json())
  app.use('/actions', actionsRouter(db))
  const server = app.listen(0)
  t.after(() => { server.close(); db.close() })
  return async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    return { status: r.status, data: await r.json() }
  }
}

const position = id => ({ positionId: id, tradeData: { symbolId: 1, tradeSide: 'BUY', volume: 1000 }, stopLoss: 1, takeProfit: 3 })
const reply = (account, ids = ['501', '502']) => () => ({ ...(account == null ? {} : { ctidTraderAccountId: Number(account) }), position: ids.map(position) })

test('close-all: a reply naming ANOTHER account closes nothing and says why', async t => {
  const sc = await sidecar(t, reply('99'))
  const post = await serve(t)
  const out = await post('/actions/close-all', { confirm: true })
  assert.ok(out.status >= 400, JSON.stringify(out))
  assert.match(out.data.error, /reconcile identity refused/)
  assert.deepEqual(sc.writes(), [], 'no close reached the broker')
})

test('close-all: a reply naming the asked account still closes its positions (the guard does not stall the route)', async t => {
  const sc = await sidecar(t, reply(ACCOUNT))
  const post = await serve(t)
  const out = await post('/actions/close-all', { confirm: true })
  assert.equal(out.status, 200, JSON.stringify(out))
  assert.deepEqual(sc.writes().map(w => w.url), ['/close', '/close'])
})

test('close-all: a reply naming no account is "unverifiable" and proceeds, as in the main loop', async t => {
  const sc = await sidecar(t, reply(null))
  const post = await serve(t)
  const out = await post('/actions/close-all', { confirm: true })
  assert.equal(out.status, 200, JSON.stringify(out))
  assert.equal(sc.writes().length, 2)
})

test('position-double: a foreign reply places no order', async t => {
  const sc = await sidecar(t, reply('99', ['501']))
  const post = await serve(t)
  const out = await post('/actions/position-double', { positionId: '501' })
  assert.ok(out.status >= 400, JSON.stringify(out))
  assert.match(out.data.error, /reconcile identity refused/)
  assert.deepEqual(sc.writes(), [], 'nothing was sent to the broker')
})

test('position-reverse (findLivePosition): a foreign reply neither closes nor opens', async t => {
  const sc = await sidecar(t, reply('99', ['501']))
  const post = await serve(t)
  const out = await post('/actions/position-reverse', { positionId: '501' })
  assert.ok(out.status >= 400, JSON.stringify(out))
  assert.match(out.data.error, /reconcile identity refused/)
  assert.deepEqual(sc.writes(), [])
})

test('assertReconcileIdentity: foreign throws with a code and the reply account, own and unnamed pass', () => {
  assert.throws(() => assertReconcileIdentity({ ctidTraderAccountId: 99, position: [] }, '22', 'x'),
    e => e.code === 'RECONCILE_IDENTITY_REFUSED' && e.replyAccount === '99' && /x: reconcile identity refused/.test(e.message))
  assert.equal(assertReconcileIdentity({ ctidTraderAccountId: 22 }, '22').verified, true)
  assert.equal(assertReconcileIdentity({ ctidTraderAccountId: '22.0' }, 22).verified, true, 'number/string/".0" spellings agree')
  assert.equal(assertReconcileIdentity({}, '22').verified, false)
})

// loop.js's exit-volume snapshot is a closure inside executeBrokerAction with no
// injection point: pinned by comment-stripped source (a last resort, per CLAUDE.md #2).
test('the exit-volume snapshot in loop.js checks the reply identity before it reads positions', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  const at = src.indexOf('const brokerSnapshot = async () => {')
  assert.ok(at > 0, 're-anchor: brokerSnapshot not found')
  const body = src.slice(at, src.indexOf('if (action === \'FULL_EXIT\')', at))
  const read = body.indexOf('await execReconcile(')
  const guard = body.indexOf("assertReconcileIdentity(rec, accountId, 'exit snapshot')")
  const use = body.indexOf('rec.position')
  assert.ok(read > 0 && guard > read && use > guard, 'read, then the identity check, then the positions are used')
})
