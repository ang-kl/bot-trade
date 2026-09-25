// ---------------------------------------------------------------------------
// agent/services/order-lifecycle.js — V3 L1. Owner order 25-09-2026 16:50 SGT:
// flag (a) pre-order, (b) order and (c) close records that fail to store or
// are incomplete, and (d) anything stuck.
//
// REPORTING ONLY. Nothing here writes a trade, an intent, an order or a plan.
// Every gap it names is listed with the writer or resolver that would close
// it (`fix`), and those fixes are separate PRs (LIFECYCLE-SPEC §7).
//
// THE RULES ARE DATA. Each rule is { id, key, version, stage, severity, fix,
// cite, sql, when, judge }: one bounded SQL statement for its population and
// a pure judge per row. A rule's version is pinned to a hash of its sql,
// when() and judge() (order-lifecycle.test.js), so changing what a rule means
// without bumping its version fails the gate. Line citations are at origin/
// main f1d9223, where the evidence map was read.
//
// NEW VERSUS LEGACY. `acceptanceStart` (agent/config/order-lifecycle.json)
// splits a defect made on or after it (NEW: what the goal rows count) from one
// inside the window but before it (LEGACY: shown, not counted). Without the
// split the flags would inherit the saturation of close_completeness and
// trade_reasons, whose cutoffs predate every writer being judged here.
//
// A ZERO THAT CAME FROM NO INPUT IS NOT A PASS. A pre-order, order or close
// rule with no population in its window reports measurable: false with the
// reason; a stuck rule is current state and always measurable. A rule whose
// statement fails reports its error, never a count of 0.
//
// BOUNDED. Every statement ends in LIMIT; a rule that reaches it says
// `truncated: true` rather than presenting a prefix as the whole. The four
// large tables (risk_events 560 MB, telegram_outbox 380 MB, action_log,
// refusal_scores) are read only through an index or a primary-key range —
// order-lifecycle.test.js asserts EXPLAIN QUERY PLAN shows no SCAN of them.
// The build runs on a read-only worker connection (performance-populations
// kind 'order-lifecycle'); the management connection runs none of it.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { labelIntentId, isOurs } from '../lib/trade-labels.js'
import { CLEAN_BOT_ORIGINS } from '../lib/trade-origin.js'
import { requestedAccount, scopeReport } from '../lib/account-scope.js'
import { RETIRED_CONTROLLERS } from '../shared/controller-groups.js'

export const SCHEMA_VERSION = 1
export const SNAPSHOT_KEY = 'order_lifecycle_last_json'
export const CONTROLLER_NAME = 'order_lifecycle'
export const TICK_MS = 10 * 60_000
export const SNAPSHOT_MAX_BYTES = 64 * 1024
export const RESPONSE_MAX_BYTES = 512 * 1024
export const DEFAULT_POPULATION_LIMIT = 50_000
export const REFUSAL_POPULATION_LIMIT = 200_000
export const CONTEXT_LIMIT = 200_000
/** action_log has no index: it is read only in this primary-key window. */
export const ACTION_LOG_WINDOW_IDS = 5_000
/** A stop this far from its entry, as a fraction of the entry, is not a stop in price units (ORD-03, CLS-09). */
export const ABSURD_RISK_FRACTION = 0.5
export const STAGES = Object.freeze(['pre_order', 'order', 'close', 'stuck'])
export const SAMPLE_LIMIT = 25
export const SAMPLE_LIMIT_ONE_RULE = 200

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000
const OUT = Symbol('not-in-population')
const TERMINAL_INTENT = ['FILLED', 'REJECTED', 'RELEASED', 'EXPIRED']
const LIMIT_PRODUCERS = new Set(['closed_market_limits', 'pending_fib_orders'])
/**
 * Close reasons that attribute nothing (VERIFY correction 5): the reconciler's
 * generic sentence (reconciler.js:118) and its NO-STOP variant (:1079), the
 * monitor's `already_closed` (loop.js:2053, :2140) and the stale sweep
 * (reconciler.js:730).
 */
export const GENERIC_CLOSE_RE = /^(closed at the broker\b|already_closed$|stale reconcile:)/

// ---------------------------------------------------------------- helpers
export function tsMs(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).trim()
  if (/^\d{12,14}$/.test(s)) return Number(s)
  const t = /[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? Date.parse(s) : Date.parse(s.replace(' ', 'T') + 'Z')
  return Number.isFinite(t) ? t : null
}
const iso = ms => (ms == null ? null : new Date(ms).toISOString())
/** SQLite datetime() format; also sorts below an ISO string of the same date, so it is a safe coarse lower bound for both. */
const spaceTs = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const blank = v => v == null || (typeof v === 'string' && v.trim() === '')
const num = v => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const acctOf = v => (blank(v) ? null : String(v).trim())
const idKey = (acct, pid) => `${acct ?? ''}:${pid}`
const tail = a => (a == null ? '(no account)' : `…${String(a).slice(-4)}`)
const cut = (s, n = 160) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const upper = v => String(v ?? '').trim().toUpperCase()
function dirOf(v) {
  const s = upper(v)
  if (s === 'BUY' || s === 'LONG' || s === '1') return 1
  if (s === 'SELL' || s === 'SHORT' || s === '-1') return -1
  return null
}
const ours = label => { try { return isOurs(label || '') } catch { return false } }
const intentTag = label => { try { return labelIntentId(label) } catch { return null } }
const parseJson = s => { try { return typeof s === 'string' ? JSON.parse(s) : null } catch { return undefined } }
const directionReasonOf = p => (p && typeof p === 'object' ? (p.direction_reason ?? p.directionReason) : null)

/** Stop (and target) on the wrong side of the entry for the direction. */
function sideProblems(dir, entry, stop, target) {
  const out = []
  if (dir == null || entry == null) return out
  if (stop != null && (dir > 0 ? stop >= entry : stop <= entry)) out.push('sl_wrong_side')
  if (target != null && (dir > 0 ? target <= entry : target >= entry)) out.push('tp_wrong_side')
  return out
}
function riskScaleWrong(entry, stop, riskDist) {
  const rd = riskDist ?? (entry != null && stop != null ? Math.abs(entry - stop) : null)
  return entry != null && entry > 0 && rd != null && rd / entry > ABSURD_RISK_FRACTION
}
/**
 * The bot's own trade: a clean origin, our label, an intent tag, or an origin
 * that says nothing (NULL / 'unknown' — itself the violation principle 4
 * forbids). VERIFY correction 8: an adopted row with neither our label nor a
 * tag is external, not the bot's.
 */
function botTrade(t) {
  if (CLEAN_BOT_ORIGINS.includes(t.origin)) return true
  if (t.origin == null || t.origin === 'unknown') return true
  return ours(t.label_raw) || intentTag(t.label_raw) != null
}

// ---------------------------------------------------------------- config
export function loadLifecycleConfig() {
  let raw = {}
  try { raw = JSON.parse(readFileSync(new URL('../config/order-lifecycle.json', import.meta.url), 'utf8')) } catch { raw = {} }
  const start = typeof raw.acceptanceStart === 'string' && Number.isFinite(Date.parse(raw.acceptanceStart)) ? raw.acceptanceStart : '2026-09-25T08:50:00Z'
  const days = Number.isFinite(Number(raw.windowDays)) && Number(raw.windowDays) >= 1 ? Math.min(90, Math.floor(Number(raw.windowDays))) : 30
  return { acceptanceStart: new Date(Date.parse(start)).toISOString(), acceptanceStartStatus: raw.acceptanceStartStatus ?? null, windowDays: days }
}

// ---------------------------------------------------------------- context
// Small tables read whole (each under 1 MB at production size, /state/storage
// 25-09-2026), the risk events the trades reference by primary key, and the
// last ACTION_LOG_WINDOW_IDS action_log rows by primary-key range.
export const CONTEXT_SQL = Object.freeze({
  trades: `SELECT id, account_id, symbol, side, status, origin, label_raw, label_strategy, strategy, risk_event_id,
                  ctrader_position_id, opened_at, closed_at, closed_at_ms FROM trades ORDER BY id LIMIT ?`,
  plans: `SELECT trade_id, strategy, planned_entry, planned_sl, planned_tp, risk_dist FROM trade_plans LIMIT ?`,
  monitored: `SELECT id, trade_id, account_id, status, broker_volume_units, label_raw FROM monitored_positions ORDER BY id LIMIT ?`,
  deals: `SELECT deal_id, position_id, account_id, symbol, lots, close_price, opened_at, closed_at, gross_pnl, swap, commission, net_pnl
            FROM broker_deals LIMIT ?`,
  brokerOrders: `SELECT order_id, account_id, symbol, status, is_bot, label, first_seen, gone_at FROM broker_orders LIMIT ?`,
  intents: `SELECT id, account_id, symbol, side, order_type, producer_id, state, broker_order_id, broker_position_id, created_at, resolved_at
              FROM entry_intents LIMIT ?`,
  postmortems: `SELECT trade_id FROM trade_postmortems LIMIT ?`,
  historyKeys: `SELECT account_id, ctrader_position_id FROM position_history LIMIT ?`,
  incompleteKeys: `SELECT account_id, ctrader_position_id FROM position_history_incomplete LIMIT ?`,
  capture: `SELECT account_id, position_id, state FROM position_capture_queue LIMIT ?`,
  riskForTrades: `SELECT id, account_id, symbol, side, approved, proposal_json FROM risk_events
                   WHERE id IN (SELECT risk_event_id FROM trades WHERE risk_event_id IS NOT NULL) LIMIT ?`,
  approvals: `SELECT id, account_id, symbol, side, created_at FROM risk_events
               WHERE disposition IN ('ordered', 'dropped', 'superseded', 'refused_post_approval') AND created_at >= ? AND approved = 1
              UNION ALL
              SELECT id, account_id, symbol, side, created_at FROM risk_events
               WHERE disposition IS NULL AND created_at >= ? AND approved = 1
              LIMIT ?`,
  state: `SELECT key, value FROM agent_state WHERE key IN ('independent_watchdog_json', 'ctrader_account_id') LIMIT ?`,
  drainLog: `SELECT id, at, account_id, body FROM action_log
              WHERE id > (SELECT COALESCE(MAX(id), 0) FROM action_log) - ${ACTION_LOG_WINDOW_IDS}
                AND method = 'LOOP' AND path = '/entry-mode/drain' ORDER BY id LIMIT ?`,
  actionLogFloor: `SELECT at FROM action_log WHERE id > (SELECT COALESCE(MAX(id), 0) FROM action_log) - ${ACTION_LOG_WINDOW_IDS} ORDER BY id LIMIT ?`,
})

function loadContext(db, win) {
  const ctx = { truncated: [] }
  const read = (name, params = [], limit = CONTEXT_LIMIT) => {
    const rows = db.prepare(CONTEXT_SQL[name]).all(...params, limit)
    if (limit > 1 && rows.length >= limit) ctx.truncated.push(name)
    return rows
  }
  ctx.trades = read('trades')
  ctx.tradeById = new Map(ctx.trades.map(t => [t.id, t]))
  ctx.tradesByIdentity = new Map()
  for (const t of ctx.trades) {
    if (t.ctrader_position_id == null) continue
    const k = idKey(acctOf(t.account_id), t.ctrader_position_id)
    const l = ctx.tradesByIdentity.get(k) || []
    l.push(t); ctx.tradesByIdentity.set(k, l)
  }
  ctx.planByTrade = new Map(read('plans').map(p => [p.trade_id, p]))
  ctx.activeTradeIds = new Set()
  ctx.activeIdentities = new Set()
  ctx.monitoredByTrade = new Map()
  ctx.tagCarriers = new Map()
  const carry = (label, kind, id, symbol, account) => {
    const t = intentTag(label)
    if (!t) return
    const l = ctx.tagCarriers.get(t) || []
    l.push({ kind, id, symbol: upper(symbol), account: acctOf(account) })
    ctx.tagCarriers.set(t, l)
  }
  for (const t of ctx.trades) carry(t.label_raw, 'trade', t.id, t.symbol, t.account_id)
  for (const m of read('monitored')) {
    ctx.monitoredByTrade.set(m.trade_id, m)
    const t = ctx.tradeById.get(m.trade_id)
    carry(m.label_raw, 'position', m.id, t?.symbol, m.account_id ?? t?.account_id)
    if (m.status !== 'active') continue
    ctx.activeTradeIds.add(m.trade_id)
    if (t?.ctrader_position_id != null) ctx.activeIdentities.add(idKey(acctOf(m.account_id ?? t.account_id), t.ctrader_position_id))
  }
  ctx.dealsByIdentity = new Map()
  for (const d of read('deals')) {
    const k = idKey(acctOf(d.account_id), d.position_id)
    const l = ctx.dealsByIdentity.get(k) || []
    l.push(d); ctx.dealsByIdentity.set(k, l)
  }
  ctx.orderById = new Map(read('brokerOrders').map(o => [String(o.order_id), o]))
  ctx.intents = read('intents')
  ctx.intentByPosition = new Map()
  ctx.intentByOrder = new Map()
  for (const i of ctx.intents) {
    if (i.broker_position_id != null) ctx.intentByPosition.set(idKey(acctOf(i.account_id), i.broker_position_id), i)
    if (i.broker_order_id != null) ctx.intentByOrder.set(idKey(acctOf(i.account_id), i.broker_order_id), i)
  }
  ctx.postmortemTrades = new Set(read('postmortems').map(r => r.trade_id))
  ctx.historyKeys = new Set(read('historyKeys').map(r => idKey(acctOf(r.account_id), r.ctrader_position_id)))
  ctx.incompleteKeys = new Set(read('incompleteKeys').map(r => idKey(acctOf(r.account_id), r.ctrader_position_id)))
  ctx.captureState = new Map(read('capture').map(r => [idKey(acctOf(r.account_id), r.position_id), r.state]))
  ctx.riskById = new Map(read('riskForTrades').map(r => [r.id, r]))
  ctx.approvals = read('approvals', [win.lowSpace, win.lowSpace])
  const state = Object.fromEntries(read('state').map(r => [r.key, r.value]))
  ctx.selectedAccount = acctOf(state.ctrader_account_id)
  ctx.watchdog = parseJson(state.independent_watchdog_json ?? null) ?? null
  ctx.drainLog = read('drainLog')
  ctx.actionLogFloorMs = tsMs(read('actionLogFloor', [], 1)[0]?.at)
  return ctx
}

const proposalOf = (ctx, riskEventId) => {
  const r = riskEventId == null ? null : ctx.riskById.get(Number(riskEventId))
  if (!r) return null
  if (r._p === undefined) r._p = parseJson(r.proposal_json) ?? null
  return r._p
}
/** The fill time: the broker's opening deal when one exists, else our row's opened_at (an adoption stamp on adopted rows, reconciler.js:541). */
function fillOf(t, ctx) {
  const deals = t.ctrader_position_id == null ? null : ctx.dealsByIdentity.get(idKey(acctOf(t.account_id), t.ctrader_position_id))
  const dealMs = deals ? Math.min(...deals.map(d => tsMs(d.opened_at) ?? Infinity)) : Infinity
  if (Number.isFinite(dealMs)) return { ms: dealMs, source: 'broker_deal' }
  const ms = tsMs(t.opened_at)
  return { ms, source: t.origin === 'reconciler_adopted' ? 'trades.opened_at (adoption stamp)' : 'trades.opened_at' }
}
const closeMsOf = t => num(t.closed_at_ms) ?? tsMs(t.closed_at)
/** A trade or position carrying the intent's tag on the same account (and symbol when known). */
function tagEvidence(ctx, intentId, account, symbol = null) {
  const l = ctx.tagCarriers.get(intentId) || []
  return l.find(c => (account == null || c.account == null || c.account === account) && (!symbol || !c.symbol || c.symbol === upper(symbol))) || null
}
/**
 * The fill of a resting pending_orders row, which has no intent column (W5):
 * the intent that placed it (broker_order_id = order_id on the account, else a
 * limit intent on the same account and side created within 5 s of placed_at),
 * then a trade or position carrying that intent's tag on the same symbol.
 */
function fillForPending(row, ctx) {
  const acct = acctOf(row.account_id)
  const sym = upper(row.symbol)
  const byOrder = row.order_id != null ? ctx.intentByOrder.get(idKey(acct, row.order_id)) : null
  const candidates = byOrder ? [byOrder] : (() => {
    const placed = tsMs(row.placed_at)
    const side = Number(row.dir) > 0 ? 1 : Number(row.dir) < 0 ? -1 : null
    if (placed == null || side == null) return []
    return ctx.intents.filter(i => acctOf(i.account_id) === acct && dirOf(i.side) === side
      && (LIMIT_PRODUCERS.has(i.producer_id) || upper(i.order_type) !== 'MARKET')
      && Math.abs((tsMs(i.created_at) ?? Infinity) - placed) <= 5_000)
  })()
  for (const i of candidates) {
    const f = tagEvidence(ctx, i.id, acct, sym)
    if (f) return { intent: i.id, fill: `${f.kind} ${f.id}`, via: byOrder ? 'broker_order_id' : 'placement_time' }
  }
  return null
}

// ---------------------------------------------------------------- rules
const APPROVALS_SQL = `SELECT id, account_id, symbol, side, disposition, proposal_json, created_at FROM risk_events
 WHERE disposition IN ('ordered', 'dropped', 'superseded', 'refused_post_approval') AND created_at >= ? AND approved = 1
UNION ALL
SELECT id, account_id, symbol, side, disposition, proposal_json, created_at FROM risk_events
 WHERE disposition IS NULL AND created_at >= ? AND approved = 1
LIMIT ?`
const TRADES_OPENED_SQL = `SELECT id, account_id, symbol, side, status, origin, label_raw, label_strategy, strategy, risk_event_id,
       ctrader_position_id, proposal_entry_price, opened_at FROM trades
 WHERE status IN ('open', 'closed', 'submitting', 'unconfirmed') AND (opened_at >= ? OR opened_at IS NULL) LIMIT ?`
const CLOSES_SQL = `SELECT id, account_id, symbol, side, origin, ctrader_position_id, net_pnl, exit_price, commission, swap,
       closed_at, closed_at_ms, hold_duration_ms, close_reason, pnl_unresolvable, pnl_unresolvable_reason FROM trades
 WHERE status = 'closed' AND (closed_at >= ? OR closed_at_ms >= ? OR (closed_at IS NULL AND closed_at_ms IS NULL)) LIMIT ?`
const DEALS_SQL = `SELECT deal_id, position_id, account_id, symbol, lots, gross_pnl, swap, commission, net_pnl, closed_at, imported_at
  FROM broker_deals WHERE closed_at >= ? OR closed_at IS NULL LIMIT ?`

const byId = r => `trade:${r.id}`
const acctCol = r => acctOf(r.account_id)
const opened = w => [w.lowSpace]
const closedParams = w => [w.lowSpace, w.lowMs]
/** Closes older than `ageMs` inside the window (money, cause, postmortem and record rules). */
const closedOlder = (t, w, ageMs) => t != null && t >= w.sinceMs && t <= w.nowMs - ageMs
/**
 * A trade is in the window when its fill OR its row's own opened_at is: an
 * adopted row written in the window about a fill before it is still shown
 * (as legacy — new versus legacy is always the fill time).
 */
const tradeInWindow = (r, w, _ctx, t) => (t != null && t >= w.sinceMs) || (tsMs(r.opened_at) ?? -Infinity) >= w.sinceMs

export const RULES = Object.freeze([
  // ======================================================== (a) PRE-ORDER
  {
    id: 'PRE-01', key: 'approval_incomplete', version: 1, stage: 'pre_order', severity: 'defect', fix: 'writer',
    cite: ['risk.js:2679', 'risk.js:2757', 'position-history.js:77-80', 'position-history.js:99-108', 'closed-market-limits.js:288'],
    noun: 'approval',
    sql: APPROVALS_SQL, params: w => [w.lowSpace, w.lowSpace],
    when: r => tsMs(r.created_at), subject: r => `risk_event:${r.id}`, account: acctCol,
    judge(r) {
      const p = parseJson(r.proposal_json)
      const missing = []
      if (blank(r.account_id)) missing.push('account_id')
      if (!p || typeof p !== 'object') missing.push('proposal_json')
      else {
        // The VALUE is tested, not the key: closed-market-limits.js:288 writes the key with null.
        if (blank(directionReasonOf(p))) missing.push('direction_reason')
        if (blank(p.strategy)) missing.push('strategy')
        missing.push(...sideProblems(dirOf(r.side ?? p.side), num(p.entry), num(p.sl), null))
      }
      return missing.length ? { missing, detail: `${r.symbol} ${r.side ?? ''} src=${p?.source ?? '?'} disposition=${r.disposition ?? 'unsettled'}` } : null
    },
  },
  {
    id: 'PRE-02', key: 'refusal_unscored', version: 1, stage: 'pre_order', severity: 'defect', fix: 'writer',
    cite: ['refusal-ledger.js:163', 'refusal-ledger.js:204-211', 'refusal-ledger.js:228', 'goal-table.js:407-421'],
    noun: 'scored refusal row (by scored_at, refusal-ledger.js:228 — not refusals made in the window)',
    populationLimit: REFUSAL_POPULATION_LIMIT,
    sql: `SELECT opportunity_key, account_id, symbol, outcome, scored_at FROM refusal_scores WHERE scored_at >= ? LIMIT ?`,
    params: opened, when: r => tsMs(r.scored_at), subject: r => `refusal:${r.opportunity_key}`, account: acctCol,
    judge(r) {
      if (r.outcome === 'no_bars') return { class: 'no_bars', detail: `${r.symbol}: scorer found no bars — object bars filtered as arrays (refusal-ledger.js:204)` }
      if (r.outcome === 'unscorable') return { class: 'unscorable', detail: `${r.symbol}: proposal carries no entry, stop or target (refusal-ledger.js:163)` }
      return ['target', 'stop', 'stop_moved', 'time_cap'].includes(r.outcome) ? { violation: false, class: 'scored' } : { violation: false, class: r.outcome ?? 'no_outcome' }
    },
  },
  {
    id: 'PRE-03', key: 'intent_incomplete', version: 1, stage: 'pre_order', severity: 'defect', fix: 'writer',
    cite: ['exec-engine.js:809', 'loop.js:693-696', 'exec-engine.js:811', 'reconciler.js:93-98', 'db.js:2046-2058'],
    noun: 'entry intent',
    sql: `SELECT id, account_id, symbol, symbol_id, side, order_type, volume, producer_id, basis, risk_event_id, created_at
            FROM entry_intents WHERE created_at >= ? OR created_at IS NULL LIMIT ?`,
    params: opened, when: r => tsMs(r.created_at), subject: r => `intent:${r.id}`, account: acctCol,
    judge(r, ctx) {
      const missing = []
      if (blank(r.symbol)) missing.push('symbol')
      if (r.volume == null) missing.push('volume')
      if (blank(r.order_type)) missing.push('order_type')
      if (r.basis === 'bar' && r.risk_event_id == null) {
        // The reconciler's own window (reconciler.js:93-98): an approval on the
        // account, symbol and side in the five minutes before the intent —
        // matched case-insensitively. With no symbol stored there is nothing to match.
        const at = tsMs(r.created_at)
        const found = !blank(r.symbol) && at != null && ctx.approvals.some(a => acctOf(a.account_id) === acctOf(r.account_id)
          && upper(a.symbol) === upper(r.symbol) && dirOf(a.side) === dirOf(r.side)
          && (tsMs(a.created_at) ?? -Infinity) <= at && (tsMs(a.created_at) ?? -Infinity) >= at - 5 * MIN)
        if (!found) missing.push('risk_event_id')
      }
      return missing.length ? { missing, detail: `${r.id} ${r.producer_id ?? '?'} symbol_id=${r.symbol_id ?? 'NULL'} ${r.side ?? ''}` } : null
    },
  },
  {
    id: 'PRE-04', key: 'resting_record_incomplete', version: 1, stage: 'pre_order', severity: 'defect', fix: 'writer',
    cite: ['closed-market-limits.js:384', 'pending-orders.js:642'],
    noun: 'resting-order row',
    sql: `SELECT id, account_id, symbol, order_id, dir, level, sl, tp, volume, expires_at, strategy, timeframe, risk_event_id,
                 time_cap_minutes, note, status, placed_at FROM pending_orders WHERE placed_at >= ? OR placed_at IS NULL LIMIT ?`,
    params: opened, when: r => tsMs(r.placed_at), subject: r => `pending:${r.id}`, account: acctCol,
    judge(r) {
      const missing = ['account_id', 'order_id', 'dir', 'level', 'sl', 'volume', 'expires_at', 'strategy', 'timeframe', 'risk_event_id'].filter(f => blank(r[f]))
      missing.push(...sideProblems(Number(r.dir) > 0 ? 1 : Number(r.dir) < 0 ? -1 : null, num(r.level), num(r.sl), null))
      if (missing.length) return { missing, detail: `#${r.id} ${r.symbol} ${r.note ?? ''} status=${r.status}` }
      // tp NULL is the runner design. time_cap_minutes NULL is information only:
      // the INSERT at closed-market-limits.js:384 omits it.
      return r.time_cap_minutes == null ? { violation: false, class: 'time_cap_unrecorded' } : null
    },
  },
  {
    id: 'PRE-05', key: 'approval_dropped', version: 1, stage: 'pre_order', severity: 'defect', fix: 'reporting',
    cite: ['opportunity-disposition.js:44', 'log-inspector.js:326-350'],
    noun: 'approval',
    sql: APPROVALS_SQL, params: w => [w.lowSpace, w.lowSpace],
    when: r => tsMs(r.created_at), subject: r => `risk_event:${r.id}`, account: acctCol,
    judge: r => (r.disposition === 'dropped' ? { detail: `${r.symbol} ${r.side ?? ''}: approved, nothing acted, grace elapsed` } : null),
  },
  // ======================================================== (b) ORDER
  {
    id: 'ORD-01', key: 'bot_trade_unreasoned', version: 1, stage: 'order', severity: 'defect', fix: 'writer',
    cite: ['close-completeness.js:69-100', 'position-history.js:292', 'trade-labels.js:360-363', 'actions.js:5935-5940'],
    noun: 'bot trade',
    sql: TRADES_OPENED_SQL, params: opened,
    when: (r, ctx) => fillOf(r, ctx).ms, subject: byId, account: acctCol, inWindow: tradeInWindow,
    judge(r, ctx) {
      if (!botTrade(r)) return OUT
      const missing = []
      if (blank(r.account_id)) missing.push('account_id')
      if ((r.status === 'open' || r.status === 'closed') && blank(r.ctrader_position_id)) missing.push('ctrader_position_id')
      if (dirOf(r.side) == null) missing.push('side')
      const plan = ctx.planByTrade.get(r.id)
      const strategyLabelOnly = blank(plan?.strategy) && blank(r.strategy) && !blank(r.label_strategy)
      if (blank(plan?.strategy) && blank(r.strategy) && blank(r.label_strategy)) missing.push('strategy')
      if (!CLEAN_BOT_ORIGINS.includes(r.origin)) missing.push('origin')
      if (r.risk_event_id == null) missing.push('risk_event_id')
      if (!plan) missing.push('trade_plan')
      if (!missing.length) return strategyLabelOnly ? { violation: false, class: 'strategy_label_only' } : null
      return { missing, detail: `#${r.id} ${r.symbol} ${r.status} origin=${r.origin ?? 'NULL'}`, openedAtSource: fillOf(r, ctx).source }
    },
  },
  {
    id: 'ORD-02', key: 'direction_reason_unreachable', version: 1, stage: 'order', severity: 'defect', fix: 'writer',
    cite: ['position-history.js:77-85', 'position-history.js:99-108', 'loop.js:5664'],
    noun: 'bot trade',
    sql: `SELECT id, account_id, symbol, side, status, origin, label_raw, risk_event_id, ctrader_position_id, opened_at FROM trades
           WHERE (status IN ('open', 'closed', 'submitting', 'unconfirmed') AND (opened_at >= ? OR opened_at IS NULL)) OR status = 'open' LIMIT ?`,
    params: opened, when: (r, ctx) => fillOf(r, ctx).ms, subject: byId, account: acctCol,
    inWindow: (r, w, ctx, t) => r.status === 'open' || tradeInWindow(r, w, ctx, t),
    judge(r, ctx) {
      if (!botTrade(r)) return OUT
      let missing = null
      if (r.risk_event_id == null) missing = 'risk_event_id'
      else if (!ctx.riskById.has(Number(r.risk_event_id))) missing = 'risk_event_pruned'
      else if (blank(directionReasonOf(proposalOf(ctx, r.risk_event_id)))) missing = 'direction_reason'
      if (!missing) return null
      return { missing: [missing], class: r.status === 'open' ? 'will_close_incomplete' : r.status, detail: `#${r.id} ${r.symbol} ${r.status} risk_event=${r.risk_event_id ?? 'NULL'}` }
    },
  },
  {
    id: 'ORD-03', key: 'plan_invalid', version: 1, stage: 'order', severity: 'defect', fix: 'writer',
    cite: ['reconciler.js:107', 'trade-plans.js:51-73', 'closed-market-limits.js:163-172', 'exec-engine.js:811'],
    noun: 'trade plan',
    sql: `SELECT trade_plans.trade_id, trade_plans.account_id AS plan_account, trade_plans.symbol, trade_plans.side, trade_plans.planned_entry,
                 trade_plans.planned_sl, trade_plans.planned_tp, trade_plans.risk_dist, trade_plans.source,
                 trades.account_id, trades.status, trades.origin, trades.opened_at, trades.closed_at, trades.closed_at_ms, trades.ctrader_position_id
            FROM trade_plans JOIN trades ON trades.id = trade_plans.trade_id
           WHERE trades.status = 'open' OR trades.opened_at >= ? OR trades.closed_at >= ? OR trades.closed_at_ms >= ? LIMIT ?`,
    params: w => [w.lowSpace, w.lowSpace, w.lowMs],
    // VERIFY correction 2: the plan is judged with its TRADE's window (opened
    // or closed in it, or open now), never by the plan's own created_at.
    when: (r, ctx) => fillOf(r, ctx).ms, subject: r => `trade:${r.trade_id}`, account: r => acctOf(r.account_id ?? r.plan_account),
    inWindow: (r, w, ctx, t) => r.status === 'open' || tradeInWindow(r, w, ctx, t) || (closeMsOf(r) ?? -Infinity) >= w.sinceMs,
    judge(r) {
      const e = num(r.planned_entry), s = num(r.planned_sl), tp = num(r.planned_tp)
      const missing = []
      if (e == null) missing.push('planned_entry')
      if (s == null) missing.push('planned_sl')
      missing.push(...sideProblems(dirOf(r.side), e, s, tp))
      if (riskScaleWrong(e, s, num(r.risk_dist))) missing.push('risk_scale')
      return missing.length ? { missing, detail: `t#${r.trade_id} ${r.symbol} ${r.side} entry ${r.planned_entry} sl ${r.planned_sl} rd ${r.risk_dist} src=${r.source ?? '?'}` } : null
    },
  },
  {
    id: 'ORD-04', key: 'intent_state_false', version: 1, stage: 'order', severity: 'defect', fix: 'writer+resolver',
    cite: ['exec-engine.js:851-858', 'entry-ledger.js:303-309', 'entry-ledger.js:394', 'fill-anchor.js:94-98'],
    noun: 'entry intent',
    sql: `SELECT id, account_id, symbol, side, order_type, producer_id, state, broker_order_id, broker_position_id, resolution_source,
                 created_at, resolved_at FROM entry_intents
           WHERE resolved_at >= ? OR created_at >= ? OR state NOT IN ('FILLED', 'REJECTED', 'RELEASED', 'EXPIRED') LIMIT ?`,
    params: w => [w.lowSpace, w.lowSpace],
    when: r => tsMs(r.resolved_at) ?? tsMs(r.created_at), subject: r => `intent:${r.id}`, account: acctCol,
    inWindow: (r, w, _ctx, t) => !TERMINAL_INTENT.includes(r.state) || (t != null && t >= w.sinceMs),
    judge(r, ctx, w) {
      if (r.state !== 'FILLED') return null
      const created = tsMs(r.created_at), resolved = tsMs(r.resolved_at)
      const restingAtPlacement = upper(r.order_type) !== 'MARKET' && r.resolution_source === 'response'
        && created != null && resolved != null && resolved - created <= 5_000
      if (resolved != null && w.nowMs - resolved < 30 * MIN) return null
      const acct = acctOf(r.account_id)
      const pid = r.broker_position_id
      const evidence = (pid != null && (ctx.tradesByIdentity.has(idKey(acct, pid)) || ctx.dealsByIdentity.has(idKey(acct, pid))))
        || tagEvidence(ctx, r.id, acct) != null
      if (evidence) return restingAtPlacement ? { violation: false, class: 'resting_filled_at_placement' } : null
      const order = r.broker_order_id != null ? ctx.orderById.get(String(r.broker_order_id)) : null
      return {
        missing: ['position_evidence'], class: order?.status === 'gone' ? 'order_gone_unfilled' : 'no_position_evidence',
        detail: `${r.id} ${r.producer_id ?? '?'} ${r.order_type ?? '?'} FILLED ${String(r.resolved_at ?? '').slice(0, 16)} by ${r.resolution_source ?? '?'}; position ${pid ?? 'NULL'}` +
          (order ? `; order ${r.broker_order_id} ${order.status}${order.gone_at ? ' ' + String(order.gone_at).slice(0, 16) : ''}` : ''),
      }
    },
  },
  {
    id: 'ORD-05', key: 'trade_intent_unlinkable', version: 1, stage: 'order', severity: 'defect', fix: 'writer',
    cite: ['loop.js:1024-1031', 'exec-engine.js:917-919', 'trade-labels.js:189', 'trade-labels.js:193-198'],
    noun: 'clean-origin trade',
    sql: `SELECT id, account_id, symbol, status, origin, label_raw, ctrader_position_id, opened_at FROM trades
           WHERE status IN ('open', 'closed', 'submitting', 'unconfirmed') AND origin IN ('bot_market_dispatch', 'bot_pending_fill')
             AND (opened_at >= ? OR opened_at IS NULL) LIMIT ?`,
    params: opened, when: (r, ctx) => fillOf(r, ctx).ms, subject: byId, account: acctCol, inWindow: tradeInWindow,
    judge(r, ctx) {
      if (intentTag(r.label_raw)) return null
      if (r.ctrader_position_id != null && ctx.intentByPosition.has(idKey(acctOf(r.account_id), r.ctrader_position_id))) return null
      return { missing: ['intent_link'], detail: `#${r.id} ${r.symbol} label=${cut(r.label_raw ?? 'NULL', 60)}` }
    },
  },
  {
    id: 'ORD-06', key: 'position_duplicate_rows', version: 1, stage: 'order', severity: 'defect', fix: 'reporting',
    cite: ['position-history.js:169-173', 'position-capture.js:357-361', 'broker-history-import.js:136-143', 'db.js:31'],
    noun: 'broker position',
    sql: `SELECT account_id, ctrader_position_id, COUNT(*) AS n, GROUP_CONCAT(id || ':' || COALESCE(status, '?'), ',') AS rows_list,
                 GROUP_CONCAT(COALESCE(opened_at, ''), '|') AS opened_list, MAX(id) AS last_id,
                 SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_n,
                 SUM(CASE WHEN status IN ('rejected', 'cancelled') THEN 0 ELSE 1 END) AS live_n
            FROM trades WHERE ctrader_position_id IS NOT NULL GROUP BY account_id, ctrader_position_id LIMIT ?`,
    params: () => [],
    when: r => { const t = String(r.opened_list || '').split('|').map(tsMs).filter(x => x != null); return t.length ? Math.max(...t) : null },
    subject: r => `position:${acctOf(r.account_id) ?? ''}:${r.ctrader_position_id}`, account: acctCol,
    inWindow: (r, w, _ctx, t) => r.open_n > 0 || (t != null && t >= w.sinceMs),
    judge(r) {
      if (r.n < 2) return null
      const lastStatus = String(r.rows_list || '').split(',').find(x => x.startsWith(`${r.last_id}:`))?.split(':')[1]
      return {
        missing: ['unique_row'], class: r.live_n >= 2 ? 'unrepaired' : 'repaired_twin',
        readerTakes: ['rejected', 'cancelled'].includes(lastStatus) ? 'rejected_twin' : 'live_row',
        detail: `${tail(r.account_id)} pos ${r.ctrader_position_id} rows ${r.rows_list}`,
      }
    },
  },
  {
    id: 'ORD-07', key: 'bot_fill_without_preorder', version: 1, stage: 'order', severity: 'defect', fix: 'reporting',
    cite: ['reconciler.js:541', 'trade-labels.js:360-363', 'close-completeness.js:84-96'],
    noun: 'adopted row wearing our label',
    sql: `SELECT id, account_id, symbol, side, status, origin, label_raw, risk_event_id, ctrader_position_id, opened_at FROM trades
           WHERE origin = 'reconciler_adopted' AND status IN ('open', 'closed') AND (opened_at >= ? OR opened_at IS NULL) LIMIT ?`,
    params: opened, when: (r, ctx) => fillOf(r, ctx).ms, subject: byId, account: acctCol, inWindow: tradeInWindow,
    judge(r, ctx) {
      if (!ours(r.label_raw)) return OUT
      if (intentTag(r.label_raw) || r.risk_event_id != null) return null
      // pending_orders carries no trade link (W5), so "no resting row linked by
      // order id or risk event" reduces to the two links above; the writer of
      // the fill itself stays Not Verifiable.
      const fill = fillOf(r, ctx)
      return {
        missing: ['intent_tag', 'risk_event_id'], openedAtSource: fill.source,
        detail: `#${r.id} ${tail(r.account_id)} ${r.symbol} ${r.label_raw} opened ${iso(fill.ms)?.slice(0, 16) ?? 'NULL'} (${fill.source})`,
      }
    },
  },
  {
    id: 'ORD-08', key: 'external_unreasoned', version: 1, stage: 'order', severity: 'notice', fix: 'reporting', current: true,
    cite: ['close-completeness.js:54-56', 'trade-plans.js:152'],
    noun: 'external order or position',
    sql: `SELECT 'order' AS kind, order_id AS ref, account_id, symbol, label, first_seen AS at, is_bot, NULL AS origin FROM broker_orders
           WHERE status = 'working' AND (is_bot = 0 OR label IS NULL)
          UNION ALL
          SELECT 'trade', CAST(id AS TEXT), account_id, symbol, label_raw, opened_at, NULL, origin FROM trades
           WHERE status = 'open' AND origin IN ('external', 'manual_broker', 'external_system', 'reconciler_adopted')
          LIMIT ?`,
    params: () => [], when: r => tsMs(r.at), subject: r => `${r.kind}:${r.ref}`, account: acctCol,
    judge(r) {
      if (r.kind === 'trade' && r.origin === 'reconciler_adopted' && (ours(r.label) || intentTag(r.label))) return OUT
      return { class: r.kind, detail: `external: no reason recorded — ${r.kind} ${r.ref} ${r.symbol} ${r.origin ?? ''} label=${cut(r.label ?? 'NULL', 40)}` }
    },
  },
  {
    id: 'ORD-09', key: 'fill_truth_missing', version: 1, stage: 'order', severity: 'defect', fix: 'writer',
    cite: ['position-history.js:221-247', 'position-history.js:268'],
    noun: 'bot trade',
    sql: TRADES_OPENED_SQL, params: opened,
    when: (r, ctx) => fillOf(r, ctx).ms, subject: byId, account: acctCol, inWindow: tradeInWindow,
    judge(r, ctx, w) {
      if (!botTrade(r) || (r.status !== 'open' && r.status !== 'closed')) return OUT
      const missing = []
      if (num(ctx.planByTrade.get(r.id)?.planned_entry) == null && num(r.proposal_entry_price) == null) missing.push('planned_entry')
      const opened = tsMs(r.opened_at)
      const mp = ctx.monitoredByTrade.get(r.id)
      if (r.status === 'open' && mp && mp.status === 'active' && mp.broker_volume_units == null && opened != null && w.nowMs - opened > 10 * MIN) missing.push('broker_volume_units')
      return missing.length ? { missing, detail: `#${r.id} ${r.symbol} ${r.status}` } : null
    },
  },
  {
    id: 'ORD-10', key: 'pending_status_wrong', version: 1, stage: 'order', severity: 'defect', fix: 'resolver',
    cite: ['closed-market-limits.js:113-116', 'closed-market-limits.js:176', 'pending-orders.js:353'],
    noun: 'terminal resting-order row',
    sql: `SELECT id, account_id, symbol, dir, status, note, order_id, placed_at FROM pending_orders
           WHERE status IN ('expired', 'cancelled') AND (placed_at >= ? OR placed_at IS NULL) LIMIT ?`,
    params: opened, when: r => tsMs(r.placed_at), subject: r => `pending:${r.id}`, account: acctCol,
    judge(r, ctx) {
      const f = fillForPending(r, ctx)
      return f ? { missing: ['status'], detail: `#${r.id} ${tail(r.account_id)} ${r.symbol} '${r.status}' but ${f.fill} carries ${f.intent} (${f.via})` } : null
    },
  },
  // ======================================================== (c) CLOSE
  {
    id: 'CLS-01', key: 'close_unrecorded', version: 1, stage: 'close', severity: 'defect', fix: 'writer',
    cite: ['broker-history-import.js:136-143', 'reconciler.js:619-630'],
    noun: 'broker closing deal',
    sql: DEALS_SQL, params: opened, when: r => tsMs(r.closed_at),
    subject: r => `position:${acctOf(r.account_id) ?? ''}:${r.position_id}`, account: acctCol,
    judge(r, ctx) {
      const k = idKey(acctOf(r.account_id), r.position_id)
      const rows = ctx.tradesByIdentity.get(k) || []
      if (rows.some(t => t.status === 'closed' || t.status === 'rejected') || ctx.activeIdentities.has(k)) return null
      return { missing: ['trades_close_row'], class: rows.length ? `ledger_${rows[rows.length - 1].status}` : 'no_ledger_row', detail: `${tail(r.account_id)} ${r.symbol} pos ${r.position_id} deal ${r.deal_id} net ${r.net_pnl ?? 'NULL'}` }
    },
  },
  {
    id: 'CLS-02', key: 'close_money_incomplete', version: 1, stage: 'close', severity: 'defect', fix: 'resolver+writer',
    cite: ['position-history.js:81-83', 'pnl-backfill.js:104-113', 'old-position-pnl.js:16'],
    noun: 'close older than 2 h',
    sql: CLOSES_SQL, params: closedParams, when: closeMsOf, subject: byId, account: acctCol,
    inWindow: (r, w, _ctx, t) => closedOlder(t, w, 2 * HOUR),
    judge(r, ctx) {
      const writtenOff = Number(r.pnl_unresolvable) === 1
      const deals = r.ctrader_position_id == null ? [] : ctx.dealsByIdentity.get(idKey(acctOf(r.account_id), r.ctrader_position_id)) || []
      const field = { net_pnl: 'net_pnl', exit_price: 'close_price', commission: 'commission', swap: 'swap', closed_at_ms: 'closed_at', hold_duration_ms: 'opened_at' }
      const missing = []
      if (r.net_pnl == null && !writtenOff) missing.push('net_pnl')
      for (const f of ['exit_price', 'commission', 'swap', 'closed_at_ms', 'hold_duration_ms', 'account_id']) if (blank(r[f])) missing.push(f)
      if (!missing.length) return writtenOff && r.net_pnl == null ? { violation: false, class: 'settled_unrecoverable' } : null
      const recoverable = Object.fromEntries(missing.map(f => [f,
        writtenOff ? 'none' : field[f] && deals.some(d => d[field[f]] != null) ? 'local' : f === 'account_id' ? 'none' : 'broker']))
      return { missing, recoverable, class: writtenOff ? 'settled_unrecoverable' : undefined, detail: `#${r.id} ${tail(r.account_id)} ${r.symbol} closed ${iso(closeMsOf(r))?.slice(0, 16)}` }
    },
  },
  {
    id: 'CLS-03', key: 'close_cause_unattributed', version: 1, stage: 'close', severity: 'defect', fix: 'writer',
    cite: ['reconciler.js:118', 'reconciler.js:1024', 'reconciler.js:1079', 'loop.js:2053', 'loop.js:2140', 'reconciler.js:730'],
    noun: 'close',
    sql: CLOSES_SQL, params: closedParams, when: closeMsOf, subject: byId, account: acctCol,
    judge(r) {
      if (blank(r.close_reason)) return { missing: ['close_reason'], class: 'null', detail: `#${r.id} ${r.symbol}: no close reason` }
      return GENERIC_CLOSE_RE.test(String(r.close_reason)) ? { missing: ['close_cause'], class: 'generic', detail: `#${r.id} ${r.symbol}: ${cut(r.close_reason, 80)}` } : null
    },
  },
  {
    id: 'CLS-04', key: 'position_record_refused', version: 1, stage: 'close', severity: 'defect', fix: 'writer',
    cite: ['position-history.js:77-85', 'position-history.js:330', 'position-capture.js:73'],
    noun: 'captured close',
    sql: `SELECT 'complete' AS kind, account_id, ctrader_position_id AS position_id, symbol, closed_at_ms AS at, NULL AS missing_json, NULL AS last_error
            FROM position_history WHERE closed_at_ms >= ?
          UNION ALL
          SELECT 'incomplete', account_id, ctrader_position_id, symbol, closed_at_ms, missing_json, NULL
            FROM position_history_incomplete WHERE closed_at_ms >= ?
          UNION ALL
          SELECT 'gave_up', account_id, position_id, symbol, settled_at, NULL, last_error FROM position_capture_queue WHERE state = 'gave_up'
          LIMIT ?`,
    params: w => [w.lowMs, w.lowMs], when: r => tsMs(r.at),
    subject: r => `position:${acctOf(r.account_id) ?? ''}:${r.position_id}`, account: acctCol,
    judge(r, ctx) {
      if (r.kind === 'complete') return null
      const k = idKey(acctOf(r.account_id), r.position_id)
      if (r.kind === 'gave_up') return { missing: ['record'], class: 'gave_up', detail: `${tail(r.account_id)} ${r.symbol} pos ${r.position_id}: ${cut(r.last_error ?? '', 80)}` }
      const missing = (() => { const m = parseJson(r.missing_json); return Array.isArray(m) ? m.map(String) : ['missing_json'] })()
      const rows = ctx.tradesByIdentity.get(k) || []
      const deals = ctx.dealsByIdentity.get(k) || []
      const moneyField = { volume: 'lots', exit_price: 'close_price', gross_pnl: 'gross_pnl', net_pnl: 'net_pnl', commission: 'commission', swap: 'swap' }
      const recoverable = {}
      for (const f of missing) {
        if (f === 'direction_reason') recoverable[f] = rows.some(t => !blank(directionReasonOf(proposalOf(ctx, t.risk_event_id)))) ? 'local' : 'none'
        else if (f === 'planned_entry' || f === 'planned_sl' || f === 'risk_dist') recoverable[f] = rows.some(t => { const p = proposalOf(ctx, t.risk_event_id); return num(p?.entry) != null && num(p?.sl) != null }) ? 'local' : 'none'
        else if (f === 'strategy') recoverable[f] = rows.some(t => !blank(t.strategy) || !blank(t.label_strategy)) ? 'local' : 'none'
        else if (moneyField[f]) recoverable[f] = deals.some(d => d[moneyField[f]] != null) ? 'local' : 'broker'
        else recoverable[f] = 'unknown'
      }
      return { missing, recoverable, class: 'incomplete', detail: `${tail(r.account_id)} ${r.symbol} pos ${r.position_id} missing ${missing.join(',')}` }
    },
  },
  {
    id: 'CLS-05', key: 'postmortem_missing', version: 1, stage: 'close', severity: 'defect', fix: 'reporting',
    cite: ['loss-postmortem.js:467', 'close-completeness.js:129-139'],
    noun: 'close older than 48 h',
    sql: CLOSES_SQL, params: closedParams, when: closeMsOf, subject: byId, account: acctCol,
    inWindow: (r, w, _ctx, t) => closedOlder(t, w, 48 * HOUR),
    judge(r, ctx) {
      if (ctx.postmortemTrades.has(r.id)) return null
      if (num(r.net_pnl) === 0) return { violation: false, class: 'exempt_zero' }
      if (r.net_pnl == null && r.exit_price == null) return { violation: false, class: 'blocked_by_money' }
      return { missing: ['postmortem'], detail: `#${r.id} ${r.symbol} net ${r.net_pnl ?? 'NULL'}` }
    },
  },
  {
    id: 'CLS-06', key: 'deal_detail_lost', version: 1, stage: 'close', severity: 'defect', fix: 'writer',
    cite: ['index.js:127-129', 'broker-history-import.js:159-170'],
    noun: 'broker closing deal',
    sql: DEALS_SQL, params: opened, when: r => tsMs(r.closed_at),
    subject: r => `deal:${r.deal_id}`, account: acctCol,
    judge(r) {
      const lost = ['gross_pnl', 'swap', 'lots'].filter(f => r[f] == null)
      const closed = tsMs(r.closed_at), imported = tsMs(r.imported_at)
      if (!lost.length || r.net_pnl == null || closed == null || imported == null || imported - closed <= DAY) return null
      return { missing: lost, detail: `deal ${r.deal_id} ${r.symbol} closed ${iso(closed).slice(0, 16)} imported ${iso(imported).slice(0, 16)}` }
    },
  },
  {
    id: 'CLS-07', key: 'close_time_disagrees', version: 1, stage: 'close', severity: 'defect', fix: 'reporting',
    cite: ['db.js:2304', 'close-completeness.js:136'],
    noun: 'close',
    sql: CLOSES_SQL, params: closedParams, when: closeMsOf, subject: byId, account: acctCol,
    judge(r) {
      const a = tsMs(r.closed_at), b = num(r.closed_at_ms)
      if (a == null || b == null || Math.abs(a - b) <= DAY) return null
      return { missing: ['closed_at'], detail: `#${r.id} ${r.symbol} closed_at ${iso(a).slice(0, 16)} vs closed_at_ms ${iso(b).slice(0, 16)}` }
    },
  },
  {
    // VERIFY correction 1: a close with NO record in either stream — neither
    // position_history nor position_history_incomplete — was invisible to
    // every reader (the route lists incomplete rows after its cutoff only).
    id: 'CLS-08', key: 'close_record_absent', version: 1, stage: 'close', severity: 'defect', fix: 'writer',
    cite: ['position-history.js:578', 'position-history.js:602', 'loop.js:2087', 'loop.js:3502-3506'],
    noun: 'close older than 2 h',
    sql: CLOSES_SQL, params: closedParams, when: closeMsOf, subject: byId, account: acctCol,
    inWindow: (r, w, _ctx, t) => closedOlder(t, w, 2 * HOUR),
    judge(r, ctx) {
      if (r.ctrader_position_id == null) return OUT
      const k = idKey(acctOf(r.account_id), r.ctrader_position_id)
      if (ctx.historyKeys.has(k) || ctx.incompleteKeys.has(k)) return null
      const q = ctx.captureState.get(k)
      if (q === 'pending') return { violation: false, class: 'capture_pending' }
      return { missing: ['position_record'], class: q ? `queue_${q}` : 'never_queued', detail: `#${r.id} ${tail(r.account_id)} ${r.symbol} pos ${r.ctrader_position_id} origin=${r.origin ?? 'NULL'}` }
    },
  },
  {
    // VERIFY corrections 2 and 3: a record counted COMPLETE can still carry a
    // stop in wire units — position-history.js:269-272 copies the plan and
    // :330 only tests for null.
    id: 'CLS-09', key: 'record_plan_units_wrong', version: 1, stage: 'close', severity: 'defect', fix: 'writer',
    cite: ['position-history.js:269-272', 'position-history.js:330', 'reconciler.js:107'],
    noun: 'complete position record',
    sql: `SELECT account_id, ctrader_position_id, symbol, trade_id, direction, planned_entry, planned_sl, planned_tp, risk_dist, closed_at_ms
            FROM position_history WHERE closed_at_ms >= ? LIMIT ?`,
    params: w => [w.lowMs], when: r => num(r.closed_at_ms),
    subject: r => `position:${acctOf(r.account_id) ?? ''}:${r.ctrader_position_id}`, account: acctCol,
    judge(r) {
      const e = num(r.planned_entry), s = num(r.planned_sl)
      const missing = [...sideProblems(dirOf(r.direction), e, s, null)]
      if (riskScaleWrong(e, s, num(r.risk_dist))) missing.push('risk_scale')
      return missing.length ? { missing, detail: `t#${r.trade_id ?? '?'} ${r.symbol} ${r.direction} entry ${r.planned_entry} sl ${r.planned_sl} rd ${r.risk_dist}` } : null
    },
  },
  // ======================================================== (d) STUCK
  {
    id: 'STK-01', key: 'resting_record_orphaned', version: 1, stage: 'stuck', severity: 'defect', fix: 'resolver', current: true,
    cite: ['closed-market-limits.js:84-88', 'loop.js:114', 'loop.js:4600', 'entry-mode.js:82-86', 'entry-drain.js:102', 'closed-market-limits.js:276-278'],
    noun: 'working resting-order row',
    sql: `SELECT id, account_id, symbol, dir, order_id, note, placed_at, expires_at, status FROM pending_orders WHERE status = 'working' LIMIT ?`,
    params: () => [], when: r => tsMs(r.placed_at), subject: r => `pending:${r.id}`, account: acctCol,
    judge(r, ctx, w) {
      // ONE classification per row (VERIFY correction 6): a filled row is not
      // also counted as expired, and the entry-mode "resting" count is the same
      // rows seen through entry-mode.js:82, not more of them.
      const filled = fillForPending(r, ctx)
      const order = r.order_id != null ? ctx.orderById.get(String(r.order_id)) : null
      const expires = tsMs(r.expires_at), placed = tsMs(r.placed_at)
      const kind = filled ? 'filled_unlinked'
        : expires != null && expires < w.nowMs - 10 * MIN ? 'expired_working'
          : order?.status === 'gone' ? 'order_gone'
            : !order && placed != null && placed < w.nowMs - HOUR ? 'no_broker_order' : null
      if (!kind) return null
      return {
        missing: ['terminal_status'], class: kind, resolverExists: r.note === 'pending-closed',
        corrupts: ['countResting (entry-mode.js:82-86)', 'the drain (entry-drain.js:102)', 'the cap of 20 (closed-market-limits.js:276-278)'],
        detail: `#${r.id} ${tail(r.account_id)} ${r.symbol} ${r.note ?? ''} expires ${iso(expires)?.slice(0, 16) ?? 'NULL'}${filled ? `; ${filled.fill} carries ${filled.intent}` : ''}; resolver ${r.note === 'pending-closed' ? 'exists' : 'none (pending-fib retired, loop.js:114)'}`,
      }
    },
  },
  {
    id: 'STK-02', key: 'intent_open_past_bound', version: 1, stage: 'stuck', severity: 'defect', fix: 'resolver', current: true,
    cite: ['entry-ledger.js:350-356', 'entry-ledger.js:44-47', 'entry-ledger.js:467'],
    noun: 'open entry intent',
    sql: `SELECT id, account_id, symbol, side, state, permit_expires_at, created_at, updated_at FROM entry_intents
           WHERE state IN ('RESERVED', 'DISPATCHING', 'SENT', 'UNKNOWN') LIMIT ?`,
    params: () => [], when: r => tsMs(r.created_at), subject: r => `intent:${r.id}`, account: acctCol,
    judge(r, _ctx, w) {
      const over = (r.state === 'RESERVED' && (tsMs(r.permit_expires_at) ?? Infinity) < w.nowMs - 2 * MIN)
        || ((r.state === 'DISPATCHING' || r.state === 'SENT') && (tsMs(r.updated_at) ?? Infinity) < w.nowMs - 3 * MIN)
        || (r.state === 'UNKNOWN' && (tsMs(r.created_at) ?? Infinity) < w.nowMs - 4 * HOUR)
      return over ? { missing: ['resolution'], class: r.state, detail: `${r.id} ${tail(r.account_id)} ${r.symbol ?? 'symbol NULL'} ${r.state} since ${String(r.created_at ?? '').slice(0, 16)}` } : null
    },
  },
  {
    id: 'STK-03', key: 'trade_inflight_unresolved', version: 1, stage: 'stuck', severity: 'defect', fix: 'resolver', current: true,
    cite: ['loop.js:867', 'loop.js:911', 'actions.js:548-582', 'broker-history-import.js:302'],
    noun: 'in-flight trade row',
    sql: `SELECT id, account_id, symbol, side, status, opened_at FROM trades WHERE status IN ('submitting', 'unconfirmed') LIMIT ?`,
    params: () => [], when: r => tsMs(r.opened_at), subject: byId, account: acctCol,
    judge(r, _ctx, w) {
      const at = tsMs(r.opened_at) ?? -Infinity
      const over = (r.status === 'submitting' && at < w.nowMs - 10 * MIN) || (r.status === 'unconfirmed' && at < w.nowMs - HOUR)
      return over ? { missing: ['resolution'], class: r.status, detail: `#${r.id} ${tail(r.account_id)} ${r.symbol} ${r.status} since ${String(r.opened_at ?? '').slice(0, 16)}; resolver: manual POST /actions/reconcile-trades only` } : null
    },
  },
  {
    id: 'STK-04', key: 'open_trade_unmonitored', version: 1, stage: 'stuck', severity: 'defect', fix: 'resolver', current: true,
    cite: ['reconciler.js:619-630'],
    noun: 'open trade row',
    sql: `SELECT id, account_id, symbol, ctrader_position_id, origin, opened_at FROM trades WHERE status = 'open' LIMIT ?`,
    params: () => [], when: r => tsMs(r.opened_at), subject: byId, account: acctCol,
    judge(r, ctx) {
      const missing = []
      if (r.ctrader_position_id == null) missing.push('ctrader_position_id')
      if (!ctx.activeTradeIds.has(r.id) && !(r.ctrader_position_id != null && ctx.activeIdentities.has(idKey(acctOf(r.account_id), r.ctrader_position_id)))) missing.push('active_monitored_row')
      return missing.length ? { missing, detail: `#${r.id} ${tail(r.account_id)} ${r.symbol} origin=${r.origin ?? 'NULL'}` } : null
    },
  },
  {
    id: 'STK-05', key: 'pnl_unreachable', version: 1, stage: 'stuck', severity: 'defect', fix: 'resolver', current: true,
    cite: ['pnl-backfill.js:104-113', 'old-position-pnl.js:35-38'],
    noun: 'unpriced close',
    sql: `SELECT id, account_id, symbol, ctrader_position_id, closed_at, closed_at_ms, pnl_attempts FROM trades
           WHERE status = 'closed' AND net_pnl IS NULL AND COALESCE(pnl_unresolvable, 0) = 0 LIMIT ?`,
    params: () => [], when: closeMsOf, subject: byId, account: acctCol,
    judge(r, ctx, w) {
      const closed = closeMsOf(r)
      if (closed == null || w.nowMs - closed < 15 * MIN || r.ctrader_position_id == null) return null
      const k = idKey(acctOf(r.account_id), r.ctrader_position_id)
      const rows = ctx.tradesByIdentity.get(k) || []
      if (rows.length < 2) return null
      const deal = (ctx.dealsByIdentity.get(k) || []).find(d => d.net_pnl != null)
      return {
        missing: ['net_pnl'], class: 'position_ledger_ambiguous', localDeal: deal ? String(deal.deal_id) : null,
        detail: `#${r.id} ${tail(r.account_id)} ${r.symbol} rows ${rows.map(t => `${t.id}:${t.status}`).join(',')}; local deal ${deal ? `${deal.deal_id} net ${deal.net_pnl}` : 'none'}; attempts ${r.pnl_attempts ?? 0}`,
      }
    },
  },
  {
    id: 'STK-06', key: 'capture_terminal', version: 1, stage: 'stuck', severity: 'defect', fix: 'reporting', current: true,
    cite: ['position-capture.js:73', 'position-capture.js:143', 'position-capture.js:181-222'],
    noun: 'capture row',
    sql: `SELECT 'gave_up' AS kind, account_id, position_id, symbol, last_error AS note, settled_at AS at FROM position_capture_queue WHERE state = 'gave_up'
          UNION ALL
          SELECT 'unverified_at_cap', position_history.account_id, position_history.ctrader_position_id, position_history.symbol,
                 position_history.verification_state, position_history.closed_at_ms
            FROM position_history JOIN position_capture_queue
              ON position_capture_queue.account_id = position_history.account_id AND position_capture_queue.position_id = position_history.ctrader_position_id
           WHERE position_history.verification_state = 'unverified' AND COALESCE(position_capture_queue.reverify_attempts, 0) >= 3
             AND (position_history.rebuilt_at IS NULL OR position_history.rebuilt_at <= COALESCE(position_capture_queue.settled_at, ''))
          LIMIT ?`,
    params: () => [], when: r => tsMs(r.at), subject: r => `position:${acctOf(r.account_id) ?? ''}:${r.position_id}`, account: acctCol,
    judge: r => ({ missing: [r.kind === 'gave_up' ? 'record' : 'verdict'], class: r.kind, detail: `${tail(r.account_id)} ${r.symbol} pos ${r.position_id}: ${cut(r.note ?? '', 80)}` }),
  },
  {
    id: 'STK-07', key: 'entry_transition_stuck', version: 1, stage: 'stuck', severity: 'defect', fix: 'writer+resolver', current: true,
    cite: ['entry-drain.js:118-140', 'entry-drain.js:130'],
    noun: 'account engine record',
    sql: `SELECT key, value FROM agent_state WHERE key >= 'acct:' AND key < 'acct;' AND key LIKE '%:engine_status_json' LIMIT ?`,
    params: () => [], when: () => null,
    subject: r => `engine:${String(r.key).split(':')[1]}`, account: r => acctOf(String(r.key).split(':')[1]),
    judge(r, ctx, w) {
      const s = parseJson(r.value)
      if (!s || typeof s !== 'object') return { missing: ['engine_status'], class: 'unreadable', detail: `${r.key}: record does not parse` }
      const acct = acctOf(String(r.key).split(':')[1])
      const state = s.transitionState
      const orphans = w.orphanedPendingByAccount.get(acct) || 0
      if (s.requestedEntryMode === 'STOPPED' && orphans > 0) {
        return { missing: ['settle'], class: 'cannot_settle', detail: `${tail(acct)} STOPPED requested with ${orphans} orphaned working resting row(s): it cannot settle (entry-drain.js:120-123)` }
      }
      if (!['WARMING', 'QUIESCING', 'RECONCILING'].includes(state)) return null
      // updatedAt is rewritten every pass (entry-drain.js:130): the entry time
      // is a LOWER BOUND from the newest drain row that recorded the transition.
      const entered = ctx.drainLog.filter(d => acctOf(d.account_id) === acct && parseJson(d.body)?.to === state).map(d => tsMs(d.at)).filter(x => x != null)
      const since = entered.length ? Math.max(...entered) : ctx.actionLogFloorMs
      if (since == null || w.nowMs - since <= 30 * MIN) return null
      return { missing: ['settle'], class: state, since: iso(since), sinceIsLowerBound: !entered.length, detail: `${tail(acct)} ${state} since ${entered.length ? '' : 'at least '}${iso(since).slice(0, 16)}` }
    },
  },
  {
    id: 'STK-08', key: 'outbox_backlog', version: 1, stage: 'stuck', severity: 'defect', fix: 'reporting', current: true,
    cite: ['db.js:1815', 'independent-protection.js:117', 'watchdog_state.cpp:61-65'],
    noun: 'outbox',
    sql: `SELECT id, queued_at, (SELECT COUNT(*) FROM telegram_outbox WHERE sent_at IS NULL) AS n FROM telegram_outbox
           WHERE sent_at IS NULL ORDER BY id LIMIT ?`,
    params: () => [], populationLimit: 1,
    rows(dbRows, ctx) {
      const out = [{ kind: 'telegram', ...(dbRows[0] || { n: 0 }) }]
      out.push({ kind: 'watchdog', status: ctx.watchdog?.status ?? null, readAt: ctx.watchdog?.readAt ?? null })
      return out
    },
    when: r => (r.kind === 'telegram' ? tsMs(r.queued_at) : null), subject: r => `outbox:${r.kind}`, account: () => null,
    judge(r, _ctx, w) {
      if (r.kind === 'telegram') {
        const oldest = tsMs(r.queued_at)
        return r.n > 0 && oldest != null && oldest < w.nowMs - DAY
          ? { missing: ['delivery'], class: 'telegram', since: iso(oldest), detail: `${r.n} unsent Telegram row(s), oldest queued ${iso(oldest).slice(0, 16)}` } : null
      }
      const s = r.status
      if (!s || typeof s !== 'object') return OUT
      const items = s.outbox && typeof s.outbox === 'object' ? Object.values(s.outbox) : []
      const oldUnattempted = items.filter(i => Number(i?.attempts || 0) === 0 && Number(i?.createdAtMs) < w.nowMs - HOUR).length
      const dropped = Number(s.dropped) || 0
      if (!((items.length >= 512 && oldUnattempted > 0) || dropped > 0)) return null
      // ONE stuck mechanism, not 512 stuck items (VERIFY correction 6).
      return { missing: ['delivery'], class: 'watchdog', detail: `watchdog outbox ${items.length}/512, ${oldUnattempted} never attempted and over 1 h old, dropped ${dropped}` }
    },
  },
  {
    id: 'STK-09', key: 'targetless_repeating', version: 1, stage: 'stuck', severity: 'defect', fix: 'resolver+owner', current: true,
    cite: ['naked-position-guard.js:400-425'],
    noun: 'targetless position (last 5,000 action_log ids)',
    sql: `SELECT id, at, body FROM action_log
           WHERE id > (SELECT COALESCE(MAX(id), 0) FROM action_log) - ${ACTION_LOG_WINDOW_IDS} AND method = 'POSITION_NO_TARGET' ORDER BY id LIMIT ?`,
    params: () => [],
    rows(dbRows) {
      const by = new Map()
      for (const row of dbRows) {
        const b = parseJson(row.body) || {}
        const pid = b.positionId ?? b.position_id
        if (pid == null) continue
        const g = by.get(String(pid)) || { positionId: String(pid), account_id: acctOf(b.accountId ?? b.account_id), symbol: b.symbol ?? null, first: Infinity, last: -Infinity, n: 0 }
        const t = tsMs(row.at)
        if (t != null) { g.first = Math.min(g.first, t); g.last = Math.max(g.last, t) }
        g.n++
        by.set(String(pid), g)
      }
      return [...by.values()]
    },
    when: r => (Number.isFinite(r.first) ? r.first : null), subject: r => `position:${r.account_id ?? ''}:${r.positionId}`, account: r => r.account_id,
    judge(r, ctx) {
      const open = ctx.trades.find(t => t.status === 'open' && String(t.ctrader_position_id) === r.positionId && (r.account_id == null || acctOf(t.account_id) === r.account_id))
      if (!open) return OUT
      r.account_id = r.account_id ?? acctOf(open.account_id)
      if (!(r.last - r.first > 2 * HOUR)) return null
      return { missing: ['target'], since: iso(r.first), detail: `pos ${r.positionId} ${open.symbol} (#${open.id}): ${r.n} POSITION_NO_TARGET rows over ${Math.round((r.last - r.first) / HOUR)} h` }
    },
  },
  {
    id: 'STK-10', key: 'external_order_ageing', version: 1, stage: 'stuck', severity: 'notice', fix: 'reporting', current: true,
    cite: ['close-completeness.js:54-56'],
    noun: 'external working order',
    sql: `SELECT order_id, account_id, symbol, order_type, label, first_seen FROM broker_orders WHERE status = 'working' AND is_bot = 0 LIMIT ?`,
    params: () => [], when: r => tsMs(r.first_seen), subject: r => `order:${r.order_id}`, account: acctCol,
    judge(r, _ctx, w) {
      const seen = tsMs(r.first_seen)
      return seen != null && seen < w.nowMs - 7 * DAY ? { class: 'external_aged', since: iso(seen), detail: `order ${r.order_id} ${tail(r.account_id)} ${r.symbol} ${r.order_type ?? ''} working since ${iso(seen).slice(0, 10)}` } : null
    },
  },
  {
    // VERIFY correction 11: the heartbeat's own ladder names `error` (and
    // `stalled`); there is no `failing`. A controller at the alert streak
    // (heartbeat.js FAIL_ALERT_AT = 3) is stuck on something only a fix or
    // an operator clears — pnl_reconcile at 1,701 consecutive failures.
    id: 'STK-11', key: 'controller_failing', version: 1, stage: 'stuck', severity: 'defect', fix: 'resolver', current: true,
    cite: ['heartbeat.js:170', 'heartbeat.js:456-461', 'heartbeat.js:525-529'],
    noun: 'controller',
    sql: `SELECT name, last_run_at, last_ok_at, last_error, consecutive_failures FROM controller_heartbeats LIMIT ?`,
    params: () => [], when: r => tsMs(r.last_ok_at), subject: r => `controller:${r.name}`, account: () => null,
    judge(r) {
      if (RETIRED_CONTROLLERS.includes(r.name) || !(Number(r.consecutive_failures) >= 3)) return null
      return { missing: ['ok_run'], class: 'error', since: r.last_ok_at ?? null, detail: `${r.name} ×${r.consecutive_failures} since ok ${String(r.last_ok_at ?? 'never').slice(0, 16)}: ${cut(r.last_error ?? '', 80)}` }
    },
  },
])

/**
 * The helpers the judges share. A change to any of them changes what several
 * rules mean at once, so they carry their own version, pinned beside the
 * rules' (order-lifecycle.test.js) and named in RULESET_VERSION.
 */
export const HELPERS_VERSION = 1
export const JUDGE_HELPERS = Object.freeze({
  tsMs, blank, num, acctOf, idKey, upper, dirOf, ours, intentTag, parseJson, directionReasonOf, sideProblems, riskScaleWrong,
  botTrade, proposalOf, fillOf, closeMsOf, tagEvidence, fillForPending, closedOlder, tradeInWindow,
  constants: `${ABSURD_RISK_FRACTION}|${GENERIC_CLOSE_RE}|${[...LIMIT_PRODUCERS]}|${TERMINAL_INTENT}|${CLEAN_BOT_ORIGINS}|${ACTION_LOG_WINDOW_IDS}`,
})
export const RULESET_VERSION = [...RULES.map(r => `${r.id}@${r.version}`), `helpers@${HELPERS_VERSION}`].join(',')

/** Things a rule cannot judge from the database, stated rather than passed. */
export const NOT_VERIFIABLE = Object.freeze([
  'approval opportunity_key: a backfill fills every missing key after the fact (opportunity-identity.js:192), so a key the write path failed to store is invisible — Not Verifiable, not Passed (VERIFY correction 4).',
  'approval entry and stop presence: risk.js:2056 vetoes any proposal without them, so an approval always carries both; only strategy, direction reason and stop side are judged (VERIFY correction 4).',
  'intent bracket units: exec-engine.js:811 stores relative wire points without recording that it did (bracketUnits: unrecorded).',
  'the fill time of an adopted row with no broker deal: opened_at is the adoption stamp (reconciler.js:541), not the fill.',
  'whether cTrader pre-assigns a positionId to a resting order on ORDER_ACCEPTED (the mechanism behind ORD-04) is inferred, not observed.',
  'broker-side facts (a deal not yet imported, a position the broker still holds): no broker read is made here; recoverability "broker" means one is needed.',
])

// ---------------------------------------------------------------- builder
function windowFor(nowMs, { sinceIso = null, days = null } = {}, cfg) {
  const d = days == null ? cfg.windowDays : Number(days)
  if (!Number.isFinite(d) || d < 1 || d > 90) throw new RangeError('days must be between 1 and 90')
  let sinceMs = nowMs - Math.floor(d) * DAY
  if (sinceIso != null && sinceIso !== '') {
    const t = Date.parse(String(sinceIso))
    if (!Number.isFinite(t)) throw new RangeError('since must be an ISO date')
    if (t > nowMs) throw new RangeError('since is in the future')
    sinceMs = t
  }
  const lowMs = sinceMs - DAY
  return { nowMs, sinceMs, lowMs, lowSpace: spaceTs(lowMs), acceptanceMs: Date.parse(cfg.acceptanceStart), windowDays: Math.round((nowMs - sinceMs) / DAY * 100) / 100 }
}

function ruleByRef(ref) {
  if (ref == null || ref === '') return null
  const s = String(ref).trim()
  const r = RULES.find(x => x.id.toLowerCase() === s.toLowerCase() || x.key === s)
  if (!r) throw new RangeError(`unknown rule ${cut(s, 40)}`)
  return r
}

/**
 * Validate and normalise the route's query on the MAIN thread (no database),
 * so a bad parameter is a 400 and not a worker failure. The result is the
 * worker's option object and its single-flight key: the same query always
 * normalises to the same key.
 */
export function normaliseLifecycleOptions(q = {}, nowMs = Date.now()) {
  const pick = v => (v == null || String(v).trim() === '' ? null : String(v).trim())
  const account = pick(q.account)
  if (account != null && account.toLowerCase() !== 'all' && !/^[A-Za-z0-9_.-]{1,64}$/.test(account)) throw new RangeError('account must be all or an account id')
  let days = null
  if (pick(q.days) != null) {
    days = Number(pick(q.days))
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new RangeError('days must be an integer between 1 and 90')
  }
  const sinceIso = pick(q.since)
  if (sinceIso != null) {
    const t = Date.parse(sinceIso)
    if (!Number.isFinite(t)) throw new RangeError('since must be an ISO date')
    if (t > nowMs) throw new RangeError('since is in the future')
  }
  const only = ruleByRef(pick(q.rule))
  let limit = null
  if (pick(q.limit) != null) {
    const max = only ? SAMPLE_LIMIT_ONE_RULE : SAMPLE_LIMIT
    limit = Number(pick(q.limit))
    if (!Number.isInteger(limit) || limit < 0 || limit > max) throw new RangeError(`limit must be an integer between 0 and ${max}`)
  }
  let offset = 0
  if (pick(q.offset) != null) {
    offset = Number(pick(q.offset))
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new RangeError('offset must be a non-negative integer')
  }
  return { account: account != null && account.toLowerCase() === 'all' ? 'all' : account, days, sinceIso, rule: only ? only.id : null, limit, offset }
}
/** The 10-minute snapshot reads exactly what the Reasons page's ?account=all reads — one shared worker job. */
export const SNAPSHOT_OPTIONS = Object.freeze(normaliseLifecycleOptions({ account: 'all' }))

function runRule(db, rule, ctx, win, scope) {
  const res = {
    id: rule.id, key: rule.key, version: rule.version, stage: rule.stage, severity: rule.severity, fix: rule.fix, cite: rule.cite,
    measurable: true, reason: null, population: 0, populationNew: 0, violations: 0, newViolations: 0, legacyViolations: 0,
    undated: 0, classes: {}, byAccount: {}, unattributed: { population: 0, violations: 0, newViolations: 0 },
    newestAt: null, truncated: ctx.truncated.length > 0, error: null,
  }
  const entries = []
  let rows
  const limit = Math.max(1, Math.min(win.populationLimit ?? Infinity, rule.populationLimit ?? DEFAULT_POPULATION_LIMIT))
  try {
    rows = db.prepare(rule.sql).all(...rule.params(win), limit)
  } catch (err) {
    res.measurable = false; res.error = String(err?.message || err); res.reason = `unreadable: ${cut(res.error, 120)}`
    return { res, entries }
  }
  if (rows.length >= limit && !(rule.populationLimit === 1)) res.truncated = true
  if (rule.rows) rows = rule.rows(rows, ctx, win)
  let newest = -Infinity
  for (const row of rows) {
    const t = rule.when(row, ctx, win)
    const current = rule.current === true
    const inWin = current || (rule.inWindow ? rule.inWindow(row, win, ctx, t) : (t != null && t >= win.sinceMs))
    // A row with no usable time cannot be placed in the window: counted and
    // said, never silently dropped.
    if (!inWin) { if (t == null) res.undated++; continue }
    const verdict = rule.judge(row, ctx, win)
    if (verdict === OUT) continue
    const acct = acctOf(rule.account(row, ctx))
    const isNew = current ? true : (t != null && t >= win.acceptanceMs)
    const inScope = scope.all || acct === scope.accountId
    const unattributed = acct == null
    if (!inScope && !unattributed) continue
    const bucket = unattributed ? res.unattributed : (res.byAccount[acct] ||= { population: 0, violations: 0, newViolations: 0 })
    bucket.population++
    // Scoped to one account, an unattributed row is counted beside the
    // answer, never credited to the account (VERIFY correction 10).
    const counts = scope.all || !unattributed
    if (counts) { res.population++; if (isNew) res.populationNew++ }
    if (verdict == null) continue
    if (verdict.violation === false) { if (counts) res.classes[verdict.class] = (res.classes[verdict.class] || 0) + 1; continue }
    bucket.violations++; if (isNew) bucket.newViolations++
    if (!counts) continue
    res.violations++
    if (isNew) res.newViolations++; else res.legacyViolations++
    if (verdict.class) res.classes[verdict.class] = (res.classes[verdict.class] || 0) + 1
    const at = t ?? tsMs(verdict.since)
    if (at != null && at > newest) newest = at
    const { detail, class: cls, violation: _v, ...extra } = verdict
    entries.push({ subject: rule.subject(row, ctx), account: acct, at: iso(at), new: isNew, ...(cls ? { class: cls } : {}), ...extra, detail: cut(detail) })
  }
  res.newestAt = Number.isFinite(newest) ? iso(newest) : null
  if (res.undated) res.reason = `${res.undated} row(s) carry no usable time and are not placed in the window`
  if (!rule.current && res.population === 0 && !res.error) {
    res.measurable = false
    res.reason = `no ${rule.noun} in the window since ${iso(win.sinceMs).slice(0, 16)}Z${res.undated ? ` (${res.undated} undated)` : ''}`
  }
  if (rule.id === 'PRE-02' && res.population > 0 && !res.classes.scored && (res.classes.no_bars || 0) > 0) {
    res.note = `scored 0 while no_bars ${res.classes.no_bars}: the scorer is not scoring (goal-table.js:407-421 reports this as "waiting")`
  }
  return { res, entries }
}

const sortEntries = list => list.sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0) || String(a.subject).localeCompare(String(b.subject)))

function summarise(results, win, cfg) {
  const summary = {}
  const perAccount = new Map()
  const bump = (acct, stage, field, subject) => {
    const k = `${acct}|${stage}`
    if (!perAccount.has(k)) perAccount.set(k, { account: acct, stage, new: new Set(), legacy: new Set(), notices: new Set() })
    perAccount.get(k)[field].add(subject)
  }
  for (const stage of STAGES) {
    const rs = results.filter(r => r.res.stage === stage)
    const defects = rs.filter(r => r.res.severity === 'defect')
    const newS = new Set(), legS = new Set(), noticeS = new Set()
    for (const { res, entries } of rs) {
      for (const e of entries) {
        const acct = e.account ?? 'unattributed'
        if (res.severity === 'notice') { noticeS.add(e.subject); bump(acct, stage, 'notices', e.subject); continue }
        if (e.new) { newS.add(e.subject); bump(acct, stage, 'new', e.subject) } else { legS.add(e.subject); bump(acct, stage, 'legacy', e.subject) }
      }
    }
    for (const s of newS) legS.delete(s)
    const measurable = defects.some(r => r.res.measurable)
    const populationNew = defects.reduce((m, r) => Math.max(m, r.res.populationNew), 0)
    const unreadable = defects.filter(r => r.res.error).map(r => r.res.id)
    const note = !measurable
      ? `not measurable: ${defects.map(r => `${r.res.id} ${r.res.reason ?? '?'}`).slice(0, 3).join('; ')}`
      : stage !== 'stuck' && populationNew === 0
        ? `nothing new to judge since ${cfg.acceptanceStart}: a fact about volume, not a pass`
        : `${newS.size} ${stage === 'stuck' ? 'stuck' : 'new defective'} record(s)${unreadable.length ? `; unreadable: ${unreadable.join(', ')}` : ''}`
    summary[stage] = { new: newS.size, legacy: stage === 'stuck' ? 0 : legS.size, notices: noticeS.size, measurable, populationNew, note }
  }
  const accounts = [...perAccount.values()]
    .map(a => ({ account: a.account, stage: a.stage, new: a.new.size, legacy: a.stage === 'stuck' ? 0 : [...a.legacy].filter(s => !a.new.has(s)).length, notices: a.notices.size }))
    .sort((x, y) => STAGES.indexOf(x.stage) - STAGES.indexOf(y.stage) || String(x.account).localeCompare(String(y.account)))
  return { summary, accounts }
}

/**
 * Build the report. Pure over the database (reads only) and safe on the
 * worker's read-only connection. `account` is the raw ?account= value (null:
 * the selected account, read on THIS connection). Throws RangeError on a bad
 * parameter.
 */
export function buildOrderLifecycle(db, { nowMs = Date.now(), sinceIso = null, days = null, account = null, rule = null, limit = null, offset = 0, populationLimit = null, acceptanceStart = null } = {}) {
  const cfg = loadLifecycleConfig()
  if (acceptanceStart != null) {
    if (!Number.isFinite(Date.parse(acceptanceStart))) throw new RangeError('acceptanceStart must be an ISO date')
    cfg.acceptanceStart = new Date(Date.parse(acceptanceStart)).toISOString()
  }
  const now = Number(nowMs)
  const win = windowFor(now, { sinceIso, days }, cfg)
  if (populationLimit != null) win.populationLimit = Math.max(1, Math.floor(Number(populationLimit)))
  const only = ruleByRef(rule)
  const maxLimit = only ? SAMPLE_LIMIT_ONE_RULE : SAMPLE_LIMIT
  const sampleLimit = limit == null ? (only ? 50 : SAMPLE_LIMIT) : Number(limit)
  if (!Number.isFinite(sampleLimit) || sampleLimit < 0 || sampleLimit > maxLimit) throw new RangeError(`limit must be between 0 and ${maxLimit}`)
  const sampleOffset = Math.floor(Number(offset) || 0)
  if (sampleOffset < 0) throw new RangeError('offset must be 0 or more')

  const ctx = loadContext(db, win)
  const scope = requestedAccount(db, { query: { account: account == null || String(account).trim() === '' ? undefined : String(account) } })
  scope.all = scope.all || scope.accountId == null
  // STK-07's prediction needs the orphaned resting rows per account.
  win.orphanedPendingByAccount = new Map()
  const results = []
  for (const r of RULES) {
    if (r.id === 'STK-07') continue
    results.push(runRule(db, r, ctx, win, scope))
    if (r.id === 'STK-01') {
      for (const e of results[results.length - 1].entries) win.orphanedPendingByAccount.set(e.account, (win.orphanedPendingByAccount.get(e.account) || 0) + 1)
    }
  }
  results.splice(RULES.findIndex(r => r.id === 'STK-07'), 0, runRule(db, RULES.find(r => r.id === 'STK-07'), ctx, win, scope))

  const { summary, accounts } = summarise(results, win, cfg)
  const coverage = (() => {
    const total = results.reduce((s, { res }) => s + res.population, 0)
    if (scope.all) return { total, attributable: total, unstamped: 0, pct: 100, scoped: false }
    const unstamped = results.reduce((s, { res }) => s + res.unattributed.population, 0)
    const all = total + unstamped
    return { total: all, attributable: total, unstamped, pct: all === 0 ? 100 : Math.round(total / all * 1000) / 10, scoped: true }
  })()
  const shown = only ? results.filter(r => r.res.id === only.id) : results
  const stages = Object.fromEntries(STAGES.map(s => [s, []]))
  for (const { res, entries } of shown) {
    sortEntries(entries)
    stages[res.stage].push({ ...res, sampleTotal: entries.length, sampleOffset, sample: entries.slice(sampleOffset, sampleOffset + sampleLimit) })
  }
  const flat = shown.map(({ res }) => ({
    id: res.id, key: res.key, version: res.version, stage: res.stage, severity: res.severity, fix: res.fix,
    measurable: res.measurable, population: res.population, populationNew: res.populationNew,
    violations: res.violations, newViolations: res.newViolations, legacyViolations: res.legacyViolations,
    unattributed: res.unattributed.violations, newestAt: res.newestAt, truncated: res.truncated,
    reason: res.reason, cite: res.cite[0],
  }))
  const notVerifiable = [...NOT_VERIFIABLE]
  if (ctx.truncated.length) notVerifiable.push(`context read reached its bound (${ctx.truncated.join(', ')}): every rule is marked truncated`)
  return {
    schemaVersion: SCHEMA_VERSION, rulesetVersion: RULESET_VERSION, generatedAt: iso(now),
    acceptanceStart: cfg.acceptanceStart, acceptanceStartStatus: cfg.acceptanceStartStatus,
    windowDays: win.windowDays, window: { since: iso(win.sinceMs), until: iso(now) },
    scope: scopeReport({ accountId: scope.accountId, all: scope.all, explicit: scope.explicit }, coverage),
    summary, rules: flat, accounts, stages, notVerifiable,
    ...(only ? { rule: only.id } : {}),
  }
}

// ---------------------------------------------------------------- snapshot
/**
 * The row the goal table, the inspector and the daily report read: counts,
 * at most 5 samples per rule, and never more than SNAPSHOT_MAX_BYTES. The
 * samples shrink (5 → 1 → 0) before the snapshot is refused; the counts never do.
 */
export function compactSnapshot(report) {
  if (!report || report.schemaVersion !== SCHEMA_VERSION) throw new Error('order_lifecycle_snapshot_shape')
  const make = n => ({
    at: report.generatedAt, schemaVersion: report.schemaVersion, rulesetVersion: report.rulesetVersion,
    acceptanceStart: report.acceptanceStart, windowDays: report.windowDays, window: report.window,
    summary: report.summary, accounts: report.accounts,
    rules: STAGES.flatMap(s => report.stages[s] || []).map(r => ({
      id: r.id, key: r.key, version: r.version, stage: r.stage, severity: r.severity, fix: r.fix,
      measurable: r.measurable, reason: r.reason, population: r.population, populationNew: r.populationNew,
      violations: r.violations, newViolations: r.newViolations, legacyViolations: r.legacyViolations,
      unattributed: r.unattributed?.violations ?? 0, newestAt: r.newestAt, truncated: r.truncated, classes: r.classes,
      byAccount: Object.fromEntries(Object.entries(r.byAccount || {}).map(([a, b]) => [a, [b.violations, b.newViolations]])),
      sample: (r.sample || []).slice(0, n).map(e => ({ subject: e.subject, account: e.account, at: e.at, new: e.new, detail: cut(e.detail, 120) })),
    })),
    samplesPerRule: n,
  })
  for (const n of [5, 1, 0]) {
    const s = make(n)
    if (Buffer.byteLength(JSON.stringify(s)) <= SNAPSHOT_MAX_BYTES) return s
  }
  throw new Error('order_lifecycle_snapshot_bound')
}

export function readSnapshot(getStateFn, db) {
  try {
    const s = JSON.parse(getStateFn(db, SNAPSHOT_KEY) || 'null')
    return s && typeof s === 'object' && s.summary ? s : null
  } catch { return null }
}

// ---------------------------------------------------------------- goal rows
const STAGE_NAMES = { pre_order: 'Pre-order records stored complete', order: 'Order records stored complete', close: 'Close records stored complete', stuck: 'Nothing stuck without a resolver' }

/** Four goal rows from the snapshot. Pure. */
export function lifecycleGoals(snapshot, targets, nowMs) {
  const maxAgeMin = Number(targets.lifecycleSnapshotMaxAgeMin) || 30
  const at = Date.parse(snapshot?.at ?? '')
  const ageMin = Number.isFinite(at) ? Math.round((nowMs - at) / MIN) : null
  const stale = !snapshot || ageMin == null || ageMin > maxAgeMin
  return STAGES.map(stage => {
    const s = snapshot?.summary?.[stage]
    const max = stage === 'stuck' ? Number(targets.lifecycleStuckMax ?? 0) : Number(targets.lifecycleNewDefectsMax ?? 0)
    const top = (snapshot?.rules || []).filter(r => r.stage === stage && r.severity === 'defect' && r.newViolations > 0)
      .sort((a, b) => b.newViolations - a.newViolations).slice(0, 3).map(r => `${r.id} ${r.key} ${r.newViolations}`)
    const measurable = !stale && !!s && s.measurable !== false && (stage === 'stuck' || s.populationNew > 0)
    const note = !snapshot ? `no snapshot at ${SNAPSHOT_KEY} — the order_lifecycle controller has not produced one`
      : stale ? `snapshot ${ageMin} min old (limit ${maxAgeMin} min) — the controller may be failing; see /state/heartbeats`
        : !s ? `stage ${stage} missing from the snapshot`
          : s.measurable === false ? s.note
            : stage !== 'stuck' && !(s.populationNew > 0) ? `nothing new to judge since ${snapshot.acceptanceStart}: a fact about volume, not a pass; legacy ${s.legacy}`
              : `${s.new} ${stage === 'stuck' ? 'stuck' : 'new defective'} record(s)${top.length ? ` — ${top.join(' · ')}` : ''}${stage === 'stuck' ? '' : `; legacy ${s.legacy}`}${s.notices ? `; notices ${s.notices}` : ''}`
    return {
      id: `lifecycle_${stage}`, name: STAGE_NAMES[stage], subsystem: 'order lifecycle',
      metric: stage === 'stuck' ? 'records stuck now with no terminal state (distinct records)' : `records made since ${snapshot?.acceptanceStart ?? 'the acceptance start'} that failed to store or are incomplete (distinct records)`,
      target: `≤ ${max}`, horizon: stage === 'stuck' ? 'now' : `since ${snapshot?.acceptanceStart ?? '?'}`,
      current: measurable ? s.new : null,
      verdict: !measurable ? 'not_measurable' : s.new <= max ? 'on_track' : 'off_track',
      note, source: `/state/order-lifecycle?account=all (snapshot ${Number.isFinite(at) ? new Date(at).toISOString().slice(11, 16) + 'Z' : 'none'})`,
    }
  })
}

// ---------------------------------------------------------------- inspector
/**
 * log-inspector INSPECTIONS entry: one proposed code_change finding per rule
 * with NEW defect violations and a fix that is not reporting-only. Reads the
 * snapshot only. The finding is never auto-applied (log-inspector.js:472-475).
 */
export function inspectLifecycleRegression(snapshot, nowMs) {
  if (!snapshot || !Array.isArray(snapshot.rules)) return []
  return snapshot.rules.filter(r => r.severity === 'defect' && r.fix !== 'reporting' && r.newViolations > 0).map(r => ({
    source: 'order_lifecycle',
    subject_key: `order_lifecycle:${r.id}@v${r.version}`,
    speech_act: 'declaration',
    said: `${r.id} ${r.key}: ${r.newViolations} new violation(s) since ${snapshot.acceptanceStart} (newest ${r.newestAt ?? '?'})`,
    doing: 'declaring that a lifecycle record failed to store, stored incomplete, or is stuck — the owner order of 25-09-2026',
    finding: `${r.id} (${r.key}) keeps producing defective records; the ${r.fix} named in the rule is the fix — reporting will not clear it`,
    principle_kind: 'code_change',
    principle_params: { ruleId: r.id, version: r.version, newViolations: r.newViolations, fix: r.fix },
    falsifier: {
      prediction: `a new ${r.id} violation appears within 24 h — confirming the defect is live; none would mean it was historical`,
      metric: { kind: 'lifecycle_rule_recurs', ruleId: r.id, sinceMs: nowMs },
      deadlineMs: nowMs + 86_400_000,
    },
  }))
}

/** evalFalsifierMetric's case: true = recurred after sinceMs, false = did not, null = no snapshot / rule. */
export function lifecycleRuleRecurs(snapshot, { ruleId, sinceMs }) {
  if (!snapshot || !Array.isArray(snapshot.rules)) return null
  const r = snapshot.rules.find(x => x.id === ruleId)
  if (!r) return null
  const t = Date.parse(r.newestAt ?? '')
  if (!Number.isFinite(t)) return r.measurable === false ? null : false
  return t > Number(sinceMs)
}

// ---------------------------------------------------------------- daily report
export function lifecycleReportLines(snapshot) {
  if (!snapshot) return [`Lifecycle: no snapshot (${SNAPSHOT_KEY}) — the order_lifecycle controller has not produced one`]
  const s = snapshot.summary
  const hhmm = String(snapshot.at).slice(11, 16)
  const lines = [`Lifecycle since ${String(snapshot.acceptanceStart).slice(0, 16).replace('T', ' ')}Z (snapshot ${hhmm}Z): pre-order ${s.pre_order.new} new / ${s.pre_order.legacy} legacy; order ${s.order.new}; close ${s.close.new}; stuck ${s.stuck.new}`]
  const top = (snapshot.rules || []).filter(r => r.severity === 'defect' && r.newViolations > 0).sort((a, b) => b.newViolations - a.newViolations).slice(0, 3)
  for (const r of top) lines.push(`  ${r.id} ${r.key}: ${r.newViolations} new`)
  for (const stage of STAGES) {
    if (s[stage]?.measurable === false || (stage !== 'stuck' && !(s[stage]?.populationNew > 0))) lines.push(`  ${stage} not measurable: ${s[stage]?.note ?? 'missing'}`)
  }
  return lines
}
