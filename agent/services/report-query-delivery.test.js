// Codex · №12,834 · 2026-10-10; codex-footprint: report-query-bounds.
// Actual controller -> file-backed read worker -> snapshot -> heartbeat.
// No injected report result, timer, broker transport or production request.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { initDB, getState, setState } from '../db.js'
import { tempDir } from '../test-support/temp-dir.js'
import { runOrderLifecyclePass } from './order-lifecycle-ticker.js'
import { SNAPSHOT_KEY, RULES } from './order-lifecycle.js'
import { CONFIG_KEY, digestState } from './telegram-digest.js'

test('report query correction delivers and persists an actual worker report, retaining the last snapshot on storage failure and recovering after reopen', async t => {
  const path = join(tempDir('report-query-delivery-'), 'report.db')
  const handles = []
  const open = () => { const db = initDB(path); handles.push(db); return db }
  t.after(() => { for (const db of handles) if (db.open) db.close() })
  let db = open()
  assert.equal(db.memory, false, 'the production reader must use a real worker')
  const at = new Date(Date.now() - 60_000).toISOString()
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString()
  setState(db, CONFIG_KEY, JSON.stringify({ enabled: false }))
  db.prepare('INSERT INTO accounts (account_id) VALUES (?)').run('fixture-account')
  const score = db.prepare(`INSERT INTO refusal_scores
    (opportunity_key, account_id, symbol, outcome, scored_at, reason)
    VALUES (?, ?, 'SYNTHETIC', ?, ?, ?)`)
  const message = db.prepare('INSERT INTO telegram_outbox (queued_at, text, reason, sent_at) VALUES (?, ?, ?, ?)')
  db.transaction(() => {
    for (let i = 0; i < 500; i++) score.run(`refusal-${i}`, i % 3 ? 'fixture-account' : null,
      i % 2 ? 'target' : 'no_bars', at, 'synthetic payload '.repeat(40))
    for (let i = 0; i < 2107; i++) message.run(old, 'synthetic message '.repeat(40),
      i % 7 ? `reason-${i % 64}` : null, i % 31 === 0 ? at : null)
  })()
  const rowsBefore = {
    scores: db.prepare('SELECT * FROM refusal_scores ORDER BY rowid').all(),
    outbox: db.prepare('SELECT * FROM telegram_outbox ORDER BY id').all(),
  }
  const expectedDigest = digestState(db, { nowMs: Date.parse(at) })
  // Exercise an existing database gaining the additive index, not only a
  // freshly created schema. Retained report inputs must remain byte-identical.
  db.exec('DROP INDEX idx_tg_outbox_pending_report')
  db.close()
  db = open()
  assert.deepEqual(db.prepare('SELECT * FROM refusal_scores ORDER BY rowid').all(), rowsBefore.scores)
  assert.deepEqual(db.prepare('SELECT * FROM telegram_outbox ORDER BY id').all(), rowsBefore.outbox)
  assert.deepEqual(digestState(db, { nowMs: Date.parse(at) }), expectedDigest)

  const result = await runOrderLifecyclePass(db)
  assert.equal(result.ok, true, result.error)
  const stored = getState(db, SNAPSHOT_KEY)
  const snapshot = JSON.parse(stored)
  assert.equal(snapshot.rules.length, RULES.length, 'all rules reached the delivered snapshot')
  const refusal = snapshot.rules.find(r => r.id === 'PRE-02')
  assert.equal(refusal.population, 500)
  assert.equal(refusal.violations, 250)
  assert.equal(refusal.truncated, false)
  const outbox = snapshot.rules.find(r => r.id === 'STK-08')
  assert.equal(outbox.measurable, true)
  assert.equal(outbox.violations, 0, 'muted outbox remains held by setting')
  assert.equal(outbox.classes.held_by_setting, 1, 'the compact snapshot retains the actual classification')
  let beat = db.prepare("SELECT * FROM controller_heartbeats WHERE name = 'order_lifecycle'").get()
  assert.equal(beat.consecutive_failures, 0)
  assert.equal(beat.runs, 1)

  // A separate parent handle cannot reuse the first worker's still-settling
  // promise. A failed durable snapshot must never be announced as delivered.
  db = open()
  db.exec(`CREATE TRIGGER fail_report_snapshot BEFORE INSERT ON agent_state
    WHEN NEW.key = 'order_lifecycle_last_json'
    BEGIN SELECT RAISE(ABORT, 'fixture_snapshot_storage_failure'); END`)
  const failed = await runOrderLifecyclePass(db)
  assert.equal(failed.ok, false)
  assert.match(failed.error, /fixture_snapshot_storage_failure/)
  assert.equal(getState(db, SNAPSHOT_KEY), stored, 'failed storage preserves exact previous snapshot')
  beat = db.prepare("SELECT * FROM controller_heartbeats WHERE name = 'order_lifecycle'").get()
  assert.equal(beat.consecutive_failures, 1)
  assert.equal(beat.runs, 2)
  db.exec('DROP TRIGGER fail_report_snapshot')
  db.close()

  db = open()
  const recovered = await runOrderLifecyclePass(db)
  assert.equal(recovered.ok, true, recovered.error)
  assert.equal(JSON.parse(getState(db, SNAPSHOT_KEY)).rules.length, RULES.length)
  beat = db.prepare("SELECT * FROM controller_heartbeats WHERE name = 'order_lifecycle'").get()
  assert.equal(beat.consecutive_failures, 0)
  assert.equal(beat.runs, 3)
  assert.deepEqual(db.prepare('SELECT * FROM refusal_scores ORDER BY rowid').all(), rowsBefore.scores)
  assert.deepEqual(db.prepare('SELECT * FROM telegram_outbox ORDER BY id').all(), rowsBefore.outbox)
})
