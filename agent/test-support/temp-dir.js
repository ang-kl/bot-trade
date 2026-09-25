// Test-only helper: temporary directories that are removed when the test
// process ends.
//
// The bug this exists for, measured 25-09-2026: one full run of
// `node --test agent/**/*.test.js` left 279 directories (190,865,902 B) in
// TMPDIR — `naked-*`, `opendup-*`, `arming-log-*`, `acct-phases-*`,
// `pending-*`, `tick-seg-route-big-*` and forty more prefixes — because each
// test made a fixture database or segment directory with fs.mkdtempSync and
// never removed it. Every gate run added another ~190 MB, about 25 GB in a
// day of makers and checkers, until the container disk filled and interrupted
// a build.
//
// mkdtempSync / mkdtemp here are drop-in replacements for the node:fs and
// node:fs/promises functions of the same name. Each directory they create is
// recorded, and every recorded directory is removed (recursive, force) when
// the process emits 'exit'. 'exit' and not a node:test `after` hook, because:
//   - a root `after` registered here would run BEFORE the test file's own
//     `after` hooks (this module is imported first), deleting a database
//     directory while a worker or an open handle still uses it;
//   - `after` called from a module first imported inside a test body attaches
//     to that test, not to the file, and would delete fixtures other tests
//     still need;
//   - 'exit' runs after every test and hook, on a pass, on a failure and on
//     an uncaught exception alike, and rmSync is synchronous, which is all an
//     'exit' listener may do.
// It does not run when the process is killed by a signal; nothing in-process
// can. scripts/run-agent-tests.mjs checks the private TMPDIR after the whole
// suite and fails the gate if anything was left, so a new leak is named in CI
// instead of accumulating on disk.
import { mkdtempSync as fsMkdtempSync, rmSync } from 'node:fs'
import { mkdtemp as fsMkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const owned = new Set()

/** Remove every directory this module created. Idempotent. */
export function removeTempDirs() {
  for (const dir of owned) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort at exit */ }
    owned.delete(dir)
  }
}

process.once('exit', removeTempDirs)

/** Drop-in for fs.mkdtempSync; the directory is removed at process exit. */
export function mkdtempSync(prefix, options) {
  const dir = fsMkdtempSync(prefix, options)
  owned.add(dir)
  return dir
}

/** Drop-in for fs/promises mkdtemp; the directory is removed at process exit. */
export async function mkdtemp(prefix, options) {
  const dir = await fsMkdtemp(prefix, options)
  owned.add(dir)
  return dir
}

/** A fresh directory under os.tmpdir() named `<prefix>XXXXXX`, removed at exit. */
export function tempDir(prefix = 'test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}
