// agent/services/position-capture.test.js — the close-triggered capture.
//
// The cases that matter are the ones where a plausible implementation would
// lose a position quietly: a close detected twice, a retry that resets its own
// attempt count, a capture that runs out of attempts and is deleted, and a
// verifier that is unreachable being read as "fine".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import {
  enqueueCapture, dueCaptures, drainCaptureQueue, captureQueueView,
  archiveRecord, archivePathFor, archiveDir, refreshDealsFor,
  CAPTURE_DELAY_MS, MAX_ATTEMPTS,
} from './position-capture.js'
import { verifyClient, verifyRequestFor, verifierStatus } from '../lib/verify-client.js'

const ACCT = '47790949'
const PID = '240505687'
const OPEN_MS = Date.parse('2026-09-15T08:00:00Z')
const CLOSE_MS = Date.parse('2026-09-15T12:00:00Z')
const fresh = () => initDB(':memory:')

function seedComplete(db) {
  const re = db.prepare(`INSERT INTO risk_events (symbol, side, approved, proposal_json) VALUES ('EURUSD','BUY',1,?)`)
    .run(JSON.stringify({ direction_reason: 'trend continuation' }))
  const t = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, volume, opened_at, closed_at,
                        closed_at_ms, hold_duration_ms, gross_pnl, net_pnl, status, close_reason, strategy,
                        ctrader_position_id, account_id, risk_event_id, origin, commission, swap, realised_rr)
    VALUES ('EURUSD','BUY',1.1,1.105,1.098,10000,?,?,?,?,50,48,'closed','take_profit','vwap_trend',?,?,?,'scan_dispatch',-1,-1,2.5)
  `).run(new Date(OPEN_MS).toISOString(), new Date(CLOSE_MS).toISOString(), CLOSE_MS, CLOSE_MS - OPEN_MS,
    PID, ACCT, re.lastInsertRowid)
  db.prepare(`
    INSERT INTO trade_plans (trade_id, account_id, symbol, side, strategy, planned_entry, planned_sl, risk_dist)
    VALUES (?, ?, 'EURUSD','BUY','vwap_trend',1.1,1.098,0.002)
  `).run(t.lastInsertRowid, ACCT)
  db.prepare(`
    INSERT INTO broker_deals (deal_id, position_id, account_id, symbol, side, lots, entry_price, close_price,
                              opened_at, closed_at, gross_pnl, swap, commission, net_pnl)
    VALUES ('d1', ?, ?, 'EURUSD','BUY',10000,1.1,1.105,?,?,50,-1,-1,48)
  `).run(PID, ACCT, new Date(OPEN_MS).toISOString(), new Date(CLOSE_MS).toISOString())
  return t.lastInsertRowid
}

test('a close is queued 30 seconds out, and is not due before then', () => {
  const db = fresh()
  const now = Date.now()
  enqueueCapture(db, { accountId: ACCT, positionId: PID, symbol: 'EURUSD', now })
  assert.equal(dueCaptures(db, { now: now + CAPTURE_DELAY_MS - 1 }).length, 0,
    'the broker needs the 30 s — building earlier would be refused by our own timing')
  assert.equal(dueCaptures(db, { now: now + CAPTURE_DELAY_MS }).length, 1)
})

test('the same close detected twice does not reset an in-flight capture', async () => {
  // The reconciler can report the same close on consecutive passes. If the
  // second enqueue overwrote the row, the attempt count would reset every
  // pass and a capture that can never complete would retry forever while
  // reading as "pending" — a queue that looks busy and never finishes.
  const db = fresh()
  const now = Date.now()
  enqueueCapture(db, { accountId: ACCT, positionId: PID, now })
  await drainCaptureQueue(db, { now: now + CAPTURE_DELAY_MS })   // fails: nothing seeded
  const after = db.prepare('SELECT attempts, due_at_ms FROM position_capture_queue').get()
  assert.equal(after.attempts, 1)

  enqueueCapture(db, { accountId: ACCT, positionId: PID, now: now + 60_000 })
  const again = db.prepare('SELECT attempts, due_at_ms FROM position_capture_queue').get()
  assert.equal(again.attempts, 1, 'the attempt count survives a re-detection')
  assert.equal(again.due_at_ms, after.due_at_ms, 'and so does the backoff')
})

test('a complete record is captured, archived to the volume, and the row settles', async () => {
  const db = fresh()
  seedComplete(db)
  const dir = mkdtempSync(join(tmpdir(), 'poshist-'))
  const env = { DB_PATH: join(dir, 'agent.db') }
  const now = Date.now()
  enqueueCapture(db, { accountId: ACCT, positionId: PID, now })

  const out = await drainCaptureQueue(db, { now: now + CAPTURE_DELAY_MS, env })
  assert.equal(out.captured, 1)
  assert.equal(out.archived, 1)
  assert.equal(db.prepare('SELECT state FROM position_capture_queue').get().state, 'captured')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM position_history').get().n, 1)

  const path = join(dir, 'position-history', '2026-09.jsonl')
  assert.ok(existsSync(path), 'the archive lands beside the database, on the volume')
  const line = JSON.parse(readFileSync(path, 'utf8').trim())
  assert.equal(line.ctrader_position_id, PID)
  assert.equal(line.net_pnl, 48)
})

test('an incomplete capture retries with a widening gap and is never lost', async () => {
  const db = fresh()
  const now = Date.now()
  enqueueCapture(db, { accountId: ACCT, positionId: PID, now })
  let prevDue = 0
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    const at = now + CAPTURE_DELAY_MS + i * 3600_000
    const out = await drainCaptureQueue(db, { now: at })
    assert.equal(out.incomplete, 1)
    assert.equal(out.gaveUp, 0, `attempt ${i} must not give up early`)
    const row = db.prepare('SELECT * FROM position_capture_queue').get()
    assert.equal(row.state, 'pending')
    assert.ok(row.due_at_ms > at, 'the next attempt is scheduled, not dropped')
    assert.ok(row.due_at_ms - at > prevDue, 'and the gap widens')
    prevDue = row.due_at_ms - at
    assert.ok(row.last_error, 'with the reason recorded')
  }
})

test('a capture that runs out of attempts is marked gave_up and KEPT, not deleted', async () => {
  // Deleting it would make the queue read permanently healthy. A closed
  // position this system could not describe is exactly what should be
  // countable.
  const db = fresh()
  const now = Date.now()
  enqueueCapture(db, { accountId: ACCT, positionId: PID, symbol: 'EURUSD', now })
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await drainCaptureQueue(db, { now: now + CAPTURE_DELAY_MS + i * 86_400_000 })
  }
  const row = db.prepare('SELECT * FROM position_capture_queue').get()
  assert.equal(row.state, 'gave_up')
  assert.equal(row.attempts, MAX_ATTEMPTS)
  assert.ok(row.last_error.includes('missing'), 'and says what was missing')

  const view = captureQueueView(db)
  assert.equal(view.gaveUp, 1)
  assert.equal(view.gaveUpRows[0].position_id, PID, 'named, not just counted')
})

test('a gave_up row is not retried on the next drain', async () => {
  const db = fresh()
  const now = Date.now()
  enqueueCapture(db, { accountId: ACCT, positionId: PID, now })
  for (let i = 0; i < MAX_ATTEMPTS; i++) await drainCaptureQueue(db, { now: now + CAPTURE_DELAY_MS + i * 86_400_000 })
  const out = await drainCaptureQueue(db, { now: now + 30 * 86_400_000 })
  assert.equal(out.due, 0, 'settled rows leave the working set')
})

test('the verifier is asked, and its answer is stored unchanged', async () => {
  const db = fresh()
  seedComplete(db)
  const env = { DB_PATH: join(mkdtempSync(join(tmpdir(), 'poshist-')), 'agent.db') }
  const now = Date.now()
  enqueueCapture(db, { accountId: ACCT, positionId: PID, now })

  const asked = []
  const verify = async (record) => {
    asked.push(record.ctrader_position_id)
    return { state: 'disputed', disputes: [{ field: 'entry_price', keeper: '1.1', broker: '1.10012' }], host: 'demo.ctrader.com' }
  }
  const out = await drainCaptureQueue(db, { now: now + CAPTURE_DELAY_MS, env, verify })
  assert.deepEqual(asked, [PID])
  assert.equal(out.verified, 0, 'a dispute is not a verification')
  const row = db.prepare('SELECT * FROM position_history').get()
  assert.equal(row.verification_state, 'disputed')
  assert.equal(row.verifier_host, 'demo.ctrader.com')
  assert.equal(JSON.parse(row.disputes_json)[0].field, 'entry_price')
})

// CONTRACT 3 (fix-the-exits BC): the record handed to the verifier carries
// the symbol's lotSize from the broker's declaration in the registry — and
// NOT the hardcoded contract table, which would scale the broker's own
// volume by a guess and call the result a verdict.
test('the drain sends the broker-declared lotSize with the record, and nothing from the table fallback', async () => {
  const { rememberLotSize } = await import('../lib/lot-size-registry.js')
  const { withBrokerLotSize } = await import('./position-capture.js')
  const db = fresh()
  seedComplete(db)
  // Nothing declared yet: the registry falls back to its table, which has a
  // unitsPerLot but NO lotSize (lot-size-registry.js) → no lot travels.
  const { unitsPerLot } = await import('../lib/lot-size-registry.js')
  assert.equal(unitsPerLot(db, 'EURUSD').source, 'table')
  assert.ok(unitsPerLot(db, 'EURUSD').unitsPerLot > 0, 'the table knows a contract size …')
  assert.equal(withBrokerLotSize(db, { symbol: 'EURUSD' }).lot_size, null, '… and it is not what travels')
  assert.equal(withBrokerLotSize(db, { symbol: null }).lot_size, null)
  rememberLotSize(db, 'EURUSD', 10000000)
  assert.equal(withBrokerLotSize(db, { symbol: 'EURUSD' }).lot_size, 10000000)

  const env = { DB_PATH: join(mkdtempSync(join(tmpdir(), 'poshist-')), 'agent.db') }
  const now = Date.now()
  enqueueCapture(db, { accountId: ACCT, positionId: PID, now })
  const seen = []
  await drainCaptureQueue(db, {
    now: now + CAPTURE_DELAY_MS, env,
    verify: async (record) => { seen.push(record); return { state: 'verified', disputes: [], contractVersion: 3 } },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].symbol, 'EURUSD')
  assert.equal(seen[0].lot_size, 10000000, 'the verifier is told the lot the keeper priced its lots with')
})

test('an unreachable verifier leaves the record unverified — it never becomes verified by default', async () => {
  // The whole point of the separate service. A `verified` produced here
  // because the verifier was down would be worse than no verification.
  const db = fresh()
  seedComplete(db)
  const env = { DB_PATH: join(mkdtempSync(join(tmpdir(), 'poshist-')), 'agent.db') }
  const now = Date.now()
  enqueueCapture(db, { accountId: ACCT, positionId: PID, now })
  const out = await drainCaptureQueue(db, {
    now: now + CAPTURE_DELAY_MS, env,
    verify: async () => { throw new Error('ECONNREFUSED') },
  })
  assert.equal(out.captured, 1, 'the record is still captured')
  assert.equal(out.verified, 0)
  assert.equal(db.prepare('SELECT verification_state FROM position_history').get().verification_state, 'unverified')
  assert.ok(out.errors.some(e => e.includes('ECONNREFUSED')), 'and the failure is reported, not swallowed')
})

test('with no verifier configured the capture still runs and says nothing false', async () => {
  const db = fresh()
  seedComplete(db)
  const env = { DB_PATH: join(mkdtempSync(join(tmpdir(), 'poshist-')), 'agent.db') }
  const now = Date.now()
  enqueueCapture(db, { accountId: ACCT, positionId: PID, now })
  const out = await drainCaptureQueue(db, { now: now + CAPTURE_DELAY_MS, env, verify: null })
  assert.equal(out.captured, 1)
  assert.equal(db.prepare('SELECT verification_state FROM position_history').get().verification_state, 'unverified')
  assert.equal(verifyClient({ env: {} }), null, 'no VERIFY_URL means no client, not a stub that says yes')
  assert.equal(verifierStatus({}).configured, false)
  assert.match(verifierStatus({}).reason, /VERIFY_URL/)
})

test('the deal pull asks for THIS position window, not a blanket range, and reports truncation', async () => {
  const db = fresh()
  seedComplete(db)
  const asked = []
  const getDeals = async (from, to) => { asked.push([from, to]); return { deal: [], hasMore: false } }
  await refreshDealsFor(db, { accountId: ACCT, positionId: PID, getDeals })
  assert.equal(asked.length, 1)
  assert.ok(asked[0][0] < OPEN_MS, 'the window opens before the position did')
  assert.ok(asked[0][1] > CLOSE_MS, 'and closes after it did')
  assert.ok(asked[0][1] - asked[0][0] < 24 * 3600_000, 'and is the position\'s life, not a blanket range')

  const stalling = async () => ({ deal: [{ dealId: 1, executionTimestamp: OPEN_MS }], hasMore: true })
  const t = await refreshDealsFor(db, { accountId: ACCT, positionId: PID, getDeals: stalling })
  assert.equal(t.complete, false)
  assert.ok(t.reason, 'an incomplete pull is named, never passed off as whole')
})

test('the archive path is derived from DB_PATH and is absent when the volume is not configured', () => {
  assert.equal(archiveDir({}), null, 'no DB_PATH means no archive, and the boot already warns about that')
  assert.equal(archiveDir({ DB_PATH: '/data/agent.db' }), '/data/position-history')
  assert.equal(
    archivePathFor({ closed_at_ms: Date.parse('2026-03-04T05:06:07Z') }, { DB_PATH: '/data/agent.db' }),
    '/data/position-history/2026-03.jsonl', 'one file per month')
  assert.equal(archiveRecord({ closed_at_ms: 1 }, { env: {} }).ok, false)
})

test('the verify request carries a window containing the whole position', () => {
  // cpp-verify answers `unverified — widen it` when the opening deal falls
  // outside the window. That would be OUR fault, not the broker's, so the
  // slack is on both ends.
  const body = verifyRequestFor({
    account_id: ACCT, ctrader_position_id: PID, direction: 'short', volume: 10000,
    entry_price: 1.1, exit_price: 1.09, net_pnl: 48, opened_at_ms: OPEN_MS, closed_at_ms: CLOSE_MS,
  }, { host: 'demo.ctrader.com' })
  assert.equal(body.host, 'demo.ctrader.com')
  assert.ok(body.fromMs < OPEN_MS && body.toMs > CLOSE_MS)
  assert.equal(body.record.tradeSide, 2, 'short is side 2')
  assert.equal(body.record.positionId, Number(PID))
})

test('the close path and the drain are WIRED into the loop', () => {
  // The call sites are invisible from this module; without them the queue
  // would sit empty forever and read as "no closes".
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.match(loop, /for \(const c of result\.closedDetected \|\| \[\]\) \{[\s\S]{0,200}enqueueCapture\(db, \{/,
    'every detected close must be enqueued')
  assert.match(loop, /drainCaptureQueue\(db, \{/, 'and the queue must be drained')
  assert.match(loop, /verifyClient\(\)/, 'with the verifier consulted when one is configured')
})
