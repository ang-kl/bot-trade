// node --test agent/lib/deal-money.test.js
//
// V3 B1 (P5b-1). The money one closing deal carries, and whether a full close
// may write it on its own row. Behaviour, not source: the loop's FULL_EXIT
// calls exactly these two functions (pinned separately, comments stripped, in
// pnl-lifecycle-guard.test.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { closeDealMoney, fullCloseMoney, openedVolumeOnRecord } from './deal-money.js'
import { reconcilePositions } from '../services/reconciler.js'

test('closeDealMoney: signed gross + swap + commission at the deal\'s own moneyDigits', () => {
  // A positive swap is a CREDIT and is added. The old loop formula
  // (gross − |commission| − |swap|)/100 booked it as a cost: 12.00 here.
  assert.deepEqual(closeDealMoney({ grossProfit: 1500, swap: 200, commission: -100, moneyDigits: 2 }),
    { gross: 15, swap: 2, commission: -1, net: 16 })
  // moneyDigits 3: the scale is the deal's, not a hardcoded 100.
  assert.deepEqual(closeDealMoney({ grossProfit: 12345, swap: -5, commission: -40, moneyDigits: 3 }),
    { gross: 12.345, swap: -0.005, commission: -0.04, net: 12.3 })
  // Omitted zero swap/commission (protobuf JSON drops defaults) are zero.
  assert.deepEqual(closeDealMoney({ grossProfit: -291, moneyDigits: 2 }), { gross: -2.91, swap: 0, commission: 0, net: -2.91 })
  // pnlConversionFee is not part of net (one treatment on every path).
  assert.equal(closeDealMoney({ grossProfit: 100, moneyDigits: 2, pnlConversionFee: -7 }).net, 1)
})

test('closeDealMoney: missing or unreadable fields give null, never a guessed figure', () => {
  for (const cpd of [null, undefined, {}, { grossProfit: 100 }, { grossProfit: 100, moneyDigits: 11 },
    { grossProfit: 100, moneyDigits: 2.5 }, { moneyDigits: 2 }, { grossProfit: '1e3', moneyDigits: 2 },
    { grossProfit: 1.5, moneyDigits: 2 }, { grossProfit: 100, swap: 'x', moneyDigits: 2 },
    { grossProfit: 100, commission: 0.5, moneyDigits: 2 }]) {
    assert.equal(closeDealMoney(cpd), null, JSON.stringify(cpd))
  }
})

const deal = (closedVolume, extra = {}) => ({ dealId: 3, executionPrice: 0.61,
  closePositionDetail: { grossProfit: 291, swap: 0, commission: 0, moneyDigits: 2, closedVolume, ...extra } })

test('fullCloseMoney: the one deal is written only when it closes the WHOLE opened volume', () => {
  const whole = fullCloseMoney(deal(100_000), { openedVolume: 100_000 })
  assert.equal(whole.money.net, 2.91); assert.equal(whole.reason, null)
  // #714 NZDUSD: two partials of 100.27 and 99.53 went first; the final deal
  // closed a third of what was opened. Its 2.91 is not the position's money.
  const partial = fullCloseMoney(deal(100_000), { openedVolume: 300_000 })
  assert.equal(partial.money, null)
  assert.match(partial.reason, /partial lifecycle: this deal closed 100000 of 300000 opened/)
  assert.equal(fullCloseMoney(deal(300_001), { openedVolume: 300_000 }).money, null, 'more closed than opened is contradictory evidence')
  for (const openedVolume of [undefined, null, 0, -1, 1.5, '1e5']) {
    assert.equal(fullCloseMoney(deal(100_000), { openedVolume }).money, null, `opened ${openedVolume}`)
  }
  assert.equal(fullCloseMoney(deal(undefined), { openedVolume: 100_000 }).money, null, 'no closed volume, no proof')
  assert.equal(fullCloseMoney({ closePositionDetail: { closedVolume: 1, moneyDigits: 2 } }, { openedVolume: 1 }).money, null)
  assert.equal(fullCloseMoney(undefined, { openedVolume: 1 }).money, null)
})

function db() {
  const d = initDB(':memory:')
  d.prepare(`INSERT INTO trades (id, account_id, symbol, side, status, ctrader_position_id) VALUES (714, '46130058', 'NZDUSD', 'BUY', 'open', '231000714')`).run()
  d.prepare(`INSERT INTO monitored_positions (id, symbol, side, status, trade_id, account_id) VALUES (9, 'NZDUSD', 'long', 'active', 714, '46130058')`).run()
  return d
}
const args = extra => ({ accountId: '46130058', positionId: '231000714', tradeId: 714, monitoredId: 9, heldVolume: 100_000, ...extra })

test('openedVolumeOnRecord: the held volume when no earlier partial is on record', () => {
  const d = db()
  assert.equal(openedVolumeOnRecord(d, args()), 100_000)
  assert.equal(openedVolumeOnRecord(d, args({ heldVolume: null })), null, 'a volume not read from the broker snapshot is not evidence')
  assert.equal(openedVolumeOnRecord(d, args({ heldVolume: 0 })), null)
})

test('openedVolumeOnRecord: any partial writer on record makes the opened volume unknown', () => {
  // The bot's PARTIAL_EXIT, the keeper and the trade guard write scale_out —
  // by trade id or by account + position, in units that differ by writer.
  const byTrade = db()
  byTrade.prepare(`INSERT INTO position_events (trade_id, symbol, kind, to_value) VALUES (714, 'NZDUSD', 'scale_out', 0.5)`).run()
  assert.equal(openedVolumeOnRecord(byTrade, args()), null)
  const byPosition = db()
  byPosition.prepare(`INSERT INTO position_events (account_id, position_id, symbol, kind, to_value) VALUES ('46130058', '231000714', 'NZDUSD', 'scale_out', 50000)`).run()
  assert.equal(openedVolumeOnRecord(byPosition, args({ tradeId: null })), null)
  // Another account's event on the same position id is not this position's.
  const other = db()
  other.prepare(`INSERT INTO position_events (account_id, position_id, symbol, kind, to_value) VALUES ('999', '231000714', 'NZDUSD', 'scale_out', 50000)`).run()
  assert.equal(openedVolumeOnRecord(other, args({ tradeId: null })), 100_000)
  // The keeper / trade guard flag.
  const flagged = db()
  flagged.prepare('UPDATE monitored_positions SET scaled_out = 1 WHERE id = 9').run()
  assert.equal(openedVolumeOnRecord(flagged, args()), null)
  // The P0 partial manager writes no position event: its plan past ARMED is the evidence.
  const planned = db()
  planned.exec(`CREATE TABLE momentum_partial_plans (account_id TEXT, trade_id INTEGER, position_id TEXT, state TEXT)`)
  planned.prepare(`INSERT INTO momentum_partial_plans VALUES ('46130058', 714, '231000714', 'ARMED')`).run()
  assert.equal(openedVolumeOnRecord(planned, args()), 100_000, 'an ARMED plan has not closed anything')
  for (const state of ['SENDING', 'AMBIGUOUS', 'RECEIVED', 'CONFIRMED']) {
    planned.prepare('UPDATE momentum_partial_plans SET state = ?').run(state)
    assert.equal(openedVolumeOnRecord(planned, args()), null, state)
  }
})

test('the #714 close, end to end over the decision: the final deal after two partials writes NULL', () => {
  const d = db()
  d.prepare(`INSERT INTO position_events (trade_id, account_id, position_id, symbol, kind, to_value) VALUES (714, '46130058', '231000714', 'NZDUSD', 'scale_out', 100000)`).run()
  const openedVolume = openedVolumeOnRecord(d, args())
  const { money, reason } = fullCloseMoney(deal(100_000), { openedVolume })
  assert.equal(money, null)
  assert.match(reason, /opened volume unknown/)
})

// ---------------------------------------------------------------------------
// A partial made by hand in cTrader (B1 checker blocker): the reconciler's
// tamper watch is the only local record of it, on every account's pass.
// ---------------------------------------------------------------------------

const brokerPos = volume => ({ positionId: 231000714, symbolName: 'NZDUSD', price: 0.6, stopLoss: null, takeProfit: null,
  tradeData: { positionId: 231000714, symbolId: 1, tradeSide: 'BUY', openPrice: 0.6, volume } })
const pass = (d, volume, accountId = '46130058') => reconcilePositions(d, [brokerPos(volume)], [], () => {}, { accountId })

test('a manual partial seen by the tamper watch makes the later full close write NULL money', () => {
  const d = db()
  pass(d, 30_000_000)                      // baseline: 300,000 units
  const seen = pass(d, 20_000_000)         // the owner closed 100,000 in cTrader
  assert.deepEqual(seen.manualChanges, [{ kind: 'volume', symbol: 'NZDUSD', positionId: '231000714', from: 300_000, to: 200_000 }])
  const ev = d.prepare(`SELECT account_id, position_id, trade_id, kind, from_value, to_value, source FROM position_events`).all()
  assert.deepEqual(ev, [{ account_id: '46130058', position_id: '231000714', trade_id: 714, kind: 'volume_reduced',
    from_value: 300_000, to_value: 200_000, source: 'reconciler' }])
  // The FULL_EXIT that follows closes what the broker holds: 200,000 of the
  // 300,000 opened. Before this, held = closed and its one deal was written.
  const openedVolume = openedVolumeOnRecord(d, args({ heldVolume: 200_000 }))
  assert.equal(openedVolume, null)
  assert.equal(fullCloseMoney(deal(200_000), { openedVolume }).money, null)
  // By account + position alone too (a row the loop reaches without its trade id).
  assert.equal(openedVolumeOnRecord(d, args({ tradeId: null, heldVolume: 200_000 })), null)
  // An observation does not advance the management state.
  assert.equal(d.prepare(`SELECT state_to FROM position_events`).get().state_to, 'opened')
})

test('a volume that ROSE, or did not change, is not a partial: the full close still writes its deal', () => {
  const d = db()
  pass(d, 10_000_000)
  pass(d, 10_000_000)
  pass(d, 30_000_000)                      // added to by hand: the final deal closes it all
  assert.equal(d.prepare(`SELECT COUNT(*) n FROM position_events`).get().n, 0)
  const openedVolume = openedVolumeOnRecord(d, args({ heldVolume: 300_000 }))
  assert.equal(openedVolume, 300_000)
  assert.equal(fullCloseMoney(deal(300_000), { openedVolume }).money.net, 2.91)
})

test('the evidence is written on a non-primary account\'s pass, under that account', () => {
  const d = db()
  d.prepare(`INSERT INTO agent_state (key, value) VALUES ('ctrader_account_id', '999')`).run()
  pass(d, 30_000_000); pass(d, 20_000_000)
  assert.equal(d.prepare(`SELECT account_id FROM position_events WHERE kind = 'volume_reduced'`).get().account_id, '46130058')
  assert.equal(openedVolumeOnRecord(d, args({ tradeId: null, heldVolume: 200_000 })), null)
  // Another account's observation on the same position id is not this position's.
  assert.equal(openedVolumeOnRecord(d, args({ accountId: '999', tradeId: null, heldVolume: 200_000 })), 200_000)
})
