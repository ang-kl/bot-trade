// agent/lib/tick-exec-costs.test.js — §2 PR-2b and PR-2c: the SIZE-AWARE
// commission path, and measured-vs-assumed execution costs.
//
// PR-2b closes the two gaps the size-free model states it cannot express
// (the US-stock per-side minimum and FX's per-lot unit) WITHOUT changing a
// single number or a single behaviour on the size-free path — every existing
// caller must be byte-identical, and that is asserted here too.
//
// PR-2c pins the hard rule: matching the configured schedule proves the book
// charged what THIS REPO'S FILE says, never that the file matches the broker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { initDB } from '../db.js'
import {
  COST_CLASSES, costExact, costsForClass, loadRepoSchedule, loadSizedCommission,
  normalizeSchedule, repriceNetR, rowChargedUnder, SCHEDULE_MATCH_MEANS, scheduleHash,
  sizedCommissionUsdPerSide, sizedCommissionUsdRoundTrip, TICK_SHADOW_SIM_FILE, wireCostInt, WIRE_PER_PRICE,
} from './tick-cost-schedule.js'
import { costBasis, latencyForSim, latencySamples, MIN_LATENCY_SAMPLES, slippageEvidence } from './tick-exec-measurements.js'

const raw = () => JSON.parse(readFileSync(TICK_SHADOW_SIM_FILE, 'utf8'))
const SCH = () => loadRepoSchedule()
const NO_SIZED = { stockUsMinUsdPerSide: null, fxUsdPerLotPerSide: null }

// ───────────────────────────────────────────────────────────────────────────
// PR-2b — the two measured gaps, closed, and only on the sized path
// ───────────────────────────────────────────────────────────────────────────

test('US stock: the $0.02 PER SIDE MINIMUM is charged, and the per-share fee is read off the schedule\'s own wire term', () => {
  const row = costsForClass(SCH(), 'stock_us')
  const sized = loadSizedCommission()
  assert.equal(sized.stockUsMinUsdPerSide, 0.02)
  // 1 lot of a US stock is 100 shares here; at $0.02/share that is $2.00.
  const big = sizedCommissionUsdPerSide(row, 'stock_us', { priceUsd: 29.84, lots: 1, unitsPerLot: 100, sized })
  assert.equal(+big.usd.toFixed(6), 2)
  assert.equal(big.basis, 'per_share_with_minimum')
  assert.equal(big.note, null, 'the per-share fee is above the minimum here — nothing bound')
  // THE GAP: below one share, $0.02 x quantity falls under the minimum.
  const tiny = sizedCommissionUsdPerSide(row, 'stock_us', { priceUsd: 1222, lots: 0.005, unitsPerLot: 100, sized })
  assert.equal(+tiny.usd.toFixed(6), 0.02, 'half a share pays the $0.02 MINIMUM, not $0.01')
  assert.match(tiny.note, /minimum bound this side/)
  // the per-share figure is NOT a second copy of the number: it is the
  // schedule's own wire term, so zeroing that term moves this figure too
  const zeroed = { ...row, commissionWirePerSide: 0 }
  assert.equal(sizedCommissionUsdPerSide(zeroed, 'stock_us', { priceUsd: 29.84, lots: 1, unitsPerLot: 100, sized }).usd, 0.02,
    'with no per-share term only the minimum remains — the two paths read ONE number')
  assert.equal(row.commissionWirePerSide / WIRE_PER_PRICE, 0.02, '2000 wire units IS $0.02 of price')
  // with no configured minimum the shortfall is stated, not silently filled
  const noMin = sizedCommissionUsdPerSide(row, 'stock_us', { priceUsd: 1222, lots: 0.005, unitsPerLot: 100, sized: NO_SIZED })
  assert.equal(noMin.basis, 'per_share_no_minimum')
  assert.match(noMin.note, /UNDERCHARGES/)
})

test('FX: the $3.50 PER LOT per side is charged as a per-lot fee, not as the bps approximation', () => {
  const row = costsForClass(SCH(), 'fx')
  const sized = loadSizedCommission()
  assert.equal(sized.fxUsdPerLotPerSide, 3.5)
  const one = sizedCommissionUsdPerSide(row, 'fx', { priceUsd: 1.10, lots: 1, unitsPerLot: 100_000, sized })
  assert.equal(one.usd, 3.5); assert.equal(one.basis, 'per_lot')
  assert.equal(sizedCommissionUsdPerSide(row, 'fx', { priceUsd: 1.10, lots: 2.5, unitsPerLot: 100_000, sized }).usd, 8.75)
  // THE GAP IT CLOSES. 0.35 bps of notional is exact only for a USD-BASE pair.
  // On GBPUSD at 1.27 the bps shape over-charges — the config measures ~35%.
  const bpsShape = 0.35 * (1.27 * 1 * 100_000) / 10000
  assert.ok(bpsShape > 3.5, 'the bps approximation over-charges a GBP-base lot')
  assert.ok(Math.abs(bpsShape / 3.5 - 1.27) < 0.01, 'and by the proportion the config states')
  assert.equal(sizedCommissionUsdPerSide(row, 'fx', { priceUsd: 1.27, lots: 1, unitsPerLot: 100_000, sized }).usd, 3.5,
    'the sized path charges the fee, so the per-pair error is gone')
  // without a configured per-lot figure it falls back and SAYS which shape
  const fallback = sizedCommissionUsdPerSide(row, 'fx', { priceUsd: 1.27, lots: 1, unitsPerLot: 100_000, sized: NO_SIZED })
  assert.equal(fallback.basis, 'bps_of_notional')
  assert.match(fallback.note, /over-charges GBP-base/)
})

test('every other class keeps the bps-of-notional shape, because that is the shape its measurement has', () => {
  const sch = SCH(); const sized = loadSizedCommission()
  const hk = sizedCommissionUsdPerSide(costsForClass(sch, 'stock_hk'), 'stock_hk', { priceUsd: 100, lots: 1, unitsPerLot: 500, sized })
  assert.equal(hk.basis, 'bps_of_notional')
  assert.equal(+hk.usd.toFixed(4), +(15 * 50_000 / 10000).toFixed(4), '15 bps of a $50,000 notional')
  for (const c of ['index_cfd', 'crypto']) {
    const z = sizedCommissionUsdPerSide(costsForClass(sch, c), c, { priceUsd: 100, lots: 1, unitsPerLot: 1, sized })
    assert.equal(z.usd, 0); assert.equal(z.basis, 'zero', `${c} measured a genuine zero`)
  }
  // unpriceable inputs produce zero AND say so — never a confident number
  assert.equal(sizedCommissionUsdPerSide(costsForClass(sch, 'fx'), 'fx', { priceUsd: 1.1, lots: 0, unitsPerLot: 100_000, sized }).basis, 'unpriceable')
})

test('the round trip charges both sides at each side\'s own price, and scales linearly with the multiple', () => {
  const sized = loadSizedCommission()
  const row = costsForClass(SCH(), 'stock_us')
  const at = (k) => sizedCommissionUsdRoundTrip(row, 'stock_us', { entryUsd: 29.84, exitUsd: 31.00, lots: 1, unitsPerLot: 100, sized, multiple: k })
  assert.equal(+at(1).usd.toFixed(6), 4, '$2 per side on 100 shares')
  assert.equal(at(0).usd, 0)
  assert.equal(+at(2).usd.toFixed(6), 8)
})

test('NOTHING on the size-free path moved: the schedule, its hash and its numbers are unchanged', () => {
  const j = raw()
  const sch = normalizeSchedule(j.costs)
  const EXPECTED = {
    stock_us: { commissionWirePerSide: 2000, commissionBpsPerSide: 0, slippageWirePerSide: 0, slippageBpsPerSide: 0.5 },
    stock_hk: { commissionWirePerSide: 0, commissionBpsPerSide: 15, slippageWirePerSide: 0, slippageBpsPerSide: 0.5 },
    index_cfd: { commissionWirePerSide: 0, commissionBpsPerSide: 0, slippageWirePerSide: 0, slippageBpsPerSide: 0.5 },
    fx: { commissionWirePerSide: 0, commissionBpsPerSide: 0.35, slippageWirePerSide: 0, slippageBpsPerSide: 0.5 },
    commodity: { commissionWirePerSide: 0, commissionBpsPerSide: 0.08, slippageWirePerSide: 0, slippageBpsPerSide: 0.5 },
    crypto: { commissionWirePerSide: 0, commissionBpsPerSide: 0, slippageWirePerSide: 0, slippageBpsPerSide: 0.5 },
  }
  for (const c of COST_CLASSES) assert.deepEqual(sch.classes[c], EXPECTED[c], `${c} moved`)
  assert.equal(j.slippage, 0); assert.equal(j.commissionPerSide, 0); assert.equal(j.latencyMs, 250)
  // the sizedCommission block is NOT a class and NOT in the hash, so the
  // sidecar push and every stored evidence record are untouched by it
  assert.deepEqual(sch.unknownClasses, [], 'the new block must not appear as a class this repo cannot price')
  assert.equal(scheduleHash(sch), scheduleHash(normalizeSchedule({ classes: EXPECTED, fallbackClass: j.costs.fallbackClass })),
    'the schedule hash is blind to sizedCommission')
  // and the size-free arithmetic itself is untouched
  assert.equal(costExact(2000, 0, 2_984_000), 2000)
  assert.equal(wireCostInt(0, 0.5, 6851), 1, 'still rounds away from zero on a cheap symbol')
})

// ───────────────────────────────────────────────────────────────────────────
// PR-2c — measured vs assumed
// ───────────────────────────────────────────────────────────────────────────

function intent(db, id, createdAt, clientMsgId) {
  db.prepare(`INSERT INTO entry_intents (id, account_id, environment, symbol, symbol_id, side, producer_id, basis,
      mode_epoch, permit_id, permit_expires_at, state, client_msg_id, created_at, updated_at)
    VALUES (?, '1', 'demo', 'EURUSD', 1, 'BUY', 'tick_momentum', 'tick', 1, ?, '2026-01-01T00:00:00Z', 'FILLED', ?, ?, ?)`)
    .run(id, 'p' + id, clientMsgId, createdAt, createdAt)
}
function ack(db, seq, clientMsgId, tsMs) {
  db.prepare(`INSERT INTO cpp_events (side, boot_id, seq, ts_ms, client_msg_id, execution_type)
    VALUES ('cpp_exec_demo', 'b1', ?, ?, ?, 'ORDER_FILLED')`).run(seq, tsMs, clientMsgId)
}

test('LATENCY IS MEASURABLE: intent creation → broker acknowledgement yields a real p90 through the replayer\'s own path', () => {
  const db = initDB(':memory:')
  // nothing recorded → the fixed default, reported as ASSUMED
  const none = latencyForSim(db)
  assert.equal(none.measured, false); assert.equal(none.latencyMs, 250)
  assert.match(none.latencySource, /fixed/); assert.match(none.latencySource, /ASSUMED/)
  assert.equal(none.samples, 0)
  // a thin sample is still not a measurement, and says why
  const t0 = Date.parse('2026-09-20T00:00:00.000Z')
  for (let i = 0; i < 3; i++) { intent(db, `i${i}`, new Date(t0 + i * 1000).toISOString(), `m${i}`); ack(db, i, `m${i}`, t0 + i * 1000 + 100) }
  const thin = latencyForSim(db)
  assert.equal(thin.measured, false); assert.equal(thin.samples, 3)
  assert.match(thin.latencySource, new RegExp(`below the ${MIN_LATENCY_SAMPLES}`))
  // enough pairs → measured, and the p90 comes from resolveLatency itself
  // 14 fast acknowledgements and 3 slow ones: the p90 must land on the SLOW
  // tail, which is the whole reason the replayer takes a percentile.
  for (let i = 3; i < 20; i++) { intent(db, `i${i}`, new Date(t0 + i * 1000).toISOString(), `m${i}`); ack(db, i, `m${i}`, t0 + i * 1000 + (i >= 17 ? 900 : 120)) }
  const m = latencyForSim(db)
  assert.equal(m.measured, true); assert.equal(m.samples, 20)
  assert.match(m.latencySource, /^measured p90 of 20 samples$/)
  assert.equal(m.latencyMs, 900, 'the p90 of these 20 samples is the pessimistic tail, not the mean')
  // and what the reading IS is on the record — it is wider than network latency
  assert.match(latencySamples(db).note, /WIDER than network latency/)
})

test('latency samples: an acknowledgement before the intent, or an implausible gap, is counted apart and never averaged in', () => {
  const db = initDB(':memory:')
  const t0 = Date.parse('2026-09-20T00:00:00.000Z')
  intent(db, 'a', new Date(t0).toISOString(), 'ma'); ack(db, 1, 'ma', t0 - 5000)           // before
  intent(db, 'b', new Date(t0).toISOString(), 'mb'); ack(db, 2, 'mb', t0 + 10 * 60_000)    // implausible
  intent(db, 'c', new Date(t0).toISOString(), 'mc'); ack(db, 3, 'mc', t0 + 180)            // good
  const s = latencySamples(db)
  assert.deepEqual(s.samples, [180])
  assert.equal(s.skipped.negative, 1); assert.equal(s.skipped.implausible, 1)
  assert.equal(s.pairs, 3, 'every pair is accounted for')
})

test('SLIPPAGE IS NOT MEASURABLE HERE, and the check asks the schema rather than repeating this file\'s prose', () => {
  const db = initDB(':memory:')
  const ev = slippageEvidence(db)
  assert.equal(ev.available, false)
  assert.equal(ev.intentPriceColumn, null)
  assert.match(ev.reason, /entry_intents records no price the order was sent against/)
  // the reason is built from the LIVE column list, so it is a reading
  const cols = db.prepare('PRAGMA table_info(entry_intents)').all().map(c => c.name)
  for (const c of ['symbol', 'side', 'volume', 'sl', 'tp']) assert.ok(ev.reason.includes(c), `${c} must be in the reported column list`)
  assert.ok(!cols.some(c => /price/i.test(c)), 'confirming the baseline: entry_intents carries no price column at all')
  // and the placeholder is therefore RETAINED, and still labelled a placeholder
  const j = raw()
  for (const c of COST_CLASSES) {
    assert.equal(j.costs.classes[c].slippageBpsPerSide, 0.5)
    assert.match(j.costs.classes[c]._slippageSource, /PLACEHOLDER/)
  }
  assert.match(j.sizedCommission._slippage, /NOT HERE, AND NOT MEASURED/)
  // the day a price column exists this stops saying "no column" — the check
  // reads the schema, so it is a guard and not a decoration
  db.exec('ALTER TABLE entry_intents ADD COLUMN intended_price REAL')
  const after = slippageEvidence(db)
  assert.equal(after.intentPriceColumn, 'intended_price')
  assert.equal(after.available, false, 'a column with no paired fill is still not a measurement')
  assert.match(after.reason, /no row pairs with a fill/)
})

test('the cost basis reports each term as measured or assumed, and the slippage term carries its sensitivity', () => {
  const db = initDB(':memory:')
  const b = costBasis(db)
  assert.equal(b.latency.basis, 'assumed'); assert.equal(b.latency.ms, 250)
  assert.equal(b.slippage.basis, 'assumed'); assert.equal(b.slippage.available, false)
  assert.match(b.slippage.sensitivity, /0x, 1x and 2x/)
  assert.equal(b.commission.basis, 'measured_with_stated_gaps')
  assert.match(b.commission.source, /gaps/)
})

// ───────────────────────────────────────────────────────────────────────────
// THE HARD RULE
// ───────────────────────────────────────────────────────────────────────────

test('HARD RULE: matching the configured schedule proves the BOOK charged what THIS REPO\'S FILE says — never that the file matches the broker', () => {
  const sch = SCH()
  const fx = sch.classes.fx
  // a row the book really did charge the file's fx row
  const entry = 110_000, exit = 110_300, stopDistance = 100
  const comm = costExact(fx.commissionWirePerSide, fx.commissionBpsPerSide, entry)
             + costExact(fx.commissionWirePerSide, fx.commissionBpsPerSide, exit)
  const grossR = (exit - entry) / stopDistance
  const row = {
    cost_class: 'fx', commission_wire: 0, commission_bps: 0.35, slippage_wire: 0, slippage_bps: 0.5,
    entry, exit, stop_distance: stopDistance, gross_r: grossR, net_r: +(grossR - comm / stopDistance).toFixed(4), trade_side: 'BUY',
  }
  assert.equal(rowChargedUnder(row, sch).ok, true, 'this row WAS charged the file\'s schedule')

  // WHAT THAT DOES AND DOES NOT MEAN, stated once and asserted here.
  assert.match(SCHEDULE_MATCH_MEANS, /subtracted what agent\/config\/tick-shadow-sim\.json says/)
  assert.match(SCHEDULE_MATCH_MEANS, /not evidence that the file matches the broker/)
  assert.match(SCHEDULE_MATCH_MEANS, /placeholder/)

  // A DIFFERENT FILE MAKES THE SAME ROW REFUSE. That is the whole point: the
  // verdict is about agreement with a repo file, so it moves when the file
  // moves — it cannot be a statement about the broker, who did not move.
  const invented = normalizeSchedule({ classes: { fx: { commissionBpsPerSide: 99, slippageBpsPerSide: 0.5 } }, fallbackClass: 'fx' })
  assert.equal(rowChargedUnder(row, invented).ok, false)
  assert.equal(rowChargedUnder(row, invented).reason, 'cost_terms_differ')
  // and a row could be charged that invented schedule and pass just as well —
  // "charged" tracks the file, not reality
  const c2 = costExact(0, 99, entry) + costExact(0, 99, exit)
  const inventedRow = { ...row, commission_bps: 99, net_r: +(grossR - c2 / stopDistance).toFixed(4) }
  assert.equal(rowChargedUnder(inventedRow, invented).ok, true, 'a 99-bps world is equally "charged"')

  // NO WORDING ANYWHERE MAY IMPLY THE BROKER WAS VERIFIED.
  // Sentence by sentence, because a DENIAL of the claim is exactly what these
  // files are required to carry: "not evidence that the file matches the
  // broker" is the wording being enforced, not the wording being banned.
  const CLAIM = /(matches|verified against|proves|confirms|agrees with)\s+(the\s+)?(broker|reality|actual execution)|broker[- ]verified|proof that the schedule/i
  const DENIAL = /\b(not|never|no|nothing|cannot|neither|nor|without)\b/i
  for (const [name, text] of [
    ['SCHEDULE_MATCH_MEANS', SCHEDULE_MATCH_MEANS],
    ['tick-cost-schedule.js', readFileSync(new URL('./tick-cost-schedule.js', import.meta.url), 'utf8')],
    ['tick-exec-measurements.js', readFileSync(new URL('./tick-exec-measurements.js', import.meta.url), 'utf8')],
    ['tick-shadow-accounts.js', readFileSync(new URL('../services/tick-shadow-accounts.js', import.meta.url), 'utf8')],
    ['tick-shadow-sim.json', readFileSync(TICK_SHADOW_SIM_FILE, 'utf8')],
  ]) {
    for (const sentence of String(text).split(/(?<=[.;])\s|\n\n/)) {
      if (!CLAIM.test(sentence)) continue
      assert.ok(DENIAL.test(sentence), `${name} asserts the schedule was checked against the broker: ${sentence.trim().slice(0, 160)}`)
    }
  }
  // the check itself must be able to fail — an affirmative claim is caught
  assert.throws(() => {
    for (const sentence of 'the schedule matches the broker and always will.'.split(/(?<=[.;])\s|\n\n/)) {
      if (!CLAIM.test(sentence)) continue
      assert.ok(DENIAL.test(sentence), 'caught')
    }
  }, /caught/)
})

test('repricing at 0x / 1x / 2x remains available for every figure the account simulation reports', () => {
  const row = { cost_class: 'fx', commission_wire: 0, commission_bps: 0.35, slippage_wire: 0, slippage_bps: 0.5,
    entry: 110_000, exit: 110_300, stop_distance: 100, gross_r: 3, net_r: 3, trade_side: 'BUY' }
  const fx = costsForClass(SCH(), 'fx')
  const at = [0, 1, 2].map(k => repriceNetR(row, fx, k))
  assert.ok(at.every(x => x != null), 'every multiple prices')
  assert.ok(at[0] > at[1] && at[1] > at[2], 'more cost, less net — monotone')
})
