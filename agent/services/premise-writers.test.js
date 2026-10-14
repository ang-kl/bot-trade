// ---------------------------------------------------------------------------
// premise-writers.test.js — Claude · № 14,745 15-Oct (owner order § 14,741·A
// PR-1; owner choices § 14,744: tick-fired, frozen at entry, the pad requires a
// premise; claude-builder).
//
// Real schema (in-memory SQLite), the real reconciler, the real manual-order
// writer, the real synth builder and the real monitor. Expected outcomes:
//  · every monitored row carries a trigger the monitor either reads
//    (`price<X`/`price>X`) or that names why there is none — the 14-10
//    inventory found 55 of 55 autopilot rows reading `Close beyond swing
//    origin undefined` (§ 14,743·A, production records);
//  · the monitor closes on the premise with reason `premise_invalidated`, and
//    never widens a stop on a losing position (the trader's rule, § 14,740·A).
// ---------------------------------------------------------------------------
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { reconcilePositions } from './reconciler.js'
import { recordManualOrderTrade } from '../routes/actions.js'
import { synthesizeFibSignal } from './fib-strategy.js'
import { evaluatePosition, DEFAULT_RULES, _internal } from './position-manager.js'
import { STRATEGY_KEYS } from './strategies.js'
import { isReadablePremise } from '../lib/premise.js'

const ACCT = '43097342'
const readable = (raw) => isReadablePremise(raw)
const explained = (raw) => /^(none_|unreadable:)/.test(String(raw))

test('the synth stamps every strategy a readable premise, or the reason there is none — never undefined', () => {
  for (const key of STRATEGY_KEYS) {
    const withPremise = synthesizeFibSignal('EURUSD', { bias: 'long', entry: 1.1, sl: 1.09, tp1: 1.13, tp2: 1.15, conviction: 9, rr: 3, timeframe: '1h', strategy: key, thesis: 't', invalidation: { op: '<', price: 1.095 } })
    assert.equal(withPremise.synthesis.invalidation_trigger, 'price<1.095', key)
    assert.ok(_internal.parsePriceTrigger(withPremise.synthesis.invalidation_trigger), `${key}: the monitor reads it`)
    const none = synthesizeFibSignal('EURUSD', { bias: 'long', entry: 1.1, sl: 1.09, tp1: 1.13, tp2: 1.15, conviction: 9, rr: 3, timeframe: '1h', strategy: key, thesis: 't' })
    assert.equal(none.synthesis.invalidation_trigger, `unreadable:${key}`)
    const outside = synthesizeFibSignal('EURUSD', { bias: 'long', entry: 1.1, sl: 1.09, tp1: 1.13, tp2: 1.15, conviction: 9, rr: 3, timeframe: '1h', strategy: key, thesis: 't', invalidation: null, invalidation_reason: 'outside_stop' })
    assert.equal(outside.synthesis.invalidation_trigger, 'unreadable:outside_stop')
    for (const s of [withPremise, none, outside]) assert.ok(!/undefined/.test(s.synthesis.invalidation_trigger))
  }
  // fib's own signal shape (swingA) carries its premise the same way
  const fib = synthesizeFibSignal('EURUSD', { bias: 'long', entry: 1.1, sl: 1.0895, tp1: 1.13, tp2: 1.15, conviction: 9, rr: 3, timeframe: '1h', strategy: 'fib_618_fade', thesis: 't', swingA: 1.09, swingB: 1.12, invalidation: { op: '<', price: 1.09 } })
  assert.equal(fib.synthesis.invalidation_trigger, 'price<1.09')
})

test('an adopted position is stamped none_adopted; a manual order its premise, or none_manual', () => {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', ACCT)
  reconcilePositions(db, [{ positionId: 7001, symbolName: 'EURUSD', price: 1.1, stopLoss: 1.09, takeProfit: 1.13,
    tradeData: { symbolId: 1, tradeSide: 'BUY', volume: 1_000_000, label: 'manual' } }], [], (k, v) => setState(db, k, v), { accountId: ACCT })
  const adopted = db.prepare(`SELECT invalidation_trigger FROM monitored_positions WHERE status = 'active'`).all()
  assert.equal(adopted.length, 1)
  assert.equal(adopted[0].invalidation_trigger, 'none_adopted')
  const withPremise = recordManualOrderTrade(db, { symbol: 'GBPUSD', side: 'BUY', entryP: 1.3, sl: 1.29, tp: 1.33, volLots: 0.1, positionId: '7002', structuredLabel: 'MAN|v1|-|-|-|-|-', accountId: ACCT, invalidationTrigger: 'price<1.295' })
  const without = recordManualOrderTrade(db, { symbol: 'GBPUSD', side: 'SELL', entryP: 1.3, sl: 1.31, tp: 1.27, volLots: 0.1, positionId: '7003', structuredLabel: 'MAN|v1|-|-|-|-|-', accountId: ACCT })
  const row = id => db.prepare(`SELECT invalidation_trigger FROM monitored_positions WHERE trade_id = ?`).get(id).invalidation_trigger
  assert.equal(row(withPremise), 'price<1.295')
  assert.equal(row(without), 'none_manual')
  for (const r of db.prepare(`SELECT invalidation_trigger t FROM monitored_positions`).all()) {
    assert.ok(readable(r.t) || explained(r.t), `every row is readable or explained: ${r.t}`)
  }
})

const pos = (o = {}) => ({ id: 1, symbol: 'EURUSD', side: 'long', entry_price: 1.1, current_sl: 1.09, current_tp: 1.13, initial_risk: 0.01,
  mfe_r: 0, mae_r: 0, be_moved: 0, scaled_out: 0, invalidation_trigger: null, time_cap_at: null, strategy: 'vwap_trend',
  created_at: new Date(Date.now() - 10 * 60_000).toISOString(), ...o })

test('the monitor closes on the premise before the stop, with an attributable reason; an explained absence never fires', () => {
  const fired = evaluatePosition(pos({ invalidation_trigger: 'price<1.095' }), { currentPrice: 1.0949, rules: DEFAULT_RULES })
  assert.equal(fired.action, 'FULL_EXIT')
  assert.match(fired.reason, /^premise_invalidated:price<1\.095/)
  const held = evaluatePosition(pos({ invalidation_trigger: 'price<1.095' }), { currentPrice: 1.0951, rules: DEFAULT_RULES })
  assert.notEqual(held.action, 'FULL_EXIT')
  for (const t of ['none_manual', 'none_adopted', 'unreadable:vwap_trend', 'unreadable:outside_stop', 'Close beyond swing origin undefined']) {
    const r = evaluatePosition(pos({ invalidation_trigger: t }), { currentPrice: 1.0905, rules: DEFAULT_RULES })
    assert.notEqual(r.action, 'FULL_EXIT', `${t} is not a trigger`)
  }
  // short mirror
  const s = evaluatePosition(pos({ side: 'short', entry_price: 1.1, current_sl: 1.11, current_tp: 1.07, invalidation_trigger: 'price>1.105' }), { currentPrice: 1.1051, rules: DEFAULT_RULES })
  assert.equal(s.action, 'FULL_EXIT')
})

test('no writer widens a stop on a losing position: every MOVE_SL the monitor returns is tighter than the stop it holds', () => {
  // Sweep losing and flat prices for both sides across the rule set the loop
  // runs (DEFAULT_RULES) — any MOVE_SL must be tighter (isTighter), never looser.
  for (const side of ['long', 'short']) {
    const p = side === 'long' ? pos() : pos({ side: 'short', entry_price: 1.1, current_sl: 1.11, current_tp: 1.07 })
    for (let i = 0; i <= 100; i++) {
      const price = side === 'long' ? 1.1 - 0.0001 * i : 1.1 + 0.0001 * i // 0R down to −1R
      const r = evaluatePosition({ ...p, mfe_r: 0 }, { currentPrice: price, rules: DEFAULT_RULES })
      if (r.action === 'MOVE_SL') assert.ok(_internal.isTighter(side, p.current_sl, r.newSL), `${side} @ ${price}: ${r.newSL} tighter than ${p.current_sl}`)
    }
  }
  // the guard itself: a looser stop is never "tighter"
  assert.equal(_internal.isTighter('long', 1.09, 1.08), false)
  assert.equal(_internal.isTighter('short', 1.11, 1.12), false)
  assert.equal(_internal.isTighter('long', 1.09, 1.095), true)
})
