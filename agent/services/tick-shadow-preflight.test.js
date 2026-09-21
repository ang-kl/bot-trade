import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function preflight(runtime) {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-preflight-'))
  try {
    const file = join(dir, 'status.json')
    writeFileSync(file, JSON.stringify({ runtime }))
    return spawnSync(process.execPath, ['scripts/tick-shadow-preflight.mjs', file], { encoding: 'utf8' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const snapshot = () => ({ at: new Date().toISOString(),
  sides: [{ service: 'cpp-acct', healthFresh: true, connected: true, tickBlock: 'unavailable' }],
  accounts: [{ accountId: '123', environment: 'live', enabled: true,
    entryMode: 'TIME_BASED', entryCounts: { unsent: 0, inFlight: 0, unknown: 0 },
    protection: { hasRun: true, ok: true, stale: false, naked: 0, targetless: 0, phantom: 0, unmatched: 0 } }],
})

test('restart preflight refuses unknown or missing intent state', () => {
  for (const entryCounts of [null, { unsent: 0, inFlight: 0, unknown: 1 }, { unsent: 0, inFlight: 1, unknown: 0 }]) {
    const runtime = snapshot()
    runtime.accounts[0].entryCounts = entryCounts
    const run = preflight(runtime)
    assert.equal(run.status, 1)
    assert.ok(JSON.parse(run.stdout).protectionBlockers.some(b => /intent/.test(b.reason)))
  }
})

test('preflight prepares a change but requires approval even with clean evidence', () => {
  const run = preflight(snapshot())
  assert.equal(run.status, 0, run.stderr)
  const plan = JSON.parse(run.stdout)
  assert.equal(plan.mode, 'PREPARE_ONLY')
  assert.equal(plan.approvalRequired, true)
  assert.equal(plan.change.variable, 'TICK_SPOOL_PATH')
})

test('preflight blocks targetless, stale and incomplete protection evidence', () => {
  const data = snapshot()
  data.accounts[0].protection.targetless = 3
  assert.equal(preflight(data).status, 1)
  data.accounts[0].protection = { hasRun: true, ok: true }
  assert.equal(preflight(data).status, 1)
  data.at = '2020-01-01T00:00:00Z'
  assert.equal(preflight(data).status, 2)
})
