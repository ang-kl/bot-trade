// node --test agent/services/housekeeping-run.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runHousekeepingSteps, changesOf } from './housekeeping-run.js'

test('a throwing step does NOT cancel the steps after it — the 55,443 case', async () => {
  // THE REGRESSION. In loop.js the retention deletes ran unguarded ahead of the
  // disposition sweep, so one failing delete skipped the sweep — and because
  // the 8-hour schedule stamp is written before the work, it stayed skipped
  // until the next window. Production showed 55,443 approvals with no terminal
  // state after the cadence fix had already deployed.
  const ran = []
  const r = await runHousekeepingSteps([
    { name: 'prune-scans', run: () => { ran.push('prune-scans'); return { changes: 3 } } },
    { name: 'prune-operational', run: () => { throw new Error('database is locked') } },
    { name: 'disposition-sweep', run: () => { ran.push('disposition-sweep'); return { written: 5000 } } },
  ])

  assert.deepEqual(ran, ['prune-scans', 'disposition-sweep'])
  assert.equal(r.ran, 2)
  assert.deepEqual(r.failed, [{ name: 'prune-operational', message: 'database is locked' }])
  assert.equal(r.results['disposition-sweep'].written, 5000)
})

test('an async step that rejects is isolated the same way', async () => {
  const r = await runHousekeepingSteps([
    { name: 'a', run: async () => { throw new Error('boom') } },
    { name: 'b', run: async () => 'done' },
  ])
  assert.equal(r.results.b, 'done')
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0].name, 'a')
})

test('failures are reported to the log, once each, by name', async () => {
  const lines = []
  await runHousekeepingSteps(
    [{ name: 'prune-trades', run: () => { throw new Error('no such table: trades') } }],
    { log: (m) => lines.push(m) },
  )
  assert.equal(lines.length, 1)
  assert.match(lines[0], /prune-trades/)
  assert.match(lines[0], /no such table: trades/)
})

test('a non-Error throw still names the step', async () => {
  const r = await runHousekeepingSteps([{ name: 's', run: () => { throw 'plain string' } }])
  assert.deepEqual(r.failed, [{ name: 's', message: 'plain string' }])
})

test('malformed step entries are skipped, not thrown over', async () => {
  const r = await runHousekeepingSteps([null, {}, { name: 'ok', run: () => 1 }])
  assert.equal(r.ran, 1)
  assert.equal(r.results.ok, 1)
})

test('changesOf keeps the summary honest when a delete never happened', () => {
  assert.equal(changesOf({ changes: 7 }), 7)
  assert.equal(changesOf(undefined), 0)   // the step failed — 0, not "undefined"
  assert.equal(changesOf(null), 0)
  assert.equal(changesOf({}), 0)
})
