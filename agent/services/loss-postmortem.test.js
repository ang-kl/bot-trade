// node --test agent/services/loss-postmortem.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { classifyLoss, runLossPostmortems, postmortemStats, sqliteMs } from './loss-postmortem.js'

// Long trade: entry 100, SL 98 (risk 2), stopped at 98.
const LONG = { side: 'BUY', entry_price: 100, sl_price: 98, exit_price: 98, close_reason: 'sl' }
const T0 = Date.parse('2026-07-20T12:00:00Z')
const bar = (i, h, l, c) => ({ t: T0 + (i + 1) * 60_000, o: c, h, l, c, v: 100 })

test('classifyLoss: stop_hunt — price returns to entry after the stop', () => {
  const after = [bar(0, 98.5, 97.9, 98.2), bar(1, 99.2, 98.1, 99.0), bar(2, 100.3, 98.9, 100.1), bar(3, 100.5, 99.8, 100.2), bar(4, 100.2, 99.6, 99.9)]
  const v = classifyLoss(LONG, after, T0)
  assert.equal(v.classification, 'stop_hunt')
  assert.match(v.detail, /stop was too tight|entry too early/)
})

test('classifyLoss: thesis_wrong — price continues 1R beyond the stop', () => {
  // 1R beyond SL 98 = 96. Third bar trades down to 95.8.
  const after = [bar(0, 98.4, 97.5, 97.6), bar(1, 97.8, 96.8, 97.0), bar(2, 97.1, 95.8, 96.0), bar(3, 96.5, 95.9, 96.2), bar(4, 96.4, 96.0, 96.1)]
  const v = classifyLoss(LONG, after, T0)
  assert.equal(v.classification, 'thesis_wrong')
})

test('classifyLoss: chronological order wins — crash first, recovery later = thesis_wrong', () => {
  const after = [bar(0, 97.9, 95.5, 95.8), bar(1, 98.5, 95.7, 98.2), bar(2, 100.4, 98.1, 100.2), bar(3, 100.5, 99.9, 100.3), bar(4, 100.4, 100.0, 100.1)]
  const v = classifyLoss(LONG, after, T0)
  assert.equal(v.classification, 'thesis_wrong')
})

test('classifyLoss: chop — neither event in the window', () => {
  const after = Array.from({ length: 6 }, (_, i) => bar(i, 98.8, 97.9, 98.3))
  const v = classifyLoss(LONG, after, T0)
  assert.equal(v.classification, 'chop')
})

test('classifyLoss: short side is mirrored', () => {
  // Short entry 100, SL 102, stopped at 102; price falls back to 100 → hunt.
  const short = { side: 'SELL', entry_price: 100, sl_price: 102, exit_price: 102, close_reason: 'sl' }
  const after = [bar(0, 102.2, 101.4, 101.6), bar(1, 101.8, 100.4, 100.6), bar(2, 100.8, 99.8, 100.0), bar(3, 100.4, 99.9, 100.1), bar(4, 100.3, 99.9, 100.0)]
  const v = classifyLoss(short, after, T0)
  assert.equal(v.classification, 'stop_hunt')
})

test('classifyLoss: time cap close is its own class; too-few bars waits (null)', () => {
  assert.equal(classifyLoss({ ...LONG, close_reason: 'time_cap_expired (x)' }, [], T0).classification, 'time_cap')
  assert.equal(classifyLoss(LONG, [bar(0, 98.5, 97.9, 98.2)], T0), null)
  // allowPartial (stale trade) classifies with what exists instead of waiting
  const partial = classifyLoss(LONG, [bar(0, 100.4, 98.0, 100.2)], T0, { allowPartial: true })
  assert.equal(partial.classification, 'stop_hunt')
})

test('runLossPostmortems: sweep classifies a losing trade and stores replay bars', async () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, volume, opened_at, closed_at,
                        net_pnl, status, close_reason, label_strategy, label_timeframe)
    VALUES ('EURUSD', 'BUY', 100, 98, 98, 0.1, datetime('now', '-3 hours'), datetime('now', '-2 hours'),
            -50, 'closed', 'sl', 'fib_618_fade', '1h')
  `).run()
  const closedMs = sqliteMs(db.prepare(`SELECT closed_at FROM trades`).get().closed_at)
  const mkBars = () => {
    const out = []
    for (let i = 0; i < 40; i++) {
      const t = closedMs - (30 - i) * 3_600_000
      // After the close: price rockets back over entry → stop_hunt.
      const late = t > closedMs
      out.push({ t, o: 99, h: late ? 101 : 99.5, l: late ? 99 : 98.4, c: late ? 100.5 : 99, v: 10 })
    }
    return out
  }
  const res = await runLossPostmortems(db, async () => mkBars())
  assert.equal(res.classified, 1)
  const pm = db.prepare(`SELECT * FROM trade_postmortems`).get()
  assert.equal(pm.classification, 'stop_hunt')
  assert.equal(pm.strategy, 'fib_618_fade')
  assert.ok(JSON.parse(pm.bars_json).length > 0, 'replay bars stored')
  // Second sweep: nothing left to classify (UNIQUE trade_id)
  const res2 = await runLossPostmortems(db, async () => mkBars())
  assert.equal(res2.examined, 0)
})

test('runLossPostmortems: fetch failure skips without inserting; stats aggregate', async () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, opened_at, closed_at,
                        net_pnl, status, close_reason)
    VALUES ('GBPUSD', 'SELL', 1.30, 1.31, 1.31, datetime('now','-2 hours'), datetime('now','-1 hours'),
            -30, 'closed', 'sl')
  `).run()
  const res = await runLossPostmortems(db, async () => { throw new Error('ws down') })
  assert.equal(res.classified, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM trade_postmortems`).get().n, 0)
  // seed one postmortem row directly and check stats shape
  db.prepare(`INSERT INTO trade_postmortems (trade_id, symbol, strategy, classification) VALUES (1, 'GBPUSD', 'fib_618_fade', 'stop_hunt')`).run()
  const stats = postmortemStats(db)
  assert.deepEqual(stats, [{ strategy: 'fib_618_fade', classification: 'stop_hunt', n: 1 }])
})

// Wins carry lessons too --------------------------------------------------

test('classifyWin: gave_back — peaked far above the banked R', async () => {
  const { classifyWin } = await import('./loss-postmortem.js')
  // Long entry 100, SL 98 (risk 2), banked at 103 (+1.5R) but peaked 108 (+4R).
  const w = { side: 'BUY', entry_price: 100, sl_price: 98, exit_price: 103 }
  const bars = [
    { t: 10, o: 100, h: 104, l: 99.5, c: 103 },
    { t: 20, o: 103, h: 108, l: 102, c: 107 },
    { t: 30, o: 107, h: 107.5, l: 103, c: 103.2 },
  ]
  const v = classifyWin(w, bars, 5, 35)
  assert.equal(v.classification, 'gave_back')
  assert.match(v.detail, /left on the table/)
})

test('classifyWin: escaped beats gave_back — near-stop first is the bigger lesson', async () => {
  const { classifyWin } = await import('./loss-postmortem.js')
  // Drew down to 98.2 (−0.9R) before rallying to 108 and banking 103.
  const w = { side: 'BUY', entry_price: 100, sl_price: 98, exit_price: 103 }
  const bars = [
    { t: 10, o: 100, h: 100.5, l: 98.2, c: 99 },
    { t: 20, o: 99, h: 108, l: 99, c: 107 },
    { t: 30, o: 107, h: 107.5, l: 103, c: 103.2 },
  ]
  const v = classifyWin(w, bars, 5, 35)
  assert.equal(v.classification, 'escaped')
  assert.match(v.detail, /entry timing was early/)
})

test('classifyWin: clean_win when the exit captured the move', async () => {
  const { classifyWin } = await import('./loss-postmortem.js')
  const w = { side: 'SELL', entry_price: 100, sl_price: 102, exit_price: 97.5 }
  const bars = [
    { t: 10, o: 100, h: 100.4, l: 98.5, c: 99 },
    { t: 20, o: 99, h: 99.2, l: 97.2, c: 97.6 },
  ]
  const v = classifyWin(w, bars, 5, 25)
  assert.equal(v.classification, 'clean_win')
})

test('runLossPostmortems: sweep classifies WINS too, with endTime-anchored fetch', async () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, opened_at, closed_at,
                        net_pnl, status, close_reason, label_strategy, label_timeframe)
    VALUES ('EURUSD', 'BUY', 100, 103, 98, datetime('now', '-30 hours'), datetime('now', '-26 hours'),
            +75, 'closed', 'bank_target', 'ema_pullback', '1h')
  `).run()
  const closedMs = sqliteMs(db.prepare(`SELECT closed_at FROM trades`).get().closed_at)
  let gotEndTime = null
  const fetchBars = async (_sym, _tf, _count, endTimeMs) => {
    gotEndTime = endTimeMs
    // Holding-period bars: peak +4R (108) while banked +1.5R → gave_back.
    const out = []
    for (let i = 0; i < 30; i++) {
      const t = closedMs - (28 - i) * 3_600_000
      out.push({ t, o: 100, h: i > 10 ? 108 : 101, l: 99.5, c: 103, v: 5 })
    }
    return out
  }
  const res = await runLossPostmortems(db, fetchBars)
  assert.equal(res.classified, 1)
  assert.ok(gotEndTime != null && gotEndTime >= closedMs, 'fetch anchored at/after the close')
  const pm = db.prepare(`SELECT * FROM trade_postmortems`).get()
  assert.equal(pm.classification, 'gave_back')
  assert.ok(pm.r_multiple > 0, 'win stored with positive R')
})

test('runLossPostmortems: 90-day window back-fills history (old trade included)', async () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, opened_at, closed_at,
                        net_pnl, status, close_reason)
    VALUES ('GBPUSD', 'BUY', 100, 98, 98, datetime('now', '-40 days'), datetime('now', '-40 days', '+2 hours'),
            -20, 'closed', 'sl')
  `).run()
  const closedMs = sqliteMs(db.prepare(`SELECT closed_at FROM trades`).get().closed_at)
  const fetchBars = async () => {
    const out = []
    for (let i = 0; i < 40; i++) {
      const t = closedMs - (25 - i) * 3_600_000
      const late = t > closedMs
      out.push({ t, o: 99, h: late ? 101 : 99.5, l: late ? 99 : 98.4, c: late ? 100.5 : 99, v: 5 })
    }
    return out
  }
  const res = await runLossPostmortems(db, fetchBars)
  assert.equal(res.classified, 1, 'a 40-day-old loss is inside the 90-day back-fill window')
  assert.equal(db.prepare(`SELECT classification FROM trade_postmortems`).get().classification, 'stop_hunt')
})

// Trade-Lesson Extraction (owner spec) --------------------------------------

test('classifyResult: Win/Partial/Miss judged against the GOAL (TP1), not raw P&L', async () => {
  const { classifyResult } = await import('./loss-postmortem.js')
  // Long entry 100, goal TP1 110: exit 110 = Win; exit 105 = Partial; exit 98 = Miss.
  assert.equal(classifyResult({ side: 'BUY', entry_price: 100, exit_price: 110, tp_price: 110 }), 'Win')
  assert.equal(classifyResult({ side: 'BUY', entry_price: 100, exit_price: 105, tp_price: 110 }), 'Partial')
  assert.equal(classifyResult({ side: 'BUY', entry_price: 100, exit_price: 98, tp_price: 110 }), 'Miss')
  // Short mirrored; no TP recorded → any profit counts as Win (no goal to miss).
  assert.equal(classifyResult({ side: 'SELL', entry_price: 100, exit_price: 90, tp_price: 90 }), 'Win')
  assert.equal(classifyResult({ side: 'BUY', entry_price: 100, exit_price: 103, tp_price: null }), 'Win')
})

test('alphaDecayFlag: EXACT Symbol+Strategy+Timeframe key, last 5, >=3 Miss = decay', async () => {
  const { alphaDecayFlag } = await import('./loss-postmortem.js')
  const db = initDB(':memory:')
  const ins = db.prepare(`INSERT INTO trade_postmortems (trade_id, symbol, strategy, timeframe, result) VALUES (NULL, ?, ?, ?, ?)`)
  // 5 same-key rows, 3 Miss → decay
  for (const r of ['Miss', 'Miss', 'Win', 'Miss', 'Partial']) ins.run('EURUSD', 'fib_618_fade', '4h', r)
  assert.equal(alphaDecayFlag(db, { symbol: 'EURUSD', strategy: 'fib_618_fade', timeframe: '4h' }), 'decay')
  // Same symbol, DIFFERENT timeframe → independent edge, insufficient history
  assert.equal(alphaDecayFlag(db, { symbol: 'EURUSD', strategy: 'fib_618_fade', timeframe: '1d' }), 'insufficient_history')
  // Same symbol, different strategy → independent edge
  assert.equal(alphaDecayFlag(db, { symbol: 'EURUSD', strategy: 'ema_pullback', timeframe: '4h' }), 'insufficient_history')
  // Healthy key: 5 rows, only 1 Miss → ok
  for (const r of ['Win', 'Win', 'Miss', 'Partial', 'Win']) ins.run('GBPUSD', 'vp_value', '4h', r)
  assert.equal(alphaDecayFlag(db, { symbol: 'GBPUSD', strategy: 'vp_value', timeframe: '4h' }), 'ok')
})

test('entryQuality: <=2 confluence -> Watch; unrecorded -> unknown (never invented)', async () => {
  const { entryQuality } = await import('./loss-postmortem.js')
  assert.equal(entryQuality(2), 'Watch')
  assert.equal(entryQuality(3), 'OK')
  assert.equal(entryQuality(null), 'unknown')
})

test('lessonLine: imperative, deterministic per classification', async () => {
  const { lessonLine } = await import('./loss-postmortem.js')
  assert.match(lessonLine('stop_hunt'), /^Widen stop/)
  assert.match(lessonLine('thesis_wrong', { strategy: 'fib_618_fade' }), /fib_618_fade/)
  assert.match(lessonLine('escaped', { maeR: -0.92 }), /-0\.9R/)
  assert.ok(lessonLine('chop').split(' ').length < 15)
})

test('sweep persists the flat lesson fields', async () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, tp_price, opened_at, closed_at,
                        net_pnl, status, close_reason, label_strategy, label_timeframe, confluence_count)
    VALUES ('EURUSD', 'BUY', 100, 98, 98, 104, datetime('now', '-3 hours'), datetime('now', '-2 hours'),
            -50, 'closed', 'sl', 'fib_618_fade', '1h', 2)
  `).run()
  const closedMs = sqliteMs(db.prepare(`SELECT closed_at FROM trades`).get().closed_at)
  const bars = []
  for (let i = 0; i < 40; i++) {
    const t = closedMs - (30 - i) * 3_600_000
    const late = t > closedMs
    bars.push({ t, o: 99, h: late ? 101 : 99.5, l: late ? 99 : 98.4, c: late ? 100.5 : 99, v: 10 })
  }
  await runLossPostmortems(db, async () => bars)
  const pm = db.prepare(`SELECT * FROM trade_postmortems`).get()
  assert.equal(pm.result, 'Miss')
  assert.equal(pm.alpha_decay, 'insufficient_history')
  assert.equal(pm.entry_quality, 'Watch')       // confluence_count = 2
  assert.match(pm.lesson, /^Widen stop/)        // stop_hunt verdict
})
