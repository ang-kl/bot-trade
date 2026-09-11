// node --test agent/routes/position-reverse-leg-two.test.js
//
// WHOLE-PLAN AUDIT 11-09-2026 (plan §13, TM-39): the opening leg of a manual
// reverse is new risk and must see the guard of THIS instant, not the
// snapshot taken before the close. legTwoCreds() rebuilds the credentials
// after the close; a halt raised in between refuses the leg (and the route's
// half-done alarm fires, because the account is flat). The route pin is
// comment-stripped.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { legTwoCreds } from './actions.js'

const ACCT = '46130058'
function db() {
  const d = initDB(':memory:')
  d.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)').run(ACCT, 0, 1, 'active', '5203012')
  setState(d, 'ctrader_access_token', 'tok'); setState(d, 'ctrader_account_id', ACCT)
  process.env.cTrader_ClientID = 'cid'; process.env.cTrader_Secret = 'sec'
  return d
}

test('a halt raised between the legs refuses the opening leg; a per-account halt too; a clear guard admits it with fresh creds', () => {
  const d = db()
  const ok = legTwoCreds(d, ACCT, { producerId: 'route_position_reverse', volume: 1000 })
  assert.equal(ok.ok, true); assert.equal(String(ok.creds.accountId), ACCT); assert.equal(ok.creds.producerId, 'route_position_reverse')
  setState(d, 'exec_guard_json', JSON.stringify({ halt: true }))
  const halted = legTwoCreds(d, ACCT, { producerId: 'route_position_reverse', volume: 1000 })
  assert.equal(halted.ok, false); assert.match(halted.reason, /guard_halt/)
  // RACE CHECKER 11-09-2026: the stored JSON never names a halted account —
  // the per-account halt is DERIVED from the equity stop's trip stamp, so
  // that is what the test trips (the same input production sees).
  setState(d, 'exec_guard_json', JSON.stringify({ halt: false }))
  setState(d, `acct:${ACCT}:equity_stop_tripped_at`, new Date().toISOString())
  const acct = legTwoCreds(d, ACCT, { producerId: 'route_position_reverse', volume: 1000 })
  assert.equal(acct.ok, false); assert.match(acct.reason, /guard_halt_account: 0058/)
  setState(d, `acct:${ACCT}:equity_stop_tripped_at`, null)
  assert.equal(legTwoCreds(d, ACCT, { producerId: 'route_position_reverse', volume: 1000 }).ok, true, 'the trip cleared → admitted again')
  setState(d, 'exec_guard_json', JSON.stringify({ halt: false, maxOrderVolume: 500 }))
  const big = legTwoCreds(d, ACCT, { producerId: 'route_position_reverse', volume: 1000 })
  assert.equal(big.ok, false); assert.match(big.reason, /guard_volume_cap/)
})

test('the reverse route rebuilds the credentials AFTER the close and sends the opening leg with them (comment-stripped pin)', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const src = strip(readFileSync(new URL('./actions.js', import.meta.url), 'utf8'))
  const route = src.slice(src.indexOf("router.post('/position-reverse'"))
  const close = route.indexOf('await execClosePosition(creds')
  const leg = route.indexOf('legTwoCreds(db, String(local?.account_id ?? creds.accountId)')
  const place = route.indexOf('await execPlaceOrder(legTwo.creds')
  assert.ok(close > 0 && leg > close && place > leg, 'close → fresh creds → open, in that order')
  assert.ok(!route.slice(leg, place).includes('await execPlaceOrder(creds'), 'the stale creds never place the opening leg')
})
