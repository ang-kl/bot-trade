// node --test agent/services/stuck-resolver.test.js
//
// V3 I3 — the stuck-record resolver under the owner's write-off rule
// (25-09-2026 21:30 SGT). What must hold, on the production shapes read from
// GET /state/order-lifecycle at 7562efe / 2e80f39 (25-09-2026 13:55 UTC):
//   1. a stuck record with broker evidence is SETTLED from it (R2 a closing
//      deal no ledger row carries; R5 the row the reconciler adopted; R1 a
//      fill carrying the resting order's intent, or its order gone from the
//      book; R6 a capture whose missing field now exists; R7 a target the bot
//      recorded elsewhere);
//   2. one with none is WRITTEN OFF: terminal, reason + evidence + timestamp,
//      its row never deleted and never rewritten into a status it did not
//      reach, no money written onto it, no longer counted as stuck, and
//      named as a notice (STK-12);
//   3. evidence that could belong to two records settles neither (contested);
//   4. nothing is written off before its age bound — a young in-flight row
//      stays stuck (still counted), not silently ended;
//   5. bounded (at most maxWrites per kind per pass) and idempotent (a second
//      pass changes nothing);
//   6. the resolver never touches the broker: it imports no order path;
//   7. the ticker runs it before the snapshot, and a failing resolver fails
//      the beat without withholding the snapshot.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from '../db.js'
import {
  runStuckResolver, resolveInflightTrades, resolveRestingOrders, resolveCaptures, resolveTargetless, recordedTargetEvidence,
  missingFieldsOf, castIntKey, WRITE_OFF_AGE_MS, LAST_KEY, ENABLED_KEY, TARGET_WRITE_KEY, MAX_WRITES_PER_KIND,
} from './stuck-resolver.js'
import { inflightLiveSql, UNRESOLVED_NO_EVIDENCE, UNRESOLVED_AMBIGUOUS, UNRESOLVED_NO_RECORD, UNRESOLVED_NO_TARGET } from '../lib/stuck-resolutions.js'
import { buildOrderLifecycle } from './order-lifecycle.js'
import { countForSymbol } from './symbol-position-cap.js'
import { openPositionsFor } from './tick-permits.js'
import { runOrderLifecyclePass, runResolverStep } from './order-lifecycle-ticker.js'

const NOW = Date.parse('2026-09-25T14:00:00Z')
const D58 = '46130058', D42 = '43097342', D08 = '46979908', D49 = '47790949'
const label = tag => `AP|v3|FIB|H|LDN|1h|TR${tag ? `|${tag}` : ''}`

function ins(db, table, row) {
  const cols = Object.keys(row)
  return Number(db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => row[c])).lastInsertRowid)
}
const trade = (db, o) => ins(db, 'trades', { side: 'BUY', origin: 'bot_market_dispatch', ...o })
const deal = (db, o) => ins(db, 'broker_deals', { side: 'BUY', lots: 1, swap: 0, ...o })
const res = (db, subject) => db.prepare('SELECT * FROM stuck_resolutions WHERE subject = ?').get(subject)
const row = (db, table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
const counts = db => ({
  trades: db.prepare('SELECT COUNT(*) AS n FROM trades').get().n,
  pending: db.prepare('SELECT COUNT(*) AS n FROM pending_orders').get().n,
  capture: db.prepare('SELECT COUNT(*) AS n FROM position_capture_queue').get().n,
})
const lifecycle = (db, rule) => {
  const r = buildOrderLifecycle(db, { nowMs: NOW, account: 'all', rule, limit: 200 })
  return Object.values(r.stages).flat().find(x => x.id === rule)
}

// ---------------------------------------------------------------- R2 + R5
/** The in-flight production shapes of STK-03 (…7342 0003.HK, …0058 SUGAR, …0058 BTCUSD). */
function inflightFixture() {
  const db = initDB(':memory:')
  // #1398 …7342 0003.HK submitting 28-08 02:06:18; CLS-01 names the broker
  // closing deal 316639118 of position 238993864 at 02:06:35 with no ledger row.
  trade(db, { id: 1398, symbol: '0003.HK', status: 'submitting', account_id: D42, opened_at: '2026-08-28 02:06:18', entry_price: 30.1, proposal_entry_price: 30.1 })
  deal(db, { deal_id: '316639118', position_id: '238993864', account_id: D42, symbol: '0003.HK', entry_price: 30.0, close_price: 29.9,
    opened_at: '2026-08-28T02:06:19.000Z', closed_at: '2026-08-28T02:06:35.000Z', gross_pnl: -30, commission: -4.02, net_pnl: -34.02 })
  // #1466 …0058 SUGAR unconfirmed 07-09 10:35:37: no deal, no adoption.
  trade(db, { id: 1466, symbol: 'SUGAR', status: 'unconfirmed', account_id: D58, opened_at: '2026-09-07 10:35:37' })
  // #1439 …0058 BTCUSD unconfirmed 03-09 08:54:36, and the row the reconciler
  // adopted for its fill (adoption stamp 08:57:10, no deal yet: still open).
  trade(db, { id: 1439, symbol: 'BTCUSD', status: 'unconfirmed', account_id: D58, opened_at: '2026-09-03 08:54:36' })
  trade(db, { id: 1500, symbol: 'BTCUSD', status: 'open', account_id: D58, opened_at: '2026-09-03 08:57:10', origin: 'reconciler_adopted', ctrader_position_id: '240100001' })
  // A young unconfirmed row (3 h): stuck, but not yet past the write-off bound.
  trade(db, { id: 1700, symbol: 'EURUSD', status: 'unconfirmed', account_id: D08, opened_at: '2026-09-25 11:00:00' })
  return db
}

test('R2: an in-flight row whose fill is a closing deal no ledger row carries becomes that closed trade (#1398 0003.HK)', () => {
  const db = inflightFixture()
  assert.equal(row(db, 'trades', 1398).status, 'submitting', 'precondition: stuck in flight')
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE ctrader_position_id = '238993864'`).get().n, 0, 'precondition: no ledger row carries the deal')
  assert.ok(lifecycle(db, 'CLS-01').sample.some(e => e.subject === `position:${D42}:238993864`), 'precondition: CLS-01 names the unrecorded close')
  const out = resolveInflightTrades(db, { nowMs: NOW })
  assert.equal(out.settledFromDeal, 1)
  const t = row(db, 'trades', 1398)
  assert.equal(t.status, 'closed')
  assert.equal(t.ctrader_position_id, '238993864')
  assert.equal(t.net_pnl, -34.02, 'the broker money, not an estimate')
  assert.equal(t.entry_price, 30.0, "the broker's fill, the intent kept in proposal_entry_price")
  assert.equal(t.proposal_entry_price, 30.1)
  assert.equal(t.exit_price, 29.9)
  assert.equal(t.closed_at_ms, Date.parse('2026-08-28T02:06:35Z'))
  assert.match(t.close_reason, /^closed at the broker — settled by the stuck resolver from broker deal\(s\) 316639118; the close cause is not recorded$/)
  assert.equal(db.prepare(`SELECT matched_trade_id FROM broker_deals WHERE deal_id = '316639118'`).get().matched_trade_id, 1398)
  const r = res(db, 'trade:1398')
  assert.equal(r.outcome, 'settled')
  assert.equal(r.position_id, '238993864')
  assert.equal(JSON.parse(r.evidence_json).fill.dealIds[0], '316639118')
  assert.ok(!lifecycle(db, 'CLS-01').sample.some(e => e.subject === `position:${D42}:238993864`), 'the close is recorded now')
  assert.ok(!lifecycle(db, 'STK-03').sample.some(e => e.subject === 'trade:1398'))
})

test('R2: a row already naming its position settles on that position\'s own deal; money a deal lacks stays NULL, never a 0', () => {
  const db = initDB(':memory:')
  trade(db, { id: 1395, symbol: 'TSLA.US', status: 'submitting', account_id: D42, opened_at: '2026-08-27 16:52:48', ctrader_position_id: '238945106' })
  // Opened 20 min after the submission (outside the fill window) — but it IS the row's own position.
  deal(db, { deal_id: '316570134', position_id: '238945106', account_id: D42, symbol: 'TSLA.US', entry_price: 340, close_price: 339, opened_at: '2026-08-27T17:12:48.000Z', closed_at: '2026-08-27T17:54:31.000Z', gross_pnl: null, commission: -0.5, net_pnl: -22.86 })
  resolveInflightTrades(db, { nowMs: NOW })
  const t = row(db, 'trades', 1395)
  assert.equal(t.status, 'closed')
  assert.equal(t.net_pnl, -22.86)
  assert.equal(t.gross_pnl, null, 'the deal carries no gross: none is invented')
  assert.equal(JSON.parse(res(db, 'trade:1395').evidence_json).fill.own, true)
})

test('R5: an in-flight row whose fill the reconciler adopted is ended as that row\'s duplicate — kept, not deleted, not re-statused (#1439 BTCUSD)', () => {
  const db = inflightFixture()
  db.prepare(`UPDATE trades SET strategy = 'donchian_breakout', risk_event_id = 4242, label_raw = ? WHERE id = 1439`).run(label('ib7c1439aaaaa'))
  const before = counts(db)
  resolveInflightTrades(db, { nowMs: NOW })
  const r = res(db, 'trade:1439')
  assert.equal(r.outcome, 'settled')
  assert.equal(r.verdict, 'duplicate of trade #1500')
  assert.equal(r.position_id, '240100001')
  assert.equal(row(db, 'trades', 1439).status, 'unconfirmed', 'the row keeps what it said; the resolution ends it')
  assert.equal(row(db, 'trades', 1500).status, 'open', 'the adopted row is untouched')
  // NIT 7: the submission's attribution is kept in the resolution, NOT
  // carried onto the open adopted row (that write can change how it is
  // managed — an owner decision).
  const ev = JSON.parse(r.evidence_json)
  assert.deepEqual(ev.attribution, { origin: 'bot_market_dispatch', strategy: 'donchian_breakout', labelStrategy: null, riskEventId: 4242, labelRaw: label('ib7c1439aaaaa') })
  assert.match(r.reason, /attribution \(donchian_breakout, risk event 4242\) is kept in this resolution, not carried onto #1500/)
  assert.equal(row(db, 'trades', 1500).strategy, null)
  assert.equal(row(db, 'trades', 1500).risk_event_id, null)
  assert.deepEqual(counts(db), before, 'nothing deleted')
  const stk = lifecycle(db, 'STK-03')
  assert.ok(!stk.sample.some(e => e.subject === 'trade:1439'))
  assert.equal(stk.classes.settled, 1)
})

test('R2 write-off: no broker evidence after 24 h → terminal "unresolved: no broker evidence", excluded from money, counted as a notice (#1466 SUGAR)', () => {
  const db = inflightFixture()
  assert.ok(lifecycle(db, 'STK-03').sample.some(e => e.subject === 'trade:1466'), 'precondition: STK-03 counts it stuck')
  resolveInflightTrades(db, { nowMs: NOW })
  const r = res(db, 'trade:1466')
  assert.equal(r.outcome, 'unresolved')
  assert.equal(r.verdict, UNRESOLVED_NO_EVIDENCE)
  assert.equal(r.prior_state, 'unconfirmed')
  assert.equal(r.resolved_at, new Date(NOW).toISOString())
  assert.match(r.reason, /no broker deal, no adopted position and no ledger row on …0058 SUGAR BUY/)
  assert.deepEqual(JSON.parse(r.evidence_json).checked, ['broker_deals', 'trades (reconciler-adopted rows)'])
  const t = row(db, 'trades', 1466)
  assert.equal(t.status, 'unconfirmed', 'never rewritten into rejected/cancelled — nobody observed either')
  assert.equal(t.net_pnl, null, 'no money written onto a written-off record')
  const stk = lifecycle(db, 'STK-03')
  assert.ok(!stk.sample.some(e => e.subject === 'trade:1466'), 'no longer counted as stuck')
  assert.equal(stk.classes.written_off, 1, 'still judged and shown in the rule\'s classes')
  const notice = lifecycle(db, 'STK-12')
  assert.equal(notice.severity, 'notice')
  const e = notice.sample.find(x => x.subject === 'trade:1466')
  assert.ok(e, 'named as a notice')
  assert.equal(e.verdict, UNRESOLVED_NO_EVIDENCE)
  const report = buildOrderLifecycle(db, { nowMs: NOW, account: 'all' })
  assert.ok(report.summary.stuck.notices >= 1)
})

test('age bound: a young stuck row is NOT written off — it stays stuck and counted (never silently ended)', () => {
  const db = inflightFixture()
  const out = resolveInflightTrades(db, { nowMs: NOW })
  assert.equal(res(db, 'trade:1700'), undefined)
  assert.equal(out.waiting, 1)
  assert.ok(lifecycle(db, 'STK-03').sample.some(e => e.subject === 'trade:1700'), 'still stuck')
  // Past the bound it is ended.
  resolveInflightTrades(db, { nowMs: Date.parse('2026-09-25T11:00:00Z') + WRITE_OFF_AGE_MS + 1 })
  assert.equal(res(db, 'trade:1700').outcome, 'unresolved')
})

test('contested: one broker fill two stuck rows reach for settles neither — both written off as ambiguous with the candidate named', () => {
  const db = initDB(':memory:')
  trade(db, { id: 1428, symbol: 'BTCUSD', status: 'unconfirmed', account_id: D58, opened_at: '2026-09-02 23:25:18' })
  trade(db, { id: 1429, symbol: 'BTCUSD', status: 'unconfirmed', account_id: D58, opened_at: '2026-09-02 23:25:40' })
  deal(db, { deal_id: '9001', position_id: '239900001', account_id: D58, symbol: 'BTCUSD', entry_price: 100, close_price: 101, opened_at: '2026-09-02T23:25:41.000Z', closed_at: '2026-09-03T01:00:00.000Z', gross_pnl: 1, commission: 0, net_pnl: 1 })
  resolveInflightTrades(db, { nowMs: NOW })
  for (const id of [1428, 1429]) {
    const r = res(db, `trade:${id}`)
    assert.equal(r.outcome, 'unresolved')
    assert.equal(r.verdict, UNRESOLVED_AMBIGUOUS)
    assert.equal(JSON.parse(r.evidence_json).candidates[0].positionId, '239900001')
    assert.equal(row(db, 'trades', id).ctrader_position_id, null, 'never settled onto a fill it cannot claim alone')
  }
  assert.equal(db.prepare(`SELECT matched_trade_id FROM broker_deals WHERE deal_id = '9001'`).get().matched_trade_id, null)
})

test('the symbol cap and the tick position count stop holding a slot for an in-flight row the resolver ended', () => {
  const db = initDB(':memory:')
  // …0949 USDHKD: #797, #789, #661 unconfirmed since August — three rows hold the cap of 3.
  for (const [id, at] of [[797, '2026-08-06 08:02:30'], [789, '2026-08-06 07:25:39'], [661, '2026-08-03 22:36:47']]) trade(db, { id, symbol: 'USDHKD', status: 'unconfirmed', account_id: D49, opened_at: at })
  assert.equal(countForSymbol(db, D49, 'USDHKD').inFlight, 3, 'precondition: the stale rows hold the symbol')
  assert.equal(openPositionsFor(db, D49).total, 3)
  resolveInflightTrades(db, { nowMs: NOW })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM stuck_resolutions WHERE outcome = 'unresolved'`).get().n, 3)
  assert.equal(countForSymbol(db, D49, 'USDHKD').inFlight, 0)
  assert.equal(openPositionsFor(db, D49).total, 0)
  // A live in-flight row still counts: only ENDED rows are excluded.
  trade(db, { id: 1800, symbol: 'USDHKD', status: 'submitting', account_id: D49, opened_at: '2026-09-25 13:59:00' })
  assert.equal(countForSymbol(db, D49, 'USDHKD').inFlight, 1)
  assert.equal(openPositionsFor(db, D49).total, 1)
})

test('inflightLiveSql: a database without the table reads exactly as before I3 (never a query that throws into an empty catch)', () => {
  const fake = { prepare: () => ({ get: () => undefined }) }
  assert.equal(inflightLiveSql(fake), '')
  const db = initDB(':memory:')
  assert.match(inflightLiveSql(db, 't'), /NOT EXISTS \(SELECT 1 FROM stuck_resolutions sr WHERE sr\.trade_id = t\.id AND sr\.kind = 'trade_inflight'\)/)
})

// ---------------------------------------------------------------- R1
/** The six orphaned resting rows of STK-01 (…0058 and …9908, pending-fib), plus a live one and ORD-10's wrong 'expired' row. */
function restingFixture() {
  const db = initDB(':memory:')
  const pend = (id, acct, symbol, order, expires, o = {}) => ins(db, 'pending_orders', { id, symbol, order_id: order, dir: 1, level: 1, sl: 0.9, tp: 1.2, volume: 1, status: 'working', note: 'pending-fib', account_id: acct, placed_at: '2026-09-12 07:12:00', expires_at: expires, ...o })
  const book = (order, acct, status, gone) => ins(db, 'broker_orders', { order_id: order, account_id: acct, symbol: 'X', label: 'AP|v3', is_bot: 1, status, gone_at: gone })
  const intent = (id, acct, order, symbol) => ins(db, 'entry_intents', { id, account_id: acct, environment: 'demo', symbol, side: 'BUY', order_type: 'LIMIT', volume: 1, producer_id: 'pending_fib_orders', basis: 'bar', mode_epoch: 1, permit_id: `p-${id}`, permit_expires_at: '2026-09-12T08:00:00Z', state: 'FILLED', broker_order_id: order, created_at: '2026-09-12T07:12:00Z', updated_at: '2026-09-12T07:12:00Z' })
  // #671 QCOM.US: order gone 25-09 07:47:42 (the owner's cancellation), no fill.
  pend(671, D58, 'QCOM.US', '360473880', '2026-09-20T07:12:00Z'); book('360473880', D58, 'gone', '2026-09-25 07:47:42')
  // #669 SGDJPY: trade 1716 carries iowbtj8tx66xi.
  pend(669, D58, 'SGDJPY', '360473877', '2026-09-26T07:12:00Z'); book('360473877', D58, 'gone', '2026-09-24 09:51:14')
  intent('iowbtj8tx66xi', D58, '360473877', 'SGDJPY')
  trade(db, { id: 1716, account_id: D58, symbol: 'SGDJPY', label_raw: label('iowbtj8tx66xi'), opened_at: '2026-09-24 09:51:14', status: 'open', origin: 'reconciler_adopted', ctrader_position_id: '242000001' })
  // #661 AUDPLN on …9908: trade 1598 carries ie2nl08vaiq8p.
  pend(661, D08, 'AUDPLN', '360470004', '2026-09-20T06:58:00Z')
  intent('ie2nl08vaiq8p', D08, '360470004', 'AUDPLN')
  trade(db, { id: 1598, account_id: D08, symbol: 'AUDPLN', label_raw: label('ie2nl08vaiq8p'), opened_at: '2026-09-14 03:00:00', status: 'closed', net_pnl: 1, closed_at: '2026-09-15 03:00:00', origin: 'reconciler_adopted', ctrader_position_id: '242000002' })
  // #664 0011.HK and #662 0267.HK: no broker record at all, expiry long past.
  pend(664, D08, '0011.HK', '360470001', '2026-09-12T18:58:00Z')
  pend(662, D08, '0267.HK', '360470003', '2026-09-13T06:58:00Z')
  // A row whose order is still working at the broker past our expiry: live, never cancelled here.
  pend(650, D08, 'MSFT.US', '360460000', '2026-09-20T00:00:00Z'); book('360460000', D08, 'working', null)
  // A pending-closed row belongs to closed-market-limits.js's own resolver.
  pend(640, D08, 'AAPL.US', '360450000', '2026-09-20T00:00:00Z', { note: 'pending-closed' })
  // ORD-10: #705 NATGAS stored 'expired' while trade 1661 carries its intent.
  ins(db, 'pending_orders', { id: 705, symbol: 'NATGAS', order_id: '705', dir: 1, level: 3, sl: 2.9, volume: 1, status: 'expired', note: 'pending-closed: gone at broker, no fill adopted', account_id: D42, placed_at: '2026-09-15 21:39:01' })
  intent('i1ea06ki4vdgt', D42, '705', 'NATGAS')
  trade(db, { id: 1661, account_id: D42, symbol: 'NATGAS', label_raw: label('i1ea06ki4vdgt'), opened_at: '2026-09-16 01:00:00', status: 'closed', net_pnl: 2, closed_at: '2026-09-16 05:00:00', origin: 'reconciler_adopted', ctrader_position_id: '242000003' })
  return db
}

test('R1: the orphaned resting rows settle from the broker — filled where a trade carries the intent, expired where the order left the book, written off where the broker has nothing', () => {
  const db = restingFixture()
  const stk01 = lifecycle(db, 'STK-01')
  assert.equal(stk01.violations, 7, 'precondition: STK-01 counts the six production rows, the live order past expiry and the pending-closed row')
  const before = counts(db)
  const out = resolveRestingOrders(db, { nowMs: NOW })
  const status = id => row(db, 'pending_orders', id).status
  assert.equal(status(669), 'filled'); assert.equal(res(db, 'pending:669').verdict, 'filled')
  assert.equal(status(661), 'filled')
  assert.match(row(db, 'pending_orders', 661).note, /filled: trade 1598 carries intent ie2nl08vaiq8p \(stuck resolver\)$/)
  assert.equal(status(671), 'expired')
  assert.match(row(db, 'pending_orders', 671).note, /gone at broker 2026-09-25 07:47:42; no fill carries its intent — expired or cancelled, the cause is not recorded/)
  assert.equal(status(664), 'unresolved'); assert.equal(res(db, 'pending:664').verdict, UNRESOLVED_NO_EVIDENCE)
  assert.equal(status(662), 'unresolved')
  assert.equal(status(650), 'working', 'still working at the broker: nothing to settle, never cancelled by a resolver')
  assert.equal(res(db, 'pending:650'), undefined)
  assert.equal(status(640), 'working', "a pending-closed row is left to its own resolver")
  assert.equal(status(705), 'filled', 'ORD-10: the wrong expired row re-judged on the same evidence')
  assert.equal(res(db, 'pending:705').rule_id, 'ORD-10')
  assert.equal(res(db, 'pending:705').prior_state, 'expired')
  assert.equal(out.stillWorkingAtBroker, 1)
  assert.deepEqual(counts(db), before, 'nothing deleted')
  const after = lifecycle(db, 'STK-01')
  assert.deepEqual(after.sample.map(e => e.subject).sort(), ['pending:640', 'pending:650'], 'only the live order past expiry and the other resolver\'s row remain')
  assert.ok(after.sample.every(e => e.resolverExists === true))
  assert.equal(lifecycle(db, 'ORD-10').violations, 0)
  assert.deepEqual(lifecycle(db, 'STK-12').sample.map(e => e.subject).sort(), ['pending:662', 'pending:664'])
})

test('R1 age bound: a working row placed 2 h ago with no broker record yet is NOT written off — a lagging order sync is not a dead order (checker NIT 2)', () => {
  const db = initDB(':memory:')
  ins(db, 'pending_orders', { id: 900, symbol: 'EURUSD', order_id: '361000900', dir: 1, level: 1.1, sl: 1.09, tp: 1.12, volume: 1, status: 'working', note: 'pending-fib', account_id: D08,
    placed_at: new Date(NOW - 2 * 3_600_000).toISOString().slice(0, 19).replace('T', ' '), expires_at: null })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM broker_orders`).get().n, 0, 'precondition: no broker_orders row')
  assert.equal(lifecycle(db, 'STK-01').violations, 1, 'precondition: STK-01 counts it (no broker order past 1 h)')
  const out = resolveRestingOrders(db, { nowMs: NOW })
  assert.equal(out.waiting, 1)
  assert.equal(out.writtenOff, 0)
  assert.equal(row(db, 'pending_orders', 900).status, 'working')
  assert.equal(res(db, 'pending:900'), undefined)
  // Past its bound it is written off.
  resolveRestingOrders(db, { nowMs: NOW - 2 * 3_600_000 + WRITE_OFF_AGE_MS + 60_000 })
  assert.equal(row(db, 'pending_orders', 900).status, 'unresolved')
})

test('R1 terminal rows: only a row whose order an intent carries is read, newest first — a page of intent-less rows never hides it (checker NIT 5)', () => {
  const db = initDB(':memory:')
  const pend = (id, order) => ins(db, 'pending_orders', { id, symbol: 'NATGAS', order_id: order, dir: 1, level: 3, sl: 2.9, volume: 1, status: 'expired', note: 'pending-closed: gone at broker, no fill adopted', account_id: D42, placed_at: '2026-09-15 21:39:01' })
  pend(800, '800'); pend(801, '801') // no intent carries these: can never be re-judged
  pend(799, '799')
  ins(db, 'entry_intents', { id: 'i1ea06ki4vdgt', account_id: D42, environment: 'demo', symbol: 'NATGAS', side: 'BUY', order_type: 'LIMIT', volume: 1, producer_id: 'pending_fib_orders', basis: 'bar', mode_epoch: 1, permit_id: 'p-799', permit_expires_at: '2026-09-16T00:00:00Z', state: 'FILLED', broker_order_id: '799', created_at: '2026-09-15T21:39:01Z', updated_at: '2026-09-15T21:39:01Z' })
  trade(db, { id: 1661, account_id: D42, symbol: 'NATGAS', label_raw: label('i1ea06ki4vdgt'), opened_at: '2026-09-16 01:00:00', status: 'closed', net_pnl: 2, closed_at: '2026-09-16 05:00:00', origin: 'reconciler_adopted', ctrader_position_id: '242000003' })
  const out = resolveRestingOrders(db, { nowMs: NOW, readLimit: 1 })
  assert.equal(out.rejudged, 1)
  assert.equal(row(db, 'pending_orders', 799).status, 'filled')
  assert.equal(row(db, 'pending_orders', 800).status, 'expired')
  assert.equal(row(db, 'pending_orders', 801).status, 'expired')
})

test('STK-01: switched off, the stuck resolver is not reported as a resolver that exists (checker NIT 8)', () => {
  const db = restingFixture()
  assert.ok(lifecycle(db, 'STK-01').sample.filter(e => e.subject !== 'pending:640').every(e => e.resolverExists === true && e.resolver === 'stuck resolver R1'))
  setState(db, ENABLED_KEY, 'false')
  const off = lifecycle(db, 'STK-01').sample
  for (const e of off.filter(x => x.subject !== 'pending:640')) {
    assert.equal(e.resolverExists, false, e.subject)
    assert.match(e.resolver, /switched off \(agent_state stuck_resolver_enabled = 'false'\)/)
  }
  const closed = off.find(x => x.subject === 'pending:640')
  assert.equal(closed.resolverExists, true, 'a pending-closed row keeps its own resolver')
})

// ---------------------------------------------------------------- R6
function captureFixture() {
  const db = initDB(':memory:')
  const risk = (id, reason) => ins(db, 'risk_events', { id, opportunity_key: `ok${id}`, symbol: 'X', side: 'BUY', approved: 1, disposition: 'ordered', account_id: D58, created_at: '2026-09-21T10:00:00Z', proposal_json: JSON.stringify({ strategy: 'x', entry: 1, sl: 0.9, ...(reason ? { direction_reason: reason } : {}) }) })
  const gaveUp = (acct, pid, symbol, err) => ins(db, 'position_capture_queue', { account_id: acct, position_id: pid, symbol, due_at_ms: 1, attempts: 6, state: 'gave_up', last_error: err, settled_at: '2026-09-21T17:05:26.254Z' })
  // COIN.US pos 241759757 (…0058): missing direction_reason, and its approval has none.
  risk(10, null)
  trade(db, { id: 1650, symbol: 'COIN.US', status: 'closed', account_id: D58, ctrader_position_id: '241759757', risk_event_id: 10, opened_at: '2026-09-21 10:00:00', closed_at: '2026-09-21 17:00:00', net_pnl: 3 })
  gaveUp(D58, '241759757', 'COIN.US', 'missing: direction_reason')
  // BTCUSD pos 240088269 (…0058): missing direction_reason — its approval carries one now.
  risk(11, 'donchian breakout above the 20-bar high')
  trade(db, { id: 1651, symbol: 'BTCUSD', status: 'closed', account_id: D58, ctrader_position_id: '240088269', risk_event_id: 11, opened_at: '2026-09-21 10:00:00', closed_at: '2026-09-21 17:00:00', net_pnl: 4 })
  gaveUp(D58, '240088269', 'BTCUSD', 'missing: direction_reason')
  // GD.US pos 239952669 (…0058): three fields missing, none upstream.
  trade(db, { id: 1652, symbol: 'GD.US', status: 'closed', account_id: D58, ctrader_position_id: '239952669', opened_at: '2026-09-22 10:00:00', closed_at: '2026-09-22 14:00:00', net_pnl: -2 })
  gaveUp(D58, '239952669', 'GD.US', 'missing: direction_reason, planned_entry, risk_dist')
  return db
}

test('R6: a gave_up capture is re-queued ONCE when its missing field now exists; written off when it exists nowhere; a second give-up is written off', () => {
  assert.deepEqual(missingFieldsOf('missing: direction_reason, planned_entry, risk_dist'), ['direction_reason', 'planned_entry', 'risk_dist'])
  assert.equal(missingFieldsOf('deal fetch timed out'), null)
  const db = captureFixture()
  assert.equal(lifecycle(db, 'STK-06').violations, 3, 'precondition: three gave_up rows counted stuck')
  const before = counts(db)
  resolveCaptures(db, { nowMs: NOW })
  const q = pid => db.prepare('SELECT * FROM position_capture_queue WHERE position_id = ?').get(pid)
  assert.equal(q('240088269').state, 'pending', 'the field exists upstream now: re-queued')
  assert.equal(q('240088269').attempts, 0)
  assert.equal(q('240088269').due_at_ms, NOW)
  assert.equal(res(db, `capture:${D58}:240088269`).verdict, 'requeued')
  assert.equal(q('241759757').state, 'gave_up', 'the row is kept as it was')
  const coin = res(db, `capture:${D58}:241759757`)
  assert.equal(coin.outcome, 'unresolved')
  assert.equal(coin.verdict, UNRESOLVED_NO_RECORD)
  assert.match(coin.reason, /lacks direction_reason and no upstream record carries direction_reason/)
  assert.match(res(db, `capture:${D58}:239952669`).reason, /direction_reason, planned_entry, risk_dist/)
  assert.deepEqual(counts(db), before, 'nothing deleted')
  const stk = lifecycle(db, 'STK-06')
  assert.equal(stk.violations, 0)
  assert.equal(stk.classes.written_off, 2)
  // The re-queued capture gives up again: the next pass writes it off — bounded at one re-queue.
  db.prepare(`UPDATE position_capture_queue SET state = 'gave_up', attempts = 6, last_error = 'missing: planned_sl' WHERE position_id = '240088269'`).run()
  assert.equal(lifecycle(db, 'STK-06').violations, 1, 'stuck again until the resolver ends it')
  resolveCaptures(db, { nowMs: NOW + 600_000 })
  const again = res(db, `capture:${D58}:240088269`)
  assert.equal(again.outcome, 'unresolved')
  assert.match(again.reason, /re-queued once .* and gave up again/)
  assert.equal(q('240088269').state, 'gave_up', 'not re-queued a second time')
  assert.equal(lifecycle(db, 'STK-06').violations, 0)
})

test('R6 never starves: written-off captures stay gave_up for good, yet a new give-up behind a full page of them is still reached (checker NIT 4)', () => {
  const db = captureFixture()
  // Two write-offs first (COIN.US, GD.US: nothing upstream) …
  resolveCaptures(db, { nowMs: NOW })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM stuck_resolutions WHERE kind = 'capture' AND outcome = 'unresolved'`).get().n, 2)
  // … then a NEW give-up, settled later than both, behind a page of 2.
  trade(db, { id: 1653, symbol: 'AAPL.US', status: 'closed', account_id: D58, ctrader_position_id: '239000001', opened_at: '2026-09-23 10:00:00', closed_at: '2026-09-23 14:00:00', net_pnl: 1 })
  ins(db, 'position_capture_queue', { account_id: D58, position_id: '239000001', symbol: 'AAPL.US', due_at_ms: 1, attempts: 6, state: 'gave_up', last_error: 'missing: planned_entry', settled_at: '2026-09-24T17:05:26.254Z' })
  const out = resolveCaptures(db, { nowMs: NOW, readLimit: 2 })
  assert.equal(out.examined, 1, 'the written-off rows are excluded by the query, not skipped after it')
  assert.ok(res(db, `capture:${D58}:239000001`), 'the new give-up is judged')
})

// ---------------------------------------------------------------- R7
function targetlessFixture() {
  const db = initDB(':memory:')
  const log = (pid, acct, at) => ins(db, 'action_log', { method: 'POSITION_NO_TARGET', path: '/protection-audit', at, body: JSON.stringify({ positionId: pid, accountId: acct, symbol: 'X' }) })
  // #1687 ETHUSD …9908 pos 242004561, filled from pending #717 whose tp is on record.
  ins(db, 'entry_intents', { id: 'i1qgcr4790aot', account_id: D08, environment: 'demo', symbol: 'ETHUSD', side: 'BUY', order_type: 'LIMIT', volume: 1, sl: 701748000, tp: 701900000, producer_id: 'pending_fib_orders', basis: 'bar', mode_epoch: 1, permit_id: 'p1', permit_expires_at: '2026-09-17T00:00:00Z', state: 'FILLED', broker_order_id: '361000717', created_at: '2026-09-16T21:10:22Z', updated_at: '2026-09-16T21:10:22Z' })
  ins(db, 'pending_orders', { id: 717, symbol: 'ETHUSD', order_id: '361000717', dir: 1, level: 4400, sl: 4300, tp: 4650, volume: 1, status: 'expired', note: 'pending-fib', account_id: D08, placed_at: '2026-09-16 21:10:22' })
  trade(db, { id: 1687, symbol: 'ETHUSD', status: 'open', account_id: D08, ctrader_position_id: '242004561', entry_price: 4400, label_raw: label('i1qgcr4790aot'), opened_at: '2026-09-23 09:30:00', origin: 'reconciler_adopted' })
  // #1704 XRPUSD …0949 pos 242243017: its plan carries a stop in wire units and no target.
  trade(db, { id: 1704, symbol: 'XRPUSD', status: 'open', account_id: D49, ctrader_position_id: '242243017', entry_price: 2.9, opened_at: '2026-09-23 09:20:00', origin: 'reconciler_adopted' })
  ins(db, 'trade_plans', { trade_id: 1704, account_id: D49, symbol: 'XRPUSD', side: 'BUY', strategy: 'fib', planned_entry: 2.9, planned_sl: 701748000, planned_tp: 702000000, risk_dist: 1 })
  for (const [pid, acct] of [['242004561', D08], ['242243017', D49]]) {
    for (let h = 0; h <= 28; h++) log(pid, acct, new Date(NOW - (28 - h) * 3_600_000 - 5 * 60_000).toISOString().slice(0, 19).replace('T', ' '))
  }
  return db
}

test('R7 default OFF (checker BLOCKER 1): a found target is NOT written to trades.tp_price — target-restore would amend the live position; STK-09 stays a defect naming the value and its source', () => {
  const db = targetlessFixture()
  const stk = lifecycle(db, 'STK-09')
  assert.equal(stk.violations, 2, 'precondition: both production positions counted stuck')
  assert.equal(getState(db, TARGET_WRITE_KEY), null, 'precondition: the switch is absent')
  // The ticker's own step: the pass result is what STK-09 reads the finding from.
  const pass = runResolverStep(db, (d, o) => runStuckResolver(d, { ...o, nowMs: NOW }), NOW)
  assert.equal(pass.ok, true, JSON.stringify(pass))
  assert.equal(row(db, 'trades', 1687).tp_price, null, 'nothing written while the switch is absent')
  assert.equal(res(db, `target:${D08}:242004561`), undefined, 'no resolution: the position is not ended')
  assert.equal(pass.targetless.targetFound, 1)
  assert.deepEqual(pass.targetless.found, [{ accountId: D08, positionId: '242004561', tradeId: 1687, tp: 4650, source: 'pending_orders #717 tp (order 361000717, intent i1qgcr4790aot)' }])
  assert.match(pass.targetless.targetWrite, /^off/)
  const xrp = res(db, `target:${D49}:242243017`)
  assert.equal(xrp.outcome, 'unresolved', 'nothing recorded anywhere: written off either way')
  assert.equal(xrp.verdict, UNRESOLVED_NO_TARGET)
  assert.ok(JSON.parse(xrp.evidence_json).tried.some(t => /not in price units/.test(t.why ?? '')))
  const after = lifecycle(db, 'STK-09')
  assert.equal(after.violations, 1)
  const eth = after.sample.find(e => e.subject === `position:${D08}:242004561`)
  assert.equal(eth.class, 'recorded_target_found')
  assert.deepEqual(eth.recordedTarget, { tp: 4650, source: 'pending_orders #717 tp (order 361000717, intent i1qgcr4790aot)', foundAt: new Date(NOW).toISOString(), written: false })
  assert.match(eth.detail, /recorded target 4650 found \(pending_orders #717/)
  assert.equal(after.classes.written_off, 1)
  // Anything but exactly 'true' is off.
  setState(db, TARGET_WRITE_KEY, 'yes')
  resolveTargetless(db, { nowMs: NOW })
  assert.equal(row(db, 'trades', 1687).tp_price, null)
})

test('R7 switched ON by the owner: the found target is written to trades.tp_price and the position settled', () => {
  const db = targetlessFixture()
  setState(db, TARGET_WRITE_KEY, 'true')
  const out = resolveTargetless(db, { nowMs: NOW })
  assert.equal(out.targetRecorded, 1)
  assert.equal(row(db, 'trades', 1687).tp_price, 4650, "pending #717's tp, not the intent's wire-unit 701900000")
  const eth = res(db, `target:${D08}:242004561`)
  assert.equal(eth.outcome, 'settled')
  assert.match(eth.reason, /pending_orders #717 tp \(order 361000717, intent i1qgcr4790aot\)/)
  assert.match(eth.reason, /stuck_resolver_target_write = 'true' \(owner\)/)
  assert.equal(row(db, 'trades', 1704).tp_price, null, 'a plan target 702000000 on a 2.9 entry is not a price: refused')
  const after = lifecycle(db, 'STK-09')
  assert.deepEqual(after.sample.map(e => e.subject), [`position:${D08}:242004561`], 'the recorded target is not yet on the position: still stuck until the audit stops reporting it')
})

test('R7 wrong side: a recorded target on the wrong side of the entry is refused, never written (checker NIT 1)', () => {
  const db = initDB(':memory:')
  const log = (pid, acct, at) => ins(db, 'action_log', { method: 'POSITION_NO_TARGET', path: '/protection-audit', at, body: JSON.stringify({ positionId: pid, accountId: acct, symbol: 'ETHUSD' }) })
  // BUY at 4400 whose only recorded target is 4300 (below), SELL at 4400 whose only one is 4500 (above).
  trade(db, { id: 1801, symbol: 'ETHUSD', side: 'BUY', status: 'open', account_id: D08, ctrader_position_id: '243000001', entry_price: 4400, opened_at: '2026-09-23 09:30:00' })
  ins(db, 'trade_plans', { trade_id: 1801, account_id: D08, symbol: 'ETHUSD', side: 'BUY', strategy: 'fib', planned_entry: 4400, planned_sl: 4300, planned_tp: 4300, risk_dist: 100 })
  trade(db, { id: 1802, symbol: 'ETHUSD', side: 'SELL', status: 'open', account_id: D08, ctrader_position_id: '243000002', entry_price: 4400, opened_at: '2026-09-23 09:30:00' })
  ins(db, 'trade_plans', { trade_id: 1802, account_id: D08, symbol: 'ETHUSD', side: 'SELL', strategy: 'fib', planned_entry: 4400, planned_sl: 4500, planned_tp: 4500, risk_dist: 100 })
  for (const pid of ['243000001', '243000002']) for (let h = 0; h <= 4; h++) log(pid, D08, new Date(NOW - (4 - h) * 3_600_000 - 5 * 60_000).toISOString().slice(0, 19).replace('T', ' '))
  const buy = recordedTargetEvidence(db, row(db, 'trades', 1801))
  assert.equal(buy.hit, null)
  assert.ok(buy.tried.some(t => t.tp === 4300 && /wrong side of the 4400 entry/.test(t.why ?? '')), JSON.stringify(buy.tried))
  setState(db, TARGET_WRITE_KEY, 'true') // even with the write switched on
  resolveTargetless(db, { nowMs: NOW })
  for (const [id, pid] of [[1801, '243000001'], [1802, '243000002']]) {
    assert.equal(row(db, 'trades', id).tp_price, null, `#${id}: never written`)
    const r = res(db, `target:${D08}:${pid}`)
    assert.equal(r.outcome, 'unresolved')
    assert.equal(r.verdict, UNRESOLVED_NO_TARGET)
    assert.ok(JSON.parse(r.evidence_json).tried.some(t => /wrong side/.test(t.why ?? '')))
  }
})

test('STK-09 v2 (checker NIT 3): a position the audit stopped reporting is clean ONLY on positive evidence — otherwise not_reported_now, named, never silently clean', () => {
  const later = NOW + 3 * 3_600_000
  const stk09 = db => buildOrderLifecycle(db, { nowMs: later, account: 'all', rule: 'STK-09' }).stages.stuck[0]
  // No audit record of the account: not verifiable as fixed.
  const quiet = targetlessFixture()
  const q = stk09(quiet)
  assert.equal(q.violations, 0)
  assert.equal(q.classes.not_reported_now, 2)
  assert.ok(q.info.not_reported_now.some(s => /pos 242004561 .*no successful audit of the account on record/.test(s)), JSON.stringify(q.info))
  // A successful audit of …9908 one mute window after the last row, not listing the position: clean.
  const fixed = targetlessFixture()
  setState(fixed, `acct:${D08}:protection_audit_last_json`, JSON.stringify({ at: new Date(NOW + 2 * 3_600_000).toISOString(), ok: true, accountId: D08, targetless: 0, missingTargets: [] }))
  const f = stk09(fixed)
  assert.equal(f.violations, 0)
  assert.equal(f.classes.not_reported_now, 1, 'only …0949, which has no such record, stays not verifiable')
  assert.ok(!f.info.not_reported_now.some(s => /242004561/.test(s)))
  // An audit that is too early proves nothing.
  const early = targetlessFixture()
  setState(early, `acct:${D08}:protection_audit_last_json`, JSON.stringify({ at: new Date(NOW + 30 * 60_000).toISOString(), ok: true, accountId: D08, missingTargets: [] }))
  assert.equal(stk09(early).classes.not_reported_now, 2)
  // A late audit that still LISTS it targetless: stuck.
  const listed = targetlessFixture()
  setState(listed, `acct:${D08}:protection_audit_last_json`, JSON.stringify({ at: new Date(NOW + 2 * 3_600_000).toISOString(), ok: true, accountId: D08, missingTargets: [{ positionId: '242004561', symbol: 'ETHUSD' }] }))
  const l = stk09(listed)
  assert.equal(l.violations, 1)
  assert.match(l.sample[0].detail, /still in the audit's list/)
})

// ---------------------------------------------------------------- the pass
test('idempotent and bounded: a second pass changes nothing; maxWrites caps each kind', () => {
  const db = inflightFixture()
  const first = runStuckResolver(db, { nowMs: NOW })
  assert.equal(first.ok, true, JSON.stringify(first))
  const snap = () => JSON.stringify([db.prepare('SELECT * FROM stuck_resolutions ORDER BY subject').all(), db.prepare('SELECT * FROM trades ORDER BY id').all()])
  const a = snap()
  const second = runStuckResolver(db, { nowMs: NOW })
  assert.equal(snap(), a)
  assert.equal(second.trades.settledFromDeal + second.trades.settledDuplicate + second.trades.writtenOff, 0)
  const capped = inflightFixture()
  const out = resolveInflightTrades(capped, { nowMs: NOW, maxWrites: 1 })
  assert.equal(out.settledFromDeal + out.settledDuplicate + out.writtenOff, 1)
  assert.equal(capped.prepare('SELECT COUNT(*) AS n FROM stuck_resolutions').get().n, 1)
})

test('one commit per kind, one savepoint per record: a record that fails rolls back alone; the rest of its kind is kept (checker NIT 6)', () => {
  const db = inflightFixture()
  db.exec(`CREATE TRIGGER boom BEFORE INSERT ON stuck_resolutions WHEN NEW.subject = 'trade:1466' BEGIN SELECT RAISE(ABORT, 'boom 1466'); END`)
  const out = runStuckResolver(db, { nowMs: NOW })
  assert.equal(out.ok, false)
  assert.ok(out.trades.errors.some(e => /^trade:1466: boom 1466/.test(e)), JSON.stringify(out.trades.errors))
  assert.equal(res(db, 'trade:1466'), undefined, 'the failed record is not ended')
  assert.equal(res(db, 'trade:1398').outcome, 'settled', 'its neighbour in the same kind still committed')
  assert.equal(row(db, 'trades', 1398).status, 'closed')
  assert.equal(res(db, 'trade:1439').outcome, 'settled')
  assert.equal(MAX_WRITES_PER_KIND, 8)
})

test('castIntKey reads an id as SQLite CAST(... AS INTEGER) does — the per-pass lookups compare what the SQL compared', () => {
  assert.equal(castIntKey('240100001'), '240100001')
  assert.equal(castIntKey('240100001.0'), '240100001')
  assert.equal(castIntKey(' 42'), '42')
  assert.equal(castIntKey(240100001), '240100001')
  assert.equal(castIntKey('abc'), '0')
  assert.equal(castIntKey(null), null)
  const db = initDB(':memory:')
  for (const v of ['240100001.0', ' 42', 'abc', '7x']) assert.equal(castIntKey(v), String(db.prepare('SELECT CAST(? AS INTEGER) AS n').get(v).n), v)
  // A twin stored with a trailing .0 still finds its deal's opening time.
  trade(db, { id: 1439, symbol: 'BTCUSD', status: 'unconfirmed', account_id: D58, opened_at: '2026-09-03 08:54:36' })
  trade(db, { id: 1500, symbol: 'BTCUSD', status: 'open', account_id: D58, opened_at: '2026-09-03 09:30:00', origin: 'reconciler_adopted', ctrader_position_id: '240100001.0' })
  deal(db, { deal_id: '1', position_id: '240100001', account_id: D58, symbol: 'BTCUSD', entry_price: 1, close_price: 1, opened_at: '2026-09-03T08:55:00.000Z', closed_at: null })
  resolveInflightTrades(db, { nowMs: NOW })
  const ev = JSON.parse(res(db, 'trade:1439').evidence_json)
  assert.equal(ev.fill.fillSource, 'broker_deals.opened_at', 'the deal time, not the 35-minute-late adoption stamp (which would miss the window)')
})

test('never the broker: the resolver imports no order, amend or broker-read path', () => {
  const src = readFileSync(new URL('./stuck-resolver.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const imports = [...src.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map(m => m[1])
  assert.deepEqual(imports.sort(), ['../lib/stuck-resolutions.js', '../lib/trade-labels.js', './position-history.js', './trade-consistency.js'])
  assert.doesNotMatch(src, /exec-engine|ctrader-ws|amendPosition|placeOrder|cancelOrder|closePosition|fetch\(/)
})

test('ticker: the resolver runs before the snapshot; a failing resolver fails the beat but the snapshot is still written; switched off is said', async () => {
  const db = inflightFixture()
  const beats = []
  const heartbeat = { beat: (_db, name, o) => beats.push({ name, ...o }) }
  const read = async () => buildOrderLifecycle(db, { nowMs: NOW, account: 'all' })
  const ok = await runOrderLifecyclePass(db, { read, heartbeat, resolve: (d, o) => runStuckResolver(d, { ...o, nowMs: NOW }) })
  assert.equal(ok.ok, true, ok.error)
  assert.equal(res(db, 'trade:1466').outcome, 'unresolved', 'resolved in the pass')
  const snap = JSON.parse(getState(db, 'order_lifecycle_last_json'))
  assert.equal(snap.rules.find(r => r.id === 'STK-03').violations, 1, 'the snapshot reads the resolved state: only the young #1700 is stuck')
  assert.ok(snap.summary.stuck.notices >= 1)
  assert.equal(beats.at(-1).ok, true)
  assert.equal(beats.at(-1).detail.resolver.counts.trades.writtenOff, 1)
  assert.equal(JSON.parse(getState(db, LAST_KEY)).trades.settledFromDeal, 1)
  const failed = await runOrderLifecyclePass(db, { read, heartbeat, resolve: () => { throw new Error('no such table: stuck_resolutions') } })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /^stuck resolver: no such table: stuck_resolutions/)
  assert.equal(beats.at(-1).ok, false)
  assert.ok(getState(db, 'order_lifecycle_last_json'), 'the snapshot is not withheld')
  setState(db, ENABLED_KEY, 'false')
  let called = 0
  const off = await runOrderLifecyclePass(db, { read, heartbeat, resolve: () => { called++; return {} } })
  assert.equal(off.ok, true)
  assert.equal(called, 0)
  assert.match(off.resolver.skipped, /switched off/)
})

test('the loop reaches the resolver: the ticker it starts runs it by default (failure mode #4)', () => {
  const src = readFileSync(new URL('./order-lifecycle-ticker.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(src, /export async function runOrderLifecyclePass\(db, \{[^}]*resolve = runStuckResolver[^}]*\}/)
  assert.match(src, /const resolver = resolverBrief\(runResolverStep\(db, resolve\)\)\s*\n\s*try \{\s*\n\s*const report = await read\(db, SNAPSHOT_OPTIONS\)/)
})
