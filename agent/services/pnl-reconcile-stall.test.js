// V3 I1 — one un-reconcilable trade must never stall the P&L repair.
//
// Production 25-09-2026 13:43Z, GET /state/heartbeats: pnl_reconcile status
// 'error', 1,776 consecutive failures, last ok 2026-09-21T15:11:26Z, error
// "2 closed trade(s) with no realised P&L have never been attempted". The two
// rows (GET /state/trades?account=42993489):
//   #774 AVY.US pos 517869182, opened 08-05, closed 09-21, net NULL, attempts NULL
//   #775 GEV.US pos 299683664, opened 08-05, closed 09-21, net NULL, attempts NULL
// and the ledger ALSO holds each position as an older row, written off on
// 09-02 with 77 attempts: #372 AVY.US and #373 GEV.US (a "stale reconcile"
// close on 08-03 while the broker still held the positions). broker_deals
// holds the AVY close: deal 336389481, closed 09-09 13:32:38, net 1.23,
// linked #774. Every pass reached #774/#775, backfillClosedPnl refused the
// duplicate identity, and old-position-pnl.js swallowed the refusal as
// 'failed' without counting an attempt.
//
// The first test uses only functions that exist on main before this change,
// so running it against main's code shows the stall (it goes red there).
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState } from '../db.js'
import { recoverOldPositionPnl } from './old-position-pnl.js'
import { pnlReconciliationState } from './pnl-backfill.js'

const NOW = Date.now(), MIN = 60_000, DAY = 86400_000
const ACCT = '42993489'
const creds = { ready: true, host: 'demo.ctraderapi.com', accountId: ACCT }
const sql = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
const LEGACY = 'no broker deal history for this close: closed 2026-08-03 02:24:51, older than the 7-day deal-history horizon, and pnl-backfill has exhausted its retries on account 42993489'

function productionShape(t) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  const ins = db.prepare(`INSERT INTO trades (id, account_id, symbol, side, status, ctrader_position_id, opened_at, closed_at,
    entry_price, exit_price, volume, source, close_reason, net_pnl, pnl_attempts, pnl_last_attempt_at,
    pnl_unresolvable, pnl_unresolvable_reason, pnl_unresolvable_at)
    VALUES (?, ?, ?, 'BUY', 'closed', ?, ?, ?, ?, ?, 0.1, 'external', ?, NULL, ?, ?, ?, ?, ?)`)
  // The two written-off originals (false reconcile close, 53 days ago).
  for (const [id, sym, pos, entry] of [[372, 'AVY.US', '517869182', 155.68], [373, 'GEV.US', '299683664', 786]]) {
    ins.run(id, ACCT, sym, pos, sql(NOW - 58 * DAY), sql(NOW - 53 * DAY), entry, null,
      'stale reconcile: position not open at the broker (orphaned open row, never reconciled)',
      77, new Date(NOW - 51 * DAY).toISOString(), 1, LEGACY, sql(NOW - 23 * DAY))
  }
  // The two live re-adoptions, closed four days ago, never priced.
  for (const [id, sym, pos, entry, exit] of [[774, 'AVY.US', '517869182', 155.68, 166.98], [775, 'GEV.US', '299683664', 786, null]]) {
    ins.run(id, ACCT, sym, pos, sql(NOW - 51 * DAY), sql(NOW - 4 * DAY), entry, exit,
      'closed at the broker (manual close or broker-side SL/TP fill) — not closed by the bot',
      null, null, 0, null, null)
  }
  db.prepare(`INSERT INTO broker_deals (deal_id, position_id, account_id, symbol, side, entry_price, close_price, closed_at,
    gross_pnl, swap, commission, net_pnl, matched_trade_id) VALUES ('336389481','517869182',?,'AVY.US','BUY',155.68,166.98,?,1.43,-0.14,-0.06,1.23,774)`)
    .run(ACCT, sql(NOW - 16 * DAY))
  return db
}

// The broker's complete position histories: AVY closed 16 days ago for net
// 1.23 (the same money as the local deal); GEV has nothing on file.
function brokerHistory(positionId) {
  if (positionId === '517869182') {
    const common = { positionId, symbolId: 10, dealStatus: 2, filledVolume: 10, volume: 10 }
    return { ctidTraderAccountId: ACCT, hasMore: false, deal: [
      { ...common, dealId: '335000001', executionTimestamp: NOW - 58 * DAY, executionPrice: 155.68 },
      { ...common, dealId: '336389481', executionTimestamp: NOW - 16 * DAY, executionPrice: 166.98,
        closePositionDetail: { grossProfit: 143, swap: -14, commission: -6, moneyDigits: 2, closedVolume: 10 } },
    ] }
  }
  return { ctidTraderAccountId: ACCT, hasMore: false }
}

const trade = (db, id) => db.prepare(`SELECT id, net_pnl, pnl_attempts, pnl_unresolvable, pnl_unresolvable_reason
  FROM trades WHERE id = ?`).get(id)
// STK-05's population: unpriced closes nothing has written off.
const stillStuck = db => db.prepare(`SELECT id FROM trades WHERE status = 'closed' AND net_pnl IS NULL
  AND COALESCE(pnl_unresolvable, 0) = 0 ORDER BY id`).all().map(r => r.id)

test('the production shape (#372/#774 AVY.US, #373/#775 GEV.US) no longer stalls: every row reaches a terminal state and the pass moves on', async t => {
  const db = productionShape(t)
  assert.deepEqual(stillStuck(db), [774, 775], 'fixture: the two rows production reports')
  assert.equal(pnlReconciliationState(db).neverTriedOverdue, 2, 'fixture: the heartbeat\'s "never been attempted" count')

  const reads = [], states = []
  for (let pass = 0; pass < 12; pass++) {
    const out = await recoverOldPositionPnl(db, creds, { now: NOW + pass * 16 * MIN, isCurrent: () => true,
      getPositionDeals: async p => { reads.push(p); return brokerHistory(p) } })
    states.push(out.state)
  }
  // #774 settled from the broker's complete position history, and only #774:
  // the written-off original on the same position is not given the money too.
  assert.equal(trade(db, 774).net_pnl, 1.23)
  assert.equal(trade(db, 372).net_pnl, null, 'the position\'s money lands on ONE row')
  // #775: the broker has no close on file; bounded attempts, then terminal,
  // excluded from money (net_pnl NULL) and still in the ledger.
  const gev = trade(db, 775)
  assert.equal(gev.net_pnl, null)
  assert.equal(gev.pnl_unresolvable, 1)
  assert.equal(gev.pnl_attempts, 6)
  assert.match(gev.pnl_unresolvable_reason, /^unresolved: no broker evidence: .*holds no closing deal/)
  // Nothing is still stuck, nothing is "never attempted", nothing was deleted.
  assert.deepEqual(stillStuck(db), [])
  assert.equal(pnlReconciliationState(db).neverTriedOverdue, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trades').get().n, 4)
  // The pass moved on: it finished the live rows, re-read each written-off
  // original once, and then had nothing left to do.
  assert.equal(states.at(-1), 'no_old_gap')
  assert.equal(reads.filter(p => p === '299683664').length, 6, 'GEV read exactly the bounded number of times')
  // The written-off originals kept their write-off, with the reason corrected
  // to the evidence (R4) and the old reason preserved.
  for (const id of [372, 373]) {
    const r = trade(db, id)
    assert.equal(r.pnl_unresolvable, 1)
    assert.match(r.pnl_unresolvable_reason, /^unresolved: no broker evidence: re-read /)
    assert.match(r.pnl_unresolvable_reason, /duplicate-row decision is left to an operator/)
    assert.ok(r.pnl_unresolvable_reason.includes('older than the 7-day deal-history horizon'), 'the original reason is kept, not erased')
  }
  assert.match(trade(db, 372).pnl_unresolvable_reason, /already booked on #774/)
  // The local deal is named as evidence. Its old link to #774 is gone: the
  // settling read re-persisted the deal, and persistDeals (unchanged) refuses
  // to link an account+position the ledger holds twice.
  assert.match(trade(db, 372).pnl_unresolvable_reason, /local closing deal\(s\): 336389481 net 1\.23;/)
  assert.equal(db.prepare(`SELECT matched_trade_id m FROM broker_deals WHERE deal_id = '336389481'`).get().m, null)
  assert.equal(trade(db, 373).pnl_attempts, 78, 'the GEV attempts stamped #775 only; #373 gained its one re-read')
})

// ---------------------------------------------------------------------------
// The branch's own contracts, beyond the production shape.
// ---------------------------------------------------------------------------
// Namespace reads, not named imports: the file must still LOAD against code
// that predates these exports, so the production-shape test above can be run
// on main and seen to fail on the stall itself rather than on a missing name.
import { readFileSync } from 'node:fs'
const backfillModule = await import('./pnl-backfill.js')
const { pnlReconcileHeartbeat, backfillClosedPnl, POSITION_LEDGER_IDENTITY } = backfillModule
const { OLD_POSITION_MAX_ATTEMPTS } = await import('./old-position-pnl.js')
const { sweepUnresolvable, UNRESOLVED_NO_EVIDENCE } = await import('./mark-unresolvable.js')

function twoLiveRows(t) {
  const db = productionShape(t)
  // Make #372 a true duplicate of #774 (same lifetime, live): two closes
  // claim the AVY position and nothing says which one the broker's close
  // belongs to. The first write-off must not then hand the money to the other.
  db.prepare(`UPDATE trades SET pnl_unresolvable = 0, pnl_unresolvable_reason = NULL, pnl_attempts = 0,
    opened_at = (SELECT opened_at FROM trades WHERE id = 774), closed_at = (SELECT closed_at FROM trades WHERE id = 774) WHERE id = 372`).run()
  db.prepare("UPDATE trades SET status = 'rejected' WHERE id IN (373, 775)").run()
  return db
}

test('two live rows on one position: each refusal is an attempt, both end terminal with the ambiguity as evidence, the broker is never read', async t => {
  const db = twoLiveRows(t)
  let reads = 0
  const states = []
  for (let pass = 0; pass < 2 * OLD_POSITION_MAX_ATTEMPTS + 2; pass++) {
    const out = await recoverOldPositionPnl(db, creds, { now: NOW + pass * 16 * MIN, isCurrent: () => true,
      getPositionDeals: async p => { reads++; return brokerHistory(p) } })
    states.push(out.state)
  }
  assert.equal(reads, 0, 'the refusal is decided locally, before any broker read')
  for (const id of [372, 774]) {
    const r = trade(db, id)
    assert.equal(r.net_pnl, null, 'no guess: neither row is given the position\'s money')
    assert.equal(r.pnl_unresolvable, 1)
    assert.equal(r.pnl_attempts, OLD_POSITION_MAX_ATTEMPTS)
    assert.match(r.pnl_unresolvable_reason, /^unresolved: no broker evidence: ledger identity ambiguous for position 517869182/)
    assert.match(r.pnl_unresolvable_reason, /other claimant\(s\) #(372|774):closed/)
    assert.match(r.pnl_unresolvable_reason, /local closing deal\(s\): 336389481 net 1\.23/)
  }
  assert.equal(states.at(-1), 'no_old_gap')
  const audit = db.prepare(`SELECT body FROM action_log WHERE method = 'PNL_UNRESOLVABLE' AND path = '/old-position-pnl'`).all()
  assert.deepEqual(audit.map(a => JSON.parse(a.body).ids[0]).sort(), [372, 774])
})

test('row-scoped settlement never books a position twice, never pays an earlier record over a later claimant, and needs the close inside the row\'s lifetime', async t => {
  const db = productionShape(t)
  const read = async p => brokerHistory(p)
  const scoped = tradeId => backfillClosedPnl(db, creds, { accountId: ACCT, positionId: '517869182', tradeId,
    strictAccount: true, now: NOW, isCurrent: () => true, getPositionDeals: read })
  await assert.rejects(scoped(372), e => e.code === POSITION_LEDGER_IDENTITY && /other claimant\(s\) #774:closed/.test(e.message))
  assert.equal((await scoped(774)).backfilled, 1)
  await assert.rejects(scoped(372), e => e.code === POSITION_LEDGER_IDENTITY && /already booked on #774/.test(e.message))
  await assert.rejects(scoped(774), /already carries P&L/)
  assert.deepEqual([trade(db, 372).net_pnl, trade(db, 774).net_pnl], [null, 1.23])
  // The broker closed GEV before #775 opened: that money may be #373's.
  const early = { ctidTraderAccountId: ACCT, hasMore: false, deal: brokerHistory('517869182').deal.map((d, i) => ({ ...d,
    positionId: '299683664', executionTimestamp: NOW - (i ? 52 : 58) * DAY })) }
  await assert.rejects(backfillClosedPnl(db, creds, { accountId: ACCT, positionId: '299683664', tradeId: 775,
    strictAccount: true, now: NOW, getPositionDeals: async () => early }),
  e => e.code === POSITION_LEDGER_IDENTITY && /closing deal 336389481 precedes row #775's opening/.test(e.message))
  assert.equal(trade(db, 775).net_pnl, null)
  // An open sibling claims the position too.
  db.prepare("UPDATE trades SET status = 'open' WHERE id = 373").run()
  await assert.rejects(backfillClosedPnl(db, creds, { accountId: ACCT, positionId: '299683664', tradeId: 775,
    strictAccount: true, now: NOW, getPositionDeals: read }), /other claimant\(s\) #373:open/)
})

test('R4: a row written off under the old horizon claim is re-read once; settled when the broker has the close', async t => {
  const db = productionShape(t)
  // A single-row written-off position the per-position reader can settle.
  db.prepare(`INSERT INTO trades (id, account_id, symbol, side, status, ctrader_position_id, opened_at, closed_at, entry_price, volume,
    net_pnl, pnl_attempts, pnl_unresolvable, pnl_unresolvable_reason, pnl_unresolvable_at)
    VALUES (9, ?, 'BTCUSD', 'BUY', 'closed', '700', ?, ?, 155.68, 1, NULL, 15718, 1, ?, ?)`)
    .run(ACCT, sql(NOW - 70 * DAY), sql(NOW - 69 * DAY), LEGACY, sql(NOW - 23 * DAY))
  db.prepare("UPDATE trades SET status = 'rejected' WHERE id IN (372, 373, 774, 775)").run()
  const history = p => p === '700'
    ? { ...brokerHistory('517869182'), deal: brokerHistory('517869182').deal.map(d => ({ ...d, positionId: '700' })) }
    : brokerHistory(p)
  let reads = 0
  const pass = n => recoverOldPositionPnl(db, creds, { now: NOW + n * 16 * MIN, isCurrent: () => true,
    getPositionDeals: async p => { reads++; return history(p) } })
  assert.equal((await pass(0)).state, 'recovered')
  const r = db.prepare('SELECT net_pnl, pnl_unresolvable, pnl_unresolvable_reason FROM trades WHERE id = 9').get()
  assert.equal(r.net_pnl, 1.23)
  assert.equal(r.pnl_unresolvable, 0, 'money landed: the write-off no longer describes the row')
  assert.match(r.pnl_unresolvable_reason, /^settled from the broker's complete position history .*had been written off .*deal-history horizon/)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM action_log WHERE method = 'PNL_WRITE_OFF_SETTLED'`).get().n, 1)
  assert.equal((await pass(1)).state, 'no_old_gap')
  assert.equal(reads, 1)
})

test('R4: an unsettleable re-read is remembered, so a written-off row is read once, not every pass', async t => {
  const db = productionShape(t)
  db.prepare("UPDATE trades SET status = 'rejected' WHERE id IN (372, 774, 775)").run()
  let reads = 0
  const states = []
  for (let n = 0; n < 4; n++) {
    states.push((await recoverOldPositionPnl(db, creds, { now: NOW + n * 16 * MIN, isCurrent: () => true,
      getPositionDeals: async p => { reads++; return brokerHistory(p) } })).state)
  }
  assert.deepEqual(states, ['no_matching_close', 'no_old_gap', 'no_old_gap', 'no_old_gap'])
  assert.equal(reads, 1)
  const r = trade(db, 373)
  assert.equal(r.pnl_unresolvable, 1)
  assert.match(r.pnl_unresolvable_reason, /^unresolved: no broker evidence: re-read .*holds no closing deal.*written off .* as: no broker deal history/)
  assert.equal(JSON.parse(getState(db, `position_pnl_reread:${ACCT}`))['373'].outcome, 'no_matching_close')
})

test('a broker history that arrives and cannot be settled is an attempt; a read that fails is not', async t => {
  const db = productionShape(t)
  // #774 alone on its position (no duplicate), GEV out of the way.
  db.prepare("UPDATE trades SET ctrader_position_id = '9517869182' WHERE id = 372").run()
  db.prepare("UPDATE trades SET status = 'rejected' WHERE id IN (373, 775)").run()
  const unsupported = () => {
    const h = brokerHistory('517869182'); h.deal[1].closePositionDetail.pnlConversionFee = 5; return h
  }
  const pass = (n, reader) => recoverOldPositionPnl(db, creds, { now: NOW + n * 16 * MIN, isCurrent: () => true, getPositionDeals: reader })
  const failed = await pass(0, async () => { throw new Error('broker unavailable') })
  assert.equal(failed.state, 'failed'); assert.equal(trade(db, 774).pnl_attempts, null)
  const envelope = await pass(1, async () => ({ ctidTraderAccountId: ACCT, hasMore: true }))
  assert.equal(envelope.state, 'failed', 'a partial page is not evidence about the position')
  assert.equal(trade(db, 774).pnl_attempts, null)
  const refused = await pass(2, async () => unsupported())
  assert.equal(refused.state, 'refused'); assert.match(refused.reason, /closing money or volume unsupported/)
  assert.equal(trade(db, 774).pnl_attempts, 1)
  for (let n = 3; n < 2 + OLD_POSITION_MAX_ATTEMPTS; n++) await pass(n, async () => unsupported())
  const r = trade(db, 774)
  assert.equal(r.pnl_attempts, OLD_POSITION_MAX_ATTEMPTS)
  assert.equal(r.net_pnl, null); assert.equal(r.pnl_unresolvable, 1)
  assert.match(r.pnl_unresolvable_reason, /^unresolved: no broker evidence: the broker's position history .* was refused: position closing money or volume unsupported/)
})

test('the heartbeat is decided by the pass: ok while the pass completes, error only when it fails', () => {
  const st = { unresolved: 2, oldestClosedAt: '2026-09-21 14:57:15', maxAttempts: 0, neverTried: 2, neverTriedOverdue: 2 }
  const done = pnlReconcileHeartbeat(st, { attempted: 3, completed: 3, skipped: 4 })
  assert.equal(done.ok, true); assert.equal(done.error, null)
  assert.match(done.detail.notice, /^2 closed trade\(s\) .* not yet attempted .* not a controller failure/)
  assert.doesNotMatch(JSON.stringify(done), /have never been attempted/)
  assert.deepEqual(done.detail.pass, { attempted: 3, completed: 3, skipped: 4, failed: [] })
  const partial = pnlReconcileHeartbeat({ ...st, neverTriedOverdue: 0 }, { attempted: 2, completed: 1, failures: [{ accountId: '1', error: 'timeout' }] })
  assert.equal(partial.ok, true); assert.equal(partial.detail.notice, undefined)
  assert.deepEqual(partial.detail.pass.failed, [{ accountId: '1', error: 'timeout' }])
  const nothingDue = pnlReconcileHeartbeat(st, { attempted: 0, completed: 0, skipped: 7 })
  assert.equal(nothingDue.ok, true)
  const failedPass = pnlReconcileHeartbeat(st, { attempted: 2, completed: 0,
    failures: [{ accountId: '1', error: 'backfill deadline elapsed' }, { accountId: '2', error: 'x'.repeat(400) }] })
  assert.equal(failedPass.ok, false)
  assert.match(failedPass.error, /^the P&L repair pass failed on every account it tried \(2\/2\): 1: backfill deadline elapsed/)
  assert.ok(failedPass.detail.pass.failed[1].error.length <= 160)
  const unreadable = pnlReconcileHeartbeat({ unresolved: -1, error: true }, { attempted: 1, completed: 1 })
  assert.equal(unreadable.ok, false); assert.equal(unreadable.error, 'pnl reconciliation state could not be read')
  assert.equal(pnlReconcileHeartbeat(null, {}).ok, false)
})

test('loop wiring: pnl_reconcile beats the pass verdict, counting completed and failed accounts (source pin, comments stripped)', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  const start = src.indexOf('let completedAccts = 0')
  const block = src.slice(start, src.indexOf("hb.beat(db, 'pnl_reconcile', verdict)") + 40)
  assert.ok(start > 0 && block.length < 6000, 'the counters and the beat live in the same pass')
  assert.match(block, /const bf = recovered\.result\s+completedAccts\+\+/)
  assert.match(block, /catch \(e\) \{\s+failedAccts\.push\(\{ accountId: acct, error: e\.message \}\)/)
  assert.match(block, /pnlReconcileHeartbeat\(st, \{\s+attempted: targets\.length - skipped, completed: completedAccts, skipped, failures: failedAccts,/)
  assert.match(block, /hb\.beat\(db, 'pnl_reconcile', verdict\)/)
  assert.doesNotMatch(src, /have never been attempted/, 'the false text is gone from the beat')
})

test('the write-off sweep no longer cites a deal-history horizon: it states the owner wording and the row\'s own attempts', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (id, account_id, symbol, side, status, closed_at, net_pnl, pnl_attempts)
    VALUES (1, 'A', 'X', 'BUY', 'closed', datetime('now', '-9 days'), NULL, 7)`).run()
  const out = sweepUnresolvable(db, { exhaustedAccounts: ['A'], dryRun: false })
  assert.equal(out.marked, 1)
  const reason = db.prepare('SELECT pnl_unresolvable_reason r FROM trades WHERE id = 1').get().r
  assert.ok(reason.startsWith(`${UNRESOLVED_NO_EVIDENCE}: closed `))
  assert.match(reason, /older than the 7-day age gate; the P&L repair recorded 7 attempt\(s\) on this row/)
  assert.doesNotMatch(reason, /deal-history horizon/)
  db.close()
})
