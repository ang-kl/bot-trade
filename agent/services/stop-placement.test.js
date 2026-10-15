// node --test agent/services/stop-placement.test.js
//
// Claude · № 14,945 15-Oct (owner order § 14,741·A PR-3; claude-builder).
// The stop-placement review: per closed bot trade, the stop at entry in 1h
// ATRs at approval, outcome R from that stop, net R, excursion and slippage;
// buckets by stop/ATR with an INSUFFICIENT verdict under 30.
//
// Expected outcomes: the US30 #1826 case is the production trade of 13-10
// (§ 14,687·D·1, the stored trade and broker fill): long, entry 52050, stop
// 51966, filled at 51957.8, 8.2 points past the stop, −1.10R, never more than
// 0.05R in profit. Its 1h ATR here (100) is a fixture value, self-derived. The
// other cases are arithmetic on fixture values, self-derived: they prove the
// report computes what its method says, not that the method is right.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import {
  stopPlacementReport, stopAtEntryOf, stopAtrBucket, bucketStats, reviewRow,
  STOP_PLACEMENT_ROW_FIELDS, STOP_PLACEMENT_MIN_SAMPLE, NEVER_IN_PROFIT_R,
} from './stop-placement.js'

const NOW = Date.parse('2026-10-15T08:00:00Z')
const DAY = 86_400_000

function mkDb() {
  const db = initDB(':memory:')
  let reId = 1000
  const trade = db.prepare(`INSERT INTO trades(id, symbol, side, status, account_id, strategy, origin, entry_price, exit_price, sl_price,
      broker_sl_initial, gross_pnl, net_pnl, pnl_price_mismatch, exit_price_suspect, closed_at_ms, risk_event_id, close_reason, label_timeframe)
    VALUES (@id, @symbol, @side, 'closed', @account, @strategy, @origin, @entry, @exit, @sl, @bsi, @gross, @net, @mismatch, @suspect, @closedAt, @re, @reason, @tf)`)
  const re = db.prepare('INSERT INTO risk_events(id, symbol, checks_json, proposal_json) VALUES (?, ?, ?, ?)')
  const mp = db.prepare(`INSERT INTO monitored_positions(symbol, trade_id, status, initial_risk, mae_r, mfe_r, mae_exit_r, mfe_exit_r, broker_sl, current_sl)
    VALUES (?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?)`)
  const add = (o) => {
    const id = o.id
    let reRow = null
    if (o.atr !== undefined || o.proposalSl !== undefined || o.floorTo !== undefined || o.tfProposal !== undefined) {
      reRow = ++reId
      const stop_floor = o.atr === 'no_atr' ? 'no_atr' : o.atr == null ? undefined
        : o.floorTo != null ? { from: o.proposalSl, to: o.floorTo, atr1h: o.atr, mult: 1, source: 'scan_1h' } : { ok: true, atr1h: o.atr, mult: 1, source: 'scan_1h' }
      re.run(reRow, o.symbol ?? 'AAA', JSON.stringify({ stop_floor }), JSON.stringify({ sl: o.proposalSl ?? null, timeframe: o.tfProposal ?? null }))
    }
    trade.run({
      id, symbol: o.symbol ?? 'AAA', side: o.side ?? 'BUY', account: o.account ?? '111', strategy: o.strategy ?? 'vwap_trend',
      origin: o.origin ?? 'bot_market_dispatch', entry: o.entry ?? 100, exit: o.exit ?? 90, sl: o.sl ?? null, bsi: o.bsi ?? null,
      gross: o.gross ?? null, net: o.net ?? null, mismatch: o.mismatch ?? null, suspect: o.suspect ?? null,
      closedAt: o.closedAt ?? NOW - DAY, re: reRow, reason: o.reason ?? 'stop loss hit', tf: o.tf ?? null,
    })
    if (o.mp) mp.run(o.symbol ?? 'AAA', id, o.mp.ir ?? null, o.mp.mae ?? null, o.mp.mfe ?? null, o.mp.maeExit ?? null, o.mp.mfeExit ?? null, o.mp.brokerSl ?? null, o.mp.currentSl ?? null)
  }
  return { db, add }
}

test('US30 #1826 reproduced: −1.10R from the stop at entry, 0.098R slippage past it, never in profit', () => {
  const { db, add } = mkDb()
  add({ id: 1826, symbol: 'US30', side: 'BUY', account: '46130058', strategy: 'rsi2_reversion', entry: 52050, exit: 51957.8, bsi: 51966,
    sl: 51966, atr: 100, gross: -92.2, net: -95, reason: 'stop loss hit — broker-side SL fill (reclassified from the broker exit price)', tf: '15m',
    mp: { ir: 84, mae: -1.1, mfe: 0, maeExit: -1.1, mfeExit: 0, brokerSl: 51966 } })
  const r = stopPlacementReport(db, { account: 'all', days: 30, now: NOW })
  assert.equal(r.population.included, 1)
  const row = r.rows[0]
  assert.equal(row.outcomeR, -1.0976, '(51957.8 − 52050) ÷ 84 — the −1.10R of § 14,687·D·1')
  assert.equal(row.slippageR, 0.0976, '8.2 points past the 51966 stop, over 84')
  assert.equal(row.exitKind, 'sl')
  assert.equal(row.stopSource, 'broker_sl_initial')
  assert.equal(row.stopAtr, 0.84)
  assert.equal(row.mfeR, 0)
  assert.equal(row.excursionBasis, 'exit')
  assert.equal(row.timeframe, '15m')
  // net R: −95 money ÷ (−92.2 money per −1.0976R) → costs count in R
  assert.equal(row.netR, -1.131)
  assert.deepEqual(Object.keys(row).sort(), [...STOP_PLACEMENT_ROW_FIELDS].sort(), 'only allowlisted fields leave the worker')
  const b = r.buckets.find(x => x.bucket === '0.75-1')
  assert.equal(b.n, 1); assert.equal(b.verdict, 'INSUFFICIENT')
  assert.deepEqual(b.losersNeverInProfit, { n: 1, of: 1, share: 1 })
})

test('buckets by stop/ATR: <0.75, 0.75–1, a stop floored to exactly 1 ATR reads 1–1.5, >1.5, and no ATR', () => {
  assert.equal(stopAtrBucket(0.5), '<0.75')
  assert.equal(stopAtrBucket(0.75), '0.75-1')
  assert.equal(stopAtrBucket(0.9999), '0.75-1')
  assert.equal(stopAtrBucket(1), '1-1.5')
  assert.equal(stopAtrBucket(0.9999999), '1-1.5', 'floating-point noise on a 1 ATR floor')
  assert.equal(stopAtrBucket(1.5), '1-1.5')
  assert.equal(stopAtrBucket(1.6), '>1.5')
  assert.equal(stopAtrBucket(null), 'no_atr')
  const { db, add } = mkDb()
  add({ id: 1, entry: 100, exit: 95, bsi: 95, atr: 10, gross: -5, net: -5 })            // 0.5
  add({ id: 2, entry: 100, exit: 91, bsi: 91, atr: 10, gross: -9, net: -9 })            // 0.9
  add({ id: 3, entry: 100, exit: 90, proposalSl: 96, floorTo: 90, atr: 10, gross: -10, net: -10 }) // floored → 1.0
  add({ id: 4, entry: 100, exit: 112, bsi: 88, atr: 10, gross: 12, net: 12, reason: 'take profit hit' }) // 1.2
  add({ id: 5, entry: 100, exit: 80, bsi: 80, atr: 10, gross: -20, net: -20 })          // 2.0
  add({ id: 6, entry: 100, exit: 90, bsi: 90, atr: 'no_atr', gross: -10, net: -10 })    // no ATR recorded
  const r = stopPlacementReport(db, { now: NOW })
  const byId = Object.fromEntries(r.rows.map(x => [x.id, x]))
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(i => stopAtrBucket(byId[i].stopAtr)), ['<0.75', '0.75-1', '1-1.5', '1-1.5', '>1.5', 'no_atr'])
  assert.equal(byId[3].stopSource, 'stop_floor', 'the floored stop, not the proposal\'s 96')
  assert.equal(byId[6].atrSource, 'no_atr')
  assert.deepEqual(r.buckets.map(b => [b.bucket, b.n]), [['<0.75', 1], ['0.75-1', 1], ['1-1.5', 2], ['>1.5', 1], ['no_atr', 1]])
})

test('the stop at entry: broker_sl_initial → floored stop → proposal → initial risk → sl_price (never book-trailed)', () => {
  const base = { entry_price: 100, side: 'BUY' }
  assert.deepEqual(stopAtEntryOf({ ...base, broker_sl_initial: 92, stop_floor: { to: 90 }, proposal_sl: 95, initial_risk: 7, sl_price: 99 }), { stop: 92, risk: 8, source: 'broker_sl_initial' })
  assert.deepEqual(stopAtEntryOf({ ...base, stop_floor: { to: 90 }, proposal_sl: 95, initial_risk: 7 }), { stop: 90, risk: 10, source: 'stop_floor' })
  assert.deepEqual(stopAtEntryOf({ ...base, proposal_sl: 95, initial_risk: 7 }), { stop: 95, risk: 5, source: 'proposal_sl' })
  assert.deepEqual(stopAtEntryOf({ ...base, initial_risk: 7 }), { stop: 93, risk: 7, source: 'initial_risk' })
  assert.deepEqual(stopAtEntryOf({ ...base, sl_price: 94 }), { stop: 94, risk: 6, source: 'sl_price' })
  assert.deepEqual(stopAtEntryOf({ ...base, sl_price: 94, book_trailed: 1 }), { stop: null, risk: null, source: null }, 'a book-trailed sl_price is not the stop at entry')
  // a stop on the wrong side of the entry is not a stop at entry; the next source is tried
  assert.deepEqual(stopAtEntryOf({ ...base, broker_sl_initial: 101, proposal_sl: 96 }), { stop: 96, risk: 4, source: 'proposal_sl' })
  assert.deepEqual(stopAtEntryOf({ entry_price: 100, side: 'SELL', broker_sl_initial: 104 }), { stop: 104, risk: 4, source: 'broker_sl_initial' })
  assert.deepEqual(stopAtEntryOf({ entry_price: 100, side: 'SELL', initial_risk: 3 }), { stop: 103, risk: 3, source: 'initial_risk' })
})

test('population: bot origins only, closed in the window, on the account asked; superseded / suspect / stop-less rows are counted out', () => {
  const { db, add } = mkDb()
  add({ id: 1, bsi: 90, atr: 10, gross: -10, net: -10 })
  add({ id: 2, bsi: 90, atr: 10, gross: -10, net: -10, origin: 'bot_pending_fill', account: '222' })
  add({ id: 3, bsi: 90, atr: 10, gross: -10, net: -10, origin: 'manual_ticket' })
  add({ id: 4, bsi: 90, atr: 10, gross: -10, net: -10, closedAt: NOW - 40 * DAY })
  add({ id: 5, bsi: 90, atr: 10, gross: -10, net: -10, reason: 'duplicate_adoption: superseded by trade 1' })
  add({ id: 6, bsi: 90, atr: 10, gross: -10, net: -10, suspect: 1 })
  add({ id: 7, atr: 10, gross: -10, net: -10 }) // no stop anywhere
  const all = stopPlacementReport(db, { account: 'all', days: 30, now: NOW })
  assert.deepEqual(all.rows.map(r => r.id).sort(), [1, 2])
  assert.deepEqual(all.population, { considered: 5, included: 2, excluded: { superseded: 1, exit_price_suspect: 1, no_stop_at_entry: 1 } })
  const one = stopPlacementReport(db, { account: '222', days: 30, now: NOW })
  assert.deepEqual(one.rows.map(r => r.id), [2])
  assert.equal(stopPlacementReport(db, { account: 'all', days: 60, now: NOW }).rows.length, 3, 'a wider window reaches the 40-day close')
})

test('net R: costs scale with the money one R was worth; withheld when money and price disagree in sign', () => {
  const ok = reviewRow({ id: 1, side: 'SELL', entry_price: 100, exit_price: 96, broker_sl_initial: 104, gross_pnl: 40, net_pnl: 36 })
  assert.equal(ok.row.outcomeR, 1); assert.equal(ok.row.netR, 0.9)
  assert.equal(ok.row.side, 'short')
  const flipped = reviewRow({ id: 2, side: 'BUY', entry_price: 100, exit_price: 104, broker_sl_initial: 96, gross_pnl: -10, net_pnl: -12 })
  assert.equal(flipped.row.outcomeR, 1); assert.equal(flipped.row.netR, null, 'a winning price move with losing money is a record defect, not a result')
  const mismatch = reviewRow({ id: 3, side: 'BUY', entry_price: 100, exit_price: 104, broker_sl_initial: 96, gross_pnl: 40, net_pnl: 38, pnl_price_mismatch: 1 })
  assert.equal(mismatch.row.netR, null)
  // excursion is rescaled from the monitor's R to this stop's R
  const rescaled = reviewRow({ id: 4, side: 'BUY', entry_price: 100, exit_price: 90, broker_sl_initial: 80, gross_pnl: -10, net_pnl: -10, mp_initial_risk: 10, mae_r: -1, mfe_r: 0.4 })
  assert.equal(rescaled.row.mfeR, 0.2); assert.equal(rescaled.row.maeR, -0.5); assert.equal(rescaled.row.excursionBasis, 'mid')
  // slippage is measured past the stop the broker last held (moved after entry), short side
  const moved = reviewRow({ id: 5, side: 'SELL', entry_price: 100, exit_price: 101, broker_sl_initial: 110, gross_pnl: -1, net_pnl: -1, mp_broker_sl: 100.5, close_reason: 'stop loss hit — broker-side fill at a stop moved after entry' })
  assert.equal(moved.row.slippageR, 0.05)
  assert.equal(reviewRow({ id: 6, side: 'BUY', entry_price: 100, exit_price: 110, broker_sl_initial: 90, gross_pnl: 10, net_pnl: 10, close_reason: 'take profit hit' }).row.slippageR, null, 'not a stop exit')
})

test(`a bucket under ${STOP_PLACEMENT_MIN_SAMPLE} scored trades reads INSUFFICIENT; at ${STOP_PLACEMENT_MIN_SAMPLE} it is MEASURED with a bootstrap lower bound`, () => {
  const row = (netR, mfeR) => ({ netR, mfeR, slippageR: null })
  const small = bucketStats(Array.from({ length: 29 }, (_, i) => row(i % 2 ? 1 : -1, 0)))
  assert.equal(small.verdict, 'INSUFFICIENT'); assert.equal(small.n, 29)
  // 18 wins of +1R, 12 losses of −1R (8 never past +0.05R)
  const rows = [...Array.from({ length: 18 }, () => row(1, 1.2)), ...Array.from({ length: 8 }, () => row(-1, NEVER_IN_PROFIT_R)), ...Array.from({ length: 4 }, () => row(-1, 0.6)), row(null, null)]
  const s = bucketStats(rows)
  assert.equal(s.verdict, 'MEASURED'); assert.equal(s.n, 30); assert.equal(s.unscored, 1)
  assert.equal(s.winRate, 0.6); assert.equal(s.avgWinR, 1); assert.equal(s.avgLossR, -1); assert.equal(s.profitFactor, 1.5)
  assert.equal(s.expectancyR, 0.2)
  assert.equal(typeof s.expectancyLowerR, 'number'); assert.ok(s.expectancyLowerR < 0.2, 'the 5th percentile sits below the mean')
  assert.deepEqual(s.losersNeverInProfit, { n: 8, of: 12, share: 0.6667 })
  assert.equal(bucketStats([row(1, 1), row(2, 3)]).profitFactor, null)
  assert.equal(bucketStats([row(1, 1), row(2, 3)]).lossless, true)
})

test('byStrategy: each strategy carries its own totals and buckets', () => {
  const { db, add } = mkDb()
  add({ id: 1, strategy: 'vwap_trend', bsi: 90, atr: 10, gross: -10, net: -10 })
  add({ id: 2, strategy: 'donchian_breakout', entry: 100, exit: 130, bsi: 80, atr: 10, gross: 30, net: 30, reason: 'take profit hit' }) // 2 ATR
  const r = stopPlacementReport(db, { now: NOW })
  assert.deepEqual(r.byStrategy.map(s => [s.strategy, s.n]), [['donchian_breakout', 1], ['vwap_trend', 1]])
  assert.equal(r.byStrategy[0].buckets.find(b => b.bucket === '>1.5').n, 1)
  assert.equal(r.report, 'stop-placement')
})
