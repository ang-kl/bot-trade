// ---------------------------------------------------------------------------
// agent/services/momentum-partial-runtime.js — V3 T3 (P0-2, corrected).
//
// The momentum partial-TP1 manager (momentum-partial-manager.js) is a state
// machine per plan; until this pass nothing called it, so a registered plan
// would have sat ARMED with its trigger passed and nobody watching. This pass
// runs it once per main-loop cycle, for every account that holds a plan, and
// records what it did so the status route and the website can say whether the
// manager is actually running.
//
// Inert while no plan exists: with the plan table absent or empty the pass
// makes no broker call, reads no credentials and changes no row. It writes
// only its own record (MOMENTUM_PARTIAL_PASS_KEY) and the loop's heartbeat.
//
// WHAT ONE PASS DOES
//   1. AWAITING_BIND intents whose position has already been exited (book row
//      exit_sent/closed, trade row terminal, or a close journaled by the book's
//      legacy path) become BIND_ABANDONED. No plan is registered for them, no
//      broker call is made, and the record stays visible with its evidence.
//      (The AWAITING_BIND state itself is written by T4's deferred bind; until
//      then this sweep finds nothing.)
//   2. Every plan in ARMED, SENDING, AMBIGUOUS or RECEIVED is grouped by its
//      own account. Each account runs with its own credentials, its own time
//      budget and its own failures; accounts run concurrently, plans within
//      an account one at a time.
//   3. An ARMED plan is first checked against a local price WITH A RECORDED
//      AGE: the momentum book's marks { c, at } (momentum_book_state_json).
//      Only a fresh mark more than prefilterR × initial risk short of the
//      trigger skips the authoritative read. A missing, stale or near mark
//      falls through to the broker. lastScanPrice is not used: it carries no
//      timestamp, so a days-old scan row far from the trigger would have
//      suppressed the authoritative read for ever.
//   4. At most one authoritative check per plan per minCheckIntervalMs.
//   5. A plan holding a proven partial receipt gets exactly one `scale_out`
//      position event (dealId, volume, price), marked on the plan row in the
//      same transaction so a crash, a restart or the journal's retention
//      sweep can never write it twice.
//
// The side of the mark. The book's marks are trendbar closes. For a BUY the
// trigger is tested on the bid, which is at or below the ask; for a SELL on
// the ask, which is at or above the bid. So a mark more than the margin short
// of the trigger proves the tested side is short of it too, whether the bar
// was built from the bid or the ask: the pre-filter can only fall through
// wrongly (an extra read), never skip wrongly.
// ---------------------------------------------------------------------------
import { getState, setState } from '../db.js'
import { markKey } from './book-open-drawdown.js'
import { readPartialPlan, runPartialPlan, addMissingColumns } from './momentum-partial-manager.js'
import { recordPositionEvent } from './position-events.js'

/** The pass record: when the pass last ran and what it did. */
export const MOMENTUM_PARTIAL_PASS_KEY = 'momentum_partial_pass_json'
/** momentum-book.js MOMENTUM_BOOK_STATE_KEY. Not imported: momentum-book
 * reaches momentum-entry-contract through book-entry-write, and the status
 * reader imports this file. A test pins the two strings equal. */
export const BOOK_STATE_KEY = 'momentum_book_state_json'

export const PARTIAL_PASS_DEFAULTS = Object.freeze({
  // One authoritative (broker) check per plan per minute at most.
  minCheckIntervalMs: 60_000,
  // A book mark older than this is not a price. The book re-marks every loop
  // (5 minutes); three loops of silence and the pass stops trusting it.
  markMaxAgeMs: 15 * 60_000,
  // A fresh mark within this many R of the trigger (or beyond it) forces the
  // authoritative read.
  prefilterR: 0.25,
  // Per account: no new plan is started once this much wall time has gone.
  accountBudgetMs: 15_000,
  maxPlansPerAccount: 50,
})

/** Plan states the manager still has work for. */
export const ACTIVE_PARTIAL_STATES = Object.freeze(['ARMED', 'SENDING', 'AMBIGUOUS', 'RECEIVED'])
/** Terminal trade states, db.js's CHECK vocabulary (momentum-book's BOOK_TERMINAL_TRADE_STATES). */
const TERMINAL_TRADE = ['closed', 'rejected', 'cancelled']
/** Position-event kinds that end a position (position-events.js TERMINAL_KINDS). */
const CLOSE_KINDS = ['close', 'loss_cap_close', 'position_reversed']

const parse = value => { try { return value ? JSON.parse(value) : null } catch { return null } }
const hasTable = (db, name) => {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) } catch { return false }
}
const iso = ms => new Date(ms).toISOString()
const short = e => String(e?.message ?? e).slice(0, 200)

/** The pass record as stored, or null. */
export function readMomentumPartialPass(db) {
  try { return parse(getState(db, MOMENTUM_PARTIAL_PASS_KEY)) } catch { return null }
}

function loopIntervalMs(db) {
  const n = Number(getState(db, 'loop_interval_min'))
  return (Number.isFinite(n) && n >= 1 && n <= 60 ? n : 5) * 60_000
}

/** Whether the pass is running: judged at read time from the record's own
 * stamp, three loop intervals of grace (the heartbeat registry's factor). */
export function partialPassFreshness(db, record, nowMs = Date.now()) {
  const maxAgeMs = 3 * loopIntervalMs(db)
  const atMs = Date.parse(record?.at ?? '')
  if (!Number.isFinite(atMs)) return { at: null, ageMs: null, maxAgeMs, fresh: false, why: 'the partial manager pass has never run' }
  const ageMs = nowMs - atMs
  const fresh = ageMs >= 0 && ageMs <= maxAgeMs
  return { at: record.at, ageMs, maxAgeMs, fresh,
    why: fresh ? null : `the partial manager pass is stale: last pass ${record.at}, ${Math.round(ageMs / 60_000)} min ago (limit ${Math.round(maxAgeMs / 60_000)} min)` }
}

/**
 * The pre-filter for one ARMED plan. `skip` only when the ledger still shows
 * the lifecycle open AND a fresh mark is more than `prefilterR` R short of
 * the trigger. Every other case falls through to the broker.
 */
export function prefilterVerdict({ plan, ledgerOpen, mark, nowMs, config = PARTIAL_PASS_DEFAULTS }) {
  if (!ledgerOpen) return { skip: false, reason: 'lifecycle_not_open_in_ledger' }
  const c = Number(mark?.c), at = Number(mark?.at)
  if (!(c > 0) || !Number.isFinite(at)) return { skip: false, reason: 'no_mark' }
  if (at > nowMs || nowMs - at > config.markMaxAgeMs) return { skip: false, reason: 'mark_stale' }
  const dir = plan?.side === 'BUY' ? 1 : plan?.side === 'SELL' ? -1 : 0
  if (!dir || !(plan.initialRisk > 0) || !(plan.trigger > 0)) return { skip: false, reason: 'plan_unreadable' }
  const gap = dir * (plan.trigger - c)
  if (gap > config.prefilterR * plan.initialRisk) return { skip: true, reason: 'mark_far_from_trigger', mark: c, markAt: at }
  return { skip: false, reason: 'mark_near_or_beyond_trigger' }
}

/** The ledger's view of a plan's lifecycle and the book's mark for it. */
function ledgerFor(db, accountId, tradeId, marks) {
  try {
    const t = db.prepare('SELECT status, symbol FROM trades WHERE id=? AND account_id=?').get(tradeId, accountId)
    const b = db.prepare('SELECT status, symbol FROM momentum_book WHERE trade_id=? AND account_id=?').all(tradeId, accountId)
    const book = b.length === 1 ? b[0] : null
    const open = t?.status === 'open' && book?.status === 'open'
    return { open, mark: open ? marks[markKey(accountId, book.symbol)] ?? null : null }
  } catch { return { open: false, mark: null } }
}

// ---------------------------------------------------------------------------
// 1. AWAITING_BIND → BIND_ABANDONED
// ---------------------------------------------------------------------------
const INTENT_COLUMNS = [['reason', 'TEXT'], ['evidence_json', 'TEXT'], ['resolved_at', 'INTEGER']]

/** Evidence that the position an AWAITING_BIND intent waits for has been
 * exited, or null while it may still be bound. Reads the ledger only. */
export function bindAbandonEvidence(db, accountId, tradeId) {
  const book = hasTable(db, 'momentum_book')
    ? db.prepare('SELECT id, status, exited_at, note FROM momentum_book WHERE trade_id=? AND account_id=?').all(tradeId, accountId) : []
  const exited = book.find(b => b.status === 'exit_sent' || b.status === 'closed')
  if (exited) return { reason: `book_row_${exited.status}`, bookRowId: exited.id, exitedAt: exited.exited_at ?? null, note: exited.note ?? null }
  const trade = hasTable(db, 'trades') ? db.prepare('SELECT status FROM trades WHERE id=? AND account_id=?').get(tradeId, accountId) : null
  if (trade && TERMINAL_TRADE.includes(trade.status)) return { reason: `trade_${trade.status}`, tradeStatus: trade.status }
  const close = hasTable(db, 'position_events')
    ? db.prepare(`SELECT id, kind, source, at FROM position_events WHERE trade_id=? AND (account_id=? OR account_id IS NULL)
        AND kind IN (${CLOSE_KINDS.map(() => '?').join(',')}) ORDER BY id LIMIT 1`).get(tradeId, accountId, ...CLOSE_KINDS) : null
  if (close) return { reason: 'close_recorded', positionEventId: close.id, kind: close.kind, source: close.source, at: close.at }
  return null
}

export function abandonExitedBinds(db, { nowMs }) {
  if (!hasTable(db, 'momentum_target_intents')) return []
  const waiting = db.prepare("SELECT account_id, trade_id FROM momentum_target_intents WHERE state='AWAITING_BIND'").all()
  if (!waiting.length) return []
  addMissingColumns(db, 'momentum_target_intents', INTENT_COLUMNS)
  const plans = hasTable(db, 'momentum_partial_plans')
  const done = []
  for (const w of waiting) {
    // A plan already registered means the bind happened; nothing to abandon.
    if (plans && readPartialPlan(db, w.account_id, w.trade_id)) continue
    const evidence = bindAbandonEvidence(db, w.account_id, w.trade_id)
    if (!evidence) continue
    const changed = db.prepare(`UPDATE momentum_target_intents SET state='BIND_ABANDONED', reason=?, evidence_json=?, resolved_at=?
      WHERE account_id=? AND trade_id=? AND state='AWAITING_BIND'`)
      .run(`bind_abandoned: ${evidence.reason}`, JSON.stringify({ ...evidence, source: 'ledger' }), nowMs, w.account_id, w.trade_id)
    if (changed.changes === 1) done.push({ accountId: w.account_id, tradeId: w.trade_id, reason: evidence.reason })
  }
  return done
}

// ---------------------------------------------------------------------------
// 5. One scale_out event per proven partial receipt
// ---------------------------------------------------------------------------
const PLAN_EVENT_COLUMNS = [['scale_out_event_id', 'INTEGER']]

function provenReceipt(row) {
  const r = row?.receipt, p = row?.plan
  return !!(r && p && r.accountId === row.account_id && String(r.positionId) === row.position_id
    && typeof r.dealId === 'string' && /^[1-9]\d*$/.test(r.dealId) && r.closedVolume === p.closeVolume
    && Number.isFinite(r.price) && r.price > 0 && Number.isSafeInteger(r.executedAtMs))
}

/** Write the scale_out event for every plan whose partial deal is proven and
 * not yet journaled. Returns the plans written, and those whose receipt is
 * held but whose event did not land (or whose receipt does not read as a
 * proven deal) — visible, retried next pass. Never makes a broker call. */
export function recordPartialScaleOuts(db) {
  const written = [], pending = []
  if (!hasTable(db, 'momentum_partial_plans')) return { written, pending }
  const withReceipt = db.prepare('SELECT account_id, trade_id FROM momentum_partial_plans WHERE receipt_json IS NOT NULL').all()
  if (!withReceipt.length) return { written, pending }
  addMissingColumns(db, 'momentum_partial_plans', PLAN_EVENT_COLUMNS)
  for (const w of withReceipt) {
    const row = readPartialPlan(db, w.account_id, w.trade_id)
    if (!row || row.scale_out_event_id != null) continue
    if (!provenReceipt(row)) { pending.push({ accountId: w.account_id, tradeId: w.trade_id, why: 'receipt_not_a_proven_deal' }); continue }
    const r = row.receipt, p = row.plan
    const dir = p.side === 'BUY' ? 1 : -1
    const find = () => db.prepare(`SELECT id FROM position_events WHERE trade_id=? AND kind='scale_out' AND source='momentum_partial'
      AND detail_json LIKE ? ORDER BY id LIMIT 1`).get(w.trade_id, `%"dealId":"${r.dealId}"%`)
    const id = db.transaction(() => {
      if (readPartialPlan(db, w.account_id, w.trade_id).scale_out_event_id != null) return null
      let ev = find()
      if (!ev) {
        const trade = hasTable(db, 'trades') ? db.prepare('SELECT symbol FROM trades WHERE id=? AND account_id=?').get(w.trade_id, w.account_id) : null
        recordPositionEvent(db, {
          accountId: w.account_id, positionId: row.position_id, tradeId: w.trade_id,
          symbol: trade?.symbol ?? `symbolId ${row.identity?.symbolId ?? 'unknown'}`,
          kind: 'scale_out', fromValue: p.volume, toValue: p.runnerVolume, priceAt: r.price,
          rAt: Number((dir * (r.price - p.entry) / p.initialRisk).toFixed(4)),
          reason: `momentum partial TP1: closed ${r.closedVolume} of ${p.volume} broker units at ${r.price} (trigger ${p.trigger})`,
          source: 'momentum_partial',
          detail: { dealId: r.dealId, orderId: r.orderId ?? null, volume: r.closedVolume, price: r.price,
            executedAtMs: r.executedAtMs, receiptSource: r.source ?? null, planState: row.state, volumeUnit: 'broker_volume' },
        })
        ev = find()
      }
      // recordPositionEvent never throws; an event that did not land leaves
      // the plan unmarked and the next pass tries again.
      if (!ev) return null
      db.prepare('UPDATE momentum_partial_plans SET scale_out_event_id=? WHERE account_id=? AND trade_id=? AND scale_out_event_id IS NULL')
        .run(ev.id, w.account_id, w.trade_id)
      return ev.id
    })()
    if (id != null) written.push({ accountId: w.account_id, tradeId: w.trade_id, eventId: id, dealId: r.dealId })
    else pending.push({ accountId: w.account_id, tradeId: w.trade_id, why: 'event_not_written' })
  }
  return { written, pending }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------
async function defaultAdapterFor(db, ref) {
  const { makeMomentumPartialBroker } = await import('./momentum-partial-broker.js')
  return makeMomentumPartialBroker(db, ref)
}

/**
 * One pass over every plan the manager still has work for.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ credsFor: (accountId: string) => object|null, now?: () => number,
 *   log?: (line: string) => void, deps?: { adapterFor?: Function, config?: object } }} options
 */
export async function runMomentumPartialPass(db, { credsFor = () => null, now: clock = Date.now, log = () => {}, deps = {} } = {}) {
  const now = typeof clock === 'function' ? clock : () => clock
  const config = { ...PARTIAL_PASS_DEFAULTS, ...(deps.config || {}) }
  const startMs = now()
  const prev = readMomentumPartialPass(db)
  const summary = { at: iso(startMs), ok: true, activePlans: 0, accounts: {}, abandonedBinds: [], scaleOutsRecorded: [],
    scaleOutsPending: [], errors: [], lastCheckAt: {} }
  const fail = (where, e) => { summary.ok = false; summary.errors.push(`${where}: ${short(e)}`) }

  try { summary.abandonedBinds = abandonExitedBinds(db, { nowMs: startMs }) } catch (e) { fail('bind_abandon', e) }

  let rows = []
  if (hasTable(db, 'momentum_partial_plans')) {
    try {
      rows = db.prepare(`SELECT account_id, trade_id, state FROM momentum_partial_plans
        WHERE state IN (${ACTIVE_PARTIAL_STATES.map(() => '?').join(',')}) ORDER BY account_id, trade_id`).all(...ACTIVE_PARTIAL_STATES)
    } catch (e) { fail('plan_read', e) }
  }
  summary.activePlans = rows.length
  const lastCheck = prev?.lastCheckAt && typeof prev.lastCheckAt === 'object' ? prev.lastCheckAt : {}
  for (const r of rows) {
    const k = `${r.account_id}|${r.trade_id}`
    if (Number.isFinite(lastCheck[k])) summary.lastCheckAt[k] = lastCheck[k]
  }

  if (rows.length) {
    const marks = (() => { try { return parse(getState(db, BOOK_STATE_KEY))?.marks ?? {} } catch { return {} } })()
    const byAccount = new Map()
    for (const r of rows) {
      if (!byAccount.has(r.account_id)) byAccount.set(r.account_id, [])
      byAccount.get(r.account_id).push(r)
    }
    const runAccount = async (accountId, plans) => {
      const a = { plans: plans.length, checked: 0, prefiltered: 0, rateLimited: 0, deferredBudget: 0, error: null, outcomes: [] }
      summary.accounts[accountId] = a
      let creds = null
      try { creds = credsFor(accountId) } catch (e) { a.error = `credentials_unreadable: ${short(e)}` }
      if (!a.error && (!creds?.ready || String(creds.accountId) !== accountId)) a.error = 'no_credentials'
      if (a.error) { summary.ok = false; return }
      const t0 = now()
      for (const plan of plans.slice(0, config.maxPlansPerAccount)) {
        const key = `${accountId}|${plan.trade_id}`
        if (now() - t0 >= config.accountBudgetMs) { a.deferredBudget++; continue }
        const last = summary.lastCheckAt[key]
        if (Number.isFinite(last) && now() - last < config.minCheckIntervalMs) { a.rateLimited++; continue }
        const row = readPartialPlan(db, accountId, plan.trade_id)
        if (!row || !ACTIVE_PARTIAL_STATES.includes(row.state)) continue
        if (row.state === 'ARMED') {
          const ledger = ledgerFor(db, accountId, plan.trade_id, marks)
          const verdict = prefilterVerdict({ plan: row.plan, ledgerOpen: ledger.open, mark: ledger.mark, nowMs: now(), config })
          if (verdict.skip) {
            a.prefiltered++
            a.outcomes.push({ tradeId: plan.trade_id, from: 'ARMED', state: 'ARMED', reason: verdict.reason, mark: verdict.mark, markAt: verdict.markAt })
            continue
          }
        }
        summary.lastCheckAt[key] = now()
        a.checked++
        let out
        try {
          const adapter = await (deps.adapterFor || defaultAdapterFor)(db, { identity: row.identity, tradeId: plan.trade_id })
          out = await runPartialPlan(db, creds, plan.trade_id, adapter)
        } catch (e) {
          summary.ok = false
          out = { state: row.state, reason: `pass_error: ${short(e)}` }
        }
        a.outcomes.push({ tradeId: plan.trade_id, from: row.state, state: out?.state ?? row.state, reason: out?.reason ?? null })
        if (out?.state !== row.state) log(`momentum partial …${accountId.slice(-4)} trade ${plan.trade_id}: ${row.state} → ${out?.state}${out?.reason ? ` (${out.reason})` : ''}`)
      }
      a.deferredBudget += Math.max(0, plans.length - config.maxPlansPerAccount)
      a.outcomes = a.outcomes.slice(-20)
    }
    await Promise.all([...byAccount].map(([accountId, plans]) => runAccount(accountId, plans).catch(e => {
      summary.ok = false
      summary.accounts[accountId] = { ...(summary.accounts[accountId] || {}), error: `account_pass_failed: ${short(e)}` }
    })))
  }

  try {
    const events = recordPartialScaleOuts(db)
    summary.scaleOutsRecorded = events.written
    summary.scaleOutsPending = events.pending
    for (const e of events.written) log(`momentum partial …${e.accountId.slice(-4)} trade ${e.tradeId}: scale_out journaled (deal ${e.dealId})`)
  } catch (e) { fail('scale_out_record', e) }
  summary.durationMs = now() - startMs
  summary.errors = summary.errors.slice(0, 10)
  try { setState(db, MOMENTUM_PARTIAL_PASS_KEY, JSON.stringify(summary)) } catch (e) { fail('record_write', e) }
  return summary
}

/**
 * What the website says about a position's partial plan (cockpit intention):
 * the plan, its state, and whether the pass that acts on it is running.
 * null when the position has no plan. Read-only.
 */
export function momentumPartialForPosition(db, accountId, tradeId, nowMs = Date.now()) {
  if (accountId == null || tradeId == null || !hasTable(db, 'momentum_partial_plans')) return null
  let row = null
  try { row = readPartialPlan(db, String(accountId), Number(tradeId)) } catch { return null }
  if (!row?.plan) return null
  const pass = partialPassFreshness(db, readMomentumPartialPass(db), nowMs)
  return { plan: row.plan, state: row.state, reason: row.reason ?? null, positionId: row.position_id, pass }
}
