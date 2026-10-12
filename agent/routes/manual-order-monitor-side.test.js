// node --test agent/routes/manual-order-monitor-side.test.js
//
// Claude · № 13,782 12-Oct (demo stress run, defect D3; owner "Writer +
// re-strategize"; claude-builder)
//
// MEASURED 12-10-2026 on demo 43097342 (the selected account). Manual orders
// #1806 DOW.US and #1807 GER40 filled at 13:33Z through POST
// /actions/manual-order. Both manual writers stored the monitor row's side as
// the ORDER side, 'BUY'/'SELL', where every other writer (loop.js, adoption,
// the pending fill) stores the POSITION side, 'long'/'short'. The 13:36:05Z
// reconcile compared 'BUY' with the broker's 'long', called each a REVERSAL,
// logged "⚠️ MANUAL CHANGE … REVERSED … Original thesis no longer applies",
// alerted the owner on Telegram and ran re-strategize, which tried to amend
// both positions' SL/TP at the broker (refused). Through the real writers and
// the real reconciler.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { recordManualOrderTrade, writeAheadAnalysisTrade, settleAnalysisTrade } from './actions.js'
import { reconcilePositions } from '../services/reconciler.js'

const A = '43097342'
function fresh() {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')").run(A, A)
  setState(db, 'ctrader_account_id', A) // the selected account: the pass that alerts and re-strategizes
  return db
}
const setAcct = (db) => (k, v) => setState(db, k, v)
const brokerPos = (positionId, symbolName, tradeSide, price, sl, tp, symbolId = 10283) => ({
  positionId, symbolName, price, stopLoss: sl, takeProfit: tp,
  tradeData: { positionId, symbolId, tradeSide, openPrice: price, volume: 508000, label: 'MAN|v1|VP|-|NY|-|-' },
})
const side = (db, tradeId) => db.prepare(`SELECT side FROM monitored_positions WHERE trade_id = ? AND status = 'active'`).get(tradeId).side

test('manual-order rows are written long/short, and the next reconcile sees no reversal', () => {
  const db = fresh()
  const buy = recordManualOrderTrade(db, { symbol: 'DOW.US', side: 'BUY', entryP: 28.28, entryEstimate: 28.48, sl: 27.93, tp: 30.48, volLots: 50.8, positionId: '248025157', structuredLabel: 'MAN|v1|VP|-|NY|-|-', accountId: A, strategy: 'vp_value' })
  const sell = recordManualOrderTrade(db, { symbol: 'NFLX.US', side: 'SELL', entryP: 70.28, sl: 70.4, tp: 69.98, volLots: 1, positionId: '248025999', structuredLabel: 'MAN|v1|DON|-|NY|-|-', accountId: A, strategy: 'donchian_breakout' })
  assert.equal(side(db, buy), 'long', 'RED before: the order side BUY was stored')
  assert.equal(side(db, sell), 'short')
  // The trade row keeps the order side, as every writer does.
  assert.equal(db.prepare('SELECT side FROM trades WHERE id = ?').get(buy).side, 'BUY')
  const r = reconcilePositions(db, [brokerPos('248025157', 'DOW.US', 'BUY', 28.28, 27.93, 30.48), brokerPos('248025999', 'NFLX.US', 'SELL', 70.28, 70.4, 69.98, 10301)], [], setAcct(db), { readAt: Date.now() })
  assert.deepEqual(r.manualChanges.filter(c => c.kind === 'reversed'), [], 'RED before: both were called REVERSED (BUY→long, SELL→short)')
})

test('execute-analysis rows are written long/short too, and the next reconcile sees no reversal', () => {
  const db = fresh()
  const id = writeAheadAnalysisTrade(db, { symbol: 'GER40', side: 'SELL', entry: 25296.8, sl: 25380, tp: 25100, volLots: 0.2, accountId: A, strategy: 'donchian_breakout' })
  settleAnalysisTrade(db, id, { symbol: 'GER40', side: 'SELL', entryP: 25283.6, entry: 25296.8, sl: 25380, tp: 25100, volLots: 0.2, positionId: '248025168', label: 'MAN|v1|DON|-|NY|-|-', accountId: A, strategy: 'donchian_breakout' })
  assert.equal(side(db, id), 'short', 'RED before: the order side SELL was stored')
  const r = reconcilePositions(db, [brokerPos('248025168', 'GER40', 'SELL', 25283.6, 25380, 25100, 10006)], [], setAcct(db), { readAt: Date.now() })
  assert.deepEqual(r.manualChanges.filter(c => c.kind === 'reversed'), [])
})

test('a genuine reversal at the broker is still caught, and names the symbol this account holds it under', () => {
  const db = fresh()
  const id = recordManualOrderTrade(db, { symbol: 'GER40', side: 'BUY', entryP: 25283.6, sl: 25214, tp: 25521.8, volLots: 0.2, positionId: '248025168', structuredLabel: 'MAN|v1|DON|-|NY|-|-', accountId: A, strategy: 'donchian_breakout' })
  const r = reconcilePositions(db, [brokerPos('248025168', 'GER40', 'SELL', 25283.6, 25380, 25100, 10006)], [], setAcct(db), { readAt: Date.now() })
  const rev = r.manualChanges.filter(c => c.kind === 'reversed')
  assert.deepEqual(rev.map(c => [c.positionId, c.from, c.to, c.symbolId]), [['248025168', 'long', 'short', 10006]])
  assert.equal(side(db, id), 'short')
})
