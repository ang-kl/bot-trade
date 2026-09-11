// agent/services/sidecar-pins.test.js — source pins on the sidecar that no
// C++ unit test can exercise (a signal's default disposition is process
// state; the TLS write path needs a real peer). Comments are stripped before
// matching (CLAUDE.md recurring failure mode #2).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const src = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'))

test('the sidecar ignores SIGPIPE at startup — a peer hang-up under a write is EPIPE, never a silent exit (11-09-2026 demo restart loop)', () => {
  const main = src('../../cpp-exec/src/main.cpp')
  assert.match(main, /signal\(SIGPIPE, SIG_IGN\)/, 'main.cpp must ignore SIGPIPE process-wide')
  assert.match(main, /static void installCrashHandler\(\) \{[\s\S]{0,600}signal\(SIGPIPE, SIG_IGN\)/, 'installed with the crash handlers, before any thread starts')
  assert.match(main, /installCrashHandler\(\);/, 'and the installer is called')
  // the plain-TCP transport already refuses the signal per write
  assert.match(src('../../cpp-exec/src/ws_client.cpp'), /::send\(fd, [^;]*MSG_NOSIGNAL\)/)
})
