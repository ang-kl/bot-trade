// exit-price-suspects.test.js
//
// The two rows this exists for are real, and both are named in
// trade-consistency.js's header. One is caught by the sign check; the other is
// not, and that one is the reason this module exists at all.

import test from 'node:test'
import assert from 'node:assert/strict'
import { impliedUnitValue, impliedExitPrice, exitPriceSuspects } from './exit-price-suspects.js'
import { checkTradeConsistency } from './trade-consistency.js'

// A healthy JPN225 population: 1 USD per point per unit, which is what the
// broker's realised money implies (see contracts.js, corrected in #690).
const healthy = (i, vol, pts) => ({
  id: 100 + i, symbol: 'JPN225', side: 'SELL', entry_price: 62000, exit_price: 62000 - pts,
  volume: vol, net_pnl: pts * vol, closed_at: `2026-08-0${i} 10:00:00`,
})
const POP = [healthy(1, 50, 30), healthy(2, 60, 20), healthy(3, 40, 45), healthy(4, 55, 25)]

// Trade 641, real: SELL 62487 -> 62484.4, so 2.6 points IN FAVOUR of the short,
// and the broker charged 9,171.76. The SIGN check catches this one — a short
// that moved in its favour cannot lose money.
//
// The row it CANNOT catch is the same magnitude error with the sign consistent,
// and that is what the third test builds. That row is the reason this module
// exists: it is invisible to the existing check and therefore never repaired.
const T641 = {
  id: 641, symbol: 'JPN225', side: 'SELL', entry_price: 62487, exit_price: 62484.4,
  volume: 72.54, net_pnl: -9171.76, closed_at: '2026-08-03 13:47:53',
  close_reason: 'closed at the broker (manual close or broker-side SL/TP fill) — not closed by the bot',
}

test('the derived unit value needs no currency table', () => {
  // 30 points x 50 volume = 1500 of money -> 1.0 per point per unit.
  assert.equal(impliedUnitValue(healthy(1, 50, 30)), 1)
  // And it is scale-free: double the volume, double the money, same value.
  assert.equal(impliedUnitValue(healthy(1, 100, 30)), 1)
})

test('a healthy population produces no suspects', () => {
  const r = exitPriceSuspects(POP)
  assert.equal(r.totalSuspects, 0)
  assert.equal(r.symbols[0].verdict, 'consistent')
  assert.equal(r.symbols[0].medianUnitValue, 1)
})

test('THE QUIET CASE: right direction, wrong magnitude, sign check blind', () => {
  // A short that exits BELOW entry and LOST money is caught by the sign check.
  // The dangerous row is the mirror: direction agrees, magnitude is absurd.
  // 2.6 points of recorded move against 9,171.76 of broker money implies
  // ~48.7 money-per-point-per-unit where the symbol's own median is 1.
  const quiet = { ...T641, net_pnl: 9171.76 }   // short, price fell, PROFIT: signs agree
  assert.equal(checkTradeConsistency(quiet).ok, true, 'the sign check sees nothing wrong')

  const r = exitPriceSuspects([...POP, quiet])
  assert.equal(r.totalSuspects, 1, 'but the magnitude check flags it')
  const s = r.suspects[0]
  assert.equal(s.id, 641)
  assert.ok(s.ratio > 40, `ratio ${s.ratio} should be ~48.7`)
  assert.equal(s.symbolMedian, 1)
})

test('and it still catches the loud case the sign check already had', () => {
  const r = exitPriceSuspects([...POP, T641])
  assert.equal(r.totalSuspects, 1)
  assert.equal(r.suspects[0].id, 641)
  // Belt and braces: the two checks agree that this row is broken, by
  // different routes. Neither is redundant — see the second test.
  assert.equal(checkTradeConsistency(T641).ok, false)
})

test('under-stated exits are caught as loudly as over-stated ones', () => {
  // A row implying 1/50th the symbol's money-per-point. A bare
  // `ratio > tolerance` test would find none of these.
  const tiny = { id: 999, symbol: 'JPN225', side: 'SELL', entry_price: 62000, exit_price: 60500, volume: 50, net_pnl: 1500 }
  const r = exitPriceSuspects([...POP, tiny])
  assert.equal(r.totalSuspects, 1)
  assert.ok(r.suspects[0].ratio < 1, `ratio ${r.suspects[0].ratio} is below 1`)
})

test('a thin symbol gets no verdict — a median of two is not a reference', () => {
  const r = exitPriceSuspects([POP[0], T641], { minTrades: 4 })
  assert.equal(r.totalSuspects, 0)
  assert.equal(r.symbols[0].verdict, 'insufficient')
})

test('SYSTEMATIC error is invisible here, and the test says so', () => {
  // Every row off by the same factor — what a wrong quote currency does. The
  // median moves with the error, so nothing looks odd. This is the documented
  // blind spot and it belongs to sizing-parity.js; pinning it stops someone
  // later trusting this check to mean more than it does.
  const allWrong = POP.map(t => ({ ...t, net_pnl: t.net_pnl * 158 }))
  const r = exitPriceSuspects(allWrong)
  assert.equal(r.totalSuspects, 0, 'consistent, and consistently wrong')
  assert.equal(r.symbols[0].medianUnitValue, 158)
})

test('rows that cannot be checked are counted as silent, never as passing', () => {
  const r = exitPriceSuspects([
    ...POP,
    { id: 1, symbol: 'JPN225', side: 'SELL', entry_price: 62000, exit_price: null, volume: 10, net_pnl: -5 },
    { id: 2, symbol: 'JPN225', side: 'SELL', entry_price: 62000, exit_price: 61990, volume: 0, net_pnl: -5 },
    { id: 3, symbol: 'JPN225', side: 'SELL', entry_price: 62000, exit_price: 62000, volume: 10, net_pnl: -5 },
    { id: 4, symbol: 'JPN225', side: 'SELL', entry_price: 62000, exit_price: 61990, volume: 10, net_pnl: 0 },
  ])
  assert.equal(r.usable, 4)
  assert.equal(r.silent, 4)
  assert.equal(r.totalSuspects, 0)
})

test('`Number(null)` is 0 — a missing exit must not become a price of zero', () => {
  // The trap that has now appeared three times in this codebase in two days.
  // An exit of "0" on a 62,000 index is a 100% move and a colossal fake ratio.
  assert.equal(impliedUnitValue({ side: 'SELL', entry_price: 62000, exit_price: null, volume: 10, net_pnl: -5 }), null)
  assert.equal(impliedUnitValue({ side: 'SELL', entry_price: 62000, exit_price: '', volume: 10, net_pnl: -5 }), null)
})

test('impliedExit offers evidence, and refuses to invent it', () => {
  // At a unit value of 1, a 9,171.76 loss on 72.54 volume needs 126.44 points
  // against a short — so the exit was near 62,613, not the recorded 62,484.4.
  const exit = impliedExitPrice(T641, 1)
  assert.ok(Math.abs(exit - 62613.44) < 0.01, `implied exit ${exit}`)
  // Refusals: no median, no side, no volume -> null, never a plausible guess.
  assert.equal(impliedExitPrice(T641, 0), null)
  assert.equal(impliedExitPrice({ ...T641, side: 'x' }, 1), null)
  assert.equal(impliedExitPrice({ ...T641, volume: null }, 1), null)
})

test('suspects are ranked by how wrong they are, in log space', () => {
  const big = { id: 11, symbol: 'JPN225', side: 'SELL', entry_price: 62000, exit_price: 61999, volume: 50, net_pnl: 5000 }
  const small = { id: 12, symbol: 'JPN225', side: 'SELL', entry_price: 62000, exit_price: 61800, volume: 50, net_pnl: 2000 }
  const r = exitPriceSuspects([...POP, small, big])
  assert.equal(r.totalSuspects, 2)
  assert.equal(r.suspects[0].id, 11, 'the 100x row outranks the 5x row')
})

test('the sweep stamps the flag, clears it on repair, and writes no prices', async () => {
  const { initDB } = await import('../db.js')
  const { sweepExitPriceSuspects } = await import('./exit-price-suspects.js')
  const db = initDB(':memory:')
  const ins = db.prepare(`INSERT INTO trades
    (symbol, side, entry_price, exit_price, volume, net_pnl, status, closed_at)
    VALUES (?,?,?,?,?,?,'closed', datetime('now','-1 day'))`)
  for (const t of POP) ins.run(t.symbol, t.side, t.entry_price, t.exit_price, t.volume, t.net_pnl)
  const bad = ins.run(T641.symbol, T641.side, T641.entry_price, T641.exit_price, T641.volume, T641.net_pnl)
  const badId = bad.lastInsertRowid

  const r1 = sweepExitPriceSuspects(db)
  assert.equal(r1.error, undefined, r1.error)
  assert.equal(r1.flagged, 1)
  assert.equal(r1.scanned, 5)
  assert.equal(db.prepare('SELECT exit_price_suspect FROM trades WHERE id = ?').get(badId).exit_price_suspect, 1)
  // The flag is the only thing written — the price is untouched, because only
  // the broker's execution price may replace it (pnl-backfill.js does that).
  assert.equal(db.prepare('SELECT exit_price FROM trades WHERE id = ?').get(badId).exit_price, T641.exit_price)

  // Idempotent: a second pass changes nothing.
  const r2 = sweepExitPriceSuspects(db)
  assert.equal(r2.flagged, 0)
  assert.equal(r2.cleared, 0)

  // Repair the price the way the backfill would, then re-sweep: the flag must
  // CLEAR. A mark that only ever turns on is a history, not a worklist.
  db.prepare('UPDATE trades SET exit_price = ? WHERE id = ?').run(62613.44, badId)
  const r3 = sweepExitPriceSuspects(db)
  assert.equal(r3.cleared, 1)
  assert.equal(db.prepare('SELECT exit_price_suspect FROM trades WHERE id = ?').get(badId).exit_price_suspect, 0)
})
