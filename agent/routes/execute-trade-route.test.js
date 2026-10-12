// node --test agent/routes/execute-trade-route.test.js
//
// Claude · № 13,699 12-Oct (owner, after the PR audit № 13,693: "Execute-
// analysis route (B1–B4)", then "Keep the three as chosen"; claude-builder).
//
// POST /actions/execute-trade places a MARKET order from a stored analysis.
// The audit of 10–12 Oct found four places where it answered differently from
// the pad route (/actions/manual-order) and the loop, each reproduced through
// the real route, the real gate and a stand-in broker:
//   B1  the gate approved some setups only at a stretched target
//       (target_override); this route sent the analysis's own, shorter one;
//   B2  it read the shared watchlist's Max lots only, never the account's own;
//   B3  it judged the stop side against the analysis's planned entry, never
//       the price now, so an analysis the market had already run through was
//       sent with its stop on the wrong side of the fill;
//   B4  a refusal before any transport (entry mode, ledger, permit, duplicate
//       lock) was thrown as a 500 with no refusal recorded, so the approval
//       read "ordered" and /health "traded" for an order never sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import express from 'express'
import { initDB, setState } from '../db.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'
import { recordMarketCalendar } from '../services/market-calendar.js'
import { _resetEntryHoursRefresh } from '../services/entry-hours.js'
import { PT, _setWebSocketForTests } from '../lib/ctrader-ws.js'
import { _resetOrderLocks } from '../lib/exec-engine.js'
import { auditDecisions } from '../services/decision-audit.js'
import { sweepDispositions } from '../services/opportunity-disposition.js'
import { POST_APPROVAL_FLAG } from '../services/risk.js'
import { acctWatchlistKey } from '../services/watchlists.js'
import actionsRouter from './actions.js'

const A = '4242'
const SYM = 'EURUSD', SYM_ID = 1
const HOST = 'demo.ctraderapi.com'
const WEEK = 7 * 86400

function fresh({ halt = true } = {}) {
  _resetEntryHoursRefresh()
  _resetOrderLocks()
  const db = initDB(':memory:')
  db.prepare("INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')").run(A, A)
  setState(db, `acct:${A}:account_balance_usd`, '10000')
  setState(db, accountSymbolMapKey(A), JSON.stringify({ builtAt: new Date().toISOString(), accountId: A, map: { [SYM]: SYM_ID } }))
  recordMarketCalendar(db, { host: HOST, accountId: A, symbolId: String(SYM_ID) },
    { symbolId: SYM_ID, scheduleTimeZone: 'UTC', tradingMode: 0, schedule: [{ startSecond: 0, endSecond: WEEK }], holiday: [] }, { nowMs: Date.now() })
  setState(db, 'ctrader_account_id', A)
  setState(db, 'ctrader_access_token', 't')
  setState(db, 'symbol_id_map', JSON.stringify({ [SYM]: SYM_ID }))
  setState(db, 'autotrade_enabled', 'true')
  setState(db, 'evidence_gate_json', JSON.stringify({ on: false }))
  setState(db, 'autopilot_symbols_json', JSON.stringify([{ symbol: SYM, enabled: true, maxVolume: 0.1 }]))
  // The kill switch stops the send AFTER the gate; off where a test needs the order itself.
  setState(db, 'exec_guard_json', halt ? JSON.stringify({ halt: true }) : 'null')
  return db
}

/**
 * A broker socket: auth, 1m bars closing at `close` (or none), the lot record;
 * a new order is recorded and refused at once (ORDER_ERROR_EVENT), so a test
 * can read the payload the route sent.
 */
function fakeBroker(close) {
  const sent = [], orders = []
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; setImmediate(() => this.emit('open')) }
    send(raw) {
      const m = JSON.parse(raw)
      if (m.payloadType === PT.HEARTBEAT) return
      sent.push(m.payloadType)
      const reply = (type, payload) => setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ payloadType: type, payload, clientMsgId: m.clientMsgId }))))
      if (m.payloadType === PT.NEW_ORDER_REQ) { orders.push(m.payload); return reply(PT.ORDER_ERROR_EVENT, { errorCode: 'TEST_REFUSED', description: 'stand-in broker' }) }
      const minute = Math.floor(Date.now() / 60_000)
      const answer = {
        [PT.APP_AUTH_REQ]: [PT.APP_AUTH_RES, {}],
        [PT.ACCOUNT_AUTH_REQ]: [PT.ACCOUNT_AUTH_RES, { ctidTraderAccountId: m.payload?.ctidTraderAccountId }],
        [PT.GET_TRENDBARS_REQ]: [PT.GET_TRENDBARS_RES, {
          ctidTraderAccountId: m.payload?.ctidTraderAccountId, symbolId: m.payload?.symbolId, period: m.payload?.period,
          trendbar: close == null ? [] : [{ low: Math.round(close * 100_000) - 50, deltaOpen: 0, deltaHigh: 60, deltaClose: 50, utcTimestampInMinutes: minute - 1, volume: 1 }],
        }],
        [PT.SYMBOL_BY_ID_REQ]: [PT.SYMBOL_BY_ID_RES, {
          ctidTraderAccountId: m.payload?.ctidTraderAccountId,
          symbol: [].concat(m.payload?.symbolId ?? []).map(id => ({ symbolId: id, lotSize: 10_000_000, minVolume: 100_000, maxVolume: 100_000_000_000, stepVolume: 100_000, digits: 5, pipPosition: 4 })),
        }],
      }[m.payloadType]
      if (answer) reply(answer[0], answer[1])
    }
    close() { this.readyState = 3 }
  }
  return { Socket, sent, orders }
}

async function serve(t, db, { close = 1.1 } = {}) {
  const broker = fakeBroker(close)
  _setWebSocketForTests(broker.Socket); t.after(() => _setWebSocketForTests(null))
  const app = express(); app.use(express.json()); app.use('/actions', actionsRouter(db))
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  t.after(() => new Promise(r => server.close(r)))
  const saved = { id: process.env.CTRADER_CLIENT_ID, secret: process.env.CTRADER_CLIENT_SECRET }
  process.env.CTRADER_CLIENT_ID = 'c'; process.env.CTRADER_CLIENT_SECRET = 's'
  t.after(() => {
    if (saved.id === undefined) delete process.env.CTRADER_CLIENT_ID; else process.env.CTRADER_CLIENT_ID = saved.id
    if (saved.secret === undefined) delete process.env.CTRADER_CLIENT_SECRET; else process.env.CTRADER_CLIENT_SECRET = saved.secret
  })
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}/actions/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, ...(await r.json()) }))
  return { post, broker }
}

const analysis = (db, { bias = 'long', entry = 1.1, sl = 1.09, tp = 1.135, strategy = 'ema_pullback' } = {}) =>
  Number(db.prepare(`INSERT INTO analyses (symbol, consensus_bias, overall_conviction, synthesis, entry_price, sl_price, tp1_price, strategy, analyzed_at)
    VALUES (?, ?, 9, '{}', ?, ?, ?, ?, ?)`).run(SYM, bias, entry, sl, tp, strategy, new Date().toISOString()).lastInsertRowid)
const approval = db => db.prepare('SELECT id, checks_json FROM risk_events WHERE approved = 1 ORDER BY id LIMIT 1').get()
const flagged = r => new RegExp(`"${POST_APPROVAL_FLAG}"\\s*:\\s*true`).test(String(r.checks_json || ''))

/** The approval has its refusal recorded after it, tied by both auditors. */
function assertRefusedAfterApproval(db, label, reasonRe) {
  const all = db.prepare('SELECT id, approved, veto_reason, checks_json FROM risk_events ORDER BY id').all()
  assert.equal(all.length, 2, `${label}: one approval and one refusal (${all.map(r => r.veto_reason).join(' | ')})`)
  assert.equal(all[0].approved, 1, `${label}: the gate approved (${all[0].veto_reason})`)
  assert.equal(all[1].approved, 0)
  assert.match(all[1].veto_reason, reasonRe)
  assert.equal(flagged(all[1]), true, `${label}: recorded as a refusal after approval`)
  sweepDispositions(db)
  assert.equal(db.prepare('SELECT disposition FROM risk_events WHERE id = ?').get(all[0].id).disposition, 'refused_post_approval', `${label}: not "ordered"`)
  const audit = auditDecisions(db, { accountId: A })
  assert.equal(audit.silentDrops, 0, `${label}: /health counts no silent drop (${audit.because})`)
  assert.notEqual(audit.verdict, 'traded', `${label}: and does not read it as traded`)
}

test('B1: an analysis the gate approved only at a stretched target is sent with that target, and the ledger records it', async t => {
  const db = fresh({ halt: false })
  t.after(() => db.close())
  // The prior earned-floor.test.js uses for a stretched admit: rsi2's 1.2R design reaches 1.4R.
  setState(db, 'autopilot_strategy_prior_json', JSON.stringify({ rsi2_reversion: { winRatePct: 48, trades: 900, combos: 40 } }))
  const { post, broker } = await serve(t, db)
  await post('execute-trade', { analysisId: analysis(db, { sl: 1.097, tp: 1.1036, strategy: 'rsi2_reversion' }) })
  const a = approval(db)
  assert.ok(a, 'the gate approved')
  const ef = JSON.parse(a.checks_json).earned_floor
  assert.equal(ef?.stretchedFrom, 1.2, 'approved at a stretch from the 1.2R design')
  assert.equal(broker.orders.length, 1, 'an order reached the broker')
  assert.equal(broker.orders[0].relativeTakeProfit, Math.round((ef.tp1 - 1.1) * 100_000), `the stretched ${ef.tp1}, not the analysis's 1.1036`)
  assert.equal(db.prepare('SELECT tp_price FROM trades').get().tp_price, ef.tp1, 'the trade row records the target that was sent')
})

test('B2: the account\'s own watchlist Max lots caps the order, over the shared list\'s', async t => {
  const db = fresh()
  t.after(() => db.close())
  setState(db, acctWatchlistKey(A), JSON.stringify([{ symbol: SYM, enabled: true, maxVolume: 0.02 }]))
  const { post } = await serve(t, db)
  await post('execute-trade', { analysisId: analysis(db) })
  const c = JSON.parse(approval(db).checks_json)
  assert.ok(c.risk_based_volume > 0.1, `the budget buys ${c.risk_based_volume} lots, so both caps bind`)
  assert.equal(c.adjusted_volume, 0.02, 'the account\'s own cap, not the shared 0.1')
  // An own row with no Max lots of its own still takes the shared row's (the loop's merge: own over shared).
  db.prepare('DELETE FROM risk_events').run()
  setState(db, acctWatchlistKey(A), JSON.stringify([{ symbol: SYM, enabled: true }]))
  await post('execute-trade', { analysisId: analysis(db) })
  assert.equal(JSON.parse(approval(db).checks_json).adjusted_volume, 0.1)
})

test('B3: an analysis the market has already run through its stop is refused after the gate, recorded, and nothing is sent — long and short', async t => {
  for (const [bias, entry, sl, tp, close] of [['long', 1.1, 1.09, 1.135, 1.085], ['short', 1.1, 1.11, 1.065, 1.115]]) {
    const db = fresh({ halt: false })
    const { post, broker } = await serve(t, db, { close })
    const res = await post('execute-trade', { analysisId: analysis(db, { bias, entry, sl, tp }) })
    assert.equal(res.vetoed, true, `${bias}: ${JSON.stringify(res).slice(0, 300)}`)
    assert.match(res.reason, /^sl_wrong_side_at_market: /)
    assert.equal(broker.orders.length, 0, `${bias}: nothing was sent`)
    assertRefusedAfterApproval(db, bias, /^sl_wrong_side_at_market: /)
    db.close()
  }
})

test('B3: the price now on the right side of the stop goes on to the send; no price at all is refused, not guessed', async t => {
  const db = fresh()
  t.after(() => db.close())
  const { post } = await serve(t, db, { close: 1.095 }) // below the planned entry, still above the stop
  const res = await post('execute-trade', { analysisId: analysis(db) })
  assert.match(res.reason, /^guard_halt: /, 'reached the send')
  const db2 = fresh({ halt: false })
  t.after(() => db2.close())
  const { post: post2, broker } = await serve(t, db2, { close: null })
  const res2 = await post2('execute-trade', { analysisId: analysis(db2) })
  assert.equal(res2.vetoed, true, JSON.stringify(res2).slice(0, 300))
  assert.match(res2.reason, /^no_current_price: /)
  assert.equal(broker.orders.length, 0)
  assertRefusedAfterApproval(db2, 'no price', /^no_current_price: /)
})

test('B4: a refusal before any transport (an open intent on the ledger) is recorded after the approval, not thrown as a 500', async t => {
  const db = fresh({ halt: false })
  t.after(() => db.close())
  // An intent still open for this account, symbol and side: the ledger refuses a second (intent_open).
  db.prepare(`INSERT INTO entry_intents (id, account_id, environment, symbol, symbol_id, side, producer_id, basis, mode_epoch, permit_id, permit_expires_at, state)
    VALUES ('iopen1', ?, 'demo', ?, ?, 'BUY', 'route_execute_trade', 'manual', 0, 'popen1', '2099-01-01T00:00:00.000Z', 'SENT')`).run(A, SYM, SYM_ID)
  const { post, broker } = await serve(t, db)
  const res = await post('execute-trade', { analysisId: analysis(db) })
  assert.equal(res.status, 200, `answered, not a server fault: ${JSON.stringify(res).slice(0, 300)}`)
  assert.equal(res.vetoed, true)
  assert.match(res.reason, /^ENTRY_LEDGER_REFUSED: /)
  assert.equal(broker.orders.length, 0, 'nothing was sent')
  assert.equal(db.prepare('SELECT status FROM trades').get().status, 'rejected', 'the write-ahead row is marked rejected')
  assertRefusedAfterApproval(db, 'ledger', /^ENTRY_LEDGER_REFUSED: /)
})
