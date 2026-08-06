// node --test agent/lib/trade-origin.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import {
  ORIGINS, CLEAN_BOT_ORIGINS, isOrigin, normaliseOrigin,
  cleanBotOrigin, deriveOrigin, originCoverage,
} from './trade-origin.js'

test('the enum is closed, and normalisation cannot widen it', () => {
  assert.equal(isOrigin('bot_market_dispatch'), true)
  assert.equal(isOrigin('bot_dispatch'), false, 'near-misses are not members')
  assert.equal(normaliseOrigin('bot_dispatch'), 'unknown')
  assert.equal(normaliseOrigin(''), 'unknown')
  assert.equal(normaliseOrigin(null), 'unknown')
  assert.equal(normaliseOrigin('reconciler_adopted'), 'reconciler_adopted')
})

test('only this system\'s own dispatch counts as evidence of edge', () => {
  // The audit's instruction made mechanical: "Do not use adopted or manual
  // trades as clean evidence of strategy expectancy."
  assert.deepEqual([...CLEAN_BOT_ORIGINS], ['bot_market_dispatch', 'bot_pending_fill'])
  assert.equal(cleanBotOrigin('bot_market_dispatch'), true)
  assert.equal(cleanBotOrigin('bot_pending_fill'), true)
  for (const o of ['reconciler_adopted', 'manual_broker', 'external_system', 'legacy_unattributed', 'unknown']) {
    assert.equal(cleanBotOrigin(o), false, `${o} must not count as edge`)
  }
})

// ---------------------------------------------------------------------------
// Derivation for rows written before the column existed
// ---------------------------------------------------------------------------

test('an adopted position is derived as adopted, from either signal', () => {
  // The nine 0066.HK duplicates (#179) landed exactly this way: adopted in one
  // reconcile pass, thesis "Adopted bot position — label autopilot/…".
  assert.equal(deriveOrigin({ source: 'reconciled' }), 'reconciler_adopted')
  assert.equal(deriveOrigin({ source: 'broker', thesis: 'Adopted bot position — label autopilot/fib_confluence' }), 'reconciler_adopted')
})

test('an autotrade row is clean ONLY when it carries its decision record', () => {
  // THE LINE THAT MATTERS. risk_event_id is the gate verdict. Without one,
  // an autotrade row is this system's order with no decision attached — real,
  // but not clean evidence, and promoting it would launder exactly the rows
  // this column exists to separate.
  assert.equal(deriveOrigin({ source: 'autotrade', risk_event_id: 4231 }), 'bot_market_dispatch')
  assert.equal(deriveOrigin({ source: 'autotrade', risk_event_id: null }), 'legacy_unattributed')
})

test('pending fills and manual entries are derived from their own writers\' literals', () => {
  assert.equal(deriveOrigin({ source: 'fib_618_fade' }), 'bot_pending_fill')
  assert.equal(deriveOrigin({ source: 'manual' }), 'manual_broker')
  assert.equal(deriveOrigin({ source: 'execute_analysis' }), 'manual_broker')
})

test('an unestablishable row is legacy_unattributed — a statement, not a shrug', () => {
  assert.equal(deriveOrigin({}), 'legacy_unattributed')
  assert.equal(deriveOrigin({ source: 'something-new' }), 'legacy_unattributed')
  assert.ok(!cleanBotOrigin(deriveOrigin({})), 'and it is never clean')
})

test('every derivation lands inside the declared set', () => {
  const inputs = [
    {}, { source: 'autotrade', risk_event_id: 1 }, { source: 'autotrade' },
    { source: 'reconciled' }, { source: 'manual' }, { source: 'fib_618_fade' },
    { thesis: 'adopted' }, { source: 'llm' }, { source: 'zzz' },
  ]
  for (const i of inputs) assert.ok(ORIGINS.includes(deriveOrigin(i)), JSON.stringify(i))
})

// ---------------------------------------------------------------------------
// Coverage, reported beside the metrics rather than instead of them
// ---------------------------------------------------------------------------

test('coverage says what fraction of a number is actually strategy evidence', () => {
  const rows = [
    { origin: 'bot_market_dispatch' },
    { origin: 'bot_pending_fill' },
    { origin: 'reconciler_adopted' },
    { origin: 'reconciler_adopted' },
    { origin: 'legacy_unattributed' },
  ]
  const c = originCoverage(rows)
  assert.equal(c.n, 5)
  assert.equal(c.clean, 2)
  assert.equal(c.cleanPct, 40)
  assert.equal(c.known, 4, 'adopted IS known; only unknown/legacy are not')
  assert.equal(c.byOrigin.reconciler_adopted, 2)
  assert.match(c.note, /NOT evidence of strategy edge/)
})

test('an empty window says so rather than reporting 100% of nothing', () => {
  const c = originCoverage([])
  assert.equal(c.n, 0)
  assert.equal(c.cleanPct, 0)
  assert.equal(c.note, 'No trades in this window.')
})

test('unrecognised origins in the data are counted as unknown, not passed through', () => {
  const c = originCoverage([{ origin: 'bot_dispatch' }, { origin: null }])
  assert.equal(c.byOrigin.unknown, 2)
  assert.equal(c.clean, 0)
})

// ---------------------------------------------------------------------------
// The column exists and the write paths reach it
// ---------------------------------------------------------------------------

test('the trades table carries origin and origin_source', () => {
  const db = initDB(':memory:')
  const cols = db.prepare('PRAGMA table_info(trades)').all().map(c => c.name)
  assert.ok(cols.includes('origin'), 'origin column missing')
  assert.ok(cols.includes('origin_source'), 'origin_source column missing')
})

test('a row can be stamped and read back through the enum', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (symbol, side, status, origin, origin_source)
              VALUES ('EURUSD', 'BUY', 'open', 'bot_market_dispatch', 'write')`).run()
  const row = db.prepare('SELECT origin, origin_source FROM trades').get()
  assert.equal(normaliseOrigin(row.origin), 'bot_market_dispatch')
  assert.equal(cleanBotOrigin(row.origin), true)
  assert.equal(row.origin_source, 'write')
})

test('rollback targets backfilled rows ONLY — a write-time origin survives it', () => {
  // The reversal contract of scripts/backfill-trade-origin.mjs, asserted here
  // so it cannot quietly widen: undoing a backfill must never erase an origin
  // recorded at the moment a trade was created.
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (symbol, side, status, origin, origin_source)
              VALUES ('EURUSD', 'BUY', 'open', 'bot_market_dispatch', 'write')`).run()
  db.prepare(`INSERT INTO trades (symbol, side, status, origin, origin_source)
              VALUES ('US30', 'SELL', 'closed', 'legacy_unattributed', 'backfill')`).run()

  const cleared = db.prepare("UPDATE trades SET origin = NULL, origin_source = NULL WHERE origin_source = 'backfill'").run()
  assert.equal(cleared.changes, 1)
  const left = db.prepare('SELECT symbol, origin FROM trades WHERE origin IS NOT NULL').all()
  assert.deepEqual(left, [{ symbol: 'EURUSD', origin: 'bot_market_dispatch' }])
})

// ---------------------------------------------------------------------------
// The route says what the mixture is
// ---------------------------------------------------------------------------

test('GET /state/attribution reports origin coverage beside the numbers', async () => {
  const express = (await import('express')).default
  const stateRouter = (await import('../routes/state.js')).default
  const db = initDB(':memory:')
  const ins = db.prepare(`INSERT INTO trades (symbol, side, status, closed_at, net_pnl, origin, label_strategy)
                          VALUES (?, 'BUY', 'closed', datetime('now'), ?, ?, 'fib_confluence')`)
  ins.run('EURUSD', 12, 'bot_market_dispatch')
  ins.run('US30', -8, 'reconciler_adopted')
  ins.run('0066.HK', -3, 'reconciler_adopted')

  const app = express()
  app.use('/state', stateRouter(db))
  const s = await new Promise(r => { const srv = app.listen(0, () => r(srv)) })
  try {
    const base = `http://127.0.0.1:${s.address().port}`
    const body = await fetch(`${base}/state/attribution?groupBy=strategy&account=all`).then(r => r.json())
    assert.equal(body.originCoverage.n, 3)
    assert.equal(body.originCoverage.clean, 1)
    assert.match(body.originCoverage.note, /NOT evidence of strategy edge/)

    // And origin is groupable, so "which of these are actually ours" is one query.
    const byOrigin = await fetch(`${base}/state/attribution?groupBy=origin&account=all`).then(r => r.json())
    const adopted = byOrigin.rows.find(r => r.origin === 'reconciler_adopted')
    assert.equal(adopted.trades, 2)
  } finally { s.close() }
})
