// agent/loop-regime-symbols.test.js — V3 C4 (SEQUENCE PR-4, WP-B B3): the
// quant phase's regime symbol set includes the tick universe.
//
// BEHAVIOURAL, not a source match: the actual lines of loop.js that build
// `regimeSymbols` are cut out of the (comment-stripped) file and EXECUTED
// against a fixture database. The reviewer's blocker was a TDZ throw —
// `const regimeSymbols = regimeSymbols({...})` — which a regex over the source
// stays green over, while the quant phase's outer catch silently skips the
// regime writes and the automatic entry-mode switch every cycle. Running the
// real slice turns that red.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from './db.js'

const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

function regimeSlice() {
  const loop = strip(readFileSync(new URL('./loop.js', import.meta.url), 'utf8'))
  const start = loop.indexOf('const { momentumUniverseSymbols: regimeUniverse }')
  const end = loop.indexOf('const { getRegimeBars }', start)
  assert.ok(start > 0 && end > start, 'the regime symbol block is where the quant phase builds it')
  const services = new URL('./services/', import.meta.url).href
  return loop.slice(start, end).replaceAll("import('./services/", `import('${services}`)
}

test('the quant phase\'s own lines build the regime set from scanned, momentum-universe AND tick names, without a TDZ throw', async () => {
  const db = initDB(':memory:')
  try {
    setState(db, 'tick_symbols_json', JSON.stringify(['xauusd', 'ZZTICKONLY']))
    const run = new AsyncFunction('db', 'recentScans', `${regimeSlice()}\nreturn regimeSymbols`)
    const out = await run(db, [{ symbol: 'eurusd' }, { symbol: 'EURUSD' }])
    const names = out.map(s => s.symbol)
    assert.ok(out.every(s => typeof s === 'object' && typeof s.symbol === 'string'), 'objects the regime loop destructures as { symbol }')
    assert.equal(names[0], 'EURUSD', 'scanned names lead, upper-cased and deduplicated')
    assert.ok(names.includes('ZZTICKONLY'), 'a tick-only name gets a regime row (RED if the tick source is dropped)')
    assert.ok(names.includes('XAUUSD'))
    assert.equal(names.length, new Set(names).size)
    assert.ok(names.indexOf('ZZTICKONLY') > names.indexOf('EURUSD'), 'tick names are appended after the existing sources')
  } finally { db.close() }
})
