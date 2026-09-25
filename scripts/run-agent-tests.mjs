#!/usr/bin/env node
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { privateTmpDir } from '../agent/test-support/tmp-guard.js'
import { runAgentGate } from './agent-gate.mjs'

const files = []
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(path)
  }
}
walk('agent')
files.sort()
const latency = 'agent/routes/tick-readiness-routes.test.js'
if (!files.includes(latency)) throw new Error('Required latency acceptance suite is missing')
// The hygiene test runs the latency file again in a nested `node --test`, so
// it gets its own group too: it must not compete with the latency file's
// isolated run, and its nested run must not compete with the rest.
const hygiene = 'agent/test-hygiene.test.js'
if (!files.includes(hygiene)) throw new Error('Required test hygiene suite is missing')
// These tests deliberately measure the production handler against a 100 ms
// limit. Competing test processes are not part of that workload. Run the
// whole latency file first, then the hygiene file, then every other agent
// test exactly once.
const groups = [[latency], [hygiene], files.filter(path => path !== latency && path !== hygiene)]
if (!groups[2].length) throw new Error('Agent test inventory is empty')
const labels = ['isolated latency acceptance', 'isolated test hygiene', 'remaining agent suite']
// Every test process gets one private TMPDIR. After the whole suite it must
// be empty: a test that leaves a fixture directory behind fails the gate here,
// by name, instead of filling the disk (25-09-2026: 279 directories and
// 190,865,902 B left by one run; ~25 GB in a day). Fixtures come from
// agent/test-support/temp-dir.js, which removes them at process exit. The
// gate first proves a child's temp directory lands there (the canary in
// scripts/agent-gate.mjs), so a runner that lost the env fails, not passes.
const tmp = privateTmpDir()
let failed = true
try {
  failed = runAgentGate({ groups, labels, tmp }).failed
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
