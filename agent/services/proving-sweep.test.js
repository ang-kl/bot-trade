// node --test agent/services/proving-sweep.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import { pickUnprovenStrategy, runProvingSweep } from './proving-sweep.js'

function armAll(db, keys) {
  setState(db, 'enabled_strategies_json', JSON.stringify(keys))
}

test('pickUnprovenStrategy: armed strategy with no baseline and no fresh attempt', () => {
  const db = initDB(':memory:')
  armAll(db, ['fib_618_fade', 'vwap_trend'])
  setState(db, 'backtest_baselines_json', JSON.stringify({ fib_618_fade: { combos: [] } }))
  assert.equal(pickUnprovenStrategy(db), 'vwap_trend')
  // a fresh attempt suppresses re-pick for a day
  setState(db, 'proving_attempts_json', JSON.stringify({ vwap_trend: Date.now() }))
  assert.equal(pickUnprovenStrategy(db), null)
  // …but an attempt older than a day re-qualifies
  setState(db, 'proving_attempts_json', JSON.stringify({ vwap_trend: Date.now() - 90_000_000 }))
  assert.equal(pickUnprovenStrategy(db), 'vwap_trend')
})

test('runProvingSweep: queues a self-call backtest and stamps the attempt', async () => {
  const db = initDB(':memory:')
  armAll(db, ['vwap_trend'])
  const calls = []
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization }); return { ok: true } }
  const out = await runProvingSweep(db, { fetchImpl, port: '3001', secret: 's3cret' })
  assert.equal(out.queued, 'vwap_trend')
  assert.equal(calls[0].url, 'http://127.0.0.1:3001/actions/backtest')
  assert.equal(calls[0].body.strategy, 'vwap_trend')
  assert.equal(calls[0].auth, 'Bearer s3cret')
  const attempts = JSON.parse(getState(db, 'proving_attempts_json'))
  assert.ok(attempts.vwap_trend > 0, 'attempt stamped')
  // immediate re-run: nothing to queue (attempt is fresh)
  const again = await runProvingSweep(db, { fetchImpl, port: '3001', secret: 's3cret' })
  assert.equal(again.queued, null)
})

test('runProvingSweep: missing secret or failing call degrade gracefully', async () => {
  const db = initDB(':memory:')
  armAll(db, ['vwap_trend'])
  const noSecret = await runProvingSweep(db, { fetchImpl: async () => ({ ok: true }), secret: '' })
  assert.equal(noSecret.reason, 'no_secret')
  const failing = await runProvingSweep(db, { fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }), secret: 's' })
  assert.equal(failing.queued, null)
  assert.match(failing.reason, /backtest_call_500/)
})
