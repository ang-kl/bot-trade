// node --test agent/services/account-pregate.test.js
//
// PR-C (owner principle 7): the cycle-level guards asked once per account per
// cycle, recorded as decision_log skips, with the risk gate kept as the
// backstop that calls the same functions. Each test here goes red when its
// change is reverted: the memo (one row, not one per symbol), the zero
// risk_events contribution, the leak fix, the R:R pre-filter and the loop
// wiring.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { evaluateTrade, DEFAULT_RISK_CONFIG, openPositionsForAccount, rrFloorVerdict, HARD_MIN_RR } from './risk.js'
import {
  accountPregate, accountPregateVerdict, proposalPregate, resetAccountPregate, invalidateAccountPregate,
  PREGATE_STAGE_PREFIX, RR_PREFILTER_STAGE,
} from './account-pregate.js'

const A = '11110001'
const B = '11110002'

function fresh() {
  const db = initDB(':memory:')
  for (const id of [A, B]) {
    db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')`).run(id, id)
    setState(db, `acct:${id}:account_balance_usd`, '10000')
    setState(db, `acct:${id}:account_leverage`, '100')
  }
  setState(db, 'ctrader_account_id', A)
  resetAccountPregate()
  return db
}

function openPositionOn(db, account, symbol) {
  const tradeId = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, volume, status, opened_at, account_id)
    VALUES (?, 'BUY', 100, 0.1, 'open', datetime('now'), ?)
  `).run(symbol, account).lastInsertRowid
  db.prepare(`
    INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, status, account_id)
    VALUES (?, ?, 'long', 100, 'active', ?)
  `).run(symbol, tradeId, account)
}

function closedToday(db, account, netPnl, minutesAgo = 5) {
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, volume, status, opened_at, closed_at, net_pnl, account_id)
    VALUES ('GBPUSD', 'BUY', 100, 99, 0.1, 'closed', datetime('now', '-2 hours'), datetime('now', ?), ?, ?)
  `).run(`-${minutesAgo} minutes`, netPnl, account)
}

// EURUSD: a pair the fresh DB can price (usd_per_lot known), so a clean
// account really does reach an approval rather than dying at sizing.
const proposalFor = (account, over = {}) => ({
  symbol: 'EURUSD', side: 'BUY', entry: 1.1000, sl: 1.0970, tp1: 1.1105,
  requestedVolume: 0.1, strategy: 'vwap_trend', timeframe: '1h', source: 'auto_signal',
  accountId: account, ...over,
})

const skips = (db, prefix = PREGATE_STAGE_PREFIX) => db.prepare(
  `SELECT account_id, symbol, stage, reason, loop_id FROM decision_log WHERE stage LIKE ? ORDER BY id`
).all(`${prefix}%`)
const riskRows = (db) => db.prepare(`SELECT COUNT(*) AS n FROM risk_events`).get().n

test('an account at 5/5 positions: ONE decision_log skip for the cycle, zero risk_events, however many symbols ask', () => {
  const db = fresh()
  for (let i = 0; i < DEFAULT_RISK_CONFIG.maxOpenPositions; i++) openPositionOn(db, A, `SYM${i}`)

  const first = accountPregate(db, A, { cycle: 7 })
  assert.equal(first.ok, false)
  assert.equal(first.guard, 'max_positions')
  assert.match(first.reason, /^max_positions=5\/5$/)
  // The fan-out asks once per symbol; the memo answers without a second row.
  for (const _ of ['EURUSD', 'XAUUSD', 'NAS100']) assert.equal(accountPregate(db, A, { cycle: 7 }).ok, false)

  const rows = skips(db)
  assert.equal(rows.length, 1, 'one skip row per account per cycle, not one per symbol')
  assert.equal(rows[0].stage, 'account_pregate:max_positions')
  assert.equal(rows[0].account_id, A)
  assert.equal(rows[0].loop_id, 7)
  assert.equal(riskRows(db), 0, 'a skipped account contributes no risk_events rows that cycle')

  // The next cycle asks again and writes its own row — the memo is per cycle.
  accountPregate(db, A, { cycle: 8 })
  assert.equal(skips(db).length, 2)
})

test('the backstop: evaluateTrade called directly on the same state still vetoes max_positions from the same helper', () => {
  const db = fresh()
  for (let i = 0; i < DEFAULT_RISK_CONFIG.maxOpenPositions; i++) openPositionOn(db, A, `SYM${i}`)
  const r = evaluateTrade(db, proposalFor(A), DEFAULT_RISK_CONFIG)
  assert.equal(r.approved, false)
  assert.match(r.veto_reason, /^max_positions=5\/5$/)
  assert.equal(r.checks.open_positions, 5)
})

test('a tripped daily loss cap: one skip, zero risk_events; the gate vetoes it too', () => {
  const db = fresh()
  closedToday(db, A, -500) // 10k balance → tier cap max(200, 4%) = 400; −500 trips it
  const v = accountPregate(db, A, { cycle: 1 })
  assert.equal(v.ok, false)
  assert.equal(v.guard, 'daily_loss_limit_hit')
  assert.match(v.reason, /^daily_loss_limit_hit pnl=-500\.00/)
  accountPregate(db, A, { cycle: 1 })
  assert.equal(skips(db).length, 1)
  assert.equal(skips(db)[0].stage, 'account_pregate:daily_loss_limit_hit')
  assert.equal(riskRows(db), 0)

  const r = evaluateTrade(db, proposalFor(A), DEFAULT_RISK_CONFIG)
  assert.equal(r.approved, false)
  assert.match(r.veto_reason, /^daily_loss_limit_hit/)
})

test('a loss streak in cooldown: the pre-gate names it; the gate names it', () => {
  const db = fresh()
  for (let i = 0; i < DEFAULT_RISK_CONFIG.maxConsecutiveLosses; i++) closedToday(db, A, -10)
  const v = accountPregateVerdict(db, A)
  assert.equal(v.ok, false)
  assert.equal(v.guard, 'loss_streak_cooldown')
  const r = evaluateTrade(db, proposalFor(A), DEFAULT_RISK_CONFIG)
  assert.match(r.veto_reason, /^loss_streak_cooldown/)
})

test('a balance borrowed from another account is refused by the pre-gate with the same words as the gate', () => {
  const db = fresh()
  const C = '11110003'
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')`).run(C, C)
  setState(db, 'account_balance_usd', '5000') // legacy global key only, three enabled accounts → ambiguous
  const v = accountPregateVerdict(db, C)
  assert.equal(v.guard, 'balance_not_account_scoped')
  const r = evaluateTrade(db, proposalFor(C), DEFAULT_RISK_CONFIG)
  assert.match(r.veto_reason, /^balance_not_account_scoped/)
  assert.equal(v.reason, r.veto_reason)
})

test('a clean account reaches the gate: pre-gate ok, no rows, and the gate approves the same proposal', () => {
  const db = fresh()
  const v = accountPregate(db, A, { cycle: 3 })
  assert.equal(v.ok, true)
  assert.ok(Array.isArray(v.openPositions))
  assert.equal(skips(db).length, 0)
  const pp = proposalPregate(db, A, proposalFor(A), { cycle: 3, account: v })
  assert.equal(pp.ok, true)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM decision_log`).get().n, 0)
  const r = evaluateTrade(db, proposalFor(A), DEFAULT_RISK_CONFIG)
  assert.equal(r.approved, true, r.veto_reason)
})

test('THE LEAK: a NULL-account active row no longer caps a scoped account; an unscoped evaluation still counts it', () => {
  const db = fresh()
  const cfg = { ...DEFAULT_RISK_CONFIG, maxOpenPositions: 2 }
  openPositionOn(db, A, 'AAA')
  openPositionOn(db, null, 'ORPHAN') // legacy, pre-stamping row

  assert.equal(openPositionsForAccount(db, A, { countOnly: true }).length, 1, 'the COUNT read: own rows only')
  assert.equal(openPositionsForAccount(db, null, { countOnly: true }).length, 2, 'unscoped count: legacy rows count')
  assert.equal(openPositionsForAccount(db, A).length, 2, 'every other consumer keeps the NULL-inclusive list')

  const scoped = evaluateTrade(db, { ...proposalFor(A), symbol: 'CCC' }, cfg)
  assert.ok(!/max_positions/.test(scoped.veto_reason || ''), `orphan row capped account …${A.slice(-4)}: ${scoped.veto_reason}`)
  assert.equal(scoped.checks.open_positions, 1)

  // No account on the proposal and no selected account → the legacy meaning
  // of "the account", where the orphan row does belong to the evaluation.
  setState(db, 'ctrader_account_id', null)
  const legacy = evaluateTrade(db, { ...proposalFor(A), symbol: 'CCC', accountId: undefined }, cfg)
  assert.match(legacy.veto_reason || '', /^max_positions=2\/2$/)
})

test('the pre-gate counts the same way: two own rows cap the account, an orphan and one own row do not', () => {
  const db = fresh()
  const cfg = { ...DEFAULT_RISK_CONFIG, maxOpenPositions: 2 }
  openPositionOn(db, A, 'AAA')
  openPositionOn(db, null, 'ORPHAN')
  assert.equal(accountPregateVerdict(db, A, { config: cfg }).ok, true)
  openPositionOn(db, A, 'BBB')
  assert.equal(accountPregateVerdict(db, A, { config: cfg }).guard, 'max_positions')
})

test('rr_prefilter: a 1.2R proposal is dropped before the gate with a decision_log skip and no risk_events row', () => {
  const db = fresh()
  const v = accountPregate(db, A, { cycle: 5 })
  assert.equal(v.ok, true)
  const p = proposalFor(A, { entry: 1.1000, sl: 1.0970, tp1: 1.1036 }) // 1.2R, under the producers' 1.5 floor and HARD_MIN_RR
  const pp = proposalPregate(db, A, p, { cycle: 5, account: v })
  assert.equal(pp.ok, false)
  assert.equal(pp.stage, RR_PREFILTER_STAGE)
  assert.match(pp.reason, new RegExp(`^bad_rr 1\\.20<${HARD_MIN_RR}`))
  const rows = skips(db, RR_PREFILTER_STAGE)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].symbol, 'EURUSD')
  assert.equal(rows[0].account_id, A)
  assert.equal(riskRows(db), 0, 'the gate was never called: no verdict row exists')
  // The same words the gate would have used, from the same function.
  assert.equal(rrFloorVerdict(db, { strategy: 'vwap_trend', rr: 1.2, accountId: A, config: DEFAULT_RISK_CONFIG, entry: 1.1000, sl: 1.0970, tp1: 1.1036, side: 'BUY' }).reason, pp.reason)
  assert.equal(evaluateTrade(db, p, DEFAULT_RISK_CONFIG).veto_reason, pp.reason)
})

test('rr_prefilter lets a proposal at the floor through, and never touches one with no target', () => {
  const db = fresh()
  const v = accountPregate(db, A, { cycle: 6 })
  assert.equal(proposalPregate(db, A, proposalFor(A, { tp1: 1.1105 }), { cycle: 6, account: v }).ok, true)
  assert.equal(proposalPregate(db, A, proposalFor(A, { tp1: null }), { cycle: 6, account: v }).ok, true)
  assert.equal(skips(db, RR_PREFILTER_STAGE).length, 0)
})

test('overexposed / correlated are proposal-level pre-gates on the memoised position read', () => {
  const db = fresh()
  const cfg = { ...DEFAULT_RISK_CONFIG, maxCurrencyExposure: 1, maxOpenPositions: 10 }
  openPositionOn(db, A, 'EURUSD')
  openPositionOn(db, A, 'EURGBP')
  const v = accountPregate(db, A, { cycle: 9, config: cfg })
  assert.equal(v.ok, true)
  const pp = proposalPregate(db, A, proposalFor(A, { symbol: 'EURJPY' }), { cycle: 9, account: v })
  assert.equal(pp.ok, false)
  assert.equal(pp.stage, 'account_pregate:overexposed')
  assert.match(pp.reason, /^overexposed_EUR=3$/)
  assert.equal(riskRows(db), 0)
  assert.match(evaluateTrade(db, proposalFor(A, { symbol: 'EURJPY' }), cfg).veto_reason, /^overexposed_EUR=3$/)
})

test('the pre-gate module never calls the gate or writes a risk event (comments stripped)', () => {
  const src = readFileSync(new URL('./account-pregate.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/evaluateTrade\s*\(/.test(src), 'the pre-gate is not the gate')
  assert.ok(!/persistRiskEvent/.test(src), 'a skip is not a veto')
  assert.ok(/recordDecision\(/.test(src))
})

test('loop wiring (comments stripped): the account pre-gate runs after the margin pool and before every other per-account stage; the proposal pre-gate runs right before autoTrade', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const fan = src.indexOf('for (const acct of apAccounts) {')
  assert.ok(fan > 0)
  const body = src.slice(fan, src.indexOf('return { fired, synth }', fan))
  const at = (needle) => { const i = body.indexOf(needle); assert.ok(i >= 0, `missing: ${needle}`); return i }
  const pregate = at('accountPregate(db, acct.accountId, { cycle: loopCount })')
  assert.ok(at("stage: 'margin_pool'") < pregate, 'margin pool first — the cheapest check')
  for (const later of ["stage: 'fundable_universe'", "stage: 'account_horizon'", "stage: 'stage_matrix'", "stage: 'ratchet_gate'", "stage: 'account_watchlist'", "stage: 'symbol_strategy'"]) {
    assert.ok(pregate < at(later), `${later} must come after the account pre-gate`)
  }
  const pp = at('proposalPregate(db, acct.accountId, {')
  const auto = at('const tradeResult = await autoTrade(db, sym, synth, acctItem, acct, { sharedAccounts: sharedAccountsForSignal })')
  assert.ok(at("stage: 'symbol_strategy'") < pp && pp < auto, 'the proposal pre-gate is the last stop before autoTrade')
  assert.ok(/if \(!pregate\.ok\) \{[\s\S]{0,300}?continue/.test(body), 'a refused account is skipped for this symbol')
  assert.ok(/if \(!pp\.ok\) \{[\s\S]{0,300}?continue/.test(body), 'a refused proposal is skipped')
})

test('THE ORDER WAS THE COUNT ONLY: a NULL-account row on X still trips duplicate_symbol, exposure and correlation for a scoped account', () => {
  const db = fresh()
  const cfg = { ...DEFAULT_RISK_CONFIG, maxOpenPositions: 5, maxCurrencyExposure: 1 }
  openPositionOn(db, null, 'EURUSD') // orphan on X
  const dup = evaluateTrade(db, proposalFor(A, { symbol: 'EURUSD' }), cfg)
  assert.match(dup.veto_reason || '', /^duplicate_symbol/, `a second position on X was allowed: ${dup.veto_reason}`)
  assert.equal(dup.checks.open_positions, 0, 'the count itself is scoped')
  openPositionOn(db, null, 'EURGBP')
  const expo = evaluateTrade(db, proposalFor(A, { symbol: 'EURJPY' }), cfg)
  assert.match(expo.veto_reason || '', /^overexposed_EUR=3$/)
  const v = accountPregateVerdict(db, A, { config: cfg })
  assert.equal(v.ok, true)
  assert.equal(v.openPositions.length, 2, 'the pre-gate hands the proposal checks the NULL-inclusive list')
  assert.equal(proposalPregate(db, A, proposalFor(A, { symbol: 'EURJPY' }), { account: v }).stage, 'account_pregate:overexposed')
})

test('the memo follows the book inside a cycle: a close re-admits the account, a fill re-refuses it, one row per change', () => {
  const db = fresh()
  for (let i = 0; i < DEFAULT_RISK_CONFIG.maxOpenPositions; i++) openPositionOn(db, A, `SYM${i}`)
  assert.equal(accountPregate(db, A, { cycle: 20 }).ok, false)
  assert.equal(accountPregate(db, A, { cycle: 20 }).ok, false)
  assert.equal(skips(db).length, 1)
  // A position closes mid-cycle (the monitor phase): the next symbol must not
  // find the account still skipped.
  db.prepare(`UPDATE monitored_positions SET status = 'closed' WHERE symbol = 'SYM0'`).run()
  assert.equal(accountPregate(db, A, { cycle: 20 }).ok, true)
  // A fill mid-cycle: refused again, and that is a new fact worth one row.
  openPositionOn(db, A, 'SYM9')
  assert.equal(accountPregate(db, A, { cycle: 20 }).guard, 'max_positions')
  assert.equal(accountPregate(db, A, { cycle: 20 }).guard, 'max_positions')
  assert.equal(skips(db).length, 2)
})

test('invalidateAccountPregate forces a re-ask for a change the book fingerprint cannot see', () => {
  const db = fresh()
  assert.equal(accountPregate(db, A, { cycle: 21 }).ok, true)
  closedToday(db, A, -500) // trips the daily cap; monitored_positions unchanged
  assert.equal(accountPregate(db, A, { cycle: 21 }).ok, true, 'memoised — the fingerprint did not move')
  invalidateAccountPregate(A)
  assert.equal(accountPregate(db, A, { cycle: 21 }).guard, 'daily_loss_limit_hit')
})

test('loop wiring (comments stripped): a placed order invalidates the account pre-gate memo', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(src, /const tradeResult = await autoTrade\(db, sym, synth, acctItem, acct, \{ sharedAccounts: sharedAccountsForSignal \}\)\s*if \(tradeResult\) \{\s*fired = true\s*invalidateAccountPregate\(acct\.accountId\)/)
})
