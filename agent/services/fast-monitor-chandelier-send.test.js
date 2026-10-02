// node --test agent/services/fast-monitor-chandelier-send.test.js
//
// The fast monitor's Chandelier reading SENDS a stop amend (02-10-2026,
// № 10,474: "it should trigger adjustment for stop-loss. verify"). Driven
// through runFastMonitor's public entry point by the M7 simulator with a
// fake executor, so the assertion is on the action handed to the broker
// path, not on a pure function. Mutation (checked by hand, 02-10): removing
// the maeChandelierTick call leaves obs.actions without a mae_chandelier
// entry and the first test is red.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runScenario } from '../test-support/fast-monitor-sim.js'
import { storeBars } from './mae-chandelier-observe.js'

const T0 = Date.parse('2026-10-02T10:00:00Z')
const SYMBOL_ID = 7

// The position sits at +0.3R, which the exit ladder reads as HOLD (the
// Chandelier tick runs only after a HOLD verdict). 40 hourly bars climbing
// to 1.1015 with a 0.0010 range → ATR ≈ 0.0010 and a since-entry level ≈
// 1.1020 − 0.0030 = 1.0990: above the 1.0950 stop, below the 1.1015 price.
function climbingBars() {
  return Array.from({ length: 40 }, (_, i) => { const c = 1.0835 + i * 0.00046; return { h: c + 0.0005, l: c - 0.0005, c } })
}

function scenario({ sl }) {
  const quote = { bid: 1.1014, ask: 1.1016 }
  return {
    startMs: T0, durationMs: 12_000, tickMs: 3_000,
    symbolMap: { EURUSD: SYMBOL_ID },
    positions: [{ id: 1, symbol: 'EURUSD', side: 'BUY', entry: 1.1000, sl, tp: null, risk: 0.0050 }],
    sidecar: () => ({ [SYMBOL_ID]: quote }),
    broker: () => ({ kind: 'quote', ...quote, latencyMs: 50 }),
    bars: () => [],
  }
}

test('a stop below the since-entry Chandelier level is tightened through the broker path (MOVE_SL, source mae_chandelier)', async () => {
  storeBars(SYMBOL_ID, climbingBars())
  const run = await runScenario('branch', scenario({ sl: 1.0950 }))
  const sends = run.obs.actions.filter(a => a.source === 'mae_chandelier')
  assert.ok(sends.length >= 1, `expected a mae_chandelier action, got ${JSON.stringify(run.obs.actions)}`)
  assert.equal(sends[0].action, 'MOVE_SL')
  assert.equal(sends[0].reason, 'mae_chandelier_since_entry_tighten')
  assert.equal(sends[0].id, 1)
  assert.ok(run.obs.actions.every(a => a.source === 'mae_chandelier'), `only the Chandelier acted, got ${JSON.stringify(run.obs.actions)}`)
})

test('a stop already above the level is left alone', async () => {
  storeBars(SYMBOL_ID, climbingBars())
  const run = await runScenario('branch', scenario({ sl: 1.1005 }))
  assert.deepEqual(run.obs.actions.filter(a => a.source === 'mae_chandelier'), [])
  assert.ok(run.obs.evaluations.length > 0, 'the position was evaluated')
})
