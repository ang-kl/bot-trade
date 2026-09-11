// node --test agent/services/adaptive-breaker.test.js
//
// Adaptive breaker: a per-strategy loss streak triggers ADAPTATION through
// the stage matrix (disarm the strategy / arm the next filter) instead of a
// human-style pause. Acts once per streak; a win resets the count.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { runAdaptiveBreaker, strategyLossStreak, loadAdaptiveBreakerConfig, DEFAULT_ADAPTIVE_BREAKER } from './adaptive-breaker.js'
import { loadStageMatrix, setStage, armedTradeKeys, FILTER_DEFS, disarmStrategyEverywhere } from './stage-matrix.js'

function closeTrade(db, strategy, pnl, minutesAgo = 0) {
  db.prepare(
    `INSERT INTO trades (symbol, side, status, net_pnl, label_strategy, opened_at, closed_at)
     VALUES ('EURUSD', 'BUY', 'closed', ?, ?, datetime('now', ?), datetime('now', ?))`
  ).run(pnl, strategy, `-${minutesAgo + 30} minutes`, `-${minutesAgo} minutes`)
}

test('defaults: on at streak 3; streak clamps 2..10', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadAdaptiveBreakerConfig(db), DEFAULT_ADAPTIVE_BREAKER)
  setState(db, 'adaptive_breaker_json', JSON.stringify({ on: true, streak: 99 }))
  assert.equal(loadAdaptiveBreakerConfig(db).streak, 10)
})

test('strategyLossStreak counts leading losses only', () => {
  const db = initDB(':memory:')
  closeTrade(db, 'fib_618_fade', +5, 40) // older win
  closeTrade(db, 'fib_618_fade', -1, 30)
  closeTrade(db, 'fib_618_fade', -1, 20)
  closeTrade(db, 'fib_618_fade', -1, 10)
  assert.equal(strategyLossStreak(db, 'fib_618_fade').streak, 3)
  closeTrade(db, 'fib_618_fade', +2, 0)  // newest win resets
  assert.equal(strategyLossStreak(db, 'fib_618_fade').streak, 0)
})

test('streak on a strategy with OTHERS armed → that strategy is disarmed', () => {
  const db = initDB(':memory:')
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade', 'ema_pullback']))
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  const notes = []
  const out = runAdaptiveBreaker(db, { notify: (t) => notes.push(t) })
  assert.deepEqual(out.actions, [{ strategy: 'fib_618_fade', streak: 3, did: 'disarmed_strategy', scopes: ['global'], heldPinned: [], ownVerdictScopes: [] }])
  const m = loadStageMatrix(db, getState)
  assert.equal(m.strategies.find(s => s.key === 'fib_618_fade').stages.trade, false)
  assert.equal(m.strategies.find(s => s.key === 'ema_pullback').stages.trade, true)
  assert.match(notes[0], /disarmed at Auto Trade/)
})

test('NEVER-ZERO invariant: streak on the LAST armed strategy → next filter armed, strategy stays live', () => {
  const db = initDB(':memory:')
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade'])) // fib as the sole armed strategy
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  const out = runAdaptiveBreaker(db, {})
  assert.deepEqual(out.actions, [{ strategy: 'fib_618_fade', streak: 3, did: 'armed_filter', filter: 'vwap' }])
  const m = loadStageMatrix(db, getState)
  assert.equal(m.strategies.find(s => s.key === 'fib_618_fade').stages.trade, true, 'last strategy stays live (never zero armed)')
  assert.equal(m.filters.find(f => f.key === 'vwap').stages.trade, true, 'VWAP filter armed to tighten entries')
})

test('LAST armed strategy with every filter already armed → HELD, never disarmed to zero', () => {
  const db = initDB(':memory:')
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade'])) // fib as the sole armed strategy
  // Arm all confluence filters up front so the ladder is exhausted.
  for (const f of FILTER_DEFS) setStage(db, { kind: 'filter', key: f.key, stage: 'trade', on: true }, { getState, setState })
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  const out = runAdaptiveBreaker(db, {})
  assert.deepEqual(out.actions, [{ strategy: 'fib_618_fade', streak: 3, did: 'held_last_strategy' }])
  const m = loadStageMatrix(db, getState)
  assert.equal(m.strategies.find(s => s.key === 'fib_618_fade').stages.trade, true, 'last strategy is NOT disarmed to zero')
})

test('acts ONCE per streak; a new loss re-triggers (filter ladder)', () => {
  const db = initDB(':memory:')
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade'])) // fib as the sole armed strategy
  for (const m of [20, 10, 5]) closeTrade(db, 'fib_618_fade', -1, m)
  assert.equal(runAdaptiveBreaker(db, {}).actions.length, 1) // arms vwap (rsi already on by default)
  assert.equal(runAdaptiveBreaker(db, {}).actions.length, 0) // same streak — no repeat
  closeTrade(db, 'fib_618_fade', -1, 0)                      // 4th loss = new information
  const out = runAdaptiveBreaker(db, {})
  assert.deepEqual(out.actions[0], { strategy: 'fib_618_fade', streak: 4, did: 'armed_filter', filter: 'fvg' })
})

test('a disarm reaches per-account trade pins, not just the global list', () => {
  // 2026-08-31: the breaker disarmed donchian_breakout globally while three
  // accounts kept it armed via overlay pins and proposed it for days. The
  // disarm must land wherever the strategy is armed — except a scope where it
  // is the LAST armed strategy, which holds (never-go-dark, per scope).
  const db = initDB(':memory:')
  // PR-B (owner principle 1): an explicit trade:true cell is the owner's
  // word on EVERY scope, live included, so the breaker HOLDS it and names it;
  // the global list is disarmed, and a scope that only inherits the global
  // list (no cell of its own) follows that disarm. The helper itself, run
  // without the exemption, still reaches every pin (pinned below).
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('111','1',1,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('222','2',1,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('555','5',1,1,'active')`).run() // inherits global
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade', 'ema_pullback']))
  const io = { getState, setState }
  // 111 pins fib armed alongside another; 222 pins fib as its ONLY armed strategy.
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: true, accountId: '111' }, io)
  setStage(db, { kind: 'strategy', key: 'ema_pullback', stage: 'trade', on: true, accountId: '111' }, io)
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: true, accountId: '222' }, io)
  setStage(db, { kind: 'strategy', key: 'ema_pullback', stage: 'trade', on: false, accountId: '222' }, io)
  setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: false, accountId: '222' }, io)
  setStage(db, { kind: 'strategy', key: 'rsi2_reversion', stage: 'trade', on: false, accountId: '222' }, io)
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  const out = runAdaptiveBreaker(db, {})
  assert.equal(out.actions[0].did, 'disarmed_strategy')
  assert.deepEqual(out.actions[0].scopes.sort(), ['global'])
  assert.deepEqual(out.actions[0].heldPinned, ['111'], 'the live hand pin is held and named (222 is last-armed there, held by never-go-dark first)')
  assert.equal(armedTradeKeys(db, getState, null).has('fib_618_fade'), false, 'global disarmed')
  assert.equal(armedTradeKeys(db, getState, '555').has('fib_618_fade'), false, 'a scope inheriting the global list follows the disarm')
  assert.equal(armedTradeKeys(db, getState, '111').has('fib_618_fade'), true, 'PR-B: the live pin holds — RED if the exemption regains its environment term')
  assert.equal(armedTradeKeys(db, getState, '222').has('fib_618_fade'), true, 'last-armed scope holds — never to zero')
  // The helper without the exemption reaches the pin (the never-go-dark scope still holds).
  const plain = disarmStrategyEverywhere(db, io, 'fib_618_fade')
  assert.deepEqual([...plain], ['111'])
  assert.equal(armedTradeKeys(db, getState, '111').has('fib_618_fade'), false)
})

test('a HAND-PINNED DEMO arm is held by the breaker; the global list and a live pin are still disarmed (owner, 03-09-2026)', () => {
  // 21:11 SGT 02-09: two minutes after the demo split pinned rsi2 on
  // ACCT-DEMO-4 to measure it, the breaker disarmed it there. The split's
  // point is to record the loss, so a scope with an explicit trade:true
  // cell holds — on demo AND on live (PR-B, owner principle 1); the disarm
  // still reaches the global list and every scope inheriting it.
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('111','1',0,1,'active')`).run() // demo, pinned
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('333','3',1,1,'active')`).run() // LIVE, pinned
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('444','4',0,1,'active')`).run() // demo, inherits global
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade', 'ema_pullback']))
  const io = { getState, setState }
  for (const a of ['111', '333']) {
    setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: true, accountId: a }, io)
    setStage(db, { kind: 'strategy', key: 'ema_pullback', stage: 'trade', on: true, accountId: a }, io)
  }
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  const out = runAdaptiveBreaker(db, {})
  assert.equal(out.actions[0].did, 'disarmed_strategy')
  assert.deepEqual(out.actions[0].scopes.sort(), ['global'])
  assert.deepEqual(out.actions[0].heldPinned, ['111', '333'], 'the demo AND the live hand pin are held and named')
  assert.equal(armedTradeKeys(db, getState, null).has('fib_618_fade'), false, 'global disarmed')
  assert.equal(armedTradeKeys(db, getState, '333').has('fib_618_fade'), true, 'PR-B: a hand-pinned LIVE arm holds — RED if the exemption regains its !isLive term')
  assert.equal(armedTradeKeys(db, getState, '111').has('fib_618_fade'), true, 'the hand-pinned demo arm holds')
  assert.equal(armedTradeKeys(db, getState, '444').has('fib_618_fade'), false, 'a demo scope inheriting the global list follows the global disarm')
  // The exemption is a breaker choice, not the helper's default.
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade', 'ema_pullback']))
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: true, accountId: '111' }, io)
  const plain = disarmStrategyEverywhere(db, io, 'fib_618_fade')
  assert.ok(plain.includes('111'), 'without the flag the pin is disarmed as before')
})

test('a streak on a strategy armed ONLY by a LIVE account pin still triggers the breaker — the action is recorded and the pin is held (PR-B)', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('111','1',1,1,'active')`).run()
  setState(db, 'enabled_strategies_json', JSON.stringify(['ema_pullback'])) // fib globally OFF
  const io = { getState, setState }
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: true, accountId: '111' }, io)
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  const out = runAdaptiveBreaker(db, {})
  assert.equal(out.actions.length, 1, 'globally-off but pin-armed must not be invisible to the breaker')
  assert.deepEqual(out.actions[0].scopes, [])
  assert.deepEqual(out.actions[0].heldPinned, ['111'], 'the owner\'s pin on a live scope is held and named')
  assert.equal(armedTradeKeys(db, getState, '111').has('fib_618_fade'), true)
})

test('off → no actions even with a streak', () => {
  const db = initDB(':memory:')
  setState(db, 'adaptive_breaker_json', JSON.stringify({ on: false }))
  for (const m of [20, 10, 0]) closeTrade(db, 'fib_618_fade', -1, m)
  assert.equal(runAdaptiveBreaker(db, {}).skipped, 'off')
})

test('a broker-side close with net_pnl still NULL does not END the streak (02-09-2026)', () => {
  // The freshest stop-out lands with NULL money until the paced backfill
  // fills it. `(null ?? 0) < 0` read that as "not a loss" and stopped the
  // count at the exact trade that should have extended it.
  const db = initDB(':memory:')
  const ins = (net, minsAgo) => db.prepare(
    `INSERT INTO trades (symbol, side, status, label_strategy, net_pnl, closed_at) VALUES ('X','BUY','closed','fib_618_fade',?, datetime('now', ?))`
  ).run(net, `-${minsAgo} minutes`)
  ins(null, 1)   // newest: broker-side, money not yet filled
  ins(-5, 10)
  ins(-7, 20)
  ins(-9, 30)
  ins(4, 40)
  const s = strategyLossStreak(db, 'fib_618_fade')
  assert.equal(s.streak, 3, 'unknown money is skipped, not counted as a win')
  // A known win still ends it.
  ins(3, 0)
  assert.equal(strategyLossStreak(db, 'fib_618_fade').streak, 0)
})

// PR-B checker (11-09-2026): with `_all` pins every enabled account carries
// an explicit trade:true for every strategy, and an exemption that held every
// pin left the breaker unable to disarm anything anywhere. The pin holds
// against the POOLED verdict; the account whose OWN closes carry the streak
// has its cell written false.
function closeTradeOn(db, strategy, accountId, pnl, minutesAgo = 0) {
  db.prepare(
    `INSERT INTO trades (symbol, side, status, net_pnl, label_strategy, account_id, opened_at, closed_at)
     VALUES ('EURUSD', 'BUY', 'closed', ?, ?, ?, datetime('now', ?), datetime('now', ?))`
  ).run(pnl, strategy, accountId, `-${minutesAgo + 30} minutes`, `-${minutesAgo} minutes`)
}
function pinEveryAccount(db, io, ids, keys) {
  for (const id of ids) for (const k of keys) setStage(db, { kind: 'strategy', key: k, stage: 'trade', on: true, accountId: id }, io)
}

test('production shape (every account pinned): a 3-loss streak on account X\'s OWN closes disarms X\'s cell and holds the other pins; a pooled-only streak holds every pin', () => {
  const db = initDB(':memory:')
  const ids = ['111', '222', '333']
  for (const [id, live] of [['111', 1], ['222', 0], ['333', 0]]) db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, ?, 1, 'active')`).run(id, id, live)
  setState(db, 'enabled_strategies_json', JSON.stringify(['fib_618_fade', 'ema_pullback', 'vwap_trend']))
  const io = { getState, setState }
  pinEveryAccount(db, io, ids, ['fib_618_fade', 'ema_pullback', 'vwap_trend'])
  // Three losses on the LIVE account 111 alone.
  for (const m of [20, 10, 0]) closeTradeOn(db, 'fib_618_fade', '111', -1, m)
  const out = runAdaptiveBreaker(db, {})
  assert.equal(out.actions.length, 1)
  assert.equal(out.actions[0].did, 'disarmed_strategy')
  assert.deepEqual(out.actions[0].ownVerdictScopes, ['111'])
  assert.deepEqual(out.actions[0].scopes.sort(), ['111', 'global'], 'RED if the pin holds against the account\'s own streak')
  assert.deepEqual(out.actions[0].heldPinned, ['222', '333'], 'the other pins hold')
  assert.equal(armedTradeKeys(db, getState, '111').has('fib_618_fade'), false, 'X\'s own cell written false')
  assert.equal(armedTradeKeys(db, getState, '222').has('fib_618_fade'), true)
  assert.equal(armedTradeKeys(db, getState, '333').has('fib_618_fade'), true)
  assert.equal(armedTradeKeys(db, getState, null).has('fib_618_fade'), false, 'global list disarmed')
  // A POOLED streak (one loss on each of three accounts, no account with its own streak) holds every pin.
  const db2 = initDB(':memory:')
  for (const id of ids) db2.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')`).run(id, id)
  setState(db2, 'enabled_strategies_json', JSON.stringify(['fib_618_fade', 'ema_pullback']))
  pinEveryAccount(db2, io, ids, ['fib_618_fade', 'ema_pullback'])
  closeTradeOn(db2, 'fib_618_fade', '111', -1, 20); closeTradeOn(db2, 'fib_618_fade', '222', -1, 10); closeTradeOn(db2, 'fib_618_fade', '333', -1, 0)
  const pooled = runAdaptiveBreaker(db2, {})
  assert.equal(pooled.actions.length, 1)
  assert.deepEqual(pooled.actions[0].ownVerdictScopes, [])
  assert.deepEqual(pooled.actions[0].scopes, ['global'])
  assert.deepEqual(pooled.actions[0].heldPinned, ids)
  for (const id of ids) assert.equal(armedTradeKeys(db2, getState, id).has('fib_618_fade'), true, `${id}: pooled verdict holds the pin`)
  // strategyLossStreak scoped to an account reads that account's closes only.
  assert.equal(strategyLossStreak(db2, 'fib_618_fade', 12, { accountId: '111' }).streak, 1)
  assert.equal(strategyLossStreak(db2, 'fib_618_fade').streak, 3)
})
