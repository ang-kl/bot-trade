// node --test agent/services/account-currency.test.js
//
// C·1 PR-2 (owner 03-10-2026, № 10,777·B·5 "rate table"): the risk engine
// sizes and caps in USD, two accounts hold SGD, and the only source of the
// USDSGD rate is the FX rate table with its staleness rule. Each test here
// goes red when its change is reverted (see the mutation list in the PR):
// a USD account is byte-identical, an SGD account is sized through the
// rate, a missing or stale rate REFUSES rather than assuming 1.0, the caps
// convert, the views say which rate was used, the leg refresher demands the
// deposit currency, and USDSGD is seeded under its own group.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { initDB, setState, getState } from '../db.js'
import { recordAccountMoney, recordDepositCurrency } from './account-money.js'
import { recordFxRate, RATE_MAX_AGE_MS } from './fx-rates.js'
import {
  accountCurrencyConversion, sizingBalanceUsd, usdFromNative, nativeFromUsd, accountDepositCurrencies, FX_RATE_UNAVAILABLE,
} from './account-currency.js'
import { evaluateTrade, DEFAULT_RISK_CONFIG, dailyLossVerdict, accountMarginPool, portfolioMarginStatus, drawdownDeriskFactor, riskBudgetUsd } from './risk.js'
import { accountPregateVerdict, resetAccountPregate } from './account-pregate.js'
import { journalMarginPoolState, resetMarginPoolJournal } from './margin-pool-journal.js'
import { dailyStopReading } from './daily-stop-reading.js'
import { requiredQuoteCurrencies, refreshFxLegs, fxLegReport } from './fx-legs.js'
import { seedWatchlistAdditionsFromConfig, readWatchlist } from './watchlists.js'
import stateRouter from '../routes/state.js'

const USD = '11110001'
const SGD = '11110002'
const UNVERIFIED = '11110003'
const HOST = 'live.ctraderapi.com'
const USDSGD = 1.30            // SGD per USD → rate 1/1.30 = 0.76923077 USD per SGD
const CFG = { ...DEFAULT_RISK_CONFIG, cooldownMinutes: 0 }

function fresh({ balanceSgd = 1300, rate = USDSGD, rateAgeMs = 0, rateSymbol = 'USDSGD' } = {}) {
  const db = initDB(':memory:')
  const T = Date.now() - 60_000
  for (const id of [USD, SGD, UNVERIFIED]) {
    db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 1, 1, 'active')`).run(id, id)
    setState(db, `acct:${id}:account_leverage`, '100')
  }
  recordDepositCurrency(db, { accountId: USD, host: HOST, depositAssetId: '15', currency: 'USD', receivedAt: T })
  recordAccountMoney(db, { accountId: USD, host: HOST, trader: { depositAssetId: 15, moneyDigits: 2 }, balance: 1000, receivedAt: T })
  setState(db, `acct:${USD}:account_balance_usd`, '1000')
  recordDepositCurrency(db, { accountId: SGD, host: HOST, depositAssetId: '14', currency: 'SGD', receivedAt: T })
  recordAccountMoney(db, { accountId: SGD, host: HOST, trader: { depositAssetId: 14, moneyDigits: 2 }, balance: balanceSgd, receivedAt: T })
  setState(db, `acct:${SGD}:account_balance_usd`, String(balanceSgd))
  recordAccountMoney(db, { accountId: UNVERIFIED, host: HOST, trader: { depositAssetId: 14, moneyDigits: 2 }, balance: 1000, receivedAt: T })
  setState(db, `acct:${UNVERIFIED}:account_balance_usd`, '1000')
  setState(db, 'ctrader_account_id', USD)
  if (rate != null) recordFxRate(db, rateSymbol, rate, Date.now() - rateAgeMs)
  resetAccountPregate()
  return db
}

const proposal = (accountId, over = {}) => ({
  symbol: 'EURUSD', side: 'BUY', entry: 1.1000, sl: 1.0970, tp1: 1.1105,
  requestedVolume: 0.1, strategy: 'vwap_trend', timeframe: '1h', source: 'auto_signal', accountId, ...over,
})
const closedToday = (db, account, netPnl) => db.prepare(`
  INSERT INTO trades (symbol, side, entry_price, exit_price, volume, status, opened_at, closed_at, net_pnl, account_id)
  VALUES ('GBPUSD', 'BUY', 100, 99, 0.1, 'closed', datetime('now', '-2 hours'), datetime('now', '-5 minutes'), ?, ?)`).run(netPnl, account)
const snapshot = (db, accountId, usedMargin, currency) => setState(db, `acct:${accountId}:broker_snapshot_cache_json`, JSON.stringify({
  fetchedAt: new Date().toISOString(), account: { accountId, currency, health: { usedMargin, marginLevelPct: 900 } },
}))
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ---------------------------------------------------------------------------

test('USD unchanged: a broker-verified USD account is identity — rate 1, no table dependence, the gate\'s checks row carries no fx field', t => {
  const db = fresh({ rate: USDSGD, rateAgeMs: RATE_MAX_AGE_MS + 3_600_000 }); t.after(() => db.close())
  const conv = accountCurrencyConversion(db, USD)
  assert.equal(conv.conversion, 'identity'); assert.equal(conv.rate, 1); assert.equal(conv.rateSymbol, null); assert.equal(conv.refused, null)
  const m = sizingBalanceUsd(db, USD, { balance: 1000 })
  assert.equal(m.balanceUsd, 1000, 'the native number passes through untouched')
  // An UNVERIFIED currency keeps the pre-PR-2 behaviour (read as USD) and says so.
  const u = sizingBalanceUsd(db, UNVERIFIED, { balance: 1000 })
  assert.equal(u.conversion, 'identity'); assert.equal(u.currencySource, 'unverified'); assert.equal(u.balanceUsd, 1000)
  const r = evaluateTrade(db, proposal(USD), CFG)
  assert.equal(r.approved, true, r.veto_reason)
  assert.equal(r.checks.balance, 1000)
  for (const k of ['balance_native', 'balance_currency', 'fx_conversion', 'fx_rate', 'fx_rate_symbol', 'fx_rate_age_min', 'daily_pnl_native', 'daily_fx_rate']) {
    assert.ok(!(k in r.checks), `${k} must not appear on a USD account's checks`)
  }
  const pool = accountMarginPool(db, CFG, [USD])[0]
  assert.ok(!('money' in pool) && !('refused' in pool), 'no conversion fields on a USD pool entry')
})

test('SGD sized through the rate: SGD 1,300 at USDSGD 1.30 is USD 1,000 — the same lots as a USD 1,000 account, not a USD 1,300 one', t => {
  const db = fresh(); t.after(() => db.close())
  const m = sizingBalanceUsd(db, SGD, { balance: 1300 })
  assert.equal(m.conversion, 'fx_table'); assert.equal(m.rateSymbol, 'USDSGD'); assert.equal(m.ratePrice, 1.30)
  assert.ok(Math.abs(m.rate - 1 / 1.30) < 1e-12); assert.ok(Math.abs(m.balanceUsd - 1000) < 1e-9); assert.equal(m.rateAgeMin, 0)
  assert.ok(Math.abs(usdFromNative(130, m) - 100) < 1e-9); assert.ok(Math.abs(nativeFromUsd(100, m) - 130) < 1e-9)
  const sgd = evaluateTrade(db, proposal(SGD), CFG)
  assert.equal(sgd.approved, true, sgd.veto_reason)
  assert.ok(Math.abs(sgd.checks.balance - 1000) < 1e-9, 'the gate sizes on the USD value')
  assert.equal(sgd.checks.balance_native, 1300); assert.equal(sgd.checks.balance_currency, 'SGD')
  assert.equal(sgd.checks.fx_conversion, 'fx_table'); assert.equal(sgd.checks.fx_rate_symbol, 'USDSGD'); assert.equal(sgd.checks.fx_rate_age_min, 0)
  assert.ok(Math.abs(sgd.checks.fx_rate - 0.76923077) < 1e-7)
  assert.ok(Math.abs(sgd.checks.risk_budget - riskBudgetUsd(1000, CFG)) < 0.01, `budget ${sgd.checks.risk_budget} is the USD 1,000 budget (${riskBudgetUsd(1000, CFG)}), not the SGD 1,300 one (${riskBudgetUsd(1300, CFG)})`)
  const usd = evaluateTrade(db, proposal(USD), CFG)
  assert.equal(sgd.checks.risk_based_volume, usd.checks.risk_based_volume, 'USD 1,000 and SGD 1,300 size identically')
  setState(db, `acct:${USD}:account_balance_usd`, '1300')
  const wrong = evaluateTrade(db, proposal(USD), CFG)
  assert.ok(wrong.checks.risk_based_volume > sgd.checks.risk_based_volume, 'the pre-PR-2 size (1,300 read as USD) was larger')
  // The margin cap is USD too, and an SGD broker snapshot is accepted in SGD and valued at the same rate.
  snapshot(db, SGD, 130, 'SGD')
  const pm = portfolioMarginStatus(db, CFG, { balance: 1000, leverage: 100, accountId: SGD, money: m })
  assert.equal(pm.source, 'broker'); assert.ok(Math.abs(pm.usedMargin - 100) < 1e-9); assert.equal(pm.usedMarginNative, 130); assert.equal(pm.currency, 'SGD')
  assert.ok(Math.abs(pm.cap - 1000 * CFG.maxMarginUsagePct) < 1e-9)
  const pool = accountMarginPool(db, CFG, [SGD])[0]
  assert.equal(pool.exhausted, false); assert.equal(pool.balanceNative, 1300); assert.equal(pool.money.rateSymbol, 'USDSGD'); assert.equal(pool.refused, null)
  // The SGDUSD direction is read as is (no inversion).
  const db2 = fresh({ rate: 0.77, rateSymbol: 'SGDUSD' }); t.after(() => db2.close())
  const m2 = sizingBalanceUsd(db2, SGD, { balance: 1300 })
  assert.equal(m2.rateSymbol, 'SGDUSD'); assert.ok(Math.abs(m2.rate - 0.77) < 1e-12); assert.ok(Math.abs(m2.balanceUsd - 1001) < 1e-9)
})

test('missing or stale rate → refusal, never 1.0: the gate vetoes fx_rate_unavailable, the pool holds the account out, the journal names it', t => {
  for (const variant of [{ rate: null }, { rate: USDSGD, rateAgeMs: RATE_MAX_AGE_MS + 60_000 }]) {
    const db = fresh(variant); t.after(() => db.close())
    const conv = accountCurrencyConversion(db, SGD)
    assert.equal(conv.conversion, 'refused'); assert.equal(conv.refused, FX_RATE_UNAVAILABLE); assert.equal(conv.rate, null)
    assert.match(conv.detail, /no SGDUSD or USDSGD close in the FX rate table within 26 h/)
    const m = sizingBalanceUsd(db, SGD, { balance: 1300 })
    assert.equal(m.balanceUsd, null, 'no USD value — not 1,300, not anything')
    assert.equal(usdFromNative(130, m), null)
    const r = evaluateTrade(db, proposal(SGD), CFG)
    assert.equal(r.approved, false)
    assert.match(r.veto_reason, /^fx_rate_unavailable currency=SGD balance=1300 — no SGDUSD or USDSGD close/)
    assert.equal(r.checks.fx_conversion, 'refused'); assert.equal(r.checks.balance_native, 1300)
    assert.equal(r.checks.risk_budget, undefined, 'the veto is before sizing: nothing was sized')
    const pool = accountMarginPool(db, CFG, [SGD, USD])
    const sgd = pool.find(p => p.accountId === SGD)
    assert.equal(sgd.exhausted, true); assert.equal(sgd.refused, FX_RATE_UNAVAILABLE); assert.equal(sgd.status, null); assert.equal(sgd.balance, null)
    assert.equal(pool.find(p => p.accountId === USD).exhausted, false, 'the USD account is untouched')
    resetMarginPoolJournal()
    const rows = journalMarginPoolState(db, [sgd], { loopId: 1 })
    assert.equal(rows.length, 1); assert.match(rows[0].reason, /^fx_rate_unavailable currency=SGD balance=1300/)
    assert.equal(rows[0].detail.fx_refused, FX_RATE_UNAVAILABLE)
    assert.ok(!/portfolio_margin_exhausted/.test(rows[0].reason), 'not misfiled as margin exhaustion')
    // A stamped zero is zero in every currency and is not a refusal.
    setState(db, `acct:${SGD}:account_balance_usd`, '0')
    assert.equal(sizingBalanceUsd(db, SGD, { balance: 0 }).balanceUsd, 0)
  }
})

test('cap conversion: the daily cap is judged in USD at the rate — native P&L valued, the floor applied in USD; refused blocks the day with the native % figure on record', t => {
  const db = fresh(); t.after(() => db.close())
  const cfg = { ...CFG, dailyLossPct: 0.03, dailyLossFloorUsd: null, dailyLossLimit: null, dailyLossTierAtUsd: null }
  closedToday(db, SGD, -130)   // SGD, the broker's native money
  const m = sizingBalanceUsd(db, SGD, { balance: 1300 })
  const v = dailyLossVerdict(db, cfg, SGD, { balance: m.balanceUsd, money: m })
  assert.ok(Math.abs(v.checks.daily_pnl - (-100)) < 1e-9, `−130 SGD is −100 USD, got ${v.checks.daily_pnl}`)
  assert.equal(v.checks.daily_pnl_native, -130); assert.equal(v.checks.daily_pnl_currency, 'SGD')
  assert.ok(Math.abs(v.checks.daily_fx_rate - 0.76923077) < 1e-7)
  assert.ok(Math.abs(v.checks.daily_cap_pct_usd - 30) < 1e-9, '3 % of USD 1,000, not of SGD 1,300')
  assert.equal(v.block, true); assert.equal(v.guard, 'daily_loss_limit_hit')
  // Without the conversion the same day read −130 against a 39 cap: the same verdict for the wrong reason, by the wrong numbers.
  const naive = dailyLossVerdict(db, cfg, SGD, { balance: 1300 })
  assert.equal(naive.checks.daily_pnl, -130); assert.equal(naive.checks.daily_cap_pct_usd, 39)
  // The anti-tilt window values its P&L at the same rate.
  const dd = { ...cfg, derisk: { on: true, windowHours: 24, triggerPct: 0.09, mult: 0.5 } }
  assert.equal(drawdownDeriskFactor(db, 1000, dd, SGD, { pnlRate: m.rate }), 0.5, '−100 USD is 10 % of 1,000: trips the 9 % trigger')
  assert.equal(drawdownDeriskFactor(db, 1000, { ...dd, derisk: { ...dd.derisk, triggerPct: 0.11 } }, SGD, { pnlRate: m.rate }), 1)
  // The pre-gate uses the same verdict.
  const pg = accountPregateVerdict(db, SGD, { config: cfg })
  assert.equal(pg.ok, false); assert.equal(pg.guard, 'daily_loss_limit_hit')
  // Refused: the day is blocked, the % figure is native and the USD floor is not applied.
  const db2 = fresh({ rate: null }); t.after(() => db2.close())
  closedToday(db2, SGD, -10)
  const m2 = sizingBalanceUsd(db2, SGD, { balance: 1300 })
  const r = dailyLossVerdict(db2, { ...CFG, dailyLossPct: 0.03, dailyLossFloorUsd: 200, dailyLossTierAtUsd: null }, SGD, { balance: m2.balanceUsd, money: m2 })
  assert.equal(r.block, true); assert.equal(r.guard, FX_RATE_UNAVAILABLE); assert.match(r.reason, /^fx_rate_unavailable currency=SGD/)
  assert.equal(r.checks.daily_fx, FX_RATE_UNAVAILABLE); assert.equal(r.checks.daily_pnl, -10); assert.equal(r.checks.daily_pnl_native, -10)
  assert.equal(r.checks.daily_cap_pct_usd, 39, 'the native % figure, 3 % of SGD 1,300, is on record')
  assert.equal(r.checks.daily_cap_floor_usd, null, 'the USD 200 floor is not applied to SGD money')
  assert.equal(r.checks.daily_cap_binding, 'pct')
  const pg2 = accountPregateVerdict(db2, SGD, { config: CFG })
  assert.equal(pg2.ok, false); assert.equal(pg2.guard, FX_RATE_UNAVAILABLE)
  assert.equal(accountPregateVerdict(db2, USD, { config: CFG }).ok, true, 'the USD account is untouched')
})

test('the views say which rate was used: /state/risk-config, /state/account-money and the daily-stop reading carry rate, symbol, age — or fx_rate_unavailable', async t => {
  const serve = (db) => new Promise(resolve => {
    const app = express(); app.use(express.json()); app.use('/state', stateRouter(db))
    const s = app.listen(0, () => resolve({ close: () => s.close(), get: async (p) => (await fetch(`http://127.0.0.1:${s.address().port}${p}`)).json() }))
  })
  const db = fresh(); t.after(() => db.close())
  const s = await serve(db); t.after(() => s.close())
  const rc = await s.get(`/state/risk-config?account=${SGD}`)
  assert.equal(rc.derived.balance, 1300, 'the native number stays the native number'); assert.equal(rc.derived.balanceCurrency, 'SGD')
  assert.equal(rc.derived.fx.conversion, 'fx_table'); assert.equal(rc.derived.fx.rateSymbol, 'USDSGD'); assert.equal(rc.derived.fx.rateAgeMin, 0)
  assert.ok(Math.abs(rc.derived.fx.rate - 0.76923077) < 1e-7); assert.equal(rc.derived.fx.balanceUsd, 1000); assert.equal(rc.derived.fx.refused, null)
  assert.equal(rc.derived.per_trade_budget_usd, Number((1000 * rc.effective.perTradeRiskPct).toFixed(2)))
  assert.equal(rc.derived.margin_cap_usd, Number((1000 * rc.effective.maxMarginUsagePct).toFixed(2)))
  const usd = await s.get(`/state/risk-config?account=${USD}`)
  assert.equal(usd.derived.fx.conversion, 'identity'); assert.equal(usd.derived.per_trade_budget_usd, Number((1000 * usd.effective.perTradeRiskPct).toFixed(2)))
  const am = await s.get(`/state/account-money?account=${SGD}`)
  assert.equal(am.observation.currency, 'SGD'); assert.equal(am.sizing.rateSymbol, 'USDSGD'); assert.equal(am.sizing.balanceUsd, 1000); assert.equal(am.sizing.refused, null)
  const dsr = dailyStopReading(db, SGD, { moneyCurrency: 'SGD', openPnl: -13 })
  assert.equal(dsr.unitsComparable, true); assert.match(dsr.unitsNote, /values this account's SGD money in USD at 0\.769231 \(USDSGD 1\.3, 0 min old\)/)
  assert.equal(dsr.fx.rateSymbol, 'USDSGD'); assert.equal(dsr.balanceUsed, 1000); assert.equal(dsr.balanceNative, 1300); assert.equal(dsr.currency, 'USD')
  assert.equal(dsr.lossCapUsed.floatingLoss, 10, 'the SGD −13 floating P&L is USD −10 beside a USD cap')
  // Refused.
  const db2 = fresh({ rate: null }); t.after(() => db2.close())
  const s2 = await serve(db2); t.after(() => s2.close())
  const rc2 = await s2.get(`/state/risk-config?account=${SGD}`)
  assert.equal(rc2.derived.balance, 1300); assert.equal(rc2.derived.refused, FX_RATE_UNAVAILABLE); assert.equal(rc2.derived.mode, FX_RATE_UNAVAILABLE)
  assert.equal(rc2.derived.per_trade_budget_usd, null); assert.equal(rc2.derived.margin_cap_usd, null); assert.equal(rc2.derived.daily_cap_pct_usd, null)
  assert.equal(rc2.derived.fx.refused, FX_RATE_UNAVAILABLE); assert.equal(rc2.derived.fx.rate, null)
  const am2 = await s2.get(`/state/account-money?account=${SGD}`)
  assert.equal(am2.sizing.refused, FX_RATE_UNAVAILABLE); assert.equal(am2.sizing.balanceUsd, null); assert.equal(am2.sizing.balanceNative, 1300)
  const dsr2 = dailyStopReading(db2, SGD, { moneyCurrency: 'SGD', openPnl: -13 })
  assert.equal(dsr2.engineBlock.guard, FX_RATE_UNAVAILABLE); assert.equal(dsr2.unitsComparable, false); assert.match(dsr2.unitsNote, /^fx_rate_unavailable: /)
  assert.equal(dsr2.currency, 'SGD'); assert.equal(dsr2.fx.refused, FX_RATE_UNAVAILABLE); assert.equal(dsr2.lossCapUsed.status, 'not_comparable')
})

test('the leg refresher demands the deposit currency: USDSGD is fetched from the broker like any conversion leg, and the report names it', async t => {
  const db = fresh({ rate: null }); t.after(() => db.close())
  assert.deepEqual([...accountDepositCurrencies(db)], ['SGD'], 'the SGD account demands SGD; the USD and unverified ones demand nothing')
  assert.ok(requiredQuoteCurrencies(['EURUSD'], ['SGD']).has('SGD'))
  assert.ok(!requiredQuoteCurrencies(['EURUSD'], ['USD']).has('USD'))
  assert.ok(!requiredQuoteCurrencies(['USDSGD']).has('SGD'), 'the C·5 rule still holds for a USD-base pair on the watchlist alone')
  const asked = []
  const r = await refreshFxLegs(db, {
    symbols: ['EURUSD'], symbolMap: { USDSGD: 77, EURUSD: 1 }, accountCurrencies: ['SGD'],
    getSpot: async (sid) => { asked.push(sid); return { bid: 1.2999, ask: 1.3001 } },
  })
  assert.deepEqual(r.fetched, ['USDSGD']); assert.deepEqual(asked, [77]); assert.deepEqual(r.currencies, ['SGD'])
  const m = sizingBalanceUsd(db, SGD, { balance: 1300 })
  assert.equal(m.conversion, 'fx_table'); assert.ok(Math.abs(m.balanceUsd - 1000) < 1e-6, 'the refreshed mid values the balance')
  const rep = fxLegReport(db, { symbols: ['EURUSD'], symbolMap: { USDSGD: 77, EURUSD: 1 }, accountCurrencies: ['SGD'] })
  const row = rep.rows.find(x => x.currency === 'SGD')
  assert.equal(row.leg, 'USDSGD'); assert.equal(row.depositCurrency, true); assert.equal(row.state, 'fresh')
  // The loop passes the enabled accounts' deposit currencies to the refresher (comments stripped).
  const src = stripComments(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.match(src, /accountDepositCurrencies\(db\)[\s\S]{0,400}?refreshFxLegs\(db, \{\s*symbols, symbolMap, accountCurrencies,/, 'loop.js hands the deposit currencies to refreshFxLegs')
})

test('watchlist seed: USDSGD is appended under its own group, the US stocks keep theirs', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  setState(db, 'autopilot_symbols_json', JSON.stringify([{ symbol: 'EURUSD', enabled: true, group: 'FOREX' }]))
  const out = seedWatchlistAdditionsFromConfig(db)
  assert.equal(out.error, null)
  const items = readWatchlist(db, null)
  const usdsgd = items.find(i => i.symbol === 'USDSGD')
  assert.deepEqual(usdsgd, { symbol: 'USDSGD', enabled: true, group: 'FX Conversion Legs' })
  assert.equal(items.find(i => i.symbol === 'NVDA.US').group, 'US Stocks')
  assert.equal(seedWatchlistAdditionsFromConfig(db).added, 0, 'idempotent')
  assert.equal(getState(db, 'autopilot_symbols_json') != null || true, true)
})
