// node --test agent/services/fast-monitor-no-observer.test.js
//
// The MAE/Chandelier observer was REMOVED 03-10-2026 (owner: "remove all
// three"; measured: since 02-10 it never produced a usable reading in
// production — /state/mae-chandelier at 06:25Z 03-10: positions 1, withBars 0,
// adjustable 0, receipts 0 — while its bar fetch added broker calls on every
// tick and it was a third stop authority beside the stop policy and the
// keeper). This pins the removal two ways:
//
// 1. Behaviour: the scenario the deleted send test used (a stop below where
//    the since-entry level would have been, HOLD verdict) is driven through
//    runFastMonitor by the M7 simulator and produces NO action with source
//    mae_chandelier / mae_chandelier_timeframe, while the position is still
//    evaluated every tick. Mutation: re-adding an executeBrokerAction call with
//    source 'mae_chandelier' on the HOLD path turns the first test red.
// 2. Source: fast-monitor.js and loop.js name neither the source nor the
//    observer's trendbar purpose (comments stripped first — CLAUDE.md rule 2:
//    a test must not pass by matching its own comment), and the only place
//    the retired state key appears is the boot cleanup that deletes it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runScenario } from '../test-support/fast-monitor-sim.js'

const T0 = Date.parse('2026-10-03T10:00:00Z')
const SYMBOL_ID = 7

// +0.3R: the exit ladder reads HOLD. The deleted observer would have tightened
// the 1.0950 stop to ≈1.0990 here (ATR ≈ 0.0010, entry 1.1000, price 1.1015).
function climbingBars() {
  return Array.from({ length: 40 }, (_, i) => { const c = 1.0835 + i * 0.00046; return { h: c + 0.0005, l: c - 0.0005, c } })
}

function scenario({ sl }) {
  // The quote moves a pip-fraction each tick (an unchanged quote is not
  // re-evaluated), staying at +0.3R so every verdict is a HOLD.
  const quoteAt = t => { const w = (Math.floor((t - T0) / 3_000) % 3) * 0.00001; return { bid: 1.1014 + w, ask: 1.1016 + w } }
  return {
    startMs: T0, durationMs: 30_000, tickMs: 3_000,
    symbolMap: { EURUSD: SYMBOL_ID },
    overrides: { EURUSD: 0.05 }, // re-check every 3 s (the default cadence is 30-90 s)
    positions: [{ id: 1, symbol: 'EURUSD', side: 'BUY', entry: 1.1000, sl, tp: null, risk: 0.0050 }],
    sidecar: t => ({ [SYMBOL_ID]: quoteAt(t) }),
    broker: (_id, t) => ({ kind: 'quote', ...quoteAt(t), latencyMs: 50 }),
    bars: () => climbingBars(),
  }
}

test('a stop below where the since-entry Chandelier level would have been is NOT tightened: no observer action, position still evaluated', async () => {
  const run = await runScenario('branch', scenario({ sl: 1.0950 }))
  const observer = run.obs.actions.filter(a => a.source === 'mae_chandelier' || a.source === 'mae_chandelier_timeframe')
  assert.deepEqual(observer, [], `the observer is gone, got ${JSON.stringify(run.obs.actions)}`)
  assert.deepEqual(run.obs.actions, [], `a HOLD sends nothing at all, got ${JSON.stringify(run.obs.actions)}`)
  assert.ok(run.obs.evaluations.filter(e => e.id === 1).length >= 3, `the position was evaluated every tick, got ${run.obs.evaluations.length} evaluations`)
  assert.ok(run.obs.checks.some(c => c.id === 1 && c.action === 'FAST:HOLD'), 'the HOLD verdict is still recorded on the row')
  assert.equal(run.obs.passes.filter(p => p.error).length, 0, 'no pass threw')
})

// ---------------------------------------------------------------------------
// Source pins.
// ---------------------------------------------------------------------------
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
const read = rel => stripComments(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'))

test('fast-monitor.js and loop.js carry neither the observer source nor its trendbar fetch', () => {
  for (const rel of ['services/fast-monitor.js', 'loop.js']) {
    const src = read(rel)
    assert.ok(src.includes('executeBrokerAction('), `${rel}: the scan found no executeBrokerAction( at all — a broken scan would pass on nothing`)
    assert.doesNotMatch(src, /mae_chandelier/, `${rel}: an action with source mae_chandelier`)
    assert.doesNotMatch(src, /maeChandelierTick|decideAdjust|recordObserve|recordAmendReceipt/, `${rel}: observer wiring`)
    assert.doesNotMatch(src, /mae-chandelier-observe/, `${rel}: imports the observer module or fetches bars for it`)
  }
  const fm = read('services/fast-monitor.js')
  const fetches = fm.match(/wsGetTrendbarsBatch\(/g) || []
  assert.ok(fetches.length >= 1, 'the relative-volume fetch is still there (the scan sees the call)')
  assert.doesNotMatch(fm, /wsGetTrendbarsBatch\([^)]*mae-chandelier-observe/, 'no trendbar fetch for the observer')
})

test('the retired state key is written nowhere; the boot cleanup is the only reader and it deletes', () => {
  const root = new URL('..', import.meta.url).pathname
  const files = []
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(m?js)$/.test(name) && !/\.test\.m?js$/.test(name)) files.push(p)
    }
  }
  walk(root)
  assert.ok(files.length > 50, `the walk found only ${files.length} source files`)
  const hits = files.filter(f => stripComments(readFileSync(f, 'utf8')).includes('mae_chandelier_observe_json'))
  assert.deepEqual(hits.map(f => f.slice(root.length)), ['index.js'], 'the key survives only in the boot cleanup')
  const idx = stripComments(readFileSync(join(root, 'index.js'), 'utf8'))
  assert.match(idx, /DELETE FROM agent_state WHERE key = \?'\)\.run\('mae_chandelier_observe_json'\)/, 'the boot cleanup deletes the key')
  assert.doesNotMatch(idx, /setState\([^)]*mae_chandelier_observe_json/, 'nothing writes the key back')
  for (const f of files) {
    assert.doesNotMatch(stripComments(readFileSync(f, 'utf8')), /OBSERVE_STATE_KEY/, `${f.slice(root.length)}: the observer's key constant`)
  }
})
