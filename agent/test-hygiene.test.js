// agent/test-hygiene.test.js — V3 A1 (P8a): the agent tests remove the
// temporary directories they make.
//
// Measured 25-09-2026 on main f1d9223: one run of
// `node --test agent/**/*.test.js` left 279 directories (190,865,902 B) in
// TMPDIR; about 25 GB had built up in one day of gate runs and the full disk
// interrupted a maker. Fixtures now come from agent/test-support/temp-dir.js,
// which removes them when the test process exits.
//
// Every check here runs a real nested `node --test` with a fresh TMPDIR and
// looks at what is left in it afterwards. Two things make that able to fail:
//   - NODE_TEST_CONTEXT is deleted from the child's env (childTestEnv). Under
//     `node --test` every test process carries NODE_TEST_CONTEXT=child-v8,
//     and a nested run that inherits it executes NOTHING — exit 0, no TAP,
//     an empty TMPDIR — so each check also asserts the child really ran
//     tests (from its TAP totals) before it trusts an empty directory.
//   - the control fixture makes the same directories with node:fs directly,
//     and the check must find every one of them left behind.
//
// The whole agent suite is checked the same way by scripts/run-agent-tests.mjs
// (the CI step), which fails when a full run leaves anything in its TMPDIR.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { setPriority } from 'node:os'
import { join, dirname, sep, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tempDir } from './test-support/temp-dir.js'
import { childTestEnv, leftovers, describeLeftovers, tapTotals } from './test-support/tmp-guard.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HELPER_URL = pathToFileURL(join(ROOT, 'agent/test-support/temp-dir.js')).href

/**
 * Run `node --test` on `files` with TMPDIR = `tmp`. With `lowerPriority` the
 * child is niced: it is a heavy run started from inside the suite, and it
 * must not take CPU from the latency assertions of the suite's own run.
 */
function runNodeTest(files, tmp, { lowerPriority = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], {
      cwd: ROOT, env: childTestEnv(tmp), stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (lowerPriority) { try { setPriority(child.pid, 10) } catch { /* not permitted here: normal priority */ } }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

test('P8a: the tick readiness route tests leave nothing in TMPDIR (main left 5 directories, 28,791,377 B)', { timeout: 300_000 }, async () => {
  const tmp = tempDir('hygiene-tick-routes-')
  const run = await runNodeTest(['agent/routes/tick-readiness-routes.test.js'], tmp, { lowerPriority: true })
  const totals = tapTotals(run.stdout)
  // The route file runs 28 tests (its own and the tick-research-run tests it
  // imports). Pass/fail is that file's own business in the suite — its two
  // 100 ms latency assertions can lose to this nested run's CPU share — so
  // the check is that the child RAN them, then that nothing was left.
  assert.ok(totals.tests >= 28, `the nested run reported ${totals.tests} tests (need >= 28): it did not run the file, so an empty TMPDIR would prove nothing\n${run.stderr.slice(-2000)}`)
  const left = leftovers(tmp)
  assert.deepEqual(left.map(e => e.name), [], describeLeftovers(left))
})

// The fixture: a directory made at module load (with a 4,096-byte file in it,
// as a fixture database would be), one made inside a passing test, one from
// the async mkdtemp, and one inside a test that FAILS — cleanup must not
// depend on the tests passing.
function fixtureSource(importLine) {
  return `${importLine}
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const top = mkdtempSync(join(tmpdir(), 'fixture-top-'))
writeFileSync(join(top, 'agent.db'), 'x'.repeat(4096))
console.log('created ' + top)
test('passes', async () => {
  const d = tempDir('fixture-pass-'); writeFileSync(join(d, 'a'), 'y'); console.log('created ' + d)
  const e = await mkdtemp(join(tmpdir(), 'fixture-async-')); console.log('created ' + e)
})
test('fails after making a directory', () => {
  const d = tempDir('fixture-fail-'); console.log('created ' + d)
  assert.fail('planted failure')
})
`
}
const HELPER_IMPORT = `import { mkdtempSync, mkdtemp, tempDir } from '${HELPER_URL}'`
const RAW_IMPORT = [
  `import { mkdtempSync } from 'node:fs'`,
  `import { mkdtemp } from 'node:fs/promises'`,
  `import { tmpdir as osTmp } from 'node:os'`,
  `import { join as pathJoin } from 'node:path'`,
  `const tempDir = (prefix) => mkdtempSync(pathJoin(osTmp(), prefix))`,
].join('\n')

async function runFixture(importLine) {
  const src = tempDir('hygiene-src-')
  const file = join(src, 'fixture.test.mjs')
  writeFileSync(file, fixtureSource(importLine))
  const tmp = tempDir('hygiene-fixture-')
  const run = await runNodeTest([file], tmp)
  const created = [...run.stdout.matchAll(/created (\S+)/g)].map(m => m[1])
  return { run, tmp, created, totals: tapTotals(run.stdout) }
}

test('temp-dir.js removes its directories at exit — made at load, in a passing test, by async mkdtemp and in a failing test', { timeout: 60_000 }, async () => {
  const { run, tmp, created, totals } = await runFixture(HELPER_IMPORT)
  assert.equal(run.code, 1, `the planted failure must fail the run\n${run.stderr.slice(-2000)}`)
  assert.deepEqual(totals, { tests: 2, pass: 1, fail: 1 }, 'the nested run did not run the fixture')
  assert.equal(created.length, 4, `four directories were made:\n${run.stdout.slice(-2000)}`)
  for (const dir of created) assert.ok(dir.startsWith(tmp + sep), `${dir} was made outside the run's TMPDIR ${tmp}`)
  const left = leftovers(tmp)
  assert.deepEqual(left.map(e => e.name), [], describeLeftovers(left))
})

test('control: the same fixture on node:fs mkdtemp leaves all four directories, and the check names each one', { timeout: 60_000 }, async () => {
  const { run, tmp, created, totals } = await runFixture(RAW_IMPORT)
  assert.deepEqual(totals, { tests: 2, pass: 1, fail: 1 }, `the nested run did not run the fixture\n${run.stderr.slice(-2000)}`)
  assert.equal(created.length, 4)
  const left = leftovers(tmp)
  assert.deepEqual(left.map(e => e.name), created.map(d => basename(d)).sort())
  const top = left.find(e => e.name.startsWith('fixture-top-'))
  assert.equal(top.bytes, 4096, 'the size is the fixture file inside the directory')
  assert.match(describeLeftovers(left), /^4 entries, 4,097 B left in the private TMPDIR:/)
})

test('childTestEnv points TMPDIR at the private directory and drops NODE_TEST_CONTEXT, keeping everything else', () => {
  const env = childTestEnv('/x/private', { PATH: '/bin', NODE_TEST_CONTEXT: 'child-v8', TMPDIR: '/tmp', DB_PATH: 'a.db' })
  assert.deepEqual(env, { PATH: '/bin', TMPDIR: '/x/private', TMP: '/x/private', TEMP: '/x/private', DB_PATH: 'a.db' })
})

test('tapTotals reads the totals and reports null when there is no TAP (the inherited-context run)', () => {
  assert.deepEqual(tapTotals('ok 1 - a\n# tests 28\n# suites 0\n# pass 27\n# fail 1\n'), { tests: 28, pass: 27, fail: 1 })
  assert.deepEqual(tapTotals(''), { tests: null, pass: null, fail: null })
})

test('leftovers is empty for an empty directory, and lists a stray file and a nested directory with their bytes', () => {
  const dir = tempDir('hygiene-leftovers-')
  assert.deepEqual(leftovers(dir), [])
  writeFileSync(join(dir, 'stray.txt'), 'abc')
  mkdirSync(join(dir, 'naked-abc123', 'wal'), { recursive: true })
  writeFileSync(join(dir, 'naked-abc123', 'agent.db'), 'z'.repeat(10))
  writeFileSync(join(dir, 'naked-abc123', 'wal', 'agent.db-wal'), 'w'.repeat(5))
  assert.deepEqual(leftovers(dir), [{ name: 'naked-abc123', bytes: 15 }, { name: 'stray.txt', bytes: 3 }])
})
