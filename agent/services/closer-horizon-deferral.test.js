// node --test agent/services/closer-horizon-deferral.test.js
//
// V3 F1 (docs/v3-momentum-exit-coordination-2026-09-25.md, "Not covered"):
// the four other automatic closers — the profit keeper, the loss guardian,
// the trade guard and the weekend bank — read the momentum partial plan
// before they close, by the rule T2 gave the loss cap and the ratchet
// (protectiveExitDeferral): a partial or rank close claimed within the
// transport horizon may still be in flight, so the competing close waits for
// this pass only. Past the horizon, after the request ended (AMBIGUOUS), or
// with no plan at all (recordedPlans 0 in production today), each closer
// closes exactly as before. Every closer is exercised through its own run
// function with injected broker doubles; nothing here reads the source.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { registerPartialPlan } from './momentum-partial-manager.js'
import { planMomentumTargets } from './momentum-target-policy.js'
import { rankExitSchema } from './momentum-rank-exit.js'
import { TRANSPORT_HORIZON_MS } from './momentum-broker-evidence.js'
import { IN_FLIGHT_EXIT_STATES } from './momentum-exit-coordination.js'
import { runProfitKeeper } from './profit-keeper.js'
import { runLossGuardian } from './loss-guardian.js'
import { runTradeGuards } from './trade-guard.js'
import { runWeekendBank } from './weekend-bank.js'

const NOW = 1_800_000_000_000
const plan = planMomentumTargets({ side: 'BUY', entry: 100, originalStop: 90, requiredRr: 3,
  costReservePrice: 0.4, digits: 2, volume: 10000, minVolume: 100, stepVolume: 100 })

// A plan on (account, position), put in `state`, its request claimed `age` ms
// before NOW — on the plan row for a partial, on the rank claim for a RANK_
// state (the same shape momentum-exit-coordination.test.js uses).
function withPlan(db, { accountId, positionId, state, age = 1_000 }) {
  registerPartialPlan(db, { accountId, tradeId: 7, positionId: String(positionId), plan, evidenceId: 'fixture:7',
    identity: { host: 'demo.ctraderapi.com', accountId, symbolId: '7' } })
  const rank = state.startsWith('RANK_')
  db.prepare('UPDATE momentum_partial_plans SET state=?, attempted_at=?').run(state, rank ? NOW - 10 * TRANSPORT_HORIZON_MS : NOW - age)
  if (rank) {
    rankExitSchema(db)
    db.prepare(`INSERT INTO momentum_rank_exits(account_id,trade_id,position_id,token,prior_state,state,created_at,attempted_at,volume)
      VALUES (?,7,?,'tok','ARMED',?,?,?,10000)`).run(accountId, String(positionId), state.slice(5), NOW - 20 * TRANSPORT_HORIZON_MS, NOW - age)
  }
}

// Each case: the closer, a fresh database holding one position it WOULD
// close, and a runner that returns { closed, out, deferred }.
const CASES = {
  'profit keeper (close at takeProfitUsd)': {
    account: '1', position: 9001,
    db() {
      const db = initDB(':memory:')
      setState(db, 'profit_keeper_json', JSON.stringify({ on: true, scope: 'external', mode: 'fixed', armProfitUsd: 50, givebackPct: 40, takeProfitUsd: 10 }))
      const tradeId = db.prepare(`INSERT INTO trades (symbol, side, ctrader_position_id, status) VALUES ('NATGAS', 'SELL', '9001', 'open')`).run().lastInsertRowid
      db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, current_tp, status, source, trade_id)
        VALUES ('NATGAS', 'short', 2.8795, 2.918, 1.8, 'active', 'external', ?)`).run(tradeId)
      return db
    },
    async run(db) {
      const closed = []
      const out = await runProfitKeeper(db, { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }, {
        now: NOW,
        exec: {
          reconcile: async () => ({ position: [{ positionId: 9001, price: 2.8795, stopLoss: 2.918, takeProfit: 1.8, tradeData: { symbolId: 1, volume: 10000, tradeSide: 2 } }] }),
          closePosition: async (_c, args) => { closed.push(args) },
          amendPosition: async () => ({}),
        },
        ws: { wsGetLastCloses: async () => ({ 1: 2.30 }), wsGetTrendbarsBatch: async () => ({}) },
        sizing: { getVolumeMeta: async () => ({ lotSize: 10000, digits: 3 }) },
        notify: () => {},
      })
      return { closed, out, deferred: out.deferred }
    },
  },
  'loss guardian (maxHoldHours backstop)': {
    account: '1', position: 9101,
    db() {
      const db = initDB(':memory:')
      setState(db, 'loss_guardian_json', JSON.stringify({ on: true, scope: 'all', maxHoldHours: 1 }))
      const tradeId = db.prepare(`INSERT INTO trades (symbol, side, ctrader_position_id, status, account_id, opened_at) VALUES ('NATGAS', 'BUY', '9101', 'open', '1', datetime('now', '-3 days'))`).run().lastInsertRowid
      db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, status, source, trade_id, account_id)
        VALUES ('NATGAS', 'long', 2.9, 2.7, 'active', 'autopilot', ?, '1')`).run(tradeId)
      return db
    },
    async run(db) {
      const closed = []
      const out = await runLossGuardian(db, { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }, {
        now: NOW,
        exec: {
          reconcile: async () => ({ position: [{ positionId: 9101, price: 2.9, stopLoss: 2.7, tradeData: { symbolId: 1, volume: 10000, tradeSide: 1, openTimestamp: NOW - 3 * 86_400_000 } }] }),
          closePosition: async (_c, args) => { closed.push(args) },
        },
        ws: { wsGetLastCloses: async () => ({ 1: 2.85 }), wsGetTrendbarsBatch: async () => ({}) },
        sizing: { getVolumeMeta: async () => ({ lotSize: 10000, digits: 3 }) },
        notify: () => {},
      })
      return { closed, out, deferred: out.deferred }
    },
  },
  'trade guard (partial take-profit)': {
    account: '42', position: 7,
    db() {
      const db = initDB(':memory:')
      setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1 }))
      const tradeId = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at, account_id)
         VALUES ('EURUSD', 'BUY', 1.1000, 0.02, '7', 'autopilot', 'open', datetime('now'), '42')`).run().lastInsertRowid
      db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, thesis, initial_risk, source, status, account_id, guard_json)
         VALUES ('EURUSD', ?, 'long', 1.1000, 1.0950, null, 't', 1, 'autopilot', 'active', '42', ?)`)
        .run(tradeId, JSON.stringify({ takeProfits: [{ price: 1.1020, lots: 0.01 }] }))
      return db
    },
    async run(db) {
      const closed = []
      const out = await runTradeGuards(db, { accountId: '42', host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't' }, {
        now: NOW,
        exec: {
          reconcile: async () => ({ position: [{ positionId: 7, price: 1.1000, stopLoss: 1.0950 }] }),
          closePosition: async (_c, args) => { closed.push(args) },
          amendPosition: async () => {},
        },
        ws: { wsGetLastCloses: async () => ({ 1: 1.1025 }) },
        sizing: { getVolumeMeta: async () => ({ pipPosition: 4, digits: 5, lotSize: 100000 }) },
        notify: () => {},
      })
      return { closed, out, deferred: out.deferred }
    },
  },
  'weekend bank (pre-closure bank)': {
    account: '43097342', position: 222,
    db() {
      const db = initDB(':memory:')
      const H = 3600
      db.prepare(`INSERT INTO symbol_hours (symbol, schedule_json, tz) VALUES ('GD.US', ?, 'UTC')`)
        .run(JSON.stringify([{ start: 21 * H, end: (5 * 24 + 21) * H }]))
      return db
    },
    async run(db) {
      const closed = []
      // 30 min before a Friday close; `now` also dates the deferral.
      const fri = new Date(Date.UTC(2026, 6, 17, 20, 30, 0))
      const out = await runWeekendBank(db, { host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '43097342' },
        [{ positionId: 222, symbolName: 'GD.US', price: 362.43, tradeData: { symbolId: 1, tradeSide: 1, volume: 100 } }],
        { deps: { closePosition: async (_c, args) => { closed.push(args) }, wsGetSpotOnce: async () => ({ bid: 370, ask: 370.1 }) }, now: fri })
      return { closed, out, deferred: out.deferred }
    },
    // The bank dates its deferral from its own `now` (a Date), not NOW.
    nowMs: Date.UTC(2026, 6, 17, 20, 30, 0),
  },
}

// The plan's claim time is relative to NOW; the weekend bank's clock is its
// own, so its plan is re-dated to that clock.
function planFor(c, db, state, age, accountId = c.account) {
  withPlan(db, { accountId, positionId: c.position, state, age })
  if (c.nowMs != null) {
    const shift = c.nowMs - NOW
    db.prepare('UPDATE momentum_partial_plans SET attempted_at = attempted_at + ?').run(shift)
    try { db.prepare('UPDATE momentum_rank_exits SET attempted_at = attempted_at + ?, created_at = created_at + ?').run(shift, shift) } catch { /* no rank table */ }
  }
}

for (const [name, c] of Object.entries(CASES)) {
  test(`F1 ${name}: no plan — closes exactly as before`, async () => {
    const { closed, deferred } = await c.run(c.db())
    assert.equal(closed.length, 1, `control must close: ${JSON.stringify(deferred)}`)
    assert.deepEqual(deferred, [])
  })

  test(`F1 ${name}: a partial or rank close in flight defers this pass, and says why; the beat is not failed by it`, async () => {
    for (const state of IN_FLIGHT_EXIT_STATES) {
      const db = c.db(); planFor(c, db, state, 1_000)
      const { closed, out, deferred } = await c.run(db)
      assert.equal(closed.length, 0, `${state}: no competing close`)
      assert.equal(deferred.length, 1, `${state}: ${JSON.stringify(out)}`)
      const reason = typeof deferred[0] === 'string' ? deferred[0] : deferred[0].reason
      assert.match(reason, new RegExp(`momentum partial plan ${state} on position ${c.position}.*deferred at most ${TRANSPORT_HORIZON_MS} ms`))
      if (Array.isArray(out.errors)) assert.deepEqual(out.errors, [], `${state}: a deferral is not a failure`)
      // The plan row is read, never rewritten.
      assert.equal(db.prepare('SELECT state FROM momentum_partial_plans').get().state, state)
      // The next pass after the request ended closes (nothing was stamped done).
      db.prepare("UPDATE momentum_partial_plans SET state='AMBIGUOUS'").run()
      const next = await c.run(db)
      assert.equal(next.closed.length, 1, `${state} → AMBIGUOUS: the close proceeds on the next pass`)
    }
  })

  test(`F1 ${name}: bounded by the horizon — a claim older than ${TRANSPORT_HORIZON_MS} ms holds nothing off, the edge still defers`, async () => {
    for (const state of IN_FLIGHT_EXIT_STATES) {
      const stale = c.db(); planFor(c, stale, state, TRANSPORT_HORIZON_MS + 1)
      const a = await c.run(stale)
      assert.equal(a.closed.length, 1, `${state} past the horizon closes: ${JSON.stringify(a.deferred)}`)
      assert.deepEqual(a.deferred, [])
      const edge = c.db(); planFor(c, edge, state, TRANSPORT_HORIZON_MS)
      assert.equal((await c.run(edge)).closed.length, 0, `${state} at the horizon edge defers`)
    }
  })

  test(`F1 ${name}: another account's plan on the same position number does not defer`, async () => {
    // Dated on the closer's own clock (planFor), so only the account differs.
    const db = c.db(); planFor(c, db, 'SENDING', 1_000, `${c.account}9`)
    assert.equal((await c.run(db)).closed.length, 1)
    // The same plan on this account defers: the control above is not vacuous.
    const own = c.db(); planFor(c, own, 'SENDING', 1_000)
    assert.equal((await c.run(own)).closed.length, 0)
  })
}
