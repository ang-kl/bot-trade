// node --test agent/stop-amend-rail.test.js
//
// The never-loosen rail and the stop policy at the executor (02-10-2026; owner:
// Opposite trigger + broker-side trailing). Behaviour, not source: the REAL
// executeBrokerAction and exec-engine (EXEC_ENGINE=cpp → POST /amend) against a
// stub gateway that answers like the sidecar's ratchet does.
//
// WHY A RAIL. Broker-side trailing means the BROKER moves a stop between the
// bot's reads. The ladder, the break-even lock and the Chandelier decide from
// the stored current_sl; before trailing that was the truth, now it can be
// looser than what the broker holds. The executor therefore asks the sidecar to
// read the live stop first and refuse to loosen (ratchetOnly), and stores what
// the broker holds, not what it was sent.
//
// loop.js memoises its prepared statements for the FIRST db it is handed, so
// every test here shares one db on purpose.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { initDB, setState } from './db.js'
import { prepareStatements, executeBrokerAction, stopAmendExtras, heldStop } from './loop.js'

const ENV_KEYS = ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'EXEC_ENGINE', 'EXEC_URL', 'EXEC_URL_DEMO', 'EXEC_URL_LIVE', 'EXEC_SECRET', 'EXEC_FALLBACK']
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

let server
let requests = []
let nextAmend = { status: 200, body: '{}' }
before(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: raw })
      const resp = req.url === '/amend' ? nextAmend : { status: 200, body: '{}' }
      res.writeHead(resp.status, { 'content-type': 'application/json' })
      res.end(resp.body)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.CTRADER_CLIENT_ID = 'fixture'
  process.env.CTRADER_CLIENT_SECRET = 'fixture'
  process.env.EXEC_ENGINE = 'cpp'
  process.env.EXEC_URL = `http://127.0.0.1:${server.address().port}`
  delete process.env.EXEC_URL_DEMO
  delete process.env.EXEC_URL_LIVE
  process.env.EXEC_SECRET = 'sekret'
  process.env.EXEC_FALLBACK = '0'
})
after(() => {
  server.close()
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
})

const db = (() => {
  const d = initDB(':memory:')
  setState(d, 'ctrader_account_id', '42')
  setState(d, 'ctrader_access_token', 'fixture')
  d.prepare(`INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES ('42', 0, 1, 'active')`).run()
  setState(d, 'symbol_id_map:42', JSON.stringify({ map: {}, builtAt: new Date().toISOString() }))
  return d
})()
const s = prepareStatements(db)

/** A monitored position + its trade. `book` also puts it in the momentum book. */
function position(positionId, { side = 'BUY', entry = 100, sl = 95, tp = 110, book = false } = {}) {
  const tradeId = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, status, ctrader_position_id, account_id, opened_at)
    VALUES ('EURUSD', ?, ?, 0.01, 'open', ?, '42', datetime('now'))`).run(side, entry, String(positionId)).lastInsertRowid
  const id = db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, status, account_id, source)
    VALUES ('EURUSD', ?, ?, ?, ?, ?, 'active', '42', 'autopilot')`).run(tradeId, side, entry, sl, tp).lastInsertRowid
  if (book) {
    db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entered_at, status)
      VALUES (?, '42', 'EURUSD', ?, 'long', ?, ?, datetime('now'), 'open')`).run(tradeId, String(positionId), entry, sl)
  }
  return db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(id)
}

const sentBody = () => JSON.parse(requests.find(r => r.url === '/amend').body)
const storedSl = (pos) => db.prepare('SELECT current_sl FROM monitored_positions WHERE id = ?').get(pos.id).current_sl
const slEvents = (pos) => db.prepare(`SELECT kind, to_value FROM position_events WHERE trade_id = ? AND kind = 'sl_moved'`).all(pos.trade_id)

test('stopAmendExtras: the policy context and the rail, and no rail when the side is unknown', () => {
  const pos = { side: 'long', entry_price: 100, trade_id: 1 }
  const ex = stopAmendExtras(db, pos, { positionId: 9 }, '42')
  assert.deepEqual(ex, { stopContext: { side: 'long', entry: 100, book: false }, ratchetOnly: true, expectedDirection: 1 })
  assert.equal(stopAmendExtras(db, { side: 'SELL', entry_price: 100 }, { positionId: 9 }, '42').expectedDirection, -1)
  const unknown = stopAmendExtras(db, { side: 'HOLD', entry_price: 100 }, { positionId: 9 }, '42')
  assert.equal('ratchetOnly' in unknown, false, 'no known side, no rail: the plain amend as before')
  assert.ok(!('expectedSymbolId' in ex), 'expectedSymbolId is never sent: symbol_id_map belongs to the selected account')
})

test('heldStop: the sidecar read-back wins over the sent value', () => {
  assert.equal(heldStop({ protection: { verified: true, stopLoss: 105 } }, 104), 105)
  assert.equal(heldStop({ protection: { stopLoss: null } }, 104), 104)
  assert.equal(heldStop({}, 104), 104)
  assert.equal(heldStop(undefined, 104), 104)
})

test('MOVE_SL on a long: Opposite, rail on, trailing only once the stop locks profit', async () => {
  requests = []
  nextAmend = { status: 200, body: '{}' }
  const risk = position(9401, { entry: 100, sl: 95 })
  const out1 = await executeBrokerAction(db, s, risk, { action: 'MOVE_SL', newSL: 97, reason: 'tighten below entry' }, 'position_manager')
  assert.equal(out1.error, undefined, JSON.stringify(out1))
  assert.deepEqual(sentBody(), { positionId: 9401, stopLoss: 97, takeProfit: 110, ctidTraderAccountId: 42, ratchetOnly: true, expectedDirection: 1, stopLossTriggerMethod: 2 },
    'a stop still below entry: Opposite and the rail, no trailing')
  requests = []
  const lock = position(9402, { entry: 100, sl: 95 })
  await executeBrokerAction(db, s, lock, { action: 'MOVE_SL', newSL: 101, reason: 'lock' }, 'position_manager')
  assert.deepEqual(sentBody(), { positionId: 9402, stopLoss: 101, takeProfit: 110, ctidTraderAccountId: 42, ratchetOnly: true, expectedDirection: 1, stopLossTriggerMethod: 2, trailingStopLoss: true },
    'a stop past entry: broker-side trailing is requested')
})

test('MOVE_SL on a short: direction -1 and the lock rule mirrored', async () => {
  requests = []
  const pos = position(9403, { side: 'SELL', entry: 100, sl: 105, tp: 90 })
  await executeBrokerAction(db, s, pos, { action: 'MOVE_SL', newSL: 99, reason: 'lock short' }, 'position_manager')
  assert.deepEqual(sentBody(), { positionId: 9403, stopLoss: 99, takeProfit: 90, ctidTraderAccountId: 42, ratchetOnly: true, expectedDirection: -1, stopLossTriggerMethod: 2, trailingStopLoss: true })
})

test('MOVE_SL on a momentum-book row: Opposite, never broker trailing (the book trails by its own daily rule)', async () => {
  requests = []
  const pos = position(9404, { entry: 100, sl: 95, book: true })
  await executeBrokerAction(db, s, pos, { action: 'MOVE_SL', newSL: 104, reason: 'book stop' }, 'position_manager')
  const body = sentBody()
  assert.equal(body.stopLossTriggerMethod, 2)
  assert.equal('trailingStopLoss' in body, false, 'one-horizon rule: a book row has one stop authority')
})

test('MOVE_SL on a position with no target: succeeds (explicit null, stripped before the wire), the broker gets no takeProfit', async () => {
  requests = []
  const pos = position(9405, { entry: 100, sl: 95, tp: null })
  const out = await executeBrokerAction(db, s, pos, { action: 'MOVE_SL', newSL: 97, reason: 'tp-less' }, 'position_manager')
  assert.equal(out.error, undefined, 'omitting takeProfit threw in assertAmendIntent before 02-10-2026')
  assert.equal('takeProfit' in sentBody(), false)
  assert.equal(storedSl(pos), 97)
})

test('the broker already holds a tighter stop: nothing is recorded as moved and the stored stop becomes the broker\'s', async () => {
  requests = []
  const pos = position(9406, { entry: 100, sl: 95 })
  // What the sidecar's ratchet answers when its live read finds the stop already tighter (engine.cpp: "already_tighter_snapshot").
  nextAmend = { status: 200, body: JSON.stringify({
    unchanged: true,
    protection: { verified: true, confirmation: 'already_tighter_snapshot', stopLoss: 103, takeProfit: 110, stopLossTriggerMethod: 2, trailingStopLoss: true },
    policy: { requested: { stopLossTriggerMethod: 2, trailingStopLoss: null }, applied: false, readback: 'confirmed', refused: null, skipped: null },
  }) }
  const out = await executeBrokerAction(db, s, pos, { action: 'MOVE_SL', newSL: 98, reason: 'stale decision' }, 'position_manager')
  assert.equal(out.error, undefined)
  assert.equal(out.unchanged, true)
  assert.match(out.summary, /SL kept 103\.00000 \(broker already tighter than 98\.00000\)/)
  assert.equal(out.protection.stopLoss, 103)
  assert.equal(out.policy.readback, 'confirmed')
  assert.equal(storedSl(pos), 103, 'the stored stop is the broker\'s, so the next decision starts from the truth')
  assert.deepEqual(slEvents(pos), [], 'no sl_moved event: nothing moved at the broker')
})

test('a moved stop is recorded as sent when the read-back agrees, and the outcome carries the confirmation', async () => {
  requests = []
  const pos = position(9407, { entry: 100, sl: 95 })
  nextAmend = { status: 200, body: JSON.stringify({ unchanged: false, protection: { verified: true, stopLoss: 101, takeProfit: 110 }, policy: { applied: true, readback: 'confirmed', refused: null, skipped: null } }) }
  const out = await executeBrokerAction(db, s, pos, { action: 'MOVE_SL', newSL: 101, reason: 'lock' }, 'position_manager')
  assert.match(out.summary, /^SL → 101\.00000/)
  assert.equal(out.unchanged, undefined)
  assert.equal(out.protection.verified, true)
  assert.equal(storedSl(pos), 101)
  assert.deepEqual(slEvents(pos).map(e => e.to_value), [101])
  nextAmend = { status: 200, body: '{}' }
})

test('a sidecar refusal of the rail (stale identity) is reported to the caller and records nothing', async () => {
  requests = []
  const pos = position(9408, { entry: 100, sl: 95 })
  nextAmend = { status: 502, body: JSON.stringify({ errorCode: 'guard_ratchet_identity', description: 'broker position direction/symbol mismatch' }) }
  const out = await executeBrokerAction(db, s, pos, { action: 'MOVE_SL', newSL: 98, reason: 'wrong position' }, 'position_manager')
  assert.match(out.error, /guard_ratchet_identity/)
  assert.equal(storedSl(pos), 95)
  assert.deepEqual(slEvents(pos), [])
  nextAmend = { status: 200, body: '{}' }
})
