// node --test agent/routes/state-route-uniqueness.test.js
//
// GUARD. `GET /state/veto-breakdown` was declared TWICE in state.js. Express
// serves the first registration and silently ignores every later one, so the
// second handler had never run — for months, in production.
//
// The wasted lines were not the problem. A dead route LOOKS ALIVE:
//
//   · editing it changes nothing, and nothing says so;
//   · reading it tells you the endpoint is account-blind when the live one
//     already accepts ?account=;
//   · an audit that counts routes counts it, so "how many routes are
//     account-blind" came back wrong.
//
// Express will not warn. Nothing at runtime will. So the build does.
//
// This is the same shape as the other two guards in this repo — the
// `textTransform: 'capitalize'` ban and the duplicate strategy-name map. All
// three exist because a second source of truth is invisible until it
// disagrees with the first.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Every `router.<verb>('<path>'` declaration in a file, with line numbers. */
function declaredRoutes(file) {
  const src = fs.readFileSync(file, 'utf8')
  const out = []
  src.split('\n').forEach((line, i) => {
    const m = line.match(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/)
    if (m) out.push({ verb: m[1], route: m[2], line: i + 1 })
  })
  return out
}

for (const file of ['state.js', 'actions.js']) {
  const full = path.join(HERE, file)
  if (!fs.existsSync(full)) continue

  test(`${file} declares every route exactly once`, () => {
    const seen = new Map()
    const dupes = []
    for (const r of declaredRoutes(full)) {
      const key = `${r.verb.toUpperCase()} ${r.route}`
      if (seen.has(key)) dupes.push(`${key} — line ${seen.get(key)} wins, line ${r.line} is DEAD`)
      else seen.set(key, r.line)
    }
    assert.deepEqual(dupes, [],
      `duplicate route declarations in ${file}. Express serves the FIRST and ` +
      'silently ignores the rest, so the later handler never runs while still ' +
      'reading like live code. Delete it, or merge what it does into the first.')
  })
}

test('the guard actually catches a duplicate (it is not vacuously green)', () => {
  // A guard nobody has seen fail is a guard nobody knows works. This proves
  // the detection on a synthetic source rather than trusting the real file to
  // stay clean.
  const fake = [
    "  router.get('/alpha', (req, res) => {})",
    "  router.post('/alpha', (req, res) => {})",   // different verb — NOT a duplicate
    "  router.get('/beta', (req, res) => {})",
    "  router.get('/alpha', (req, res) => {})",    // duplicate
  ].join('\n')

  const seen = new Map()
  const dupes = []
  fake.split('\n').forEach((line, i) => {
    const m = line.match(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/)
    if (!m) return
    const key = `${m[1].toUpperCase()} ${m[2]}`
    if (seen.has(key)) dupes.push(key)
    else seen.set(key, i + 1)
  })
  assert.deepEqual(dupes, ['GET /alpha'],
    'GET and POST on one path are two different routes and must not be flagged')
})
