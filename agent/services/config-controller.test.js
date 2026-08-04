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
  cfg(db, '46130058', { minRR: 3.5, allowNegativeExpectancyOverride: false, minTradesForKelly: 30, dailyLossPct: 0.18 })
  assert.equal(
    proposeForAccount(db, '46130058', { balance: 50000 }).proposals.some(p => p.setting === 'dailyLossPct'),
    false,
  )
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
