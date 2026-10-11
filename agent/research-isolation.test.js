// agent/research-isolation.test.js — the research programme has no order
// authority and the live system does not read it.
//
// Claude · № 13,094 11-Oct (ordered № 13,093; claude-builder). The owner's
// condition on the measure-first plan: the live trade management, the gates
// and the loop are not changed by it, and the research cannot reach them.
// Two checks, both on SOURCE (comments stripped — CLAUDE.md failure mode #2):
//
//   1. No research module, through its static import graph, reaches a
//      protected or order-authority module, and none calls setState (the
//      agent_state writer every gate reads from).
//   2. No live module (anything under agent/ that is not a test and not on
//      the research list) imports a research module. The only importers
//      allowed are the read routes, the action route that starts a research
//      job, the report worker that hosts read-only reports, and scripts.
//
// The protected list is READ from scripts/check-protected-boundary.sh
// (between its PROTECTED markers), so the script and this test cannot drift.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Research modules: the ones that exist now; later steps add theirs here. */
export const RESEARCH_MODULES = [
  'agent/lib/research-config.js',
  'agent/lib/tick-bars.js',
  'agent/services/theory-gap.js',
  'agent/services/research-slot.js',
  'agent/services/bar-form-research.js',
  'agent/services/bar-form-research-worker.js',
].filter(p => existsSync(join(ROOT, p)))

/** Order authority and state writers a research module must never reach. */
const ORDER_AUTHORITY = [
  'agent/services/exec-engine.js',
  'agent/lib/exec-engine.js',
  'agent/services/stage-matrix.js',
  'agent/services/position-manager.js',
  'agent/services/reconciler.js',
  'agent/routes/actions.js',
  'agent/index.js',
]

/** Importers that may read research modules: read routes, the action starter, the report worker, scripts. */
const ALLOWED_IMPORTERS = new Set([
  'agent/routes/state.js',
  'agent/routes/actions.js',
  'agent/services/performance-populations.js',
  // Report-only service reached from the route/worker. It reads the LIVE
  // management loaders (managed-exit, mae-chandelier-observe, capped-hybrid)
  // to build the "current management" approximation, so it cannot itself be
  // a research module; it writes nothing and nothing live imports it.
  'agent/services/exit-counterfactual-extended.js',
])

export function protectedPaths() {
  const sh = readFileSync(join(ROOT, 'scripts/check-protected-boundary.sh'), 'utf8')
  const block = sh.split('# PROTECTED-BEGIN')[1]?.split('# PROTECTED-END')[0] ?? ''
  return block.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('PROTECTED=') && l !== ')')
}

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
const IMPORT_RE = /(?:^|\n)\s*(?:import\s[^'"]*?from\s*|import\s*\(\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]/g
function staticImports(file) {
  const src = strip(readFileSync(file, 'utf8'))
  const out = []
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1]
    if (!spec.startsWith('.')) continue
    const abs = resolve(dirname(file), spec)
    out.push(relative(ROOT, abs))
  }
  return out
}
function graph(start) {
  const seen = new Set(), stack = [start]
  while (stack.length) {
    const f = stack.pop()
    if (seen.has(f)) continue
    seen.add(f)
    const abs = join(ROOT, f)
    if (!existsSync(abs) || !/\.(js|mjs)$/.test(f)) continue
    for (const dep of staticImports(abs)) stack.push(dep)
  }
  seen.delete(start)
  return seen
}
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) { if (name !== 'node_modules' && name !== 'test-support') walk(p, out) }
    else if (/\.(js|mjs)$/.test(name) && !/\.test\.(js|mjs)$/.test(name)) out.push(p)
  }
  return out
}

test('the protected list is read from the boundary script and names real files', () => {
  const list = protectedPaths()
  assert.ok(list.length >= 40, `protected list too short: ${list.length}`)
  for (const p of list) assert.ok(existsSync(join(ROOT, p)), `protected path missing on disk: ${p}`)
  for (const must of ['agent/services/managed-exit.js', 'agent/services/profit-keeper.js', 'agent/services/risk.js', 'agent/loop.js', 'cpp-exec/src/trail_engine.cpp']) {
    assert.ok(list.includes(must), `${must} must be protected`)
  }
})

test('research modules exist (at least the config loader) and reach no protected or order-authority module, and call no state writer', () => {
  assert.ok(RESEARCH_MODULES.includes('agent/lib/research-config.js'), 'research-config.js is the first research module')
  const forbidden = new Set([...protectedPaths(), ...ORDER_AUTHORITY])
  for (const mod of RESEARCH_MODULES) {
    const reach = graph(mod)
    const hits = [...reach].filter(f => forbidden.has(f))
    assert.deepEqual(hits, [], `${mod} reaches protected/order-authority module(s): ${hits.join(', ')}`)
    const src = strip(readFileSync(join(ROOT, mod), 'utf8'))
    assert.ok(!/\bsetState\s*\(/.test(src), `${mod} calls setState`)
    assert.ok(!/\bsetAccountState\s*\(/.test(src), `${mod} calls setAccountState`)
  }
})

test('no live module imports a research module (routes, the report worker and scripts are the only readers)', () => {
  const research = new Set(RESEARCH_MODULES)
  const offenders = []
  for (const abs of walk(join(ROOT, 'agent'))) {
    const rel = relative(ROOT, abs)
    if (research.has(rel) || ALLOWED_IMPORTERS.has(rel)) continue
    for (const dep of staticImports(abs)) {
      if (research.has(dep) || research.has(dep + '.js')) offenders.push(`${rel} → ${dep}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('no protected module imports a research module, even through the allowed importers', () => {
  // The allowed importers are routes and the report worker; a protected
  // module must not reach research code through them either.
  const research = new Set(RESEARCH_MODULES)
  for (const p of protectedPaths().filter(p => /\.(js|mjs)$/.test(p))) {
    const reach = graph(p)
    const hits = [...reach].filter(f => research.has(f))
    assert.deepEqual(hits, [], `${p} reaches research module(s): ${hits.join(', ')}`)
  }
})
