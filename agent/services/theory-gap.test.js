// node --test agent/services/theory-gap.test.js
// Claude · № 13,094 11-Oct (ordered № 13,093; claude-builder)
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { rAudit, rUnderCandidates, theoryGapReport, STOP_CANDIDATES } from './theory-gap.js'

const NOW = Date.parse('2026-10-10T12:00:00Z'), DAY = 86_400_000

function fixture() {
  const db = initDB(':memory:')
  const ins = db.prepare(`INSERT INTO trades(id, symbol, side, status, account_id, strategy, origin, entry_price, exit_price, sl_price, tp_price, broker_sl_initial, realised_rr, exit_price_suspect, net_pnl, closed_at_ms, risk_event_id, close_reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  // #1: long, entry 100, initial stop 90 (risk 10), book trailed sl_price to 105, exit 112 → R 1.2 against the initial stop, 7.0 against the trailed one.
  ins.run(1, 'AAA', 'BUY', 'closed', '111', 'tsmom_long', 'bot_pending_fill', 100, 112, 105, null, 90, 1.2, null, 120, NOW - 2 * DAY, 501, 'momentum_account: rank exit')
  // #2: short, entry 50, initial stop 55 (risk 5), trailed to 48, exit 47 → R 0.6 initial; against trailed stop (risk 2) R 1.5.
  ins.run(2, 'BBB', 'SELL', 'closed', '111', 'tsmom_long', 'bot_market_dispatch', 50, 47, 48, null, 55, 0.6, null, 30, NOW - 3 * DAY, null, 'take profit hit')
  // #3: long loser, closed in two legs: 0.5 lots at 96 and 0.5 lots at 92 → fill-weighted close 94, R −0.6 (risk 10). The ledger exit is the last leg.
  ins.run(3, 'CCC', 'BUY', 'closed', '111', 'tsmom_long', 'bot_pending_fill', 100, 92, 90, null, 90, -0.8, null, -40, NOW - 4 * DAY, null, 'stop loss hit')
  // #4: superseded duplicate — excluded. #5: another strategy — excluded. #6: outside the window — excluded.
  ins.run(4, 'AAA', 'BUY', 'closed', '111', 'tsmom_long', 'reconciler_adopted', 100, 112, 105, null, 90, 1.2, null, 120, NOW - 2 * DAY, null, 'duplicate_adoption: superseded by trade 1')
  ins.run(5, 'AAA', 'BUY', 'closed', '111', 'vp_value', 'bot_market_dispatch', 100, 112, 105, null, 90, 1.2, null, 120, NOW - 2 * DAY, null, 'tp')
  ins.run(6, 'AAA', 'BUY', 'closed', '111', 'tsmom_long', 'bot_market_dispatch', 100, 112, 105, null, 90, 1.2, null, 120, NOW - 400 * DAY, null, 'tp')
  db.prepare(`INSERT INTO trade_postmortems(trade_id, symbol, strategy, side, entry_price, exit_price, sl_price, net_pnl, r_multiple, classification)
    VALUES (1,'AAA','tsmom_long','BUY',100,112,105,120,7.0,'clean_win'), (2,'BBB','tsmom_long','SELL',50,47,48,30,1.5,'clean_win')`).run()
  db.prepare(`INSERT INTO trade_plans(trade_id, symbol, side, strategy, planned_entry, planned_sl, risk_dist) VALUES (1,'AAA','BUY','tsmom_long',100,91,9)`).run()
  db.prepare(`INSERT INTO monitored_positions(symbol, trade_id, status, initial_risk) VALUES ('AAA', 1, 'closed', 10)`).run()
  db.prepare(`INSERT INTO risk_events(id, symbol, proposal_json) VALUES (501, 'AAA', ?)`).run(JSON.stringify({ sl: 90.5, tp1: 130 }))
  db.prepare(`INSERT INTO broker_deals(deal_id, position_id, account_id, symbol, side, lots, entry_price, close_price, matched_trade_id)
    VALUES ('d1','p3','111','CCC','BUY',0.5,100,96,3), ('d2','p3','111','CCC','BUY',0.5,100,92,3)`).run()
  return db
}

test('rUnderCandidates: R under every candidate stop; a missing candidate is unavailable, never guessed', () => {
  const r = rUnderCandidates({ side: 'BUY', entry_price: 100, exit_price: 112, broker_sl_initial: 90, current_sl: 105, initial_risk: 10, postmortem_sl: 105, planned_sl: null, proposal_sl: 90.5 })
  assert.equal(r.move, 12)
  assert.equal(r.under.broker_sl_initial.r, 1.2); assert.equal(r.under.current_sl.r, 2.4); assert.equal(r.under.postmortem_sl.r, 2.4)
  assert.equal(r.under.initial_risk.r, 1.2); assert.equal(r.under.proposal_sl.r, 1.263)
  assert.deepEqual(r.under.planned_sl, { available: false, r: null, risk: null })
  const short = rUnderCandidates({ side: 'SELL', entry_price: 50, exit_price: 47, broker_sl_initial: 55 })
  assert.equal(short.under.broker_sl_initial.r, 0.6)
  assert.equal(STOP_CANDIDATES.length, 6)
})

test('rAudit: the population, the per-candidate figures, the postmortem-stop flag and the fill-weighted R', () => {
  const db = fixture()
  const out = rAudit(db, { strategy: 'tsmom_long', days: 365, now: NOW })
  assert.equal(out.trades, 3, 'superseded, other strategy and out-of-window rows excluded')
  const c = Object.fromEntries(out.candidates.map(x => [x.key, x]))
  // Against the broker's initial stop: +1.2, +0.6, −0.8 → PF 2.25, expectancy 0.333.
  assert.equal(c.broker_sl_initial.available, 3); assert.equal(c.broker_sl_initial.profitFactorR, 2.25); assert.equal(c.broker_sl_initial.expectancyR, 0.333)
  // Against the trailed (current) stop: +2.4 (risk 5), +1.5 (risk 2), −0.8 → inflated.
  assert.equal(c.current_sl.profitFactorR, 4.88); assert.equal(c.postmortem_sl.available, 2)
  assert.equal(c.proposal_sl.available, 1); assert.equal(c.planned_sl.available, 1); assert.equal(c.initial_risk.available, 1)
  assert.equal(out.postmortemStopDiffersFromBrokerInitial, 2, 'both postmortem rows divided by a trailed stop')
  assert.deepEqual(out.ledgerVsPostmortem, { agree: 0, disagree: 2, unscored: 1 })
  assert.equal(out.tradesWithPartialCloses, 1)
  const t3 = out.rows.find(r => r.id === 3)
  assert.equal(t3.closingDeals, 2); assert.equal(t3.fillWeightedR, -0.6, 'lots-weighted close 94 against risk 10')
  const t1 = out.rows.find(r => r.id === 1)
  assert.equal(t1.rUnder.broker_sl_initial, 1.2); assert.equal(t1.rUnder.postmortem_sl, 2.4); assert.equal(t1.postmortemR, 7)
  assert.equal(t1.stops.proposal_sl, 90.5); assert.equal(t1.ledgerRecomputed, 1.2, 'realisedRR divides by broker_sl_initial first')
  assert.match(out.note, /postmortem divides by trades.sl_price AT POSTMORTEM TIME/)
})

test('theoryGapReport dispatches by section and refuses an unknown one; an empty population is a report, not an error', () => {
  const db = fixture()
  assert.equal(theoryGapReport(db, { section: 'r-audit', strategy: 'tsmom_long', now: NOW }).trades, 3)
  const none = theoryGapReport(db, { section: 'r-audit', strategy: 'nothing_here', now: NOW })
  assert.equal(none.trades, 0); assert.ok(none.candidates.every(c => c.n === 0 && c.available === 0))
  assert.throws(() => theoryGapReport(db, { section: 'nope' }), RangeError)
})

// --- regime-blocks (plan step 5, B5a) — Claude · № 13,095 11-Oct ---------
import { recordRegimeBlock } from './gate-skips.js'
import { regimeBlocks, REGIME_BLOCKS_TOP } from './theory-gap.js'

function blocksFixture() {
  const db = initDB(':memory:')
  const quiet = s => `regime_block trend-in-quiet (${s}): no trend to ride, breakouts fake out`
  const fade = s => `regime_block fade-vs-trend (${s}): long fade into a down-trending market`
  // Three cycles of the same Donchian/AAA/1h block in one day = one episode; one VA block; two meanrev fades.
  for (let i = 0; i < 3; i++) recordRegimeBlock(db, { symbol: 'AAA', synth: { strategy: 'donchian_breakout', timeframe: '1h', consensus_bias: 'long', entry: 101 }, signal: { entry: 101 }, reason: quiet('donchian_breakout'), loopId: i })
  recordRegimeBlock(db, { symbol: 'BBB', synth: { strategy: 'va_breakout', timeframe: '15m', consensus_bias: 'short' }, signal: null, reason: quiet('va_breakout'), loopId: 3 })
  recordRegimeBlock(db, { symbol: 'AAA', synth: { strategy: 'rsi_meanrev', timeframe: '15m', consensus_bias: 'long', entry: 100 }, signal: null, reason: fade('rsi_meanrev'), loopId: 4 })
  recordRegimeBlock(db, { symbol: 'CCC', synth: { strategy: 'rsi_meanrev', timeframe: '15m', consensus_bias: 'long' }, signal: null, reason: fade('rsi_meanrev'), loopId: 5 })
  // One old row outside the window, and one row of another stage that must not count.
  recordRegimeBlock(db, { symbol: 'OLD', synth: { strategy: 'donchian_breakout', timeframe: '1h' }, signal: null, reason: quiet('donchian_breakout'), loopId: 6 })
  db.prepare("UPDATE decision_log SET created_at = datetime('now', '-40 days') WHERE symbol = 'OLD'").run()
  db.prepare("INSERT INTO decision_log(symbol, stage, decision, reason, strategy) VALUES ('AAA', 'evidence_gate', 'skip', 'evidence_gate: x', 'donchian_breakout')").run()
  return db
}

test('regime-blocks: counts the loop\'s regime_block skips by kind, strategy, symbol and bias; episodes collapse repeated cycles; the window and the stage are respected', () => {
  const db = blocksFixture()
  const out = regimeBlocks(db, { days: 30 })
  assert.equal(out.rows, 6, 'six cycles in the window; the 40-day-old row and the evidence_gate row are out')
  assert.equal(out.episodes, 4, 'three Donchian cycles are one episode')
  assert.deepEqual(out.byKind, { 'trend-in-quiet': 4, 'fade-vs-trend': 2 })
  assert.deepEqual(out.quietByStrategy, { donchian_breakout: 3, va_breakout: 1 })
  assert.deepEqual(out.byStrategyKind, { 'donchian_breakout · trend-in-quiet': 3, 'va_breakout · trend-in-quiet': 1, 'rsi_meanrev · fade-vs-trend': 2 })
  assert.deepEqual(out.episodesByStrategyKind, { 'donchian_breakout · trend-in-quiet': 1, 'va_breakout · trend-in-quiet': 1, 'rsi_meanrev · fade-vs-trend': 2 })
  assert.deepEqual(out.bySymbol, { AAA: 4, BBB: 1, CCC: 1 }); assert.equal(out.symbolsOmitted, 0)
  assert.deepEqual(out.byBias, { long: 5, short: 1 }); assert.deepEqual(out.byTimeframe, { '1h': 3, '15m': 3 })
  // The stored detail carries entry at most: nothing is scorable, and the report says so.
  assert.deepEqual(out.capture, { entryKnown: 4, stopKnown: 0, targetKnown: 0, convictionKnown: 0, scorable: 0 })
  assert.match(out.note, /stop, target and conviction are not recorded/)
  // One strategy; and the window widened takes the old row in.
  assert.equal(regimeBlocks(db, { days: 30, strategy: 'rsi_meanrev' }).rows, 2)
  assert.equal(regimeBlocks(db, { days: 60 }).rows, 7)
  assert.equal(theoryGapReport(db, { section: 'regime-blocks', strategy: null, days: 30 }).rows, 6)
})

test('regime-blocks: the symbol table is bounded and says how many it left out; a malformed reason is "unknown", never dropped', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < REGIME_BLOCKS_TOP + 3; i++) recordRegimeBlock(db, { symbol: `S${String(i).padStart(2, '0')}`, synth: { strategy: 'vwap_trend', timeframe: '15m' }, signal: null, reason: i === 0 ? 'garbage' : 'regime_block trend-in-quiet (vwap_trend): x', loopId: i })
  const out = regimeBlocks(db, { days: 7 })
  assert.equal(Object.keys(out.bySymbol).length, REGIME_BLOCKS_TOP); assert.equal(out.symbolsOmitted, 3)
  assert.equal(out.byKind.unknown, 1); assert.equal(out.rows, REGIME_BLOCKS_TOP + 3)
})
