// node --test agent/services/stop-side-gate.test.js
//
// Claude · № 13,254 11-Oct (owner "You decide" on the finding of № 13,243;
// claude-builder). The gate refuses a stop on the wrong side of the entry.
//
// THE MEASUREMENT (demo 47790949, 11-10-2026 10:46Z): UNIUSD's weekly
// vwap_trend long carried a stop of 7.763 with the price at 7.507. The gate
// measured |entry − sl| = 0.256 as the stop, read a 15.8R target and
// approved a stale signal whose price had already fallen through its stop.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { evaluateTrade } from './risk.js'

const ACCT = '47790949'
function fresh() {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, '1', 0, 1, 'active')`).run(ACCT)
  setState(db, `acct:${ACCT}:account_balance_usd`, '42854.57')
  return db
}
const proposal = (side, entry, sl, tp1) => ({
  symbol: 'EURUSD', side, entry, sl, tp1, requestedVolume: 0.01, requestedVolumeDefault: true,
  strategy: 'manual_order', direction_reason: 'test', conviction: null, source: 'manual', accountId: ACCT,
})

test('a long whose stop is above the entry is refused by name (the UNIUSD case)', () => {
  for (const side of ['BUY', 'long', 'buy']) {
    const r = evaluateTrade(fresh(), proposal(side, 7.507, 7.763, 11.55))
    assert.equal(r.approved, false, side)
    assert.equal(r.veto_reason, 'sl_wrong_side: long stop 7.763 is above the entry 7.507', side)
  }
})

test('a short whose stop is below the entry is refused by name', () => {
  for (const side of ['SELL', 'short', 'sell']) {
    const r = evaluateTrade(fresh(), proposal(side, 1.1, 1.09, 1.05))
    assert.equal(r.approved, false, side)
    assert.equal(r.veto_reason, 'sl_wrong_side: short stop 1.09 is below the entry 1.1', side)
  }
})

test('stops on the right side are not refused by this check; a stop at the entry keeps sl_at_entry', () => {
  const long = evaluateTrade(fresh(), proposal('BUY', 1.1, 1.09, 1.14))
  assert.equal(String(long.veto_reason ?? '').startsWith('sl_wrong_side'), false, long.veto_reason)
  const short = evaluateTrade(fresh(), proposal('SELL', 1.1, 1.11, 1.06))
  assert.equal(String(short.veto_reason ?? '').startsWith('sl_wrong_side'), false, short.veto_reason)
  const at = evaluateTrade(fresh(), proposal('BUY', 1.1, 1.1, 1.14))
  assert.equal(at.veto_reason, 'sl_at_entry')
})

test('a side the gate does not recognise is not judged by this check', () => {
  const r = evaluateTrade(fresh(), proposal('HOLD', 1.1, 1.2, 1.3))
  assert.equal(String(r.veto_reason ?? '').startsWith('sl_wrong_side'), false, r.veto_reason)
})
