// node --test agent/services/scoreboard.test.js
// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { recordAccountMoney, recordDepositCurrency } from './account-money.js'
import { buildScoreboard, readScoreboard, scoreMetrics, exclusionOf, nightlyRecord, EXTERNAL_SOURCES, SCOREBOARD_TRADES, SCOREBOARD_NIGHTS } from './scoreboard.js'

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
  assert.equal(a.closedTotal, 300, 'Claude · № 12,990: the account line counts every close, not the bounded buffer'); assert.ok(a.closedN < 300)
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

// Claude · № 12,990 10-Oct (owner: "where are the account details like Live ·
// 1251247 · 42993489 · SGD and the leverage and how many trade"): the account
// line's facts — registry side and login, stored leverage, ledger open count,
// closes today on the owner's (Singapore) calendar day. Display only.
test('account facts: side, login, leverage, open now and closed today (SGT day)', () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO accounts(account_id, broker_label, enabled, is_live, trader_login, mode) VALUES ('111','P',1,1,'1251247','active'), ('222','P',1,0,'5067353','manage_only')").run()
  db.prepare("INSERT INTO agent_state(key, value) VALUES ('acct:111:account_leverage', '200'), ('acct:222:account_leverage', 'garbage')").run()
  const ins = db.prepare(`INSERT INTO trades(symbol, side, status, account_id, net_pnl, realised_rr, closed_at_ms, source, close_reason) VALUES(?,?,?,?,?,?,?,?,?)`)
  // NOW = 08:00Z = 16:00 SGT; the SGT day began at 16:00Z the day before.
  ins.run('EURUSD', 'BUY', 'closed', '111', 1, 1, NOW - 2 * H, 'autopilot', 'tp')          // 14:00 SGT today
  ins.run('EURUSD', 'BUY', 'closed', '111', 1, 1, NOW - 15 * H, 'autopilot', 'tp')         // 01:00 SGT today
  ins.run('EURUSD', 'BUY', 'closed', '111', 1, 1, NOW - 17 * H, 'autopilot', 'tp')         // 23:00 SGT yesterday
  ins.run('EURUSD', 'BUY', 'open', '111', null, null, null, 'autopilot', null)
  ins.run('USDJPY', 'SELL', 'open', '111', null, null, null, 'manual', null)
  const out = readScoreboard(db, { account: 'all', days: 30, now: NOW })
  const a = out.accounts.find(x => x.accountId === '111'), b = out.accounts.find(x => x.accountId === '222')
  assert.equal(a.isLive, true); assert.equal(a.login, '1251247'); assert.equal(a.leverage, 200); assert.equal(a.mode, 'active')
  assert.equal(a.openNow, 2, 'open ledger rows, bot and manual alike'); assert.equal(a.closedToday, 2, 'SGT calendar day'); assert.equal(a.closedN, 3); assert.equal(a.closedTotal, 3)
  assert.equal(b.isLive, false); assert.equal(b.leverage, null, 'a non-numeric stored leverage is not shown'); assert.equal(b.openNow, 0)
  assert.equal(b.mode, 'manage_only')
})

// Claude · № 13,024 10-Oct (owner after № 13,017: "Is there a record in the
// storage of Bot-trade the daily balance of account recorded so that we can
// check pattern"): the nightly balance line from equity_snapshots.
const night = (at, balance, over = {}) => ({ at, balance_usd: balance, open_pnl_usd: 0, equity_usd: balance, open_positions: 1,
  error: null, currency: 'SGD', broker_host: 'demo.ctraderapi.com', ...over })

test('nightlyRecord: one unit only, changes between consecutive nights, a host change has no change', () => {
  const rows = [
    night('2026-09-19T23:20:00Z', 1527.21, { currency: null }),      // written before the pass recorded a unit
    night('2026-09-22T23:25:00Z', 3116.38),
    night('2026-09-23T23:26:00Z', 3116.38),
    night('2026-09-24T23:27:00Z', 3131.42),
    night('2026-09-25T23:28:00Z', 3100.00, { broker_host: 'live.ctraderapi.com' }),   // another host after a read night
    night('2026-09-26T23:29:00Z', null, { equity_usd: null, error: 'balance: timeout', broker_host: 'live.ctraderapi.com' }),
    night('2026-09-27T23:30:00Z', 3090.00, { broker_host: 'live.ctraderapi.com' }),
    night('2026-09-28T23:31:00Z', 3080.00, { broker_host: 'live.ctraderapi.com' }),
    night('2026-09-29T23:31:00Z', 50, { currency: 'USD' }),
  ]
  const seen = []
  const r = nightlyRecord(rows.slice().reverse(), { currency: 'SGD', flowsOf: (p, n) => { seen.push([p.at, n.at]); return { status: 'read', external: 0 } } })
  assert.equal(r.currency, 'SGD')
  assert.equal(r.shown, 7, 'only SGD nights are drawn')
  assert.equal(r.unitUnrecorded, 1); assert.equal(r.otherUnit, 1)
  assert.deepEqual(r.nights.map(n => n.at.slice(0, 10)), ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'], 'oldest first')
  assert.deepEqual(r.nights.map(n => n.balanceChange), [null, 0, 15.04, null, null, null, -10],
    'first has no earlier own night; a host change (from a read night) and an unread balance on either side have none')
  assert.equal(r.nights[4].error, 'balance: timeout')
  assert.deepEqual(r.nights.map(n => n.flows?.status ?? null), [null, 'read', 'read', null, null, null, 'read'], 'flows asked only where a change exists')
  assert.equal(seen.length, 3)
  assert.equal(r.change, Number((3080 - 3116.38).toFixed(2)), 'first to last read balance')
  assert.deepEqual([r.up, r.down, r.flat], [1, 1, 1])
})

test('nightlyRecord: an unverified currency shows nothing; the limit keeps the newest and the night before it for the first change', () => {
  const rows = Array.from({ length: SCOREBOARD_NIGHTS + 5 }, (_, i) => night(new Date(Date.parse('2026-09-01T00:00:00Z') + i * DAY).toISOString(), 100 + i))
  const r = nightlyRecord(rows, { currency: 'SGD' })
  assert.equal(r.shown, SCOREBOARD_NIGHTS); assert.equal(r.earlierOwn, 5)
  assert.equal(r.nights[0].balanceChange, 1, 'the first shown night compares with the one before it')
  assert.equal(r.nights[0].flows, null, 'no flows reader: null, never "no deposits"')
  const none = nightlyRecord(rows, { currency: null })
  assert.equal(none.shown, 0); assert.equal(none.currency, null)
  const flowsThrow = nightlyRecord(rows.slice(0, 3), { currency: 'SGD', flowsOf: () => { throw new Error('x') } })
  assert.deepEqual(flowsThrow.nights.map(n => n.flows), [null, null, null])
})

test('readScoreboard: the nightly record per account, with deposits read from the cashflow ledger only where it covers the span', () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO accounts(account_id, broker_label, enabled) VALUES ('111','P',1)").run()
  const wall = Date.now()
  recordDepositCurrency(db, { accountId: '111', host: 'demo.ctraderapi.com', depositAssetId: '7', currency: 'SGD', receivedAt: wall - 1000 })
  recordAccountMoney(db, { accountId: '111', host: 'demo.ctraderapi.com', trader: { depositAssetId: '7', ctidTraderAccountId: 111 }, balance: 50, receivedAt: wall - 500 })
  const ins = db.prepare(`INSERT INTO equity_snapshots(at, account_id, balance_usd, open_pnl_usd, equity_usd, open_positions, error, currency, broker_host)
    VALUES (?,?,?,?,?,?,?,?,?)`)
  const t0 = Date.parse('2026-10-05T23:54:00Z')
  ins.run(new Date(t0).toISOString(), '111', 1000, 0, 1000, 0, null, 'SGD', 'demo.ctraderapi.com')
  ins.run(new Date(t0 + DAY).toISOString(), '111', 1500, -5, 1495, 1, null, 'SGD', 'demo.ctraderapi.com')
  ins.run(new Date(t0 + 2 * DAY).toISOString(), '111', 1490, 0, 1490, 0, null, 'SGD', 'demo.ctraderapi.com')
  ins.run(new Date(t0 + 2 * DAY).toISOString(), '222', 9, 0, 9, 0, null, 'USD', 'demo.ctraderapi.com')
  // The ledger covers the first span only, and holds a 500 deposit inside it.
  db.prepare(`INSERT INTO account_cashflow_windows(account_id, host, currency, from_ms, to_ms, received_ms) VALUES ('111','demo.ctraderapi.com','SGD',?,?,?)`)
    .run(t0 - DAY, t0 + DAY + 60_000, t0 + DAY + 60_000)
  db.prepare(`INSERT INTO account_cashflows(account_id, host, event_id, at_ms, currency, delta, operation_type, kind, received_ms)
    VALUES ('111','demo.ctraderapi.com','9001',?,'SGD',500,0,'external',?)`).run(t0 + 3600_000, t0 + DAY)
  const out = readScoreboard(db, { account: 'all', days: 30, now: NOW })
  const a = out.accounts.find(x => x.accountId === '111')
  assert.equal(a.nightly.shown, 3)
  assert.deepEqual(a.nightly.nights.map(n => n.balanceChange), [null, 500, -10])
  assert.deepEqual(a.nightly.nights[1].flows, { status: 'read', external: 500 }, 'the +500 night was a deposit, not trading')
  assert.deepEqual(a.nightly.nights[2].flows, { status: 'unread', external: null }, 'an uncovered span is unread, never zero')
  assert.equal(a.nightly.nights[1].openPnl, -5); assert.equal(a.nightly.nights[1].equity, 1495); assert.equal(a.nightly.nights[1].openPositions, 1)
  assert.ok(!out.accounts.some(x => x.accountId === '222'), 'a snapshot alone does not add an account to the board')
  assert.match(out.nightlyRule, /deposits and withdrawals/)
})
