// node --test agent/services/momentum-book.test.js
//
// The TS momentum book (owner order 03-09-2026; two-sided since PR-D,
// 11-09-2026). Pinned: the pure arithmetic (ATR, the stop that only moves in
// the trade's favour, the targetless synth that execution must refuse and
// marketOnly); the cycle
// against an in-memory DB with fake broker calls — off writes nothing; a
// shadow long entry becomes one autoTrade per armed account with the keeper
// paused and a book row; a shadow SHORT is taken only at conviction ≥ 9 and
// never against an up-trend reading, as a 'short' row with a SELL order and
// a stop above entry; a shadow exit closes the position; the trail ratchets
// up (long) / down (short) and never the other way; an account with the
// strategy not armed, or autotrade off, is skipped; the report reads it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from '../db.js'
import { setStage } from './stage-matrix.js'
import {
  atrOf, trailStop, trailImproves, buildEntrySynth, momentumBookConfig, runMomentumBook, momentumBookReport,
  MOMENTUM_BOOK_CONFIG_KEY, MOMENTUM_BOOK_STATE_KEY, TSMOM_STRATEGY, DEFAULT_MOMENTUM_BOOK, RECONCILE_EVERY_MS, PENDING_FLIP_TTL_MS,
} from './momentum-book.js'
import { bookCloseVolume } from './book-close-volume.js'
import { MOMENTUM_SHADOW_STATE_KEY } from './momentum-shadow.js'

const DEMO = '111', LIVE = '222'
const cfg = momentumBookConfig({ enabled: true })
// PR-K (16-09-2026). The cases written before PR-K exercise a RANK EXIT on
// the pass that follows the shadow row — which is exactly the behaviour
// `bookExitCadence: 'every_pass'` restores, so they are kept verbatim as the
// restore-switch pin and say so here. The new default ('daily' cadence + a
// 24 h minimum hold) has its own cases at the end of this file; nothing that
// is NOT a rank exit (the stop, the refused-exit retry, the owed exit from a
// previous day) is configured away anywhere.
const EVERY_PASS = { enabled: true, bookExitCadence: 'every_pass' }

test('off by default; config repairs nonsense', () => {
  assert.equal(DEFAULT_MOMENTUM_BOOK.enabled, false)
  assert.equal(momentumBookConfig({ enabled: 'yes' }).enabled, false)
  const c = momentumBookConfig({ atrPeriod: 1, stopAtr: 50, maxPositionsPerAccount: 0 })
  assert.deepEqual([c.atrPeriod, c.stopAtr, c.maxPositionsPerAccount], [5, 10, 1])
})

test('ATR, the stop that only rises, and the targetless synth carries no waiver', () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({ t: i, o: 100, h: 101 + i * 0.1, l: 99 + i * 0.1, c: 100 + i * 0.1 }))
  const a = atrOf(bars, 20)
  assert.ok(a > 1.9 && a < 2.2, `ATR ≈ 2 (range 2 + gap 0.1), got ${a}`)
  assert.equal(atrOf(bars.slice(0, 10), 20), null, 'thin bars → null, never a number')
  assert.equal(trailStop({ prevStop: 90, close: 100, atr: 2, stopAtr: 3 }), 94)
  assert.equal(trailStop({ prevStop: 95, close: 100, atr: 2, stopAtr: 3 }), 95, 'never lowers')
  assert.equal(trailStop({ prevStop: null, close: 100, atr: 2, stopAtr: 3 }), 94)
  assert.equal(trailStop({ prevStop: 95, close: NaN, atr: 2, stopAtr: 3 }), 95, 'no price → the stop stands')
  // PR-D: a short's stop sits ABOVE the close and only ever comes down.
  assert.equal(trailStop({ prevStop: 110, close: 100, atr: 2, stopAtr: 3, side: 'short' }), 106)
  assert.equal(trailStop({ prevStop: 105, close: 100, atr: 2, stopAtr: 3, side: 'short' }), 105, 'never raises a short stop')
  assert.equal(trailStop({ prevStop: null, close: 100, atr: 2, stopAtr: 3, side: 'short' }), 106)
  assert.equal(trailImproves({ side: 'long', prevStop: 94, nextStop: 95 }), true)
  assert.equal(trailImproves({ side: 'long', prevStop: 95, nextStop: 94 }), false)
  assert.equal(trailImproves({ side: 'short', prevStop: 106, nextStop: 105 }), true)
  assert.equal(trailImproves({ side: 'short', prevStop: 105, nextStop: 106 }), false)
  const sh = buildEntrySynth({ symbol: 'NATGAS', price: 100, atr: 2, cfg, conviction: 9, rankPct: 0.02, side: 'short', directionReason: 'tsmom:short conviction 9 ≥ 9 trend unknown' })
  assert.equal(sh.consensus_bias, 'short'); assert.equal(sh.sl, 106, 'short stop above entry'); assert.equal(sh.tp1, null)
  assert.equal(sh.direction_reason, 'tsmom:short conviction 9 ≥ 9 trend unknown')
  assert.equal(buildEntrySynth({ symbol: 'X', price: 10, atr: 5, cfg, side: 'sideways' }), null, 'an unknown side is not a trade')
  const s = buildEntrySynth({ symbol: 'BTCUSD', price: 77000, atr: 1500, cfg, conviction: 9, rankPct: 1 })
  assert.equal(s.consensus_bias, 'long')
  assert.equal(s.direction_reason, 'tsmom:long_top_band', 'every entry states its direction (PR-D)')
  assert.equal(s.entry, 77000)
  assert.equal(s.sl, 77000 - 3 * 1500)
  assert.equal(s.tp1, null, 'no target: the exit is the ranking or the stop')
  assert.equal(s.noTarget, undefined, 'a missing TP1 is never converted into an execution waiver')
  assert.equal(s.strategy, TSMOM_STRATEGY)
  assert.equal(s.marketOnly, true)
  assert.equal(s.auto_trade, true)
  assert.equal(s.overall_conviction, 9)
  assert.equal(buildEntrySynth({ symbol: 'X', price: 10, atr: 5, cfg }), null, 'a stop at or below zero is not a trade')
})

function fresh() {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${DEMO}','1',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${LIVE}','2',1,1,'active')`).run()
  setState(db, 'symbol_id_map', JSON.stringify({ BTCUSD: 1, NATGAS: 2 }))
  return db
}
function shadowRow(db, { symbol, action, side = 'long', rank = 1, conviction = 9, price = 100, at = new Date().toISOString() }) {
  // `at` is ISO, as the shadow writes it (momentum-shadow.js: new Date(now).toISOString()).
  return db.prepare(`INSERT INTO momentum_shadow (symbol, action, side, rank_pct, conviction, price, timeframe, universe, applied, at) VALUES (?, ?, ?, ?, ?, ?, '1d', 20, 0, ?)`).run(symbol, action, side, rank, conviction, price, at).lastInsertRowid
}
// A fresh trend reading for a symbol ('short' = down-trend, 'long' = up-trend), `age` in SQLite modifier form.
function trendRow(db, symbol, dir, age = '0 minutes', regime = 'trending') {
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES (?, ?, ?, datetime('now', ?))`).run(symbol, regime, dir, `-${age}`)
}
function fakes({ fill = true } = {}) {
  const calls = { autoTrade: [], amend: [], close: [] }
  const bars = Array.from({ length: 30 }, (_, i) => ({ t: i, o: 100, h: 101 + i * 0.1, l: 99 + i * 0.1, c: 100 + i * 0.1 }))
  return {
    calls, bars,
    deps: {
      symbolMap: { BTCUSD: 1, NATGAS: 2 },
      bars: async () => bars,
      spot: async () => ({ bid: 102.9, ask: 103 }),
      amend: async (_c, args) => { calls.amend.push(args); return { protection: { stopLoss: args.stopLoss, takeProfit: args.takeProfit, verified: true, source: 'broker_reconcile', readStartedAtMs: Date.now(), checkedAtMs: Date.now(), readDurationMs: 0 } } },
      close: async (_c, args) => { calls.close.push(args); return {} },
      positionVolume: async () => 1000,
      phasesOn: () => true,
      mayTrade: () => ({ ok: true, item: null }),
      autoTrade: async (db, symbol, synth, _w, acct) => {
        calls.autoTrade.push({ symbol, synth, acct })
        if (!fill) return null
        const orderSide = synth.consensus_bias === 'short' ? 'SELL' : 'BUY'
        // Broker fixture: cycle tests need a protected filled position to
        // exercise trailing. The real boundary refuses this synth until its
        // strategy supplies an approved TP1.
        const tp1 = synth.consensus_bias === 'short' ? synth.entry - 10 : synth.entry + 10
        const t = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at) VALUES (?,?,'open',?,?,?,?,?,?,'bot_market_dispatch',?,datetime('now'))`)
          .run(symbol, orderSide, synth.entry, synth.sl, tp1, synth.strategy, synth.strategy, acct.accountId, `pos-${symbol}-${acct.accountId}`)
        db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, account_id, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'autopilot')`).run(symbol, t.lastInsertRowid, synth.consensus_bias, synth.entry, synth.sl, tp1, acct.accountId)
        return { side: orderSide, tradeId: t.lastInsertRowid }
      },
    },
  }
}
const accounts = [{ accountId: DEMO, isLive: false }, { accountId: LIVE, isLive: true }]
const credsFor = (a) => ({ accountId: a.accountId, host: a.isLive ? 'live' : 'demo' })

test('disabled: nothing runs, nothing written', async () => {
  const db = fresh()
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  assert.deepEqual(await runMomentumBook(db, { accounts, credsFor, deps: f.deps }), { ran: false, why: 'disabled' })
  assert.equal(f.calls.autoTrade.length, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM momentum_book`).get().n, 0)
})

test('a shadow long entry becomes one autoTrade per ARMED account, with the keeper paused and a book row; a shadow short at conviction 9 under a fresh down-trend reading is a SELL with the stop above entry (PR-D)', async () => {
  const db = fresh()
  trendRow(db, 'NATGAS', 'short')
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  const io = { getState, setState }
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, io)
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: LIVE }, io)
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', rank: 0.95, conviction: 9 })
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9 })
  const f = fakes()
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000_000 })
  assert.equal(r.ran, true)
  assert.equal(r.accounts, 2)
  assert.equal(r.entries, 4, `one long and one short per armed account — skipped: ${JSON.stringify(r.skipped)}`)
  assert.deepEqual(f.calls.autoTrade.map(c => [c.symbol, c.acct.accountId, c.acct.isLive]), [['BTCUSD', DEMO, false], ['NATGAS', DEMO, false], ['BTCUSD', LIVE, true], ['NATGAS', LIVE, true]])
  const synth = f.calls.autoTrade[0].synth
  assert.equal(synth.entry, 103, 'priced at the live ask, not the bar close')
  assert.equal(synth.tp1, null)
  assert.equal(synth.marketOnly, true)
  assert.equal(synth.strategy, TSMOM_STRATEGY)
  assert.equal(synth.consensus_bias, 'long')
  assert.match(synth.direction_reason, /^tsmom:long conviction 9 ≥ 6/, 'every entry states its direction (PR-D)')
  const shortSynth = f.calls.autoTrade[1].synth
  assert.equal(shortSynth.consensus_bias, 'short')
  assert.equal(shortSynth.entry, 102.9, 'a short hits the bid')
  assert.ok(shortSynth.sl > shortSynth.entry, 'a short stop is ABOVE entry')
  assert.match(shortSynth.direction_reason, /^tsmom:short conviction 9 ≥ 9 trend down/)
  const rows = db.prepare(`SELECT * FROM momentum_book ORDER BY id`).all()
  assert.equal(rows.length, 4)
  assert.ok(rows.every(x => x.status === 'open' && x.trade_id != null))
  assert.deepEqual(rows.map(x => [x.symbol, x.side]), [['BTCUSD', 'long'], ['NATGAS', 'short'], ['BTCUSD', 'long'], ['NATGAS', 'short']])
  assert.ok(rows.filter(x => x.side === 'short').every(x => x.stop > x.entry_price), 'the short rows hold a stop above entry')
  assert.deepEqual(db.prepare(`SELECT symbol, side FROM trades WHERE symbol = 'NATGAS' ORDER BY id`).all(), [{ symbol: 'NATGAS', side: 'SELL' }, { symbol: 'NATGAS', side: 'SELL' }], 'the order side is SELL')
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM monitored_positions WHERE paused = 1`).get().n, 4, 'the keeper is paused on book positions')
  assert.equal(JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).lastShadowRowId, 2)
  assert.ok(momentumBookReport(db).open.some(o => o.symbol === 'NATGAS' && o.side === 'short'), 'the report says which side')
  // A second pass with no new shadow rows enters nothing and does not re-enter the open names.
  const r2 = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_100_000 })
  assert.equal(r2.entries, 0)
  assert.equal(f.calls.autoTrade.length, 4)
})

test('PR-D direction policy on the book: a shadow short at conviction 8 is refused (short_rule), at 9 with NO reading refused (direction_no_trend_reading), at 9 with a down-trend admitted; against an up-trend refused; a stale reading is no reading (refused)', async () => {
  const mk = () => { const db = fresh(); setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true })); setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState }); return db }
  const one = [{ accountId: DEMO, isLive: false }]
  // conviction 8 < the 9 floor (6 × 1.5)
  let db = mk()
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.15, conviction: 8 })
  let f = fakes()
  let r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps })
  assert.equal(r.entries, 0); assert.equal(f.calls.autoTrade.length, 0)
  assert.ok(r.skipped.some(s => /NATGAS: short_rule: conviction 8 < 9/.test(s)), JSON.stringify(r.skipped))
  // conviction 9, NO reading → refused (checker MAJOR 2: unknown is not a reading)
  db = mk()
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9 })
  f = fakes()
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps })
  assert.equal(r.entries, 0); assert.equal(f.calls.autoTrade.length, 0)
  assert.ok(r.skipped.some(s => /NATGAS: direction_no_trend_reading: a short needs a fresh trend reading/.test(s)), JSON.stringify(r.skipped))
  // conviction 9 with a fresh down-trend → admitted
  db = mk()
  trendRow(db, 'NATGAS', 'short')
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9 })
  f = fakes()
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps })
  assert.equal(r.entries, 1, JSON.stringify(r.skipped)); assert.equal(f.calls.autoTrade[0].synth.consensus_bias, 'short')
  // conviction 9 against a fresh up-trend reading → refused, with the reason
  db = mk()
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('NATGAS', 'trending', 'long', datetime('now'))`).run()
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9 })
  f = fakes()
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps })
  assert.equal(r.entries, 0); assert.equal(f.calls.autoTrade.length, 0)
  assert.ok(r.skipped.some(s => /NATGAS: direction_against_trend: short into an up-trend/.test(s)), JSON.stringify(r.skipped))
  // a down-trend reading agrees → admitted; a long against a down-trend is NOT refused by this policy (the regime gate owns that)
  db = mk()
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('NATGAS', 'trending', 'short', datetime('now'))`).run()
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9 })
  f = fakes()
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps })
  assert.equal(r.entries, 1); assert.match(f.calls.autoTrade[0].synth.direction_reason, /trend down/)
  // a STALE down-trend row is no reading (the gate's age bound) → refused; the owner's own bound (regime_gate_json) is what the reader honours
  db = mk()
  trendRow(db, 'NATGAS', 'short', '2 days')
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9 })
  f = fakes()
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps })
  assert.equal(r.entries, 0, 'a fossil reading is no reading'); assert.ok(r.skipped.some(s => /direction_no_trend_reading/.test(s)))
  db = mk()
  trendRow(db, 'NATGAS', 'short', '30 minutes')
  setState(db, 'regime_gate_json', JSON.stringify({ on: true, maxRegimeAgeMin: 10 }))
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9 })
  f = fakes()
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps })
  assert.equal(r.entries, 0, 'a 30-minute row under the owner\'s 10-minute bound is a fossil'); assert.ok(r.skipped.some(s => /direction_no_trend_reading/.test(s)))
})

test('the REGIME GATE is on the book\'s path (checker MAJOR 1): a long into a quiet regime is refused with a decision_log skip row; the owner\'s off switch lifts it; a short with the gate off has no reading', async () => {
  const mk = () => { const db = fresh(); setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true })); setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState }); return db }
  const one = [{ accountId: DEMO, isLive: false }]
  let db = mk()
  trendRow(db, 'BTCUSD', null, '0 minutes', 'quiet')
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', rank: 0.95, conviction: 9 })
  let f = fakes()
  let r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps })
  assert.equal(r.entries, 0); assert.equal(f.calls.autoTrade.length, 0)
  assert.ok(r.skipped.some(s => /BTCUSD: regime_block trend-in-quiet \(tsmom_long\)/.test(s)), JSON.stringify(r.skipped))
  const { recentDecisions } = await import('./decision-log.js')
  const rows = recentDecisions(db, { symbol: 'BTCUSD', stage: 'regime_gate' })
  assert.equal(rows.length, 1); assert.equal(rows[0].decision, 'skip'); assert.match(rows[0].reason, /trend-in-quiet/); assert.equal(String(rows[0].account_id), DEMO)
  // the owner switches the gate off → the long enters
  db = mk()
  trendRow(db, 'BTCUSD', null, '0 minutes', 'quiet')
  setState(db, 'regime_gate_json', JSON.stringify({ on: false }))
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', rank: 0.95, conviction: 9 })
  f = fakes()
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps })
  assert.equal(r.entries, 1, JSON.stringify(r.skipped))
  // gate off, a short: the reading is gone with it → refused as no reading, never placed on a table the owner turned off
  db = mk()
  trendRow(db, 'NATGAS', 'short')
  setState(db, 'regime_gate_json', JSON.stringify({ on: false }))
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9 })
  f = fakes()
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps })
  assert.equal(r.entries, 0); assert.ok(r.skipped.some(s => /direction_no_trend_reading/.test(s)))
})

test('CHECKER COUNTEREXAMPLE (BLOCKER): shadow exit(long)+enter(short) for one name in ONE batch — the long is exited FIRST (rank exit (flip)) and the short entered; a later shadow exit of the short closes the SHORT row', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  const f = fakes(); const one = [{ accountId: DEMO, isLive: false }]
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'long', rank: 0.95, conviction: 9 })
  let r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 1_000 })
  assert.equal(r.entries, 1, JSON.stringify(r.skipped))
  // the trend turned (which is why the shadow flips) and the loop was down for > 1 shadow interval: both rows land in one batch
  trendRow(db, 'NATGAS', 'short')
  shadowRow(db, { symbol: 'NATGAS', action: 'exit', side: 'long', rank: 0.3 })
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9 })
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 2_000 })
  assert.equal(r.exits, 1, `the long's exit is not dropped by the enter — skipped: ${JSON.stringify(r.skipped)}`)
  assert.equal(r.entries, 1, 'the short is entered after the exit')
  assert.equal(f.calls.close.length, 1); assert.equal(f.calls.close[0].positionId, `pos-NATGAS-${DEMO}`)
  assert.deepEqual(db.prepare(`SELECT side, status, note FROM momentum_book ORDER BY id`).all(), [{ side: 'long', status: 'exit_sent', note: 'rank exit (flip)' }, { side: 'short', status: 'open', note: 'entered on shadow row 3' }])
  // fix-the-exits BA: the rank exit is journalled so the reconciler can attribute the close it will see next pass
  assert.deepEqual(db.prepare(`SELECT position_id, symbol, kind, reason, source FROM position_events WHERE kind = 'close'`).all(),
    [{ position_id: `pos-NATGAS-${DEMO}`, symbol: 'NATGAS', kind: 'close', reason: 'rank exit (flip)', source: 'momentum_book' }])
  assert.deepEqual(f.calls.autoTrade.map(c => c.synth.consensus_bias), ['long', 'short'])
  // a later pass (reconcile window elapsed): nothing more
  const r3 = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 2_000 + 7 * 3_600_000 })
  assert.equal(r3.exits + r3.entries + r3.reconciled, 0, JSON.stringify(r3))
  // the shadow then exits the SHORT: that row closes the SHORT, not a long
  shadowRow(db, { symbol: 'NATGAS', action: 'exit', side: 'short', rank: 0.5 })
  const r4 = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 3_000 + 7 * 3_600_000 })
  assert.equal(r4.exits, 1); assert.equal(f.calls.close.length, 2)
  assert.deepEqual(db.prepare(`SELECT side, status FROM momentum_book ORDER BY id`).all(), [{ side: 'long', status: 'exit_sent' }, { side: 'short', status: 'exit_sent' }])
})

test('a flip whose short is REFUSED still exits the long (the exit never waits on the entry); a flip the cursor already passed is an OWED exit (last word: enter on the other side)', async () => {
  // refused short: no trend reading → the long still goes
  let db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  let f = fakes(); const one = [{ accountId: DEMO, isLive: false }]
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'long', rank: 0.95, conviction: 9 })
  await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 1_000 })
  shadowRow(db, { symbol: 'NATGAS', action: 'exit', side: 'long', rank: 0.3 })
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9 })
  let r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 2_000 })
  assert.equal(r.exits, 1); assert.equal(r.entries, 0); assert.ok(r.skipped.some(s => /direction_no_trend_reading/.test(s)))
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'exit_sent')
  // owed: the cursor has already passed the flip rows (an earlier pass whose close failed silently, before the flag existed)
  db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  f = fakes()
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'long', rank: 0.95, conviction: 9, at: '2026-09-10T00:00:00.000Z' })
  await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: Date.parse('2026-09-10T01:00:00Z') })
  const flipId = shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9, at: '2026-09-11T00:00:00.000Z' })
  setState(db, MOMENTUM_BOOK_STATE_KEY, JSON.stringify({ ...JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)), lastShadowRowId: flipId }))
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: Date.parse('2026-09-11T02:00:00Z') })
  assert.equal(r.exits, 1, 'the shadow\'s last word is enter(short) after a long row was entered: the exit is owed')
  assert.equal(db.prepare(`SELECT status, note FROM momentum_book WHERE side = 'long'`).get().note, 'rank exit (flip)')
})

test('PR-D: the trail moves a short\'s stop DOWN and never up; the ledger follows; a rank exit closes the short', async () => {
  const db = fresh()
  trendRow(db, 'NATGAS', 'short')
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9 })
  const f = fakes()
  const one = [{ accountId: DEMO, isLive: false }]
  await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 1_000 })
  const row = db.prepare(`SELECT * FROM momentum_book`).get()
  assert.equal(row.side, 'short'); assert.ok(row.stop > row.entry_price)
  // Price falls 10: the stop comes down with it.
  f.deps.bars = async () => f.bars.map(b => ({ ...b, h: b.h - 10, l: b.l - 10, c: b.c - 10 }))
  let r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 2_000 })
  assert.equal(r.trailed, 1)
  const after = db.prepare(`SELECT stop FROM momentum_book`).get().stop
  assert.ok(after < row.stop, `short stop fell: ${row.stop} → ${after}`)
  assert.equal(f.calls.amend[0].stopLoss, after); assert.equal(f.calls.amend[0].takeProfit, row.entry_price - 10)
  assert.equal(db.prepare(`SELECT sl_price FROM trades`).get().sl_price, after)
  // Price bounces back up: the short stop does NOT rise.
  f.deps.bars = async () => f.bars
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 3_000 })
  assert.equal(r.trailed, 0); assert.equal(db.prepare(`SELECT stop FROM momentum_book`).get().stop, after)
  // The ranking's exit closes it.
  shadowRow(db, { symbol: 'NATGAS', action: 'exit', side: 'short', rank: 0.5 })
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 4_000 })
  assert.equal(r.exits, 1); assert.equal(f.calls.close[0].positionId, `pos-NATGAS-${DEMO}`)
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'exit_sent')
})

test('accounts where tsmom_long is not armed, or autotrade is off, are skipped; the cap holds; an unfilled autoTrade leaves no row', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true, maxPositionsPerAccount: 1 }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  shadowRow(db, { symbol: 'NATGAS', action: 'enter' })
  const f = fakes()
  let r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps })
  assert.equal(r.accounts, 1, 'LIVE is not armed')
  assert.equal(r.entries, 1, 'the cap of 1 holds')
  assert.ok(r.skipped.some(s => /maxPositionsPerAccount/.test(s)))
  // autotrade off on the account → skipped entirely
  const db2 = fresh()
  setState(db2, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db2, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db2, { symbol: 'BTCUSD', action: 'enter' })
  const g = fakes(); g.deps.phasesOn = () => false
  r = await runMomentumBook(db2, { accounts, credsFor, deps: g.deps })
  assert.equal(r.accounts, 0)
  assert.equal(g.calls.autoTrade.length, 0)
  // gate/broker refused → no book row, no pause
  const db3 = fresh()
  setState(db3, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db3, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db3, { symbol: 'BTCUSD', action: 'enter' })
  const h = fakes({ fill: false })
  r = await runMomentumBook(db3, { accounts, credsFor, deps: h.deps })
  assert.equal(r.entries, 0)
  assert.equal(db3.prepare(`SELECT COUNT(*) n FROM momentum_book`).get().n, 0)
})

test('a shadow exit closes the position and marks the row; the trail ratchets the stop up, never down, and a closed trade closes the row', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 1_000 })
  const before = db.prepare(`SELECT stop FROM momentum_book`).get().stop
  // Price climbs: the close of the fake bars is 102.9, stop was 103 − 3·ATR. Push the bars up 10 and trail.
  f.deps.bars = async () => f.bars.map(b => ({ ...b, h: b.h + 10, l: b.l + 10, c: b.c + 10 }))
  let r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 2_000 })
  assert.equal(r.trailed, 1)
  const after = db.prepare(`SELECT stop FROM momentum_book`).get().stop
  assert.ok(after > before, `stop rose: ${before} → ${after}`)
  assert.equal(f.calls.amend.length, 1)
  assert.equal(f.calls.amend[0].stopLoss, after)
  assert.equal(f.calls.amend[0].takeProfit, 113, 'the trail re-sends broker-native TP1')
  assert.equal(db.prepare(`SELECT sl_price FROM trades`).get().sl_price, after, 'the ledger follows the ratchet')
  assert.equal(db.prepare(`SELECT current_sl FROM monitored_positions`).get().current_sl, after)
  // A target updated on the record survives the next trail amend.
  db.prepare(`UPDATE monitored_positions SET current_tp = 999`).run()
  db.prepare(`UPDATE trades SET tp_price = 999`).run()
  f.deps.bars = async () => f.bars.map(b => ({ ...b, h: b.h + 20, l: b.l + 20, c: b.c + 20 }))
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 2_500 })
  assert.equal(r.trailed, 1)
  assert.equal(f.calls.amend.at(-1).takeProfit, 999, 'the amended stop carries the updated TP1')
  assert.equal(db.prepare(`SELECT current_tp FROM monitored_positions`).get().current_tp, 999, 'the trail preserves recorded TP1')
  assert.equal(db.prepare(`SELECT tp_price FROM trades`).get().tp_price, 999)
  const after2 = db.prepare(`SELECT stop FROM momentum_book`).get().stop
  assert.ok(after2 > after)
  // Price falls back: the stop does NOT follow.
  f.deps.bars = async () => f.bars
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 3_000 })
  assert.equal(r.trailed, 0)
  assert.equal(db.prepare(`SELECT stop FROM momentum_book`).get().stop, after2)
  // Rank exit: the position is closed and the row says why.
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit' })
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 4_000 })
  assert.equal(r.exits, 1)
  assert.equal(f.calls.close.length, 1)
  assert.equal(f.calls.close[0].positionId, `pos-BTCUSD-${DEMO}`)
  assert.equal(f.calls.close[0].volume, 1000, 'the close carries the broker volume — cTrader refuses one without (LLY.US, 09-09-2026)')
  assert.equal(db.prepare(`SELECT status, note FROM momentum_book`).get().status, 'exit_sent')
  // The reconciler closes the trade; the next pass closes the row and the report reads it.
  db.prepare(`UPDATE trades SET status = 'closed', net_pnl = 250, closed_at = datetime('now')`).run()
  db.prepare(`UPDATE momentum_book SET status = 'open'`).run() // simulate a row the reconciler beat to the close
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000 })
  const rep = momentumBookReport(db)
  assert.equal(rep.open.length, 0)
  assert.deepEqual(rep.closed, { n: 1, wins: 1, winRate: 100, profitFactor: null, net: 250 })
  assert.equal(rep.config.enabled, true)
})

test('a targetless book row never advances its ledger without broker read-back confirmation', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 1_000 })
  db.prepare(`UPDATE monitored_positions SET current_tp = NULL`).run()
  db.prepare(`UPDATE trades SET tp_price = NULL`).run()
  f.deps.bars = async () => f.bars.map(b => ({ ...b, h: b.h + 10, l: b.l + 10, c: b.c + 10 }))

  const standing = db.prepare('SELECT stop FROM momentum_book').get().stop
  f.deps.amend = async () => ({ ok: true }) // send acknowledgement alone is insufficient
  const r = await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })
  assert.equal(r.trailed, 0)
  assert.equal(db.prepare('SELECT stop FROM momentum_book').get().stop, standing)
  assert.ok(r.skipped.some(s => /not confirmed/.test(s)), JSON.stringify(r.skipped))
  assert.match(db.prepare('SELECT trail_note FROM momentum_book').get().trail_note, /broker protection failed/)
  const state = JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY))
  assert.equal(state.markFail[`${DEMO}|BTCUSD`], undefined, 'fresh bar is not falsely labelled unavailable')
  assert.ok(state.marks[`${DEMO}|BTCUSD`].c > 0)
  const old = Date.now() - 5001
  f.deps.amend = async (_c, args) => ({ protection: { verified: true, stopLoss: args.stopLoss,
    takeProfit: null, source: 'broker_reconcile', readStartedAtMs: old, checkedAtMs: old, readDurationMs: 0 } })
  const stale = await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 3_000 })
  assert.equal(stale.trailed, 0)
  assert.equal(db.prepare('SELECT stop FROM momentum_book').get().stop, standing, 'expired proof cannot advance ledger')
})

test('wiring pins: the loop runs the book after the shadow with the real autoTrade and broker calls injected; the limit branch honours marketOnly (comments stripped)', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  const shadow = src.indexOf("import('./services/momentum-shadow.js')")
  const book = src.indexOf("import('./services/momentum-book.js')")
  assert.ok(shadow > 0 && book > shadow, 'the book runs after the shadow')
  const block = src.slice(book, src.indexOf('momentum book:', book))
  assert.ok(block.includes('accounts: getAutopilotAccounts(db)'))
  assert.ok(block.includes('credsFor: (a) => getCtraderCreds(db, a)'))
  assert.ok(block.includes('autoTrade,'))
  assert.ok(block.includes('amend: (creds, args) => amendBookStop(creds, args,'), 'the loop uses the broker-confirmed stop adapter')
  assert.ok(block.includes('await wsReconcile('), 'fresh reads bypass the sidecar snapshot cache')
  assert.ok(block.includes('close: (creds, args) => exec.closePosition(creds, args)'))
  assert.ok(block.includes('positionVolume: async (creds, positionId) => brokerPositionVolume((await exec.reconcile(creds)).position || [], positionId)'), 'the loop hands the book the broker volume for its closes')
  assert.ok(block.includes('phasesOn: (accountId) => !!effectivePhases(db, accountId)?.autotrade'))
  assert.ok(block.includes("digitsFor: async (creds, symbolId) => (await (await import('./lib/lot-sizing.js')).getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)).digits"), 'the loop hands the book the symbol digits the trailed stop is rounded to')
  assert.ok(src.includes("synth.marketOnly !== true && !fresh"), 'a marketOnly synth never rests as a limit')
})

// ---------------------------------------------------------------------------
// 04-09-2026, Railway logs: every trail amend since adoption was refused —
// "Order price = 1053.4199999999998 has more digits than allowed" (LLY.US),
// "Order protection = 344.358 has more digits than symbol allows. Allowed 2
// digits" (GD.US). The book's stop that "only rises" had never risen once.
// ---------------------------------------------------------------------------

test('the trailed stop is rounded to the symbol digits before the amend, and the rounded value is what the ledger stores', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  const askedDigits = []
  f.deps.digitsFor = async (_c, symbolId) => { askedDigits.push(symbolId); return 2 }
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 1_000 })
  // Bars shifted by a float-noisy amount: close − 3·ATR carries far more than two decimals.
  f.deps.bars = async () => f.bars.map(b => ({ ...b, h: b.h + 10.123456789, l: b.l + 10.123456789, c: b.c + 10.123456789 }))
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 2_000 })
  assert.equal(r.trailed, 1)
  assert.equal(f.calls.amend.length, 1)
  const sent = f.calls.amend[0].stopLoss
  assert.equal(sent, Math.round(sent * 100) / 100, `the amend carries at most two decimals: ${sent}`)
  assert.equal(db.prepare(`SELECT stop FROM momentum_book`).get().stop, sent, 'the book stores what the broker holds')
  assert.equal(db.prepare(`SELECT sl_price FROM trades`).get().sl_price, sent)
  assert.ok(askedDigits.length >= 1 && askedDigits.every(id => id === 1), `digits are asked for THIS symbol id on every pass: ${JSON.stringify(askedDigits)}`)
})

test('without a digits source the raw trailed stop still goes out (the fixture path) — the loop wiring pin above is what guarantees production rounds', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 1_000 })
  f.deps.bars = async () => f.bars.map(b => ({ ...b, h: b.h + 10.123456789, l: b.l + 10.123456789, c: b.c + 10.123456789 }))
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 2_000 })
  assert.equal(r.trailed, 1)
  assert.notEqual(f.calls.amend[0].stopLoss, Math.round(f.calls.amend[0].stopLoss * 100) / 100, 'no rounding was applied — proves the digits path is what the first test exercised')
})

// ---------------------------------------------------------------------------
// 03-09-2026: the first production pass read LLY.US at 6.56 on ACCT-LIVE-1
// (1,159.32 on the demos) because one shared symbol map was applied to every
// account, and could not enter an open market at all because the no-target
// bracket tripped guard_no_target. Both are pinned here.
// ---------------------------------------------------------------------------

test('the symbol id is resolved PER ACCOUNT through symbolIdFor(creds, symbol); a null resolution skips the entry with the account named', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  const io = { getState, setState }
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, io)
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: LIVE }, io)
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', rank: 0.95, conviction: 9 })
  const f = fakes()
  const asked = []
  const seenIds = []
  f.deps.symbolIdFor = async (creds, symbol) => { asked.push([creds.accountId, symbol]); return creds.accountId === LIVE ? null : 77 }
  f.deps.bars = async (_c, id) => { seenIds.push(id); return f.bars }
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000_000 })
  assert.deepEqual(asked.slice(0, 2), [[DEMO, 'BTCUSD'], [LIVE, 'BTCUSD']], 'each account resolves with ITS OWN creds (the trail pass asks again for the open row)')
  assert.ok(seenIds.length >= 1 && seenIds.every(id => id === 77), `bars (entry and trail) are fetched with the account-resolved id, never the shared map's 1: ${JSON.stringify(seenIds)}`)
  assert.equal(r.entries, 1)
  assert.ok(r.skipped.some(s => s.startsWith(`${LIVE} BTCUSD: not in this account's symbol list`)), JSON.stringify(r.skipped))
  assert.equal(f.calls.autoTrade.length, 1)
  assert.equal(f.calls.autoTrade[0].synth.noTarget, undefined, 'the synth carries no target waiver')
})

test('an open tsmom_long trade with no book row (a resting limit that filled later) is adopted once, keeper paused; an exited row is not re-adopted', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  // The limit path stamps a 1.5R target (3.45); adoption must preserve it.
  const tid = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at) VALUES ('NATGAS','BUY','open',3.0,2.7,3.45,?,?,?,'bot_market_dispatch','pos-late',datetime('now'))`)
    .run(TSMOM_STRATEGY, TSMOM_STRATEGY, DEMO).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, account_id, status, source) VALUES ('NATGAS', ?, 'long', 3.0, 2.7, 3.45, ?, 'active', 'autopilot')`).run(tid, DEMO)
  const f = fakes()
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000_000 })
  assert.equal(r.adopted, 1)
  const row = db.prepare(`SELECT * FROM momentum_book WHERE trade_id = ?`).get(tid)
  assert.ok(row && row.status === 'open' && row.position_id === 'pos-late' && row.stop >= 2.7, JSON.stringify(row))
  const mp = db.prepare(`SELECT paused, current_tp FROM monitored_positions WHERE trade_id = ?`).get(tid)
  assert.equal(mp.paused, 1)
  assert.equal(mp.current_tp, 3.45, 'adoption preserves broker-native TP1')
  assert.equal(db.prepare(`SELECT tp_price FROM trades WHERE id = ?`).get(tid).tp_price, 3.45)
  // second pass: nothing new to adopt
  const r2 = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_100_000 })
  assert.equal(r2.adopted, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM momentum_book`).get().n, 1)
  // rank exit → exit_sent; the trade row is still 'open' until the reconciler closes it — must NOT be adopted again
  shadowRow(db, { symbol: 'NATGAS', action: 'exit' })
  const r3 = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_200_000 })
  assert.equal(r3.exits, 1)
  assert.equal(r3.adopted, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM momentum_book`).get().n, 1)
})

// ---------------------------------------------------------------------------
// RECONCILE (owner "build it", 03-09-2026, §7,272·B): the shadow emits `enter`
// only on the flat→long transition, so a held name whose order never filled
// (an expired closed-market limit, a gate refusal that day) was never tried
// again. Every pass re-proposes each held long with no open row and no
// working limit, at most once per symbol per account per RECONCILE_EVERY_MS.
// ---------------------------------------------------------------------------

test('reconcile: a long the shadow holds with no book row and no working limit is re-proposed; throttled per symbol/account; a working limit or an open row blocks it', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  // The shadow holds BTCUSD and NATGAS long; no new enter rows exist (they were consumed earlier).
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: {
    BTCUSD: { side: 'long', entryPrice: 77000, enteredAt: 1, entryRank: 0.95, entryConviction: 9 },
    NATGAS: { side: 'long', entryPrice: 2.9, enteredAt: 1, entryRank: 0.9, entryConviction: 8 },
  }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  // NATGAS already has a resting tsmom limit on this account → must not be stacked.
  db.prepare(`INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, placed_at, expires_at, status, note, strategy, account_id) VALUES ('NATGAS','1d','o1',1,2.9,2.7,NULL,1,datetime('now'),datetime('now','+1 day'),'working','pending-closed',?,?)`).run(TSMOM_STRATEGY, DEMO)
  const f = fakes()
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000_000 })
  assert.equal(r.reconciled, 1, `only BTCUSD is reconciled: ${JSON.stringify(r.skipped)}`)
  assert.equal(r.entries, 1)
  assert.deepEqual(f.calls.autoTrade.map(c => c.symbol), ['BTCUSD'])
  const row = db.prepare(`SELECT * FROM momentum_book WHERE symbol = 'BTCUSD' AND account_id = ?`).get(DEMO)
  assert.ok(row && row.status === 'open' && /reconciled/.test(row.note), JSON.stringify(row))
  assert.equal(row.entry_rank, 0.95, 'the held rank rides on the row')
  // Same pass again within the hour: BTCUSD now has an open row, NATGAS still has its limit → nothing.
  const r2 = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000_000 + 60_000 })
  assert.equal(r2.reconciled, 0)
  assert.equal(f.calls.autoTrade.length, 1)
  // Throttle: a held name whose attempt was refused is not retried inside RECONCILE_EVERY_MS.
  db.prepare(`DELETE FROM pending_orders`).run()
  const g = fakes({ fill: false })
  const r3 = await runMomentumBook(db, { accounts, credsFor, deps: g.deps, now: 5_000_000 + 120_000 })
  assert.equal(r3.reconciled, 1, 'NATGAS attempted once the limit is gone')
  assert.equal(g.calls.autoTrade.length, 1)
  const r4 = await runMomentumBook(db, { accounts, credsFor, deps: g.deps, now: 5_000_000 + 180_000 })
  assert.equal(r4.reconciled, 0, 'not retried within the hour')
  assert.equal(g.calls.autoTrade.length, 1)
  const r5 = await runMomentumBook(db, { accounts, credsFor, deps: g.deps, now: 5_000_000 + 120_000 + RECONCILE_EVERY_MS + 1 })
  assert.equal(r5.reconciled, 1, 'retried after the hour')
  assert.ok(JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).reconciledAt[`${DEMO}|NATGAS`] > 0, 'the throttle stamp persists')
})

test('reconcile re-proposes a held SHORT too (PR-D, under the direction policy) and never a name with a fresh enter row this pass (those go through the normal entry)', async () => {
  const db = fresh()
  trendRow(db, 'NATGAS', 'short')
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: {
    NATGAS: { side: 'short', entryPrice: 2.9, enteredAt: 1, entryRank: 0.05, entryConviction: 9 },
    BTCUSD: { side: 'long', entryPrice: 77000, enteredAt: 1, entryRank: 0.95, entryConviction: 9 },
  }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', rank: 0.95, conviction: 9 })
  const f = fakes()
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000_000 })
  assert.equal(r.entries, 2)
  assert.equal(r.reconciled, 1, 'BTCUSD entered through its enter row; the held short is reconciled')
  assert.deepEqual(f.calls.autoTrade.map(c => [c.symbol, c.synth.consensus_bias]), [['BTCUSD', 'long'], ['NATGAS', 'short']])
  // The same held short at conviction 8 is refused by the policy and not reconciled into a position.
  const db2 = fresh()
  setState(db2, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db2, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  setState(db2, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { NATGAS: { side: 'short', entryPrice: 2.9, enteredAt: 1, entryRank: 0.15, entryConviction: 8 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  const g = fakes()
  const r2 = await runMomentumBook(db2, { accounts, credsFor, deps: g.deps, now: 5_000_000 })
  assert.equal(r2.entries, 0); assert.ok(r2.skipped.some(s => /short_rule: conviction 8 < 9/.test(s)))
  // A held short with NO recorded conviction is refused — no fallback to the book's default for the side that needs the floor (checker item h).
  const db3 = fresh()
  trendRow(db3, 'NATGAS', 'short')
  setState(db3, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true, conviction: 10 }))
  setStage(db3, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  setState(db3, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { NATGAS: { side: 'short', entryPrice: 2.9, enteredAt: 1, entryRank: 0.05 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  const h = fakes()
  const r3 = await runMomentumBook(db3, { accounts, credsFor, deps: h.deps, now: 5_000_000 })
  assert.equal(r3.entries, 0); assert.ok(r3.skipped.some(s => /short_rule: conviction \? < 9/.test(s)), JSON.stringify(r3.skipped))
})

test('THE 21:32 SGT CASE: the momentum account adopts its filled tsmom_long trade too, before its daily branch', async () => {
  const { MOMENTUM_ACCOUNT_KEY } = await import('./momentum-account.js')
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: DEMO, volTargetPct: 10, maxPositions: 8 }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  const tid = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at) VALUES ('MSFT.US','BUY','open',500.44,463.47,510,?,?,?,'reconciler_adopted','pos-msft',datetime('now'))`)
    .run(TSMOM_STRATEGY, TSMOM_STRATEGY, DEMO).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, account_id, status, source) VALUES ('MSFT.US', ?, 'long', 500.44, 463.47, 510, ?, 'active', 'autopilot')`).run(tid, DEMO)
  const f = fakes()
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000_000 })
  assert.equal(r.adopted, 1, JSON.stringify(r.skipped))
  const row = db.prepare(`SELECT * FROM momentum_book WHERE trade_id = ?`).get(tid)
  assert.ok(row && row.status === 'open' && row.position_id === 'pos-msft', JSON.stringify(row))
  assert.equal(db.prepare(`SELECT paused, current_tp FROM monitored_positions WHERE trade_id = ?`).get(tid).paused, 1)
})

// ---------------------------------------------------------------------------
// The close's volume (09-09-2026 17:00 SGT): LLY.US rank exit on ACCT-DEMO-1
// failed `Message missing required fields: volume`. Broker position first,
// trade lots × lot size second, else the close is NOT sent and the row stays
// open with the reason in the summary.
// ---------------------------------------------------------------------------
test('bookCloseVolume: broker volume first, trade lots × lot size second, null when neither can say', async () => {
  const db = fresh()
  const tid = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, label_strategy, strategy, account_id, origin, ctrader_position_id, volume, opened_at) VALUES ('LLY.US','BUY','open',700,650,?,?,?,'bot_market_dispatch','pos-lly',0.5,datetime('now'))`)
    .run(TSMOM_STRATEGY, TSMOM_STRATEGY, DEMO).lastInsertRowid
  const row = { trade_id: tid, position_id: 'pos-lly', symbol: 'LLY.US' }
  const lotDeps = { symbolIdFor: async () => 7, volumeMeta: async () => ({ lotSize: 100 }) }
  assert.equal(await bookCloseVolume(db, {}, row, { positionVolume: async () => 60, ...lotDeps }), 60, 'the broker is the authority')
  assert.equal(await bookCloseVolume(db, {}, row, { positionVolume: async () => null, ...lotDeps }), 50, '0.5 lots × 100 = 50 units')
  assert.equal(await bookCloseVolume(db, {}, row, { positionVolume: async () => { throw new Error('502') }, ...lotDeps }), 50, 'a broker read failure falls through to the trade row')
  assert.equal(await bookCloseVolume(db, {}, row, { positionVolume: async () => null }), null, 'no lot meta → nothing to send')
  assert.equal(await bookCloseVolume(db, {}, { ...row, trade_id: null }, { positionVolume: async () => null, ...lotDeps }), null, 'no trade row → nothing to send')
  db.prepare(`UPDATE trades SET volume = NULL WHERE id = ?`).run(tid)
  assert.equal(await bookCloseVolume(db, {}, row, { positionVolume: async () => null, ...lotDeps }), null, 'a trade with no lots → nothing to send')
})

test('a rank exit with no resolvable volume is NOT sent: the row stays open, the summary says why, and the next pass retries once the broker answers', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  let brokerVolume = null
  f.deps.positionVolume = async () => brokerVolume
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 1_000 })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM momentum_book WHERE status = 'open'`).get().n, 1)
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit' })
  let r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 2_000 })
  assert.equal(r.exits, 0)
  assert.equal(f.calls.close.length, 0, 'no volume, no close')
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'open', 'the row is not marked exit_sent for a close that never went')
  assert.match(db.prepare(`SELECT note FROM momentum_book`).get().note, /^exit_pending: unknown volume/, 'the refused exit is flagged on the row so the next pass retries it (the shadow cursor never re-reads the exit row)')
  assert.ok(r.skipped.some(x => /BTCUSD: close failed — unknown volume/.test(x)), JSON.stringify(r.skipped))
  // The broker answers next pass: the close goes with its volume.
  brokerVolume = 250
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 3_000 })
  assert.equal(r.exits, 1)
  assert.deepEqual(f.calls.close, [{ positionId: `pos-BTCUSD-${DEMO}`, volume: 250 }])
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'exit_sent')
})

test('wiring pin: both book exit paths resolve the volume before the close', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const f of ['./momentum-book.js', './momentum-account.js']) {
    const src = strip(readFileSync(new URL(f, import.meta.url), 'utf8'))
    assert.match(src, /const volume = await bookCloseVolume\(db, creds, row, deps\)[\s\S]{0,200}?if \(volume == null\) throw new Error\('unknown volume — close not sent'\)[\s\S]{0,120}?deps\.close\(creds, \{ positionId: row\.position_id, volume \}\)/, `${f} sends the close with its volume`)
    assert.ok(!/deps\.close\(creds, \{ positionId: row\.position_id \}\)/.test(src), `${f} has no volume-less close left`)
  }
})

// ---------------------------------------------------------------------------
// The ranking's last word (09-09-2026, the LLY.US residue): an exit refused
// BEFORE the exit_pending flag existed carries no flag and the cursor never
// re-reads the exit row. The newest shadow enter/exit word for the symbol,
// written after the row was entered, is an exit still owed.
// ---------------------------------------------------------------------------
test('an open row whose newest shadow word is exit (after entry) is exited even with no flag; adopted rows the shadow never ranked and re-entries are untouched', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', at: new Date(500).toISOString() })
  const f = fakes()
  let closeOk = false
  f.deps.close = async (_c, args) => { if (!closeOk) throw new Error('old code: nothing sent'); f.calls.close.push(args); return {} }
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 1_000 })
  assert.equal(db.prepare(`SELECT status FROM momentum_book WHERE symbol = 'BTCUSD'`).get().status, 'open')
  // The exit row is read once through the cursor; the close fails; then the
  // flag is wiped to mimic the pre-#872 code that never wrote one.
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit', at: new Date(5_000).toISOString() })
  shadowRow(db, { symbol: 'NATGAS', action: 'exit', at: new Date(2_000).toISOString() }) // consumed by this pass too: no NATGAS row yet
  let r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 6_000 })
  assert.equal(r.exits, 0)
  db.prepare(`UPDATE momentum_book SET note = 'rank entry' WHERE symbol = 'BTCUSD'`).run()
  // An adopted row the shadow never ranked, and a name re-entered AFTER its exit word.
  const adopted = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at) VALUES ('MSFT.US','BUY','open',500,463,NULL,?,?,?,'reconciler_adopted','pos-msft',datetime('now'))`)
    .run(TSMOM_STRATEGY, TSMOM_STRATEGY, DEMO).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, account_id, status, source) VALUES ('MSFT.US', ?, 'long', 500, 463, ?, 'active', 'autopilot')`).run(adopted, DEMO)
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entry_rank, entered_at, status, note) VALUES (NULL, ?, 'NATGAS', 'pos-natgas', 'long', 3, 2.7, 0.1, 0.9, ?, 'open', 're-entered after the exit word')`).run(DEMO, new Date(7_000).toISOString())
  closeOk = true
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 8_000 })
  assert.equal(r.exits, 1, JSON.stringify(r.skipped))
  assert.deepEqual(f.calls.close, [{ positionId: `pos-BTCUSD-${DEMO}`, volume: 1000 }], 'the owed BTCUSD exit goes; nothing else is closed')
  const st = Object.fromEntries(db.prepare(`SELECT symbol, status FROM momentum_book`).all().map(x => [x.symbol, x.status]))
  assert.equal(st.BTCUSD, 'exit_sent')
  assert.equal(st['MSFT.US'], 'open', 'adopted, never ranked by the shadow: untouched')
  assert.equal(st.NATGAS, 'open', 'entered after its exit word: untouched')
})

// ---------------------------------------------------------------------------
// PR-K (16-09-2026) — THE HORIZON. Measured over 95 bot deals, 09–11 Sep:
// positions held over 24 h netted −972, and the three largest single losses
// were this book's RANK exits firing intraday on positions entered for a
// weeks-long move (US30 and US2000 closed 09-09 18:39 SGT; GER40 −2.66 %).
// The owner's first principle for the book, 07-09-2026: "HORIZON IS THE
// DESIGN VARIABLE… book decisions on the daily close only (trail, entries,
// exits), not per-minute."
//
// What moved: the RANK EXIT (the ranking's opinion), including the flip-exit
// leg — once per UTC day, never under bookMinHoldHours.
// What did NOT move: the stop at the broker, the retry of an exit the broker
// REFUSED, the sweep for an exit decided on a previous day, and every guard
// that is not a rank exit.
// ---------------------------------------------------------------------------

const T = (iso) => Date.parse(iso)
const DAILY = { enabled: true }   // the ordered defaults: 'daily' + 24 h
const armOne = (db) => { setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState }) }
const one = [{ accountId: DEMO, isLive: false }]

test('PR-K config: the ordered defaults, and nonsense falls back to them (never to every_pass, never to a 0 hold)', () => {
  const d = momentumBookConfig({ enabled: true })
  assert.equal(d.bookExitCadence, 'daily', 'the ordered behaviour is the default')
  assert.equal(d.bookMinHoldHours, 24)
  assert.equal(momentumBookConfig({ bookExitCadence: 'hourly' }).bookExitCadence, 'daily', 'anything not the literal every_pass is daily')
  assert.equal(momentumBookConfig({ bookExitCadence: 'every_pass' }).bookExitCadence, 'every_pass')
  assert.equal(momentumBookConfig({ bookMinHoldHours: 'soon' }).bookMinHoldHours, 24, 'nonsense is the default, not 0')
  // CHECKER MAJOR (16-09-2026): Number(null), Number(''), Number(false) and
  // Number([]) are all 0 AND finite, so a clamp that tests Number.isFinite
  // reads a CLEARED UI FIELD as "no minimum hold at all" — the knob switched
  // off by a blank box, while the comment above it claims the opposite.
  for (const blank of [null, '', '   ', false, [], {}, undefined, NaN]) {
    assert.equal(momentumBookConfig({ bookMinHoldHours: blank }).bookMinHoldHours, 24, `${JSON.stringify(blank) ?? String(blank)} must not disable the hold`)
  }
  assert.equal(momentumBookConfig({ bookMinHoldHours: '36' }).bookMinHoldHours, 36, 'a numeric string is a number')
  assert.equal(momentumBookConfig({ bookMinHoldHours: 0 }).bookMinHoldHours, 0, '0 is a real setting: the daily cadence without the hold')
  assert.equal(momentumBookConfig({ bookMinHoldHours: 9999 }).bookMinHoldHours, 168, 'the ceiling is 7 days — a typo must not freeze rank exits for a month')
  assert.equal(DEFAULT_MOMENTUM_BOOK.bookExitCadence, 'daily')
  assert.equal(DEFAULT_MOMENTUM_BOOK.bookMinHoldHours, 24)
})

test('PR-K: a row ranked out MID-DAY is not exited on that pass — and its stop is trailed on that very pass; the daily pass after 21:05Z exits it', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(DAILY))
  armOne(db)
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', at: '2026-09-08T09:00:00.000Z' })
  const f = fakes()
  await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-08T09:05:00Z') })
  const entered = db.prepare(`SELECT status, stop FROM momentum_book`).get()
  assert.equal(entered.status, 'open')
  // 10:00 UTC the next day: the ranking says the name left its band.
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit', at: '2026-09-09T10:00:00.000Z' })
  f.deps.bars = async () => f.bars.map(b => ({ ...b, h: b.h + 10, l: b.l + 10, c: b.c + 10 }))
  let r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-09T10:05:00Z') })
  assert.equal(r.exits, 0, `the opinion waits for the daily close: ${JSON.stringify(r.skipped)}`)
  assert.equal(f.calls.close.length, 0, 'nothing was closed intraday')
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'open')
  assert.equal(r.rankExitsDeferred, 1)
  assert.ok(r.skipped.some(s => /BTCUSD: rank exit held — cadence daily: rank exits are decided once per UTC day after 21:05Z/.test(s)), JSON.stringify(r.skipped))
  // THE STOP IS NOT DEFERRED WITH THE OPINION: it moved on this same pass.
  assert.equal(r.trailed, 1, 'the stop is maintained on the pass that defers the rank exit')
  assert.equal(f.calls.amend.length, 1)
  assert.ok(db.prepare(`SELECT stop FROM momentum_book`).get().stop > entered.stop, 'the broker holds a tighter stop while the row is carried')
  // A later intraday pass must not re-admit the deferred exit through the owed sweep.
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-09T15:00:00Z') })
  assert.equal(r.exits, 0, `the owed sweep does not smuggle today's opinion back in: ${JSON.stringify(r.skipped)}`)
  assert.equal(f.calls.close.length, 0)
  // The daily pass: it goes.
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-09T21:10:00Z') })
  assert.equal(r.exits, 1, JSON.stringify(r.skipped))
  assert.deepEqual(f.calls.close, [{ positionId: `pos-BTCUSD-${DEMO}`, volume: 1000 }])
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'exit_sent')
})

test('PR-K: a row younger than bookMinHoldHours is NOT rank-exited even on a daily pass; the next daily pass, once it is old enough, exits it', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(DAILY))
  armOne(db)
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', at: '2026-09-09T19:55:00.000Z' })
  const f = fakes()
  await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-09T20:00:00Z') })
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'open')
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit', at: '2026-09-09T21:06:00.000Z' })
  let r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-09T21:10:00Z') })
  assert.equal(r.exits, 0, `a 1 h old position is not rank-exited by a daily pass: ${JSON.stringify(r.skipped)}`)
  assert.equal(f.calls.close.length, 0)
  assert.ok(r.skipped.some(s => /BTCUSD: rank exit held — held 1\.2h < bookMinHoldHours 24 — reconsidered on the next daily pass/.test(s)), JSON.stringify(r.skipped))
  // Still refused on the following morning's passes (cadence AND hold).
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-10T09:00:00Z') })
  assert.equal(r.exits, 0)
  // The next daily pass: 25 h held, the opinion stands, it goes.
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-10T21:10:00Z') })
  assert.equal(r.exits, 1, JSON.stringify(r.skipped))
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'exit_sent')
})

test('PR-K: the min hold is measured from the OLDEST stamp — an adopted row does not get a fresh 24 h shield from the moment it was adopted', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(DAILY))
  armOne(db)
  // A tsmom_long trade that filled three days ago, adopted by the book today.
  const tid = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, label_strategy, strategy, account_id, origin, ctrader_position_id, volume, opened_at) VALUES ('BTCUSD','BUY','open',100,94,NULL,?,?,?,'bot_market_dispatch','pos-old',1,'2026-09-06 09:00:00')`)
    .run(TSMOM_STRATEGY, TSMOM_STRATEGY, DEMO).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, account_id, status, source) VALUES ('BTCUSD', ?, 'long', 100, 94, ?, 'active', 'autopilot')`).run(tid, DEMO)
  const f = fakes()
  const r0 = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-09T10:00:00Z') })
  assert.equal(r0.adopted, 1)
  assert.equal(db.prepare(`SELECT entered_at FROM momentum_book`).get().entered_at, '2026-09-09T10:00:00.000Z', 'the row is stamped at ADOPTION, not at the fill — 11 h before the daily pass below')
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit', at: '2026-09-09T10:30:00.000Z' })
  const r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-09T21:10:00Z') })
  assert.equal(r.exits, 1, `the trade has been held three days — the adoption stamp is not a new clock: ${JSON.stringify(r.skipped)}`)
})

test('PR-K: bookExitCadence "every_pass" restores the pre-PR-K behaviour EXACTLY — the same young row, ranked out mid-day, is closed on the next pass (the default is not)', async () => {
  const mk = (stored) => {
    const db = fresh()
    setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(stored))
    armOne(db)
    shadowRow(db, { symbol: 'BTCUSD', action: 'enter', at: '2026-09-09T09:55:00.000Z' })
    return db
  }
  // the ordered default: nothing goes
  const dbDefault = mk(DAILY)
  const fd = fakes()
  await runMomentumBook(dbDefault, { accounts: one, credsFor, deps: fd.deps, now: T('2026-09-09T10:00:00Z') })
  shadowRow(dbDefault, { symbol: 'BTCUSD', action: 'exit', at: '2026-09-09T11:00:00.000Z' })
  const rd = await runMomentumBook(dbDefault, { accounts: one, credsFor, deps: fd.deps, now: T('2026-09-09T11:05:00Z') })
  assert.equal(rd.exits, 0)
  assert.equal(fd.calls.close.length, 0)
  // the SAME sequence with the one stored value flipped: closed on the next pass, as before PR-K
  const dbEvery = mk(EVERY_PASS)
  const fe = fakes()
  await runMomentumBook(dbEvery, { accounts: one, credsFor, deps: fe.deps, now: T('2026-09-09T10:00:00Z') })
  shadowRow(dbEvery, { symbol: 'BTCUSD', action: 'exit', at: '2026-09-09T11:00:00.000Z' })
  const re = await runMomentumBook(dbEvery, { accounts: one, credsFor, deps: fe.deps, now: T('2026-09-09T11:05:00Z') })
  assert.equal(re.exits, 1, `every_pass is the revert switch — one stored value: ${JSON.stringify(re.skipped)}`)
  assert.equal(re.rankExitsDeferred, 0, 'neither the cadence nor the hold applies under every_pass')
  assert.deepEqual(fe.calls.close, [{ positionId: `pos-BTCUSD-${DEMO}`, volume: 1000 }])
  assert.equal(dbEvery.prepare(`SELECT status FROM momentum_book`).get().status, 'exit_sent')
})

test('PR-K: an exit the broker REFUSED still retries on EVERY pass, cadence or no cadence (09-09-2026, LLY.US)', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(DAILY))
  armOne(db)
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', at: '2026-09-08T09:00:00.000Z' })
  const f = fakes()
  let brokerVolume = null
  f.deps.positionVolume = async () => brokerVolume
  await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-08T09:05:00Z') })
  // The daily pass decides the exit; the broker refuses it.
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit', at: '2026-09-09T21:06:00.000Z' })
  let r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-09T21:10:00Z') })
  assert.equal(r.exits, 0)
  assert.equal(f.calls.close.length, 0)
  assert.match(db.prepare(`SELECT note FROM momentum_book`).get().note, /^exit_pending: unknown volume/)
  // MID-DAY, the next day, hours before any daily threshold: the owed close goes
  // the moment the broker can answer. An owed exit does not wait for 21:05.
  brokerVolume = 250
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-10T03:00:00Z') })
  assert.equal(r.exits, 1, `the retry is not a fresh opinion and is not gated: ${JSON.stringify(r.skipped)}`)
  assert.deepEqual(f.calls.close, [{ positionId: `pos-BTCUSD-${DEMO}`, volume: 250 }])
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'exit_sent')
})

test('PR-K: an exit decided on a PREVIOUS book day and never executed still fires on an ordinary mid-day pass (the owed sweep keeps working)', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(DAILY))
  armOne(db)
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', at: '2026-09-08T09:00:00.000Z' })
  const f = fakes()
  let closeOk = false
  f.deps.close = async (_c, args) => { if (!closeOk) throw new Error('old code: nothing sent'); f.calls.close.push(args); return {} }
  await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-08T09:05:00Z') })
  // The exit word is consumed by the daily pass; the close silently fails and
  // the flag is wiped, as the pre-#872 code left it.
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit', at: '2026-09-09T21:06:00.000Z' })
  let r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-09T21:10:00Z') })
  assert.equal(r.exits, 0)
  db.prepare(`UPDATE momentum_book SET note = 'rank entry'`).run()
  closeOk = true
  // 04:00 UTC two book days later — no daily threshold has passed on this
  // pass, but the DECISION is from a previous book day: it is owed, and it goes.
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-11T04:00:00Z') })
  assert.equal(r.exits, 1, `an exit decided yesterday is not re-deferred: ${JSON.stringify(r.skipped)}`)
  assert.deepEqual(f.calls.close, [{ positionId: `pos-BTCUSD-${DEMO}`, volume: 1000 }])
})

test('PR-K: a FLIP still exits and enters in ONE pass on the daily pass; deferred mid-day it does NEITHER, so the book never holds both sides or neither', async () => {
  const mk = () => {
    const db = fresh()
    setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(DAILY))
    armOne(db)
    return db
  }
  // (a) the daily pass: exit + enter together
  let db = mk()
  let f = fakes()
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'long', rank: 0.95, conviction: 9, at: '2026-09-08T09:00:00.000Z' })
  await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-08T09:05:00Z') })
  trendRow(db, 'NATGAS', 'short')
  shadowRow(db, { symbol: 'NATGAS', action: 'exit', side: 'long', rank: 0.3, at: '2026-09-09T21:06:00.000Z' })
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9, at: '2026-09-09T21:06:00.000Z' })
  let r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-09T21:10:00Z') })
  assert.equal(r.exits, 1, JSON.stringify(r.skipped))
  assert.equal(r.entries, 1, 'the flip is one pass: the long is out and the short is on, never both')
  assert.deepEqual(db.prepare(`SELECT side, status FROM momentum_book ORDER BY id`).all(), [{ side: 'long', status: 'exit_sent' }, { side: 'short', status: 'open' }])
  // (b) the same flip mid-day: neither leg runs
  db = mk()
  f = fakes()
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'long', rank: 0.95, conviction: 9, at: '2026-09-08T09:00:00.000Z' })
  await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-08T09:05:00Z') })
  trendRow(db, 'NATGAS', 'short')
  shadowRow(db, { symbol: 'NATGAS', action: 'exit', side: 'long', rank: 0.3, at: '2026-09-09T10:00:00.000Z' })
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9, at: '2026-09-09T10:00:00.000Z' })
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-09T10:05:00Z') })
  assert.equal(r.exits, 0)
  assert.equal(r.entries, 0, 'the flip ENTRY waits with its exit — the book is never left holding both sides')
  assert.ok(r.skipped.some(s => /NATGAS: flip entry waits for its flip exit \(rank-exit cadence daily\)/.test(s)), JSON.stringify(r.skipped))
  assert.deepEqual(db.prepare(`SELECT side, status FROM momentum_book ORDER BY id`).all(), [{ side: 'long', status: 'open' }], 'one row, one side, still stopped at the broker')
  // and on the evening pass the flip completes in ONE pass — the exit AND the
  // entry the deferral held back. The shadow's `enter` row was consumed by the
  // cursor on the deferring pass, so this only works because the book
  // remembered the flip (checker MINOR, 16-09-2026); note this database has NO
  // shadow holdings at all, so the reconcile path cannot supply it.
  assert.deepEqual(JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).pendingFlips[`${DEMO}|NATGAS`].side, 'short')
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-09T21:10:00Z') })
  assert.equal(r.exits, 1, JSON.stringify(r.skipped))
  assert.equal(r.entries, 1, 'the other side of the flip is entered on the same pass as its exit')
  assert.deepEqual(db.prepare(`SELECT side, status, note FROM momentum_book ORDER BY id`).all(), [
    { side: 'long', status: 'exit_sent', note: 'rank exit (flip)' },
    { side: 'short', status: 'open', note: 'flip entry short after the deferred flip exit' },
  ])
  assert.equal(f.calls.autoTrade[f.calls.autoTrade.length - 1].synth.consensus_bias, 'short')
  assert.deepEqual(JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).pendingFlips, {}, 'the record is dropped once acted on')
  // (c) a remembered flip is not carried forever: past its TTL it expires unacted.
  const db3 = mk()
  const f3 = fakes()
  shadowRow(db3, { symbol: 'NATGAS', action: 'enter', side: 'long', rank: 0.95, conviction: 9, at: '2026-09-08T09:00:00.000Z' })
  await runMomentumBook(db3, { accounts: one, credsFor, deps: f3.deps, now: T('2026-09-08T09:05:00Z') })
  trendRow(db3, 'NATGAS', 'short')
  shadowRow(db3, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9, at: '2026-09-09T10:00:00.000Z' })
  await runMomentumBook(db3, { accounts: one, credsFor, deps: f3.deps, now: T('2026-09-09T10:05:00Z') })
  assert.ok(JSON.parse(getState(db3, MOMENTUM_BOOK_STATE_KEY)).pendingFlips[`${DEMO}|NATGAS`], 'remembered')
  db3.prepare(`UPDATE momentum_book SET status = 'exit_sent' WHERE side = 'long'`).run()
  const late = await runMomentumBook(db3, { accounts: one, credsFor, deps: f3.deps, now: T('2026-09-09T10:05:00Z') + PENDING_FLIP_TTL_MS + 1 })
  assert.equal(late.entries, 0, 'a ranking opinion from days ago does not open a position today')
  assert.ok(late.skipped.some(s => /deferred flip entry expired/.test(s)), JSON.stringify(late.skipped))
  assert.deepEqual(JSON.parse(getState(db3, MOMENTUM_BOOK_STATE_KEY)).pendingFlips, {})
})

test('PR-K: the day cursor is PER ACCOUNT — one account\'s daily pass does not consume another\'s', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(DAILY))
  const io = { getState, setState }
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, io)
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: LIVE }, io)
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', at: '2026-09-08T09:00:00.000Z' })
  const f = fakes()
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: T('2026-09-08T09:05:00Z') })
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM momentum_book WHERE status = 'open'`).get().n, 2, 'both accounts hold the name')
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit', at: '2026-09-09T21:06:00.000Z' })
  // Only DEMO is passed this cycle: its day is spent, LIVE's is not.
  let r = await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: T('2026-09-09T21:10:00Z') })
  assert.equal(r.exits, 1)
  const cursor = JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).rankExitAt
  assert.deepEqual(Object.keys(cursor), [DEMO], `one cursor entry per account: ${JSON.stringify(cursor)}`)
  // Ten minutes later, both accounts: LIVE's daily pass runs, DEMO's does not repeat.
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: T('2026-09-09T21:20:00Z') })
  assert.equal(r.exits, 1, `LIVE was never gated by DEMO's stamp: ${JSON.stringify(r.skipped)}`)
  assert.deepEqual(f.calls.close.map(c => c.positionId), [`pos-BTCUSD-${DEMO}`, `pos-BTCUSD-${LIVE}`])
  assert.deepEqual(Object.keys(JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).rankExitAt).sort(), [DEMO, LIVE].sort())
  // A third pass the same day: neither account re-runs its opinion.
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: T('2026-09-09T21:30:00Z') })
  assert.equal(r.exits, 0)
  assert.equal(f.calls.close.length, 2)
})

test('PR-K wiring pin: the revert switch is written by POST /actions/momentum-book, MERGED FROM STORED (comments stripped)', () => {
  const src = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const at = src.indexOf("router.post('/momentum-book'")
  assert.ok(at > 0, 'the route exists')
  const block = src.slice(at, at + 1200)
  assert.match(block, /const merged = \{ \.\.\.loadMomentumBook\(db\) \}/, 'the patch starts from what is STORED, never from the defaults (failure mode #5)')
  assert.match(block, /'bookExitCadence', 'bookMinHoldHours'/, 'both PR-K knobs are writable from the running system')
  assert.match(block, /res\.json\(\{ ok: true, effective: cfg \}\)/, 'the reply is the effective policy')
})

// ---------------------------------------------------------------------------
// THE ARM GATE'S REFUSAL IS RECORDED (16-09-2026). Measured in production:
// `momentum book: 0 entered, 0 exited, 0 trailed on 1 account(s)` with no
// suffix, because the `!armed` branch dropped six of seven enabled accounts
// with an empty `skipped`. These cases pin that every drop carries a reason,
// that a THROWN arm check reads differently from a deliberate "not armed",
// and that an armed account is untouched.

/**
 * `db` whose arm check FAILS for every account after the first `survive` of
 * them. The injection point is real: `armedTradeKeys` → `enabledStrategies`
 * reads `cup_handle_enabled` from agent_state OUTSIDE any try (strategies.js),
 * so a state read that throws there propagates out of the arm check exactly as
 * a disk or corruption failure would. Nothing else is touched: every other
 * statement passes straight through.
 *
 * If that read ever becomes guarded, these cases go RED rather than quietly
 * proving nothing — the counts below are only reachable if the throw landed.
 */
function dbWithArmCheckThrowingAfter(db, survive) {
  let seen = 0
  const wrapStmt = (stmt) => new Proxy(stmt, {
    get(s, prop) {
      const v = s[prop]
      if (typeof v !== 'function') return v
      return (...args) => {
        if (args.some(a => a === 'cup_handle_enabled') && ++seen > survive) {
          throw new Error('agent_state read failed (disk I/O error)')
        }
        return v.apply(s, args)
      }
    },
  })
  return new Proxy(db, {
    get(t, prop) {
      if (prop === 'prepare') return (sql) => wrapStmt(t.prepare(sql))
      const v = Reflect.get(t, prop)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}

test('an account the strategy is not armed for is recorded in skipped by name and cause, and the armed account runs exactly as before', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps })
  // The refusal is READ, not inferred: the account and the cause are both named.
  const line = r.skipped.find(s => s.startsWith(`${LIVE}:`))
  assert.ok(line, `LIVE's drop is recorded: ${JSON.stringify(r.skipped)}`)
  assert.match(line, new RegExp(`^${LIVE}: ${TSMOM_STRATEGY} not armed$`))
  assert.equal(r.notArmed, 1)
  assert.equal(r.armCheckFailed, 0, 'nothing threw — a configuration choice is not an error')
  // UNCHANGED for the armed account: one dispatch, one entry, one book row.
  assert.equal(r.accounts, 1)
  assert.equal(r.entries, 1)
  assert.deepEqual(f.calls.autoTrade.map(c => String(c.acct.accountId)), [DEMO], 'only the armed account traded')
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM momentum_book WHERE account_id = ?`).get(DEMO).n, 1)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM momentum_book WHERE account_id = ?`).get(LIVE).n, 0)
})

test('an arm check that THROWS is reported as an error, distinguishable from a deliberate "not armed"', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  const r = await runMomentumBook(dbWithArmCheckThrowingAfter(db, 1), { accounts, credsFor, deps: f.deps })
  const line = r.skipped.find(s => s.startsWith(`${LIVE}:`))
  assert.ok(line, `the throw is recorded: ${JSON.stringify(r.skipped)}`)
  assert.match(line, /arm check failed/, 'the cause is the failure, not the configuration')
  assert.match(line, /disk I\/O error/, "the thrown error's own message survives")
  assert.doesNotMatch(line, /not armed$/, 'a thrown error must NOT read as a configuration choice')
  assert.equal(r.armCheckFailed, 1)
  assert.equal(r.notArmed, 0, 'a throw is not counted as an unarmed account')
  // Behaviour is unchanged: the account is still dropped, the armed one still runs.
  assert.equal(r.accounts, 1)
  assert.equal(r.entries, 1)
  assert.deepEqual(f.calls.autoTrade.map(c => String(c.acct.accountId)), [DEMO])
})

test('considered-vs-ran is counted across a mix of armed, unarmed and throwing accounts, and leads the skipped list the loop prints', async () => {
  const THIRD = '333'
  const db = fresh()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${THIRD}','3',0,1,'active')`).run()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const three = [...accounts, { accountId: THIRD, isLive: false }]
  const f = fakes()
  const r = await runMomentumBook(dbWithArmCheckThrowingAfter(db, 2), { accounts: three, credsFor, deps: f.deps })
  assert.equal(r.considered, 3, 'every account handed in was considered')
  assert.equal(r.accounts, 1, 'the pass ran on one — the meaning of `accounts` is unchanged')
  assert.equal(r.notArmed, 1)
  assert.equal(r.armCheckFailed, 1)
  // The count must survive `mb.skipped.slice(0, 4)` in the loop, so it leads.
  assert.match(r.skipped[0], /^considered 3 account\(s\), ran on 1 — 1 not armed for tsmom_long, 1 arm check failed$/)
  assert.ok(r.skipped.slice(0, 4).some(s => /considered 3/.test(s)), 'the loop prints at most four; the count is inside them')
  // A pass that drops nobody keeps its log line unchanged — no roll-up.
  const dbAll = fresh()
  setState(dbAll, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  for (const id of [DEMO, LIVE]) setStage(dbAll, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: id }, { getState, setState })
  const g = fakes()
  const rAll = await runMomentumBook(dbAll, { accounts, credsFor, deps: g.deps })
  assert.equal(rAll.considered, 2)
  assert.equal(rAll.accounts, 2)
  assert.equal(rAll.notArmed + rAll.armCheckFailed, 0)
  assert.ok(!rAll.skipped.some(s => /^considered /.test(s)), 'nothing dropped → no roll-up line')
})

// ---------------------------------------------------------------------------
// PR-P (16-09-2026): the PER-ACCOUNT ENTRY BRAKE, wired.
//
// The arithmetic is pinned in book-open-drawdown.test.js. What is pinned here
// is that something CALLS it — on both entry paths — and that nothing on the
// EXIT side does. A repair nothing calls is dead (CLAUDE.md), and a brake that
// slowed an exit would be worse than no brake at all.
// ---------------------------------------------------------------------------

/** Two open, marked-at-their-stops book rows on `account`, with a real trade and plan behind each. */
function bleedingBook(db, account, { symbols = ['BTCUSD', 'NATGAS'], entry = 100, risk = 10, mark = 90, at = Date.now() } = {}) {
  const marks = {}
  for (const symbol of symbols) {
    const t = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at) VALUES (?,'BUY','open',?,?,?,?,?,?,'bot_market_dispatch',?, datetime('now','-5 days'))`)
      .run(symbol, entry, entry - risk, entry + 2 * risk, TSMOM_STRATEGY, TSMOM_STRATEGY, account, `pos-${symbol}-${account}`).lastInsertRowid
    db.prepare(`INSERT INTO monitored_positions (trade_id, symbol, side, entry_price, current_sl, current_tp, account_id, status, source) VALUES (?,?,'long',?,?,?,?, 'active','autopilot')`)
      .run(t, symbol, entry, entry - risk, entry + 2 * risk, account)
    db.prepare(`INSERT INTO trade_plans (trade_id, account_id, symbol, side, risk_dist) VALUES (?,?,?,'long',?)`).run(t, account, symbol, risk)
    db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entered_at, status) VALUES (?,?,?,?, 'long', ?, ?, 2, datetime('now','-5 days'), 'open')`)
      .run(t, account, symbol, `pos-${symbol}-${account}`, entry, entry - risk)
    marks[`${account}|${symbol}`] = { c: mark, at }
  }
  return marks
}

test('PR-P row-cursor path: a bleeding account takes NO new book entry, by name and reason — and its rank EXIT still goes', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  // Two rows at their stops on DEMO → 100% of the risk put up, over the
  // default 50% limit and the default 2-row minimum.
  const marks = bleedingBook(db, DEMO)
  setState(db, MOMENTUM_BOOK_STATE_KEY, JSON.stringify({ lastShadowRowId: 0, lastRunMs: 0, reconciledAt: {}, rankExitAt: {}, pendingFlips: {}, marks }))
  // One fresh name to enter, and one open name the ranking wants OUT of.
  shadowRow(db, { symbol: 'XAUUSD', action: 'enter' })
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit' })
  const f = fakes()
  const r = await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: { ...f.deps, symbolMap: { BTCUSD: 1, NATGAS: 2, XAUUSD: 3 } } })
  // ENTRIES: refused, once, with a reason an operator reads.
  assert.equal(r.entries, 0, 'no new exposure on a bleeding account')
  assert.equal(f.calls.autoTrade.length, 0)
  assert.equal(r.entriesBraked, 1)
  const line = r.skipped.find(s => s.startsWith(`${DEMO}: open book drawdown`))
  assert.ok(line, `the refusal is named: ${JSON.stringify(r.skipped)}`)
  assert.match(line, /100% of the risk put up \(>= 50%\) across 2 of 2 carried row\(s\), coverage 100%/)
  assert.equal(r.skipped.filter(s => /open book drawdown/.test(s)).length, 1, 'one line per braked account, not one per symbol')
  // EXITS: completely untouched. The ranking's exit on BTCUSD went to the broker.
  assert.equal(r.exits, 1, 'the brake is on ENTRIES only')
  assert.deepEqual(f.calls.close.map(c => c.positionId), [`pos-BTCUSD-${DEMO}`])
  assert.equal(db.prepare(`SELECT status FROM momentum_book WHERE symbol = 'BTCUSD'`).get().status, 'exit_sent')
  // And the trail still ran on both rows — a stop is protection, not an opinion.
  assert.ok(r.trailed >= 1, `the stop kept being maintained: trailed ${r.trailed}`)
})

test('PR-P: the same book with the brake OFF enters — so the refusal above was the brake and not some other gate', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ ...EVERY_PASS, bookDrawdownOn: false }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  const marks = bleedingBook(db, DEMO)
  setState(db, MOMENTUM_BOOK_STATE_KEY, JSON.stringify({ lastShadowRowId: 0, lastRunMs: 0, reconciledAt: {}, rankExitAt: {}, pendingFlips: {}, marks }))
  shadowRow(db, { symbol: 'XAUUSD', action: 'enter' })
  const f = fakes()
  const r = await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: { ...f.deps, symbolMap: { BTCUSD: 1, NATGAS: 2, XAUUSD: 3 } } })
  assert.equal(r.entries, 1, 'with the brake off the identical book takes the entry')
  assert.equal(r.entriesBraked, undefined)
})

test('PR-P: THE INPUT ARRIVES — the trail pass writes the mark the brake reads, and drops it when the row closes', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  const one = [{ accountId: DEMO, isLive: false }]
  await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 1_000 })
  const after = JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY))
  const key = `${DEMO}|BTCUSD`
  // The mark is the SAME bar close the trail prices its stop from — one price,
  // not a second feed that can drift from the first.
  assert.equal(after.marks[key].c, f.bars[f.bars.length - 1].c, 'the trail pass wrote the mark')
  assert.equal(after.marks[key].at, 1_000, 'stamped, so staleness is a fact and not a guess')
  // A closed row's mark is dropped: a position that is gone must never keep
  // weighing on the account's reading.
  db.prepare(`UPDATE momentum_book SET status = 'closed' WHERE symbol = 'BTCUSD'`).run()
  await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 2_000 })
  assert.deepEqual(JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).marks, {}, 'closed rows leave no mark behind')
})

test('PR-P: a row the broker could not be reached for KEEPS its last mark — an outage must not read as "no price"', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  const one = [{ accountId: DEMO, isLive: false }]
  await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 1_000 })
  const first = JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).marks[`${DEMO}|BTCUSD`]
  assert.ok(first?.c > 0)
  // Next pass: bars throw. The row is still open, so its mark stands.
  await runMomentumBook(db, { accounts: one, credsFor, deps: { ...f.deps, bars: async () => { throw new Error('broker unreachable') } }, now: 2_000 })
  assert.deepEqual(JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).marks[`${DEMO}|BTCUSD`], first)
})

test('PR-P: the report shows the number measured NEXT TO the number it is compared with, per account', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  const marks = bleedingBook(db, DEMO)
  setState(db, MOMENTUM_BOOK_STATE_KEY, JSON.stringify({ lastShadowRowId: 0, lastRunMs: 0, reconciledAt: {}, rankExitAt: {}, pendingFlips: {}, marks }))
  const rep = momentumBookReport(db)
  const cell = rep.entryBrake.accounts[`…${DEMO.slice(-4)}`]
  assert.equal(cell.blocking, true)
  assert.equal(cell.drawdownPct, 100)
  assert.equal(cell.limitPct, 50, 'the limit is printed beside the reading, not left to be looked up')
  assert.equal(cell.measured, 2)
  assert.equal(cell.rows, 2)
  assert.equal(rep.config.bookDrawdownPct, 50)
})

test('PR-P MAJOR 2: a price fetch that fails on every pass does NOT quietly retire the brake — it blocks and says so, every pass', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  const T0 = Date.UTC(2026, 8, 16, 12, 0)
  const marks = bleedingBook(db, DEMO, { at: T0 })
  setState(db, MOMENTUM_BOOK_STATE_KEY, JSON.stringify({ lastShadowRowId: 0, lastRunMs: 0, reconciledAt: {}, rankExitAt: {}, pendingFlips: {}, marks }))
  shadowRow(db, { symbol: 'XAUUSD', action: 'enter' })
  const one = [{ accountId: DEMO, isLive: false }]
  const dead = { symbolMap: { BTCUSD: 1, NATGAS: 2, XAUUSD: 3 }, bars: async () => { throw new Error('broker unreachable') },
    spot: async () => null, amend: async () => ({}), close: async () => ({}), positionVolume: async () => 1000,
    phasesOn: () => true, mayTrade: () => ({ ok: true, item: null }), autoTrade: async () => null }
  // Marks still fresh: blocked on drawdown.
  let r = await runMomentumBook(db, { accounts: one, credsFor, deps: dead, now: T0 })
  assert.equal(r.entriesBraked, 1)
  assert.ok(r.skipped.some(s => /open book drawdown/.test(s)))
  // The marks were carried forward, not lost, by the failing trail pass.
  assert.equal(Object.keys(JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).marks).length, 2)
  // 192 h later every fetch has still failed, so the marks are past the TTL.
  // The first draft went from blocking to OPEN here, with no log line and no
  // summary entry — the closed-trade brakes cannot cover that gap by
  // construction, so this is the whole guard silently retiring itself.
  const later = T0 + 192 * 3_600_000
  r = await runMomentumBook(db, { accounts: one, credsFor, deps: dead, now: later })
  assert.equal(r.entriesBraked, 1, 'still braked when it goes blind')
  assert.equal(r.entries, 0)
  const unreadable = r.skipped.find(s => /open book UNREADABLE/.test(s))
  assert.ok(unreadable, `the blindness is named: ${JSON.stringify(r.skipped)}`)
  assert.match(unreadable, /2 of 2 carried row\(s\) unread, coverage 0%/)
  assert.match(unreadable, /2× stale — bars unavailable: broker unreachable/, 'the CAUSE travels end to end, from the trail pass to the log line')
  assert.match(unreadable, /oldest stale price 192 h/)
  assert.ok(r.skipped.some(s => /row\(s\) unread/.test(s)), 'and a notice line names the coverage every pass')
  assert.match(r.skipped[0], /^entry brake: 1 of 1 account\(s\) taking no new book entries/, 'the roll-up survives skipped.slice(0, 4)')
})

test('PR-P: unread rows are named even when the brake lets the entry through', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true, bookDrawdownMinCoveragePct: 0 }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  // Two rows, one marked well above entry, one never marked at all.
  const marks = bleedingBook(db, DEMO, { mark: 130 })
  delete marks[`${DEMO}|NATGAS`]
  setState(db, MOMENTUM_BOOK_STATE_KEY, JSON.stringify({ lastShadowRowId: 0, lastRunMs: 0, reconciledAt: {}, rankExitAt: {}, pendingFlips: {}, marks }))
  shadowRow(db, { symbol: 'XAUUSD', action: 'enter' })
  const f = fakes()
  const r = await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: { ...f.deps, symbolMap: { BTCUSD: 1, NATGAS: 2, XAUUSD: 3 } } })
  assert.equal(r.entriesBraked, undefined, 'not blocked — coverage judging is off and the readable row is in profit')
  assert.equal(r.entries, 1)
  const notice = r.skipped.find(s => /row\(s\) unread/.test(s))
  assert.ok(notice, `the blind spot is named anyway: ${JSON.stringify(r.skipped)}`)
  assert.match(notice, /1 of 2 carried row\(s\) unread, coverage 50%/)
  assert.match(notice, /1× never marked/, 'the cause, not just the count')
  assert.ok(!r.skipped.some(s => /^entry brake: /.test(s)), 'nothing braked → no roll-up')
})

test('PR-P MINOR 3: the mark carries the BAR\'s own epoch when the feed supplies one', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  // Real trendbars carry `t` in epoch ms (ctrader-ws.js: utcTimestampInMinutes × 60000).
  const barOpen = Date.UTC(2026, 8, 16, 0, 0)
  const realBars = f.bars.map((b, i) => ({ ...b, t: barOpen - (f.bars.length - 1 - i) * 86_400_000 }))
  const one = [{ accountId: DEMO, isLive: false }]
  await runMomentumBook(db, { accounts: one, credsFor, deps: { ...f.deps, bars: async () => realBars }, now: 1_000 })
  const m = JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).marks[`${DEMO}|BTCUSD`]
  assert.equal(m.bt, barOpen, 'the bar\'s own stamp, so a frozen feed cannot pass as fresh')
  assert.equal(m.at, 1_000, 'and the fetch clock alongside it')
  // The fixture's index-style `t` is NOT a plausible epoch and must not be
  // written as one — it would read as 1970 and mark every row stale forever.
  const db2 = fresh()
  setState(db2, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db2, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db2, { symbol: 'BTCUSD', action: 'enter' })
  const g = fakes()
  await runMomentumBook(db2, { accounts: one, credsFor, deps: g.deps, now: 1_000 })
  assert.equal(JSON.parse(getState(db2, MOMENTUM_BOOK_STATE_KEY)).marks[`${DEMO}|BTCUSD`].bt, undefined)
})

test('PR-P MAJOR 1: the book rank-exits a bleeding account and the brake DOES NOT go quiet on the next pass', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  // Stamped on the TEST clock, not the wall clock: this case drives `now`
  // explicitly, and a mark stamped decades ahead of `now` is correctly not a
  // reading any more (checker MINOR 4).
  const marks = bleedingBook(db, DEMO, { at: 0 })
  setState(db, MOMENTUM_BOOK_STATE_KEY, JSON.stringify({ lastShadowRowId: 0, lastRunMs: 0, reconciledAt: {}, rankExitAt: {}, pendingFlips: {}, marks }))
  // The ranking wants OUT of both names, and offers a fresh one.
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit' })
  shadowRow(db, { symbol: 'NATGAS', action: 'exit' })
  const f = fakes()
  const one = [{ accountId: DEMO, isLive: false }]
  const deps = { ...f.deps, symbolMap: { BTCUSD: 1, NATGAS: 2, XAUUSD: 3 } }
  let r = await runMomentumBook(db, { accounts: one, credsFor, deps, now: 1_000 })
  assert.equal(r.exits, 2, 'both exits were SENT')
  assert.equal(r.entriesBraked, 1)
  assert.deepEqual(db.prepare(`SELECT DISTINCT status FROM momentum_book`).all().map(x => x.status), ['exit_sent'],
    'sent, not confirmed — the rows are still carried')
  // NEXT PASS. Reading `status = 'open'` alone gave `rows: 0`, which took the
  // "nothing to be blind about" carve-out: block false, reason null, notice
  // null — no line anywhere — at the exact moment the book had just decided
  // this account's positions were bad.
  shadowRow(db, { symbol: 'XAUUSD', action: 'enter' })
  r = await runMomentumBook(db, { accounts: one, credsFor, deps, now: 2_000 })
  assert.equal(r.entriesBraked, 1, 'still braked while the closes are in flight')
  assert.equal(r.entries, 0)
  assert.equal(f.calls.autoTrade.length, 0)
  const line = r.skipped.find(s => /open book drawdown/.test(s))
  assert.ok(line, `and it still says why: ${JSON.stringify(r.skipped)}`)
  assert.match(line, /across 2 of 2 carried row\(s\)/)
  // The marks survived for rows the trail pass no longer walks (it selects
  // `open` only, and must keep doing so — trailing an exited row is exit
  // behaviour).
  assert.equal(Object.keys(JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).marks).length, 2)
  // A CONFIRMED close drops out: the trade closes, the row becomes 'closed',
  // the mark goes with it and the account is judged on what is left.
  db.prepare(`UPDATE trades SET status = 'closed' WHERE account_id = ?`).run(DEMO)
  r = await runMomentumBook(db, { accounts: one, credsFor, deps, now: 3_000 })
  assert.equal(r.entriesBraked, undefined, 'nothing carried, nothing to brake')
  assert.deepEqual(JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).marks, {}, 'a confirmed close leaves no mark behind')
})

test('PR-P MAJOR 2: a symbol the trail cannot resolve is named as the cause, not counted as a bare "unmarked"', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  bleedingBook(db, DEMO)
  const f = fakes()
  // NATGAS does not resolve on this account. The trail's `continue` used to
  // be completely silent, so the operator saw "1 unmarked" and had no way to
  // tell a permanent mapping fault from a one-pass broker outage.
  const deps = { ...f.deps, symbolMap: { BTCUSD: 1 } }
  const one = [{ accountId: DEMO, isLive: false }]
  await runMomentumBook(db, { accounts: one, credsFor, deps, now: 1_000 })
  const st = JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY))
  assert.equal(st.markFail[`${DEMO}|NATGAS`], 'symbol does not resolve on this account')
  const r = await runMomentumBook(db, { accounts: one, credsFor, deps, now: 2_000 })
  const line = r.skipped.find(s => /carried row\(s\) unread/.test(s))
  assert.ok(line, `the cause reaches the log: ${JSON.stringify(r.skipped)}`)
  assert.match(line, /1× symbol does not resolve on this account/)
})

test('PR-P: the roll-up counts accounts the pass RAN on, not accounts handed in', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  // DEMO is armed and bleeding; LIVE is handed in but never armed, so the
  // brake is never consulted for it. Counting it in the denominator makes the
  // ratio read better than it is — "1 of 2" when every account that actually
  // ran is braked (checker MINOR 2).
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  const marks = bleedingBook(db, DEMO)
  setState(db, MOMENTUM_BOOK_STATE_KEY, JSON.stringify({ lastShadowRowId: 0, lastRunMs: 0, reconciledAt: {}, rankExitAt: {}, pendingFlips: {}, marks }))
  shadowRow(db, { symbol: 'XAUUSD', action: 'enter' })
  const f = fakes()
  const r = await runMomentumBook(db, { accounts, credsFor, deps: { ...f.deps, symbolMap: { BTCUSD: 1, NATGAS: 2, XAUUSD: 3 } } })
  assert.equal(r.considered, 2)
  assert.equal(r.accounts, 1, 'only one account ran')
  assert.equal(r.entriesBraked, 1)
  const roll = r.skipped.find(s => /^entry brake: /.test(s))
  assert.match(roll, /^entry brake: 1 of 1 account\(s\) taking no new book entries/, 'denominator is the accounts that RAN')
  assert.doesNotMatch(roll, /1 of 2/, 'not the accounts handed in')
})

test('PR-P: a row the TRAIL closes (its trade went away while the row was open) drops its mark in the same pass', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  const one = [{ accountId: DEMO, isLive: false }]
  await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 1_000 })
  assert.ok(JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).marks[`${DEMO}|BTCUSD`])
  // The reconciler closes the trade. The row is still 'open', so the trail
  // pass is what notices and flips it — and the mark must go with it, or a
  // position that no longer exists keeps weighing on the account's reading.
  db.prepare(`UPDATE trades SET status = 'closed' WHERE account_id = ?`).run(DEMO)
  await runMomentumBook(db, { accounts: one, credsFor, deps: f.deps, now: 2_000 })
  assert.equal(db.prepare(`SELECT status FROM momentum_book WHERE symbol = 'BTCUSD'`).get().status, 'closed')
  // The mark is gone because the CARRY predicate excludes any row whose trade
  // is closed — one rule, one place. (The first draft also deleted the mark
  // inside the trail's close branch; that line was unreachable for exactly
  // this reason and was removed rather than left as decoration.)
  assert.deepEqual(JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).marks, {}, 'a closed trade leaves no mark behind')
})

// ---------------------------------------------------------------------------
// PR-AV — the trail says what it decided, on every pass.
//
// THE MEASURED DEFECT (18-09-2026, /state/momentum-book): five of 36 open book
// rows carried `atr: null`, two of them open since 07-09. The stored `atr` was
// written in exactly ONE place — inside the `trailImproves` branch — so a row
// whose 3-ATR trail sat wider than its standing stop never wrote one. That is
// the correct outcome of a wide trail, and it read identically to a row the
// ratchet had never reached.
//
// Nothing traded wrong: the stored value was never an INPUT (the trail
// recomputes ATR from bars every pass, and `row.atr` was read only by the
// view). The cost was diagnostic, and this repo has a name for it — a panel
// that cannot tell a working guard from a dead one. The fix is that every
// branch which ends a row's pass records what it decided.
// ---------------------------------------------------------------------------

/** Enter one book row, then hand it back with the trail's record blanked. */
async function bookRowWithStop(stop, { fill = true } = {}) {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', rank: 0.95, conviction: 9 })
  const f = fakes({ fill })
  await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 1_000 })
  const row = db.prepare(`SELECT * FROM momentum_book ORDER BY id DESC LIMIT 1`).get()
  assert.ok(row, 'the fixture opened a book row')
  db.prepare(`UPDATE momentum_book SET stop = ?, atr = NULL, trail_checked_at = NULL, trail_note = NULL WHERE id = ?`).run(stop, row.id)
  db.prepare(`DELETE FROM momentum_shadow`).run()   // no further entries or exits
  return { db, f, id: row.id }
}
const trailRow = (db, id) => db.prepare(`SELECT atr, trail_checked_at, trail_note, stop FROM momentum_book WHERE id = ?`).get(id)

test('PR-AV THE MEASURED CASE: a trail that DECLINES still records that it ran', async () => {
  // ATR over the fixture bars is 2 and the last close is 102.9, so the 3-ATR
  // candidate is 96.9 — wider than a stop already standing at 99, which is
  // exactly the condition that used to leave no trace at all.
  const { db, f, id } = await bookRowWithStop(99)
  await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })

  const r = trailRow(db, id)
  assert.equal(r.stop, 99, 'the stop correctly did NOT move')
  assert.equal(f.calls.amend.length, 0, 'and nothing was sent to the broker')
  assert.equal(r.atr, 2, 'BUT the ATR it computed is now on the row — this is the whole fix')
  assert.ok(r.trail_checked_at, 'and when it ran')
  assert.match(r.trail_note, /declined/, 'and that it declined')
  assert.match(r.trail_note, /trail at 96\.9/,
    'naming the UNCLAMPED candidate — the ratchet\'s own output just equals the standing stop and says nothing')
  assert.match(r.trail_note, /standing stop 99/, 'and the stop that beat it')
})

test('PR-AV: a trail that MOVES records the move', async () => {
  const { db, f, id } = await bookRowWithStop(90)
  await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })

  const r = trailRow(db, id)
  assert.equal(r.stop, 96.9, 'the ratchet moved the stop up')
  assert.equal(f.calls.amend.length, 1, 'and amended at the broker')
  assert.equal(r.atr, 2)
  assert.ok(r.trail_checked_at)
  assert.match(r.trail_note, /trailed 90 -> 96\.9/)
})

test('PR-AV: thin bars leave a NULL atr — but a STAMP, so "no data" never reads like "never ran"', async () => {
  const { db, f, id } = await bookRowWithStop(99)
  f.deps.bars = async () => f.bars.slice(0, 5)   // fewer than atrPeriod + 1
  await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })

  const r = trailRow(db, id)
  assert.equal(r.atr, null, 'no ATR is computable from five bars, and none is invented')
  assert.ok(r.trail_checked_at, 'the stamp is the difference: the ratchet DID run')
  assert.match(r.trail_note, /no ATR/)
  assert.match(r.trail_note, /got 5/, 'and says how many bars it had — the operator\'s actual remedy')
})

test('PR-AV: a row the pass cannot reach says WHY, in the same field', async () => {
  const { db, f, id } = await bookRowWithStop(99)
  f.deps.bars = async () => { throw new Error('broker timeout') }
  await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })

  const r = trailRow(db, id)
  assert.ok(r.trail_checked_at)
  assert.match(r.trail_note, /not reached/)
  assert.match(r.trail_note, /broker timeout/,
    '"the broker was down for one pass" and "this symbol does not resolve" have different remedies and must not share a null')
})

test('PR-AV: an unresolvable symbol is named too, without ever calling for bars', async () => {
  const { db, f, id } = await bookRowWithStop(99)
  f.deps.symbolMap = {}                     // nothing resolves
  let barsCalled = 0
  f.deps.bars = async () => { barsCalled++; return f.bars }
  await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })

  const r = trailRow(db, id)
  assert.equal(barsCalled, 0)
  assert.match(r.trail_note, /symbol does not resolve/)
  assert.ok(r.trail_checked_at)
})

test('PR-AV: the view carries the trail\'s own account, so a null atr can be read correctly', async () => {
  const { db, f, id } = await bookRowWithStop(99)
  await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })

  const view = momentumBookReport(db)
  const o = view.open.find(x => x.symbol === 'BTCUSD')
  assert.ok(o, JSON.stringify(view.open))
  assert.ok(o.trailCheckedAt, 'the panel that reported the null now reports the stamp beside it')
  assert.match(o.trailNote, /declined/)
  assert.equal(trailRow(db, id).atr, 2)
})

// ---------------------------------------------------------------------------
// PR-AX — `exit_sent` is no longer a dead end.
//
// MEASURED 18-09-2026 from /state/momentum-book: 28 rows `open`, every one
// carrying a fresh trail stamp; 8 rows `exit_sent`, not one stamped, the
// oldest fifteen days old. The trail loop selected `status = 'open'`, so
// `exit_sent` rows were never walked — and since the ONLY branch that moves a
// row to `closed` lives inside that loop, a row that reached `exit_sent` could
// never be reclassified by the code whose job that is.
//
// The cost: the report counts `open` + `exit_sent`, so it presented 36 open
// book positions where 28 were open, and the gap only ever widened.
//
// A CLAIM I MADE AND THEN DISPROVED, kept because the disproof is the useful
// part. I argued an `exit_sent` row whose trade is still open would never be
// trailed again, and started by widening the trail loop to walk those rows.
// That turned PR-P MAJOR 1 red — walking them RE-PRICES them, replacing the
// carried marks the entry brake judges an account on — and that test states
// the rule outright: the trail "selects `open` only, and must keep doing so
// — trailing an exited row is exit behaviour".
//
// It is right, and the hole I imagined does not exist: a REFUSED exit leaves
// the row `open` with an `exit_pending` note and is retried every pass
// (momentum-book.js:617/680), so it keeps its trail. `exit_sent` means the
// broker ACCEPTED the close. So the fix is a narrow sweep, not a wider loop.
// ---------------------------------------------------------------------------

/** One book row, forced into a chosen status with the trail record blanked. */
async function bookRowInState(status, { closeTrade = false, stop = 99 } = {}) {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', rank: 0.95, conviction: 9 })
  const f = fakes()
  await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 1_000 })
  const row = db.prepare(`SELECT * FROM momentum_book ORDER BY id DESC LIMIT 1`).get()
  db.prepare(`UPDATE momentum_book SET status = ?, stop = ?, atr = NULL, trail_checked_at = NULL, trail_note = NULL WHERE id = ?`)
    .run(status, stop, row.id)
  if (closeTrade) db.prepare(`UPDATE trades SET status = 'closed' WHERE id = ?`).run(row.trade_id)
  db.prepare(`DELETE FROM momentum_shadow`).run()
  return { db, f, id: row.id, tradeId: row.trade_id }
}
const bookRow = (db, id) => db.prepare(`SELECT status, stop, atr, trail_checked_at, trail_note FROM momentum_book WHERE id = ?`).get(id)

test('PR-AX: an exit_sent row whose trade is still open is LEFT ALONE — not trailed, not reclassified', async () => {
  // The rule PR-P MAJOR 1 encodes, pinned from the other side: the close was
  // accepted and the row is on its way out, so the sweep does not touch it
  // and the trail does not walk it. A refused exit is a different row — it
  // stays `open` with an exit_pending note and keeps its trail.
  const { db, f, id } = await bookRowInState('exit_sent', { stop: 90 })
  const r = await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })

  const row = bookRow(db, id)
  assert.equal(row.status, 'exit_sent', 'still on its way out')
  assert.equal(row.stop, 90, 'the stop is NOT moved — trailing an exited row is exit behaviour')
  assert.equal(f.calls.amend.length, 0, 'and nothing is sent to the broker for it')
  assert.equal(r.reclassified, 0, 'its trade has not closed, so there is nothing to reclassify')
})

test('PR-AX: an exit_sent row whose trade HAS closed is reclassified, once', async () => {
  const { db, f, id } = await bookRowInState('exit_sent', { closeTrade: true })
  const r1 = await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })
  assert.equal(bookRow(db, id).status, 'closed', 'the dead end is gone')
  assert.equal(r1.reclassified, 1, 'and it is counted, because a silent repair cannot be told from the bug')
  assert.equal(f.calls.amend.length, 0, 'a closed position is never amended')

  // Second pass: the row is `closed`, so it is out of the walked set entirely.
  const r2 = await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 3_000 })
  assert.equal(r2.reclassified, 0, 'the count is a repair, not a heartbeat')
})

// PR-AZ — TERMINAL IS TWO STATES. Found by the Codex review on #946, after
// PR-AX had merged, and verified against reconciler.js:489 before acting.
//
// The reconciler de-duplicates trades sharing one broker position: the newest
// row is kept and the older ones are set to `rejected` — deliberately NOT
// `closed`, because a closed duplicate gets the same broker P&L stamped onto
// it by the backfill and one real loss then reads as several. Nothing
// relinks momentum_book.trade_id, so a book row pointing at a de-duplicated
// trade never matched the sweep's `= 'closed'` and sat in `exit_sent` for
// ever: the dead end PR-AX removes, reintroduced through a state its first
// version did not enumerate.
test('PR-AZ: a row whose trade was REJECTED as a duplicate is reclassified too', async () => {
  const { db, f, id, tradeId } = await bookRowInState('exit_sent')
  db.prepare(`UPDATE trades SET status = 'rejected' WHERE id = ?`).run(tradeId)
  const r = await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })
  const row = bookRow(db, id)
  assert.equal(row.status, 'closed', 'a de-duplicated trade is terminal, and its book row goes with it')
  assert.equal(r.reclassified, 1)
  assert.match(db.prepare('SELECT note FROM momentum_book WHERE id = ?').get(id).note, /trade rejected/,
    'and the note says WHICH terminal state retired it — "closed" would be a lie about a dedupe')
})

test('PR-AZ: an IN-FLIGHT trade status does NOT retire a live book row', async () => {
  // The first version of this case used a made-up status and could not exist:
  // db.js CHECKs trades.status against a closed vocabulary, so the insert
  // threw. The constraint is better evidence than the guess was — it names
  // the real list, and two of its members are in flight rather than terminal.
  // A `<> 'open'` predicate would retire a row mid-submission.
  for (const st of ['submitting', 'unconfirmed']) {
    const { db, f, id, tradeId } = await bookRowInState('exit_sent')
    db.prepare(`UPDATE trades SET status = ? WHERE id = ?`).run(st, tradeId)
    const r = await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })
    assert.equal(bookRow(db, id).status, 'exit_sent', `${st} is in flight, not terminal`)
    assert.equal(r.reclassified, 0)
  }
})

test('PR-AZ: a CANCELLED trade retires its book row — an order that never filled is not a position', async () => {
  const { db, f, id, tradeId } = await bookRowInState('exit_sent')
  db.prepare(`UPDATE trades SET status = 'cancelled' WHERE id = ?`).run(tradeId)
  const r = await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })
  assert.equal(bookRow(db, id).status, 'closed')
  assert.equal(r.reclassified, 1)
})

test('PR-AZ: the terminal set matches the schema\'s own vocabulary', () => {
  // The two must not drift: a status added to the CHECK and not considered
  // here silently becomes "in flight for ever" for a book row.
  const dbSrc = readFileSync(new URL('../db.js', import.meta.url), 'utf8')
  const m = dbSrc.match(/CHECK\(status IN \('open','closed','cancelled','rejected','submitting','unconfirmed'\)\)/)
  assert.ok(m, 'trades.status still carries the vocabulary this sweep was written against')
  const src = readFileSync(new URL('./momentum-book.js', import.meta.url), 'utf8')
  assert.match(src, /IN \('closed', 'rejected', 'cancelled'\)/,
    'and the sweep retires exactly the terminal three')
})

test('PR-AX: an OPEN row whose trade closed is still reclassified, and NOT counted', async () => {
  // The pre-existing path, unchanged. `reclassified` counts only rows that
  // were stranded in exit_sent — the thing that used to be unreachable.
  const { db, f, id } = await bookRowInState('open', { closeTrade: true })
  const r = await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })
  assert.equal(bookRow(db, id).status, 'closed')
  assert.equal(r.reclassified, 0, 'this row was never stranded, so it is not a repair')
})

test('PR-AX: a `closed` row is never walked — the loop does not resurrect finished rows', async () => {
  const { db, f, id } = await bookRowInState('closed', { stop: 90 })
  await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })
  const r = bookRow(db, id)
  assert.equal(r.stop, 90, 'untouched')
  assert.equal(r.trail_checked_at, null, 'and not even looked at')
  assert.equal(f.calls.amend.length, 0)
})

test('PR-AX: the trail STILL selects open alone — the sweep must not become a wider loop', async () => {
  // Pinned because the first version of this fix did exactly that and turned
  // PR-P MAJOR 1 red. The sweep and the trail are deliberately separate: one
  // advances a status, the other moves stops, and only the first may look at
  // an exited row.
  const src = readFileSync(new URL('./momentum-book.js', import.meta.url), 'utf8')
  const code = src.replace(/^\s*\/\/.*$/gm, '')
  assert.match(code, /WHERE b\.status = 'open'`\)\.all\(\)/,
    'the trail loop keeps its own predicate')
  assert.match(code, /FROM momentum_book WHERE status = 'exit_sent'/,
    'and the reclassification is its own query')
})


// ---------------------------------------------------------------------------
// B3 (18-09-2026): the trail loop's own blind spot. PR-AZ retired exit_sent
// rows on three terminal states; the branch that retires OPEN rows still read
// `= 'closed'`, so an open row whose trade was de-duplicated to `rejected` (or
// cancelled before a fill) was trailed as a live position for ever.
// ---------------------------------------------------------------------------

for (const st of ['rejected', 'cancelled']) {
  test(`B3: an OPEN book row whose trade is ${st} is retired by the trail loop, note says which state, and it is not trailed`, async () => {
    const { db, f, id, tradeId } = await bookRowInState('open')
    db.prepare(`UPDATE trades SET status = ? WHERE id = ?`).run(st, tradeId)
    const r = await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })
    const row = bookRow(db, id)
    assert.equal(row.status, 'closed', `${st} is terminal for a book row`)
    assert.match(db.prepare('SELECT note FROM momentum_book WHERE id = ?').get(id).note, new RegExp(`trade ${st}`))
    assert.equal(row.trail_checked_at, null, 'a retired row is not trailed')
    assert.equal(r.trailed, 0)
    assert.equal(f.calls.amend.length, 0, 'no stop amend for a position that does not exist')
  })
}

test('B3: an OPEN row whose trade is in flight (submitting / unconfirmed) is NOT retired', async () => {
  for (const st of ['submitting', 'unconfirmed']) {
    const { db, f, id, tradeId } = await bookRowInState('open')
    db.prepare(`UPDATE trades SET status = ? WHERE id = ?`).run(st, tradeId)
    await runMomentumBook(db, { accounts: [{ accountId: DEMO, isLive: false }], credsFor, deps: f.deps, now: 2_000 })
    assert.equal(bookRow(db, id).status, 'open', `${st} is in flight, not terminal`)
  }
})

test('Wave 1 (19-09-2026): the book\'s master switch boots from agent/config/momentum-book.json — only the named keys are patched, diff-by-value, idempotent; the checked-in file enables the book; index.js runs the seed', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { seedMomentumBookFromConfig, loadMomentumBook, MOMENTUM_BOOK_CONFIG_KEY } = await import('./momentum-book.js')
  const db = initDB(':memory:')
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: false, stopAtr: 4 }))
  const file = join(mkdtempSync(join(tmpdir(), 'mbook-')), 'momentum-book.json')
  writeFileSync(file, JSON.stringify({ enabled: true, bookMinHoldHours: 48 }))
  const lines = []
  const a = seedMomentumBookFromConfig(db, { file, log: (m) => lines.push(m) })
  assert.equal(a.error, null); assert.equal(a.applied, true)
  const cfg = loadMomentumBook(db)
  assert.equal(cfg.enabled, true); assert.equal(cfg.bookMinHoldHours, 48)
  assert.equal(cfg.stopAtr, 4, 'a stored key the file does not name is kept')
  assert.equal(seedMomentumBookFromConfig(db, { file }).applied, false, 'idempotent')
  assert.match(lines[0], /momentum book: enabled=true/)
  const shipped = JSON.parse(readFileSync(new URL('../config/momentum-book.json', import.meta.url), 'utf8'))
  assert.equal(shipped.enabled, true)
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(src, /seedMomentumBookFromConfig\(db, \{ log/)
})

test('Wave 2 (§K·8): linking an adopted tsmom_long fill to the book upgrades its origin from reconciler_adopted to bot_pending_fill (the book placed the resting limit) — an already-clean origin is left alone', () => {
  const db = initDB(':memory:')
  const src = readFileSync(new URL('./momentum-book.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(src, /UPDATE trades SET origin = 'bot_pending_fill', origin_source = 'book_link' WHERE id = \? AND \(origin IS NULL OR origin = 'reconciler_adopted'\)/)
  assert.match(src, /if \(row\.position_id \|\| row\.trade_id\) \{\s*recordPositionEvent\(db, \{\s*accountId, positionId: row\.position_id \|\| null, tradeId: row\.trade_id/, 'a rank exit is journalled by trade id even before the position id is known')
  db.prepare(`INSERT INTO trades (symbol, side, status, origin) VALUES ('JPM.US', 'BUY', 'open', 'reconciler_adopted')`).run()
  db.prepare(`UPDATE trades SET origin = 'bot_pending_fill', origin_source = 'book_link' WHERE id = ? AND (origin IS NULL OR origin = 'reconciler_adopted')`).run(1)
  assert.equal(db.prepare(`SELECT origin FROM trades WHERE id = 1`).get().origin, 'bot_pending_fill')
})

// ---------------------------------------------------------------------------
// Wave 5 (first-principles audit 19-09-2026 §K item 15): an owed exit is not
// retried into a market the hours table already knows is closed — no broker
// call, one line when it first defers, one when it resumes.
// ---------------------------------------------------------------------------
test('OWED EXIT, MARKET CLOSED: the close is not sent, the pass counts deferredClosed, ONE line on the first deferral and none on the next pass; when the market opens the close goes with one resume line', async () => {
  const { _resetDeferredClosedForTests } = await import('./momentum-book.js')
  _resetDeferredClosedForTests()
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  let open = true
  f.deps.isSymbolOpen = () => (open ? { open: true, source: 'broker' } : { open: false, source: 'broker', reason: 'closed per broker trading schedule' })
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 1_000 })
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit' })
  open = false
  const lines = []
  let r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 2_000, log: (l) => lines.push(l) })
  assert.equal(f.calls.close.length, 0, 'known closed: the broker is not called')
  assert.equal(r.exits, 0)
  assert.equal(r.deferredClosed, 1)
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'open', 'the row stays open, the exit still owed')
  assert.ok(!r.skipped.some(x => /close failed/.test(x)), 'not a failed close — nothing was sent')
  const deferLines = lines.filter(l => /deferred — market closed/.test(l))
  assert.equal(deferLines.length, 1, lines.join('\n'))
  assert.match(deferLines[0], /BTCUSD on …\w+/)
  // Next pass, still closed: still no call, still counted, NO second line.
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 62_000, log: (l) => lines.push(l) })
  assert.equal(f.calls.close.length, 0)
  assert.equal(r.deferredClosed, 1)
  assert.equal(lines.filter(l => /deferred — market closed/.test(l)).length, 1, 'one line per symbol, not per pass')
  // The market opens: the close goes, one resume line.
  open = true
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 122_000, log: (l) => lines.push(l) })
  assert.equal(r.exits, 1)
  assert.equal(r.deferredClosed, 0)
  assert.deepEqual(f.calls.close, [{ positionId: `pos-BTCUSD-${DEMO}`, volume: 1000 }])
  assert.equal(lines.filter(l => /market open for BTCUSD .* resuming the deferred exit \(deferred 2 min\)/.test(l)).length, 1, lines.join('\n'))
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'exit_sent')
})

test('OWED EXIT, hours UNKNOWN (no symbol_hours row): the close IS attempted even where the sessions.js heuristic guesses closed — only the broker schedule may defer', async () => {
  const { _resetDeferredClosedForTests } = await import('./momentum-book.js')
  _resetDeferredClosedForTests()
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'NATGAS', action: 'enter' })
  const f = fakes()
  // No stub: the real isSymbolOpenCached. NATGAS has no hours row, and at
  // 21:10 UTC the heuristic calls energies closed (settlement break) — the
  // exact guess that must NOT hold an owed exit.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM symbol_hours WHERE symbol = 'NATGAS'`).get().n, 0)
  const { isSymbolOpenCached } = await import('./symbol-hours.js')
  const at = Date.parse('2026-09-09T21:10:00Z')
  assert.deepEqual([isSymbolOpenCached(db, 'NATGAS', new Date(at)).open, isSymbolOpenCached(db, 'NATGAS', new Date(at)).source], [false, 'heuristic'])
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: at - 60_000 })
  shadowRow(db, { symbol: 'NATGAS', action: 'exit' })
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: at })
  assert.equal(r.exits, 1)
  assert.equal(r.deferredClosed, 0)
  assert.equal(f.calls.close.length, 1, 'the heuristic is not a reason to hold an owed exit')
  // The same for an explicit heuristic verdict and for an hours reader that throws.
  for (const stub of [() => ({ open: false, source: 'heuristic', reason: 'guess' }), () => { throw new Error('hours reader down') }]) {
    const db2 = fresh()
    setState(db2, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
    setStage(db2, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
    shadowRow(db2, { symbol: 'BTCUSD', action: 'enter' })
    const f2 = fakes()
    f2.deps.isSymbolOpen = stub
    await runMomentumBook(db2, { accounts, credsFor, deps: f2.deps, now: 1_000 })
    shadowRow(db2, { symbol: 'BTCUSD', action: 'exit' })
    const r2 = await runMomentumBook(db2, { accounts, credsFor, deps: f2.deps, now: 2_000 })
    assert.equal(r2.exits, 1); assert.equal(r2.deferredClosed, 0); assert.equal(f2.calls.close.length, 1)
  }
})

test('OWED EXIT, hours known OPEN: the close is sent', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify(EVERY_PASS))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  f.deps.isSymbolOpen = () => ({ open: true, source: 'broker' })
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 1_000 })
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit' })
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 2_000 })
  assert.equal(r.exits, 1)
  assert.equal(f.calls.close.length, 1)
})

test('wiring pin: the hours are asked BEFORE the owed close, and the default is the cached broker schedule', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const src = strip(readFileSync(new URL('./momentum-book.js', import.meta.url), 'utf8'))
  assert.match(src, /\(deps\.isSymbolOpen \?\? isSymbolOpenCached\)\(db, symbol, new Date\(now\)\)[\s\S]{0,600}?if \(hours\.open === false && hours\.source === 'broker'\) \{[\s\S]{0,900}?continue[\s\S]{0,700}?const volume = await bookCloseVolume/)
})
