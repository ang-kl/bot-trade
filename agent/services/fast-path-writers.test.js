// node --test agent/services/fast-path-writers.test.js
//
// ONE WRITER, ON A TIMER THAT DOES NOT DEPEND ON THE SCAN CYCLE.
//
// Operating Goal Plan §70.7: "Ensure the five-minute strategy loop is never
// the sole position protector." Trade guards and the Profit Keeper move stops
// and close positions, and both used to run inside the 5-minute cycle — so
// break-even moves, trailing and profit locks stopped whenever a scan ran
// long, which is exactly when a fast market makes them matter.
//
// They were MOVED, not copied. §36.2.3: "Two components must not unknowingly
// write the same stop." The protection audit reads only and therefore runs on
// both paths deliberately; an ACTING layer must have exactly one writer, and
// the test that matters is that the loop no longer calls these.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { withBudget } from './fast-monitor.js'
import { CONTROLLERS } from './heartbeat.js'

const loopSrc = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
const fastSrc = readFileSync(new URL('./fast-monitor.js', import.meta.url), 'utf8')

test('the loop no longer invokes the acting layers — one writer, not two', () => {
  for (const fn of ['runTradeGuards', 'runProfitKeeper', 'runLossGuardian']) {
    assert.equal(loopSrc.includes(`${fn}(db,`), false,
      `loop.js still calls ${fn} — two components would write the same stop (§36.2.3)`)
  }
})

test('the fast monitor does invoke them, and budgets each pass', () => {
  for (const fn of ['runTradeGuards', 'runProfitKeeper', 'runLossGuardian']) {
    assert.ok(fastSrc.includes(fn), `fast-monitor.js must call ${fn}`)
  }
  assert.ok(/withBudget\(job\.key/.test(fastSrc), 'each job runs under a budget')
})

test('their heartbeat expectation is FIXED, not derived from the loop', () => {
  // A threshold computed from observed loop cadence stretches as the loop
  // degrades — the alarm quietly follows the failure it exists to catch.
  for (const key of ['trade_guards', 'profit_keeper', 'protection_audit', 'loss_guardian']) {
    const def = CONTROLLERS[key]
    assert.equal(def.tiedToLoop, undefined, `${key} must not be loop-tied any more`)
    assert.equal(def.expectedSec, 60, `${key} expects its own 60s cadence`)
  }
})

test('withBudget returns the value when the work finishes in time', async () => {
  const r = await withBudget('quick', 1000, async () => ({ slMoves: 2 }))
  assert.deepEqual(r.value, { slMoves: 2 })
  assert.equal(r.timedOut, undefined)
})

test('withBudget surfaces a throw as an error rather than a timeout', async () => {
  const r = await withBudget('boom', 1000, async () => { throw new Error('broker said no') })
  assert.match(r.error.message, /broker said no/)
  assert.equal(r.timedOut, undefined)
})

test('a hung pass abandons the WAIT so the ticker keeps its cadence', async () => {
  // The work is not cancelled — it finishes detached and its writes are
  // idempotent. What must not happen is the tick blocking, because
  // tickRunning would then skip the 3-second ticks spike protection needs.
  let settled = false
  let finish
  const work = new Promise(resolve => { finish = resolve })
  const started = Date.now()
  const r = await withBudget('hang', 60, () => work.then(v => { settled = true; return v }))

  assert.equal(r.timedOut, true)
  assert.match(r.error.message, /budget/)
  assert.ok(Date.now() - started < 1500, 'returned promptly instead of waiting out the work')
  assert.equal(settled, false, 'and the work was left running, not cancelled')

  // Let the detached work complete, so the test does not leave a pending
  // promise behind. In production nothing awaits it — that is the point — and
  // its writes are idempotent.
  finish('late')
  await work
})

test('EVERY controller that beats a heartbeat is in the registry', () => {
  // loss_guardian beat `loss_guardian` on every loop cycle since it shipped and
  // was never in CONTROLLERS, so heartbeatView skipped it entirely: the one
  // writer whose job is to put a stop on a position that has NONE was the one
  // writer nobody could see running. A beat to an unregistered name is worse
  // than no beat — it looks like instrumentation and reports nothing.
  //
  // WIDENED 2026-08-04: this used to read loop.js and fast-monitor.js only,
  // which was every host there was — until §70.4's review got its own ticker.
  // A test that only knows two hosts stops catching the defect the moment a
  // third appears, so it now walks every service.
  const beaten = new Set()
  const dir = new URL('./', import.meta.url)
  const sources = [loopSrc, fastSrc, ...readdirSync(dir)
    .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map(f => readFileSync(new URL(f, dir), 'utf8'))]
  for (const src of sources) {
    for (const m of src.matchAll(/(?:hbeat|hb\.beat|beat)\(db,\s*'([a-z_]+)'/g)) beaten.add(m[1])
  }
  const missing = [...beaten].filter(k => !CONTROLLERS[k])
  assert.deepEqual(missing, [], `these controllers beat but are not registered: ${missing.join(', ')}`)
})
