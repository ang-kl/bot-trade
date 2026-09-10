// 03-09-2026: /actions/order-cancel and /actions/queued-cancel always built
// their broker call from the PRIMARY account's credentials, so a resting
// order on any other account could not be cancelled from the agent at all —
// the mis-priced ACCT-LIVE-1 limit (order 386180672) had to be cancelled by
// hand in cTrader. Both routes now resolve the ORDER's account.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { credsForAccountId } from './actions.js'

function seeded() {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', '42')
  setState(db, 'ctrader_is_live', 'false')
  setState(db, 'ctrader_access_token', 'tok')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('42','1',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('43','2',1,1,'active')`).run()
  return db
}

test('credsForAccountId: the named account on its own side; null or unknown → the primary', () => {
  const db = seeded()
  const live = credsForAccountId(db, '43')
  assert.equal(live.accountId, '43')
  assert.equal(live.isLive, true)
  assert.equal(live.host, 'live.ctraderapi.com')
  const demo = credsForAccountId(db, 42)
  assert.equal(demo.accountId, '42')
  assert.equal(demo.isLive, false)
  assert.equal(credsForAccountId(db, null).accountId, '42')
  assert.equal(credsForAccountId(db, '').accountId, '42')
  assert.equal(credsForAccountId(db, '99').accountId, '42', 'an id the registry does not know falls back to the primary, as before')
})

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const routeBody = (src, path) => {
  const start = src.indexOf(`router.post('${path}'`)
  const end = src.indexOf('\n  router.', start + 1)
  assert.ok(start > 0 && end > start, `${path} route found`)
  return src.slice(start, end)
}

test('both cancel routes resolve the ORDER\'s account, and neither builds its cancel from the primary any more', () => {
  const src = strip(readFileSync(new URL('./actions.js', import.meta.url), 'utf8'))
  const oc = routeBody(src, '/order-cancel')
  assert.ok(oc.includes('SELECT account_id FROM pending_orders WHERE order_id = ?'), 'the ledger row names the account')
  assert.ok(oc.includes('credsForAccountId(db, req.body?.account ?? ledgerRow?.account_id ?? null)'))
  assert.ok(!oc.includes('getCtraderCreds(db)'), 'no primary-only cancel left in /order-cancel')
  const qc = routeBody(src, '/queued-cancel')
  assert.ok(qc.includes('credsForAccountId(db, row.account_id)'))
  assert.ok(!qc.includes('getCtraderCreds(db)'), 'no primary-only cancel left in /queued-cancel')
})

test('manual-order and position-close take the ORDER\'s account too (owner: "use ACCT-DEMO-2"), and manual-order resolves the id per account', () => {
  const src = strip(readFileSync(new URL('./actions.js', import.meta.url), 'utf8'))
  const mo = routeBody(src, '/manual-order')
  assert.ok(mo.includes("const creds = credsForAccountId(db, account, { producerId: 'route_manual_order' })"), 'the ORDER\'s account, and (P1b) the route names itself to the entry fence')
  assert.ok(mo.includes('await resolveSymbolId(db, creds, symbol)'), 'the account\'s own symbol id, never the shared map')
  assert.ok(!mo.includes('ensureSymbolMap(db, creds)'), 'the shared-map lookup is gone from /manual-order')
  assert.ok(mo.includes("is not in the registry"), 'an unknown account is refused, not routed to the primary')
  assert.ok(mo.includes("origin, origin_source, account_id)"), 'the trade row is stamped with the account')
  const pc = routeBody(src, '/position-close')
  assert.ok(pc.includes('credsForAccountId(db, req.body?.account)'))
  assert.ok(!pc.includes('getCtraderCreds(db)'))
})
