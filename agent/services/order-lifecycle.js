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
// without bumping its version fails the gate. The shared machinery (context,
// runRule, summarise, the limits) is pinned the same way under
// HELPERS_VERSION. Line citations are at the tree this file ships in: the
// evidence map was read at f1d9223 and each cite was re-anchored to the same
// code on this branch (the L1 fix round), so a cite names a line that exists.
//
// NEW VERSUS LEGACY. `acceptanceStart` (agent/config/order-lifecycle.json)
// splits a defect made on or after it (NEW: what the goal rows count) from one
// inside the window but before it (LEGACY: shown, not counted). Without the
// split the flags would inherit the saturation of close_completeness and
// trade_reasons, whose cutoffs predate every writer being judged here.
//
// A ZERO THAT CAME FROM NO INPUT IS NOT A PASS. A pre-order, order or close
// rule with no population in its window reports measurable: false with the
// reason; a stuck rule is current state and measurable unless the account
// asked for is one nothing knows. A rule whose statement fails reports its
// error, never a count of 0 — and a stage with an unreadable or truncated
// rule says so in its summary, its goal row and its daily line, so a zero
// over the readable rules is never presented as the stage's zero.
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
import { CONTROLLERS, heartbeatView } from './heartbeat.js'

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
/** V3 L1c: unattributed violations named per rule in a report scoped to one account (bounded; ?account=all names them all). */
export const UNATTRIBUTED_SAMPLE_MAX = 5
/**
 * A snapshot this old is not evidence about now: the goal rows' default
 * limit (lifecycleSnapshotMaxAgeMin), the controller's own record limit
 * (heartbeat.js order_lifecycle maxAgeSec 1800) and the falsifiers' coverage.
 */
export const SNAPSHOT_FRESH_MS = 30 * 60_000
/** A trade younger than this is still being written (its plan, its monitored row): ORD-01 and STK-04, the same 10 minutes ORD-09 carries inline. */
export const WRITE_GRACE_MS = 10 * 60_000
/** At most this many subjects are named per information class (STK-11's record_stale / never_ran). */
const INFO_NAMES_MAX = 20
/** The protection audit logs one row per position per kind per this (naked-position-guard.js:320): STK-09's "still reported" bound. */
const PROTECTION_LOG_MUTE_MS = Math.max(60_000, Number(process.env.PROTECTION_LOG_MUTE_MS) || 3_600_000)

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

/**
 * V3 I3: a stuck record the resolver ENDED is not stuck. Written off
 * ('unresolved') it is a notice under STK-12; settled from broker evidence it
 * is terminal. Either way it is still judged (population) and shown in the
 * rule's classes, never dropped. null when the resolver has not ended it.
 */
function endedBy(ctx, subject) {
  const r = ctx.resolutionBySubject?.get(subject)
  if (!r) return null
  return { violation: false, class: r.outcome === 'unresolved' ? 'written_off' : 'settled' }
}

/**
 * V3 L1c: a record key naming a registered controller (STK-11's subject,
 * `controller:<name>`). A controller is not an account record: the stage
 * counts it, and names it on its own line — never inside an account's count,
 * never dropped from the headline.
 */
const CONTROLLER_RECORD_RE = /^controller:/
const isControllerRecord = rec => CONTROLLER_RECORD_RE.test(String(rec ?? ''))
/** The per-account line (`accounts[]`) the stage's controllers are counted on. */
export const CONTROLLERS_LINE = 'controllers'

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
  // V3 I3 fix round: + the stuck resolver's switch and last pass (STK-01,
  // STK-09's found-but-unwritten targets) and the protection audit's
  // per-account record (STK-09's positive evidence, naked-position-guard.js
  // auditKeyFor: 'acct:<id>:protection_audit_last_json').
  state: `SELECT key, value FROM agent_state
           WHERE key IN ('independent_watchdog_json', 'ctrader_account_id', 'stuck_resolver_enabled', 'stuck_resolver_last_json')
              OR (key LIKE 'acct:%' AND key LIKE '%:protection_audit_last_json') LIMIT ?`,
  drainLog: `SELECT id, at, account_id, body FROM action_log
              WHERE id > (SELECT COALESCE(MAX(id), 0) FROM action_log) - ${ACTION_LOG_WINDOW_IDS}
                AND method = 'LOOP' AND path = '/entry-mode/drain' ORDER BY id LIMIT ?`,
  actionLogFloor: `SELECT at FROM action_log WHERE id > (SELECT COALESCE(MAX(id), 0) FROM action_log) - ${ACTION_LOG_WINDOW_IDS} ORDER BY id LIMIT ?`,
  // V3 I3: how the stuck resolver ended a record (lib/stuck-resolutions.js).
  resolutions: `SELECT subject, kind, rule_id, outcome, verdict FROM stuck_resolutions LIMIT ?`,
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
  ctx.stuckResolverOn = state.stuck_resolver_enabled !== 'false'
  // The targets the resolver FOUND but did not write (R7 switched off): keyed
  // `<account>:<position>`, named in STK-09's detail.
  const resolverLast = parseJson(state.stuck_resolver_last_json ?? null) ?? null
  ctx.targetFound = new Map((Array.isArray(resolverLast?.targetless?.found) ? resolverLast.targetless.found : [])
    .map(f => [`${acctOf(f.accountId) ?? ''}:${f.positionId}`, { ...f, passAt: resolverLast.at ?? null }]))
  // The protection audit's last SUCCESSFUL read of each account (`at` is kept
  // through failures — recordAuditUnavailable) and the targetless positions it
  // saw then.
  ctx.auditByAccount = new Map()
  for (const [k, v] of Object.entries(state)) {
    const m = /^acct:(.+):protection_audit_last_json$/.exec(k)
    const rec = m ? parseJson(v) : null
    if (rec && typeof rec === 'object') ctx.auditByAccount.set(acctOf(m[1]), rec)
  }
  ctx.drainLog = read('drainLog')
  ctx.actionLogFloorMs = tsMs(read('actionLogFloor', [], 1)[0]?.at)
  ctx.resolutionBySubject = new Map(read('resolutions').map(r => [r.subject, r]))
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
    id: 'PRE-02', key: 'refusal_unscored', version: 2, stage: 'pre_order', severity: 'defect', fix: 'writer',
    cite: ['refusal-ledger.js:163', 'refusal-ledger.js:216-229', 'refusal-ledger.js:245', 'goal-table.js:415-429'],
    noun: 'scored refusal row (by scored_at, refusal-ledger.js:245 — not refusals made in the window)',
    populationLimit: REFUSAL_POPULATION_LIMIT,
    sql: `SELECT opportunity_key, account_id, symbol, outcome, scored_at FROM refusal_scores WHERE scored_at >= ? LIMIT ?`,
    params: opened, when: r => tsMs(r.scored_at), subject: r => `refusal:${r.opportunity_key}`, account: acctCol,
    judge(r) {
      if (r.outcome === 'no_bars') return { class: 'no_bars', detail: `${r.symbol}: scorer found no bars in the refusal's window (refusal-ledger.js:228)` }
      if (r.outcome === 'unscorable') return { class: 'unscorable', detail: `${r.symbol}: proposal carries no entry, stop or target (refusal-ledger.js:163)` }
      return ['target', 'stop', 'stop_moved', 'time_cap'].includes(r.outcome) ? { violation: false, class: 'scored' } : { violation: false, class: r.outcome ?? 'no_outcome' }
    },
  },
  {
    id: 'PRE-03', key: 'intent_incomplete', version: 1, stage: 'pre_order', severity: 'defect', fix: 'writer',
    cite: ['exec-engine.js:809', 'loop.js:693-696', 'exec-engine.js:811', 'reconciler.js:93-98', 'db.js:2113-2125'],
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
    cite: ['opportunity-disposition.js:44', 'log-inspector.js:327-351'],
    noun: 'approval',
    sql: APPROVALS_SQL, params: w => [w.lowSpace, w.lowSpace],
    when: r => tsMs(r.created_at), subject: r => `risk_event:${r.id}`, account: acctCol,
    judge: r => (r.disposition === 'dropped' ? { detail: `${r.symbol} ${r.side ?? ''}: approved, nothing acted, grace elapsed` } : null),
  },
  // ======================================================== (b) ORDER
  {
    // v2 (L1 fix round, N6): the plan is written at the fill, so it is owed
    // only by a filled row (open or closed) — not by a write-ahead
    // 'submitting' / 'unconfirmed' row, whose staleness is STK-03's — and
    // not by an open row inside WRITE_GRACE_MS of its opening.
    id: 'ORD-01', key: 'bot_trade_unreasoned', version: 2, stage: 'order', severity: 'defect', fix: 'writer',
    cite: ['close-completeness.js:69-100', 'position-history.js:292', 'trade-labels.js:360-363', 'actions.js:5957-5962'],
    noun: 'bot trade',
    sql: TRADES_OPENED_SQL, params: opened,
    when: (r, ctx) => fillOf(r, ctx).ms, subject: byId, account: acctCol, inWindow: tradeInWindow,
    judge(r, ctx, w) {
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
      const openedMs = tsMs(r.opened_at)
      const planOwed = r.status === 'closed' || (r.status === 'open' && !(openedMs != null && w.nowMs - openedMs < WRITE_GRACE_MS))
      if (!plan && planOwed) missing.push('trade_plan')
      if (!missing.length) return strategyLabelOnly ? { violation: false, class: 'strategy_label_only' } : null
      return { missing, detail: `#${r.id} ${r.symbol} ${r.status} origin=${r.origin ?? 'NULL'}`, openedAtSource: fillOf(r, ctx).source }
    },
  },
  {
    id: 'ORD-02', key: 'direction_reason_unreachable', version: 1, stage: 'order', severity: 'defect', fix: 'writer',
    cite: ['position-history.js:77-85', 'position-history.js:99-108', 'loop.js:5650'],
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
    cite: ['position-history.js:169-173', 'position-capture.js:357-361', 'broker-history-import.js:136-143', 'db.js:34'],
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
    cite: ['index.js:128-130', 'broker-history-import.js:159-170'],
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
    cite: ['db.js:2371', 'close-completeness.js:136'],
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
    cite: ['position-history.js:578', 'position-history.js:602', 'loop.js:2087', 'db.js:2425', 'position-capture-accounts.js:57-67'],
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
    // v2 (V3 I3): every working row now has a resolver — 'pending-closed'
    // rows closed-market-limits.js:84, every other note the stuck resolver
    // (R1, stuck-resolver.js). The row keeps naming which, never "none".
    id: 'STK-01', key: 'resting_record_orphaned', version: 2, stage: 'stuck', severity: 'defect', fix: 'resolver', current: true,
    cite: ['closed-market-limits.js:85-88', 'stuck-resolver.js:344', 'entry-mode.js:82-86', 'entry-drain.js:102', 'closed-market-limits.js:276-278'],
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
      // I3 fix round (checker NIT 8): the stuck resolver is a resolver only
      // while it is switched on — agent_state stuck_resolver_enabled = 'false'
      // is said here, never reported as a resolver that exists.
      const resolver = r.note === 'pending-closed' ? 'closed-market-limits reconcile'
        : ctx.stuckResolverOn ? 'stuck resolver R1' : "none — stuck resolver R1 switched off (agent_state stuck_resolver_enabled = 'false')"
      return {
        missing: ['terminal_status'], class: kind, resolverExists: r.note === 'pending-closed' || ctx.stuckResolverOn, resolver,
        corrupts: ['countResting (entry-mode.js:82-86)', 'the drain (entry-drain.js:102)', 'the cap of 20 (closed-market-limits.js:276-278)'],
        detail: `#${r.id} ${tail(r.account_id)} ${r.symbol} ${r.note ?? ''} expires ${iso(expires)?.slice(0, 16) ?? 'NULL'}${filled ? `; ${filled.fill} carries ${filled.intent}` : ''}; resolver: ${resolver}${kind === 'expired_working' && order?.status === 'working' ? ' (the order is still working at the broker: nothing to settle, never cancelled by a resolver)' : ''}`,
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
    // v2 (V3 I3): the stuck resolver ends these rows (R2 from a broker deal,
    // R5 as the duplicate of an adopted row, or written off after 24 h with
    // no broker evidence). A row it ended keeps its status — the trades CHECK
    // has no honest terminal value for "no evidence" — and is judged here as
    // written_off / settled, never as stuck.
    id: 'STK-03', key: 'trade_inflight_unresolved', version: 2, stage: 'stuck', severity: 'defect', fix: 'resolver', current: true,
    cite: ['loop.js:867', 'loop.js:911', 'stuck-resolver.js:229', 'actions.js:548-582'],
    noun: 'in-flight trade row',
    sql: `SELECT id, account_id, symbol, side, status, opened_at FROM trades WHERE status IN ('submitting', 'unconfirmed') LIMIT ?`,
    params: () => [], when: r => tsMs(r.opened_at), subject: byId, account: acctCol,
    judge(r, ctx, w) {
      const ended = endedBy(ctx, `trade:${r.id}`)
      if (ended) return ended
      const at = tsMs(r.opened_at) ?? -Infinity
      const over = (r.status === 'submitting' && at < w.nowMs - 10 * MIN) || (r.status === 'unconfirmed' && at < w.nowMs - HOUR)
      return over ? { missing: ['resolution'], class: r.status, detail: `#${r.id} ${tail(r.account_id)} ${r.symbol} ${r.status} since ${String(r.opened_at ?? '').slice(0, 16)}; resolver: the stuck resolver settles it from broker evidence, or writes it off 24 h after submission` } : null
    },
  },
  {
    // v2 (L1 fix round, N6): a row opened inside WRITE_GRACE_MS is still
    // being written (its monitored row follows the fill) — not stuck yet.
    id: 'STK-04', key: 'open_trade_unmonitored', version: 2, stage: 'stuck', severity: 'defect', fix: 'resolver', current: true,
    cite: ['reconciler.js:619-630'],
    noun: 'open trade row',
    sql: `SELECT id, account_id, symbol, ctrader_position_id, origin, opened_at FROM trades WHERE status = 'open' LIMIT ?`,
    params: () => [], when: r => tsMs(r.opened_at), subject: byId, account: acctCol,
    judge(r, ctx, w) {
      const opened = tsMs(r.opened_at)
      if (opened != null && w.nowMs - opened < WRITE_GRACE_MS) return null
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
    // v2 (V3 I3): a gave_up capture the stuck resolver wrote off (R6: the
    // field it lacked exists nowhere upstream, or it gave up again after one
    // re-queue) is a notice under STK-12, judged here as written_off.
    id: 'STK-06', key: 'capture_terminal', version: 2, stage: 'stuck', severity: 'defect', fix: 'resolver', current: true,
    cite: ['position-capture.js:73', 'position-capture.js:143', 'position-capture.js:181-222', 'stuck-resolver.js:474'],
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
    judge(r, ctx) {
      const ended = r.kind === 'gave_up' ? endedBy(ctx, `capture:${acctOf(r.account_id) ?? ''}:${r.position_id}`) : null
      if (ended && ended.class === 'written_off') return ended
      return { missing: [r.kind === 'gave_up' ? 'record' : 'verdict'], class: r.kind, detail: `${tail(r.account_id)} ${r.symbol} pos ${r.position_id}: ${cut(r.note ?? '', 80)}` }
    },
  },
  {
    // v2 (L1 fix round, N7): entry-drain.js:132-140 also logs a pass whose
    // from equals its to; such a row is not an entry into the state and would
    // move `since` later, understating how long the transition has been stuck.
    // v3 (L2a W14): the record's own `transitionSince`, stamped by
    // writeEngineStatus when the state was entered, is the entry time when
    // present; the drain-row lower bound below is the fallback for a record
    // written before the field existed.
    id: 'STK-07', key: 'entry_transition_stuck', version: 3, stage: 'stuck', severity: 'defect', fix: 'writer+resolver', current: true,
    cite: ['entry-drain.js:119-140', 'entry-drain.js:130', 'entry-mode.js:133-155'],
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
      // updatedAt is rewritten every pass (entry-drain.js:130): without the
      // record's own stamp the entry time is a LOWER BOUND from the newest
      // drain row that recorded the transition.
      const stamped = tsMs(s.transitionSince)
      const entered = stamped != null ? [] : ctx.drainLog.filter(d => {
        if (acctOf(d.account_id) !== acct) return false
        const b = parseJson(d.body)
        return b?.to === state && b?.from !== b?.to
      }).map(d => tsMs(d.at)).filter(x => x != null)
      const since = stamped ?? (entered.length ? Math.max(...entered) : ctx.actionLogFloorMs)
      if (since == null || w.nowMs - since <= 30 * MIN) return null
      const sinceSource = stamped != null ? 'record' : entered.length ? 'drain_log' : 'action_log_floor'
      return { missing: ['settle'], class: state, since: iso(since), sinceSource, sinceIsLowerBound: sinceSource === 'action_log_floor', detail: `${tail(acct)} ${state} since ${sinceSource === 'action_log_floor' ? 'at least ' : ''}${iso(since).slice(0, 16)}` }
    },
  },
  {
    id: 'STK-08', key: 'outbox_backlog', version: 1, stage: 'stuck', severity: 'defect', fix: 'reporting', current: true,
    cite: ['db.js:1874', 'independent-protection.js:117', 'watchdog_state.cpp:61-65'],
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
    // v2 (V3 I3): (a) a position the stuck resolver wrote off (R7: no target
    // recorded anywhere) is a notice under STK-12, judged here as
    // written_off; (b) CURRENT state — the protection audit logs one row per
    // position per PROTECTION_LOG_MUTE_MS (naked-position-guard.js:320), so a
    // position whose newest row is older than two of those (+10 min) has
    // stopped being reported targetless — clean only when the audit's own
    // per-account record proves it read the account late enough and did not
    // list the position, otherwise 'not_reported_now' (not a violation, named
    // in the rule's info: an account whose read keeps failing goes quiet
    // without the position gaining a target); (c) a target the resolver found
    // on record but did not write (R7's write is the owner's switch) is named
    // on the finding as class recorded_target_found.
    id: 'STK-09', key: 'targetless_repeating', version: 2, stage: 'stuck', severity: 'defect', fix: 'resolver+owner', current: true,
    cite: ['naked-position-guard.js:401-425', 'naked-position-guard.js:320', 'stuck-resolver.js:578'],
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
    judge(r, ctx, w) {
      const open = ctx.trades.find(t => t.status === 'open' && String(t.ctrader_position_id) === r.positionId && (r.account_id == null || acctOf(t.account_id) === r.account_id))
      if (!open) return OUT
      r.account_id = r.account_id ?? acctOf(open.account_id)
      if (!(r.last - r.first > 2 * HOUR)) return null
      const key = `${r.account_id ?? ''}:${r.positionId}`
      let stillListed = false
      if (r.last < w.nowMs - (2 * PROTECTION_LOG_MUTE_MS + 10 * MIN)) {
        // NO LONGER REPORTED is not "has a target" (I3 checker NIT 3): the
        // audit logs only after a successful account read, so an account
        // whose read keeps failing goes quiet with the position still
        // targetless. Clean only on POSITIVE evidence — the audit's last
        // successful read of the account (`at`, kept through failures) came
        // at least one mute window after the last row, when it would have
        // logged again, and it did not list the position targetless.
        const audit = ctx.auditByAccount?.get(r.account_id) ?? null
        const auditAt = tsMs(audit?.at)
        const late = auditAt != null && auditAt >= r.last + PROTECTION_LOG_MUTE_MS
        stillListed = Array.isArray(audit?.missingTargets) && audit.missingTargets.some(m => String(m?.positionId) === r.positionId)
        if (late && !stillListed) return null
        if (!late) {
          return { violation: false, class: 'not_reported_now',
            info: `pos ${r.positionId} ${open.symbol}: last reported targetless ${iso(r.last)}; ${auditAt == null ? 'no successful audit of the account on record' : `the account's last successful audit (${iso(auditAt)}) predates the next report`} — not verifiable as fixed` }
        }
        // late && stillListed: the audit's own list says it is still targetless.
      }
      const ended = endedBy(ctx, `target:${key}`)
      if (ended && ended.class === 'written_off') return ended
      // BLOCKER 1 (I3 checker): a target the resolver FOUND but did not write
      // (agent_state stuck_resolver_target_write not 'true') is named — the
      // position stays stuck until the owner decides.
      const found = ctx.targetFound?.get(key) ?? null
      return {
        missing: ['target'], since: iso(r.first), ...(found ? { class: 'recorded_target_found', recordedTarget: { tp: found.tp, source: found.source, foundAt: found.passAt, written: false } } : {}),
        detail: `pos ${r.positionId} ${open.symbol} (#${open.id}): ${r.n} POSITION_NO_TARGET rows over ${Math.round((r.last - r.first) / HOUR)} h${stillListed ? ', still in the audit\'s list' : ''}${found ? `; recorded target ${found.tp} found (${found.source}), not written — owner decision` : ''}`,
      }
    },
    note(res) {
      const names = res.info?.not_reported_now
      return names?.length ? `Not Verifiable as fixed — not_reported_now ${res.classes.not_reported_now}: ${names.join('; ')}${res.classes.not_reported_now > names.length ? '; …' : ''}` : null
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
    // VERIFY corrections 11 and 12. v2 (L1 fix round, B3): judged by the
    // heartbeat's OWN view (heartbeatView over the CONTROLLERS registry), so
    // this rule and /state/heartbeats cannot disagree about a controller —
    // two readings of one subsystem is CLAUDE.md failure mode #3's correction.
    //   stalled — last run older than expected × factor (heartbeat.js:611):
    //             pnl_reconcile last ran 09-20 with 0 failures is stuck;
    //   error   — consecutive failures ≥ FAIL_ALERT_AT = 3 (heartbeat.js:201):
    //             pnl_reconcile at 1,701 consecutive failures.
    // Unregistered names never reach the view (it iterates the registry), so a
    // row left behind by a removed controller cannot stay stuck for ever;
    // retired and dormant controllers are not in the population. record_stale
    // (the runner beats, its product is past its limit) and never_ran (no beat
    // on record) are NOT judged stuck: they are named as Not Verifiable here.
    id: 'STK-11', key: 'controller_failing', version: 2, stage: 'stuck', severity: 'defect', fix: 'resolver', current: true,
    cite: ['heartbeat.js:201', 'heartbeat.js:611-615', 'heartbeat.js:393-399', 'heartbeat.js:584-588', 'heartbeat.js:604-608'],
    noun: 'registered controller',
    // The statement proves the table is readable (a dropped table is an
    // error, never 0); the rows are the heartbeat's own view of it.
    sql: `SELECT name FROM controller_heartbeats LIMIT ?`,
    params: () => [], populationLimit: 1,
    rows: (_dbRows, _ctx, w, db) => heartbeatView(db, { now: new Date(w.nowMs) }),
    when: () => null, subject: r => `controller:${r.name}`, account: () => null,
    judge(r) {
      if (r.retired || RETIRED_CONTROLLERS.includes(r.name) || r.dormant) return OUT
      const def = CONTROLLERS[r.name] || {}
      if (r.verdict === 'stalled') {
        const limitMin = Number.isFinite(r.expected_sec) && Number.isFinite(def.factor) ? Math.round(r.expected_sec * def.factor / 60) : '?'
        return { missing: ['beat'], class: 'stalled', since: r.last_run_at ?? null,
          detail: `${r.name} stalled: last ran ${String(r.last_run_at ?? 'never').slice(0, 16)}, ${Number.isFinite(r.age_sec) ? Math.round(r.age_sec / 60) : '?'} min against a ${limitMin} min limit; ${r.consecutive_failures ?? 0} consecutive failure(s)` }
      }
      if (r.verdict === 'error') {
        return { missing: ['ok_run'], class: 'error', since: r.last_ok_at ?? r.last_run_at ?? null,
          detail: `${r.name} ×${r.consecutive_failures} since ok ${String(r.last_ok_at ?? 'never').slice(0, 16)}: ${cut(r.last_error ?? '', 80)}` }
      }
      if (r.verdict === 'record_stale' || r.verdict === 'never_ran') return { violation: false, class: r.verdict, info: r.name }
      return { violation: false, class: 'running' }
    },
    note(res) {
      const parts = ['record_stale', 'never_ran'].filter(c => res.info?.[c]?.length)
        .map(c => `${c} ${res.classes[c]}: ${res.info[c].join(', ')}${res.classes[c] > res.info[c].length ? ', …' : ''}`)
      return parts.length ? `Not Verifiable as stuck — ${parts.join('; ')} (a stale record or a controller with no beat is not judged here; see /state/heartbeats)` : null
    },
  },
  {
    // V3 I3 — THE WRITE-OFF IS A NOTICE, NOT A DISAPPEARANCE (owner
    // 25-09-2026 21:30 SGT): every record the stuck resolver ended with no
    // broker evidence to settle it on is named here, with its verdict and
    // reason, for as long as it exists. It is not counted as stuck (severity
    // notice: summary.notices, never summary.new) and not money (the resolver
    // writes no P&L onto a written-off record).
    id: 'STK-12', key: 'stuck_written_off', version: 1, stage: 'stuck', severity: 'notice', fix: 'reporting', current: true,
    cite: ['stuck-resolver.js:626', 'stuck-resolutions.js:60'],
    noun: 'written-off stuck record',
    sql: `SELECT subject, kind, rule_id, account_id, trade_id, verdict, reason, prior_state, resolved_at FROM stuck_resolutions WHERE outcome = 'unresolved' LIMIT ?`,
    params: () => [], when: r => tsMs(r.resolved_at), subject: r => r.subject, account: acctCol,
    judge: r => ({ class: r.kind, rule: r.rule_id, verdict: r.verdict, since: r.resolved_at, detail: `${r.subject} (${r.rule_id}, was ${r.prior_state ?? '?'}): ${r.verdict} — ${cut(r.reason, 110)}` }),
  },
])

/**
 * The helpers the judges share. A change to any of them changes what several
 * rules mean at once, so they carry their own version, pinned beside the
 * rules' (order-lifecycle.test.js) and named in RULESET_VERSION.
 *
 * v2 (L1 fix round, N4): the machinery every rule runs through is pinned
 * too — the context statements (the approvals window behind PRE-03, the
 * risk events behind ORD-02 and CLS-04), loadContext, runRule, summarise,
 * recordKeyOf, the registry check and the limits. Editing any of them
 * changes what the report says with no rule's own source changing, so it
 * must bump HELPERS_VERSION.
 *
 * v3 (V3 I3): the context reads the stuck resolver's record
 * (CONTEXT_SQL.resolutions) and endedBy() turns a resolved subject into a
 * written_off / settled class for STK-03, STK-06 and STK-09; it also reads
 * the stuck resolver's switch and last pass (STK-01 resolverExists, STK-09's
 * found-but-unwritten targets) and the protection audit's per-account
 * records (STK-09's positive evidence). v3 never shipped before this fix
 * round, so the fix round keeps the number.
 *
 * v4 (V3 L1c): the stage summaries count every violation, the unattributed
 * ones included. A report scoped to one account now carries its NULL-account
 * violations `beside` the account (runRule) and summarise counts them in the
 * stage headline — the rule's own counts are unchanged and still never
 * credit them to the account. A controller (STK-11, `controller:<name>`) is
 * counted in the headline and named on its own line (`controllers` in the
 * summary and in accounts[]), never as an account record. The all-accounts
 * headline numbers are unchanged; its parts are new. No rule's own source
 * changed, so no rule version moves.
 */
export const HELPERS_VERSION = 4
export const JUDGE_HELPERS = Object.freeze({
  tsMs, blank, num, acctOf, idKey, upper, dirOf, ours, intentTag, parseJson, directionReasonOf, sideProblems, riskScaleWrong,
  botTrade, proposalOf, fillOf, closeMsOf, tagEvidence, fillForPending, closedOlder, tradeInWindow, endedBy,
  loadContext, runRule, summarise, recordKeyOf, accountRegistered, isControllerRecord, stageCountPhrase,
  constants: `${ABSURD_RISK_FRACTION}|${GENERIC_CLOSE_RE}|${[...LIMIT_PRODUCERS]}|${TERMINAL_INTENT}|${CLEAN_BOT_ORIGINS}|${ACTION_LOG_WINDOW_IDS}` +
    `|${DEFAULT_POPULATION_LIMIT}|${REFUSAL_POPULATION_LIMIT}|${CONTEXT_LIMIT}|${WRITE_GRACE_MS}|${INFO_NAMES_MAX}|${PROTECTION_LOG_MUTE_MS}|${JSON.stringify(CONTEXT_SQL)}` +
    `|${CONTROLLER_RECORD_RE}|${CONTROLLERS_LINE}`,
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

/** true: in the account registry; false: not in it; null: the registry could not be read. */
function accountRegistered(db, accountId) {
  try { return db.prepare('SELECT 1 AS ok FROM accounts WHERE account_id = ? LIMIT 1').get(String(accountId)) != null } catch { return null }
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

/**
 * The record a subject names, for a stage's distinct count (VERIFY
 * correction 8, L1 fix round N1): a trade that carries a broker position IS
 * that position, so ORD-01 naming `trade:17` and ORD-06 naming
 * `position:<acct>:<pid>` for the same fill are one record, not two.
 */
function recordKeyOf(subject, ctx) {
  const m = /^trade:(\d+)$/.exec(String(subject))
  if (!m) return String(subject)
  const t = ctx.tradeById.get(Number(m[1]))
  return t?.ctrader_position_id != null ? `position:${acctOf(t.account_id) ?? ''}:${t.ctrader_position_id}` : String(subject)
}

function runRule(db, rule, ctx, win, scope) {
  const res = {
    id: rule.id, key: rule.key, version: rule.version, stage: rule.stage, severity: rule.severity, fix: rule.fix, cite: rule.cite,
    current: rule.current === true,
    measurable: true, reason: null, population: 0, populationNew: 0, violations: 0, newViolations: 0, legacyViolations: 0,
    undated: 0, classes: {}, info: {}, byAccount: {}, unattributed: { population: 0, violations: 0, newViolations: 0 },
    newestAt: null, truncated: ctx.truncated.length > 0, error: null,
  }
  const entries = []
  // V3 L1c: a report scoped to one account keeps its NULL-account rows (a
  // controller, an outbox, a row no writer stamped) out of the rule's own
  // counts — never credited to the account (VERIFY correction 10) — but the
  // stage summary counts them beside it, exactly as the all-accounts report
  // does. Measured in production with L1b live (helpers@2), 25-09-2026: the
  // report scoped to the selected account read summary.stuck.new = 19 while
  // STK-11 held pnl_reconcile (unattributed 1) and, at 15:05 UTC, STK-08 an
  // outbox (unattributed 1) — neither in any stage count.
  const beside = { entries: [], populationNew: 0 }
  let rows
  const limit = Math.max(1, Math.min(win.populationLimit ?? Infinity, rule.populationLimit ?? DEFAULT_POPULATION_LIMIT))
  try {
    rows = db.prepare(rule.sql).all(...rule.params(win), limit)
    if (rows.length >= limit && !(rule.populationLimit === 1)) res.truncated = true
    // A rule's own row shaping (STK-08, STK-09, STK-11) failing is the rule
    // being unreadable — never the whole report failing, never a 0.
    if (rule.rows) rows = rule.rows(rows, ctx, win, db)
  } catch (err) {
    res.measurable = false; res.error = String(err?.message || err); res.reason = `unreadable: ${cut(res.error, 120)}`
    return { res, entries, beside }
  }
  let newest = -Infinity, newestJudged = -Infinity
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
    if (counts) {
      res.population++; if (isNew) res.populationNew++
      // The newest record JUDGED at all, defective or not: what lets a
      // falsifier say "a record was made since and it was stored right".
      if (t != null && t > newestJudged) newestJudged = t
    } else if (isNew) beside.populationNew++
    if (verdict == null) continue
    if (verdict.violation === false) {
      if (!counts) continue
      res.classes[verdict.class] = (res.classes[verdict.class] || 0) + 1
      if (verdict.info != null) { const l = (res.info[verdict.class] ||= []); if (l.length < INFO_NAMES_MAX) l.push(String(verdict.info)) }
      continue
    }
    bucket.violations++; if (isNew) bucket.newViolations++
    const at = t ?? tsMs(verdict.since)
    const { detail, class: cls, violation: _v, info: _i, ...extra } = verdict
    const subject = rule.subject(row, ctx)
    const entry = { subject, record: recordKeyOf(subject, ctx), account: acct, at: iso(at), new: isNew, ...(cls ? { class: cls } : {}), ...extra, detail: cut(detail) }
    if (!counts) { beside.entries.push(entry); continue }
    res.violations++
    if (isNew) res.newViolations++; else res.legacyViolations++
    if (verdict.class) res.classes[verdict.class] = (res.classes[verdict.class] || 0) + 1
    if (at != null && at > newest) newest = at
    entries.push(entry)
  }
  res.newestAt = Number.isFinite(newest) ? iso(newest) : null
  res.newestJudgedAt = Number.isFinite(newestJudged) ? iso(newestJudged) : null
  if (res.undated) res.reason = `${res.undated} row(s) carry no usable time and are not placed in the window`
  if (!rule.current && res.population === 0 && !res.error) {
    res.measurable = false
    res.reason = `no ${rule.noun} in the window since ${iso(win.sinceMs).slice(0, 16)}Z${res.undated ? ` (${res.undated} undated)` : ''}`
  }
  if (rule.id === 'PRE-02' && res.population > 0 && !res.classes.scored && (res.classes.no_bars || 0) > 0) {
    res.note = `scored 0 while no_bars ${res.classes.no_bars}: the scorer is not scoring (goal-table.js:415-429 reports this as "waiting")`
  }
  if (rule.note) { const n = rule.note(res); if (n) res.note = n }
  return { res, entries, beside }
}

const sortEntries = list => list.sort((a, b) => (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0) || String(a.subject).localeCompare(String(b.subject)))

/**
 * V3 L1c: a stage's count as one phrase. When every counted item is an
 * account record it reads as before ("19 stuck record(s)"); otherwise it
 * names the parts the headline adds up — "20 stuck — 19 account record(s) ·
 * controllers: 1 stalled (pnl_reconcile: error)". Reads a snapshot written
 * before L1c (no parts) the old way. Pure.
 */
export function stageCountPhrase(s, stage) {
  const what = stage === 'stuck' ? 'stuck' : 'new defective'
  const ctl = Number(s?.controllers) || 0
  const una = Number(s?.unattributed) || 0
  if (!ctl && !una) return `${s?.new} ${what} record(s)`
  const records = Number.isFinite(Number(s?.records)) ? Number(s.records) : Number(s?.new) - ctl - una
  const names = Array.isArray(s?.controllerNames) && s.controllerNames.length
    ? ` (${s.controllerNames.join(', ')}${ctl > s.controllerNames.length ? ', …' : ''})`
    : ''
  const parts = [`${records} account record(s)`]
  if (una) parts.push(`${una} with no account`)
  if (ctl) parts.push(`controllers: ${ctl} stalled${names}`)
  return `${s?.new} ${what} — ${parts.join(' · ')}`
}

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
    // L1c: the record keys any entry credits to an account, and each
    // controller's class — the parts the headline is made of.
    const attributed = new Set()
    const controllerClass = new Map()
    for (const { res, entries, beside } of rs) {
      // L1c: a scoped report's unattributed violations (`beside`) count in the
      // stage as they do in the all-accounts report; the rule's own counts
      // stay the account's.
      for (const e of [...entries, ...(beside?.entries ?? [])]) {
        // Distinct RECORDS (N1): a trade with a broker position counts as that position.
        const rec = e.record ?? e.subject
        const controller = isControllerRecord(rec)
        const acct = controller ? CONTROLLERS_LINE : (e.account ?? 'unattributed')
        if (!controller && e.account != null) attributed.add(rec)
        if (res.severity === 'notice') { noticeS.add(rec); bump(acct, stage, 'notices', rec); continue }
        if (e.new) {
          newS.add(rec); bump(acct, stage, 'new', rec)
          if (controller && !controllerClass.has(rec)) controllerClass.set(rec, e.class ?? null)
        } else { legS.add(rec); bump(acct, stage, 'legacy', rec) }
      }
    }
    for (const s of newS) legS.delete(s)
    const controllerKeys = [...newS].filter(isControllerRecord).sort()
    const records = [...newS].filter(k => !isControllerRecord(k) && attributed.has(k)).length
    const parts = {
      records,
      unattributed: newS.size - controllerKeys.length - records,
      controllers: controllerKeys.length,
      controllerNames: controllerKeys.slice(0, INFO_NAMES_MAX).map(k => {
        const cls = controllerClass.get(k)
        return `${String(k).replace(CONTROLLER_RECORD_RE, '')}${cls ? `: ${cls}` : ''}`
      }),
    }
    const counted = stageCountPhrase({ new: newS.size, ...parts }, stage)
    const measurable = defects.some(r => r.res.measurable)
    // L1c: a new row beside a scoped account is a new row judged in the stage.
    const populationNew = defects.reduce((m, r) => Math.max(m, r.res.populationNew + (r.beside?.populationNew ?? 0)), 0)
    // B2: a stage whose count leaves a rule out says which, every time — the
    // goal row and the daily line read these, never a bare 0.
    const unreadable = defects.filter(r => r.res.error).map(r => ({ id: r.res.id, reason: cut(r.res.error, 100) }))
    const truncated = defects.filter(r => r.res.truncated).map(r => r.res.id)
    const partial = [
      unreadable.length ? `unreadable: ${unreadable.map(u => `${u.id} (${u.reason})`).join(', ')}` : null,
      truncated.length ? `truncated at the population bound (counts are a lower bound): ${truncated.join(', ')}` : null,
    ].filter(Boolean).join('; ')
    const note = !measurable
      // L1c: what WAS counted (a controller is judged whatever the account) is still said.
      ? `not measurable: ${defects.map(r => `${r.res.id} ${r.res.reason ?? '?'}`).slice(0, 3).join('; ')}${newS.size ? `; counted: ${counted}` : ''}`
      : stage !== 'stuck' && populationNew === 0
        ? `nothing new to judge since ${cfg.acceptanceStart}: a fact about volume, not a pass${partial ? `; ${partial}` : ''}`
        : `${counted}${partial ? `; ${partial}` : ''}`
    summary[stage] = { new: newS.size, legacy: stage === 'stuck' ? 0 : legS.size, notices: noticeS.size, measurable, populationNew, unreadable, truncated, note, ...parts }
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

  // N8 (spec §6 item 5): an explicit account that the registry does not know
  // and no record carries is not "nothing stuck" — every rule, the stuck ones
  // included, is not measurable for it. A registered account with nothing to
  // judge keeps its real 0; an unreadable registry is "could not tell", not
  // "unknown", so only the population decides then.
  const registry = scope.explicit && !scope.all ? accountRegistered(db, scope.accountId) : null
  scope.known = registry
  if (scope.explicit && !scope.all && registry !== true && results.every(({ res }) => res.population === 0)) {
    const why = registry === false
      ? `account ${cut(scope.accountId, 40)} is not in the account registry and no record carries it — nothing can be judged for it`
      : `no record carries account ${cut(scope.accountId, 40)} and the account registry could not be read — nothing can be judged for it`
    for (const { res } of results) if (!res.error) { res.measurable = false; res.reason = why }
  }

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
  for (const { res, entries, beside } of shown) {
    sortEntries(entries)
    // L1c: scoped to one account, the unattributed violations the stage
    // headline counts are named here too (a few; ?account=all has them all).
    const named = beside?.entries?.length ? { unattributedSample: sortEntries([...beside.entries]).slice(0, UNATTRIBUTED_SAMPLE_MAX) } : {}
    stages[res.stage].push({ ...res, sampleTotal: entries.length, sampleOffset, sample: entries.slice(sampleOffset, sampleOffset + sampleLimit), ...named })
  }
  const flat = shown.map(({ res }) => ({
    id: res.id, key: res.key, version: res.version, stage: res.stage, severity: res.severity, fix: res.fix,
    measurable: res.measurable, population: res.population, populationNew: res.populationNew,
    violations: res.violations, newViolations: res.newViolations, legacyViolations: res.legacyViolations,
    unattributed: res.unattributed.violations, newestAt: res.newestAt, truncated: res.truncated,
    reason: res.reason, ...(res.note ? { note: res.note } : {}), cite: res.cite[0],
  }))
  const notVerifiable = [...NOT_VERIFIABLE]
  if (ctx.truncated.length) notVerifiable.push(`context read reached its bound (${ctx.truncated.join(', ')}): every rule is marked truncated`)
  const controllers = results.find(r => r.res.id === 'STK-11')?.res
  if (controllers?.note) notVerifiable.push(`STK-11 ${controllers.note}`)
  const targetless = results.find(r => r.res.id === 'STK-09')?.res
  if (targetless?.note) notVerifiable.push(`STK-09 ${targetless.note}`)
  return {
    schemaVersion: SCHEMA_VERSION, rulesetVersion: RULESET_VERSION, generatedAt: iso(now),
    acceptanceStart: cfg.acceptanceStart, acceptanceStartStatus: cfg.acceptanceStartStatus,
    windowDays: win.windowDays, window: { since: iso(win.sinceMs), until: iso(now) },
    scope: { ...scopeReport({ accountId: scope.accountId, all: scope.all, explicit: scope.explicit }, coverage), ...(scope.explicit && !scope.all ? { registered: registry } : {}) },
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
      id: r.id, key: r.key, version: r.version, stage: r.stage, severity: r.severity, fix: r.fix, current: r.current === true,
      measurable: r.measurable, reason: r.reason, population: r.population, populationNew: r.populationNew,
      violations: r.violations, newViolations: r.newViolations, legacyViolations: r.legacyViolations,
      unattributed: r.unattributed?.violations ?? 0, newestAt: r.newestAt, newestJudgedAt: r.newestJudgedAt ?? null, truncated: r.truncated, classes: r.classes,
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
    const judged = !stale && !!s && s.measurable !== false && (stage === 'stuck' || s.populationNew > 0)
    // B2 (principle 6): a stage whose count leaves out an unreadable rule, or
    // whose population hit its bound, holds a LOWER BOUND. It can prove
    // off_track; it can never prove on_track — that is not_measurable, named.
    const partialNote = partialOf(s)
    const verdict = !judged ? 'not_measurable' : s.new > max ? 'off_track' : partialNote ? 'not_measurable' : 'on_track'
    // L1c: the count names its parts when any is not an account record
    // (a stalled controller, a row with no account) — the number is the whole.
    const counted = `${stageCountPhrase(s, stage)}${partialNote ? ' over the readable rules' : ''}`
    const note = !snapshot ? `no snapshot at ${SNAPSHOT_KEY} — the order_lifecycle controller has not produced one`
      : stale ? `snapshot ${ageMin} min old (limit ${maxAgeMin} min) — the controller may be failing; see /state/heartbeats`
        : !s ? `stage ${stage} missing from the snapshot`
          : s.measurable === false ? s.note
            : stage !== 'stuck' && !(s.populationNew > 0) ? `nothing new to judge since ${snapshot.acceptanceStart}: a fact about volume, not a pass; legacy ${s.legacy}${partialNote ? `; ${partialNote}` : ''}`
              : `${verdict === 'not_measurable' ? `not a pass — ${counted}` : verdict === 'off_track' && partialNote ? `at least ${counted}` : counted}` +
                `${top.length ? ` — ${top.join(' · ')}` : ''}${stage === 'stuck' ? '' : `; legacy ${s.legacy}`}${s.notices ? `; notices ${s.notices}` : ''}${partialNote ? `; ${partialNote}` : ''}`
    return {
      id: `lifecycle_${stage}`, name: STAGE_NAMES[stage], subsystem: 'order lifecycle',
      metric: stage === 'stuck'
        ? 'records stuck now with no terminal state, plus registered controllers stalled or failing — counted in, and named on their own line (distinct records within the stage; a trade with a broker position counts as that position)'
        : `records made since ${snapshot?.acceptanceStart ?? 'the acceptance start'} that failed to store or are incomplete (distinct records within the stage; a trade with a broker position counts as that position)`,
      target: `≤ ${max}`, horizon: stage === 'stuck' ? 'now' : `since ${snapshot?.acceptanceStart ?? '?'}`,
      current: verdict === 'not_measurable' ? null : s.new,
      verdict,
      note, source: `/state/order-lifecycle?account=all (snapshot ${Number.isFinite(at) ? new Date(at).toISOString().slice(11, 16) + 'Z' : 'none'})`,
    }
  })
}

/** The unreadable and truncated rules of a snapshot stage, as one clause; '' when the stage's count is whole. */
function partialOf(s) {
  const unreadable = Array.isArray(s?.unreadable) ? s.unreadable : []
  const truncated = Array.isArray(s?.truncated) ? s.truncated : []
  return [
    unreadable.length ? `unreadable: ${unreadable.map(u => (u && typeof u === 'object' ? `${u.id} (${u.reason ?? '?'})` : String(u))).join(', ')}` : null,
    truncated.length ? `truncated at the population bound: ${truncated.join(', ')} (counts are a lower bound)` : null,
  ].filter(Boolean).join('; ')
}

// ---------------------------------------------------------------- inspector
/**
 * log-inspector INSPECTIONS entry: one proposed code_change finding per rule
 * with NEW defect violations and a fix that is not reporting-only. Reads the
 * snapshot only. The finding is never auto-applied (log-inspector.js:499-500).
 */
export function inspectLifecycleRegression(snapshot, nowMs) {
  if (!snapshot || !Array.isArray(snapshot.rules)) return []
  const deadlineMs = nowMs + 86_400_000
  return snapshot.rules.filter(r => r.severity === 'defect' && r.fix !== 'reporting' && r.newViolations > 0).map(r => {
    // B1: a stuck rule's violations are CURRENT STATE, dated by when the item
    // got stuck (placed_at, last_ok_at, queued_at) — never after the finding.
    // "Recurs after the finding" can only falsify it, every day it is still
    // stuck. Its question is whether it is STILL stuck at the deadline.
    const current = r.current ?? RULES.find(x => x.id === r.id)?.current === true
    const falsifier = current
      ? {
          prediction: `${r.id} still shows violations in a snapshot taken within ${SNAPSHOT_FRESH_MS / 60_000} min of the 24 h deadline — confirming the stuck state is live; 0 would mean it was resolved; no such snapshot means nothing was measured (expired)`,
          metric: { kind: 'lifecycle_rule_persists', ruleId: r.id, version: r.version, sinceMs: deadlineMs - SNAPSHOT_FRESH_MS },
          deadlineMs,
        }
      : {
          prediction: `a new ${r.id} violation appears within 24 h — confirming the defect is live; none, over a snapshot that covers the 24 h and judged a record made in them, would mean it was historical`,
          metric: { kind: 'lifecycle_rule_recurs', ruleId: r.id, version: r.version, sinceMs: nowMs, coverUntilMs: deadlineMs - SNAPSHOT_FRESH_MS },
          deadlineMs,
        }
    return {
      source: 'order_lifecycle',
      subject_key: `order_lifecycle:${r.id}@v${r.version}`,
      speech_act: 'declaration',
      said: `${r.id} ${r.key}: ${r.newViolations} ${current ? 'stuck' : 'new'} violation(s) since ${current ? 'now' : snapshot.acceptanceStart} (newest ${r.newestAt ?? '?'})`,
      doing: 'declaring that a lifecycle record failed to store, stored incomplete, or is stuck — the owner order of 25-09-2026',
      finding: `${r.id} (${r.key}) ${current ? 'holds records stuck with no terminal state' : 'keeps producing defective records'}; the ${r.fix} named in the rule is the fix — reporting will not clear it`,
      principle_kind: 'code_change',
      principle_params: { ruleId: r.id, version: r.version, newViolations: r.newViolations, fix: r.fix, current },
      falsifier,
    }
  })
}

/** The snapshot's rule for a falsifier metric, or null when the evidence cannot answer (no snapshot, no rule, another version). */
function falsifierRule(snapshot, { ruleId, version }) {
  if (!snapshot || !Array.isArray(snapshot.rules)) return null
  const r = snapshot.rules.find(x => x.id === ruleId)
  if (!r) return null
  // A finding is about rule@version: a snapshot of a different meaning cannot confirm or falsify it.
  if (version != null && Number(r.version) !== Number(version)) return null
  return r
}

/**
 * evalFalsifierMetric 'lifecycle_rule_recurs' (non-current rules): true = a
 * violation newer than sinceMs; false = none, over a snapshot taken at or
 * after coverUntilMs that judged a record made after sinceMs; null = the
 * evidence cannot say (no snapshot, a snapshot not after sinceMs — the ticker
 * died —, one that does not cover the window, an unreadable rule, or no
 * record made since to judge). Never decided on absent evidence
 * (log-inspector.js:538).
 */
export function lifecycleRuleRecurs(snapshot, { ruleId, sinceMs, version = null, coverUntilMs = null }) {
  const r = falsifierRule(snapshot, { ruleId, version })
  if (!r) return null
  const at = Date.parse(snapshot.at ?? '')
  const since = Number(sinceMs)
  if (!Number.isFinite(at) || !(at > since)) return null
  const newest = Date.parse(r.newestAt ?? '')
  if (Number.isFinite(newest) && newest > since) return true
  if (r.measurable === false || r.error) return null
  if (at < Number(coverUntilMs ?? since)) return null
  const judged = Date.parse(r.newestJudgedAt ?? '')
  return Number.isFinite(judged) && judged > since ? false : null
}

/**
 * evalFalsifierMetric 'lifecycle_rule_persists' (current / stuck rules):
 * true = a snapshot taken after sinceMs still shows violations; false = it
 * shows 0 over a whole population; null = no snapshot after sinceMs (the
 * ticker is dead), an unreadable rule, or 0 over a truncated population.
 */
export function lifecycleRulePersists(snapshot, { ruleId, sinceMs, version = null }) {
  const r = falsifierRule(snapshot, { ruleId, version })
  if (!r) return null
  const at = Date.parse(snapshot.at ?? '')
  if (!Number.isFinite(at) || !(at > Number(sinceMs))) return null
  if (r.measurable === false || r.error) return null
  if (Number(r.violations) > 0) return true
  return r.truncated ? null : false
}

// ---------------------------------------------------------------- daily report
export function lifecycleReportLines(snapshot) {
  if (!snapshot) return [`Lifecycle: no snapshot (${SNAPSHOT_KEY}) — the order_lifecycle controller has not produced one`]
  const s = snapshot.summary
  const hhmm = String(snapshot.at).slice(11, 16)
  // A stage whose count leaves a rule out carries a mark on the headline (B2):
  // "pre-order 0* new" is not "pre-order 0 new", and the line below names why.
  const mark = stage => (partialOf(s[stage]) ? '*' : '')
  const lines = [`Lifecycle since ${String(snapshot.acceptanceStart).slice(0, 16).replace('T', ' ')}Z (snapshot ${hhmm}Z): pre-order ${s.pre_order.new}${mark('pre_order')} new / ${s.pre_order.legacy} legacy; order ${s.order.new}${mark('order')}; close ${s.close.new}${mark('close')}; stuck ${s.stuck.new}${mark('stuck')}`]
  const top = (snapshot.rules || []).filter(r => r.severity === 'defect' && r.newViolations > 0).sort((a, b) => b.newViolations - a.newViolations).slice(0, 3)
  for (const r of top) lines.push(`  ${r.id} ${r.key}: ${r.newViolations} new`)
  // L1c: a headline that counts a controller or a row with no account says
  // so on its own line — "stuck: 20 stuck — 19 account record(s) ·
  // controllers: 1 stalled (pnl_reconcile: error)".
  for (const stage of STAGES) {
    if ((Number(s[stage]?.controllers) || 0) + (Number(s[stage]?.unattributed) || 0) > 0) lines.push(`  ${stage}: ${stageCountPhrase(s[stage], stage)}`)
  }
  for (const stage of STAGES) {
    if (s[stage]?.measurable === false || (stage !== 'stuck' && !(s[stage]?.populationNew > 0))) lines.push(`  ${stage} not measurable: ${s[stage]?.note ?? 'missing'}`)
    else if (partialOf(s[stage])) lines.push(`  ${stage}* partial — ${partialOf(s[stage])}`)
  }
  return lines
}
