// Claude · № 14,533 14-Oct (owner: "start NASA-5 and NASA-6"; claude-builder).
// node --test agent/acceptance/matrix.test.js
//
// NASA-5 operational acceptance matrix (agent/acceptance/matrix.json). This
// test keeps the matrix honest in both directions:
//   - every (form × event) cell is present exactly once, with a state;
//   - a COVERED cell's receipts are real: each names a test file that exists
//     and a test title the file DECLARES in code (read from its syntax tree:
//     not a comment, a string or test.skip), so deleting, renaming or
//     disabling a receipt turns this red;
//   - a GAP carries no receipt, and the number of gaps is pinned exactly
//     (GAP_COUNT): filling or opening one is a deliberate edit, never silent;
//   - NOT_APPLICABLE carries its reason.
// What this does NOT establish: that a receipt test is itself correct, or any
// operational or financial outcome. Those are separate acceptance states.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import * as acorn from 'acorn'

const ROOT = new URL('../../', import.meta.url)
const matrix = JSON.parse(readFileSync(new URL('./matrix.json', import.meta.url), 'utf8'))
// The 14-10 inventory found 41 gaps. Pinned EXACTLY (Codex P2 on #1366): a
// ceiling leaves spare room once a gap is filled and forgotten here, so a
// covered cell could slide back to a gap unseen. Every change edits this.
const GAP_COUNT = 41

// Claude · № 14,558 14-Oct (Codex P2 on #1366; claude-builder). The titles a
// test file DECLARES, read from its syntax tree (acorn, as module-imports.js
// does): a call to test(...) or it(...), or a subtest t.test(...), whose title
// is a fixed string. A commented-out declaration, a title inside a string and
// test.skip / test.todo are not declarations, so a receipt that no longer runs
// turns this red. A file that does not parse throws (named).
function declaredTitles(src, file = 'source') {
  let ast
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowAwaitOutsideFunction: true }) } catch (e) { throw new Error(`${file} does not parse: ${e.message}`) }
  const titles = new Set()
  // A parameterised title (`F1 ${name}: …`, run once per name) is cited by its template text as written.
  const title = n => n?.type === 'Literal' && typeof n.value === 'string' ? n.value
    : n?.type === 'TemplateLiteral' ? (n.expressions.length === 0 ? n.quasis[0].value.cooked : src.slice(n.start + 1, n.end - 1)) : null
  const isDecl = c => (c.type === 'Identifier' && (c.name === 'test' || c.name === 'it')) ||
    (c.type === 'MemberExpression' && !c.computed && c.property.name === 'test' && c.object.type === 'Identifier' && c.object.name !== 'test' && c.object.name !== 'it')
  const walk = n => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'CallExpression' && isDecl(n.callee)) { const t = title(n.arguments[0]); if (t != null) titles.add(t) }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end') continue
      const v = n[k]
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v)
    }
  }
  walk(ast)
  return titles
}
const titlesByFile = new Map()
const declares = (file, title) => {
  if (!titlesByFile.has(file)) titlesByFile.set(file, declaredTitles(readFileSync(new URL(file, ROOT), 'utf8'), file))
  return titlesByFile.get(file).has(title)
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
      if (!declares(r.file, r.title)) missing.push(`${c.form}×${c.event}: ${r.file} declares no test "${r.title}"`)
    }
  }
  assert.deepEqual(missing, [])
})

test('NASA-5 matrix: gaps carry no receipt and never grow; not-applicable cells say why', () => {
  const gaps = matrix.cells.filter(c => c.state === 'gap')
  assert.ok(gaps.every(c => !c.receipts), 'a gap with a receipt is covered, not a gap')
  assert.equal(gaps.length, GAP_COUNT, `${gaps.length} gaps where GAP_COUNT is ${GAP_COUNT}: filling or opening a gap is a deliberate edit of GAP_COUNT`)
  for (const c of matrix.cells.filter(x => x.state === 'not_applicable')) assert.ok(typeof c.reason === 'string' && c.reason.length > 20, `${c.form}×${c.event} needs its reason`)
})

test('NASA-5 matrix: the receipt check can fail — an absent, commented-out, skipped or string-only title is caught', () => {
  assert.equal(declares('agent/services/reconciler.test.js', 'orphan sweep: an open trade whose position is gone at the broker (no monitored row) is closed'), true)
  assert.equal(declares('agent/services/reconciler.test.js', 'orphan sweep: an open trade whose position is gone at the broker (no monitored row) is closed!'), false)
  const t = declaredTitles([
    "import test from 'node:test'",
    "test('it\\'s here', () => {})",
    "test(`template`, () => {})",
    "for (const name of ['a']) test(`each ${name} runs`, () => {})",
    "test('outer', async t => { await t.test('a subtest', () => {}) })",
    "// test('commented out', () => {})",
    "/* test('block commented', () => {}) */",
    "const s = \"test('inside a string', () => {})\"",
    "test.skip('skipped', () => {})",
    "test.todo('todo')",
  ].join('\n'))
  assert.deepEqual([...t].sort(), ["a subtest", 'each ${name} runs', "it's here", 'outer', 'template'])
  assert.throws(() => declaredTitles('test(', 'broken.test.js'), /broken\.test\.js does not parse/)
})
