// Tests for whole-period account analytics (audit findings 2.1 and 2.2).
//
// The two findings these lock down:
//   2.1 "All time" was the latest 100 trades, because the page derived its
//       tiles from /state/trades (LIMIT 100). The 101st trade silently
//       stopped counting toward the win rate and profit factor the owner
//       gates live trading on.
//   2.2 Max drawdown ran over a NEWEST-FIRST array, so it measured the
//       worst run-up rather than the worst fall.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { accountAnalytics } from './account-analytics.js'

const T0 = Date.UTC(2026, 6, 1, 0, 0, 0)
const HOUR = 3_600_000

let seq = 0
function closeTrade(db, { pnl, ms, account = null, hold = null }) {
  seq += 1
  db.prepare(
    `INSERT INTO trades (id, symbol, side, status, net_pnl, closed_at, closed_at_ms,
                         opened_at, hold_duration_ms, account_id)
     VALUES (?, 'EURUSD', 'BUY', 'closed', ?, ?, ?, ?, ?, ?)`
  ).run(
    seq, pnl,
    new Date(ms).toISOString(), ms,
    new Date(ms - HOUR).toISOString(), hold, account,
  )
}

test('accountAnalytics — empty record reports nulls, never zeros that read as data', () => {
  const db = initDB(':memory:')
  const a = accountAnalytics(db, {})
  assert.equal(a.trades, 0)
  assert.equal(a.net, null)
  assert.equal(a.winRate, null)
  assert.equal(a.profitFactor, null)
  assert.equal(a.maxDrawdown, null)
})

test('accountAnalytics — counts EVERY trade, not the latest 100 (audit 2.1)', () => {
  const db = initDB(':memory:')
  // 150 trades: the first 50 are +10 winners, the last 100 are -1 losers.
  // A 100-row newest-first window sees ONLY losers → 0% win rate, net -100.
  // The whole record is 50 wins / 100 losses → 33.33%, net +400.
  for (let i = 0; i < 50; i++) closeTrade(db, { pnl: 10, ms: T0 + i * HOUR })
  for (let i = 0; i < 100; i++) closeTrade(db, { pnl: -1, ms: T0 + (50 + i) * HOUR })

  const a = accountAnalytics(db, {})
  assert.equal(a.trades, 150, 'all 150 closed trades counted')
  assert.equal(a.net, 400)
  assert.equal(a.wins, 50)
  assert.equal(a.losses, 100)
  assert.equal(a.winRate, 33.33)
  assert.equal(a.truncated, false)
  // Profit factor over the whole record: 500 / 100 = 5.
  assert.equal(a.profitFactor, 5)
})

test('accountAnalytics — max drawdown is the chronological peak-to-trough fall', () => {
  const db = initDB(':memory:')
  // Chronological path -20, +100, -40 ⇒ equity -20, 80, 40.
  // Peak 80, trough after it 40 ⇒ MDD 40. Rows are INSERTED newest-first to
  // prove the service sorts rather than trusting insertion order.
  closeTrade(db, { pnl: -40, ms: T0 + 3 * HOUR })
  closeTrade(db, { pnl: 100, ms: T0 + 2 * HOUR })
  closeTrade(db, { pnl: -20, ms: T0 + 1 * HOUR })

  const a = accountAnalytics(db, {})
  assert.equal(a.trades, 3)
  assert.equal(a.net, 40)
  assert.equal(a.maxDrawdown, 40)
  // The sort is what the audit's finding 2.2 is really about, so assert it
  // directly on the order-SENSITIVE outputs rather than via drawdown (which
  // is invariant under reversal — see the note in account-analytics.js).
  assert.equal(a.firstMs, T0 + 1 * HOUR, 'first close is the oldest trade')
  assert.equal(a.lastMs, T0 + 3 * HOUR, 'last close is the newest trade')
})

test('max drawdown is invariant under reversal — the finding 2.2 claim, checked', () => {
  // Documented here because the audit asserts a reversed series yields a
  // WRONG drawdown, and acting on that belief later (e.g. "re-sort and the
  // number will change") would waste a debugging session. It will not.
  const mdd = (arr) => {
    let peak = 0, equity = 0, worst = 0
    for (const v of arr) { equity += v; if (equity > peak) peak = equity; if (peak - equity > worst) worst = peak - equity }
    return worst
  }
  for (const path of [[10, -30, 40], [-20, 100, -40], [5, -1, -1, 20, -15], [100, -60, 10]]) {
    assert.equal(mdd(path), mdd([...path].reverse()), `path ${JSON.stringify(path)}`)
  }
})

test('accountAnalytics — streaks and day buckets follow real chronology', () => {
  const db = initDB(':memory:')
  // Day 1: +5, +5, +5 (3-win streak).  Day 2: -1, -1 (2-loss streak).
  for (let i = 0; i < 3; i++) closeTrade(db, { pnl: 5, ms: T0 + i * HOUR })
  for (let i = 0; i < 2; i++) closeTrade(db, { pnl: -1, ms: T0 + 24 * HOUR + i * HOUR })

  const a = accountAnalytics(db, {})
  assert.equal(a.winStreak, 3)
  assert.equal(a.lossStreak, 2)
  assert.equal(a.tradingDays, 2)
  assert.equal(a.greenDays, 1)
  assert.equal(a.bestDay, 15)
  assert.equal(a.worstDay, -2)
})

test('accountAnalytics — a scratch counts as a loss (win rate is a gate number)', () => {
  const db = initDB(':memory:')
  closeTrade(db, { pnl: 10, ms: T0 })
  closeTrade(db, { pnl: 0, ms: T0 + HOUR })
  const a = accountAnalytics(db, {})
  assert.equal(a.wins, 1)
  assert.equal(a.losses, 1)
  assert.equal(a.winRate, 50)
})

test('accountAnalytics — profit factor is null with no losses, never Infinity', () => {
  const db = initDB(':memory:')
  closeTrade(db, { pnl: 10, ms: T0 })
  closeTrade(db, { pnl: 20, ms: T0 + HOUR })
  const a = accountAnalytics(db, {})
  assert.equal(a.profitFactor, null)
  assert.equal(a.winRate, 100)
})

test('accountAnalytics — days window trims by close time', () => {
  const db = initDB(':memory:')
  const now = T0 + 40 * 24 * HOUR
  closeTrade(db, { pnl: 100, ms: T0 })                       // 40 days old
  closeTrade(db, { pnl: -5, ms: now - 2 * 24 * HOUR })       // inside 30d
  const all = accountAnalytics(db, { now })
  const win30 = accountAnalytics(db, { days: 30, now })
  assert.equal(all.trades, 2)
  assert.equal(all.net, 95)
  assert.equal(win30.trades, 1)
  assert.equal(win30.net, -5)
  assert.equal(win30.windowDays, 30)
})

test('accountAnalytics — account scope includes unstamped legacy rows only', () => {
  const db = initDB(':memory:')
  closeTrade(db, { pnl: 10, ms: T0, account: 'A' })
  closeTrade(db, { pnl: 20, ms: T0 + HOUR, account: 'B' })
  closeTrade(db, { pnl: 5, ms: T0 + 2 * HOUR, account: null })  // legacy

  const a = accountAnalytics(db, { accountId: 'A' })
  assert.equal(a.trades, 2, 'A plus the unstamped legacy row')
  assert.equal(a.net, 15)

  const b = accountAnalytics(db, { accountId: 'B' })
  assert.equal(b.trades, 2)
  assert.equal(b.net, 25)

  const all = accountAnalytics(db, { accountId: 'all' })
  assert.equal(all.trades, 3)
  assert.equal(all.net, 35)
})

test('accountAnalytics — median hold is the middle value, in minutes', () => {
  const db = initDB(':memory:')
  closeTrade(db, { pnl: 1, ms: T0, hold: 10 * 60_000 })
  closeTrade(db, { pnl: 1, ms: T0 + HOUR, hold: 30 * 60_000 })
  closeTrade(db, { pnl: 1, ms: T0 + 2 * HOUR, hold: 50 * 60_000 })
  const a = accountAnalytics(db, {})
  assert.equal(a.medianHoldMin, 30)
})

test('accountAnalytics — expectancy and payoff reconcile with the components', () => {
  const db = initDB(':memory:')
  closeTrade(db, { pnl: 30, ms: T0 })
  closeTrade(db, { pnl: -10, ms: T0 + HOUR })
  const a = accountAnalytics(db, {})
  assert.equal(a.net, 20)
  assert.equal(a.expectancy, 10)      // 20 / 2
  assert.equal(a.avgWin, 30)
  assert.equal(a.avgLoss, 10)
  assert.equal(a.payoff, 3)           // 30 / 10
  assert.equal(a.profitFactor, 3)     // 30 / 10
})
