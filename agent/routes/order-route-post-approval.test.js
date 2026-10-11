// node --test agent/routes/order-route-post-approval.test.js
//
// Claude · № 13,307 11-Oct (owner "yes, fix it, merge when green and read
// back", on № 13,304·C·1; claude-builder)
//
// THE MEASUREMENT. Demo 47790949, 11-10-2026 08:10Z: DOTUSD, AVAXUSD, UNIUSD
// and XLMUSD were approved at the gate, then refused by POST
// /actions/manual-order at the broker's minimum. The refusal WAS written to
// risk_events, but as a plain veto, without the post-approval flag, so
// neither auditor could tie it to its approval: /health read `silent_drop`
// ("4 approval(s) went nowhere with nothing recorded") and
// /state/dispositions listed all four as `dropped`.
//
// A refusal AFTER the gate approved is a post-approval refusal
// (risk.persistPostApprovalVeto), as loop.js, pending-orders.js,
// closed-market-limits.js and momentum-limit-entry.js already record theirs.
// These tests drive the real routes over HTTP with a stand-in broker socket;
// the refusal they reach after the gate is the order guard's kill switch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import express from 'express'
import { initDB, setState } from '../db.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'
import { recordMarketCalendar } from '../services/market-calendar.js'
import { _resetEntryHoursRefresh } from '../services/entry-hours.js'
import { PT, _setWebSocketForTests } from '../lib/ctrader-ws.js'
import { auditDecisions } from '../services/decision-audit.js'
import { sweepDispositions } from '../services/opportunity-disposition.js'
import { POST_APPROVAL_FLAG, persistRiskEvent } from '../services/risk.js'
import actionsRouter from './actions.js'

const A = '4242'
const SYM = 'EURUSD', SYM_ID = 1
const HOST = 'demo.ctraderapi.com'
const WEEK = 7 * 86400

function fresh() {
  _resetEntryHoursRefresh()
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
  setState(db, 'autopilot_symbols_json', JSON.stringify([{ symbol: SYM, enabled: true, maxVolume: 0.3 }]))
  // The kill switch: every order is refused at the send, AFTER the gate.
  setState(db, 'exec_guard_json', JSON.stringify({ halt: true }))
  return db
}

/** A broker socket that answers auth, 1m bars and the lot record; anything else is recorded, never answered. */
function fakeBroker(close = 1.1) {
  const sent = []
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; setImmediate(() => this.emit('open')) }
    send(raw) {
      const m = JSON.parse(raw)
      if (m.payloadType === PT.HEARTBEAT) return
      sent.push(m.payloadType)
      const minute = Math.floor(Date.now() / 60_000)
      const answer = {
        [PT.APP_AUTH_REQ]: [PT.APP_AUTH_RES, {}],
        [PT.ACCOUNT_AUTH_REQ]: [PT.ACCOUNT_AUTH_RES, { ctidTraderAccountId: m.payload?.ctidTraderAccountId }],
        [PT.GET_TRENDBARS_REQ]: [PT.GET_TRENDBARS_RES, {
          ctidTraderAccountId: m.payload?.ctidTraderAccountId, symbolId: m.payload?.symbolId, period: m.payload?.period,
          trendbar: [{ low: Math.round(close * 100_000) - 50, deltaOpen: 0, deltaHigh: 60, deltaClose: 50, utcTimestampInMinutes: minute - 1, volume: 1 }],
        }],
        [PT.SYMBOL_BY_ID_REQ]: [PT.SYMBOL_BY_ID_RES, {
          ctidTraderAccountId: m.payload?.ctidTraderAccountId,
          symbol: [].concat(m.payload?.symbolId ?? []).map(id => ({ symbolId: id, lotSize: 10_000_000, minVolume: 100_000, maxVolume: 100_000_000_000, stepVolume: 100_000, digits: 5, pipPosition: 4 })),
        }],
      }[m.payloadType]
      if (!answer) return
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ payloadType: answer[0], payload: answer[1], clientMsgId: m.clientMsgId }))))
    }
    close() { this.readyState = 3 }
  }
  return { Socket, sent }
}

async function serve(t, db) {
  const broker = fakeBroker(1.1)
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
  }).then(r => r.json())
  return { post, broker }
}

const rows = db => db.prepare('SELECT id, approved, veto_reason, checks_json, account_id, symbol, side FROM risk_events ORDER BY id').all()
const flagged = r => new RegExp(`"${POST_APPROVAL_FLAG}"\\s*:\\s*true`).test(String(r.checks_json || ''))

/** The approval and its refusal are tied together by both auditors. */
function assertAccounted(db, label) {
  const [approval, refusal, ...rest] = rows(db)
  assert.equal(rest.length, 0, `${label}: one approval and one refusal, nothing else`)
  assert.equal(approval.approved, 1, `${label}: the gate approved (${approval.veto_reason})`)
  assert.equal(refusal.approved, 0)
  assert.equal(flagged(refusal), true, `${label}: the refusal after the gate carries the post-approval flag`)
  assert.equal(refusal.account_id, A)
  sweepDispositions(db)
  const disp = db.prepare('SELECT disposition FROM risk_events WHERE id = ?').get(approval.id).disposition
  assert.equal(disp, 'refused_post_approval', `${label}: /state/dispositions no longer reads it as dropped`)
  const audit = auditDecisions(db, { accountId: A })
  assert.equal(audit.silentDrops, 0, `${label}: /health no longer counts a silent drop (${audit.because})`)
  assert.notEqual(audit.verdict, 'silent_drop')
  return { approval, refusal }
}

test('manual-order: a refusal after the gate approved is recorded as a post-approval refusal, not a silent drop', async t => {
  const db = fresh(); t.after(() => db.close())
  const { post, broker } = await serve(t, db)
  const res = await post('manual-order', { account: A, symbol: SYM, side: 'BUY', lots: 0.01, sl: 1.09, tp: 1.135 })
  assert.equal(res.vetoed, true, JSON.stringify(res).slice(0, 300))
  assert.match(res.reason, /^guard_halt: /)
  assert.equal(broker.sent.includes(PT.NEW_ORDER_REQ), false, 'nothing was sent')
  const { refusal } = assertAccounted(db, 'manual-order')
  assert.match(refusal.veto_reason, /^guard_halt: /)
})

test('execute-trade: the same, for an order placed from an analysis', async t => {
  const db = fresh(); t.after(() => db.close())
  const { post, broker } = await serve(t, db)
  const analysisId = db.prepare(`INSERT INTO analyses (symbol, consensus_bias, overall_conviction, synthesis, entry_price, sl_price, tp1_price, strategy, analyzed_at)
    VALUES (?, 'long', 9, '{}', 1.1, 1.09, 1.135, 'ema_pullback', ?)`).run(SYM, new Date().toISOString()).lastInsertRowid
  const res = await post('execute-trade', { analysisId: Number(analysisId) })
  assert.equal(res.vetoed, true, JSON.stringify(res).slice(0, 300))
  assert.match(res.reason, /^guard_halt: /)
  assert.equal(broker.sent.includes(PT.NEW_ORDER_REQ), false, 'nothing was sent')
  assertAccounted(db, 'execute-trade')
})

// Codex P2 on #1322: /actions/execute-trade writes its trade row BEFORE the
// send and marks it 'rejected' when a guard_ refusal is thrown at the send.
// That row must not read as an order that landed. Reachable: an analysis with
// no TP passes the gate (R:R is judged only when tp1 is present) and the
// bracket guard then throws guard_no_target.
test('execute-trade: a guard refusal thrown at the send, after the write-ahead row, still reads as refused after approval', async t => {
  const db = fresh(); t.after(() => db.close())
  setState(db, 'exec_guard_json', 'null') // no kill switch: the send itself refuses
  const { post, broker } = await serve(t, db)
  const analysisId = db.prepare(`INSERT INTO analyses (symbol, consensus_bias, overall_conviction, synthesis, entry_price, sl_price, tp1_price, strategy, analyzed_at)
    VALUES (?, 'long', 9, '{}', 1.1, 1.09, NULL, 'ema_pullback', ?)`).run(SYM, new Date().toISOString()).lastInsertRowid
  const res = await post('execute-trade', { analysisId: Number(analysisId) })
  assert.equal(res.vetoed, true, JSON.stringify(res).slice(0, 300))
  assert.match(res.reason, /^guard_no_target: /)
  assert.equal(broker.sent.includes(PT.NEW_ORDER_REQ), false, 'nothing was sent')
  const trade = db.prepare('SELECT status, risk_event_id FROM trades').get()
  assert.equal(trade.status, 'rejected', 'the write-ahead row is marked rejected')
  const { approval } = assertAccounted(db, 'execute-trade (thrown at the send)')
  assert.equal(trade.risk_event_id, approval.id, 'and it is linked to the approval')
})

// Codex P2 on #1322 (second round): /health counted that rejected write-ahead
// row as a landed trade AND its refusal as a resolution — one attempt
// accounting for two approvals — so a genuine silent drop on the same day
// was hidden. The rejected row now counts once, as its refusal.
test('the health audit counts a refused write-ahead attempt once, so a real silent drop beside it still shows', async t => {
  const db = fresh(); t.after(() => db.close())
  setState(db, 'exec_guard_json', 'null')
  const { post } = await serve(t, db)
  const analysisId = db.prepare(`INSERT INTO analyses (symbol, consensus_bias, overall_conviction, synthesis, entry_price, sl_price, tp1_price, strategy, analyzed_at)
    VALUES (?, 'long', 9, '{}', 1.1, 1.09, NULL, 'ema_pullback', ?)`).run(SYM, new Date().toISOString()).lastInsertRowid
  const res = await post('execute-trade', { analysisId: Number(analysisId) })
  assert.match(res.reason, /^guard_no_target: /)
  assert.equal(auditDecisions(db, { accountId: A }).silentDrops, 0, 'the refused attempt alone is accounted for')
  // a genuine silent drop: approved, nothing landed, nothing refused
  persistRiskEvent(db, { symbol: 'GBPUSD', side: 'BUY', entry: 1.3, sl: 1.29, tp1: 1.34, accountId: A, strategy: 'ema_pullback' }, { approved: true, checks: {} })
  const audit = auditDecisions(db, { accountId: A })
  assert.equal(audit.silentDrops, 1, `the real drop is not hidden by the double count (${audit.because})`)
  assert.equal(audit.verdict, 'silent_drop')
})

test('a refusal BEFORE the gate stays a plain veto: a typed lots below the broker minimum was never approved', async t => {
  const db = fresh(); t.after(() => db.close())
  const { post } = await serve(t, db)
  const res = await post('manual-order', { account: A, symbol: SYM, side: 'BUY', lots: 0.001, sl: 1.09, tp: 1.135 })
  assert.equal(res.reason, 'below_min_volume: 0.001 lots < broker minimum (0.01 lots)')
  const all = rows(db)
  assert.equal(all.length, 1)
  assert.equal(all[0].approved, 0)
  assert.equal(flagged(all[0]), false, 'no approval exists for it to resolve')
})

// Every refusal the two routes write after their gate goes through the
// post-approval writer; the one before the gate stays a plain veto.
// Comment-stripped source (CLAUDE.md failure mode #2).
test('wiring: after each route\'s gate, no refusal is written as a plain veto', () => {
  const src = readFileSync(new URL('./actions.js', import.meta.url), 'utf8')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  for (const route of ["router.post('/execute-trade'", "router.post('/manual-order'"]) {
    const start = src.indexOf(route)
    assert.ok(start > 0, route)
    const handler = src.slice(start, src.indexOf('\n  router.', start + 10))
    const gate = handler.indexOf('evaluateTrade(db, proposal')
    assert.ok(gate > 0, `${route}: gate found`)
    const after = handler.slice(gate)
    assert.equal(/persistRiskEvent\(db, proposal, \{ approved: false/.test(after), false, `${route}: a plain veto after the gate`)
    assert.ok((after.match(/persistPostApprovalVeto\(db, proposal, /g) || []).length >= 3, `${route}: size, guard and thrown-guard refusals`)
  }
})

// ---------------------------------------------------------------------------
// Lot fix — Claude · № 13,396 12-Oct (owner "Go lot fix" after № 13,394;
// claude-builder). An empty Lots box on the pad means "risk-based sizing" (the
// pad's own label). The route sent 0.01 instead, which the gate read as a
// ceiling: DOGEUSD on …0949, 11-10, went out at 0.01 lots against a
// risk-based 18.91 ($0.23 at risk instead of $428). Through the real route,
// the real gate and a stand-in broker (the kill switch stops the send, after
// the gate has sized the order).
// ---------------------------------------------------------------------------
const approvalChecks = db => JSON.parse(db.prepare('SELECT checks_json FROM risk_events WHERE approved = 1 ORDER BY id LIMIT 1').get().checks_json)

test('lot fix: a pad order with no lots is sized by the risk budget, not a hidden 0.01', async t => {
  const db = fresh(); t.after(() => db.close())
  const { post } = await serve(t, db)
  const res = await post('manual-order', { account: A, symbol: SYM, side: 'BUY', sl: 1.09, tp: 1.135 })
  assert.match(res.reason, /^guard_halt: /, JSON.stringify(res).slice(0, 300))
  const c = approvalChecks(db)
  assert.ok(c.risk_based_volume > 0.01, `the budget buys ${c.risk_based_volume} lots`)
  assert.equal(c.adjusted_volume, c.risk_based_volume, 'the order is the risk-based size, uncapped')
  const proposal = JSON.parse(db.prepare('SELECT proposal_json FROM risk_events WHERE approved = 1').get().proposal_json)
  assert.equal(proposal.requestedVolume, null, 'nothing typed, nothing capped')
})

test('lot fix: a typed lots is still the ceiling the trader set', async t => {
  const db = fresh(); t.after(() => db.close())
  const { post } = await serve(t, db)
  await post('manual-order', { account: A, symbol: SYM, side: 'BUY', lots: 0.02, sl: 1.09, tp: 1.135 })
  const c = approvalChecks(db)
  assert.ok(c.risk_based_volume > 0.02)
  assert.equal(c.adjusted_volume, 0.02)
})

test('lot fix: an analysis executed with no watchlist Max lots is sized by the risk budget; with one, capped there', async t => {
  const db = fresh(); t.after(() => db.close())
  setState(db, 'autopilot_symbols_json', JSON.stringify([{ symbol: SYM, enabled: true }]))   // no maxVolume
  const { post } = await serve(t, db)
  const insert = () => db.prepare(`INSERT INTO analyses (symbol, consensus_bias, overall_conviction, synthesis, entry_price, sl_price, tp1_price, strategy, analyzed_at)
    VALUES (?, 'long', 9, '{}', 1.1, 1.09, 1.135, 'ema_pullback', ?)`).run(SYM, new Date().toISOString()).lastInsertRowid
  await post('execute-trade', { analysisId: Number(insert()) })
  let c = approvalChecks(db)
  assert.ok(c.risk_based_volume > 0.01)
  assert.equal(c.adjusted_volume, c.risk_based_volume, 'no Max lots: the risk-based size')
  db.prepare('DELETE FROM risk_events').run()
  setState(db, 'autopilot_symbols_json', JSON.stringify([{ symbol: SYM, enabled: true, maxVolume: 0.02 }]))
  await post('execute-trade', { analysisId: Number(insert()) })
  c = approvalChecks(db)
  assert.equal(c.adjusted_volume, 0.02, 'the watchlist Max lots is the ceiling')
})
