// Codex · №12,834 · 2026-10-10; codex-footprint: report-query-bounds.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { tempDir } from '../test-support/temp-dir.js'
import { initDB, setState } from '../db.js'
import { CONFIG_KEY, digestState, DIGEST_STATE_SQL, DIGEST_REASON_ROWS_MAX } from './telegram-digest.js'
import { buildOrderLifecycle } from './order-lifecycle.js'
import { readOrderLifecycle } from './performance-populations.js'

const NOW = Date.parse('2026-10-10T01:00:00Z')
const INDEX = 'idx_tg_outbox_pending_report'
const options = account => ({ account, nowMs: NOW })
const reasonPlan = db => db.prepare(`EXPLAIN QUERY PLAN ${DIGEST_STATE_SQL.reasons}`).all(DIGEST_REASON_ROWS_MAX).map(r => r.detail).join('\n')

function assertCovered(db) {
  assert.match(reasonPlan(db), /USING COVERING INDEX idx_tg_outbox_pending_report \(sent_at=\?\)/)
  const tableRoot = db.prepare("SELECT rootpage FROM sqlite_schema WHERE type='table' AND name='telegram_outbox'").get().rootpage
  const code = db.prepare(`EXPLAIN ${DIGEST_STATE_SQL.reasons}`).all(DIGEST_REASON_ROWS_MAX)
  assert.equal(code.some(op => op.opcode === 'OpenRead' && op.p2 === tableRoot), false,
    'reason sampling must not open the message table; an indexed table lookup still reads payload pages')
}

function expectedReasons(input) {
  const groups = new Map()
  for (const row of input.filter(r => r.sent_at === null).sort((a, b) => b.id - a.id).slice(0, DIGEST_REASON_ROWS_MAX)) {
    const reason = row.reason ?? ''
    const group = groups.get(reason) ?? { reason, count: 0, oldestQueuedAt: row.queued_at }
    group.count++
    if (row.queued_at < group.oldestQueuedAt) group.oldestQueuedAt = row.queued_at
    groups.set(reason, group)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || Buffer.compare(Buffer.from(a.reason), Buffer.from(b.reason))).slice(0, 50)
}

test('digest migration covers metadata with old index statistics and preserves the complete report and readonly worker', async t => {
  const path = join(tempDir('digest-query-'), 'fixture.db')
  let db = initDB(path)
  t.after(() => { if (db.open) db.close() })
  assertCovered(db) // fresh database, not only the migration path below
  assert.deepEqual(digestState(db, options('all')).reasons, {
    rows: [], over: 0, of: 0, complete: true, window: 'newest pending rows first',
  })

  // Reproduce the old schema on this isolated file, including existing ANALYZE
  // statistics. The real initializer, not test DDL, must install the correction.
  db.exec(`DROP INDEX ${INDEX}`)
  setState(db, CONFIG_KEY, JSON.stringify({ enabled: false, mode: 'hourly' }))
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (?,?)').run('90001', 0)
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (?,?)').run('90002', 1)
  const input = [], reasons = [null, '', 'A', 'a', 'é', ...Array.from({ length: 65 }, (_, i) => `reason-${String(i).padStart(2, '0')}`)]
  const payload = 'fixture-private-message:'.padEnd(8192, 'x')
  const insert = db.prepare('INSERT INTO telegram_outbox(queued_at,text,reason,sent_at) VALUES (?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < 3300; i++) {
      const queued_at = new Date(NOW - 3 * 86400000 - i % 37 * 60000).toISOString()
      const sent_at = i % 3 === 0 ? new Date(NOW - 1000).toISOString() : null
      const reason = i < 300 ? 'outside-newest-window' : reasons[i % reasons.length]
      const id = Number(insert.run(queued_at, payload, reason, sent_at).lastInsertRowid)
      input.push({ id, queued_at, reason, sent_at })
    }
  })()
  db.exec('ANALYZE telegram_outbox')
  assert.ok(db.prepare("SELECT stat FROM sqlite_stat1 WHERE idx='idx_tg_outbox_pending'").get())
  assert.doesNotMatch(reasonPlan(db), /COVERING INDEX/)
  const tableRoot = db.prepare("SELECT rootpage FROM sqlite_schema WHERE type='table' AND name='telegram_outbox'").get().rootpage
  assert.ok(db.prepare(`EXPLAIN ${DIGEST_STATE_SQL.reasons}`).all(DIGEST_REASON_ROWS_MAX)
    .some(op => op.opcode === 'OpenRead' && op.p2 === tableRoot), 'the baseline reads message-table pages, whether via index lookup or reverse table scan')
  const before = digestState(db, options('all'))
  assert.deepEqual(before.reasons.rows, expectedReasons(input), 'all group values, counts and ordering match an independent population calculation')
  assert.equal(before.pending.count, 2200)
  assert.equal(before.pending.oldestQueuedAt, input[1].queued_at, 'oldest is selected by ID, not MIN time')
  assert.equal(before.reasons.over, 2000)
  assert.equal(before.reasons.rows.length, 50)
  assert.equal(before.reasons.complete, false)
  assert.equal(before.reasons.rows.some(r => r.reason === 'outside-newest-window'), false)
  assert.equal(JSON.stringify(before).includes('fixture-private-message'), false)
  const reports = new Map(['all', '90001', '90002'].map(account => [account, buildOrderLifecycle(db, options(account))]))

  db.close()
  db = initDB(path)
  assert.equal(db.prepare('SELECT stat FROM sqlite_stat1 WHERE idx=?').get(INDEX), undefined,
    'exercise an upgrade before any statistics exist for the new covering index')
  assert.ok(db.prepare("SELECT stat FROM sqlite_stat1 WHERE idx='idx_tg_outbox_pending'").get())
  assertCovered(db)
  assert.deepEqual(digestState(db, options('all')), before)
  for (const [account, expected] of reports) assert.deepEqual(buildOrderLifecycle(db, options(account)), expected)
  assert.equal(reports.get('all').stages.stuck.find(r => r.id === 'STK-08').classes.held_by_setting, 1)
  for (const account of ['90001', '90002'])
    assert.equal(reports.get(account).stages.stuck.find(r => r.id === 'STK-08').classes.held_by_setting, undefined,
      'a global outbox is not attributed to either account')

  const reader = new Database(path, { readonly: true, fileMustExist: true })
  try {
    assertCovered(reader)
    assert.deepEqual(await readOrderLifecycle(reader, options('all')), reports.get('all'),
      'the complete real readonly worker report is delivered with the unchanged deadline')
  } finally { reader.close() }

  // Completeness concerns the 2,000-row sample, independent of the 50-group
  // display cap. Exercise the exact boundary, an empty queue, and read failure.
  const sampled = input.filter(r => r.sent_at === null).slice(-DIGEST_REASON_ROWS_MAX)
  db.prepare('UPDATE telegram_outbox SET sent_at=? WHERE id<? AND sent_at IS NULL').run(new Date(NOW).toISOString(), sampled[0].id)
  const bounded = digestState(db, options('all'))
  assert.equal(bounded.pending.count, 2000)
  assert.equal(bounded.reasons.complete, true)
  assert.equal(bounded.reasons.rows.length, 50)
  assert.deepEqual(bounded.reasons.rows, before.reasons.rows)
  db.prepare('UPDATE telegram_outbox SET sent_at=? WHERE sent_at IS NULL').run(new Date(NOW).toISOString())
  const empty = digestState(db, options('all'))
  assert.deepEqual(empty.pending, { count: 0, oldestQueuedAt: null, oldestReason: null })
  assert.deepEqual(empty.reasons, { rows: [], over: 0, of: 0, complete: true, window: 'newest pending rows first' })
  db.exec('DROP TABLE telegram_outbox')
  assert.throws(() => digestState(db, options('all')), /no such table: telegram_outbox/)
})
