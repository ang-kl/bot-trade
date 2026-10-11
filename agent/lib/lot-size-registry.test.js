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
  rememberLotSize, rememberVolumeMeta, brokerMinLots,
  unitsPerLot, lotsFromUnits, lotSizeParity,
  LOT_SIZE_KEY, CENTS_PER_UNIT, lotRecordFor, LOT_SIZE_BY_ACCOUNT_KEY, reconcileLotRecord, brokerLotStep, ensureOwnLotRecord, withBrokerLotSizes,
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

test('the registry key holds a symbol map of broker volume records', () => {
  // The shape changed on purpose when the broker's MINIMUM joined the lot
  // size (17-09). It is asserted here because the map is persisted state: a
  // silent shape change is how a deployed database stops being readable.
  const db = fresh()
  rememberLotSize(db, '0003.HK', 6_000)
  assert.deepEqual(JSON.parse(getState(db, LOT_SIZE_KEY)), {
    '0003.HK': { lotSize: 6_000, minVolume: null, stepVolume: null },
  })
})

test('a legacy bare-number entry is still read, and is not a claimed minimum', () => {
  // EVERY DEPLOYED DATABASE CARRIES THE OLD SHAPE. A migration that dropped
  // it would throw away the one thing this module exists to keep, so the
  // reader accepts both. The legacy entry knows a lot size and NOT a minimum,
  // and must say so rather than implying one.
  const db = fresh()
  setState(db, LOT_SIZE_KEY, JSON.stringify({ '0003.HK': 6_000 }))
  assert.equal(unitsPerLot(db, '0003.HK').source, 'broker')
  assert.equal(unitsPerLot(db, '0003.HK').lotSize, 6_000)
  const m = brokerMinLots(db, '0003.HK')
  assert.equal(m.minLots, null)
  assert.equal(m.source, 'unknown')
  assert.equal(m.lotSize, 6_000, 'the lot size survives; only the minimum is unknown')
})

test('the broker minimum is recorded in lots, and a later lotSize-only write keeps it', () => {
  const db = fresh()
  rememberVolumeMeta(db, '0003.HK', { lotSize: 6_000, minVolume: 60_000, stepVolume: 6_000 })
  const m = brokerMinLots(db, '0003.HK')
  assert.equal(m.minLots, 10, '60,000 / 6,000 = 10 lots is the smallest order the broker accepts')
  assert.equal(m.source, 'broker')

  // The legacy call must not erase a known minimum with nothing.
  assert.equal(rememberLotSize(db, '0003.HK', 6_000), false, 'nothing changed, so nothing is written')
  assert.equal(brokerMinLots(db, '0003.HK').minLots, 10)
})

test('brokerMinLots never invents a minimum for a symbol the broker never described', () => {
  const db = fresh()
  const m = brokerMinLots(db, 'NEVER.SEEN')
  assert.equal(m.minLots, null)
  assert.equal(m.source, 'unknown')
})

// Claude · № 13,172 11-Oct (Codex P2 on #1318): a record carries the account
// whose broker answer it is, when the writer names one; the legacy
// lot-size-only call neither adds nor removes a stamp.
test('a record is stamped with the account that wrote it, and lotRecordFor reports it; unstamped records report null', () => {
  const db = fresh()
  assert.equal(lotRecordFor(db, 'BTCUSD'), null)
  assert.equal(rememberVolumeMeta(db, 'BTCUSD', { lotSize: 100, minVolume: 1, stepVolume: 1, accountId: 47790949 }), true)
  const rec = lotRecordFor(db, 'BTCUSD')
  assert.equal(rec.accountId, '47790949')
  assert.equal(rec.lotSize, 100)
  assert.equal(rec.minVolume, 1)
  assert.match(rec.at, /^\d{4}-\d{2}-\d{2}T/)
  // the same values from the same account: unchanged, no write
  assert.equal(rememberVolumeMeta(db, 'BTCUSD', { lotSize: 100, minVolume: 1, stepVolume: 1, accountId: '47790949' }), false)
  // the same values confirmed by another account: the stamp moves
  assert.equal(rememberVolumeMeta(db, 'BTCUSD', { lotSize: 100, minVolume: 1, stepVolume: 1, accountId: '43097342' }), true)
  assert.equal(lotRecordFor(db, 'BTCUSD').accountId, '43097342')
  // the legacy call keeps the stamp on file when it confirms the same values
  assert.equal(rememberLotSize(db, 'BTCUSD', 100), false)
  assert.equal(lotRecordFor(db, 'BTCUSD').accountId, '43097342')
  // Codex P2 on #1318, round 2: an unscoped writer that REPLACES the values
  // (loop.js, which names no account) clears the stamp — the record cannot
  // say whose answer the new values are
  assert.equal(rememberVolumeMeta(db, 'BTCUSD', { lotSize: 100, minVolume: 10, stepVolume: 1 }), true)
  assert.deepEqual(lotRecordFor(db, 'BTCUSD'), { lotSize: 100, minVolume: 10, stepVolume: 1, accountId: null, at: null })
  assert.equal('accountId' in JSON.parse(getState(db, LOT_SIZE_KEY)).BTCUSD, false, 'no stale stamp stored')
  // and a scoped writer stamps it again
  assert.equal(rememberVolumeMeta(db, 'BTCUSD', { lotSize: 100, minVolume: 10, stepVolume: 1, accountId: '47790949' }), true)
  assert.equal(lotRecordFor(db, 'BTCUSD').accountId, '47790949')
  // Codex P2 on #1318, round 3: a DIFFERENT account's answer that omits a
  // field does not inherit the previous account's minimum or step
  assert.equal(rememberVolumeMeta(db, 'BTCUSD', { lotSize: 100, accountId: '43097342' }), true)
  assert.deepEqual({ ...lotRecordFor(db, 'BTCUSD'), at: null }, { lotSize: 100, minVolume: null, stepVolume: null, accountId: '43097342', at: null })
  assert.equal(brokerMinLots(db, 'BTCUSD').source, 'unknown', 'the gate falls back to its own assumption, not to another account\'s minimum')
  // the SAME account's lot-size-only confirmation keeps its own minimum
  rememberVolumeMeta(db, 'BTCUSD', { lotSize: 100, minVolume: 10, stepVolume: 1, accountId: '43097342' })
  assert.equal(rememberVolumeMeta(db, 'BTCUSD', { lotSize: 100, accountId: '43097342' }), false)
  assert.equal(brokerMinLots(db, 'BTCUSD').minLots, 0.1)
  // an unstamped record (every deployed database) reports no account
  rememberLotSize(db, '0003.HK', 6_000)
  assert.deepEqual(lotRecordFor(db, '0003.HK'), { lotSize: 6_000, minVolume: null, stepVolume: null, accountId: null, at: null })
  assert.deepEqual(JSON.parse(getState(db, LOT_SIZE_KEY))['0003.HK'], { lotSize: 6_000, minVolume: null, stepVolume: null }, 'the stored shape without a stamp is unchanged')
  // a blank account is no stamp
  rememberVolumeMeta(db, 'ETHUSD', { lotSize: 100, minVolume: 1, stepVolume: 1, accountId: '  ' })
  assert.equal(lotRecordFor(db, 'ETHUSD').accountId, null)
})

// Claude · № 13,175 11-Oct (Codex P1 on #1318; ordered № 13,174): each
// account's own broker answer is kept apart, and a reader that names an
// account reads that account's record before the shared one.
test('per-account records: a named account reads its own record first, never another account\'s', () => {
  const db = fresh()
  // account A: 1 lot = 100 units, min 0.1 lot; account B: 1 lot = 1 unit, min 0.01 lot
  rememberVolumeMeta(db, 'DOTUSD', { lotSize: 10_000, minVolume: 1_000, stepVolume: 1_000, accountId: 'A' })
  rememberVolumeMeta(db, 'DOTUSD', { lotSize: 100, minVolume: 1, stepVolume: 1, accountId: 'B' })
  assert.equal(unitsPerLot(db, 'DOTUSD', 'A').unitsPerLot, 100)
  assert.equal(unitsPerLot(db, 'DOTUSD', 'B').unitsPerLot, 1)
  assert.equal(brokerMinLots(db, 'DOTUSD', 'A').minLots, 0.1)
  assert.equal(brokerMinLots(db, 'DOTUSD', 'B').minLots, 0.01)
  assert.equal(brokerLotStep(db, 'DOTUSD', 'A').stepLots, 0.1)
  // the shared map holds the last writer (B), as it always did, for callers that name no account
  assert.equal(unitsPerLot(db, 'DOTUSD').unitsPerLot, 1)
  // an account with no record of its own never reads another account's
  // stamped lot (Codex P2, round 8): it falls to the table until its own is fetched
  assert.deepEqual(unitsPerLot(db, 'DOTUSD', 'C'), { unitsPerLot: contractSize('DOTUSD') || 1, source: 'table', lotSize: null })
  assert.equal(lotRecordFor(db, 'DOTUSD', 'C'), null, 'no own record is reported as none, never as the shared one')
  assert.deepEqual({ ...lotRecordFor(db, 'DOTUSD', 'A'), at: null }, { lotSize: 10_000, minVolume: 1_000, stepVolume: 1_000, accountId: 'A', at: null })
  // a lot-size-only write for A keeps A's own minimum and does not borrow B's
  rememberVolumeMeta(db, 'DOTUSD', { lotSize: 10_000, accountId: 'A' })
  assert.equal(brokerMinLots(db, 'DOTUSD', 'A').minLots, 0.1)
  const stored = JSON.parse(getState(db, LOT_SIZE_BY_ACCOUNT_KEY))
  assert.deepEqual(Object.keys(stored).sort(), ['A', 'B'])
})

test('reconcileLotRecord: records this account\'s answer and names a gate that sized on a different lot', () => {
  const db = fresh()
  // the gate sized on the shared record, written by B (1 unit a lot)
  const checks = { units_per_lot: { value: 1, source: 'broker' } }
  const reason = reconcileLotRecord(db, 'DOTUSD', 'A', { lotSize: 10_000, minVolume: 1_000, stepVolume: 1_000 }, checks)
  assert.match(reason, /^lot_record_mismatch: the gate sized DOTUSD at 1 units\/lot \(broker\); the broker says 100 for account A/)
  assert.equal(unitsPerLot(db, 'DOTUSD', 'A').unitsPerLot, 100, 'the record is corrected for the next pass')
  // the same lot: no refusal
  assert.equal(reconcileLotRecord(db, 'DOTUSD', 'A', { lotSize: 10_000 }, { units_per_lot: { value: 100, source: 'broker' } }), null)
  // a table-sized gate with a matching broker lot passes; a mismatching one is refused
  assert.equal(reconcileLotRecord(db, 'EURUSD', 'A', { lotSize: 10_000_000 }, { units_per_lot: { value: 100_000, source: 'table' } }), null)
  assert.match(reconcileLotRecord(db, 'BCHUSD', 'A', { lotSize: 100 }, { units_per_lot: { value: 100_000, source: 'table' } }), /sized BCHUSD at 100000 units\/lot \(table\); the broker says 1 for account A/)
  // nothing to compare: no refusal, still recorded
  assert.equal(reconcileLotRecord(db, 'XLMUSD', 'A', { lotSize: 10_000 }, {}), null)
  assert.equal(unitsPerLot(db, 'XLMUSD', 'A').unitsPerLot, 100)
})

// Codex P2 on #1318, round 7: a HIGHER minimum written by another account
// would refuse this account at the gate on every retry, before any post-gate
// fetch could correct it. Another account's shared minimum is never used.
test('a named account with no record of its own does not inherit another account\'s minimum or step; unstamped legacy entries still apply', () => {
  const db = fresh()
  rememberVolumeMeta(db, 'DOTUSD', { lotSize: 10_000, minVolume: 1_000, stepVolume: 1_000, accountId: 'B' }) // B: min 0.1
  const a = brokerMinLots(db, 'DOTUSD', 'A')
  assert.equal(a.minLots, null)
  assert.equal(a.source, 'unknown', 'A falls back to the configured assumption; a too-low guess is caught after the gate')
  assert.equal(brokerLotStep(db, 'DOTUSD', 'A').stepLots, null)
  assert.equal(brokerMinLots(db, 'DOTUSD', 'B').minLots, 0.1, 'B reads its own')
  assert.equal(brokerMinLots(db, 'DOTUSD').minLots, 0.1, 'a caller naming no account reads the shared map as before')
  assert.equal(unitsPerLot(db, 'DOTUSD', 'A').source, 'table', 'nor another account\'s lot SIZE (round 8); the paths fetch their own before the gate')
  // an unstamped legacy entry (provenance unknown) still applies to a named account
  setState(db, LOT_SIZE_KEY, JSON.stringify({ XLMUSD: { lotSize: 10_000, minVolume: 1_000, stepVolume: 1_000 } }))
  assert.equal(brokerMinLots(db, 'XLMUSD', 'A').minLots, 0.1)
  // a shared entry stamped by the SAME account applies
  setState(db, LOT_SIZE_BY_ACCOUNT_KEY, '{}')
  setState(db, LOT_SIZE_KEY, JSON.stringify({ UNIUSD: { lotSize: 10_000, minVolume: 1_000, stepVolume: 1_000, accountId: 'A' } }))
  assert.equal(brokerMinLots(db, 'UNIUSD', 'A').minLots, 0.1)
})

// Codex P2 on #1318, round 8: an account with no record of its own fetches
// it before the gate, once — the record persists — and a failure changes
// nothing and is retried.
test('ensureOwnLotRecord fetches this account\'s record once, persists it, and leaves nothing behind on a failure', async () => {
  const db = fresh()
  rememberVolumeMeta(db, 'BTCUSD', { lotSize: 10_000_000, minVolume: 100_000, accountId: 'B' }) // B: 100,000 units a lot
  let calls = 0
  const fetchA = async () => { calls++; return { lotSize: 100, minVolume: 1, stepVolume: 1 } }
  assert.equal(unitsPerLot(db, 'BTCUSD', 'A').source, 'table', 'before: no own record, B\'s is not used')
  assert.deepEqual(await ensureOwnLotRecord(db, 'BTCUSD', 'A', fetchA), { fetched: true, reason: null })
  assert.equal(unitsPerLot(db, 'BTCUSD', 'A').unitsPerLot, 1, 'A sizes in its own 1 unit a lot')
  assert.equal(brokerMinLots(db, 'BTCUSD', 'A').minLots, 0.01)
  assert.deepEqual(await ensureOwnLotRecord(db, 'BTCUSD', 'A', fetchA), { fetched: false, reason: 'own_record' })
  assert.equal(calls, 1, 'one broker call, ever, for this account and symbol')
  // a failure writes nothing and the next pass tries again
  const failed = await ensureOwnLotRecord(db, 'ETHUSD', 'A', async () => { throw new Error('timeout') })
  assert.equal(failed.fetched, false)
  assert.match(failed.reason, /^fetch_failed: timeout/)
  assert.equal(lotRecordFor(db, 'ETHUSD', 'A'), null)
  assert.equal((await ensureOwnLotRecord(db, 'ETHUSD', 'A', async () => null)).reason, 'no_lot_size')
  assert.equal((await ensureOwnLotRecord(db, 'ETHUSD', null, fetchA)).reason, 'no_account')
})

// Codex P1 on #1318, round 9: converting an existing position reads the
// position's own account record first; the shared entry stays the fallback.
test('lotsFromUnits converts with the account\'s own record first, the shared one after', async () => {
  const db = fresh()
  const { brokerVolumeToLots } = await import('../services/reconciler.js')
  rememberVolumeMeta(db, 'BTCUSD', { lotSize: 100, accountId: 'B' })          // B: 1 BTC a lot
  rememberVolumeMeta(db, 'BTCUSD', { lotSize: 10_000, accountId: 'A' })       // A: 100 BTC a lot, written last (shared = A)
  assert.equal(lotsFromUnits(db, 'BTCUSD', 2, 'B').lots, 2, 'B\'s position converts with B\'s own lot, not A\'s shared one')
  assert.equal(lotsFromUnits(db, 'BTCUSD', 200, 'A').lots, 2)
  assert.equal(lotsFromUnits(db, 'BTCUSD', 200).lots, 2, 'no account named: the shared entry, as before')
  assert.equal(lotsFromUnits(db, 'BTCUSD', 200, 'C').lots, 2, 'an account with no record of its own: the shared entry, never the 100,000-unit table')
  const bp = { tradeData: { volume: 200 } } // broker cents of units → 2 units
  assert.equal(brokerVolumeToLots(bp, 'BTCUSD', db, 'B'), 2)
  assert.equal(brokerVolumeToLots(bp, 'BTCUSD', db, 'A'), 0.02)
  assert.equal(lotsFromUnits(db, 'BTCUSD', null, 'B').lots, null, 'absent volume stays absent')
})

// Codex P1 on #1318, round 11: writers this change added record the
// account's own record only; deal imports divide by the account's own lot.
test('an own-only write leaves the shared slot alone, and deal imports read the account\'s own lot first', () => {
  const db = fresh()
  rememberVolumeMeta(db, 'BTCUSD', { lotSize: 100, accountId: 'B' })                         // shared + B (a pre-existing writer)
  assert.equal(rememberVolumeMeta(db, 'BTCUSD', { lotSize: 10_000, accountId: 'A' }, { shared: false }), true)
  assert.equal(lotRecordFor(db, 'BTCUSD').lotSize, 100, 'the shared slot still holds B\'s answer')
  assert.equal(lotRecordFor(db, 'BTCUSD', 'A').lotSize, 10_000)
  const meta = () => ({ 7: { symbolName: 'BTCUSD' } })
  assert.equal(withBrokerLotSizes(db, meta(), 'A')[7].lotSize, 10_000, 'A\'s deals divide by A\'s lot')
  assert.equal(withBrokerLotSizes(db, meta(), 'B')[7].lotSize, 100)
  assert.equal(withBrokerLotSizes(db, meta())[7].lotSize, 100, 'no account named: the shared slot, as before')
  // Codex P1 on #1318, round 12: an account with no record of its own never
  // divides by a shared lot another account stamped — the lots stay unknown
  assert.equal(withBrokerLotSizes(db, meta(), 'C')[7].lotSize, undefined, 'B stamped the shared slot; C\'s deals keep lots unknown')
  setState(db, LOT_SIZE_KEY, JSON.stringify({ XRPUSD: 1_000 }))   // a legacy unstamped entry still applies
  assert.equal(withBrokerLotSizes(db, { 9: { symbolName: 'XRPUSD' } }, 'C')[9].lotSize, 1_000)
  assert.equal(rememberVolumeMeta(db, 'ETHUSD', { lotSize: 100 }, { shared: false }), false, 'own-only with no account writes nothing')
  assert.equal(lotRecordFor(db, 'ETHUSD'), null)
})
