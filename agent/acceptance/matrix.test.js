// Claude · № 14,533 14-Oct (owner: "start NASA-5 and NASA-6"; claude-builder).
// node --test agent/acceptance/matrix.test.js
//
// NASA-5 operational acceptance matrix (agent/acceptance/matrix.json). This
// test keeps the matrix honest in both directions:
//   - every (form × event) cell is present exactly once, with a state;
//   - a COVERED cell's receipts are real: each names a test file that exists
//     and a test title that the file declares (test('…'), test("…") or a
//     template title), so deleting or renaming a receipt turns this red;
//   - a GAP carries no receipt, and the number of gaps can only fall (a new
//     gap is a deliberate edit of GAP_CEILING, never silent);
//   - NOT_APPLICABLE carries its reason.
// What this does NOT establish: that a receipt test is itself correct, or any
// operational or financial outcome. Those are separate acceptance states.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const ROOT = new URL('../../', import.meta.url)
const matrix = JSON.parse(readFileSync(new URL('./matrix.json', import.meta.url), 'utf8'))
// The 14-10 inventory found 40 gaps. Filling one lowers this; it never rises silently.
const GAP_CEILING = 40

function declares(src, title) {
  const forms = [`'${title.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`, `"${title.replace(/"/g, '\\"')}"`, `\`${title}\``]
  return forms.some(q => src.includes(`test(${q}`) || src.includes(`it(${q}`))
}

test('NASA-5 matrix: every form × event cell appears exactly once with a known state', () => {
  const seen = new Set()
  for (const c of matrix.cells) {
    assert.ok(matrix.forms.includes(c.form), c.form); assert.ok(matrix.events.includes(c.event), c.event)
    const k = `${c.form}×${c.event}`
    assert.ok(!seen.has(k), `duplicate cell ${k}`); seen.add(k)
    assert.ok(['covered', 'gap', 'not_applicable'].includes(c.state), `${k}: ${c.state}`)
  }
  assert.equal(seen.size, matrix.forms.length * matrix.events.length)
})

test('NASA-5 matrix: every receipt of a covered cell is a test that exists', () => {
  const missing = []
  for (const c of matrix.cells.filter(x => x.state === 'covered')) {
    assert.ok(Array.isArray(c.receipts) && c.receipts.length > 0, `${c.form}×${c.event} is covered with no receipt`)
    for (const r of c.receipts) {
      const url = new URL(r.file, ROOT)
      if (!existsSync(url)) { missing.push(`${c.form}×${c.event}: ${r.file} does not exist`); continue }
      if (!declares(readFileSync(url, 'utf8'), r.title)) missing.push(`${c.form}×${c.event}: ${r.file} declares no test "${r.title}"`)
    }
  }
  assert.deepEqual(missing, [])
})

test('NASA-5 matrix: gaps carry no receipt and never grow; not-applicable cells say why', () => {
  const gaps = matrix.cells.filter(c => c.state === 'gap')
  assert.ok(gaps.every(c => !c.receipts), 'a gap with a receipt is covered, not a gap')
  assert.ok(gaps.length <= GAP_CEILING, `${gaps.length} gaps over the ceiling ${GAP_CEILING}: a new gap is a deliberate edit`)
  for (const c of matrix.cells.filter(x => x.state === 'not_applicable')) assert.ok(typeof c.reason === 'string' && c.reason.length > 20, `${c.form}×${c.event} needs its reason`)
})

test('NASA-5 matrix: the receipt check can fail — a title no file declares is caught', () => {
  const src = readFileSync(new URL('agent/services/reconciler.test.js', ROOT), 'utf8')
  assert.equal(declares(src, 'orphan sweep: an open trade whose position is gone at the broker (no monitored row) is closed'), true)
  assert.equal(declares(src, 'orphan sweep: an open trade whose position is gone at the broker (no monitored row) is closed!'), false)
  assert.equal(declares('test(\'it\\\'s here\', () => {})', "it's here"), true, 'an escaped quote in a single-quoted title')
})
