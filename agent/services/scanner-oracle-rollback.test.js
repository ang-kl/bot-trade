// Codex · №12,781 · 2026-10-10; codex-footprint: scanner-oracle-rollback.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { TickMomentumOracle, profileHash } from '../lib/tick-strategy.js'
import { createScannerCollector } from './scanner-collector.js'
import { comparisonRecord, TickComparisonReader } from './scanner-comparison.js'

const fixture = JSON.parse(readFileSync(new URL('../../cpp-scan-tick/src/tests/fixtures/tick_momentum_fixture.json', import.meta.url), 'utf8'))
const expected = JSON.parse(readFileSync(new URL('../../cpp-scan-tick/src/tests/fixtures/tick_momentum_expected.json', import.meta.url), 'utf8'))
const NOW = fixture.events.at(-1).recvMs + 1000, INSTANCE = 'a'.repeat(64)
const feed = { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '1000' }
const otherFeed = { ...feed, symbolId: '1001' }, hash = profileHash(fixture.params)
const oracle = new TickMomentumOracle(fixture.params), signals = []
const rows = fixture.events.map(quote => {
  const signal = oracle.feed(quote)
  if (signal) signals.push(signal)
  return { cursor: quote.seq, feed, strategy: 'tick_momentum_breakout', feedEpoch: 'epoch-a',
    configVersion: 'v1', profileHash: hash, profile: fixture.params, completedAtMs: quote.recvMs,
    orderAuthority: false, outcome: signal ? 'candidate' : 'no_signal', signal, quote }
})
const row = (seq, extra = {}) => ({ ...rows[seq - 1], ...extra })
const page = (candidates, extra = {}) => ({ instanceId: INSTANCE, orderAuthority: false,
  oldestCursor: 1, latestCursor: candidates.at(-1)?.cursor ?? 0, gap: false, candidates, ...extra })
const capture = reader => structuredClone({ after: reader.after, instance: reader.instance, streams: [...reader.streams] })
const records = db => db.prepare('SELECT id,source,state,detail,observed_ms FROM scanner_comparisons ORDER BY id').all()
const mainStream = reader => [...reader.streams.values()][0]

function database(t) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES(11,0)').run()
  setState(db, 'symbol_id_map:11', JSON.stringify({ accountId: '11', map: { X: 1000, Y: 1001 } }))
  setState(db, 'scanner_mirror_profiles_json', JSON.stringify([feed, otherFeed].map(owned => ({
    source: 'cpp-scan-tick', feed: owned, strategy: 'tick_momentum_breakout', configVersion: 'v1',
    profileHash: hash, candidateTtlMs: 60000,
  }))))
  comparisonRecord(db, 'seed', 'cpp-scan-tick', 'fixture', {}, NOW)
  db.prepare('DELETE FROM scanner_comparisons').run()
  return db
}
function consumeRows(reader, db, candidates) {
  for (let offset = 0; offset < candidates.length; offset += 128)
    reader.consume(db, page(candidates.slice(offset, offset + 128), { latestCursor: candidates.at(-1).cursor }), NOW)
}
function insertionFailure(db) {
  const fault = { sequence: null }
  db.function('oracle_insert_fault', seq => {
    if (fault.sequence != null && seq === fault.sequence) throw new Error('controlled-oracle-insert-failure')
    return 0
  })
  db.exec(`CREATE TEMP TRIGGER oracle_insert_fault BEFORE INSERT ON scanner_comparisons
    BEGIN SELECT oracle_insert_fault(json_extract(NEW.detail,'$.sourceSequence')); END`)
  return fault
}
function collector(db, reader, requested = []) {
  return createScannerCollector(db, {
    reader, env: { SCANNER_TICK_URL: 'http://fixture', SCANNER_TICK_SECRET: 'fixture' },
    now: () => NOW, mirrors: async () => ({ outcomes: [] }),
    request: async (_url, _secret, path) => {
      const after = Number(path.split('=')[1]); requested.push(after)
      return page(rows.filter(r => r.cursor > after).slice(0, 128), { latestCursor: rows.length })
    },
  })
}

test('later collector prefix failure preserves the committed confirming oracle and replays both real fixture signals', async t => {
  // Pin the generated full comparison signals to the shared C++/JS fixture's
  // checked-in economic expectations; the expected file omits V/E/spread.
  assert.deepEqual(signals.map(s => Object.fromEntries(Object.keys(expected.signals[0]).map(k => [k, s[k]]))), expected.signals)
  assert.deepEqual(signals.map(s => [s.seq, s.side]), [[118, 'BUY'], [284, 'SELL']])
  const db = database(t), controlDb = database(t), reader = new TickComparisonReader(), control = new TickComparisonReader()
  consumeRows(reader, db, rows.slice(0, 115))
  consumeRows(control, controlDb, rows.slice(0, 117))
  assert.equal(mainStream(control).known, true)
  assert.equal(mainStream(control).oracle.state, 'CONFIRMING')
  assert.equal(mainStream(control).oracle.setup.confirmed, 1)
  assert.equal(mainStream(control).oracle.setup.dir, 'BUY')
  const committed = capture(control), committedRecords = records(controlDb)
  const fault = insertionFailure(db); fault.sequence = 119
  const requested = [], collect = collector(db, reader, requested)
  const failed = await collect(), failedState = capture(reader), failedRecords = records(db)
  assert.equal(failed.error, 'comparison_read_or_contract_failed')
  assert.equal(failed.tickCursor, 117); assert.equal(failed.tickRecords, 2); assert.equal(failed.tickBacklog, true)
  fault.sequence = null
  const recovered = await collect()
  await collector(controlDb, control)()
  assert.equal(requested[1], 117, 'only the failed suffix is refetched; its initial snapshot was committed earlier')
  assert.ok(rows.slice(117).every(r => !r.quote.snapshot))
  assert.equal(recovered.tickCursor, rows.length)
  assert.equal(mainStream(reader).known, true, 'a recovered suffix must not lose its previously committed snapshot')
  assert.deepEqual(failedState, committed, 'arrays, setup, rejection counters and sequence must roll back with the prefix')
  assert.deepEqual(failedRecords, committedRecords)
  assert.deepEqual(capture(reader), capture(control))
  assert.deepEqual(records(db), records(controlDb))
  for (const signal of signals) {
    const saved = records(db).find(r => JSON.parse(r.detail).sourceSequence === signal.seq)
    assert.equal(saved.state, 'matched', `real ${signal.side} signal ${signal.seq} survives suffix recovery`)
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM scanner_comparisons WHERE state='reference_warmup_unknown'").get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entry_intents').get().n, 0)
})

test('direct multirow consume restores mutable oracle windows, setup and rejection counters after an insert failure', t => {
  const db = database(t), controlDb = database(t), reader = new TickComparisonReader(), control = new TickComparisonReader()
  consumeRows(reader, db, rows.slice(0, 117)); consumeRows(control, controlDb, rows.slice(0, 117))
  const before = capture(reader), beforeRecords = records(db)
  const retry = page([row(118), row(119, { quote: { ...rows[118].quote, changed: false } }), row(120)])
  control.consume(controlDb, retry, NOW)
  const next = mainStream(control).oracle, previous = before.streams[0][1].oracle
  assert.equal(previous.setup.confirmed, 1); assert.equal(next.setup.confirmed, 2)
  assert.equal(next.state, 'SIGNALLED'); assert.equal(next.rejected.repeat, previous.rejected.repeat + 1)
  for (const key of ['mids', 'bids', 'asks', 'spreads']) assert.notDeepEqual(next[key], previous[key], `${key} actually changes`)
  assert.ok(next.accepted > previous.accepted); assert.ok(next.warmedEvaluations > previous.warmedEvaluations)
  const fault = insertionFailure(db); fault.sequence = 120
  assert.throws(() => reader.consume(db, retry, NOW), /controlled-oracle-insert-failure/)
  assert.deepEqual(capture(reader), before)
  assert.deepEqual(records(db), beforeRecords)
  fault.sequence = null; reader.consume(db, retry, NOW)
  assert.deepEqual(capture(reader), capture(control)); assert.deepEqual(records(db), records(controlDb))
})

test('a real deferred SQLite COMMIT failure restores both streams and an untouched stream still confirms its signal', t => {
  const db = database(t), controlDb = database(t), reader = new TickComparisonReader(), control = new TickComparisonReader()
  const seeded = [...rows.slice(0, 117), ...rows.slice(0, 117).map((r, i) => ({ ...r, cursor: 118 + i, feed: otherFeed }))]
  consumeRows(reader, db, seeded); consumeRows(control, controlDb, seeded)
  assert.equal(reader.streams.size, 2)
  assert.ok([...reader.streams.values()].every(s => s.known && s.oracle.setup.confirmed === 1))
  const before = capture(reader), beforeRecords = records(db)
  const retry = page([row(118, { cursor: 235 }), row(119, { cursor: 236 })])
  db.pragma('foreign_keys=ON')
  db.exec(`CREATE TABLE oracle_commit_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE oracle_commit_child(parent_id INTEGER REFERENCES oracle_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`)
  let fail = true
  db.function('oracle_commit_fault', () => Number(fail))
  db.exec(`CREATE TEMP TRIGGER oracle_commit_fault AFTER INSERT ON scanner_comparisons WHEN oracle_commit_fault()=1
    BEGIN INSERT INTO oracle_commit_child(parent_id) VALUES(777); END`)
  assert.throws(() => reader.consume(db, retry, NOW), e => e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY')
  assert.equal(db.inTransaction, false)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM oracle_commit_child').get().n, 0)
  assert.deepEqual(capture(reader), before); assert.deepEqual(records(db), beforeRecords)
  fail = false
  reader.consume(db, retry, NOW); control.consume(controlDb, retry, NOW)
  assert.deepEqual(capture(reader), capture(control))
  const untouchedSignal = page([row(118, { cursor: 237, feed: otherFeed })])
  reader.consume(db, untouchedSignal, NOW); control.consume(controlDb, untouchedSignal, NOW)
  assert.deepEqual(capture(reader), capture(control)); assert.deepEqual(records(db), records(controlDb))
  const held = records(db).filter(r => JSON.parse(r.detail).sourceSequence === 118)
  assert.equal(held.length, 2); assert.ok(held.every(r => r.state === 'matched'))
})

const snapshotRow = cursor => row(118, { cursor, outcome: 'no_signal', signal: null, quote: { ...rows[117].quote, snapshot: true } })
const transitions = [
  ['snapshot', () => page([snapshotRow(118), row(119)]), false, true],
  ['page gap', () => page([row(118, { cursor: 120 }), row(119, { cursor: 121 })], { oldestCursor: 120, gap: true }), true, false],
  ['cursor gap', () => page([row(118, { cursor: 120 }), row(119, { cursor: 121 })]), true, false],
  ['native instance', () => page([snapshotRow(1), row(119, { cursor: 2 })], { instanceId: 'b'.repeat(64) }), false, true],
  ['feed epoch', () => page([row(118, { feedEpoch: 'epoch-b' }), row(119, { feedEpoch: 'epoch-b' })]), false, false],
]
for (const [name, transition, hasGap, known] of transitions) {
  test(`failed ${name} transition restores the prior direct-consume oracle; a successful retry retains the real reset`, t => {
    const db = database(t), controlDb = database(t), reader = new TickComparisonReader(), control = new TickComparisonReader()
    consumeRows(reader, db, rows.slice(0, 117)); consumeRows(control, controlDb, rows.slice(0, 117))
    const before = capture(reader), beforeRecords = records(db), input = transition()
    const fault = insertionFailure(db); fault.sequence = 119
    assert.throws(() => reader.consume(db, input, NOW), /controlled-oracle-insert-failure/)
    assert.deepEqual(capture(reader), before); assert.deepEqual(records(db), beforeRecords)
    fault.sequence = null
    reader.consume(db, input, NOW); control.consume(controlDb, input, NOW)
    assert.deepEqual(capture(reader), capture(control)); assert.deepEqual(records(db), records(controlDb))
    assert.equal(mainStream(reader).known, known)
    assert.equal(mainStream(reader).oracle.state, 'WARMING')
    assert.equal(db.prepare("SELECT COUNT(*) n FROM scanner_comparisons WHERE state='input_gap'").get().n, Number(hasGap))
    assert.equal(db.prepare('SELECT COUNT(*) n FROM entry_intents').get().n, 0)
  })
}
