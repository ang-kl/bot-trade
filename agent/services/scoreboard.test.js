// node --test agent/services/scoreboard.test.js
// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { recordAccountMoney, recordDepositCurrency } from './account-money.js'
import { buildScoreboard, readScoreboard, scoreMetrics, exclusionOf, EXTERNAL_SOURCES, SCOREBOARD_TRADES } from './scoreboard.js'

const NOW = Date.parse('2026-10-10T08:00:00Z'), H = 3_600_000, DAY = 24 * H
let seq = 0
const row = (over = {}) => ({ id: ++seq, status: 'closed', account_id: '111', symbol: 'EURUSD', side: 'BUY', strategy: 'vwap_trend',
  label_strategy: null, close_reason: 'tp_hit', net_pnl: 1, realised_rr: 1, exit_price_suspect: null,
  closed_at: null, closed_at_ms: NOW - H, source: 'autopilot', ...over })

test('formulas: win rate, PF, payoff, expectancy and R over one set of rows', () => {
  const m = scoreMetrics([row({ net_pnl: 6, realised_rr: 2 }), row({ net_pnl: 3, realised_rr: 1 }),
    row({ net_pnl: -2, realised_rr: -1 }), row({ net_pnl: -4, realised_rr: -1 }), row({ net_pnl: 0, realised_rr: 0 })])
  assert.equal(m.n, 5); assert.equal(m.wins, 2); assert.equal(m.losses, 2); assert.equal(m.zeros, 1)
  assert.equal(m.winRatePct, 40)
  assert.equal(m.grossWin, 9); assert.equal(m.grossLoss, 6)
  assert.equal(m.profitFactor, 1.5)
  assert.equal(m.avgWin, 4.5); assert.equal(m.avgLoss, 3)
  assert.equal(m.payoff, 1.5)
  assert.equal(m.net, 3); assert.equal(m.expectancy, 0.6)
  assert.equal(m.rScored, 5); assert.equal(m.expectancyR, 0.2); assert.equal(m.profitFactorR, 1.5)
})

test('no losses: PF and PF(R) are null, never Infinity or 0; zero rows: every ratio null', () => {
  const m = scoreMetrics([row({ net_pnl: 2 }), row({ net_pnl: 3 })])
  assert.equal(m.profitFactor, null); assert.equal(m.profitFactorR, null); assert.equal(m.payoff, null)
  assert.equal(m.winRatePct, 100)
  const z = scoreMetrics([])
  assert.deepEqual([z.n, z.winRatePct, z.profitFactor, z.expectancy, z.net, z.expectancyR, z.avgWin, z.avgLoss],
    [0, null, null, null, null, null, null, null])
  const out = buildScoreboard([], { now: NOW, accounts: [{ accountId: '111', currency: 'SGD' }] })
  assert.equal(out.accounts.length, 1)
  assert.equal(out.accounts[0].last20.n, 0)
  assert.deepEqual(out.accounts[0].last20.rows, [])
})

test('R excludes a suspect exit price and a non-finite realised_rr; the money figure stays', () => {
  const m = scoreMetrics([row({ net_pnl: 5, realised_rr: 9, exit_price_suspect: 1 }), row({ net_pnl: -1, realised_rr: -1 }),
    row({ net_pnl: 2, realised_rr: null }), row({ net_pnl: 2, realised_rr: 'x' })])
  assert.equal(m.n, 4); assert.equal(m.net, 8)
  assert.equal(m.rScored, 1); assert.equal(m.expectancyR, -1)
  const out = buildScoreboard([row({ net_pnl: 5, realised_rr: 9, exit_price_suspect: 1 })], { now: NOW })
  assert.equal(out.accounts[0].last20.rows[0].realised_rr, null)
  assert.equal(out.accounts[0].last20.rows[0].net_pnl, 5)
})

test('exclusions: superseded duplicates, unpriced, unstamped and not-closed rows are outside the population', () => {
  assert.equal(exclusionOf(row({ close_reason: 'duplicate_adoption: superseded by trade 7 (reopened)' })), 'superseded')
  assert.equal(exclusionOf(row({ close_reason: 'Superseded duplicate' })), 'superseded')
  assert.equal(exclusionOf(row({ net_pnl: null })), 'unpriced')
  assert.equal(exclusionOf(row({ net_pnl: '' })), 'unpriced')
  assert.equal(exclusionOf(row({ net_pnl: Number.NaN })), 'unpriced')
  assert.equal(exclusionOf(row({ account_id: null })), 'unstamped')
  assert.equal(exclusionOf(row({ account_id: '  ' })), 'unstamped')
  assert.equal(exclusionOf(row({ status: 'open' })), 'not_closed')
  assert.equal(exclusionOf(row()), null)
  const out = buildScoreboard([row({ net_pnl: 10 }), row({ net_pnl: 100, close_reason: 'duplicate_adoption: superseded by trade 1' }),
    row({ net_pnl: null }), row({ account_id: null, net_pnl: 50 }), row({ status: 'open', net_pnl: 70 })], { now: NOW })
  assert.equal(out.accounts.length, 1)
  assert.equal(out.accounts[0].last20.n, 1)
  assert.equal(out.accounts[0].last20.net, 10)
  assert.deepEqual(out.excluded, { unpriced: 1, unstamped: 1, superseded: 1 })
})

test('newest first by closed_at_ms, falling back to closed_at, ties by id; only the 20 newest', () => {
  const rows = []
  for (let i = 0; i < 25; i++) rows.push(row({ id: 100 + i, closed_at_ms: NOW - (i + 2) * H, net_pnl: i }))
  // No ms stamp: its closed_at (SQLite and ISO formats) places it newest and third.
  rows.push(row({ id: 1, closed_at_ms: null, closed_at: new Date(NOW - 30 * 60_000).toISOString().replace('T', ' ').slice(0, 19), net_pnl: -9 }))
  rows.push(row({ id: 2, closed_at_ms: null, closed_at: new Date(NOW - 2.5 * H).toISOString(), net_pnl: -8 }))
  // Same instant as id 100: the higher id is newer.
  rows.push(row({ id: 300, closed_at_ms: NOW - 2 * H, net_pnl: -7 }))
  const out = buildScoreboard(rows, { now: NOW })
  const ids = out.accounts[0].last20.rows.map(r => r.id)
  assert.equal(ids.length, SCOREBOARD_TRADES)
  assert.deepEqual(ids.slice(0, 4), [1, 300, 100, 2])
  assert.equal(out.accounts[0].last20.rows[0].closed_at, new Date(NOW - 30 * 60_000).toISOString())
  assert.ok(!ids.includes(124), 'the oldest closes fall outside the 20')
})

test('currency separation: each account keeps its own currency and money; nothing is summed across accounts', () => {
  const rows = [row({ account_id: '111', net_pnl: 10 }), row({ account_id: '111', net_pnl: -4 }),
    row({ account_id: '222', net_pnl: 1000 }), row({ account_id: '222', net_pnl: -500 })]
  const out = buildScoreboard(rows, { now: NOW, accounts: [{ accountId: '111', currency: 'SGD' }, { accountId: '222', currency: 'USD' }] })
  const a = out.accounts.find(x => x.accountId === '111'), b = out.accounts.find(x => x.accountId === '222')
  assert.equal(a.currency, 'SGD'); assert.equal(b.currency, 'USD')
  assert.equal(a.last20.net, 6); assert.equal(b.last20.net, 500)
  assert.equal(a.days30.net, 6); assert.equal(b.days30.net, 500)
  assert.equal(a.label, '…111'); assert.equal(b.label, '…222')
  // The pooled line is unit-free: counts and R only, no money key at all.
  for (const k of ['net', 'grossWin', 'grossLoss', 'profitFactor', 'expectancy', 'avgWin', 'avgLoss']) {
    assert.equal(k in out.pooled.days30, false, `pooled carries no ${k}`)
  }
  assert.equal(out.pooled.days30.n, 4)
  // 6 + 500 (net) and 10 + 1000 (gross win) are the cross-account sums: neither appears anywhere.
  assert.equal(/\b506\b|\b1010\b/.test(JSON.stringify(out)), false, 'no cross-account money sum')
  // An unverified currency stays null; it is never borrowed from another account.
  const c = buildScoreboard([row({ account_id: '333' })], { now: NOW, accounts: [{ accountId: '333', currency: 'usd' }] })
  assert.equal(c.accounts[0].currency, null)
})

test('bot versus external: source external/manual are not the bot; last 20 bot is its own selection', () => {
  assert.deepEqual([...EXTERNAL_SOURCES], ['external', 'manual'])
  const rows = []
  for (let i = 0; i < 20; i++) rows.push(row({ closed_at_ms: NOW - (i + 1) * H, net_pnl: -1, source: i % 2 ? 'manual' : 'External' }))
  for (let i = 0; i < 20; i++) rows.push(row({ closed_at_ms: NOW - (30 + i) * H, net_pnl: 2, source: i === 0 ? null : 'autopilot' }))
  const out = buildScoreboard(rows, { now: NOW })
  const a = out.accounts[0]
  assert.equal(a.last20.n, 20); assert.equal(a.last20.externalN, 20); assert.equal(a.last20.net, -20)
  assert.equal(a.last20.bot.n, 20, 'the 20 newest BOT closes, from further back')
  assert.equal(a.last20.bot.net, 40)
  assert.equal(a.days30.n, 40); assert.equal(a.days30.bot.n, 20); assert.equal(a.days30.externalN, 20)
  assert.equal(out.pooled.days30Bot.n, 20)
})

test('the window: closes within `days` of now only; an older close is in last 20 but not the window', () => {
  const out = buildScoreboard([row({ closed_at_ms: NOW - 2 * DAY, net_pnl: 3 }), row({ closed_at_ms: NOW - 40 * DAY, net_pnl: -5 }),
    row({ closed_at_ms: NOW + DAY, net_pnl: 9 })], { now: NOW, days: 30 })
  const a = out.accounts[0]
  assert.equal(a.last20.n, 3)
  assert.equal(a.days30.n, 1); assert.equal(a.days30.net, 3); assert.equal(a.days30.days, 30)
})

test('readScoreboard: one indexed scan, bounded buffers, the goal tracker\'s currency source, scoped reads', () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO accounts(account_id, broker_label, enabled) VALUES ('111','P',1), ('222','P',1)").run()
  // balanceUnit reads with the wall clock, so the observation is stamped by it.
  const wall = Date.now()
  recordDepositCurrency(db, { accountId: '111', host: 'demo.ctraderapi.com', depositAssetId: '7', currency: 'SGD', receivedAt: wall - 1000 })
  recordAccountMoney(db, { accountId: '111', host: 'demo.ctraderapi.com', trader: { depositAssetId: '7', ctidTraderAccountId: 111 }, balance: 50, receivedAt: wall - 500 })
  const ins = db.prepare(`INSERT INTO trades(symbol, side, status, account_id, net_pnl, realised_rr, exit_price_suspect, closed_at_ms, source, close_reason)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
  // 300 closes on 111 spread over 300 days: far more than the buffer bound.
  for (let i = 0; i < 300; i++) ins.run('EURUSD', 'BUY', 'closed', '111', i % 2 ? 2 : -1, i % 2 ? 1 : -0.5, null, NOW - i * DAY - H, i % 3 ? 'autopilot' : 'manual', 'tp')
  ins.run('GBPUSD', 'SELL', 'closed', '222', 7, 1, 1, NOW - H, 'autopilot', 'duplicate_adoption: superseded by trade 9')
  ins.run('GBPUSD', 'SELL', 'closed', '222', 4, 1, 1, NOW - H, 'autopilot', 'sl_hit')
  ins.run('GBPUSD', 'SELL', 'closed', null, 4, 1, null, NOW - H, 'autopilot', 'sl_hit')
  ins.run('GBPUSD', 'SELL', 'open', '222', null, null, null, null, 'autopilot', null)
  const out = readScoreboard(db, { account: 'all', days: 30, now: NOW })
  const a = out.accounts.find(x => x.accountId === '111'), b = out.accounts.find(x => x.accountId === '222')
  assert.equal(a.currency, 'SGD', 'balanceUnit, the goal tracker balanceCurrency source')
  assert.equal(b.currency, null)
  assert.equal(a.last20.n, 20); assert.equal(a.days30.n, 30)
  assert.equal(a.last20.bot.n, 20)
  assert.equal(b.last20.n, 1); assert.equal(b.last20.rScored, 0, 'suspect exit: no R')
  assert.deepEqual(out.excluded, { unpriced: 0, unstamped: 1, superseded: 1 })
  // Exactly the same figures as handing every row to the pure function.
  const all = db.prepare("SELECT * FROM trades WHERE status = 'closed'").all()
  const full = buildScoreboard(all, { now: NOW, days: 30, accounts: out.accounts.map(x => ({ accountId: x.accountId, currency: x.currency })) })
  assert.deepEqual(out.accounts.map(x => [x.last20, x.days30]), full.accounts.map(x => [x.last20, x.days30]))
  const scoped = readScoreboard(db, { account: '222', days: 30, now: NOW })
  assert.deepEqual(scoped.accounts.map(x => x.accountId), ['222'])
  assert.equal(scoped.account, '222')
  const none = readScoreboard(db, { account: '999', days: 30, now: NOW })
  assert.equal(none.accounts[0].last20.n, 0); assert.equal(none.accounts[0].registered, false)
})
