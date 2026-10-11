// node --test agent/routes/manual-order-strategy-gate.test.js
//
// Claude · № 13,126 11-Oct (ordered № 13,125; claude-builder). The order
// pad's proposal reaches the risk gate with the strategy the trader chose,
// not the literal 'manual'. Measured 11-10 on demo 47790949: ten pad orders
// carrying registry keys were judged as a strategy with no prior and no
// record (`earned_floor_denied: thin_sample 0<9`) on an account whose prior
// report read 12 strategies with priors, so the earned floor and the stretch
// — the bridge between the registry's 2R designs and the 3.0 floor — could
// never apply to a pad order. The route is not injectable (broker price,
// sizing and send), so this pins the proposal's field comment-stripped, the
// way manual-order-plan.test.js pins the ledger write; the gate's own
// behaviour per strategy is pinned by rrFloorVerdict below.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { manualOrderStrategy, MANUAL_ORDER_STRATEGY } from './actions.js'
import { rrFloorVerdict, DEFAULT_RISK_CONFIG } from '../services/risk.js'

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function manualRoute() {
  const src = strip(readFileSync(new URL('./actions.js', import.meta.url), 'utf8'))
  const start = src.indexOf("router.post('/manual-order'")
  const end = src.indexOf('\n  router.', start + 1)
  assert.ok(start > 0 && end > start, 'route found')
  return src.slice(start, end)
}

test('the pad proposal carries the validated strategy key, never the literal manual (comment-stripped pin)', () => {
  const route = manualRoute()
  const p0 = route.indexOf('const proposal = {')
  assert.ok(p0 > 0, 'proposal found')
  const proposal = route.slice(p0, route.indexOf('\n      }', p0))
  assert.ok(/\n\s*strategy,\n/.test(proposal), 'the proposal field is the validated `strategy` variable')
  assert.ok(!/strategy:\s*'manual'/.test(proposal), "no literal strategy: 'manual' in the proposal")
  assert.ok(!/strategy:\s*'manual'/.test(route), 'no literal strategy: manual anywhere in the route (the bracket-gap advice reads the same key)')
  assert.ok(route.includes('const strategy = manualOrderStrategy(rawStrategy)'), 'the key is validated against the registry first')
})

test('the gate reads the pad key: a registry strategy with a prior is judged on it, manual_order stays a thin sample', () => {
  const db = initDB(':memory:')
  const ACCT = '47790949'
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, '1', 0, 1, 'active')`).run(ACCT)
  // a sweep prior exists for vwap_trend, none for manual_order
  setState(db, 'autopilot_strategy_prior_json', JSON.stringify({ vwap_trend: { winRatePct: 60, trades: 500, combos: 20 } }))
  const config = { ...DEFAULT_RISK_CONFIG }
  const args = { rr: 2, accountId: ACCT, config, entry: 1.2, sl: 1.1, tp1: 1.4, side: 'BUY' }
  const viaKey = rrFloorVerdict(db, { ...args, strategy: 'vwap_trend' })
  assert.equal(viaKey.ok, true, `a 2R vwap_trend proposal is admitted via its prior: ${viaKey.reason}`)
  assert.equal(viaKey.checks.earned_floor?.via, 'prior')
  const viaManual = rrFloorVerdict(db, { ...args, strategy: manualOrderStrategy(null) })
  assert.equal(viaManual.ok, false)
  assert.match(viaManual.reason, /^bad_rr 2\.00<3/)
  assert.match(String(viaManual.checks.earned_floor_denied), /^thin_sample 0</)
  assert.equal(manualOrderStrategy(null), MANUAL_ORDER_STRATEGY)
})
