// node --test agent/services/position-lifecycle-evidence.test.js
//
// V3 B2 (P5b-2): broker lifecycle verdicts. Behaviour, on disposable SQLite,
// with injected position histories:
//   - a rejected-only history is `never_filled` and does not throw; the old
//     reader's write-off label says "never filled", not "no broker evidence";
//   - unsupported answers are FINAL and never read again;
//   - the sweep reads money rows without receipts, keeps the receipts, and
//     never writes money; it shares the old reader's 30 s pacing, rotates its
//     classes fairly, and a reply after the deadline writes nothing;
//   - a row with no account is probed on BOTH hosts (a demo and a live
//     account's pass), and the report names the one account that holds it.
// Fix round (checker N1, N3, N4, N5, N9): the pacing holds in both
// directions; a final verdict is final only under the current rules; a paged
// answer is final; "never filled" needs this position's own deals; an open
// row with no account is probed like a closed one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { tempDir } from '../test-support/temp-dir.js'
import {
  classifyPositionHistory, sweepLifecycleEvidence, VERDICTS, EVIDENCE_PACE_MS, EVIDENCE_RETRY_MS, EVIDENCE_RULES,
} from './position-lifecycle-evidence.js'
import { verifiedPositionHistory, POSITION_HISTORY_REFUSED } from '../lib/position-deal-history.js'
import { backfillAccountPnl } from './cross-side-pnl.js'
import { recoverOldPositionPnl } from './old-position-pnl.js'
import { resetBackfillPacing } from './pnl-backfill.js'
import { BROKER_NEVER_FILLED, UNRESOLVED_NO_EVIDENCE } from './mark-unresolvable.js'
import { buildLedgerReconciliation } from './ledger-reconciliation.js'

const NOW = Date.parse('2026-09-25T12:00:00Z'), MIN = 60_000, DAY = 86_400_000
const DEMO = '46130058', LIVE = '42993489', DEMO2 = '43097342'
const HOST = { [DEMO]: 'demo.ctraderapi.com', [DEMO2]: 'demo.ctraderapi.com', [LIVE]: 'live.ctraderapi.com' }

function fresh(t, accounts = [[DEMO, 0], [LIVE, 1]]) {
  const db = initDB(':memory:'); resetBackfillPacing()
  t.after(() => { db.close(); resetBackfillPacing() })
  for (const [id, live] of accounts) db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,?,1,'active')").run(id, live)
  return db
}
const iso = ms => new Date(ms).toISOString()
function trade(db, { acct = DEMO, pid, status = 'closed', net = null, opened = NOW - 30 * DAY, closed = NOW - 29 * DAY, writtenOff = 0,
  symbol = 'EURUSD', side = 'BUY', reason = null }) {
  return Number(db.prepare(`INSERT INTO trades (account_id, symbol, side, status, ctrader_position_id, opened_at, closed_at, entry_price, sl_price,
      volume, net_pnl, pnl_unresolvable, pnl_unresolvable_reason, pnl_attempts) VALUES (?,?,?,?,?,?,?,1.1,1.0,1,?,?,?,0)`)
    .run(acct, symbol, side, status, pid, iso(opened), iso(closed), net, writtenOff, reason).lastInsertRowid)
}
const od = (id, pid, t, vol = 100, extra = {}) => ({ dealId: String(id), positionId: String(pid), symbolId: 10, dealStatus: 2, tradeSide: 1,
  volume: vol, filledVolume: vol, executionPrice: 1.1, executionTimestamp: t, ...extra })
const cd = (id, pid, t, vol, gross, extra = {}) => ({ dealId: String(id), positionId: String(pid), symbolId: 10, dealStatus: 2, tradeSide: 2,
  volume: vol, filledVolume: vol, executionPrice: 1.2, executionTimestamp: t,
  closePositionDetail: { grossProfit: gross, swap: 0, commission: 0, moneyDigits: 2, closedVolume: vol, entryPrice: 1.1 }, ...extra })
const hist = (acct, deals, more = {}) => ({ ctidTraderAccountId: acct, hasMore: false, deal: deals, ...more })
/** A whole lifecycle: open, one close at `closeAt` with `gross` cents. */
const life = (acct, pid, gross, closeAt = NOW - 29 * DAY) => hist(acct, [od(pid * 10 + 1, pid, NOW - 30 * DAY), cd(pid * 10 + 2, pid, closeAt, 100, gross)])
const rejected = (id, pid, status = 4) => ({ ...od(id, pid, NOW - 30 * DAY), dealStatus: status })
const evidence = (db, acct, pid) => db.prepare('SELECT * FROM position_lifecycle_evidence WHERE account_id = ? AND position_id = ?').get(acct, String(pid))
const rowSnap = (db, id) => db.prepare('SELECT status, net_pnl, gross_pnl, account_id, pnl_unresolvable, exit_price FROM trades WHERE id = ?').get(id)

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

test('a rejected-only history is never_filled, final, and does not throw; the settling reader refuses it as never filled', () => {
  const response = hist(DEMO, [rejected(1, 700, 4), rejected(2, 700, 'MISSED'), rejected(3, 700, 5)])
  let c
  assert.doesNotThrow(() => { c = classifyPositionHistory(response, { accountId: DEMO, positionId: '700', now: NOW }) })
  assert.equal(c.verdict, 'never_filled'); assert.equal(c.final, true)
  assert.match(c.reason, /none executed: REJECTED×1, MISSED×1, INTERNALLY_REJECTED×1/)
  assert.equal(c.persistable, false)
  // The money path: a refusal with the evidence named, not "deal evidence invalid".
  assert.throws(() => verifiedPositionHistory(response, { accountId: DEMO, positionId: '700', now: NOW }),
    e => e.code === POSITION_HISTORY_REFUSED && e.neverFilled === true && /never filled/.test(e.message))
  // A malformed deal is still the old refusal, not "never filled".
  assert.throws(() => verifiedPositionHistory(hist(DEMO, [od(1, 700, NOW - DAY, 100, { dealStatus: 2, executionPrice: -1 })]),
    { accountId: DEMO, positionId: '700', now: NOW }), e => e.code === POSITION_HISTORY_REFUSED && !e.neverFilled && /deal evidence invalid/.test(e.message))
})

test('every answer shape gets its verdict; final ones are the ones nothing at the broker can change', () => {
  const c = (response, ledgerRows = []) => classifyPositionHistory(response, { accountId: DEMO, positionId: '700', now: NOW, ledgerRows })
  assert.deepEqual([c(hist(DEMO, [])).verdict, c(hist(DEMO, [])).final], ['empty_at_broker', true])
  assert.deepEqual([c({ ctidTraderAccountId: DEMO, deal: [] }).verdict, c({ ...hist(DEMO, []), hasMore: true }).final], ['unreadable', false])
  assert.equal(c(hist(LIVE, [])).verdict, 'unreadable', 'another account answered')
  assert.equal(c(null).verdict, 'unreadable')
  assert.equal(c(hist(DEMO, [cd(2, 700, NOW - DAY, 100, 150)])).verdict, 'opening_not_retained')
  assert.equal(c(hist(DEMO, [od(1, 700, NOW - 3 * DAY, 50), cd(2, 700, NOW - DAY, 100, 150)])).verdict, 'opening_not_retained')
  const big = hist(DEMO, Array.from({ length: 501 }, (_, i) => od(i + 1, 700, NOW - DAY)))
  assert.deepEqual([c(big).verdict, c(big).final], ['permanently_unsupported', true])
  assert.equal(c(hist(DEMO, [{ ...od(1, 700, NOW - DAY), dealStatus: 9 }])).verdict, 'permanently_unsupported')
  assert.match(c(hist(DEMO, [od(1, 700, NOW - 2 * DAY), rejected(2, 700), cd(3, 700, NOW - DAY, 100, 150)])).reason, /non-executed deal/)
  const open = c(hist(DEMO, [od(1, 700, NOW - 2 * DAY), cd(2, 700, NOW - DAY, 40, 150)]))
  assert.deepEqual([open.verdict, open.final, open.persistable], ['open_at_broker', false, true])
  assert.equal(c(life(DEMO, 700, 150)).verdict, 'no_ledger_row')
  for (const [v, spec] of Object.entries(VERDICTS)) assert.equal(typeof spec.final, 'boolean', v)
})

test('a paged answer (hasMore with deals) is the bounded response exceeded: final; hasMore with no deal says nothing (checker N4)', () => {
  const c = response => classifyPositionHistory(response, { accountId: DEMO, positionId: '700', now: NOW })
  const paged = c(hist(DEMO, [od(1, 700, NOW - 2 * DAY), cd(2, 700, NOW - DAY, 100, 150)], { hasMore: true }))
  assert.deepEqual([paged.verdict, paged.final, paged.persistable, paged.deals], ['permanently_unsupported', true, false, 2])
  assert.match(paged.reason, /paged the history of position 700 \(hasMore after 2 deal\(s\)\)/)
  // Still unreadable: hasMore with nothing in it, and an answer with no hasMore flag at all.
  assert.equal(c(hist(DEMO, [], { hasMore: true })).verdict, 'unreadable')
  assert.equal(c({ ctidTraderAccountId: DEMO, deal: [od(1, 700, NOW - DAY)] }).verdict, 'unreadable')
  // Another account's paged answer is another account's: unreadable, never final.
  assert.equal(c(hist(LIVE, [od(1, 700, NOW - DAY)], { hasMore: true })).verdict, 'unreadable')
})

test('"never filled" needs every deal to be this position\'s, with a deal id (checker N5)', () => {
  const at = response => ({ c: classifyPositionHistory(response, { accountId: DEMO, positionId: '700', now: NOW }), response })
  const foreign = hist(DEMO, [rejected(1, 999, 4), rejected(2, 999, 4)])
  const noId = hist(DEMO, [{ ...rejected(1, 700, 4), dealId: undefined }, rejected(2, 700, 4)])
  const mixed = hist(DEMO, [rejected(1, 700, 4), rejected(2, 999, 'MISSED')])
  for (const { c, response } of [at(foreign), at(noId), at(mixed)]) {
    assert.equal(c.verdict, 'permanently_unsupported')
    assert.match(c.reason, /position deal evidence invalid/)
    // The settling reader: the pre-B2 refusal, not "never filled".
    assert.throws(() => verifiedPositionHistory(response, { accountId: DEMO, positionId: '700', now: NOW }),
      e => e.code === POSITION_HISTORY_REFUSED && e.neverFilled !== true && e.message === 'position deal evidence invalid')
  }
  // This position's own rejected deals are still "never filled".
  assert.equal(at(hist(DEMO, [rejected(1, 700, 4), rejected(2, '700', 'MISSED')])).c.verdict, 'never_filled')
})

test('money verdicts: agrees, disagrees, and the two fragment shapes (309/310, two priced rows) — verdict only', () => {
  const rows = (...r) => r.map((x, i) => ({ id: i + 1, status: 'closed', net_pnl: null, closed_at: iso(NOW - 29 * DAY), ...x }))
  const c = ledgerRows => classifyPositionHistory(life(DEMO, 700, 15000), { accountId: DEMO, positionId: '700', now: NOW, ledgerRows })
  assert.equal(c(rows({ net_pnl: 150 })).verdict, 'agrees')
  const d = c(rows({ net_pnl: 120 }))
  assert.equal(d.verdict, 'money_disagrees'); assert.equal(d.broker.net, 150); assert.match(d.reason, /delta -30/)
  // NATGAS #309: money on a row recorded closed a day before the broker's
  // final close, its true twin #310 rejected.
  const f = c([{ id: 309, status: 'closed', net_pnl: 435.5, closed_at: iso(NOW - 30 * DAY + 60 * MIN) }, { id: 310, status: 'rejected', net_pnl: null }])
  assert.equal(f.verdict, 'money_bearing_fragment'); assert.match(f.reason, /#310:rejected/)
  assert.equal(c(rows({ net_pnl: 100 }, { net_pnl: 50 })).verdict, 'money_bearing_fragment')
  assert.equal(c(rows({})).verdict, 'unpriced')
  assert.equal(c(rows({ status: 'open' })).verdict, 'ledger_row_open')
})

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

const creds = acct => ({ accountId: acct, host: HOST[acct] })

test('a money row with no receipt: read once, receipts kept and linked, verdict agrees, money untouched', async t => {
  const db = fresh(t)
  const id = trade(db, { pid: '700', net: 150 })
  const before = rowSnap(db, id)
  const reads = []
  const out = await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW, getPositionDeals: async pid => { reads.push(pid); return life(DEMO, 700, 15000) } })
  assert.deepEqual(reads, ['700'])
  assert.equal(out.state, 'read'); assert.equal(out.class, 'receipt'); assert.equal(out.verdict, 'agrees'); assert.equal(out.receipts, 1)
  const ev = evidence(db, DEMO, 700)
  assert.deepEqual([ev.verdict, ev.final, ev.broker_net, ev.ledger_net, ev.host, ev.source], ['agrees', 1, 150, 150, 'demo.ctraderapi.com', 'evidence_sweep:receipt'])
  const deal = db.prepare('SELECT net_pnl, matched_trade_id FROM broker_deals WHERE account_id = ? AND position_id = ?').get(DEMO, '700')
  assert.deepEqual(deal, { net_pnl: 150, matched_trade_id: id })
  assert.deepEqual(rowSnap(db, id), before, 'the sweep never writes money or status')
  // Final and receipted: never read again.
  const again = await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW + EVIDENCE_RETRY_MS + MIN, getPositionDeals: async pid => { reads.push(pid); return null } })
  assert.equal(again.state, 'no_candidate'); assert.equal(reads.length, 1)
})

test('money that disagrees and a money-bearing fragment are verdicts only: the rows stay byte-identical', async t => {
  const db = fresh(t)
  const a = trade(db, { pid: '701', net: 120 })
  const f = trade(db, { pid: '702', net: 435.5, closed: NOW - 30 * DAY + 60 * MIN }), twin = trade(db, { pid: '702', status: 'rejected' })
  const snaps = [a, f, twin].map(id => rowSnap(db, id))
  const histories = { 701: life(DEMO, 701, 15000), 702: life(DEMO, 702, 35100) }
  let now = NOW
  for (let i = 0; i < 2; i++, now += EVIDENCE_PACE_MS) {
    await sweepLifecycleEvidence(db, creds(DEMO), { now, getPositionDeals: async pid => histories[pid] })
  }
  assert.equal(evidence(db, DEMO, 701).verdict, 'money_disagrees')
  assert.equal(evidence(db, DEMO, 702).verdict, 'money_bearing_fragment')
  assert.deepEqual([a, f, twin].map(id => rowSnap(db, id)), snaps)
})

test('pacing is shared with the old-position reader: one read per account per 30 s across both', async t => {
  const db = fresh(t)
  trade(db, { pid: '700', net: 150 }); trade(db, { pid: '701', net: 20 })
  let reads = 0
  const read = async pid => { reads++; return life(DEMO, Number(pid), pid === '700' ? 15000 : 2000) }
  assert.equal((await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW, getPositionDeals: read })).state, 'read')
  assert.equal((await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW + EVIDENCE_PACE_MS - 1, getPositionDeals: read })).state, 'paced')
  setState(db, `position_pnl_recovery:${DEMO}`, JSON.stringify({ lastReadAt: NOW + 40_000 }))
  assert.equal((await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW + 45_000, getPositionDeals: read })).state, 'paced', 'the old reader read 5 s ago')
  assert.equal(reads, 1)
  // 31 s after the reader's read and 71 s after the sweep's: due again.
  assert.equal((await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW + 71_000, getPositionDeals: read })).state, 'read')
  assert.equal(reads, 2)
})

test('the other direction (checker N1): a sweep read 10 s ago paces the old-position reader on the same account', async t => {
  const db = fresh(t, [[DEMO, 0], [DEMO2, 0]])
  trade(db, { pid: '700', net: 150 })
  let reads = 0
  const swept = await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW, getPositionDeals: async () => { reads++; return life(DEMO, 700, 15000) } })
  assert.equal(swept.state, 'read')
  // The checker's reproduction: a new unpriced row, and a reader pass 10 s later.
  const unpriced = trade(db, { pid: '701' })
  const reader = (acct, at) => recoverOldPositionPnl(db, { ready: true, host: HOST[acct], accountId: acct }, { now: at, isCurrent: () => true,
    getPositionDeals: async pid => { reads++; return life(acct, Number(pid), 2000) } })
  assert.equal((await reader(DEMO, NOW + 10_000)).state, 'paced')
  assert.equal(reads, 1, 'two position-history reads in 10 s on one account is what the shared pacing forbids')
  assert.equal(rowSnap(db, unpriced).net_pnl, null)
  // Another account is not paced by this account's sweep.
  trade(db, { acct: DEMO2, pid: '702' })
  assert.equal((await reader(DEMO2, NOW + 10_000)).state, 'recovered')
  assert.equal(reads, 2)
  // 30 s after the sweep's read the reader is due again and fills the row.
  assert.equal((await reader(DEMO, NOW + EVIDENCE_PACE_MS)).state, 'recovered')
  assert.equal(reads, 3); assert.equal(rowSnap(db, unpriced).net_pnl, 20)
})

test('a final verdict is final only under the current rules: one judged under older rules is read once more (checker N3)', async t => {
  const db = fresh(t)
  trade(db, { pid: '700', net: 150 })
  let reads = 0
  const read = async () => { reads++; return hist(DEMO, []) }
  await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW, getPositionDeals: read })
  assert.deepEqual([evidence(db, DEMO, 700).verdict, evidence(db, DEMO, 700).final, evidence(db, DEMO, 700).rules], ['empty_at_broker', 1, EVIDENCE_RULES])
  assert.equal((await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW + EVIDENCE_RETRY_MS + MIN, getPositionDeals: read })).state, 'no_candidate')
  // The rules change (the owner answers how an empty history is judged).
  db.prepare('UPDATE position_lifecycle_evidence SET rules = ?').run(EVIDENCE_RULES - 1)
  const again = await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW + EVIDENCE_RETRY_MS + 2 * MIN, getPositionDeals: read })
  assert.deepEqual([again.state, again.positionId, reads], ['read', '700', 2])
  assert.equal(evidence(db, DEMO, 700).rules, EVIDENCE_RULES)
  // Judged under the current rules again: never read again.
  assert.equal((await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW + 3 * DAY, getPositionDeals: read })).state, 'no_candidate')
  assert.equal(reads, 2)
})

test('a table created before the rules column gains it, and its rows count as older rules (checker N3)', t => {
  const path = join(tempDir('lifecycle-evidence-rules-'), 'old.db')
  const old = new Database(path)
  old.exec(`CREATE TABLE position_lifecycle_evidence (account_id TEXT NOT NULL, position_id TEXT NOT NULL, host TEXT, verdict TEXT NOT NULL,
    final INTEGER NOT NULL DEFAULT 0, reason TEXT, source TEXT, deals INTEGER, executed INTEGER, symbol_id TEXT, opening_side TEXT, opened_ms INTEGER,
    final_close_ms INTEGER, broker_net REAL, broker_gross REAL, broker_swap REAL, broker_commission REAL, conversion_fee REAL, ledger_net REAL,
    ledger_rows TEXT, trade_ids TEXT, read_at TEXT NOT NULL, reads INTEGER NOT NULL DEFAULT 1, last_error TEXT, last_error_at TEXT,
    PRIMARY KEY (account_id, position_id))`)
  old.prepare(`INSERT INTO position_lifecycle_evidence (account_id, position_id, verdict, final, read_at) VALUES ('${DEMO}', '700', 'empty_at_broker', 1, ?)`).run(iso(NOW))
  old.close()
  const db = initDB(path); t.after(() => db.close())
  assert.ok(db.prepare('PRAGMA table_info(position_lifecycle_evidence)').all().some(c => c.name === 'rules'))
  assert.equal(evidence(db, DEMO, 700).rules, 0)
  assert.notEqual(EVIDENCE_RULES, 0, 'a pre-column row is never "current"')
})

test('an open row with no account is probed too, so the report never reads "probing" for ever (checker N9)', async t => {
  const db = fresh(t)
  const orphan = trade(db, { acct: null, pid: '231100001', status: 'open' })
  const noPid = trade(db, { acct: null, pid: null, status: 'open' })
  const before = rowSnap(db, orphan)
  const brokerOn = { [DEMO]: hist(DEMO, [od(1, 231100001, NOW - DAY)]), [LIVE]: hist(LIVE, []) }
  for (const acct of [DEMO, LIVE]) {
    const out = await sweepLifecycleEvidence(db, creds(acct), { now: NOW, getPositionDeals: async () => brokerOn[acct] })
    assert.deepEqual([out.state, out.class, out.positionId], ['read', 'no_account', '231100001'], acct)
  }
  const rows = buildLedgerReconciliation(db).noAccount.rows
  const row = rows.find(r => r.tradeId === orphan)
  assert.deepEqual([row.status, row.verdict, row.heldBy.accountId, row.heldBy.verdict], ['open', 'held_by_one_account', DEMO, 'open_at_broker'])
  // A row with no position id is listed, not hidden, and not "probing".
  assert.equal(rows.find(r => r.tradeId === noPid).verdict, 'no_position_id')
  assert.deepEqual(rowSnap(db, orphan), before, 'nothing is written to the row')
})

test('an unreadable answer is retried after 15 minutes, never sooner, and never replaces a verdict', async t => {
  const db = fresh(t)
  trade(db, { pid: '700', net: 150 })
  let reads = 0
  const fail = async () => { reads++; throw new Error('broker socket closed') }
  await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW, getPositionDeals: fail })
  assert.deepEqual([evidence(db, DEMO, 700).verdict, evidence(db, DEMO, 700).last_error], ['unreadable', 'broker socket closed'])
  assert.equal((await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW + EVIDENCE_RETRY_MS - MIN, getPositionDeals: fail })).state, 'no_candidate')
  assert.equal(reads, 1)
  // An open-at-broker verdict survives a later failed read.
  await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW + EVIDENCE_RETRY_MS + MIN,
    getPositionDeals: async () => hist(DEMO, [od(1, 700, NOW - 2 * DAY), cd(2, 700, NOW - DAY, 40, 150)]) })
  assert.equal(evidence(db, DEMO, 700).verdict, 'open_at_broker')
  await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW + 2 * EVIDENCE_RETRY_MS + 2 * MIN, getPositionDeals: fail })
  const ev = evidence(db, DEMO, 700)
  assert.deepEqual([ev.verdict, ev.last_error], ['open_at_broker', 'broker socket closed'])
})

test('a reply after the deadline writes nothing: no verdict, no receipt', async t => {
  const db = fresh(t)
  const id = trade(db, { pid: '700', net: 150 })
  let current = true
  const out = await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW, isCurrent: () => current,
    getPositionDeals: async () => { current = false; return life(DEMO, 700, 15000) } })
  assert.equal(out.state, 'deadline')
  assert.equal(evidence(db, DEMO, 700), undefined)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM broker_deals').get().n, 0)
  assert.equal(rowSnap(db, id).net_pnl, 150)
  // The pass's own deadline error is the same: nothing recorded.
  const late = await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW + EVIDENCE_PACE_MS, getPositionDeals: async () => { throw new Error('backfill deadline elapsed') } })
  assert.equal(late.state, 'deadline'); assert.equal(evidence(db, DEMO, 700), undefined)
})

test('fairness: the classes are served in rotation, so a receipt backlog cannot starve the no-account probes', async t => {
  const db = fresh(t)
  for (const pid of ['700', '701', '702']) trade(db, { pid, net: 1.5 })
  trade(db, { acct: null, pid: '900', net: 3 })
  const order = []
  const read = async pid => { order.push(pid); return pid === '900' ? hist(DEMO, []) : life(DEMO, Number(pid), 150) }
  for (let i = 0; i < 4; i++) await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW + i * EVIDENCE_PACE_MS, getPositionDeals: read })
  assert.deepEqual(order, ['702', '900', '701', '700'])
  assert.equal(JSON.parse(getState(db, `position_lifecycle_sweep:${DEMO}`)).class, 'receipt')
})

test('a final unsupported answer is never read again', async t => {
  const db = fresh(t)
  trade(db, { pid: '700', net: 150 })
  let reads = 0
  const read = async () => { reads++; return hist(DEMO, Array.from({ length: 501 }, (_, i) => od(i + 1, 700, NOW - DAY))) }
  await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW, getPositionDeals: read })
  assert.deepEqual([evidence(db, DEMO, 700).verdict, evidence(db, DEMO, 700).final], ['permanently_unsupported', 1])
  for (const later of [EVIDENCE_RETRY_MS + MIN, 3 * DAY]) {
    assert.equal((await sweepLifecycleEvidence(db, creds(DEMO), { now: NOW + later, getPositionDeals: read })).state, 'no_candidate')
  }
  assert.equal(reads, 1)
})

test('a row with no account is probed on both hosts, and the report names the one account that holds it', async t => {
  const db = fresh(t, [[DEMO, 0], [LIVE, 1], [DEMO2, 0]])
  const orphan = trade(db, { acct: null, pid: '230926972', net: 12.5, side: 'SELL' })
  const before = rowSnap(db, orphan)
  const brokerOn = { [DEMO]: hist(DEMO, []), [LIVE]: life(LIVE, 230926972, 1250), [DEMO2]: hist(DEMO2, []) }
  const probed = []
  const probe = async acct => sweepLifecycleEvidence(db, creds(acct), { now: NOW,
    getPositionDeals: async pid => { probed.push([acct, HOST[acct], pid]); return brokerOn[acct] } })
  await probe(DEMO)
  let report = buildLedgerReconciliation(db).noAccount.rows[0]
  assert.equal(report.verdict, 'probing', 'two enabled accounts are not probed yet')
  await probe(LIVE); await probe(DEMO2)
  assert.deepEqual(new Set(probed.map(p => p[1])), new Set(['demo.ctraderapi.com', 'live.ctraderapi.com']), 'both hosts probed')
  assert.deepEqual([evidence(db, DEMO, 230926972).verdict, evidence(db, LIVE, 230926972).verdict, evidence(db, DEMO2, 230926972).verdict],
    ['empty_at_broker', 'no_ledger_row', 'empty_at_broker'])
  assert.equal(evidence(db, LIVE, 230926972).trade_ids, JSON.stringify([orphan]))
  report = buildLedgerReconciliation(db).noAccount.rows[0]
  assert.equal(report.verdict, 'held_by_one_account')
  assert.deepEqual([report.heldBy.accountId, report.heldBy.brokerNet, report.heldBy.sideMatches], [LIVE, 12.5, false])
  assert.deepEqual(rowSnap(db, orphan), before, 'the attribution is reported, never written')
  // Receipts of the probe are the live account's, and not "broker-only" there.
  assert.equal(buildLedgerReconciliation(db, { accountId: LIVE }).accounts[0].classes.broker_only, undefined)
})

test('no enabled account holds it: every probe complete-empty', async t => {
  const db = fresh(t)
  trade(db, { acct: null, pid: '231034106', net: 5 })
  for (const acct of [DEMO, LIVE]) {
    await sweepLifecycleEvidence(db, creds(acct), { now: NOW, getPositionDeals: async () => hist(acct, []) })
  }
  assert.equal(buildLedgerReconciliation(db).noAccount.rows[0].verdict, 'no_enabled_account_holds_it')
})

// ---------------------------------------------------------------------------
// The old reader's reads become verdicts (the account pass's tap)
// ---------------------------------------------------------------------------

function passDeps(positionHistory) {
  let positionReads = 0
  return {
    deps: {
      clock: () => NOW, closeSeen: true,
      getDeals: async () => ({ ctidTraderAccountId: DEMO, hasMore: false, deal: [] }),
      getPositionDeals: async (_h, _c, _s, _t, acct, pid) => { positionReads++; return positionHistory(acct, pid) },
    },
    reads: () => positionReads,
  }
}
const passCreds = { ready: true, host: 'demo.ctraderapi.com', accountId: DEMO, clientId: 'c', clientSecret: 's', accessToken: 't' }

test('the old reader re-reading a written-off row with a rejected-only history: verdict never_filled, label "never filled"', async t => {
  const db = fresh(t)
  const id = trade(db, { pid: '353', writtenOff: 1, reason: `${UNRESOLVED_NO_EVIDENCE}: older than the 7-day horizon` })
  const { deps, reads } = passDeps(acct => hist(acct, [rejected(1, 353, 4), rejected(2, 353, 4)]))
  const out = await backfillAccountPnl(db, passCreds, deps)
  assert.equal(reads(), 1, 'one read: the sweep does not read in the same pass')
  assert.equal(out.result.positionHistory.verdict, 'never_filled')
  const ev = evidence(db, DEMO, 353)
  assert.deepEqual([ev.verdict, ev.source, ev.final], ['never_filled', 'old_position_reader', 1])
  const row = db.prepare('SELECT net_pnl, pnl_unresolvable, pnl_unresolvable_reason AS reason FROM trades WHERE id = ?').get(id)
  assert.equal(row.net_pnl, null); assert.equal(row.pnl_unresolvable, 1)
  assert.ok(row.reason.startsWith(`${BROKER_NEVER_FILLED}: re-read`), row.reason)
  assert.match(row.reason, /older than the 7-day horizon/, 'the old reason is kept')
})

test('the old reader filling an unpriced row from its complete history leaves the verdict "filled"', async t => {
  const db = fresh(t)
  const id = trade(db, { pid: '355' })
  const { deps } = passDeps(acct => life(acct, 355, 4200))
  const out = await backfillAccountPnl(db, passCreds, deps)
  assert.equal(out.result.positionHistory.state, 'recovered')
  assert.equal(rowSnap(db, id).net_pnl, 42)
  assert.deepEqual([evidence(db, DEMO, 355).verdict, evidence(db, DEMO, 355).broker_net], ['filled', 42])
})

test('with nothing for the old reader, the pass runs one sweep step; the next pass inside 30 s does not', async t => {
  const db = fresh(t)
  trade(db, { pid: '356', net: 1 })
  const { deps, reads } = passDeps(acct => life(acct, 356, 100))
  const first = await backfillAccountPnl(db, passCreds, deps)
  assert.equal(first.result.lifecycleEvidence.verdict, 'agrees')
  await backfillAccountPnl(db, passCreds, { ...deps, clock: () => NOW + 10_000 })
  assert.equal(reads(), 1)
})
