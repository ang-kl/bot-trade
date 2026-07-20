// node --test agent/services/alpha-decay.test.js
//
// Alpha decay: expectancy math, rolling window comparison + trend verdicts,
// entry-lag buckets, and the assembled DB view.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { expectancy, rollingDecay, entryLagBuckets, alphaDecayView } from './alpha-decay.js'

const trade = (pnl, i) => ({ net_pnl: pnl, closed_at: `2026-07-${String(1 + Math.floor(i / 10)).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:00:00` })

test('expectancy: mean net PnL, win rate, empty-safe', () => {
  assert.deepEqual(expectancy([]), { n: 0, expectancy: null, winRate: null, totalPnl: 0 })
  const e = expectancy([{ net_pnl: 10 }, { net_pnl: -5 }, { net_pnl: 4 }])
  assert.equal(e.n, 3)
  assert.equal(e.expectancy, 3)
  assert.equal(e.winRate, 0.667)
  assert.equal(e.totalPnl, 9)
})

test('rollingDecay: too few trades → insufficient, no false verdicts', () => {
  const r = rollingDecay(Array.from({ length: 15 }, (_, i) => trade(1, i)), 10)
  // 15 trades: recent window has 10, prior only 5 (< min 10) → insufficient
  assert.equal(r.trend, 'insufficient')
  assert.equal(r.delta, null)
})

test('rollingDecay: falling expectancy is flagged decaying, rising improving, flat stable', () => {
  // 20 old trades at +$2, then 20 recent at -$1 → decaying
  const decay = [
    ...Array.from({ length: 20 }, (_, i) => trade(2, i)),
    ...Array.from({ length: 20 }, (_, i) => trade(-1, 20 + i)),
  ]
  const d = rollingDecay(decay, 20)
  assert.equal(d.trend, 'decaying')
  assert.equal(d.delta, -3)
  assert.equal(d.recent.expectancy, -1)
  assert.equal(d.prior.expectancy, 2)

  const improve = [
    ...Array.from({ length: 20 }, (_, i) => trade(-1, i)),
    ...Array.from({ length: 20 }, (_, i) => trade(2, 20 + i)),
  ]
  assert.equal(rollingDecay(improve, 20).trend, 'improving')

  // ±10% wobble around $2 stays stable (threshold is 20% of prior)
  const flat = [
    ...Array.from({ length: 20 }, (_, i) => trade(2, i)),
    ...Array.from({ length: 20 }, (_, i) => trade(2.2, 20 + i)),
  ]
  assert.equal(rollingDecay(flat, 20).trend, 'stable')
})

test('entryLagBuckets: trades land in the right lag bucket', () => {
  const rows = [
    { net_pnl: 10, lag_sec: 5 },
    { net_pnl: 20, lag_sec: 59 },
    { net_pnl: -5, lag_sec: 120 },
    { net_pnl: -15, lag_sec: 3000 },
    { net_pnl: 99, lag_sec: NaN }, // unknown lag → excluded
  ]
  const [fast, medium, slow] = entryLagBuckets(rows)
  assert.equal(fast.n, 2)
  assert.equal(fast.expectancy, 15)
  assert.equal(medium.n, 1)
  assert.equal(slow.n, 1)
  assert.equal(slow.expectancy, -15)
})

test('alphaDecayView: groups by strategy and computes lag from the analyses join', () => {
  const db = initDB(':memory:')
  const insA = db.prepare(`INSERT INTO analyses (symbol, analyzed_at) VALUES ('EURUSD', ?)`)
  const insT = db.prepare(
    `INSERT INTO trades (symbol, side, net_pnl, status, label_strategy, opened_at, closed_at, analysis_id)
     VALUES ('EURUSD', 'BUY', ?, 'closed', ?, ?, ?, ?)`
  )
  // 12 fib trades, signal → fill lag 30s each
  for (let i = 0; i < 12; i++) {
    const signalAt = `2026-07-10 0${i % 10}:00:00`
    const a = insA.run(signalAt)
    insT.run(5, 'fib_618_fade', `2026-07-10 0${i % 10}:00:30`, `2026-07-10 0${i % 10}:30:00`, a.lastInsertRowid)
  }
  // one open trade must be excluded
  db.prepare(`INSERT INTO trades (symbol, net_pnl, status, label_strategy) VALUES ('EURUSD', NULL, 'open', 'fib_618_fade')`).run()

  const v = alphaDecayView(db, { window: 10 })
  assert.equal(v.total_closed, 12)
  // Every REGISTERED strategy now appears, not just the one that traded
  // (owner: "include all strategy and justify"). The fib row carries the
  // trades; the untraded ones are present with n=0.
  const fib = v.strategies.find(s => s.strategy === 'fib_618_fade')
  assert.ok(v.strategies.length >= 5, `expected all registered strategies, got ${v.strategies.length}`)
  assert.equal(fib.total.n, 12)
  assert.equal(fib.netPnl, 60)       // 12 × +5
  assert.equal(fib.winRate, 1)        // all wins
  assert.equal(fib.trend, 'insufficient') // prior window only 2
  assert.equal(typeof fib.armed, 'boolean')
  // An untraded registered strategy shows up with a clean zero row.
  const idle = v.strategies.find(s => s.strategy === 'vp_value')
  assert.ok(idle)
  assert.equal(idle.total.n, 0)
  assert.equal(idle.netPnl, 0)
  assert.equal(v.lag_sampled, 12)
  assert.equal(v.entry_lag[0].n, 12) // all lags = 30s → fast bucket
})

test('streakOf: counts the newest same-sign run', async () => {
  const { streakOf } = await import('./alpha-decay.js')
  assert.deepEqual(streakOf([]), { kind: null, n: 0 })
  const t = (pnl, i) => ({ net_pnl: pnl, closed_at: `2026-07-10 ${String(i).padStart(2, '0')}:00:00` })
  assert.deepEqual(streakOf([t(-1, 1), t(2, 2), t(3, 3)]), { kind: 'win', n: 2 })
  assert.deepEqual(streakOf([t(5, 1), t(-1, 2), t(-2, 3), t(-3, 4)]), { kind: 'loss', n: 3 })
})

test('view: no "unknown" — unlabelled bucket carries the source breakdown', async () => {
  const { alphaDecayView } = await import('./alpha-decay.js')
  const { setState } = await import('../db.js')
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (symbol, net_pnl, status, source, closed_at) VALUES ('EURUSD', -5, 'closed', 'manual', '2026-07-10 01:00:00')`).run()
  db.prepare(`INSERT INTO trades (symbol, net_pnl, status, source, closed_at) VALUES ('BTCUSD', 2, 'closed', 'validation_fill', '2026-07-10 02:00:00')`).run()
  setState(db, 'adaptive_breaker_json', JSON.stringify({ on: false, streak: 3 }))

  const v = alphaDecayView(db)
  assert.ok(!v.strategies.some(s => s.strategy === 'unknown'))
  assert.equal(v.unlabelled.n, 2)
  assert.deepEqual(v.unlabelled.sources, { manual: 1, validation_fill: 1 })
  assert.equal(v.breaker.on, false)
  assert.equal(v.backtest, null)
  // Advisories: baseline missing + insufficient-samples guidance both present
  assert.ok(v.advisories.some(a => /backtest baseline/.test(a.text)))
  assert.ok(v.advisories.some(a => /burn-in builds the sample/.test(a.text)))
})

test('view: loss streak → COMMITTED advisory when breaker armed, plain advisory when off', async () => {
  const { alphaDecayView } = await import('./alpha-decay.js')
  const { setState } = await import('../db.js')
  const mk = (breakerOn) => {
    const db = initDB(':memory:')
    for (let i = 0; i < 12; i++) {
      db.prepare(`INSERT INTO trades (symbol, net_pnl, status, label_strategy, closed_at) VALUES ('EURUSD', ?, 'closed', 'fib_618_fade', ?)`)
        .run(i < 9 ? 1 : -2, `2026-07-10 ${String(i).padStart(2, '0')}:00:00`)
    }
    setState(db, 'adaptive_breaker_json', JSON.stringify({ on: breakerOn, streak: 3 }))
    return alphaDecayView(db, { window: 10 })
  }
  const armed = mk(true)
  const fib = armed.strategies.find(s => s.strategy === 'fib_618_fade')
  assert.deepEqual(fib.streak, { kind: 'loss', n: 3 })
  assert.ok(armed.advisories.some(a => a.level === 'committed' && /adaptive breaker WILL rotate/.test(a.text)))
  const off = mk(false)
  assert.ok(off.advisories.some(a => a.level === 'advisory' && /breaker is OFF/.test(a.text)))
})

test('arm advisory: an ARMED strategy with no proven edge is flagged (non-blocking), a proven one is not', async () => {
  const { alphaDecayView } = await import('./alpha-decay.js')
  const { setState } = await import('../db.js')

  // rsi_meanrev armed, never traded, never backtested → unproven advisory.
  const db1 = initDB(':memory:')
  setState(db1, 'enabled_strategies_json', JSON.stringify(['rsi_meanrev']))
  const v1 = alphaDecayView(db1, { window: 10 })
  assert.ok(
    v1.advisories.some(a => a.strategy === 'rsi_meanrev' && /ARMED but unproven/.test(a.text)),
    'armed untested strategy should warn',
  )
  // Arming still allowed — the strategy is present and armed, not blocked.
  assert.equal(v1.strategies.find(s => s.strategy === 'rsi_meanrev').armed, true)
  // An UNARMED strategy never gets the arm advisory.
  assert.ok(!v1.advisories.some(a => a.strategy === 'vp_value' && /ARMED but unproven/.test(a.text)))

  // fib armed WITH a positive backtest for it → no arm advisory (has edge).
  const db2 = initDB(':memory:')
  setState(db2, 'enabled_strategies_json', JSON.stringify(['fib_618_fade']))
  setState(db2, 'backtest_baseline_json', JSON.stringify({ ranAt: '2026-07-17T00:00:00Z', strategy: 'fib_618_fade', combos: [{ symbol: 'EURUSD', tf: '4h', trades: 20, profitFactor: 1.6 }] }))
  const v2 = alphaDecayView(db2, { window: 10 })
  assert.ok(!v2.advisories.some(a => a.strategy === 'fib_618_fade' && /ARMED but unproven/.test(a.text)))
})

test('view: stored backtest baseline surfaces, reality-gap advisory fires on live-negative', async () => {
  const { alphaDecayView } = await import('./alpha-decay.js')
  const { setState } = await import('../db.js')
  const db = initDB(':memory:')
  for (let i = 0; i < 12; i++) {
    db.prepare(`INSERT INTO trades (symbol, net_pnl, status, label_strategy, closed_at) VALUES ('EURUSD', -1, 'closed', 'fib_618_fade', ?)`)
      .run(`2026-07-10 ${String(i).padStart(2, '0')}:00:00`)
  }
  setState(db, 'backtest_baseline_json', JSON.stringify({ ranAt: '2026-07-17T00:00:00Z', strategy: 'fib_618_fade', combos: [{ symbol: 'EURUSD', tf: '4h', trades: 20, profitFactor: 1.6, winRatePct: 60 }] }))
  const v = alphaDecayView(db, { window: 10 })
  assert.equal(v.backtest.combos.length, 1)
  assert.ok(v.advisories.some(a => /Reality gap/.test(a.text)))
})
