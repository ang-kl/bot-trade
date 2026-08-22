// node --test agent/services/strategy-prefilter-rr.test.js
//
// NINE FILES EACH CARRIED `const MIN_RR = 1.5`, and one of them commented it
// "shared floor across all strategies" while being a private copy. Nothing was
// shared. The real gate moved to risk.js's HARD_MIN_RR = 3.0 — set at the
// measured 3.02 breakeven of a 24.9% win rate — and all nine stayed put.
//
// So every strategy self-approved a 2R setup against an abandoned number and
// handed it to a gate that refused it: 14,841 `bad_rr` vetoes in one day,
// 71% of everything the risk gate saw.
//
// THIS CHANGES NOTHING ABOUT WHAT TRADES. The value is the same 1.5 and the
// binding decision was always risk.js's. What it changes is that there is now
// ONE definition, so the next time the real floor moves, the divergence is a
// one-line edit instead of nine files quietly disagreeing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { STRATEGY_PREFILTER_RR } from '../lib/strategy-prefilter-rr.js'
import { STRATEGY_PREFILTER_RR as viaStrategies } from './strategies.js'
import { HARD_MIN_RR } from './risk.js'

test('the value is unchanged — this refactor must not move a threshold', () => {
  assert.equal(STRATEGY_PREFILTER_RR, 1.5)
  assert.equal(viaStrategies, STRATEGY_PREFILTER_RR, 'the re-export must be the same number')
})

test('IT IS NOT THE GATE, and the gap is the thing to remember', () => {
  // If these two ever converge, the pre-filter has become the gate and the
  // comment in strategies.js needs rewriting rather than this assertion
  // deleting.
  assert.ok(HARD_MIN_RR > STRATEGY_PREFILTER_RR,
    'the real floor must stay above the pre-filter, or the pre-filter is the gate')
  assert.equal(HARD_MIN_RR, 3.0)
})

test('NO STRATEGY CARRIES A PRIVATE COPY OF THE NUMBER', () => {
  // The actual guard. Comments are stripped first — this file's own prose and
  // several strategies' explanatory comments contain the literal, and a test
  // that passes by matching its own commentary is failure mode #2.
  const dir = new URL('.', import.meta.url)
  const offenders = []
  for (const f of readdirSync(dir).filter(n => n.endsWith('.js') && !n.includes('.test.'))) {
    const code = readFileSync(new URL(f, dir), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    if (/\bMIN_RR\s*=\s*1\.5/.test(code)) offenders.push(f)
  }
  assert.deepEqual(offenders, [], `these re-hardcoded the pre-filter: ${offenders.join(', ')}`)
})

test('every strategy that gates on it resolves the shared constant', async () => {
  // Proves the import actually reaches them: a file that imported the constant
  // and then shadowed it would pass the scan above and fail here.
  const dir = new URL('.', import.meta.url)
  const users = readdirSync(dir).filter(n => n.endsWith('.js') && !n.includes('.test.'))
    .filter(f => /\bMIN_RR\b/.test(readFileSync(new URL(f, dir), 'utf8')))
  assert.ok(users.length >= 8, `expected the strategy set, found ${users.length}`)
  for (const f of users) {
    const code = readFileSync(new URL(f, dir), 'utf8')
    assert.match(code, /STRATEGY_PREFILTER_RR/, `${f} uses MIN_RR without the shared constant`)
  }
})

test('the constant module imports nothing — that is what keeps it out of a cycle', () => {
  // The first attempt put this in strategies.js, which builds its registry from
  // the strategy modules; importing back produced a temporal-dead-zone error in
  // 128 tests. A leaf module cannot form that cycle, and must stay a leaf.
  const src = readFileSync(new URL('../lib/strategy-prefilter-rr.js', import.meta.url), 'utf8')
  assert.ok(!/^\s*import\s/m.test(src), 'this module must not import anything')
})
