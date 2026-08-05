// node --test agent/services/trade-consistency.test.js
//
// The load-bearing test is `THE JPN225 ROWS` — the four real production rows
// that started this. A long that exits 152.8 points below its entry cannot be
// booked as a $14,259.55 profit, and until 05-08-2026 nothing said so.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import {
  priceMove, realisedRR, checkTradeConsistency,
  inconsistentTrades, consistencySummary, inconsistencyLine,
} from './trade-consistency.js'

const ACCT = '46130058'

function closed(db, t) {
  return db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, tp_price, volume,
                        status, opened_at, closed_at, net_pnl, gross_pnl, account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'closed', '2026-08-04 05:18:21', '2026-08-04 05:50:42', ?, ?, ?)
  `).run(t.symbol, t.side, t.entry, t.exit, t.sl ?? null, t.tp ?? null, t.volume ?? 1,
    t.net, t.net, t.account ?? ACCT).lastInsertRowid
}

// ---------------------------------------------------------------------------
// The real rows
// ---------------------------------------------------------------------------

test('THE JPN225 ROWS: four production trades that contradict themselves', () => {
  // Copied from /state/trades on 46130058, 05-08-2026. Not invented.
  const rows = [
    { id: 702, symbol: 'JPN225', side: 'BUY', entry: 63557.3, exit: 63404.5, net: 14259.55 },
    { id: 641, symbol: 'JPN225', side: 'SELL', entry: 62487.0, exit: 62484.4, net: -9171.76 },
    { id: 737, symbol: 'JPN225', side: 'SELL', entry: 63814.8, exit: 63741.9, net: -2681.29 },
    { id: 624, symbol: 'JPN225', side: 'SELL', entry: 62552.0, exit: 62534.3, net: -1315.92 },
  ]
  for (const r of rows) {
    const c = checkTradeConsistency({ side: r.side, entry_price: r.entry, exit_price: r.exit, net_pnl: r.net })
    assert.equal(c.decidable, true, `#${r.id} must be decidable`)
    assert.equal(c.ok, false, `#${r.id} contradicts itself and must be reported`)
  }
  // The headline one, spelled out: price fell 152.8 on a LONG.
  assert.equal(priceMove({ side: 'BUY', entry_price: 63557.3, exit_price: 63404.5 }).toFixed(1), '-152.8')
})

test('a trade that agrees with itself is not flagged', () => {
  const c = checkTradeConsistency({ side: 'SELL', entry_price: 100, exit_price: 95, net_pnl: 250 })
  assert.equal(c.decidable, true)
  assert.equal(c.ok, true)
})

// ---------------------------------------------------------------------------
// "Not decidable" is NOT "healthy" — the distinction the audit depends on
// ---------------------------------------------------------------------------

test('missing data is UNDECIDABLE, never counted as agreement', () => {
  // The whole point of the flag: a row we cannot check must not quietly pad
  // the "agrees" number and make the book look sounder than it is.
  for (const t of [
    { side: 'BUY', entry_price: 100, exit_price: null, net_pnl: 5 },
    { side: 'BUY', entry_price: null, exit_price: 105, net_pnl: 5 },
    { side: null, entry_price: 100, exit_price: 105, net_pnl: 5 },
    { side: 'BUY', entry_price: 100, exit_price: 105, net_pnl: null },
  ]) {
    const c = checkTradeConsistency(t)
    assert.equal(c.decidable, false)
    assert.equal(c.ok, true, 'ok=true means "no contradiction PROVEN", not "verified sound"')
  }
})

test('a scratch trade is undecidable, not a contradiction', () => {
  // Exit equals entry and P&L is a commission-only debit. Nothing to disagree
  // with — flagging it would bury the real 56 in noise.
  const c = checkTradeConsistency({ side: 'BUY', entry_price: 1.1, exit_price: 1.1, net_pnl: -0.4 })
  assert.equal(c.decidable, false)
})

test('zero P&L is undecidable whichever way price went', () => {
  const c = checkTradeConsistency({ side: 'BUY', entry_price: 100, exit_price: 110, net_pnl: 0 })
  assert.equal(c.decidable, false)
})

test('epsilon is relative to price, so a 5-digit FX pair is not noise-flagged', () => {
  const t = { side: 'BUY', entry_price: 1.10000, exit_price: 1.10001, net_pnl: -50 }
  assert.equal(checkTradeConsistency(t).decidable, true, 'a real pip is a real move')
  assert.equal(checkTradeConsistency(t, { epsilon: 1e-4 }).decidable, false, 'a looser epsilon calls it flat')
})

// ---------------------------------------------------------------------------
// Realised R — the number that did not exist
// ---------------------------------------------------------------------------

test('realised R is measured travel over the risk taken AT ENTRY', () => {
  // Entry 100, stop 98 => risk 2. Exit 106 => +6 => 3R.
  assert.equal(realisedRR({ side: 'BUY', entry_price: 100, exit_price: 106, sl_price: 98 }), 3)
  // A short that goes the wrong way is NEGATIVE R, not absolute.
  assert.equal(realisedRR({ side: 'SELL', entry_price: 100, exit_price: 102, sl_price: 102 }), -1)
})

test('realised R differs from PLANNED R — which is the entire point', () => {
  // Bracket says risk 2, reward 4 => planned R 2.0. The trade was cut by the
  // time cap at +1, so realised R is 0.5. 25% of our closed book exits this
  // way, which is why `edge` computed from planned R flatters us.
  const t = { side: 'BUY', entry_price: 100, exit_price: 101, sl_price: 98, tp_price: 104 }
  const planned = Math.abs(t.tp_price - t.entry_price) / Math.abs(t.entry_price - t.sl_price)
  assert.equal(planned, 2)
  assert.equal(realisedRR(t), 0.5)
})

test('realised R is null rather than wrong when the risk is unknowable', () => {
  assert.equal(realisedRR({ side: 'BUY', entry_price: 100, exit_price: 106, sl_price: null }), null)
  assert.equal(realisedRR({ side: 'BUY', entry_price: 100, exit_price: 106, sl_price: 100 }), null, 'zero risk is not infinite R')
  assert.equal(realisedRR({ side: 'BUY', entry_price: 100, exit_price: null, sl_price: 98 }), null)
})

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

test('inconsistentTrades finds them, worst first, and ignores the sound ones', () => {
  const db = initDB(':memory:')
  closed(db, { symbol: 'JPN225', side: 'BUY', entry: 63557.3, exit: 63404.5, net: 14259.55 })
  closed(db, { symbol: 'JPN225', side: 'SELL', entry: 62487, exit: 62484.4, net: -9171.76 })
  closed(db, { symbol: 'EURUSD', side: 'BUY', entry: 1.1, exit: 1.11, net: 120 })     // sound
  closed(db, { symbol: 'GBPUSD', side: 'SELL', entry: 1.3, exit: 1.3, net: -0.5 })    // scratch

  const bad = inconsistentTrades(db)
  assert.equal(bad.length, 2)
  assert.equal(bad[0].symbol, 'JPN225')
  assert.equal(bad[0].net_pnl, 14259.55, 'largest absolute P&L first — that is the one that moves the ledger')
  assert.ok(!bad.some(b => b.symbol === 'EURUSD'))
  assert.ok(!bad.some(b => b.symbol === 'GBPUSD'))
})

test('the audit is per account', () => {
  const db = initDB(':memory:')
  closed(db, { symbol: 'JPN225', side: 'BUY', entry: 100, exit: 90, net: 500, account: '46130058' })
  closed(db, { symbol: 'JPN225', side: 'BUY', entry: 100, exit: 90, net: 500, account: '43097342' })
  assert.equal(inconsistentTrades(db, { accountId: '46130058' }).length, 1)
  assert.equal(inconsistentTrades(db).length, 2, 'no account means every account')
})

test('the summary separates decidable from merely-present', () => {
  const db = initDB(':memory:')
  closed(db, { symbol: 'JPN225', side: 'BUY', entry: 100, exit: 90, net: 500 })   // contradiction
  closed(db, { symbol: 'EURUSD', side: 'BUY', entry: 1.1, exit: 1.11, net: 120 }) // agrees
  closed(db, { symbol: 'USDJPY', side: 'BUY', entry: 150, exit: null, net: 40 })  // undecidable

  const s = consistencySummary(db)
  assert.equal(s.closed, 3)
  assert.equal(s.decidable, 2, 'the row with no exit price cannot vote')
  assert.equal(s.agree, 1)
  assert.equal(s.contradict, 1)
  assert.equal(s.contradictPct, 50, 'a percentage OF THE DECIDABLE set, not of everything')
})

test('a database without the table fails OPEN', () => {
  const broken = { prepare() { throw new Error('no such table: trades') } }
  assert.deepEqual(inconsistentTrades(broken), [])
  assert.deepEqual(consistencySummary(broken), { closed: 0, decidable: 0, agree: 0, contradict: 0, contradictPct: null })
})

test('the line names the trade, both facts, and the account', () => {
  const t = {
    id: 702, symbol: 'JPN225', side: 'BUY', entry_price: 63557.3, exit_price: 63404.5,
    net_pnl: 14259.55, account_id: '46130058',
    check: checkTradeConsistency({ side: 'BUY', entry_price: 63557.3, exit_price: 63404.5, net_pnl: 14259.55 }),
  }
  const line = inconsistencyLine(t)
  assert.match(line, /#702 JPN225 BUY 63557\.3→63404\.5/)
  assert.match(line, /move -152\.8/)
  assert.match(line, /net \+14259\.55/)
  assert.match(line, /on 46130058/)
})

// ---------------------------------------------------------------------------
// The write path — closeTradeRow stamps both columns, for EVERY closer
// ---------------------------------------------------------------------------

test('closeTradeRow stamps realised R and the mismatch flag', async () => {
  const { closeTradeRow } = await import('../db.js')
  const db = initDB(':memory:')
  const id = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume, status, opened_at, account_id)
    VALUES ('EURUSD', 'BUY', 1.1000, 1.0980, 1.1060, 1, 'open', '2026-08-04 10:00:00', ?)
  `).run(ACCT).lastInsertRowid

  closeTradeRow(db, id, { exitPrice: 1.1010, closeReason: 'take profit', netPnl: 100 })
  const r = db.prepare(`SELECT realised_rr, pnl_price_mismatch FROM trades WHERE id = ?`).get(id)
  // risk 0.0020, move +0.0010 => 0.5R. Planned R was 0.0060/0.0020 = 3.
  assert.equal(Math.round(r.realised_rr * 1000) / 1000, 0.5)
  assert.equal(r.pnl_price_mismatch, 0)
})

test('THE STAMP CATCHES THE JPN225 SHAPE at the moment of close', async () => {
  const { closeTradeRow } = await import('../db.js')
  const db = initDB(':memory:')
  const id = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, sl_price, volume, status, opened_at, account_id)
    VALUES ('JPN225', 'BUY', 63557.3, 62031.9, 55.57, 'open', '2026-08-04 05:18:21', ?)
  `).run(ACCT).lastInsertRowid

  closeTradeRow(db, id, { exitPrice: 63404.5, closeReason: 'time_cap_expired', netPnl: 14259.55 })
  const r = db.prepare(`SELECT realised_rr, pnl_price_mismatch FROM trades WHERE id = ?`).get(id)
  assert.equal(r.pnl_price_mismatch, 1, 'a long that exits below entry cannot book a profit')
  assert.ok(r.realised_rr < 0, 'and its realised R is negative however the P&L reads')
})

test('a closer that supplies NO exit price still gets stamped', async () => {
  // Four of the five closeTradeRow callers pass no exit price. Before this,
  // those rows were never checked by anything. The stamp lives in
  // closeTradeRow precisely so none of them can opt out.
  const { closeTradeRow } = await import('../db.js')
  const db = initDB(':memory:')
  const id = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, volume, status, opened_at, account_id)
    VALUES ('DOW.US', 'SELL', 29.84, 30.18, 30.18, 250, 'open', '2026-08-04 15:33:17', ?)
  `).run(ACCT).lastInsertRowid

  closeTradeRow(db, id, { closeReason: 'closed at the broker (manual close or broker-side SL/TP fill)', netPnl: -95 })
  const r = db.prepare(`SELECT realised_rr, pnl_price_mismatch FROM trades WHERE id = ?`).get(id)
  assert.equal(r.pnl_price_mismatch, 0, 'a short stopped out above entry loses — consistent')
  assert.equal(Math.round(r.realised_rr * 100) / 100, -1, 'stopped at the stop is exactly -1R')
})

test('an unknowable realised R is stored as NULL, not as a guess', async () => {
  const { closeTradeRow } = await import('../db.js')
  const db = initDB(':memory:')
  const id = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, volume, status, opened_at, account_id)
    VALUES ('BTCUSD', 'BUY', 63000, 0.09, 'open', '2026-08-04 18:00:00', ?)
  `).run(ACCT).lastInsertRowid
  closeTradeRow(db, id, { closeReason: 'already_closed', netPnl: 12 })
  const r = db.prepare(`SELECT realised_rr, pnl_price_mismatch FROM trades WHERE id = ?`).get(id)
  assert.equal(r.realised_rr, null, 'no stop and no exit means no R — not zero R')
  assert.equal(r.pnl_price_mismatch, 0, 'undecidable is not a contradiction')
})
