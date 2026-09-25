import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { DEFAULT_PARAMS, profileHash } from '../lib/tick-strategy.js'
import { TickComparisonReader, matchingProfile, comparisonMemo, comparisonRecord, retainComparisons, comparisonStatus, REFUSAL_WINDOW_MS, REFUSAL_ROW_LIMIT } from './scanner-comparison.js'

const HASH = profileHash(DEFAULT_PARAMS)
const tickFeed = (symbolId, accountId = '11', host = 'demo.ctraderapi.com') => ({ provider: 'ctrader', host, accountId, symbolId: String(symbolId) })
const tickProfile = (feed, over = {}) => ({ source: 'cpp-scan-tick', feed, strategy: 'tick_momentum_breakout', configVersion: 'v1', profileHash: HASH, candidateTtlMs: 60000, ...over })
function database(t, { symbols = 4, profiles = [] } = {}) {
  const db = initDB(':memory:'); t.after(() => db.close())
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (11,0)').run()
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (22,1)').run()
  setState(db, 'symbol_id_map:11', JSON.stringify({ map: Object.fromEntries(Array.from({ length: symbols }, (_, i) => [`S${i}`, 1000 + i])) }))
  setState(db, 'symbol_id_map:22', JSON.stringify({ map: { S0: 2000 } }))
  setState(db, 'scanner_mirror_profiles_json', JSON.stringify(profiles))
  return db
}
// A view of the database that records every statement it runs: the SQL, how
// many rows a write changed, and each read of one agent_state key.
function observed(db, key = 'scanner_mirror_profiles_json') {
  const log = { statements: [], keyReads: 0 }
  const wrap = (statement, sql) => new Proxy(statement, { get(target, prop) {
    const value = Reflect.get(target, prop, target)
    if (typeof value !== 'function') return value
    if (!['run', 'get', 'all', 'iterate'].includes(prop)) return value.bind(target)
    return (...args) => {
      if (/FROM agent_state WHERE key/.test(sql) && args[0] === key) log.keyReads++
      const out = value.apply(target, args)
      log.statements.push({ sql, changes: prop === 'run' ? out.changes : null })
      return out
    }
  } })
  const proxy = new Proxy(db, { get(target, prop) {
    if (prop === 'prepare') return sql => wrap(target.prepare(sql), sql)
    const value = Reflect.get(target, prop, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return { db: proxy, log }
}
const row = (cursor, feed, over = {}) => ({ cursor, feed, strategy: 'tick_momentum_breakout', feedEpoch: 'epoch-a', configVersion: 'v1', profileHash: HASH, profile: { ...DEFAULT_PARAMS },
  outcome: 'no_signal', orderAuthority: false, completedAtMs: 1_800_000_000_000,
  quote: { seq: cursor, recvMs: 1_800_000_000_000, bid: 100, ask: 101, snapshot: true, crossed: false, changed: true }, ...over })
const page = (rows, instanceId = 'a'.repeat(64)) => ({ instanceId, orderAuthority: false, oldestCursor: 1, latestCursor: rows.at(-1).cursor, gap: false, candidates: rows })

test('one comparison page reads the profile registry once and matches exactly as the per-row path does', t => {
  const registered = [tickFeed(1000), tickFeed(1001), tickFeed(2000, '22', 'live.ctraderapi.com')]
  // Profiles the identity gate must refuse although they are in the registry
  // (the registry validates at registration; the gate re-checks at use): a
  // symbol outside account 11's map, an account with no accounts row, and the
  // demo account's feed carrying the live host. Without these every gate
  // failure also had no profile, so deleting the gate could not turn red.
  const gated = [tickFeed(1004), tickFeed(1000, '33'), tickFeed(1000, '11', 'live.ctraderapi.com')]
  const db = database(t, { profiles: [...registered.map(f => tickProfile(f)), ...gated.map(f => tickProfile(f)),
    tickProfile(tickFeed(1002), { source: 'cpp-scan-timeframe', timeframe: '1h' }), tickProfile(tickFeed(1003), { configVersion: 'v2' })] })
  const variants = [
    ...registered, ...gated, tickFeed(1002), tickFeed(1003), tickFeed(9999),
    { symbolId: '1001', host: 'demo.ctraderapi.com', accountId: '11', provider: 'ctrader' }, // same identity, other key order
  ]
  const rows = Array.from({ length: 64 }, (_, i) => {
    const feed = variants[i % variants.length]
    return row(i + 1, feed, i % 7 === 3 ? { configVersion: 'v2' } : i % 11 === 5 ? { profileHash: 'other' } : i % 13 === 7 ? { timeframe: '1h' } : {})
  })
  const memo = comparisonMemo()
  for (const feed of gated) {
    assert.equal(matchingProfile(db, 'cpp-scan-tick', row(1, feed), memo), null, `memo path admitted ${JSON.stringify(feed)}`)
    assert.equal(matchingProfile(db, 'cpp-scan-tick', row(1, feed)), null, `per-row path admitted ${JSON.stringify(feed)}`)
  }
  for (const r of rows) assert.deepEqual(matchingProfile(db, 'cpp-scan-tick', r, memo), matchingProfile(db, 'cpp-scan-tick', r), JSON.stringify(r.feed))
  assert.ok(rows.some(r => matchingProfile(db, 'cpp-scan-tick', r)) && rows.some(r => !matchingProfile(db, 'cpp-scan-tick', r)), 'a mixed page')

  const { db: view, log } = observed(db)
  new TickComparisonReader().consume(view, page(rows), 1_800_000_000_000)
  assert.equal(log.keyReads, 1, 'the registry is parsed once per page, not once per row')
  const states = db.prepare("SELECT state FROM scanner_comparisons WHERE source='cpp-scan-tick' ORDER BY rowid").all().map(r => r.state)
  const expected = rows.map(r => matchingProfile(db, 'cpp-scan-tick', r) ? 'matched' : 'contract_rejected')
  assert.deepEqual(states, expected)
})

test('a new feed epoch replaces its oracle stream instead of adding one past the 512 bound', t => {
  const feeds = Array.from({ length: 512 }, (_, i) => tickFeed(1000 + i))
  const db = database(t, { symbols: 512, profiles: feeds.map(f => tickProfile(f)) }), reader = new TickComparisonReader()
  let cursor = 0
  const consumeEpoch = (feedEpoch, snapshot) => {
    for (let at = 0; at < feeds.length; at += 128) {
      const rows = feeds.slice(at, at + 128).map(f => { cursor++; return row(cursor, f, { feedEpoch, quote: { ...row(cursor, f).quote, snapshot } }) })
      reader.consume(db, page(rows), 1_800_000_000_000)
    }
  }
  consumeEpoch('epoch-a', true)
  consumeEpoch('epoch-b', false)
  const byState = Object.fromEntries(db.prepare("SELECT state,count(*) n FROM scanner_comparisons GROUP BY state").all().map(r => [r.state, r.n]))
  assert.equal(byState.reference_capacity, undefined, JSON.stringify(byState))
  assert.equal(byState.matched, 512)
  assert.equal(byState.reference_warmup_unknown, 512, 'the first epoch-B row of each stream rewarms')
  assert.equal(reader.streams.size, 512)
})

test('retention keeps each source its own newest rows', t => {
  const db = database(t), now = 1_800_000_000_000
  for (let i = 0; i < 20; i++) comparisonRecord(db, `tick${i}`, 'cpp-scan-tick', 'matched', {}, now - 1000 + i)
  for (let i = 0; i < 3; i++) comparisonRecord(db, `tf${i}`, 'cpp-scan-timeframe', 'matched', {}, now - 5000 + i)
  retainComparisons(db, now, { cap: 10 })
  const kept = db.prepare('SELECT source,count(*) n,MIN(observed_ms) oldest FROM scanner_comparisons GROUP BY source ORDER BY source').all()
  assert.deepEqual(kept, [{ source: 'cpp-scan-tick', n: 10, oldest: now - 1000 + 10 }, { source: 'cpp-scan-timeframe', n: 3, oldest: now - 5000 }])
  // Ties on observed_ms (a whole page shares one timestamp) still keep exactly `cap`.
  for (let i = 0; i < 15; i++) comparisonRecord(db, `tie${i}`, 'cpp-scan-tick', 'matched', {}, now)
  retainComparisons(db, now, { cap: 10 })
  assert.equal(db.prepare("SELECT count(*) n FROM scanner_comparisons WHERE source='cpp-scan-tick'").get().n, 10)
  assert.equal(db.prepare("SELECT count(*) n FROM scanner_comparisons WHERE source='cpp-scan-tick' AND id LIKE 'tie%'").get().n, 10)
})

test('no statement on the page path counts or deletes; retention runs a fixed number of indexed statements', t => {
  const db = database(t, { symbols: 4, profiles: [tickProfile(tickFeed(1000))] }), now = 1_800_000_000_000
  const { db: view, log } = observed(db)
  new TickComparisonReader().consume(view, page(Array.from({ length: 128 }, (_, i) => row(i + 1, tickFeed(1000)))), now)
  assert.equal(log.statements.filter(s => /count\(|delete/i.test(s.sql)).length, 0, 'a per-row trim is back on the page path')

  const fill = (source, n) => db.transaction(() => { for (let i = 0; i < n; i++) comparisonRecord(db, `${source}:${i}`, source, 'matched', {}, now - n + i) })()
  const retainRun = options => {
    const seen = observed(db), started = performance.now()
    retainComparisons(seen.db, now, options)
    return { statements: seen.log.statements, ms: performance.now() - started }
  }
  fill('cpp-scan-tick', 1000); fill('cpp-scan-timeframe', 1000)
  const small = retainRun({ cap: 30_000 }).statements.length
  fill('cpp-scan-tick', 24_000); fill('cpp-scan-timeframe', 24_000)
  assert.equal(retainRun({ cap: 30_000 }).statements.length, small, 'the statement count grew with the table')

  const trimmed = retainRun({ cap: 20_000, chunk: 2000 })
  const deletes = trimmed.statements.filter(s => /^DELETE FROM scanner_comparisons WHERE rowid IN/.test(s.sql))
  assert.ok(deletes.length >= 4 && deletes.every(s => s.changes <= 2000), JSON.stringify(deletes.map(s => s.changes)))
  assert.deepEqual(db.prepare('SELECT source,count(*) n FROM scanner_comparisons GROUP BY source ORDER BY source').all(),
    [{ source: 'cpp-scan-tick', n: 20_000 }, { source: 'cpp-scan-timeframe', n: 20_000 }])
  assert.ok(trimmed.ms < 3000, `retention took ${trimmed.ms.toFixed(0)} ms`)

  // Every read and write retention and the status route issue walks an index.
  const plans = [...trimmed.statements.map(s => s.sql), ...(() => { const s = observed(db); comparisonStatus(s.db); return s.log.statements.map(x => x.sql) })()]
    .filter(sql => /scanner_comparisons/.test(sql) && !/sqlite_master/.test(sql))
  for (const sql of new Set(plans)) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(sql.match(/\?/g) || []).map(() => 0)).map(r => r.detail).join(' | ')
    assert.doesNotMatch(plan, /TEMP B-TREE FOR ORDER BY|SCAN scanner_comparisons(?! USING)/, `${sql}\n${plan}`)
    // Only the refusal breakdown groups in a temporary tree, and only over the
    // last hour of input_refused rows of one source: a range on the index.
    if (/TEMP B-TREE/.test(plan)) assert.match(plan, /SEARCH scanner_comparisons USING INDEX scanner_comparison_source_state \(source=\? AND state=\? AND observed_ms>\?\)/, plan)
  }
  const status = observed(db); comparisonStatus(status.db)
  const groupBy = status.log.statements.find(s => /GROUP BY source,state/.test(s.sql)).sql
  assert.match(db.prepare(`EXPLAIN QUERY PLAN ${groupBy}`).all().map(r => r.detail).join(' '), /COVERING INDEX scanner_comparison_source_state/)
})

test('the refusal breakdown opens only the last hour of refusals, however many are retained', t => {
  const db = database(t), now = 1_800_000_000_000
  const refusal = (id, at, reason) => comparisonRecord(db, id, 'cpp-scan-timeframe', 'input_refused', { error: 'bar_input_invalid', reason }, at)
  db.transaction(() => {
    // Six days of retained refusals, all older than the hour.
    for (let i = 0; i < 20_000; i++) refusal(`old${i}`, now - REFUSAL_WINDOW_MS - 1 - i * 25_000, 'last_bar_partial')
    for (let i = 0; i < 30; i++) refusal(`partial${i}`, now - i * 60_000, 'last_bar_partial')
    for (let i = 0; i < 10; i++) refusal(`empty${i}`, now - i * 60_000, 'bars_empty')
    refusal('edge', now - REFUSAL_WINDOW_MS, 'ohlc_invalid') // the window is inclusive at its start
  })()
  // Count every row the breakdown opens: json_extract on detail is the per-row cost.
  let opened = 0
  db.function('json_extract', { deterministic: true }, (doc, path) => { opened++; return JSON.parse(doc)[path.replace(/^\$\./, '')] ?? null })
  const status = comparisonStatus(db, { now })
  assert.equal(status.inputRefusedWindowMs, REFUSAL_WINDOW_MS)
  assert.deepEqual(status.inputRefusedLastHour.map(r => [r.error, r.reason, r.records]).sort(), [
    ['bar_input_invalid', 'bars_empty', 10], ['bar_input_invalid', 'last_bar_partial', 30], ['bar_input_invalid', 'ohlc_invalid', 1]])
  assert.ok(opened > 0 && opened <= 2 * 41, `the breakdown opened ${opened / 2} rows for 41 in the hour (20,041 retained)`)
  // The retained total is still reported, from the covering index alone.
  assert.equal(status.populations.find(p => p.state === 'input_refused').records, 20_041)
  const { db: view, log } = observed(db); comparisonStatus(view, { now })
  const breakdown = log.statements.find(s => /json_extract/.test(s.sql)).sql
  assert.match(db.prepare(`EXPLAIN QUERY PLAN ${breakdown}`).all(0, 1).map(r => r.detail).join(' | '),
    /SEARCH scanner_comparisons USING INDEX scanner_comparison_source_state \(source=\? AND state=\? AND observed_ms>\?\)/)
})

test('the 7-day age deletes run in bounded chunks, one statement per chunk', t => {
  const db = database(t), now = 1_800_000_000_000, stale = now - 8 * 86_400_000
  db.transaction(() => {
    for (let i = 0; i < 5000; i++) comparisonRecord(db, `stale${i}`, 'cpp-scan-tick', 'matched', {}, stale - i)
    for (let i = 0; i < 10; i++) comparisonRecord(db, `fresh${i}`, 'cpp-scan-tick', 'matched', {}, now - i)
    const reference = db.prepare('INSERT INTO scanner_references (id,payload,observed_ms) VALUES (?,?,?)')
    for (let i = 0; i < 3000; i++) reference.run(`stale${i}`, '{}', stale - i)
    for (let i = 0; i < 5; i++) reference.run(`fresh${i}`, '{}', now - i)
  })()
  const { db: view, log } = observed(db)
  retainComparisons(view, now, { chunk: 1000 })
  const deletes = log.statements.filter(s => /^DELETE/.test(s.sql))
  assert.ok(deletes.every(s => s.changes <= 1000), JSON.stringify(deletes.map(s => [s.sql.slice(0, 40), s.changes])))
  const aged = table => deletes.filter(s => s.sql.startsWith(`DELETE FROM ${table} `) && /observed_ms\s*<\s*\?/.test(s.sql)).map(s => s.changes)
  assert.deepEqual(aged('scanner_comparisons'), [1000, 1000, 1000, 1000, 1000, 0])
  assert.deepEqual(aged('scanner_references'), [1000, 1000, 1000, 0])
  assert.equal(db.prepare('SELECT count(*) n FROM scanner_comparisons').get().n, 10)
  assert.equal(db.prepare('SELECT count(*) n FROM scanner_references').get().n, 5)
})

test('the refusal window and row limit are pinned (re-checker N-a, N-b): a wider window or no limit reads every retained refusal', () => {
  assert.equal(REFUSAL_WINDOW_MS, 3_600_000, 'RED if the window is widened: the breakdown opens every retained refusal again')
  assert.equal(REFUSAL_ROW_LIMIT, 5000)
})

test('the refusal breakdown reads at most REFUSAL_ROW_LIMIT rows and says when it is truncated', (t) => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const now = 1_800_000_000_000
  comparisonRecord(db, 'seed', 'cpp-scan-timeframe', 'input_refused', { error: 'seed', reason: 'seed' }, now - 10)
  const ins = db.prepare(`INSERT INTO scanner_comparisons (id, source, state, observed_ms, detail) VALUES (?, 'cpp-scan-timeframe', 'input_refused', ?, ?)`)
  db.transaction(() => { for (let i = 0; i < REFUSAL_ROW_LIMIT + 50; i++) ins.run(`r${i}`, now - 1000 - i, JSON.stringify({ error: 'bar_invalid', reason: 'last_bar_partial' })) })()
  const s = comparisonStatus(db, { now })
  const read = s.inputRefusedLastHour.reduce((n, r) => n + r.records, 0)
  assert.equal(s.inputRefusedTruncated, true, 'RED without the row limit: the whole hour is opened')
  assert.equal(read, REFUSAL_ROW_LIMIT)
})
