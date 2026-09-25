// agent/services/order-writers-l2a.test.js — V3 L2a, the pre-order and order
// writer fixes of LIFECYCLE-SPEC §7 (W1, W5, W6, W7, W8, W9, W14).
//
// Every test here exercises the writer and reads back the row it wrote. The
// few source pins are comment-stripped and bounded, and each sits beside a
// behavioural test of the same writer (failure modes #2 and #4): the pin
// only holds the call site the behaviour cannot reach without a broker.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'

import { initDB, getState, setState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { attachEntryFence, bindEntryIntent } from '../lib/ctrader-creds.js'
import { placeOrder, _resetOrderLocks } from '../lib/exec-engine.js'
import { reserveEntry, reconcileIntents } from './entry-ledger.js'
import { fillEvidence } from './intent-corrections.js'
import { placeClosedMarketLimit, reconcileStaleClosedMarketLimits, findLimitFill } from './closed-market-limits.js'
import { stampAdoptedFromIntent, INTENT_APPROVAL_WINDOW_SQL } from './reconciler.js'
import { persistFilledTrade } from './pending-orders.js'
import { PLAN_WRITE_FAILED_PATH, recordPlanWriteFailure } from './trade-plans.js'
import { writeAheadAnalysisTrade, failAnalysisTrade, settleAnalysisTrade, validationFillDirectionReason } from '../routes/actions.js'
import { withTransitionSince, writeEngineStatus, engineStatusFor, requestEntryMode, ENGINE_STATUS_KEY } from './entry-mode.js'
import { validateEngineStatus } from '../lib/entry-contracts.js'
import { getAccountState } from './account-registry.js'
import { labelIntentId } from '../lib/trade-labels.js'

const DEMO = '46130058'
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const src = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'))
const tagged = (id) => `PRE|v1|MR|H|NY|1d|TR|${id}`

function freshDb() {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: DEMO, isLive: false })
  return db
}
/** A plan write that FAILS: the table refuses the insert (the W7 input). */
function refusePlans(db) {
  db.exec(`CREATE TRIGGER l2a_refuse_plan BEFORE INSERT ON trade_plans BEGIN SELECT RAISE(ABORT, 'plan write refused (test)'); END`)
}
const planFailures = (db) => db.prepare(`SELECT body, account_id FROM action_log WHERE path = ?`).all(PLAN_WRITE_FAILED_PATH).map(r => ({ ...JSON.parse(r.body), account_id: r.account_id }))
// X1 (merged before this file): a resting order's intent is ACCEPTED ("placed,
// not filled") until broker evidence moves it — so that is the default a
// resting fixture carries; a MARKET fixture is FILLED, as its answer settles it.
function insertIntent(db, { id, accountId = DEMO, symbol = 'DOW.US', side = 'SELL', orderType = 'LIMIT', state = String(orderType).toUpperCase() === 'MARKET' ? 'FILLED' : 'ACCEPTED', brokerOrderId = null, brokerPositionId = null }) {
  db.prepare(`INSERT INTO entry_intents (id, account_id, environment, symbol, side, order_type, producer_id, basis, mode_epoch, permit_id, permit_expires_at, state, broker_order_id, broker_position_id)
              VALUES (?, ?, 'demo', ?, ?, ?, 'daily_momentum_account', 'bar', 0, ?, '2026-01-01T00:00:00Z', ?, ?, ?)`)
    .run(id, accountId, symbol, side, orderType, 'p' + id.slice(1), state, brokerOrderId, brokerPositionId)
}

// ---------------------------------------------------------------------------
// A stub sidecar, so the REAL exec-engine.placeOrder runs its real ledger
// protocol (reserve → redeem → markSent → send → settle) against a real DB.
// ---------------------------------------------------------------------------
let server
let onOrder = () => ({ status: 200, body: '{}' })
const saved = {}
before(async () => {
  for (const k of ['EXEC_ENGINE', 'EXEC_URL', 'EXEC_SECRET']) saved[k] = process.env[k]
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const resp = req.url === '/order' ? onOrder(JSON.parse(raw || '{}')) : { status: 200, body: '{}' }
      res.writeHead(resp.status, { 'content-type': 'application/json' })
      res.end(resp.body)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.EXEC_URL = `http://127.0.0.1:${server.address().port}`
  process.env.EXEC_SECRET = 'sekret'
})
after(() => {
  server.close()
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
})
beforeEach(() => { process.env.EXEC_ENGINE = 'cpp'; _resetOrderLocks() })

const ORDER = { symbolId: 41, tradeSide: 'BUY', orderType: 'MARKET', volume: 100000, relativeStopLoss: 50000, relativeTakeProfit: 50000, label: 'AU|v1|MR|H|NY|1d|TR' }
const BASE_CREDS = { host: 'demo.ctraderapi.com', clientId: 'ci', clientSecret: 'cs', accessToken: 'at', accountId: DEMO }

// ======================================================================= W5/W6
test('W5/W6 end to end: the intent the send reserves carries the approval, and its id is on the write-ahead row BEFORE the order reaches the sidecar', async () => {
  const db = freshDb()
  const tradeId = Number(db.prepare(`INSERT INTO trades (symbol, side, status, account_id, origin, origin_source) VALUES ('DOW.US', 'BUY', 'submitting', ?, 'bot_market_dispatch', 'write')`).run(DEMO).lastInsertRowid)
  let atSend = 'not sent'
  let sentLabel = null
  onOrder = (body) => {
    atSend = db.prepare(`SELECT intent_id FROM trades WHERE id = ?`).get(tradeId).intent_id
    sentLabel = body.label
    return { status: 200, body: '{"executionType":"ORDER_FILLED","position":{"positionId":777},"order":{"orderId":555}}' }
  }
  let reserved = null
  const creds = bindEntryIntent(attachEntryFence(db, BASE_CREDS, { producerId: 'daily_momentum_account' }), {
    riskEventId: 4242,
    onReserved: (id) => { reserved = id; db.prepare(`UPDATE trades SET intent_id = ? WHERE id = ?`).run(id, tradeId) },
  })
  await placeOrder(creds, { ...ORDER })
  const intent = db.prepare(`SELECT * FROM entry_intents WHERE id = ?`).get(reserved)
  assert.ok(intent, 'the send reserved a real intent row')
  assert.equal(intent.risk_event_id, 4242, 'W5: the bar intent names its approval (RED if bindEntryIntent drops riskEventId)')
  assert.equal(intent.state, 'FILLED'); assert.equal(intent.broker_position_id, '777')
  assert.equal(atSend, reserved, 'W6: the write-ahead row named its intent before anything reached the sidecar')
  assert.equal(labelIntentId(sentLabel), reserved, 'the broker label carries the same id the row names')
})

test('W5/W6: a throwing onReserved never blocks the order; creds without a ledger are returned as they were', async () => {
  const db = freshDb()
  let sent = 0
  onOrder = () => { sent++; return { status: 200, body: '{"position":{"positionId":9}}' } }
  const creds = bindEntryIntent(attachEntryFence(db, BASE_CREDS, { producerId: 'daily_momentum_account' }), {
    riskEventId: 7, onReserved: () => { throw new Error('link write failed') },
  })
  await placeOrder(creds, { ...ORDER, symbolId: 42 })
  assert.equal(sent, 1, 'the link is a record, the order is money')
  const bare = { ...BASE_CREDS }
  assert.equal(bindEntryIntent(bare, { riskEventId: 1 }), bare, 'no ledger, nothing wrapped')
  // no riskEventId: the reservation carries none (NULL, never invented)
  const seen = []
  const fake = { entryLedger: { reserve: (o) => { seen.push(o); return { ok: true, intentId: 'iabcdefabcdef' } } } }
  bindEntryIntent(fake, {}).entryLedger.reserve({ side: 'BUY' })
  assert.equal('riskEventId' in seen[0], false)
})

test('W5: reserveEntry stores the risk event it is given, and NULL when none (or garbage) is given', () => {
  const db = freshDb()
  const a = reserveEntry(db, { accountId: DEMO, producerId: 'daily_momentum_account', symbol: 'EURUSD', symbolId: 1, side: 'BUY', riskEventId: 991 })
  const b = reserveEntry(db, { accountId: DEMO, producerId: 'daily_momentum_account', symbol: 'GBPUSD', symbolId: 2, side: 'BUY' })
  const c = reserveEntry(db, { accountId: DEMO, producerId: 'daily_momentum_account', symbol: 'AUDUSD', symbolId: 3, side: 'BUY', riskEventId: 'x' })
  const read = (r) => db.prepare(`SELECT risk_event_id FROM entry_intents WHERE id = ?`).get(r.intentId).risk_event_id
  assert.equal(read(a), 991); assert.equal(read(b), null); assert.equal(read(c), null)
})

test('W5: a resting limit placement binds its approval to the intent and records the intent on its pending row', async () => {
  const db = freshDb()
  setState(db, 'symbol_id_map', JSON.stringify({ US30: 7 }))
  const risk = { loadRiskConfig: () => ({}), evaluateTrade: () => ({ approved: true, adjusted_volume: 0.1 }), persistRiskEvent: () => 777 }
  const exec = {
    // exec-engine's protocol, reduced to the part under test: it reserves
    // through the ledger on the creds it is handed.
    placeOrder: async (c, p) => { const r = c.entryLedger.reserve({ symbolId: p.symbolId, side: p.tradeSide, orderType: 'LIMIT', volume: p.volume }); assert.ok(r.ok, r.reason); return { order: { orderId: 9001 } } },
    cancelOrder: async () => ({}),
  }
  const sizing = { getVolumeMeta: async () => ({ digits: 2, lotSize: 100, minVolume: 1 }), lotsToVolume: (l) => ({ volume: Math.round(l * 100), belowMin: false }), relativePoints: (d, dg) => Math.round(d * 10 ** dg) }
  const creds = attachEntryFence(db, { ...BASE_CREDS }, { producerId: 'daily_momentum_account' })
  const r = await placeClosedMarketLimit(db, creds, 'US30', { consensus_bias: 'long', entry: 100, sl: 98, tp1: 104, strategy: 'tsmom_long', timeframe: '1d', direction_reason: 'tsmom:long_top_band' },
    { producerId: 'daily_momentum_account', risk, exec, sizing, now: Date.parse('2026-09-25T12:00:00Z') })
  assert.equal(r.placed, true, JSON.stringify(r))
  const row = db.prepare(`SELECT intent_id, risk_event_id FROM pending_orders WHERE symbol = 'US30'`).get()
  assert.match(row.intent_id ?? '', /^i[0-9a-z]{12}$/, 'the resting row names the intent that placed it')
  assert.equal(row.risk_event_id, 777)
  assert.equal(db.prepare(`SELECT risk_event_id FROM entry_intents WHERE id = ?`).get(row.intent_id).risk_event_id, 777, 'and that intent names the approval')
})

// ========================================================================= W9
function workingLimit(db, over = {}) {
  const row = { symbol: 'DOW.US', order_id: '901', dir: -1, level: 29.84, sl: 30.1, tp: 29.2, placed_at: '2026-09-25T10:00:00Z', expires_at: '2026-09-28T00:00:00Z', status: 'working', note: 'pending-closed', account_id: DEMO, risk_event_id: 5150, strategy: 'tsmom_long', timeframe: '1d', intent_id: null, ...over }
  const cols = Object.keys(row)
  return Number(db.prepare(`INSERT INTO pending_orders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row)).lastInsertRowid)
}
const NOW = Date.parse('2026-09-25T12:00:00Z')

test('W9: the fill is the trade the intent produced — matched case-insensitively — and it is stamped as the bot\'s resting fill', () => {
  const db = freshDb()
  const pid = workingLimit(db, { intent_id: 'idow00000901' })
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status, account_id) VALUES ('901', 'DOW.US', 'gone', ?)`).run(DEMO)
  // The adopted row carries the broker's spelling of the symbol.
  const tid = Number(db.prepare(`INSERT INTO trades (symbol, side, status, account_id, origin, origin_source, label_raw, opened_at) VALUES ('dow.us', 'SELL', 'open', ?, 'reconciler_adopted', 'write', ?, '2026-09-25T11:00:00Z')`).run(DEMO, tagged('idow00000901')).lastInsertRowid)
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: NOW })
  assert.equal(r.filled, 1, 'RED if the symbol match is case-sensitive')
  const p = db.prepare(`SELECT status, note FROM pending_orders WHERE id = ?`).get(pid)
  assert.equal(p.status, 'filled'); assert.match(p.note, new RegExp(`trade #${tid} \\(intent idow00000901 via pending_orders\\.intent_id\\)`))
  const t = db.prepare(`SELECT origin, origin_source, strategy, intent_id, risk_event_id FROM trades WHERE id = ?`).get(tid)
  assert.deepEqual(t, { origin: 'bot_pending_fill', origin_source: 'limit_link', strategy: 'tsmom_long', intent_id: 'idow00000901', risk_event_id: 5150 })
  const plan = db.prepare(`SELECT source, planned_entry, planned_sl, side FROM trade_plans WHERE trade_id = ?`).get(tid)
  assert.deepEqual(plan, { source: 'closed_market_limit_fill', planned_entry: 29.84, planned_sl: 30.1, side: 'SELL' })
})

test('W9: THE HEURISTIC IS GONE — a same-account, same-symbol, same-side trade opened after placement, with no evidence, is NOT credited as the fill', () => {
  const db = freshDb()
  const pid = workingLimit(db, { order_id: '902' })
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status, account_id) VALUES ('902', 'DOW.US', 'gone', ?)`).run(DEMO)
  const tid = Number(db.prepare(`INSERT INTO trades (symbol, side, status, account_id, origin, label_raw, opened_at) VALUES ('DOW.US', 'SELL', 'open', ?, 'reconciler_adopted', 'PRE|v1|MR|H|NY|1d|TR', '2026-09-25T11:00:00Z')`).run(DEMO).lastInsertRowid)
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: NOW })
  assert.equal(r.filled, 0, '"the first trade on this symbol since placement" links nothing any more')
  assert.equal(r.expired, 1)
  assert.match(db.prepare(`SELECT note FROM pending_orders WHERE id = ?`).get(pid).note, /no intent evidence for this order/)
  const t = db.prepare(`SELECT origin, risk_event_id, intent_id FROM trades WHERE id = ?`).get(tid)
  assert.deepEqual(t, { origin: 'reconciler_adopted', risk_event_id: null, intent_id: null }, 'an unrelated trade is left exactly as it was')
})

test('W9: a row with no intent column is linked through the intent whose broker_order_id is its order, or the tag on the broker\'s order label', () => {
  const db = freshDb()
  // (a) entry_intents.broker_order_id — settleIntent recorded the order id
  insertIntent(db, { id: 'ilegacy00903', brokerOrderId: '903' })
  workingLimit(db, { order_id: '903' })
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status, account_id) VALUES ('903', 'DOW.US', 'gone', ?)`).run(DEMO)
  const t1 = Number(db.prepare(`INSERT INTO trades (symbol, side, status, account_id, origin, label_raw) VALUES ('DOW.US', 'SELL', 'open', ?, 'reconciler_adopted', ?)`).run(DEMO, tagged('ilegacy00903')).lastInsertRowid)
  // (b) the tag on broker_orders.label — no intent row survives
  workingLimit(db, { order_id: '904', symbol: 'US30' })
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status, account_id, label) VALUES ('904', 'US30', 'gone', ?, ?)`).run(DEMO, tagged('ibrokerlab904'))
  const t2 = Number(db.prepare(`INSERT INTO trades (symbol, side, status, account_id, origin, intent_id) VALUES ('US30', 'SELL', 'open', ?, 'reconciler_adopted', 'ibrokerlab904')`).run(DEMO).lastInsertRowid)
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: NOW })
  assert.equal(r.filled, 2)
  assert.equal(findLimitFill(db, { symbol: 'DOW.US', order_id: '903', dir: -1, account_id: DEMO }).via, 'entry_intents.broker_order_id')
  assert.equal(findLimitFill(db, { symbol: 'US30', order_id: '904', dir: -1, account_id: DEMO }).via, 'broker_orders.label')
  assert.equal(db.prepare(`SELECT intent_id FROM trades WHERE id = ?`).get(t1).intent_id, 'ilegacy00903')
  assert.equal(db.prepare(`SELECT origin FROM trades WHERE id = ?`).get(t2).origin, 'bot_pending_fill')
})

test('W9: a fill the broker book never showed as working is filled, not expired — and evidence on another account or the opposite side is refused', () => {
  const db = freshDb()
  // no broker_orders row at all, own expiry passed: the old path said 'expired'
  const pid = workingLimit(db, { order_id: '905', intent_id: 'iquickfill05', expires_at: '2026-09-25T11:00:00Z' })
  db.prepare(`INSERT INTO trades (symbol, side, status, account_id, origin, label_raw) VALUES ('DOW.US', 'SELL', 'open', ?, 'reconciler_adopted', ?)`).run(DEMO, tagged('iquickfill05'))
  // the tag on another account's trade, and on an opposite-side trade: no link
  const other = workingLimit(db, { order_id: '906', intent_id: 'iotheracct06' })
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status, account_id) VALUES ('906', 'DOW.US', 'gone', ?)`).run(DEMO)
  db.prepare(`INSERT INTO trades (symbol, side, status, account_id, label_raw) VALUES ('DOW.US', 'SELL', 'open', '43097342', ?)`).run(tagged('iotheracct06'))
  const opp = workingLimit(db, { order_id: '907', intent_id: 'ioppositee07' })
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status, account_id) VALUES ('907', 'DOW.US', 'gone', ?)`).run(DEMO)
  db.prepare(`INSERT INTO trades (symbol, side, status, account_id, label_raw) VALUES ('DOW.US', 'BUY', 'open', ?, ?)`).run(DEMO, tagged('ioppositee07'))
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: NOW })
  assert.equal(db.prepare(`SELECT status FROM pending_orders WHERE id = ?`).get(pid).status, 'filled')
  assert.equal(db.prepare(`SELECT status FROM pending_orders WHERE id = ?`).get(other).status, 'expired')
  assert.equal(db.prepare(`SELECT status FROM pending_orders WHERE id = ?`).get(opp).status, 'expired')
  assert.deepEqual({ filled: r.filled, expired: r.expired }, { filled: 1, expired: 2 })
})

test('W9: an origin a more direct writer recorded is never rewritten by the link', () => {
  const db = freshDb()
  workingLimit(db, { order_id: '908', intent_id: 'imanualbk008' })
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status, account_id) VALUES ('908', 'DOW.US', 'gone', ?)`).run(DEMO)
  const tid = Number(db.prepare(`INSERT INTO trades (symbol, side, status, account_id, origin, origin_source, label_raw) VALUES ('DOW.US', 'SELL', 'open', ?, 'manual_broker', 'write', ?)`).run(DEMO, tagged('imanualbk008')).lastInsertRowid)
  assert.equal(reconcileStaleClosedMarketLimits(db, { nowMs: NOW }).filled, 1)
  assert.deepEqual(db.prepare(`SELECT origin, origin_source FROM trades WHERE id = ?`).get(tid), { origin: 'manual_broker', origin_source: 'write' })
})

// ============================================================ L2a × X1 (merge)
// X1 merged while L2a was open: a resting order's placement answer
// (ORDER_ACCEPTED, carrying the broker's PRE-CREATED position id) leaves the
// intent ACCEPTED with its order id and no position id, and only the ledger's
// broker-evidence resolvers move it on. L2a's writers own the ROWS (the
// resting row's status, the trade's lineage). These tests hold the seam: one
// writer per record, the same evidence read the same way on both.
const ACCEPTED_ANSWER = '{"executionType":"ORDER_ACCEPTED","position":{"positionId":241267454},"order":{"orderId":360473873}}'
async function placeRestingThroughEngine(db) {
  setState(db, 'symbol_id_map', JSON.stringify({ US30: 7 }))
  let sent = null
  onOrder = (body) => { sent = body; return { status: 200, body: ACCEPTED_ANSWER } }
  const risk = { loadRiskConfig: () => ({}), evaluateTrade: () => ({ approved: true, adjusted_volume: 0.1 }), persistRiskEvent: () => 777 }
  const sizing = { getVolumeMeta: async () => ({ digits: 2, lotSize: 100, minVolume: 1 }), lotsToVolume: (l) => ({ volume: Math.round(l * 100), belowMin: false }), relativePoints: (d, dg) => Math.round(d * 10 ** dg) }
  const creds = attachEntryFence(db, { ...BASE_CREDS }, { producerId: 'daily_momentum_account' })
  // No `exec` injected: the REAL exec-engine.placeOrder runs its ledger
  // protocol and settles the intent from the stub sidecar's answer.
  const r = await placeClosedMarketLimit(db, creds, 'US30', { consensus_bias: 'long', entry: 100, sl: 98, tp1: 104, strategy: 'tsmom_long', timeframe: '1d', direction_reason: 'tsmom:long_top_band' },
    { producerId: 'daily_momentum_account', risk, sizing, now: Date.parse('2026-09-25T12:00:00Z') })
  assert.equal(r.placed, true, JSON.stringify(r))
  const row = db.prepare(`SELECT * FROM pending_orders WHERE symbol = 'US30'`).get()
  const intent = db.prepare(`SELECT * FROM entry_intents WHERE id = ?`).get(row.intent_id)
  return { row, intent, sent }
}
const counts = (db) => ['pending_orders', 'entry_intents', 'trades'].map(t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n)

test('L2a × X1: a resting limit answered ORDER_ACCEPTED through the real engine is ACCEPTED on its intent (approval and row link recorded, no position); the sweep that finds no fill expires the ROW and never touches the intent', async () => {
  const db = freshDb()
  const { row, intent, sent } = await placeRestingThroughEngine(db)
  assert.equal(row.order_id, '360473873')
  assert.ok(intent, 'the resting row names the intent the engine reserved (L2a W5)')
  assert.deepEqual(
    { state: intent.state, order: String(intent.broker_order_id), position: intent.broker_position_id, risk: intent.risk_event_id, type: intent.order_type, symbol: intent.symbol },
    { state: 'ACCEPTED', order: '360473873', position: null, risk: 777, type: 'LIMIT', symbol: 'US30' },
    'X1: placed, not filled — the pre-created position id is not recorded as a fill; L2a: the approval rides on the intent',
  )
  assert.equal(labelIntentId(sent.label), intent.id, 'the broker label carries the id the row names')
  assert.equal('symbolName' in sent, false, 'X1 W2: the symbol is ledger-only')
  // The order leaves the book with no fill on record.
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status, account_id) VALUES ('360473873', 'US30', 'gone', ?)`).run(DEMO)
  const before = counts(db)
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: Date.parse('2026-09-26T12:00:00Z') })
  assert.deepEqual({ filled: r.filled, expired: r.expired }, { filled: 0, expired: 1 })
  assert.equal(db.prepare(`SELECT status FROM pending_orders WHERE id = ?`).get(row.id).status, 'expired')
  const after = db.prepare(`SELECT state, broker_position_id, resolution_source, updated_at FROM entry_intents WHERE id = ?`).get(intent.id)
  assert.deepEqual(after, { state: 'ACCEPTED', broker_position_id: null, resolution_source: intent.resolution_source, updated_at: intent.updated_at },
    'the ROW\'s writer never writes the INTENT: its outcome is the ledger\'s, from broker evidence (order details), never inferred here')
  assert.deepEqual(counts(db), before, 'nothing deleted, nothing added')
})

test('L2a × X1: when the fill arrives, the sweep settles the ROW from the tagged trade and leaves the intent ACCEPTED; the ledger\'s reconcile then moves the intent FILLED on the tagged position — one writer per record, no FILLED without the fill', async () => {
  const db = freshDb()
  const { row, intent } = await placeRestingThroughEngine(db)
  const label = tagged(intent.id)
  // The fill: the broker's pre-created position id becomes the position; the
  // reconciler adopted it with the broker's label (the intent tag on it).
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status, account_id) VALUES ('360473873', 'US30', 'gone', ?)`).run(DEMO)
  const tid = Number(db.prepare(`INSERT INTO trades (symbol, side, status, account_id, origin, origin_source, label_raw, ctrader_position_id, opened_at) VALUES ('US30', 'BUY', 'open', ?, 'reconciler_adopted', 'write', ?, '241267454', '2026-09-26T09:00:00Z')`).run(DEMO, label).lastInsertRowid)
  const before = counts(db)
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: Date.parse('2026-09-26T12:00:00Z') })
  assert.equal(r.filled, 1)
  const p = db.prepare(`SELECT status, note FROM pending_orders WHERE id = ?`).get(row.id)
  assert.equal(p.status, 'filled'); assert.match(p.note, new RegExp(`trade #${tid} \\(intent ${intent.id} via pending_orders\\.intent_id\\)`))
  assert.equal(db.prepare(`SELECT state FROM entry_intents WHERE id = ?`).get(intent.id).state, 'ACCEPTED',
    'RED if the row\'s writer settles the intent: that transition is the ledger\'s alone')
  const rec = reconcileIntents(db, { accountId: DEMO, positions: [{ positionId: 241267454, tradeData: { label } }], orders: [], now: Date.parse('2026-09-26T12:01:00Z') })
  assert.deepEqual(rec.resolved, [{ intentId: intent.id, from: 'ACCEPTED', to: 'FILLED' }])
  const filled = db.prepare(`SELECT state, broker_position_id, resolution_source FROM entry_intents WHERE id = ?`).get(intent.id)
  assert.deepEqual({ ...filled, broker_position_id: String(filled.broker_position_id) }, { state: 'FILLED', broker_position_id: '241267454', resolution_source: 'reconcile' })
  assert.deepEqual(counts(db), before, 'nothing deleted, nothing added')
})

test('L2a × X1: the resting row and its intent read the SAME fill evidence the same way — findLimitFill agrees with X1\'s fillEvidence case by case', () => {
  const db = freshDb()
  const cases = [
    // [name, trade row (or null), intent position id, expected]
    ['tag on a same-account trade', { account_id: DEMO, label_raw: tagged('iagreetag001') }, null, true],
    ['tag on an UNATTRIBUTED trade (account NULL)', { account_id: null, label_raw: tagged('iagreenul002') }, null, true],
    ['the position id stored in its float form', { account_id: DEMO, label_raw: 'PRE|v1|MR|H|NY|1d|TR', ctrader_position_id: '5553.0' }, '5553', true],
    ['tag on ANOTHER account\'s trade', { account_id: '43097342', label_raw: tagged('iagreeoth004') }, null, false],
    ['no trade at all', null, null, false],
  ]
  cases.forEach(([name, trade, pos, want], i) => {
    const n = i + 1
    const id = ['iagreetag001', 'iagreenul002', 'iagreepos003', 'iagreeoth004', 'iagreenon005'][i]
    const order = String(9100 + n)
    insertIntent(db, { id, symbol: 'DOW.US', side: 'SELL', orderType: 'LIMIT', state: pos ? 'FILLED' : 'ACCEPTED', brokerOrderId: order, brokerPositionId: pos })
    if (trade) db.prepare(`INSERT INTO trades (symbol, side, status, account_id, origin, label_raw, ctrader_position_id) VALUES ('DOW.US', 'SELL', 'open', ?, 'reconciler_adopted', ?, ?)`).run(trade.account_id, trade.label_raw, trade.ctrader_position_id ?? null)
    const rowLink = !!findLimitFill(db, { symbol: 'DOW.US', order_id: order, dir: -1, account_id: DEMO }).trade
    const intentRow = db.prepare(`SELECT * FROM entry_intents WHERE id = ?`).get(id)
    const intentLink = fillEvidence(db, intentRow).found.length > 0
    assert.equal(rowLink, want, `row, ${name}`)
    assert.equal(intentLink, want, `intent, ${name}`)
  })
})

// ========================================================================= W7
test('W7: the closed-market sweep RECORDS a plan it failed to write, and still settles the fill', () => {
  const db = freshDb()
  workingLimit(db, { order_id: '909', intent_id: iid('909') })
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status, account_id) VALUES ('909', 'DOW.US', 'gone', ?)`).run(DEMO)
  const tid = Number(db.prepare(`INSERT INTO trades (symbol, side, status, account_id, label_raw) VALUES ('DOW.US', 'SELL', 'open', ?, ?)`).run(DEMO, tagged(iid('909'))).lastInsertRowid)
  refusePlans(db)
  assert.equal(reconcileStaleClosedMarketLimits(db, { nowMs: NOW }).filled, 1)
  const f = planFailures(db)
  assert.equal(f.length, 1, 'RED if the catch swallows the failure again')
  assert.deepEqual({ tradeId: f[0].tradeId, source: f[0].source, stage: f[0].stage, account: f[0].account_id }, { tradeId: tid, source: 'closed_market_limit_fill', stage: 'closed_market_sweep', account: DEMO })
  assert.match(f[0].error, /plan write refused/)
})
function iid(n) { return `iplanfail${String(n).padStart(3, '0')}` }

test('W7: recordPlanWriteFailure never throws, even when the log itself cannot be written', () => {
  const db = freshDb()
  db.exec('DROP TABLE action_log')
  assert.equal(recordPlanWriteFailure(db, { tradeId: 1, error: new Error('x') }), false)
})

// ================================================================ W5/W6/W7 reconciler
test('W5: the adopted intent\'s approval is found case-insensitively; W6: the trade names its intent; W7: a failed plan is recorded and the stamp stays', () => {
  const db = freshDb()
  insertIntent(db, { id: 'iadoptjpm001', symbol: 'JPM.US', side: 'BUY', orderType: 'MARKET' })
  db.prepare(`UPDATE entry_intents SET created_at = '2026-09-25T10:00:00.000Z' WHERE id = 'iadoptjpm001'`).run()
  const ev = Number(db.prepare(`INSERT INTO risk_events (symbol, side, approved, account_id, created_at, proposal_json) VALUES ('jpm.us', 'buy', 1, ?, '2026-09-25T09:58:00.000Z', '{}')`).run(DEMO).lastInsertRowid)
  const tid = Number(db.prepare(`INSERT INTO trades (symbol, side, status, account_id, origin, origin_source, label_raw) VALUES ('JPM.US', 'BUY', 'open', ?, 'reconciler_adopted', 'write', ?)`).run(DEMO, 'AU|v1|MR|H|NY|1d|TR|iadoptjpm001').lastInsertRowid)
  refusePlans(db)
  const r = stampAdoptedFromIntent(db, { tradeId: tid, label: 'AU|v1|MR|H|NY|1d|TR|iadoptjpm001', parsed: { strategy: 'tsmom_long' }, acct: DEMO, symbolName: 'JPM.US', side: 'long', entry: 300, sl: 290, tp: 330 })
  assert.equal(r?.riskEventId, ev, 'RED if the window matches the symbol case-sensitively')
  const t = db.prepare(`SELECT origin, risk_event_id, intent_id FROM trades WHERE id = ?`).get(tid)
  assert.deepEqual(t, { origin: 'bot_market_dispatch', risk_event_id: ev, intent_id: 'iadoptjpm001' })
  const f = planFailures(db)
  assert.equal(f.length, 1); assert.equal(f[0].stage, 'adopt_stamp'); assert.equal(f[0].tradeId, tid)
})

test('W5: the case-insensitive window is still an index read — EXPLAIN shows no scan of risk_events', () => {
  const db = freshDb()
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${INTENT_APPROVAL_WINDOW_SQL}`).all(DEMO, 'JPM.US', 'BUY', '2026-09-25T10:00:00Z', '2026-09-25T09:55:00Z').map(r => r.detail).join(' | ')
  assert.doesNotMatch(plan, /SCAN risk_events/, plan)
  assert.match(plan, /SEARCH risk_events USING/, plan)
})

test('W6: a pending fill\'s trade names its intent — the resting row\'s, else the tag on the broker position\'s label', () => {
  const db = freshDb()
  const withRow = persistFilledTrade(db, { symbol: 'EURUSD', dir: 1, level: 1.1, sl: 1.09, tp: 1.12, volume: 0.1, order_id: '77', intent_id: 'ipendrow0001', strategy: 'fib_618_fade' }, { positionId: 5001, price: 1.1, tradeData: { label: 'AU|v1|MR|H|LN|1h|TR' } }, DEMO)
  const fromLabel = persistFilledTrade(db, { symbol: 'GBPUSD', dir: 1, level: 1.3, sl: 1.29, tp: 1.32, volume: 0.1, order_id: '78', strategy: 'fib_618_fade' }, { positionId: 5002, price: 1.3, tradeData: { label: 'AU|v1|MR|H|LN|1h|TR|ipendlab0002' } }, DEMO)
  const read = (id) => db.prepare(`SELECT intent_id FROM trades WHERE id = ?`).get(id).intent_id
  assert.equal(read(withRow), 'ipendrow0001'); assert.equal(read(fromLabel), 'ipendlab0002')
})

// ========================================================================= W8
test('W8: /execute-trade writes ahead — account, strategy and approval id on the first write — then promotes the SAME row', () => {
  const db = freshDb()
  const id = writeAheadAnalysisTrade(db, { symbol: 'US30', side: 'BUY', entry: 100, sl: 98, tp: 104, volLots: 0.2, accountId: DEMO, strategy: 'donchian_breakout', riskEventId: 31337 })
  const w = db.prepare(`SELECT status, account_id, strategy, risk_event_id, origin, proposal_entry_price FROM trades WHERE id = ?`).get(id)
  assert.deepEqual(w, { status: 'submitting', account_id: DEMO, strategy: 'donchian_breakout', risk_event_id: 31337, origin: 'manual_broker', proposal_entry_price: 100 })
  settleAnalysisTrade(db, id, { symbol: 'US30', side: 'BUY', entryP: 100.5, entry: 100, sl: 98, tp: 104, volLots: 0.2, positionId: '8080', label: 'AU|v1|BRKO|H|NY|1d|TR|iexecute0001', accountId: DEMO, strategy: 'donchian_breakout', timeframe: '1d' })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM trades`).get().n, 1, 'promoted, never a second row')
  const t = db.prepare(`SELECT status, entry_price, ctrader_position_id, label_raw, account_id, strategy, risk_event_id FROM trades WHERE id = ?`).get(id)
  assert.deepEqual(t, { status: 'open', entry_price: 100.5, ctrader_position_id: '8080', label_raw: 'AU|v1|BRKO|H|NY|1d|TR|iexecute0001', account_id: DEMO, strategy: 'donchian_breakout', risk_event_id: 31337 })
  assert.equal(db.prepare(`SELECT account_id FROM monitored_positions WHERE trade_id = ?`).get(id).account_id, DEMO)
  assert.equal(db.prepare(`SELECT source FROM trade_plans WHERE trade_id = ?`).get(id).source, 'manual_broker')
})

test('W8: a failed send is marked by OUTCOME — refusals before any transport are rejected, anything that may have reached the broker is unconfirmed', () => {
  const db = freshDb()
  const mk = () => writeAheadAnalysisTrade(db, { symbol: 'US30', side: 'BUY', entry: 100, sl: 98, accountId: DEMO, strategy: 's', riskEventId: 1 })
  const cases = [
    [new Error('guard_no_target: no take profit'), 'rejected'],
    [Object.assign(new Error('ENTRY_MODE_REFUSED: entry_mode STOPPED'), { code: 'ENTRY_MODE_REFUSED' }), 'rejected'],
    [Object.assign(new Error('ENTRY_LEDGER_REFUSED: intent_open'), { code: 'ENTRY_LEDGER_REFUSED' }), 'rejected'],
    [new Error('TIMEOUT: no payloadType 2126 within 20000ms'), 'unconfirmed'],
  ]
  for (const [err, want] of cases) {
    const id = mk()
    assert.equal(failAnalysisTrade(db, id, err), want, err.message)
    assert.equal(db.prepare(`SELECT status FROM trades WHERE id = ?`).get(id).status, want)
  }
  // a plan that fails to write at the fill is recorded (W7)
  const id = mk()
  refusePlans(db)
  settleAnalysisTrade(db, id, { symbol: 'US30', side: 'BUY', entryP: 100, entry: 100, sl: 98, tp: 104, volLots: 0.1, label: 'AU|v1|BRKO|H|NY|1d|TR', accountId: DEMO, strategy: 's' })
  assert.equal(db.prepare(`SELECT status FROM trades WHERE id = ?`).get(id).status, 'open', 'the trade stands')
  assert.equal(planFailures(db).at(-1).stage, 'execute_trade')
})

test('W8 wiring (comments stripped, bounded): the route writes ahead BEFORE the send, binds the approval to the intent, and settles or fails that same row', () => {
  const act = src('../routes/actions.js')
  const route = act.slice(act.indexOf("router.post('/execute-trade'"), act.indexOf("router.post('/manual-order'"))
  const at = (re) => { const m = re.exec(route); assert.ok(m, String(re)); return m.index }
  const writeAhead = at(/const tradeId = writeAheadAnalysisTrade\(db, \{[^}]{0,300}riskEventId,/)
  const send = at(/exec = await execPlaceOrder\(\s+bindEntryIntent\(/)
  assert.ok(writeAhead < send, 'the write-ahead row exists before the order is sent')
  assert.match(route, /bindEntryIntent\([\s\S]{0,300}?\{ riskEventId, onReserved: \(id\) => \{ entryIntentId = id; db\.prepare\('UPDATE trades SET intent_id = \? WHERE id = \?'\)\.run\(id, tradeId\) \} \}/)
  assert.match(route, /\} catch \(err\) \{\s+try \{ failAnalysisTrade\(db, tradeId, err\) \}/)
  assert.ok(at(/settleAnalysisTrade\(db, tradeId, \{/) > send)
  assert.match(route, /const riskEventId = persistRiskEvent\(db, proposal, riskResult\)/)
  assert.doesNotMatch(route, /INSERT INTO trades/, 'no second, post-fill insert')
})

// ========================================================================= W6 loop
test('W6/W7 wiring in loop.js autoTrade (comments stripped, bounded): the reserved intent lands on the write-ahead row, the stored label is the tagged one, and a plan failure is recorded', () => {
  const loop = src('../loop.js')
  assert.match(loop, /bindEntryIntent\(attachEntryFence\(db, \{ host, clientId, clientSecret, accessToken, accountId, execGuard \}, \{ producerId \}\), \{\s+riskEventId,\s+onReserved: \(id\) => \{\s+entryIntentId = id\s+db\.prepare\(`UPDATE trades SET intent_id = \? WHERE id = \?`\)\.run\(id, intentId\)/)
  assert.match(loop, /const parsedLabel = parseLabel\(entryIntentId \? tagLabelWithIntent\(structuredLabel, entryIntentId\) : structuredLabel\)/)
  assert.match(loop, /source: synth\.source \|\| 'auto_signal',\s+\}\)\s+\} catch \(err\) \{\s+recordPlanWriteFailure\(db, \{ tradeId, accountId, symbol, source: synth\.source \|\| 'auto_signal', stage: 'dispatch', error: err \}\)/)
})

// ======================================================================== W14
test('W14: writeEngineStatus stamps transitionSince when the state is ENTERED, keeps it across same-state rewrites, and drops it on STABLE', () => {
  const db = freshDb()
  db.prepare(`INSERT INTO pending_orders (symbol, order_id, dir, level, status, note, account_id) VALUES ('US30', '1', 1, 100, 'working', 'pending-closed', ?)`).run(DEMO)
  const r = requestEntryMode(db, DEMO, 'STOPPED', { actor: 'owner', now: new Date('2026-09-25T10:00:00.000Z') })
  assert.ok(r.ok !== false, JSON.stringify(r))
  const st = engineStatusFor(db, DEMO)
  assert.equal(st.transitionState, 'QUIESCING')
  assert.equal(st.transitionSince, '2026-09-25T10:00:00.000Z')
  // a drain pass rewrites the record in the same state, later
  writeEngineStatus(db, { ...st, updatedAt: '2026-09-25T11:00:00.000Z' })
  assert.equal(engineStatusFor(db, DEMO).transitionSince, '2026-09-25T10:00:00.000Z', 'RED if every write re-stamps the clock')
  // a change of state is a new entry time
  writeEngineStatus(db, { ...engineStatusFor(db, DEMO), transitionState: 'RECONCILING', updatedAt: '2026-09-25T11:05:00.000Z' })
  assert.equal(engineStatusFor(db, DEMO).transitionSince, '2026-09-25T11:05:00.000Z')
  // STABLE carries no clock, and the record still validates under the contract
  const stable = writeEngineStatus(db, { ...engineStatusFor(db, DEMO), transitionState: 'STABLE', effectiveEntryMode: 'STOPPED', updatedAt: '2026-09-25T11:10:00.000Z' })
  assert.equal('transitionSince' in stable, false)
  assert.equal('transitionSince' in JSON.parse(getAccountState(db, DEMO, ENGINE_STATUS_KEY)), false)
})

test('W14: a record written before the field, still in the same state, is NOT given an invented entry time; the field validates', () => {
  const next = { transitionState: 'RECONCILING', updatedAt: '2026-09-25T12:00:00.000Z' }
  assert.equal('transitionSince' in withTransitionSince(next, { transitionState: 'RECONCILING' }), false, 'unknown stays unknown')
  assert.equal(withTransitionSince(next, null).transitionSince, '2026-09-25T12:00:00.000Z', 'no stored record: entered now')
  assert.equal(withTransitionSince({ ...next, transitionSince: '1999-01-01T00:00:00.000Z' }, { transitionState: 'STABLE' }).transitionSince, '2026-09-25T12:00:00.000Z', 'a carried stamp from the old state is replaced')
  const db = freshDb()
  const base = engineStatusFor(db, DEMO)
  const { stored, invalid, ...rec } = base // eslint-disable-line no-unused-vars
  assert.equal(validateEngineStatus({ ...rec, transitionState: 'STABLE', transitionSince: '2026-09-25T12:00:00.000Z' }).ok, true)
  assert.equal(validateEngineStatus({ ...rec, transitionSince: 5 }).ok, false, 'a non-string stamp is refused')
})

// ========================================================================= W1
test('W1: an owner-fired validation fill states the cause of its side — the operator\'s, or the route default named as a default', () => {
  assert.equal(validationFillDirectionReason('short'), 'manual:operator_chose_short')
  assert.equal(validationFillDirectionReason('long'), 'manual:operator_chose_long')
  assert.equal(validationFillDirectionReason(undefined), 'validation_fill:route_default_long')
  assert.equal(validationFillDirectionReason('SIDEWAYS'), 'validation_fill:route_default_long')
  const act = src('../routes/actions.js')
  const route = act.slice(act.indexOf("router.post('/validation-fill'"), act.indexOf("router.post('/validation-fill'") + 4000)
  assert.match(route, /const synth = \{\s+consensus_bias: bias,\s+direction_reason: validationFillDirectionReason\(req\.body\?\.side\),/)
  assert.equal(typeof getState, 'function')
})

test('L2a × X1 follow-up: the sweep never expires a resting row whose intent the ledger settled FILLED from broker evidence — the row reads filled, naming the ledger; a response-only FILLED (pre-X1) is not evidence and the row still expires', () => {
  const db = freshDb()
  const settle = db.prepare(`UPDATE entry_intents SET resolution_source = ? WHERE id = ?`)
  // (a) broker says gone, ledger FILLED from order details, no trade row (opened and closed between passes)
  insertIntent(db, { id: 'iledgerfil01', state: 'FILLED', brokerOrderId: '9201', brokerPositionId: '555' })
  settle.run('order_details', 'iledgerfil01')
  const a = workingLimit(db, { order_id: '9201', intent_id: 'iledgerfil01' })
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status, account_id) VALUES ('9201', 'DOW.US', 'gone', ?)`).run(DEMO)
  // (b) no broker record, own expiry passed, ledger FILLED from an execution event
  insertIntent(db, { id: 'iledgerfil02', state: 'FILLED', brokerOrderId: '9202', brokerPositionId: '556' })
  settle.run('event', 'iledgerfil02')
  const b = workingLimit(db, { order_id: '9202', intent_id: 'iledgerfil02', expires_at: '2026-09-25T11:00:00Z' })
  // (c) no order id, expiry passed, ledger FILLED from reconcile
  insertIntent(db, { id: 'iledgerfil03', state: 'FILLED', brokerPositionId: '557' })
  settle.run('reconcile', 'iledgerfil03')
  const c = workingLimit(db, { order_id: null, intent_id: 'iledgerfil03', expires_at: '2026-09-25T11:00:00Z' })
  // (d) the pre-X1 shape: FILLED by the placement answer alone — not fill evidence for a resting order
  insertIntent(db, { id: 'iledgerres04', state: 'FILLED', brokerOrderId: '9204', brokerPositionId: '558' })
  settle.run('response', 'iledgerres04')
  const d = workingLimit(db, { order_id: '9204', intent_id: 'iledgerres04' })
  db.prepare(`INSERT INTO broker_orders (order_id, symbol, status, account_id) VALUES ('9204', 'DOW.US', 'gone', ?)`).run(DEMO)
  const before = counts(db)
  const r = reconcileStaleClosedMarketLimits(db, { nowMs: NOW })
  const st = id => db.prepare(`SELECT status, note FROM pending_orders WHERE id = ?`).get(id)
  for (const [id, src] of [[a, 'order_details'], [b, 'event'], [c, 'reconcile']]) {
    assert.equal(st(id).status, 'filled', `RED if the sweep writes expired over a ledger FILLED from ${src}`)
    assert.match(st(id).note, new RegExp(`filled per the entry ledger \\(intent iledgerfil0\\d FILLED from ${src}`))
  }
  assert.equal(st(d).status, 'expired', 'a FILLED from the placement answer alone is not evidence: the row expires as before')
  assert.deepEqual([r.filled, r.expired], [3, 1])
  for (const id of ['iledgerfil01', 'iledgerfil02', 'iledgerfil03', 'iledgerres04']) {
    assert.equal(db.prepare(`SELECT state FROM entry_intents WHERE id = ?`).get(id).state, 'FILLED', 'the sweep never writes the intent')
  }
  assert.deepEqual(counts(db), before, 'nothing deleted, nothing added')
})
