// log-watch.test.js — the in-process log matcher (owner order 01-09-2026).
//
// The rules table is iterated (log-inspector precedent): every rule must have
// a line that fires it and a near-miss that doesn't, or it's decoration
// (failure mode #3). The wiring pins exist because a matcher whose producer
// lines get reworded dies silently — the test couples both ends.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import {
  LOG_WATCH_DEFAULTS, loadLogWatch, installLogWatch, logWatchView, RULES,
} from './log-watch.js'

function freshDb() {
  return initDB(':memory:')
}

// One firing line + one near-miss per rule, keyed by rule. A rule added to
// RULES without a row here fails the iteration test by name.
const RULE_CASES = {
  earned_floor_admit: {
    fires: '[risk] earned_floor admit: vwap_trend EURUSD rr=2.50 W=40% over 12 closes e=0.4R riskScale=1',
    misses: '[risk] earned_floor denied: expectancy -0.01R',
  },
  controller_stalled: {
    fires: '[phase-audit] controller order_monitor: stalled — 1214s since last beat',
    misses: '[phase-audit] controller order_monitor: recovered',
  },
  sidecar_restart: {
    fires: '[heartbeat] sidecar_restart: cpp-exec — previous boot abc, new boot def',
    misses: '[heartbeat] sidecar cpp-exec beat ok',
  },
}

test('every rule in RULES has a case that fires it and a near-miss that does not', async () => {
  const db = freshDb()
  for (const rule of RULES) {
    const cases = RULE_CASES[rule.key]
    assert.ok(cases, `RULES entry '${rule.key}' has no RULE_CASES row — add one or the rule is untested decoration`)
    const fired = []
    const { scan } = installLogWatch(db, { notify: async (t) => { fired.push(t) } })
    scan(cases.fires, 'log')
    await new Promise((r) => setImmediate(r))
    assert.equal(fired.length, 1, `'${rule.key}' did not fire on its own case`)
    assert.ok(fired[0].includes(cases.fires.slice(0, 40)), `'${rule.key}' alert must carry the matched line`)
    scan(cases.misses, 'log')
    await new Promise((r) => setImmediate(r))
    assert.equal(fired.length, 1, `'${rule.key}' fired on its near-miss: ${cases.misses}`)
  }
})

test('cooldown: the same rule firing twice inside its window notifies once', async () => {
  const db = freshDb()
  let t = 1_000_000
  const fired = []
  const { scan } = installLogWatch(db, { notify: async (x) => { fired.push(x) }, now: () => t })
  const line = RULE_CASES.earned_floor_admit.fires
  scan(line, 'log')
  t += 60_000 // 1 min — inside the 60-min rule cooldown
  scan(line, 'log')
  await new Promise((r) => setImmediate(r))
  assert.equal(fired.length, 1)
  t += 61 * 60_000 // past the cooldown
  scan(line, 'log')
  await new Promise((r) => setImmediate(r))
  assert.equal(fired.length, 2)
})

test('error burst: fires at the threshold, not below, and respects config', async () => {
  const db = freshDb()
  setState(db, 'log_watch_json', JSON.stringify({ errorBurstN: 3, errorBurstWindowMin: 5 }))
  let t = 1_000_000
  const fired = []
  const { scan } = installLogWatch(db, { notify: async (x) => { fired.push(x) }, now: () => t })
  scan('boom one', 'error')
  scan('boom two', 'error')
  await new Promise((r) => setImmediate(r))
  assert.equal(fired.length, 0, 'below threshold must stay silent')
  scan('boom three', 'error')
  await new Promise((r) => setImmediate(r))
  assert.equal(fired.length, 1)
  assert.match(fired[0], /3 error-level log lines/)
  // Outside the window the count resets: two more errors 10 min later stay quiet.
  t += 10 * 60_000
  scan('later one', 'error')
  scan('later two', 'error')
  await new Promise((r) => setImmediate(r))
  assert.equal(fired.length, 1)
})

test('config off silences every rule; loadLogWatch clamps junk to defaults', async () => {
  const db = freshDb()
  setState(db, 'log_watch_json', JSON.stringify({ on: false }))
  const fired = []
  const { scan } = installLogWatch(db, { notify: async (x) => { fired.push(x) } })
  scan(RULE_CASES.earned_floor_admit.fires, 'log')
  for (let i = 0; i < 20; i++) scan('err', 'error')
  await new Promise((r) => setImmediate(r))
  assert.equal(fired.length, 0)

  setState(db, 'log_watch_json', '{"errorBurstN": "garbage", "cooldownMin": -5}')
  const cfg = loadLogWatch(db)
  assert.equal(cfg.errorBurstN, LOG_WATCH_DEFAULTS.errorBurstN)
  assert.equal(cfg.cooldownMin, 1) // clamped to floor, not default — a stated number stands
})

test('re-entrancy: a notify that logs through the wrap cannot re-trigger itself', async () => {
  const db = freshDb()
  let calls = 0
  const handle = installLogWatch(db, {
    notify: async () => {
      calls++
      // Simulate the alert path logging a matching line synchronously.
      handle.scan(RULE_CASES.controller_stalled.fires, 'log')
    },
  })
  handle.scan(RULE_CASES.controller_stalled.fires, 'log')
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 1)
})

test('scan never throws, even on a rule or notify that does', async () => {
  const db = freshDb()
  const { scan } = installLogWatch(db, { notify: async () => { throw new Error('telegram down') } })
  assert.doesNotThrow(() => scan(RULE_CASES.sidecar_restart.fires, 'log'))
  await new Promise((r) => setImmediate(r))
})

test('console wrap: emits through the original and scans; uninstall restores', async () => {
  const db = freshDb()
  const fired = []
  const handle = installLogWatch(db, { notify: async (x) => { fired.push(x) } })
  try {
    assert.equal(console.__logWatchInstalled, true)
    console.log('[heartbeat] sidecar_restart:', 'cpp-acct — previous boot x, new boot y')
    await new Promise((r) => setImmediate(r))
    assert.equal(fired.length, 1, 'multi-arg console.log must be joined and scanned as one line')
  } finally {
    handle.uninstall()
  }
  assert.notEqual(console.__logWatchInstalled, true)
})

test('logWatchView reports installed state, rules and fired history', async () => {
  const db = freshDb()
  const handle = installLogWatch(db, { notify: async () => {} })
  try {
    handle.scan(RULE_CASES.earned_floor_admit.fires, 'log')
    const view = logWatchView(db)
    assert.equal(view.installed, true)
    assert.ok(view.rules.includes('error_burst'))
    for (const r of RULES) assert.ok(view.rules.includes(r.key))
    assert.ok(view.fired.earned_floor_admit, 'a fired rule must be visible — "has this input ever arrived" is readable')
  } finally {
    handle.uninstall()
  }
})

// Wiring pins — the matcher and its producers live in different files; a
// reword on either side must fail HERE, not die silently in production.
test('wiring: producers emit the exact prefixes the rules match', () => {
  const risk = readFileSync(new URL('./risk.js', import.meta.url), 'utf8')
  assert.ok(risk.includes('[risk] earned_floor admit:'), 'risk.js must log the admit line log-watch matches')
  const hb = readFileSync(new URL('./heartbeat.js', import.meta.url), 'utf8')
  assert.ok(hb.includes('[heartbeat] sidecar_restart:'), 'heartbeat.js must log the restart line log-watch matches')
  const pa = readFileSync(new URL('./phase-audit.js', import.meta.url), 'utf8')
  assert.match(pa, /\[phase-audit\] controller \$\{controller\}: \$\{event\}/, 'phase-audit controller line must keep its shape')
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(idx.includes('installLogWatch'), 'index.js must install the watch — a matcher nobody installs is dead (failure mode #4)')
})
