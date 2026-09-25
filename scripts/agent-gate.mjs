// The agent test gate (scripts/run-agent-tests.mjs, the CI step) as a
// function, so the part that makes its hygiene check able to see anything is
// exercised by a test (scripts/agent-gate.test.js) instead of trusted.
//
// V3 M2b (A1 check nit 1): the leak check reads ONE private TMPDIR, and it
// only sees a test's temp directories if every test process is started with
// that TMPDIR in its environment. The A1 checker dropped `, env` from the
// spawn in a scratch copy: a planted leak landed in the outer TMPDIR, the
// runner printed "the private TMPDIR is empty after the full suite" and
// exited 0 — a guard out of reach of what it guards (CLAUDE.md failure modes
// #3/#4), and no test went red. Now:
//   - every child (the canary and each test group) is started by one
//     function, runNode, with the private environment;
//   - before any test runs, a canary child makes one directory in its
//     os.tmpdir(); the gate fails, naming itself BLIND, unless that directory
//     is the only entry in the private TMPDIR. A runner that loses the env
//     cannot pass: it fails on the canary before the suite starts.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { childTestEnv, leftovers, describeLeftovers } from '../agent/test-support/tmp-guard.js'

export const CANARY_PREFIX = 'agent-gate-canary-'
const CANARY_SOURCE = `process.stdout.write(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), ${JSON.stringify(CANARY_PREFIX)})))`

/**
 * @param {{ groups: string[][], labels: string[], tmp: string,
 *   spawn?: typeof spawnSync, stdio?: 'inherit' | 'pipe',
 *   log?: (line: string) => void, error?: (line: string) => void }} options
 *   `tmp` is the private TMPDIR (the caller creates and removes it); `spawn`
 *   and `stdio` exist for the test.
 * @returns {{ failed: boolean, reason: null | 'canary_not_seen' | 'tests_failed' | 'leftovers', leftovers: {name: string, bytes: number}[] }}
 */
export function runAgentGate({ groups, labels, tmp, spawn = spawnSync, stdio = 'inherit', log = console.log, error = console.error }) {
  const env = childTestEnv(tmp)
  const runNode = (args, childStdio = stdio) => spawn(process.execPath, args, { stdio: childStdio, env, encoding: 'utf8' })

  const canary = runNode(['-e', CANARY_SOURCE], 'pipe')
  if (canary.error) throw canary.error
  const canaryPath = String(canary.stdout ?? '').trim()
  const seen = leftovers(tmp)
  const sighted = canary.status === 0 && seen.length === 1 && seen[0].name.startsWith(CANARY_PREFIX) && canaryPath === join(tmp, seen[0].name)
  // The canary's directory is removed wherever it landed; a blind run must
  // not leak it into the outer TMPDIR either.
  if (canaryPath.includes(CANARY_PREFIX)) rmSync(canaryPath, { recursive: true, force: true })
  if (!sighted) {
    error(`[agent-gate] test hygiene guard is BLIND: the canary child's temp directory (${canaryPath || 'none'}) did not land in the private TMPDIR ${tmp} (${seen.length ? describeLeftovers(seen) : 'it is empty'}), so leaks from the suite could not be seen. Every child must be started with childTestEnv(tmp).`)
    return { failed: true, reason: 'canary_not_seen', leftovers: seen }
  }
  log('[agent-gate] test hygiene: the canary child\'s temp directory landed in the private TMPDIR')

  let failed = false
  for (const [index, group] of groups.entries()) {
    log(`[agent-gate] ${labels[index]}: ${group.length} files`)
    const result = runNode(['--test', '--test-concurrency=2', ...group])
    if (result.error) throw result.error
    if (result.status !== 0) failed = true
  }
  const left = leftovers(tmp)
  if (left.length) {
    error(`[agent-gate] test hygiene FAILED: ${describeLeftovers(left)}\n[agent-gate] make test fixtures with agent/test-support/temp-dir.js (mkdtempSync / tempDir), which removes them at exit`)
    return { failed: true, reason: 'leftovers', leftovers: left }
  }
  log('[agent-gate] test hygiene: the private TMPDIR is empty after the full suite')
  return { failed, reason: failed ? 'tests_failed' : null, leftovers: [] }
}
