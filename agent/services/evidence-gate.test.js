// node --test agent/services/evidence-gate.test.js
//
// The strategy-level evidence gate (owner "build it", 03-09-2026). Pinned:
// a hand-pinned demo or live arm passes on the owner's word; a record that
// clears the pre-registered bar passes on evidence; everything else is a
// shadow refusal that keeps the full proposal; off means off; the report
// reads the same verdicts; and loop.js runs the gate before both dispatch
// paths and persists the refusal as a risk event.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from '../db.js'
import { setStage } from './stage-matrix.js'
import { evidenceGate, evidenceRecord, evidenceGateReport, evidenceGateConfig, EVIDENCE_GATE_KEY, EVIDENCE_GATE_DEFAULTS } from './evidence-gate.js'

const DEMO = '111', LIVE = '222'
function fresh() {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${DEMO}','1',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${LIVE}','2',1,1,'active')`).run()
  return db
}
function closes(db, strategy, n, winPct, { accountId = DEMO, origin = 'bot_market_dispatch', ageDays = 1 } = {}) {
  const wins = Math.round(n * winPct / 100)
  const ins = db.prepare(`INSERT INTO trades (symbol, side, status, label_strategy, net_pnl, closed_at, account_id, origin) VALUES ('EURUSD','BUY','closed',?,?,datetime('now', ?),?,?)`)
  for (let i = 0; i < n; i++) ins.run(strategy, i < wins ? 30 : -10, `-${ageDays} days`, accountId, origin)
}

test('defaults: on at the pre-registered bar; config repairs nonsense', () => {
  assert.deepEqual({ ...EVIDENCE_GATE_DEFAULTS }, { on: true, minCloses: 30, minPf: 1.5, windowDays: 90 })
  const c = evidenceGateConfig({ minCloses: 'x', minPf: 99, windowDays: 0 })
  assert.deepEqual(c, { on: true, minCloses: 30, minPf: 10, windowDays: 1 })
  assert.equal(evidenceGateConfig({ on: false }).on, false)
})

test('a hand-pinned arm passes on the owner\'s word, demo or live, with no record at all', () => {
  const db = fresh()
  const io = { getState, setState }
  setStage(db, { kind: 'strategy', key: 'rsi2_reversion', stage: 'trade', on: true, accountId: DEMO }, io)
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: true, accountId: LIVE }, io)
  assert.deepEqual(evidenceGate(db, { strategy: 'rsi2_reversion', accountId: DEMO }).via, 'pinned')
  assert.equal(evidenceGate(db, { strategy: 'tsmom_long', accountId: LIVE }).allowed, true)
  // The global list is NOT a pin: an account inheriting it is gated on record.
  setState(db, 'enabled_strategies_json', JSON.stringify(['ema_pullback']))
  const v = evidenceGate(db, { strategy: 'ema_pullback', accountId: DEMO })
  assert.equal(v.allowed, false)
  assert.equal(v.via, 'shadow')
  assert.match(v.reason, /ema_pullback on …111: 0\/30 closes, PF 0 \(bar 1\.5\); not hand-pinned — logged as shadow/)
})

test('a record that clears the bar passes on evidence; one short of it is a shadow; the window and account scope apply', () => {
  const db = fresh()
  closes(db, 'donchian_breakout', 29, 60)
  let v = evidenceGate(db, { strategy: 'donchian_breakout', accountId: DEMO })
  assert.equal(v.allowed, false)
  assert.equal(v.record.closes, 29)
  closes(db, 'donchian_breakout', 1, 100)
  v = evidenceGate(db, { strategy: 'donchian_breakout', accountId: DEMO })
  assert.equal(v.allowed, true)
  assert.equal(v.via, 'record')
  assert.equal(v.record.closes, 30)
  assert.ok(v.record.profitFactor >= 1.5)
  // The other account has no record of its own: shadow there.
  assert.equal(evidenceGate(db, { strategy: 'donchian_breakout', accountId: LIVE }).allowed, false)
  // Unscoped legacy rows count for every account.
  closes(db, 'vwap_trend', 30, 60, { accountId: null })
  assert.equal(evidenceGate(db, { strategy: 'vwap_trend', accountId: LIVE }).via, 'record')
  // Probes and non-bot origins never make a record.
  closes(db, 'va_breakout', 30, 60, { origin: 'reconciler_adopted' })
  assert.equal(evidenceRecord(db, { strategy: 'va_breakout', accountId: DEMO }).closes, 0)
  // Outside the window the record is gone.
  closes(db, 'vp_value', 30, 60, { ageDays: 120 })
  assert.equal(evidenceGate(db, { strategy: 'vp_value', accountId: DEMO }).allowed, false)
  // A bad PF with enough closes is still a shadow.
  closes(db, 'fib_confluence', 30, 20)
  const bad = evidenceGate(db, { strategy: 'fib_confluence', accountId: DEMO })
  assert.equal(bad.allowed, false)
  assert.ok(bad.record.profitFactor < 1.5)
})

test('off means off; an unlabelled proposal is refused', () => {
  const db = fresh()
  assert.equal(evidenceGate(db, { strategy: null, accountId: DEMO }).via, 'unlabelled')
  setState(db, EVIDENCE_GATE_KEY, JSON.stringify({ on: false }))
  assert.deepEqual(evidenceGate(db, { strategy: 'fib_confluence', accountId: DEMO }).via, 'off')
})

test('the report reads the same verdicts per strategy × account and counts shadow refusals', () => {
  const db = fresh()
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, proposal_json, account_id, created_at) VALUES ('EURUSD','BUY',0,'evidence_gate: x',?,?,datetime('now'))`).run(JSON.stringify({ strategy: 'ema_pullback' }), DEMO)
  const r = evidenceGateReport(db)
  assert.equal(r.reportOnly, true)
  assert.deepEqual(r.accounts, [DEMO, LIVE])
  assert.equal(r.strategies.tsmom_long[DEMO].via, 'pinned')
  assert.equal(r.strategies.tsmom_long[LIVE].via, 'shadow')
  assert.equal(r.strategies.tsmom_long[LIVE].live, true)
  assert.equal(r.strategies.ema_pullback[DEMO].shadowRefusals7d, 1)
})

test('wiring pins: loop.js runs the gate after the market-hours gate, before the limit branch and the risk gate, and records the refusal as a SKIP, not a veto (PR-C; comments stripped)', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  const gate = src.indexOf("import('./services/evidence-gate.js')")
  assert.ok(gate > 0)
  assert.ok(src.indexOf("mkt_closed_logged_${symbol}`, null)") < gate, 'after the market-hours gate')
  assert.ok(gate < src.indexOf('htfLimitDispatch'), 'before the limit branch')
  assert.ok(gate < src.indexOf('const riskResult = evaluateTrade(db, proposal, riskCfg)'), 'before the risk gate')
  const block = src.slice(gate, gate + 1400)
  // PR-C: the refusal is a decision_log skip carrying the proposal (services/
  // gate-skips.js), no longer a risk_events veto counted in every veto total.
  assert.ok(block.includes('recordEvidenceShadow(db, { symbol, side, synth, accountId'))
  assert.ok(!block.includes('persistRiskEvent('), 'the evidence gate must not write a risk_events veto')
  assert.ok(block.includes('return null'))
})

// V3 Q4b (PR-B1): the record carries PF in R (r-net-v1) beside the money PF
// (usd-net-v0), each labelled — and the GATE still judges money. The two
// fixtures below disagree on purpose, so a gate that started reading R would
// flip both verdicts.
function closesRAndMoney(db, strategy, { winR, lossR, winUsd, lossUsd, n = 30, accountId = DEMO } = {}) {
  const ins = db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, status, label_strategy, realised_rr, net_pnl, gross_pnl, closed_at, account_id, origin)
                          VALUES ('EURUSD','BUY',1.1,1.1,1.09,'closed',?,?,?,?,datetime('now','-1 days'),?,'bot_market_dispatch')`)
  for (let i = 0; i < n; i++) {
    const win = i % 2 === 0
    const usd = win ? winUsd : -lossUsd
    ins.run(strategy, win ? winR : -lossR, usd, usd, accountId)
  }
}

test('PF in R is reported beside the money PF, labelled; the gate judges the money PF only (Q4b: nothing gates on R)', () => {
  const db = fresh()
  // R reads 2.0, money reads 0.5 → the gate refuses on money.
  closesRAndMoney(db, 'vwap_trend', { winR: 2, lossR: 1, winUsd: 10, lossUsd: 20 })
  const rec = evidenceRecord(db, { strategy: 'vwap_trend', accountId: DEMO })
  assert.equal(rec.profitFactor, 0.5)
  assert.equal(rec.profitFactorR, 2)
  assert.deepEqual(rec.metrics, { profitFactor: 'usd-net-v0', profitFactorR: 'r-net-v1' })
  assert.equal(evidenceGate(db, { strategy: 'vwap_trend', accountId: DEMO }).via, 'shadow', 'RED if the gate reads PF in R (2.0 would clear 1.5)')
  // R reads 1.0, money reads 3.0 → the gate admits on money.
  closesRAndMoney(db, 'va_breakout', { winR: 1, lossR: 1, winUsd: 30, lossUsd: 10 })
  const rec2 = evidenceRecord(db, { strategy: 'va_breakout', accountId: DEMO })
  assert.equal(rec2.profitFactor, 3); assert.equal(rec2.profitFactorR, 1)
  assert.equal(evidenceGate(db, { strategy: 'va_breakout', accountId: DEMO }).via, 'record')
})

test('evidenceRecord: an explicit `now` reads the same window SQLite\'s clock does, and a row with no R is counted, not scored', () => {
  const db = fresh()
  closes(db, 'ema_pullback', 5, 60) // no prices on these rows → no R
  const a = evidenceRecord(db, { strategy: 'ema_pullback', accountId: DEMO })
  const b = evidenceRecord(db, { strategy: 'ema_pullback', accountId: DEMO, now: Date.now() })
  assert.deepEqual(b, a)
  assert.equal(a.closes, 5)
  assert.equal(a.rScored, 0); assert.equal(a.rUnscorable, 5); assert.equal(a.profitFactorR, null)
  // 200 days on, the rows are outside the 90-day window.
  assert.equal(evidenceRecord(db, { strategy: 'ema_pullback', accountId: DEMO, now: Date.now() + 200 * 86_400_000 }).closes, 0)
})
