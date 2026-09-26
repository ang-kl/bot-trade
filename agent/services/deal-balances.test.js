// node --test agent/services/deal-balances.test.js
//
// V3 WEB-8 (8,989-A row 7): the broker balance is stored on deals and
// cashflows, and a window edge older than account_history reads a balance
// only when the stored events prove it. Behaviour, not source:
//   - shapeDeals decodes closePositionDetail.balance with the deal's own
//     moneyDigits and never a default scale;
//   - persistDeals never lets a later read erase a stored balance, and a
//     statement never replaces the API's;
//   - the statement's "Balance <CCY>" column is read by its header;
//   - recordCashflowWindow keeps depositWithdraw.balance, fills a missing one
//     on a re-read and never refuses a window over it;
//   - the edge reader proves a balance only when the next event reconciles to
//     the cent (and its balanceVersion is the next one, where both carry it),
//     and otherwise names why not;
//   - the committed statements reconcile on every link;
//   - GET /state/deal-balances serves it and refuses a bad edge.
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import Database from 'better-sqlite3'
import { mkdtempSync } from '../test-support/temp-dir.js'
import { initDB, setState } from '../db.js'
import { shapeDeals, persistDeals } from './broker-history-import.js'
import { parseStatement, importSeedStatements } from './statement-import.js'
import { recordCashflowWindow } from './account-cashflows.js'
import { depositCurrencies } from './deposit-currencies.js'
import { balanceReader } from './balance-edges.js'
import { dealBalanceReader, dealBalanceReport, eventTime, brokerAmount, BALANCE_GAP_LABELS } from './deal-balances.js'
import stateRouter from '../routes/state.js'

const A = '46130058'
const HOST = 'demo.ctraderapi.com'
const H = 3_600_000
const T0 = Date.UTC(2026, 7, 3, 10, 0, 0)          // 2026-08-03 10:00:00Z, a whole second
const META = { 1: { symbolName: 'EURUSD', lotSize: 100_000 } }

function fixture(t, { currency = 'USD', accounts = [[A, '5306502']] } = {}) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  for (const [id, login] of accounts) {
    db.prepare('INSERT INTO accounts (account_id, trader_login, is_live) VALUES (?, ?, 0)').run(id, login)
    if (currency) {
      setState(db, `acct:${id}:deposit_currency_evidence_json`,
        JSON.stringify({ accountId: id, host: HOST, currency, receivedAt: T0, source: 'broker_asset_list' }))
    }
  }
  return db
}
const reader = (db) => dealBalanceReader(db, { currencyByAccount: depositCurrencies(db) })

// A raw closing deal as ProtoOAGetDealListRes returns it. Money, including
// the balance after the close, is in the broker's integer units.
function apiDeal({ dealId, at, gross, balance, version, digits = 2 }) {
  const cpd = { entryPrice: 1.1, grossProfit: gross, swap: 0, commission: 0 }
  if (digits !== undefined) cpd.moneyDigits = digits
  if (balance !== undefined) cpd.balance = balance
  if (version !== undefined) cpd.balanceVersion = version
  return { dealId, positionId: dealId, symbolId: 1, volume: 100_000, tradeSide: 2, executionPrice: 1.2,
    executionTimestamp: at, closePositionDetail: cpd }
}
const storeApi = (db, deals) => persistDeals(db, shapeDeals(deals, META, A))
const cashflowResponse = (items) => ({ ctidTraderAccountId: A, hasMore: false, depositWithdraw: items })
const deposit = ({ id, at, delta, balance, version }) => ({ balanceHistoryId: id, changeBalanceTimestamp: at, delta,
  moneyDigits: 2, operationType: 0, ...(balance === undefined ? {} : { balance }), ...(version === undefined ? {} : { balanceVersion: version }) })
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]))

test('shapeDeals keeps the balance after each close in the broker units the deal states, never a guessed scale', () => {
  const noDigits = apiDeal({ dealId: 3, at: T0 + 120_000, gross: 100, balance: 5_001_350 })
  delete noDigits.closePositionDetail.moneyDigits
  const rows = shapeDeals([
    apiDeal({ dealId: 1, at: T0, gross: 1500, balance: 5_001_500, version: 41 }),
    apiDeal({ dealId: 2, at: T0 + 60_000, gross: -250, balance: '5001250', version: '42' }),
    noDigits,
    apiDeal({ dealId: 4, at: T0 + 180_000, gross: 100, balance: 50013.5 }),
    apiDeal({ dealId: 5, at: T0 + 240_000, gross: 100 }),
    apiDeal({ dealId: 6, at: T0 + 300_000, gross: 100, balance: 123_456, digits: 3 }),
  ], META, A)
  assert.deepEqual(rows.map(r => [r.deal_id, r.balance, r.balance_version, r.balance_source]), [
    ['1', 50015, 41, 'broker_api'],
    ['2', 50012.5, 42, 'broker_api'],
    ['3', null, null, 'broker_api'],       // no moneyDigits: no scale is assumed
    ['4', null, null, 'broker_api'],       // not an integer amount
    ['5', null, null, 'broker_api'],       // not given
    ['6', 123.456, null, 'broker_api'],
  ])
  assert.equal(brokerAmount('-150', 2), -1.5)
  assert.equal(brokerAmount('12', 11), null)
})

test('a later read never erases a stored balance; a statement never replaces the API balance; the API replaces a statement', t => {
  const db = fixture(t)
  const row = (extra = {}) => ({ deal_id: '10', position_id: '10', account_id: A, symbol: 'EURUSD', side: 'BUY', lots: 1,
    entry_price: 1.1, close_price: 1.2, opened_at: null, closed_at: '2026-08-01 10:00:00', gross_pnl: 5, swap: 0,
    commission: 0, net_pnl: 5, ...extra })
  const stored = () => db.prepare(`SELECT balance, balance_version, balance_currency, balance_source
    FROM broker_deals WHERE deal_id = '10'`).get()

  persistDeals(db, [row()])   // a caller that does not read balances
  assert.deepEqual(stored(), { balance: null, balance_version: null, balance_currency: null, balance_source: null })

  persistDeals(db, [row({ balance: 1000, balance_currency: 'USD', balance_source: 'statement' })])
  assert.deepEqual(stored(), { balance: 1000, balance_version: null, balance_currency: 'USD', balance_source: 'statement' })

  persistDeals(db, [row({ balance: 1000.5, balance_version: 7, balance_source: 'broker_api' })])
  const api = { balance: 1000.5, balance_version: 7, balance_currency: null, balance_source: 'broker_api' }
  assert.deepEqual(stored(), api)

  persistDeals(db, [row({ balance: 999, balance_currency: 'USD', balance_source: 'statement' })])
  assert.deepEqual(stored(), api, 'the statement does not replace the API read')
  persistDeals(db, [row({ balance: null, balance_source: 'broker_api' })])
  persistDeals(db, [row()])
  assert.deepEqual(stored(), api, 'a read with no balance keeps the stored one')

  persistDeals(db, [row({ balance: 1001, balance_version: 8, balance_source: 'broker_api' })])
  assert.deepEqual(stored(), { ...api, balance: 1001, balance_version: 8 }, 'an API re-read carrying a balance is the latest record')
})

test('with no balance on either read, the source records the read that had none; a caller that reads none changes nothing', t => {
  const db = fixture(t)
  const row = (extra = {}) => ({ deal_id: '11', position_id: '11', account_id: A, symbol: 'X', side: 'BUY', lots: 1,
    entry_price: 1, close_price: 2, opened_at: null, closed_at: '2026-08-01 10:00:00', gross_pnl: 1, swap: 0,
    commission: 0, net_pnl: 1, ...extra })
  const source = () => db.prepare(`SELECT balance, balance_source FROM broker_deals WHERE deal_id = '11'`).get()
  persistDeals(db, [row({ balance_source: 'statement' })])
  assert.deepEqual(source(), { balance: null, balance_source: 'statement' })
  persistDeals(db, [row({ balance_source: 'broker_api' })])
  assert.deepEqual(source(), { balance: null, balance_source: 'broker_api' })
  persistDeals(db, [row({ balance_source: 'statement' })])
  persistDeals(db, [row()])
  assert.deepEqual(source(), { balance: null, balance_source: 'broker_api' })
})

test('the statement Balance column is read by its header name; a file without it stores none', () => {
  const header = 'Deal ID,Order ID,Symbol,Opening Direction,Closing Direction,Opening time (UTC+8),Closing Time (UTC+8),Entry price,Closing price,Closing Quantity,Commissions,Pips,Net USD,Channel'
  const deal = 'DID315186380,356247791,JPM.US,Buy,Sell,20 Aug 2026 21:56:13.342,20 Aug 2026 21:57:53.488,356.21,354.88,13.8 Lots,-0.70,-13.3,-24.05,openapi_cbot-t'
  const withBalance = parseStatement(`Deals\n${header},Balance USD\n${deal},1 719.75\n`)
  assert.deepEqual(pick(withBalance[0], ['balance', 'balance_currency', 'balance_source', 'balance_version']),
    { balance: 1719.75, balance_currency: 'USD', balance_source: 'statement', balance_version: null })
  const without = parseStatement(`Deals\n${header}\n${deal}\n`)
  assert.deepEqual(pick(without[0], ['balance', 'balance_currency', 'balance_source']),
    { balance: null, balance_currency: null, balance_source: 'statement' })
  assert.equal(without[0].net_pnl, -24.05, 'the rest of the row is unchanged')
})

test('a balance is proven at an edge when the next close reconciles to the cent, and labelled when it cannot be', t => {
  const db = fixture(t)
  storeApi(db, [
    apiDeal({ dealId: 1, at: T0, gross: 1000, balance: 100_000 }),            // 1,000.00 after
    apiDeal({ dealId: 2, at: T0 + 2 * H, gross: 500, balance: 100_500 }),     // +5.00 → 1,005.00
    apiDeal({ dealId: 3, at: T0 + 4 * H, gross: -200, balance: 160_300 }),    // −2.00, and 600.00 arrived unrecorded
  ])
  const r = reader(db)
  const mid = r.at(A, T0 + H)
  assert.deepEqual(pick(mid, ['status', 'value', 'currency', 'source', 'proof', 'at', 'provenUntil']),
    { status: 'observed', value: 1000, currency: 'USD', source: 'broker_deal', proof: 'balance_arithmetic', at: T0 + 999, provenUntil: T0 + 2 * H })
  assert.deepEqual(pick(r.at(A, T0 + 3 * H), ['status', 'reason', 'unexplained']),
    { status: 'not_stored', reason: 'balance_chain_break', unexplained: 600 })
  assert.deepEqual(pick(r.at(A, T0 - H), ['status', 'reason', 'storedFrom']),
    { status: 'not_stored', reason: 'before_first_stored_event', storedFrom: T0 + 999 })
  assert.deepEqual(pick(r.at(A, T0 + 5 * H), ['status', 'reason']), { status: 'not_stored', reason: 'after_last_stored_event' })
  // The close time is stored to the second: an edge inside that second may
  // fall before the close or at/after it. Windows are [from, to), so an edge
  // at the second's last millisecond is still inside it, and the first edge
  // after the second is the first one the close is provably before.
  assert.deepEqual(pick(r.at(A, T0 + 500), ['status', 'reason']), { status: 'not_stored', reason: 'edge_inside_event_time' })
  assert.deepEqual(pick(r.at(A, T0 + 999), ['status', 'reason']), { status: 'not_stored', reason: 'edge_inside_event_time' })
  assert.deepEqual(pick(r.at(A, T0 + 1000), ['status', 'value']), { status: 'observed', value: 1000 })
  // A close stamped to a second that STARTS at the edge is provably at or
  // after the edge: it belongs to the window starting there, so the balance
  // at the edge is the one before it — not "inside the event's time".
  assert.deepEqual(pick(r.at(A, T0 + 2 * H), ['status', 'value', 'event', 'nextEvent']),
    { status: 'observed', value: 1000, event: { kind: 'deal', id: '1' }, nextEvent: { kind: 'deal', id: '2' } })
  assert.deepEqual(pick(r.at(A, T0), ['status', 'reason']), { status: 'not_stored', reason: 'before_first_stored_event' })
})

test('an event timed exactly at an edge belongs to the window that starts there, as the ledger counts it ([from, to))', t => {
  const db = fixture(t)
  storeApi(db, [
    apiDeal({ dealId: 1, at: T0, gross: 1000, balance: 100_000 }),                  // 1,000.00 after
    apiDeal({ dealId: 2, at: T0 + 2 * H, gross: 500, balance: 160_500 }),           // +5.00 on 1,600.00
  ])
  // A deposit the broker times to the millisecond, exactly at the edge.
  recordCashflowWindow(db, { accountId: A, host: HOST, currency: 'USD', from: T0, to: T0 + 2 * H, receivedAt: T0 + 3 * H,
    response: cashflowResponse([deposit({ id: '77', at: T0 + H, delta: 60_000, balance: 160_000 })]) })
  const r = reader(db)
  // Carry out of [.., E) and carry in of [E, ..) are the same figure: the
  // balance before the deposit the window starting at E counts.
  assert.deepEqual(pick(r.at(A, T0 + H), ['status', 'value', 'event', 'nextEvent', 'provenUntil']),
    { status: 'observed', value: 1000, event: { kind: 'deal', id: '1' }, nextEvent: { kind: 'cashflow', id: '77' }, provenUntil: T0 + H })
  assert.deepEqual(pick(r.at(A, T0 + H + 1), ['status', 'value', 'event']),
    { status: 'observed', value: 1600, event: { kind: 'cashflow', id: '77' } })
  assert.deepEqual(pick(r.at(A, T0 + H - 1), ['status', 'value']), { status: 'observed', value: 1000 })
})

test('a stored cashflow carrying its balance closes the gap an unrecorded deposit opened', t => {
  const db = fixture(t)
  storeApi(db, [
    apiDeal({ dealId: 1, at: T0, gross: 1000, balance: 100_000 }),
    apiDeal({ dealId: 2, at: T0 + 2 * H, gross: 500, balance: 160_500 }),
  ])
  assert.equal(reader(db).at(A, T0 + H).reason, 'balance_chain_break')
  recordCashflowWindow(db, { accountId: A, host: HOST, currency: 'USD', from: T0, to: T0 + 2 * H, receivedAt: T0 + 3 * H,
    response: cashflowResponse([deposit({ id: '77', at: T0 + 90 * 60_000, delta: 60_000, balance: 160_000 })]) })
  const r = reader(db)
  assert.deepEqual(pick(r.at(A, T0 + H), ['status', 'value', 'source', 'provenUntil']),
    { status: 'observed', value: 1000, source: 'broker_deal', provenUntil: T0 + 90 * 60_000 })
  assert.deepEqual(pick(r.at(A, T0 + 100 * 60_000), ['status', 'value', 'source']),
    { status: 'observed', value: 1600, source: 'broker_cashflow' })
})

test('where both events carry the broker balanceVersion, only the next version proves the edge', t => {
  const db = fixture(t)
  storeApi(db, [
    apiDeal({ dealId: 1, at: T0, gross: 1000, balance: 100_000, version: 41 }),
    apiDeal({ dealId: 2, at: T0 + 2 * H, gross: 500, balance: 100_500, version: 42 }),
    apiDeal({ dealId: 3, at: T0 + 4 * H, gross: 500, balance: 101_000, version: 44 }),   // one change in between nets to zero
  ])
  const r = reader(db)
  assert.deepEqual(pick(r.at(A, T0 + H), ['status', 'proof']), { status: 'observed', proof: 'balance_version_consecutive' })
  assert.deepEqual(pick(r.at(A, T0 + 3 * H), ['status', 'reason', 'versions']),
    { status: 'not_stored', reason: 'balance_version_gap', versions: [42, 44] })
})

test('a deal stored before balances were kept is labelled, and a re-read recovers it', t => {
  const db = fixture(t)
  storeApi(db, [apiDeal({ dealId: 1, at: T0, gross: 1000, balance: 100_000 }), apiDeal({ dealId: 3, at: T0 + 4 * H, gross: 500, balance: 101_000 })])
  // Deal 2 as a pre-WEB-8 writer stored it: no balance fields at all.
  const [legacy] = shapeDeals([apiDeal({ dealId: 2, at: T0 + 2 * H, gross: 500 })], META, A)
  const { balance: _b, balance_version: _v, balance_currency: _c, balance_source: _s, ...old } = legacy
  persistDeals(db, [old])
  const gap = reader(db).at(A, T0 + H)
  assert.deepEqual(pick(gap, ['status', 'reason', 'eventLabel', 'event']),
    { status: 'not_stored', reason: 'event_without_balance', eventLabel: 'stored_before_balance_capture', event: { kind: 'deal', id: '2' } })
  assert.ok(BALANCE_GAP_LABELS[gap.eventLabel])
  const cov = reader(db).coverage(A)
  assert.deepEqual(cov.deals.withoutBalance, { stored_before_balance_capture: 1 })

  storeApi(db, [apiDeal({ dealId: 2, at: T0 + 2 * H, gross: 500, balance: 100_500 })])
  assert.deepEqual(pick(reader(db).at(A, T0 + H), ['status', 'value']), { status: 'observed', value: 1000 })
  assert.deepEqual(pick(reader(db).at(A, T0 + 3 * H), ['status', 'value']), { status: 'observed', value: 1005 })
  assert.deepEqual(reader(db).coverage(A).links, { reconciled: 2, versionConsecutive: 0, arithmeticOnly: 2, breaks: 0, versionGaps: 0, notCheckable: 0 })
})

test('no recorded deposit currency is a reason, never a default; a statement in another currency is not the account balance', t => {
  const bare = fixture(t, { currency: null })
  storeApi(bare, [apiDeal({ dealId: 1, at: T0, gross: 1000, balance: 100_000 }), apiDeal({ dealId: 2, at: T0 + 2 * H, gross: 500, balance: 100_500 })])
  assert.deepEqual(pick(reader(bare).at(A, T0 + H), ['status', 'reason']), { status: 'not_stored', reason: 'deposit_currency_not_recorded' })

  const db = fixture(t)
  const row = (id, at, net, balance) => ({ deal_id: id, position_id: null, account_id: A, symbol: 'X', side: 'BUY', lots: 1,
    entry_price: 1, close_price: 2, opened_at: null, closed_at: new Date(at).toISOString(), gross_pnl: null, swap: null,
    commission: 0, net_pnl: net, balance, balance_version: null, balance_currency: 'EUR', balance_source: 'statement' })
  persistDeals(db, [row('1', T0, 10, 1000), row('2', T0 + 2 * H, 5, 1005)])
  assert.deepEqual(pick(reader(db).at(A, T0 + H), ['status', 'reason', 'eventCurrency']),
    { status: 'not_stored', reason: 'observation_currency_mismatch', eventCurrency: 'EUR' })
})

test('the committed statements reconcile on every link, so their whole span carries a balance', async t => {
  const logins = [['46130058', '5306502'], ['10000001', '5203012'], ['10000002', '5268549']]
  const db = fixture(t, { accounts: logins })
  const dir = fileURLToPath(new URL('../seed-statements/', import.meta.url))
  const report = await importSeedStatements(db, dir, { log() {}, warn() {} })
  assert.equal(report.skipped, 0)
  const r = reader(db)
  const expected = { '46130058': 221, '10000001': 446, '10000002': 16 }
  for (const [id] of logins) {
    const cov = r.coverage(id)
    assert.equal(cov.deals.total, expected[id])
    assert.equal(cov.deals.withBalance, expected[id], `${id}: every statement deal stores its balance`)
    assert.deepEqual(cov.links, { reconciled: expected[id] - 1, versionConsecutive: 0, arithmeticOnly: expected[id] - 1,
      breaks: 0, versionGaps: 0, notCheckable: 0 }, `${id}: every consecutive pair reconciles to the cent`)
  }
  // 46130058 (login 5306502): DID315179943 closed 2026-08-20 13:38:19.954Z at
  // 46,538.53; the next close is DID315271452 at 2026-08-21 01:31:00.286Z.
  const edge = r.at('46130058', Date.parse('2026-08-20T20:00:00Z'))
  assert.deepEqual(pick(edge, ['status', 'value', 'currency', 'source', 'proof', 'event', 'nextEvent']), {
    status: 'observed', value: 46538.53, currency: 'USD', source: 'broker_statement', proof: 'balance_arithmetic',
    event: { kind: 'deal', id: '315179943' }, nextEvent: { kind: 'deal', id: '315271452' } })
  assert.equal(r.at('46130058', Date.parse('2026-07-30T00:00:00Z')).reason, 'before_first_stored_event')
  assert.equal(r.at('46130058', Date.parse('2026-08-22T00:00:00Z')).reason, 'after_last_stored_event')

  // A second boot re-imports the same files and keeps every balance.
  await importSeedStatements(db, dir, { log() {}, warn() {} })
  assert.equal(reader(db).coverage('46130058').deals.withBalance, 221)
})

test('the cashflow balance is kept, a missing one is filled on a re-read, and neither a missing nor a disagreeing one refuses the window', t => {
  const db = fixture(t)
  const stored = () => db.prepare(`SELECT event_id, delta, balance, balance_version, balance_source FROM account_cashflows ORDER BY event_id`).all()
  const window = (items, receivedAt = T0 + 3 * H) => recordCashflowWindow(db, { accountId: A, host: HOST, currency: 'USD',
    from: T0, to: T0 + 2 * H, receivedAt, response: cashflowResponse(items) })
  // A row stored before WEB-8 (no balance columns written).
  db.prepare(`INSERT INTO account_cashflows (account_id, host, event_id, at_ms, currency, delta, operation_type, kind, received_ms)
    VALUES (?, ?, '1', ?, 'USD', 100, 0, 'external', ?)`).run(A, HOST, T0 + 60_000, T0 + H)
  const first = window([
    deposit({ id: '1', at: T0 + 60_000, delta: 10_000, balance: 110_000, version: 5 }),
    deposit({ id: '2', at: T0 + 120_000, delta: 5000 }),                              // no balance given
  ])
  assert.equal(first.events, 2)
  assert.equal(first.balanceConflicts, 0)
  assert.deepEqual(stored(), [
    { event_id: '1', delta: 100, balance: 1100, balance_version: 5, balance_source: 'broker_api' },
    { event_id: '2', delta: 50, balance: null, balance_version: null, balance_source: 'broker_api' },
  ])
  const second = window([
    deposit({ id: '1', at: T0 + 60_000, delta: 10_000, balance: 999_900, version: 9 }),     // disagrees: first stays
    deposit({ id: '2', at: T0 + 120_000, delta: 5000, balance: 115_000, version: 6 }),     // fills the missing one
  ])
  assert.equal(second.balanceConflicts, 1)
  assert.deepEqual(stored(), [
    { event_id: '1', delta: 100, balance: 1100, balance_version: 5, balance_source: 'broker_api' },
    { event_id: '2', delta: 50, balance: 1150, balance_version: 6, balance_source: 'broker_api' },
  ])
  // The delta rule is untouched: a disagreeing delta still refuses the window.
  assert.throws(() => window([deposit({ id: '1', at: T0 + 60_000, delta: 1, balance: 110_000 })]), /cashflow_duplicate_conflict/)
})

test('a re-read writes only the row it fills: a stored balance, or an API read that already found none, is not rewritten', t => {
  const db = fixture(t)
  db.exec(`CREATE TABLE cashflow_row_writes (event_id TEXT);
    CREATE TRIGGER cashflow_row_written AFTER UPDATE ON account_cashflows
    BEGIN INSERT INTO cashflow_row_writes VALUES (NEW.event_id); END;`)
  const writes = () => db.prepare('SELECT event_id FROM cashflow_row_writes ORDER BY rowid').all().map(r => r.event_id)
  const window = (items) => recordCashflowWindow(db, { accountId: A, host: HOST, currency: 'USD',
    from: T0, to: T0 + 2 * H, receivedAt: T0 + 3 * H, response: cashflowResponse(items) })
  // Event 3 as a pre-WEB-8 writer stored it: no balance, no source.
  db.prepare(`INSERT INTO account_cashflows (account_id, host, event_id, at_ms, currency, delta, operation_type, kind, received_ms)
    VALUES (?, ?, '3', ?, 'USD', 20, 0, 'external', ?)`).run(A, HOST, T0 + 180_000, T0 + H)
  const items = [
    deposit({ id: '1', at: T0 + 60_000, delta: 10_000, balance: 110_000, version: 5 }),
    deposit({ id: '2', at: T0 + 120_000, delta: 5000 }),
    deposit({ id: '3', at: T0 + 180_000, delta: 2000 }),
  ]
  window(items)
  assert.deepEqual(writes(), ['3'], 'only the pre-WEB-8 row is stamped with the read that found no balance')
  const before = db.prepare('SELECT * FROM account_cashflows ORDER BY event_id').all()
  window(items)
  window(items)
  assert.deepEqual(writes(), ['3'], 'the same read again rewrites nothing')
  assert.deepEqual(db.prepare('SELECT * FROM account_cashflows ORDER BY event_id').all(), before)
  window([items[0], deposit({ id: '2', at: T0 + 120_000, delta: 5000, balance: 115_000, version: 6 }), items[2]])
  assert.deepEqual(writes(), ['3', '2'], 'a read carrying the missing balance fills exactly that row')
  assert.deepEqual(db.prepare(`SELECT balance, balance_version, balance_source FROM account_cashflows WHERE event_id = '2'`).get(),
    { balance: 1150, balance_version: 6, balance_source: 'broker_api' })
})

test('event times are the interval the stored text is known to within', () => {
  assert.deepEqual(eventTime('2026-08-03 10:00:00'), { earliest: T0, latest: T0 + 999 })
  assert.deepEqual(eventTime('2026-08-03T10:00:00.250Z'), { earliest: T0 + 250, latest: T0 + 250 })
  assert.deepEqual(eventTime('2026-08-03T18:00:00.2+08:00'), { earliest: T0 + 200, latest: T0 + 299 })
  assert.equal(eventTime('yesterday'), null)
  assert.equal(eventTime(null), null)
})

test('initDB adds the balance columns to a pre-WEB-8 database, keeps its rows, and runs again as a no-op', t => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'deal-balance-db-')), 'agent.db')
  // The two tables exactly as they were declared before WEB-8, with one row each.
  const old = new Database(file)
  old.exec(`CREATE TABLE broker_deals (deal_id TEXT PRIMARY KEY, position_id TEXT, account_id TEXT, symbol TEXT, side TEXT,
      lots REAL, entry_price REAL, close_price REAL, opened_at TEXT, closed_at TEXT, gross_pnl REAL, swap REAL,
      commission REAL, net_pnl REAL, matched_trade_id INTEGER, imported_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE account_cashflows (account_id TEXT NOT NULL, host TEXT NOT NULL, event_id TEXT NOT NULL, at_ms INTEGER NOT NULL,
      currency TEXT NOT NULL, delta REAL NOT NULL, operation_type INTEGER NOT NULL, kind TEXT NOT NULL,
      received_ms INTEGER NOT NULL, PRIMARY KEY(account_id, host, event_id));
    INSERT INTO broker_deals (deal_id, account_id, closed_at, net_pnl) VALUES ('9', '${A}', '2026-08-01 10:00:00', 5);
    INSERT INTO account_cashflows VALUES ('${A}', '${HOST}', '4', ${T0}, 'USD', 10, 0, 'external', ${T0});`)
  old.close()
  initDB(file).close()
  const db = initDB(file)
  t.after(() => db.close())
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
  for (const c of ['balance', 'balance_version', 'balance_currency', 'balance_source']) assert.ok(cols('broker_deals').includes(c), c)
  for (const c of ['balance', 'balance_version', 'balance_source']) assert.ok(cols('account_cashflows').includes(c), c)
  assert.deepEqual(db.prepare(`SELECT deal_id, net_pnl, balance, balance_source FROM broker_deals`).all(),
    [{ deal_id: '9', net_pnl: 5, balance: null, balance_source: null }])
  assert.deepEqual(db.prepare(`SELECT event_id, delta, balance, balance_source FROM account_cashflows`).all(),
    [{ event_id: '4', delta: 10, balance: null, balance_source: null }])
  db.prepare(`INSERT INTO accounts (account_id, is_live) VALUES (?, 0)`).run(A)
  assert.deepEqual(reader(db).coverage(A).deals.withoutBalance, { stored_before_balance_capture: 1 })
  assert.deepEqual(reader(db).coverage(A).cashflows.withoutBalance, { stored_before_balance_capture: 1 })
})

test('GET /state/deal-balances reports the evidence and the proven edge; a bad edge is a 400', async t => {
  const db = fixture(t)
  storeApi(db, [apiDeal({ dealId: 1, at: T0, gross: 1000, balance: 100_000 }), apiDeal({ dealId: 2, at: T0 + 2 * H, gross: 500, balance: 100_500 })])
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const url = q => `http://127.0.0.1:${server.address().port}/state/deal-balances${q}`

  const res = await fetch(url(`?account=${A}&at=${T0 + H},${new Date(T0 - H).toISOString()}`))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.accounts.length, 1)
  const [acct] = body.accounts
  assert.deepEqual(pick(acct, ['accountId', 'currency', 'firstBalanceAt', 'lastBalanceAt']),
    { accountId: A, currency: 'USD', firstBalanceAt: new Date(T0 + 999).toISOString(), lastBalanceAt: new Date(T0 + 2 * H).toISOString() })
  assert.deepEqual(acct.edges.map(e => [e.edge, e.status, e.value ?? e.reason]), [
    [new Date(T0 + H).toISOString(), 'observed', 1000],
    // The ledger carry's reader answers the edges: before every stored
    // balance of either kind is "not stored before" the first one.
    [new Date(T0 - H).toISOString(), 'not_stored', 'before_balance_history'],
  ])
  assert.equal(acct.edges[1].storedFrom, T0 + 999)
  assert.equal(body.edgeBasis, 'ledger_carry_reader')
  // One reader: each edge here is exactly what the ledger carry reads there.
  const carry = balanceReader(db, { currencyByAccount: depositCurrencies(db), dealBalances: true })
  assert.deepEqual(acct.edges, [{ edge: new Date(T0 + H).toISOString(), ...carry.at(A, T0 + H) },
    { edge: new Date(T0 - H).toISOString(), ...carry.at(A, T0 - H) }])
  assert.deepEqual(body.labels, BALANCE_GAP_LABELS)

  for (const q of ['?at=yesterday', `?at=${Array.from({ length: 25 }, (_, i) => T0 + i).join(',')}`]) {
    const bad = await fetch(url(q))
    assert.equal(bad.status, 400, q)
  }
  assert.equal(dealBalanceReport(db, { currencyByAccount: depositCurrencies(db) }).accounts.length, 1)
})
