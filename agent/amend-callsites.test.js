// node --test agent/amend-callsites.test.js
//
// WHY A SOURCE SCAN OVER FOUR FILES. lib/amend-intent.test.js proves the rule
// is enforced; it cannot prove the callers SATISFY it. A call site that forgot
// would now throw at runtime — loudly, but during a live stop move, which is
// the worst moment to discover it. The four sites are the ones that were
// measured wrong on 2026-08-22, so they are pinned by name.
//
// Comments are stripped first (failure mode #2): every block above these calls
// explains the take-profit rule and names `takeProfit`, so a raw-source scan
// would stay green with the payload line deleted — exactly how
// amend-preserves-tp.test.js passed by matching its own explanation.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')

const read = (rel) => strip(readFileSync(new URL(rel, import.meta.url), 'utf8'))

/** Every `amendPosition(...)` / `execAmendPosition(...)` call in a file. */
function amendCalls(code) {
  const out = []
  const re = /(?:exec\.)?(?:exec)?[aA]mendPosition\(/g
  let m
  while ((m = re.exec(code))) {
    // Take a generous slice: these calls span several lines.
    out.push(code.slice(m.index, m.index + 420))
  }
  return out
}

const SITES = [
  ['./services/profit-keeper.js', 'the SL ratchet'],
  ['./services/loss-guardian.js', 'the protective stop on a naked position'],
  ['./services/trade-guard.js', 'the break-even / trailing move'],
]

for (const [rel, what] of SITES) {
  test(`${rel} — ${what} states its take-profit intent`, () => {
    const calls = amendCalls(read(rel))
    assert.ok(calls.length > 0, `no amendPosition call found in ${rel} — this test's anchor is gone`)
    for (const call of calls) {
      assert.match(call, /takeProfit|clearTakeProfit/,
        `an amendPosition call in ${rel} states no take-profit intent — it will throw at runtime`)
    }
  })
}

test('loop.js — BOTH amend sites state intent, including the runner leg', () => {
  // The runner-leg move after a scale-out was the one that forgot, and the
  // TP1-at-1R change (#738) made it fire after every partial.
  const calls = amendCalls(read('./loop.js'))
  assert.ok(calls.length >= 2, `expected at least 2 amend calls in loop.js, found ${calls.length}`)
  for (const call of calls) {
    assert.match(call, /takeProfit|clearTakeProfit/,
      'an amendPosition call in loop.js states no take-profit intent')
  }
})

test('the take profit is read from a REAL source, not invented', () => {
  // `takeProfit: 0` or a hardcoded number would satisfy the rule above while
  // inventing a target the position never had. Each site must read it from
  // the broker snapshot or the book row.
  for (const [rel] of SITES) {
    for (const call of amendCalls(read(rel))) {
      if (!/takeProfit:/.test(call)) continue
      assert.match(call, /takeProfit:[^,]*(bp|r)\.(takeProfit|current_tp)/s,
        `${rel} sets takeProfit from something other than the broker snapshot or the book row`)
    }
  }
})

test('the two rows that feed the fallback actually SELECT current_tp', () => {
  // `r.current_tp` is undefined unless the query asks for it, which would make
  // the fallback dead code and the guard decorative — on, configured, and out
  // of reach of what it guards (failure mode #3). Both files lacked it.
  for (const rel of ['./services/profit-keeper.js', './services/loss-guardian.js', './services/trade-guard.js']) {
    assert.match(read(rel), /SELECT[\s\S]{0,300}mp\.current_tp/,
      `${rel} reads r.current_tp but never selects it`)
  }
})
