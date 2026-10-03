// node --test agent/services/refusal-ledger.test.js
//
// §7,437·B·2 (owner, 08-09-2026): each refused setup is scored against the
// bars that followed, at its own entry/stop/target within its horizon, and
// summed per reason. A refusal re-proposed every loop is one opportunity.
// Intrabar ambiguity is refused, not guessed, exactly as exit-replay does.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB } from '../db.js'
import { persistRiskEvent } from './risk.js'
import { pendingRefusals, scoreRefusedOpportunities, refusalCostReport, horizonMinFor, evidenceShadowRefusals, stopForReplay } from './refusal-ledger.js'
import { recordEvidenceShadow } from './gate-skips.js'

const T0 = Date.parse('2026-09-01T10:00:00Z')
const iso = (ms) => new Date(ms).toISOString()

// The opportunity key is derived from the previous evaluation of the same
// tuple (opportunity-identity.js), so rows are persisted at wall-clock time
// and backdated afterwards — the key groups them, the date sets the horizon.
function refuse(db, { symbol = 'EURUSD', side = 'BUY', entry = 1.1, sl = 1.095, tp = 1.11, reason = 'bad_rr 2.0<3', tf = '1h', at = T0, accountId = 'A1', checks = {} } = {}) {
  const proposal = { symbol, side, entry, sl, tp1: tp, strategy: 'donchian_breakout', timeframe: tf, accountId }
  const id = persistRiskEvent(db, proposal, { approved: false, veto_reason: reason, checks })
  db.prepare('UPDATE risk_events SET created_at = ? WHERE id = ?').run(iso(at).replace('T', ' ').slice(0, 19), id)
  return id
}
function backdate(db, at = T0) {
  db.prepare('UPDATE risk_events SET created_at = ?').run(iso(at).replace('T', ' ').slice(0, 19))
}

// bars: [t,o,h,l,c,v]
const bar = (t, o, h, l, c) => [t, o, h, l, c, 0]

test('horizon: 48 bars of the timeframe, floored at 4h, capped at 20 days; unknown reads as 1h', () => {
  assert.equal(horizonMinFor('5m'), 240)
  assert.equal(horizonMinFor('1h'), 2880)
  assert.equal(horizonMinFor('4h'), 11520)
  assert.equal(horizonMinFor('1d'), 20 * 1440)
  assert.equal(horizonMinFor(null), 2880)
})

test('pendingRefusals: same setup refused on many loops is one opportunity, waits for its horizon, names unscorable ones', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 5; i++) refuse(db, { at: Date.now() })                   // one opportunity, 5 refusals
  refuse(db, { symbol: 'GBPUSD', entry: null, sl: null, tp: null, reason: 'insufficient_equity min_lot=0.01', at: Date.now() }) // unscorable
  backdate(db, T0)
  const early = pendingRefusals(db, { nowMs: T0 + 60 * 60_000 })
  assert.equal(early.filter(p => !p.unscorable).length, 0, 'the horizon has not elapsed')
  const later = pendingRefusals(db, { nowMs: T0 + 3 * 86_400_000 })
  const eur = later.find(p => p.symbol === 'EURUSD')
  assert.ok(eur); assert.equal(eur.refusals, 5); assert.equal(eur.reasonKey, 'bad_rr <n><3', 'veto-breakdown’s key: numbers out, floor kept'); assert.equal(eur.horizonMin, 2880)
  assert.ok(later.find(p => p.symbol === 'GBPUSD')?.unscorable)
})

test('scoreRefusedOpportunities: target, stop, ambiguous and fetch failure each become one row', async () => {
  const db = initDB(':memory:')
  refuse(db, { symbol: 'EURUSD', at: T0 })                                   // will hit target
  refuse(db, { symbol: 'USDJPY', entry: 150, sl: 149.5, tp: 151, at: T0 })   // will hit stop
  refuse(db, { symbol: 'AUDUSD', entry: 0.66, sl: 0.655, tp: 0.67, at: T0 }) // ambiguous bar
  refuse(db, { symbol: 'NOSYM', at: T0 })                                   // fetch throws
  backdate(db, T0)
  const H = 3600_000
  const fetchBars = async (symbol) => {
    if (symbol === 'EURUSD') return [bar(T0 + H, 1.1, 1.105, 1.099, 1.104), bar(T0 + 2 * H, 1.104, 1.111, 1.103, 1.11)]
    if (symbol === 'USDJPY') return [bar(T0 + H, 150, 150.2, 149.4, 149.5)]
    if (symbol === 'AUDUSD') return [bar(T0 + H, 0.66, 0.671, 0.654, 0.66)]
    throw new Error(`symbolId unknown for ${symbol}`)
  }
  const r = await scoreRefusedOpportunities(db, fetchBars, { nowMs: T0 + 3 * 86_400_000, maxPerCycle: 10 })
  assert.equal(r.scored, 3); assert.equal(r.failed, 1); assert.equal(r.waiting, 0)
  const by = Object.fromEntries(db.prepare('SELECT * FROM refusal_scores').all().map(x => [x.symbol, x]))
  assert.equal(by.EURUSD.outcome, 'target'); assert.equal(by.EURUSD.r_reached, 2)
  assert.equal(by.USDJPY.outcome, 'stop'); assert.equal(by.USDJPY.r_reached, -1)
  assert.equal(by.AUDUSD.outcome, 'ambiguous'); assert.equal(by.AUDUSD.r_reached, null)
  assert.equal(by.NOSYM.outcome, 'fetch_failed'); assert.match(by.NOSYM.note, /symbolId unknown/)
  // a second pass finds nothing left
  const again = await scoreRefusedOpportunities(db, fetchBars, { nowMs: T0 + 3 * 86_400_000 })
  assert.equal(again.scored + again.failed + again.unscorable, 0)
})

test('refusalCostReport: sums R over decided outcomes per reason and keeps the rest beside it', async () => {
  const db = initDB(':memory:')
  refuse(db, { symbol: 'EURUSD', at: T0, reason: 'bad_rr 2.0<3' })
  refuse(db, { symbol: 'USDJPY', entry: 150, sl: 149.5, tp: 151, at: T0, reason: 'bad_rr 1.6<3' })
  refuse(db, { symbol: 'AUDUSD', entry: 0.66, sl: 0.655, tp: 0.67, at: T0, reason: 'overexposed_USD=-2' })
  backdate(db, T0)
  const H = 3600_000
  const fetchBars = async (symbol) => symbol === 'EURUSD'
    ? [bar(T0 + H, 1.1, 1.111, 1.099, 1.11)]
    : symbol === 'USDJPY' ? [bar(T0 + H, 150, 150.2, 149.4, 149.5)] : [bar(T0 + H, 0.66, 0.671, 0.654, 0.66)]
  const now = T0 + 3 * 86_400_000
  await scoreRefusedOpportunities(db, fetchBars, { nowMs: now, maxPerCycle: 10 })
  const r = refusalCostReport(db, { days: 7, now })
  assert.equal(r.total.n, 3); assert.equal(r.total.scored, 2); assert.equal(r.total.sumR, 1)
  const badRr = r.reasons.find(x => x.reason === 'bad_rr <n><3')
  assert.equal(badRr.n, 2); assert.equal(badRr.scored, 2); assert.equal(badRr.sumR, 1); assert.equal(badRr.wouldHavePaid, 1)
  assert.equal(r.reasons.find(x => x.reason === 'overexposed_USD=<n>').outcomes.ambiguous, 1)
})

test('UI-5 (RS-1): refusalCostReport windows on first_at (refusal time), not scored_at (when the scorer got to it)', () => {
  const db = initDB(':memory:')
  const insert = db.prepare(`INSERT INTO refusal_scores (opportunity_key, account_id, symbol, side, reason_key, reason,
      entry, sl, tp, first_at, last_at, refusals, horizon_min, scored_at, outcome, r_reached)
    VALUES (@key, 'A1', @symbol, 'BUY', 'bad_rr', 'bad_rr', 1.1, 1.095, 1.11, @first_at, @first_at, 1, 60, @scored_at, 'target', 1)`)
  const now = T0
  const since7d = now - 7 * 86_400_000

  // Refused 10 days ago (OUTSIDE the 7-day window), but the background
  // scorer only just got to it — the OLD scored_at-windowed query would
  // wrongly include it in "the last 7 days".
  insert.run({ key: 'old-refusal-late-score', symbol: 'OLDREF', first_at: iso(now - 10 * 86_400_000), scored_at: iso(now - 60_000) })

  // Refused 2 days ago (INSIDE the window) and scored promptly.
  insert.run({ key: 'recent-refusal', symbol: 'RECENT', first_at: iso(now - 2 * 86_400_000), scored_at: iso(now - 2 * 86_400_000 + 3_600_000) })

  const r = refusalCostReport(db, { days: 7, now })
  const symbols = r.recent.map(x => x.symbol)
  assert.ok(!symbols.includes('OLDREF'), 'a refusal from 10 days ago must not count as "the last 7 days" just because it was scored late')
  assert.ok(symbols.includes('RECENT'))
  assert.equal(r.total.n, 1)
  assert.ok(since7d < now) // sanity: the window constant used above is meaningful
})

test('wiring pin: the loop scores refusals with the postmortem fetcher, capped per cycle, and both hot paths carry a timeframe', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  const cml = strip(readFileSync(new URL('./closed-market-limits.js', import.meta.url), 'utf8'))
  assert.match(loop, /scoreRefusedOpportunities\(db, pmFetch, \{ maxPerCycle: 6/, 'scored with the broker fetcher, six per cycle')
  assert.match(cml, /timeframe: synth\.timeframe \?\? null/, 'closed-market proposals carry their timeframe')
  assert.match(loop, /prune-refusal-scores/, 'refusal scores have their own retention step')
})

test('PR-C: evidence-gate SKIPS are scored too — read from decision_log, keyed by the same rule, one opportunity per re-proposal run', () => {
  const db = initDB(':memory:')
  const acct = '44440001'
  const synth = { strategy: 'vwap_trend', timeframe: '1h', entry: 100, sl: 99, tp1: 103 }
  for (let i = 0; i < 3; i++) {
    recordEvidenceShadow(db, { symbol: 'EURUSD', side: 'BUY', accountId: acct, synth, gate: { reason: 'thin record' } })
  }
  // Three rows minutes apart → one opportunity; dated three days back so the 1h horizon (48 bars = 2 days) has elapsed.
  db.prepare(`UPDATE decision_log SET created_at = datetime('now', '-3 days', '+' || id || ' minutes')`).run()
  const shadow = evidenceShadowRefusals(db)
  assert.equal(shadow.length, 1)
  assert.equal(shadow[0].refusals, 3)
  assert.match(shadow[0].opportunity_key, new RegExp(`^${acct}\\|EURUSD\\|BUY\\|VWAP_TREND@\\d+$`))

  const pending = pendingRefusals(db, { nowMs: Date.now() })
  assert.equal(pending.length, 1)
  const it = pending[0]
  assert.equal(it.strategy, 'vwap_trend')
  assert.equal(it.timeframe, '1h')
  assert.deepEqual([it.entry, it.sl, it.tp], [100, 99, 103])
  assert.equal(it.refusals, 3)
  assert.equal(it.reasonKey, 'evidence_gate')
  assert.equal(it.unscorable, undefined)

  // Scored once → gone from the pending set, like a risk_events refusal.
  db.prepare(`INSERT INTO refusal_scores (opportunity_key, symbol, scored_at, outcome) VALUES (?, 'EURUSD', datetime('now'), 'target')`).run(it.opportunityKey)
  assert.equal(pendingRefusals(db, { nowMs: Date.now() }).length, 0)
  assert.equal(evidenceShadowRefusals(db).length, 0)
})

// ---------------------------------------------------------------------------
// R1 (the 03-10-2026 replays, docs/replays-2026-10-03.md): the stop the
// ledger replays is the stop the GATE judged — the hourly-ATR floor's `to`
// when it widened the proposal's stop — not the strategy's pre-floor stop.
// Measured: 354 of 357 bad_rr vetoes floored, median 4.1×, so the old unit
// described trades four times tighter than any the gate would have sized.
// ---------------------------------------------------------------------------

test('R1: stopForReplay — the floor\'s `to` when the gate widened, the proposal\'s stop when it did not, and the unit says which', () => {
  const p = { entry: 1.1, sl: 1.095 }
  assert.deepEqual(stopForReplay(p, { stop_floor: { from: 1.095, to: 1.09, atr1h: 0.01, mult: 1 } }), { sl: 1.09, slProposal: 1.095, stopUnit: 'gate' })
  assert.deepEqual(stopForReplay(p, { stop_floor: { ok: true, atr1h: 0.001, mult: 1 } }), { sl: 1.095, slProposal: 1.095, stopUnit: 'gate' }, 'the proposal\'s stop cleared the floor: it IS the gate\'s stop')
  assert.deepEqual(stopForReplay(p, { stop_floor: 'no_atr' }), { sl: 1.095, slProposal: 1.095, stopUnit: 'gate' }, 'no ATR, no floor: the gate judged the proposal\'s stop')
  assert.deepEqual(stopForReplay(p, {}), { sl: 1.095, slProposal: 1.095, stopUnit: 'gate' })
  assert.deepEqual(stopForReplay(p, null), { sl: 1.095, slProposal: 1.095, stopUnit: 'proposal' }, 'no checks at all: the gate never ran (a shadow refusal)')
  assert.deepEqual(stopForReplay(p, undefined), { sl: 1.095, slProposal: 1.095, stopUnit: 'proposal' })
})

test('R1: a floored refusal is replayed at the gate\'s stop — its R is in the unit the gate sized, and the row records both stops', async () => {
  const db = initDB(':memory:')
  // Proposal stop 1.095 (5 pips); the gate widened it to 1.09 (10 pips). The
  // target 1.11 is 10 pips away: 2 R at the proposal's stop, 1 R at the
  // gate's. A bar that reaches 1.111 hits the target either way; the R must
  // be the gate's 1, not the proposal's 2.
  refuse(db, { symbol: 'EURUSD', entry: 1.1, sl: 1.095, tp: 1.11, at: T0, checks: { stop_floor: { from: 1.095, to: 1.09, atr1h: 0.01, mult: 1 } } })
  // An unfloored refusal keeps the proposal's stop and still reads as the gate's unit.
  refuse(db, { symbol: 'USDJPY', entry: 150, sl: 149.5, tp: 151, at: T0, checks: { stop_floor: { ok: true, atr1h: 0.2, mult: 1 } } })
  backdate(db, T0)
  const pending = pendingRefusals(db, { nowMs: T0 + 3 * 86_400_000 })
  const eur = pending.find(p => p.symbol === 'EURUSD')
  assert.deepEqual([eur.sl, eur.slProposal, eur.stopUnit], [1.09, 1.095, 'gate'])
  const jpy = pending.find(p => p.symbol === 'USDJPY')
  assert.deepEqual([jpy.sl, jpy.slProposal, jpy.stopUnit], [149.5, 149.5, 'gate'])
  const H = 3600_000
  const fetchBars = async (symbol) => symbol === 'EURUSD'
    ? [bar(T0 + H, 1.1, 1.111, 1.0995, 1.11)]
    : [bar(T0 + H, 150, 151.2, 149.9, 151)]
  await scoreRefusedOpportunities(db, fetchBars, { nowMs: T0 + 3 * 86_400_000, maxPerCycle: 10 })
  const by = Object.fromEntries(db.prepare('SELECT * FROM refusal_scores').all().map(x => [x.symbol, x]))
  assert.equal(by.EURUSD.outcome, 'target')
  assert.equal(by.EURUSD.r_reached, 1, 'R in the gate\'s unit (the old code said 2)')
  assert.deepEqual([by.EURUSD.sl, by.EURUSD.sl_proposal, by.EURUSD.stop_unit], [1.09, 1.095, 'gate'])
  assert.equal(by.USDJPY.r_reached, 2)
  assert.deepEqual([by.USDJPY.sl, by.USDJPY.sl_proposal, by.USDJPY.stop_unit], [149.5, 149.5, 'gate'])
})

test('R1: a shadow refusal (the gate never ran) is replayed at the proposal\'s stop and says so', async () => {
  const db = initDB(':memory:')
  const synth = { strategy: 'vwap_trend', timeframe: '1h', entry: 100, sl: 99, tp1: 103 }
  recordEvidenceShadow(db, { symbol: 'EURUSD', side: 'BUY', accountId: '44440001', synth, gate: { reason: 'thin record' } })
  db.prepare(`UPDATE decision_log SET created_at = datetime('now', '-3 days')`).run()
  const it = pendingRefusals(db, { nowMs: Date.now() })[0]
  assert.deepEqual([it.sl, it.slProposal, it.stopUnit], [99, 99, 'proposal'])
  await scoreRefusedOpportunities(db, async () => [bar(it.firstMs + 3600_000, 100, 103.5, 99.5, 103)], { nowMs: Date.now(), maxPerCycle: 10 })
  const row = db.prepare('SELECT * FROM refusal_scores').get()
  assert.deepEqual([row.outcome, row.r_reached, row.sl_proposal, row.stop_unit], ['target', 3, 99, 'proposal'])
})

test('R1: refusalCostReport splits known-unit rows from legacy rows, and the refusal_cost goal reads only the known', async () => {
  const db = initDB(':memory:')
  refuse(db, { symbol: 'EURUSD', entry: 1.1, sl: 1.095, tp: 1.11, at: T0, checks: { stop_floor: { from: 1.095, to: 1.09, atr1h: 0.01, mult: 1 } } })
  backdate(db, T0)
  const now = T0 + 3 * 86_400_000
  await scoreRefusedOpportunities(db, async () => [bar(T0 + 3600_000, 1.1, 1.111, 1.0995, 1.11)], { nowMs: now, maxPerCycle: 10 })
  // A row scored before the unit existed: stop_unit NULL, R in the old (pre-floor) unit.
  db.prepare(`INSERT INTO refusal_scores (opportunity_key, account_id, symbol, side, reason_key, reason, entry, sl, tp, first_at, last_at, refusals, horizon_min, scored_at, outcome, r_reached)
    VALUES ('legacy-1', 'A1', 'GBPUSD', 'BUY', 'bad_rr <n><3', 'bad_rr 2.0<3', 1.3, 1.299, 1.31, ?, ?, 1, 60, ?, 'target', 10)`).run(iso(T0), iso(T0), iso(now))
  const r = refusalCostReport(db, { days: 7, now })
  assert.equal(r.total.scored, 2, 'total keeps every row')
  assert.equal(r.known.scored, 1); assert.equal(r.known.sumR, 1)
  assert.equal(r.legacy.scored, 1); assert.equal(r.legacy.sumR, 10)
  assert.deepEqual(r.byUnit, { gate: 1, proposal: 0, legacy: 1 })

  // The goal: known rows only, the legacy count named in the note. One scored
  // row is under the 20 floor, so the verdict is not_measurable — and the
  // legacy row must not be what makes it measurable.
  const { goalTable } = await import('./goal-table.js')
  const table = await goalTable(db, { now })
  const g = table.goals.find(x => x.id === 'refusal_cost')
  assert.ok(g, 'the goal exists')
  assert.equal(g.verdict, 'not_measurable')
  assert.match(g.note, /1 scored refusal\(s\) in the gate's stop unit/)
  assert.match(g.note, /1 older row\(s\) in an unknown stop unit left out/)
})
