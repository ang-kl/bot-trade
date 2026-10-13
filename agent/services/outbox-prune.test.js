import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { runHousekeepingSteps } from './housekeeping-run.js'

const fixedNow = Date.parse('2026-10-06T12:28:00Z')
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedNow])) }
  static now() { return fixedNow }
}
const cutoff = new Clock(fixedNow - 14 * 86_400_000).toISOString()
const moduleUrl = new URL('./outbox-prune.js', import.meta.url)
const pruner = existsSync(moduleUrl) ? await import(moduleUrl) : null

// Run the actual loop step with its database and clock boundaries supplied.
// Importing the whole trading loop would run unrelated broker/controller code.
function actualStep(db, { date = Clock, activity = { at: date.now() } } = {}) {
  const sourceUrl = process.env.OUTBOX_PRUNE_LOOP_SOURCE || new URL('../loop.js', import.meta.url)
  const source = readFileSync(sourceUrl, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const match = source.match(/name: 'prune-outbox',\s*run: ([\s\S]*?)\n\s*},/)
  assert.ok(match, 'the isolated housekeeping list must contain the outbox step')
  const expression = match[1].trim().replace(/,$/, '')
    .replace(/import\('\.\/services\/outbox-prune\.js'\)/g, 'loadPruner()')
  return new Function('db', 'Date', 'loadPruner', 'activity', `
    let lastLoopActivityAt = activity.at;
    Object.defineProperty(activity, 'at', { get: () => lastLoopActivityAt });
    return (${expression});
  `)(db, date, () => Promise.resolve(pruner), activity)
}

function freshDB() {
  const db = new Database(':memory:')
  // Claude · № 13,878 13-Oct: the production table has `reason` (db.js
  // telegram_outbox), which the prune now reads for notify_off rows.
  db.exec('CREATE TABLE telegram_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, queued_at TEXT, sent_at TEXT, reason TEXT); CREATE INDEX idx_tg_outbox_pending ON telegram_outbox(sent_at, id)')
  return db
}
const old = '2026-08-01T00:00:00.000Z'
const recent = '2026-10-05T00:00:00.000Z'
function add(db, queuedAt, sentAt, n = 1, reason = null) {
  const stmt = db.prepare('INSERT INTO telegram_outbox (queued_at, sent_at, reason) VALUES (?, ?, ?)')
  db.transaction(() => { for (let i = 0; i < n; i++) stmt.run(queuedAt, sentAt, reason) })()
}
const expired = db => db.prepare('SELECT count(*) n FROM telegram_outbox WHERE sent_at IS NOT NULL AND queued_at < ?').get(cutoff).n

const loopSource = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
const verdictSource = loopSource.match(/export function watchdogVerdict\([\s\S]*?\n}/)?.[0]
assert.ok(verdictSource, 'the actual watchdog verdict must remain identifiable')
const watchdogVerdict = new Function(`${verdictSource.replace('export ', '')}; return watchdogVerdict;`)()

for (const sparse of [false, true]) test(`actual watchdog stays live during ${sparse ? 'sparse' : 'dense'} outbox progress beyond its 12-minute budget`, async () => {
  const db = freshDB()
  const time = { now: fixedNow }
  class ProgressClock extends Clock { static now() { return time.now } }
  const activity = { at: time.now }
  const verdicts = []
  let done = false
  try {
    if (sparse) { add(db, recent, recent, 250); add(db, old, null, 250); add(db, old, old) }
    else add(db, old, old, 601)
    // Execute the original SQLite statements. Only advance the supplied clock
    // to represent slow completed batches; no real minutes or process exit.
    const prepare = db.prepare.bind(db)
    db.prepare = sql => {
      const stmt = prepare(sql)
      if (sql.startsWith('DELETE FROM telegram_outbox')) {
        const run = stmt.run.bind(stmt)
        stmt.run = (...args) => { const result = run(...args); time.now += 5 * 60_000; return result }
      }
      return stmt
    }
    const tick = () => {
      if (done) return
      verdicts.push(watchdogVerdict({ quietMs: time.now - activity.at, loopRunning: true,
        midCycleMs: 12 * 60_000, idleMs: 30 * 60_000, tripped: false }))
      setImmediate(tick)
    }
    setImmediate(tick)
    const result = await runHousekeepingSteps([{ name: 'prune-outbox', run: actualStep(db, { date: ProgressClock, activity }) }])
    done = true
    assert.deepEqual(result.failed, [])
    assert.ok(time.now - fixedNow > 12 * 60_000, 'fixture must cross the unchanged watchdog budget')
    assert.ok(verdicts.length >= 3, 'the ready watchdog must run across multiple actual batches')
    assert.ok(verdicts.every(v => v === 'ok'), `progress must prevent a false exit; observed ${verdicts}`)
    assert.equal(activity.at, time.now, 'the last completed batch must stamp progress')
    // Genuine lack of progress must still trip the existing watchdog.
    assert.equal(watchdogVerdict({ quietMs: 12 * 60_000, loopRunning: true,
      midCycleMs: 12 * 60_000, idleMs: 30 * 60_000, tripped: false }), 'exit')
    assert.equal(expired(db), 0)
  } finally { done = true; db.close() }
})

test('actual housekeeping yields to a ready callback before draining all old sent rows', async () => {
  const db = freshDB()
  try {
    add(db, old, old, 601)
    const callback = new Promise(resolve => setImmediate(() => resolve(expired(db))))
    const pass = runHousekeepingSteps([{ name: 'prune-outbox', run: actualStep(db) }])
    const beforeDrain = await callback
    const result = await pass
    assert.ok(beforeDrain > 0, `callback must run before the full cleanup; observed ${beforeDrain} rows`)
    assert.equal(expired(db), 0)
    assert.equal(result.results['prune-outbox'].changes, 601)
    assert.deepEqual(result.failed, [])
  } finally { db.close() }
})

test('ready callbacks also run before a sparse expiry beyond recent/pending rows', async () => {
  const db = freshDB()
  try {
    add(db, recent, recent, 250)
    add(db, old, null, 250)
    add(db, old, old)
    const callback = new Promise(resolve => setImmediate(() => resolve(expired(db))))
    const pass = runHousekeepingSteps([{ name: 'prune-outbox', run: actualStep(db) }])
    const beforeDrain = await callback
    await pass
    assert.equal(beforeDrain, 1, 'bounded inspected rows must yield even when none of the first rows expire')
    assert.equal(expired(db), 0)
    // Owner 13-10 ("Stop queuing while off"): unsent rows older than 14 days
    // are removed too, so only the 250 recent rows remain (was 500).
    assert.equal(db.prepare('SELECT count(*) n FROM telegram_outbox').get().n, 250)
  } finally { db.close() }
})

// Claude · № 13,878 13-Oct (owner "Stop queuing while off"): an unsent row
// older than 14 days now goes (it was kept), and an unsent notify_off row goes
// at any age. Recent unsent rows deferred by quiet hours or the hourly digest,
// the boundary, future and unknown timestamps are kept as before.
test('14-day predicate: old rows go sent or not, notify_off rows go at any age; recent deferred, boundary, future and unknown timestamps stay', async () => {
  const db = freshDB()
  try {
    add(db, old, old, 401)
    add(db, old, null)                                   // old unsent: now due
    add(db, recent, null, 1, 'notify_off')               // held by notify OFF: due at any age
    for (const [queuedAt, sentAt, reason] of [[cutoff, old, null], [recent, recent, null], [recent, null, 'quiet_hours'], [recent, null, 'hourly_digest'], ['2026-11-01T00:00:00.000Z', old, null], [null, old, null]]) add(db, queuedAt, sentAt, 1, reason)
    const kept = db.prepare('SELECT id, queued_at, sent_at, reason FROM telegram_outbox WHERE id > 403 ORDER BY id').all()
    const result = await runHousekeepingSteps([{ name: 'prune-outbox', run: actualStep(db) }])
    assert.equal(result.results['prune-outbox'].changes, 403)
    assert.deepEqual(db.prepare('SELECT id, queued_at, sent_at, reason FROM telegram_outbox ORDER BY id').all(), kept)
  } finally { db.close() }
})

test('fixed high-water mark leaves new arrivals for the next scheduled pass', async () => {
  const db = freshDB()
  try {
    add(db, old, old, 401)
    const arrival = new Promise(resolve => setImmediate(() => { add(db, old, old); resolve() }))
    const pass = runHousekeepingSteps([{ name: 'prune-outbox', run: actualStep(db) }])
    await arrival
    const result = await pass
    assert.equal(result.results['prune-outbox'].changes, 401)
    assert.equal(expired(db), 1)
    await runHousekeepingSteps([{ name: 'prune-outbox', run: actualStep(db) }])
    assert.equal(expired(db), 0)
  } finally { db.close() }
})

test('primary-key gaps and imported zero/negative ids retain the original deletion predicate', async () => {
  const db = freshDB()
  try {
    const insert = db.prepare('INSERT INTO telegram_outbox (id, queued_at, sent_at) VALUES (?, ?, ?)')
    for (const id of [-3, 0, 10, 5000]) insert.run(id, old, old)
    // A row that is not due survives the gaps: a recent unsent one (an old
    // unsent row is due since 13-10, owner "Stop queuing while off").
    insert.run(200, recent, null)
    const result = await runHousekeepingSteps([{ name: 'prune-outbox', run: actualStep(db) }])
    assert.equal(result.results['prune-outbox'].changes, 4)
    assert.deepEqual(db.prepare('SELECT id FROM telegram_outbox').all(), [{ id: 200 }])
  } finally { db.close() }
})

test('empty outbox is a no-op and a missing table stays an isolated housekeeping failure', async () => {
  const db = freshDB()
  try {
    const empty = await runHousekeepingSteps([{ name: 'prune-outbox', run: actualStep(db) }])
    assert.equal(empty.results['prune-outbox'].changes, 0)
    db.exec('DROP TABLE telegram_outbox')
    let later = false
    const result = await runHousekeepingSteps([{ name: 'prune-outbox', run: actualStep(db) }, { name: 'later', run: () => { later = true } }])
    assert.equal(later, true)
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].name, 'prune-outbox')
  } finally { db.close() }
})
