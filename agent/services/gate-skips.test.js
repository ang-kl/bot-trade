// node --test agent/services/gate-skips.test.js
//
// PR-C: the regime gate and the evidence gate are upstream refusals and are
// recorded as decision_log SKIPS, never risk_events vetoes. The loop pins
// prove the call sites; the evidence-gate report proves the moved number
// survives the move.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { recordRegimeBlock, recordEvidenceShadow, REGIME_BLOCK_STAGE, EVIDENCE_GATE_STAGE } from './gate-skips.js'
import { evidenceGateReport } from './evidence-gate.js'

const A = '33330001'
const riskRows = (db) => db.prepare(`SELECT COUNT(*) AS n FROM risk_events`).get().n
const decisions = (db, stage) => db.prepare(`SELECT * FROM decision_log WHERE stage = ? ORDER BY id`).all(stage)

test('a regime block writes ONE decision_log skip and NO risk_event', () => {
  const db = initDB(':memory:')
  recordRegimeBlock(db, {
    symbol: 'NAS100', synth: { strategy: 'rsi_meanrev', consensus_bias: 'short', timeframe: '1h', entry: 100 },
    signal: { entry: 101 }, reason: 'regime_block meanrev-in-volatile (rsi_meanrev): whipsaw blows through fade levels', loopId: 12,
  })
  assert.equal(riskRows(db), 0)
  const d = decisions(db, REGIME_BLOCK_STAGE)
  assert.equal(d.length, 1)
  assert.equal(d[0].decision, 'skip')
  assert.equal(d[0].symbol, 'NAS100')
  assert.equal(d[0].strategy, 'rsi_meanrev')
  assert.equal(d[0].loop_id, 12)
  assert.match(d[0].reason, /^regime_block meanrev-in-volatile/)
  const detail = JSON.parse(d[0].detail_json)
  assert.equal(detail.side, 'SELL')
  assert.equal(detail.entry, 101)
})

test('an evidence-gate refusal writes a skip carrying the full proposal (its shadow record) and no risk_event', () => {
  const db = initDB(':memory:')
  recordEvidenceShadow(db, {
    symbol: 'EURUSD', side: 'BUY', accountId: A, requestedVolume: 0.2,
    synth: { strategy: 'vwap_trend', timeframe: '4h', entry: 1.1, sl: 1.097, tp1: 1.11, tp2: 1.12, overall_conviction: 8 },
    gate: { via: 'shadow', record: { closes: 3, profitFactor: null }, bar: { minCloses: 30, minPf: 1.5 }, reason: 'vwap_trend on …0001: 3/30 closes' },
    loopId: 4,
  })
  assert.equal(riskRows(db), 0)
  const d = decisions(db, EVIDENCE_GATE_STAGE)
  assert.equal(d.length, 1)
  assert.equal(d[0].account_id, A)
  assert.equal(d[0].reason, 'evidence_gate: vwap_trend on …0001: 3/30 closes')
  const detail = JSON.parse(d[0].detail_json)
  assert.equal(detail.via, 'shadow')
  assert.deepEqual(detail.proposal, {
    symbol: 'EURUSD', side: 'BUY', entry: 1.1, sl: 1.097, tp1: 1.11, tp2: 1.12,
    requestedVolume: 0.2, strategy: 'vwap_trend', timeframe: '4h', conviction: 8, source: 'auto_signal', accountId: A,
  })
})

test('evidenceGateReport counts the moved rows: decision_log skips plus legacy risk_events rows (repeat_count summed)', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')`).run(A, A)
  setState(db, 'ctrader_account_id', A)
  for (let i = 0; i < 2; i++) {
    recordEvidenceShadow(db, { symbol: 'EURUSD', side: 'BUY', accountId: A, synth: { strategy: 'vwap_trend' }, gate: { reason: 'thin' } })
  }
  // A pre-PR-C row, merged three times.
  db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, proposal_json, account_id, repeat_count)
              VALUES ('EURUSD', 'BUY', 0, 'evidence_gate: thin', '{"strategy":"vwap_trend"}', ?, 3)`).run(A)
  const r = evidenceGateReport(db)
  assert.equal(r.strategies.vwap_trend[A].shadowRefusals7d, 5)
  assert.equal(r.strategies.ema_pullback[A].shadowRefusals7d, 0)
})

test('loop wiring (comments stripped): the regime block calls recordRegimeBlock and neither block calls persistRiskEvent', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const rg = src.indexOf('const rg = checkRegimeGate(db, synth.strategy, synth.consensus_bias, sym)')
  assert.ok(rg > 0)
  const block = src.slice(rg, src.indexOf('synth.auto_trade = false', rg))
  assert.ok(block.includes('recordRegimeBlock(db, { symbol: sym, synth, signal, reason: rg.reason'))
  assert.ok(!block.includes('persistRiskEvent('), 'the regime block must not write a risk_events veto')
  const eg = src.indexOf("import('./services/evidence-gate.js')")
  const egBlock = src.slice(eg, src.indexOf('return null', eg))
  assert.ok(egBlock.includes('recordEvidenceShadow(db, {'))
  assert.ok(!egBlock.includes('persistRiskEvent('), 'the evidence gate must not write a risk_events veto')
})

// W2 (Claude · № 13,356 12-Oct, ordered № 13,345; claude-builder): a regime
// refusal records the refused proposal's stop, targets and conviction so it
// can be scored later. Through the real recorder and real SQLite.
import { regimeBlocks } from './theory-gap.js'

const REASON = 'regime_block trend-against-trend (donchian_breakout): x'

test('W2: a regime block carries the proposal\'s sl, tp1, tp2 and conviction', () => {
  const db = initDB(':memory:')
  recordRegimeBlock(db, {
    symbol: 'US500', synth: { strategy: 'donchian_breakout', timeframe: '1h', consensus_bias: 'long', entry: 100, sl: 97, tp1: 109, tp2: 112, overall_conviction: 8 },
    signal: { entry: 100, sl: 97, tp1: 109, tp2: 112, conviction: 8 }, reason: REASON, loopId: 1,
  })
  const detail = JSON.parse(decisions(db, REGIME_BLOCK_STAGE)[0].detail_json)
  assert.deepEqual(detail, { bias: 'long', side: 'BUY', entry: 100, sl: 97, tp1: 109, tp2: 112, conviction: 8 })
})

test('W2: a missing value is recorded as null, never guessed', () => {
  const db = initDB(':memory:')
  recordRegimeBlock(db, { symbol: 'US500', synth: { strategy: 'donchian_breakout', consensus_bias: 'long', entry: 100 }, signal: null, reason: REASON })
  const detail = JSON.parse(decisions(db, REGIME_BLOCK_STAGE)[0].detail_json)
  for (const k of ['sl', 'tp1', 'tp2', 'conviction']) {
    assert.ok(Object.hasOwn(detail, k), `${k} is written`)
    assert.equal(detail[k], null, `${k} is null`)
  }
  // A conviction of 0 is a value, not a missing one.
  recordRegimeBlock(db, { symbol: 'US500', synth: { strategy: 'x', consensus_bias: 'long', overall_conviction: 0 }, reason: REASON })
  assert.equal(JSON.parse(decisions(db, REGIME_BLOCK_STAGE)[1].detail_json).conviction, 0)
})

test('W2: the signal fills a value the synth lacks', () => {
  const db = initDB(':memory:')
  recordRegimeBlock(db, { symbol: 'US500', synth: { strategy: 'x', consensus_bias: 'long' }, signal: { entry: 100, sl: 96, tp1: 110, tp2: 115, conviction: 7 }, reason: REASON })
  const detail = JSON.parse(decisions(db, REGIME_BLOCK_STAGE)[0].detail_json)
  assert.deepEqual([detail.sl, detail.tp1, detail.tp2, detail.conviction], [96, 110, 115, 7])
})

test('W2: after a direction override mirrored the synth, the record keeps the synth\'s side AND its geometry', () => {
  const db = initDB(':memory:')
  // The signal was a long (stop 97 below entry); the watchlist override made
  // it a short and mirrored the stop to 103 above entry (loop.js). The record's
  // side is SELL, so its stop must be 103, not the long's 97.
  recordRegimeBlock(db, {
    symbol: 'US500', synth: { strategy: 'x', consensus_bias: 'short', entry: 100, sl: 103, tp1: 91, tp2: 88, overall_conviction: 8 },
    signal: { entry: 100, sl: 97, tp1: 109, tp2: 112, conviction: 8 }, reason: REASON,
  })
  const detail = JSON.parse(decisions(db, REGIME_BLOCK_STAGE)[0].detail_json)
  assert.equal(detail.side, 'SELL')
  assert.deepEqual([detail.sl, detail.tp1, detail.tp2], [103, 91, 88])
})

test('W2: the regime-blocks report counts the captured fields from rows the recorder wrote', () => {
  const db = initDB(':memory:')
  recordRegimeBlock(db, { symbol: 'A', synth: { strategy: 'donchian_breakout', timeframe: '1h', consensus_bias: 'long', entry: 100, sl: 97, tp1: 109, overall_conviction: 8 }, reason: REASON })
  recordRegimeBlock(db, { symbol: 'B', synth: { strategy: 'donchian_breakout', timeframe: '1h', consensus_bias: 'long', entry: 50 }, reason: REASON })
  const out = regimeBlocks(db, { days: 30 })
  assert.deepEqual(out.capture, { entryKnown: 2, stopKnown: 1, targetKnown: 1, convictionKnown: 1, scorable: 1 })
})

test('W2 (Codex P2 on #1325): scorable counts rows that EACH carry a stop and a target; tp2 alone is a target', () => {
  const db = initDB(':memory:')
  // One stop-only row and one target-only row: neither is scorable.
  recordRegimeBlock(db, { symbol: 'A', synth: { strategy: 'x', consensus_bias: 'long', sl: 97 }, reason: REASON })
  recordRegimeBlock(db, { symbol: 'B', synth: { strategy: 'x', consensus_bias: 'long', tp1: 110 }, reason: REASON })
  assert.deepEqual(regimeBlocks(db, { days: 30 }).capture, { entryKnown: 0, stopKnown: 1, targetKnown: 1, convictionKnown: 0, scorable: 0 })
  // A stop with only tp2 is scorable.
  recordRegimeBlock(db, { symbol: 'C', synth: { strategy: 'x', consensus_bias: 'long', sl: 97, tp2: 115 }, reason: REASON })
  assert.deepEqual(regimeBlocks(db, { days: 30 }).capture, { entryKnown: 0, stopKnown: 2, targetKnown: 2, convictionKnown: 0, scorable: 1 })
})
