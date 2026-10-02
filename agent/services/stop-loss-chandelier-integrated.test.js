// node --test agent/services/stop-loss-chandelier-integrated.test.js
//
// The MAE / Chandelier legs of the integrated stop-loss suite (02-10-2026,
// PR-3). The fast monitor's Chandelier tick and the slow pass's timeframe
// Chandelier each send a MOVE_SL. Here they go through the REAL runFastMonitor
// / monitorOnePosition, the REAL executeBrokerAction and exec-engine, to the
// stateful sidecar+broker model — not to a fake executor (that single-step
// proof is fast-monitor-chandelier-send.test.js) — and what is asserted is
// what the BROKER ends up holding, the receipt the Chandelier records, and the
// numbers GET /state/mae-chandelier serves.
//
// Own file: loop.js memoises its prepared statements for the first db, and the
// Chandelier legs need a symbol map the executor test must not have.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import { prepareStatements, monitorOnePosition } from '../loop.js'
import { runFastMonitor } from './fast-monitor.js'
import { startStopBrokerModel } from '../test-support/stop-broker-model.js'
import { setStopPolicy, resetTrailingRegistry, resetStopPolicyStats } from '../lib/stop-policy.js'
import { storeBars, maeChandelierView, OBSERVE_STATE_KEY } from './mae-chandelier-observe.js'
import { invalidateSidecarSession } from '../lib/exec-engine.js'
import { _seedVolumeMetaForTests } from '../lib/lot-sizing.js'

const ENV_KEYS = ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'EXEC_ENGINE', 'EXEC_URL', 'EXEC_URL_DEMO', 'EXEC_URL_LIVE', 'EXEC_SECRET', 'EXEC_FALLBACK', 'FROZEN_QUOTE_MIN']
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
const ACCOUNT = '42'
const SYMBOL_ID = 7
const T0 = Date.parse('2026-10-02T10:00:00Z')
let model = null

const db = (() => {
  const d = initDB(':memory:')
  setState(d, 'ctrader_account_id', ACCOUNT)
  setState(d, 'ctrader_access_token', 'fixture')
  d.prepare(`INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES (?, 0, 1, 'active')`).run(ACCOUNT)
  setState(d, 'symbol_id_map', JSON.stringify({ EURUSD: SYMBOL_ID }))
  setState(d, `symbol_id_map:${ACCOUNT}`, JSON.stringify({ map: { EURUSD: SYMBOL_ID }, builtAt: new Date().toISOString() }))
  return d
})()
const s = prepareStatements(db)
// The executor rounds a stop to the symbol's digits; seeded, that lookup never opens a websocket.
_seedVolumeMetaForTests(ACCOUNT, SYMBOL_ID, { digits: 5 })

before(() => {
  process.env.CTRADER_CLIENT_ID = 'fixture'
  process.env.CTRADER_CLIENT_SECRET = 'fixture'
  process.env.EXEC_ENGINE = 'cpp'
  delete process.env.EXEC_URL_DEMO
  delete process.env.EXEC_URL_LIVE
  process.env.EXEC_SECRET = 'sekret'
  process.env.EXEC_FALLBACK = '0'
  process.env.FROZEN_QUOTE_MIN = '0'
})
after(async () => {
  if (model) await model.close()
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
})
beforeEach(() => { setStopPolicy(null); resetTrailingRegistry(); resetStopPolicyStats(); db.exec("UPDATE monitored_positions SET status = 'closed'"); setState(db, OBSERVE_STATE_KEY, '{}') })

async function useModel(opts) {
  if (model) await model.close()
  model = await startStopBrokerModel({ account: ACCOUNT, ...opts })
  process.env.EXEC_URL = model.url
  invalidateSidecarSession()
  return model
}

// 40 hourly bars climbing to 1.1015 with a 0.0010 range: ATR is about 0.0010,
// the since-entry Chandelier is about 1.0990 — above a 1.0950 stop, below the
// 1.1015 price. A +0.3R long: the exit ladder reads HOLD, so the Chandelier
// runs (it only runs after a HOLD verdict).
const climbingBars = () => Array.from({ length: 40 }, (_, i) => { const c = 1.0835 + i * 0.00046; return { h: c + 0.0005, l: c - 0.0005, c } })
const QUOTE = { bid: 1.1014, ask: 1.1016 }

function openLong({ sl = 1.0950, tp = 1.1300, source = 'autopilot' } = {}) {
  const bp = model.open({ symbolId: SYMBOL_ID, tradeSide: 'BUY', entry: 1.1000, stopLoss: sl, takeProfit: tp, trigger: 1 })
  model.price(SYMBOL_ID, QUOTE)
  const tradeId = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, status, ctrader_position_id, account_id, opened_at)
    VALUES ('EURUSD', 'BUY', 1.1000, 0.01, 'open', ?, ?, datetime('now', '-2 hours'))`).run(String(bp.positionId), ACCOUNT).lastInsertRowid
  const id = db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, initial_risk, status, account_id, source, strategy, created_at)
    VALUES ('EURUSD', ?, 'BUY', 1.1000, ?, ?, 0.0050, 'active', ?, ?, 'fib_618_fade', datetime('now', '-2 hours'))`).run(tradeId, sl, tp, ACCOUNT, source).lastInsertRowid
  return { bp, id, row: () => db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(id) }
}

const fastDeps = () => ({
  now: () => T0, monoNow: () => T0, sleep: async () => {}, tickMs: 3_000, quoteMaxAgeMs: 10_000,
  ws: { wsProbeSpot: async () => ({ kind: 'quote', ...QUOTE }), wsGetSpotOnce: async () => QUOTE, wsGetTrendbarsBatch: async () => ({ '1h': climbingBars() }) },
  exec: { sidecarQuotes: async () => ({ feed: 'up', generation: 1, accountId: ACCOUNT, nowMs: T0, count: 1,
    quotes: [{ symbolId: SYMBOL_ID, bid: QUOTE.bid, ask: QUOTE.ask, tsMs: T0 - 300, recvMs: T0 - 300 }] }) },
})
const readObserve = () => JSON.parse(getState(db, OBSERVE_STATE_KEY) || '{}')
const receiptFor = id => (readObserve().receipts ?? []).filter(r => r.id === String(id)).at(-1)
const settle = () => new Promise(r => setTimeout(r, 60)) // recordObserve / recordAmendReceipt are fire-and-forget

for (const omittedFlags of ['preserve', 'reset']) {
  test(`fast Chandelier tick (omittedFlags=${omittedFlags}): the stop is tightened AT THE BROKER, Opposite, target kept, receipt confirmed with the policy outcome`, async () => {
    await useModel({ omittedFlags })
    storeBars(SYMBOL_ID, climbingBars())
    const pos = openLong()
    const out = await runFastMonitor(db, { ready: true, host: 'demo.ctraderapi.com', clientId: 'fixture', clientSecret: 'fixture', accessToken: 'fixture', accountId: ACCOUNT, isLive: false }, fastDeps())
    assert.equal(out.error, undefined, JSON.stringify(out))
    await settle()
    const held = model.position(pos.bp.positionId)
    assert.ok(held.stopLoss > 1.0950 && held.stopLoss < QUOTE.bid, `the broker holds a tighter stop behind price: ${held.stopLoss}`)
    assert.equal(held.trigger, 2, 'Opposite')
    assert.equal(held.takeProfit, 1.1300, 'the target survived the Chandelier amend')
    assert.equal(held.trailing, false, 'a Chandelier stop below entry is not broker-trailed')
    assert.equal(pos.row().current_sl, held.stopLoss, 'the stored stop is what the broker holds')
    const state = readObserve()
    const reading = state.positions?.[String(pos.id)]
    assert.ok(reading, 'the reading was recorded')
    assert.equal(reading.mayAmend, true)
    const receipt = receiptFor(pos.id)
    assert.ok(receipt, `a receipt was recorded: ${JSON.stringify(Object.keys(state))}`)
    assert.equal(receipt.sent, true)
    assert.equal(receipt.confirmed, true, 'the sidecar read the broker back')
    assert.equal(receipt.policy.readback, 'confirmed')
    const view = maeChandelierView(db, getState)
    assert.ok((view.receiptsConfirmed ?? view.summary?.receiptsConfirmed) >= 1, `GET /state/mae-chandelier counts the confirmed receipt: ${JSON.stringify(view).slice(0, 300)}`)
  })
}

test('fast Chandelier tick, stop already tighter than the Chandelier level: nothing is sent and the broker\'s stop is untouched', async () => {
  await useModel()
  storeBars(SYMBOL_ID, climbingBars())
  const pos = openLong({ sl: 1.1005 }) // already tighter than the ~1.0990 level: the reading may not amend
  const before = model.amendRequests().length
  await runFastMonitor(db, { ready: true, host: 'demo.ctraderapi.com', clientId: 'fixture', clientSecret: 'fixture', accessToken: 'fixture', accountId: ACCOUNT, isLive: false }, fastDeps())
  await settle()
  assert.equal(model.amendRequests().length, before, 'no amend: the stop was already tighter than the Chandelier')
  assert.equal(model.position(pos.bp.positionId).stopLoss, 1.1005)
})

test('slow-pass timeframe Chandelier: the symbol id comes from the map, the stop is tightened at the broker with the same wire and a confirmed receipt', async () => {
  await useModel()
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: SYMBOL_ID }))
  storeBars(SYMBOL_ID, climbingBars())
  const pos = openLong()
  await monitorOnePosition(db, { ...s, selectBrokerContext: s.selectBrokerContext }, pos.row(), QUOTE.bid, null, () => true)
  await settle()
  const held = model.position(pos.bp.positionId)
  assert.ok(held.stopLoss > 1.0950, `the slow pass tightened the stop at the broker: ${held.stopLoss}`)
  assert.equal(held.trigger, 2)
  assert.equal(held.takeProfit, 1.1300)
  const receipt = receiptFor(pos.id)
  assert.ok(receipt?.confirmed, `receipt confirmed: ${JSON.stringify(receipt)}`)
})

test('a refused policy does not stop the Chandelier tightening, and the receipt records the refusal', async () => {
  await useModel({ refuseFlags: true })
  storeBars(SYMBOL_ID, climbingBars())
  const pos = openLong()
  await runFastMonitor(db, { ready: true, host: 'demo.ctraderapi.com', clientId: 'fixture', clientSecret: 'fixture', accessToken: 'fixture', accountId: ACCOUNT, isLive: false }, fastDeps())
  await settle()
  const held = model.position(pos.bp.positionId)
  assert.ok(held.stopLoss > 1.0950, 'the stop tightened although the broker refused the policy fields')
  assert.equal(held.trigger, 1, 'the broker kept Trade: the refusal is honest')
  const receipt = receiptFor(pos.id)
  assert.equal(receipt?.policy?.refused, true, 'the receipt records the refusal')
})
