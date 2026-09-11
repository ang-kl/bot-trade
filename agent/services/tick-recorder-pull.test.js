// agent/services/tick-recorder-pull.test.js — P3a: the keeper's side of the
// tick recorder. The probe pulls GET /tick-status into <side>_tick_json and
// logs a line on every STATE change (and every 30 min while recording), so
// the recorder's growth and the mount's free bytes are on record without a
// bearer token; the wiring that a refactor could drop in silence is pinned.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { initDB, getState } from '../db.js'
import { pullTickStatus, TICK_STATUS_LOG_EVERY_MS } from './heartbeat.js'

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')

function status(over = {}) {
  return {
    enabled: true, recording: true, state: 'RECORDING', reason: '',
    events: { total: 1200, changed: 900, dropped: 0, gaps: 0 },
    segments: { sealed: 2, sealedBytes: 134217728, openBytes: 4096 },
    disk: { totalBytes: 50e9, availBytes: 45e9, reserveBytes: 10e9, usagePct: 10 },
    perSymbol: [{ symbolId: 1, events: 1200, eventsPerSec: 4.2 }],
    ...over,
  }
}

test('the pull stores the status per side and logs on state change, then every 30 minutes while recording', async () => {
  const db = initDB(':memory:')
  const lines = []
  const orig = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try {
    const side = { name: 'cpp_exec_demo', base: 'http://demo:8081' }
    const exec = { sidecarTickStatus: async ({ base }) => { assert.equal(base, 'http://demo:8081'); return status() } }
    const t0 = Date.parse('2026-09-11T02:00:00Z')
    const rec = await pullTickStatus(db, exec, side, t0)
    assert.equal(rec.status.state, 'RECORDING')
    assert.equal(JSON.parse(getState(db, 'cpp_exec_demo_tick_json')).status.events.total, 1200)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^\[tick\] cpp_exec_demo recorder RECORDING: 1200 events \(900 changed, 0 dropped, 0 gaps\), 2 segments sealed \(0\.13 GB\)/)
    assert.match(lines[0], /mount 45\.00 GB free of 50\.00 GB \(10% used, reserve 10\.00 GB\)/)
    // unchanged state within the window: stored, not logged
    await pullTickStatus(db, exec, side, t0 + 60_000)
    assert.equal(lines.length, 1)
    // the periodic line while recording
    await pullTickStatus(db, exec, side, t0 + TICK_STATUS_LOG_EVERY_MS + 1)
    assert.equal(lines.length, 2)
    // a state change logs at once
    const paused = { sidecarTickStatus: async () => status({ state: 'PAUSED_RESERVE' }) }
    await pullTickStatus(db, paused, side, t0 + TICK_STATUS_LOG_EVERY_MS + 2)
    assert.equal(lines.length, 3); assert.match(lines[2], /recorder PAUSED_RESERVE/)
    // switched off: logged once, then silent
    const off = { sidecarTickStatus: async () => status({ recording: false, state: 'OFF' }) }
    await pullTickStatus(db, off, side, t0 + TICK_STATUS_LOG_EVERY_MS + 3)
    await pullTickStatus(db, off, side, t0 + 3 * TICK_STATUS_LOG_EVERY_MS)
    assert.equal(lines.length, 4); assert.match(lines[3], /recorder OFF \(switch off\)/)
    // a sidecar without a recorder: stored (so the route can say so), never logged
    const none = { sidecarTickStatus: async () => ({ enabled: false, reason: 'TICK_SPOOL_PATH not set' }) }
    await pullTickStatus(db, none, { name: 'cpp_exec' }, t0)
    assert.equal(lines.length, 4)
    assert.equal(JSON.parse(getState(db, 'cpp_exec_tick_json')).status.enabled, false)
    // unreachable: nothing stored
    assert.equal(await pullTickStatus(db, { sidecarTickStatus: async () => null }, { name: 'x' }, t0), null)
    assert.equal(getState(db, 'x_tick_json'), null)
  } finally {
    console.log = orig
  }
})

test('wiring pins: the probe pulls tick status, pingSidecar carries the tick field, the routes exist, the sidecar taps the feed only with TICK_SPOOL_PATH', () => {
  const hb = strip(readFileSync(new URL('./heartbeat.js', import.meta.url), 'utf8'))
  assert.match(hb, /await pullTickStatus\(db, exec, side, nowMs\)/, 'the probe pulls /tick-status')
  assert.match(hb, /reportedTick: r\.tick \?\? null/, 'the guard sync sees the recorder')
  const ee = strip(readFileSync(new URL('../lib/exec-engine.js', import.meta.url), 'utf8'))
  assert.match(ee, /tick: body\?\.tick \?\? null/, 'pingSidecar carries the tick summary')
  assert.match(ee, /export async function sidecarTickStatus/, 'the /tick-status reader exists')
  assert.match(ee, /base \+ '\/tick-status'/)
  const actions = strip(readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8'))
  assert.match(actions, /router\.post\('\/tick-observation'/)
  assert.match(actions, /requestTickObservation\(db, String\(accountId\), String\(mode\)\.toUpperCase\(\)/)
  assert.match(actions, /router\.post\('\/tick-symbols'/)
  assert.match(actions, /setState\(db, 'tick_symbols_json'/)
  const state = strip(readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8'))
  assert.match(state, /router\.get\('\/tick-recorder'/)
  const sync = strip(readFileSync(new URL('./exec-guard-sync.js', import.meta.url), 'utf8'))
  assert.match(sync, /out\.tickRecord = true; break/, 'any RECORD account switches the side on')
  // the sidecar: the recorder exists only with TICK_SPOOL_PATH, taps the raw feed, and /config carries the switch
  const main = readFileSync(new URL('../../cpp-exec/src/main.cpp', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(main, /envOr\("TICK_SPOOL_PATH", ""\)/)
  assert.match(main, /if \(!tickSpoolPath\.empty\(\)\) \{[\s\S]*?tickRecorder = std::make_unique<tick::TickRecorder>\(rc\);/)
  assert.match(main, /spotFeed->setRawTap\(/)
  assert.match(main, /v\.get\("tickRecord"\)\.isBool\(\)/)
  assert.match(main, /server\.route\("GET", "\/tick-status"/)
  const feed = readFileSync(new URL('../../cpp-exec/src/spot_feed.cpp', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(feed, /if \(rawTap_\) \{[\s\S]*?rawTap_\(symbolId, rb\.isNumber\(\)/, 'the tap sees the raw sides')
})
