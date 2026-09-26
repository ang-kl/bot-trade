// node --test agent/services/order-lifecycle.test.js
//
// V3 L1 — the order-lifecycle flags. What must hold:
//   1. every rule goes RED on a fixture carrying its defect and names the
//      defective row by its subject (a count alone proves nothing), and goes
//      GREEN on the same shape stored correctly; a rule with no fixture fails
//      the meta-test. Each red fixture first asserts the defect is really in
//      the database (CLAUDE.md failure mode #1).
//   2. the production shapes named in LIFECYCLE-SPEC §4 reproduce;
//   3. no input is not a pass: on an empty database every pre-order, order
//      and close rule is measurable: false with a reason, every stuck rule
//      measurable with 0;
//   4. new versus legacy splits at the acceptance start by the FILL time;
//   5. scope: all is the union, one account filters, NULL-account rows are
//      unattributed and never credited to the account asked for;
//   6. bounded: no SCAN of the four large tables; a limit hit says truncated;
//   7. a rule's meaning cannot change without a version bump (the pin);
//   8. goal rows, inspector, daily report and the ticker read one snapshot;
//   9. (L1c) a stage headline counts every violation — a scoped report's
//      unattributed ones beside the account, a controller on its own line —
//      so a stalled controller with no account record reads stuck > 0.
import test, { mock } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { initDB, getState, setState } from '../db.js'
import {
  RULES, RULESET_VERSION, HELPERS_VERSION, JUDGE_HELPERS, CONTEXT_SQL, STAGES, SNAPSHOT_KEY, SNAPSHOT_OPTIONS, SNAPSHOT_MAX_BYTES,
  buildOrderLifecycle, compactSnapshot, lifecycleGoals, normaliseLifecycleOptions, readSnapshot,
  inspectLifecycleRegression, lifecycleRuleRecurs, lifecycleRulePersists, lifecycleReportLines, loadLifecycleConfig, GENERIC_CLOSE_RE,
  CONTROLLERS_LINE, stageCountPhrase, UNATTRIBUTED_SAMPLE_MAX, NAMED_CLOSE_RULES, NAMED_RECORDS_MAX,
} from './order-lifecycle.js'
import { classifyRefusedRecord, REFUSED_CLASSES, CLASSED_ON_REFUSED_VIEW, positionHistoryView } from './position-history.js'
import { runOrderLifecyclePass, startOrderLifecycle } from './order-lifecycle-ticker.js'
import { goalTable, DEFAULT_GOAL_TARGETS, GOAL_ITEMS_MAX } from './goal-table.js'
import { runLogInspector, evalFalsifierMetric, INSPECTIONS } from './log-inspector.js'
import { buildDailyReport, DAILY_REPORT_MAX_CHARS } from './daily-report.js'
import { CONTROLLERS, heartbeatView } from './heartbeat.js'
import { scoreRefusedOpportunities } from './refusal-ledger.js'
import { DIGEST_STATE_SQL, DIGEST_REASON_ROWS_MAX } from './telegram-digest.js'

const NOW = Date.parse('2026-09-26T12:00:00Z')
const START = loadLifecycleConfig().acceptanceStart // 2026-09-25T08:50:00.000Z (proposed)
const NEW = '2026-09-26T09:00:00.000Z' // after the acceptance start, older than 2 h
const OLD = '2026-09-20 10:00:00' // inside the 30-day window, before the start
const OLDER = '2026-09-18T10:00:00.000Z' // legacy, and more than 48 h old
const A = '46130058', B = '43097342'
const iso = ms => new Date(ms).toISOString()

let seq = 0
function ins(db, table, row) {
  const cols = Object.keys(row)
  return Number(db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => row[c])).lastInsertRowid)
}
const PROPOSAL = { direction_reason: 'donchian breakout above the 20-bar high', strategy: 'donchian_breakout', entry: 1.1, sl: 1.09, tp1: 1.13, source: 'scan' }
const risk = (db, o = {}) => ins(db, 'risk_events', { symbol: 'EURUSD', side: 'BUY', approved: 1, disposition: 'ordered', account_id: A, opportunity_key: `ok${++seq}`, created_at: NEW, proposal_json: JSON.stringify(PROPOSAL), ...o })
const trade = (db, o = {}) => ins(db, 'trades', { symbol: 'EURUSD', side: 'BUY', status: 'open', origin: 'bot_market_dispatch', account_id: A, opened_at: NEW, ctrader_position_id: String(700000 + ++seq), strategy: 'donchian_breakout', ...o })
const plan = (db, tradeId, o = {}) => ins(db, 'trade_plans', { trade_id: tradeId, account_id: A, symbol: 'EURUSD', side: 'BUY', strategy: 'donchian_breakout', planned_entry: 1.1, planned_sl: 1.09, planned_tp: 1.13, risk_dist: 0.01, ...o })
const monitored = (db, tradeId, o = {}) => ins(db, 'monitored_positions', { symbol: 'EURUSD', trade_id: tradeId, account_id: A, status: 'active', broker_volume_units: 100000, created_at: NEW, ...o })
const intent = (db, o = {}) => {
  const id = o.id ?? `i${String(++seq).padStart(8, '0')}x`
  ins(db, 'entry_intents', { id, account_id: A, environment: 'demo', symbol: 'EURUSD', side: 'BUY', order_type: 'MARKET', volume: 1, producer_id: 'scan_dispatch', basis: 'bar', mode_epoch: 1, permit_id: `p-${id}`, permit_expires_at: NEW, state: 'FILLED', resolution_source: 'response', created_at: NEW, updated_at: NEW, resolved_at: NEW, ...o, ...(o.id ? {} : {}) })
  return id
}
const deal = (db, o = {}) => ins(db, 'broker_deals', { deal_id: String(300000000 + ++seq), position_id: '1', account_id: A, symbol: 'EURUSD', side: 'BUY', lots: 1, entry_price: 1.1, close_price: 1.12, opened_at: NEW, closed_at: NEW, gross_pnl: 20, swap: 0, commission: -1, net_pnl: 19, imported_at: NEW, ...o })
const label = tag => `AP|v3|DB|H|LDN|1h|TR${tag ? `|${tag}` : ''}`
/** A complete position_history record (every REQUIRED field is NOT NULL in the table). */
const ph = (db, o = {}) => ins(db, 'position_history', { account_id: A, ctrader_position_id: String(++seq), symbol: 'EURUSD', direction: 'long', direction_reason: 'breakout', strategy: 'donchian_breakout', origin: 'bot_market_dispatch',
  planned_entry: 1.1, planned_sl: 1.09, risk_dist: 0.01, entry_price: 1.1, exit_price: 1.12, volume: 1, opened_at_ms: Date.parse(OLDER) - 3_600_000, closed_at_ms: Date.parse(OLDER), hold_ms: 3_600_000,
  gross_pnl: 20, commission: -1, swap: 0, net_pnl: 19, realised_r: 2, close_reason: 'take profit (tp1)', sl_moves: 0, tp_moves: 0, scale_outs: 0, events_json: '[]', sources_json: '{}', built_at: NEW, ...o })
/** A bot trade stored the way every writer should store it. */
function goodTrade(db, o = {}) {
  const tag = `igood${String(++seq).padStart(6, '0')}`
  const re = risk(db, { account_id: o.account_id ?? A })
  const id = trade(db, { risk_event_id: re, label_raw: label(tag), proposal_entry_price: 1.1, ...o })
  plan(db, id, { account_id: o.account_id ?? A })
  if ((o.status ?? 'open') === 'open') monitored(db, id, { account_id: o.account_id ?? A })
  return id
}
/** A close stored complete: money, cause, times, record, postmortem, deal. */
function goodClose(db, o = {}) {
  const closedAt = o.closed_at ?? OLDER
  const id = goodTrade(db, { status: 'closed', net_pnl: 19, exit_price: 1.12, commission: -1, swap: 0, closed_at: closedAt, closed_at_ms: Date.parse(closedAt.includes('T') ? closedAt : closedAt.replace(' ', 'T') + 'Z'), hold_duration_ms: 3_600_000, close_reason: 'take profit (tp1)', ...o })
  const t = db.prepare('SELECT * FROM trades WHERE id = ?').get(id)
  ins(db, 'trade_postmortems', { trade_id: id, symbol: t.symbol, net_pnl: t.net_pnl })
  ph(db, { account_id: t.account_id, ctrader_position_id: t.ctrader_position_id, symbol: t.symbol, trade_id: id, closed_at_ms: t.closed_at_ms })
  deal(db, { position_id: t.ctrader_position_id, account_id: t.account_id, closed_at: iso(t.closed_at_ms), imported_at: iso(t.closed_at_ms + 60_000) })
  return id
}
const build = (db, o = {}) => buildOrderLifecycle(db, { nowMs: NOW, account: 'all', ...o })
const ruleOf = (report, id) => STAGES.flatMap(s => report.stages[s]).find(r => r.id === id)
const one = (db, id, o = {}) => ruleOf(build(db, { rule: id, limit: 200, ...o }), id)
const subjects = r => r.sample.map(e => e.subject)

// ---------------------------------------------------------------------------
// 1. Red and green, per rule. `red` returns { ids, present } — `present` is
// the precondition assertion that the defect is in the database.
// ---------------------------------------------------------------------------
const FIXTURES = {
  'PRE-01': {
    red(db) {
      const id = risk(db, { proposal_json: JSON.stringify({ ...PROPOSAL, direction_reason: null }) })
      return { ids: [`risk_event:${id}`], present: () => assert.equal(JSON.parse(db.prepare('SELECT proposal_json FROM risk_events WHERE id = ?').get(id).proposal_json).direction_reason, null) }
    },
    green: db => { risk(db) },
  },
  'PRE-02': {
    red(db) {
      ins(db, 'refusal_scores', { opportunity_key: 'r1', account_id: A, symbol: 'EURUSD', outcome: 'no_bars', scored_at: NEW })
      return { ids: ['refusal:r1'], present: () => assert.equal(db.prepare(`SELECT outcome FROM refusal_scores WHERE opportunity_key = 'r1'`).get().outcome, 'no_bars') }
    },
    green: db => { ins(db, 'refusal_scores', { opportunity_key: 'g1', account_id: A, symbol: 'EURUSD', outcome: 'stop', r_reached: -1, scored_at: NEW }) },
  },
  'PRE-03': {
    red(db) {
      const id = intent(db, { symbol: null, symbol_id: 1 })
      return { ids: [`intent:${id}`], present: () => assert.equal(db.prepare('SELECT symbol FROM entry_intents WHERE id = ?').get(id).symbol, null) }
    },
    green(db) {
      risk(db, { created_at: '2026-09-26T08:58:00.000Z' })
      intent(db, { created_at: NEW })
    },
  },
  'PRE-04': {
    red(db) {
      const id = ins(db, 'pending_orders', { symbol: 'QCOM.US', order_id: '1', dir: 1, level: 150, sl: 145, volume: 1, expires_at: NEW, strategy: 'x', timeframe: '1h', risk_event_id: null, account_id: A, placed_at: NEW, note: 'pending-closed' })
      return { ids: [`pending:${id}`], present: () => assert.equal(db.prepare('SELECT risk_event_id FROM pending_orders WHERE id = ?').get(id).risk_event_id, null) }
    },
    green: db => { ins(db, 'pending_orders', { symbol: 'QCOM.US', order_id: '2', dir: 1, level: 150, sl: 145, volume: 1, expires_at: NEW, strategy: 'x', timeframe: '1h', risk_event_id: 9, time_cap_minutes: 60, account_id: A, placed_at: NEW, note: 'pending-closed' }) },
  },
  'PRE-05': {
    red(db) {
      const id = risk(db, { disposition: 'dropped' })
      return { ids: [`risk_event:${id}`], present: () => assert.equal(db.prepare('SELECT disposition FROM risk_events WHERE id = ?').get(id).disposition, 'dropped') }
    },
    green: db => { risk(db) },
  },
  'ORD-01': {
    red(db) {
      const id = trade(db, { risk_event_id: null, strategy: null, label_raw: label(null) })
      return { ids: [`trade:${id}`], present: () => assert.equal(db.prepare('SELECT risk_event_id FROM trades WHERE id = ?').get(id).risk_event_id, null) }
    },
    green: db => { goodTrade(db) },
  },
  'ORD-02': {
    red(db) {
      const re = risk(db, { proposal_json: JSON.stringify({ ...PROPOSAL, direction_reason: null }) })
      const id = trade(db, { risk_event_id: re })
      return { ids: [`trade:${id}`], present: () => assert.equal(JSON.parse(db.prepare('SELECT proposal_json FROM risk_events WHERE id = ?').get(re).proposal_json).direction_reason, null) }
    },
    green: db => { goodTrade(db) },
  },
  'ORD-03': {
    red(db) {
      const id = trade(db, { symbol: 'JPM.US' })
      plan(db, id, { symbol: 'JPM.US', planned_entry: 310.5, planned_sl: 1_732_000, risk_dist: 1_731_689.5 })
      return { ids: [`trade:${id}`], present: () => assert.equal(db.prepare('SELECT planned_sl FROM trade_plans WHERE trade_id = ?').get(id).planned_sl, 1_732_000) }
    },
    green: db => { goodTrade(db) },
  },
  'ORD-04': {
    red(db) {
      const id = intent(db, { order_type: 'LIMIT', producer_id: 'pending_fib_orders', broker_position_id: '555', broker_order_id: '360473873' })
      return { ids: [`intent:${id}`], present: () => assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE ctrader_position_id = '555'`).get().n, 0) }
    },
    green(db) {
      const id = goodTrade(db)
      const pid = db.prepare('SELECT ctrader_position_id FROM trades WHERE id = ?').get(id).ctrader_position_id
      intent(db, { broker_position_id: pid })
    },
  },
  'ORD-05': {
    red(db) {
      const id = trade(db, { label_raw: label(null), ctrader_position_id: '8801' })
      return { ids: [`trade:${id}`], present: () => assert.equal(db.prepare('SELECT label_raw FROM trades WHERE id = ?').get(id).label_raw, label(null)) }
    },
    green: db => { goodTrade(db) },
  },
  'ORD-06': {
    red(db) {
      trade(db, { ctrader_position_id: '299683664', status: 'closed', opened_at: OLD })
      trade(db, { ctrader_position_id: '299683664', status: 'open' })
      return { ids: [`position:${A}:299683664`], present: () => assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE ctrader_position_id = '299683664'`).get().n, 2) }
    },
    green: db => { goodTrade(db) },
  },
  'ORD-07': {
    red(db) {
      const id = trade(db, { symbol: 'ES.US', origin: 'reconciler_adopted', label_raw: label(null), risk_event_id: null })
      return { ids: [`trade:${id}`], present: () => assert.equal(db.prepare('SELECT origin FROM trades WHERE id = ?').get(id).origin, 'reconciler_adopted') }
    },
    green: db => { trade(db, { origin: 'reconciler_adopted', label_raw: label('igreen0001') }) },
  },
  'ORD-08': {
    red(db) {
      ins(db, 'broker_orders', { order_id: '358927828', symbol: 'Cocoa', side: 'SELL', order_type: 'STOP', label: null, is_bot: 0, status: 'working', account_id: '46130949', first_seen: '2026-09-03 10:00:00' })
      return { ids: ['order:358927828'], present: () => assert.equal(db.prepare(`SELECT is_bot FROM broker_orders WHERE order_id = '358927828'`).get().is_bot, 0) }
    },
    green: db => {
      ins(db, 'broker_orders', { order_id: '9', symbol: 'EURUSD', label: label('igreen0002'), is_bot: 1, status: 'working', account_id: A })
      trade(db, { origin: 'reconciler_adopted', label_raw: label('igreen0003') })
    },
    emptyGreen: true, // the bot's own orders and adopted fills are not external: nothing to judge
  },
  'ORD-09': {
    red(db) {
      const id = goodTrade(db)
      db.prepare('UPDATE monitored_positions SET broker_volume_units = NULL WHERE trade_id = ?').run(id)
      return { ids: [`trade:${id}`], present: () => assert.equal(db.prepare('SELECT broker_volume_units FROM monitored_positions WHERE trade_id = ?').get(id).broker_volume_units, null) }
    },
    green: db => { goodTrade(db) },
  },
  'ORD-10': {
    red(db) {
      const id = ins(db, 'pending_orders', { symbol: 'NATGAS', order_id: '705', dir: 1, level: 3, sl: 2.9, volume: 1, status: 'expired', note: 'pending-closed: gone at broker, no fill adopted', account_id: A, placed_at: NEW })
      intent(db, { id: 'i1ea06ki4vdgt', producer_id: 'closed_market_limits', order_type: 'LIMIT', broker_order_id: '705', symbol: 'NATGAS' })
      trade(db, { symbol: 'NATGAS', label_raw: label('i1ea06ki4vdgt') })
      return { ids: [`pending:${id}`], present: () => assert.equal(db.prepare('SELECT status FROM pending_orders WHERE id = ?').get(id).status, 'expired') }
    },
    green: db => { ins(db, 'pending_orders', { symbol: 'NATGAS', order_id: '706', dir: 1, level: 3, sl: 2.9, volume: 1, status: 'expired', note: 'pending-closed', account_id: A, placed_at: NEW }) },
  },
  'CLS-01': {
    red(db) {
      const d = deal(db, { position_id: '43097342001', account_id: B, net_pnl: -12.5 })
      assert.ok(d)
      return { ids: [`position:${B}:43097342001`], present: () => assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE ctrader_position_id = '43097342001'`).get().n, 0) }
    },
    green: db => { goodClose(db, { closed_at: NEW }) },
  },
  'CLS-02': {
    red(db) {
      const id = goodClose(db)
      db.prepare('UPDATE trades SET commission = NULL WHERE id = ?').run(id)
      return { ids: [`trade:${id}`], present: () => assert.equal(db.prepare('SELECT commission FROM trades WHERE id = ?').get(id).commission, null) }
    },
    green: db => { goodClose(db) },
  },
  'CLS-03': {
    red(db) {
      const id = goodClose(db, { close_reason: 'closed at the broker (manual close or broker-side SL/TP fill) — not closed by the bot' })
      return { ids: [`trade:${id}`], present: () => assert.match(db.prepare('SELECT close_reason FROM trades WHERE id = ?').get(id).close_reason, /^closed at the broker/) }
    },
    green: db => { goodClose(db) },
  },
  'CLS-04': {
    red(db) {
      ins(db, 'position_history_incomplete', { account_id: A, ctrader_position_id: '1618', symbol: 'EURUSD', closed_at_ms: Date.parse(NEW), missing_json: JSON.stringify(['direction_reason']), partial_json: '{}', built_at: NEW })
      return { ids: [`position:${A}:1618`], present: () => assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM position_history_incomplete`).get().n, 1) }
    },
    green: db => { goodClose(db) },
  },
  'CLS-05': {
    red(db) {
      const id = goodClose(db)
      db.prepare('DELETE FROM trade_postmortems WHERE trade_id = ?').run(id)
      return { ids: [`trade:${id}`], present: () => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trade_postmortems WHERE trade_id = ?').get(id).n, 0) }
    },
    green: db => { goodClose(db) },
  },
  'CLS-06': {
    red(db) {
      const d = deal(db, { deal_id: '683000001', gross_pnl: null, swap: null, lots: null, net_pnl: 4.2, closed_at: '2026-09-20T10:00:00.000Z', imported_at: '2026-09-25 08:53:56' })
      assert.ok(d)
      return { ids: ['deal:683000001'], present: () => assert.equal(db.prepare(`SELECT lots FROM broker_deals WHERE deal_id = '683000001'`).get().lots, null) }
    },
    green: db => { deal(db) },
  },
  'CLS-07': {
    red(db) {
      const id = goodClose(db)
      db.prepare(`UPDATE trades SET closed_at = '2026-09-21 14:57:15', closed_at_ms = ? WHERE id = ?`).run(Date.parse('2026-09-10T01:31:21Z'), id)
      return { ids: [`trade:${id}`], present: () => assert.ok(db.prepare('SELECT closed_at_ms FROM trades WHERE id = ?').get(id).closed_at_ms < Date.parse('2026-09-11T00:00:00Z')) }
    },
    green: db => { goodClose(db) },
  },
  'CLS-08': {
    red(db) {
      const id = goodClose(db)
      db.prepare('DELETE FROM position_history WHERE trade_id = ?').run(id)
      return { ids: [`trade:${id}`], present: () => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM position_history').get().n, 0) }
    },
    green: db => { goodClose(db) },
  },
  'CLS-09': {
    red(db) {
      ph(db, { ctrader_position_id: '1701', symbol: 'BTCUSD', trade_id: 1701, planned_entry: 76457.41, planned_sl: 701_748_000, risk_dist: 701_671_542.59, closed_at_ms: Date.parse(NEW) })
      return { ids: [`position:${A}:1701`], present: () => assert.equal(db.prepare(`SELECT planned_sl FROM position_history WHERE ctrader_position_id = '1701'`).get().planned_sl, 701_748_000) }
    },
    green: db => { goodClose(db) },
  },
  'STK-01': {
    red(db) {
      const id = ins(db, 'pending_orders', { id: 671, symbol: 'QCOM.US', order_id: '360473880', dir: 1, level: 150, sl: 145, volume: 1, status: 'working', note: 'pending-fib', account_id: A, placed_at: OLDER, expires_at: '2026-09-20T00:00:00Z' })
      return { ids: [`pending:${id}`], present: () => assert.equal(db.prepare('SELECT status FROM pending_orders WHERE id = 671').get().status, 'working') }
    },
    green: db => {
      ins(db, 'pending_orders', { symbol: 'QCOM.US', order_id: '77', dir: 1, level: 150, sl: 145, volume: 1, status: 'working', note: 'pending-closed', account_id: A, placed_at: NEW, expires_at: iso(NOW + 86_400_000) })
      ins(db, 'broker_orders', { order_id: '77', symbol: 'QCOM.US', label: 'PRE|v3', is_bot: 1, status: 'working', account_id: A })
    },
  },
  'STK-02': {
    red(db) {
      const id = intent(db, { state: 'UNKNOWN', created_at: '2026-09-26T06:00:00.000Z', resolved_at: null })
      return { ids: [`intent:${id}`], present: () => assert.equal(db.prepare('SELECT state FROM entry_intents WHERE id = ?').get(id).state, 'UNKNOWN') }
    },
    green: db => { intent(db, { state: 'SENT', updated_at: iso(NOW - 30_000), resolved_at: null }) },
  },
  'STK-03': {
    red(db) {
      const id = trade(db, { status: 'submitting', ctrader_position_id: null, opened_at: '2026-09-26 11:00:00' })
      return { ids: [`trade:${id}`], present: () => assert.equal(db.prepare('SELECT status FROM trades WHERE id = ?').get(id).status, 'submitting') }
    },
    green: db => { trade(db, { status: 'submitting', ctrader_position_id: null, opened_at: iso(NOW - 60_000) }) },
  },
  'STK-04': {
    red(db) {
      const id = trade(db)
      return { ids: [`trade:${id}`], present: () => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM monitored_positions').get().n, 0) }
    },
    green: db => { goodTrade(db) },
  },
  'STK-05': {
    red(db) {
      trade(db, { id: 372, ctrader_position_id: '517869182', account_id: '46133489', status: 'closed', net_pnl: 1.23, opened_at: OLD, closed_at: OLD })
      const id = trade(db, { id: 774, ctrader_position_id: '517869182', account_id: '46133489', status: 'closed', net_pnl: null, opened_at: OLD, closed_at: '2026-09-21 14:57:15' })
      return { ids: [`trade:${id}`], present: () => assert.equal(db.prepare('SELECT net_pnl FROM trades WHERE id = 774').get().net_pnl, null) }
    },
    // Unpriced but unambiguous: the backfill's ordinary work, not stuck.
    green: db => { trade(db, { status: 'closed', net_pnl: null, opened_at: OLD, closed_at: OLD }) },
  },
  'STK-06': {
    red(db) {
      ins(db, 'position_capture_queue', { account_id: A, position_id: '4401', symbol: 'EURUSD', due_at_ms: 1, attempts: 6, state: 'gave_up', last_error: 'missing: direction_reason', settled_at: NEW })
      return { ids: [`position:${A}:4401`], present: () => assert.equal(db.prepare(`SELECT state FROM position_capture_queue`).get().state, 'gave_up') }
    },
    green: db => { ins(db, 'position_capture_queue', { account_id: A, position_id: '4402', symbol: 'EURUSD', due_at_ms: 1, state: 'captured', settled_at: NEW }) },
    emptyGreen: true, // every terminal capture row IS the finding: a clean queue has no population
  },
  'STK-07': {
    red(db) {
      setState(db, `acct:${A}:engine_status_json`, JSON.stringify({ accountId: A, transitionState: 'RECONCILING', requestedEntryMode: 'TIME_BASED', updatedAt: iso(NOW) }))
      ins(db, 'action_log', { method: 'LOOP', path: '/entry-mode/drain', account_id: A, at: '2026-09-26 10:00:00', body: JSON.stringify({ accountId: A, from: 'STABLE', to: 'RECONCILING' }) })
      return { ids: [`engine:${A}`], present: () => assert.match(getState(db, `acct:${A}:engine_status_json`), /RECONCILING/) }
    },
    green: db => { setState(db, `acct:${A}:engine_status_json`, JSON.stringify({ accountId: A, transitionState: 'STABLE', requestedEntryMode: 'TIME_BASED' })) },
  },
  'STK-08': {
    red(db) {
      ins(db, 'telegram_outbox', { queued_at: '2026-09-24T00:00:00.000Z', kind: 'alert', priority: 'normal', text: 'x', sent_at: null })
      return { ids: ['outbox:telegram'], present: () => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_outbox WHERE sent_at IS NULL').get().n, 1) }
    },
    green: db => { ins(db, 'telegram_outbox', { queued_at: iso(NOW - 60_000), kind: 'alert', priority: 'normal', text: 'x', sent_at: null }) },
  },
  'STK-09': {
    red(db) {
      const id = trade(db, { ctrader_position_id: '6601' })
      // v2 (I3): still reported — the newest row inside two log-mute windows.
      for (const at of ['2026-09-26 06:00:00', '2026-09-26 09:00:00', '2026-09-26 11:30:00']) ins(db, 'action_log', { method: 'POSITION_NO_TARGET', path: '/protection-audit', at, body: JSON.stringify({ positionId: '6601', symbol: 'EURUSD' }) })
      assert.ok(id)
      return { ids: [`position:${A}:6601`], present: () => assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE method = 'POSITION_NO_TARGET'`).get().n, 3) }
    },
    green: db => {
      trade(db, { ctrader_position_id: '6602' })
      ins(db, 'action_log', { method: 'POSITION_NO_TARGET', path: '/protection-audit', at: '2026-09-26 11:00:00', body: JSON.stringify({ positionId: '6602' }) })
    },
  },
  'STK-10': {
    red(db) {
      ins(db, 'broker_orders', { order_id: '358927854', symbol: 'Cocoa', order_type: 'STOP', is_bot: 0, status: 'working', account_id: '46130949', first_seen: '2026-09-03 10:00:00' })
      return { ids: ['order:358927854'], present: () => assert.equal(db.prepare(`SELECT status FROM broker_orders WHERE order_id = '358927854'`).get().status, 'working') }
    },
    green: db => { ins(db, 'broker_orders', { order_id: '8', symbol: 'Cocoa', is_bot: 0, status: 'working', account_id: A, first_seen: '2026-09-26 10:00:00' }) },
  },
  'STK-11': {
    // Both halves of the heartbeat's own ladder (heartbeat.js:530-534):
    // `error` (pnl_reconcile ×1,701, running) and `stalled` (minute_review,
    // 0 failures, last ran an hour ago against 60 s × 4).
    red(db) {
      ins(db, 'controller_heartbeats', { name: 'pnl_reconcile', last_run_at: iso(NOW - 60_000), last_ok_at: '2026-09-21T15:11:26.759Z', last_error: 'position_ledger_ambiguous', consecutive_failures: 1701, runs: 9000 })
      ins(db, 'controller_heartbeats', { name: 'minute_review', last_run_at: iso(NOW - 3_600_000), last_ok_at: iso(NOW - 3_600_000), consecutive_failures: 0, runs: 500 })
      return {
        ids: ['controller:pnl_reconcile', 'controller:minute_review'],
        present: () => {
          assert.equal(db.prepare(`SELECT consecutive_failures FROM controller_heartbeats WHERE name = 'pnl_reconcile'`).get().consecutive_failures, 1701)
          assert.equal(heartbeatView(db, { now: new Date(NOW) }).find(v => v.name === 'minute_review').verdict, 'stalled', 'the heartbeat itself says stalled')
        },
      }
    },
    green: db => { ins(db, 'controller_heartbeats', { name: 'pnl_reconcile', last_run_at: iso(NOW - 60_000), last_ok_at: iso(NOW - 60_000), consecutive_failures: 0, runs: 9000 }) },
  },
  'STK-12': {
    // V3 I3: a written-off stuck record is a NOTICE naming it; a settled one is not.
    red(db) {
      const id = trade(db, { id: 1466, symbol: 'SUGAR', status: 'unconfirmed', ctrader_position_id: null, opened_at: '2026-09-07 10:35:37' })
      ins(db, 'stuck_resolutions', { subject: `trade:${id}`, kind: 'trade_inflight', rule_id: 'STK-03', account_id: A, trade_id: id, outcome: 'unresolved', verdict: 'unresolved: no broker evidence', reason: 'no deal', evidence_json: '{}', prior_state: 'unconfirmed', resolver_version: 1, resolved_at: NEW })
      return { ids: [`trade:${id}`], present: () => assert.equal(db.prepare(`SELECT outcome FROM stuck_resolutions WHERE subject = 'trade:1466'`).get().outcome, 'unresolved') }
    },
    green(db) {
      const id = trade(db, { status: 'unconfirmed', ctrader_position_id: null, opened_at: '2026-09-07 10:35:37' })
      ins(db, 'stuck_resolutions', { subject: `trade:${id}`, kind: 'trade_inflight', rule_id: 'STK-03', account_id: A, trade_id: id, outcome: 'settled', verdict: 'duplicate of trade #1', reason: 'adopted', evidence_json: '{}', prior_state: 'unconfirmed', resolver_version: 1, resolved_at: NEW })
    },
    emptyGreen: true, // a settled record is not in the notice's population: the whole population is the write-offs
  },
}

test('meta: every rule has a red and a green fixture, and ids and keys are unique', () => {
  const missing = RULES.map(r => r.id).filter(id => !FIXTURES[id] || typeof FIXTURES[id].red !== 'function' || typeof FIXTURES[id].green !== 'function')
  assert.deepEqual(missing, [], `rules without a red/green fixture: ${missing.join(', ')}`)
  assert.equal(new Set(RULES.map(r => r.id)).size, RULES.length)
  assert.equal(new Set(RULES.map(r => r.key)).size, RULES.length)
  for (const r of RULES) {
    assert.ok(STAGES.includes(r.stage), `${r.id} stage`)
    assert.ok(['defect', 'notice'].includes(r.severity), `${r.id} severity`)
    assert.ok(Array.isArray(r.cite) && r.cite.length && r.cite.every(c => /^[a-z_.-]+\.(js|cpp):\d+(-\d+)?$/.test(c)), `${r.id} cites file:line`)
    assert.ok(Number.isInteger(r.version) && r.version >= 1, `${r.id} version`)
    assert.match(r.sql, /LIMIT \?\s*$/, `${r.id} sql ends in LIMIT ?`)
  }
})

for (const rule of RULES) {
  test(`${rule.id} ${rule.key}: red names the defective row; green passes`, () => {
    const red = initDB(':memory:')
    const { ids, present } = FIXTURES[rule.id].red(red)
    present() // the defect is really in the database before the rule is asked
    const r = one(red, rule.id)
    assert.ok(r.violations > 0, `${rule.id} did not fire on its red fixture: ${JSON.stringify({ population: r.population, reason: r.reason, classes: r.classes })}`)
    for (const id of ids) assert.ok(subjects(r).includes(id), `${rule.id} did not name ${id}: named ${subjects(r).join(', ')}`)
    const green = initDB(':memory:')
    FIXTURES[rule.id].green(green)
    const g = one(green, rule.id)
    assert.equal(g.violations, 0, `${rule.id} fired on its green fixture: ${JSON.stringify(g.sample)}`)
    if (!FIXTURES[rule.id].emptyGreen) assert.ok(g.population > 0, `${rule.id} green fixture reached no population — a green that judged nothing proves nothing`)
    assert.equal(g.measurable, true)
  })
}

// ---------------------------------------------------------------------------
// 2. Known answers (LIFECYCLE-SPEC §4, VERIFY spot-checks).
// ---------------------------------------------------------------------------
test('known answer: the six orphaned resting rows, one classification each (#669 and #661 after their fill)', () => {
  const db = initDB(':memory:')
  const D58 = '46130058', D08 = '46129908'
  const pend = (id, acct, symbol, order, expires) => ins(db, 'pending_orders', { id, symbol, order_id: order, dir: 1, level: 1, sl: 0.9, volume: 1, status: 'working', note: 'pending-fib', account_id: acct, placed_at: '2026-09-10 07:12:00', expires_at: expires })
  const gone = (order, acct, at) => ins(db, 'broker_orders', { order_id: order, account_id: acct, symbol: 'X', label: 'AP|v3', is_bot: 1, status: 'gone', gone_at: at })
  pend(671, D58, 'QCOM.US', '360473880', '2026-09-20T00:00:00Z'); gone('360473880', D58, '2026-09-25 07:47:42')
  pend(669, D58, 'SGDJPY', '360473877', iso(NOW + 86_400_000)); gone('360473877', D58, '2026-09-24 09:51:14')
  intent(db, { id: 'iowbtj8tx66xi', account_id: D58, producer_id: 'pending_fib_orders', order_type: 'LIMIT', broker_order_id: '360473877', symbol: 'SGDJPY' })
  trade(db, { id: 1673, account_id: D58, symbol: 'SGDJPY', label_raw: label('iowbtj8tx66xi'), opened_at: '2026-09-24 09:51:14', status: 'closed', net_pnl: 1, closed_at: NEW })
  pend(664, D08, '0011.HK', '360470001', '2026-09-20T00:00:00Z')
  pend(663, D08, 'QCOM.US', '360470002', iso(NOW + 86_400_000)); gone('360470002', D08, '2026-09-24 00:00:00')
  pend(662, D08, '0267.HK', '360470003', '2026-09-20T00:00:00Z')
  pend(661, D08, 'AUDPLN', '360470004', '2026-09-20T00:00:00Z')
  intent(db, { id: 'ie2nl08vaiq8p', account_id: D08, producer_id: 'pending_fib_orders', order_type: 'LIMIT', broker_order_id: '360470004', symbol: 'AUDPLN' })
  trade(db, { id: 1598, account_id: D08, symbol: 'AUDPLN', label_raw: label('ie2nl08vaiq8p'), opened_at: '2026-09-14 03:00:00', status: 'closed', net_pnl: 1, closed_at: NEW })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM pending_orders WHERE status = 'working'`).get().n, 6)
  const r = one(db, 'STK-01')
  assert.equal(r.violations, 6, 'six rows, not 5 + 2 + 6 (VERIFY correction 6)')
  assert.deepEqual(r.classes, { expired_working: 3, filled_unlinked: 2, order_gone: 1 })
  const by = Object.fromEntries(r.sample.map(e => [e.subject, e]))
  assert.equal(by['pending:669'].class, 'filled_unlinked')
  assert.equal(by['pending:661'].class, 'filled_unlinked', '#661 filled: not also counted as expired')
  assert.equal(by['pending:663'].class, 'order_gone')
  // v2 (I3): pending-fib rows now have a resolver (the stuck resolver, R1);
  // the six classifications above are unchanged from v1.
  for (const e of r.sample) { assert.equal(e.resolverExists, true); assert.equal(e.resolver, 'stuck resolver R1') }
  assert.equal(build(db).summary.stuck.new, 6)
})

test('known answer: #774 / #775 on …3489 — ambiguous identity, #774 with its local deal', () => {
  const db = initDB(':memory:')
  const L = '46133489'
  trade(db, { id: 372, account_id: L, ctrader_position_id: '517869182', status: 'closed', net_pnl: 1.1, opened_at: OLD, closed_at: OLD })
  trade(db, { id: 774, account_id: L, ctrader_position_id: '517869182', status: 'closed', net_pnl: null, opened_at: OLD, closed_at: '2026-09-21 14:57:15', closed_at_ms: Date.parse('2026-09-09T13:32:38Z') })
  trade(db, { id: 373, account_id: L, ctrader_position_id: '299683664', status: 'closed', net_pnl: 2.2, opened_at: OLD, closed_at: OLD })
  trade(db, { id: 775, account_id: L, ctrader_position_id: '299683664', status: 'closed', net_pnl: null, opened_at: OLD, closed_at: '2026-09-21 14:57:15' })
  deal(db, { deal_id: '336389481', position_id: '517869182', account_id: L, net_pnl: 1.23, matched_trade_id: 774, closed_at: '2026-09-09T13:32:38Z' })
  const r = one(db, 'STK-05')
  const by = Object.fromEntries(r.sample.map(e => [e.subject, e]))
  assert.equal(by['trade:774'].localDeal, '336389481')
  assert.equal(by['trade:775'].localDeal, null)
  assert.equal(r.classes.position_ledger_ambiguous, 2)
  const c7 = one(db, 'CLS-07')
  assert.ok(subjects(c7).includes('trade:774'), '#774: closed_at 09-21 against a broker close of 09-09')
})

test('known answer: i7fgue8t2rgxx CADJPY — FILLED at placement, order gone, no position', () => {
  const db = initDB(':memory:')
  const D58 = '46130058'
  intent(db, { id: 'i7fgue8t2rgxx', account_id: D58, symbol: 'CADJPY', producer_id: 'pending_fib_orders', order_type: 'LIMIT', broker_order_id: '360473873', broker_position_id: '99001',
    created_at: '2026-09-12T07:12:00.000Z', resolved_at: '2026-09-12T07:12:01.000Z', updated_at: '2026-09-12T07:12:01.000Z' })
  ins(db, 'broker_orders', { order_id: '360473873', account_id: D58, symbol: 'CADJPY', is_bot: 1, status: 'gone', gone_at: '2026-09-25 07:47:42' })
  const r = one(db, 'ORD-04')
  assert.equal(r.violations, 1)
  assert.equal(r.sample[0].subject, 'intent:i7fgue8t2rgxx')
  assert.equal(r.sample[0].class, 'order_gone_unfilled')
  assert.equal(r.sample[0].new, false, 'resolved 09-12: legacy, before the acceptance start')
  assert.equal(r.legacyViolations, 1)
})

test('known answer: #1686 JPM.US — a plan in wire units is wrong-side AND absurd in scale', () => {
  const db = initDB(':memory:')
  const id = trade(db, { id: 1686, symbol: 'JPM.US', origin: 'reconciler_adopted', label_raw: label('ijpm00000001'), opened_at: '2026-09-15 14:00:00' })
  plan(db, id, { symbol: 'JPM.US', planned_entry: 310.5, planned_sl: 1_732_000, planned_tp: null, risk_dist: 1_731_689.5, source: 'reconciler_adopted_intent' })
  const r = one(db, 'ORD-03')
  assert.deepEqual(r.sample[0].missing, ['sl_wrong_side', 'risk_scale'])
})

test('a stop on the RIGHT side but in wire units is still flagged — risk scale alone, plan and record', () => {
  const db = initDB(':memory:')
  // A short whose wire-unit stop sits above the entry: the side test passes,
  // only the scale test can catch it (1,732,000 against 310.5).
  const id = trade(db, { side: 'SELL', symbol: 'JPM.US' })
  plan(db, id, { side: 'SELL', symbol: 'JPM.US', planned_entry: 310.5, planned_sl: 1_732_000, planned_tp: 300, risk_dist: 1_731_689.5 })
  assert.deepEqual(one(db, 'ORD-03').sample.map(e => [e.subject, e.missing]), [[`trade:${id}`, ['risk_scale']]])
  ph(db, { ctrader_position_id: '1702', direction: 'short', planned_entry: 310.5, planned_sl: 1_732_000, risk_dist: 1_731_689.5, closed_at_ms: Date.parse(NEW) })
  assert.deepEqual(one(db, 'CLS-09').sample.map(e => [e.subject, e.missing]), [[`position:${A}:1702`, ['risk_scale']]])
})

test('known answer: #1618 / #1622 — the direction reason is recoverable from the sibling row', () => {
  const db = initDB(':memory:')
  const reWith = risk(db, { created_at: OLD })
  const reWithout = risk(db, { created_at: OLD, proposal_json: JSON.stringify({ ...PROPOSAL, direction_reason: undefined }) })
  trade(db, { id: 1618, ctrader_position_id: '1618', status: 'closed', risk_event_id: reWith, opened_at: OLD, closed_at: NEW })
  trade(db, { id: 1622, ctrader_position_id: '1618', status: 'rejected', risk_event_id: reWithout, opened_at: NEW })
  ins(db, 'position_history_incomplete', { account_id: A, ctrader_position_id: '1618', symbol: 'EURUSD', closed_at_ms: Date.parse(NEW), missing_json: JSON.stringify(['direction_reason', 'commission']), partial_json: '{}', built_at: NEW })
  const r = one(db, 'CLS-04')
  assert.deepEqual(r.sample[0].recoverable, { direction_reason: 'local', commission: 'broker' })
  // …and none when no row's event carries it.
  const db2 = initDB(':memory:')
  trade(db2, { ctrader_position_id: '1619', status: 'closed', risk_event_id: risk(db2, { proposal_json: '{}' }), closed_at: NEW })
  ins(db2, 'position_history_incomplete', { account_id: A, ctrader_position_id: '1619', symbol: 'EURUSD', closed_at_ms: Date.parse(NEW), missing_json: '["direction_reason"]', partial_json: '{}', built_at: NEW })
  assert.deepEqual(one(db2, 'CLS-04').sample[0].recoverable, { direction_reason: 'none' })
})

test('known answer: `direction_reason: null` — the value is tested, not the key (closed-market-limits.js:288)', () => {
  const db = initDB(':memory:')
  const withKey = risk(db, { proposal_json: JSON.stringify({ ...PROPOSAL, direction_reason: null, source: 'closed_market_limit' }) })
  const camel = risk(db, { proposal_json: JSON.stringify({ ...PROPOSAL, direction_reason: undefined, directionReason: 'tsmom:long conviction 8 ≥ 6' }) })
  const r = one(db, 'PRE-01')
  assert.deepEqual(subjects(r), [`risk_event:${withKey}`])
  assert.ok(!subjects(r).includes(`risk_event:${camel}`), 'directionReason is read as position-history.js:99-108 does')
})

test('known answer: {t,o,h,l,c} bars through the real refusal scorer are SCORED (V3 L2b W13), and PRE-02 names a no_bars row as the defect stored it', async () => {
  const db = initDB(':memory:')
  ins(db, 'risk_events', { symbol: 'EURUSD', side: 'BUY', approved: 0, veto_reason: 'bad_rr 1.50<3', account_id: A, opportunity_key: 'opp-objbars',
    created_at: '2026-09-20 10:00:00', proposal_json: JSON.stringify({ entry: 1.1, sl: 1.09, tp1: 1.13, timeframe: '1h', strategy: 'x' }) })
  const objectBars = Array.from({ length: 60 }, (_, i) => ({ t: Date.parse('2026-09-20T10:00:00Z') + i * 3_600_000, o: 1.1, h: 1.12, l: 1.095, c: 1.11 }))
  await scoreRefusedOpportunities(db, async () => objectBars, { nowMs: NOW - 3_600_000 })
  assert.equal(db.prepare(`SELECT outcome FROM refusal_scores WHERE opportunity_key = 'opp-objbars'`).get()?.outcome, 'time_cap', 'W13: the scorer now reads the objects the broker fetch returns (refusal-ledger.js:216-217)')
  // The rows the defect wrote before W13 are what PRE-02 still reads: one as stored.
  const legacy = { opportunity_key: 'opp-legacy', account_id: A, symbol: 'EURUSD', side: 'BUY', entry: 1.1, sl: 1.09, tp: 1.13, first_at: '2026-09-20 10:00:00', horizon_min: 2880, scored_at: iso(NOW - 3_600_000), outcome: 'no_bars', bars_used: 0, note: 'no bars stored' }
  ins(db, 'refusal_scores', legacy)
  const r = one(db, 'PRE-02')
  assert.deepEqual(subjects(r), ['refusal:opp-legacy'], 'the scored row is not a violation; the defect-shaped row is')
  assert.doesNotMatch(String(r.note ?? ''), /scored 0 while/, 'one row scored: the scorer is scoring')
  const onlyLegacy = initDB(':memory:')
  ins(onlyLegacy, 'refusal_scores', legacy)
  assert.match(one(onlyLegacy, 'PRE-02').note, /scored 0 while no_bars 1/)
})

test('known answer: #1715 ES.US — adopted, our label, no tag, no approval; opened_at is the adoption stamp', () => {
  const db = initDB(':memory:')
  trade(db, { id: 1715, account_id: '46133489', symbol: 'ES.US', origin: 'reconciler_adopted', label_raw: label(null), risk_event_id: null, opened_at: '2026-09-21 14:57:15' })
  const r = one(db, 'ORD-07')
  assert.equal(r.sample[0].subject, 'trade:1715')
  assert.equal(r.sample[0].openedAtSource, 'trades.opened_at (adoption stamp)')
})

test('CLS-03: the generic-close pattern covers every unattributing writer (VERIFY correction 5)', () => {
  for (const s of ['closed at the broker (manual close or broker-side SL/TP fill) — not closed by the bot', 'closed at the broker with NO STOP LOSS on record — cause unknown', 'already_closed', 'stale reconcile: position not open at the broker']) assert.ok(GENERIC_CLOSE_RE.test(s), s)
  for (const s of ['take profit (tp1)', 'stop loss hit', 'already_closed by owner']) assert.ok(!GENERIC_CLOSE_RE.test(s), s)
})

// ---------------------------------------------------------------------------
// 3. No input is not a pass.
// ---------------------------------------------------------------------------
test('empty database: every pre-order, order and close rule is not measurable WITH a reason; stuck rules measure 0', () => {
  const db = initDB(':memory:')
  const r = build(db)
  for (const rule of RULES) {
    const x = ruleOf(r, rule.id)
    if (rule.stage === 'stuck' || rule.current) {
      assert.equal(x.measurable, true, `${rule.id} is current state`)
      assert.equal(x.violations, 0)
    } else {
      assert.equal(x.measurable, false, `${rule.id} read a zero from no input as a pass`)
      assert.match(x.reason, /^no .+ in the window since/, `${rule.id} states why`)
    }
  }
  for (const s of ['pre_order', 'order', 'close']) assert.equal(r.summary[s].measurable, false)
  assert.equal(r.summary.stuck.measurable, true)
})

test('a rule whose statement fails reports the error, never a count of 0', () => {
  const db = initDB(':memory:')
  db.exec('DROP TABLE controller_heartbeats')
  const r = build(db)
  const x = ruleOf(r, 'STK-11')
  assert.equal(x.measurable, false)
  assert.equal(x.violations, 0)
  assert.match(x.reason, /^unreadable: .*controller_heartbeats/)
})

// ---------------------------------------------------------------------------
// 4. New versus legacy.
// ---------------------------------------------------------------------------
test('new versus legacy: the same defect either side of the acceptance start; an adopted row is judged by its broker fill', () => {
  const db = initDB(':memory:')
  const before = risk(db, { created_at: OLD, proposal_json: '{"strategy":"x","entry":1,"sl":0.9}' })
  const after = risk(db, { created_at: NEW, proposal_json: '{"strategy":"x","entry":1,"sl":0.9}' })
  const r = one(db, 'PRE-01')
  assert.equal(r.newViolations, 1); assert.equal(r.legacyViolations, 1)
  assert.equal(r.sample.find(e => e.subject === `risk_event:${after}`).new, true)
  assert.equal(r.sample.find(e => e.subject === `risk_event:${before}`).new, false)
  // Adopted AFTER the start (opened_at is the adoption stamp), filled BEFORE it.
  const db2 = initDB(':memory:')
  trade(db2, { id: 1715, origin: 'reconciler_adopted', label_raw: label(null), ctrader_position_id: '77001', opened_at: NEW })
  deal(db2, { position_id: '77001', opened_at: '2026-09-21T09:00:00.000Z', closed_at: NEW })
  const o = one(db2, 'ORD-07')
  assert.equal(o.violations, 1)
  assert.equal(o.sample[0].new, false, 'the fill predates the start: legacy')
  assert.equal(o.sample[0].openedAtSource, 'broker_deal')
  assert.equal(o.legacyViolations, 1)
  // The start is configurable per call, and moving it moves the split.
  assert.equal(one(db, 'PRE-01', { acceptanceStart: '2026-09-01T00:00:00Z' }).newViolations, 2)
})

test('a stage with nothing new since the start is "nothing new to judge", not a pass', () => {
  const db = initDB(':memory:')
  risk(db, { created_at: OLD, proposal_json: '{}' })
  const r = build(db)
  assert.equal(r.summary.pre_order.populationNew, 0)
  assert.match(r.summary.pre_order.note, /nothing new to judge since .*a fact about volume, not a pass/)
  assert.equal(r.summary.pre_order.legacy, 1)
})

test('distinct records, not summed rule counts (VERIFY correction 8): one bad trade in four rules is one record', () => {
  const db = initDB(':memory:')
  trade(db, { risk_event_id: null, strategy: null, label_raw: label(null), ctrader_position_id: '51' })
  const r = build(db)
  const fired = r.rules.filter(x => x.stage === 'order' && x.newViolations > 0)
  assert.ok(fired.length >= 3, `expected several order rules on one trade: ${fired.map(x => x.id)}`)
  assert.equal(r.summary.order.new, 1)
})

// ---------------------------------------------------------------------------
// 5. Scope.
// ---------------------------------------------------------------------------
test('scope: all is the union; one account filters; NULL-account rows are unattributed; an unknown id is population 0', () => {
  const db = initDB(':memory:')
  const bad = '{"strategy":"x"}'
  risk(db, { account_id: A, proposal_json: bad })
  risk(db, { account_id: B, proposal_json: bad })
  const legacyNull = risk(db, { account_id: null, proposal_json: bad })
  const all = one(db, 'PRE-01')
  assert.equal(all.violations, 3)
  assert.equal(all.unattributed.violations, 1)
  assert.ok(subjects(all).includes(`risk_event:${legacyNull}`), 'never dropped')
  assert.deepEqual(Object.keys(all.byAccount).sort(), [A, B].sort())
  const a = one(db, 'PRE-01', { account: A })
  assert.equal(a.violations, 1, 'one account — the NULL row is not credited to it (VERIFY correction 10)')
  assert.equal(a.unattributed.violations, 1, '…but it is counted beside the answer')
  assert.deepEqual(subjects(a).filter(s => s.startsWith('risk_event')).length, 1)
  const report = build(db, { account: A })
  assert.equal(report.scope.account, A)
  assert.equal(report.scope.coverage.unstamped > 0, true)
  const unknown = build(db, { account: '999999' })
  assert.equal(ruleOf(unknown, 'PRE-01').population, 0)
  assert.equal(ruleOf(unknown, 'PRE-01').measurable, false)
  assert.equal(unknown.scope.account, '999999', 'the scope is explicit, not silently widened')
  // The selected account is read on the builder's own connection when none is asked for.
  setState(db, 'ctrader_account_id', B)
  const selected = build(db, { account: null })
  assert.equal(selected.scope.account, B)
  assert.equal(selected.scope.explicit, false)
  assert.equal(ruleOf(selected, 'PRE-01').violations, 1)
})

// ---------------------------------------------------------------------------
// 6. Boundedness.
// ---------------------------------------------------------------------------
test('bounded: no rule or context statement SCANs risk_events, telegram_outbox, action_log or refusal_scores', () => {
  const db = initDB(':memory:')
  const big = /\bSCAN (TABLE )?(risk_events|telegram_outbox|action_log|refusal_scores)\b/
  const plans = []
  const w = { lowSpace: '2026-09-01 00:00:00', lowMs: 0 }
  for (const rule of RULES) plans.push([rule.id, db.prepare(`EXPLAIN QUERY PLAN ${rule.sql}`).all(...rule.params(w), 10).map(p => p.detail)])
  for (const [name, sql] of Object.entries(CONTEXT_SQL)) {
    const n = name === 'approvals' ? 3 : 1
    plans.push([name, db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(n - 1).fill('2026-09-01 00:00:00'), 10).map(p => p.detail)])
  }
  for (const [name, plan] of plans) {
    assert.ok(!plan.some(d => big.test(d)), `${name} scans a large table: ${plan.join(' | ')}`)
  }
  // The plans that reach the large tables use the indexes they were written for.
  const plan = id => plans.find(p => p[0] === id)[1].join(' | ')
  assert.match(plan('PRE-01'), /idx_risk_events_disposition/)
  assert.match(plan('PRE-02'), /idx_refusal_scores_scored/)
  assert.match(plan('STK-08'), /idx_tg_outbox_pending/)
  assert.match(plan('STK-09'), /INTEGER PRIMARY KEY \(rowid>\?\)/)
  assert.match(plan('riskForTrades'), /risk_events USING INTEGER PRIMARY KEY/)
})

test('bounded: a population at its limit says truncated rather than presenting a prefix as the whole', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 4; i++) risk(db, { proposal_json: '{}' })
  assert.equal(one(db, 'PRE-01', { populationLimit: 3 }).truncated, true)
  assert.equal(one(db, 'PRE-01', { populationLimit: 3 }).population, 3)
  assert.equal(one(db, 'PRE-01', { populationLimit: 5 }).truncated, false)
})

test('bounded: samples page at 25 (200 with one rule), counts never shrink', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 30; i++) risk(db, { proposal_json: '{}' })
  const all = build(db)
  assert.equal(ruleOf(all, 'PRE-01').violations, 30)
  assert.equal(ruleOf(all, 'PRE-01').sample.length, 25)
  const page = build(db, { rule: 'PRE-01', limit: 10, offset: 25 })
  assert.equal(ruleOf(page, 'PRE-01').sample.length, 5)
  assert.equal(page.rules.length, 1)
  assert.throws(() => normaliseLifecycleOptions({ limit: '26' }), RangeError)
  assert.throws(() => normaliseLifecycleOptions({ rule: 'PRE-01', limit: '201' }), RangeError)
  assert.throws(() => normaliseLifecycleOptions({ rule: 'NOPE-9' }), RangeError)
  assert.throws(() => normaliseLifecycleOptions({ days: '0' }), RangeError)
  assert.throws(() => normaliseLifecycleOptions({ since: 'yesterday' }), RangeError)
  assert.deepEqual(normaliseLifecycleOptions({ rule: 'approval_incomplete' }).rule, 'PRE-01')
  assert.deepEqual(normaliseLifecycleOptions({ account: 'ALL' }), SNAPSHOT_OPTIONS, 'the Reasons read and the snapshot share one worker key')
})

// ---------------------------------------------------------------------------
// 7. The ruleset pin: a rule's meaning cannot change without a version bump.
// ---------------------------------------------------------------------------
// Every behavioural field is hashed — sql, params, when, inWindow, rows,
// judge, subject, account, severity, stage, fix, limits — all but the id,
// the version and the documentation (cite, noun). Shared helpers are pinned
// separately under HELPERS_VERSION.
const src = v => (typeof v === 'function' ? v.toString() : JSON.stringify(v))
const ruleHash = r => createHash('sha256').update(Object.keys(r).filter(k => !['id', 'version', 'cite', 'noun'].includes(k)).sort().map(k => `${k}=${src(r[k])}`).join('\n␞\n')).digest('hex').slice(0, 16)
const helpersHash = () => createHash('sha256').update(Object.keys(JUDGE_HELPERS).sort().map(k => `${k}=${src(JUDGE_HELPERS[k])}`).join('\n␞\n')).digest('hex').slice(0, 16)
// helpers@4 (V3 L1c): runRule carries a scoped report's unattributed
// violations `beside`, summarise counts them and names controllers on their
// own line. No rule's own hash moved.
const PINNED_HELPERS = { [`helpers@4`]: '758feead1efec1bd' }
// STK-08@2 (STK-08v2): held_by_setting, and the digest reader and notify
// loader it judges by are pinned in its hash. No other rule's hash moved.
const PINNED = {
  'PRE-01@1': 'ef8952cc321a0a03', 'PRE-02@2': '8310a4e233690cf5', 'PRE-03@1': 'bf01d978a6b93535', 'PRE-04@1': 'fa04e500d8a0ca47',
  'PRE-05@1': 'c7aeb7460046a6fc',
  'ORD-01@2': '6455e3a08b70c56b', 'ORD-02@1': '520f853e457966a7', 'ORD-03@1': 'c3efa49b62d76c7e', 'ORD-04@1': '0576f08d9e583115',
  'ORD-05@1': 'ff61f53fcc0a5c36', 'ORD-06@1': '75ca883642df5b6e', 'ORD-07@1': '48d7a24785139f8d', 'ORD-08@1': '70ab525d959eef60',
  'ORD-09@1': '76e16b5ec574fd5f', 'ORD-10@1': '6aac17826225e763',
  'CLS-01@1': 'd1c6f94d5d127f9b', 'CLS-02@1': '1f3a45c656e2f94b', 'CLS-03@1': '40b74e5ba9111a98', 'CLS-04@1': '4313b95a7b55beb1',
  'CLS-05@1': '2cca97ff9080477d', 'CLS-06@1': 'a4bb8873fe57a5f1', 'CLS-07@1': '77e677b6b8b4b901', 'CLS-08@1': '540f253a1c1c8eab',
  'CLS-09@1': '9985d3c5b7b5b9cf',
  'STK-01@2': '969001ee6208e6c7', 'STK-02@1': '995fd7c14286ef8e', 'STK-03@2': '92e5e73e8c8494e9', 'STK-04@2': '30b119a04d39ebc5',
  'STK-05@1': 'fd6653d6850b9006', 'STK-06@2': '71140bf5e2dfef4e', 'STK-07@3': 'a5a2b92ecb68e9e5', 'STK-08@2': 'f79c388f91fac5d1',
  'STK-09@2': '29a95b3d182e245c', 'STK-10@1': '60a7854f87507cb9', 'STK-11@2': '53ce6e2a623913f6', 'STK-12@1': '20bc6106e975e370',
}
test('ruleset pin: every rule\'s sql + judge is pinned to its version', () => {
  const now = Object.fromEntries(RULES.map(r => [`${r.id}@${r.version}`, ruleHash(r)]))
  const changed = Object.entries(now).filter(([k, h]) => PINNED[k] !== h).map(([k, h]) => `${k}: ${h}`)
  assert.deepEqual(changed, [], `a rule changed without a version bump (bump its version and re-pin): ${changed.join('; ')}`)
  assert.deepEqual(Object.keys(PINNED).sort(), Object.keys(now).sort())
  const helpers = { [`helpers@${HELPERS_VERSION}`]: helpersHash() }
  assert.deepEqual(helpers, PINNED_HELPERS, 'a shared judge helper changed without a HELPERS_VERSION bump (bump it and re-pin)')
  assert.equal(RULESET_VERSION, [...RULES.map(r => `${r.id}@${r.version}`), `helpers@${HELPERS_VERSION}`].join(','))
})

// ---------------------------------------------------------------------------
// 8. Snapshot, goal rows, inspector, daily report, ticker.
// ---------------------------------------------------------------------------
function withSnapshot(db, report, at = NOW) {
  const snap = compactSnapshot(report)
  snap.at = iso(at)
  setState(db, SNAPSHOT_KEY, JSON.stringify(snap))
  return snap
}

test('snapshot: counts plus at most 5 samples per rule, ≤ 64 KB, and the samples shrink before it is refused', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 30; i++) risk(db, { proposal_json: '{}' })
  const snap = compactSnapshot(build(db))
  assert.ok(Buffer.byteLength(JSON.stringify(snap)) <= SNAPSHOT_MAX_BYTES)
  const pre = snap.rules.find(r => r.id === 'PRE-01')
  assert.equal(pre.violations, 30)
  assert.equal(pre.sample.length, 5)
  assert.equal(snap.rules.length, RULES.length)
  // An oversize report degrades samples, never counts.
  const fat = build(db)
  for (const s of STAGES) for (const r of fat.stages[s]) r.sample = Array.from({ length: 25 }, () => ({ subject: 'x'.repeat(400), detail: 'y'.repeat(400) }))
  const small = compactSnapshot(fat)
  assert.ok(small.samplesPerRule < 5)
  assert.equal(small.rules.find(r => r.id === 'PRE-01').violations, 30)
})

test('goal rows: off_track with the count; stale snapshot and no input are not_measurable; a throwing reader is four rows', async () => {
  const db = initDB(':memory:')
  risk(db, { proposal_json: '{}' })
  withSnapshot(db, build(db))
  const t = await goalTable(db, { now: NOW })
  const g = Object.fromEntries(t.goals.map(x => [x.id, x]))
  assert.equal(g.lifecycle_pre_order.verdict, 'off_track')
  assert.equal(g.lifecycle_pre_order.current, 1)
  assert.match(g.lifecycle_pre_order.note, /PRE-01 approval_incomplete 1/)
  assert.equal(g.lifecycle_order.verdict, 'not_measurable', 'no order in the window is not a pass')
  assert.equal(g.lifecycle_stuck.verdict, 'on_track')
  // Stale: 31 minutes old against the 30-minute limit.
  const stale = lifecycleGoals(readSnapshot(getState, db), DEFAULT_GOAL_TARGETS, NOW + 31 * 60_000)
  assert.ok(stale.every(r => r.verdict === 'not_measurable'))
  assert.match(stale[0].note, /snapshot 31 min old/)
  assert.ok(lifecycleGoals(null, DEFAULT_GOAL_TARGETS, NOW).every(r => r.verdict === 'not_measurable' && /no snapshot/.test(r.note)))
  const broken = await goalTable(db, { now: NOW, lifecycleRead: () => { throw new Error('boom') } })
  const rows = broken.goals.filter(x => x.id.startsWith('lifecycle_'))
  assert.equal(rows.length, 4)
  assert.ok(rows.every(x => x.verdict === 'not_measurable' && /reader failed: boom/.test(x.note)))
})

test('inspector: one proposed code_change per rule@version, idempotent; reporting-only rules open none; the falsifier reads the snapshot', () => {
  const db = initDB(':memory:')
  assert.ok(INSPECTIONS.some(i => i.key === 'lifecycle_regression'))
  risk(db, { proposal_json: '{}' }) // PRE-01, fix writer
  risk(db, { disposition: 'dropped' }) // PRE-05, fix reporting
  const snap = withSnapshot(db, build(db))
  runLogInspector(db, { now: NOW })
  runLogInspector(db, { now: NOW + 60_000 })
  const rows = db.prepare(`SELECT subject_key, principle_kind, status, falsifier FROM inspection_findings WHERE source = 'order_lifecycle'`).all()
  assert.deepEqual(rows.map(r => r.subject_key), ['order_lifecycle:PRE-01@v1'])
  assert.equal(rows[0].principle_kind, 'code_change')
  assert.equal(rows[0].status, 'proposed', 'never auto-applied')
  const fal = JSON.parse(rows[0].falsifier)
  assert.equal(fal.metric.kind, 'lifecycle_rule_recurs')
  assert.equal(fal.metric.version, 1)
  assert.equal(fal.metric.coverUntilMs, fal.deadlineMs - 30 * 60_000, 'a "none" must cover the 24 h, not the first ten minutes of them')
  // true: a violation newer than sinceMs, in a snapshot taken after it.
  assert.equal(evalFalsifierMetric(db, { kind: 'lifecycle_rule_recurs', ruleId: 'PRE-01', sinceMs: Date.parse(snap.rules[0].newestAt) - 1 }), true)
  // null: the snapshot is not after sinceMs — a dead ticker is no evidence (B1).
  assert.equal(evalFalsifierMetric(db, { kind: 'lifecycle_rule_recurs', ruleId: 'PRE-01', sinceMs: NOW + 1 }), null)
  assert.equal(evalFalsifierMetric(initDB(':memory:'), { kind: 'lifecycle_rule_recurs', ruleId: 'PRE-01', sinceMs: 0 }), null)
  assert.equal(lifecycleRuleRecurs(snap, { ruleId: 'NOPE', sinceMs: 0 }), null)
  assert.equal(lifecycleRuleRecurs(snap, { ruleId: 'PRE-01', version: 9, sinceMs: 0 }), null, 'another version of the rule cannot answer for this one')
  assert.deepEqual(inspectLifecycleRegression(null, NOW), [])
})

test('recurs (non-current rules): false only when a covering snapshot judged a record made since and it was clean', () => {
  const db = initDB(':memory:')
  risk(db, { proposal_json: '{}', created_at: NEW }) // 09:00, defective
  const since = Date.parse('2026-09-26T10:00:00Z')
  const noneMade = compactSnapshot(build(db))
  assert.equal(lifecycleRuleRecurs(noneMade, { ruleId: 'PRE-01', sinceMs: since, coverUntilMs: since }), null, 'nothing was made after the finding: no evidence either way')
  risk(db, { created_at: '2026-09-26T11:00:00.000Z' }) // 11:00, stored right
  const clean = compactSnapshot(build(db))
  assert.equal(clean.rules.find(r => r.id === 'PRE-01').newestJudgedAt, '2026-09-26T11:00:00.000Z')
  assert.equal(lifecycleRuleRecurs(clean, { ruleId: 'PRE-01', sinceMs: since, coverUntilMs: since }), false)
  assert.equal(lifecycleRuleRecurs(clean, { ruleId: 'PRE-01', sinceMs: since, coverUntilMs: NOW + 1 }), null, 'a snapshot short of the coverage cannot say none')
  risk(db, { proposal_json: '{}', created_at: '2026-09-26T11:30:00.000Z' })
  assert.equal(lifecycleRuleRecurs(compactSnapshot(build(db)), { ruleId: 'PRE-01', sinceMs: since, coverUntilMs: NOW + 1 }), true, 'a recurrence confirms even before the coverage is complete')
})

test('B1: a stuck rule\'s finding asks whether it is STILL stuck at the deadline — confirmed, falsified (resolved), expired (ticker dead)', () => {
  const LATER = NOW + 86_400_000 + 5 * 60_000
  const finding = db => db.prepare(`SELECT status, falsifier, resolution FROM inspection_findings WHERE subject_key LIKE 'order_lifecycle:STK-01@v%'`).get()
  const setup = () => {
    const db = initDB(':memory:')
    const { present } = FIXTURES['STK-01'].red(db)
    present()
    withSnapshot(db, build(db))
    runLogInspector(db, { now: NOW })
    const f = finding(db)
    assert.equal(f.status, 'proposed')
    const fal = JSON.parse(f.falsifier)
    assert.equal(fal.metric.kind, 'lifecycle_rule_persists', 'a stuck rule is never asked whether it recurred')
    assert.equal(fal.metric.sinceMs, fal.deadlineMs - 30 * 60_000)
    return db
  }
  // Still stuck at the deadline, measured by a fresh snapshot → confirmed.
  const stuck = setup()
  withSnapshot(stuck, build(stuck, { nowMs: LATER - 60_000 }), LATER - 60_000)
  assert.equal(readSnapshot(getState, stuck).rules.find(r => r.id === 'STK-01').violations, 1)
  runLogInspector(stuck, { now: LATER })
  assert.equal(finding(stuck).status, 'confirmed', finding(stuck).resolution)
  // Resolved: the row went terminal, a fresh snapshot shows 0 → falsified.
  const resolved = setup()
  resolved.prepare(`UPDATE pending_orders SET status = 'expired' WHERE id = 671`).run()
  withSnapshot(resolved, build(resolved, { nowMs: LATER - 60_000 }), LATER - 60_000)
  runLogInspector(resolved, { now: LATER })
  assert.equal(finding(resolved).status, 'falsified')
  // Ticker dead: the only snapshot is the one the finding came from → expired, never falsified.
  const dead = setup()
  runLogInspector(dead, { now: LATER })
  assert.equal(finding(dead).status, 'expired')
  // The metric itself: an unreadable rule and a truncated zero are no evidence either.
  const snap = readSnapshot(getState, stuck)
  const m = { ruleId: 'STK-01', version: RULES.find(r => r.id === 'STK-01').version, sinceMs: NOW }
  assert.equal(lifecycleRulePersists(snap, m), true)
  assert.equal(lifecycleRulePersists({ ...snap, rules: snap.rules.map(r => (r.id === 'STK-01' ? { ...r, violations: 0, truncated: true } : r)) }, m), null)
  assert.equal(lifecycleRulePersists({ ...snap, rules: snap.rules.map(r => (r.id === 'STK-01' ? { ...r, measurable: false } : r)) }, m), null)
})

test('daily report: the lifecycle section sits right after the goals and fits the Telegram bound', async () => {
  const db = initDB(':memory:')
  risk(db, { proposal_json: '{}' })
  withSnapshot(db, build(db))
  const r = await buildDailyReport(db, { now: NOW })
  const ids = r.sections.map(s => s.id)
  assert.equal(ids.indexOf('lifecycle'), ids.indexOf('goals') + 1)
  const lines = r.sections.find(s => s.id === 'lifecycle').lines
  assert.match(lines[0], /^Lifecycle since 2026-09-25 08:50Z \(snapshot \d\d:\d\dZ\): pre-order 1 new \/ 0 legacy; order 0; close 0; stuck 0$/)
  assert.ok(lines.some(l => /PRE-01 approval_incomplete: 1 new/.test(l)))
  assert.ok(lines.some(l => /order not measurable/.test(l)))
  assert.ok(r.text.length <= DAILY_REPORT_MAX_CHARS)
  assert.match(lifecycleReportLines(null)[0], /no snapshot/)
})

test('ticker: ok writes one snapshot row and beats ok; a failed build beats ok: false with the error and keeps the last snapshot', async () => {
  assert.ok(CONTROLLERS.order_lifecycle, 'registered, or the panel cannot show it')
  assert.equal(CONTROLLERS.order_lifecycle.effect.key, SNAPSHOT_KEY)
  const db = initDB(':memory:')
  // The pass reads at the real clock (the snapshot options carry no time).
  risk(db, { proposal_json: '{}', created_at: iso(Date.now() - 3_600_000) })
  const ok = await runOrderLifecyclePass(db)
  assert.equal(ok.ok, true, ok.error)
  const snap = readSnapshot(getState, db)
  assert.equal(snap.summary.pre_order.new, 1)
  let hb = db.prepare(`SELECT * FROM controller_heartbeats WHERE name = 'order_lifecycle'`).get()
  assert.equal(hb.consecutive_failures, 0)
  assert.equal(heartbeatView(db).find(v => v.name === 'order_lifecycle').work_product.fresh, true)
  const failed = await runOrderLifecyclePass(db, { read: async () => { throw Object.assign(new Error('order_lifecycle_worker_capacity'), { reason: 'order_lifecycle_worker_capacity' }) } })
  assert.equal(failed.ok, false)
  hb = db.prepare(`SELECT * FROM controller_heartbeats WHERE name = 'order_lifecycle'`).get()
  assert.equal(hb.consecutive_failures, 1)
  assert.match(hb.last_error, /order_lifecycle_worker_capacity/)
  assert.equal(readSnapshot(getState, db).at, snap.at, 'the last good snapshot stands and ages on its own')
})

// ---------------------------------------------------------------------------
// 9. The L1 fix round (checker B1-B3, N1-N8). Each test names what it guards.
// ---------------------------------------------------------------------------
test('B2: a stage with an unreadable rule is never on_track 0 — summary, goal row and daily line all name the rule', () => {
  const db = initDB(':memory:')
  risk(db) // a clean approval made after the start: the pre-order stage has something new to judge, and it is clean
  db.exec('ALTER TABLE refusal_scores RENAME COLUMN outcome TO outcome_renamed') // only PRE-02 reads it
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('refusal_scores') WHERE name = 'outcome'`).get().n, 0)
  const report = build(db)
  assert.match(ruleOf(report, 'PRE-02').reason, /^unreadable: .*outcome/)
  assert.equal(ruleOf(report, 'PRE-01').measurable, true, 'the other rules still read')
  assert.deepEqual(report.summary.pre_order.unreadable.map(u => u.id), ['PRE-02'])
  assert.equal(report.summary.pre_order.new, 0)
  assert.match(report.summary.pre_order.note, /unreadable: PRE-02 \(no such column: outcome\)/)
  withSnapshot(db, report)
  const row = () => lifecycleGoals(readSnapshot(getState, db), DEFAULT_GOAL_TARGETS, NOW).find(r => r.id === 'lifecycle_pre_order')
  assert.equal(row().verdict, 'not_measurable', 'a 0 over the readable rules is not the stage\'s 0 (principle 6)')
  assert.equal(row().current, null)
  assert.match(row().note, /not a pass — 0 new defective record\(s\) over the readable rules.*unreadable: PRE-02 \(no such column: outcome\)/)
  const lines = lifecycleReportLines(readSnapshot(getState, db))
  assert.match(lines[0], /pre-order 0\* new/)
  assert.ok(lines.some(l => /^ {2}pre_order\* partial — unreadable: PRE-02 \(no such column: outcome\)/.test(l)), lines.join('\n'))
  // A new defect beside it: off_track is provable from a lower bound, and said as one.
  risk(db, { proposal_json: '{}' })
  withSnapshot(db, build(db))
  assert.equal(row().verdict, 'off_track')
  assert.equal(row().current, 1)
  assert.match(row().note, /^at least 1 new defective record\(s\) over the readable rules/)
  // The stuck stage the same way: a dropped telegram_outbox is STK-08 unreadable, not "nothing stuck".
  const s = initDB(':memory:')
  s.exec('DROP TABLE telegram_outbox')
  withSnapshot(s, build(s))
  const stuck = lifecycleGoals(readSnapshot(getState, s), DEFAULT_GOAL_TARGETS, NOW).find(r => r.id === 'lifecycle_stuck')
  assert.equal(stuck.verdict, 'not_measurable')
  assert.match(stuck.note, /unreadable: STK-08 \(no such table: telegram_outbox\)/)
})

test('B2: a population at its bound is a lower bound — flagged, and never on_track', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 4; i++) risk(db) // four clean approvals
  const report = build(db, { populationLimit: 3 })
  assert.ok(report.summary.pre_order.truncated.includes('PRE-01'))
  assert.equal(report.summary.pre_order.new, 0)
  withSnapshot(db, report)
  const g = lifecycleGoals(readSnapshot(getState, db), DEFAULT_GOAL_TARGETS, NOW).find(r => r.id === 'lifecycle_pre_order')
  assert.equal(g.verdict, 'not_measurable')
  assert.match(g.note, /truncated at the population bound: .*PRE-01/)
  assert.ok(lifecycleReportLines(readSnapshot(getState, db)).some(l => /pre_order\* partial — truncated/.test(l)))
})

test('B3: STK-11 is the heartbeat\'s own view — stalled and error flagged; retired, unregistered and dormant skipped; record_stale and never_ran named, not judged', () => {
  const db = initDB(':memory:')
  const hb = (name, o) => ins(db, 'controller_heartbeats', { name, runs: 10, consecutive_failures: 0, ...o })
  hb('pnl_reconcile', { last_run_at: iso(NOW - 60_000), last_ok_at: '2026-09-21T15:11:26.759Z', consecutive_failures: 1701, last_error: 'position_ledger_ambiguous' })
  hb('minute_review', { last_run_at: iso(NOW - 3_600_000), last_ok_at: iso(NOW - 3_600_000) }) // 0 failures, stalled
  hb('pending_orders', { last_run_at: '2026-09-18T00:00:00.000Z', consecutive_failures: 50 }) // retired
  hb('controller_removed_long_ago', { last_run_at: '2026-08-01T00:00:00.000Z', consecutive_failures: 99 }) // unregistered
  hb('daily_report', { last_run_at: iso(NOW - 60_000), last_ok_at: iso(NOW - 60_000) }) // beats, but no daily_report_last_json: record_stale
  setState(db, 'cpp_exec_demo_health_json', JSON.stringify({ dormant: true, at: iso(NOW - 60_000) })) // dormant side, no row
  const view = Object.fromEntries(heartbeatView(db, { now: new Date(NOW) }).map(v => [v.name, v]))
  assert.equal(view.minute_review.verdict, 'stalled')
  assert.equal(view.pnl_reconcile.verdict, 'error')
  assert.equal(view.daily_report.verdict, 'record_stale')
  assert.equal(view.cpp_exec_demo.dormant, true)
  assert.equal(view.controller_removed_long_ago, undefined)
  const r = one(db, 'STK-11')
  assert.deepEqual(r.sample.map(e => [e.subject, e.class]).sort(), [['controller:minute_review', 'stalled'], ['controller:pnl_reconcile', 'error']])
  assert.equal(r.violations, 2, 'the frozen count of an unregistered row and a retired controller are not stuck')
  assert.equal(r.classes.record_stale, 1)
  assert.match(r.sample.find(e => e.subject === 'controller:minute_review').detail, /last ran 2026-09-26T11:00, 60 min against a 4 min limit/)
  const report = build(db)
  const note = report.rules.find(x => x.id === 'STK-11').note
  assert.match(note, /record_stale 1: daily_report/)
  assert.match(note, /never_ran \d+: /)
  assert.ok(!/cpp_exec_demo/.test(note), 'a dormant side is not "never ran"')
  assert.ok(report.notVerifiable.some(l => /^STK-11 Not Verifiable as stuck — record_stale 1: daily_report/.test(l)))
})

test('N1: a stage counts distinct records — ORD-01 on a trade and ORD-06 on its broker position are one record', () => {
  const db = initDB(':memory:')
  trade(db, { ctrader_position_id: '424242', status: 'closed', opened_at: OLD, closed_at: OLD }) // the older twin: legacy
  const id = trade(db, { ctrader_position_id: '424242', risk_event_id: null }) // new, unreasoned
  const r = build(db)
  assert.ok(subjects(ruleOf(r, 'ORD-01')).includes(`trade:${id}`))
  assert.ok(subjects(ruleOf(r, 'ORD-06')).includes(`position:${A}:424242`))
  assert.equal(ruleOf(r, 'ORD-06').sample[0].new, true)
  assert.equal(ruleOf(r, 'ORD-01').sample.find(e => e.subject === `trade:${id}`).record, `position:${A}:424242`)
  assert.equal(r.summary.order.new, 1, 'one broker position, not a trade and a position')
  assert.deepEqual(r.accounts.filter(a => a.stage === 'order').map(a => [a.account, a.new]), [[A, 1]])
  // A trade with no broker position stays itself.
  const d2 = initDB(':memory:')
  const sub = trade(d2, { status: 'submitting', ctrader_position_id: null, risk_event_id: null })
  assert.equal(ruleOf(build(d2), 'ORD-01').sample.find(e => e.subject === `trade:${sub}`).record, `trade:${sub}`)
})

test('N2: STK-07 cannot_settle — STOPPED requested while an orphaned resting row stays working', () => {
  const db = initDB(':memory:')
  FIXTURES['STK-01'].red(db) // #671 on account A
  setState(db, `acct:${A}:engine_status_json`, JSON.stringify({ accountId: A, transitionState: 'QUIESCING', requestedEntryMode: 'STOPPED', updatedAt: iso(NOW) }))
  const r = one(db, 'STK-07')
  assert.deepEqual(r.sample.map(e => [e.subject, e.class]), [[`engine:${A}`, 'cannot_settle']])
  assert.match(r.sample[0].detail, /1 orphaned working resting row/)
  // Without the orphan the same request is judged on its transition instead.
  const clean = initDB(':memory:')
  setState(clean, `acct:${A}:engine_status_json`, JSON.stringify({ accountId: A, transitionState: 'STABLE', requestedEntryMode: 'STOPPED' }))
  assert.equal(one(clean, 'STK-07').violations, 0)
})

test('N7: STK-07 dates the transition from the row that ENTERED it — a later from = to pass does not move `since`', () => {
  const db = initDB(':memory:')
  setState(db, `acct:${A}:engine_status_json`, JSON.stringify({ accountId: A, transitionState: 'RECONCILING', requestedEntryMode: 'TIME_BASED', updatedAt: iso(NOW) }))
  const drain = (at, from, to) => ins(db, 'action_log', { method: 'LOOP', path: '/entry-mode/drain', account_id: A, at, body: JSON.stringify({ accountId: A, from, to, cancelled: ['1'] }) })
  drain('2026-09-26 10:00:00', 'STABLE', 'RECONCILING') // entered two hours ago
  drain('2026-09-26 11:50:00', 'RECONCILING', 'RECONCILING') // a cancel logged while still in it (entry-drain.js:132-140)
  const r = one(db, 'STK-07')
  assert.equal(r.violations, 1, 'two hours in RECONCILING, not ten minutes')
  assert.equal(r.sample[0].since, '2026-09-26T10:00:00.000Z')
  assert.equal(r.sample[0].sinceIsLowerBound, false)
})

test('L2a W14: STK-07 v3 dates the transition from the record\'s own transitionSince, not the drain-row bound', () => {
  // The record says RECONCILING since 11:45 (15 minutes before NOW) while the
  // only drain row says it entered at 10:00: the record's stamp wins, so
  // there is nothing stuck yet. RED if the judge ignores transitionSince.
  const fresh = initDB(':memory:')
  setState(fresh, `acct:${A}:engine_status_json`, JSON.stringify({ accountId: A, transitionState: 'RECONCILING', requestedEntryMode: 'TIME_BASED', updatedAt: iso(NOW), transitionSince: '2026-09-26T11:45:00.000Z' }))
  ins(fresh, 'action_log', { method: 'LOOP', path: '/entry-mode/drain', account_id: A, at: '2026-09-26 10:00:00', body: JSON.stringify({ accountId: A, from: 'STABLE', to: 'RECONCILING' }) })
  assert.equal(one(fresh, 'STK-07').violations, 0, 'fifteen minutes by the record, not two hours by the drain row')
  // Stamped two hours ago with NO drain row at all: exact, not "at least".
  const old = initDB(':memory:')
  setState(old, `acct:${A}:engine_status_json`, JSON.stringify({ accountId: A, transitionState: 'WARMING', requestedEntryMode: 'TIME_BASED', updatedAt: iso(NOW), transitionSince: '2026-09-26T10:00:00.000Z' }))
  const r = one(old, 'STK-07')
  assert.equal(r.violations, 1)
  assert.equal(r.sample[0].since, '2026-09-26T10:00:00.000Z')
  assert.equal(r.sample[0].sinceSource, 'record')
  assert.equal(r.sample[0].sinceIsLowerBound, false)
  assert.doesNotMatch(r.sample[0].detail, /at least/)
})

test('N2: STK-08 watchdog outbox — the spec\'s known answer, 512/512 and 1,136,836 dropped, is one stuck mechanism', () => {
  const db = initDB(':memory:')
  const outbox = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`k${i}`, { attempts: 0, createdAtMs: NOW - 2 * 3_600_000 }]))
  setState(db, 'independent_watchdog_json', JSON.stringify({ status: { outbox, dropped: 1_136_836 }, readAt: iso(NOW - 60_000), error: null }))
  const r = one(db, 'STK-08')
  assert.deepEqual(r.sample.map(e => [e.subject, e.class]), [['outbox:watchdog', 'watchdog']])
  assert.equal(r.sample[0].detail, 'watchdog outbox 512/512, 512 never attempted and over 1 h old, dropped 1136836')
  assert.equal(r.violations, 1, 'one mechanism, not 512 items (VERIFY correction 6)')
  const ok = initDB(':memory:')
  setState(ok, 'independent_watchdog_json', JSON.stringify({ status: { outbox: { a: { attempts: 1, createdAtMs: NOW } }, dropped: 0 }, readAt: iso(NOW) }))
  assert.equal(one(ok, 'STK-08').violations, 0)
})

// ---------------------------------------------------------------------------
// STK-08 v2 (owner 25-09-2026 21:30 SGT): a channel switched OFF BY A SETTING
// holds its rows — class held_by_setting, named, not counted as stuck. A
// channel that is ON and a day behind stays the defect; a setting that cannot
// be read is never taken as off. Production 25-09-2026 23:29 UTC: 57,750
// Telegram rows from 2026-08-22 10:39 UTC with notify OFF; the watchdog
// outbox 512/512, dropped 1,526,163, all four delivery settings false.
// ---------------------------------------------------------------------------
const TG_OLD = '2026-08-22T10:39:26.800Z'
const outboxRow = (db, o = {}) => ins(db, 'telegram_outbox', { queued_at: TG_OLD, kind: 'alert', priority: 'normal', text: 'SECRET-TEXT do not show', reason: 'notify_off', sent_at: null, ...o })
const watchdogStatus = (o = {}) => ({
  outbox: Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`k${i}`, { attempts: 0, createdAtMs: Date.parse('2026-09-23T09:51:26.074Z') + i }])),
  dropped: 1_526_163, masterEnabled: false, deploymentDeliveryEnabled: false, incidentOwnerConfigured: false, deliveryCredentialsConfigured: false, effectivePolicyAllowsUrgent: false, ...o,
})
const WATCHDOG_ALL_ON = { masterEnabled: true, deploymentDeliveryEnabled: true, incidentOwnerConfigured: true, deliveryCredentialsConfigured: true, effectivePolicyAllowsUrgent: true }

test('STK-08 v2 telegram OFF by setting: held_by_setting, named with the setting, count, oldest and reasons — not in the stuck headline', () => {
  const db = initDB(':memory:')
  setState(db, 'telegram_notify_json', JSON.stringify({ enabled: false, mode: 'live', quiet: null, urgentBypass: true, tz: 'Asia/Singapore' }))
  outboxRow(db)
  outboxRow(db, { queued_at: '2026-09-25T10:00:00.000Z', reason: 'quiet_hours' })
  outboxRow(db, { queued_at: '2026-09-26T11:00:00.000Z' })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_outbox WHERE sent_at IS NULL').get().n, 3)
  assert.equal(getState(db, 'telegram_notify_json').includes('"enabled":false'), true)
  const report = build(db)
  const r = ruleOf(report, 'STK-08')
  assert.equal(r.version, 2)
  assert.equal(r.violations, 0, 'held by a setting is not a stuck violation')
  assert.equal(r.classes.held_by_setting, 1)
  assert.equal(r.info.held_by_setting.length, 1)
  const info = r.info.held_by_setting[0]
  assert.match(info, /^telegram: 3 unsent Telegram row\(s\), oldest queued 2026-08-22T10:39 — held by the setting telegram_notify_json enabled=false/)
  assert.match(info, /reasons over the 3 pending row\(s\): notify_off 2 \(oldest 2026-08-22T10:39\), quiet_hours 1 \(oldest 2026-09-25T10:00\); the oldest row's reason notify_off/)
  assert.match(info, /last flush never recorded/)
  assert.doesNotMatch(info, /SECRET-TEXT/, 'no message text')
  assert.match(r.note, /^held by a setting, not stuck \(not in the stuck count\) — telegram: 3 unsent/)
  assert.equal(report.summary.stuck.new, 0, 'the stuck headline excludes it')
  assert.match(report.rules.find(x => x.id === 'STK-08').note, /held by the setting telegram_notify_json enabled=false/, 'visible on the flat rules the Reasons page renders')
  // The goal row and the daily line say it beside the count, so a count that
  // fell because a channel is held never reads as delivered.
  const snap = compactSnapshot(report)
  assert.equal(snap.rules.find(x => x.id === 'STK-08').classes.held_by_setting, 1)
  const goal = lifecycleGoals(snap, DEFAULT_GOAL_TARGETS, NOW).find(g => g.id === 'lifecycle_stuck')
  assert.equal(goal.current, 0)
  assert.match(goal.note, /held by a setting, not counted: STK-08 outbox_backlog 1/)
  assert.ok(lifecycleReportLines(snap).includes('  STK-08 outbox_backlog 1 held by a setting (not stuck; see the rule\'s note)'))
})

test('STK-08 v2 telegram ON and a day behind: still the defect, with the digest state on the finding', () => {
  const db = initDB(':memory:')
  setState(db, 'telegram_notify_json', JSON.stringify({ enabled: true, mode: 'hourly' }))
  outboxRow(db, { reason: 'hourly_digest' })
  const r = one(db, 'STK-08')
  assert.equal(r.violations, 1)
  assert.equal(r.classes.held_by_setting, undefined)
  const e = r.sample.find(x => x.subject === 'outbox:telegram')
  assert.equal(e.class, 'telegram')
  assert.equal(e.detail, '1 unsent Telegram row(s), oldest queued 2026-08-22T10:39')
  assert.deepEqual(e.notify, { enabled: true, mode: 'hourly', configReadable: true, configError: null })
  assert.equal(e.lastError, null)
  assert.deepEqual(e.reasons.rows, [{ reason: 'hourly_digest', count: 1, oldestQueuedAt: TG_OLD }])
  assert.equal(build(db).summary.stuck.new, 1)
})

test('STK-08 v2 telegram ON with a recorded flush error: the defect names the error (token redacted)', () => {
  const db = initDB(':memory:')
  setState(db, 'telegram_notify_json', JSON.stringify({ enabled: true, mode: 'live' }))
  setState(db, 'tg_digest_last_error', '2026-09-25T23:00:00.000Z error: request to https://api.telegram.org/bot123456:AAbbCC_dd-ee/sendMessage failed')
  outboxRow(db, { reason: 'quiet_hours' })
  const r = one(db, 'STK-08')
  assert.equal(r.violations, 1)
  const e = r.sample.find(x => x.subject === 'outbox:telegram')
  // The detail drops the flush's own leading timestamp so the snapshot's cut keeps the error itself (checker nit 3).
  assert.match(e.detail, /^1 unsent Telegram row\(s\), oldest queued 2026-08-22T10:39; last flush error: error: request to https:\/\/api\.telegram\.org\/bot<redacted>\/sendMessage failed$/)
  assert.match(e.lastError, /bot<redacted>\/sendMessage failed$/)
  assert.doesNotMatch(JSON.stringify(r), /AAbbCC_dd-ee/, 'no credential anywhere in the rule')
})

test('STK-08 v2 unreadable notify config: never taken as off — the defect stays and says so', () => {
  for (const bad of ['{not json', '[false]', 'null', '"off"']) {
    const db = initDB(':memory:')
    setState(db, 'telegram_notify_json', bad)
    outboxRow(db)
    assert.equal(getState(db, 'telegram_notify_json'), bad)
    const r = one(db, 'STK-08')
    assert.equal(r.violations, 1, `unreadable ${bad} must not hold`)
    assert.equal(r.classes.held_by_setting, undefined)
    const e = r.sample.find(x => x.subject === 'outbox:telegram')
    assert.match(e.detail, /; telegram_notify_json unreadable, not taken as off$/)
    assert.equal(e.notify.configReadable, false)
  }
  // An absent config is the loader's default — enabled — and readable: the defect stays, unmarked.
  const none = initDB(':memory:')
  outboxRow(none)
  const e = one(none, 'STK-08').sample.find(x => x.subject === 'outbox:telegram')
  assert.equal(e.detail, '1 unsent Telegram row(s), oldest queued 2026-08-22T10:39')
  assert.equal(e.notify.enabled, true)
})

test('STK-08 v2 watchdog with its delivery settings OFF: held_by_setting naming each setting, the dropped count and the oldest item', () => {
  const db = initDB(':memory:')
  setState(db, 'telegram_notify_json', JSON.stringify({ enabled: false }))
  setState(db, 'independent_watchdog_json', JSON.stringify({ status: watchdogStatus(), readAt: '2026-09-25T23:33:27.475Z', error: null }))
  const report = build(db)
  const r = ruleOf(report, 'STK-08')
  assert.equal(r.violations, 0)
  assert.equal(r.classes.held_by_setting, 1)
  const info = r.info.held_by_setting.find(x => x.startsWith('watchdog:'))
  assert.equal(info, 'watchdog: watchdog outbox 512/512, 512 never attempted and over 1 h old, dropped 1526163; oldest queued 2026-09-23T09:51 — held by the setting(s) ' +
    'deploymentDeliveryEnabled=false (the cpp-verify delivery switch), incidentOwnerConfigured=false (the cpp-verify incident owner), ' +
    'deliveryCredentialsConfigured=false (WATCHDOG_TELEGRAM_TOKEN / WATCHDOG_TELEGRAM_CHAT_ID), masterEnabled=false (Node\'s telegram_notify_json as cpp-verify last read it): ' +
    'cpp-verify delivers nothing while any is off; status read 2026-09-25T23:33:27.475Z')
  assert.equal(report.summary.stuck.new, 0)
  // ONE setting off is enough: cpp-verify delivers only with all of them on.
  const one1 = initDB(':memory:')
  setState(one1, 'independent_watchdog_json', JSON.stringify({ status: watchdogStatus({ ...WATCHDOG_ALL_ON, deliveryCredentialsConfigured: false }), readAt: iso(NOW) }))
  const r1 = one(one1, 'STK-08')
  assert.equal(r1.violations, 0)
  assert.match(r1.info.held_by_setting[0], /held by the setting\(s\) deliveryCredentialsConfigured=false \(WATCHDOG_TELEGRAM_TOKEN/)
  // masterEnabled false relayed from an UNREADABLE Node policy is not a setting: the defect stays.
  const unread = initDB(':memory:')
  setState(unread, 'telegram_notify_json', '{not json')
  setState(unread, 'independent_watchdog_json', JSON.stringify({ status: watchdogStatus({ ...WATCHDOG_ALL_ON, masterEnabled: false }), readAt: iso(NOW) }))
  const ru = one(unread, 'STK-08')
  assert.equal(ru.classes.held_by_setting, undefined)
  assert.deepEqual(ru.sample.map(e => [e.subject, e.class]), [['outbox:watchdog', 'watchdog']])
  // Nor is masterEnabled false while Node's OWN readable setting is on (a stale cpp-verify copy,
  // or the contract's false for an unknown timezone): the defect stays (checker nit 1, 26-09).
  const nodeOn = initDB(':memory:')
  setState(nodeOn, 'telegram_notify_json', JSON.stringify({ enabled: true, mode: 'live' }))
  setState(nodeOn, 'independent_watchdog_json', JSON.stringify({ status: watchdogStatus({ ...WATCHDOG_ALL_ON, masterEnabled: false }), readAt: iso(NOW) }))
  const rn = one(nodeOn, 'STK-08')
  assert.equal(rn.violations, 1)
  assert.equal(rn.classes.held_by_setting, undefined)
  assert.deepEqual(rn.sample.map(e => [e.subject, e.class]), [['outbox:watchdog', 'watchdog']])
  // A field that is absent or null is unknown, never off.
  const nulls = initDB(':memory:')
  setState(nulls, 'independent_watchdog_json', JSON.stringify({ status: watchdogStatus({ masterEnabled: null, deploymentDeliveryEnabled: undefined, incidentOwnerConfigured: undefined, deliveryCredentialsConfigured: undefined }), readAt: iso(NOW) }))
  assert.equal(one(nulls, 'STK-08').violations, 1)
})

test('STK-08 v2 watchdog with delivery ON and still dropping: the defect, with the delivery settings on the finding', () => {
  const db = initDB(':memory:')
  setState(db, 'independent_watchdog_json', JSON.stringify({ status: watchdogStatus(WATCHDOG_ALL_ON), readAt: iso(NOW - 60_000) }))
  const r = one(db, 'STK-08')
  assert.equal(r.violations, 1)
  assert.equal(r.classes.held_by_setting, undefined)
  const e = r.sample.find(x => x.subject === 'outbox:watchdog')
  assert.equal(e.class, 'watchdog')
  assert.equal(e.detail, 'watchdog outbox 512/512, 512 never attempted and over 1 h old, dropped 1526163')
  assert.deepEqual(e.delivery, WATCHDOG_ALL_ON)
  // Dropping alone (an outbox not full) is still the defect when delivery is on.
  const drop = initDB(':memory:')
  setState(drop, 'independent_watchdog_json', JSON.stringify({ status: { ...WATCHDOG_ALL_ON, outbox: { a: { attempts: 3, createdAtMs: NOW } }, dropped: 7 }, readAt: iso(NOW) }))
  assert.equal(one(drop, 'STK-08').violations, 1)
})

test('STK-08 v2 the digest reader reads the outbox only through idx_tg_outbox_pending and bounds the reason breakdown', () => {
  const db = initDB(':memory:')
  for (const [name, sql] of Object.entries(DIGEST_STATE_SQL)) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(name === 'reasons' ? [10] : [])).map(p => p.detail).join(' | ')
    assert.doesNotMatch(plan, /\bSCAN (TABLE )?telegram_outbox\b/, `${name}: ${plan}`)
    assert.match(plan, /idx_tg_outbox_pending/, `${name}: ${plan}`)
  }
  const ins1 = db.prepare(`INSERT INTO telegram_outbox (queued_at, text, reason) VALUES (?, 'x', ?)`)
  db.transaction(() => { for (let i = 0; i <= DIGEST_REASON_ROWS_MAX; i++) ins1.run(iso(Date.parse(TG_OLD) + i * 1000), i === 0 ? 'quiet_hours' : 'notify_off') })()
  setState(db, 'telegram_notify_json', JSON.stringify({ enabled: false }))
  const r = one(db, 'STK-08')
  // The oldest row (quiet_hours) is outside the newest-2,000 window: the reply says so rather than presenting a prefix as the whole.
  assert.match(r.info.held_by_setting[0], new RegExp(`reasons over the newest ${DIGEST_REASON_ROWS_MAX} of ${DIGEST_REASON_ROWS_MAX + 1} pending rows: notify_off ${DIGEST_REASON_ROWS_MAX} .*; the oldest row's reason quiet_hours`))
})

test('N2: STK-06 unverified_at_cap — the spec\'s known answer, 11 records unverified at the re-verify cap', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 11; i++) {
    const pid = String(880000 + i)
    ph(db, { ctrader_position_id: pid, verification_state: 'unverified', rebuilt_at: null })
    ins(db, 'position_capture_queue', { account_id: A, position_id: pid, symbol: 'EURUSD', due_at_ms: 1, state: 'captured', reverify_attempts: 3, settled_at: NEW })
  }
  // One still under the cap and one verified: neither is stuck.
  ph(db, { ctrader_position_id: '889998', verification_state: 'unverified' })
  ins(db, 'position_capture_queue', { account_id: A, position_id: '889998', symbol: 'EURUSD', due_at_ms: 1, state: 'captured', reverify_attempts: 2, settled_at: NEW })
  ph(db, { ctrader_position_id: '889999', verification_state: 'verified' })
  ins(db, 'position_capture_queue', { account_id: A, position_id: '889999', symbol: 'EURUSD', due_at_ms: 1, state: 'captured', reverify_attempts: 3, settled_at: NEW })
  const r = one(db, 'STK-06')
  assert.equal(r.violations, 11)
  assert.deepEqual(r.classes, { unverified_at_cap: 11 })
  assert.ok(subjects(r).includes(`position:${A}:880000`) && !subjects(r).includes(`position:${A}:889998`))
})

test('N2: STK-01 no_broker_order — a working row over an hour old, not expired, with no broker order and no fill', () => {
  const db = initDB(':memory:')
  const id = ins(db, 'pending_orders', { symbol: 'EURUSD', order_id: '999001', dir: 1, level: 1.1, sl: 1.09, volume: 1, status: 'working', note: 'pending-closed', account_id: A, placed_at: iso(NOW - 2 * 3_600_000), expires_at: iso(NOW + 86_400_000) })
  const young = ins(db, 'pending_orders', { symbol: 'EURUSD', order_id: '999002', dir: 1, level: 1.1, sl: 1.09, volume: 1, status: 'working', note: 'pending-closed', account_id: A, placed_at: iso(NOW - 10 * 60_000), expires_at: iso(NOW + 86_400_000) })
  const r = one(db, 'STK-01')
  assert.deepEqual(r.sample.map(e => [e.subject, e.class]), [[`pending:${id}`, 'no_broker_order']])
  assert.ok(!subjects(r).includes(`pending:${young}`), 'inside the hour the broker order may not be read yet')
  assert.equal(r.sample[0].resolverExists, true, 'pending-closed has a resolver')
})

test('N2: ORD-04 — a resting fill at placement is a notice, and a FILLED intent has 30 minutes to show its position', () => {
  const db = initDB(':memory:')
  // Resting LIMIT resolved FILLED by the placement response within 5 s, with the position there: a notice, not a defect.
  const tid = goodTrade(db)
  const pid = db.prepare('SELECT ctrader_position_id FROM trades WHERE id = ?').get(tid).ctrader_position_id
  intent(db, { order_type: 'LIMIT', producer_id: 'closed_market_limits', broker_position_id: pid, resolution_source: 'response', created_at: '2026-09-26T09:00:00.000Z', resolved_at: '2026-09-26T09:00:02.000Z' })
  // FILLED 10 minutes ago with no position yet: inside the grace.
  const fresh = intent(db, { broker_position_id: '777001', resolved_at: iso(NOW - 10 * 60_000), created_at: iso(NOW - 10 * 60_000) })
  // FILLED 40 minutes ago with no position: the defect.
  const late = intent(db, { broker_position_id: '777002', resolved_at: iso(NOW - 40 * 60_000), created_at: iso(NOW - 40 * 60_000) })
  const r = one(db, 'ORD-04')
  assert.equal(r.classes.resting_filled_at_placement, 1)
  assert.deepEqual(subjects(r), [`intent:${late}`])
  assert.ok(!subjects(r).includes(`intent:${fresh}`), 'the 30-minute grace')
})

test('N2: CLS-05 exempt_zero and blocked_by_money — counted as classes, never as missing postmortems', () => {
  const db = initDB(':memory:')
  const zero = goodClose(db, { net_pnl: 0 })
  db.prepare('DELETE FROM trade_postmortems WHERE trade_id = ?').run(zero)
  const blocked = goodClose(db)
  db.prepare('UPDATE trades SET net_pnl = NULL, exit_price = NULL WHERE id = ?').run(blocked)
  db.prepare('DELETE FROM trade_postmortems WHERE trade_id = ?').run(blocked)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trade_postmortems').get().n, 0)
  const r = one(db, 'CLS-05')
  assert.equal(r.violations, 0)
  assert.deepEqual(r.classes, { exempt_zero: 1, blocked_by_money: 1 })
})

test('N2: CLS-02 settled_unrecoverable — written off with nothing else missing is a class; written off AND incomplete says none is recoverable', () => {
  const db = initDB(':memory:')
  const settled = goodClose(db)
  db.prepare('UPDATE trades SET net_pnl = NULL, pnl_unresolvable = 1 WHERE id = ?').run(settled)
  const worse = goodClose(db)
  db.prepare('UPDATE trades SET net_pnl = NULL, pnl_unresolvable = 1, commission = NULL WHERE id = ?').run(worse)
  const r = one(db, 'CLS-02')
  assert.equal(r.classes.settled_unrecoverable, 2)
  assert.deepEqual(subjects(r), [`trade:${worse}`])
  assert.deepEqual(r.sample[0].recoverable, { commission: 'none' })
})

test('N2: CLS-08 — an incomplete record IS a record (CLS-04 judges it); a pending capture is a class; a gave_up queue row is named', () => {
  const db = initDB(':memory:')
  const pidOf = id => db.prepare('SELECT ctrader_position_id FROM trades WHERE id = ?').get(id).ctrader_position_id
  const inc = goodClose(db)
  db.prepare('DELETE FROM position_history WHERE trade_id = ?').run(inc)
  ins(db, 'position_history_incomplete', { account_id: A, ctrader_position_id: pidOf(inc), symbol: 'EURUSD', closed_at_ms: Date.parse(OLDER), missing_json: '["commission"]', partial_json: '{}', built_at: NEW })
  const pending = goodClose(db)
  db.prepare('DELETE FROM position_history WHERE trade_id = ?').run(pending)
  ins(db, 'position_capture_queue', { account_id: A, position_id: pidOf(pending), symbol: 'EURUSD', due_at_ms: 1, state: 'pending' })
  const gave = goodClose(db)
  db.prepare('DELETE FROM position_history WHERE trade_id = ?').run(gave)
  ins(db, 'position_capture_queue', { account_id: A, position_id: pidOf(gave), symbol: 'EURUSD', due_at_ms: 1, state: 'gave_up', last_error: 'x' })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM position_history').get().n, 0)
  const r = one(db, 'CLS-08')
  assert.deepEqual(r.sample.map(e => [e.subject, e.class]), [[`trade:${gave}`, 'queue_gave_up']])
  assert.ok(!subjects(r).includes(`trade:${inc}`), 'the incomplete record exists: not absent')
  assert.equal(r.classes.capture_pending, 1)
})

test('N6: a trade still being written is not defective or stuck — ORD-01 owes no plan on a write-ahead row or inside 10 minutes; STK-04 waits 10 minutes', () => {
  const db = initDB(':memory:')
  const re = () => risk(db)
  const submitting = trade(db, { status: 'submitting', ctrader_position_id: null, risk_event_id: re(), label_raw: label('isub000001'), opened_at: iso(NOW - 60_000) })
  const fresh = trade(db, { risk_event_id: re(), label_raw: label('ifresh00001'), opened_at: iso(NOW - 5 * 60_000) })
  const settled = trade(db, { risk_event_id: re(), label_raw: label('iold0000001'), opened_at: iso(NOW - 20 * 60_000) })
  const o = one(db, 'ORD-01')
  assert.deepEqual(subjects(o), [`trade:${settled}`], 'only the trade past the grace owes its plan')
  assert.deepEqual(o.sample[0].missing, ['trade_plan'])
  assert.ok(!subjects(o).includes(`trade:${submitting}`) && !subjects(o).includes(`trade:${fresh}`))
  const s = one(db, 'STK-04')
  assert.ok(subjects(s).includes(`trade:${settled}`), 'twenty minutes open with no monitored row is stuck')
  assert.ok(!subjects(s).includes(`trade:${fresh}`), 'five minutes is still the fill being written')
})

test('N8: an explicit account nothing knows is not "nothing stuck" — every rule not measurable; a registered account keeps its real 0', () => {
  const db = initDB(':memory:')
  risk(db, { proposal_json: '{}' }) // account A has data
  const typo = build(db, { account: '4613005' })
  assert.equal(typo.scope.registered, false)
  for (const r of typo.rules) assert.equal(r.measurable, false, `${r.id} measured an account nothing knows`)
  assert.match(ruleOf(typo, 'STK-01').reason, /not in the account registry and no record carries it/)
  assert.equal(typo.summary.stuck.measurable, false)
  // Registered, with nothing to judge: the stuck 0 is a real 0.
  ins(db, 'accounts', { account_id: '47790949', enabled: 1 })
  const quiet = build(db, { account: '47790949' })
  assert.equal(quiet.scope.registered, true)
  assert.equal(quiet.summary.stuck.measurable, true)
  assert.equal(ruleOf(quiet, 'STK-01').measurable, true)
  // Carried by records though not registered (a deregistered account): judged as before.
  const carried = build(db, { account: A })
  assert.equal(carried.scope.registered, false)
  assert.equal(ruleOf(carried, 'PRE-01').violations, 1)
  assert.equal(carried.summary.stuck.measurable, true)
})

test('N4: the shared machinery is inside the helpers pin — context statements, loadContext, runRule, summarise, the limits', () => {
  for (const k of ['loadContext', 'runRule', 'summarise', 'recordKeyOf', 'accountRegistered']) assert.equal(typeof JUDGE_HELPERS[k], 'function', k)
  assert.ok(JUDGE_HELPERS.constants.includes(CONTEXT_SQL.approvals.replace(/\n/g, '\\n')), 'the approvals window behind PRE-03')
  assert.ok(JUDGE_HELPERS.constants.includes(CONTEXT_SQL.riskForTrades.replace(/\n/g, '\\n')), 'the risk events behind ORD-02 and CLS-04')
  assert.ok(JUDGE_HELPERS.constants.includes('|50000|'), 'DEFAULT_POPULATION_LIMIT')
})

test('N3: startOrderLifecycle — first pass at firstMs, then every tickMs; a pass still running is skipped, not doubled; stop clears both timers', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    let reads = 0
    let release = null
    const read = () => { reads++; return new Promise(resolve => { release = () => resolve(null) }) }
    const beats = []
    const heartbeat = { beat: (_db, name, o) => beats.push([name, o.ok]) }
    const stop = startOrderLifecycle({}, { tickMs: 600_000, firstMs: 60_000, read, heartbeat })
    mock.timers.tick(59_999)
    assert.equal(reads, 0, 'nothing before firstMs')
    mock.timers.tick(1)
    assert.equal(reads, 1, 'the first pass at firstMs')
    mock.timers.tick(600_000)
    mock.timers.tick(600_000)
    assert.equal(reads, 1, 're-entrancy guard: a pass still running is not started again')
    release()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    assert.deepEqual(beats, [['order_lifecycle', false]], 'the pass ended (a null report is a failed build) and beat once')
    mock.timers.tick(600_000)
    assert.equal(reads, 2, 'the next tick runs once the previous pass has finished')
    release()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    stop()
    mock.timers.tick(10 * 600_000)
    assert.equal(reads, 2, 'stopped: no timer left')
  } finally { mock.timers.reset() }
})

test('N3: the loop starts the ticker (failure mode #4: a call site the module cannot see)', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  const start = src.indexOf('export function startLoop(db)')
  assert.ok(start > 0)
  const body = src.slice(start, start + 40_000)
  assert.match(body, /import\('\.\/services\/order-lifecycle-ticker\.js'\)\s*\.then\(m => m\.startOrderLifecycle\(db\)\)/)
})

// ---------------------------------------------------------------------------
// 10. V3 L1c — the stage headline counts every violation. Measured in
// production with L1b live (25-09-2026): STK-11 flagged pnl_reconcile under
// `unattributed` (population 35, violations 1) and STK-08 an outbox, while
// the report scoped to the selected account read summary.stuck.new = 19 —
// the unattributed violations were in no stage count. A controller is not an
// account record: it is counted in the headline and named on its own line.
// ---------------------------------------------------------------------------
const stalledController = db => {
  ins(db, 'controller_heartbeats', { name: 'minute_review', last_run_at: iso(NOW - 3_600_000), last_ok_at: iso(NOW - 3_600_000), consecutive_failures: 0, runs: 500 })
  assert.equal(heartbeatView(db, { now: new Date(NOW) }).find(v => v.name === 'minute_review').verdict, 'stalled', 'precondition: the heartbeat itself says stalled')
}
const partsAddUp = (s, label) => assert.equal(s.new, s.records + s.unattributed + s.controllers, `${label}: the headline is the sum of its named parts`)

test('L1c: a stalled controller and no account records reads stuck > 0 — all accounts, the selected account and an explicit one', () => {
  const db = initDB(':memory:')
  stalledController(db)
  ins(db, 'accounts', { account_id: A, enabled: 1 })
  setState(db, 'ctrader_account_id', A)
  for (const t of ['trades', 'pending_orders', 'entry_intents', 'risk_events', 'monitored_positions', 'telegram_outbox']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `precondition: no account record in ${t}`)
  }
  const reports = [['all', build(db)], ['selected', build(db, { account: null })], ['explicit', build(db, { account: A })]]
  assert.equal(reports[1][1].scope.account, A, 'the selected account is the scope')
  assert.equal(reports[1][1].scope.explicit, false)
  for (const [label, report] of reports) {
    const s = report.summary.stuck
    assert.ok(s.new > 0, `${label}: a stalled controller is stuck, read ${s.new}`)
    assert.equal(s.new, 1, label)
    assert.equal(s.controllers, 1, label)
    assert.equal(s.records, 0, label)
    assert.equal(s.unattributed, 0, label)
    partsAddUp(s, label)
    assert.deepEqual(s.controllerNames, ['minute_review: stalled'], label)
    assert.equal(s.measurable, true, label)
    assert.equal(s.note, '1 stuck — 0 account record(s) · controllers: 1 stalled (minute_review: stalled)', label)
    assert.deepEqual(report.accounts.filter(a => a.stage === 'stuck').map(a => [a.account, a.new]), [[CONTROLLERS_LINE, 1]], `${label}: its own line, not an account's`)
  }
  // The rule's own counts still never credit it to the account asked for (VERIFY correction 10) — it is named beside.
  const scoped = ruleOf(build(db, { account: A }), 'STK-11')
  assert.equal(scoped.violations, 0)
  assert.equal(scoped.unattributed.violations, 1)
  assert.deepEqual(scoped.sample, [])
  assert.deepEqual(scoped.unattributedSample.map(e => [e.subject, e.class]), [['controller:minute_review', 'stalled']])
  assert.equal(ruleOf(build(db), 'STK-11').unattributedSample, undefined, 'all accounts: already in the sample')
  // The goal row and the daily line read the all-accounts snapshot: off track, the controller named.
  withSnapshot(db, build(db))
  const g = lifecycleGoals(readSnapshot(getState, db), DEFAULT_GOAL_TARGETS, NOW).find(r => r.id === 'lifecycle_stuck')
  assert.equal(g.verdict, 'off_track')
  assert.equal(g.current, 1)
  assert.match(g.note, /^1 stuck — 0 account record\(s\) · controllers: 1 stalled \(minute_review: stalled\) — STK-11 controller_failing 1$/)
  assert.match(g.metric, /registered controllers stalled or failing/)
  const lines = lifecycleReportLines(readSnapshot(getState, db))
  assert.match(lines[0], /; stuck 1$/)
  assert.ok(lines.includes('  stuck: 1 stuck — 0 account record(s) · controllers: 1 stalled (minute_review: stalled)'), lines.join('\n'))
})

test('L1c: scoped to one account, the headline is its records plus every unattributed one beside it — never credited to it, never dropped', () => {
  const db = initDB(':memory:')
  stalledController(db)
  const onA = trade(db, { account_id: A, status: 'submitting', ctrader_position_id: null, opened_at: '2026-09-26 11:00:00' })
  const onB = trade(db, { account_id: B, status: 'submitting', ctrader_position_id: null, opened_at: '2026-09-26 11:00:00' })
  ins(db, 'telegram_outbox', { queued_at: '2026-09-24T00:00:00.000Z', kind: 'alert', priority: 'normal', text: 'x', sent_at: null }) // STK-08: no account
  risk(db, { account_id: A }) // a clean approval on A: the pre-order stage has something of A's to judge
  const nullApproval = risk(db, { account_id: null, proposal_json: '{"strategy":"x"}' }) // PRE-01, new, no account
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM risk_events WHERE account_id IS NULL').get().n, 1, 'precondition')
  const a = build(db, { account: A })
  const s = a.summary.stuck
  assert.equal(s.new, 3, 'A\'s in-flight trade + the outbox + the stalled controller')
  assert.deepEqual([s.records, s.unattributed, s.controllers], [1, 1, 1])
  partsAddUp(s, 'scoped stuck')
  assert.equal(s.note, '3 stuck — 1 account record(s) · 1 with no account · controllers: 1 stalled (minute_review: stalled)')
  assert.deepEqual(a.accounts.filter(x => x.stage === 'stuck').map(x => [x.account, x.new]), [[A, 1], [CONTROLLERS_LINE, 1], ['unattributed', 1]])
  // The rules' own counts are unchanged: A's only.
  assert.deepEqual(subjects(ruleOf(a, 'STK-03')), [`trade:${onA}`], 'B\'s trade is not in A\'s report')
  assert.equal(ruleOf(a, 'STK-08').violations, 0)
  assert.equal(ruleOf(a, 'STK-08').unattributed.violations, 1)
  assert.deepEqual(ruleOf(a, 'STK-08').unattributedSample.map(e => e.subject), ['outbox:telegram'])
  assert.equal(ruleOf(a, 'PRE-01').violations, 0, 'the NULL-account approval is not credited to A (VERIFY correction 10)')
  // …and the pre-order stage counts that approval beside A.
  const p = a.summary.pre_order
  assert.deepEqual([p.new, p.records, p.unattributed, p.controllers], [1, 0, 1, 0])
  assert.equal(p.measurable, true)
  assert.equal(p.note, '1 new defective — 0 account record(s) · 1 with no account')
  assert.deepEqual(ruleOf(a, 'PRE-01').unattributedSample.map(e => e.subject), [`risk_event:${nullApproval}`])
  // All accounts: the headline is the distinct records the samples name (the pre-L1c count), with its parts.
  const all = build(db)
  const st = all.summary.stuck
  assert.equal(st.new, 4, 'B\'s trade too')
  assert.deepEqual([st.records, st.unattributed, st.controllers], [2, 1, 1])
  partsAddUp(st, 'all stuck')
  const named = new Set(all.stages.stuck.filter(r => r.severity === 'defect').flatMap(r => r.sample.filter(e => e.new).map(e => e.record)))
  assert.equal(st.new, named.size, 'all accounts: the headline is still the distinct records named')
  assert.ok(named.has(`trade:${onB}`) && named.has('controller:minute_review') && named.has('outbox:telegram'))
  assert.deepEqual(all.accounts.filter(x => x.stage === 'stuck').map(x => [x.account, x.new]), [[B, 1], [A, 1], [CONTROLLERS_LINE, 1], ['unattributed', 1]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))))
  for (const [label, r] of [['scoped', a], ['all', all]]) for (const stage of STAGES) partsAddUp(r.summary[stage], `${label} ${stage}`)
  // The daily line names the parts.
  withSnapshot(db, all)
  assert.ok(lifecycleReportLines(readSnapshot(getState, db)).includes('  stuck: 4 stuck — 2 account record(s) · 1 with no account · controllers: 1 stalled (minute_review: stalled)'))
})

test('L1c: an explicit account nothing knows stays not measurable, and still says the controller it counted', () => {
  const db = initDB(':memory:')
  stalledController(db)
  const typo = build(db, { account: '4613005' })
  assert.equal(typo.scope.registered, false)
  assert.equal(typo.summary.stuck.measurable, false, 'N8 still holds')
  assert.equal(typo.summary.stuck.controllers, 1)
  assert.match(typo.summary.stuck.note, /^not measurable: .*; counted: 1 stuck — 0 account record\(s\) · controllers: 1 stalled \(minute_review: stalled\)$/)
})

test('L1c: a new unattributed defect beside an account with only legacy rows is judged new — not "nothing new to judge"', () => {
  const db = initDB(':memory:')
  risk(db, { account_id: A, created_at: OLD }) // A's only approval predates the start: legacy population
  risk(db, { account_id: null, proposal_json: '{"strategy":"x"}' }) // new, defective, no account
  const r = build(db, { account: A })
  assert.equal(ruleOf(r, 'PRE-01').populationNew, 0, 'precondition: nothing new of A\'s own')
  const p = r.summary.pre_order
  assert.equal(p.measurable, true)
  assert.equal(p.populationNew, 1, 'the new row beside A was judged')
  assert.equal(p.new, 1)
  assert.equal(p.note, '1 new defective — 0 account record(s) · 1 with no account')
})

test('L1c: a snapshot written before L1c (no parts) reads as before; the unattributed sample is bounded', () => {
  assert.equal(stageCountPhrase({ new: 19 }, 'stuck'), '19 stuck record(s)')
  assert.equal(stageCountPhrase({ new: 0, controllers: 0, unattributed: 0 }, 'order'), '0 new defective record(s)')
  assert.equal(stageCountPhrase({ new: 20, records: 19, unattributed: 0, controllers: 1, controllerNames: ['pnl_reconcile: error'] }, 'stuck'),
    '20 stuck — 19 account record(s) · controllers: 1 stalled (pnl_reconcile: error)')
  const old = { at: iso(NOW), acceptanceStart: START, summary: Object.fromEntries(STAGES.map(st => [st, { new: st === 'stuck' ? 19 : 0, legacy: 0, notices: 0, measurable: true, populationNew: 1, unreadable: [], truncated: [] }])), rules: [] }
  assert.equal(lifecycleGoals(old, DEFAULT_GOAL_TARGETS, NOW).find(r => r.id === 'lifecycle_stuck').note, '19 stuck record(s)')
  assert.equal(lifecycleReportLines(old).filter(l => /^ {2}stuck: /.test(l)).length, 0)
  const db = initDB(':memory:')
  for (let i = 0; i < UNATTRIBUTED_SAMPLE_MAX + 3; i++) risk(db, { account_id: null, proposal_json: '{}' })
  risk(db, { account_id: A })
  const r = build(db, { account: A })
  assert.equal(ruleOf(r, 'PRE-01').unattributed.violations, UNATTRIBUTED_SAMPLE_MAX + 3)
  assert.equal(ruleOf(r, 'PRE-01').unattributedSample.length, UNATTRIBUTED_SAMPLE_MAX)
  assert.equal(r.summary.pre_order.unattributed, UNATTRIBUTED_SAMPLE_MAX + 3, 'the count is whole; only the naming is bounded')
})

// ---------------------------------------------------------------------------
// V3 B4b (B4 checker nit 5): the close row NAMES each CLS-04 / CLS-03 record —
// account, symbol, position id, what is missing, the refused class from
// position-history's classifier and its reason — beside the unchanged count.
// ---------------------------------------------------------------------------
const GENERIC = 'closed at the broker (manual close or broker-side SL/TP fill) — not closed by the bot'
/** A close whose position record is refused (CLS-04), in the production shapes of 26-09. */
function refusedClose(db, { symbol = 'EURUSD', missing = ['direction_reason'], closeReason = null, origin = null, riskAt = null, gaveUp = false, closedAt = NEW } = {}) {
  const id = goodClose(db, { symbol, closed_at: closedAt, ...(closedAt !== NEW ? { opened_at: closedAt } : {}), ...(closeReason ? { close_reason: closeReason } : {}), ...(origin ? { origin } : {}) })
  const t = db.prepare('SELECT * FROM trades WHERE id = ?').get(id)
  if (riskAt) db.prepare('UPDATE risk_events SET created_at = ? WHERE id = ?').run(riskAt, t.risk_event_id)
  db.prepare('DELETE FROM position_history WHERE trade_id = ?').run(id)
  ins(db, 'position_history_incomplete', { account_id: A, ctrader_position_id: t.ctrader_position_id, symbol, closed_at_ms: t.closed_at_ms, missing_json: JSON.stringify(missing),
    partial_json: JSON.stringify({ trade_id: id, risk_event_id: t.risk_event_id, opened_at_ms: Date.parse(NEW), origin: t.origin, account_id: A, ctrader_position_id: t.ctrader_position_id }), built_at: NEW })
  if (gaveUp) ins(db, 'position_capture_queue', { account_id: A, position_id: t.ctrader_position_id, symbol, due_at_ms: 1, attempts: 6, state: 'gave_up', last_error: `missing: ${missing.join(', ')}`, settled_at: NEW })
  return { id, pid: t.ctrader_position_id }
}
const closeRow = (snap, now = NOW) => lifecycleGoals(snap, DEFAULT_GOAL_TARGETS, now).find(r => r.id === 'lifecycle_close')

test('B4b: the close row names each CLS-04 and CLS-03 record — account, symbol, position id, what is missing, the refused class and its reason — beside the unchanged count', async () => {
  const db = initDB(':memory:')
  // SGDJPY …0058 shape: refused for its reason, the capture gave up, and the close cause is generic — one record, three flags.
  const sg = refusedClose(db, { symbol: 'SGDJPY', closeReason: GENERIC, gaveUp: true })
  // Cocoa …0949 shape: a manual position — no writer here could hold its reason.
  const co = refusedClose(db, { symbol: 'Cocoa', origin: 'manual_broker', missing: ['direction_reason', 'strategy', 'planned_entry', 'risk_dist'] })
  // Entered between PR-D and PR-AL's fix: a gap this codebase built.
  const pf = refusedClose(db, { symbol: 'COIN.US', riskAt: '2026-09-15 00:00:00' })
  // A close only CLS-02 flags (its commission is missing): counted, not named.
  const other = goodClose(db, { closed_at: NEW, commission: null })
  // Fix round (checker nit 1): a LEGACY close — refused and with a generic
  // cause, so CLS-04 and CLS-03 both flag it — closed before the acceptance
  // start. Production holds ~250 such older records beside a count of 6; they
  // are counted as legacy and never named.
  const legacy = refusedClose(db, { symbol: 'GBPJPY', closeReason: GENERIC, closedAt: OLD, riskAt: OLD })
  assert.ok(Date.parse(OLD.replace(' ', 'T') + 'Z') < Date.parse(START), 'the legacy close predates the acceptance start')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM position_history_incomplete').get().n, 4, 'the three new refused records and the legacy one are in the database')
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM position_capture_queue WHERE state = 'gave_up'`).get().n, 1)

  const report = build(db)
  assert.equal(report.summary.close.new, 4, 'four distinct records: the three named and the CLS-02 one')
  // Precondition: the named rules DID flag the legacy record — as legacy — so
  // the filter below is exercised, not vacuously passed.
  assert.equal(ruleOf(report, 'CLS-04').legacyViolations, 1, 'CLS-04 flags the legacy refused record')
  assert.equal(ruleOf(report, 'CLS-03').legacyViolations, 1, 'CLS-03 flags the legacy generic cause')
  assert.equal(report.summary.close.legacy, 1, 'one legacy record in the close stage')
  const named = report.named.close
  assert.deepEqual(named.rules, NAMED_CLOSE_RULES)
  assert.equal(named.total, 3, 'the legacy record is not named: only new records are')
  assert.ok(!named.items.some(i => i.positionId === legacy.pid || i.tradeId === legacy.id), 'the legacy record is absent from the named items')
  assert.deepEqual(named.byClass, { live_gap: 1, post_contract_pre_fix: 1, outside_bot: 1, broker_evidence_pending: 0, labelled_unrecoverable: 0, pre_contract: 0 })
  assert.deepEqual(named.items.map(i => [i.positionId, i.class]), [[sg.pid, 'live_gap'], [pf.pid, 'post_contract_pre_fix'], [co.pid, 'outside_bot']], 'actionable class first')
  const [s1] = named.items
  assert.equal(s1.record, `position:${A}:${sg.pid}`)
  assert.equal(s1.account, A); assert.equal(s1.symbol, 'SGDJPY'); assert.equal(s1.tradeId, sg.id); assert.equal(s1.stored, 'refused')
  assert.deepEqual(s1.rules, ['CLS-03 generic', 'CLS-04 gave_up', 'CLS-04 incomplete'])
  assert.deepEqual(s1.missing, ['direction_reason', 'close_cause'], 'the stored missing field and the generic close cause; the gave-up "record" names no field')
  assert.match(s1.reason, /direction_reason: live_gap \(entered 2026-09-26T09:00:00Z \(risk event\), after #934's fix/)
  assert.match(s1.reason, /close_cause: live_gap \(no dated contract for this field\)/)
  assert.match(named.items[2].reason, /origin manual_broker/)
  // Checker nit 3: what each class was computed on — SGDJPY also on CLS-03's close_cause.
  assert.deepEqual(named.items.map(i => [i.positionId, i.classedOn]), [[sg.pid, 'stored missing + close flags'], [pf.pid, CLASSED_ON_REFUSED_VIEW], [co.pid, CLASSED_ON_REFUSED_VIEW]])
  // The SAME classifier, not a second one: each item's class and reason is classifyRefusedRecord's on that record.
  for (const it of named.items) {
    const row = db.prepare('SELECT partial_json FROM position_history_incomplete WHERE account_id = ? AND ctrader_position_id = ?').get(A, it.positionId)
    const c = classifyRefusedRecord(db, { record: JSON.parse(row.partial_json), missing: it.missing })
    assert.equal(it.class, c.class, it.record); assert.equal(it.reason, c.reason, it.record)
  }
  assert.ok(!named.items.some(i => i.tradeId === other), 'the CLS-02-only close is counted, not named')

  // The goal row, from the snapshot the goal table reads.
  const snap = withSnapshot(db, report)
  const row = closeRow(snap)
  assert.equal(row.verdict, 'off_track'); assert.equal(row.current, 4, 'the count is unchanged — nothing named leaves it')
  assert.deepEqual(row.split, { raw: 4, live_gap: 1, post_contract_pre_fix: 1, outside_bot: 1, broker_evidence_pending: 0, labelled_unrecoverable: 0, pre_contract: 0, other_rules: 1, classes: row.split.classes })
  const parts = Object.keys(REFUSED_CLASSES).reduce((n, k) => n + row.split[k], 0) + row.split.other_rules
  assert.equal(parts, row.split.raw, 'the split is a partition of the count')
  assert.equal(row.split.raw, row.current)
  assert.ok(!row.items.some(i => i.positionId === legacy.pid), 'the legacy record is not in the goal row either')
  assert.deepEqual(Object.keys(row.split.classes).sort(), [...Object.keys(REFUSED_CLASSES), 'other_rules'].sort())
  assert.equal(row.itemsTotal, 3); assert.deepEqual(row.items, snap.named.close.items)
  assert.ok(row.note.startsWith('4 new defective record(s) — '), `the existing headline is unchanged: ${row.note}`)
  assert.ok(row.note.includes(`; named 3 (CLS-04, CLS-03): live_gap 1, outside_bot 1, post_contract_pre_fix 1 — …0058 SGDJPY pos ${sg.pid} [live_gap], …0058 COIN.US pos ${pf.pid} [post_contract_pre_fix], …0058 Cocoa pos ${co.pid} [outside_bot]; items list 3 with what is missing, class and reason`), row.note)
  assert.ok(row.note.includes("; 1 listed item(s) classed on more than /state/position-history's refused view reads (classedOn: the close flags' fields, or a record completed from the flag key or ledger row), so the class there can differ"), row.note)
  assert.match(row.note, /; 1 flagged by other close rules only \(counted, not named\)$/)
  // The other rows are untouched by the naming.
  for (const r of lifecycleGoals(snap, DEFAULT_GOAL_TARGETS, NOW).filter(x => x.id !== 'lifecycle_close')) assert.ok(!('items' in r) && !('split' in r), r.id)
  // The goal table serves the same row, and its summary counts it once, off track.
  const t = await goalTable(db, { now: NOW })
  const g = t.goals.find(x => x.id === 'lifecycle_close')
  assert.deepEqual({ split: g.split, items: g.items, itemsTotal: g.itemsTotal, current: g.current, verdict: g.verdict }, { split: row.split, items: row.items, itemsTotal: 3, current: 4, verdict: 'off_track' })
  assert.equal(NAMED_RECORDS_MAX, GOAL_ITEMS_MAX, 'the lifecycle row caps its items where B4\'s rows do')
})

test('B4b: nothing is counted as recovered — a gave-up record stored complete since is still named and counted; the cap counts the rest; stale, pre-B4b and non-partitioning snapshots name nothing false', () => {
  // A capture that gave up while the position is stored complete now: still flagged by CLS-04, still named, still counted.
  const one = initDB(':memory:')
  const id = goodClose(one, { symbol: 'MSFT.US', closed_at: NEW })
  const pid = one.prepare('SELECT ctrader_position_id FROM trades WHERE id = ?').get(id).ctrader_position_id
  ins(one, 'position_capture_queue', { account_id: A, position_id: pid, symbol: 'MSFT.US', due_at_ms: 1, attempts: 6, state: 'gave_up', last_error: 'missing: direction_reason', settled_at: NEW })
  assert.equal(one.prepare('SELECT COUNT(*) AS n FROM position_history WHERE ctrader_position_id = ?').get(pid).n, 1, 'the complete record exists')
  const r1 = build(one)
  assert.equal(r1.summary.close.new, 1)
  const [it] = r1.named.close.items
  assert.deepEqual([it.positionId, it.symbol, it.stored, it.missing, it.class, it.rules], [pid, 'MSFT.US', 'complete', ['record'], 'live_gap', ['CLS-04 gave_up']])
  const row1 = closeRow({ ...compactSnapshot(r1), at: iso(NOW) })
  assert.equal(row1.current, 1); assert.equal(row1.split.raw, 1); assert.equal(row1.split.live_gap, 1)
  assert.ok(!Object.keys(row1.split).some(k => /recovered/.test(k)) && !r1.named.close.items.some(i => Object.keys(i).some(k => /recovered/.test(k))), 'no recovered bucket anywhere')

  // The cap: 55 refused records — 50 listed, every one counted and classed.
  const db = initDB(':memory:')
  for (let i = 0; i < 55; i++) refusedClose(db)
  const report = build(db)
  assert.equal(report.named.close.total, 55)
  assert.equal(report.named.close.items.length, NAMED_RECORDS_MAX)
  assert.equal(Object.values(report.named.close.byClass).reduce((a, b) => a + b, 0), 55, 'byClass covers the unlisted records too')
  const snap = { ...compactSnapshot(report), at: iso(NOW) }
  const row = closeRow(snap)
  assert.equal(row.current, 55); assert.equal(row.itemsTotal, 55); assert.equal(row.items.length, 50); assert.equal(row.split.live_gap, 55)
  assert.match(row.note, /, \+50 more; items list 50 with what is missing, class and reason, 5 more counted, not listed/)

  // Under the byte bound the samples go first, then the list; the counts never shrink.
  const fat = build(db)
  fat.named.close.items = fat.named.close.items.map(i => ({ ...i, reason: 'x'.repeat(2000) }))
  const small = compactSnapshot(fat)
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= SNAPSHOT_MAX_BYTES)
  assert.equal(small.samplesPerRule, 0, 'samples dropped before the named list')
  assert.equal(small.named.close.itemsListed, 10)
  assert.equal(small.named.close.total, 55); assert.deepEqual(small.named.close.byClass, fat.named.close.byClass)
  // A list shrunk to nothing still counts every record, and says none is listed.
  const empty = structuredClone(snap)
  empty.named.close.items = []
  const emptyRow = closeRow(empty)
  assert.equal(emptyRow.current, 55); assert.equal(emptyRow.itemsTotal, 55); assert.equal(emptyRow.split.live_gap, 55)
  assert.match(emptyRow.note, /; named 55 \(CLS-04, CLS-03\): live_gap 55; items list 0 with what is missing, class and reason, 55 more counted, not listed$/)

  // Stale: not evidence about now — nothing named.
  const stale = closeRow(snap, NOW + 31 * 60_000)
  assert.deepEqual([stale.verdict, stale.split, stale.items, stale.itemsTotal], ['not_measurable', null, null, null])
  // A snapshot written before B4b says it names nothing, rather than implying none.
  const { named: _unused, ...pre } = snap
  const preRow = closeRow(pre)
  assert.equal(preRow.current, 55); assert.equal(preRow.items, null)
  assert.match(preRow.note, /; records not named \(the snapshot predates B4b — the next pass names them\)$/)
  // A split that would not add up is withheld and said, never forced.
  const bad = structuredClone(snap)
  bad.named.close.total = 56
  const badRow = closeRow(bad)
  assert.equal(badRow.split, null); assert.equal(badRow.current, 55)
  assert.match(badRow.note, /split withheld — 56 named record\(s\) do not partition the count of 55/)
  // A failed naming pass is said.
  const err = structuredClone(snap)
  err.named.close = { rules: ['CLS-04', 'CLS-03'], total: null, byClass: null, items: [], error: 'naming unreadable: boom' }
  assert.match(closeRow(err).note, /; records not named — naming unreadable: boom$/)
})

test('B4b fix round: a lower-bound count withholds the split (as a stale snapshot does) and keeps the named items; a named rule that is itself partial makes the named count "at least"', () => {
  const db = initDB(':memory:')
  const sg = refusedClose(db, { symbol: 'SGDJPY', closeReason: GENERIC, gaveUp: true })
  const co = refusedClose(db, { symbol: 'Cocoa', origin: 'manual_broker', missing: ['direction_reason', 'strategy', 'planned_entry', 'risk_dist'] })
  goodClose(db, { closed_at: NEW, commission: null })
  const snap = withSnapshot(db, build(db))
  assert.equal(closeRow(snap).split?.raw, 3, 'precondition: the whole count carries its split')

  // Another close rule unreadable: the count of 3 leaves it out, so it is a lower bound.
  const partial = structuredClone(snap)
  partial.summary.close.unreadable = [{ id: 'CLS-01', reason: 'no such table: trades' }]
  // Under the default target (0) the count proves off_track ("at least"); under
  // a target above it the verdict is not_measurable and current is null — the
  // case where a split would show a lower bound as the whole.
  for (const [targets, verdict, current] of [[DEFAULT_GOAL_TARGETS, 'off_track', 3], [{ ...DEFAULT_GOAL_TARGETS, lifecycleNewDefectsMax: 10 }, 'not_measurable', null]]) {
    const row = lifecycleGoals(partial, targets, NOW).find(r => r.id === 'lifecycle_close')
    assert.equal(row.verdict, verdict); assert.equal(row.current, current)
    assert.equal(row.split, null, `${verdict}: the split of a lower bound is withheld, not shown as whole`)
    assert.equal(row.itemsTotal, 2, 'the named records stay: each was read and classed now')
    assert.deepEqual(row.items.map(i => i.positionId), [sg.pid, co.pid])
    assert.match(row.note, /unreadable: CLS-01 \(no such table: trades\)/, 'the main note already says which rule')
    assert.match(row.note, /; split withheld — the count of 3 is a lower bound \(a close rule unreadable or truncated\), so no split of it is whole$/)
    assert.ok(row.note.includes('; named 2 (CLS-04, CLS-03): '), 'CLS-01 is not a named rule: the named count is whole')
    assert.ok(!/flagged by other close rules only/.test(row.note), 'no other_rules figure is derived from a lower bound')
  }
  // A NAMED rule truncated at its population bound: the named count is a lower bound too.
  const trunc = structuredClone(snap)
  trunc.summary.close.truncated = ['CLS-04']
  const tr = closeRow(trunc)
  assert.equal(tr.split, null); assert.equal(tr.itemsTotal, 2)
  assert.ok(tr.note.includes('; named at least 2 (CLS-04, CLS-03; CLS-04 unreadable or truncated): '), tr.note)
  assert.match(tr.note, /; split withheld — the count of 3 is a lower bound/)
  // The whole snapshot is untouched by the checks above.
  assert.equal(closeRow(snap).split.raw, 3)
})

test('B4b fix round: one record, two classes — the goal row classes on the close flags too, the refused view on the stored record alone, and classedOn says so', () => {
  const db = initDB(':memory:')
  // Entered before PR-D (#899): its missing direction_reason is pre_contract.
  // Its close cause is generic, so CLS-03 adds close_cause — a live gap.
  const r = refusedClose(db, { symbol: 'MSFT.US', closeReason: GENERIC, riskAt: '2026-09-01 00:00:00' })
  const view = positionHistoryView(db).refused.rows.find(x => x.ctrader_position_id === r.pid)
  assert.equal(view.class, 'pre_contract', '/state/position-history classes it on its stored missing fields alone')
  assert.deepEqual(view.missing, ['direction_reason'])

  const snap = withSnapshot(db, build(db))
  const [it] = snap.named.close.items
  assert.equal(it.positionId, r.pid)
  assert.deepEqual(it.missing, ['direction_reason', 'close_cause'])
  assert.equal(it.class, 'live_gap', 'the goal row classes it on the close flags too')
  assert.equal(it.classedOn, 'stored missing + close flags', 'and says what it classed on')
  assert.notEqual(it.classedOn, CLASSED_ON_REFUSED_VIEW)
  const row = closeRow(snap)
  assert.deepEqual(row.items, snap.named.close.items)
  assert.match(row.note, /; 1 listed item\(s\) classed on more than \/state\/position-history's refused view reads \(classedOn: the close flags' fields, or a record completed from the flag key or ledger row\), so the class there can differ/)

  // Without the CLS-03 flag the two views agree, and nothing is said.
  const db2 = initDB(':memory:')
  const r2 = refusedClose(db2, { symbol: 'MSFT.US', riskAt: '2026-09-01 00:00:00' })
  const snap2 = withSnapshot(db2, build(db2))
  const [it2] = snap2.named.close.items
  assert.equal(it2.class, positionHistoryView(db2).refused.rows.find(x => x.ctrader_position_id === r2.pid).class)
  assert.equal(it2.classedOn, CLASSED_ON_REFUSED_VIEW)
  assert.ok(!/classed on more than/.test(closeRow(snap2).note))
})
