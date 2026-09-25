// Test-only: the private-TMPDIR check the agent gate runs around the suite.
//
// scripts/run-agent-tests.mjs (the CI step) gives every test process one
// fresh TMPDIR, runs the whole agent suite, and fails if anything is left in
// it — so a test that makes a fixture directory and never removes it is named
// in CI instead of adding ~190 MB to the disk on every run (measured
// 25-09-2026: 279 directories, 190,865,902 B from one run of main).
// agent/test-hygiene.test.js uses the same functions on a single file.
import { mkdtempSync, readdirSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A fresh directory for one test run's TMPDIR. The caller removes it. */
export function privateTmpDir(prefix = 'agent-tests-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * The environment for a nested `node --test` run whose temp files must land
 * in `tmp`.
 *
 * NODE_TEST_CONTEXT is deleted, not inherited: every process that
 * `node --test` starts carries NODE_TEST_CONTEXT=child-v8, and a nested
 * `node --test` that inherits it runs NOTHING — exit 0, no TAP, nothing in
 * TMPDIR — so a hygiene check spawned from inside the suite would pass
 * without having run a single test (measured by the V3 reviewer).
 */
export function childTestEnv(tmp, base = process.env) {
  const env = { ...base, TMPDIR: tmp, TMP: tmp, TEMP: tmp }
  delete env.NODE_TEST_CONTEXT
  return env
}

function bytesOf(path) {
  const st = lstatSync(path)
  if (!st.isDirectory()) return st.size
  let total = 0
  for (const name of readdirSync(path)) total += bytesOf(join(path, name))
  return total
}

/** Every entry left in `dir`, sorted by name, with its size in bytes. */
export function leftovers(dir) {
  return readdirSync(dir).sort().map(name => ({ name, bytes: bytesOf(join(dir, name)) }))
}

/** A readable report of `leftovers(dir)`, at most `limit` names listed. */
export function describeLeftovers(list, limit = 50) {
  const total = list.reduce((sum, e) => sum + e.bytes, 0)
  const lines = list.slice(0, limit).map(e => `  ${e.name}  ${e.bytes.toLocaleString('en-US')} B`)
  if (list.length > limit) lines.push(`  ... and ${list.length - limit} more`)
  return `${list.length} ${list.length === 1 ? 'entry' : 'entries'}, ${total.toLocaleString('en-US')} B left in the private TMPDIR:\n${lines.join('\n')}`
}

/** The totals line of a TAP stream (`# tests N`, `# pass N`, `# fail N`). */
export function tapTotals(stdout) {
  const read = (key) => {
    const m = String(stdout).match(new RegExp(`^# ${key} (\\d+)$`, 'm'))
    return m ? Number(m[1]) : null
  }
  return { tests: read('tests'), pass: read('pass'), fail: read('fail') }
}
