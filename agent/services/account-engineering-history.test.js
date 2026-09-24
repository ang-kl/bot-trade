import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { initDB } from '../db.js'
import { engineeringView } from './account-engineering.js'

const history = /\bFROM\s+(decision_log|risk_events)\b/i
const indexes = ['idx_decision_log_account_latest', 'idx_risk_events_account_latest']
function registry(db) {
  const insert = db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,0,1,?)')
  for (const id of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) insert.run(id, 'active')
}
function decision(db, account, at, stage, result = 'skip') {
  db.prepare(`INSERT INTO decision_log (account_id,symbol,created_at,stage,decision,reason)
    VALUES (?,'EURUSD',?,?,?,'fixture')`).run(account, at, stage, result)
}
function risk(db, account, at, approved) {
  db.prepare(`INSERT INTO risk_events (account_id,symbol,side,created_at,approved)
    VALUES (?,'EURUSD','long',?,?)`).run(account, at, approved)
}
function retained(db) {
  return Object.fromEntries(['decision_log', 'risk_events', 'accounts', 'agent_state'].map(table =>
    [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}

test('account report seeks history by account without full scans or temporary sorts', t => {
  const db = initDB(':memory:')
  t.after(() => db.close())
  registry(db)
  decision(db, 'A', '2026-09-24 12:00:00', 'dispatch', 'proceed')
  const plans = []
  const prepare = db.prepare.bind(db)
  db.prepare = sql => {
    const statement = prepare(sql)
    if (!history.test(sql)) return statement
    return new Proxy(statement, {
      get(target, property) {
        const value = target[property]
        if (property !== 'all' && property !== 'get') return typeof value === 'function' ? value.bind(target) : value
        return (...args) => {
          plans.push({ sql, steps: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) })
          return value.apply(target, args)
        }
      },
    })
  }
  engineeringView(db)
  assert.ok(plans.some(p => /FROM decision_log/i.test(p.sql)))
  assert.ok(plans.some(p => /FROM risk_events/i.test(p.sql)))
  for (const { sql, steps } of plans) {
    assert.ok(steps.some(s => /SEARCH .*\(account_id=\?\)/.test(s.detail)), JSON.stringify({ sql, steps }))
    assert.ok(steps.every(s => !/SCAN |TEMP B-TREE/.test(s.detail)), JSON.stringify({ sql, steps }))
  }
})

test('latest decisions preserve timestamp ordering, ties, empty accounts and all retained evidence', t => {
  const db = initDB(':memory:')
  t.after(() => db.close())
  registry(db)
  const empty = engineeringView(db)
  decision(db, 'A', '2026-09-24 09:00:00', 'old')
  decision(db, 'A', '2026-09-24 10:00:00', 'first-tie')
  decision(db, 'A', '2026-09-24 10:00:00', 'second-tie', 'proceed')
  risk(db, 'A', '2026-09-24 10:00:00', 1)
  risk(db, 'B', '2026-09-24 11:00:00', 0)
  risk(db, 'B', '2026-09-24 11:00:00', 1)
  decision(db, 'B', '2026-09-24 10:00:00', 'older')
  // Preserve the existing text MAX ordering, including mixed timestamp forms.
  decision(db, 'C', '2026-09-24T08:00:00Z', 'iso')
  risk(db, 'C', '2026-09-24 22:00:00', 1)
  risk(db, 'D', '2026-09-24T12:00:00Z', 1)
  decision(db, null, '2099-01-01', 'unattributed')
  decision(db, 'not-in-registry', '2099-01-01', 'unregistered')
  risk(db, null, '2099-01-01', 1)
  risk(db, 'not-in-registry', '2099-01-01', 1)
  const before = retained(db)
  // The previous aggregate is an independent reference for exact tie parity.
  const previous = new Map()
  for (const r of db.prepare(`SELECT account_id,MAX(created_at) AS at,stage,decision
    FROM decision_log NOT INDEXED WHERE account_id IS NOT NULL GROUP BY account_id`).all()) {
    previous.set(r.account_id, { at: r.at, stage: r.stage, decision: r.decision })
  }
  for (const r of db.prepare(`SELECT account_id,MAX(created_at) AS at,approved
    FROM risk_events NOT INDEXED WHERE account_id IS NOT NULL GROUP BY account_id`).all()) {
    if (!previous.has(r.account_id) || r.at > previous.get(r.account_id).at) {
      previous.set(r.account_id, { at: r.at, stage: 'risk_gate', decision: r.approved ? 'approved' : 'veto' })
    }
  }
  const expected = {
    ...empty,
    accounts: empty.accounts.map(a => ({ ...a,
      lastDecisionAt: previous.get(a.accountId)?.at ?? null,
      lastDecisionStage: previous.get(a.accountId)?.stage ?? null,
      lastDecision: previous.get(a.accountId)?.decision ?? null,
    })),
  }
  assert.deepEqual(engineeringView(db), expected)
  assert.equal(previous.get('A').stage, 'first-tie')
  assert.equal(previous.get('B').decision, 'veto')
  assert.equal(previous.get('C').stage, 'iso')
  assert.equal(expected.accounts.find(a => a.accountId === 'G').lastDecisionAt, null)
  assert.deepEqual(retained(db), before)
})

test('history indexes upgrade a retained database idempotently without losing unattributed rows', t => {
  const dir = mkdtempSync(join(tmpdir(), 'account-history-upgrade-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'agent.db')
  let db = initDB(path)
  registry(db)
  for (const name of indexes) db.exec(`DROP INDEX IF EXISTS ${name}`)
  decision(db, 'A', '2026-09-24', 'dispatch', 'proceed')
  decision(db, null, '2026-09-23', 'legacy')
  risk(db, 'A', '2026-09-24', 1)
  risk(db, null, '2026-09-23', 0)
  const before = retained(db)
  const report = engineeringView(db)
  db.close()
  for (let pass = 0; pass < 2; pass++) {
    db = initDB(path)
    try {
      assert.deepEqual(retained(db), before)
      assert.deepEqual(engineeringView(db), report)
      for (const name of indexes) assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('index', name), name)
      assert.equal(db.pragma('synchronous', { simple: true }), 2)
      assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
    } finally { db.close() }
  }
})

test('risk history index is created after migration of the original accountless schema', t => {
  const dir = mkdtempSync(join(tmpdir(), 'accountless-risk-upgrade-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'agent.db')
  const old = new Database(path)
  old.exec(`CREATE TABLE risk_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, side TEXT, approved INTEGER,
    veto_reason TEXT, checks_json TEXT, proposal_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ); INSERT INTO risk_events(symbol,side,approved,created_at) VALUES ('EURUSD','long',0,'2026-09-20')`)
  old.close()
  const db = initDB(path)
  t.after(() => db.close())
  assert.deepEqual(db.prepare('SELECT id,symbol,side,approved,created_at,account_id FROM risk_events').all(),
    [{ id: 1, symbol: 'EURUSD', side: 'long', approved: 0, created_at: '2026-09-20', account_id: null }])
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_risk_events_account_latest'").get())
})
