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
function trade(db, { account = DEMO, pid = '5001', status = 'open', volume = 0.2, symbol = 'EURUSD', origin = 'bot_market_dispatch' } = {}) {
  return Number(db.prepare(`INSERT INTO trades(symbol,side,entry_price,volume,status,ctrader_position_id,account_id,opened_at,origin)
    VALUES (?, 'BUY', 1.1, ?, ?, ?, ?, datetime('now'), ?)`).run(symbol, volume, status, pid, account, origin).lastInsertRowid)
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
  for (const source of FILLED_SOURCES.filter(x => x !== 'broker_opening_deals')) {
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
  assert.deepEqual(openedLotsFor({ filledVolume: null, filledSource: null, volume: 0.2, reduced: false, origin: 'bot_market_dispatch' }), { lots: 0.2, source: 'sent_order' })
  assert.deepEqual(openedLotsFor({ filledVolume: null, filledSource: null, volume: 0.2, reduced: false, origin: 'manual_broker' }), { lots: 0.2, source: 'sent_order' })
  // Codex P2 on #1359 (№ 14,343): an adopted row's volume is the broker's, not an order sent.
  for (const origin of ['reconciler_adopted', 'external_system', 'unknown', null]) {
    assert.deepEqual(openedLotsFor({ filledVolume: null, filledSource: null, volume: 0.2, reduced: false, origin }), { lots: null, source: 'unknown' })
  }
  assert.deepEqual(openedLotsFor({ filledVolume: null, filledSource: null, volume: 0.1, reduced: true }), { lots: null, source: 'unknown_after_partial' })
  assert.deepEqual(openedLotsFor({ filledVolume: 0.2, filledSource: 'guess', volume: 0.2, reduced: false, origin: 'bot_pending_fill' }), { lots: 0.2, source: 'sent_order' })
  assert.deepEqual(openedLotsFor({ filledVolume: 0.2, filledSource: 'broker_closing_deals', volume: 0.1, reduced: true }), { lots: null, source: 'unknown_after_partial' }, 'no longer a source')
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
    // Read again only after the retry interval (№ 14,348), never sooner.
    const again = await sweepLifecycleEvidence(db, { accountId: acct, host: 'h' }, { now: Date.now() + 60_000, getPositionDeals: async () => { throw Error('not read') } })
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

test('history import: a scaled row\'s residual is not kept as requested_volume; closing deals are not recorded as the fill', () => {
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
    // Codex P2 on #1359 (№ 14,343): a history read can hold only the later
    // closes of a position, so their sum is not proven to be the fill.
    assert.deepEqual(filled(db, id), { v: null, s: null })
  }
})

// Claude · № 14,344 13-Oct (Codex P2 round 2 on #1359; claude-builder). A
// position added to after its deals were read: the reconciler sees more volume
// and clears the recorded fill; the next complete deal read records the new sum.
test('an added opening fill clears the recorded fill; a later complete deal read replaces it', () => {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', DEMO)
  rememberVolumeMeta(db, 'EURUSD', { lotSize: 10_000_000, accountId: DEMO }, { shared: false })
  const id = trade(db, { volume: 0.2 })
  db.prepare(`INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,current_sl,current_tp,initial_risk,source,status,account_id,broker_volume_units)
    VALUES ('EURUSD', ?, 'long', 1.1, 1.09, 1.13, 0.01, 'autopilot', 'active', ?, 20000)`).run(id, DEMO)
  stampFilledVolume(db, { accountId: DEMO, positionId: '5001', lots: 0.2, source: 'broker_opening_deals' })
  const pos = volume => [{ positionId: 5001, price: 1.1, stopLoss: 1.09, takeProfit: 1.13,
    tradeData: { symbolId: 1, symbolName: 'EURUSD', tradeSide: 'BUY', volume, label: 'AP|v1|RSIM' } }]
  reconcilePositions(db, pos(2_000_000), [], (k, v) => setState(db, k, v), { accountId: DEMO })
  assert.deepEqual(filled(db, id), { v: 0.2, s: 'broker_opening_deals' }, 'unchanged volume keeps the fill')
  reconcilePositions(db, pos(3_000_000), [], (k, v) => setState(db, k, v), { accountId: DEMO })
  assert.deepEqual(filled(db, id), { v: null, s: null }, 'more volume: the old fill no longer covers it')
  assert.equal(stampFilledVolume(db, { accountId: DEMO, positionId: '5001', lots: 0.3, source: 'broker_opening_deals' }), 1)
  assert.equal(stampFilledVolume(db, { accountId: DEMO, positionId: '5001', lots: 0.35, source: 'broker_opening_deals' }), 1, 'a later complete read replaces an earlier one')
  assert.equal(stampFilledVolume(db, { accountId: DEMO, positionId: '5001', lots: 0.5, source: 'broker_position_first_seen' }), 0)
  assert.deepEqual(filled(db, id), { v: 0.35, s: 'broker_opening_deals' })
})

// Claude · № 14,345 13-Oct (Codex P2s round 3 on #1359; claude-builder). A netted
// reversal keeps the position id: no fill is derived from the mixed history,
// and the reconciler's side flip clears the fill on record.
test('a reversed position: no fill from its deals, and the side flip clears the recorded fill', () => {
  const deal = (id, side, filled, closed = null) => ({ dealId: id, positionId: 5001, dealStatus: 2, tradeSide: side, filledVolume: filled,
    ...(closed != null ? { closePositionDetail: { closedVolume: closed } } : {}) })
  assert.equal(openingDealsFilledLots({ hasMore: false, deal: [deal(1, 1, 2000), deal(2, 2, 3000, 2000)] }, '5001', 1000).reason, 'position_reversed',
    'one deal closes 2,000 and opens 1,000 the other way')
  assert.equal(openingDealsFilledLots({ hasMore: false, deal: [deal(1, 1, 2000), deal(2, 2, 2000, 2000), deal(3, 2, 1000)] }, '5001', 1000).reason, 'position_reversed',
    'opening deals on both sides')
  assert.equal(openingDealsFilledLots({ hasMore: false, deal: [deal(1, 1, 2000), deal(2, 2, 1000, 1000)] }, '5001', 1000).lots, 2, 'a plain partial close is no reversal')
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', DEMO)
  rememberVolumeMeta(db, 'EURUSD', { lotSize: 10_000_000, accountId: DEMO }, { shared: false })
  const id = trade(db, { volume: 0.2 })
  db.prepare(`INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,current_sl,current_tp,initial_risk,source,status,account_id,broker_volume_units)
    VALUES ('EURUSD', ?, 'long', 1.1, 1.09, 1.13, 0.01, 'autopilot', 'active', ?, 20000)`).run(id, DEMO)
  stampFilledVolume(db, { accountId: DEMO, positionId: '5001', lots: 0.2, source: 'broker_opening_deals' })
  reconcilePositions(db, [{ positionId: 5001, price: 1.1, stopLoss: 1.12, takeProfit: 1.05,
    tradeData: { symbolId: 1, symbolName: 'EURUSD', tradeSide: 'SELL', volume: 1_000_000, label: 'AP|v1|RSIM' } }], [], (k, v) => setState(db, k, v), { accountId: DEMO })
  assert.deepEqual(filled(db, id), { v: null, s: null })
})

// Claude · № 14,346 13-Oct (Codex P2 follow-ups from #1359; claude-builder).
// (1) The broker-position fallbacks stand for the fill only where the lifecycle
// began here; an adopted position may have been reduced before adoption with
// nothing on record. Its own deals still do. (2) A close and an add between two
// passes can leave the net lower: any volume change clears the fill on record.
test('an adopted position takes no broker-position fallback; its own deals still record the fill', () => {
  const db = initDB(':memory:')
  for (const origin of ['reconciler_adopted', 'external_system', 'unknown', null]) {
    const pid = String(6000 + ['reconciler_adopted', 'external_system', 'unknown', null].indexOf(origin))
    const id = trade(db, { pid, origin })
    for (const source of ['broker_position_first_seen', 'broker_position_before_first_partial']) {
      assert.equal(stampFilledVolume(db, { accountId: DEMO, positionId: pid, lots: 0.2, source }), 0, `${origin} ${source}`)
    }
    assert.equal(stampFilledVolume(db, { accountId: DEMO, positionId: pid, lots: 0.2, source: 'broker_opening_deals' }), 1)
    assert.deepEqual(filled(db, id), { v: 0.2, s: 'broker_opening_deals' })
  }
})

test('any broker volume change the reconciler sees clears the recorded fill', () => {
  for (const next of [3_000_000, 2_000_000 - 500_000]) {
    const db = initDB(':memory:')
    setState(db, 'ctrader_account_id', DEMO)
    rememberVolumeMeta(db, 'EURUSD', { lotSize: 10_000_000, accountId: DEMO }, { shared: false })
    const id = trade(db, { volume: 0.2 })
    db.prepare(`INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,current_sl,current_tp,initial_risk,source,status,account_id,broker_volume_units)
      VALUES ('EURUSD', ?, 'long', 1.1, 1.09, 1.13, 0.01, 'autopilot', 'active', ?, 20000)`).run(id, DEMO)
    stampFilledVolume(db, { accountId: DEMO, positionId: '5001', lots: 0.2, source: 'broker_opening_deals' })
    reconcilePositions(db, [{ positionId: 5001, price: 1.1, stopLoss: 1.09, takeProfit: 1.13,
      tradeData: { symbolId: 1, symbolName: 'EURUSD', tradeSide: 'BUY', volume: next, label: 'AP|v1|RSIM' } }], [], (k, v) => setState(db, k, v), { accountId: DEMO })
    assert.deepEqual(filled(db, id), { v: null, s: null }, `${next > 2_000_000 ? 'more' : 'less'} volume: read the deals again`)
  }
})

// № 14,348 (Codex P2 on #1360; claude-builder): a close and an equal-sized add
// leave the net unchanged; the sweep re-reads open positions anyway (once per
// 15 minutes each) and the later complete read replaces the earlier fill.
test('an open position with a fill from its deals is read again after the retry interval', async () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO accounts(account_id,is_live,enabled,mode) VALUES (?,0,1,'active')").run(DEMO)
  setState(db, accountSymbolMapKey(DEMO), JSON.stringify({ accountId: DEMO, builtAt: new Date().toISOString(), map: { EURUSD: 1 } }))
  rememberVolumeMeta(db, 'EURUSD', { lotSize: 10_000_000, accountId: DEMO }, { shared: false })
  const id = trade(db, { volume: 0.2 })
  const answer = deals => async () => ({ ctidTraderAccountId: Number(DEMO), hasMore: false, deal: deals.map((v, i) => ({
    dealId: 11 + i, orderId: 21 + i, positionId: 5001, symbolId: 1, tradeSide: 1, dealStatus: 2, volume: v, filledVolume: v,
    executionPrice: 1.1, executionTimestamp: Date.parse('2026-10-13T10:00:00Z') + i * 60_000 })) })
  const t0 = Date.parse('2026-10-13T12:00:00Z')
  const first = await sweepLifecycleEvidence(db, { accountId: DEMO, host: 'h' }, { now: t0, getPositionDeals: answer([2_000_000]) })
  assert.equal(first.class, 'filled'); assert.deepEqual(filled(db, id), { v: 0.2, s: 'broker_opening_deals' })
  // A close of 0.1 and an add of 0.1 later: the deals now hold two openings summing 0.3.
  let later = null
  for (let k = 1; k <= 4 && later?.class !== 'filled'; k++) {
    later = await sweepLifecycleEvidence(db, { accountId: DEMO, host: 'h' }, { now: t0 + 16 * 60_000 + k * 31_000, getPositionDeals: answer([2_000_000, 1_000_000]) })
  }
  assert.equal(later.class, 'filled', JSON.stringify(later))
  assert.deepEqual(filled(db, id), { v: 0.3, s: 'broker_opening_deals' })
})

// Claude · № 14,461 14-Oct (owner: "fix the follow-ups C·1 and C·2"; Codex P2
// recorded on #1360; claude-builder). A complete empty answer stores a final
// verdict (empty_at_broker); the open broker position then takes its opening
// deals. Finality must not stop the filled class reading it again.
test('a final verdict on an open position does not stop the filled re-read', async () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO accounts(account_id,is_live,enabled,mode) VALUES (?,0,1,'active')").run(DEMO)
  setState(db, accountSymbolMapKey(DEMO), JSON.stringify({ accountId: DEMO, builtAt: new Date().toISOString(), map: { EURUSD: 1 } }))
  rememberVolumeMeta(db, 'EURUSD', { lotSize: 10_000_000, accountId: DEMO }, { shared: false })
  const id = trade(db, { volume: 0.2 })
  const t0 = Date.parse('2026-10-13T12:00:00Z')
  const first = await sweepLifecycleEvidence(db, { accountId: DEMO, host: 'h' }, { now: t0,
    getPositionDeals: async () => ({ ctidTraderAccountId: Number(DEMO), hasMore: false, deal: [] }) })
  assert.equal(first.class, 'filled')
  const stored = db.prepare('SELECT verdict, final FROM position_lifecycle_evidence WHERE account_id=? AND position_id=?').get(DEMO, '5001')
  assert.deepEqual(stored, { verdict: 'empty_at_broker', final: 1 }, 'the arrangement holds: a final verdict on an open position')
  const answer = async () => ({ ctidTraderAccountId: Number(DEMO), hasMore: false, deal: [{ dealId: 11, orderId: 21, positionId: 5001, symbolId: 1,
    tradeSide: 1, dealStatus: 2, volume: 2_000_000, filledVolume: 2_000_000, executionPrice: 1.1, executionTimestamp: Date.parse('2026-10-13T11:59:00Z') }] })
  const soon = await sweepLifecycleEvidence(db, { accountId: DEMO, host: 'h' }, { now: t0 + 5 * 60_000, getPositionDeals: answer })
  assert.notEqual(soon.class, 'filled', 'still paced: never read again inside 15 minutes')
  let later = null
  for (let k = 1; k <= 4 && later?.class !== 'filled'; k++) {
    later = await sweepLifecycleEvidence(db, { accountId: DEMO, host: 'h' }, { now: t0 + 16 * 60_000 + k * 31_000, getPositionDeals: answer })
  }
  assert.equal(later.class, 'filled', JSON.stringify(later))
  assert.deepEqual(filled(db, id), { v: 0.2, s: 'broker_opening_deals' })
})

// № 14,349 (Codex P2 round 2 on #1360; claude-builder): with more open
// positions than reads per window, the least recently read goes first, so every
// position is reached rather than the newest ones over and over.
test('the filled sweep reads the least recently read open position first', async () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO accounts(account_id,is_live,enabled,mode) VALUES (?,0,1,'active')").run(DEMO)
  setState(db, accountSymbolMapKey(DEMO), JSON.stringify({ accountId: DEMO, builtAt: new Date().toISOString(), map: { EURUSD: 1 } }))
  rememberVolumeMeta(db, 'EURUSD', { lotSize: 10_000_000, accountId: DEMO }, { shared: false })
  const ids = ['7001', '7002', '7003'].map(pid => trade(db, { pid }))
  for (const pid of ['7001', '7002', '7003']) stampFilledVolume(db, { accountId: DEMO, positionId: pid, lots: 0.2, source: 'broker_opening_deals' })
  const answer = pid => ({ ctidTraderAccountId: Number(DEMO), hasMore: false, deal: [{ dealId: Number(pid), orderId: 1, positionId: Number(pid), symbolId: 1,
    tradeSide: 1, dealStatus: 2, volume: 2_000_000, filledVolume: 2_000_000, executionPrice: 1.1, executionTimestamp: Date.parse('2026-10-13T10:00:00Z') }] })
  const t0 = Date.parse('2026-10-13T12:00:00Z'), order = []
  for (let k = 0; order.length < 6 && k < 40; k++) {
    const out = await sweepLifecycleEvidence(db, { accountId: DEMO, host: 'h' }, { now: t0 + k * 31 * 60_000, getPositionDeals: async pid => answer(pid) })
    if (out.class === 'filled') order.push(out.positionId)
  }
  assert.deepEqual(order.slice(0, 3).sort(), ['7001', '7002', '7003'], 'each is read once before any is read twice')
  assert.deepEqual(order.slice(3, 6).sort(), ['7001', '7002', '7003'], JSON.stringify(order))
  assert.equal(ids.length, 3)
})

// № 14,350 (Codex P2 round 3 on #1360): a position that can never get a deal
// fill (no declared lot size) does not starve one that has a deal fill.
test('an unstampable position does not starve a deal-stamped one', async () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO accounts(account_id,is_live,enabled,mode) VALUES (?,0,1,'active')").run(DEMO)
  setState(db, accountSymbolMapKey(DEMO), JSON.stringify({ accountId: DEMO, builtAt: new Date().toISOString(), map: { EURUSD: 1, XAUUSD: 2 } }))
  rememberVolumeMeta(db, 'EURUSD', { lotSize: 10_000_000, accountId: DEMO }, { shared: false })
  trade(db, { pid: '8001', symbol: 'EURUSD' })
  trade(db, { pid: '8002', symbol: 'XAUUSD' }) // no lot size: never stampable
  const answer = pid => ({ ctidTraderAccountId: Number(DEMO), hasMore: false, deal: [{ dealId: Number(pid), orderId: 1, positionId: Number(pid),
    symbolId: pid === '8001' ? 1 : 2, tradeSide: 1, dealStatus: 2, volume: 2_000_000, filledVolume: 2_000_000, executionPrice: 1.1,
    executionTimestamp: Date.parse('2026-10-13T10:00:00Z') }] })
  const t0 = Date.parse('2026-10-13T12:00:00Z'), order = []
  for (let k = 0; order.length < 4 && k < 40; k++) {
    const out = await sweepLifecycleEvidence(db, { accountId: DEMO, host: 'h' }, { now: t0 + k * 31 * 60_000, getPositionDeals: async pid => answer(pid) })
    if (out.class === 'filled') order.push(out.positionId)
  }
  assert.equal(order.filter(p => p === '8001').length, 2, JSON.stringify(order))
  assert.equal(order.filter(p => p === '8002').length, 2, JSON.stringify(order))
})
