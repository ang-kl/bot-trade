// node --test agent/services/close-completeness.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import {
  findIncompleteCloses, runCloseCompletenessSweep, findUnreasonedTrades, TRADE_REASONS_CUTOFF_ISO, UNREASONED_KINDS,
  classifyIncompleteClose, incompleteCloseLine, findUnpricedClosesWithoutCloseStamp, reasonContractClass, CLOSE_CLASSES,
} from './close-completeness.js'
import { recordTradePlan, scoreClosedPlans } from './trade-plans.js'
import { closeTradeRow } from '../db.js'

const HOUR_MS = 3_600_000
const NOW = Date.parse('2026-07-22T12:00:00Z')

function insertTrade(db, { symbol = 'EURUSD', side = 'BUY', netPnl = null, closedAtMs = null } = {}) {
  const { lastInsertRowid: id } = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, opened_at, status, closed_at, closed_at_ms, net_pnl)
    VALUES (?, ?, 1.1, datetime('now'), 'closed', datetime('now'), ?, ?)
  `).run(symbol, side, closedAtMs, netPnl)
  return id
}

function insertPostmortem(db, tradeId) {
  db.prepare(`INSERT INTO trade_postmortems (trade_id, symbol) VALUES (?, 'EURUSD')`).run(tradeId)
}

test('flags a closed trade past the window with no net_pnl and no postmortem', () => {
  const db = initDB(':memory:')
  const id = insertTrade(db, { closedAtMs: NOW - 72 * HOUR_MS })
  const stuck = findIncompleteCloses(db, { now: NOW })
  assert.equal(stuck.length, 1)
  assert.equal(stuck[0].id, id)
  assert.equal(stuck[0].missingPnl, true)
  assert.equal(stuck[0].missingPostmortem, true)
  assert.equal(stuck[0].ageHours, 72)
})

test('still flagged if only ONE of net_pnl/postmortem is missing — both must be complete to clear', () => {
  const db = initDB(':memory:')
  const pnlOnly = insertTrade(db, { closedAtMs: NOW - 72 * HOUR_MS, netPnl: 12.5 }) // pnl backfilled, no postmortem yet
  const pmOnly = insertTrade(db, { closedAtMs: NOW - 72 * HOUR_MS }) // postmortem exists, pnl still null
  insertPostmortem(db, pmOnly)
  const stuck = findIncompleteCloses(db, { now: NOW })
  const ids = stuck.map(s => s.id).sort()
  assert.deepEqual(ids, [pnlOnly, pmOnly].sort())
  assert.equal(stuck.find(s => s.id === pnlOnly).missingPostmortem, true)
  assert.equal(stuck.find(s => s.id === pmOnly).missingPnl, true)
})

test('cleared once BOTH net_pnl and a postmortem exist', () => {
  const db = initDB(':memory:')
  const id = insertTrade(db, { closedAtMs: NOW - 72 * HOUR_MS, netPnl: 12.5 })
  insertPostmortem(db, id)
  assert.equal(findIncompleteCloses(db, { now: NOW }).length, 0)
})

test('inside the window is never flagged — mirrors loss-postmortem.js\'s own 24h staleness cutoff', () => {
  const db = initDB(':memory:')
  insertTrade(db, { closedAtMs: NOW - 10 * HOUR_MS }) // fresh — loss-postmortem would still be waiting for bars
  insertTrade(db, { closedAtMs: NOW - 47 * HOUR_MS })
  assert.equal(findIncompleteCloses(db, { now: NOW, windowHours: 48 }).length, 0)
})

test('a row with no closed_at_ms at all (pre-migration history) is never flagged', () => {
  const db = initDB(':memory:')
  insertTrade(db, { closedAtMs: null })
  assert.equal(findIncompleteCloses(db, { now: NOW }).length, 0)
})

test('runCloseCompletenessSweep: no-op without TELEGRAM_BOT_TOKEN, still reports the count', async () => {
  const db = initDB(':memory:')
  insertTrade(db, { closedAtMs: NOW - 72 * HOUR_MS })
  delete process.env.TELEGRAM_BOT_TOKEN
  const res = await runCloseCompletenessSweep(db, { now: NOW })
  assert.equal(res.flagged, 1)
})

// ---------------------------------------------------------------------------
// PR-E (owner principle 4): every trade has a reason — the invariant.
// ---------------------------------------------------------------------------
const T1 = Date.parse('2026-09-11T08:00:00Z')
function botTrade(db, { origin = 'bot_market_dispatch', strategy = 'donchian_breakout', riskEventId = 77, openedAt = '2026-09-10 08:00:00', plan = true, symbol = 'EURUSD' } = {}) {
  const id = db.prepare(`INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume, opened_at, status, origin, strategy, risk_event_id, account_id)
                         VALUES (?, 'BUY', 1.1, 1.095, 1.11, 1000, ?, 'open', ?, ?, ?, 'A1')`).run(symbol, openedAt, origin, strategy, riskEventId).lastInsertRowid
  if (plan) recordTradePlan(db, id, { accountId: 'A1', symbol, side: 'BUY', strategy, entry: 1.1, sl: 1.095, tp: 1.11, source: 'auto_signal', now: T1 })
  return id
}

test('findUnreasonedTrades: a clean fixture reads 0 — open and closed bot trades with origin, strategy, plan, approval id, close reason and a scored plan; external origins are outside the population', () => {
  const db = initDB(':memory:')
  botTrade(db)
  const closed = botTrade(db, { origin: 'bot_pending_fill', strategy: 'fib_618_fade' })
  closeTradeRow(db, closed, { exitPrice: 1.095, closeReason: 'stop_loss', netPnl: -50, closedAtMs: T1 })
  scoreClosedPlans(db, { now: T1 })
  // external-by-design rows: no strategy, no plan — not violations
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, opened_at, status, origin) VALUES ('GBPUSD','SELL',1.3,'2026-09-10 09:00:00','open','reconciler_adopted')`).run()
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, opened_at, status, origin) VALUES ('GBPUSD','SELL',1.3,'2026-09-10 09:00:00','open','manual_broker')`).run()
  // a pre-cutoff row with nothing on it is history, not a violation
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, opened_at, status) VALUES ('USDJPY','BUY',150,'2026-07-01 09:00:00','closed')`).run()
  const r = findUnreasonedTrades(db, { now: T1 })
  assert.equal(r.sinceIso, TRADE_REASONS_CUTOFF_ISO)
  assert.equal(r.trades, 2, 'the two bot rows')
  assert.equal(r.considered, 3, 'the adopted row is read for M4 but is not a bot trade')
  assert.deepEqual(r.violations, [])
  assert.equal(r.counts.total, 0)
})

test('findUnreasonedTrades: every violation kind is named on a dirty fixture', () => {
  const db = initDB(':memory:')
  const noOrigin = db.prepare(`INSERT INTO trades (symbol, side, entry_price, opened_at, status, strategy) VALUES ('EURUSD','BUY',1.1,'2026-09-10 08:00:00','open','x')`).run().lastInsertRowid
  const unknownOrigin = db.prepare(`INSERT INTO trades (symbol, side, entry_price, opened_at, status, origin) VALUES ('EURUSD','BUY',1.1,'2026-09-10T08:00:00.000Z','open','unknown')`).run().lastInsertRowid
  const noStrategy = botTrade(db, { strategy: null })
  const noPlan = botTrade(db, { plan: false })
  const noRisk = botTrade(db, { riskEventId: null })
  const noReason = botTrade(db)
  db.prepare(`UPDATE trades SET status = 'closed', closed_at = '2026-09-10 12:00:00', closed_at_ms = ? WHERE id = ?`).run(T1, noReason)
  const unscored = botTrade(db)
  closeTradeRow(db, unscored, { exitPrice: 1.11, closeReason: 'take_profit', netPnl: 100, closedAtMs: T1 })
  // a stale UNKNOWN and a fresh one
  const ins = db.prepare(`INSERT INTO entry_intents (id, account_id, environment, symbol, symbol_id, side, producer_id, basis, mode_epoch, permit_id, permit_expires_at, state, created_at, updated_at)
                          VALUES (?, '46130058', 'demo', 'EURUSD', 1, 'BUY', 'scan_dispatch', 'bar', 0, ?, ?, 'UNKNOWN', ?, ?)`)
  const staleAt = new Date(T1 - 5 * 3_600_000).toISOString()
  const freshAt = new Date(T1 - 1 * 3_600_000).toISOString()
  ins.run('istale00000001', 'pstale00000001', staleAt, staleAt, staleAt)
  ins.run('ifresh00000001', 'pfresh00000001', freshAt, freshAt, freshAt)
  const r = findUnreasonedTrades(db, { now: T1 })
  const kinds = (id) => r.violations.filter(v => v.tradeId === id).map(v => v.kind)
  assert.deepEqual(kinds(noOrigin), ['origin_missing'])
  assert.deepEqual(kinds(unknownOrigin), ['origin_unknown'])
  assert.deepEqual(kinds(noStrategy), ['strategy_missing'])
  assert.deepEqual(kinds(noPlan), ['plan_missing'])
  assert.deepEqual(kinds(noRisk), ['risk_event_missing'])
  assert.deepEqual(kinds(noReason), ['close_reason_missing', 'plan_unscored'])
  assert.deepEqual(kinds(unscored), ['plan_unscored'])
  const intents = r.violations.filter(v => v.intentId)
  assert.deepEqual(intents.map(v => v.intentId), ['istale00000001'], 'only the UNKNOWN past the age floor')
  assert.equal(intents[0].kind, 'intent_unknown_stale'); assert.match(intents[0].detail, /…0058 EURUSD BUY: UNKNOWN for 5h/)
  // M3: a post-cutoff row the backfill stamped; M4: an adopted row wearing our label with nothing behind it
  const laundered = db.prepare(`INSERT INTO trades (symbol, side, entry_price, opened_at, status, origin, origin_source, source) VALUES ('EURUSD','BUY',1.1,'2026-09-10 08:00:00','open','legacy_unattributed','backfill','autotrade')`).run().lastInsertRowid
  const adoptedOurs = db.prepare(`INSERT INTO trades (symbol, side, entry_price, opened_at, status, origin, origin_source, label_raw) VALUES ('EURUSD','BUY',1.1,'2026-09-10 08:00:00','open','reconciler_adopted','write','ap|v1|FIB|H|LN|4h|RG')`).run().lastInsertRowid
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, opened_at, status, origin, origin_source, label_raw) VALUES ('EURUSD','BUY',1.1,'2026-09-10 08:00:00','open','reconciler_adopted','write','someone-elses-label')`).run()
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, opened_at, status, origin, origin_source, source) VALUES ('EURUSD','BUY',1.1,'2026-08-01 08:00:00','open','legacy_unattributed','backfill','autotrade')`).run() // pre-cutoff: fine
  const r2 = findUnreasonedTrades(db, { now: T1 })
  const kinds2 = (id) => r2.violations.filter(v => v.tradeId === id).map(v => v.kind)
  assert.deepEqual(kinds2(laundered), ['backfilled_after_cutoff'])
  assert.deepEqual(kinds2(adoptedOurs), ['adopted_ours_unreasoned']); assert.match(r2.violations.find(v => v.tradeId === adoptedOurs).detail, /no strategy, plan, approval id/)
  assert.equal(r2.counts.total, 11, 'the foreign-label adoption and the pre-cutoff backfill are not violations')
  assert.deepEqual(Object.keys(r2.counts.byKind).sort(), [...UNREASONED_KINDS].sort())
  assert.ok(r.violations.every(v => typeof v.detail === 'string' && v.detail.length > 0))
})

// ---------------------------------------------------------------------------
// V3 B4 (P5b-3): completeness names what cannot be recovered — never counted
// as recovered, never as zero, and every row still counted.
// ---------------------------------------------------------------------------
function unpricedClose(db, { account = '46130058', pos, writtenOff = false, reason = null, at = null, net = null, closedAtMs = NOW - 72 * HOUR_MS }) {
  return db.prepare(`INSERT INTO trades (symbol, side, entry_price, opened_at, status, closed_at, closed_at_ms, net_pnl, account_id, ctrader_position_id,
                                         pnl_unresolvable, pnl_unresolvable_reason, pnl_unresolvable_at)
                     VALUES ('GBPJPY', 'BUY', 190, '2026-07-19 21:00:00', 'closed', '2026-07-19 21:06:24', ?, ?, ?, ?, ?, ?, ?)`)
    .run(closedAtMs, net, account, pos, writtenOff ? 1 : 0, reason, at).lastInsertRowid
}
function verdict(db, { account = '46130058', pos, verdict: v, final }) {
  db.prepare(`INSERT INTO position_lifecycle_evidence (account_id, position_id, verdict, final, reason, read_at) VALUES (?, ?, ?, ?, ?, '2026-09-25T23:00:00.450Z')`)
    .run(account, pos, v, final ? 1 : 0, `${v} on the complete history`)
}

test('B4: every incomplete close is named by class — written off and final-unpriceable are labelled unrecoverable with the reason, the rest pending — and none is dropped', () => {
  const db = initDB(':memory:')
  const off = unpricedClose(db, { pos: '234843534', writtenOff: true, reason: 'unresolved: no broker evidence: position deal evidence invalid', at: '2026-09-02 11:00:30' })
  const never = unpricedClose(db, { pos: '234843601' }); verdict(db, { pos: '234843601', verdict: 'never_filled', final: true })
  const unread = unpricedClose(db, { pos: '234866443' }); verdict(db, { pos: '234866443', verdict: 'unreadable', final: false })
  const bare = unpricedClose(db, { pos: '235375880' })
  const pmOnly = unpricedClose(db, { pos: '235575497', net: -12.5 })
  const rows = findIncompleteCloses(db, { now: NOW })
  assert.equal(rows.length, 5, 'the class names a row, it never removes one')
  const byId = Object.fromEntries(rows.map(r => [r.id, r]))
  assert.equal(byId[off].class, 'labelled_unrecoverable')
  assert.match(byId[off].reason, /^written off 2026-09-02 11:00:30: unresolved: no broker evidence: position deal evidence invalid/)
  assert.equal(byId[off].missingPnl, true, 'still missing its P&L — never filled with a zero')
  assert.equal(byId[never].class, 'labelled_unrecoverable')
  assert.match(byId[never].reason, /broker verdict never_filled \(final\).*not written off in the ledger/)
  assert.equal(byId[unread].class, 'broker_evidence_pending', 'a non-final verdict says nothing is known yet')
  assert.match(byId[unread].reason, /broker verdict unreadable/)
  assert.equal(byId[bare].class, 'broker_evidence_pending')
  assert.match(byId[bare].reason, /no broker lifecycle verdict on record/)
  assert.equal(byId[pmOnly].class, 'postmortem_pending')
  assert.deepEqual(Object.keys(CLOSE_CLASSES).sort(), ['broker_evidence_pending', 'labelled_unrecoverable', 'postmortem_pending'])
  assert.match(incompleteCloseLine(byId[off]), /still no P&L, no postmortem — unrecoverable: written off 2026-09-02 11:00:30/)
  assert.doesNotMatch(incompleteCloseLine(byId[bare]), /unrecoverable/)
})

test('B4: classifyIncompleteClose — a write-off outranks the verdict; a final verdict that does not say "cannot be priced" is no label', () => {
  assert.equal(classifyIncompleteClose({ missingPnl: true, writtenOff: true, writtenOffReason: 'r', evidence: { verdict: 'unreadable', final: false } }).class, 'labelled_unrecoverable')
  assert.equal(classifyIncompleteClose({ missingPnl: true, writtenOff: false, evidence: { verdict: 'unpriced', final: false } }).class, 'broker_evidence_pending')
  assert.equal(classifyIncompleteClose({ missingPnl: true, writtenOff: false, evidence: { verdict: 'no_ledger_row', final: true } }).class, 'broker_evidence_pending')
  for (const v of ['empty_at_broker', 'never_filled', 'opening_not_retained', 'permanently_unsupported']) {
    assert.equal(classifyIncompleteClose({ missingPnl: true, writtenOff: false, evidence: { verdict: v, final: true } }).class, 'labelled_unrecoverable', v)
    assert.equal(classifyIncompleteClose({ missingPnl: true, writtenOff: false, evidence: { verdict: v, final: false } }).class, 'broker_evidence_pending', `${v} not final`)
  }
})

test('B4: an unpriced close with no closed_at_ms is outside the goal population and is named, not recovered', () => {
  const db = initDB(':memory:')
  const outside = unpricedClose(db, { pos: '231619053', writtenOff: true, reason: 'x', closedAtMs: null })
  unpricedClose(db, { pos: '231619054', closedAtMs: null, net: -3 }) // priced: not unpriced
  assert.equal(findIncompleteCloses(db, { now: NOW }).length, 0)
  assert.deepEqual(findUnpricedClosesWithoutCloseStamp(db).map(r => [r.id, r.writtenOff]), [[outside, true]])
})

test('B4: reasonContractClass — the plan kinds split at the exact #857 second; nothing else is excused by a date', () => {
  for (const kind of ['plan_missing', 'plan_unscored']) {
    assert.equal(reasonContractClass(kind, '2026-09-08 07:48:27'), 'pre_contract', kind)
    assert.equal(reasonContractClass(kind, '2026-09-08T07:48:27.999Z'), 'pre_contract', `${kind} iso`)
    assert.equal(reasonContractClass(kind, '2026-09-08 07:48:28'), 'post_contract', `${kind} at the boundary`)
    assert.equal(reasonContractClass(kind, '2026-09-08T15:48:27+08:00'), 'pre_contract', `${kind} with a zone`)
    assert.equal(reasonContractClass(kind, null), 'post_contract', 'an unknown open time is never excused')
  }
  assert.equal(reasonContractClass('adopted_ours_unreasoned', '2026-08-20 00:00:00', ['plan']), 'pre_contract', 'adopted, and only the plan is missing')
  assert.equal(reasonContractClass('adopted_ours_unreasoned', '2026-08-20 00:00:00', ['strategy', 'plan', 'approval id']), 'post_contract')
  for (const kind of ['origin_missing', 'strategy_missing', 'risk_event_missing', 'close_reason_missing', 'backfilled_after_cutoff']) {
    assert.equal(reasonContractClass(kind, '2026-08-20 00:00:00'), 'post_contract', kind)
  }
})

test('B4: findUnreasonedTrades — the contract split is a partition of the unchanged total', () => {
  const db = initDB(':memory:')
  const pre = botTrade(db, { plan: false, openedAt: '2026-09-08 07:48:27' })
  const post = botTrade(db, { plan: false, openedAt: '2026-09-08 07:48:28' })
  const noRisk = botTrade(db, { riskEventId: null, openedAt: '2026-09-01 00:00:00' })
  const r = findUnreasonedTrades(db, { now: T1 })
  assert.equal(r.counts.total, 3, 'every violation still counted')
  assert.deepEqual(r.counts.byKind, { plan_missing: 2, risk_event_missing: 1 })
  assert.deepEqual(r.counts.byContract, { pre_contract: 1, post_contract: 2 })
  assert.deepEqual(r.counts.byContractKind, { pre_contract: { plan_missing: 1 }, post_contract: { plan_missing: 1, risk_event_missing: 1 } })
  const c = (id) => r.violations.find(v => v.tradeId === id).contract
  assert.equal(c(pre), 'pre_contract'); assert.equal(c(post), 'post_contract'); assert.equal(c(noRisk), 'post_contract')
})
