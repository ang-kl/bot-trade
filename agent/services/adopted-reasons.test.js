// node --test agent/services/adopted-reasons.test.js
//
// V3 B4c: an adopted bot fill gets its reason back from EVIDENCE only — the
// label's own strategy code, the entry intent the ledger recorded, the resting
// order row that placed it, a clean bot row on the same position. Never a
// plan, never a guessed approval, never an origin from the label alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { backfillAdoptedReasons, recoverTradeReason, adoptedReasonsLine, matchTradeIntent } from './adopted-reasons.js'
import { findUnreasonedTrades } from './close-completeness.js'
import { reconcilePositions } from './reconciler.js'
import { evidenceRows } from './evidence-gate.js'
import { strategyAttrSql } from '../lib/strategy-attribution.js'
import { parseLabel } from '../lib/trade-labels.js'

const ACCT = '43097342'
const OTHER = '46130058'
const NOW = Date.parse('2026-09-26T02:00:00Z')

function adopted(db, { id = null, symbol = 'HD.US', side = 'SELL', label = 'PRE|v1|DON|HI|LDN|1d|-', pos = '241174047', acct = ACCT, opened = '2026-09-11 14:17:11', status = 'closed', rev = null, strategy = null, origin = 'reconciler_adopted', intentId = null } = {}) {
  return Number(db.prepare(`INSERT INTO trades (id, symbol, side, entry_price, volume, opened_at, closed_at, status, ctrader_position_id, source, label_raw, label_strategy,
                                                account_id, origin, origin_source, risk_event_id, strategy, intent_id, net_pnl, close_reason)
                            VALUES (?, ?, ?, 380.5, 1, ?, ?, ?, ?, 'preopen', ?, ?, ?, ?, 'write', ?, ?, ?, ?, ?)`)
    .run(id, symbol, side, opened, status === 'closed' ? '2026-09-12 10:00:00' : null, status, pos, label,
      parseLabel(label).strategy,
      acct, origin, rev, strategy, intentId, status === 'closed' ? -12.5 : null, status === 'closed' ? 'stop loss hit — broker-side SL fill' : null).lastInsertRowid)
}
function approval(db, { symbol = 'HD.US', side = 'SELL', acct = ACCT, approved = 1, at = '2026-09-11T14:15:50.000Z' } = {}) {
  return Number(db.prepare(`INSERT INTO risk_events (symbol, side, approved, checks_json, proposal_json, account_id, created_at) VALUES (?, ?, ?, '{}', '{}', ?, ?)`)
    .run(symbol, side, approved, acct, at).lastInsertRowid)
}
function intent(db, { id = 'i2m2fs9nty3dk', acct = ACCT, side = 'SELL', producer = 'closed_market_limits', orderType = 'LIMIT', orderId = '360358179', pos = '241174047', rev = null } = {}) {
  const at = '2026-09-11T14:15:54.424Z'
  db.prepare(`INSERT INTO entry_intents (id, account_id, environment, side, order_type, producer_id, basis, mode_epoch, permit_id, permit_expires_at, state,
                                         broker_order_id, broker_position_id, resolution_source, risk_event_id, created_at, updated_at)
              VALUES (?, ?, 'demo', ?, ?, ?, 'bar', 0, ?, ?, 'FILLED', ?, ?, 'response', ?, ?, ?)`)
    .run(id, acct, side, orderType, producer, `p${id.slice(1)}`, at, orderId, pos, rev, at, at)
}
function resting(db, { acct = ACCT, orderId = '360358179', rev, symbol = 'HD.US', dir = -1, intentId = null } = {}) {
  return Number(db.prepare(`INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, status, note, strategy, risk_event_id, account_id, intent_id)
                            VALUES (?, '1d', ?, ?, 380, 390, 360, 1, 'filled', 'pending-closed: adopted as trade', 'donchian_breakout', ?, ?, ?)`)
    .run(symbol, orderId, dir, rev, acct, intentId).lastInsertRowid)
}
const row = (db, id) => db.prepare(`SELECT origin, origin_source, strategy, intent_id, risk_event_id FROM trades WHERE id = ?`).get(id)
const evidence = (db, id) => Object.fromEntries(db.prepare(`SELECT field, evidence FROM trade_reason_evidence WHERE trade_id = ?`).all(id).map(e => [e.field, e.evidence]))
const plans = (db) => db.prepare(`SELECT COUNT(*) AS n FROM trade_plans`).get().n
const kinds = (db, id) => findUnreasonedTrades(db, { now: NOW }).violations.filter(v => v.tradeId === id).map(v => v.kind)

test('an untagged PRE fill gets the strategy its own label names — and nothing a record does not name: origin stays adopted, no plan, no approval from a time window', async () => {
  const db = initDB(':memory:')
  // An approved event on the same account, symbol and side seconds before —
  // exactly what the reconciler's ±5-minute window would take. Not evidence.
  approval(db, { at: '2026-09-11T14:17:00.000Z' })
  const t = adopted(db, { label: 'PRE|v1|DON|HI|LDN|1d|-' })
  assert.deepEqual(kinds(db, t), ['adopted_ours_unreasoned'])
  const out = await backfillAdoptedReasons(db, { at: '2026-09-26T02:00:00.000Z' })
  assert.deepEqual(row(db, t), { origin: 'reconciler_adopted', origin_source: 'write', strategy: 'donchian_breakout', intent_id: null, risk_event_id: null })
  assert.deepEqual(evidence(db, t), { strategy: 'label' })
  assert.equal(plans(db), 0, 'no plan is invented')
  assert.equal(out.considered, 1); assert.equal(out.rowsWritten, 1)
  assert.deepEqual(out.byEvidence, { 'strategy:label': 1 })
  assert.deepEqual(out.stillMissing, { 'approval id': 1, plan: 1 })
  // Still counted — the strategy is back, the plan and the approval are not.
  const v = findUnreasonedTrades(db, { now: NOW }).violations.find(x => x.tradeId === t)
  assert.equal(v.kind, 'adopted_ours_unreasoned')
  assert.match(v.detail, /and no plan, approval id — strategy from label — missing: plan: none was recorded at adoption, and none is invented after the fact; approval id: only an entry intent/)
})

test('a tagged fill adopted before the stamp shipped (the #1585 shape): the intent gives the origin and the link, the resting row that placed its order gives the approval; the plan stays missing and counted', async () => {
  const db = initDB(':memory:')
  const ev = approval(db)
  intent(db) // closed_market_limits, LIMIT, order 360358179, position 241174047
  resting(db, { rev: ev })
  const t = adopted(db, { label: 'PRE|v1|DON|HI|LDN|1d|-|i2m2fs9nty3dk' })
  await backfillAdoptedReasons(db)
  assert.deepEqual(row(db, t), { origin: 'bot_pending_fill', origin_source: 'intent_link', strategy: 'donchian_breakout', intent_id: 'i2m2fs9nty3dk', risk_event_id: ev })
  assert.deepEqual(evidence(db, t), { strategy: 'label', intent_id: 'intent_tag', origin: 'intent_tag', risk_event_id: 'resting_row' })
  assert.equal(plans(db), 0)
  assert.deepEqual(kinds(db, t), ['plan_missing'], 'a bot row now, and its missing plan is named as one')
})

test('the intent is refused on any fact that contradicts it — another account, a manual producer, the other side, another position, a trade that already holds it', async () => {
  const cases = [
    ['another account', (db) => intent(db, { acct: OTHER })],
    ['manual producer', (db) => intent(db, { producer: 'route_manual_order' })],
    ['other side', (db) => intent(db, { side: 'BUY' })],
    ['other position', (db) => intent(db, { pos: '999' })],
    ['already held', (db) => { intent(db); adopted(db, { pos: '555', origin: 'bot_pending_fill', intentId: 'i2m2fs9nty3dk', rev: 1, strategy: 'donchian_breakout' }) }],
  ]
  for (const [name, seed] of cases) {
    const db = initDB(':memory:')
    const ev = approval(db)
    seed(db)
    resting(db, { rev: ev })
    const t = adopted(db, { label: 'PRE|v1|DON|HI|LDN|1d|-|i2m2fs9nty3dk' })
    const m = matchTradeIntent(db, db.prepare('SELECT * FROM trades WHERE id = ?').get(t))
    assert.equal(m.intent, null, `${name}: refused`); assert.ok(m.why.length > 0, `${name}: says why`)
    await backfillAdoptedReasons(db)
    const r = row(db, t)
    assert.equal(r.origin, 'reconciler_adopted', `${name}: no origin from a refused intent`)
    assert.equal(r.intent_id, null, `${name}: no link`)
    assert.equal(r.risk_event_id, null, `${name}: no approval through a refused intent`)
    assert.equal(r.strategy, 'donchian_breakout', `${name}: the label still names the strategy`)
  }
})

test('an approval is taken only when the risk event itself agrees: approved, same account, side and symbol, and one resting row names it', async () => {
  const cases = [
    ['vetoed', (db) => approval(db, { approved: 0 })],
    ['another account', (db) => approval(db, { acct: OTHER })],
    ['other symbol', (db) => approval(db, { symbol: 'MCD.US' })],
    ['other side', (db) => approval(db, { side: 'BUY' })],
  ]
  for (const [name, mk] of cases) {
    const db = initDB(':memory:')
    const ev = mk(db)
    intent(db)
    resting(db, { rev: ev })
    const t = adopted(db, { label: 'PRE|v1|DON|HI|LDN|1d|-|i2m2fs9nty3dk' })
    await backfillAdoptedReasons(db)
    assert.equal(row(db, t).risk_event_id, null, `${name}: no approval`)
    assert.equal(row(db, t).origin, 'bot_pending_fill', `${name}: the intent still proves the origin`)
  }
  // A resting row on another account for the same order id is not this order's row.
  const db = initDB(':memory:')
  const ev = approval(db)
  intent(db)
  resting(db, { rev: ev, acct: OTHER })
  const t = adopted(db, { label: 'PRE|v1|DON|HI|LDN|1d|-|i2m2fs9nty3dk' })
  await backfillAdoptedReasons(db)
  assert.equal(row(db, t).risk_event_id, null)
  // Two resting rows naming two different approvals: ambiguous, nothing taken.
  const db2 = initDB(':memory:')
  const a1 = approval(db2), a2 = approval(db2)
  intent(db2)
  resting(db2, { rev: a1 }); resting(db2, { rev: a2 })
  const t2 = adopted(db2, { label: 'PRE|v1|DON|HI|LDN|1d|-|i2m2fs9nty3dk' })
  await backfillAdoptedReasons(db2)
  assert.equal(row(db2, t2).risk_event_id, null)
})

test('the ledger\'s own record of the position links an untagged fill (no tag, one intent recorded this position on this account)', async () => {
  const db = initDB(':memory:')
  const ev = approval(db)
  intent(db, { rev: ev })
  const t = adopted(db, { label: 'PRE|v1|DON|HI|LDN|1d|-' })
  await backfillAdoptedReasons(db)
  assert.deepEqual(row(db, t), { origin: 'bot_pending_fill', origin_source: 'intent_link', strategy: 'donchian_breakout', intent_id: 'i2m2fs9nty3dk', risk_event_id: ev })
  assert.deepEqual(evidence(db, t), { strategy: 'label', intent_id: 'intent_position', origin: 'intent_position', risk_event_id: 'intent_approval' })
})

test('a re-adopted position (the #1310 shape) takes the approval its clean sibling row on the same position holds — but not its origin: two rows, one position, one edge record', async () => {
  const db = initDB(':memory:')
  const ev = approval(db, { symbol: 'DOGEUSD', side: 'BUY', at: '2026-08-23T10:25:50.000Z' })
  adopted(db, { symbol: 'DOGEUSD', side: 'BUY', label: 'AP|v1|BURN|HI|LDN|5m|REGR', pos: '238111184', origin: 'bot_market_dispatch', rev: ev, strategy: 'burnin', opened: '2026-08-23 10:25:53' })
  const t = adopted(db, { symbol: 'DOGEUSD', side: 'BUY', label: 'AP|v1|BURN|HI|LDN|5m|REGR', pos: '238111184', opened: '2026-08-23 10:37:17' })
  const before = evidenceRows(db, { windowDays: 3650, now: NOW }).map(r => r.id)
  assert.equal(before.length, 1, 'the sibling is in the gate\'s population')
  await backfillAdoptedReasons(db)
  assert.deepEqual(row(db, t), { origin: 'reconciler_adopted', origin_source: 'write', strategy: 'burnin', intent_id: null, risk_event_id: ev })
  assert.deepEqual(evidence(db, t), { strategy: 'label', risk_event_id: 'sibling_trade' })
  assert.deepEqual(evidenceRows(db, { windowDays: 3650, now: NOW }).map(r => r.id), before, 'the evidence gate reads the same rows')
})

test('a stored approval an evidence record contradicts is KEPT, and the disagreement is recorded beside it', async () => {
  const db = initDB(':memory:')
  const stored = approval(db, { at: '2026-09-11T13:00:00.000Z' })
  const named = approval(db)
  intent(db)
  resting(db, { rev: named })
  const t = adopted(db, { label: 'PRE|v1|DON|HI|LDN|1d|-|i2m2fs9nty3dk', rev: stored })
  const out = await backfillAdoptedReasons(db)
  assert.equal(row(db, t).risk_event_id, stored, 'never overwritten')
  assert.equal(out.conflicts.length, 1)
  assert.deepEqual({ stored: out.conflicts[0].stored, evidenced: out.conflicts[0].evidenced }, { stored, evidenced: named })
  assert.equal(evidence(db, t).risk_event_id_conflict, 'resting_row')
  assert.match(adoptedReasonsLine(out), /1 stored approval id\(s\) contradicted by evidence, kept and recorded/)
})

test('a clean bot row with no approval (the #1661 shape) gets the one its resting row recorded; its origin is never touched', async () => {
  const db = initDB(':memory:')
  const ev = approval(db, { symbol: 'NatGas', side: 'BUY' })
  intent(db, { id: 'i1ea06ki4vdgt', side: 'BUY', orderId: '361030908', pos: '241760676' })
  resting(db, { rev: ev, orderId: '361030908', symbol: 'NatGas', dir: 1 })
  const t = adopted(db, { symbol: 'NATGAS', side: 'BUY', label: 'PRE|v1|DON|HI|OFF|5m|-|i1ea06ki4vdgt', pos: '241760676', origin: 'bot_pending_fill', strategy: 'donchian_breakout' })
  assert.deepEqual(kinds(db, t), ['plan_missing', 'risk_event_missing'])
  await backfillAdoptedReasons(db)
  assert.deepEqual(row(db, t), { origin: 'bot_pending_fill', origin_source: 'write', strategy: 'donchian_breakout', intent_id: 'i1ea06ki4vdgt', risk_event_id: ev })
  assert.deepEqual(kinds(db, t), ['plan_missing'])
})

test('idempotent: a second pass writes nothing and names the same gaps', async () => {
  const db = initDB(':memory:')
  const ev = approval(db)
  intent(db)
  resting(db, { rev: ev })
  adopted(db, { label: 'PRE|v1|DON|HI|LDN|1d|-|i2m2fs9nty3dk' })
  adopted(db, { label: 'PRE|v1|VP|HI|NYC|15m|-', pos: '1', symbol: 'US30', side: 'BUY' })
  const first = await backfillAdoptedReasons(db)
  const snapshot = db.prepare('SELECT * FROM trades ORDER BY id').all()
  const second = await backfillAdoptedReasons(db)
  assert.equal(first.rowsWritten, 2)
  assert.equal(second.rowsWritten, 0); assert.deepEqual(second.fields, {})
  assert.deepEqual(db.prepare('SELECT * FROM trades ORDER BY id').all(), snapshot)
  assert.deepEqual(first.stillMissing, { plan: 2, 'approval id': 1 })
  assert.deepEqual(second.stillMissing, { plan: 1, 'approval id': 1 }, 'the linked row left the candidates; the other is named again, unchanged')
  assert.match(adoptedReasonsLine(second), /^adopted reasons: 1 bot row\(s\) since 2026-08-17 considered · 0 written \(nothing new\) · still without: approval id 1, plan 1 on 1 row\(s\)/)
})

test('out of scope, untouched: a foreign label, a pre-cutoff row, a rejected twin, a row whose label names no strategy', async () => {
  const db = initDB(':memory:')
  const foreign = adopted(db, { label: 'someone-elses-label' })
  const early = adopted(db, { opened: '2026-08-01 10:00:00', pos: '2' })
  const twin = adopted(db, { status: 'rejected', pos: '3' })
  const noCode = adopted(db, { label: 'AP|v1|-|HI|SGP|4h|-', pos: '4' })
  const out = await backfillAdoptedReasons(db)
  for (const id of [foreign, early, twin, noCode]) assert.equal(row(db, id).strategy, null)
  assert.equal(out.considered, 1, 'only the ours-labelled row since the cutoff is considered')
  assert.deepEqual(out.stillMissing, { strategy: 1, 'approval id': 1, plan: 1 })
})

test('label strategy is attribution-neutral: every reader that keys on strategyAttrSql sees the same value before and after', async () => {
  const db = initDB(':memory:')
  const ids = [adopted(db, { label: 'PRE|v1|VP|HI|NYC|15m|-', pos: '10' }), adopted(db, { label: 'PRE|v1|DON|HI|OFF|1h|-', pos: '11' })]
  const attr = () => db.prepare(`SELECT id, ${strategyAttrSql()} AS s FROM trades ORDER BY id`).all()
  const before = attr()
  await backfillAdoptedReasons(db)
  assert.deepEqual(attr(), before)
  assert.deepEqual(ids.map(id => row(db, id).strategy), ['vp_value', 'donchian_breakout'])
})

test('recoverTradeReason never throws on a missing row and reports an out-of-scope row as such', () => {
  const db = initDB(':memory:')
  assert.equal(recoverTradeReason(db, 999).inScope, false)
  const foreign = adopted(db, { label: 'someone-elses-label' })
  assert.deepEqual(recoverTradeReason(db, foreign).wrote, {})
})

// ---------------------------------------------------------------------------
// GOING FORWARD — the reconciler's adoption. Red without the B4c call site:
// an untagged OURS label used to land with strategy NULL and nothing tried.
// ---------------------------------------------------------------------------
function brokerPos({ positionId, symbolName = 'HD.US', tradeSide = 'SELL', label }) {
  return { positionId, tradeData: { positionId, symbolId: 1, tradeSide, openPrice: 380.5, volume: 100, label }, price: 380.5, stopLoss: 390, takeProfit: 360, symbolName, label }
}
const setState = (db) => (k, v) => db.prepare('INSERT OR REPLACE INTO agent_state (key, value) VALUES (?, ?)').run(k, v)

test('adoption: an untagged OURS label is recorded with the strategy its label names, and the evidence says so', () => {
  const db = initDB(':memory:')
  const r = reconcilePositions(db, [brokerPos({ positionId: 7001, label: 'PRE|v1|TSM|HI|SYD|1d|-' })], [], setState(db), { accountId: ACCT })
  const t = db.prepare(`SELECT id, origin, strategy, label_strategy FROM trades WHERE ctrader_position_id = '7001'`).get()
  assert.equal(t.origin, 'reconciler_adopted', 'the label alone never promotes the origin')
  assert.equal(t.strategy, 'tsmom_long')
  assert.deepEqual(r.newExternal[0].reasonRecovered, { strategy: 'label' })
  assert.deepEqual(db.prepare(`SELECT field, evidence, writer FROM trade_reason_evidence WHERE trade_id = ?`).all(t.id), [{ field: 'strategy', evidence: 'label', writer: 'adoption' }])
})

test('adoption: an untagged OURS label whose position the ledger recorded is the bot fill it is — origin, link and approval from the intent', () => {
  const db = initDB(':memory:')
  const ev = approval(db)
  intent(db, { pos: '7002', rev: ev, orderType: 'LIMIT' })
  reconcilePositions(db, [brokerPos({ positionId: 7002, label: 'PRE|v1|DON|HI|LDN|1d|-' })], [], setState(db), { accountId: ACCT })
  const t = db.prepare(`SELECT id, origin, origin_source, strategy, intent_id, risk_event_id FROM trades WHERE ctrader_position_id = '7002'`).get()
  assert.deepEqual({ ...t, id: undefined }, { id: undefined, origin: 'bot_pending_fill', origin_source: 'intent_link', strategy: 'donchian_breakout', intent_id: 'i2m2fs9nty3dk', risk_event_id: ev })
  assert.deepEqual(kinds(db, t.id), ['plan_missing'], 'the plan is not invented at adoption either')
})

test('adoption: a foreign label is still imported observe-only with nothing recovered', () => {
  const db = initDB(':memory:')
  const r = reconcilePositions(db, [brokerPos({ positionId: 7003, label: 'someone-elses-label' })], [], setState(db), { accountId: ACCT })
  assert.equal(r.newExternal[0].adopted, false)
  assert.equal(r.newExternal[0].reasonRecovered, undefined)
  assert.equal(db.prepare(`SELECT strategy FROM trades WHERE ctrader_position_id = '7003'`).get().strategy, null)
})

test('findUnreasonedTrades names an approval the pre-L2a sweep linked as such — a heuristic, not evidence', () => {
  const db = initDB(':memory:')
  const ev = approval(db)
  const t = adopted(db, { rev: ev, strategy: 'donchian_breakout' })
  const v = findUnreasonedTrades(db, { now: NOW }).violations.find(x => x.tradeId === t)
  assert.deepEqual(v.detail.match(/and no (.*?) —/)[1], 'plan')
  assert.match(v.detail, new RegExp(`approval id #${ev} linked by the pre-L2a closed-market sweep \\(symbol \\+ time\\), not by evidence`))
})

test('wiring: the boot runs the backfill BEFORE the position history build, and the close-completeness cadence runs it again (a repair nothing calls is a dead one)', async () => {
  // Source pin (failure mode #4: the call site is invisible from this
  // module); comments stripped first (failure mode #2).
  const { readFileSync } = await import('node:fs')
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const index = strip(readFileSync(new URL('../index.js', import.meta.url), 'utf8'))
  const boot = index.indexOf('await backfillAdoptedReasons(db)')
  assert.ok(boot > 0, 'boot calls the backfill')
  assert.match(index, /console\.log\(`\[boot\] \$\{adoptedReasonsLine\(await backfillAdoptedReasons\(db\)\)\}`\)/, 'and prints its counts')
  assert.ok(boot < index.indexOf('backfillPositionHistory(db, { sinceMs: Date.now() - 90 * 86400_000 })'), 'before the history build reads the rows')
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  const sweep = loop.indexOf('const cc = await runCloseCompletenessSweep(db)')
  const again = loop.indexOf('const ar = await backfillAdoptedReasons(db)')
  assert.ok(sweep > 0 && again > sweep && again - sweep < 1500, 'on the close-completeness cadence')
})
