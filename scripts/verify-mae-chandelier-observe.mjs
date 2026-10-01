#!/usr/bin/env node
// scripts/verify-mae-chandelier-observe.mjs
// Re-test if the observe patch fails. Exits 2 when an amend flag appears.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const node = spawnSync(process.execPath, ['--test', 'agent/services/mae-chandelier-observe.test.js'], { cwd: root, encoding: 'utf8' })
const cpp = spawnSync('c++', ['-std=c++20', 'cpp-verify/src/tests/test_mae_chandelier_observe.cpp', '-o', '/tmp/mae-chandelier-observe-test'], { cwd: root, encoding: 'utf8' })
let cppRun = { status: 1, stdout: '', stderr: 'c++ missing' }
if (cpp.status === 0) cppRun = spawnSync('/tmp/mae-chandelier-observe-test', { encoding: 'utf8' })
const ok = node.status === 0 && cpp.status === 0 && cppRun.status === 0
console.log(JSON.stringify({
  ok,
  mayAmend: false,
  node: node.status,
  cppBuild: cpp.status,
  cppRun: cppRun.status,
  nodeTail: (node.stdout || node.stderr || '').slice(-400),
  cppTail: (cppRun.stdout || cpp.stderr || '').slice(-400),
}, null, 2))
process.exit(ok ? 0 : 2)
