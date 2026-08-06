// node --test agent/services/risk-effective.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { noteRiskConfigChanges } from './risk-config-history.js'
import { accountKnown, effectiveRiskEntries, unknownQueryParams } from './risk-effective.js'

const fresh = () => initDB(':memory:')

test('unknownQueryParams names exactly what the route cannot answer', () => {
  // THE AUDIT'S CASE. `?accountId=` looks right, is not, and used to return
  // the global config as though it described that account.
  assert.deepEqual(unknownQueryParams({ accountId: '47790949' }, ['account']), ['accountId'])
  assert.deepEqual(unknownQueryParams({ account: '47790949' }, ['account']), [])
  assert.deepEqual(unknownQueryParams({}, ['account']), [])
  assert.deepEqual(unknownQueryParams({ account: '1', acct: '2', days: '7' }, ['account']), ['acct', 'days'])
})

test('accountKnown tells an unknown id apart from an empty overlay', () => {
  const db = fresh()
  db.prepare("INSERT OR REPLACE INTO accounts (account_id, is_live, enabled) VALUES ('47790949', 0, 1)").run()
  assert.equal(accountKnown(db, '47790949'), true)
  assert.equal(accountKnown(db, '99999999'), false)
  assert.equal(accountKnown(db, null), null)
})

test('an overlaid key reports global, overlay and effective as three DIFFERENT facts', () => {
  // The whole finding in one row: the page said 1.5, the account traded 4.68.
  const db = fresh()
  setState(db, 'risk_config_json', JSON.stringify({ minRR: 1.5 }))
  setState(db, 'acct:47790949:risk_config_json', JSON.stringify({ minRR: 4.68 }))

  const rows = effectiveRiskEntries(db, '47790949', { keys: ['minRR'] })
  assert.equal(rows.length, 1)
  assert.deepEqual(
    { ...rows[0], writtenAt: rows[0].writtenAt },
    {
      key: 'minRR',
      globalValue: 1.5,
      overlayValue: 4.68,
      effectiveValue: 4.68,
      scope: 'account',
      accountId: '47790949',
      source: 'unknown',      // nothing recorded who wrote this overlay
      writtenAt: null,
      writtenBy: null,
      reason: null,
    },
  )
})

test('a key with NO overlay is scoped global, and its overlay value is null — not the effective one', () => {
  const db = fresh()
  setState(db, 'risk_config_json', JSON.stringify({ minRR: 1.5 }))
  const [row] = effectiveRiskEntries(db, '47790949', { keys: ['minRR'] })
  assert.equal(row.scope, 'global')
  assert.equal(row.overlayValue, null)
  assert.equal(row.accountId, null)
  assert.equal(row.effectiveValue, 1.5)
})

test('provenance is READ from the change history, per scope', () => {
  const db = fresh()
  setState(db, 'risk_config_json', JSON.stringify({ minRR: 1.5 }))
  setState(db, 'acct:46130058:risk_config_json', JSON.stringify({ minRR: 3 }))
  noteRiskConfigChanges(db, { minRR: 1.5 }, { minRR: 3 }, { accountId: '46130058', by: 'manual', at: '2026-08-06T06:16:00.000Z' })

  const [row] = effectiveRiskEntries(db, '46130058', { keys: ['minRR'] })
  assert.equal(row.source, 'manual')
  assert.equal(row.writtenAt, '2026-08-06T06:16:00.000Z')
  assert.equal(row.writtenBy, 'manual')
})

test('a controller write is distinguishable from an owner write', () => {
  // "Who moved a risk limit" is the question the audit asks and the reason a
  // controller must not be indistinguishable from a person.
  const db = fresh()
  noteRiskConfigChanges(db, { dailyLossPct: 0.03 }, { dailyLossPct: 0.02 }, { by: 'reassess', at: '2026-08-05T00:00:00.000Z' })
  const [row] = effectiveRiskEntries(db, null, { keys: ['dailyLossPct'] })
  assert.equal(row.source, 'controller')
  assert.equal(row.writtenBy, 'reassess')
})

test('an unrecognised writer stays "unknown" rather than being labelled plausibly', () => {
  const db = fresh()
  noteRiskConfigChanges(db, { minRR: 1.5 }, { minRR: 2 }, { by: 'some-future-thing' })
  const [row] = effectiveRiskEntries(db, null, { keys: ['minRR'] })
  assert.equal(row.source, 'unknown')
  assert.equal(row.writtenBy, 'some-future-thing', 'the raw label is still reported, just not classified')
})

test('reason is null everywhere, because nothing records one', () => {
  const db = fresh()
  const rows = effectiveRiskEntries(db, null)
  assert.ok(rows.length > 10)
  assert.ok(rows.every(r => r.reason === null))
})

test('every declared risk key gets a row by default', () => {
  const db = fresh()
  const rows = effectiveRiskEntries(db, null)
  const keys = new Set(rows.map(r => r.key))
  for (const k of ['minRR', 'perTradeRiskPct', 'dailyLossPct']) assert.ok(keys.has(k), `${k} missing`)
})
