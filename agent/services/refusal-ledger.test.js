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
import { pendingRefusals, scoreRefusedOpportunities, refusalCostReport, horizonMinFor, evidenceShadowRefusals } from './refusal-ledger.js'
import { recordEvidenceShadow } from './gate-skips.js'

const T0 = Date.parse('2026-09-01T10:00:00Z')
const iso = (ms) => new Date(ms).toISOString()

// The opportunity key is derived from the previous evaluation of the same
// tuple (opportunity-identity.js), so rows are persisted at wall-clock time
// and backdated afterwards — the key groups them, the date sets the horizon.
function refuse(db, { symbol = 'EURUSD', side = 'BUY', entry = 1.1, sl = 1.095, tp = 1.11, reason = 'bad_rr 2.0<3', tf = '1h', at = T0, accountId = 'A1' } = {}) {
  const proposal = { symbol, side, entry, sl, tp1: tp, strategy: 'donchian_breakout', timeframe: tf, accountId }
  const id = persistRiskEvent(db, proposal, { approved: false, veto_reason: reason, checks: {} })
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
