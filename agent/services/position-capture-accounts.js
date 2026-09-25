// agent/services/position-capture-accounts.js — every account's closes,
// captured and verified (V3 V1, owner order 25-09-2026, the overnight run).
//
// WHAT WAS WRONG, measured on production at 21:50 SGT 25-09: the only enqueue
// and the only drain sat inside loop.js's SELECTED-account reconcile block.
// Six of seven accounts, both gateway sides, and every close the bot made
// itself were never queued; /state/position-capture read `pending 0,
// captured 45` — healthy — and its last drain line was 22-09. cpp-verify's
// journal showed its boot line and `sessions: []` since 23-09, because the
// verifier client opens a session only when it has something to verify, and
// nothing was ever handed to it. position_history held 53 records against
// 1,254 refused ones out of 1,717 trades.
//
// THE SHAPE NOW:
//   1. every close queues at the close seam (db.js closeTradeRow →
//      close-capture.js, LIFECYCLE-SPEC §7 W11), and every reconcile path's
//      detected closes queue by the same (account, position) identity
//   2. ONE pass per reconcile cycle visits every account with that account's
//      OWN credentials: a bounded sweep of the last N days (default 7), the
//      verify backlog (only with a verifier), and a drain of THAT account's
//      rows only (position-capture.js drainCaptureQueue, `accountId`)
//   3. the pass is written down per account, and its verdict — which account
//      is silent, which is stalled, whose verifier keeps refusing — is the
//      `position_capture` heartbeat, so a silent account cannot read healthy
//
// NOTHING HERE PLACES, AMENDS OR CLOSES AN ORDER. The broker calls are deal
// history reads and a symbol-list / volume-meta read; the writes are this
// process's own record tables (the capture queue, position_history and its
// refused stream, broker_deals, agent_state).
//
// A SEPARATE MODULE ON PURPOSE. position-capture.js is cited line by line by
// the order-lifecycle rules (order-lifecycle.js `cite`), so V1 changed it
// only where it had to — and line-neutrally above its drain.

import { captureQueueView, enqueueVerifyBacklog, drainCaptureQueue, CAPTURE_DELAY_MS } from './position-capture.js'
import { capturePosition, buildPositionRecord, REQUIRED_FIELDS } from './position-history.js'
import { queueCloseCapture, closeCaptureFailures } from './close-capture.js'
import { verifyClient } from '../lib/verify-client.js'
import { getState, setState } from '../db.js'

/**
 * Every close a RECONCILE PATH detected, queued for capture.
 *
 * closeTradeRow already queues each trade row it moves open → closed (the
 * close seam), so for most closes this is a no-op by the queue's own
 * identity. It is kept, on ALL THREE reconcile paths (the selected account,
 * every other same-side account, every opposite-side account), because a
 * detected close can arrive with no open trade row left to move — a monitored
 * row outliving its trade — and the pre-V1 loop queued exactly these, for the
 * selected account only. `accountId` is the account whose snapshot the
 * reconcile read; the reconciler scopes its rows to that account (legacy NULL
 * rows to the selected account, reconciler.js), so that is the owner.
 *
 * @returns {{ seen: number, queued: number, refused: number }}
 */
export function enqueueReconcileCloses(db, result, { accountId, source = 'reconcile', now = Date.now() } = {}) {
  const out = { seen: 0, queued: 0, refused: 0 }
  const closes = [...(result?.closedDetected || []), ...(result?.orphansClosed || [])]
  for (const c of closes) {
    out.seen++
    const r = queueCloseCapture(db, { accountId, positionId: c?.positionId, symbol: c?.symbol ?? null, source, now })
    if (!r.ok) out.refused++
    else if (r.queued) out.queued++
  }
  return out
}

/**
 * GET /state/position-capture: the queue totals exactly as before, plus
 * `accounts` — one row per account with its closes, captures, verdicts and a
 * status judged at READ TIME from the tables and the last pass's timestamps —
 * the last pass time, and the close seam's own counts. The totals were true;
 * they just could not say WHICH account was silent.
 */
export function positionCaptureView(db, { now = Date.now(), env = process.env } = {}) {
  let coverage
  try {
    coverage = captureCoverage(db, { now, env, verifierConfigured: verifyClient({ env }) != null })
  } catch (e) {
    coverage = { error: e?.message || String(e) }
  }
  return {
    ...captureQueueView(db),
    accounts: coverage.accounts ?? null,
    coverage: {
      windowDays: coverage.windowDays ?? null,
      since: coverage.since ?? null,
      silent: (coverage.silent || []).map(a => a.accountId),
      stalled: (coverage.stalled || []).map(a => a.accountId),
      verifyFailing: (coverage.verifyFailing || []).map(a => a.accountId),
      error: coverage.error ?? null,
    },
    lastPassAt: readPassRecord(db)?.at ?? null,
    closeSeam: closeCaptureFailures(),
  }
}

/** Rows one account may drain per pass: each costs a deal read (+ a verify). */
export const DRAIN_PER_ACCOUNT = 5
/** The whole all-account pass stops starting new rows after this. */
export const CAPTURE_PASS_BUDGET_MS = 60_000
/** Sweep: candidate closes looked at per account per pass. */
export const SWEEP_EVAL_PER_PASS = 25
/** Sweep: captures queued per account per pass, spaced so drains spread. */
export const SWEEP_ENQUEUE_PER_PASS = 10
export const SWEEP_SPACING_MS = 20_000
export const DEFAULT_BACKFILL_DAYS = 7
export const MAX_BACKFILL_DAYS = 30
/** A close older than this with no capture record at all is SILENT. */
export const UNCAPTURED_GRACE_MS = 20 * 60_000
/** Due rows and no successful drain of the account for this long: STALLED. */
export const DRAIN_STALE_MS = 30 * 60_000
/** Consecutive unanswered verify asks for one account before it is flagged. */
export const VERIFY_SKIP_STREAK = 3
export const CAPTURE_PASS_KEY = 'position_capture_last_json'

/**
 * The required fields THIS capture's deal read fills. Everything else a
 * record needs (why the direction was taken, the strategy, the plan, the
 * close reason) is written by this process at entry or never — no broker
 * read will fill it.
 *
 * `volume` is the broker's, and is NOT on this list: refreshDealsFor stores
 * deals with no lots (its symbol metadata carries no lotSize — LIFECYCLE-SPEC
 * §7 W10), so a record's volume comes only from the reconciler's live read of
 * the open position. A close missing it is therefore recorded as refused now,
 * naming `volume`, instead of being retried six times into gave_up. When W10
 * stores lots, `volume` moves onto this list.
 */
export const CAPTURE_FILLABLE_FIELDS = Object.freeze([
  'symbol', 'direction', 'entry_price', 'exit_price',
  'opened_at_ms', 'closed_at_ms', 'hold_ms',
  'gross_pnl', 'commission', 'swap', 'net_pnl', 'realised_r',
])
/** Required fields a capture cannot fill: a refused record naming one is final for the sweep. */
export const STRUCTURAL_FIELDS = Object.freeze(REQUIRED_FIELDS.filter(f => !CAPTURE_FILLABLE_FIELDS.includes(f)))

/**
 * The sweep's window in days. `POSITION_CAPTURE_BACKFILL_DAYS=0` switches it
 * off; unset (or unreadable) means the default 7; capped at 30 so a typo
 * cannot ask for a year of deal history.
 */
export function backfillDays(env = process.env) {
  const raw = env?.POSITION_CAPTURE_BACKFILL_DAYS
  if (raw == null || String(raw).trim() === '') return DEFAULT_BACKFILL_DAYS
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_BACKFILL_DAYS
  if (n <= 0) return 0
  return Math.min(MAX_BACKFILL_DAYS, n)
}

// Detection time first: closed_at is stamped by closeTradeRow when this
// process saw the close; closed_at_ms can be rewritten to the broker's fill
// time, which is the right close time for a record and the wrong clock for
// "how long has this gone uncaptured".
const DETECTED_MS_SQL = `COALESCE(CAST(strftime('%s', t.closed_at) AS INTEGER) * 1000, t.closed_at_ms)`

/**
 * The bounded sweep: closes on ONE account in the last `days` with no
 * capture record of any kind — no queue row, no history row, and no refused
 * record naming a gap a capture cannot close.
 *
 * Each candidate is built locally first (no broker call). If what is missing
 * is only what a deal read fills, it is queued (source 'sweep'). If a
 * structural field is missing (direction_reason, strategy, the plan, volume
 * — STRUCTURAL_FIELDS), a capture would spend six deal reads and give up, so
 * the refused record is
 * written now, naming the fields — the same record the drain would write,
 * without the broker traffic and without a gave_up row that says "could not
 * build" about a gap no retry can fix. The refused record is what keeps the
 * close from being SILENT: it is counted, and named, per account.
 */
export function sweepRecentCloses(db, { accountId, now = Date.now(), days = DEFAULT_BACKFILL_DAYS, evalLimit = SWEEP_EVAL_PER_PASS, enqueueLimit = SWEEP_ENQUEUE_PER_PASS, spacingMs = SWEEP_SPACING_MS } = {}) {
  const acct = accountId == null || String(accountId).trim() === '' ? null : String(accountId)
  if (!acct) return { ran: false, reason: 'no_identity' }
  if (!(days > 0)) return { ran: false, reason: 'disabled' }
  const since = now - days * 86_400_000
  const until = now - CAPTURE_DELAY_MS
  const marks = STRUCTURAL_FIELDS.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT t.ctrader_position_id AS pid, MAX(t.symbol) AS symbol, MAX(${DETECTED_MS_SQL}) AS detected_ms
      FROM trades t
     WHERE t.status = 'closed' AND t.account_id = ? AND t.ctrader_position_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM position_capture_queue q
                        WHERE q.account_id = t.account_id AND q.position_id = t.ctrader_position_id)
       AND NOT EXISTS (SELECT 1 FROM position_history h
                        WHERE h.account_id = t.account_id AND h.ctrader_position_id = t.ctrader_position_id)
       AND NOT EXISTS (SELECT 1 FROM position_history_incomplete i, json_each(i.missing_json) j
                        WHERE i.account_id = t.account_id AND i.ctrader_position_id = t.ctrader_position_id
                          AND j.value IN (${marks}))
     GROUP BY t.ctrader_position_id
    HAVING detected_ms >= ? AND detected_ms <= ?
     ORDER BY detected_ms ASC
     LIMIT ?
  `).all(acct, ...STRUCTURAL_FIELDS, since, until, evalLimit)

  const out = { ran: true, candidates: rows.length, evaluated: 0, enqueued: 0, structural: 0, missing: {}, errors: 0 }
  for (const r of rows) {
    if (out.enqueued >= enqueueLimit) break
    out.evaluated++
    let missing
    try {
      missing = buildPositionRecord(db, { accountId: acct, positionId: r.pid }).missing
    } catch { out.errors++; continue }
    const structural = missing.filter(f => STRUCTURAL_FIELDS.includes(f))
    if (!structural.length) {
      const q = queueCloseCapture(db, { accountId: acct, positionId: r.pid, symbol: r.symbol, source: 'sweep', now, delayMs: out.enqueued * spacingMs })
      if (q.queued) out.enqueued++
      continue
    }
    try {
      capturePosition(db, { accountId: acct, positionId: r.pid })
    } catch { out.errors++; continue }
    out.structural++
    for (const f of structural) out.missing[f] = (out.missing[f] || 0) + 1
  }
  return out
}

/**
 * One account's pass: sweep, verify backlog, drain — with that account's own
 * credentials and only that account's rows.
 *
 * `creds` null (or a `noDrainReason`) means the account cannot be read this
 * pass: the sweep still runs (it is local), the drain does not, and the pass
 * says why.
 */
export async function captureAccountPass(db, {
  accountId, creds = null, verifier = null, now = Date.now(), env = process.env, log = null,
  drainLimit = DRAIN_PER_ACCOUNT, deadline = null, clock = Date.now, noDrainReason = null, deps = {},
} = {}) {
  const acct = String(accountId)
  const say = (m) => { try { log?.(m) } catch { /* logging never fails a pass */ } }
  const out = { accountId: acct, at: new Date(now).toISOString(), sweep: null, backlog: null, drain: null, skipped: null }

  try {
    out.sweep = sweepRecentCloses(db, { accountId: acct, now, days: backfillDays(env) })
  } catch (e) {
    out.sweep = { ran: false, error: e?.message || String(e) }
  }
  if (out.sweep?.enqueued || out.sweep?.structural) {
    say(`Position capture [${acct}]: sweep queued ${out.sweep.enqueued} close(s), recorded ${out.sweep.structural} as structurally incomplete` +
      (out.sweep.structural ? ` (${Object.entries(out.sweep.missing).map(([f, n]) => `${f} ×${n}`).join(', ')})` : ''))
  }

  if (!creds || noDrainReason) {
    out.skipped = noDrainReason || 'no_credentials'
    return out
  }

  // PR-AP, now per account: re-arm complete records that never got a
  // verdict — only when a verifier is configured, because without one a
  // re-capture costs a deal read and returns no answer.
  if (verifier) {
    try {
      const backlog = enqueueVerifyBacklog(db, { accountId: acct, now })
      out.backlog = { armed: backlog.armed, unverified: backlog.unverified, blockedByAttempts: backlog.blockedByAttempts, terminal: backlog.terminal }
      if (backlog.report) say(`Position capture [${acct}]: ${backlog.report}`)
    } catch (e) {
      out.backlog = { error: e?.message || String(e) }
    }
  }

  const getDeals = deps.getDeals ?? (async (t0, t1) => {
    const { wsGetDeals } = await import('../lib/ctrader-ws.js')
    return wsGetDeals(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, acct, t0, t1)
  })
  // B6, per account: the symbol id is THIS account's (resolveSymbolId), never
  // the primary's map — a volume-meta read under another instrument's id
  // would hand the verifier a wrong lot size and call the result a verdict.
  const lotSizeFor = deps.lotSizeFor ?? (async (symbol) => {
    const { resolveSymbolId } = await import('../lib/ctrader-creds.js')
    const r = await resolveSymbolId(db, { ...creds, accountId: acct }, symbol)
    if (r?.id == null) return null
    const { getVolumeMeta } = await import('../lib/lot-sizing.js')
    return getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, acct, r.id)
  })
  // The credentials travel with the call because cpp-verify holds no
  // defaults; `accountIds` is this host's roster, so one /connect authorizes
  // every account the pass will ask about (each /connect REPLACES the host's
  // session — verify-client.js).
  const verify = verifier
    ? (record) => verifier(record, {
        host: creds.host, clientId: creds.clientId, clientSecret: creds.clientSecret,
        accessToken: creds.accessToken, accountId: acct, accountIds: creds.accountIds || null,
      })
    : null

  out.drain = await drainCaptureQueue(db, {
    accountId: acct, getDeals, verify, lotSizeFor, now, env, limit: drainLimit,
    stopOnDealError: true, deadline, clock,
  })
  const d = out.drain
  if (d.due) {
    say(`Position capture [${acct}]: ${d.captured} captured · ${d.archived} archived · ${d.verified} verified · ${d.incomplete} still incomplete` +
      (d.gaveUp ? ` · ${d.gaveUp} GAVE UP` : '') +
      (d.stopped ? ` · stopped (${d.stopped})` : '') +
      (verifier ? '' : ' (verifier unconfigured — records stay unverified)'))
    for (const e of d.errors) say(`Position capture [${acct}] error: ${e}`)
  }
  return out
}

let passCounter = 0
let verifierCache = null
/** One verifier client per process, so its per-host sessions are reused. */
export function sharedVerifier(env = process.env) {
  const key = `${String(env?.VERIFY_URL || '').trim()}|${String(env?.EXEC_SECRET || '').trim() ? 1 : 0}`
  if (!verifierCache || verifierCache.key !== key) verifierCache = { key, fn: verifyClient({ env }) }
  return verifierCache.fn
}

/** Every account the pass must visit: registered, the primary, or with rows waiting. */
export function captureAccounts(db) {
  const ids = new Set()
  try {
    for (const r of db.prepare('SELECT account_id FROM accounts ORDER BY account_id').all()) {
      if (r.account_id != null) ids.add(String(r.account_id))
    }
  } catch { /* registry optional on old DBs */ }
  const primary = getState(db, 'ctrader_account_id')
  if (primary) ids.add(String(primary))
  try {
    for (const r of db.prepare(`SELECT DISTINCT account_id FROM position_capture_queue WHERE state = 'pending'`).all()) {
      ids.add(String(r.account_id))
    }
  } catch { /* no queue table */ }
  return [...ids]
}

/**
 * THE ALL-ACCOUNT PASS. Called once per reconcile cycle by loop.js, after the
 * selected, same-side and opposite-side reconciles.
 *
 * `credsFor(id)` returns the account's own credentials (production:
 * ctrader-creds.js credsForRegisteredAccount; the primary falls back to the
 * linked credentials). Accounts whose token the broker refused are not read.
 * The start account rotates each pass, so a time budget spent early never
 * starves the same account twice.
 *
 * Writes the pass record and beats `position_capture` with its verdict.
 */
export async function runAllAccountCapture(db, {
  log = null, env = process.env, now = Date.now(), clock = Date.now, budgetMs = CAPTURE_PASS_BUDGET_MS,
  verifier, credsFor = null, accounts = null, refused = null, deps = {}, beat = null,
} = {}) {
  const v = verifier === undefined ? sharedVerifier(env) : verifier
  const ids = accounts ?? captureAccounts(db)
  let refusedSet = refused
  if (!refusedSet) {
    try { refusedSet = (await import('../lib/token-refused.js')).tokenRefusedAccounts(db) } catch { refusedSet = new Set() }
  }
  const credsOf = credsFor ?? (async (id) => {
    const { credsForRegisteredAccount, getCtraderCreds } = await import('../lib/ctrader-creds.js')
    const c = credsForRegisteredAccount(db, id)
    if (c) return c
    return String(getState(db, 'ctrader_account_id') || '') === id ? getCtraderCreds(db) : null
  })
  const start = ids.length ? (passCounter++ % ids.length) : 0
  const order = [...ids.slice(start), ...ids.slice(0, start)]
  const deadline = clock() + budgetMs
  const results = []
  for (const id of order) {
    let creds = null
    let noDrainReason = null
    if (refusedSet.has(id)) noDrainReason = 'token_refused'
    else if (clock() > deadline) noDrainReason = 'pass_budget'
    else {
      try { creds = await credsOf(id) } catch { creds = null }
      if (!creds?.ready || String(creds.accountId) !== id) { creds = null; noDrainReason = 'no_credentials' }
    }
    if (creds && Array.isArray(creds.accountIds)) creds = { ...creds, accountIds: creds.accountIds.filter(a => !refusedSet.has(String(a))) }
    try {
      results.push(await captureAccountPass(db, {
        accountId: id, creds, verifier: v, now, env, log, deadline, clock, noDrainReason, deps: deps[id] || deps.all || {},
      }))
    } catch (e) {
      results.push({ accountId: id, at: new Date(now).toISOString(), error: e?.message || String(e) })
    }
  }
  const record = recordCapturePass(db, results, { now, env, verifierConfigured: !!v })
  try {
    const doBeat = beat ?? (await import('./heartbeat.js')).beat
    doBeat(db, 'position_capture', { ok: record.ok, error: record.error, detail: record.detail })
  } catch { /* the heartbeat is observability — never fatal */ }
  return record
}

export function readPassRecord(db) {
  try { return JSON.parse(getState(db, CAPTURE_PASS_KEY) || 'null') } catch { return null }
}

/**
 * Write the pass down, per account, merged over the previous record so an
 * account this pass could not reach keeps its last real timestamps — which
 * then AGE, so a pass that stops draining an account turns it stalled rather
 * than leaving a green stamp behind.
 */
export function recordCapturePass(db, results, { now = Date.now(), env = process.env, verifierConfigured = false } = {}) {
  const prev = readPassRecord(db)?.accounts || {}
  const at = new Date(now).toISOString()
  const accounts = { ...prev }
  for (const r of results) {
    const p = prev[r.accountId] || {}
    const d = r.drain
    const drained = !!d && !r.error
    const drainOk = drained && d.stopped !== 'deal_read_failed'
    let streak = Number(p.verifySkipStreak) || 0
    if (d?.answered > 0) streak = 0
    else if (d?.skipped > 0) streak += d.skipped
    accounts[r.accountId] = {
      at,
      skipped: r.skipped || null,
      error: r.error || null,
      sweep: r.sweep
        ? { ran: !!r.sweep.ran, candidates: r.sweep.candidates ?? 0, enqueued: r.sweep.enqueued ?? 0, structural: r.sweep.structural ?? 0, reason: r.sweep.reason ?? r.sweep.error ?? null }
        : (p.sweep ?? null),
      drain: d
        ? { due: d.due, captured: d.captured, verified: d.verified, answered: d.answered, skippedVerify: d.skipped, incomplete: d.incomplete, gaveUp: d.gaveUp, stopped: d.stopped, errors: d.errors.slice(0, 3) }
        : null,
      lastDrainAt: drained ? at : (p.lastDrainAt ?? null),
      lastDrainOkAt: drainOk ? at : (p.lastDrainOkAt ?? null),
      lastAnsweredAt: d?.answered > 0 ? at : (p.lastAnsweredAt ?? null),
      verifySkipStreak: streak,
    }
  }
  const coverage = captureCoverage(db, { now, env, passAccounts: accounts, verifierConfigured })
  const bad = [
    ...coverage.silent.map(a => `…${a.accountId.slice(-4)} silent (${a.uncaptured} close(s) with no capture record)`),
    ...coverage.stalled.map(a => `…${a.accountId.slice(-4)} stalled (${a.dueNow} due, no successful drain since ${a.lastDrainOkAt ?? 'never'})`),
    ...coverage.verifyFailing.map(a => `…${a.accountId.slice(-4)} verifier refused the last ${a.verifySkipStreak} ask(s)`),
  ]
  const record = {
    at,
    windowDays: coverage.windowDays,
    verifierConfigured,
    accounts,
    ok: bad.length === 0,
    error: bad.length ? bad.join('; ').slice(0, 500) : null,
    detail: {
      windowDays: coverage.windowDays,
      accounts: Object.fromEntries(coverage.accounts.map(a => [a.accountId, {
        status: a.status, closes: a.closes, captured: a.captured, pending: a.pending, gaveUp: a.gaveUp,
        structural: a.structural, uncaptured: a.uncaptured, verified: a.verified, disputed: a.disputed,
        unverified: a.unverified, lastVerdictAt: a.lastVerdictAt,
      }])),
    },
  }
  try {
    setState(db, CAPTURE_PASS_KEY, JSON.stringify({ at: record.at, windowDays: record.windowDays, verifierConfigured, accounts }))
  } catch { /* the record is best-effort; the heartbeat still carries the verdict */ }
  return record
}

/**
 * Per-account capture and verification coverage, judged at READ TIME.
 *
 * For each account: its closes in the window (a close is a distinct
 * account + broker position with a closed trade row), and where each one
 * stands — captured (a history record exists, with its verdict), pending,
 * gave up, refused as incomplete (structural or not), or UNCAPTURED: no
 * queue row, no history record, no refused record, older than the grace.
 *
 *   silent          any uncaptured close
 *   stalled         rows due for DRAIN_STALE_MS and no successful drain of
 *                   the account in that time
 *   verify_failing  the verifier left the account's last VERIFY_SKIP_STREAK
 *                   asks unanswered (only when a verifier is configured)
 *   ok / no_closes  otherwise — `no_closes` says there was nothing to
 *                   capture, which is not the same as captured
 */
export function captureCoverage(db, { now = Date.now(), env = process.env, passAccounts = null, verifierConfigured = false, days = null } = {}) {
  const windowDays = days ?? (backfillDays(env) || DEFAULT_BACKFILL_DAYS)
  const since = now - windowDays * 86_400_000
  const pass = passAccounts ?? (readPassRecord(db)?.accounts || {})
  const structural = new Set(STRUCTURAL_FIELDS)

  const closes = db.prepare(`
    SELECT c.acct AS acct, c.pid AS pid, c.detected_ms AS detected_ms,
           q.state AS qstate, h.verification_state AS vstate, i.missing_json AS missing_json
      FROM (SELECT t.account_id AS acct, t.ctrader_position_id AS pid, MAX(${DETECTED_MS_SQL}) AS detected_ms
              FROM trades t
             WHERE t.status = 'closed' AND t.ctrader_position_id IS NOT NULL AND t.account_id IS NOT NULL
             GROUP BY t.account_id, t.ctrader_position_id
            HAVING detected_ms >= ?) c
      LEFT JOIN position_capture_queue q ON q.account_id = c.acct AND q.position_id = c.pid
      LEFT JOIN position_history h ON h.account_id = c.acct AND h.ctrader_position_id = c.pid
      LEFT JOIN position_history_incomplete i ON i.account_id = c.acct AND i.ctrader_position_id = c.pid
     LIMIT 20000
  `).all(since)
  const due = db.prepare(`
    SELECT account_id AS acct, COUNT(*) AS n, MIN(due_at_ms) AS oldest
      FROM position_capture_queue WHERE state = 'pending' AND due_at_ms <= ? GROUP BY account_id
  `).all(now)
  const lastCaptured = db.prepare(`
    SELECT account_id AS acct, MAX(settled_at) AS at FROM position_capture_queue WHERE state = 'captured' GROUP BY account_id
  `).all()
  const lastVerdict = db.prepare(`
    SELECT account_id AS acct, MAX(verified_at) AS at FROM position_history WHERE verified_at IS NOT NULL GROUP BY account_id
  `).all()

  const ids = new Set([
    ...captureAccounts(db), ...Object.keys(pass),
    ...closes.map(r => String(r.acct)), ...due.map(r => String(r.acct)),
  ])
  const acc = new Map([...ids].map(id => [id, {
    accountId: id, status: 'no_closes',
    closes: 0, captured: 0, verified: 0, disputed: 0, unverified: 0, absent: 0,
    pending: 0, gaveUp: 0, incomplete: 0, structural: 0, uncaptured: 0, fresh: 0,
    dueNow: 0, oldestDueAt: null, lastCapturedAt: null, lastVerdictAt: null,
    lastPassAt: pass[id]?.at ?? null, lastDrainOkAt: pass[id]?.lastDrainOkAt ?? null,
    lastSkipped: pass[id]?.skipped ?? null, verifySkipStreak: Number(pass[id]?.verifySkipStreak) || 0,
    uncapturedSample: [],
  }]))

  for (const r of closes) {
    const a = acc.get(String(r.acct))
    a.closes++
    if (r.vstate) {
      a.captured++
      if (r.vstate === 'verified') a.verified++
      else if (r.vstate === 'disputed') a.disputed++
      else if (r.vstate === 'absent') a.absent++
      else a.unverified++
      continue
    }
    if (r.qstate === 'pending') { a.pending++; continue }
    if (r.qstate === 'gave_up') { a.gaveUp++; continue }
    if (r.missing_json != null) {
      a.incomplete++
      let missing = []
      try { missing = JSON.parse(r.missing_json) || [] } catch { missing = [] }
      if (missing.some(f => structural.has(f))) a.structural++
      continue
    }
    if (r.qstate) continue // captured once; its record since moved — not silent, not counted twice
    if (Number(r.detected_ms) <= now - UNCAPTURED_GRACE_MS) {
      a.uncaptured++
      if (a.uncapturedSample.length < 5) a.uncapturedSample.push(String(r.pid))
    } else {
      a.fresh++
    }
  }
  for (const r of due) {
    const a = acc.get(String(r.acct))
    a.dueNow = r.n
    a.oldestDueAt = new Date(Number(r.oldest)).toISOString()
  }
  for (const r of lastCaptured) { const a = acc.get(String(r.acct)); if (a) a.lastCapturedAt = r.at }
  for (const r of lastVerdict) { const a = acc.get(String(r.acct)); if (a) a.lastVerdictAt = r.at }

  const staleBefore = now - DRAIN_STALE_MS
  for (const a of acc.values()) {
    const drainOkMs = Date.parse(a.lastDrainOkAt || '')
    const oldestDueMs = Date.parse(a.oldestDueAt || '')
    if (a.uncaptured > 0) a.status = 'silent'
    else if (a.dueNow > 0 && oldestDueMs <= staleBefore && !(drainOkMs > staleBefore)) a.status = 'stalled'
    else if (verifierConfigured && a.verifySkipStreak >= VERIFY_SKIP_STREAK) a.status = 'verify_failing'
    else if (a.closes > 0 || a.dueNow > 0) a.status = 'ok'
  }
  const list = [...acc.values()].sort((x, y) => x.accountId.localeCompare(y.accountId))
  return {
    windowDays,
    since: new Date(since).toISOString(),
    accounts: list,
    silent: list.filter(a => a.status === 'silent'),
    stalled: list.filter(a => a.status === 'stalled'),
    verifyFailing: list.filter(a => a.status === 'verify_failing'),
  }
}
