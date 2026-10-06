import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { refreshFxLegs, readLegAttempts, LEG_RETRY_AFTER_MS } from './fx-legs.js'
import { readFxTable, recordFxRate } from './fx-rates.js'

const NOW = Date.UTC(2026, 9, 6, 8)
const SYMBOLS = ['AUDPLN', 'GBPNOK']
const MAP = { USDPLN: 10, USDNOK: 11, USDSGD: 12 }

function observeDemandReads(db) {
  const prepare = db.prepare.bind(db)
  let reads = 0
  db.prepare = sql => {
    if (/\brisk_events\b/i.test(sql)) reads++
    return prepare(sql)
  }
  return () => reads
}

test('fresh conversion and native deposit legs do not read veto history or ask for quotes', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  for (const symbol of Object.keys(MAP)) recordFxRate(db, symbol, 2, NOW)
  const before = readFxTable(db)
  const reads = observeDemandReads(db)
  const result = await refreshFxLegs(db, {
    symbols: SYMBOLS, symbolMap: MAP, accountCurrencies: ['SGD'], now: NOW,
    getSpot: async () => assert.fail('fresh legs must not be requested'),
  })
  assert.equal(reads(), 0, 'a zero-quote sweep must not scan risk history')
  assert.deepEqual(result, { checked: 3, stale: 0, fetched: [], failed: [], failedWhy: [], currencies: ['NOK', 'PLN', 'SGD'] })
  assert.deepEqual(readFxTable(db), before)
})

test('all stale legs in retry cooldown avoid veto history and preserve refusal attempts', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const attempts = { USDPLN: NOW - 1000, USDNOK: NOW - 1000 }
  setState(db, 'fx_leg_attempts_json', JSON.stringify(attempts))
  const reads = observeDemandReads(db)
  const result = await refreshFxLegs(db, {
    symbols: SYMBOLS, symbolMap: MAP, now: NOW,
    getSpot: async () => assert.fail('cooling legs must not be requested'),
  })
  assert.equal(reads(), 0)
  assert.equal(result.stale, 0)
  assert.deepEqual(readLegAttempts(db), attempts)
})

test('eligible legs still use actual repeated veto demand before the capped quote selection', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const insert = db.prepare(`INSERT INTO risk_events(symbol,approved,veto_reason,repeat_count,created_at)
    VALUES (?,0,'insufficient_equity usd_per_lot_unknown',?,datetime('now'))`)
  insert.run('GBPNOK', 2); insert.run('AUDPLN', 9)
  const reads = observeDemandReads(db); const asked = []
  const result = await refreshFxLegs(db, {
    symbols: SYMBOLS, symbolMap: MAP, now: NOW, limit: 1,
    getSpot: async id => { asked.push(id); return { bid: 2, ask: 4 } },
  })
  assert.equal(reads(), 1)
  assert.deepEqual(asked, [10], 'PLN has greater recorded demand despite alphabetical NOK first')
  assert.equal(result.stale, 2)
  assert.deepEqual(result.fetched, ['USDPLN'])
  assert.equal(readFxTable(db).USDPLN.p, 3, 'retain quote-mid validation')
})

test('the native deposit leg becomes eligible exactly when its retry cooldown expires', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const at = NOW - LEG_RETRY_AFTER_MS
  setState(db, 'fx_leg_attempts_json', JSON.stringify({ USDPLN: NOW - 1, USDNOK: NOW - 1, USDSGD: at }))
  const reads = observeDemandReads(db); const asked = []
  const result = await refreshFxLegs(db, {
    symbols: SYMBOLS, symbolMap: MAP, accountCurrencies: ['SGD'], now: NOW,
    getSpot: async id => { asked.push(id); return { price: 2 } },
  })
  assert.equal(reads(), 1)
  assert.deepEqual(asked, [12])
  assert.equal(result.stale, 1)
  assert.deepEqual(result.fetched, ['USDSGD'])
  assert.deepEqual(readLegAttempts(db), { USDPLN: NOW - 1, USDNOK: NOW - 1 })
})
