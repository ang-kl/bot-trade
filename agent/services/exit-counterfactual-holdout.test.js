// ---------------------------------------------------------------------------
// The exit replay made fit to select a rule (research plan step 2): the
// chronological holdout, the class / side / source groupings, the broker's
// initial stop without a silent fallback, window coverage and the entry bar,
// and the cost label on the verdict.
//
// Claude · № 15,258 17-Oct (owner: "Build it, initial stop as the default,
// merge when green"; claude-builder). Every expected value below is
// self-derived from the fixtures (it proves the mechanism, not a market fact).
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { exitCounterfactualExtended } from './exit-counterfactual-extended.js'
import { primeAssetClasses, _resetAssetClassesForTests } from '../lib/asset-class.js'
import { entryBarCoverage, barIntervalMs } from '../lib/exit-replay.js'

const MIN = 60_000, DAY = 86_400_000
const T0 = Date.now() - 12 * DAY
// Long from 100, broker stop 99 (1R), target 102: price climbs to 102.2 on bar 2 → +2R.
const bars = t => [[t, 100, 100.5, 99.8, 100.4, 0], [t + MIN, 100.4, 101.2, 100.3, 101.1, 0], [t + 2 * MIN, 101.1, 102.2, 101.0, 102.1, 0], [t + 3 * MIN, 102.1, 102.3, 101.9, 102.0, 0]]

function trade(db, { at, symbol = 'JPN225', side = 'long', initial = 99, origin = 'bot_market_dispatch', openOffsetMs = 0, window = null }) {
  const info = db.prepare(`INSERT INTO trades (symbol, side, status, strategy, entry_price, sl_price, tp_price, broker_sl_initial, realised_rr, exit_price_suspect,
      opened_at, closed_at, net_pnl, origin, account_id, label_timeframe, label_regime)
    VALUES (?, ?, 'closed', 'donchian_breakout', 100, 99, 102, ?, 2, 0, ?, ?, 20, ?, '46130058', '1m', 'TRENDING')`)
    .run(symbol, side, initial, new Date(at + openOffsetMs).toISOString(), new Date(at + 3 * MIN).toISOString(), origin)
  db.prepare(`INSERT INTO trade_postmortems (trade_id, symbol, side, entry_price, sl_price, r_multiple, classification, bars_json)
    VALUES (?, ?, ?, 100, 99, 2, 'clean_win', ?)`).run(info.lastInsertRowid, symbol, side, JSON.stringify(window ?? bars(at)))
}
const fresh = () => initDB(':memory:')

test('holdout: ten trades on ten days split 7 TRAIN / 3 CONFIRM by time; the rule chosen on TRAIN is judged on CONFIRM and reads confirmed_gross_only while costs are unmodelled', () => {
  const db = fresh()
  for (let i = 0; i < 10; i++) trade(db, { at: T0 + i * DAY })
  const r = exitCounterfactualExtended(db, { minSample: 3 })
  assert.equal(r.validation.status, 'split'); assert.equal(r.validation.trainFraction, 0.7)
  assert.deepEqual(r.validation.rows, { train: 7, confirm: 3, straddling: 0 })
  assert.ok(r.validation.selectedOnTrain, 'a rule is selected on TRAIN')
  assert.equal(r.validation.confirm[r.validation.selectedOnTrain].usable, 3, 'CONFIRM is the three later trades')
  assert.equal(r.validation.verdict, 'confirmed_gross_only', 'positive on both blocks, but costs are not modelled')
  assert.equal(r.costs.status, 'gross_only_prerequisite_open')
})

test('holdout: too few CONFIRM rows reads insufficient, never confirmed', () => {
  const db = fresh()
  for (let i = 0; i < 10; i++) trade(db, { at: T0 + i * DAY })
  assert.equal(exitCounterfactualExtended(db, { minSample: 5 }).validation.verdict, 'insufficient')
})

test('groupings: class from the broker tree, side and source', () => {
  const db = fresh()
  _resetAssetClassesForTests()
  primeAssetClasses({ builtAt: 'x', classes: [{ name: 'Indices (Spot)', categories: [{ name: 'Asia', symbols: ['JPN225'] }] }, { name: 'Forex (Spot)', categories: [{ name: 'Majors', symbols: ['EURUSD'] }] }] })
  trade(db, { at: T0 }); trade(db, { at: T0 + DAY, symbol: 'EURUSD', side: 'short', initial: 101, origin: 'bot_pending_fill' })
  const byClass = exitCounterfactualExtended(db, { minSample: 1, groupBy: 'class' })
  assert.deepEqual(Object.keys(byClass.groups.values).sort(), ['fx', 'index'])
  assert.deepEqual(Object.keys(exitCounterfactualExtended(db, { minSample: 1, groupBy: 'side' }).groups.values).sort(), ['long', 'short'])
  assert.deepEqual(Object.keys(exitCounterfactualExtended(db, { minSample: 1, groupBy: 'source' }).groups.values).sort(), ['bot_market_dispatch', 'bot_pending_fill'])
  _resetAssetClassesForTests()
})

test('initial stop is the default and a row without it is excluded and counted, never replayed against the plan stop', () => {
  const db = fresh()
  trade(db, { at: T0 }); trade(db, { at: T0 + DAY, initial: null })
  const r = exitCounterfactualExtended(db, { minSample: 1 })
  assert.match(r.stop.basis, /^broker_sl_initial/)
  assert.equal(r.coverage.no_initial_stop, 1); assert.equal(r.eligible, 1)
  const rec = exitCounterfactualExtended(db, { minSample: 1, stop: 'recorded' })
  assert.equal(rec.coverage.no_initial_stop, 0); assert.equal(rec.eligible, 2, 'stop=recorded keeps the plan stop and both rows')
})

test('coverage: a window starting after the fill is clipped; a mid-bar fill whose bar reaches the stop is entry_bar_unresolved; a mid-bar fill clear of every level is replayed', () => {
  const db = fresh()
  trade(db, { at: T0, openOffsetMs: -5 * MIN })                         // window starts 5 min after the fill
  trade(db, { at: T0 + DAY, openOffsetMs: 30_000, window: [[T0 + DAY, 100, 100.4, 98.9, 100.2, 0], ...bars(T0 + DAY).slice(1)] }) // bar low 98.9 ≤ stop 99
  trade(db, { at: T0 + 2 * DAY, openOffsetMs: 30_000 })                 // bar 99.8–100.5: clear of 99 and 102
  const r = exitCounterfactualExtended(db, { minSample: 1 })
  assert.equal(r.coverage.clipped, 1)
  assert.equal(r.eligible, 2)
  const asTraded = r.rules.find(x => x.rule === 'as_traded')
  assert.equal(asTraded.entryBarUnresolved, 1)
  assert.equal(asTraded.usable, 1, 'only the clear mid-bar fill is scored')
})

test('entryBarCoverage / barIntervalMs: the unit cases', () => {
  const b = [[0, 100, 101, 99.5, 100.5], [60_000, 100.5, 100.8, 99.9, 100.2]]
  assert.equal(barIntervalMs(b), 60_000)
  const long = { side: 'long', entry: 100, sl: 99.6, tp: 102 }
  assert.equal(entryBarCoverage(b, { ...long, openedAtMs: 0 }).status, 'ok', 'a fill at the bar open is replayed')
  assert.equal(entryBarCoverage(b, { ...long, openedAtMs: 30_000 }).status, 'entry_bar_unresolved', 'bar low 99.5 reaches the stop 99.6')
  assert.equal(entryBarCoverage(b, { ...long, sl: 99, openedAtMs: 30_000 }).status, 'ok')
  assert.equal(entryBarCoverage(b, { ...long, sl: 99, openedAtMs: 30_000 }, { tpR: 0.5 }).status, 'entry_bar_unresolved', "the rule's own target 100.5 is inside the bar")
  assert.equal(entryBarCoverage(b, { ...long, openedAtMs: -1 }).status, 'clipped')
})

test('a zero or wrong-side initial stop is no initial stop: excluded and counted (Codex round 1 on #1394)', () => {
  const db = fresh()
  trade(db, { at: T0 }); trade(db, { at: T0 + DAY, initial: 0 }); trade(db, { at: T0 + 2 * DAY, initial: 101 })
  const r = exitCounterfactualExtended(db, { minSample: 1 })
  assert.equal(r.coverage.no_initial_stop, 2); assert.equal(r.eligible, 1)
})

test('an exit-at-the-mean rule: a mid-bar fill whose entry-bar close is past the SMA is entry_bar_unresolved (Codex round 2 on #1394)', () => {
  // Three bars closing 99, 99, 101: SMA(3) on the third bar is 99.67; the fill is inside that bar.
  const b = [[0, 99, 99.2, 98.8, 99], [60_000, 99, 99.2, 98.8, 99], [120_000, 99.5, 101.2, 99.4, 101]]
  const trade = { side: 'long', entry: 100, sl: 98, tp: 104, openedAtMs: 150_000 }
  assert.equal(entryBarCoverage(b, trade, {}).status, 'ok', 'no level is inside the bar')
  assert.equal(entryBarCoverage(b, trade, { exitAtMean: { period: 3 } }).status, 'entry_bar_unresolved', 'close 101 > SMA 99.67')
  assert.equal(entryBarCoverage(b, { ...trade, side: 'short', sl: 102, tp: 96 }, { exitAtMean: { period: 3 } }).status, 'ok', 'short: close above the SMA is no mean exit')
})

// Claude · № 15,268 17-Oct (Codex round 3 on #1394; owner: "Fix both, merge when green"). Self-derived fixtures.
test('holdout (Codex round 3 P1): a TRAIN row is scored only on bars closed by the cutoff — a target reached on a later aftermath bar leaves it truncated in TRAIN, while the headline still counts it', () => {
  const db = fresh()
  for (let i = 0; i < 10; i++) {
    if (i !== 6) { trade(db, { at: T0 + i * DAY }); continue }
    const t = T0 + 6 * DAY
    // Quiet until the cutoff (≈ day 6.3); the target 102 is reached only on a bar half a day later.
    const quiet = [0, 1, 2, 3].map(k => [t + k * MIN, 100, 100.6, 99.6, 100.2, 0])
    trade(db, { at: t, window: [...quiet, [t + 12 * 3_600_000, 100.2, 102.5, 100.1, 102.4, 0]] })
  }
  const r = exitCounterfactualExtended(db, { minSample: 3 })
  assert.deepEqual(r.validation.rows, { train: 7, confirm: 3, straddling: 0 })
  const headline = r.rules.find(x => x.rule === 'as_traded')
  assert.equal(headline.usable, 10, 'the full window resolves all ten for the headline')
  assert.equal(r.validation.train.as_traded.usable, 6, 'the day-6 row is still open at the cutoff, so TRAIN cannot score it')
})

test('entry bar (Codex round 3 P2): a mid-bar fill whose bar reaches the break-even or trail level is unresolved for that rule only', () => {
  const t = 1_000 * MIN
  const window = [[t, 100, 101.1, 99.5, 100.8, 0], [t + MIN, 100.8, 101, 100.5, 100.9, 0], [t + 2 * MIN, 100.9, 101, 100.6, 100.7, 0]]
  const tr = { side: 'long', entry: 100, sl: 99, tp: 102, openedAtMs: t + 30_000 } // bar reaches +1R (101) but not 99 or 102
  assert.equal(entryBarCoverage(window, tr, {}).status, 'ok')
  assert.equal(entryBarCoverage(window, tr, { name: 'be_at_1R', breakevenAtR: 1 }).status, 'entry_bar_unresolved')
  assert.equal(entryBarCoverage(window, tr, { name: 'trail_1R', trailR: 1 }).status, 'entry_bar_unresolved')
  assert.equal(entryBarCoverage(window, tr, { name: 'be_at_2R', breakevenAtR: 1.5 }).status, 'ok', 'a level the bar does not reach stays resolved')
})
