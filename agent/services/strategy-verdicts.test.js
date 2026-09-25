// node --test agent/services/strategy-verdicts.test.js
//
// The 30-close verdict, both directions (owner order 09-09-2026 15:20 SGT,
// §7,539·B·2). A hand-pinned strategy is judged on its own closes on that
// account: pending at half risk under the sample, full at PF ≥ 1.5, off under
// 1.1, half between. Not pinned → out of scope. The risk gate applies it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from '../db.js'
import { setStage } from './stage-matrix.js'
import {
  strategyVerdict, strategyVerdictsView, strategyVerdictConfig, loadStrategyVerdictConfig, STRATEGY_VERDICT_KEY, STRATEGY_VERDICT_DEFAULTS,
} from './strategy-verdicts.js'
import { evaluateTrade } from './risk.js'

const A = '111'
const B = '222'
const io = { getState, setState }

function withAccounts(db) {
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${A}','1',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${B}','2',0,1,'active')`).run()
  return db
}
const pin = (db, acct, key) => setStage(db, { kind: 'strategy', key, stage: 'trade', on: true, accountId: acct }, io)
/**
 * n bot closes for a strategy on an account: wins of +$30, losses of -$10 →
 * PF = 3·w/(n−w). Wins are spread evenly through the sequence so a losing
 * record does not also arm the loss-streak cooldown (a different guard).
 */
function closes(db, strategy, acct, n, wins) {
  const ins = db.prepare(`INSERT INTO trades (symbol, side, status, label_strategy, net_pnl, closed_at, account_id, origin) VALUES ('GBPUSD','BUY','closed',?,?,datetime('now', ?),?,'bot_market_dispatch')`)
  for (let i = 0; i < n; i++) {
    const win = Math.floor((i + 1) * wins / n) > Math.floor(i * wins / n)
    ins.run(strategy, win ? 30 : -10, `-${n - i} minutes`, acct)
  }
}

test('defaults and clamps: 30 closes, full at 1.5, off under 1.1, half risk while pending or between; offPf never above fullPf', () => {
  assert.deepEqual(strategyVerdictConfig(null), { ...STRATEGY_VERDICT_DEFAULTS })
  const c = strategyVerdictConfig({ closes: 2, fullPf: 1.2, offPf: 9, pendingScale: 5, halfScale: 0 })
  assert.equal(c.closes, 5); assert.equal(c.fullPf, 1.2); assert.equal(c.offPf, 1.2); assert.equal(c.pendingScale, 1); assert.equal(c.halfScale, 0.05)
  const db = initDB(':memory:')
  setState(db, STRATEGY_VERDICT_KEY, 'junk')
  assert.deepEqual(loadStrategyVerdictConfig(db), { ...STRATEGY_VERDICT_DEFAULTS })
})

test('scope: unpinned, unscoped and switched-off all read n/a at scale 1', () => {
  const db = withAccounts(initDB(':memory:'))
  assert.equal(strategyVerdict(db, { strategy: 'rsi2_reversion', accountId: A }).state, 'n/a')
  assert.equal(strategyVerdict(db, { strategy: 'rsi2_reversion', accountId: A }).reason, 'not_pinned')
  assert.equal(strategyVerdict(db, { strategy: null, accountId: A }).reason, 'unscoped')
  pin(db, A, 'rsi2_reversion')
  assert.equal(strategyVerdict(db, { strategy: 'rsi2_reversion', accountId: A }).state, 'pending')
  setState(db, STRATEGY_VERDICT_KEY, JSON.stringify({ on: false }))
  assert.equal(strategyVerdict(db, { strategy: 'rsi2_reversion', accountId: A }).reason, 'off')
})

test('the four states from the record, per account: pending → full / half / off; another account\'s closes do not count', () => {
  const db = withAccounts(initDB(':memory:'))
  pin(db, A, 'rsi2_reversion'); pin(db, B, 'rsi2_reversion')
  // 29 closes → pending at half risk whatever they read.
  closes(db, 'rsi2_reversion', A, 29, 29)
  let v = strategyVerdict(db, { strategy: 'rsi2_reversion', accountId: A })
  assert.equal(v.state, 'pending'); assert.equal(v.riskScale, 0.5); assert.equal(v.closes, 29)
  // 30th close, still all wins → PF null (no losses) → full.
  closes(db, 'rsi2_reversion', A, 1, 1)
  v = strategyVerdict(db, { strategy: 'rsi2_reversion', accountId: A })
  assert.equal(v.state, 'full'); assert.equal(v.riskScale, 1); assert.equal(v.profitFactor, null)
  // B has none of A's closes: still pending.
  assert.equal(strategyVerdict(db, { strategy: 'rsi2_reversion', accountId: B }).state, 'pending')
  // B: 30 closes, 10 wins → PF = 300/200 = 1.5 → full (at the bar).
  closes(db, 'rsi2_reversion', B, 30, 10)
  v = strategyVerdict(db, { strategy: 'rsi2_reversion', accountId: B })
  assert.equal(v.state, 'full'); assert.equal(v.profitFactor, 1.5)
  // Another strategy on B: 30 closes, 9 wins → PF = 270/210 = 1.29 → half.
  pin(db, B, 'ema_pullback'); closes(db, 'ema_pullback', B, 30, 9)
  v = strategyVerdict(db, { strategy: 'ema_pullback', accountId: B })
  assert.equal(v.state, 'half'); assert.equal(v.riskScale, 0.5); assert.equal(v.profitFactor, 1.29)
  // And one more: 30 closes, 7 wins → PF = 210/230 = 0.91 → off, with the reason.
  pin(db, B, 'vwap_trend'); closes(db, 'vwap_trend', B, 30, 7)
  v = strategyVerdict(db, { strategy: 'vwap_trend', accountId: B })
  assert.equal(v.state, 'off'); assert.equal(v.riskScale, 0); assert.match(v.reason, /PF 0\.91 over 30 closes < 1\.1/)
  // The view lists pinned strategies only, per account.
  const view = strategyVerdictsView(db)
  assert.deepEqual(Object.keys(view.accounts[A]), ['rsi2_reversion'])
  assert.deepEqual(Object.keys(view.accounts[B]).sort(), ['ema_pullback', 'rsi2_reversion', 'vwap_trend'])
  assert.equal(view.accounts[B].vwap_trend.state, 'off')
})

test('the risk gate: off is refused with strategy_verdict_off; pending halves the size; full does not; unpinned is untouched', () => {
  const db = withAccounts(initDB(':memory:'))
  setState(db, `acct:${A}:account_balance_usd`, '10000')
  // 3R bracket clears the floor outright, so only the verdict decides.
  const prop = { symbol: 'EURUSD', side: 'long', entry: 1.1, sl: 1.097, tp1: 1.109, requestedVolume: null, strategy: 'vwap_trend', conviction: 8, accountId: A }
  const free = evaluateTrade(db, prop)
  assert.equal(free.approved, true, free.veto_reason)
  assert.equal(free.checks.strategy_verdict, undefined, 'unpinned: out of scope')
  pin(db, A, 'vwap_trend')
  const pending = evaluateTrade(db, prop)
  assert.equal(pending.approved, true, pending.veto_reason)
  assert.equal(pending.checks.strategy_verdict.state, 'pending')
  assert.ok(Math.abs(pending.checks.risk_based_volume - free.checks.risk_based_volume / 2) <= 0.011, `pending halves the size: ${pending.checks.risk_based_volume} vs ${free.checks.risk_based_volume}`)
  closes(db, 'vwap_trend', A, 30, 15) // PF 3 → full
  const full = evaluateTrade(db, prop)
  assert.equal(full.approved, true, full.veto_reason)
  assert.equal(full.checks.strategy_verdict.state, 'full')
  assert.equal(full.checks.risk_based_volume, free.checks.risk_based_volume)
  // A losing record turns it off on THIS account only.
  const db2 = withAccounts(initDB(':memory:'))
  setState(db2, `acct:${A}:account_balance_usd`, '10000'); setState(db2, `acct:${B}:account_balance_usd`, '10000')
  pin(db2, A, 'vwap_trend'); pin(db2, B, 'vwap_trend'); closes(db2, 'vwap_trend', A, 30, 7)
  const off = evaluateTrade(db2, prop)
  assert.equal(off.approved, false)
  assert.match(off.veto_reason, /^strategy_verdict_off: vwap_trend on …111 — PF 0\.91 over 30 closes < 1\.1/)
  assert.equal(evaluateTrade(db2, { ...prop, accountId: B }).approved, true, 'B keeps trading it')
})

test('wiring pins: the state route and the gate\'s scale combine by the smaller factor', () => {
  const strip = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(strip('../routes/state.js'), /router\.get\('\/strategy-verdicts'[\s\S]{0,300}?strategyVerdictsView\(db\)/)
  assert.match(strip('./risk.js'), /Math\.min\(earnedFloor\?\.riskScale \?\? 1, verdict\.state !== 'n\/a' \? verdict\.riskScale : 1\)/)
})

// V3 Q4b (PR-B1): the verdict carries PF in R (r-net-v1) beside the money PF
// it judges (usd-net-v0). R reads 2.0 while money reads 0.91: the verdict is
// still off — moving the verdict to R is the owner's decision (H-P6-7).
test('PF in R rides beside the verdict, labelled, and judges nothing: money 0.91 is off even where R reads 2.0', () => {
  const db = withAccounts(initDB(':memory:'))
  pin(db, A, 'vwap_trend')
  const ins = db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, status, label_strategy, realised_rr, net_pnl, gross_pnl, closed_at, account_id, origin)
                          VALUES ('GBPUSD','BUY',1.1,1.1,1.09,'closed','vwap_trend',?,?,?,datetime('now', ?),?,'bot_market_dispatch')`)
  for (let i = 0; i < 30; i++) {
    const win = Math.floor((i + 1) * 7 / 30) > Math.floor(i * 7 / 30)
    const usd = win ? 30 : -10
    ins.run(win ? 2 * 23 / 7 : -1, usd, usd, `-${30 - i} minutes`, A)
  }
  const v = strategyVerdict(db, { strategy: 'vwap_trend', accountId: A })
  assert.equal(v.profitFactor, 0.91)
  assert.equal(v.profitFactorR, 2, 'R: 7 × 46/7 / 23 = 2')
  assert.equal(v.state, 'off', 'RED if the verdict reads PF in R')
  const view = strategyVerdictsView(db)
  assert.equal(view.accounts[A].vwap_trend.profitFactorR, 2)
  assert.deepEqual(view.metrics, { profitFactor: 'usd-net-v0', profitFactorR: 'r-net-v1' })
  assert.equal(strategyVerdict(db, { strategy: 'vwap_trend', accountId: B }).profitFactorR, null, 'n/a carries a null R PF')
})
