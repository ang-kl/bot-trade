// agent/lib/tick-strategy.test.js — P4: the reference oracle on planted
// fixtures, and the fixture + expected-signal files the C++ implementation
// is tested against (cpp-exec/src/tests/test_tick_strategy.cpp reads the
// same two files). If the oracle changes, this test rewrites the expected
// file only when REGEN=1; otherwise a drift fails here first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

import { TickMomentumOracle, runOracle, profileHash, profileHashFull, PROFILE_ID, normalizeParams, DEFAULT_PARAMS } from './tick-strategy.js'

const FIXTURE = new URL('../../cpp-exec/src/tests/fixtures/tick_momentum_fixture.json', import.meta.url)
const EXPECTED = new URL('../../cpp-exec/src/tests/fixtures/tick_momentum_expected.json', import.meta.url)

// A deterministic LCG so the fixture is reproducible across machines.
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 } }

/** The planted fixture: N=64 to keep it small; every scenario the state machine names. */
export function buildFixture() {
  const rnd = lcg(20260911)
  const ev = []
  let seq = 0, t = 1_757_548_800_000, bid = 100_000, ask = 100_010
  const push = (o = {}) => { seq++; t += 50; ev.push({ seq, recvMs: t, bid, ask, snapshot: false, crossed: false, changed: true, ...o }) }
  push({ snapshot: true })                       // the subscribe snapshot warms nothing
  // 1. warm-up: a bounded random walk (range ~ ±40)
  for (let i = 0; i < 90; i++) { const d = Math.round((rnd() - 0.5) * 6); bid = Math.max(99_960, Math.min(100_040, bid + d)); ask = bid + 10 + (rnd() < 0.1 ? 2 : 0); push() }
  push({ changed: false })                       // an identical repeat counts nowhere
  // 2. spread-only widening: the ask jumps far above the range on TWO consecutive events while the bid
  //    stays inside it — enough to confirm on mid alone, so only the two-sided rule (bid > frozen bidHigh)
  //    refuses it; then the spread closes and the range idles long enough for the momentum window to clear
  const keepBid = bid; ask = keepBid + 120; push(); ask = keepBid + 121; push(); ask = keepBid + 10; push()
  for (let i = 0; i < 20; i++) { const d = Math.round((rnd() - 0.5) * 4); bid = Math.max(99_960, Math.min(100_040, bid + d)); ask = bid + 10; push() }
  // 3. a genuine upward breakout: 12 events climbing fast with both sides above the prior range
  for (let i = 0; i < 12; i++) { bid += 9; ask = bid + 10; push() }
  // 4. an inefficient drift back inside the range (−4, +2 alternating: E ≈ 0.33 < 0.4, never a short), then cooldown events
  for (let i = 0; bid > 100_010; i++) { bid += (i % 2 === 0 ? -4 : 2); ask = bid + 10; push() }
  const floor4 = bid - 3, ceil4 = bid + 3   // bounded: the cooldown idles inside the range, it never breaks out by chance
  for (let i = 0; i < 30; i++) { const d = Math.round((rnd() - 0.5) * 4); bid = Math.max(floor4, Math.min(ceil4, bid + d)); ask = bid + 10; push() }
  // 5. a crossing that retraces before confirming (no signal), then a real short breakout
  bid -= 40; ask = bid + 10; push(); bid += 30; ask = bid + 10; push()
  for (let i = 0; i < 20; i++) { const d = Math.round((rnd() - 0.5) * 4); bid += d; ask = bid + 10; push() }
  for (let i = 0; i < 14; i++) { bid -= 9; ask = bid + 10; push() }
  // 6. a crossed quote invalidates; then a stale gap invalidates again
  push({ bid: ask + 5, crossed: true })
  const floor6 = bid - 12, ceil6 = bid + 12   // a bounded walk: no breakout can be planted here by chance
  for (let i = 0; i < 70; i++) { const d = Math.round((rnd() - 0.5) * 4); bid = Math.max(floor6, Math.min(ceil6, bid + d)); ask = bid + 10; push() }
  t += 120_000; push()
  for (let i = 0; i < 20; i++) { const d = Math.round((rnd() - 0.5) * 4); bid = Math.max(floor6, Math.min(ceil6, bid + d)); ask = bid + 10; push() }
  // 7. a one-sided update counts nowhere AND re-warms (plan §4: missing data invalidates) — last, so it costs the planted setups nothing
  push({ ask: null })
  return ev
}

const PARAMS = normalizeParams({ rangeEvents: 64, momentumEvents: 16, minEfficiency: 0.4, spreadBufferMult: 0.5, confirmations: 2, stopVolMult: 2, minStopPrice: 1, priceIncrement: 1, maxSpread: 200, maxQuoteAgeMs: 60_000 })

test('the planted fixture yields exactly one long and one short, the spread-only jump and the retracement yield nothing, invalid data warms nothing', () => {
  const events = buildFixture()
  const { signals, rejected, accepted } = runOracle(events, PARAMS)
  assert.equal(signals.length, 2, JSON.stringify(signals.map(s => [s.seq, s.side])))
  assert.equal(signals[0].side, 'BUY'); assert.equal(signals[1].side, 'SELL')
  assert.ok(signals[0].seq > 115 && signals[0].seq < 130, `long at ${signals[0].seq}`)
  assert.ok(!signals.some(s => s.seq >= 93 && s.seq <= 95), 'the two-event spread-only jump confirmed nothing')
  assert.ok(signals[1].seq > signals[0].seq + 60, `short at ${signals[1].seq}`)
  assert.equal(signals[0].confirmations, 2); assert.equal(signals[0].setupId, 1)
  assert.ok(signals[0].bid > signals[0].H / 2, 'the long needed the bid above the frozen range too')
  assert.ok(signals[0].stopDistance >= 1 && signals[0].E >= 0.4 && signals[0].D > 0)
  assert.ok(signals[1].D < 0 && signals[1].ask < signals[1].L / 2)
  assert.equal(rejected.repeat, 1); assert.equal(rejected.invalid, 3 /* snapshot + one-sided + crossed */); assert.equal(rejected.stale, 1)
  assert.ok(accepted > 280)
  // no lookahead: feeding the same events one by one gives the same signals as the batch run
  const o = new TickMomentumOracle(PARAMS); const one = []
  for (const q of events) { const s = o.feed(q); if (s) one.push(s) }
  assert.deepEqual(one, signals)
  // warm-up is exactly N+1 prior prices: with fewer, no setup can arm
  const short = new TickMomentumOracle(PARAMS)
  for (const q of events.slice(0, PARAMS.rangeEvents)) short.feed(q)
  assert.equal(short.state, 'WARMING')
  // a continuity break re-warms: an ARMED strategy fed a snapshot (or a one-sided update) drops its window and needs N+1 fresh events again
  for (const breaker of [{ snapshot: true }, { ask: null }]) {
    const o2 = new TickMomentumOracle(PARAMS)
    let seq = 0, t = 1_000_000
    const quiet = (over = {}) => { seq++; t += 50; return o2.feed({ seq, recvMs: t, bid: 100_000 + (seq % 7) * 2, ask: 100_010 + (seq % 7) * 2, snapshot: false, crossed: false, changed: true, ...over }) }
    for (let i = 0; i < PARAMS.rangeEvents + 2; i++) quiet()
    assert.equal(o2.state, 'ARMED', 'warm and inside its range')
    quiet(breaker)
    assert.equal(o2.state, 'WARMING', `${JSON.stringify(breaker)} re-warms`); assert.equal(o2.mids.length, 0)
    for (let i = 0; i < PARAMS.rangeEvents; i++) quiet()
    assert.equal(o2.state, 'WARMING', 'N prior events are not enough')
    quiet(); quiet()
    assert.equal(o2.state, 'ARMED', 'N+1 prior events and one inside the range arm again')
  }
  // the profile hash is stable and parameter-sensitive
  assert.equal(profileHash(PARAMS), profileHash({ ...PARAMS }))
  assert.notEqual(profileHash(PARAMS), profileHash({ ...PARAMS, minEfficiency: 0.55 }))
  assert.equal(normalizeParams({ rangeEvents: 128 }).momentumEvents, 32)
  assert.equal(DEFAULT_PARAMS.rangeEvents, 256)
})

test('the checked-in fixture and expected signals match the oracle (REGEN=1 rewrites them)', () => {
  const events = buildFixture()
  const { signals } = runOracle(events, PARAMS)
  const expected = { params: PARAMS, profileHash: profileHash(PARAMS), signals: signals.map(s => ({ seq: s.seq, side: s.side, trigger2: s.trigger2, bid: s.bid, ask: s.ask, stopDistance: s.stopDistance, setupId: s.setupId, confirmations: s.confirmations, H: s.H, L: s.L, B: s.B, D: s.D })) }
  const fixtureText = JSON.stringify({ params: PARAMS, events }, null, 0)
  const expectedText = JSON.stringify(expected, null, 1)
  if (process.env.REGEN === '1' || !existsSync(FIXTURE) || !existsSync(EXPECTED)) {
    writeFileSync(FIXTURE, fixtureText + '\n'); writeFileSync(EXPECTED, expectedText + '\n')
  }
  assert.equal(readFileSync(FIXTURE, 'utf8').trim(), fixtureText, 'fixture drifted: run with REGEN=1 and re-check the C++ test')
  assert.equal(readFileSync(EXPECTED, 'utf8').trim(), expectedText, 'expected signals drifted: run with REGEN=1 and re-check the C++ test')
})

// P5: the engine record pins the FULL sha256; the sidecar and the trial
// ledger print its first 16 characters, so the two match by prefix.
test('profileHashFull is the 64-hex sha256 whose first 16 characters are profileHash; PROFILE_ID names strategy@version', () => {
  const full = profileHashFull(PARAMS)
  assert.match(full, /^[0-9a-f]{64}$/)
  assert.equal(full.slice(0, 16), profileHash(PARAMS))
  assert.equal(profileHashFull({ ...PARAMS }), full)
  assert.notEqual(profileHashFull({ ...PARAMS, N: PARAMS.N + 1 }), full)
  assert.equal(PROFILE_ID, 'tick_momentum_breakout@v1')
})
