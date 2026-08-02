// vol-gate Layer 1 — the classifier the whole spec rests on.
//
// The tests are aimed at two things. First, the arithmetic: a percentile that
// is subtly wrong would mislabel regimes for a year before anyone noticed,
// because nothing downstream can check it. Second, and more important, the
// SINGLE-OWNER RULE the owner asked for explicitly: this module must not form
// a second opinion about market character, and must not compute a second ATR.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initDB, setState } from '../db.js'
import { readTradableUnion } from './watchlists.js'
import { computeRegime, meanAtr } from './regime.js'
import {
  classifyVolRegime, percentileRank, bandFor, atrHistory, refreshAtrHistory,
  pruneAtrHistory, HISTORY_DAYS, MIN_DAYS_FOR_VERDICT, ATR_PERIOD,
} from './vol-gate.js'

const tmpDb = () => initDB(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'volgate-')), 'agent.db'))
const DAY = 86_400_000
const START = Date.parse('2025-01-01T00:00:00.000Z')

function seedHistory(db, symbol, atrs, from = START) {
  const ins = db.prepare('INSERT OR REPLACE INTO atr_history (symbol, day, atr) VALUES (?,?,?)')
  db.transaction(() => {
    atrs.forEach((a, i) => ins.run(symbol, new Date(from + i * DAY).toISOString().slice(0, 10), a))
  })()
}

// ---------------------------------------------------------------- arithmetic

test('percentileRank: bottom, middle and top of a known sample', () => {
  const sample = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100
  assert.equal(percentileRank(1, sample), 1)
  assert.equal(percentileRank(50, sample), 50)
  assert.equal(percentileRank(100, sample), 100)
  // Above everything seen is still 100, not >100.
  assert.equal(percentileRank(500, sample), 100)
  // Below everything seen is 0, not null.
  assert.equal(percentileRank(0.5, sample), 0)
})

test('percentileRank: degenerate inputs return null, never NaN', () => {
  assert.equal(percentileRank(5, []), null)
  assert.equal(percentileRank(NaN, [1, 2, 3]), null)
  assert.equal(percentileRank(5, null), null)
})

test('bandFor: the spec cutoffs, and the boundaries specifically', () => {
  assert.equal(bandFor(19.9), 'LOW')
  assert.equal(bandFor(20), 'NORMAL', '20th is NOT low — the spec says "< 20"')
  assert.equal(bandFor(50), 'NORMAL')
  assert.equal(bandFor(80), 'NORMAL', '80th is NOT high — the spec says "> 80"')
  assert.equal(bandFor(80.1), 'HIGH')
  // No percentile at all must fail SAFE, to the band that changes nothing.
  assert.equal(bandFor(null), 'NORMAL')
})

// ------------------------------------------------------------- classification

test('a quiet symbol at its yearly low reads LOW; a spiking one reads HIGH', () => {
  const db = tmpDb()
  seedHistory(db, 'EURUSD', Array.from({ length: HISTORY_DAYS }, (_, i) => 0.001 + i * 0.00001))

  const low = classifyVolRegime(db, 'EURUSD', { currentAtr: 0.0005 })
  assert.equal(low.regime, 'LOW')
  assert.equal(low.insufficientHistory, false)

  const high = classifyVolRegime(db, 'EURUSD', { currentAtr: 0.05 })
  assert.equal(high.regime, 'HIGH')
  assert.equal(high.percentile, 100)

  const mid = classifyVolRegime(db, 'EURUSD', { currentAtr: 0.001 + 126 * 0.00001 })
  assert.equal(mid.regime, 'NORMAL')
})

test('THE THIN-INSTRUMENT CASE: too little history is NORMAL with no percentile', () => {
  const db = tmpDb()
  // A recently added symbol — exactly the softs/grains/new-listing situation
  // the percentile approach is weakest on.
  seedHistory(db, 'COCOA', Array.from({ length: MIN_DAYS_FOR_VERDICT - 1 }, () => 1))

  const v = classifyVolRegime(db, 'COCOA', { currentAtr: 99 })
  // 99 is off the top of everything seen. A naive percentile says 100 → HIGH,
  // and a downstream size cut would act on five days of data. Refuse instead.
  assert.equal(v.regime, 'NORMAL', 'a thin sample must not produce a confident HIGH')
  assert.equal(v.percentile, null, 'withhold the number rather than publish a misleading one')
  assert.equal(v.insufficientHistory, true)
  assert.match(v.note, /of 252 days/)
})

test('a symbol with no history at all is NORMAL, not a crash and not a HIGH', () => {
  const db = tmpDb()
  const v = classifyVolRegime(db, 'NEVERSEEN', { currentAtr: 1 })
  assert.equal(v.regime, 'NORMAL')
  assert.equal(v.sampleDays, 0)
  assert.equal(v.insufficientHistory, true)
})

test('partial history between the floor and a full year still classifies, but says so', () => {
  const db = tmpDb()
  seedHistory(db, 'XAUUSD', Array.from({ length: 120 }, (_, i) => 1 + i * 0.01))
  const v = classifyVolRegime(db, 'XAUUSD', { currentAtr: 5 })
  assert.equal(v.regime, 'HIGH')
  assert.equal(v.insufficientHistory, true)
  assert.match(v.note, /short window/)
})

// ------------------------------------------------------- THE SINGLE-OWNER RULE

test('SINGLE OWNER: the character label is regime.js\'s, reported verbatim', () => {
  const db = tmpDb()
  seedHistory(db, 'EURUSD', Array.from({ length: HISTORY_DAYS }, () => 1))
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, atr_pct, computed_at)
              VALUES (?,?,?,?, datetime('now'))`).run('EURUSD', 'volatile', 'short', 0.42)

  const v = classifyVolRegime(db, 'EURUSD', { currentAtr: 1 })
  assert.equal(v.characterRegime, 'volatile', 'the character label must come from the regimes table, not be re-derived')
  assert.equal(v.characterTrendDir, 'short')
  // And the two axes are independent: flat history puts this at the 100th
  // percentile of its own year while regime.js separately calls it volatile.
  // Different questions, different answers, neither overriding the other.
  assert.equal(v.regime, 'HIGH')
})

test('SINGLE OWNER: vol-gate.js contains no ATR implementation of its own', () => {
  const src = fs.readFileSync(new URL('./vol-gate.js', import.meta.url), 'utf8')
  // It must IMPORT meanAtr from regime.js...
  assert.match(src, /import \{ meanAtr \} from '\.\/regime\.js'/,
    'the ATR must come from regime.js — a second implementation is how two volatility opinions appear')
  // ...and must not define one.
  assert.doesNotMatch(src, /function\s+(meanAtr|atr|trueRange)\s*\(/,
    'vol-gate defines its own ATR/true-range — that is the duplication this rule exists to prevent')
  // ...and must not re-derive the character label either.
  assert.doesNotMatch(src, /['"]trending['"]|['"]ranging['"]/,
    'vol-gate is deciding character labels itself instead of reading regime.js')
})

test('SINGLE OWNER: the history is built with the same ATR regime.js classifies with', async () => {
  const db = tmpDb()
  const bars = Array.from({ length: 40 }, (_, i) => ({
    t: START + i * DAY, o: 10 + i * 0.1, h: 10.5 + i * 0.1, l: 9.5 + i * 0.1, c: 10 + i * 0.1, v: 100,
  }))
  await refreshAtrHistory(db, ['TESTSYM'], async () => bars)

  const series = atrHistory(db, 'TESTSYM')
  assert.ok(series.length > 0, 'nothing was written')
  // The newest stored ATR must equal regime.js's meanAtr over the same bars —
  // if these ever diverge, the percentile is being measured against a
  // different quantity than the one being classified.
  assert.equal(series[series.length - 1], meanAtr(bars, ATR_PERIOD, bars.length - 1))
})

// ------------------------------------------------------------------- refresh

test('refresh writes one row per day and is idempotent', async () => {
  const db = tmpDb()
  const bars = Array.from({ length: 60 }, (_, i) => ({
    t: START + i * DAY, o: 1, h: 1.02 + (i % 5) * 0.01, l: 0.98, c: 1, v: 10,
  }))
  const a = await refreshAtrHistory(db, ['EURUSD'], async () => bars)
  const first = db.prepare("SELECT COUNT(*) c FROM atr_history WHERE symbol='EURUSD'").get().c
  assert.equal(a.updated, 1)
  assert.ok(first > 0)

  // Re-running must correct in place, not duplicate — a daily job WILL be run
  // twice eventually (a redeploy, a manual trigger), and a doubled sample
  // would quietly halve every percentile's resolution.
  await refreshAtrHistory(db, ['EURUSD'], async () => bars)
  const second = db.prepare("SELECT COUNT(*) c FROM atr_history WHERE symbol='EURUSD'").get().c
  assert.equal(second, first, 'a second run duplicated rows')
})

test('refresh asks for period extra bars so the oldest ATR has a full lookback', async () => {
  const db = tmpDb()
  let asked = 0
  await refreshAtrHistory(db, ['EURUSD'], async (_s, count) => { asked = count; return [] })
  assert.ok(asked >= HISTORY_DAYS + ATR_PERIOD,
    `asked for ${asked}; too few and the earliest ATRs are computed from a short series and sit systematically low, dragging every percentile up`)
})

test('a symbol that fails to fetch is counted, not fatal to the rest', async () => {
  const db = tmpDb()
  const bars = Array.from({ length: 40 }, (_, i) => ({ t: START + i * DAY, o: 1, h: 1.1, l: 0.9, c: 1, v: 1 }))
  const errs = []
  const res = await refreshAtrHistory(db, ['BAD', 'GOOD'], async (s) => {
    if (s === 'BAD') throw new Error('broker said no')
    return bars
  }, { onError: (s, e) => errs.push([s, e.message]) })

  assert.equal(res.failed, 1)
  assert.equal(res.updated, 1, 'one bad symbol must not abort the sweep')
  assert.deepEqual(errs, [['BAD', 'broker said no']])
  assert.ok(atrHistory(db, 'GOOD').length > 0)
})

test('a symbol with too few bars is skipped with a reason, not written as zeros', async () => {
  const db = tmpDb()
  const res = await refreshAtrHistory(db, ['NEW'], async () => [{ t: START, o: 1, h: 1, l: 1, c: 1, v: 1 }])
  assert.equal(res.updated, 0)
  assert.equal(res.skipped.length, 1)
  assert.match(res.skipped[0].reason, /daily bars/)
  assert.equal(atrHistory(db, 'NEW').length, 0, 'a zero-ATR row would read as the calmest day of the year')
})

test('prune keeps the newest days per symbol and drops the rest', () => {
  const db = tmpDb()
  seedHistory(db, 'EURUSD', Array.from({ length: 40 }, (_, i) => i + 1))
  seedHistory(db, 'XAUUSD', Array.from({ length: 40 }, (_, i) => i + 1))
  pruneAtrHistory(db, { keepDays: 10 })
  assert.equal(db.prepare("SELECT COUNT(*) c FROM atr_history WHERE symbol='EURUSD'").get().c, 10)
  assert.equal(db.prepare("SELECT COUNT(*) c FROM atr_history WHERE symbol='XAUUSD'").get().c, 10,
    'pruning must be per symbol, not a global newest-N')
  // The ones kept are the NEWEST, so the percentile stays current.
  assert.deepEqual(atrHistory(db, 'EURUSD'), [31, 32, 33, 34, 35, 36, 37, 38, 39, 40])
})

test('computeRegime still works — exporting meanAtr changed nothing', () => {
  const bars = Array.from({ length: 60 }, (_, i) => ({
    o: 10, h: 10 + (i % 3), l: 9, c: 10 + (i % 2), v: 1,
  }))
  const r = computeRegime(bars)
  assert.ok(['trending', 'volatile', 'ranging', 'quiet', 'unknown'].includes(r.regime))
})

// ---------------------------------------------------------------------------
// #170 — "atr_history is empty and nobody can say why". refreshAtrHistory has
// always accepted an onError hook; loop.js never passed one, so a sweep where
// every fetch threw reported `failed: 200` with the reasons discarded. These
// pin the contract the loop now depends on to explain itself.
// ---------------------------------------------------------------------------

test('refresh reports WHY each fetch failed, not just how many', async () => {
  const db = tmpDb()
  const seen = []
  const res = await refreshAtrHistory(db, ['EURJPY', 'AUDPLN'], async (s) => {
    throw new Error(`symbolId unknown for ${s}`)
  }, { onError: (sym, err) => seen.push(`${sym}: ${err.message}`) })

  assert.equal(res.updated, 0)
  assert.equal(res.failed, 2)
  assert.equal(res.symbols, 2)
  // The whole point: the CAUSE survives, so an empty table is explainable
  // rather than merely observable.
  assert.deepEqual(seen, ['EURJPY: symbolId unknown for EURJPY', 'AUDPLN: symbolId unknown for AUDPLN'])
  assert.equal(db.prepare('SELECT COUNT(*) c FROM atr_history').get().c, 0)
})

test('refresh distinguishes a fetch FAILURE from thin history', async () => {
  const db = tmpDb()
  const thin = Array.from({ length: 3 }, (_, i) => ({ t: START + i * DAY, o: 1, h: 1.1, l: 0.9, c: 1, v: 1 }))
  const good = Array.from({ length: 40 }, (_, i) => ({ t: START + i * DAY, o: 1, h: 1.1, l: 0.9, c: 1, v: 1 }))
  const errs = []
  const res = await refreshAtrHistory(db, ['THROWS', 'THIN', 'GOOD'], async (s) => {
    if (s === 'THROWS') throw new Error('socket closed')
    return s === 'THIN' ? thin : good
  }, { onError: (sym, err) => errs.push([sym, err.message]) })

  // These are different problems and must not be one bucket: a throwing fetch
  // is a broker/config fault, thin history is a legitimate skip, and only the
  // first means the controller itself is unhealthy.
  assert.equal(res.failed, 1)
  assert.deepEqual(errs, [['THROWS', 'socket closed']])
  assert.equal(res.skipped.length, 1)
  assert.equal(res.skipped[0].symbol, 'THIN')
  assert.equal(res.updated, 1)
})

test('refresh writes incrementally, so a run cut short still leaves what it got', async () => {
  const db = tmpDb()
  const good = Array.from({ length: 40 }, (_, i) => ({ t: START + i * DAY, o: 1, h: 1.1, l: 0.9, c: 1, v: 1 }))
  // The loop abandons the WAIT at its budget while the run continues detached.
  // If writes were batched at the end, an over-budget sweep would leave the
  // table empty forever — the exact shape of #170. Each symbol must land as
  // it completes.
  let after1 = -1
  await refreshAtrHistory(db, ['A', 'B'], async (s) => {
    if (s === 'B') after1 = db.prepare('SELECT COUNT(*) c FROM atr_history').get().c
    return good
  })
  assert.ok(after1 > 0, `A's rows must be committed before B is fetched, saw ${after1}`)
})

// ---------------------------------------------------------------------------
// #170 root cause, pinned at the seam that actually broke.
//
// The ATR sweep passed the RAW watchlist array to refreshAtrHistory. The
// watchlist has been an array of objects since the per-symbol settings work,
// and refreshAtrHistory does `String(raw).toUpperCase()` — so every entry
// became "[OBJECT OBJECT]", missed the symbol map, and threw. 23 symbols, 23
// failures, 0 rows, for weeks, while the vol gate read every symbol as NORMAL
// for want of a baseline.
//
// Two tests: one proving the contract (strings), one proving the seam
// (readTradableUnion's output satisfies it). The second is the one that would
// have caught this.
// ---------------------------------------------------------------------------
test('refreshAtrHistory takes SYMBOL STRINGS — an object list fails loudly', async () => {
  const db = initDB(':memory:')
  const seen = []
  const fetchBars = async (sym) => { seen.push(sym); return [] }
  await refreshAtrHistory(db, [{ symbol: 'EURUSD', enabled: true }], fetchBars, {})
  assert.deepEqual(seen, ['[OBJECT OBJECT]'],
    'this is the production failure, reproduced: the object stringifies before it is looked up')
})

test('readTradableUnion output feeds refreshAtrHistory directly — the seam that broke', async () => {
  const db = initDB(':memory:')
  setState(db, 'autopilot_symbols_json', JSON.stringify([
    { symbol: 'EURUSD', enabled: true },
    { symbol: 'GBPUSD', enabled: false },
    'XAUUSD',
  ]))
  const symbols = readTradableUnion(db)
    .filter(w => w.enabled !== false)
    .map(w => w.symbol)
  const seen = []
  await refreshAtrHistory(db, symbols, async (sym) => { seen.push(sym); return [] }, {})
  assert.ok(seen.includes('EURUSD'), 'object entries resolve to their symbol')
  assert.ok(seen.includes('XAUUSD'), 'a legacy bare string still works')
  assert.ok(!seen.includes('GBPUSD'), 'a disabled symbol is not swept')
  assert.ok(!seen.some(s => s.includes('OBJECT')), 'nothing stringifies to [OBJECT OBJECT]')
})
