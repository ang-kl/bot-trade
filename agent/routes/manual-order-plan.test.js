// node --test agent/routes/manual-order-plan.test.js
//
// PR-E (owner principle 4, 11-09-2026): POST /actions/manual-order — the
// order pad's only live entry button — was the sole entry path that wrote
// no `strategy`, no `risk_event_id` and no `trade_plans` row. Its ledger
// write is now recordManualOrderTrade(), exercised here against an
// in-memory database (the route itself needs a broker for the price fetch,
// the sizing and the send, none of which are injectable), and the route is
// pinned — comment-stripped — to capture the approval id and call it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB } from '../db.js'
import { recordManualOrderTrade, MANUAL_ORDER_STRATEGY, manualOrderStrategy, manualDirectionReason } from './actions.js'
import { STRATEGY_KEYS } from '../services/strategies.js'
import { persistRiskEvent } from '../services/risk.js'
import { encodeLabel, LABEL_VERSION } from '../lib/trade-labels.js'
import { findUnreasonedTrades } from '../services/close-completeness.js'

const ACCT = '46130058'
function seeded() {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, '1', 0, 1, 'active')`).run(ACCT)
  return db
}
const label = (strategy) => encodeLabel({ source: 'manual', version: LABEL_VERSION, strategy, conviction: null, session: 'LDN' })

test('a manual order writes a trade with strategy, the approval id and a plan row (plus its monitored row) — the order as entered is the plan', () => {
  const db = seeded()
  const proposal = { symbol: 'EURUSD', side: 'BUY', entry: 1.1000, sl: 1.0950, tp1: 1.1100, requestedVolume: 0.5, strategy: 'manual', source: 'manual', accountId: ACCT }
  const riskEventId = persistRiskEvent(db, proposal, { approved: true, adjusted_volume: 0.5, checks: {} })
  assert.ok(Number(riskEventId) > 0, 'the approval produced a row id')
  const tradeId = recordManualOrderTrade(db, {
    symbol: 'EURUSD', side: 'BUY', entryP: 1.1002, entryEstimate: 1.1000, sl: 1.0950, tp: 1.1100, volLots: 0.5, positionId: '9001',
    structuredLabel: label('va_breakout'), accountId: ACCT, strategy: 'va_breakout', riskEventId,
  })
  const t = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId)
  assert.equal(t.strategy, 'va_breakout')
  assert.equal(t.risk_event_id, riskEventId)
  assert.equal(t.origin, 'manual_broker'); assert.equal(t.origin_source, 'write'); assert.equal(t.account_id, ACCT)
  assert.equal(t.ctrader_position_id, '9001'); assert.equal(t.entry_price, 1.1002); assert.equal(t.status, 'open')
  const p = db.prepare('SELECT * FROM trade_plans WHERE trade_id = ?').get(tradeId)
  assert.ok(p, 'a trade_plans row exists')
  assert.equal(p.strategy, 'va_breakout'); assert.equal(p.source, 'manual_order'); assert.equal(p.account_id, ACCT)
  assert.equal(p.planned_entry, 1.1, 'the plan is the estimate the gate sized on, not the fill')
  assert.equal(p.planned_sl, 1.095); assert.equal(p.planned_tp, 1.11); assert.equal(p.planned_r, 2)
  const m = db.prepare('SELECT * FROM monitored_positions WHERE trade_id = ?').get(tradeId)
  assert.equal(m.strategy, 'va_breakout'); assert.equal(m.status, 'active'); assert.equal(m.account_id, ACCT)
})

test('strategy is never null: with none requested the row carries manual_order, and the reasons invariant is not tripped by the manual path', () => {
  const db = seeded()
  const tradeId = recordManualOrderTrade(db, {
    symbol: 'XAUUSD', side: 'SELL', entryP: 2400, sl: 2410, tp: null, volLots: 0.1, positionId: '9002',
    structuredLabel: label('manual_order'), accountId: ACCT, strategy: '', riskEventId: 5,
  })
  const t = db.prepare('SELECT strategy, risk_event_id, tp_price FROM trades WHERE id = ?').get(tradeId)
  assert.equal(t.strategy, MANUAL_ORDER_STRATEGY); assert.equal(t.risk_event_id, 5); assert.equal(t.tp_price, null)
  const p = db.prepare('SELECT strategy, planned_tp, planned_r FROM trade_plans WHERE trade_id = ?').get(tradeId)
  assert.equal(p.strategy, MANUAL_ORDER_STRATEGY); assert.equal(p.planned_tp, null); assert.equal(p.planned_r, null)
  // manual_broker is outside the clean-bot population by design
  assert.equal(findUnreasonedTrades(db, { now: Date.now() }).counts.total, 0)
})

test('the route captures the approval id and hands strategy + riskEventId to the ledger write (comment-stripped pin)', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const src = strip(readFileSync(new URL('./actions.js', import.meta.url), 'utf8'))
  const start = src.indexOf("router.post('/manual-order'")
  const end = src.indexOf('\n  router.', start + 1)
  assert.ok(start > 0 && end > start, 'route found')
  const route = src.slice(start, end)
  assert.ok(route.includes('const riskEventId = persistRiskEvent(db, proposal, riskResult)'), 'the approval id is captured, not discarded')
  assert.ok(route.includes('const strategy = manualOrderStrategy(rawStrategy)'), 'the strategy is validated against the registry, never null (m3)')
  const rs = src.slice(src.indexOf("router.post('/entry-intents/:id/resolve'"))
  assert.ok(rs.slice(0, rs.indexOf('\n  router.')).includes('positionId: positionId ?? null'), 'an operator FILLED may carry the position id (m1)')
  const call = route.indexOf('recordManualOrderTrade(db, {')
  assert.ok(call > 0, 'the route calls the ledger write')
  const args = route.slice(call, route.indexOf('})', call))
  assert.ok(/\bstrategy\b/.test(args) && /\briskEventId\b/.test(args), 'strategy and riskEventId are passed')
  assert.ok(!route.includes('INSERT INTO trades'), 'no second, plan-less trade insert remains in the route')
})

test('m3: only a registry key is recorded as the strategy; anything else is manual_order', () => {
  assert.ok(STRATEGY_KEYS.includes('va_breakout'))
  assert.equal(manualOrderStrategy('va_breakout'), 'va_breakout')
  assert.equal(manualOrderStrategy(' va_breakout '), 'va_breakout')
  assert.equal(manualOrderStrategy('Value-Area Breakout'), MANUAL_ORDER_STRATEGY)
  assert.equal(manualOrderStrategy('manual'), MANUAL_ORDER_STRATEGY)
  assert.equal(manualOrderStrategy(''), MANUAL_ORDER_STRATEGY)
  assert.equal(manualOrderStrategy(null), MANUAL_ORDER_STRATEGY)
  assert.equal(manualOrderStrategy({ toString: () => 'va_breakout' }), 'va_breakout')
})

// ---------------------------------------------------------------------------
// PR-AL (owner principle 8). Every other entry path reads its direction
// reason off the signal that chose the side. The manual pad has no signal —
// a human chose it — so it states that, and states it as a fact rather than
// inferring one. The reason is what makes a manual position completable:
// `direction_reason` is a required field of position_history, so without it
// every manual entry is refused into the incomplete stream permanently.
// ---------------------------------------------------------------------------
test('PR-AL: a manual order states an operator reason, and prefers the trader\'s words', () => {
  assert.equal(manualDirectionReason(null, 'SELL'), 'manual:operator_chose_short')
  assert.equal(manualDirectionReason('', 'BUY'), 'manual:operator_chose_long')
  assert.equal(manualDirectionReason('   ', 'buy'), 'manual:operator_chose_long')
  // the trader's own words win, normalised and prefixed so no attribution
  // query can mistake them for a strategy's reading
  assert.equal(manualDirectionReason('earnings  gap\nfade', 'SELL'), 'manual:earnings gap fade')
  // operator input landing in proposal_json is length-bounded
  assert.equal(manualDirectionReason('x'.repeat(500), 'BUY').length, 'manual:'.length + 120)
})

test('PR-AL: the manual route and its sibling route proposal carry direction_reason (comment-stripped pin)', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const src = strip(readFileSync(new URL('./actions.js', import.meta.url), 'utf8'))
  const start = src.indexOf("router.post('/manual-order'")
  const route = src.slice(start, src.indexOf('\n  router.', start + 1))
  assert.ok(route.includes('direction_reason: manualDirectionReason(rawDirectionReason, side)'),
    'the manual proposal states its own reason')
  // /actions/execute-trade builds its proposal from a STORED analysis whose
  // synthesis already carries one — it must not drop it on the way to the
  // gate. (Its proposal's own `source` is 'execute_analysis'.)
  const ea = src.indexOf("router.post('/execute-trade'")
  assert.ok(ea > 0, 'execute-trade route found')
  const eaRoute = src.slice(ea, src.indexOf('\n  router.', ea + 1))
  assert.ok(eaRoute.includes("source: 'execute_analysis'"), 'the right proposal is in view')
  assert.ok(/direction_reason:\s*synth\.direction_reason/.test(eaRoute),
    "execute-trade passes the analysis's own reason through")
})
