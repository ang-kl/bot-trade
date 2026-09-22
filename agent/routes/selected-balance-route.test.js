import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'
import { invalidateStateCache } from '../lib/state-cache.js'
import { sizingPreview } from '../services/sizing-preview.js'

test('selected HTTP risk and sizing preview never substitute a foreign balance after switching', async t => {
  const db = initDB(':memory:')
  t.after(() => db.close())
  for (const id of ['11', '22']) db.prepare('INSERT INTO accounts (account_id) VALUES (?)').run(id)
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'acct:11:account_balance_usd', '1000')
  setState(db, 'account_balance_usd', '1000')
  setState(db, 'watchlist_json', JSON.stringify([{ symbol: 'EURUSD', enabled: true }]))
  setState(db, 'last_scan_results', JSON.stringify({ scans: [{ symbol: 'EURUSD', price: 1.1 }] }))
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const get = () => fetch(`http://127.0.0.1:${server.address().port}/state/risk-config`).then(r => r.json())
  assert.equal((await get()).derived.balance, 1000)
  setState(db, 'ctrader_account_id', '22')
  invalidateStateCache() // successful /actions writes use this same invalidation
  const missing = await get()
  assert.equal(missing.resolvedAccountId, '22')
  assert.equal(missing.derived.balance, null)
  assert.equal(missing.derived.per_trade_budget_usd, null)
  assert.equal(missing.derived.mode, 'absolute_fallback')
  const preview = sizingPreview(db)
  assert.equal(preview.balance, null)
  assert.equal(preview.budget, null)
  assert.equal(preview.rows[0].autoLots, null)
  setState(db, 'acct:22:account_balance_usd', '0')
  invalidateStateCache()
  const zero = await get()
  assert.equal(zero.resolvedAccountId, '22')
  assert.equal(zero.derived.balance, 0)
  assert.equal(zero.derived.per_trade_budget_usd, 0)
  assert.equal(sizingPreview(db).budget, 0)
})
