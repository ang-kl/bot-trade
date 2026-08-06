// node --test agent/lib/lot-size-registry.test.js
//
// THE READING THIS PINS (2026-08-06). `trades.volume` 83.14 for a 0003.HK
// position the broker holds as 5,000 units. Those two numbers are CONSISTENT —
// lots vs units, ~60 units per lot. The defect is that contractSize('0003.HK')
// returns 1, so RECONCILIATION would record the same position as 5,000 lots,
// and that figure feeds notionalUsd and the margin gate.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { contractSize } from './contracts.js'
import {
  rememberLotSize, unitsPerLot, lotsFromUnits, lotSizeParity,
  LOT_SIZE_KEY, CENTS_PER_UNIT,
} from './lot-size-registry.js'
import { brokerVolumeToLots } from '../services/reconciler.js'

const fresh = () => initDB(':memory:')
/** A broker position carrying `volume` in cTrader cents-of-units. */
const bp = (units) => ({ tradeData: { volume: units * CENTS_PER_UNIT } })

test('the table really does return 1 for a Hong Kong share CFD', () => {
  // Not an assumption — the premise of the whole finding, asserted.
  assert.equal(contractSize('0003.HK'), 1)
  assert.equal(contractSize('0005.HK'), 1)
})

test('with no broker knowledge the answer is the table, and says so', () => {
  const db = fresh()
  assert.deepEqual(unitsPerLot(db, '0003.HK'), { unitsPerLot: 1, source: 'table', lotSize: null })
  assert.equal(unitsPerLot(db, 'EURUSD').unitsPerLot, 100_000, 'FX still resolves from the table')
  assert.equal(unitsPerLot(db, 'EURUSD').source, 'table')
})

test('the broker declaration outranks the table', () => {
  const db = fresh()
  assert.equal(rememberLotSize(db, '0003.HK', 6_000), true)   // 60 units per lot
  const r = unitsPerLot(db, '0003.HK')
  assert.equal(r.unitsPerLot, 60)
  assert.equal(r.source, 'broker')
  assert.equal(r.lotSize, 6_000)
})

test('THE DEFECT: 5,000 units of 0003.HK becomes 5,000 lots on the table, ~83 on broker truth', () => {
  const db = fresh()
  // Before: the table's answer, which is what production would have recorded.
  assert.equal(brokerVolumeToLots(bp(5_000), '0003.HK'), 5_000)
  // After: the broker's own lot size, recorded at order time.
  rememberLotSize(db, '0003.HK', 6_000)
  assert.equal(brokerVolumeToLots(bp(5_000), '0003.HK', db), 5_000 / 60)
  assert.ok(Math.abs(brokerVolumeToLots(bp(5_000), '0003.HK', db) - 83.33) < 0.01,
    'and it lands on the 83 that trades.volume already held')
})

test('the second reading reconciles too — 62 units of 0005.HK at 3.45 lots', () => {
  const db = fresh()
  rememberLotSize(db, '0005.HK', 1_800)   // 18 units per lot
  const lots = brokerVolumeToLots(bp(62), '0005.HK', db)
  assert.ok(Math.abs(lots - 3.44) < 0.02, `expected ~3.45 lots, got ${lots}`)
})

test('symbol case does not decide whose lot it is', () => {
  const db = fresh()
  rememberLotSize(db, '0003.hk', 6_000)
  assert.equal(unitsPerLot(db, '0003.HK').unitsPerLot, 60)
})

test('a nonsense lot size is refused — a bad record OUTRANKS the fallback', () => {
  const db = fresh()
  for (const bad of [0, -1, null, undefined, NaN, 'many']) {
    assert.equal(rememberLotSize(db, 'EURUSD', bad), false, String(bad))
  }
  assert.equal(unitsPerLot(db, 'EURUSD').source, 'table', 'nothing was stored')
})

test('an unchanged value is not rewritten', () => {
  const db = fresh()
  assert.equal(rememberLotSize(db, 'EURUSD', 10_000_000), true)
  assert.equal(rememberLotSize(db, 'EURUSD', 10_000_000), false, 'idempotent')
  assert.equal(rememberLotSize(db, 'EURUSD', 10_000_001), true, 'a real change still writes')
})

test('malformed state does not poison the read', () => {
  const db = fresh()
  setState(db, LOT_SIZE_KEY, '{not json')
  assert.equal(unitsPerLot(db, 'EURUSD').source, 'table')
  setState(db, LOT_SIZE_KEY, '[1,2,3]')
  assert.equal(unitsPerLot(db, 'EURUSD').source, 'table', 'an array is not a symbol map')
  // And it can recover.
  assert.equal(rememberLotSize(db, 'EURUSD', 10_000_000), true)
  assert.equal(unitsPerLot(db, 'EURUSD').source, 'broker')
})

test('lotsFromUnits reports its own provenance and survives a missing volume', () => {
  const db = fresh()
  rememberLotSize(db, '0003.HK', 6_000)
  assert.deepEqual(lotsFromUnits(db, '0003.HK', 600), { lots: 10, unitsPerLot: 60, source: 'broker' })
  const none = lotsFromUnits(db, '0003.HK', null)
  assert.equal(none.lots, null)
  assert.equal(none.unitsPerLot, 60, 'the definition is still reported')
})

test('a broker position with no volume is still null, not zero lots', () => {
  const db = fresh()
  rememberLotSize(db, '0003.HK', 6_000)
  assert.equal(brokerVolumeToLots({ tradeData: {} }, '0003.HK', db), null)
  assert.equal(brokerVolumeToLots(null, '0003.HK', db), null)
})

test('existing callers that pass no db behave exactly as before', () => {
  // The whole back-compat contract in one line: eleven call sites still work.
  assert.equal(brokerVolumeToLots(bp(100_000), 'EURUSD'), 1)
  assert.equal(brokerVolumeToLots(bp(5_000), '0003.HK'), 5_000)
})

// ---------------------------------------------------------------------------
// The parity report — which side is wrong, as a number
// ---------------------------------------------------------------------------

test('parity names the disagreement and its multiple', () => {
  const db = fresh()
  rememberLotSize(db, '0003.HK', 6_000)        // 60 vs table 1
  rememberLotSize(db, 'EURUSD', 10_000_000)    // 100,000 vs table 100,000 — agrees
  const p = lotSizeParity(db)
  assert.equal(p.n, 2)
  assert.equal(p.disagreeing, 1)
  const hk = p.rows.find(r => r.symbol === '0003.HK')
  assert.deepEqual(
    { s: hk.status, b: hk.brokerUnitsPerLot, t: hk.tableUnitsPerLot, r: hk.ratio },
    { s: 'disagrees', b: 60, t: 1, r: 60 },
  )
  const fx = p.rows.find(r => r.symbol === 'EURUSD')
  assert.equal(fx.status, 'agrees')
  assert.equal(fx.ratio, null)
})

test('worst offender sorts first', () => {
  const db = fresh()
  rememberLotSize(db, '0005.HK', 1_800)   // ratio 18
  rememberLotSize(db, '0003.HK', 6_000)   // ratio 60
  assert.equal(lotSizeParity(db).rows[0].symbol, '0003.HK')
})

test('NEVER RECORDED is reported as unknown, never as agreement', () => {
  // The distinction the audit needed: "verified identical" and "never checked"
  // both print disagrees:false unless the reason is stated.
  const db = fresh()
  const p = lotSizeParity(db, ['0016.HK'])
  assert.equal(p.rows[0].status, 'broker_unknown')
  assert.equal(p.rows[0].brokerUnitsPerLot, null)
  assert.equal(p.rows[0].disagrees, false)
  assert.equal(p.unknown, 1)
  assert.match(p.note, /never been recorded and still fall back to the table/)
})

test('an empty registry says so rather than reporting clean', () => {
  const p = lotSizeParity(fresh())
  assert.equal(p.n, 0)
  assert.equal(p.disagreeing, 0)
  assert.match(p.note, /no broker lot size has been recorded yet/)
})

test('explicitly named symbols are deduped and case-folded', () => {
  const db = fresh()
  const p = lotSizeParity(db, ['0003.hk', '0003.HK', ' ', ''])
  assert.equal(p.n, 1)
  assert.equal(p.rows[0].symbol, '0003.HK')
})

test('the registry key holds a plain symbol map', () => {
  const db = fresh()
  rememberLotSize(db, '0003.HK', 6_000)
  assert.deepEqual(JSON.parse(getState(db, LOT_SIZE_KEY)), { '0003.HK': 6_000 })
})
