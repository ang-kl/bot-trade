// agent/lib/tick-cost-schedule.test.js — PR-L: the tick shadow's cost model.
//
// What this pins, in the order the PR argued it:
//   1. every symbol of the CURRENT tick-observation universe classifies, and
//      anything that does not is REPORTED rather than absorbed;
//   2. a US stock and an FX pair pay different per-fill costs for the same
//      nominal move — the defect a single flat number had;
//   3. the config's own `_note` / `_sources` claims are checked where they
//      are checkable, including that the measured numbers are the ones in the
//      file and that the slippage figure is labelled a placeholder;
//   4. the sensitivity line computes at 0 ×, 1 × and 2 × and is EXACT at 1 ×
//      against the trade's own schedule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

import {
  COST_CLASSES, classifyUniverse, costClassOf, costsForClass, costSensitivity, costExact,
  loadRepoSchedule, normalizeSchedule, profitFactorOf, repriceNetR, scheduleHash, wireCostInt,
} from './tick-cost-schedule.js'

const CONFIG = new URL('../config/tick-shadow-sim.json', import.meta.url)
const UNIVERSE = new URL('../config/momentum-universe.json', import.meta.url)
const raw = () => JSON.parse(readFileSync(CONFIG, 'utf8'))

test('every symbol of the tick-observation universe classifies, and nothing falls through unreported', () => {
  // config/tick-observation.json carries symbols: "momentum-universe", so the
  // universe file IS the set of names the recorder is asked to carry.
  const obs = JSON.parse(readFileSync(new URL('../config/tick-observation.json', import.meta.url), 'utf8'))
  assert.equal(obs.symbols, 'momentum-universe', 'the observation universe is the momentum universe; update this test if that changes')
  const u = JSON.parse(readFileSync(UNIVERSE, 'utf8'))
  const names = Object.entries(u).filter(([k]) => !k.startsWith('_')).flatMap(([, v]) => v)
  assert.ok(names.length >= 40, `the universe should be the real one, got ${names.length}`)
  const { map, unclassified, fallbackClass } = classifyUniverse(names, loadRepoSchedule(CONFIG))
  assert.deepEqual(unclassified, [], `every universe symbol must classify; unclassified: ${unclassified.join(', ')}`)
  assert.equal(Object.keys(map).length, new Set(names.map(n => n.toUpperCase())).size)
  // and the classes actually used are the ones the schedule prices
  for (const cls of new Set(Object.values(map))) assert.ok(COST_CLASSES.includes(cls), `${cls} is not a priced class`)
  // spot checks across the six
  assert.equal(map['AAPL.US'], 'stock_us')
  assert.equal(map['0700.HK'], 'stock_hk')
  assert.equal(map.NAS100, 'index_cfd')
  assert.equal(map.EURUSD, 'fx')
  assert.equal(map.XAUUSD, 'commodity')
  assert.equal(map.NATGAS, 'commodity', 'the universe\'s "NatGas" is keyed upper-cased')
  assert.equal(map.BTCUSD, 'crypto')
  assert.equal(fallbackClass, 'stock_hk')
  // a name outside the taxonomy is REPORTED, not silently priced
  const odd = classifyUniverse(['SIE.DE', 'WTFUSD?', 'AAPL.US'], loadRepoSchedule(CONFIG))
  assert.deepEqual(odd.unclassified, ['SIE.DE', 'WTFUSD?'])
  assert.deepEqual(odd.map, { 'AAPL.US': 'stock_us' })
  // …and then charged the FALLBACK, which is the most expensive class
  const sch = loadRepoSchedule(CONFIG)
  const fell = costsForClass(sch, costClassOf('SIE.DE'))
  assert.equal(fell.class, 'stock_hk')
  assert.equal(fell.source, 'fallback_unclassified')
  for (const c of COST_CLASSES) {
    assert.ok(sch.classes[c].commissionBpsPerSide + sch.classes[c].slippageBpsPerSide <= fell.commissionBpsPerSide + fell.slippageBpsPerSide,
      `${c} must not cost more than the fallback class, or an unclassified symbol is charged too little`)
  }
})

test('a US stock and an FX pair pay DIFFERENT costs, and the two cost SHAPES behave differently with price', () => {
  const sch = loadRepoSchedule(CONFIG)
  const us = costsForClass(sch, 'stock_us'), fx = costsForClass(sch, 'fx'), hk = costsForClass(sch, 'stock_hk')
  // US stock is a FLAT per-share fee, HK stock and FX are proportional
  assert.equal(us.commissionWirePerSide, 2000); assert.equal(us.commissionBpsPerSide, 0)
  assert.equal(fx.commissionWirePerSide, 0); assert.equal(fx.commissionBpsPerSide, 0.35)
  assert.equal(hk.commissionWirePerSide, 0); assert.equal(hk.commissionBpsPerSide, 15)
  const price = 1_000_000
  const comm = (c, p) => costExact(c.commissionWirePerSide, c.commissionBpsPerSide, p)
  assert.equal(comm(us, price), 2000)
  assert.equal(comm(fx, price), 35)
  assert.equal(comm(hk, price), 1500)
  assert.notEqual(comm(us, price), comm(fx, price), 'a US stock and an FX pair must not pay one number')
  // the FLAT term does not move with price; the proportional one does. This is
  // the whole reason a class row carries both: quoting the US fee in bps made
  // a $30 stock read 6.8 bps and a $1,200 stock 0.16 bps for the same $0.02.
  assert.equal(comm(us, 2 * price), 2000)
  assert.equal(comm(fx, 2 * price), 70)
  assert.equal(comm({ commissionWirePerSide: 0, commissionBpsPerSide: 0 }, price), 0)
})

test('COMMISSION is never quantised and SLIPPAGE rounds away from zero — a cheap symbol is not free (checker finding 4)', () => {
  const sch = loadRepoSchedule(CONFIG)
  const crypto = costsForClass(sch, 'crypto')
  // DOGEUSD traded in the owner's own statements at 0.06851 → 6,851 wire units.
  // 0.5 bps of that is 0.343: Math.round gives 0, which is the zero-cost bug
  // this PR exists to remove.
  const doge = 6851
  assert.ok(costExact(0, crypto.slippageBpsPerSide, doge) > 0.34 && costExact(0, crypto.slippageBpsPerSide, doge) < 0.35)
  assert.equal(Math.round(costExact(0, crypto.slippageBpsPerSide, doge)), 0, 'plain rounding would make it free')
  assert.equal(wireCostInt(0, crypto.slippageBpsPerSide, doge), 1, 'away from zero: never a free fill')
  assert.equal(wireCostInt(0, 0, doge), 0, 'a zero cost stays zero')
  assert.equal(wireCostInt(0, 1, 0), 0, 'no price, no proportional cost')
  // and the commission path keeps the fraction rather than rounding it
  const pricey = costsForClass(sch, 'fx')
  assert.ok(costExact(pricey.commissionWirePerSide, pricey.commissionBpsPerSide, doge) > 0.23)
  // the replayer must actually charge it: the same trade on a 0.5-bps class
  // is worse than on a free one, at DOGE prices
  const t = { trade_side: 'BUY', entry: 6851, exit: 7851, stop_distance: 500, slippage_bps: 0, commission_bps: 0 }
  const free = repriceNetR(t, { commissionWirePerSide: 0, commissionBpsPerSide: 0, slippageWirePerSide: 0, slippageBpsPerSide: 0 }, 1)
  const charged = repriceNetR(t, crypto, 1)
  assert.ok(charged < free, `a cheap symbol must not be free: ${charged} vs ${free}`)
})

test('the replayer charges a US stock and an FX pair differently from the same events', async () => {
  const { simulate } = await import('./tick-replay-sim.js')
  // One planted signal, one symbol's worth of events; only the class differs.
  const events = []
  for (let i = 1; i <= 40; i++) events.push({ seq: i, recvMs: 1_000_000 + i * 100, bid: 1_000_000, ask: 1_000_020, snapshot: false, crossed: false, changed: true })
  const signal = { seq: 1, recvMs: 1_000_100, side: 'BUY', bid: 1_000_000, ask: 1_000_020, stopDistance: 4000 }
  const sch = loadRepoSchedule(CONFIG)
  const run = (costClass) => simulate(events, {}, { costs: sch, costClass, minTargetToCost: 0, maxHoldEvents: 5, maxHoldMs: 6 * 3600_000 }, { signalsOverride: [signal] })
  const us = run('stock_us'), fx = run('fx'), hk = run('stock_hk')
  assert.equal(us.trades.length, 1); assert.equal(fx.trades.length, 1); assert.equal(hk.trades.length, 1)
  assert.equal(us.sim.costClass, 'stock_us'); assert.equal(us.sim.costSource, 'class')
  assert.equal(us.sim.commissionWirePerSide, 2000); assert.equal(fx.sim.commissionBpsPerSide, 0.35)
  // same events, same gross move — but not the same net
  assert.notEqual(us.trades[0].netR, fx.trades[0].netR)
  assert.ok(us.trades[0].netR < fx.trades[0].netR, 'a flat $0.02/share on a 1.00-priced instrument is dearer than 0.35 bps')
  assert.ok(hk.trades[0].netR < fx.trades[0].netR, 'HK stock at 15 bps nets less than FX at 0.35')
  // and a flat sim with no schedule is the OLD behaviour, exactly
  const flat = simulate(events, {}, { minTargetToCost: 0, maxHoldEvents: 5, maxHoldMs: 6 * 3600_000 }, { signalsOverride: [signal] })
  assert.equal(flat.sim.costClass, null); assert.equal(flat.sim.costSource, 'none')
  assert.equal(flat.trades[0].netR, flat.trades[0].grossR, 'no schedule, no absolute cost → net is gross')
  assert.ok(us.trades[0].netR < us.trades[0].grossR, 'the schedule must actually bite')
})

test('the config\'s own claims hold: every value is pinned by NUMBER, and the placeholder says placeholder', () => {
  const j = raw()
  assert.match(j._note, /commissionWirePerSide \+ commissionBpsPerSide/)
  assert.match(j._sources, /MEASURED/)
  assert.match(j._sources, /PLACEHOLDER/)
  assert.match(j._sources, /683 deal rows parse/, 'the n must be the n the file actually yields')
  // the _note claims the legacy global pair stays 0 and ADDS on top
  assert.equal(j.slippage, 0); assert.equal(j.commissionPerSide, 0)
  const sch = normalizeSchedule(j.costs)
  assert.deepEqual(Object.keys(sch.classes).sort(), [...COST_CLASSES].sort())
  assert.deepEqual(sch.unknownClasses, [], 'the config must not carry a class this repo cannot price')

  // CHECKER FINDING 7 + 8: every measured number pinned BY VALUE, not by a
  // prose string containing the word MEASURED. Zeroing any one of these is red.
  const EXPECTED = {
    stock_us: { commissionWirePerSide: 2000, commissionBpsPerSide: 0, slippageWirePerSide: 0, slippageBpsPerSide: 0.5 },
    stock_hk: { commissionWirePerSide: 0, commissionBpsPerSide: 15, slippageWirePerSide: 0, slippageBpsPerSide: 0.5 },
    index_cfd: { commissionWirePerSide: 0, commissionBpsPerSide: 0, slippageWirePerSide: 0, slippageBpsPerSide: 0.5 },
    fx: { commissionWirePerSide: 0, commissionBpsPerSide: 0.35, slippageWirePerSide: 0, slippageBpsPerSide: 0.5 },
    commodity: { commissionWirePerSide: 0, commissionBpsPerSide: 0.08, slippageWirePerSide: 0, slippageBpsPerSide: 0.5 },
    crypto: { commissionWirePerSide: 0, commissionBpsPerSide: 0, slippageWirePerSide: 0, slippageBpsPerSide: 0.5 },
  }
  for (const c of COST_CLASSES) assert.deepEqual(sch.classes[c], EXPECTED[c], `${c} moved — every cost number is pinned by value`)

  for (const c of COST_CLASSES) {
    const row = j.costs.classes[c]
    assert.ok(typeof row._commissionSource === 'string' && row._commissionSource.length > 20, `${c} must say where its commission came from`)
    assert.match(row._slippageSource, /PLACEHOLDER/, `${c}'s slippage must NOT be presented as a measurement`)
  }
  // the classes whose figure is NOT a class-wide measurement, or not in the
  // unit the broker actually charges, say so
  assert.match(j.costs.classes.commodity._commissionSource, /NARROW SAMPLE/, 'n=6 on one symbol is not a class measurement')
  assert.match(j.costs.classes.commodity._commissionSource, /n=6 on one symbol/)
  assert.match(j.costs.classes.stock_us._commissionSource, /FLAT PER-SHARE FEE/, 'the US fee is per share, not a rate')
  assert.match(j.costs.classes.stock_us._commissionSource, /BIMODAL/, 'the earlier bps figure and why it was wrong must stay on the record')
  // ROUND-TWO CHECKER, MAJOR 3: the mechanism claimed for the four outliers
  // was a GUESS and it was false. The retraction, and the measured truth,
  // must both stay on the record.
  assert.match(j.costs.classes.stock_us._commissionSource, /MINIMUM CHARGE, NOT MULTI-FILLS/)
  assert.match(j.costs.classes.stock_us._commissionSource, /57\/60/)
  assert.match(j.costs.classes.stock_us._commissionSource, /60\/60/)
  assert.match(j.costs.classes.stock_us._commissionSource, /UNDERCHARGES a very small tick position/,
    'the direction of the un-modelled minimum must be stated')
  // MINOR 1 + 2: FX and XAUUSD are charged PER LOT, not as a rate
  assert.match(j.costs.classes.fx._commissionSource, /FLAT FEE PER LOT/)
  assert.match(j.costs.classes.fx._commissionSource, /\$3\.50/)
  assert.match(j.costs.classes.fx._commissionSource, /OVERCHARGES GBP-base/)
  assert.match(j.costs.classes.commodity._commissionSource, /per lot per side/)
  assert.match(j._sources, /APPROXIMATION/, 'the _sources block must not present a per-lot fee as a measured rate')
  // and the discredited claim must not survive anywhere except inside its
  // own retraction
  for (const c of COST_CLASSES) {
    const src = j.costs.classes[c]._commissionSource
    if (/multi-fill/.test(src)) assert.match(src, /FALSE|guess published as a finding/, `${c} may mention multi-fills only to retract the claim`)
  }
  assert.match(j.costs.classes.index_cfd._commissionSource, /MEASURED ZERO/)
  assert.match(j.costs.classes.crypto._commissionSource, /MEASURED ZERO/)

  // the hash is stable, and moves when ANY of the four terms moves
  const h = scheduleHash(sch)
  assert.match(h, /^[0-9a-f]{16}$/)
  assert.equal(h, scheduleHash(normalizeSchedule(j.costs)))
  for (const term of ['commissionWirePerSide', 'commissionBpsPerSide', 'slippageWirePerSide', 'slippageBpsPerSide']) {
    const bumped = JSON.parse(JSON.stringify(j.costs))
    bumped.classes.fx[term] = Number(bumped.classes.fx[term]) + 1
    assert.notEqual(scheduleHash(bumped), h, `${term} must be part of the schedule's identity`)
  }
  // CHECKER FINDING 11: an EXTRA class the repo does not price must change the
  // hash — filtering the canon through COST_CLASSES made a sidecar carrying a
  // 99-bps class hash identical to the repo's, so matchesRepo read true.
  const extra = JSON.parse(JSON.stringify(j.costs))
  extra.classes.stock_de = { commissionBpsPerSide: 99, slippageBpsPerSide: 0 }
  assert.deepEqual(normalizeSchedule(extra).unknownClasses, ['stock_de'], 'an unpriced class is reported, not dropped in silence')
  assert.notEqual(scheduleHash(extra), h, 'a class this repo cannot price still changes the cost model')
  // …and the symbol map is NOT part of the cost model's identity (it is
  // checked separately, by comparing the sidecar's map to the pushed one)
  assert.equal(scheduleHash({ ...sch, symbolClass: { 1: 'fx' } }), h)
})

test('the sensitivity line computes at 0x, 1x and 2x, is exact at 1x, and prices by the ROW\'s own class', async () => {
  const sch = loadRepoSchedule(CONFIG)
  const fx = costsForClass(sch, 'fx')
  // a trade the book closed under this very schedule: entry/exit carry its slippage
  const closed = {
    trade_side: 'BUY', entry: 1_000_050, exit: 1_020_000, stop_distance: 10_000,
    cost_class: 'fx', commission_wire: fx.commissionWirePerSide, commission_bps: fx.commissionBpsPerSide,
    slippage_wire: fx.slippageWirePerSide, slippage_bps: fx.slippageBpsPerSide,
  }
  const at1 = repriceNetR(closed, fx, 1)
  const gross = (1_020_000 - 1_000_050) / 10_000
  const expected = +(gross - (costExact(fx.commissionWirePerSide, fx.commissionBpsPerSide, 1_000_050)
                            + costExact(fx.commissionWirePerSide, fx.commissionBpsPerSide, 1_020_000)) / 10_000).toFixed(4)
  assert.equal(at1, expected, '1x with the row\'s own schedule reproduces the book\'s own arithmetic')
  assert.ok(repriceNetR(closed, fx, 0) > at1, '0x must be better than 1x')
  assert.ok(repriceNetR(closed, fx, 2) < at1, '2x must be worse than 1x')
  assert.equal(repriceNetR({ trade_side: 'BUY', entry: 1, exit: 2, stop_distance: 0 }, fx, 1), null)

  // ROUND-TWO CHECKER, MINOR 4: the invariant must hold when the sim carries
  // a NON-ZERO global absolute term too. The book charges global + class; if
  // it records only the class row, the keeper strips less than was added and
  // reprice@1 stops reproducing the recorded fill. Driven through the real
  // replayer so it is the engine's own arithmetic, not a restatement of it.
  const { simulate } = await import('./tick-replay-sim.js')
  const events = []
  for (let i = 1; i <= 40; i++) events.push({ seq: i, recvMs: 1_000_000 + i * 100, bid: 1_000_000, ask: 1_000_020, snapshot: false, crossed: false, changed: true })
  const signal = { seq: 1, recvMs: 1_000_100, side: 'BUY', bid: 1_000_000, ask: 1_000_020, stopDistance: 4000 }
  for (const globals of [{ slippage: 0, commissionPerSide: 0 }, { slippage: 7, commissionPerSide: 11 }]) {
    const r = simulate(events, {}, { costs: sch, costClass: 'fx', minTargetToCost: 0, maxHoldEvents: 5, maxHoldMs: 6 * 3600_000, ...globals }, { signalsOverride: [signal] })
    assert.equal(r.trades.length, 1)
    const t = r.trades[0]
    const row = {
      trade_side: t.side, entry: t.entry, exit: t.exit, stop_distance: t.stopDistance,
      cost_class: r.sim.costClass,
      commission_wire: r.sim.commissionWirePerSide, commission_bps: r.sim.commissionBpsPerSide,
      slippage_wire: r.sim.slippageWirePerSide, slippage_bps: r.sim.slippageBpsPerSide,
    }
    assert.equal(row.slippage_wire, globals.slippage + sch.classes.fx.slippageWirePerSide, 'the recorded term is the EFFECTIVE one')
    assert.equal(row.commission_wire, globals.commissionPerSide + sch.classes.fx.commissionWirePerSide)
    const own = { commissionWirePerSide: row.commission_wire, commissionBpsPerSide: row.commission_bps, slippageWirePerSide: row.slippage_wire, slippageBpsPerSide: row.slippage_bps }
    assert.equal(repriceNetR(row, own, 1), t.netR, `reprice@1 must reproduce the recorded netR with globals ${JSON.stringify(globals)}`)
  }

  // CHECKER FINDING 3: the row's OWN cost_class prices it, not the current
  // symbol map — a symbol id re-mapped between the trade and the read used to
  // be re-priced as a different instrument with nothing reported.
  const rowHk = { ...closed, symbol_id: 11, cost_class: 'stock_hk', commission_wire: 0, commission_bps: 15, slippage_wire: 0, slippage_bps: 0.5 }
  const byRow = costSensitivity([rowHk], sch, () => 'fx')
  assert.equal(byRow.viaRow, 1); assert.equal(byRow.viaSymbolMap, 0)
  assert.equal(byRow.classDisagreements, 1, 'the row says stock_hk and the map says fx — that must be REPORTED')
  assert.equal(byRow.rows[1].netR, repriceNetR(rowHk, costsForClass(sch, 'stock_hk'), 1), 'priced as what it actually was')
  assert.notEqual(byRow.rows[1].netR, repriceNetR(rowHk, costsForClass(sch, 'fx'), 1))

  // the portfolio line over a mixed book: one win, one loss, one lost_restart
  const rows = [
    { symbol_id: 11, trade_side: 'BUY', entry: 1_000_000, exit: 1_030_000, stop_distance: 10_000, reason: 'target' },
    { symbol_id: 22, trade_side: 'SELL', entry: 1_000_000, exit: 1_010_000, stop_distance: 10_000, reason: 'stop' },
    { symbol_id: 11, reason: 'lost_restart' },
  ]
  const classOf = (id) => (id === 11 ? 'stock_us' : 'fx')
  const s = costSensitivity(rows, sch, classOf)
  assert.equal(s.priced, 2, 'the lost_restart row carries no result and is not priced')
  assert.equal(s.viaFallback, 0); assert.equal(s.viaSymbolMap, 2); assert.equal(s.viaRow, 0)
  assert.equal(s.costedRows, 0, 'legacy rows carry no cost class — the SHADOW gate counts these as uncosted')
  assert.deepEqual(s.rows.map(r => r.multiple), [0, 1, 2])
  assert.equal(s.scheduleHash, scheduleHash(sch))
  assert.ok(s.rows[0].profitFactor > s.rows[1].profitFactor, 'costs must lower the profit factor')
  assert.ok(s.rows[1].profitFactor > s.rows[2].profitFactor, 'twice the costs lowers it again')
  assert.equal(s.rows[0].netR > s.rows[2].netR, true)
  // an unmapped symbol id falls back — and the line SAYS how many did
  const unmapped = costSensitivity(rows, sch, () => null)
  assert.equal(unmapped.viaFallback, 2)
  assert.equal(unmapped.fallbackClass, 'stock_hk')
  assert.ok(unmapped.rows[1].netR < s.rows[1].netR, 'the fallback is the dear class, so it nets less')
  // profit factor is null with no losing trade — never Infinity
  assert.equal(profitFactorOf([1, 2, 3]), null)
  assert.equal(profitFactorOf([2, -1]), 2)
})

// CHECKER FINDING 9: the universe the recorder actually carries is
// `tick_symbols_json`, settable at RUNTIME — the momentum-universe test above
// only covers the seed. So this one classifies every symbol the owner has
// actually traded, read out of the checked-in statements, and fails on any
// name that classifies as nothing OR classifies as the wrong thing. BNBUSD was
// swallowed by the six-letter FX rule (so it was not even reported as
// unclassified) and VIX / USDX / JPYX / EURX / CN50 resolved to null.
test('every symbol in the owner\'s own statements classifies, and none of them classifies wrongly', () => {
  const dir = new URL('../seed-statements/', import.meta.url)
  const names = new Set()
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.csv')) continue
    let hdr = null
    for (const line of readFileSync(new URL(f, dir), 'utf8').split(/\r?\n/)) {
      if (line.startsWith('Deal ID,')) { hdr = line.split(',').map(h => h.trim()); continue }
      if (!hdr) continue
      if (!line.startsWith('DID')) { if (line.trim() !== '') hdr = null; continue }
      const sym = line.split(',')[hdr.indexOf('Symbol')]
      if (sym) names.add(sym.trim().toUpperCase())
    }
  }
  assert.ok(names.size >= 50, `expected the real statement universe, got ${names.size}`)
  const { unclassified } = classifyUniverse([...names], loadRepoSchedule(CONFIG))
  assert.deepEqual(unclassified, [], `every traded symbol must classify; unclassified: ${unclassified.join(', ')}`)
  // the five the checker named, by name — a regression on any of them is red
  assert.equal(costClassOf('BNBUSD'), 'crypto', 'a six-letter crypto pair is not FX')
  assert.equal(costClassOf('VIX'), 'index_cfd')
  assert.equal(costClassOf('USDX'), 'index_cfd')
  assert.equal(costClassOf('JPYX'), 'index_cfd')
  assert.equal(costClassOf('EURX'), 'index_cfd')
  assert.equal(costClassOf('CN50'), 'index_cfd')
  assert.equal(costClassOf('DOW.US'), 'stock_us', 'a US stock whose name looks like an index')
  assert.equal(costClassOf('EURUSD'), 'fx')
  // and a name genuinely outside the taxonomy is still REPORTED, not absorbed
  assert.equal(costClassOf('SIE.DE'), null)
  assert.deepEqual(classifyUniverse(['SIE.DE'], null).unclassified, ['SIE.DE'])
})

// ROUND-TWO: the COST SCREEN must read the per-class commission on the
// replayer too. It is the mechanism behind PR-L's headline finding — that an
// HK-stock signal at a 3R target cannot clear a 31 bps round trip — and
// removing the commission term from the screen changed nothing any test could
// see. cpp-exec/src/tests/test_tick_shadow.cpp pins the same thing.
test('the replayer\'s minTargetToCost screen reads the per-class commission, not just the spread', async () => {
  const { simulate } = await import('./tick-replay-sim.js')
  const sch = loadRepoSchedule(CONFIG)
  // NAS100-scale price, a 5-point stop, the repo's own 3R target and 3.0 screen
  const events = []
  for (let i = 1; i <= 40; i++) events.push({ seq: i, recvMs: 1_000_000 + i * 100, bid: 2_914_200, ask: 2_914_300, snapshot: false, crossed: false, changed: true })
  const signal = { seq: 1, recvMs: 1_000_100, side: 'BUY', bid: 2_914_200, ask: 2_914_300, stopDistance: 500 }
  const run = (costClass, costs = sch) => simulate(events, {}, { costs, costClass, targetR: 3, minTargetToCost: 3, maxHoldEvents: 5, maxHoldMs: 6 * 3600_000 }, { signalsOverride: [signal] })
  const cheap = run('index_cfd'), dear = run('stock_hk'), flatFee = run('stock_us')
  assert.equal(cheap.rejected.cost, 0, 'index CFD: spread-only, a 3R target clears the screen')
  assert.equal(cheap.trades.length, 1)
  assert.equal(dear.rejected.cost, 1, 'HK stock at 15 bps per side cannot clear a 3R target')
  assert.equal(dear.trades.length, 0)
  assert.equal(flatFee.rejected.cost, 1, 'a flat $0.02/share on a 29,142-point index is refused too')
  // …and the refusal is the COMMISSION, not the spread: zero that one class's
  // commission and the very same signal is taken
  const freed = run('stock_hk', { ...sch, classes: { ...sch.classes, stock_hk: { ...sch.classes.stock_hk, commissionBpsPerSide: 0 } } })
  assert.equal(freed.rejected.cost, 0, 'with the class commission gone the same signal clears — so the screen reads it')
  assert.equal(freed.trades.length, 1)
})
