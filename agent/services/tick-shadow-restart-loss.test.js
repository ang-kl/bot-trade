// agent/services/tick-shadow-restart-loss.test.js — V3 Q0: the shadow
// restart-loss count can fire.
//
// THE DEFECT. The heartbeat probe runs pullTickStatus BEFORE pullTickShadow.
// On the probe that first sees a sidecar restart, pullTickStatus has already
// replaced <side>_tick_json's status with the NEW boot's (a fresh boot: open
// 0), and pullTickShadow counted the open trades the restart took from that
// overwritten status — so it wrote 0 'lost_restart' rows on every one of 100
// demo and 35 live boots (production /state/tick-shadow, 25-09-2026: lost 0,
// resetSharePct 0 on both sides), and SHADOW_PASSED's "resets ≤ 20 %" check
// could not go red.
//
// These tests drive the REAL probe (probeOneSidecar) against a fake sidecar,
// so the ordering that caused the defect is the ordering under test — no
// hand-written <side>_tick_json standing in for what the probe would store.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initDB, setState, getState } from '../db.js'
import { probeOneSidecar, pullTickStatus, pullTickShadow, TICK_SHADOW_CURSOR_KEY, SHADOW_OPEN_BOOTS_KEPT } from './heartbeat.js'
import { shadowPortfolio } from './tick-shadow.js'

const SIDE = { name: 'cpp_exec_demo', base: 'http://demo.test', isLive: false }
const T0 = Date.parse('2026-09-25T12:00:00Z')

const closedTrade = (seq) => ({ seq, symbolId: 1, side: 'BUY', entry: 1000, exit: 1030, stop: 990, target: 1030, stopDistance: 10,
  reason: seq % 2 ? 'target' : 'stop', holdEvents: 8, holdMs: 800, entryMs: T0 + seq * 1000, exitMs: T0 + seq * 1000 + 800,
  grossR: seq % 2 ? 3 : -1, netR: seq % 2 ? 3 : -1, profile: 'abcdef0123456789' })

// One fake sidecar. Its boot, its shadow book and whether each endpoint
// answers are set by the test between probes; the probe reads them the way
// it reads the real /health, /tick-status and /tick-shadow.
function fakeSidecar() {
  const s = { bootId: 'boot-1', open: 0, closed: [], statusUp: true, shadowUp: true, shadowInStatus: true }
  const exec = {
    pingSidecar: async () => ({ ok: true, tick: { enabled: true } }),
    sidecarTickStatus: async () => (s.statusUp
      ? { enabled: true, state: 'RECORDING', recording: true,
          ...(s.shadowInStatus ? { shadowPortfolio: { bootId: s.bootId, closed: s.closed.length, latestSeq: s.closed.length, open: s.open, resets: 0 } } : {}) }
      : null),
    pullSidecarShadow: async ({ after, bootId }) => (s.shadowUp
      ? { bootId: s.bootId, latestSeq: s.closed.length, total: s.closed.length, trades: bootId === s.bootId ? s.closed.filter(t => t.seq > after) : s.closed }
      : null),
  }
  // a restart: a new ledger, nothing open, nothing closed
  s.restart = (bootId) => { s.bootId = bootId; s.open = 0; s.closed = [] }
  return { s, exec }
}
let clock = T0
const probe = (db, exec) => { clock += 120_000; return probeOneSidecar(db, exec, SIDE, { now: new Date(clock) }) }
const lostRows = (db, bootId) => db.prepare(`SELECT COUNT(*) AS n FROM tick_shadow_trades WHERE side = ? AND boot_id = ? AND reason = 'lost_restart' AND net_r IS NULL`).get(SIDE.name, bootId).n

test('Q0: a boot change with 3 open shadow trades writes 3 lost_restart rows and a reset share above 0 — through the real probe order', async () => {
  const db = initDB(':memory:')
  const { s, exec } = fakeSidecar()
  s.closed = [closedTrade(1), closedTrade(2), closedTrade(3), closedTrade(4)]
  s.open = 3
  await probe(db, exec)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tick_shadow_trades').get().n, 4, 'boot-1\'s four closed trades are on record')
  assert.equal(shadowPortfolio(db, { side: SIDE.name }).resetSharePct, 0, 'no restart yet: nothing lost')

  // the sidecar restarts between probes: the three open trades die with it
  s.restart('boot-2')
  await probe(db, exec)
  // the status the probe stored is the NEW boot's, open 0 — the value the old code read
  assert.equal(JSON.parse(getState(db, `${SIDE.name}_tick_json`)).status.shadowPortfolio.open, 0)
  assert.equal(lostRows(db, 'boot-1'), 3, 'the three open trades the restart took are on record, without a result')
  assert.equal(lostRows(db, 'boot-2'), 0)
  const pf = shadowPortfolio(db, { side: SIDE.name })
  assert.equal(pf.lost, 3)
  assert.equal(pf.trades, 4)
  assert.equal(pf.resetSharePct, +(100 * 3 / 7).toFixed(1), 'the reset share counts them: 3 of 7')
  assert.ok(pf.resetSharePct > 20, 'so the "resets ≤ 20 %" check CAN fail on this book')
  // the cursor moved on to the new boot, shape unchanged
  assert.deepEqual(JSON.parse(getState(db, TICK_SHADOW_CURSOR_KEY))[SIDE.name], { bootId: 'boot-2', lastSeq: 0 })

  // the next probe on the same boot writes nothing more
  await probe(db, exec)
  assert.equal(lostRows(db, 'boot-1'), 3, 'idempotent: no second batch')
  db.close()
})

test('Q0: a restart with nothing open writes no lost row — the count is the old boot\'s, not invented', async () => {
  const db = initDB(':memory:')
  const { s, exec } = fakeSidecar()
  s.closed = [closedTrade(1)]
  s.open = 0
  await probe(db, exec)
  s.restart('boot-2')
  s.open = 2 // the NEW boot already has two open by the time the probe reads it
  await probe(db, exec)
  assert.equal(lostRows(db, 'boot-1'), 0, 'boot-1 had nothing open; the new boot\'s open trades are not boot-1\'s losses')
  assert.equal(lostRows(db, 'boot-2'), 0)
  assert.equal(shadowPortfolio(db, { side: SIDE.name }).resetSharePct, 0)
  db.close()
})

test('Q0: a shadow pull that misses the boundary probe still counts the old boot on a later probe', async () => {
  const db = initDB(':memory:')
  const { s, exec } = fakeSidecar()
  s.closed = [closedTrade(1), closedTrade(2)]
  s.open = 4
  await probe(db, exec)
  s.restart('boot-2')
  s.shadowUp = false // /tick-shadow does not answer on the boundary probe
  await probe(db, exec)
  assert.equal(lostRows(db, 'boot-1'), 0, 'nothing pulled yet')
  s.open = 1
  await probe(db, exec) // the status is overwritten AGAIN with boot-2's figures
  s.shadowUp = true
  s.open = 2
  await probe(db, exec)
  assert.equal(JSON.parse(getState(db, TICK_SHADOW_CURSOR_KEY))[SIDE.name].bootId, 'boot-2')
  assert.equal(lostRows(db, 'boot-1'), 4, 'boot-1\'s last observed open count, three status overwrites later')
  db.close()
})

test('Q0: the status going OFF between boots does not erase what the old boot had open', async () => {
  const db = initDB(':memory:')
  const { s, exec } = fakeSidecar()
  s.closed = [closedTrade(1)]
  s.open = 2
  await probe(db, exec)
  s.restart('boot-2')
  s.shadowInStatus = false // e.g. a recorder answering {enabled:false}-shaped status with no shadow block
  s.shadowUp = false
  await probe(db, exec)
  s.shadowInStatus = true; s.shadowUp = true
  await probe(db, exec)
  assert.equal(lostRows(db, 'boot-1'), 2)
  db.close()
})

test('Q0: a record written before Q0 (no per-boot map) still yields the old boot\'s count after the status is overwritten', async () => {
  const db = initDB(':memory:')
  const { s, exec } = fakeSidecar()
  // the state the deploy inherits: cursor on boot-1, the pre-Q0 record for boot-1
  setState(db, TICK_SHADOW_CURSOR_KEY, JSON.stringify({ [SIDE.name]: { bootId: 'boot-1', lastSeq: 5 } }))
  setState(db, `${SIDE.name}_tick_json`, JSON.stringify({ at: new Date(T0).toISOString(), side: SIDE.name, lastLoggedAt: null,
    status: { enabled: true, state: 'RECORDING', recording: true, shadowPortfolio: { bootId: 'boot-1', closed: 5, latestSeq: 5, open: 2, resets: 0 } } }))
  s.restart('boot-2')
  await probe(db, exec)
  assert.equal(lostRows(db, 'boot-1'), 2)
  db.close()
})

test('Q0: an old boot whose open count was never observed writes nothing and says UNKNOWN — never a silent 0', async () => {
  const db = initDB(':memory:')
  setState(db, TICK_SHADOW_CURSOR_KEY, JSON.stringify({ [SIDE.name]: { bootId: 'boot-1', lastSeq: 3 } }))
  // the stored status names ANOTHER boot; and a status naming no boot says nothing either
  for (const sp of [{ bootId: 'boot-0', open: 5, latestSeq: 1 }, { open: 5, latestSeq: 1 }]) {
    setState(db, `${SIDE.name}_tick_json`, JSON.stringify({ at: new Date(T0).toISOString(), status: { shadowPortfolio: sp } }))
    const logs = []
    const orig = console.log
    console.log = (...a) => { logs.push(a.join(' ')) }
    let r
    try { r = await pullTickShadow(db, { pullSidecarShadow: async () => ({ bootId: 'boot-2', latestSeq: 0, total: 0, trades: [] }) }, SIDE) } finally { console.log = orig }
    assert.equal(lostRows(db, 'boot-1'), 0)
    assert.equal(r.restart.lost, null, 'unknown is null, not 0')
    assert.equal(r.restart.fromBoot, 'boot-1')
    assert.ok(logs.some(l => /NEVER observed/.test(l) && /UNKNOWN, not 0/.test(l)), 'the log says the count is unknown')
    setState(db, TICK_SHADOW_CURSOR_KEY, JSON.stringify({ [SIDE.name]: { bootId: 'boot-1', lastSeq: 3 } }))
  }
  db.close()
})

test('Q0: the restart record reports trades the old boot closed after its open count was observed, without netting them', async () => {
  const db = initDB(':memory:')
  // observed at latestSeq 5 with 3 open; the cursor then pulled through seq 7 before the restart
  await pullTickStatus(db, { sidecarTickStatus: async () => ({ enabled: true, shadowPortfolio: { bootId: 'boot-1', latestSeq: 5, open: 3 } }) }, SIDE, T0)
  setState(db, TICK_SHADOW_CURSOR_KEY, JSON.stringify({ [SIDE.name]: { bootId: 'boot-1', lastSeq: 7 } }))
  await pullTickStatus(db, { sidecarTickStatus: async () => ({ enabled: true, shadowPortfolio: { bootId: 'boot-2', latestSeq: 0, open: 0 } }) }, SIDE, T0 + 60_000)
  const r = await pullTickShadow(db, { pullSidecarShadow: async () => ({ bootId: 'boot-2', latestSeq: 0, total: 0, trades: [] }) }, SIDE)
  assert.deepEqual(r.restart, { fromBoot: 'boot-1', toBoot: 'boot-2', lost: 3, observedAt: new Date(T0).toISOString(), closedAfterObservation: 2 })
  assert.equal(lostRows(db, 'boot-1'), 3)
  db.close()
})

test('Q0: the per-boot record keeps only the most recent boots and never grows without bound', async () => {
  const db = initDB(':memory:')
  for (let i = 0; i < SHADOW_OPEN_BOOTS_KEPT + 5; i++) {
    await pullTickStatus(db, { sidecarTickStatus: async () => ({ enabled: true, shadowPortfolio: { bootId: `b${i}`, latestSeq: i, open: i } }) }, SIDE, T0 + i * 60_000)
  }
  const map = JSON.parse(getState(db, `${SIDE.name}_tick_json`)).shadowOpenByBoot
  assert.equal(Object.keys(map).length, SHADOW_OPEN_BOOTS_KEPT)
  assert.ok(map[`b${SHADOW_OPEN_BOOTS_KEPT + 4}`] && !map.b0, 'the newest are kept, the oldest dropped')
  // a status with no shadow block writes no map on a side that never had one
  const db2 = initDB(':memory:')
  await pullTickStatus(db2, { sidecarTickStatus: async () => ({ enabled: false }) }, { name: 'cpp_exec' }, T0)
  assert.equal(JSON.parse(getState(db2, 'cpp_exec_tick_json')).shadowOpenByBoot, undefined)
  db.close(); db2.close()
})
