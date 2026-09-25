// node --test agent/services/pnl-lifecycle-guard.test.js
//
// V3 B1 (P5b-1): realised money needs ONE whole, unique broker lifecycle.
//
// probe-p5bd.mjs reproduced the two money-writer defects on 1b54c1f with
// disposable SQLite: a false close and its re-adoption (two closed, unpriced
// rows on one position) got 150 EACH against a broker lifetime of 150, and a
// re-adopted row whose opening deal and first partial close fell before the
// 14-day window got 50 against 150. Every test below that names a probe case
// or a production shape goes red on the code before this change.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import { backfillClosedPnl, resetBackfillPacing, falseCloseVerdict, FALSE_CLOSE_TOLERANCE_MS, POSITION_LEDGER_IDENTITY } from './pnl-backfill.js'
import { backfillAccountPnl } from './cross-side-pnl.js'
import { recoverOldPositionPnl } from './old-position-pnl.js'
import { lifecycleBalance, verifiedPositionHistory } from '../lib/position-deal-history.js'
import { fullCloseMoney } from '../lib/deal-money.js'
import { persistDeals, shapeDeals, judgeTradesAgainstDeals } from './broker-history-import.js'
import actionsRouter from '../routes/actions.js'
import { upsertAccount } from './account-registry.js'

const NOW = Date.now(), MIN = 60_000, DAY = 86400_000
const iso = ms => new Date(ms).toISOString()
const ACCT = '2'
const creds = { ready: true, host: 'demo.ctraderapi.com', accountId: ACCT, clientId: 'c', clientSecret: 's', accessToken: 't', isLive: false }

function fresh(t) {
  const db = initDB(':memory:')
  resetBackfillPacing()
  t.after(() => { db.close(); resetBackfillPacing() })
  db.prepare("INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES (?, 0, 1, 'active')").run(ACCT)
  setState(db, 'ctrader_account_id', ACCT)
  return db
}
const seed = (db, { opened, closed, pos = '700', status = 'closed', net = null, account = ACCT, id = null }) => Number(db.prepare(
  `INSERT INTO trades (${id == null ? '' : 'id, '}account_id, symbol, side, status, ctrader_position_id, opened_at, closed_at, entry_price, sl_price, volume, net_pnl, close_reason)
   VALUES (${id == null ? '' : '?, '}?, 'X', 'BUY', ?, ?, ?, ?, 100, 90, 1, ?, 'stale reconcile: position not open at the broker')`)
  .run(...(id == null ? [] : [id]), account, status, pos, iso(opened), closed == null ? null : iso(closed), net).lastInsertRowid)
const od = (id, t, vol = 100, pos = 700) => ({ dealId: id, positionId: pos, symbolId: 10, dealStatus: 2, volume: vol, filledVolume: vol, executionPrice: 100, executionTimestamp: t })
const cd = (id, t, gp, vol = 50, pos = 700, extra = {}) => ({ dealId: id, positionId: pos, symbolId: 10, dealStatus: 2, volume: vol, filledVolume: vol, executionPrice: 101, executionTimestamp: t,
  closePositionDetail: { grossProfit: gp, swap: 0, commission: 0, moneyDigits: 2, closedVolume: vol, ...extra } })
const windowOf = deals => async (...a) => {
  // Both shapes: backfillClosedPnl(getDeals(t0, t1)) and backfillAccountPnl's
  // read(host, id, secret, token, account, t0, t1, timeout, 0).
  const [t0, t1] = a.length > 2 ? [a[5], a[6]] : a
  return { ctidTraderAccountId: ACCT, hasMore: false, deal: deals.filter(d => d.executionTimestamp >= t0 && d.executionTimestamp < t1) }
}
const history = deals => async () => ({ ctidTraderAccountId: ACCT, hasMore: false, deal: deals })
const row = (db, id) => db.prepare('SELECT id, status, net_pnl, pnl_attempts, close_reason, pnl_unresolvable FROM trades WHERE id = ?').get(id)
const strictWindow = (db, deals) => backfillClosedPnl(db, creds, { accountId: ACCT, strictAccount: true, now: NOW, getDeals: windowOf(deals) })

// ---------------------------------------------------------------------------
// The lifecycle walk (lib/position-deal-history.js)
// ---------------------------------------------------------------------------

test('lifecycleBalance: whole, tail-only, still-open and unreadable lifecycles', () => {
  const whole = [od(1, 10), cd(2, 20, 100, 40), cd(3, 30, 50, 60)]
  assert.deepEqual(lifecycleBalance(whole, '700'), { opened: 100, closed: 100, hasOpening: true, balanced: true, finalCloseMs: 30, reason: null })
  // The final close is where closed volume REACHES opened volume, not the first closing deal.
  assert.equal(lifecycleBalance([...whole].reverse(), 700).finalCloseMs, 30, 'order-independent')
  const tail = lifecycleBalance([cd(3, 30, 50, 60)], '700')
  assert.equal(tail.balanced, false); assert.equal(tail.reason, 'opening not among the deals')
  const open = lifecycleBalance([od(1, 10), cd(2, 20, 100, 40)], '700')
  assert.equal(open.balanced, false); assert.equal(open.reason, 'position not closed within the deals')
  assert.equal(lifecycleBalance([od(1, 10), { ...cd(2, 20, 1, 100), closePositionDetail: { grossProfit: 1, moneyDigits: 2 } }], '700').reason, 'closing volume unknown')
  assert.equal(lifecycleBalance([{ ...od(1, 10), filledVolume: undefined }, cd(2, 20, 1, 100)], '700').reason, 'opening volume unknown')
  // A deal that did not execute moves no volume; another position is not this one.
  assert.equal(lifecycleBalance([od(1, 10), { ...od(5, 11), dealStatus: 4 }, cd(2, 20, 1, 100), od(9, 12, 100, 701)], '700').balanced, true)
  assert.equal(lifecycleBalance([od(1, 10), cd(2, 20, 1, 100), od(3, 30)], '700').reason, 'deals after the lifecycle closed')
  assert.equal(lifecycleBalance(null, '700').balanced, false)
})

// ---------------------------------------------------------------------------
// probe-p5bd case 1 — a fragment pair is not written; the reader settles it
// ---------------------------------------------------------------------------

function fragmentPair(t) {
  const db = fresh(t)
  const a = seed(db, { opened: NOW - 5 * DAY, closed: NOW - 4 * DAY })   // the false close
  const b = seed(db, { opened: NOW - 3 * DAY, closed: NOW - DAY })       // the re-adoption
  const deals = [od(1, NOW - 5 * DAY), cd(2, NOW - 2 * DAY, 10000), cd(3, NOW - DAY, 5000)]
  return { db, a, b, deals }
}

test('probe-p5bd case 1: a fragment pair is ambiguous on the window path — nothing written, no attempt counted', async t => {
  const { db, a, b, deals } = fragmentPair(t)
  const r = await strictWindow(db, deals)
  assert.equal(r.backfilled, 0, 'the code before B1 wrote 150 on EACH row (ledger 300, broker 150)')
  assert.equal(r.ambiguous, 1)
  assert.deepEqual(r.ambiguousPositions, [{ positionId: '700', rows: [a, b] }])
  assert.deepEqual([row(db, a).net_pnl, row(db, b).net_pnl], [null, null])
  assert.deepEqual([row(db, a).pnl_attempts, row(db, b).pnl_attempts], [null, null], 'the window cannot settle it by construction: not its attempt')
})

test('probe-p5bd case 1, the account pass: the window hands the pair to the reader, which rejects the false close and fills the true row once', async t => {
  const { db, a, b, deals } = fragmentPair(t)
  let clock = NOW
  const reads = []
  const deps = { clock: () => clock, getDeals: windowOf(deals), getPositionDeals: async (...args) => { reads.push(args[5]); return history(deals)() } }
  const first = await backfillAccountPnl(db, creds, deps)
  assert.equal(first.result.ambiguous, 1)
  // The reader took the pair in the SAME pass although both rows opened inside
  // the 14-day window (the handoff). #a is the candidate first: #b claims the
  // position after #a opened, so #a is refused locally — an attempt, no read.
  assert.equal(first.result.positionHistory.tradeId, a)
  assert.equal(first.result.positionHistory.state, 'refused')
  assert.deepEqual(reads, [])
  clock += 16 * MIN
  const second = await backfillAccountPnl(db, creds, deps)
  assert.equal(second.result.positionHistory.tradeId, b)
  assert.equal(second.result.positionHistory.state, 'recovered')
  assert.deepEqual(reads, ['700'])
  assert.equal(row(db, b).net_pnl, 150, 'the lifetime, once')
  assert.equal(row(db, a).net_pnl, null)
  assert.equal(row(db, a).status, 'rejected', 'the false close is marked, not deleted')
  assert.match(row(db, a).close_reason, new RegExp(`^stale reconcile: .* \\| false close: broker position 700 open until ${iso(NOW - DAY)}; lifecycle on #${b}$`))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trades').get().n, 2, 'nothing deleted')
  const ledger = db.prepare("SELECT SUM(net_pnl) s FROM trades WHERE status = 'closed'").get().s
  assert.equal(ledger, 150, 'ledger total equals the broker lifetime')
})

// ---------------------------------------------------------------------------
// probe-p5bd case 2 — a tail-only window defers; the position path fills 150
// ---------------------------------------------------------------------------

test('probe-p5bd case 2: a tail-only window defers the re-adopted row, then the position path fills the lifetime 150', async t => {
  const db = fresh(t)
  const id = seed(db, { opened: NOW - 3 * DAY, closed: NOW - DAY })   // local opened_at = the re-adoption
  const lifetime = [od(1, NOW - 20 * DAY), cd(2, NOW - 16 * DAY, 10000), cd(3, NOW - DAY, 5000)]
  const w = await strictWindow(db, lifetime)
  assert.equal(w.backfilled, 0, 'the code before B1 wrote 50 against a lifetime of 150')
  assert.equal(w.deferred, 1); assert.deepEqual(w.deferredPositions, ['700'])
  assert.equal(row(db, id).net_pnl, null); assert.equal(row(db, id).pnl_attempts, null, 'deferred is not an attempt')
  // Through the account pass: deferred, handed off, read whole, filled.
  resetBackfillPacing()
  const reads = []
  const pass = await backfillAccountPnl(db, creds, { clock: () => NOW, getDeals: windowOf(lifetime),
    getPositionDeals: async (...a) => { reads.push(a[5]); return history(lifetime)() } })
  assert.equal(pass.result.positionHistory.state, 'recovered')
  assert.deepEqual(reads, ['700'])
  assert.equal(row(db, id).net_pnl, 150)
})

test('the window still fills a whole lifecycle it can see, and still counts an attempt on a row with no close in it', async t => {
  const db = fresh(t)
  const whole = seed(db, { opened: NOW - 3 * DAY, closed: NOW - DAY })
  const none = seed(db, { opened: NOW - 3 * DAY, closed: NOW - DAY, pos: '702' })
  const r = await strictWindow(db, [od(1, NOW - 3 * DAY), cd(2, NOW - 2 * DAY, 10000), cd(3, NOW - DAY, 5000)])
  assert.equal(r.backfilled, 1); assert.equal(r.deferred, 0); assert.equal(r.ambiguous, 0)
  assert.equal(row(db, whole).net_pnl, 150)
  assert.equal(row(db, none).pnl_attempts, 1)
})

// ---------------------------------------------------------------------------
// #714 NZDUSD — two partials then a full close: 202.71, not 2.91
// ---------------------------------------------------------------------------

test('the #714 shape: the final deal after two partials writes NULL, and the backfill records 202.71', async t => {
  const db = fresh(t)
  const id = seed(db, { opened: NOW - 2 * DAY, closed: null, status: 'open', pos: '231000714' })
  const deals = [od(1, NOW - 2 * DAY, 300_000, 231000714), cd(2, NOW - 30 * 3600_000, 10027, 100_000, 231000714),
    cd(3, NOW - 20 * 3600_000, 9953, 100_000, 231000714), cd(4, NOW - 3600_000, 291, 100_000, 231000714)]
  // The loop's decision on the final deal: it closed 100,000 of 300,000.
  const { money } = fullCloseMoney(deals[3], { openedVolume: 300_000 })
  assert.equal(money, null, 'the code before B1 stamped 2.91 here, for ever')
  db.prepare(`UPDATE trades SET status = 'closed', closed_at = ? WHERE id = ?`).run(iso(NOW - 3600_000), id)
  const r = await strictWindow(db, deals)
  assert.equal(r.backfilled, 1)
  assert.equal(row(db, id).net_pnl, 202.71)
})

// ---------------------------------------------------------------------------
// AVY — a partial close BEFORE the false close (the checker's correction)
// ---------------------------------------------------------------------------

test('the AVY shape with a partial before the false close: #372 rejected as a false close, #774 filled with the whole lifetime', async t => {
  const db = fresh(t)
  const falseRow = seed(db, { id: 372, opened: NOW - 58 * DAY, closed: NOW - 53 * DAY, pos: '517869182' })
  const trueRow = seed(db, { id: 774, opened: NOW - 51 * DAY, closed: NOW - 4 * DAY, pos: '517869182' })
  // As in production: #372 was written off on the horizon claim, so the live
  // #774 is the reader's first candidate.
  db.prepare("UPDATE trades SET pnl_unresolvable = 1, pnl_unresolvable_reason = 'horizon' WHERE id = 372").run()
  const P = 517869182
  const deals = [od(1, NOW - 58 * DAY, 10, P), cd(2, NOW - 54 * DAY, 50, 4, P), cd(3, NOW - 16 * DAY, 123, 6, P)]
  // A "first closing deal" rule would call #372 genuine: its recorded close
  // (53 d ago) FOLLOWS the first closing deal (the partial, 54 d ago).
  const out = await recoverOldPositionPnl(db, creds, { now: NOW, isCurrent: () => true, getPositionDeals: history(deals) })
  assert.equal(out.tradeId, 774)
  assert.equal(out.state, 'recovered', 'the code before B1 refused: closing deal precedes row #774\'s opening')
  assert.deepEqual(out.result.falseCloses, [372])
  assert.equal(row(db, trueRow).net_pnl, 1.73, 'the partial made while #372 stood is part of the lifecycle')
  assert.equal(row(db, falseRow).status, 'rejected')
  assert.equal(row(db, falseRow).net_pnl, null)
  assert.match(row(db, falseRow).close_reason, new RegExp(`false close: broker position 517869182 open until ${iso(NOW - 16 * DAY)}; lifecycle on #774$`))
  const audit = JSON.parse(db.prepare(`SELECT body FROM action_log WHERE method = 'PNL_FALSE_CLOSE'`).get().body)
  assert.deepEqual([audit.rejected, audit.lifecycleOn, audit.finalCloseAt], [[372], 774, iso(NOW - 16 * DAY)])
})

test('falseCloseVerdict: the final deal decides, with a 120 s tolerance, and only when the target holds the final close', () => {
  const F = NOW
  const target = { opened_at: iso(F - 10 * DAY), closed_at: iso(F + 60_000) }
  const peer = closedMs => ({ id: 1, status: 'closed', net_pnl: null, closed_at: iso(closedMs) })
  assert.deepEqual(falseCloseVerdict({ target, superseded: [peer(F - FALSE_CLOSE_TOLERANCE_MS - 1000)], finalCloseMs: F }).falseCloses.map(f => f.id), [1])
  assert.equal(falseCloseVerdict({ target, superseded: [peer(F - FALSE_CLOSE_TOLERANCE_MS)], finalCloseMs: F }), null, 'inside the tolerance: not proven')
  assert.equal(falseCloseVerdict({ target, superseded: [{ ...peer(F - DAY), net_pnl: 5 }], finalCloseMs: F }), null, 'a money-bearing fragment is never decided here')
  assert.equal(falseCloseVerdict({ target: { ...target, closed_at: iso(F - DAY) }, superseded: [peer(F - 2 * DAY)], finalCloseMs: F }), null,
    'a target that closed before the lifecycle ended does not hold it')
  assert.equal(falseCloseVerdict({ target: { ...target, opened_at: iso(F + DAY) }, superseded: [], finalCloseMs: F }), null,
    'a target opened after the final close does not hold it')
  assert.equal(falseCloseVerdict({ target, superseded: [peer(F - DAY)], finalCloseMs: NaN }), null, 'no balanced lifecycle, no verdict')
})

// ---------------------------------------------------------------------------
// DOGEUSD — a money-bearing fragment gets a verdict only
// ---------------------------------------------------------------------------

test('the DOGEUSD shape (money-bearing fragment): verdicts only, every row snapshot unchanged', async t => {
  const db = fresh(t)
  const P = 238111184
  const first = seed(db, { id: 1309, opened: NOW - 6 * DAY, closed: NOW - 5 * DAY, pos: String(P), net: 0.01 })
  const second = seed(db, { id: 1310, opened: NOW - 5 * DAY, closed: NOW - DAY, pos: String(P), net: 0 })
  const snapshot = () => db.prepare('SELECT * FROM trades ORDER BY id').all()
  const before = snapshot()
  const deals = [od(1, NOW - 6 * DAY, 100, P), cd(2, NOW - 2 * DAY, 1, 50, P), cd(3, NOW - DAY, -1, 50, P)]
  const w = await strictWindow(db, deals)
  assert.equal(w.ambiguous, 1)
  let reads = 0
  const read = async () => { reads++; return history(deals)() }
  await assert.rejects(backfillClosedPnl(db, creds, { accountId: ACCT, positionId: String(P), strictAccount: true, now: NOW, getPositionDeals: read }),
    e => e.code === POSITION_LEDGER_IDENTITY && /count=2/.test(e.message))
  for (const tradeId of [first, second]) {
    await assert.rejects(backfillClosedPnl(db, creds, { accountId: ACCT, positionId: String(P), tradeId, strictAccount: true, now: NOW, getPositionDeals: read }),
      e => e.code === POSITION_LEDGER_IDENTITY && /already carries P&L|already booked/.test(e.message))
  }
  assert.equal(reads, 0, 'decided locally: a money correction is owner-gated (B5)')
  assert.deepEqual(snapshot(), before)
})

// ---------------------------------------------------------------------------
// A closed row plus its rejected twin, on the STRICT POSITION path
// ---------------------------------------------------------------------------

test('a closed row plus a rejected twin settles through the strict position path', async t => {
  const db = fresh(t)
  const closed = seed(db, { opened: NOW - 30 * DAY, closed: NOW - 20 * DAY })
  const twin = seed(db, { opened: NOW - 30 * DAY, closed: null, status: 'rejected' })
  const r = await backfillClosedPnl(db, creds, { accountId: ACCT, positionId: '700', strictAccount: true, now: NOW,
    getPositionDeals: history([od(1, NOW - 30 * DAY), cd(2, NOW - 20 * DAY, 4200, 100)]) })
  assert.equal(r.backfilled, 1, 'the code before B1 refused: count=2 with the rejected twin counted')
  assert.equal(r.filledRowId, closed)
  assert.equal(row(db, closed).net_pnl, 42)
  assert.equal(row(db, twin).status, 'rejected'); assert.equal(row(db, twin).net_pnl, null)
})

// ---------------------------------------------------------------------------
// pnlConversionFee — one treatment on both paths
// ---------------------------------------------------------------------------

test('pnlConversionFee: excluded from net on the window path and the position path alike; an unreadable fee still refuses', async t => {
  const fee = { pnlConversionFee: -7 }
  const deals = [od(1, NOW - 3 * DAY), cd(2, NOW - DAY, 4200, 100, 700, fee)]
  const a = fresh(t)
  const wid = seed(a, { opened: NOW - 3 * DAY, closed: NOW - DAY })
  await strictWindow(a, deals)
  const b = fresh(t)
  const pid = seed(b, { opened: NOW - 30 * DAY, closed: NOW - DAY })
  await backfillClosedPnl(b, creds, { accountId: ACCT, positionId: '700', strictAccount: true, now: NOW, getPositionDeals: history(deals) })
  assert.deepEqual([row(a, wid).net_pnl, row(b, pid).net_pnl], [42, 42])
  assert.throws(() => verifiedPositionHistory({ ctidTraderAccountId: ACCT, hasMore: false, deal: [od(1, 1), cd(2, 2, 1, 100, 700, { pnlConversionFee: 'x' })] },
    { accountId: ACCT, positionId: '700', now: NOW }), /closing money or volume unsupported/)
})

// ---------------------------------------------------------------------------
// Rules versioning: rows judged before the lifecycle rules get one more read
// ---------------------------------------------------------------------------

test('a written-off row remembered under the old rules is read once more under the lifecycle rules, then not again', async t => {
  const db = fresh(t)
  const id = seed(db, { opened: NOW - 60 * DAY, closed: NOW - 50 * DAY })
  db.prepare("UPDATE trades SET pnl_unresolvable = 1, pnl_unresolvable_reason = 'old' WHERE id = ?").run(id)
  setState(db, `position_pnl_reread:${ACCT}`, JSON.stringify({ [id]: { at: iso(NOW - DAY), outcome: 'refused' } }))
  let reads = 0
  const read = async () => { reads++; return { ctidTraderAccountId: ACCT, hasMore: false } }
  const first = await recoverOldPositionPnl(db, creds, { now: NOW, isCurrent: () => true, getPositionDeals: read })
  assert.equal(first.state, 'no_matching_close'); assert.equal(reads, 1)
  assert.equal(JSON.parse(getState(db, `position_pnl_reread:${ACCT}`))[id].rule, 2)
  const second = await recoverOldPositionPnl(db, creds, { now: NOW + 16 * MIN, isCurrent: () => true, getPositionDeals: read })
  assert.equal(second.state, 'no_old_gap'); assert.equal(reads, 1)
})

// ---------------------------------------------------------------------------
// The Desk route is display-only
// ---------------------------------------------------------------------------

async function serve(t, transport) {
  const db = initDB(':memory:')
  const token = 'sess_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  setState(db, 'device_sessions', JSON.stringify({ [token]: Date.now() + 60_000 }))
  setState(db, 'ctrader_account_id', '22')
  setState(db, 'ctrader_access_token', 'test-access')
  for (const key of ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET']) {
    const previous = process.env[key]; process.env[key] = 'test-only'
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  upsertAccount(db, { accountId: '22', isLive: false })
  const app = express(); app.use(express.json())
  app.use('/actions', actionsRouter(db, { brokerHistoryTransport: transport }))
  const server = app.listen(0)
  t.after(() => { server.close(); db.close() })
  const post = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    return { status: r.status, data: await r.json() }
  }
  return { db, post }
}
const transport = pages => ({
  wsGetDeals: async () => pages.shift() ?? { deal: [] },
  wsSymbolsByIds: async () => ({ symbol: [{ symbolId: 10, lotSize: 100 }] }),
  wsGetSymbolsList: async () => ({ symbol: [{ symbolId: 10, symbolName: 'X' }] }),
  wsGetTrader: async () => ({}), wsGetAssets: async () => ({ asset: [] }),
})

test('POST /actions/broker-history leaves trades money unchanged — its own row, an unattributed row and a written-off row', async t => {
  const closing = { ...cd(9, Date.now() - MIN, 4200, 100), positionId: '7', tradeSide: 2 }
  const { db, post } = await serve(t, transport([{ deal: [closing] }]))
  const ins = db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id, pnl_unresolvable) VALUES ('X', 'BUY', 'closed', ?, '7', ?)`)
  ins.run('22', 0); ins.run(null, 0); ins.run('22', 1)
  const before = db.prepare('SELECT * FROM trades ORDER BY id').all()
  const r = await post('/actions/broker-history', { accountId: '22', days: 1 })
  assert.equal(r.status, 200)
  assert.equal(r.data.rows[0].netPnl, 42, 'the display is the broker\'s deal')
  assert.equal(r.data.complete, true)
  assert.equal('backfilled' in r.data, false)
  assert.deepEqual(db.prepare('SELECT * FROM trades ORDER BY id').all(), before,
    'the code before B1 wrote 42 onto the account row and claimed the unattributed one')
})

test('POST /actions/broker-history says when its walk did not finish', async t => {
  const closing = { ...cd(9, Date.now() - MIN, 4200, 100), positionId: '7', tradeSide: 2 }
  // A page that says hasMore without moving: the walk stops and says so.
  const { post } = await serve(t, transport([{ deal: [closing], hasMore: true }, { deal: [closing], hasMore: true }]))
  const r = await post('/actions/broker-history', { accountId: '22', days: 1 })
  assert.equal(r.status, 200)
  assert.equal(r.data.complete, false)
  assert.equal(r.data.incompleteReason, 'stalled_with_has_more')
})

// ---------------------------------------------------------------------------
// /reconcile-trades rejects nothing from an incomplete walk
// ---------------------------------------------------------------------------

test('judgeTradesAgainstDeals rejects an in-flight row only when the deal walk finished', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (id, symbol, side, status, opened_at) VALUES (1, 'EURUSD', 'BUY', 'submitting', '2026-09-01 10:00:00')`).run()
  const rows = () => db.prepare('SELECT * FROM trades').all()
  const partial = judgeTradesAgainstDeals(db, { rows: rows(), deals: [], symbolMap: {}, complete: false })
  assert.equal(partial.rejected, 0); assert.equal(partial.unmatchedInFlight, 1)
  assert.equal(db.prepare('SELECT status FROM trades WHERE id = 1').get().status, 'submitting')
  assert.equal(judgeTradesAgainstDeals(db, { rows: rows(), deals: [], symbolMap: {} }).rejected, 0, 'completeness is never assumed')
  assert.equal(judgeTradesAgainstDeals(db, { rows: rows(), deals: [], symbolMap: {}, complete: true }).rejected, 1)
})

// ---------------------------------------------------------------------------
// Receipts: lots kept on re-import; links to the one row that holds a position
// ---------------------------------------------------------------------------

test('a re-import that lacks lots, the gross/swap split or the symbol name keeps what is stored', () => {
  const db = initDB(':memory:')
  const d = { ...cd(900, Date.parse('2026-09-01T10:00:00Z'), 4200, 100), tradeSide: 2, closePositionDetail: { grossProfit: 4200, swap: -30, commission: -10, moneyDigits: 2, closedVolume: 100 } }
  persistDeals(db, shapeDeals([d], { 10: { symbolName: 'NZDUSD', lotSize: 200 } }, ACCT))
  const stored = () => db.prepare(`SELECT symbol, lots, gross_pnl, swap, commission, net_pnl FROM broker_deals WHERE deal_id = '900'`).get()
  assert.deepEqual(stored(), { symbol: 'NZDUSD', lots: 0.5, gross_pnl: 42, swap: -0.3, commission: -0.1, net_pnl: 41.6 })
  // The loop's receipt path: no lot size, no symbol name.
  persistDeals(db, shapeDeals([d], {}, ACCT))
  assert.deepEqual(stored(), { symbol: 'NZDUSD', lots: 0.5, gross_pnl: 42, swap: -0.3, commission: -0.1, net_pnl: 41.6 },
    'the code before B1 set lots NULL and the symbol to #10')
  // The statement seed: net only.
  persistDeals(db, [{ deal_id: '900', position_id: '700', account_id: ACCT, symbol: null, side: null, lots: null, entry_price: null,
    close_price: null, opened_at: null, closed_at: null, gross_pnl: null, swap: null, commission: null, net_pnl: 41.6 }])
  assert.deepEqual(stored(), { symbol: 'NZDUSD', lots: 0.5, gross_pnl: 42, swap: -0.3, commission: -0.1, net_pnl: 41.6 })
  // A value the re-read DOES carry still refreshes the row.
  persistDeals(db, shapeDeals([{ ...d, closePositionDetail: { ...d.closePositionDetail, swap: -40 } }], {}, ACCT))
  assert.equal(stored().swap, -0.4)
})

test('a receipt links to the one row that can hold its position: a rejected twin does not count, a float-formatted id matches', () => {
  const db = initDB(':memory:')
  const closed = Number(db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id) VALUES ('X', 'BUY', 'closed', ?, '1618')`).run(ACCT).lastInsertRowid)
  db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id) VALUES ('X', 'BUY', 'rejected', ?, '1618')`).run(ACCT)
  const floaty = Number(db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id) VALUES ('X', 'BUY', 'closed', ?, '1619.0')`).run(ACCT).lastInsertRowid)
  const deals = [{ ...cd(1, 1, 2400, 100, 1618), tradeSide: 2 }, { ...cd(2, 2, 100, 100, 1619), tradeSide: 2 }]
  const out = persistDeals(db, shapeDeals(deals, {}, ACCT))
  assert.equal(out.matchedToLocalTrades, 2, 'the code before B1 linked neither')
  const link = id => db.prepare('SELECT matched_trade_id m FROM broker_deals WHERE deal_id = ?').get(id).m
  assert.deepEqual([link('1'), link('2')], [closed, floaty])
  // Two rows that CAN hold the position: still no link.
  db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id) VALUES ('X', 'BUY', 'closed', ?, '1618')`).run(ACCT)
  persistDeals(db, shapeDeals(deals, {}, ACCT))
  assert.equal(link('1'), null)
})

// ---------------------------------------------------------------------------
// The loop's FULL_EXIT uses the decision (no injection point for the broker
// close: the wiring is pinned, comments stripped — failure mode #2)
// ---------------------------------------------------------------------------

test('loop.js FULL_EXIT takes its money from lib/deal-money.js, never from the one deal\'s own arithmetic', () => {
  const loop = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const start = loop.indexOf("if (action === 'FULL_EXIT') {")
  const block = loop.slice(start, loop.indexOf("if (action === 'PARTIAL_EXIT') {", start))
  assert.ok(start > 0 && block.length > 0)
  assert.match(block, /const heldVolume = volumeUnits\n/)
  assert.match(block, /openedVolumeOnRecord\(db, \{ accountId, positionId: ctx\.positionId, tradeId: pos\.trade_id \?\? null,\s+monitoredId: pos\.id \?\? null, heldVolume \}\)/)
  assert.match(block, /fullCloseMoney\(res\.deal, \{ openedVolume \}\)/)
  assert.match(block, /closeTradeRow\(db, pos\.trade_id, \{ exitPrice: closePrice, closeReason: eval_\.reason \|\| 'position_manager', grossPnl, netPnl \}\)/)
  assert.doesNotMatch(block, /grossProfit|Math\.abs\(cpd|\/ 100/, 'no money arithmetic left in the loop')
  // heldVolume is captured from the snapshot BEFORE the ledger-lots fallback overwrites volumeUnits.
  assert.ok(block.indexOf('const heldVolume = volumeUnits') < block.indexOf('volumeUnits = Math.round('))
})
