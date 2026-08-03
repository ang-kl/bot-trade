// node --test agent/services/fx-legs.test.js
//
// The production case these tests encode (03-08-2026): USDPLN last priced
// 01-08 05:33, 54 hours before a proposal on AUDPLN. The rate table refused
// it — correctly, it is two days old — sizing had no path from PLN to USD,
// and the entry died as `usd_per_lot_unknown`. 1,859 times in a week.
//
// So the claims worth pinning are: the right legs are identified from the
// watchlist, staleness is judged on age rather than presence, the sweep is
// cheap in the steady state, and one dead symbol does not take the rest down.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  requiredQuoteCurrencies, legSymbolFor, staleLegs, refreshFxLegs, fxLegReport,
  legVetoDemand, LEG_REFRESH_AFTER_MS,
} from './fx-legs.js'
import { loadFxRates, readFxTable } from './fx-rates.js'

const NOW = Date.UTC(2026, 7, 3, 11, 30, 0)
const HOUR = 3_600_000

// The real failing set, plus the majors that were fine.
const WATCHLIST = ['AUDPLN', 'EURJPY', 'AUDCAD', 'EURGBP', 'GBPNOK', 'EURUSD', 'US30', 'HK50', '0003.HK']
const SYMBOL_MAP = {
  AUDPLN: 1, EURJPY: 2, AUDCAD: 3, EURGBP: 4, GBPNOK: 5, EURUSD: 6,
  USDPLN: 10, USDJPY: 11, USDCAD: 12, GBPUSD: 13, USDNOK: 14, AUDUSD: 15, USDHKD: 16,
}

test('the watchlist names the currencies sizing must convert', () => {
  const got = requiredQuoteCurrencies(WATCHLIST)
  // PLN, JPY, CAD, GBP, NOK from the crosses; HKD from BOTH HK50 and 0003.HK
  // (the index and the stock share a quote currency, and it is not FX).
  for (const c of ['PLN', 'JPY', 'CAD', 'GBP', 'NOK', 'HKD']) {
    assert.ok(got.has(c), `expected ${c}`)
  }
  assert.ok(!got.has('USD'), 'USD needs no conversion')
  assert.ok(!got.has(null))
})

test('objects and bare strings are both accepted — the watchlist is stored as both', () => {
  const got = requiredQuoteCurrencies([{ symbol: 'AUDPLN' }, 'EURJPY'])
  assert.deepEqual([...got].sort(), ['JPY', 'PLN'])
})

test('the leg is whichever direction the broker lists', () => {
  assert.equal(legSymbolFor('PLN', SYMBOL_MAP), 'USDPLN')
  assert.equal(legSymbolFor('GBP', SYMBOL_MAP), 'GBPUSD')   // GBPUSD, not USDGBP
  assert.equal(legSymbolFor('USD', SYMBOL_MAP), null)
  assert.equal(legSymbolFor('ZWL', SYMBOL_MAP), null)       // broker doesn't list it
})

test('staleness is about AGE, and the most degraded leg goes first', () => {
  const table = {
    USDJPY: { p: 157.651, t: NOW - 5 * 60_000 },      // fresh
    USDPLN: { p: 3.79427, t: NOW - 54 * HOUR },       // the production case
    USDCAD: { p: 1.4095, t: NOW - 12 * HOUR },        // stale but not expired
  }
  const stale = staleLegs(table, ['USDJPY', 'USDPLN', 'USDCAD', 'USDNOK'], { now: NOW })
  assert.deepEqual(stale.map(s => s.symbol), ['USDNOK', 'USDPLN', 'USDCAD'])
  assert.equal(stale[0].everSeen, false)              // never in the table at all
  assert.ok(stale.find(s => s.symbol === 'USDJPY') === undefined, 'a fresh leg is not refetched')
})

// Ordering by blocked entries -------------------------------------------
// Owner, watching the first live sweep, 03-08-2026: "prioritise by veto
// count, not alphabetical". Age alone LOOKED principled: every never-seen leg
// ties at Infinity, so the queue fell back to input order — alphabetical by
// currency — and CZK and DKK, which block nothing, were priced ahead of PLN
// and NOK, which were between them blocking 744 entries.

function vetoDB(counts) {
  const db = initDB(':memory:')
  const ins = db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, veto_reason, created_at)
     VALUES (?, 'long', 0, 'insufficient_equity min_lot=0.01 computed=0 usd_per_lot_unknown', datetime('now'))`
  )
  for (const [sym, n] of Object.entries(counts)) for (let i = 0; i < n; i++) ins.run(sym)
  return db
}

test('demand is counted per LEG, not per symbol — several crosses share one rate', () => {
  const db = vetoDB({ AUDPLN: 695, EURJPY: 352, AUDCAD: 253, GBPNOK: 49 })
  const d = legVetoDemand(db, { symbolMap: SYMBOL_MAP })
  assert.equal(d.USDPLN, 695)
  assert.equal(d.USDJPY, 352)
  assert.equal(d.USDCAD, 253)
  assert.equal(d.USDNOK, 49)
})

test('only usd_per_lot_unknown vetoes count — other guards are somebody else\'s problem', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO risk_events (symbol, approved, veto_reason, created_at)
              VALUES ('AUDPLN', 0, 'daily_loss_limit_hit pnl=-1 limit=1', datetime('now'))`).run()
  db.prepare(`INSERT INTO risk_events (symbol, approved, veto_reason, created_at)
              VALUES ('AUDPLN', 1, 'insufficient_equity … usd_per_lot_unknown', datetime('now'))`).run()
  assert.deepEqual(legVetoDemand(db, { symbolMap: SYMBOL_MAP }), {})   // one wrong guard, one approved
})

test('THE FIX: the leg blocking the most entries is priced first, not the alphabetical one', () => {
  const db = vetoDB({ AUDPLN: 695, GBPNOK: 49 })
  const demand = legVetoDemand(db, { symbolMap: SYMBOL_MAP })
  // All four have never been seen, so age ties them at Infinity — exactly the
  // situation that produced the wrong order in production.
  const order = staleLegs({}, ['USDCZK', 'USDDKK', 'USDNOK', 'USDPLN'], { now: NOW, demand })
    .map(s => s.symbol)
  assert.deepEqual(order.slice(0, 2), ['USDPLN', 'USDNOK'])
  assert.deepEqual(order.slice(2).sort(), ['USDCZK', 'USDDKK'])
})

test('age still decides between legs blocking the same amount', () => {
  const table = { USDCZK: { p: 4.1, t: NOW - 30 * HOUR }, USDDKK: { p: 6.4, t: NOW - 7 * HOUR } }
  const order = staleLegs(table, ['USDCZK', 'USDDKK'], { now: NOW, demand: {} }).map(s => s.symbol)
  assert.deepEqual(order, ['USDCZK', 'USDDKK'])
})

test('no risk_events table → ordering falls back to age instead of throwing', () => {
  const db = initDB(':memory:')
  db.exec('DROP TABLE risk_events')
  assert.deepEqual(legVetoDemand(db, { symbolMap: SYMBOL_MAP }), {})
})

test('a zero or malformed price counts as missing, not as a usable rate', () => {
  const table = { USDPLN: { p: 0, t: NOW }, USDCAD: { p: 'x', t: NOW } }
  assert.deepEqual(
    staleLegs(table, ['USDPLN', 'USDCAD'], { now: NOW }).map(s => s.symbol).sort(),
    ['USDCAD', 'USDPLN'],
  )
})

test('the sweep fetches the missing legs and the gate can size again', async () => {
  const db = initDB(':memory:')
  const asked = []
  const quotes = { 10: { bid: 3.79, ask: 3.80 }, 11: { bid: 157.60, ask: 157.70 },
    12: { bid: 1.409, ask: 1.410 }, 13: { bid: 1.3490, ask: 1.3493 },
    14: { bid: 9.57, ask: 9.58 }, 16: { bid: 7.84, ask: 7.85 } }
  const r = await refreshFxLegs(db, {
    symbols: WATCHLIST, symbolMap: SYMBOL_MAP, now: NOW,
    getSpot: async (id) => { asked.push(id); return quotes[id] },
  })
  assert.equal(r.failed.length, 0, `failed: ${r.failed}`)
  assert.deepEqual(r.fetched.sort(), ['GBPUSD', 'USDCAD', 'USDHKD', 'USDJPY', 'USDNOK', 'USDPLN'])
  // THE MID, not the bid: a conversion rate taken from one side biases every
  // cross-pair size by half a spread, always in the same direction.
  assert.equal(readFxTable(db).USDPLN.p, 3.795)
  const rates = loadFxRates(db, NOW)
  assert.ok(rates.USDPLN > 0 && rates.USDNOK > 0 && rates.USDCAD > 0)
})

test('the steady state costs NOTHING — fresh legs are not refetched', async () => {
  const db = initDB(':memory:')
  const quotes = { 10: { bid: 3.79, ask: 3.80 }, 11: { bid: 157.6, ask: 157.7 },
    12: { bid: 1.409, ask: 1.41 }, 13: { bid: 1.349, ask: 1.3493 },
    14: { bid: 9.57, ask: 9.58 }, 16: { bid: 7.84, ask: 7.85 } }
  let calls = 0
  const getSpot = async (id) => { calls++; return quotes[id] }
  await refreshFxLegs(db, { symbols: WATCHLIST, symbolMap: SYMBOL_MAP, now: NOW, getSpot })
  const first = calls
  await refreshFxLegs(db, { symbols: WATCHLIST, symbolMap: SYMBOL_MAP, now: NOW + 60_000, getSpot })
  assert.equal(calls, first, 'a second sweep a minute later must fetch nothing')
  // …and it does come back once the refresh age passes.
  await refreshFxLegs(db, {
    symbols: WATCHLIST, symbolMap: SYMBOL_MAP, now: NOW + LEG_REFRESH_AFTER_MS + 60_000, getSpot,
  })
  assert.ok(calls > first, 'past the refresh age the legs are re-fetched')
})

test('one dead symbol does not cost the rest of the sweep', async () => {
  const db = initDB(':memory:')
  const r = await refreshFxLegs(db, {
    symbols: ['AUDPLN', 'EURJPY'], symbolMap: SYMBOL_MAP, now: NOW,
    getSpot: async (id) => {
      if (id === 10) throw new Error('symbol not subscribed')
      return { bid: 157.6, ask: 157.7 }
    },
  })
  assert.deepEqual(r.failed, ['USDPLN'])
  assert.deepEqual(r.fetched, ['USDJPY'])
})

test('no quote source → it says so rather than reporting a clean sweep', async () => {
  const db = initDB(':memory:')
  const r = await refreshFxLegs(db, { symbols: WATCHLIST, symbolMap: SYMBOL_MAP, now: NOW })
  assert.equal(r.skipped, 'no_quote_source')
  assert.equal(r.fetched.length, 0)
})

test('the fetch is capped per cycle, oldest first', async () => {
  const db = initDB(':memory:')
  const r = await refreshFxLegs(db, {
    symbols: WATCHLIST, symbolMap: SYMBOL_MAP, now: NOW, limit: 2,
    getSpot: async () => ({ bid: 1, ask: 1.1 }),
  })
  assert.equal(r.fetched.length, 2)
  assert.ok(r.stale > 2, 'the rest are reported as still stale, not silently dropped')
})

test('THE WHOLE POINT: after the sweep, AUDPLN sizes instead of vetoing', async () => {
  const { computeRiskBasedVolume } = await import('./risk.js')
  const db = initDB(':memory:')
  // Before: the table holds only what the scanner happened to see — AUDUSD,
  // not USDPLN. This is production on 03-08.
  setState(db, 'fx_rates_json', JSON.stringify({ AUDUSD: { p: 0.70402, t: NOW } }))
  const before = computeRiskBasedVolume(48386, 'AUDPLN', 0.02, 0.05, 2.649, loadFxRates(db, NOW))
  assert.equal(before.note, 'usd_per_lot_unknown')
  assert.equal(before.volume, 0)

  await refreshFxLegs(db, {
    symbols: ['AUDPLN'], symbolMap: SYMBOL_MAP, now: NOW,
    getSpot: async () => ({ bid: 3.79, ask: 3.80 }),   // USDPLN
  })

  const after = computeRiskBasedVolume(48386, 'AUDPLN', 0.02, 0.05, 2.649, loadFxRates(db, NOW))
  assert.notEqual(after.note, 'usd_per_lot_unknown')
  assert.ok(after.volume > 0, `expected a size, got ${JSON.stringify(after)}`)
  // 1 lot of AUDPLN = 100,000; a 0.02 PLN move = 2,000 PLN = 2,000 / 3.795
  // ≈ $527 per lot. A $2,419 budget buys ~4.5 lots.
  assert.ok(after.usdRisk > 0 && after.usdRisk <= 48386 * 0.05)
})

test('the report names each currency, its leg, and how old it is', () => {
  const db = initDB(':memory:')
  setState(db, 'fx_rates_json', JSON.stringify({
    USDJPY: { p: 157.651, t: NOW - 5 * 60_000 },
    USDPLN: { p: 3.79427, t: NOW - 54 * HOUR },   // expired: past RATE_MAX_AGE_MS
    USDCAD: { p: 1.4095, t: NOW - 12 * HOUR },    // stale: past refresh, still usable
  }))
  const rep = fxLegReport(db, { symbols: WATCHLIST, symbolMap: SYMBOL_MAP, now: NOW })
  const by = Object.fromEntries(rep.rows.map(r => [r.currency, r]))
  assert.equal(by.JPY.state, 'fresh')
  assert.equal(by.JPY.leg, 'USDJPY')
  assert.equal(by.JPY.ageMin, 5)
  assert.equal(by.CAD.state, 'stale')
  assert.equal(by.PLN.state, 'expired')     // this is the one that vetoed 695 entries
  assert.equal(by.NOK.state, 'missing')
  assert.ok(rep.unusable >= 2)
})
