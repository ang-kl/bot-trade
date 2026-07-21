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
