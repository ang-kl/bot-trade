// node --test agent/services/config-controller.test.js
//
// C-1, propose-only. The tests that matter here are the ones about RESTRAINT:
// a controller that advises confidently off a thin sample, or that writes
// anything at all, is worse than no controller. The arithmetic is the easy
// part and is checked against the numbers actually measured on 2026-08-04.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import {
  accountEconomics, requiredPayoff, proposeForAccount, configProposals,
  MIN_SAMPLE, TARGET_PF, RULES,
  newDangerProposals, dangerAlertText,
  MIN_LOSING_TRADES_PER_DAY,
} from './config-controller.js'

function fresh() {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode)
              VALUES ('46130058','5203012',0,1,'active')`).run()
  setState(db, 'acct:46130058:account_balance_usd', '50000')
  return db
}

/** n trades at a given win rate, with the given average win and loss. */
function seed(db, { account = '46130058', wins = 32, losses = 61, avgWin = 489.55, avgLoss = 286.79 } = {}) {
  const ins = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, net_pnl, opened_at, closed_at, account_id)
                          VALUES ('EURUSD','BUY','closed',1.1,?,datetime('now','-2 days'),datetime('now','-1 days'),?)`)
  for (let i = 0; i < wins; i++) ins.run(avgWin, account)
  for (let i = 0; i < losses; i++) ins.run(-avgLoss, account)
}

const cfg = (db, account, patch) =>
  setState(db, `acct:${account}:risk_config_json`, JSON.stringify(patch))

// ---------------------------------------------------------------------------

test('requiredPayoff reproduces the numbers measured on the real accounts', () => {
  // 46130058: 34.4% win rate -> 1.91 to break even, 3.20 for PF 1.68.
  assert.equal(requiredPayoff(0.344, 1).toFixed(2), '1.91')
  assert.equal(requiredPayoff(0.344, TARGET_PF).toFixed(2), '3.20')
  // 47790949: 38.6% -> 1.59 and 2.67 at this precision. The figure applied to
  // production was 2.68, computed from the unrounded 27/70 = 38.571%; feeding
  // the rounded 0.386 back in lands a hundredth lower. Written out rather than
  // fudged, because a controller whose test agrees with a remembered number
  // instead of with its own arithmetic is exactly the failure this file is
  // meant to prevent.
  assert.equal(requiredPayoff(0.386, 1).toFixed(2), '1.59')
  assert.equal(requiredPayoff(0.386, TARGET_PF).toFixed(2), '2.67')
  assert.equal(requiredPayoff(27 / 70, TARGET_PF).toFixed(2), '2.68')
})

test('a win rate of 0 or 1 has no finite answer and says so', () => {
  // Inventing one is how a controller recommends an infinite reward:risk off
  // a four-trade sample.
  for (const w of [0, 1, -0.5, 1.5, NaN, null, undefined, 'x']) {
    assert.equal(requiredPayoff(w), null, `${w} must not produce a number`)
  }
})

test('economics ignore trades with unknown P&L rather than counting them as zero', () => {
  const db = fresh()
  seed(db, { wins: 1, losses: 1 })
  db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, net_pnl, opened_at, closed_at, account_id)
              VALUES ('EURUSD','BUY','closed',1.1,NULL,datetime('now','-2 days'),datetime('now','-1 days'),'46130058')`).run()
  const e = accountEconomics(db, '46130058')
  assert.equal(e.trades, 2, 'the unresolved trade is not a data point')
  assert.equal(e.winRate, 0.5, 'counting it as a zero-value loss would read as 33%')
})

test('an account without losses reports a null payoff rather than Infinity', () => {
  const db = fresh()
  seed(db, { wins: 5, losses: 0 })
  const e = accountEconomics(db, '46130058')
  assert.equal(e.payoff, null)
  assert.equal(e.profitFactor, null)
})

// ---------------------------------------------------------------------------
// Restraint
// ---------------------------------------------------------------------------

test('a thin sample produces NO proposals, and says why', () => {
  // The most dangerous thing this can do is turn a fortnight of variance into
  // a permanent setting (§69.7.9).
  const db = fresh()
  seed(db, { wins: 4, losses: 6 })
  cfg(db, '46130058', { minRR: 1.5 })
  const out = proposeForAccount(db, '46130058')
  assert.deepEqual(out.proposals, [])
  assert.equal(out.sampleOk, false)
  assert.match(out.skipped, /insufficient_sample: 10 closed trades/)
  assert.match(out.skipped, new RegExp(`need ${MIN_SAMPLE}`))
})

test('silence is REPORTED, not implied — an absent proposal must not read as approval', () => {
  const db = fresh()
  const out = proposeForAccount(db, '46130058')
  assert.equal(out.skipped != null, true, 'no data still produces a stated reason')
})

test('the live account is excluded unless asked for', () => {
  const db = fresh()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode)
              VALUES ('42993489','1251247',1,1,'active')`).run()
  seed(db, { account: '42993489' })
  assert.equal(configProposals(db).accounts.some(a => a.accountId === '42993489'), false)
  assert.match(configProposals(db).scope.note, /live accounts excluded/)
  assert.equal(configProposals(db, { includeLive: true }).accounts.some(a => a.accountId === '42993489'), true)
})

test('a disabled account is not advised about', () => {
  const db = fresh()
  db.prepare("UPDATE accounts SET enabled = 0 WHERE account_id = '46130058'").run()
  seed(db)
  assert.equal(configProposals(db).accounts.length, 0)
})

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

test('minRR below breakeven is DANGER and names the arithmetic', () => {
  const db = fresh()
  seed(db)                                     // 32/93 wins -> ~34.4%
  cfg(db, '46130058', { minRR: 1.5, allowNegativeExpectancyOverride: false, minTradesForKelly: 30 })
  const out = proposeForAccount(db, '46130058')
  const p = out.proposals.find(x => x.setting === 'minRR')
  assert.ok(p, 'the finding that prompted this module must be the one it makes')
  assert.equal(p.severity, 'danger')
  assert.equal(p.current, 1.5)
  assert.ok(p.proposed > 3 && p.proposed < 3.4, `expected ~3.2, got ${p.proposed}`)
  // A number without its derivation is something to obey or ignore.
  assert.match(p.why, /win rate over 93 closed trades/)
  assert.match(p.why, /break even/)
  assert.match(p.why, /BELOW breakeven/)
  assert.ok(p.expect.length > 0)
})

test('minRR that clears breakeven but not the target is a WARNING, not a danger', () => {
  const db = fresh()
  seed(db)
  cfg(db, '46130058', { minRR: 2.5, allowNegativeExpectancyOverride: false, minTradesForKelly: 30 })
  const p = proposeForAccount(db, '46130058').proposals.find(x => x.setting === 'minRR')
  assert.equal(p.severity, 'warn')
  assert.match(p.why, /clears breakeven but cannot reach the target/)
})

test('minRR already at the target produces no proposal', () => {
  const db = fresh()
  seed(db)
  cfg(db, '46130058', { minRR: 3.5, allowNegativeExpectancyOverride: false, minTradesForKelly: 30 })
  assert.equal(proposeForAccount(db, '46130058').proposals.some(p => p.setting === 'minRR'), false)
})

test('the expectancy override and the Kelly sample size are visibly coupled', () => {
  const db = fresh()
  seed(db)
  // Override ON: the sample size changes nothing because the veto never fires,
  // so proposing it would be noise.
  cfg(db, '46130058', { minRR: 3.5, allowNegativeExpectancyOverride: true, minTradesForKelly: 10 })
  const withOverride = proposeForAccount(db, '46130058').proposals
  assert.ok(withOverride.some(p => p.setting === 'allowNegativeExpectancyOverride'))
  assert.equal(withOverride.some(p => p.setting === 'minTradesForKelly'), false)

  // Override OFF: now a 10-trade sample can stand a strategy down, and that
  // IS worth saying.
  cfg(db, '46130058', { minRR: 3.5, allowNegativeExpectancyOverride: false, minTradesForKelly: 10 })
  const withoutOverride = proposeForAccount(db, '46130058').proposals
  assert.ok(withoutOverride.some(p => p.setting === 'minTradesForKelly'))
})

test('a daily cap smaller than one average loss is DANGER', () => {
  // Measured: a $16.16 cap on 43097342 produced 4,717 vetoes in one week.
  const db = fresh()
  seed(db, { avgWin: 100, avgLoss: 200 })
  cfg(db, '46130058', { minRR: 3.5, allowNegativeExpectancyOverride: false, minTradesForKelly: 30, dailyLossPct: 0.001 })
  const p = proposeForAccount(db, '46130058', { balance: 50000 }).proposals.find(x => x.setting === 'dailyLossPct')
  assert.ok(p)
  assert.equal(p.severity, 'danger')
  assert.match(p.why, /One ordinary losing trade stops the account for the day/)
  assert.ok(p.proposed > 0.001)
})

test('a roomy daily cap is left alone', () => {
  const db = fresh()
  seed(db, { avgWin: 100, avgLoss: 200 })
  // perTradeRiskPct is EXPLICIT here, and has to be. This fixture used to
  // inherit the 0.05 default, under which an 18% daily cap is only 3.6
  // full-risk losses wide — and daily_cap_vs_permitted_risk correctly said so,
  // failing a test whose point was the OTHER rule. The two knobs have to be
  // set together to mean anything, which is the finding that rule exists for.
  cfg(db, '46130058', { minRR: 3.5, allowNegativeExpectancyOverride: false, minTradesForKelly: 30, dailyLossPct: 0.18, perTradeRiskPct: 0.01 })
  assert.equal(
    proposeForAccount(db, '46130058', { balance: 50000 }).proposals.some(p => p.setting === 'dailyLossPct'),
    false,
  )
})

test('THE PRODUCTION SHAPE: 5% per trade under a 3% daily cap contradicts itself', () => {
  // Measured 05-08-2026: perTradeRiskPct defaults to 0.05 and dailyLossPct is
  // 0.03. One full-risk trade may lose MORE than the entire day's budget —
  // 0.6 losing trades and the account stops. That is not a brake, it is a
  // guarantee of `daily_loss_limit_hit`, which was 11,946 vetoes in a week.
  const db = fresh()
  seed(db, { avgWin: 100, avgLoss: 200 })
  cfg(db, '46130058', { dailyLossPct: 0.03, perTradeRiskPct: 0.05 })
  const p = proposeForAccount(db, '46130058', { balance: 46072.92 })
    .proposals.find(x => x.setting === 'dailyLossPct')
  assert.ok(p, 'the contradiction must be reported')
  assert.match(p.why, /0\.6 losing trades/)
})

test('every rule is a callable that tolerates an empty world', () => {
  for (const r of RULES) {
    assert.equal(typeof r.evaluate, 'function', `${r.key} must be callable`)
    assert.doesNotThrow(() => r.evaluate({ econ: { winRate: null, trades: 0 }, config: {}, balance: null }))
  }
})

test('THE CONTROLLER NEVER WRITES', () => {
  // The whole contract. If this module ever gains a setState the owner's
  // "propose-only" decision has been quietly reversed, and that reversal
  // should fail here rather than surface as a changed risk limit.
  const src = readSelf()
  assert.ok(!/setState\s*\(/.test(src), 'config-controller.js must not write state')
  assert.ok(!/\bUPDATE\b|\bINSERT\b|\bDELETE\b/i.test(src.replace(/\/\/.*$/gm, '')), 'no write SQL outside comments')
})

function readSelf() {
  return readFileSync(new URL('./config-controller.js', import.meta.url), 'utf8')
}

// ---------------------------------------------------------------------------
// THE ALERT. C-1 shipped correct in #632 and nothing listened: configProposals
// was wired to a read route and to nothing else. Measured 05-08-2026, its live
// output flagged 43097342 at minRR 1.5 with a 21.4% win rate — #185 recurring
// on the one account the fix missed — and the only way to see it was to open a
// card and know to look.
// ---------------------------------------------------------------------------

const memState = () => {
  const m = new Map()
  return { getState: (_db, k) => m.get(k) ?? null, setState: (_db, k, v) => m.set(k, v) }
}
const report = (proposals) => ({ accounts: [{ accountId: '43097342', proposals }] })
const DANGER = { rule: 'minRR_below_breakeven', setting: 'minRR', current: 1.5, proposed: 6.16, severity: 'danger', why: 'BELOW breakeven' }
const WARN = { rule: 'kelly_sample_too_thin', setting: 'minTradesForKelly', current: 10, proposed: 30, severity: 'warn', why: 'thin' }

test('a danger proposal is announced once, not every cycle', () => {
  const st = memState()
  const first = newDangerProposals(null, report([DANGER]), st)
  assert.equal(first.fresh.length, 1)
  assert.equal(first.fresh[0].setting, 'minRR')
  // A standing condition must not re-alert — that is how a channel gets muted.
  assert.equal(newDangerProposals(null, report([DANGER]), st).fresh.length, 0)
})

test('warn severity never alerts', () => {
  // Several warns stand at any time. Alerting on them trains the reader to
  // ignore the channel, which is exactly how a danger goes unread.
  const st = memState()
  assert.equal(newDangerProposals(null, report([WARN]), st).fresh.length, 0)
})

test('the same wrong value returning DOES alert again', () => {
  const st = memState()
  newDangerProposals(null, report([DANGER]), st)          // seen
  newDangerProposals(null, report([]), st)                 // acted on — clears
  const back = newDangerProposals(null, report([DANGER]), st)
  assert.equal(back.fresh.length, 1, 'a regression must speak, not be muted by a memory of the fix')
})

test('a drift to a DIFFERENT wrong value is its own alert', () => {
  const st = memState()
  newDangerProposals(null, report([DANGER]), st)
  const drifted = newDangerProposals(null, report([{ ...DANGER, current: 2.0 }]), st)
  assert.equal(drifted.fresh.length, 1)
  assert.equal(drifted.fresh[0].current, 2.0)
})

test('the alert text says the limit was NOT changed', () => {
  // Changing a risk limit is the owner's, per CLAUDE.md. A message that read
  // as an action taken would be a lie about what the controller does.
  const t = dangerAlertText({ accountId: '43097342', ...DANGER })
  assert.match(t, /43097342/)
  assert.match(t, /minRR: 1\.5 → proposed 6\.16/)
  assert.match(t, /RISK LIMIT/)
  assert.match(t, /Nothing has been changed/)
})

test('an empty or malformed report is silent, never a throw', () => {
  const st = memState()
  assert.deepEqual(newDangerProposals(null, null, st).fresh, [])
  assert.deepEqual(newDangerProposals(null, { accounts: [] }, st).fresh, [])
  assert.deepEqual(newDangerProposals(null, { accounts: [{ accountId: 'x' }] }, st).fresh, [])
})

// ---------------------------------------------------------------------------
// DAILY CAP vs PERMITTED RISK. Owner, 05-08-2026: "dailyLossPct must be
// calibrated with account sizing."
//
// The older daily_cap_smaller_than_one_loss rule compares the cap to avgLoss,
// and on 04-08-2026 it was satisfied on every account while
// daily_loss_limit_hit was still the second-largest guard at 11,946 vetoes.
// Average loss is backward-looking and cannot see the trade that spends the
// whole day's budget by itself.
// ---------------------------------------------------------------------------

const capRule = RULES.find(r => r.key === 'daily_cap_vs_permitted_risk')
const ECON = (over = {}) => ({ trades: 210, winRate: 0.3, avgWin: 385, avgLoss: 192, maxLoss: 400, ...over })

test('a cap that allows fewer than five full-risk losses is flagged', () => {
  // 46072.92 × 0.03 = 1382.19 cap; 1% per trade = 460.73 → exactly 3 losses.
  const p = capRule.evaluate({
    econ: ECON(), balance: 46072.92,
    config: { dailyLossPct: 0.03, perTradeRiskPct: 0.01 },
  })
  assert.equal(p.setting, 'dailyLossPct')
  assert.equal(p.proposed, 0.05, 'five losses × 1% per trade')
  assert.match(p.why, /3\.0 losing trades/)
  assert.match(p.why, /caps variance rather than risk/)
})

test('a cap wide enough for five losses is left alone', () => {
  assert.equal(capRule.evaluate({
    econ: ECON(), balance: 46072.92,
    config: { dailyLossPct: 0.06, perTradeRiskPct: 0.01 },
  }), null)
})

test('THE JPN225 CASE: one trade past the whole cap is the STRONGER finding', () => {
  // 04-08-2026: JPN225 lost 2,681.29 against a 1,382 daily cap. The rule must
  // NOT respond by proposing a bigger cap — that hides a sizing failure.
  const p = capRule.evaluate({
    econ: ECON({ maxLoss: 2681.29 }), balance: 46072.92,
    config: { dailyLossPct: 0.03, perTradeRiskPct: 0.01 },
  })
  assert.equal(p.severity, 'danger')
  assert.equal(p.setting, 'perTradeRiskPct', 'the sizing is the problem, not the cap')
  assert.match(p.why, /2681\.29 against a daily cap of 1382\.19/)
  assert.match(p.why, /Raising the daily cap would hide this/)
})

test('the oversize-trade check runs BEFORE the too-few-losses one', () => {
  // Both conditions hold here. The stronger, differently-actioned finding has
  // to win, or the operator is told to raise a cap that a single trade has
  // already blown through.
  const p = capRule.evaluate({
    econ: ECON({ maxLoss: 5000 }), balance: 46072.92,
    config: { dailyLossPct: 0.03, perTradeRiskPct: 0.01 },
  })
  assert.equal(p.setting, 'perTradeRiskPct')
})

test('it says nothing when a knob it needs is missing', () => {
  const base = { econ: ECON(), balance: 46072.92, config: { dailyLossPct: 0.03, perTradeRiskPct: 0.01 } }
  assert.equal(capRule.evaluate({ ...base, config: { dailyLossPct: 0.03 } }), null, 'no per-trade risk to compare')
  assert.equal(capRule.evaluate({ ...base, config: { perTradeRiskPct: 0.01 } }), null, 'no cap')
  assert.equal(capRule.evaluate({ ...base, balance: 0 }), null)
  assert.equal(capRule.evaluate({ ...base, econ: ECON({ maxLoss: null }), config: { dailyLossPct: 0.06, perTradeRiskPct: 0.01 } }), null)
})

test('accountEconomics reports the WORST loss, not only the average', () => {
  const db = initDB(':memory:')
  const ins = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, status, opened_at, closed_at, net_pnl, account_id)
    VALUES ('JPN225','SELL',1,'closed',datetime('now'),datetime('now'),?,'46130058')
  `)
  for (const p of [-100, -200, -2681.29, 400]) ins.run(p)
  const e = accountEconomics(db, '46130058')
  assert.equal(e.maxLoss, 2681.29)
  assert.ok(e.avgLoss < e.maxLoss, 'the average hides it — that is the whole point')
})

test('an account with no losses has no maxLoss, and nothing is invented', () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, status, opened_at, closed_at, net_pnl, account_id)
    VALUES ('EURUSD','BUY',1,'closed',datetime('now'),datetime('now'),50,'46130058')
  `).run()
  assert.equal(accountEconomics(db, '46130058').maxLoss, null)
  assert.equal(accountEconomics(db, 'nobody').maxLoss, null)
})
