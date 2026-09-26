// node --test agent/routes/telegram-digest-route.test.js
//
// GET /state/telegram-digest (V3 STK-08v2) over HTTP: the digest's state —
// the setting, the unsent count, the oldest row, the queue reasons, the last
// flush and its error — read by the same function STK-08 judges by. It
// carries no message text and no credential, writes nothing, and an
// unreadable outbox is an explicit 500, never a body that reads as 0.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import { invalidateStateCache } from '../lib/state-cache.js'
import stateRouter from './state.js'

async function serve(t, db) {
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}/state/telegram-digest`
}

const snapshotOf = db => JSON.stringify({
  outbox: db.prepare('SELECT id, queued_at, reason, sent_at FROM telegram_outbox ORDER BY id').all(),
  state: db.prepare("SELECT key, value FROM agent_state WHERE key IN ('telegram_notify_json', 'tg_digest_last_flush_ms', 'tg_digest_last_error') ORDER BY key").all(),
})

test('GET /state/telegram-digest: notify OFF with 3 held rows — the setting, the count, the oldest and the reasons; no text, no credential, nothing written', async t => {
  invalidateStateCache()
  const db = initDB(':memory:')
  setState(db, 'telegram_notify_json', JSON.stringify({ enabled: false, mode: 'live', quiet: null, urgentBypass: true, tz: 'Asia/Singapore' }))
  setState(db, 'tg_digest_last_flush_ms', String(Date.parse('2026-08-22T10:00:00.000Z')))
  setState(db, 'tg_digest_last_error', '2026-08-22T11:00:00.000Z error: request to https://api.telegram.org/bot999:ZZtok_en/sendMessage failed')
  const ins = db.prepare(`INSERT INTO telegram_outbox (queued_at, kind, priority, text, reason) VALUES (?, 'alert', 'normal', ?, ?)`)
  ins.run('2026-08-22T10:39:26.800Z', 'PRIVATE ALERT TEXT one', 'notify_off')
  ins.run('2026-09-01T00:00:00.000Z', 'PRIVATE ALERT TEXT two', 'quiet_hours')
  ins.run('2026-09-25T23:00:00.000Z', 'PRIVATE ALERT TEXT three', 'notify_off')
  const before = snapshotOf(db)
  const url = await serve(t, db)
  const res = await fetch(url)
  assert.equal(res.status, 200)
  const raw = await res.text()
  const body = JSON.parse(raw)
  assert.equal(body.enabled, false)
  assert.equal(body.configKey, 'telegram_notify_json')
  assert.equal(body.configReadable, true)
  assert.equal(body.mode, 'live')
  assert.deepEqual(body.pending, { count: 3, oldestQueuedAt: '2026-08-22T10:39:26.800Z', oldestReason: 'notify_off' })
  assert.deepEqual(body.reasons.rows, [
    { reason: 'notify_off', count: 2, oldestQueuedAt: '2026-08-22T10:39:26.800Z' },
    { reason: 'quiet_hours', count: 1, oldestQueuedAt: '2026-09-01T00:00:00.000Z' },
  ])
  assert.deepEqual([body.reasons.over, body.reasons.of, body.reasons.complete], [3, 3, true])
  assert.equal(body.lastFlushAt, '2026-08-22T10:00:00.000Z')
  assert.match(body.lastError, /bot<redacted>\/sendMessage failed$/)
  assert.doesNotMatch(raw, /PRIVATE ALERT TEXT/, 'no message text')
  assert.doesNotMatch(raw, /ZZtok_en/, 'no credential')
  assert.equal(snapshotOf(db), before, 'a GET marks, deletes and rewrites nothing')
})

test('GET /state/telegram-digest: an unreadable outbox is a 500 naming the error, never a 0', async t => {
  invalidateStateCache()
  const db = initDB(':memory:')
  db.exec('DROP TABLE telegram_outbox')
  const url = await serve(t, db)
  const res = await fetch(url)
  assert.equal(res.status, 500)
  const body = await res.json()
  assert.equal(body.error, 'telegram_digest_unreadable')
  assert.match(body.detail, /no such table: telegram_outbox/)
  assert.equal(body.pending, undefined)
})
