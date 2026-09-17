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

// ---------------------------------------------------------------------------
// THE MIRROR, AND A WIDER NET (17-09-2026, third review).
//
// This file exists because "a call site that forgot would throw during a live
// stop move". Everything above it scans for take-profit intent only — yet
// `assertAmendIntent` is now symmetric, and the stop half is the HIGHER-RISK
// one: a forgotten take profit is upside forgone, a forgotten stop is unbounded
// downside on a live position.
//
// The file list was also the four sites measured wrong on 2026-08-22. Five more
// modules call amendPosition and none were scanned: the two that write
// protection on adopted positions (tp-suggest, target-restore), the shared door
// behind the HTTP route and the Telegram button (position-protect), and the two
// book paths (restrategize, momentum-book).
// ---------------------------------------------------------------------------

/**
 * Every amend call, however it is reached. The original `amendCalls` matches
 * `amendPosition(` only; five of the nine sites below call it through an
 * injected local (`amend(...)`, `deps.amend(...)`), which is exactly how they
 * stayed outside this file's net.
 */
function anyAmendCalls(code) {
  const out = []
  const re = /(?:deps\.|exec\.)?(?:exec)?[aA]mendPosition\(|\bamend\(/g
  let m
  while ((m = re.exec(code))) out.push(code.slice(m.index, m.index + 420))
  return out
}

/**
 * A call that passes a PRE-BUILT object (`amend(creds, args)`) carries no legs
 * at the call site, so the slice cannot answer for it. Rather than pretend, the
 * scan says so and falls back to asking whether the FILE sets that leg at all —
 * a weaker claim, stated as one.
 */
const passesPrebuiltObject = (call) => /amend(?:Position)?\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*\)/.test(call)

const legPresent = (call, fileSrc, re) => (passesPrebuiltObject(call) ? re.test(fileSrc) : re.test(call))

const ALL_SITES = [
  ['./services/profit-keeper.js', 'the SL ratchet'],
  ['./services/loss-guardian.js', 'the protective stop on a naked position'],
  ['./services/trade-guard.js', 'the break-even / trailing move'],
  ['./services/tp-suggest.js', 'the target applied to an adopted position'],
  ['./services/target-restore.js', 'the recorded target put back'],
  ['./services/position-protect.js', 'the HTTP route and the Telegram button'],
  ['./services/restrategize.js', 'the re-bracket'],
  ['./services/momentum-book.js', "the book's trail"],
  ['./loop.js', 'the strategy loop'],
]

for (const [rel, what] of ALL_SITES) {
  test(`${rel} — ${what} states its STOP-LOSS intent too`, () => {
    const src = read(rel)
    const calls = anyAmendCalls(src)
    assert.ok(calls.length > 0, `no amend call found in ${rel} — this test's anchor is gone`)
    for (const call of calls) {
      assert.ok(legPresent(call, src, /stopLoss|clearStopLoss/),
        `an amend call in ${rel} states no stop-loss intent — amend REPLACES, so it would clear the stop (and now throws)`)
    }
  })

  test(`${rel} — ${what} states its take-profit intent`, () => {
    const src = read(rel)
    for (const call of anyAmendCalls(src)) {
      assert.ok(legPresent(call, src, /takeProfit|clearTakeProfit/),
        `an amend call in ${rel} states no take-profit intent`)
    }
  })
}

test('the scan can actually fail — both halves, proven on a synthetic call', () => {
  // A scan whose assertion cannot go red is the failure this file warns about.
  const tpOnly = anyAmendCalls(strip('await amendPosition(creds, { positionId: 1, takeProfit: 2 })'))
  assert.equal(tpOnly.length, 1)
  assert.ok(!/stopLoss|clearStopLoss/.test(tpOnly[0]), 'the stop half would have caught this')

  const slOnly = anyAmendCalls(strip('await amendPosition(creds, { positionId: 1, stopLoss: 2 })'))
  assert.equal(slOnly.length, 1)
  assert.ok(!/takeProfit|clearTakeProfit/.test(slOnly[0]), 'the target half would have caught this')

  // An injected-local call is seen too, or five of the nine files are vacuous.
  assert.equal(anyAmendCalls(strip('await amend(creds, { positionId: 1, stopLoss: 2 })')).length, 1)
  // The pre-built-object fallback is recognised as such, not silently passed.
  assert.equal(passesPrebuiltObject('amend(creds, args)'), true)
  assert.equal(passesPrebuiltObject('amend(creds, { stopLoss: 1 })'), false)
  // And the comment stripper still works, or every scan above is vacuous.
  assert.ok(!strip('// amendPosition(creds, { stopLoss: 1 })').includes('amendPosition'))
})
