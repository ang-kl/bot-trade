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
//   8. goal rows, inspector, daily report and the ticker read one snapshot.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { initDB, getState, setState } from '../db.js'
import {
  RULES, RULESET_VERSION, HELPERS_VERSION, JUDGE_HELPERS, CONTEXT_SQL, STAGES, SNAPSHOT_KEY, SNAPSHOT_OPTIONS, SNAPSHOT_MAX_BYTES,
  buildOrderLifecycle, compactSnapshot, lifecycleGoals, normaliseLifecycleOptions, readSnapshot,
  inspectLifecycleRegression, lifecycleRuleRecurs, lifecycleReportLines, loadLifecycleConfig, GENERIC_CLOSE_RE,
} from './order-lifecycle.js'
import { runOrderLifecyclePass } from './order-lifecycle-ticker.js'
import { goalTable, DEFAULT_GOAL_TARGETS } from './goal-table.js'
import { runLogInspector, evalFalsifierMetric, INSPECTIONS } from './log-inspector.js'
import { buildDailyReport, DAILY_REPORT_MAX_CHARS } from './daily-report.js'
import { CONTROLLERS, heartbeatView } from './heartbeat.js'
import { scoreRefusedOpportunities } from './refusal-ledger.js'

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
      for (const at of ['2026-09-26 06:00:00', '2026-09-26 09:00:00']) ins(db, 'action_log', { method: 'POSITION_NO_TARGET', path: '/protection-audit', at, body: JSON.stringify({ positionId: '6601', symbol: 'EURUSD' }) })
      assert.ok(id)
      return { ids: [`position:${A}:6601`], present: () => assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE method = 'POSITION_NO_TARGET'`).get().n, 2) }
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
    red(db) {
      ins(db, 'controller_heartbeats', { name: 'pnl_reconcile', last_run_at: NEW, last_ok_at: '2026-09-21T15:11:26.759Z', last_error: 'position_ledger_ambiguous', consecutive_failures: 1701, runs: 9000 })
      return { ids: ['controller:pnl_reconcile'], present: () => assert.equal(db.prepare(`SELECT consecutive_failures FROM controller_heartbeats`).get().consecutive_failures, 1701) }
    },
    green: db => { ins(db, 'controller_heartbeats', { name: 'pnl_reconcile', last_run_at: NEW, last_ok_at: NEW, consecutive_failures: 0, runs: 9000 }) },
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
  for (const e of r.sample) assert.equal(e.resolverExists, false, 'pending-fib has no resolver (loop.js:114)')
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

test('known answer: {t,o,h,l,c} bars through the real refusal scorer become no_bars, and PRE-02 names the row', async () => {
  const db = initDB(':memory:')
  ins(db, 'risk_events', { symbol: 'EURUSD', side: 'BUY', approved: 0, veto_reason: 'bad_rr 1.50<3', account_id: A, opportunity_key: 'opp-objbars',
    created_at: '2026-09-20 10:00:00', proposal_json: JSON.stringify({ entry: 1.1, sl: 1.09, tp1: 1.13, timeframe: '1h', strategy: 'x' }) })
  const objectBars = Array.from({ length: 60 }, (_, i) => ({ t: Date.parse('2026-09-20T10:00:00Z') + i * 3_600_000, o: 1.1, h: 1.12, l: 1.095, c: 1.11 }))
  await scoreRefusedOpportunities(db, async () => objectBars, { nowMs: NOW - 3_600_000 })
  assert.equal(db.prepare(`SELECT outcome FROM refusal_scores WHERE opportunity_key = 'opp-objbars'`).get()?.outcome, 'no_bars', 'the scorer filters bars by b?.[0] (refusal-ledger.js:204)')
  const r = one(db, 'PRE-02')
  assert.deepEqual(subjects(r), ['refusal:opp-objbars'])
  assert.match(r.note, /scored 0 while no_bars 1/)
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
const PINNED_HELPERS = { [`helpers@1`]: 'c6bd325eb70607e2' }
const PINNED = {
  'PRE-01@1': 'ef8952cc321a0a03', 'PRE-02@1': '1d3934917924fe6a', 'PRE-03@1': 'bf01d978a6b93535', 'PRE-04@1': 'fa04e500d8a0ca47',
  'PRE-05@1': 'c7aeb7460046a6fc',
  'ORD-01@1': 'dc44a46fa075080a', 'ORD-02@1': '520f853e457966a7', 'ORD-03@1': 'c3efa49b62d76c7e', 'ORD-04@1': '0576f08d9e583115',
  'ORD-05@1': 'ff61f53fcc0a5c36', 'ORD-06@1': '75ca883642df5b6e', 'ORD-07@1': '48d7a24785139f8d', 'ORD-08@1': '70ab525d959eef60',
  'ORD-09@1': '76e16b5ec574fd5f', 'ORD-10@1': '6aac17826225e763',
  'CLS-01@1': 'd1c6f94d5d127f9b', 'CLS-02@1': '1f3a45c656e2f94b', 'CLS-03@1': '40b74e5ba9111a98', 'CLS-04@1': '4313b95a7b55beb1',
  'CLS-05@1': '2cca97ff9080477d', 'CLS-06@1': 'a4bb8873fe57a5f1', 'CLS-07@1': '77e677b6b8b4b901', 'CLS-08@1': '540f253a1c1c8eab',
  'CLS-09@1': '9985d3c5b7b5b9cf',
  'STK-01@1': 'b7c8a96e077092aa', 'STK-02@1': '995fd7c14286ef8e', 'STK-03@1': '9e6eef34c7fcf44e', 'STK-04@1': '211b880d01176305',
  'STK-05@1': 'fd6653d6850b9006', 'STK-06@1': '221e983558ccd9be', 'STK-07@1': 'bf4c98bdacf7c497', 'STK-08@1': '3fecf4ac1c0a0ce3',
  'STK-09@1': '9006966342612525', 'STK-10@1': '60a7854f87507cb9', 'STK-11@1': '69ba5ed74964ef8a',
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
  // true: a violation newer than sinceMs; false: none newer; null: no snapshot.
  assert.equal(evalFalsifierMetric(db, { kind: 'lifecycle_rule_recurs', ruleId: 'PRE-01', sinceMs: Date.parse(snap.rules[0].newestAt) - 1 }), true)
  assert.equal(evalFalsifierMetric(db, { kind: 'lifecycle_rule_recurs', ruleId: 'PRE-01', sinceMs: NOW + 1 }), false)
  assert.equal(evalFalsifierMetric(initDB(':memory:'), { kind: 'lifecycle_rule_recurs', ruleId: 'PRE-01', sinceMs: 0 }), null)
  assert.equal(lifecycleRuleRecurs(snap, { ruleId: 'NOPE', sinceMs: 0 }), null)
  assert.deepEqual(inspectLifecycleRegression(null, NOW), [])
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
