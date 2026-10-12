// node --test agent/services/fluid-rr-floor.test.js
//
// Claude · № 13,729 12-Oct (owner, after № 13,727: "Admit at breakeven with
// cost of commission included: required R:R = (1 – W) ÷ W … sized by the same
// fluid formula + commission cost"; claude-builder)
//
// Below the static 3.0 floor, a trade is admitted AT ITS OWN TARGET when the
// strategy's win rate on the account (measured, or shrunk toward its backtest)
// pays for its commission at that ratio:
//
//     required R:R = (1 − W + c) ÷ W      c = round-trip commission in R
//
// and it is never stretched to reach it. Its size is fluid:
//
//     scale = clamp(realised net PF in R ÷ goal PF, 0.25, 1)   (0.5 under 15 R-scored closes)
//     riskScale = scale ÷ (1 + c)                               (commission inside the risk budget)
//
// The real gate is run end to end where it matters (failure mode #4).
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { readFileSync } from 'node:fs'
import { evaluateTrade, rrFloorVerdict, loadRiskConfig, commissionInR, fluidRiskScale, fluidRiskConfig, lowestAdmittedRr } from './risk.js'

const A = '111'

function db0() {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${A}','1',0,1,'active')`).run()
  return db
}

/**
 * n closes of a strategy on account A, planned at `plannedRr` (under the 3.0
 * band, so they are the earned floor's population), winPct% wins. Each close
 * carries its realised R so the record's net PF in R is known:
 * wins at +winR, losses at −1R; net money follows the R (×10) with the same sign.
 */
function seed(db, strategy, n, winPct, { plannedRr = 1.6, winR = 1.5, symbol = 'GBPUSD', origin = 'bot_scan' } = {}) {
  const wins = Math.round(n * winPct / 100)
  const ins = db.prepare(`INSERT INTO trades
    (symbol, side, status, origin, label_strategy, net_pnl, gross_pnl, realised_rr, closed_at, account_id, entry_price, sl_price, tp_price)
    VALUES (?, 'BUY', 'closed', ?, ?, ?, ?, ?, ?, ?, 100, 99, ?)`)
  for (let i = 0; i < n; i++) {
    const win = i < wins
    const r = win ? winR : -1
    ins.run(symbol, origin, strategy, r * 10, r * 10, r, new Date(Date.now() - (i + 1) * 60_000).toISOString(), A, 100 + plannedRr)
  }
}

const verdict = (db, p) => rrFloorVerdict(db, { strategy: 'vwap_trend', accountId: A, config: loadRiskConfig(db, A), side: 'long', ...p })

test('commission in R: the measured class schedule, round trip, over the stop distance', () => {
  // HK stocks: 15 bps per side → 0.30R on a 1% stop.
  assert.equal(commissionInR('0700.HK', 100, 99).c, 0.3)
  assert.equal(commissionInR('0700.HK', 100, 99).class, 'stock_hk')
  // US stocks: $0.02 a share each way → $0.04 over a $2 stop = 0.02R.
  assert.equal(commissionInR('AAPL.US', 200, 198).c, 0.02)
  // Indices carry no commission in the schedule.
  assert.equal(commissionInR('US500', 5000, 4990).c, 0)
  // No stop distance, no figure — never a division by zero read as free.
  assert.equal(commissionInR('US500', 5000, 5000), null)
})

test('breakeven at its own target: 40% win on an index needs (1 − 0.4 + 0)/0.4 = 1.50R — a 1.6R setup is admitted where it stands, never stretched', () => {
  const db = db0()
  seed(db, 'vwap_trend', 20, 40)
  const v = verdict(db, { symbol: 'US500', rr: 1.6, entry: 100, sl: 99, tp1: 101.6 })
  assert.equal(v.ok, true, v.reason)
  assert.equal(v.earnedFloor.rule, 'breakeven_commission')
  assert.equal(v.earnedFloor.need, 1.5)
  assert.equal(v.earnedFloor.commissionR, 0)
  assert.equal(v.earnedFloor.stretchedFrom, undefined, 'RED on the old rule: 40% at 1.6R (E 0.04 ≤ 0.15) was stretched to 1.88R')
  assert.equal(v.earnedFloor.tp1, undefined, 'the target is the strategy\'s own')
  assert.equal(v.checks.earned_floor.need, 1.5)
})

test('commission is part of breakeven: 40% win on a HK stock with a 1% stop pays 0.30R a round trip, so it needs 2.25R — 2.0R is refused, 2.3R admitted', () => {
  const db = db0()
  seed(db, 'vwap_trend', 20, 40)
  const short = verdict(db, { symbol: '0700.HK', rr: 2, entry: 100, sl: 99, tp1: 102 })
  assert.equal(short.ok, false, 'RED on the old rule: E 0.20R > 0.15 admitted it, commission unseen')
  assert.match(short.reason, /^bad_rr 2\.00<2\.25 \(breakeven at 40% win \+ commission 0\.3R\)/)
  assert.equal(short.earnedFloor, null)
  const enough = verdict(db, { symbol: '0700.HK', rr: 2.3, entry: 100, sl: 99, tp1: 102.3 })
  assert.equal(enough.ok, true, enough.reason)
  assert.equal(enough.earnedFloor.need, 2.25)
  assert.equal(enough.earnedFloor.commissionR, 0.3)
})

test('below breakeven is refused at its own target: no stretch, no new take-profit', () => {
  // 40% win on a HK stock needs 2.25R; the old rule stretched this 1.6R setup
  // to 1.88R (its 0.15R ratio, under the 2R cap) and admitted it there.
  const db = db0()
  seed(db, 'vwap_trend', 20, 40)
  const v = verdict(db, { symbol: '0700.HK', rr: 1.6, entry: 100, sl: 99, tp1: 101.6 })
  assert.equal(v.ok, false, 'RED on the old rule: stretched to 1.88R and admitted')
  assert.match(v.reason, /^bad_rr 1\.60<2\.25 \(breakeven at 40% win \+ commission 0\.3R\)/)
  assert.equal(v.earnedFloor, null)
  assert.equal(v.checks.earned_floor_stretch_denied, undefined)
  assert.match(v.checks.earned_floor_denied, /breakeven needs 2\.25R/)
})

test('the static floor still governs a setup under the strategy\'s own pre-filter: the fluid rule is not asked below 1.5R', () => {
  const db = db0()
  seed(db, 'vwap_trend', 20, 60)
  const v = verdict(db, { symbol: 'US500', rr: 1.4, entry: 100, sl: 99, tp1: 101.4 })
  assert.equal(v.ok, false)
  assert.match(v.reason, /^bad_rr 1\.40<3/)
})

test('fluid size: half until 15 R-scored closes; then net PF in R ÷ goal PF, between 0.25 and 1; then ÷ (1 + commission)', () => {
  const cfg = { goalPf: 1.5, minScale: 0.25, minCloses: 15, pendingScale: 0.5 }
  assert.equal(fluidRiskScale({ rScored: 14, profitFactorR: 3 }, 0, cfg).scale, 0.5)
  assert.equal(fluidRiskScale({ rScored: 20, profitFactorR: 1.0 }, 0, cfg).scale, 0.6667)
  assert.equal(fluidRiskScale({ rScored: 20, profitFactorR: 3 }, 0, cfg).scale, 1)
  assert.equal(fluidRiskScale({ rScored: 20, profitFactorR: 0.2 }, 0, cfg).scale, 0.25)
  assert.equal(fluidRiskScale({ rScored: 20, profitFactorR: null }, 0, cfg).scale, 1, 'no losing close yet: nothing to scale down by')
  assert.equal(fluidRiskScale({ rScored: 20, profitFactorR: 1.0 }, 0.3, cfg).riskScale, 0.5128, '0.6667 ÷ 1.3')
  // The goal is a setting, not a constant.
  assert.equal(fluidRiskScale({ rScored: 20, profitFactorR: 1.0 }, 0, { ...cfg, goalPf: 1.3 }).scale, 0.7692)
})

test('the gate sizes a breakeven admit by the fluid scale: 8 of 20 at +1.5R is PF 1.0 in R → 0.667 of the budget', () => {
  const db = db0()
  seed(db, 'vwap_trend', 20, 40, { symbol: 'GBPUSD' })
  setState(db, `acct:${A}:account_balance_usd`, '10000')
  const prop = { symbol: 'US500', side: 'long', entry: 5000, sl: 4990, tp1: 5016, requestedVolume: null, strategy: 'vwap_trend', conviction: 8, accountId: A }
  const res = evaluateTrade(db, prop)
  assert.equal(res.approved, true, res.veto_reason)
  assert.equal(res.checks.earned_floor.rule, 'breakeven_commission')
  assert.equal(res.checks.earned_floor.fluid.profitFactorR, 1)
  assert.equal(res.checks.earned_floor.riskScale, 0.6667)
  assert.equal(res.target_override, undefined, 'admitted at its own target')
})

test('the owner can switch the fluid rule off: the earned floor and its stretch come back exactly as they were', () => {
  const db = db0()
  seed(db, 'vwap_trend', 20, 40)
  setState(db, 'risk_config_json', JSON.stringify({ fluidRisk: { on: false } }))
  const v = verdict(db, { symbol: 'US500', rr: 1.6, entry: 100, sl: 99, tp1: 101.6 })
  assert.equal(v.ok, true)
  assert.equal(v.earnedFloor.stretchedFrom, 1.6, 'the old rule stretches 1.6R to the 0.15R ratio')
  assert.equal(v.earnedFloor.rule, undefined)
})

test('the static floor is unchanged above it: a 3R setup never consults the fluid rule', () => {
  const db = db0()
  const v = verdict(db, { symbol: 'US500', rr: 3, entry: 100, sl: 99, tp1: 103 })
  assert.equal(v.ok, true)
  assert.equal(v.earnedFloor, null)
  assert.equal(v.rrFloor, 3)
})

test('the scan path\'s pre-filter asks the same rule with the same symbol: an index at 1.6R passes it, a HK stock at 2.0R is dropped with the breakeven words', async () => {
  const { accountPregate, proposalPregate, resetAccountPregate, RR_PREFILTER_STAGE } = await import('./account-pregate.js')
  const db = db0()
  setState(db, `acct:${A}:account_balance_usd`, '10000')
  setState(db, `acct:${A}:account_leverage`, '100')
  setState(db, 'ctrader_account_id', A)
  resetAccountPregate()
  seed(db, 'vwap_trend', 20, 40)
  const v = accountPregate(db, A, { cycle: 1 })
  assert.equal(v.ok, true, v.reason)
  const base = { side: 'BUY', requestedVolume: 0.1, strategy: 'vwap_trend', timeframe: '1h', source: 'auto_signal', accountId: A }
  // Without the symbol the commission would be the dearest class's (15 bps a
  // side on a 5000 index with a 10-point stop is 1.5R) and this would drop.
  const index = proposalPregate(db, A, { ...base, symbol: 'US500', entry: 5000, sl: 4990, tp1: 5016 }, { cycle: 1, account: v })
  assert.equal(index.ok, true, index.reason)
  const hk = proposalPregate(db, A, { ...base, symbol: '0700.HK', entry: 100, sl: 99, tp1: 102 }, { cycle: 1, account: v })
  assert.equal(hk.ok, false)
  assert.equal(hk.stage, RR_PREFILTER_STAGE)
  assert.match(hk.reason, /^bad_rr 2\.00<2\.25 \(breakeven at 40% win \+ commission 0\.3R\)/)
})

test('the stored settings are read safely: a blank or junk field takes its default, numbers are clamped', () => {
  // A blank goal PF from the Risk page would divide to Infinity and size at full.
  assert.deepEqual(fluidRiskConfig({ goalPf: '', minScale: 'x', minCloses: null, pendingScale: 7 }),
    { on: true, goalPf: 1.5, minScale: 0.25, minCloses: 15, pendingScale: 1 })
  assert.equal(fluidRiskConfig({ goalPf: '1.3' }).goalPf, 1.3, 'a typed number string is a number')
  assert.equal(fluidRiskConfig({ goalPf: 0 }).goalPf, 0.5)
  assert.equal(fluidRiskConfig({ on: false }).on, false)
  assert.equal(fluidRiskConfig(null).on, true)
  // Through the gate: a blank goal sizes by the default 1.5, not at full.
  const db = db0()
  seed(db, 'vwap_trend', 20, 40)
  setState(db, 'risk_config_json', JSON.stringify({ fluidRisk: { goalPf: '' } }))
  const v = verdict(db, { symbol: 'US500', rr: 1.6, entry: 100, sl: 99, tp1: 101.6 })
  assert.equal(v.earnedFloor.riskScale, 0.6667)
})

// Claude · № 13,738 12-Oct (Codex P2 on #1337, owner: "Decouple"; claude-builder)
test('the breakeven rule reads its win rate even with the earned floor switched off; the earned floor\'s own path stays off', () => {
  const db = db0()
  seed(db, 'vwap_trend', 20, 40)
  setState(db, 'earned_floor_json', JSON.stringify({ on: false }))
  const v = verdict(db, { symbol: 'US500', rr: 1.6, entry: 100, sl: 99, tp1: 101.6 })
  assert.equal(v.ok, true, `RED before the decoupling: the earned floor's off switch silenced the breakeven rule (${v.reason})`)
  assert.equal(v.earnedFloor.rule, 'breakeven_commission')
  // Both off: nothing below the floor, as the earned floor's switch always meant.
  setState(db, 'risk_config_json', JSON.stringify({ fluidRisk: { on: false } }))
  const off = verdict(db, { symbol: 'US500', rr: 1.6, entry: 100, sl: 99, tp1: 101.6 })
  assert.equal(off.ok, false)
  assert.match(off.reason, /^bad_rr 1\.60<3/)
  assert.equal(off.checks.earned_floor_denied, 'off')
})

// Claude · № 13,738 12-Oct (Codex P2 on #1337, owner: "Fix in this PR"; claude-builder)
test('the missing-target advice names the ratio the gate admits: breakeven with this trade\'s commission, the legacy bar only when the rule is off', () => {
  const db = db0()
  seed(db, 'vwap_trend', 20, 40)
  assert.equal(lowestAdmittedRr(db, A, 'vwap_trend', { symbol: '0700.HK', entry: 100, sl: 99 }), 2.25,
    'RED before: the legacy 0.15R bar advised 1.88R, which the gate refuses on this HK setup')
  assert.equal(lowestAdmittedRr(db, A, 'vwap_trend', { symbol: 'US500', entry: 5000, sl: 4990 }), 1.5)
  // Never under the strategy's own pre-filter.
  const hi = db0(); seed(hi, 'vwap_trend', 20, 80)
  assert.equal(lowestAdmittedRr(hi, A, 'vwap_trend', { symbol: 'US500', entry: 5000, sl: 4990 }), 1.5)
  // Rule off: the earned floor's own bar, as before.
  setState(db, 'risk_config_json', JSON.stringify({ fluidRisk: { on: false } }))
  assert.equal(lowestAdmittedRr(db, A, 'vwap_trend', { symbol: '0700.HK', entry: 100, sl: 99 }), 1.88)
})

test('wiring: the manual-order route passes the trade\'s symbol, entry and stop to the advice (comments stripped)', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const src = strip(readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8'))
  const start = src.indexOf("router.post('/manual-order'")
  const route = src.slice(start, src.indexOf('\n  router.', start + 1))
  assert.match(route, /lowestAdmittedRr\(db, creds\.accountId, strategy, \{ symbol, entry, sl: proposal\.sl \}\)/)
})
