import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { backfillClosedPnl, resetBackfillPacing } from './pnl-backfill.js'
import { backfillAccountPnl, backfillCrossSidePnl } from './cross-side-pnl.js'
import { recoverOldPositionPnl } from './old-position-pnl.js'
import { verifiedPositionHistory } from '../lib/position-deal-history.js'
import { EventEmitter } from 'node:events'
import { wsGetPositionDeals } from '../lib/ctrader-ws.js'
import { _setConnectForTests, _resetPool } from '../lib/ctrader-session.js'

const now = Date.now(), day = 86400_000
const creds = { ready: true, host: 'live.ctraderapi.com', accountId: '2', isLive: true }
const base = { ready: true, isLive: false }
function fixture(t) {
  const db = initDB(':memory:'); resetBackfillPacing()
  t.after(() => { db.close(); resetBackfillPacing() })
  for (const [accountId, live] of [['1', 0], ['2', 1], ['3', 1]]) {
    db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,?,1,'active')").run(accountId, live)
  }
  setState(db, 'ctrader_account_id', '1')
  return db
}
function seed(db, account = '2', position = '700', options = {}) {
  return Number(db.prepare(`INSERT INTO trades (account_id,symbol,side,status,ctrader_position_id,opened_at,closed_at,entry_price,sl_price,volume,pnl_unresolvable,pnl_attempts)
    VALUES (?,'X','BUY',?,?,?, ?,100,90,1,?,0)`).run(account, options.status || 'closed', position,
    new Date(now - 100 * day).toISOString(), new Date(now - day).toISOString(), options.writtenOff || 0).lastInsertRowid)
}
const row = (db, id) => db.prepare('SELECT net_pnl, gross_pnl, commission, exit_price, pnl_attempts, account_id FROM trades WHERE id=?').get(id)
function history(position = '700', account = '2') {
  const common = { positionId: position, symbolId: 10, dealStatus: 2, volume: 100, filledVolume: 100, executionPrice: 100 }
  return { ctidTraderAccountId: account, hasMore: false, deal: [
    { ...common, dealId: '900', executionTimestamp: now - 100 * day },
    { ...common, dealId: '901', executionTimestamp: now - 90 * day, volume: 150, filledVolume: 40, executionPrice: 90,
      closePositionDetail: { grossProfit: -400, swap: -10, commission: -20, moneyDigits: 2, closedVolume: 40 } },
    { ...common, dealId: '902', executionTimestamp: now - day, volume: 80, filledVolume: 60, executionPrice: 110,
      closePositionDetail: { grossProfit: 600, swap: -10, commission: -30, moneyDigits: 2, closedVolume: 60 } },
  ] }
}
const args = getPositionDeals => ({ accountId: '2', positionId: '700', strictAccount: true, now, getPositionDeals })

test('complete 100-day position history recovers both partial closes and their filled-volume price', async t => {
  const db = fixture(t), target = seed(db), peer = seed(db, '3'), orphan = seed(db, null), other = seed(db, '2', '701')
  const result = await backfillClosedPnl(db, creds, args(async () => history()))
  assert.equal(result.backfilled, 1); assert.equal(result.closingDeals, 2)
  assert.deepEqual(row(db, target), { net_pnl: 1.3, gross_pnl: 2, commission: -.5, exit_price: 102, pnl_attempts: 0, account_id: '2' })
  for (const id of [peer, orphan, other]) assert.equal(row(db, id).net_pnl, null)
  assert.equal(row(db, orphan).account_id, null)
  const evidence = db.prepare('SELECT opened_at, net_pnl FROM broker_deals WHERE account_id=? ORDER BY deal_id').all('2')
  assert.equal(evidence.length, 2, 'both closing receipts are retained with the observed opening time')
  assert.deepEqual(evidence.map(e => e.net_pnl), [-4.3, 5.6])
  assert.ok(evidence.every(e => Date.parse(e.opened_at.replace(' ', 'T') + 'Z') <= now - 99 * day))
})

test('empty complete history stamps only the searched position, never peers or unknown accounts', async t => {
  const db = fixture(t), target = seed(db), other = seed(db, '2', '701'), orphan = seed(db, null)
  await backfillClosedPnl(db, creds, args(async () => ({ ctidTraderAccountId: '2', hasMore: false })))
  assert.equal(row(db, target).pnl_attempts, 1)
  assert.equal(row(db, other).pnl_attempts, 0); assert.equal(row(db, orphan).pnl_attempts, 0)
})

// Checker fix round #2, item 1 (CLAUDE.md #1): the SAME empty-history read,
// row-scoped (positionId given, so pnl-backfill.js's internal windowPass is
// false), but on a WRITTEN-OFF target. pnl-backfill.js:882's own call site
// passes includeWrittenOff: !windowPass, which is `true` here — the
// deliberate, bounded, row-scoped read this file's own comment (:120-125)
// says must still count, unlike the broad periodic sweep. Nothing pinned
// this: flipping :882's argument to an unconditional `true` OR an
// unconditional `false` left every test in this file green, because every
// other written-off fixture here goes through old-position-pnl.js's OWN
// noteTradeAttempts call (line 126, only reached on out.state === 'refused'),
// never through pnl-backfill.js's internal one at a 'no_matching_close'
// state, which is what an empty history (no error, no fill) actually is.
test('a written-off target still gets its row-scoped attempt charged on an empty complete history (pnl-backfill.js:882, windowPass=false)', async t => {
  const db = fixture(t), target = seed(db, '2', '700', { writtenOff: 1 })
  await backfillClosedPnl(db, creds, args(async () => ({ ctidTraderAccountId: '2', hasMore: false })))
  assert.equal(row(db, target).pnl_attempts, 1, 'row-scoped (includeWrittenOff: !windowPass === true) still counts, unlike the broad sweep')
})

test('omitted zero-valued swap and commission preserve complete broker P&L', async t => {
  const db = fixture(t), target = seed(db), response = history()
  for (const d of response.deal.filter(d => d.closePositionDetail)) {
    delete d.closePositionDetail.swap; delete d.closePositionDetail.commission
  }
  await backfillClosedPnl(db, creds, args(async () => response))
  assert.deepEqual([row(db, target).net_pnl, row(db, target).commission], [2, 0])
})

test('complete broker lifecycles recover missing, invalid or future local opening dates', async t => {
  const db = fixture(t)
  for (const [index, opened] of [null, 'unparseable', new Date(now + day).toISOString()].entries()) {
    const position = String(700 + index), target = seed(db, '2', position)
    db.prepare('UPDATE trades SET opened_at=? WHERE id=?').run(opened, target)
    const recovered = await recoverOldPositionPnl(db, creds, { now: now + index * 30_000, isCurrent: () => true,
      getPositionDeals: async p => history(p) })
    assert.equal(recovered.state, 'recovered'); assert.equal(recovered.positionId, position)
    assert.equal(row(db, target).net_pnl, 1.3)
  }
})

test('partial, malformed, mismatched, missing-opening and unclosed histories cannot stamp money or attempts', async t => {
  const db = fixture(t), target = seed(db)
  const mutations = [
    r => { r.hasMore = true }, r => { delete r.hasMore }, r => { r.ctidTraderAccountId = '3' },
    r => { r.deal[1].positionId = '701' }, r => { r.deal.push(r.deal[1]) },
    r => { r.deal.shift() }, r => { r.deal.pop() }, r => { r.deal[1].closePositionDetail.closedVolume = 41 },
    r => { r.deal[1].closePositionDetail.grossProfit = 'bad' }, r => { r.deal[1].closePositionDetail.commission = 'bad' },
    // V3 B1: a nonzero conversion fee is no longer a refusal (one treatment:
    // excluded from net, pnl-lifecycle-guard.test.js); an unreadable one is.
    r => { r.deal[1].closePositionDetail.pnlConversionFee = 'bad' }, r => { r.deal[2].executionTimestamp = now + 1 },
    r => { r.deal[2].symbolId = 11 }, r => { r.deal[1].dealStatus = 4 },
  ]
  for (const mutate of mutations) {
    const response = history(); mutate(response)
    await assert.rejects(backfillClosedPnl(db, creds, args(async () => response)), /position/)
    assert.equal(row(db, target).net_pnl, null); assert.equal(row(db, target).pnl_attempts, 0)
  }
  assert.equal(db.prepare('SELECT count(*) n FROM broker_deals').get().n, 0)
})

test('an ambiguous local position, open peer or non-strict caller is refused before reading', async t => {
  const db = fixture(t), target = seed(db), duplicate = seed(db)
  let reads = 0
  const read = async () => { reads++; return history() }
  await assert.rejects(backfillClosedPnl(db, creds, args(read)), error => {
    assert.match(error.message, /ambiguous/)
    assert.match(error.message, /count=2/)
    assert.match(error.message, new RegExp(`"id":${target}`))
    assert.match(error.message, new RegExp(`"id":${duplicate}`))
    return true
  })
  db.prepare('DELETE FROM trades WHERE id=?').run(duplicate)
  db.prepare("UPDATE trades SET status='open' WHERE id=?").run(target)
  await assert.rejects(backfillClosedPnl(db, creds, args(read)), /not closed/)
  await assert.rejects(backfillClosedPnl(db, creds, { ...args(read), strictAccount: false }), /strict/)
  assert.equal(reads, 0)
})

test('late complete history cannot persist deals, money or attempt evidence', async t => {
  const db = fixture(t), target = seed(db)
  await assert.rejects(backfillClosedPnl(db, creds, { ...args(async () => history()), isCurrent: () => false }), /deadline/)
  assert.equal(row(db, target).net_pnl, null); assert.equal(row(db, target).pnl_attempts, 0)
  assert.equal(db.prepare('SELECT count(*) n FROM broker_deals').get().n, 0)
})

test('durable failure pacing lets the next old position advance and survives a fresh collector call', async t => {
  const db = fixture(t), failed = seed(db), good = seed(db, '2', '701'); seed(db, '2', '702', { writtenOff: 1 })
  const read = async p => { if (p === '700') throw Error('broker unavailable'); return history(p) }
  const opts = { now, isCurrent: () => true, getPositionDeals: read }
  assert.equal((await recoverOldPositionPnl(db, creds, opts)).state, 'failed')
  assert.equal((await recoverOldPositionPnl(db, creds, opts)).state, 'paced')
  assert.equal((await recoverOldPositionPnl(db, creds, { ...opts, now: now + 30_000 })).state, 'recovered')
  assert.equal(row(db, failed).pnl_attempts, 0); assert.equal(row(db, good).net_pnl, 1.3)
  assert.equal(JSON.parse(getState(db, 'position_pnl_recovery:2')).positionId, '701')
})

test('the existing cross-side pass reaches old position history on its own account with the shared budget', async t => {
  const db = fixture(t), target = seed(db), calls = []
  const result = await backfillCrossSidePnl(db, base, [], { clock: () => now,
    getCreds: (_db, { accountId }) => ({ ...creds, accountId }), getDeals: async () => { throw Error('no recent account query needed') },
    getPositionDeals: async (...a) => { calls.push(a); return history(a[5], a[4]) },
  })
  assert.equal(result.find(r => r.accountId === '2').result.positionHistory.state, 'recovered')
  assert.equal(result.find(r => r.accountId === '2').result.backfilled, 1)
  assert.equal(row(db, target).net_pnl, 1.3); assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'live.ctraderapi.com'); assert.equal(calls[0][4], '2'); assert.equal(calls[0][5], '700')
  assert.ok(calls[0][7] <= 5000); assert.equal(getState(db, 'ctrader_account_id'), '1')
})

test('same-side account passes recover the selected and other enabled accounts with their own history', async t => {
  const db = fixture(t), selected = seed(db, '1'), otherSide = seed(db, '2'), calls = []
  db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES ('4',0,1,'active')").run()
  const peer = seed(db, '4'), orphan = seed(db, null)
  for (const accountId of ['1', '4']) {
    const result = await backfillAccountPnl(db, { ...creds, host: 'demo.ctraderapi.com', isLive: false, accountId }, {
      clock: () => now, getDeals: async () => { throw Error('no recent account query needed') },
      getPositionDeals: async (...a) => { calls.push(a); return history(a[5], a[4]) },
    })
    assert.equal(result.result.positionHistory.state, 'recovered')
    assert.equal(result.result.backfilled, 1)
  }
  assert.equal(row(db, selected).net_pnl, 1.3); assert.equal(row(db, peer).net_pnl, 1.3)
  assert.equal(row(db, otherSide).net_pnl, null); assert.equal(row(db, orphan).net_pnl, null)
  assert.deepEqual(calls.map(a => [a[0], a[4], a[5]]), [['demo.ctraderapi.com', '1', '700'], ['demo.ctraderapi.com', '4', '700']])
  assert.ok(calls.every(a => a[7] <= 5000)); assert.equal(getState(db, 'ctrader_account_id'), '1')
})

test('a same-side transport still pending also blocks a later opposite-side pass after selection changes', async t => {
  const db = fixture(t), target = seed(db); let release, calls = 0
  const deps = { budgetMs: 10, getCreds: (_db, { accountId }) => ({ ...creds, accountId }),
    getPositionDeals: async () => { calls++; return new Promise(resolve => { release = resolve }) } }
  const first = await backfillAccountPnl(db, creds, deps)
  assert.equal(first.result.positionHistory.state, 'failed')
  const second = await backfillCrossSidePnl(db, base, [], deps)
  assert.equal(second.find(r => r.accountId === '2').skipped, 'read_still_in_flight')
  assert.equal(calls, 1); release(history()); await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(row(db, target).net_pnl, null); assert.equal(row(db, target).pnl_attempts, 0)
})

test('expired failure cooldowns cannot starve later old positions across repeated loop passes', async t => {
  const db = fixture(t), calls = []
  for (let i = 0; i < 5; i++) seed(db, '2', String(700 + i))
  for (let i = 0; i < 6; i++) {
    await recoverOldPositionPnl(db, creds, { now: now + i * 5 * 60_000, isCurrent: () => true,
      getPositionDeals: async p => { calls.push(p); throw Error('broker unavailable') } })
  }
  assert.deepEqual(calls, ['700', '701', '702', '703', '704', '700'])
})

test('stuck position read holds the real transport lock, releases the loop and cannot write late', async t => {
  const db = fixture(t), target = seed(db)
  let release, count = 0
  const pending = new Promise(r => { release = r })
  const deps = { budgetMs: 20, clock: () => now, getCreds: (_db, { accountId }) => ({ ...creds, accountId }),
    getPositionDeals: async () => { count++; return pending }, getDeals: async () => { throw Error('unexpected') } }
  const result = await backfillCrossSidePnl(db, base, [], deps)
  assert.match(result.find(r => r.accountId === '2').result.positionHistory.reason, /deadline/)
  assert.equal((await backfillCrossSidePnl(db, base, [], deps)).find(r => r.accountId === '2').skipped, 'read_still_in_flight')
  release(history()); await new Promise(r => setImmediate(r))
  assert.equal(count, 1); assert.equal(row(db, target).net_pnl, null); assert.equal(row(db, target).pnl_attempts, 0)
})

test('verification refuses oversized histories rather than allocating unbounded retained evidence', () => {
  assert.throws(() => verifiedPositionHistory({ ...history(), deal: Array(501).fill(history().deal[0]) },
    { accountId: '2', positionId: '700', now }), /bounded/)
})

test('the actual WS helper sends the documented position-history message for the whole lifetime', async t => {
  const old = process.env.CTRADER_WS_POOL; process.env.CTRADER_WS_POOL = '1'
  const sent = []
  class FakeWs extends EventEmitter {
    constructor() { super(); this.readyState = 1; setImmediate(() => this.emit('open')) }
    close() { this.readyState = 3 }
    send(raw) {
      const m = JSON.parse(raw); sent.push(m)
      const replies = { 2100: [2101, {}], 2102: [2103, {}], 2179: [2180, history()] }
      if (!replies[m.payloadType]) return
      const [payloadType, payload] = replies[m.payloadType]
      this.emit('message', Buffer.from(JSON.stringify({ payloadType, payload, clientMsgId: m.clientMsgId })))
    }
  }
  _resetPool(); _setConnectForTests(() => new FakeWs())
  t.after(() => { _resetPool(); _setConnectForTests(null); if (old == null) delete process.env.CTRADER_WS_POOL; else process.env.CTRADER_WS_POOL = old })
  const response = await wsGetPositionDeals('live.ctraderapi.com', 'fixture', 'fixture', 'fixture', '2', '700', now)
  assert.deepEqual(response, history())
  assert.deepEqual(sent.find(m => m.payloadType === 2179).payload,
    { ctidTraderAccountId: 2, positionId: 700, fromTimestamp: 0, toTimestamp: now })
  assert.throws(() => wsGetPositionDeals('live.ctraderapi.com', '', '', '', '2', '9007199254740992', now), /identity/)
  assert.equal(sent.filter(m => m.payloadType === 2179).length, 1)
})
