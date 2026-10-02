// node --test agent/stop-policy-callsites.test.js
//
// WHERE THE STOP POLICY IS ALLOWED TO LIVE (02-10-2026). cTrader's amend
// REPLACES a position's protection, so a stop amend that builds its own
// trigger-method / trailing fields — or forgets them — can reset what the
// policy set. The rule is: the fields are stamped at ONE chokepoint
// (exec-engine.amendPosition → lib/stop-policy.js); callers only say what the
// stop MEANS (`stopContext`). A source scan keeps it that way, with comments
// stripped first (failure mode #2: a test must not pass on its own prose).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENT = fileURLToPath(new URL('.', import.meta.url))
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
const read = (rel) => strip(readFileSync(join(AGENT, rel), 'utf8'))

function productionFiles(dir = AGENT, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'test-support' || e.startsWith('.')) continue
    const full = join(dir, e)
    if (statSync(full).isDirectory()) productionFiles(full, out)
    else if (e.endsWith('.js') && !e.endsWith('.test.js')) out.push(full)
  }
  return out
}

// The only production files that may name the two fields: the policy itself
// and the js transport that forwards what the policy stamped.
const MAY_NAME_THE_FIELDS = new Set(['lib/stop-policy.js', 'lib/ctrader-ws.js'])

test('only the policy module and the js transport name the trigger-method / trailing fields', () => {
  const offenders = []
  for (const file of productionFiles()) {
    const rel = relative(AGENT, file)
    if (MAY_NAME_THE_FIELDS.has(rel)) continue
    if (/stopLossTriggerMethod|trailingStopLoss/.test(strip(readFileSync(file, 'utf8')))) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], 'a caller that builds these fields itself bypasses the chokepoint and can reset what the policy set')
})

test('the chokepoint stamps the policy before the amend is dispatched, in both transports', () => {
  const src = read('lib/exec-engine.js')
  const start = src.indexOf('export async function amendPosition(')
  assert.ok(start > 0, 'amendPosition not found — re-anchor')
  const body = src.slice(start, src.indexOf('export async function closePosition(', start))
  const stamp = body.indexOf('applyStopPolicyToAmend(args, getStopPolicy())')
  const cpp = body.indexOf("'/amend'")
  const js = body.indexOf('wsAmendPosition(')
  assert.ok(stamp > 0, 'amendPosition no longer stamps the stop policy')
  assert.ok(cpp > stamp && js > stamp, 'the policy must be applied before either transport is reached')
  assert.match(body, /noteAmendOutcome\(/, 'the first live evidence (GET /state/stop-policy) must be fed from the chokepoint')
})

test('every stop-moving site that knows what its stop means passes stopContext', () => {
  const sites = [
    ['services/profit-keeper.js', /stopContext: \{ side: r\.side/],
    ['services/trade-guard.js', /stopContext: \{ side: r\.side/],
    ['loop.js', /\.\.\.stopAmendExtras\(db, pos, ctx, accountId\)/],
  ]
  for (const [rel, re] of sites) assert.match(read(rel), re, `${rel}: the amend no longer tells the policy what the stop means (side/entry/book)`)
  // loop.js carries it on BOTH of its automatic stop amends: MOVE_SL and the runner leg.
  const loop = read('loop.js')
  assert.equal((loop.match(/\.\.\.stopAmendExtras\(db, pos, ctx, accountId\)/g) || []).length, 2, 'MOVE_SL and the runner leg both need the rail and the context')
})

test('the executor never sends expectedSymbolId: symbol_id_map belongs to the selected account', () => {
  const src = read('loop.js')
  const start = src.indexOf('export function stopAmendExtras(')
  const body = src.slice(start, src.indexOf('export function heldStop(', start))
  assert.doesNotMatch(body, /expectedSymbolId/, 'a position on another account would be refused on a wrong symbol id — a protection regression for a guard about direction')
})

test('the trail-config push sends the policy block (exec-engine) and both spec builders send the entry price', () => {
  assert.match(read('lib/exec-engine.js'), /trailConfigPolicy\(getStopPolicy\(\)\)/)
  assert.match(read('services/profit-keeper.js'), /entryPrice: Number\(bp\.price \?\? r\.entry_price\) > 0/)
  assert.match(read('services/mae-chandelier-observe.js'), /entryPrice: peak,/)
})
