// Claude · № 14,745 15-Oct (owner order § 14,741·A PR-1; claude-builder).
// Expected outcomes: the monitor's own parser (position-manager.js
// parsePriceTrigger accepts `price<X`/`price>X` only) and the trader's rule
// that a premise sits between the stop and the entry (§ 14,740·A).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { premiseFor, premiseTrigger, premiseTriggerForSignal, unreadablePremise, noPremise, isReadablePremise, premiseAtFill } from './premise.js'
import { _internal } from '../services/position-manager.js'

test('a premise inside the stop becomes a trigger the monitor parses; outside it is dropped with a reason', () => {
  assert.deepEqual(premiseFor({ bias: 'long', entry: 100, sl: 90, level: 95 }), { op: '<', price: 95 })
  assert.deepEqual(premiseFor({ bias: 'short', entry: 100, sl: 110, level: 104.123456 }), { op: '>', price: 104.12346 })
  assert.equal(premiseFor({ bias: 'long', entry: 100, sl: 90, level: 89 }), null, 'beyond the stop: the stop wins, not a premise')
  assert.equal(premiseFor({ bias: 'long', entry: 100, sl: 90, level: 101 }), null, 'profit side: a target, not a premise')
  assert.equal(premiseFor({ bias: 'long', entry: 100, sl: 90, level: 90 }), null, 'equal to the stop is not inside it')
  assert.equal(premiseFor({ bias: 'short', entry: 100, sl: 110, level: 99 }), null)
  assert.equal(premiseFor({ bias: 'long', entry: 100, sl: 90, level: NaN }), null)
  const t = premiseTrigger(premiseFor({ bias: 'long', entry: 1.1, sl: 1.09, level: 1.0950 }))
  assert.equal(t, 'price<1.095')
  const parsed = _internal.parsePriceTrigger(t)
  assert.ok(parsed, 'the monitor reads it')
  assert.equal(parsed.fired(1.0949), true)
  assert.equal(parsed.fired(1.0951), false)
  assert.equal(premiseTrigger(null), null)
  assert.equal(premiseTrigger({ op: '<', price: 0 }), null)
})

test('absent premises are recorded as reasons the monitor never acts on', () => {
  for (const raw of [unreadablePremise('vwap_trend'), unreadablePremise('outside stop'), noPremise('adopted'), 'Close beyond swing origin undefined', null, undefined]) {
    assert.equal(_internal.parsePriceTrigger(raw), null, `${raw} is not a trigger`)
    assert.equal(isReadablePremise(raw), false)
  }
  assert.equal(unreadablePremise('outside stop'), 'unreadable:outside_stop')
  assert.equal(noPremise('manual'), 'none_manual')
  assert.equal(isReadablePremise('price>1.2'), true)
  assert.equal(premiseTriggerForSignal({ strategy: 'vwap_trend', invalidation: { op: '<', price: 1.2 } }), 'price<1.2')
  assert.equal(premiseTriggerForSignal({ strategy: 'vwap_trend', invalidation: null, invalidation_reason: 'outside_stop' }), 'unreadable:outside_stop')
  assert.equal(premiseTriggerForSignal({ strategy: 'vwap_trend' }), 'unreadable:vwap_trend')
  assert.equal(premiseTriggerForSignal(null), 'unreadable:no_signal')
})

// Claude · № 14,758 15-Oct (Codex round 2 on #1374: the fill moves, the bracket
// re-anchors; the frozen premise must still sit inside the fill-anchored band).
test('premiseAtFill keeps a premise still inside the fill-anchored band, and records one the fill crossed or the stop passed', () => {
  // long, premise 1.095; signal entry 1.1, stop 1.09 (band 1.09 < 1.095 < 1.1)
  assert.equal(premiseAtFill({ trigger: 'price<1.095', bias: 'long', fill: 1.1002, sl: 1.0902 }), 'price<1.095', 'a small slip keeps it')
  assert.equal(premiseAtFill({ trigger: 'price<1.095', bias: 'long', fill: 1.0949, sl: 1.0849 }), 'unreadable:fill_outside_band', 'the fill crossed the premise')
  assert.equal(premiseAtFill({ trigger: 'price<1.095', bias: 'long', fill: 1.106, sl: 1.096 }), 'unreadable:fill_outside_band', 'the anchored stop passed the premise')
  // short mirror
  assert.equal(premiseAtFill({ trigger: 'price>1.105', bias: 'short', fill: 1.0998, sl: 1.1098 }), 'price>1.105')
  assert.equal(premiseAtFill({ trigger: 'price>1.105', bias: 'short', fill: 1.1051, sl: 1.1151 }), 'unreadable:fill_outside_band')
  // a side mismatch is never a premise; unreadable passes through; no fill known → the frozen premise stands
  assert.equal(premiseAtFill({ trigger: 'price<1.095', bias: 'short', fill: 1.1, sl: 1.11 }), 'unreadable:fill_outside_band')
  assert.equal(premiseAtFill({ trigger: 'none_manual', bias: 'long', fill: 1.1, sl: 1.09 }), 'none_manual')
  // № 14,793 (Codex round 5, one rule): no fill known → not armed, never the frozen premise
  assert.equal(premiseAtFill({ trigger: 'price<1.095', bias: 'long', fill: null, sl: 1.09 }), 'unreadable:fill_unknown')
  assert.equal(premiseAtFill({ trigger: 'price<1.095', bias: 'long', fill: 1.1, sl: null }), 'unreadable:fill_unknown')
  assert.equal(premiseAtFill({ trigger: 'price<1.095', bias: 'long', fill: 'abc', sl: 1.09 }), 'unreadable:fill_unknown')
  assert.equal(premiseAtFill({ trigger: null, bias: 'long', fill: 1.1, sl: 1.09 }), 'unreadable:unknown')
})

// The wiring: every market-fill writer re-checks at the fill (CLAUDE.md
// failure mode #4 — a repair nothing calls). Comments stripped before matching.
test('the auto fill, the manual order and the execute-trade writers all re-check the premise at the fill', async () => {
  const { readFileSync } = await import('node:fs')
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  const actions = strip(readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8'))
  // № 14,793 (Codex round 5, one rule): every writer hands the helper the FILL (executionPrice) — never entryP, never a market estimate
  assert.match(loop, /premiseAtFill\(\{ trigger: synth\.invalidation_trigger[^\n]*fill: executionPrice, sl: executionPrice != null \? slP : null \}\)/)
  // № 14,822 (PR-2): the manual order's fill-anchored stop is computed once (anchoredSl) for the premise and the initial-stop record
  assert.match(actions, /const anchoredSl = anchorBracketToFill\(\{ side, proposalEntry: entry, fill: executionPrice, sl: proposal\.sl, tp1: proposal\.tp1 \}\)\.sl/)
  assert.match(actions, /invalidationTrigger: premiseAtFill\(\{ trigger: premiseTrigger\(premise\)[^\n]*fill: executionPrice, sl: anchoredSl \}\)/)
  assert.match(actions, /invalidationTrigger: premiseAtFill\(\{ trigger: synth\.invalidation_trigger \|\| analysis\.invalidation_trigger[^\n]*fill: executionPrice, sl: slHeld \}\)/)
  assert.doesNotMatch(actions, /premiseAtFill\(\{[^\n]*fill: entryP/)
  assert.doesNotMatch(loop, /premiseAtFill\(\{[^\n]*fill: entryP/)
  // the manual order recovers its fill from the position before the premise is judged (round 5)
  assert.equal((actions.match(/confirmFill\(\(\) => wsReconcile\(/g) || []).length, 2, 'execute-trade and manual-order both confirm the fill')
})
