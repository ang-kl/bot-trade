// npx vitest run scripts/agent-gate.test.js
//
// V3 M2b (A1 check nit 1): the CI gate's leak check only sees a test's temp
// directories if every test process is started with the private TMPDIR. The
// A1 checker dropped `, env` from the runner's spawn in a scratch copy and the
// runner still printed "the private TMPDIR is empty" and exited 0 — no test
// went red. These tests run the gate itself (scripts/agent-gate.mjs) on tiny
// fixture suites: a planted leak fails it by name, a clean suite passes, and a
// gate whose children do not get the private TMPDIR fails on its canary
// before any test runs.
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentGate, CANARY_PREFIX } from './agent-gate.mjs'

const made = new Set()
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
const dir = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); made.add(d); return d }

/** A one-test node:test file whose body is `body`. */
function fixture(body) {
  const file = join(dir('agent-gate-fixture-'), 'fixture.test.mjs')
  writeFileSync(file, [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { mkdtempSync } from 'node:fs'",
    "import { tmpdir } from 'node:os'",
    "import { join } from 'node:path'",
    `test('fixture', () => { ${body} })`,
  ].join('\n') + '\n')
  return file
}
function gate(groups, extra = {}) {
  const lines = [], errors = []
  const tmp = dir('agent-gate-private-')
  const result = runAgentGate({ groups, labels: groups.map((_, i) => `group ${i}`), tmp, stdio: 'pipe',
    log: line => lines.push(line), error: line => errors.push(line), ...extra })
  return { result, lines, errors, tmp }
}

describe('runAgentGate', () => {
  it('a planted leak fails the gate and is named', () => {
    const { result, errors } = gate([[fixture("mkdtempSync(join(tmpdir(), 'planted-leak-'))")]])
    expect(result.failed).toBe(true)
    expect(result.reason).toBe('leftovers')
    expect(result.leftovers.map(e => e.name)).toEqual([expect.stringMatching(/^planted-leak-/)])
    expect(errors.join('\n')).toMatch(/test hygiene FAILED: 1 entry, .*planted-leak-/s)
  })

  it('a clean suite passes, and the canary leaves nothing behind', () => {
    const { result, lines, tmp } = gate([[fixture('assert.equal(1, 1)')]])
    expect(result).toEqual({ failed: false, reason: null, leftovers: [] })
    expect(lines.join('\n')).toContain("the canary child's temp directory landed in the private TMPDIR")
    expect(readdirSync(tmp)).toEqual([])
  })

  it('a failing test fails the gate without being mistaken for a leak', () => {
    const { result } = gate([[fixture('assert.equal(1, 2)')]])
    expect(result).toEqual({ failed: true, reason: 'tests_failed', leftovers: [] })
  })

  it('a gate whose children do not get the private TMPDIR is BLIND: it fails on the canary and runs no test', () => {
    const outer = dir('agent-gate-outer-')
    const calls = []
    // What dropping `env` from the spawn does: the child keeps a TMPDIR that
    // is not the gate's (here `outer`, so this test leaks nothing into /tmp).
    const spawn = (command, args, options) => {
      calls.push(args)
      return spawnSync(command, args, { ...options, env: { ...options.env, TMPDIR: outer, TMP: outer, TEMP: outer } })
    }
    const { result, errors } = gate([[fixture("mkdtempSync(join(tmpdir(), 'planted-leak-'))")]], { spawn })
    expect(result.failed).toBe(true)
    expect(result.reason).toBe('canary_not_seen')
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('-e')
    expect(errors.join('\n')).toMatch(/test hygiene guard is BLIND/)
    expect(readdirSync(outer).filter(name => name.startsWith(CANARY_PREFIX))).toEqual([])
  })
})

// Wiring pin (failure mode #4): the CI step is a script with no injection
// point, so its source is read — comments stripped first (failure mode #2).
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
describe('scripts/run-agent-tests.mjs', () => {
  it('runs the suite through runAgentGate and starts no child of its own', () => {
    const src = stripComments(readFileSync(new URL('./run-agent-tests.mjs', import.meta.url), 'utf8'))
    expect(src).toContain("import { runAgentGate } from './agent-gate.mjs'")
    expect(src).toMatch(/failed = runAgentGate\(\{ groups, labels, tmp \}\)\.failed/)
    expect(src).not.toMatch(/spawn|execFile|child_process/)
    expect(src).toContain('process.exitCode = failed ? 1 : 0')
  })
})
