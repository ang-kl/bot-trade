import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Wiring pin, a last resort (failure mode #4): the boot call sits in
// startLoop, which has no injection point. The behaviour it starts is
// exercised in scanner-bridge-start.test.js. Comments are stripped first
// (failure mode #2) so the explanation above the call cannot satisfy it.
const strip = source => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
const body = name => {
  const start = loop.search(new RegExp(`\\n(export )?(async )?function ${name}\\(`))
  assert.ok(start >= 0, `${name} not found`)
  const end = loop.indexOf('\n}\n', start)
  return loop.slice(start, end)
}

test('startLoop starts the scanner bridge at boot, outside runLoop', () => {
  assert.match(loop, /import \{[^}]*\bstartScannerBridge\b[^}]*\} from '\.\/services\/scanner-feed\.js'/)
  assert.match(body('startLoop'), /\bstartScannerBridge\(db\)/)
  // runLoop's breaker and skip paths return early; the bridge must not
  // depend on any of them.
  assert.doesNotMatch(body('runLoop'), /startScannerBridge|ensureScannerBridge/)
})
