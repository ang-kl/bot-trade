import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { auditDecisions } from './decision-audit.js'
import { fxDayStartSql } from './risk.js'

test('actual decision-audit aggregates seek the FX day while retaining mixed timestamp and account semantics', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const boundary = fxDayStartSql()
  const startMs = Date.parse(boundary.replace(' ', 'T') + 'Z')
  const stamps = [
    new Date(startMs - 1).toISOString(),
    new Date(startMs - 1000).toISOString().slice(0, 19).replace('T', ' '),
    boundary,
    new Date(startMs).toISOString(),
    new Date(startMs + 60000).toISOString(),
    new Date(startMs + 86400_000).toISOString(),
  ]
  const decision = db.prepare('INSERT INTO decision_log(account_id,stage,decision,reason,created_at) VALUES (?,?,?,?,?)')
  const gate = db.prepare('INSERT INTO risk_events(account_id,symbol,side,approved,veto_reason,created_at) VALUES (?,?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < 6000; i++) {
      decision.run('11', 'scope', 'skip', 'historical', '2020-01-01 00:00:00')
      gate.run('11', 'EURUSD', 'buy', 0, 'historical', '2020-01-01T00:00:00.000Z')
    }
    for (const account of ['11', '22', null]) for (const at of stamps) {
      decision.run(account, 'scope', 'skip', 'current', at)
      gate.run(account, 'EURUSD', 'buy', 0, 'current', at)
    }
  })()
  db.exec('ANALYZE')
  for (const accountId of [null, '11', '22']) {
    const plans = []
    const measured = { prepare(sql) {
      const statement = db.prepare(sql)
      if (/GROUP BY/.test(sql) && /FROM (decision_log|risk_events)/.test(sql)) {
        return { all(...args) {
          plans.push(db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(r => r.detail).join('\n'))
          return statement.all(...args)
        } }
      }
      return statement
    } }
    const report = auditDecisions(measured, { accountId, now: new Date(startMs + 120000) })
    const expected = accountId == null ? 12 : 8
    assert.equal(report.vetoed, expected)
    assert.equal(report.vetoedDistinct, expected)
    assert.deepEqual(report.topVetoes, [{ key: 'current', n: expected }])
    assert.deepEqual(report.topSkipStages, [{ key: 'scope:current', n: expected }])
    assert.equal(plans.length, 2)
    assert.ok(plans.every(p => /SEARCH .* USING INDEX idx_(decision_log|risk_events)_at \(created_at>\?\)/.test(p)), plans.join('\n'))
  }
})
