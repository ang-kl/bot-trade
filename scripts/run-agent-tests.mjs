#!/usr/bin/env node
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

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
// These tests deliberately measure the production handler against a 100 ms
// limit. Competing test processes are not part of that workload. Run the
// whole latency file first, then every other agent test exactly once.
const groups = [[latency], files.filter(path => path !== latency)]
if (!groups[1].length) throw new Error('Agent test inventory is empty')
let failed = false
for (const [index, group] of groups.entries()) {
  console.log(`[agent-gate] ${index === 0 ? 'isolated latency acceptance' : 'remaining agent suite'}: ${group.length} files`)
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...group], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) failed = true
}
process.exitCode = failed ? 1 : 0
