// node --test agent/services/fundable-universe.test.js
//
// §7,437·B·3 (owner, 08-09-2026): the pre-trade budget planner. Once a day
// per account, at the minimum lot, against the account's risk budget and its
// pool headroom — a table, not an hourly refusal. The gates read it before an
// order is built; unknown is never a block.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { initDB, setState, getState } from '../db.js'
import { DEFAULT_RISK_CONFIG } from './risk.js'
import { writeWatchlist } from './watchlists.js'
import { planFundability, buildFundableUniverse, isFundable, fundableDue, fundableUniverseReport, FUNDABLE_KEY, FUNDABLE_LAST_KEY, FUNDABLE_REBUILD_KEY } from './fundable-universe.js'
import stateRouter from '../routes/state.js'
import actionsRouter from '../routes/actions.js'

const T0 = Date.parse('2026-09-08T10:00:00Z')

test('planFundability: fundable, risk-budget bound (with the % that would fund it), margin bound, no price', () => {
  // EURUSD min lot 0.01 at 1.10 with a 1% reference stop: 0.011 × 100,000 × 0.01 lot = $11 risk per min lot
  const ok = planFundability({ symbol: 'EURUSD', price: 1.1, minLot: 0.01, balance: 1000, riskBudgetUsd: 20, headroomUsd: 500, refStopPct: 1, leverage: 100 })
  assert.equal(ok.ok, true, ok.reason); assert.equal(ok.minLotRiskUsd, 11); assert.equal(ok.stopSource, 'ref_1pct'); assert.equal(ok.lotsAtBudget, 0.01)
  const poor = planFundability({ symbol: 'EURUSD', price: 1.1, minLot: 0.01, balance: 100, riskBudgetUsd: 1, headroomUsd: 50, refStopPct: 1, leverage: 100 })
  assert.equal(poor.ok, false); assert.match(poor.reason, /^risk_budget/); assert.equal(poor.neededRiskPct, 11, '$11 on a $100 account needs 11% per trade')
  const tight = planFundability({ symbol: 'EURUSD', price: 1.1, minLot: 0.01, balance: 1000, riskBudgetUsd: 20, headroomUsd: 5, refStopPct: 1, leverage: 100 })
  assert.equal(tight.ok, false); assert.match(tight.reason, /^margin/); assert.equal(tight.minLotMarginUsd, 11)
  assert.equal(planFundability({ symbol: 'EURUSD', price: null, minLot: 0.01, balance: 1000, riskBudgetUsd: 20 }).reason, 'no_price')
  assert.equal(planFundability({ symbol: 'EURUSD', price: 1.1, minLot: null, balance: 1000, riskBudgetUsd: 20 }).reason, 'no_lot_meta')
  // an ATR on record is the reference stop, and says so
  const atr = planFundability({ symbol: 'EURUSD', price: 1.1, minLot: 0.01, balance: 1000, riskBudgetUsd: 20, atr: 0.022, refStopPct: 1, leverage: 100 })
  assert.equal(atr.stopSource, 'atr_14'); assert.equal(atr.minLotRiskUsd, 22)
})

function fakes({ prices = {}, minVolume = 100 } = {}) {
  return {
    symbolIdFor: async (_c, symbol) => (symbol in prices ? Object.keys(prices).indexOf(symbol) + 1 : null),
    volumeMeta: async () => ({ lotSize: 10_000, minVolume }),             // 0.01 lot minimum
    spot: async (_c, sid) => { const sym = Object.keys(prices)[sid - 1]; return { bid: prices[sym], ask: prices[sym] } },
    rates: () => null,
    headroomOf: () => 500,
    atrOf: () => null,
  }
}

test('buildFundableUniverse: writes the account record and the summary, one row per enabled watchlist symbol', async () => {
  const db = initDB(':memory:')
  setState(db, 'acct:A:account_balance_usd', '1000')  // budget = min(20% risk, 1.5% cap) = $15
  writeWatchlist(db, 'A', [{ symbol: 'EURUSD' }, { symbol: 'XAUUSD' }, { symbol: 'OFF', enabled: false }, { symbol: 'NOPE' }])
  const rec = await buildFundableUniverse(db, { accountId: 'A', creds: {}, deps: fakes({ prices: { EURUSD: 1.1, XAUUSD: 2400 } }), now: T0, config: { ...DEFAULT_RISK_CONFIG, perTradeRiskPct: 0.2 } })
  assert.equal(rec.summary.total, 3, 'the disabled row is not counted')
  assert.equal(rec.rows.EURUSD.ok, true, rec.rows.EURUSD.reason)          // $11 risk vs $15 budget
  assert.equal(rec.rows.XAUUSD.ok, false, '$24 at min lot vs $15'); assert.match(rec.rows.XAUUSD.reason, /^risk_budget/)
  assert.equal(rec.rows.NOPE.reason, 'unknown_symbol')
  assert.equal(rec.summary.fundable, 1)
  assert.deepEqual(rec.summary.byReason, { fundable: 1, risk_budget: 1, unknown_symbol: 1 })
  assert.equal(JSON.parse(getState(db, FUNDABLE_KEY('A'))).at, new Date(T0).toISOString())
  assert.equal(JSON.parse(getState(db, FUNDABLE_LAST_KEY)).accounts.A.fundable, 1, 'the summary record dates the controller')
})

test('isFundable and fundableDue: unknown is never a block; a stale record is not enforced; a rebuild request makes it due', async () => {
  const db = initDB(':memory:')
  assert.equal(isFundable(db, 'A', 'EURUSD').ok, true); assert.equal(isFundable(db, 'A', 'EURUSD').known, false)
  assert.equal(fundableDue(db, 'A', T0), true, 'no record is due')
  setState(db, 'acct:A:account_balance_usd', '1000')
  writeWatchlist(db, 'A', [{ symbol: 'EURUSD' }, { symbol: 'XAUUSD' }])
  await buildFundableUniverse(db, { accountId: 'A', creds: {}, deps: fakes({ prices: { EURUSD: 1.1, XAUUSD: 2400 } }), now: T0, config: { ...DEFAULT_RISK_CONFIG, perTradeRiskPct: 0.2 } })
  assert.equal(isFundable(db, 'A', 'EURUSD', { now: T0 + 3600_000 }).ok, true)
  const lly = isFundable(db, 'A', 'XAUUSD', { now: T0 + 3600_000 })
  assert.equal(lly.ok, false); assert.equal(lly.known, true); assert.match(lly.reason, /unfundable at min lot — risk_budget/)
  assert.equal(isFundable(db, 'A', 'GBPUSD', { now: T0 + 3600_000 }).known, false, 'a symbol the record never saw')
  assert.equal(isFundable(db, 'A', 'XAUUSD', { now: T0 + 4 * 86_400_000 }).ok, true, '3 days old is not enforced')
  assert.equal(fundableDue(db, 'A', T0 + 3600_000), false)
  assert.equal(fundableDue(db, 'A', T0 + 25 * 3600_000), true, 'a day old is due')
  setState(db, FUNDABLE_REBUILD_KEY, String(T0 + 60_000))
  assert.equal(fundableDue(db, 'A', T0 + 3600_000), true, 'a rebuild requested after the record makes it due')
  const rep = fundableUniverseReport(db, ['A', 'B'], { now: T0 + 3600_000 })
  assert.equal(rep.accounts[0].unfundable[0].symbol, 'XAUUSD'); assert.ok(rep.accounts[0].unfundable[0].neededRiskPct > 0)
  assert.equal(rep.accounts[1].record, null); assert.equal(rep.accounts[1].due, true)
})

test('routes: GET /state/fundable-universe reports every enabled account; POST /actions/fundable-universe queues a rebuild', async () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('A','1',0,1,'active')`).run()
  const app = express(); app.use(express.json()); app.use('/state', stateRouter(db)); app.use('/actions', actionsRouter(db))
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)) })
  const url = (p) => `http://127.0.0.1:${s.address().port}${p}`
  try {
    const r = await fetch(url('/state/fundable-universe')).then(x => x.json())
    assert.equal(r.accounts.length, 1); assert.equal(r.accounts[0].accountId, 'A'); assert.equal(r.accounts[0].record, null)
    const p = await fetch(url('/actions/fundable-universe'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(x => x.json())
    assert.equal(p.ok, true); assert.equal(p.queued, true)
    assert.ok(Number(getState(db, FUNDABLE_REBUILD_KEY)) > 0)
  } finally { s.close() }
})

test('wiring pin: the fan-out skips an unfundable name by name, the book consults the same record, and the loop builds one due account per cycle', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  const book = strip(readFileSync(new URL('./momentum-book.js', import.meta.url), 'utf8'))
  assert.match(loop, /const fu = isFundable\(db, acct\.accountId, sym\)\s+if \(!fu\.ok\) \{[\s\S]{0,600}?stage: 'fundable_universe'[\s\S]{0,200}?continue\s+\}/, 'the fan-out gate, with its decision row')
  assert.match(loop, /const due = getAutopilotAccounts\(db\)\.find\(a => fundableDue\(db, a\.accountId\)\)[\s\S]{0,2500}?await buildFundableUniverse\(db, \{[\s\S]{0,1800}?await hbeat\(db, 'fundable_universe'\)/, 'one due account is built per cycle and the controller beats')
  assert.match(loop, /hbeat\(db, 'fundable_universe', false/, 'the failure path beats too')
  assert.match(loop, /fundable: \(accountId, symbol\) => isFundable\(db, accountId, symbol\)/, 'the book is handed the same reader')
  assert.match(book, /const fu = deps\.fundable\(accountId, symbol\)\s+if \(fu && fu\.ok === false\) \{ summary\.skipped\.push/, 'the book skips an unfundable name before fetching')
})
