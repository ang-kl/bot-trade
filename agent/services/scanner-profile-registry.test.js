import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState, getState } from '../db.js'
import { DEFAULT_PARAMS, profileHash } from '../lib/tick-strategy.js'
import { nativeProfileHash } from './scanner-profiles.js'
import { scannerProfileRegistry, registerScannerProfiles } from './scanner-profile-registry.js'
import actionsRouter from '../routes/actions.js'
import { tierAuthorizes } from '../lib/auth-tiers.js'
const feed = { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '7' }
const profile = () => ({ source: 'cpp-scan-tick', feed, strategy: 'tick_momentum_breakout', configVersion: 'v1', candidateTtlMs: 60000, profile: { ...DEFAULT_PARAMS }, profileHash: profileHash(DEFAULT_PARAMS) })
function fixture(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES(11,0)').run()
  setState(db, 'symbol_id_map:11', JSON.stringify({ map: { EURUSD: 7 } }))
  return db
}
test('registration compares revisions, retains exact settings and audits without entry authority', t => {
  const db = fixture(t), initial = scannerProfileRegistry(db), p = profile(), tradingBefore = getState(db, 'autotrade_enabled')
  const next = registerScannerProfiles(db, { expectedRevision: initial.revision, profiles: [p] }, { env: {} })
  assert.equal(next.profiles[0].profileHash, p.profileHash); assert.equal(next.orderAuthority, false)
  assert.throws(() => registerScannerProfiles(db, { expectedRevision: initial.revision, profiles: [] }, { env: {} }), /revision_conflict/)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM action_log WHERE method='AUDIT' AND path='/actions/scanner-profiles'").get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entry_intents').get().n, 0)
  assert.equal(getState(db, 'autotrade_enabled'), tradingBefore)
})
test('wrong account/symbol/host, arbitrary hashes, extra fields, unsafe numbers and duplicate identities fail atomically', t => {
  const db = fixture(t), p = profile(), expectedRevision = scannerProfileRegistry(db).revision
  const invalid = [{ ...p, feed: { ...feed, accountId: '22' } }, { ...p, feed: { ...feed, symbolId: '8' } }, { ...p, feed: { ...feed, host: 'live.ctraderapi.com' } }, { ...p, profileHash: 'invented' }, { ...p, secret: 'forbidden' }, { ...p, profile: { ...p.profile, rangeEvents: 100000 } }, { ...p, profile: { ...p.profile, momentumEvents: NaN } }]
  for (const bad of invalid) assert.throws(() => registerScannerProfiles(db, { expectedRevision, profiles: [bad] }, { env: {} }))
  assert.throws(() => registerScannerProfiles(db, { expectedRevision, profiles: [p,p] }, { env: {} }), /duplicate/)
  assert.throws(() => registerScannerProfiles(db, { expectedRevision, profiles: [p] }, { env: { SCANNER_BRIDGE_ENABLED: '1' } }), /stop_observation_bridge/)
  assert.equal(scannerProfileRegistry(db).revision, expectedRevision)
})
test('timeframe profiles require exact implemented options and configuration hashes', t => {
  const db = fixture(t), options = { pendingSetup: true, requireStack: false, minSlAtr: 0.8, maxSlAtr: 3, timeCapMinutes: 120 }
  const p = { source: 'cpp-scan-timeframe', feed, strategy: 'ema_pullback', timeframe: '1h', options, configVersion: 'reviewed-v1', candidateTtlMs: 60000, profileHash: nativeProfileHash('ema_pullback', options) }
  const expectedRevision = scannerProfileRegistry(db).revision
  assert.throws(() => registerScannerProfiles(db, { expectedRevision, profiles: [{ ...p, options: {} }] }, { env: {} }), /mismatched/)
  assert.equal(registerScannerProfiles(db, { expectedRevision, profiles: [p] }, { env: {} }).profiles.length, 1)
})
test('operator route is reachable through actions; read tier cannot register; full tier round-trip works', async t => {
  const db = fixture(t), app = express(); app.use(express.json())
  app.use((req,res,next) => tierAuthorizes(req.headers['x-test-tier'], req.method) ? next() : res.sendStatus(403))
  app.use('/actions', actionsRouter(db, { scannerProfiles: { env: {} } }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) }); t.after(() => new Promise(r => server.close(r)))
  const url = `http://127.0.0.1:${server.address().port}/actions/scanner-profiles`
  const initial = await (await fetch(url, { headers: { 'x-test-tier': 'read' } })).json()
  const body = JSON.stringify({ expectedRevision: initial.revision, profiles: [profile()] })
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-tier': 'read' }, body })).status, 403)
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-tier': 'full' }, body })
  assert.equal(response.status, 200)
  const output = await response.json(); assert.equal(output.profiles.length, 1)
  assert.deepEqual(await (await fetch(url, { headers: { 'x-test-tier': 'read' } })).json(), output)
})
