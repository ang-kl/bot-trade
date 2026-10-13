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

// Claude · № 14,558 14-Oct (Codex P2s on #1366; claude-builder). The titles a
// test file DECLARES, read from its syntax tree (acorn, as module-imports.js
// does): a call to test(...) or it(...), or a subtest t.test(...), whose title
// is a fixed string. A commented-out declaration, a title inside a string and
// test.skip / test.todo are not declarations, so a receipt that no longer runs
// turns this red. A parameterised title (`F1 ${name}: …` inside
// `for (const [name, c] of Object.entries(CASES))`) is EXPANDED, one title per
// case the file's own table holds, so a receipt names its case and removing
// that case from the table turns this red; a placeholder this cannot resolve
// declares nothing. A file that does not parse throws (named).
const MAX_EXPANSION = 1000
function declaredTitles(src, file = 'source') {
  let ast
  try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowAwaitOutsideFunction: true }) } catch (e) { throw new Error(`${file} does not parse: ${e.message}`) }
  const consts = new Map()
  for (const n of ast.body) {
    const d = n.type === 'ExportNamedDeclaration' ? n.declaration : n
    if (d?.type === 'VariableDeclaration' && d.kind === 'const') for (const v of d.declarations) if (v.id.type === 'Identifier' && v.init) consts.set(v.id.name, v.init)
  }
  const lit = n => n?.type === 'Literal' && (typeof n.value === 'string' || typeof n.value === 'number') ? String(n.value) : null
  const deref = n => n?.type === 'Identifier' && consts.has(n.name) ? consts.get(n.name) : n
  const keysOf = o => o?.type === 'ObjectExpression' && o.properties.every(p => p.type === 'Property' && !p.computed)
    ? o.properties.map(p => p.key.type === 'Identifier' ? p.key.name : lit(p.key)) : null
  const itemsOf = a => a?.type === 'ArrayExpression' && a.elements.every(e => lit(e) != null) ? a.elements.map(lit) : null
  // The names a for-of binds and the values each takes, or null when not resolvable.
  const loopBinding = f => {
    const left = f.left.type === 'VariableDeclaration' ? f.left.declarations[0].id : null
    const r = f.right
    const objectCall = r.type === 'CallExpression' && r.callee.type === 'MemberExpression' && r.callee.object.name === 'Object' && ['entries', 'keys'].includes(r.callee.property.name)
    const values = objectCall ? keysOf(deref(r.arguments[0])) : itemsOf(deref(r))
    if (!values || !left) return null
    if (left.type === 'Identifier' && !(objectCall && r.callee.property.name === 'entries')) return [left.name, values]
    if (left.type === 'ArrayPattern' && objectCall && r.callee.property.name === 'entries' && left.elements[0]?.type === 'Identifier') return [left.elements[0].name, values]
    return null
  }
  const titlesOf = (n, scope) => {
    if (n?.type === 'Literal' && typeof n.value === 'string') return [n.value]
    if (n?.type !== 'TemplateLiteral') return []
    let out = [n.quasis[0].value.cooked]
    for (let i = 0; i < n.expressions.length; i++) {
      const e = n.expressions[i]
      const vals = e.type === 'Identifier' && scope.has(e.name) ? scope.get(e.name) : lit(deref(e)) != null ? [lit(deref(e))] : null
      if (!vals) return []
      out = out.flatMap(t => vals.map(v => t + v + n.quasis[i + 1].value.cooked))
      if (out.length > MAX_EXPANSION) return []
    }
    return out
  }
  const isDecl = c => (c.type === 'Identifier' && (c.name === 'test' || c.name === 'it')) ||
    (c.type === 'MemberExpression' && !c.computed && c.property.name === 'test' && c.object.type === 'Identifier' && c.object.name !== 'test' && c.object.name !== 'it')
  const titles = new Set()
  const walk = (n, scope) => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'CallExpression' && isDecl(n.callee)) for (const t of titlesOf(n.arguments[0], scope)) titles.add(t)
    let inner = scope
    if (n.type === 'ForOfStatement') { const b = loopBinding(n); if (b) inner = new Map([...scope, b]) }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end') continue
      const v = n[k]
      if (Array.isArray(v)) v.forEach(x => walk(x, inner)); else if (v && typeof v === 'object') walk(v, inner)
    }
  }
  walk(ast, new Map())
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
    "const CASES = { 'first case': {}, second: {} }",
    "for (const [name, c] of Object.entries(CASES)) test(`each ${name} runs`, () => {})",
    "for (const n of ['x', 'y']) test(`item ${n}`, () => {})",
    "test(`unresolved ${somethingElse}`, () => {})",
    "test('outer', async t => { await t.test('a subtest', () => {}) })",
    "// test('commented out', () => {})",
    "/* test('block commented', () => {}) */",
    "const s = \"test('inside a string', () => {})\"",
    "test.skip('skipped', () => {})",
    "test.todo('todo')",
  ].join('\n'))
  assert.deepEqual([...t].sort(), ["a subtest", 'each first case runs', 'each second runs', "it's here", 'item x', 'item y', 'outer', 'template'])
  assert.throws(() => declaredTitles('test(', 'broken.test.js'), /broken\.test\.js does not parse/)
})
