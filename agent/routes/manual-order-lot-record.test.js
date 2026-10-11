// node --test agent/routes/manual-order-lot-record.test.js
//
// Claude · № 13,172 11-Oct (ordered № 13,171 "resend the orders";
// claude-builder). POST /actions/manual-order records the broker's lot size
// and minimum BEFORE its gate, so the gate sizes in broker units and floors
// at the broker's own minimum.
//
// THE MEASUREMENT THIS EXISTS FOR (demo 47790949, 11-10-2026 08:10Z, the
// crypto live test's resend): DOTUSD, AVAXUSD, UNIUSD and XLMUSD were
// approved at 0.01 lots and refused by the route at the broker's 0.1-lot
// minimum; BCHUSD was refused `insufficient_equity` with one lot priced at
// $4,049,170 — the contract table's 100,000-unit FX default on a symbol the
// registry had never seen. XRPUSD went through in the first round only
// because its record already existed. The route had the broker's answer the
// whole time: it fetched it AFTER the gate, to send the order.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { evaluateTrade } from '../services/risk.js'
import { rememberVolumeMeta } from '../lib/lot-size-registry.js'

const ACCT = '47790949'

function fresh() {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, '1', 0, 1, 'active')`).run(ACCT)
  setState(db, `acct:${ACCT}:account_balance_usd`, '42854.57')
  return db
}

// The pad's proposal with no lots given: the route caps at 0.01 and the gate
// lifts that to the broker minimum it has on record (risk.js floorLots).
const pad = (symbol, entry, sl, tp1) => ({
  symbol, side: 'BUY', entry, sl, tp1, requestedVolume: 0.01,
  strategy: 'manual_order', direction_reason: 'manual:operator_chose_long', conviction: null, source: 'manual', accountId: ACCT,
})

test('DOTUSD: with no broker record the gate approves 0.01 lots (the route then refuses at the broker 0.1 minimum); with the record it floors at 0.1', () => {
  const db = fresh()
  const before = evaluateTrade(db, pad('DOTUSD', 1.2, 1.05, 1.65))
  assert.equal(before.approved, true, `veto: ${before.veto_reason}`)
  assert.equal(before.checks.units_per_lot.source, 'table')
  assert.equal(before.adjusted_volume, 0.01, 'the global assumed minimum — below what the broker accepts')
  // the broker's record: 1 lot = 100 DOT (lotSize 10,000 cents), smallest order 0.1 lot
  rememberVolumeMeta(db, 'DOTUSD', { lotSize: 10_000, minVolume: 1_000, stepVolume: 1_000 })
  const after = evaluateTrade(db, pad('DOTUSD', 1.2, 1.05, 1.65))
  assert.equal(after.approved, true, `veto: ${after.veto_reason}`)
  assert.equal(after.checks.units_per_lot.source, 'broker')
  assert.equal(after.checks.broker_min_lots, 0.1)
  assert.equal(after.adjusted_volume, 0.1, 'floored at the broker minimum, as XRPUSD was in the first round')
})

test('BCHUSD: with no broker record one lot is priced as 100,000 units and the budget buys nothing; with the record the order sizes', () => {
  const db = fresh()
  const before = evaluateTrade(db, pad('BCHUSD', 405, 364.5, 526.5))
  assert.equal(before.approved, false)
  assert.match(before.veto_reason, /^insufficient_equity min_lot=0\.01 computed=0 /)
  assert.match(before.veto_reason, /usd_per_lot=\$4050000\.00/, 'the contract table priced one lot at 100,000 × the $40.50 stop')
  rememberVolumeMeta(db, 'BCHUSD', { lotSize: 100, minVolume: 1, stepVolume: 1 }) // 1 lot = 1 BCH, min 0.01 lot
  const after = evaluateTrade(db, pad('BCHUSD', 405, 364.5, 526.5))
  assert.equal(after.approved, true, `veto: ${after.veto_reason}`)
  assert.equal(after.checks.units_per_lot.source, 'broker')
  assert.equal(after.adjusted_volume, 0.01)
})

// The route's ORDER of operations is what the fix is; the behaviour above
// already held once the record existed. Pin the sequence on the
// comment-stripped source (failure mode #2 of CLAUDE.md: a test can pass by
// matching its own comment).
test('the manual-order route fetches and records the broker lot record before the gate runs', () => {
  const src = readFileSync(new URL('./actions.js', import.meta.url), 'utf8')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  const start = src.indexOf("router.post('/manual-order'")
  assert.ok(start > 0)
  const handler = src.slice(start, src.indexOf('router.post(', start + 10))
  const fetched = handler.indexOf('await getVolumeMeta(')
  const recorded = handler.indexOf('rememberVolumeMeta(db, symbol, volMeta)')
  const gated = handler.indexOf('evaluateTrade(db, proposal')
  assert.ok(fetched > 0 && recorded > 0 && gated > 0, { fetched, recorded, gated })
  assert.ok(fetched < recorded && recorded < gated, `fetch ${fetched} → record ${recorded} → gate ${gated}`)
  assert.equal(handler.split('await getVolumeMeta(').length - 1, 1, 'one fetch, reused for the order below')
})
