// ---------------------------------------------------------------------------
// agent/scripts/backtest-parity.test.js — CI gate for JS↔C++ backtest parity.
//
// SKIPS when the cpp-exec binary isn't built (JS-only machines stay green);
// on machines that have the binary it runs the full parity harness and
// asserts a clean exit — enforcing bit-level parity forever.
//
//   node --test agent/scripts/backtest-parity.test.js
// ---------------------------------------------------------------------------

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BINARY = path.join(__dirname, '..', '..', 'cpp-exec', 'bin', 'cpp-exec')
const HARNESS = path.join(__dirname, 'backtest-parity.mjs')

test('C++ backtest matches JS backtest bit-for-bit (5 seeds × 2 entry modes)', t => {
  if (!existsSync(BINARY)) {
    t.skip(`cpp-exec binary not built at ${BINARY} — parity not checked on this machine`)
    return
  }
  const r = spawnSync(process.execPath, [HARNESS, BINARY], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) {
    // Surface the harness's readable diff in the test failure output.
    console.error(r.stdout)
    console.error(r.stderr)
  }
  assert.equal(r.status, 0, 'parity harness exited non-zero — see diff above')
})
