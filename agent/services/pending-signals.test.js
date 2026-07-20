// node --test agent/services/pending-signals.test.js
//
// A hot signal on a symbol whose OWN market is closed used to be vetoed and
// forgotten. This queue makes the "trade later when the market opens" case
// explicit: queuePendingSignal() persists it, runPendingSignals() re-checks
// it every cycle against a FRESH scan the instant the market reopens.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { queuePendingSignal, runPendingSignals, expiryMsFor } from './pending-signals.js'

const CREDS = { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }

function mkDb() {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ NVDAUS: 1 }))
  setState(db, 'autopilot_symbols_json', JSON.stringify([{ symbol: 'NVDAUS', enabled: true }]))
  return db
}

const SYNTH = { consensus_bias: 'long', overall_conviction: 8, strategy: 'fib_618_fade', timeframe: '15m' }

test('expiryMsFor: scales with timeframe, floored at 3 days, capped at 21', () => {
  assert.equal(expiryMsFor('15m'), 3 * 86_400_000)
  assert.equal(expiryMsFor('1w'), 21 * 86_400_000)
  assert.equal(expiryMsFor('1d'), 8 * 86_400_000)
})

test('queuePendingSignal: skip/no-bias synth is not queued', () => {
  const db = mkDb()
  queuePendingSignal(db, 'NVDAUS', { consensus_bias: 'skip' }, 'closed')
  queuePendingSignal(db, 'NVDAUS', {}, 'closed')
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM pending_signals`).get().n, 0)
})

test('queuePendingSignal: one live pending row per symbol — fresher read replaces the old one', () => {
  const db = mkDb()
  queuePendingSignal(db, 'NVDAUS', SYNTH, 'NY session closed', 1_000)
  queuePendingSignal(db, 'NVDAUS', { ...SYNTH, overall_conviction: 9 }, 'NY session closed', 2_000)
  const rows = db.prepare(`SELECT * FROM pending_signals WHERE status = 'pending'`).all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].conviction, 9)
})

test('runPendingSignals: nothing queued → no-op', async () => {
  const db = mkDb()
  assert.deepEqual(await runPendingSignals(db, CREDS), { checked: 0, fired: 0, expired: 0 })
})

test('runPendingSignals: past its TTL is expired regardless of market state', async () => {
  const db = mkDb()
  queuePendingSignal(db, 'NVDAUS', SYNTH, 'closed', 1_000)
  const out = await runPendingSignals(db, CREDS, {
    now: () => 1_000 + expiryMsFor('15m') + 1,
    isSymbolMarketOpen: () => ({ open: false }),
  })
  assert.deepEqual(out, { checked: 1, expired: 1, fired: 0 })
  assert.equal(db.prepare(`SELECT status FROM pending_signals`).get().status, 'expired')
})

test('runPendingSignals: still closed → stays pending, no re-scan attempted', async () => {
  const db = mkDb()
  queuePendingSignal(db, 'NVDAUS', SYNTH, 'closed', 1_000)
  let scanned = false
  const out = await runPendingSignals(db, CREDS, {
    now: () => 2_000,
    isSymbolMarketOpen: () => ({ open: false }),
    scanSymbolFib: async () => { scanned = true; return { signal: null } },
  })
  assert.deepEqual(out, { checked: 1, fired: 0, expired: 0 })
  assert.equal(scanned, false)
  assert.equal(db.prepare(`SELECT status FROM pending_signals`).get().status, 'pending')
})

test('runPendingSignals: no creds → left pending for next cycle', async () => {
  const db = mkDb()
  queuePendingSignal(db, 'NVDAUS', SYNTH, 'closed', 1_000)
  const out = await runPendingSignals(db, { ready: false }, { now: () => 2_000 })
  assert.deepEqual(out, { checked: 1, fired: 0, expired: 0 })
})

test('runPendingSignals: market reopens, fresh scan still confirms the zone → fires via dispatchSymbolSignal', async () => {
  const db = mkDb()
  queuePendingSignal(db, 'NVDAUS', SYNTH, 'NY closed', 1_000)
  const dispatched = []
  const out = await runPendingSignals(db, CREDS, {
    now: () => 2_000,
    isSymbolMarketOpen: () => ({ open: true }),
    scanSymbolFib: async () => ({
      signal: { bias: 'long', timeframe: '15m', entry: 101, conviction: 9 },
    }),
    dispatchSymbolSignal: async (db2, s, watch, sym, signal) => {
      dispatched.push({ sym, signal })
      return { fired: true, synth: { consensus_bias: signal.bias } }
    },
  })
  assert.deepEqual(out, { checked: 1, fired: 1, expired: 0 })
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].sym, 'NVDAUS')
  assert.equal(db.prepare(`SELECT status FROM pending_signals`).get().status, 'fired')
})

test('runPendingSignals: market reopens but the bias flipped → expired, never fired opposite', async () => {
  const db = mkDb()
  queuePendingSignal(db, 'NVDAUS', SYNTH, 'NY closed', 1_000)
  let dispatchCalled = false
  const out = await runPendingSignals(db, CREDS, {
    now: () => 2_000,
    isSymbolMarketOpen: () => ({ open: true }),
    scanSymbolFib: async () => ({ signal: { bias: 'short', timeframe: '15m', entry: 90 } }),
    dispatchSymbolSignal: async () => { dispatchCalled = true; return { fired: true } },
  })
  assert.deepEqual(out, { checked: 1, fired: 0, expired: 1 })
  assert.equal(dispatchCalled, false)
  const row = db.prepare(`SELECT status, resolution_note FROM pending_signals`).get()
  assert.equal(row.status, 'expired')
  assert.match(row.resolution_note, /bias_flipped/)
})

test('runPendingSignals: market reopens but the zone is gone → expired', async () => {
  const db = mkDb()
  queuePendingSignal(db, 'NVDAUS', SYNTH, 'NY closed', 1_000)
  const out = await runPendingSignals(db, CREDS, {
    now: () => 2_000,
    isSymbolMarketOpen: () => ({ open: true }),
    scanSymbolFib: async () => ({ signal: null }),
    dispatchSymbolSignal: async () => ({ fired: true }),
  })
  assert.deepEqual(out, { checked: 1, fired: 0, expired: 1 })
  assert.equal(db.prepare(`SELECT resolution_note FROM pending_signals`).get().resolution_note, 'zone_no_longer_valid')
})

test('runPendingSignals: still valid but the gate chain declines it → expired, not left pending forever', async () => {
  const db = mkDb()
  queuePendingSignal(db, 'NVDAUS', SYNTH, 'NY closed', 1_000)
  const out = await runPendingSignals(db, CREDS, {
    now: () => 2_000,
    isSymbolMarketOpen: () => ({ open: true }),
    scanSymbolFib: async () => ({ signal: { bias: 'long', timeframe: '15m', entry: 101 } }),
    dispatchSymbolSignal: async () => ({ fired: false, synth: { auto_trade: false } }),
  })
  assert.deepEqual(out, { checked: 1, fired: 0, expired: 1 })
})

test('runPendingSignals: a transient fetch error leaves the row pending for next cycle', async () => {
  const db = mkDb()
  queuePendingSignal(db, 'NVDAUS', SYNTH, 'NY closed', 1_000)
  const out = await runPendingSignals(db, CREDS, {
    now: () => 2_000,
    isSymbolMarketOpen: () => ({ open: true }),
    scanSymbolFib: async () => ({ signal: null, error: 'trendbar fetch failed: rate limited' }),
  })
  assert.deepEqual(out, { checked: 1, fired: 0, expired: 0 })
  assert.equal(db.prepare(`SELECT status FROM pending_signals`).get().status, 'pending')
})

test('runPendingSignals: unmapped symbolId is dropped rather than looping forever', async () => {
  const db = mkDb()
  queuePendingSignal(db, 'UNKNOWNSYM', SYNTH, 'closed', 1_000)
  const out = await runPendingSignals(db, CREDS, {
    now: () => 2_000,
    isSymbolMarketOpen: () => ({ open: true }),
  })
  assert.deepEqual(out, { checked: 1, fired: 0, expired: 1 })
  assert.equal(db.prepare(`SELECT resolution_note FROM pending_signals`).get().resolution_note, 'symbolId_unknown')
})
