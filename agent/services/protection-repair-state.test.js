import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { protectionFailure, repairFailures, recordRepairFailure, retainUnresolvedRepairs } from './protection-repair-state.js'
import { makeTargetApplier } from './tp-suggest.js'
import { runProtectionAudit } from './naked-position-guard.js'
import { restoreMissingTargets } from './target-restore.js'

test('broker bad-stops refusal is terminal; transport failures remain retryable', async () => {
  const refusal = new Error(JSON.stringify({ errorCode: 'TRADING_BAD_STOPS', description: 'TP below current BID' }))
  const apply = makeTargetApplier(null, { accountId: 'A' }, {
    readPosition: async () => ({ positionId: '7', stopLoss: 90, tradeData: { tradeSide: 'BUY' } }),
    amendPosition: async () => { throw refusal },
  })
  const result = await apply({ positionId: '7', brokerSl: 90 }, { tp: 115 })
  assert.equal(result.retryable, false)
  assert.equal(result.code, 'TRADING_BAD_STOPS')
  assert.equal(protectionFailure(new Error('socket timed out')).retryable, true)
})

test('JS transport formatted broker rejections retain their broker classification', async () => {
  for (const code of ['TRADING_BAD_STOPS', 'TRADING_BAD_VOLUME', 'POSITION_NOT_FOUND', 'POSITION_CLOSED']) {
    const apply = makeTargetApplier(null, { accountId: 'A' }, {
      readPosition: async () => ({ positionId: '7', stopLoss: 90, tradeData: { tradeSide: 'BUY' } }),
      amendPosition: async () => { throw new Error(`cTrader order rejected: ${code} — invalid request (positionId=7)`) },
    })
    const result = await apply({ positionId: '7', brokerSl: 90 }, { tp: 115 })
    assert.equal(result.code, code)
    assert.equal(result.retryable, false)
  }
  assert.equal(protectionFailure(new Error('socket timed out while checking TRADING_BAD_STOPS')).retryable, true)
  assert.equal(protectionFailure(new Error('cTrader order rejected: MARKET_CLOSED — closed')).retryable, true)
})

test('identical rejected target is not resubmitted after the retry window; audit retains the incident', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const row = { id: 1, account_id: 'A', symbol: 'BTCUSD', source: 'autopilot', ctrader_position_id: '7', current_sl: 90 }
  const positions = [{ positionId: '7', stopLoss: 90, tradeData: { tradeSide: 'BUY' } }]
  let attempts = 0
  const opts = { accountId: 'A', suggestTarget: async () => ({ tp: 115 }), applyTarget: async () => {
    attempts++; throw new Error('cTrader order rejected: TRADING_BAD_STOPS — TP below current BID')
  } }
  await runProtectionAudit(db, [row], positions, { ...opts, nowMs: 1000000 })
  await runProtectionAudit(db, [row], positions, { ...opts, nowMs: 1000000 + 7 * 3600000 })
  assert.equal(attempts, 1)
  assert.equal(repairFailures(db, 'A')['7'].retryable, false)
  assert.deepEqual(repairFailures(db, 'B'), {})
  // A missing broker row is uncertainty, not proof that protection was fixed.
  await runProtectionAudit(db, [row], [], { accountId: 'A' })
  assert.ok(repairFailures(db, 'A')['7'])
  await runProtectionAudit(db, [row], [{ ...positions[0], takeProfit: 130 }], { accountId: 'A' })
  assert.deepEqual(repairFailures(db, 'A'), {})
})

test('resolution is account-isolated and clears only the positions confirmed resolved', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const f = { positionId: '7', symbol: 'X' }
  for (const account of ['A', 'B']) recordRepairFailure(db, account, f, 115, protectionFailure({ errorCode: 'TRADING_BAD_STOPS' }))
  retainUnresolvedRepairs(db, 'A', [])
  assert.deepEqual(repairFailures(db, 'A'), {})
  assert.ok(repairFailures(db, 'B')['7'])
})

test('recorded-target restoration does not report a broker refusal as success or retry identical invalid prices', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const row = { id: 1, account_id: 'A', side: 'long', symbol: 'X', entry_price: 100, current_tp: 115 }
  const f = { positionId: '7', symbol: 'X', brokerSl: 90 }
  const rows = new Map([['7', row]])
  let attempts = 0
  const deps = { readPosition: async () => ({ positionId: '7', stopLoss: 90 }), amend: async () => {
    attempts++; return { rawError: '{"errorCode":"TRADING_BAD_STOPS"}' }
  } }
  const first = await restoreMissingTargets(db, { accountId: 'A' }, [f], rows, { ...deps, nowMs: 1000000 })
  assert.equal(first.restored, 0)
  assert.equal(first.errors.length, 1)
  const second = await restoreMissingTargets(db, { accountId: 'A' }, [f], rows, { ...deps, nowMs: 1000000 + 3600000 })
  assert.equal(attempts, 1)
  assert.match(second.skipped[0], /decision required/)
  row.current_tp = 125
  await restoreMissingTargets(db, { accountId: 'A' }, [f], rows, { ...deps, nowMs: 1000000 + 7200000 })
  assert.equal(attempts, 2, 'a changed recorded decision is not permanently blocked')
})
