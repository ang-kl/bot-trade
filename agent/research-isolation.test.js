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
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { moduleImports } from './test-support/module-imports.js'
import * as acorn from 'acorn'
import { probeImportTimers } from './test-support/timer-probe.js'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Research modules: the ones that exist now; later steps add theirs here. */
export const RESEARCH_MODULES = [
  'agent/lib/research-config.js',
  'agent/lib/tick-bars.js',
  'agent/services/theory-gap.js',
  'agent/services/research-slot.js',
  'agent/services/bar-form-research-core.js',
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
  // The research DOORS (Claude · № 13,095, plan step 8): the bar-form job's
  // service and worker thread, and the tick research door that shares the
  // research slot with it. They reach the sidecar segment client and the
  // backtest (whose graph includes live readers); they hold no order
  // authority of their own and call no state writer (pinned below).
  'agent/services/bar-form-research.js',
  'agent/services/bar-form-research-worker.js',
  'agent/services/tick-research-run.js',
])

/**
 * Protected modules a research module may REACH by import for their pure,
 * read-only functions (the backtest reads regime.js meanAtr /
 * classifyVolFromBars and the regime gate's classifier). The boundary
 * script still forbids CHANGING them; this only says reading them is not
 * order authority.
 */
const READ_ONLY_PROTECTED = new Set(['agent/services/regime.js', 'agent/services/regime-gate.js'])
// Claude · № 15,001 15-Oct (owner: "#36 research isolation — CI step only when research files change" after № 14,989; claude-builder): the tick research door and its worker thread are doors too.
const RESEARCH_DOORS = ['agent/services/bar-form-research.js', 'agent/services/bar-form-research-worker.js',
  'agent/services/tick-research-run.js', 'agent/services/tick-research-worker.js']

export function protectedPaths() {
  const sh = readFileSync(join(ROOT, 'scripts/check-protected-boundary.sh'), 'utf8')
  const block = sh.split('# PROTECTED-BEGIN')[1]?.split('# PROTECTED-END')[0] ?? ''
  return block.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('PROTECTED=') && l !== ')')
}

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
// Claude · № 14,078+ 13-Oct (owner: NASA programme step 4; claude-builder).
// NASA finding C1: the line-start regex that stood here missed an inline
// `await import('./x.js')`, the second import on one line, and every
// `import(path)` whose target is a variable — strategies.js loads eight
// strategy modules that way, so the graph never followed them. Imports are
// now read from the syntax tree (test-support/module-imports.js). A dynamic
// import the parser cannot resolve must be DECLARED below (the loader or
// table that carries its literal targets); any other unresolved site fails
// the test that follows, instead of being assumed harmless.
// Codex P2 on #1355 (owner: "Per-site declaration"): a declaration excuses
// ONE unresolved site, by the function it sits in and its text — not the
// whole file. Another import(variable) in the same file still fails.
export const DECLARED_RESOLUTIONS = {
  'agent/services/strategies.js': { loaders: ['loadCompute'], site: { fn: 'loadCompute', text: 'import(path)' } },
  'agent/services/fast-monitor.js': { specProps: ['mod'], site: { fn: 'runProtectionBand', text: 'import(job.mod)' } },
}
// Is this unresolved site the one its file's declaration names?
export const declaredSite = (rel, u) => {
  const d = DECLARED_RESOLUTIONS[rel]
  return !!d?.site && u.fn === d.site.fn && u.text === d.site.text
}
const scanCache = new Map()
function scan(file) {
  const rel = relative(ROOT, file)
  if (!scanCache.has(rel)) scanCache.set(rel, moduleImports(readFileSync(file, 'utf8'), rel, DECLARED_RESOLUTIONS[rel] || {}))
  return scanCache.get(rel)
}
// Load time vs run time. A static import, a top-level `await import()` and a
// declared loader's literal target load with the module; a dynamic import
// inside a function loads only when that function runs. `loadOnly` follows
// the first kind alone.
function staticImports(file, { loadOnly = false } = {}) {
  const { specs, sites } = scan(file)
  const out = []
  for (const spec of new Set(specs)) {
    if (!spec.startsWith('.')) continue
    if (loadOnly) {
      const own = sites.filter(x => x.spec === spec)
      if (own.length && own.every(x => x.kind === 'dynamic' && x.fn !== null)) continue
    }
    out.push(relative(ROOT, resolve(dirname(file), spec)))
  }
  return out
}
function graph(start, opts = {}) {
  const seen = new Set(), stack = [start]
  while (stack.length) {
    const f = stack.pop()
    if (seen.has(f)) continue
    seen.add(f)
    const abs = join(ROOT, f)
    if (!existsSync(abs) || !/\.(js|mjs)$/.test(f)) continue
    for (const dep of staticImports(abs, opts)) stack.push(dep)
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
    const hits = [...reach].filter(f => forbidden.has(f) && !READ_ONLY_PROTECTED.has(f))
    assert.deepEqual(hits, [], `${mod} reaches protected/order-authority module(s): ${hits.join(', ')}`)
    const src = strip(readFileSync(join(ROOT, mod), 'utf8'))
    assert.ok(!/\bsetState\s*\(/.test(src), `${mod} calls setState`)
    assert.ok(!/\bsetAccountState\s*\(/.test(src), `${mod} calls setAccountState`)
  }
})

test('the research doors call no state writer', () => {
  for (const mod of RESEARCH_DOORS) {
    const src = strip(readFileSync(join(ROOT, mod), 'utf8'))
    assert.ok(!/\bsetState\s*\(/.test(src), `${mod} calls setState`)
    assert.ok(!/\bsetAccountState\s*\(/.test(src), `${mod} calls setAccountState`)
    assert.ok(!/\b(placeOrder|submitOrder|amendPosition|closePosition)\s*\(/.test(src), `${mod} calls an order function`)
    // № 15,001 (#36): the writers a door could reach by name — the engine
    // status writer, the validation importer and the exec-guard sync.
    assert.ok(!/\b(writeEngineStatus|importTickValidation|syncExecGuard)\s*\(/.test(src), `${mod} calls a state-writing function`)
  }
})

// ── Claude · № 15,001 15-Oct (owner: "#36 research isolation — CI step only when research files change" after № 14,989; claude-builder) ──
// The door test above reads a door's OWN source; a door's writes could sit
// in a module it imports (tick-validation.js's importTickValidation writes
// setAccountState; exec-guard-sync.js's syncExecGuard writes setState). So
// each door's imports from a WRITER module (one whose source calls setState /
// setAccountState / writeEngineStatus) or a protected / order-authority
// module are read from the syntax tree and must be exactly these read-only
// names — no default or namespace import — and each name's own body, and
// the same-module functions it calls, call no writer.
const WRITER_RE = /\b(setState|setAccountState|writeEngineStatus)\s*\(/
export const DOOR_READ_IMPORTS = {
  'agent/services/tick-research-run.js': {
    'agent/services/tick-validation.js': ['loadThresholds', 'replayChecks', 'shadowLiveFilters'],
    'agent/db.js': ['getState'],
    'agent/services/tick-permits.js': ['loadTickEntryConfig'],
    'agent/services/exec-guard-sync.js': ['tickSymbolNames'],
    'agent/lib/ctrader-creds.js': ['accountSymbolMapKey'],
    'agent/services/regime-gate.js': ['loadRegimeGateConfig', 'DEFAULT_MAX_REGIME_AGE_MIN'],
  },
  'agent/services/bar-form-research.js': { 'agent/db.js': ['getState'] },
  'agent/services/bar-form-research-worker.js': {},
  'agent/services/tick-research-worker.js': {},
}
const parse = (src) => acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })
/** A file's static import declarations: target spec and the names bound ('default', '*' or the imported name). */
export function importDeclarations(src) {
  return parse(src).body.filter(n => n.type === 'ImportDeclaration').map(n => ({
    spec: n.source.value,
    names: n.specifiers.map(s => s.type === 'ImportSpecifier' ? (s.imported.name ?? s.imported.value) : s.type === 'ImportDefaultSpecifier' ? 'default' : '*'),
  }))
}
/** Top-level declarations of a module by name → their source slice (exported or not). */
function topLevel(src) {
  const out = new Map()
  for (const n of parse(src).body) {
    const d = n.type === 'ExportNamedDeclaration' ? n.declaration : n
    if (!d) continue
    if (d.type === 'FunctionDeclaration' && d.id) out.set(d.id.name, src.slice(d.start, d.end))
    if (d.type === 'VariableDeclaration') for (const v of d.declarations) if (v.id?.type === 'Identifier') out.set(v.id.name, src.slice(v.start, v.end))
  }
  return out
}
/** Names whose body — or the body of any same-module declaration it calls — calls a writer. */
function writingNames(src, names) {
  const decls = topLevel(src)
  const bad = []
  for (const name of names) {
    if (!decls.has(name)) { bad.push(`${name} (not declared at top level)`); continue }
    const seen = new Set(); const stack = [name]
    while (stack.length) {
      const n = stack.pop(); if (seen.has(n)) continue; seen.add(n)
      const body = strip(decls.get(n) || '')
      if (WRITER_RE.test(body)) { bad.push(`${name} (via ${n})`); break }
      for (const [other] of decls) if (other !== n && new RegExp(`\\b${other}\\s*\\(`).test(body)) stack.push(other)
    }
  }
  return bad
}
/**
 * The violations of the rule for one door: [{ target, reason }]. `rootDir`
 * lets the synthetic controls below run on a temporary tree.
 */
export function doorImportViolations(doorRel, allow, { rootDir = ROOT, forbidden = new Set() } = {}) {
  const abs = join(rootDir, doorRel)
  const out = []
  for (const imp of importDeclarations(readFileSync(abs, 'utf8'))) {
    if (!imp.spec.startsWith('.')) continue
    const target = relative(rootDir, resolve(dirname(abs), imp.spec))
    const tAbs = join(rootDir, target)
    if (!existsSync(tAbs)) { out.push({ target, reason: 'target missing' }); continue }
    const tSrc = readFileSync(tAbs, 'utf8')
    const writer = WRITER_RE.test(strip(tSrc))
    if (!writer && !forbidden.has(target)) continue
    const allowed = allow[target] || []
    for (const name of imp.names) {
      if (name === 'default' || name === '*') { out.push({ target, reason: `${name === '*' ? 'namespace' : 'default'} import from a ${writer ? 'writer' : 'protected'} module` }); continue }
      if (!allowed.includes(name)) out.push({ target, reason: `${name} is not an allowlisted read-only import` })
    }
    for (const w of writingNames(tSrc, allowed.filter(n => imp.names.includes(n)))) out.push({ target, reason: `${w} calls a writer` })
  }
  // a dynamic import from a door must not target a writer or protected module
  for (const site of moduleImports(readFileSync(abs, 'utf8'), doorRel).sites) {
    if (site.kind !== 'dynamic' || !site.spec.startsWith('.')) continue
    const target = relative(rootDir, resolve(dirname(abs), site.spec))
    const tAbs = join(rootDir, target)
    if (existsSync(tAbs) && (forbidden.has(target) || WRITER_RE.test(strip(readFileSync(tAbs, 'utf8'))))) out.push({ target, reason: `dynamic import of a writer/protected module in ${site.fn || 'top level'}` })
  }
  return out
}

test('a research door imports only allowlisted read-only names from state-writing or protected modules, and each such name writes nothing', () => {
  const forbidden = new Set([...protectedPaths(), ...ORDER_AUTHORITY])
  for (const door of RESEARCH_DOORS) {
    assert.ok(door in DOOR_READ_IMPORTS, `${door} has no allowlist entry`)
    const v = doorImportViolations(door, DOOR_READ_IMPORTS[door], { forbidden })
    assert.deepEqual(v, [], `${door}: ${v.map(x => `${x.target}: ${x.reason}`).join('; ')}`)
  }
  // every allowlisted name is really imported (an allowlist that outlives its import is drift)
  for (const [door, byTarget] of Object.entries(DOOR_READ_IMPORTS)) {
    const imports = importDeclarations(readFileSync(join(ROOT, door), 'utf8'))
    for (const [target, names] of Object.entries(byTarget)) {
      const got = imports.filter(i => i.spec.startsWith('.') && relative(ROOT, resolve(dirname(join(ROOT, door)), i.spec)) === target).flatMap(i => i.names)
      for (const n of names) assert.ok(got.includes(n), `${door} no longer imports ${n} from ${target}`)
    }
  }
  // Positive controls on a synthetic tree: the checker flags what it is for.
  const dir = mkdtempSync(join(tmpdir(), 'door-ctl-'))
  try {
    writeFileSync(join(dir, 'w.js'), `export function importTickValidation(db) { setAccountState(db, 'a', 'k', 'v') }\nexport function pure() { return 1 }\nexport function viaHelper() { return helper() }\nfunction helper() { setState(null, 'k', 'v') }\n`)
    writeFileSync(join(dir, 'd1.js'), `import { importTickValidation } from './w.js'\n`)
    writeFileSync(join(dir, 'd2.js'), `import * as tv from './w.js'\n`)
    writeFileSync(join(dir, 'd3.js'), `import { pure } from './w.js'\n`)
    writeFileSync(join(dir, 'd4.js'), `import { viaHelper } from './w.js'\n`)
    writeFileSync(join(dir, 'd5.js'), `export async function f() { return import('./w.js') }\n`)
    const run = (door, allow) => doorImportViolations(door, allow, { rootDir: dir }).map(v => v.reason)
    assert.deepEqual(run('d1.js', {}), ['importTickValidation is not an allowlisted read-only import'])
    assert.deepEqual(run('d1.js', { 'w.js': ['importTickValidation'] }), ['importTickValidation (via importTickValidation) calls a writer'], 'allowlisting a writer does not pass it')
    assert.deepEqual(run('d2.js', {}), ['namespace import from a writer module'])
    assert.deepEqual(run('d3.js', { 'w.js': ['pure'] }), [], 'a pure function from a writer module, allowlisted, passes')
    assert.deepEqual(run('d4.js', { 'w.js': ['viaHelper'] }), ['viaHelper (via helper) calls a writer'], 'a write through a same-module helper is seen')
    assert.deepEqual(run('d5.js', {}), ['dynamic import of a writer/protected module in f'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the CI boundary job runs the script on every pull request, on a full-history checkout, and the script refuses a missing merge base', () => {
  // Codex P1 on #1380 (owner: "run the boundary job on every PR"): a
  // hand-kept research-path gate skipped the script when a research
  // dependency changed beside a protected file; the job is unconditional.
  const yml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  const job = yml.split('protected-boundary:')[1] ?? ''
  assert.ok(job, 'ci.yml defines the protected-boundary job')
  assert.match(job, /if: github\.event_name == 'pull_request'/)
  assert.match(job, /fetch-depth: 0/, 'the boundary job checks out full history (the script refuses a shallow clone)')
  assert.match(job, /run: bash scripts\/check-protected-boundary\.sh "origin\/\$\{\{ github\.base_ref \}\}"/)
  assert.doesNotMatch(job, /steps\.\w+\.outputs\.touched|RESEARCH-PATHS/, 'no research-file gate in front of the script')
  // the script itself refuses when there is no merge base, instead of reading OK
  const sh = readFileSync(join(ROOT, 'scripts/check-protected-boundary.sh'), 'utf8')
  assert.match(sh, /mb="\$\(git merge-base "\$BASE" HEAD 2>\/dev\/null\)"\nif \[\[ -z "\$mb" \]\]; then\n[^\n]*\n {2}exit 2\nfi\nchanged="\$\(git diff --name-only "\$mb" -- "\$\{PROTECTED\[@\]\}"\)"/, 'the merge base is computed, checked, and the diff runs against it with no silenced error')
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

test('no protected module LOADS a research module, even through the allowed importers', () => {
  // The allowed importers are routes and the report worker; a protected
  // module must not load research code through them either. Strict on the
  // load-time graph; run-time reach is the next test's.
  const research = new Set(RESEARCH_MODULES)
  // Positive control: an absence check on an empty graph proves nothing. The
  // load-time graph must hold what does load — loop.js's static db.js, and the
  // eight strategy modules strategies.js loads at top level through loadCompute
  // — and must not hold a function-level import (buildReport's theory-gap.js).
  const loopLoad = graph('agent/loop.js', { loadOnly: true })
  assert.ok(loopLoad.has('agent/db.js') && loopLoad.has('agent/services/performance-populations.js') === false, 'loop.js loads db.js; performance-populations.js is imported inside a function')
  assert.ok(graph('agent/services/strategies.js', { loadOnly: true }).has('agent/services/vwap-trend.js'), 'a top-level loadCompute target loads with the module')
  assert.ok(graph('agent/services/performance-populations.js').has('agent/services/theory-gap.js') && !graph('agent/services/performance-populations.js', { loadOnly: true }).has('agent/services/theory-gap.js'))
  for (const p of protectedPaths().filter(p => /\.(js|mjs)$/.test(p))) {
    const reach = graph(p, { loadOnly: true })
    const hits = [...reach].filter(f => research.has(f))
    assert.deepEqual(hits, [], `${p} loads research module(s): ${hits.join(', ')}`)
  }
})

// Claude · № 14,078+ 13-Oct (NASA finding C1). Run time: the line-start regex
// this file used never saw an import inside a function, so the protected →
// research check above was green partly by not looking. With the parser the
// run-time graph IS reachable — loop.js → performance-populations.js (the
// report worker, for readDecisionAudit) → buildReport → theory-gap.js, and
// loop.js → entry-mode-auto → entry-mode-gateway → routes/actions.js → the
// research door route handlers (and state.js's GET reads of the same jobs). These are the doors by design: the report
// worker runs a report KIND only when a route asks for it (on a Worker thread
// for a file database), and the research jobs start only from their POST
// routes. Every function-level import that ENTERS research code must be one
// of these; a new one anywhere fails here.
export const RUNTIME_DOORS = [
  { from: 'agent/services/performance-populations.js', fn: 'buildReport', route: null, to: 'agent/services/theory-gap.js' },
  { from: 'agent/services/performance-populations.js', fn: 'buildReport', route: null, to: 'agent/services/exit-counterfactual-extended.js' },
  // Codex P2 on #1355: each route callback is its own door (route named), so a
  // second route importing the same module is a second, undeclared entrance.
  { from: 'agent/routes/actions.js', fn: '<anonymous>', route: 'POST /tick-research', to: 'agent/services/tick-research-run.js' },
  { from: 'agent/routes/actions.js', fn: '<anonymous>', route: 'POST /tick-research/abort', to: 'agent/services/tick-research-run.js' },
  { from: 'agent/routes/actions.js', fn: '<anonymous>', route: 'POST /bar-form-research', to: 'agent/services/bar-form-research.js' },
  { from: 'agent/routes/actions.js', fn: '<anonymous>', route: 'POST /bar-form-research/abort', to: 'agent/services/bar-form-research.js' },
  // the GET read routes for the same two jobs (status and results)
  { from: 'agent/routes/state.js', fn: '<anonymous>', route: 'GET /bar-form-research-job', to: 'agent/services/bar-form-research.js' },
  { from: 'agent/routes/state.js', fn: '<anonymous>', route: 'GET /bar-form-research', to: 'agent/services/bar-form-research.js' },
  { from: 'agent/routes/state.js', fn: '<anonymous>', route: 'GET /tick-research-job', to: 'agent/services/tick-research-run.js' },
]
// One door per site: file, function, Express route (for route callbacks) and target.
export const doorKey = d => `${d.from} ${d.fn}()${d.route ? ` [${d.route}]` : ''} → ${d.to}`
test('every run-time import that enters research code is a declared door, and each door still exists', () => {
  const entering = new Set([...RESEARCH_MODULES, ...RESEARCH_DOORS, 'agent/services/tick-research-run.js', 'agent/services/exit-counterfactual-extended.js'])
  const found = []
  for (const abs of walk(join(ROOT, 'agent'))) {
    const rel = relative(ROOT, abs)
    if (entering.has(rel)) continue // inside research, imports among research modules
    for (const site of scan(abs).sites) {
      if (site.kind !== 'dynamic' || !site.spec.startsWith('.')) continue
      const to = relative(ROOT, resolve(dirname(abs), site.spec))
      if (entering.has(to)) found.push({ from: rel, fn: site.fn, route: site.route ?? null, to, line: site.line })
    }
  }
  const undeclared = found.filter(f => !RUNTIME_DOORS.some(d => doorKey(d) === doorKey(f))).map(f => `${doorKey(f)} (line ${f.line})`)
  assert.deepEqual(undeclared, [], 'a function-level import entering research code must be a declared door')
  for (const d of RUNTIME_DOORS) assert.equal(found.filter(f => doorKey(f) === doorKey(d)).length, 1, `declared door must match exactly one site: ${doorKey(d)}`)
  // The worker door runs off the trading thread for a file database: isolatedReport
  // hands buildReport to a Worker on this same file (source check, comments
  // stripped — the thread choice has no injection point).
  const src = strip(readFileSync(join(ROOT, 'agent/services/performance-populations.js'), 'utf8'))
  const iso = src.slice(src.indexOf('function isolatedReport('), src.indexOf('function isolatedReport(') + 1200)
  assert.match(iso, /if \(db\.memory \|\| db\.name === ':memory:'\) return run\(\)/)
  assert.match(iso, /new Worker\(new URL\(import\.meta\.url\)/)
})

/**
 * Amendment area 6 (remediation R5): the live modules the research graph
 * REACHES by import must have no import-time effect — no timer, interval or
 * immediate left armed by merely loading them. Each is imported in a fresh
 * process and the active handles counted after the import settles.
 */
const REACHED_LIVE = ['agent/services/managed-exit.js', 'agent/services/mae-chandelier-observe.js', 'agent/services/capped-hybrid-policy.js', 'agent/services/regime.js', 'agent/services/regime-gate.js', 'agent/services/strategies.js', 'agent/services/donchian-breakout.js', 'agent/scripts/backtest-fib.js', 'agent/services/tick-segments.js']
// NASA finding C2: this used to count Timeout objects in
// process._getActiveHandles(), which reads 0 for an armed interval on Node 22
// and Node 20 (measured 13-10). test-support/timer-probe.js counts timers at
// their source in a fresh process; its qualification is the next test.
test('the live modules research reaches arm nothing at import time (timers, intervals, immediates)', () => {
  for (const mod of REACHED_LIVE) {
    const { created, kinds, resources } = probeImportTimers(join(ROOT, mod), { cwd: ROOT })
    assert.equal(created, 0, `${mod} armed ${created} timer(s) at import: ${kinds.join(', ')}`)
    assert.equal(resources, 0, `${mod} left ${resources} active timer resource(s)`)
  }
})

// ---------------------------------------------------------------------------
// Qualification of the two instruments (NASA finding C, owner step 4:
// "deliberately violating fixtures must be detected"). Each violating case is
// one the replaced instrument let through; each clean case must read clean.
// ---------------------------------------------------------------------------
test('the import scanner sees every import form, and only code', () => {
  const specs = (src, o) => moduleImports(src, 'fixture.js', o).specs
  // violating: each of these reaches ./exec-engine.js
  for (const src of [
    "import a from './a.js'; import e from './exec-engine.js'",          // second import on one line
    "async function f() { return (await import('./exec-engine.js')).x }", // inline dynamic import
    'const m = cond ? null : import(`./exec-engine.js`)',               // template literal, mid-expression
    "export * from './exec-engine.js'",
    "export { placeOrder } from './exec-engine.js'",
    "const r = require('./exec-engine.js')",
    "await loadCompute('./exec-engine.js', 'placeOrder')",
  ]) assert.ok(specs(src, { loaders: ['loadCompute'] }).includes('./exec-engine.js'), src)
  // clean: the words appear only in comments and strings
  for (const src of [
    "// import e from './exec-engine.js'\nexport const x = 1",
    "/* await import('./exec-engine.js') */ export const y = 2",
    "const s = \"import('./exec-engine.js')\"; export { s }",
  ]) assert.deepEqual(specs(src), [], src)
  // a target the parser cannot read is reported, never dropped
  assert.equal(moduleImports('const p = x; await import(p)', 'f.js').unresolved.length, 1)
  assert.throws(() => moduleImports('import from from from', 'broken.js'), /broken\.js does not parse/)
})

test('every dynamic import under agent/ resolves to a literal or is declared, and each declaration still finds its targets', () => {
  const undeclared = []
  for (const abs of walk(join(ROOT, 'agent'))) {
    const rel = relative(ROOT, abs)
    const { unresolved } = scan(abs)
    undeclared.push(...unresolved.filter(u => !declaredSite(rel, u)).map(u => `${rel}:${u.line} ${u.fn ?? '<top>'}() ${u.text}`))
  }
  assert.deepEqual(undeclared, [], 'an import whose target is not a fixed string must be declared in DECLARED_RESOLUTIONS')
  for (const [rel, how] of Object.entries(DECLARED_RESOLUTIONS)) {
    const { declared, unresolved } = scan(join(ROOT, rel))
    assert.ok(declared.length > 0, `${rel}: the declared ${JSON.stringify(how)} finds no literal target — the declaration is stale`)
    assert.equal(unresolved.filter(u => declaredSite(rel, u)).length, 1, `${rel}: the declared site ${JSON.stringify(how.site)} is not exactly one unresolved import — the declaration is stale`)
  }
  // strategies.js's eight loaded modules are now in the research graph.
  const reach = graph('agent/services/strategies.js')
  for (const m of ['ema-pullback', 'donchian-breakout', 'rsi-meanrev', 'vwap-trend', 'vp-value', 'rsi2-reversion', 'fib-confluence', 'va-breakout']) {
    assert.ok(reach.has(`agent/services/${m}.js`), `${m}.js is reached through loadCompute`)
  }
})

// The runtimes this repo runs on: CI (.github/workflows/ci.yml node-version
// 22) and the production image (Dockerfile, Node 20). The probe is qualified
// on this process's runtime always; on any other listed binary present here
// as well. A probe that cannot run throws — it never skips.
const PROBE_RUNTIMES = [process.execPath, '/opt/node20/bin/node', '/opt/node22/bin/node'].filter((p, i, a) => a.indexOf(p) === i && existsSync(p))
test('the timer probe detects every timer a module leaves armed, on each runtime present, and reads a clean module as clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timer-probe-'))
  try {
    const fx = {
      // violating
      interval: ['setInterval(() => {}, 1e6)', 1],
      unrefInterval: ['setInterval(() => {}, 1e6).unref()', 1],
      unrefTimeout: ['setTimeout(() => {}, 1e6).unref()', 1],
      timersNamed: ["import { setInterval as si } from 'node:timers'\nsi(() => {}, 1e6).unref()", 1],
      timersDefault: ["import t from 'node:timers'\nt.setTimeout(() => {}, 1e6).unref()", 1],
      two: ['setInterval(() => {}, 1e6); setTimeout(() => {}, 1e6)', 2],
      // Codex P2 on #1355: a one-shot that re-arms itself through refresh()
      refreshed: ['const t = setTimeout(() => t.refresh(), 1); t.unref()', 1],
      schedulerWait: ["import { scheduler } from 'node:timers/promises'\nscheduler.wait(1e6, { ref: false })", 1],
      // Codex P2 on #1355: the promise API
      promisesTimeout: ["import { setTimeout as st } from 'node:timers/promises'\nst(1e6, undefined, { ref: false })", 1],
      promisesDefault: ["import tp from 'node:timers/promises'\ntp.setTimeout(1e6, undefined, { ref: false })", 1],
      promisesInterval: ["import { setInterval as si } from 'node:timers/promises'\nexport const it = si(1e6, undefined, { ref: false })", 1],
      // clean
      plain: ['export const x = 1', 0],
      firedOnce: ['setTimeout(() => {}, 0)', 0],
      cleared: ['const i = setInterval(() => {}, 1e6); clearInterval(i)', 0],
      immediateRan: ['setImmediate(() => {})', 0],
      promisesSettled: ["import { setTimeout as st } from 'node:timers/promises'\nawait st(1)", 0],
      schedulerWaited: ["import { scheduler } from 'node:timers/promises'\nawait scheduler.wait(1)", 0],
      promisesIntervalClosed: ["import { setInterval as si } from 'node:timers/promises'\nconst it = si(1e6); await it.return()", 0],
    }
    for (const [name, [src]] of Object.entries(fx)) writeFileSync(join(dir, `${name}.mjs`), src + '\n')
    assert.ok(PROBE_RUNTIMES.length >= 1)
    for (const node of PROBE_RUNTIMES) {
      for (const [name, [, want]] of Object.entries(fx)) {
        const { created } = probeImportTimers(join(dir, `${name}.mjs`), { node, cwd: dir })
        assert.equal(created, want, `${node}: ${name}`)
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Codex P2 on #1355: the declaration names one site; a second import(variable)
// in a declared file is not excused.
test('a declared file excuses only its declared site: a second import(variable) there is caught', () => {
  const rel = 'agent/services/strategies.js'
  const src = readFileSync(join(ROOT, rel), 'utf8') + '\nexport async function sneak(p) { return import(p) }\n'
  const { unresolved } = moduleImports(src, rel, DECLARED_RESOLUTIONS[rel])
  const excused = unresolved.filter(u => declaredSite(rel, u)), caught = unresolved.filter(u => !declaredSite(rel, u))
  assert.equal(excused.length, 1)
  assert.deepEqual(caught.map(u => [u.fn, u.text]), [['sneak', 'import(p)']])
})

// Codex P2 on #1355: two route callbacks importing the same research module are
// two sites; a require() inside a function is a run-time site like import().
test('the scanner gives each route callback its own site, and records require() as a site', () => {
  const src = `
router.post('/bar-form-research', async (req, res) => { const m = await import('../services/bar-form-research.js'); res.json(m) })
router.post('/sneak', async (req, res) => { const m = await import('../services/bar-form-research.js'); res.json(m) })
export function late() { return require('../services/theory-gap.js') }
const early = require('./x.js')`
  const { sites } = moduleImports(src, 'agent/routes/actions.js')
  const routes = sites.filter(x => x.spec === '../services/bar-form-research.js').map(x => x.route)
  assert.deepEqual(routes, ['POST /bar-form-research', 'POST /sneak'])
  const keys = routes.map(route => doorKey({ from: 'agent/routes/actions.js', fn: '<anonymous>', route, to: 'agent/services/bar-form-research.js' }))
  assert.equal(new Set(keys).size, 2, 'two routes, two door keys')
  assert.ok(!RUNTIME_DOORS.some(d => doorKey(d) === keys[1]), 'the /sneak route is not a declared door')
  const req = sites.filter(x => x.via === 'require')
  assert.deepEqual(req.map(x => [x.spec, x.kind, x.fn]), [['../services/theory-gap.js', 'dynamic', 'late'], ['./x.js', 'static', null]])
})

// Codex P2 on #1355: a require made by createRequire under another name is a require.
test('a name bound to createRequire(...) is read like require()', () => {
  const src = `import { createRequire } from 'node:module'
import * as mod from 'node:module'
const load = createRequire(import.meta.url)
const load2 = mod.createRequire(import.meta.url)
export function a() { return load('../services/theory-gap.js') }
export function b() { return load2('../services/bar-form-research.js') }
export function c(p) { return load(p) }
const other = (x) => x
other('./not-an-import.js')`
  const r = moduleImports(src, 'agent/services/x.js')
  assert.deepEqual(r.sites.filter(x => x.via === 'require').map(x => [x.spec, x.fn]), [['../services/theory-gap.js', 'a'], ['../services/bar-form-research.js', 'b']])
  assert.deepEqual(r.unresolved.map(u => [u.kind, u.fn]), [['load()', 'c']])
  assert.ok(!r.specs.includes('./not-an-import.js'))
})

// ── Claude · № 15,074 16-Oct (owner on #1381: "add a marker in a follow-up"; claude-builder) ──
// Expected outcomes: the script's own exit-code contract (0 identical or
// authorised, 1 differing, 2 no base); the marker form is self-derived.
test('the boundary script passes a differing protected path only when the PR body names it in a Protected-change-authorised line', async () => {
  const { mkdirSync, writeFileSync, copyFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { execFileSync, spawnSync } = await import('node:child_process')
  const { mkdtempSync } = await import('./test-support/temp-dir.js') // removed at exit: the gate's TMPDIR hygiene check
  const dir = mkdtempSync(join(tmpdir(), 'boundary-'))
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'agent'), { recursive: true })
  copyFileSync(join(ROOT, 'scripts/check-protected-boundary.sh'), join(dir, 'scripts/check-protected-boundary.sh'))
  writeFileSync(join(dir, 'agent/loop.js'), 'export const a = 1\n')
  git('add', '-A'); git('commit', '-qm', 'base')
  git('checkout', '-qb', 'work')
  writeFileSync(join(dir, 'agent/loop.js'), 'export const a = 2\n')
  git('commit', '-qam', 'change loop')
  const run = (env) => spawnSync('bash', ['scripts/check-protected-boundary.sh', 'main'], { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' })
  const plain = run({ PROTECTED_AUTHORISED: '' })
  assert.equal(plain.status, 1, plain.stdout + plain.stderr)
  assert.match(plain.stdout, /FAIL — protected path\(s\) differ[\s\S]*agent\/loop\.js/)
  const marked = run({ PROTECTED_AUTHORISED: 'Scan only what is open.\n\nProtected-change-authorised: agent/loop.js (owner, § 15,032·C)\n' })
  assert.equal(marked.status, 0, 'RED before: the job had no way to carry the owner\'s authorisation — ' + marked.stdout + marked.stderr)
  assert.match(marked.stdout, /OK — protected path\(s\) differ from main under an owner-authorisation marker:\n {2}agent\/loop\.js/)
  const wrong = run({ PROTECTED_AUTHORISED: 'Protected-change-authorised: agent/services/risk.js (owner)\n' })
  assert.equal(wrong.status, 1, 'a marker naming a different path authorises nothing')
  assert.match(wrong.stdout, /FAIL[\s\S]*agent\/loop\.js/)
  // locally, with no PR body, HEAD's commit message carries the line
  git('commit', '-q', '--amend', '-m', 'change loop\n\nProtected-change-authorised: agent/loop.js (owner, test)')
  const fromCommit = spawnSync('bash', ['scripts/check-protected-boundary.sh', 'main'], { cwd: dir, env: { ...process.env, PROTECTED_AUTHORISED: undefined }, encoding: 'utf8' })
  assert.equal(fromCommit.status, 0, fromCommit.stdout + fromCommit.stderr)
})

test('the CI boundary job hands the PR body to the script as an environment variable, not a shell interpolation, and runs when the body is edited', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  // Codex P1 on #1383: a marker added to the body after the push must re-run the job; a removed one must un-green it
  assert.match(yml, /on:\n {2}pull_request:\n(?: {4}#[^\n]*\n)* {4}types: \[opened, synchronize, reopened, edited\]\n/)
  const job = yml.slice(yml.indexOf('  protected-boundary:'))
  assert.match(job, /env:\n {10}PROTECTED_AUTHORISED: \$\{\{ github\.event\.pull_request\.body \}\}\n {8}run: bash scripts\/check-protected-boundary\.sh "origin\/\$\{\{ github\.base_ref \}\}"/)
})
