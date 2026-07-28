// strategy-liveness — the check that would have caught Cup & Handle.
//
// The scenario being reproduced throughout: a strategy is ARMED, the scanner is
// busy, and that strategy produces nothing. Before this module, that was
// indistinguishable from a quiet market. The tests below are written around
// that distinction, because getting it wrong in either direction makes the
// report worthless — false alarms train you to ignore it, and a missed silence
// is the original bug.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initDB, setState } from '../db.js'
import { strategyLiveness, silentStrategies, MIN_SCANS_FOR_VERDICT } from './strategy-liveness.js'

const tmpDb = () => initDB(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-')), 'agent.db'))

const nowMs = Date.parse('2026-07-28T12:00:00.000Z')
const isoAgo = (hours) => new Date(nowMs - hours * 3600_000).toISOString()
// The OTHER timestamp shape this DB stores — datetime('now') writes a space,
// not a 'T'. Mixing both is deliberate here; see the normalisation test.
const sqlAgo = (hours) => isoAgo(hours).replace('T', ' ').slice(0, 19)

function seedScans(db, strategy, n, atFn = isoAgo) {
  const ins = db.prepare('INSERT INTO scans (symbol, strategy, scanned_at) VALUES (?,?,?)')
  db.transaction(() => { for (let i = 0; i < n; i++) ins.run(`SYM${i % 7}`, strategy, atFn(1 + (i % 20))) })()
}

function seedTrade(db, strategy, { status = 'open', hoursAgo = 2 } = {}) {
  db.prepare(`INSERT INTO trades (symbol, side, status, strategy, label_strategy, opened_at, closed_at, net_pnl)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run('EURUSD', 'buy', status, strategy, strategy, isoAgo(hoursAgo),
      status === 'closed' ? isoAgo(hoursAgo - 1) : null, status === 'closed' ? 10 : null)
}

test('an armed strategy producing nothing, while others scan, reads as SILENT', () => {
  const db = tmpDb()
  setState(db, 'enabled_strategies_json', JSON.stringify(['cup_handle', 'ema_pullback']))
  // ema_pullback is busy; cup_handle produces nothing. This is the exact
  // production shape that went unnoticed.
  seedScans(db, 'ema_pullback', MIN_SCANS_FOR_VERDICT + 10)

  const { strategies } = strategyLiveness(db, { nowMs })
  const cup = strategies.find(s => s.key === 'cup_handle')

  assert.equal(cup.armed, true)
  assert.equal(cup.signals, 0)
  assert.equal(cup.verdict, 'silent')
  // And it must sort to the top — the finding should not need hunting for.
  assert.equal(strategies[0].key, 'cup_handle')
})

test('silence is NOT reported before enough scanning has happened', () => {
  const db = tmpDb()
  setState(db, 'enabled_strategies_json', JSON.stringify(['cup_handle', 'ema_pullback']))
  seedScans(db, 'ema_pullback', 3) // fresh container, barely any activity

  const { verdictable, strategies } = strategyLiveness(db, { nowMs })
  assert.equal(verdictable, false)
  assert.equal(strategies.find(s => s.key === 'cup_handle').verdict, 'unknown')
  assert.deepEqual(silentStrategies(db, { nowMs }), [], 'a fresh deploy must not alarm on every strategy')
})

test('an unarmed strategy producing nothing is not a finding', () => {
  const db = tmpDb()
  setState(db, 'enabled_strategies_json', JSON.stringify(['ema_pullback']))
  seedScans(db, 'ema_pullback', MIN_SCANS_FOR_VERDICT + 5)

  const cup = strategyLiveness(db, { nowMs }).strategies.find(s => s.key === 'cup_handle')
  assert.equal(cup.armed, false)
  assert.equal(cup.verdict, 'idle_unarmed')
  assert.ok(!silentStrategies(db, { nowMs }).some(s => s.key === 'cup_handle'))
})

test('signalling but never trading is its own verdict, distinct from silence', () => {
  const db = tmpDb()
  setState(db, 'enabled_strategies_json', JSON.stringify(['vp_value']))
  seedScans(db, 'vp_value', MIN_SCANS_FOR_VERDICT + 5)
  // signals exist, no trade opened

  const vp = strategyLiveness(db, { nowMs }).strategies.find(s => s.key === 'vp_value')
  assert.equal(vp.verdict, 'signalling_not_trading')
  assert.match(vp.note, /gates/)
})

test('a strategy that opened a position reads as TRADING', () => {
  const db = tmpDb()
  setState(db, 'enabled_strategies_json', JSON.stringify(['rsi2_reversion']))
  seedScans(db, 'rsi2_reversion', MIN_SCANS_FOR_VERDICT + 5)
  seedTrade(db, 'rsi2_reversion', { status: 'closed', hoursAgo: 3 })

  const s = strategyLiveness(db, { nowMs }).strategies.find(x => x.key === 'rsi2_reversion')
  assert.equal(s.verdict, 'trading')
  assert.equal(s.opened, 1)
  assert.equal(s.closed, 1)
  assert.ok(s.lastTradeAt)
})

test('space-form and T-form timestamps both count — a mismatch would fake a dead strategy', () => {
  const db = tmpDb()
  setState(db, 'enabled_strategies_json', JSON.stringify(['ema_pullback']))
  // datetime('now') writes "YYYY-MM-DD HH:MM:SS"; the cutoff is ISO with a T.
  // Comparing them raw matches nothing, which would report a perfectly healthy
  // strategy as silent — the exact false alarm that makes a report untrusted.
  seedScans(db, 'ema_pullback', MIN_SCANS_FOR_VERDICT + 5, sqlAgo)

  const s = strategyLiveness(db, { nowMs }).strategies.find(x => x.key === 'ema_pullback')
  assert.ok(s.signals >= MIN_SCANS_FOR_VERDICT, `space-form timestamps were dropped: ${s.signals}`)
  assert.notEqual(s.verdict, 'silent')
})

test('the window excludes older activity', () => {
  const db = tmpDb()
  setState(db, 'enabled_strategies_json', JSON.stringify(['ema_pullback', 'vp_value']))
  seedScans(db, 'ema_pullback', MIN_SCANS_FOR_VERDICT + 5)
  // vp_value was busy 30 days ago and silent since.
  seedScans(db, 'vp_value', 40, (h) => new Date(nowMs - (30 * 24 + h) * 3600_000).toISOString())

  const s = strategyLiveness(db, { nowMs, windowDays: 7 }).strategies.find(x => x.key === 'vp_value')
  assert.equal(s.signals, 0)
  assert.equal(s.verdict, 'silent')
})

test('decision counts and veto counts are reported per strategy', () => {
  const db = tmpDb()
  setState(db, 'enabled_strategies_json', JSON.stringify(['vp_value']))
  seedScans(db, 'vp_value', MIN_SCANS_FOR_VERDICT + 5)
  const ins = db.prepare('INSERT INTO decision_log (symbol, strategy, stage, decision, reason, created_at) VALUES (?,?,?,?,?,?)')
  ins.run('EURUSD', 'vp_value', 'risk_gate', 'veto', 'bad_rr', isoAgo(2))
  ins.run('EURUSD', 'vp_value', 'dispatch', 'skip', 'duplicate_symbol', isoAgo(2))
  ins.run('EURUSD', 'vp_value', 'dispatch', 'proceed', null, isoAgo(2))

  const s = strategyLiveness(db, { nowMs }).strategies.find(x => x.key === 'vp_value')
  assert.equal(s.decisions, 3)
  assert.equal(s.vetoes, 2, 'skip and veto both count as stopped; proceed does not')
})

test('every registry strategy appears exactly once', () => {
  const db = tmpDb()
  seedScans(db, 'ema_pullback', MIN_SCANS_FOR_VERDICT + 1)
  const { strategies } = strategyLiveness(db, { nowMs })
  const keys = strategies.map(s => s.key)
  assert.equal(new Set(keys).size, keys.length, 'no duplicates')
  assert.ok(keys.includes('cup_handle') && keys.includes('inv_cup_handle'))
})
