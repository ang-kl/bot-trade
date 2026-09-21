import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { controllerRuntimeView } from './controller-runtime.js'
import { upsertAccount, setAccountEnabled } from './account-registry.js'

const nowMs = Date.parse('2026-09-21T10:00:00Z')
const at = new Date(nowMs).toISOString()

test('demo shadow never implies live shadow or tick entry', () => {
  const db = initDB(':memory:')
  setState(db, 'cpp_exec_demo_tick_json', JSON.stringify({ at, status: { enabled: true, state: 'RECORDING', strategy: { shadow: true }, entry: { accounts: 0 } } }))
  setState(db, 'cpp_exec_tick_json', JSON.stringify({ at, status: { enabled: false } }))
  const { sides } = controllerRuntimeView(db, { nowMs })
  assert.equal(sides[0].shadow, true)
  assert.equal(sides[0].entryAccounts, 0)
  assert.equal(sides[1].shadow, false)
  assert.equal(sides[1].tickBlock, 'unavailable')
  assert.match(sides[1].reason, /TICK_SPOOL_PATH/)
  assert.equal(sides[1].trail, null)
  db.close()
})

test('stale, future or absent readings cannot claim currently running', () => {
  for (const time of [nowMs - 600_001, nowMs + 1, null]) {
    const db = initDB(':memory:')
    const recordedAt = time == null ? null : new Date(time).toISOString()
    setState(db, 'cpp_exec_tick_json', JSON.stringify({ at: recordedAt, status: { enabled: true, strategy: { shadow: true }, entry: { accounts: 3 } } }))
    setState(db, 'cpp_exec_health_json', JSON.stringify({ at: recordedAt, connected: true, trail: { tracked: 3 }, spotFeed: { connected: true } }))
    const live = controllerRuntimeView(db, { nowMs }).sides[1]
    assert.equal(live.shadow, null)
    assert.equal(live.entryAccounts, null)
    assert.equal(live.feedConnected, null)
    assert.equal(live.trail, null)
    db.close()
  }
})

test('runtime reports effective pipeline permission separately from tick validation', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  upsertAccount(db, { accountId: '11' })
  setAccountEnabled(db, '11', true, 'active')
  setState(db, 'autotrade_enabled', 'true')
  setState(db, 'acct:11:scan_enabled', 'false')
  const account = controllerRuntimeView(db, { nowMs }).accounts[0]
  assert.equal(account.entryReady, false, 'no validated tick profile')
  assert.equal(account.phases.autotrade, true, 'tick readiness is not the scheduled-entry master switch')
  assert.equal(account.phases.scan, false)
  assert.equal(account.phases.source.scan, 'account')
})
