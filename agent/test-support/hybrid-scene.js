// Codex · №12,323 · 2026-10-09; codex-footprint: real hybrid tick integration fixture.
// Existing actual DB/enrolment/broker-boundary scene; no live requests.
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { runMomentumPartialPass } from '../services/momentum-partial-runtime.js'
import { readPartialPlan } from '../services/momentum-partial-manager.js'
import { makeMomentumPartialBroker } from '../services/momentum-partial-broker.js'
const AT = 1791460800000
export function scene(t, { side = 'BUY', live = false, volume = 10000, step = 100, path = ':memory:' } = {}) {
  const f = { db: initDB(path), at: AT, volume, step, closes: [], reads: [], side, reply: null,
    entry: 100, sl: side === 'BUY' ? 98 : 102, tp: side === 'BUY' ? 140 : 60,
    bid: side === 'BUY' ? 120 : 79.9, ask: side === 'BUY' ? 120.1 : 80 }
  t.after(() => { try { f.db.close() } catch { /* reopened/closed by test */ } })
  f.host = live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
  f.creds = { accountId: '42', host: f.host, ready: true, clientId: 'fixture', clientSecret: 'fixture', accessToken: 'fixture' }
  f.db.prepare("INSERT INTO accounts(account_id,is_live,enabled,mode) VALUES ('42',?,1,'active')").run(live ? 1 : 0)
  f.db.prepare(`INSERT INTO entry_intents(id,account_id,environment,symbol,symbol_id,side,order_type,volume,producer_id,basis,mode_epoch,
    permit_id,permit_expires_at,state,broker_order_id,broker_position_id,risk_event_id)
    VALUES('entry-7','42',?,'EURUSD',22,?,'MARKET',?,'analysis','risk',1,'fixture-permit','2099-01-01','FILLED','55','33',1)`)
    .run(live ? 'live' : 'demo', side, volume)
  f.db.prepare(`INSERT INTO trades(id,symbol,side,status,account_id,origin,risk_event_id,entry_price,sl_price,tp_price,volume,
    strategy,label_strategy,ctrader_position_id,intent_id,source)
    VALUES(7,'EURUSD',?,'open','42','bot_market_dispatch',1,100,?,?,0.01,'ema_pullback','ema_pullback','33','entry-7','autopilot')`)
    .run(side, side === 'BUY' ? 90 : 110, f.tp)
  f.db.prepare(`INSERT INTO monitored_positions(id,trade_id,account_id,symbol,side,entry_price,current_sl,current_tp,initial_risk,
    strategy,source,status,paused) VALUES(8,7,'42','EURUSD',?,100,?,?,10,'ema_pullback','autopilot','active',0)`)
    .run(side === 'BUY' ? 'long' : 'short', f.sl, f.tp)
  const check = args => { assert.equal(args[0], f.host); assert.equal(String(args[4]), '42') }
  f.opening = { dealId: '1', orderId: '55', positionId: '33', symbolId: '22', tradeSide: side, dealStatus: 'FILLED',
    volume, filledVolume: volume, executionPrice: 100, executionTimestamp: AT - 100000 }
  f.transports = {
    now: () => f.at, readCredentials: () => f.creds,
    symbols: async (...args) => { check(args); assert.deepEqual(args[5], ['22']); f.reads.push('symbols');
      return { ctidTraderAccountId: '42', symbol: [{ symbolId: '22', digits: 2, minVolume: 100, stepVolume: f.step }] } },
    reconcile: async (...args) => { check(args); f.reads.push('position'); return {
      ctidTraderAccountId: '42', position: [{ positionId: '33', positionStatus: 'POSITION_STATUS_OPEN', price: 100,
        stopLoss: f.sl, takeProfit: f.tp, tradeData: { symbolId: '22', tradeSide: side, volume: f.volume } }],
    } },
    deals: async (...args) => { check(args); f.reads.push('deals'); return { ctidTraderAccountId: '42', hasMore: false, deal: [f.opening] } },
    quote: async (c, symbol) => { assert.equal(c.accountId, '42'); assert.equal(symbol, '22');
      return { ctidTraderAccountId: '42', symbolId: '22', bid: Math.round(f.bid * 100000), ask: Math.round(f.ask * 100000), timestamp: f.at - 1 } },
    close: async (c, order) => {
      assert.equal(c.accountId, '42'); assert.equal(c.host, f.host)
      assert.equal(readPartialPlan(f.db, '42', 7).state, 'SENDING', 'claim must be durable before send')
      f.closes.push(order)
      if (f.reply) return f.reply(order)
      f.volume -= order.volume
      return f.fill(order.volume)
    },
  }
  f.fill = amount => ({ ctidTraderAccountId: '42', executionType: 'ORDER_FILLED', deal: {
    dealId: '44', orderId: '66', positionId: '33', symbolId: '22', tradeSide: side === 'BUY' ? 'SELL' : 'BUY', dealStatus: 'FILLED',
    volume: amount, filledVolume: amount, executionPrice: side === 'BUY' ? f.bid : f.ask,
    executionTimestamp: f.at, closePositionDetail: { entryPrice: 100, closedVolume: amount },
  } })
  f.adapter = () => makeMomentumPartialBroker(f.db, { identity: { host: f.host, accountId: '42', symbolId: '22' }, tradeId: 7 }, f.transports)
  f.pass = () => runMomentumPartialPass(f.db, { credsFor: () => f.creds, now: () => f.at,
    deps: { hybridEnrolment: { transports: f.transports }, adapterFor: () => f.adapter() } })
  f.events = () => f.db.prepare("SELECT * FROM position_events WHERE trade_id=7 AND kind='scale_out'").all()
  return f
}
