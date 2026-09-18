// agent/lib/entry-producers.test.js — the inventory is pinned to the source.
//
// Same enforcement shape as exec-chokepoint.test.js: read the tree, and fail
// if a file places orders without being listed, or lists a route that does
// not exist. "All known entry producers mapped" (plan P0 exit evidence) is a
// test, not a sentence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ENTRY_PRODUCERS, PRODUCER_FAMILIES, ADMISSIONS, automaticProducers, retiredProducers, producersOutsideExecEngine, producerInventoryView } from './entry-producers.js'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.js') && !p.endsWith('.test.js')) out.push(p)
  }
  return out
}

const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const CALL = /execPlaceOrder\(|\bexec\.placeOrder\(|await autoTrade\(|deps\.autoTrade\(/

test('every agent file that places an order or calls autoTrade is in the inventory, and nothing is listed that does not', () => {
  const callers = new Set()
  for (const f of walk(join(ROOT, 'agent'))) {
    const rel = relative(ROOT, f)
    if (rel === 'agent/lib/exec-engine.js') continue // the chokepoint itself
    if (CALL.test(strip(readFileSync(f, 'utf8')))) callers.add(rel)
  }
  const listed = new Set(ENTRY_PRODUCERS.map(p => p.file).filter(f => f.startsWith('agent/')))
  for (const c of callers) assert.ok(listed.has(c), `${c} places orders but is not in ENTRY_PRODUCERS`)
  for (const l of listed) {
    if (l === 'agent/lib/exec-fallback.js') continue // raw transport, matched by exec-chokepoint.test.js instead
    assert.ok(callers.has(l), `${l} is listed but no longer places orders`)
  }
  assert.ok(callers.size >= 7, `expected the known producers, saw ${[...callers].join(', ')}`)
})

test('every route the inventory names exists in actions.js, and the C++ direct path is still direct', () => {
  const actions = readFileSync(join(ROOT, 'agent/routes/actions.js'), 'utf8')
  for (const p of ENTRY_PRODUCERS.filter(p => p.route)) {
    const path = p.route.replace(/^POST \/actions/, '')
    assert.ok(actions.includes(`router.post('${path}'`), `${p.id}: ${p.route} not found`)
  }
  const vpo = strip(readFileSync(join(ROOT, 'cpp-exec/src/vpo_dispatcher.cpp'), 'utf8'))
  assert.ok(vpo.includes('engine_.placeOrder('), 'the VPO tier still places orders in-process')
  const feeder = readFileSync(join(ROOT, 'agent/services/vpo-feeder.js'), 'utf8')
  assert.ok(feeder.includes('/vpo-config'), 'the feeder still arms it over /vpo-config')
  // P6b: the tick path places in-process too, and only with the keeper's permit.
  const firer = strip(readFileSync(join(ROOT, 'cpp-exec/src/tick_firer.cpp'), 'utf8'))
  assert.ok(firer.includes('engine_.placeOrder('), 'the tick firer still places through the engine (the send boundary)')
  assert.ok(firer.includes('permits_.take('), 'the tick firer takes a keeper permit before building a fire')
  const tickFeeder = strip(readFileSync(join(ROOT, 'agent/services/tick-permits.js'), 'utf8'))
  assert.ok(tickFeeder.includes('reserveStandingPermits('), 'the tick feeder issues permits through the ledger')
  assert.ok(tickFeeder.includes('tickEntryAccounts'), 'the tick feeder names the placing accounts on the push')
})

test('the shape of every entry, and the P2 work list', () => {
  const ids = new Set()
  for (const p of ENTRY_PRODUCERS) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`); ids.add(p.id)
    assert.ok(PRODUCER_FAMILIES.includes(p.family), `${p.id}: family ${p.family}`)
    assert.ok(ADMISSIONS.includes(p.admission), `${p.id}: admission ${p.admission}`)
    assert.ok(p.file && p.via, `${p.id}: file and via`)
    if (p.family === 'automatic') assert.ok(p.basis === 'bar' || p.basis === 'tick', `${p.id}: an automatic producer is bar- or tick-based`)
    if ('retired' in p) assert.match(p.retired, /^2026-\d\d-\d\d /, `${p.id}: a retirement names its date and reason`)
  }
  // Wave 1 (19-09-2026): burn_in_probe and vpo_cpp_direct are retired — listed for
  // the record, never scheduled, excluded from the mode-epoch fence's roster.
  assert.equal(automaticProducers().length, 6)
  assert.deepEqual(retiredProducers().map(p => p.id), ['burn_in_probe', 'vpo_cpp_direct'])
  assert.deepEqual(automaticProducers().filter(p => p.basis === 'tick').map(p => p.id), ['tick_momentum'], 'P6b: the one tick-basis producer')
  assert.deepEqual(producersOutsideExecEngine().map(p => p.id), ['vpo_cpp_direct', 'tick_momentum'], 'the two in-process sidecar paths the Node chokepoint does not cover (both fenced by the permit at the send boundary)')
  const v = producerInventoryView()
  assert.equal(v.total, ENTRY_PRODUCERS.length)
  assert.deepEqual(v.outsideExecEngine, ['vpo_cpp_direct', 'tick_momentum'])
})

test('wiring pin: GET /state/entry-producers and /state/runtime-manifest are routed', () => {
  const src = strip(readFileSync(join(ROOT, 'agent/routes/state.js'), 'utf8'))
  assert.ok(src.includes("router.get('/entry-producers'"))
  assert.ok(src.includes("router.get('/runtime-manifest'"))
})
