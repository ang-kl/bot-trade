// node --test agent/services/close-completeness.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { findIncompleteCloses, runCloseCompletenessSweep } from './close-completeness.js'

const HOUR_MS = 3_600_000
const NOW = Date.parse('2026-07-22T12:00:00Z')

function insertTrade(db, { symbol = 'EURUSD', side = 'BUY', netPnl = null, closedAtMs = null } = {}) {
  const { lastInsertRowid: id } = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, opened_at, status, closed_at, closed_at_ms, net_pnl)
    VALUES (?, ?, 1.1, datetime('now'), 'closed', datetime('now'), ?, ?)
  `).run(symbol, side, closedAtMs, netPnl)
  return id
}

function insertPostmortem(db, tradeId) {
  db.prepare(`INSERT INTO trade_postmortems (trade_id, symbol) VALUES (?, 'EURUSD')`).run(tradeId)
}

test('flags a closed trade past the window with no net_pnl and no postmortem', () => {
  const db = initDB(':memory:')
  const id = insertTrade(db, { closedAtMs: NOW - 72 * HOUR_MS })
  const stuck = findIncompleteCloses(db, { now: NOW })
  assert.equal(stuck.length, 1)
  assert.equal(stuck[0].id, id)
  assert.equal(stuck[0].missingPnl, true)
  assert.equal(stuck[0].missingPostmortem, true)
  assert.equal(stuck[0].ageHours, 72)
})

test('still flagged if only ONE of net_pnl/postmortem is missing — both must be complete to clear', () => {
  const db = initDB(':memory:')
  const pnlOnly = insertTrade(db, { closedAtMs: NOW - 72 * HOUR_MS, netPnl: 12.5 }) // pnl backfilled, no postmortem yet
  const pmOnly = insertTrade(db, { closedAtMs: NOW - 72 * HOUR_MS }) // postmortem exists, pnl still null
  insertPostmortem(db, pmOnly)
  const stuck = findIncompleteCloses(db, { now: NOW })
  const ids = stuck.map(s => s.id).sort()
  assert.deepEqual(ids, [pnlOnly, pmOnly].sort())
  assert.equal(stuck.find(s => s.id === pnlOnly).missingPostmortem, true)
  assert.equal(stuck.find(s => s.id === pmOnly).missingPnl, true)
})

test('cleared once BOTH net_pnl and a postmortem exist', () => {
  const db = initDB(':memory:')
  const id = insertTrade(db, { closedAtMs: NOW - 72 * HOUR_MS, netPnl: 12.5 })
  insertPostmortem(db, id)
  assert.equal(findIncompleteCloses(db, { now: NOW }).length, 0)
})

test('inside the window is never flagged — mirrors loss-postmortem.js\'s own 24h staleness cutoff', () => {
  const db = initDB(':memory:')
  insertTrade(db, { closedAtMs: NOW - 10 * HOUR_MS }) // fresh — loss-postmortem would still be waiting for bars
  insertTrade(db, { closedAtMs: NOW - 47 * HOUR_MS })
  assert.equal(findIncompleteCloses(db, { now: NOW, windowHours: 48 }).length, 0)
})

test('a row with no closed_at_ms at all (pre-migration history) is never flagged', () => {
  const db = initDB(':memory:')
  insertTrade(db, { closedAtMs: null })
  assert.equal(findIncompleteCloses(db, { now: NOW }).length, 0)
})

test('runCloseCompletenessSweep: no-op without TELEGRAM_BOT_TOKEN, still reports the count', async () => {
  const db = initDB(':memory:')
  insertTrade(db, { closedAtMs: NOW - 72 * HOUR_MS })
  delete process.env.TELEGRAM_BOT_TOKEN
  const res = await runCloseCompletenessSweep(db, { now: NOW })
  assert.equal(res.flagged, 1)
})
