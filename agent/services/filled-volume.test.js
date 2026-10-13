// Claude · № 14,292 13-Oct (owner: NASA-3 "yes"; filled lots "Both"; Opened lots
// "Sent lots, labelled"; claude-builder).
//
// Grounding of the expected values:
//  - Deal fields and their meaning: spotware OpenApiModelMessages.proto
//    (ProtoOADeal.filledVolume in cents; ProtoOADealListByPositionIdRes hasMore).
//  - The defect being closed: docs/nasa-baseline-2026-10-13.md B2/B3, read on
//    production 13-10 (opened_lots read trades.volume, which a keeper or general
//    partial rewrites to the residual; requested_volume was the residual for
//    scaled rows closed through the history import).
//  - The figures in the fixtures (10,000 cents at a 10,000,000-cent lot =
//    0.001 lots, etc.) are self-derived arithmetic.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'
import { rememberVolumeMeta } from '../lib/lot-size-registry.js'
import { recordPositionEvent } from './position-events.js'
import { stampFilledVolume, openingDealsFilledLots, openedLotsFor, FILLED_SOURCES } from './filled-volume.js'
import { sweepLifecycleEvidence } from './position-lifecycle-evidence.js'
import { reconcilePositions } from './reconciler.js'
import { reconcileTradePricesToBroker } from './broker-history-import.js'

const DEMO = '43097342', LIVE = '42993489'
function trade(db, { account = DEMO, pid = '5001', status = 'open', volume = 0.2, symbol = 'EURUSD' } = {}) {
  return Number(db.prepare(`INSERT INTO trades(symbol,side,entry_price,volume,status,ctrader_position_id,account_id,opened_at)
    VALUES (?, 'BUY', 1.1, ?, ?, ?, ?, datetime('now'))`).run(symbol, volume, status, pid, account).lastInsertRowid)
}
const filled = (db, id) => db.prepare('SELECT filled_volume AS v, filled_volume_source AS s FROM trades WHERE id=?').get(id)

test('stamp: a better source replaces a worse one, never the reverse; rejected rows and other accounts untouched', () => {
  const db = initDB(':memory:')
  const id = trade(db), other = trade(db, { account: LIVE }), rejected = trade(db, { status: 'rejected', pid: '5002' })
  assert.equal(stampFilledVolume(db, { accountId: DEMO, positionId: '5001', lots: 0.2, source: 'broker_position_first_seen' }), 1)
  assert.deepEqual(filled(db, id), { v: 0.2, s: 'broker_position_first_seen' })
  assert.equal(filled(db, other).v, null, 'the same position id on another account is another position')
  assert.equal(stampFilledVolume(db, { accountId: DEMO, positionId: '5001', lots: 0.19, source: 'broker_opening_deals' }), 1)
  assert.deepEqual(filled(db, id), { v: 0.19, s: 'broker_opening_deals' })
  for (const source of FILLED_SOURCES) {
    assert.equal(stampFilledVolume(db, { accountId: DEMO, positionId: '5001', lots: 0.5, source }), 0, `${source} never replaces the deals`)
  }
  assert.equal(stampFilledVolume(db, { accountId: DEMO, positionId: '5002', lots: 0.1, source: 'broker_opening_deals' }), 0)
  assert.equal(filled(db, rejected).v, null)
  for (const bad of [0, -1, NaN, Infinity, '0.2', null]) {
    assert.equal(stampFilledVolume(db, { accountId: LIVE, positionId: '5001', lots: bad, source: 'broker_opening_deals' }), 0)
  }
  assert.equal(stampFilledVolume(db, { accountId: LIVE, positionId: '5001', lots: 0.2, source: 'order_request' }), 0, 'no source outside the list')
})

test('opening deals: executed opening deals of this position only, a complete answer, a known lot size', () => {
  const open = (id, v, extra = {}) => ({ dealId: id, positionId: 5001, dealStatus: 2, filledVolume: v, ...extra })
  const ok = { hasMore: false, deal: [open(1, 6000), open(2, 4000), open(3, 10000, { closePositionDetail: { closedVolume: 10000 } })] }
  assert.deepEqual(openingDealsFilledLots(ok, '5001', 10_000_000), { lots: 0.001, reason: null })
  assert.equal(openingDealsFilledLots({ ...ok, hasMore: true }, '5001', 10_000_000).reason, 'history_incomplete')
  assert.equal(openingDealsFilledLots(ok, '5001', null).reason, 'lot_size_unknown')
  assert.equal(openingDealsFilledLots({ hasMore: false, deal: [open(1, 6000, { dealStatus: 3 }), open(9, 99, { positionId: 7 })] }, '5001', 1000).lots, 6, 'partially filled counts; another position does not')
  assert.equal(openingDealsFilledLots({ hasMore: false, deal: [open(1, 6000, { dealStatus: 4 })] }, '5001', 1000).reason, 'opening_not_retained', 'a rejected deal is no fill')
  assert.equal(openingDealsFilledLots({ hasMore: false, deal: [open(1, '60.5')] }, '5001', 1000).reason, 'opening_volume_unverified')
})

test('opened lots: the recorded fill, else the sent lots while no reduction, else unknown — never the residual', () => {
  assert.deepEqual(openedLotsFor({ filledVolume: 0.2, filledSource: 'broker_opening_deals', volume: 0.1, reduced: true }), { lots: 0.2, source: 'broker_opening_deals' })
  assert.deepEqual(openedLotsFor({ filledVolume: null, filledSource: null, volume: 0.2, reduced: false }), { lots: 0.2, source: 'sent_order' })
  assert.deepEqual(openedLotsFor({ filledVolume: null, filledSource: null, volume: 0.1, reduced: true }), { lots: null, source: 'unknown_after_partial' })
  assert.deepEqual(openedLotsFor({ filledVolume: 0.2, filledSource: 'guess', volume: 0.2, reduced: false }), { lots: 0.2, source: 'sent_order' })
})

test('sweep: an open position with no recorded fill is read from its own deals and stamped on THIS account (demo and live)', async () => {
  for (const acct of [DEMO, LIVE]) {
    const db = initDB(':memory:')
    db.prepare("INSERT INTO accounts(account_id,is_live,enabled,mode) VALUES (?,?,1,'active')").run(acct, acct === LIVE ? 1 : 0)
    setState(db, accountSymbolMapKey(acct), JSON.stringify({ accountId: acct, builtAt: new Date().toISOString(), map: { EURUSD: 1 } }))
    rememberVolumeMeta(db, 'EURUSD', { lotSize: 10_000_000, accountId: acct }, { shared: false })
    const id = trade(db, { account: acct, volume: 0.25 })
    const reads = []
    const out = await sweepLifecycleEvidence(db, { accountId: acct, host: 'h' }, { now: Date.now(), getPositionDeals: async pid => {
      reads.push(pid)
      return { ctidTraderAccountId: Number(acct), hasMore: false, deal: [
        { dealId: 11, orderId: 21, positionId: 5001, symbolId: 1, tradeSide: 1, dealStatus: 2, volume: 2_000_000, filledVolume: 2_000_000,
          executionPrice: 1.1, executionTimestamp: Date.now() - 60_000, createTimestamp: Date.now() - 61_000 },
      ] }
    } })
    assert.deepEqual(reads, ['5001'], JSON.stringify(out))
    assert.equal(out.class, 'filled')
    assert.deepEqual(filled(db, id), { v: 0.2, s: 'broker_opening_deals' }, 'the deals say 0.2 lots filled, not the 0.25 sent')
    // Once known from the deals, the position is no longer a candidate.
    const again = await sweepLifecycleEvidence(db, { accountId: acct, host: 'h' }, { now: Date.now() + 3_600_000, getPositionDeals: async () => { throw Error('not read') } })
    assert.notEqual(again.class, 'filled')
  }
})

test('reconciler: the first sighting with no reduction on record stamps the broker volume as first-seen; a reduced position does not', () => {
  for (const reduced of [false, true]) {
    const db = initDB(':memory:')
    setState(db, 'ctrader_account_id', DEMO)
    rememberVolumeMeta(db, 'EURUSD', { lotSize: 10_000_000, accountId: DEMO }, { shared: false })
    const id = trade(db, { volume: 0.25 })
    db.prepare(`INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,current_sl,current_tp,initial_risk,source,status,account_id)
      VALUES ('EURUSD', ?, 'long', 1.1, 1.09, 1.13, 0.01, 'autopilot', 'active', ?)`).run(id, DEMO)
    if (reduced) recordPositionEvent(db, { accountId: DEMO, positionId: '5001', tradeId: id, symbol: 'EURUSD', kind: 'volume_reduced', fromValue: 2, toValue: 1, source: 'test' })
    reconcilePositions(db, [{ positionId: 5001, price: 1.1, stopLoss: 1.09, takeProfit: 1.13,
      tradeData: { symbolId: 1, symbolName: 'EURUSD', tradeSide: 'BUY', volume: 2_000_000, label: 'AP|v1|RSIM' } }], [], (k, v) => setState(db, k, v), { accountId: DEMO })
    assert.deepEqual(filled(db, id), reduced ? { v: null, s: null } : { v: 0.2, s: 'broker_position_first_seen' })
  }
})

test('history import: a scaled row\'s residual is not kept as requested_volume; the closing deals are its fill', () => {
  for (const scaled of [false, true]) {
    const db = initDB(':memory:')
    const id = trade(db, { status: 'closed', volume: scaled ? 0.1 : 0.25 })
    if (scaled) recordPositionEvent(db, { accountId: DEMO, positionId: '5001', tradeId: id, symbol: 'EURUSD', kind: 'scale_out', fromValue: 2_000_000, toValue: 1_000_000, source: 'test' })
    db.prepare(`INSERT INTO broker_deals(deal_id,position_id,account_id,symbol,side,lots,volume_contract,entry_price,close_price,closed_at,matched_trade_id)
      VALUES ('d1','5001',?, 'EURUSD','BUY',0.1,1,1.1,1.12,'2026-10-12 10:00:00',?), ('d2','5001',?, 'EURUSD','BUY',0.1,1,1.1,1.13,'2026-10-12 11:00:00',?)`)
      .run(DEMO, id, DEMO, id)
    reconcileTradePricesToBroker(db)
    const row = db.prepare('SELECT volume, requested_volume FROM trades WHERE id=?').get(id)
    assert.equal(row.volume, 0.2)
    assert.equal(row.requested_volume, scaled ? null : 0.25, scaled ? 'the residual 0.1 is no request' : 'the lots sent (0.25, filled 0.2) are kept')
    assert.deepEqual(filled(db, id), { v: 0.2, s: 'broker_closing_deals' })
  }
})
