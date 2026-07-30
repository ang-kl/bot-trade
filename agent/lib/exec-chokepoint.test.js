// PHASE 4 — CENTRAL EXECUTION PATH.
//
// The gate for this phase is "all write paths have one contract ... no write
// path may silently use the primary account". exec-engine.js is that contract:
// it runs validateExecGuard, validateOrderBracket and withAccount before an
// order can reach either engine, and it is the only place that knows how to
// choose between the C++ sidecar and the JS/ws fallback.
//
// Two routes used to sidestep it. POST /actions/execute-analysis and the
// manual-trade route both called wsPlaceOrder directly. 5A had patched the
// exec guard into them by hand, so the kill switch worked, but they still
// skipped the bracket guarantee and never reached the C++ engine even with
// EXEC_ENGINE=cpp. naked-position-guard.js meanwhile told the owner that "an
// order placed through the bot could not have been submitted this way
// (guard_no_target)" — a claim those two routes falsified.
//
// A comment saying "always go through exec-engine" is worth nothing against
// the caller who has not been written yet. This test is the enforcement: it
// reads the source of every module outside agent/lib/ and fails if any of them
// imports a raw broker-write function. Adding a legitimate exception means
// editing ALLOWED below and saying why in the diff, which is the review
// conversation worth having.
import { test } from 'node:test'
import assert from 'node:assert'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Raw broker writes. Reads (wsGetSpotOnce, wsReconcile, …) are not writes. */
const WRITE_FNS = ['wsPlaceOrder', 'wsAmendPosition', 'wsClosePosition', 'wsCancelOrder']

/**
 * Files permitted to import a raw write. exec-engine.js IS the contract, and
 * exec-fallback.js is the machinery it delegates through; tests may import
 * whatever they need to characterise behaviour.
 */
const ALLOWED = new Set(['lib/exec-engine.js', 'lib/exec-fallback.js'])

function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) jsFiles(full, out)
    else if (name.endsWith('.js') && !name.endsWith('.test.js')) out.push(full)
  }
  return out
}

test('no module outside the exec contract imports a raw broker write', () => {
  const offenders = []
  for (const file of jsFiles(AGENT)) {
    const rel = relative(AGENT, file)
    if (ALLOWED.has(rel) || rel === 'lib/ctrader-ws.js') continue
    const src = readFileSync(file, 'utf8')
    // Only import statements count. A mention inside a comment — which is how
    // loop.js and exec-engine.js explain the history — is not a call site.
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*ctrader-ws\.js['"]/g)) {
      const named = m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim())
      for (const fn of WRITE_FNS) {
        if (named.includes(fn)) offenders.push(`${rel} imports ${fn}`)
      }
    }
  }
  assert.deepEqual(offenders, [],
    `these modules bypass the exec-engine contract:\n  ${offenders.join('\n  ')}\n` +
    'Route the write through agent/lib/exec-engine.js instead, or add the file to ALLOWED with a reason.')
})

test('the write functions this test guards still exist on ctrader-ws', async () => {
  // Guards against the rot case: someone renames wsPlaceOrder, every string in
  // WRITE_FNS stops matching, and the test above passes for the wrong reason.
  const ws = await import('./ctrader-ws.js')
  for (const fn of WRITE_FNS) {
    assert.equal(typeof ws[fn], 'function', `${fn} is no longer exported — update WRITE_FNS`)
  }
})
