// agent/services/tick-recorder-pull.test.js — P3a: the keeper's side of the
// tick recorder. The probe pulls GET /tick-status into <side>_tick_json and
// logs a line on every STATE change (and every 30 min while recording), so
// the recorder's growth and the mount's free bytes are on record without a
// bearer token; the wiring that a refactor could drop in silence is pinned.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { initDB, getState } from '../db.js'
import { pullTickStatus, tickRate24h, TICK_STATUS_LOG_EVERY_MS } from './heartbeat.js'

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
  assert.match(sync, /if \(mode !== 'OFF'\) out\.tickRecord = true/, 'any RECORD or SHADOW account switches recording on')
  assert.match(sync, /if \(mode === 'SHADOW'\) out\.tickShadow = true/, 'SHADOW switches the strategy shadow on')
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

test('P3b: hourly samples measure the 24 h rate from counter deltas, surviving a sidecar restart', async () => {
  const db = initDB(':memory:')
  const orig = console.log
  console.log = () => {}
  try {
    const side = { name: 'cpp_exec_demo' }
    const t0 = Date.parse('2026-09-11T00:00:00Z')
    const at = (h, total, bytes) => ({ sidecarTickStatus: async () => status({ events: { total, changed: total, dropped: 0, gaps: 0 }, segments: { sealed: 0, sealedBytes: 0, openBytes: 0, bytesWritten: bytes } }) })
    await pullTickStatus(db, at(0, 0, 0), side, t0)
    await pullTickStatus(db, at(0, 500, 20000), side, t0 + 60_000) // same hour: ignored (one row per hour)
    assert.equal(tickRate24h(db, 'cpp_exec_demo', t0 + 60_000).eventsPerSec, null, 'one sample is not a rate')
    await pullTickStatus(db, at(1, 36000, 1440000), side, t0 + 3_600_000)   // 36,000 events in the hour = 10/s
    await pullTickStatus(db, at(2, 100, 4000), side, t0 + 7_200_000)        // restart: counters reset → delta clamped to 0
    await pullTickStatus(db, at(3, 36100, 1444000), side, t0 + 10_800_000)  // 36,000 more = 10/s
    const r = tickRate24h(db, 'cpp_exec_demo', t0 + 10_800_000)
    assert.equal(r.samples, 4); assert.equal(r.spanHours, 3)
    assert.equal(r.eventsPerSec, +(72000 / 10800).toFixed(3))
    assert.equal(r.bytesPerDay, Math.round(2880000 / 10800 * 86400))
    assert.ok(r.spoolHoursAt2GiB > 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tick_status_samples').get().n, 4)
  } finally {
    console.log = orig
  }
})

// GW-CAP (owner, 25-09-2026 22:03 SGT): the spool cap and the reserve are
// read from the sidecar's environment now, so the keeper's view must carry
// the cap the side REPORTS — the retention projection and the log line — and
// never keep presenting 2 GiB as if it were still the retention.
test('GW-CAP: the log line names the cap the sidecar reports, and says nothing about one it did not send', async () => {
  const db = initDB(':memory:')
  const lines = []
  const orig = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try {
    const t0 = Date.parse('2026-09-26T00:00:00Z')
    const withCap = { sidecarTickStatus: async () => status({ segments: { sealed: 2, sealedBytes: 134217728, openBytes: 4096, spoolCapBytes: 20 * 1024 ** 3 } }) }
    await pullTickStatus(db, withCap, { name: 'cpp_exec_demo' }, t0)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /\+ 0\.00 GB open under a 21\.47 GB cap, mount 45\.00 GB free of 50\.00 GB \(10% used, reserve 10\.00 GB\)/)
    // An older sidecar that reports no cap: the line is exactly what it was.
    await pullTickStatus(db, { sidecarTickStatus: async () => status() }, { name: 'cpp_exec' }, t0)
    assert.equal(lines.length, 2)
    assert.match(lines[1], /\+ 0\.00 GB open, mount 45\.00 GB free of 50\.00 GB \(10% used, reserve 10\.00 GB\)/)
    assert.doesNotMatch(lines[1], / cap/)
  } finally {
    console.log = orig
  }
})

test('GW-CAP: the 24 h rate projects retention against the REPORTED cap; no cap reported is null, never 2 GiB assumed', async () => {
  const db = initDB(':memory:')
  const orig = console.log
  console.log = () => {}
  try {
    const side = { name: 'cpp_exec_demo' }
    const t0 = Date.parse('2026-09-26T00:00:00Z')
    const at = (total, bytes) => ({ sidecarTickStatus: async () => status({ events: { total, changed: total, dropped: 0, gaps: 0 }, segments: { sealed: 0, sealedBytes: 0, openBytes: 0, bytesWritten: bytes } }) })
    await pullTickStatus(db, at(0, 0), side, t0)
    const cap = 20 * 1024 ** 3
    // One sample is not a rate: the cap is echoed, the projection is null.
    const one = tickRate24h(db, 'cpp_exec_demo', t0 + 60_000, cap)
    assert.equal(one.spoolCapBytes, cap); assert.equal(one.spoolHoursAtCap, null); assert.equal(one.spoolHoursAt2GiB, null)
    await pullTickStatus(db, at(36000, 1440000), side, t0 + 3_600_000)
    await pullTickStatus(db, at(72000, 2880000), side, t0 + 7_200_000)
    // 2,880,000 B over 2 h = 34,560,000 B/day.
    const r = tickRate24h(db, 'cpp_exec_demo', t0 + 7_200_000, cap)
    assert.equal(r.bytesPerDay, 34_560_000)
    assert.equal(r.spoolCapBytes, cap)
    assert.equal(r.spoolHoursAtCap, +(cap / 34_560_000 * 24).toFixed(1))
    assert.equal(r.spoolHoursAt2GiB, +((2 * 1024 ** 3) / 34_560_000 * 24).toFixed(1), 'the old field is unchanged')
    assert.ok(r.spoolHoursAtCap > 9.9 * r.spoolHoursAt2GiB, 'ten times the cap, ten times the hours')
    // No cap reported (an older sidecar), or nonsense: null, never a guess.
    for (const bad of [undefined, null, 0, -5, 'lots']) {
      const n = tickRate24h(db, 'cpp_exec_demo', t0 + 7_200_000, bad)
      assert.equal(n.spoolCapBytes, null, String(bad)); assert.equal(n.spoolHoursAtCap, null, String(bad))
      assert.equal(n.spoolHoursAt2GiB, r.spoolHoursAt2GiB)
    }
  } finally {
    console.log = orig
  }
})

test('GW-CAP wiring pins: the sidecar reads the three variables and applies them BEFORE the recorder is built; /health carries the limits; the route passes the reported cap', () => {
  // main.cpp has no injection point, so its wiring is pinned from source —
  // comments stripped first, so a sentence cannot satisfy an assertion.
  const main = readFileSync(new URL('../../cpp-exec/src/main.cpp', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  for (const v of ['TICK_SPOOL_CAP_BYTES', 'TICK_SPOOL_RESERVE_MIN_BYTES', 'TICK_SPOOL_RESERVE_PCT']) {
    assert.match(main, new RegExp(`envOr\\("${v}", ""\\)`), v)
  }
  assert.match(main, /if \(!tickSpoolPath\.empty\(\)\) \{[\s\S]*?for \(const std::string& line : tick::applySpoolLimits\(rc, limitText\)\) logError\([\s\S]*?tickRecorder = std::make_unique<tick::TickRecorder>\(rc\);/,
    'applied to rc, refusals logged, and only then is the recorder constructed from rc')
  assert.match(main, /tick::spoolFitProblems\(rc, totalBytes, availBytes,/, 'the boot line judges the cap against the mount')
  assert.match(main, /if \(auto lj = jsn::parse\(tickRecorder->limitsJson\(ts, false\)\)\) tj\.set\("limits", \*lj\);/, '/health carries the limits without the typed text')
  const state = strip(readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8'))
  assert.match(state, /rate24h: tickRate24h\(db, name, Date\.now\(\), rec\.status\?\.segments\?\.spoolCapBytes \?\? null\)/)
})
