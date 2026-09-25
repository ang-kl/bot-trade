import { REGIME_BLOCK_STAGE, EVIDENCE_GATE_STAGE, PRODUCER_RETIRED_STAGE } from './gate-skips.js'
import { ROSTER_ONLY_STAGES, ROSTER_STAGES, ATTRIBUTION_MARKED_STAGES, ACCOUNT_ATTRIBUTION_MARK } from './decision-log.js'
import { getState } from '../db.js'
import { engineStatusFor, basesFor } from './entry-mode.js'
import { tickReadinessFor } from './tick-readiness.js'
import { tickEntryReceipts, TICK_RECEIPT_MAX_AGE_MS } from './tick-entry-work.js'

const DAY = 86400_000
const parse = value => { try { return value?.length <= 16_000 ? JSON.parse(value) : null } catch { return null } }
const text = value => value == null ? null : String(value).slice(0, 500)
const clip = (value, n = 200) => value == null ? null : String(value).slice(0, n)
const UPSTREAM = ['account_horizon', 'account_probe', 'account_watchlist', 'armed_scope_prefilter',
  'cluster_conviction', 'equity_stop', 'fundable_universe', 'horizon', 'lesson_decay', 'margin_pool',
  'ratchet_gate', 'stage_matrix', 'style_filter', 'symbol_strategy',
  'watchlist_override', 'weekend_quiet', 'entry_mode', 'regime_gate', REGIME_BLOCK_STAGE, EVIDENCE_GATE_STAGE, PRODUCER_RETIRED_STAGE]

// V3 C4 (WP-C PR-C1): the sidecar's tick refusals, as its decision ring
// writes them (cpp-exec/src/tick_firer.cpp). `fire_refused` carries the check
// that stopped the fire in `code` (recorder_not_recording, no_permit,
// price_bound, stop_below_floor, unaffordable_lot, sizing, queue_full, and
// fire_stale — a CODE under fire_refused, not a ring kind of its own);
// `fire_reject` carries the broker's errorCode; `fire_abandoned` is a queued
// fire dropped at shutdown. `signal`, `fire` and `fire_result` are not
// refusals and never enter the population.
export const TICK_REFUSAL_RING_KINDS = Object.freeze(['fire_refused', 'fire_reject', 'fire_abandoned'])
const TICK_KINDS_SQL = TICK_REFUSAL_RING_KINDS.map(k => `'${k}'`).join(',')
export const ENTRY_STOP_KINDS = Object.freeze(['upstream_stop', 'risk_refusal', 'post_approval_failure', 'tick_refusal'])
const SUMMARY_KINDS = ['upstream_stop', 'risk_refusal', 'post_approval_failure', 'tick_refusal', 'approved', 'placement_receipt', 'other_stop']
// The four checks that are EVIDENCE (a profile and its replay/shadow proof),
// kept apart from blockedReasons, which lists every failing readiness check:
// an account blocked only on, say, recorder_status_fresh must not read as
// "the evidence checks pass, so it is nearly ready".
export const TICK_EVIDENCE_CHECKS = Object.freeze(['profile_pinned', 'profile_matches_sidecar', 'replay_evidence', 'validation_stage'])
export const ENTRY_DIAGNOSTICS_MAX_BYTES = 32 * 1024
const MAX_ACCOUNTS = 64

// [node_permit, sidecar_checks, broker] per recorded code. The permit is
// SPENT before the firer's own checks (tick_firer.cpp: permits_.take() runs
// ahead of the price bound, the stop floor and sizing), so a check refusal
// consumed it; only the recorder gate runs before the take.
const TICK_BOUNDARY = {
  recorder_not_recording: ['not_evaluated', 'stopped', 'not_evaluated'],
  no_permit: ['absent', 'not_evaluated', 'not_evaluated'],
  price_bound: ['spent', 'stopped', 'not_evaluated'],
  stop_below_floor: ['spent', 'stopped', 'not_evaluated'],
  unaffordable_lot: ['spent', 'stopped', 'not_evaluated'],
  sizing: ['spent', 'stopped', 'not_evaluated'],
  queue_full: ['spent', 'stopped', 'not_evaluated'],
  fire_stale: ['spent', 'passed', 'not_evaluated', 'dispatch stopped: the queued fire was older than maxFireDelayMs'],
}
function tickDiagnostics(ringKind, code) {
  const [permit, checks, broker, note] = ringKind === 'fire_reject' ? ['spent', 'passed', 'rejected']
    : ringKind === 'fire_abandoned' ? ['spent', 'passed', 'not_evaluated', 'abandoned at the firer\'s stop']
      : TICK_BOUNDARY[code] || ['not_recorded', 'stopped', 'not_evaluated']
  return [
    { stage: 'node_permit', status: permit },
    { stage: 'sidecar_checks', status: checks, ...(note ? { note } : {}) },
    { stage: 'broker', status: broker },
  ]
}

// These are evidence boundaries, not a reconstructed execution trace. A
// short-circuited decision cannot establish that any later check passed.
export function blockerEvidence(row) {
  const checks = parse(row.checks_json)
  const details = parse(row.detail_json)
  const reason = text(row.reason)
  const post = row.kind === 'post_approval_failure'
  const approved = row.kind === 'approved'
  const receipt = row.kind === 'placement_receipt'
  const upstream = row.kind === 'upstream_stop'
  const risk = row.kind === 'risk_refusal'
  const tick = row.kind === 'tick_refusal'
  return {
    recordId: `${row.source}:${row.id}`, source: row.source, id: row.id,
    // V3 WEB-1: accountId is the account the stop is CHARGED to (null for a
    // roster-wide or unattributed record); storedAccountId is what the row
    // holds, kept as evidence where an older build stamped a roster stop.
    accountId: row.account_id, attribution: row.scope || (row.account_id == null ? 'unattributed' : 'account'),
    storedAccountId: row.stored_account_id === undefined ? row.account_id : row.stored_account_id,
    unsplitHistory: row.unsplit === 1,
    symbol: row.symbol, strategy: row.strategy,
    timeframe: row.timeframe, at: row.created_at, lastAt: row.last_at || row.created_at,
    kind: row.kind, stage: row.stage, reason,
    firstBlocker: approved || receipt ? null : { stage: row.stage, reason, status: reason ? 'recorded' : 'reason_unrecorded' },
    disposition: row.disposition || (receipt ? 'placed' : null), recordedEvaluations: row.reps,
    opportunityKey: row.opportunity_key || null,
    // A tick fire is admitted by Node's standing permit, never by the bar
    // risk gate: its boundaries are the permit, the sidecar's own checks and
    // the broker. No risk_gate entry, so nothing reads as an approval.
    diagnostics: tick ? tickDiagnostics(details?.ringKind, details?.code) : [
      { stage: 'upstream', status: upstream ? 'stopped' : 'not_recorded' },
      { stage: 'risk_gate', status: upstream ? 'not_evaluated' : post || approved ? 'approved' : risk ? 'stopped' : 'not_recorded' },
      { stage: 'submission', status: receipt ? 'placed' : post ? 'stopped' : upstream || risk ? 'not_evaluated' : 'not_recorded' },
    ],
    recordedChecks: checks && typeof checks === 'object' && !Array.isArray(checks) ? checks : null,
    recordedChecksStatus: row.checks_json?.length > 16_000 ? 'size_limit' : checks ? 'recorded' : 'unavailable',
    detail: details && typeof details === 'object' ? details : null,
    diagnosticNote: tick
      ? 'A copy of the sidecar\'s decision-ring record, dated when Node pulled it (tsMs in the detail is the sidecar\'s own clock). A tick fire is admitted by Node\'s standing permit, not by the bar risk gate; no risk-gate evaluation is implied. The permit is spent before the sidecar\'s own checks.'
      : 'Only recorded outcomes are shown. Missing checks are unrecorded; later checks after a stop are not evaluated. Approval is not proof of an order or fill. A placement receipt is not a second risk approval or proof of a fill.',
  }
}

/**
 * The request checks, pure (no SQL), so the route can answer 400 on the main
 * thread before handing the read to the report worker. Whether the account
 * is REGISTERED is a SQL read and stays inside blockerReport (the worker).
 */
export function validateBlockerRequest({ accountId, from, to = Date.now(), limit = 50, offset = 0, now = Date.now() } = {}) {
  if (accountId !== 'all' && !/^[1-9]\d*$/.test(String(accountId))) throw new RangeError('explicit account or all required')
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to || to - from > 90 * DAY
    || to > now + 60_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200
    || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new RangeError('invalid reporting window or page')
  return { accountId: String(accountId), from, to, limit, offset }
}

// Placement writers also use approved=1. Their boolean *_placed checks
// record submission receipts, not a second risk-gate evaluation. Parse JSON
// structurally so whitespace is immaterial and string/false values do not count.
const RECEIPT = `approved = 1 AND EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(checks_json) THEN checks_json ELSE '{}' END)
    WHERE key GLOB '*_placed' AND type = 'true'
  )`
// V3 WEB-1 (8,989-A row 2): WHOSE STOP A decision_log ROW IS. Until this fix
// recordDecision stamped every row that named no account with the SELECTED
// account, so the roster-level gates charged all their stops to one account
// (9,970 of 9,970 upstream stops on 46130058 over 24 h, 25-09) and every
// other account read "0 upstream stops". Per row:
//   roster       — an account-independent gate (decision-log.js
//                  ROSTER_ONLY_STAGES, including the older rows the fallback
//                  stamped with an account; or a stage_matrix row with no
//                  account, the roster union's). It applies to every account
//                  and is charged to none: its effective account_id is NULL
//                  and stored_account_id keeps what was written.
//   unattributed — no account and not a roster gate.
//   account      — the stored account. `unsplit` flags an older row of a
//                  stage whose fallback row and real per-account row are
//                  identical (ATTRIBUTION_MARKED_STAGES without the mark):
//                  counted as recorded, and said so, never silently moved.
const sqlList = list => list.map(s => `'${s}'`).join(',')
const ROSTER_ONLY_SQL = sqlList(ROSTER_ONLY_STAGES)
const ROSTER_FILTER = `AND (stage IN (${ROSTER_ONLY_SQL}) OR (account_id IS NULL AND stage IN (${sqlList(ROSTER_STAGES)})))`
const DECISION_SCOPE = `CASE WHEN stage IN (${ROSTER_ONLY_SQL}) OR (account_id IS NULL AND stage IN (${sqlList(ROSTER_STAGES)})) THEN 'roster'
      WHEN account_id IS NULL THEN 'unattributed' ELSE 'account' END`
const DECISION_UNSPLIT = `CASE WHEN account_id IS NOT NULL AND stage IN (${sqlList(ATTRIBUTION_MARKED_STAGES)})
      AND (CASE WHEN json_valid(detail_json) THEN json_extract(detail_json, '$.attribution') END) IS NOT '${ACCOUNT_ATTRIBUTION_MARK}' THEN 1 ELSE 0 END`
export const ROSTER_WIDE_NOTE = 'Roster-wide stops come from account-independent gates (the armed-scope pre-filter, the stage-matrix union, the horizon, style, watchlist, regime and weekend gates). They apply to every account and are charged to none; records an older build stored against the then-selected account are counted here, not under that account.'
export const UNSPLIT_NOTE = 'Records written before the attribution fix in stage_matrix (the roster union and the account\'s own gate wrote identical rows) and lesson_decay (stamped with the selected account, not the order\'s) cannot be split: they are counted as recorded, under the account they were stored against.'

// The decision_log arm: the same nineteen columns as population()'s other arms
// (named, because rosterWideStops reads it on its own).
function decisionArm(filter) {
  return `SELECT 'decision_log' source, id, CASE WHEN scope = 'roster' THEN NULL ELSE account_id END account_id,
      account_id stored_account_id, scope, unsplit, symbol, created_at, created_at last_at,
      CASE WHEN stage = 'gate_redirect' THEN 'risk_refusal'
           WHEN stage IN ('submission_dedupe', 'symbol_position_cap') THEN 'post_approval_failure'
           WHEN stage IN (${UPSTREAM.map(s => `'${s}'`).join(',')}) OR stage GLOB 'account_pregate:*' THEN 'upstream_stop'
           ELSE 'other_stop' END kind,
      stage, reason, NULL checks_json, detail_json, NULL disposition, NULL opportunity_key, 1 reps, strategy, timeframe
    FROM (SELECT *, ${DECISION_SCOPE} scope, ${DECISION_UNSPLIT} unsplit FROM decision_log
      WHERE created_at >= @floor AND julianday(created_at) >= julianday(@from)
        AND julianday(created_at) < julianday(@to) AND decision IN ('skip', 'veto') ${filter})`
}

// One population for every count, page and ranking. Each arm lists the same
// nineteen columns IN ORDER — a positional UNION with a missing or misordered
// column does not fail, it puts values in the wrong fields:
//   source, id, account_id, stored_account_id, scope, unsplit, symbol,
//   created_at, last_at, kind, stage, reason, checks_json, detail_json,
//   disposition, opportunity_key, reps, strategy, timeframe
// cpp_decisions.at is datetime('now') text ('YYYY-MM-DD HH:MM:SS', db.js), the
// same shape as @floor, so the string prefilter holds; the julianday bounds
// are the actual window. An account scope takes that account's rows only:
// roster rows (NULL, or relabelled history) are reported beside it.
function population(accountScoped) {
  const scope = accountScoped ? 'AND account_id = @account' : ''
  return `WITH records AS (
    SELECT 'risk_events' source, id, account_id, account_id stored_account_id,
      CASE WHEN account_id IS NULL THEN 'unattributed' ELSE 'account' END scope, 0 unsplit, symbol, created_at, last_at,
      CASE WHEN ${RECEIPT} THEN 'placement_receipt'
           WHEN symbol = 'PORTFOLIO' AND approved IS NOT 1 THEN 'upstream_stop'
           WHEN approved = 1 THEN 'approved'
           WHEN json_valid(checks_json) AND json_extract(checks_json, '$.post_approval') = 1 THEN 'post_approval_failure'
           ELSE 'risk_refusal' END kind,
      CASE WHEN ${RECEIPT} THEN 'submission_receipt'
           WHEN symbol = 'PORTFOLIO' AND approved IS NOT 1 THEN 'margin_pool'
           WHEN approved = 1 THEN 'risk_gate'
           WHEN json_valid(checks_json) AND json_extract(checks_json, '$.post_approval') = 1 THEN 'post_approval'
           ELSE 'risk_gate' END stage,
      veto_reason reason, checks_json, NULL detail_json, disposition, opportunity_key,
      CASE WHEN approved = 1 THEN 1 ELSE MAX(1, COALESCE(repeat_count, 1)) END reps,
      CASE WHEN json_valid(proposal_json) THEN json_extract(proposal_json, '$.strategy') END strategy,
      CASE WHEN json_valid(proposal_json) THEN json_extract(proposal_json, '$.timeframe') END timeframe
    FROM risk_events WHERE created_at >= @floor AND julianday(created_at) >= julianday(@from)
      AND julianday(created_at) < julianday(@to) ${scope}
    UNION ALL
    ${decisionArm(accountScoped ? `${scope} AND stage NOT IN (${ROSTER_ONLY_SQL})` : '')}
    UNION ALL
    SELECT 'cpp_decisions', cpp_decisions.id, cpp_decisions.account_id, cpp_decisions.account_id,
      CASE WHEN cpp_decisions.account_id IS NULL THEN 'unattributed' ELSE 'account' END, 0,
      CASE WHEN cpp_decisions.symbol_id IS NULL THEN NULL ELSE 'symbolId ' || cpp_decisions.symbol_id END,
      cpp_decisions.at, cpp_decisions.at, 'tick_refusal',
      CASE cpp_decisions.kind WHEN 'fire_refused' THEN 'tick_fire:' || COALESCE(NULLIF(cpp_decisions.code, ''), 'unrecorded')
                              WHEN 'fire_reject' THEN 'tick_broker_reject'
                              ELSE 'tick_fire_abandoned' END,
      COALESCE(NULLIF(cpp_decisions.code, ''), 'unrecorded') || COALESCE(' — ' || cpp_decisions.detail, ''),
      NULL,
      json_object('side', cpp_decisions.side, 'bootId', cpp_decisions.boot_id, 'seq', cpp_decisions.seq,
        'tsMs', cpp_decisions.ts_ms, 'ringKind', cpp_decisions.kind, 'code', cpp_decisions.code, 'symbolId', cpp_decisions.symbol_id),
      NULL, NULL, 1, NULL, 'tick'
    FROM cpp_decisions WHERE cpp_decisions.component = 'tick' AND cpp_decisions.kind IN (${TICK_KINDS_SQL})
      AND cpp_decisions.at >= @floor AND julianday(cpp_decisions.at) >= julianday(@from)
      AND julianday(cpp_decisions.at) < julianday(@to) ${scope}
  )`
}
const windowParams = (accountId, from, to) => {
  const bounds = [new Date(from).toISOString(), new Date(to).toISOString()]
  return { from: bounds[0], to: bounds[1], account: String(accountId), floor: bounds[0].replace('T', ' ').slice(0, 19) }
}
const julianToIso = jd => Number.isFinite(jd) ? new Date(Math.round((jd - 2440587.5) * DAY)).toISOString() : null

export function blockerReport(db, options = {}) {
  const { accountId, from, to, limit, offset } = validateBlockerRequest(options)
  const now = options.now ?? Date.now()
  if (accountId !== 'all' && !db.prepare('SELECT 1 FROM accounts WHERE account_id = ?').get(accountId)) throw new RangeError('account not registered')
  const all = accountId === 'all'
  const params = windowParams(accountId, from, to)
  // Read retained rows in one unit. No LIMIT is applied to the population or
  // totals. Only details are paged. ISO and SQLite timestamps share UTC.
  const records = population(!all)
  const groups = db.prepare(`${records} SELECT kind, COUNT(*) records, SUM(reps) recordedEvaluations FROM records GROUP BY kind`).all(params)
  const summary = Object.fromEntries(SUMMARY_KINDS.map(kind => {
    const g = groups.find(g => g.kind === kind)
    return [kind, { records: g?.records || 0, recordedEvaluations: g?.recordedEvaluations || 0 }]
  }))
  const totalRecords = groups.reduce((n, g) => n + g.records, 0)
  const rows = db.prepare(`${records} SELECT * FROM records ORDER BY julianday(created_at) DESC, source, id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset })
  // accountId is the EFFECTIVE account: NULL for roster-wide and unattributed
  // rows, which `scope` tells apart. unsplitRecords: see UNSPLIT_NOTE.
  const counts = db.prepare(`${records} SELECT account_id accountId, scope, kind, COUNT(*) records, SUM(unsplit) unsplitRecords
    FROM records GROUP BY account_id, scope, kind ORDER BY account_id, scope, kind`).all(params)
  const entryKinds = ENTRY_STOP_KINDS.map(k => `'${k}'`).join(',')
  const stop = db.prepare(`${records} SELECT * FROM records WHERE kind IN (${entryKinds}) ORDER BY julianday(created_at) DESC, source, id DESC LIMIT 1`).get(params)
  // The dominant entry stops per account: up to five (kind, stage) groups,
  // most records first. lastReason is the bare column of the row holding the
  // group's single MAX() — SQLite's documented bare-column rule — so it is the
  // NEWEST record's reason. Approvals, receipts and other stops are not stops
  // of an entry and are not ranked. Roster-wide and unattributed rows (both
  // account NULL) rank in their own partitions, never under an account.
  const byStage = db.prepare(`${records}, grouped AS (
      SELECT account_id, scope, kind, stage, COUNT(*) records, SUM(reps) recordedEvaluations, SUM(unsplit) unsplitRecords,
        MAX(julianday(created_at)) lastJd, reason lastReason
      FROM records WHERE kind IN (${entryKinds}) GROUP BY account_id, scope, kind, stage
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY account_id, scope ORDER BY records DESC, stage, kind) rn FROM grouped
    ) SELECT * FROM ranked WHERE rn <= 5 ORDER BY account_id, scope, rn`).all(params)
    .map(r => ({ accountId: r.account_id, scope: r.scope, kind: r.kind, stage: r.stage, records: r.records, recordedEvaluations: r.recordedEvaluations,
      unsplitRecords: r.unsplitRecords, lastAt: julianToIso(r.lastJd), lastReason: clip(r.lastReason) }))
  // Unattributed: no account AND not a roster gate — a roster stop is
  // attributed (to the roster), not unassigned.
  const unattributed = db.prepare(`SELECT
    (SELECT COUNT(*) FROM risk_events WHERE account_id IS NULL AND created_at >= @floor AND julianday(created_at) >= julianday(@from) AND julianday(created_at) < julianday(@to)) +
    (SELECT COUNT(*) FROM decision_log WHERE account_id IS NULL AND stage NOT IN (${sqlList(ROSTER_STAGES)}) AND created_at >= @floor AND julianday(created_at) >= julianday(@from) AND julianday(created_at) < julianday(@to) AND decision IN ('skip','veto')) +
    (SELECT COUNT(*) FROM cpp_decisions WHERE account_id IS NULL AND component = 'tick' AND kind IN (${TICK_KINDS_SQL}) AND at >= @floor AND julianday(at) >= julianday(@from) AND julianday(at) < julianday(@to)) n`).get(params).n
  return {
    status: 'complete', accountId, from, to, generatedAt: new Date(now).toISOString(),
    summary, totalRecords, perAccount: counts, byStage, unattributedRecordsInWindow: unattributed,
    rosterWide: rosterWideStops(db, params, all),
    unsplitRecordsInWindow: counts.reduce((n, c) => n + (c.unsplitRecords || 0), 0), unsplitNote: UNSPLIT_NOTE,
    latestEntryStop: stop ? blockerEvidence(stop) : null,
    records: rows.map(blockerEvidence), offset, limit, hasMore: offset + rows.length < totalRecords,
    nextOffset: offset + rows.length < totalRecords ? offset + rows.length : null,
    countBasis: 'Complete retained records first created in the requested window. The same event may appear in both logs. Repeated risk refusals share a record; recordedEvaluations covers that record’s lifetime, not exact attempts within the window. Records are not distinct opportunities or orders. Placement receipts are retained separately from risk approvals. Other stops include management records whose entry phase is unrecorded. Tick sidecar refusals are the ring records Node pulled (the sidecar keeps only its newest ~256; any overwritten between pulls are not counted) and are dated at the pull.',
    scopeNote: all
      ? 'Every retained record is included. Roster-wide stops are grouped as roster-wide (account NULL), never under an account; records with no account that are not roster-wide stay explicitly unattributed and are counted separately.'
      : 'Only records stored against this registered account are counted here. Roster-wide stops apply to every account and are reported beside these counts, not in them; unassigned records are excluded and counted separately.',
  }
}

/**
 * V3 WEB-1: the roster-wide stops in the window — the same records under
 * EVERY account scope, charged to none. `includedInTotals` says whether the
 * report's own summary already counts them (the all-accounts scope) or not
 * (an account scope). `recordedAgainstAnAccount` counts the older rows the
 * selected-account fallback stamped with an account: shown, never hidden.
 * Bounded: one group per (kind, stage) of the roster stage set.
 */
function rosterWideStops(db, params, includedInTotals) {
  const records = `WITH records AS (${decisionArm(ROSTER_FILTER)})`
  const stages = db.prepare(`${records} SELECT kind, stage, COUNT(*) records,
      SUM(CASE WHEN stored_account_id IS NULL THEN 0 ELSE 1 END) recordedAgainstAnAccount,
      MAX(julianday(created_at)) lastJd, reason lastReason
    FROM records GROUP BY kind, stage ORDER BY records DESC, stage, kind`).all(params)
  const sum = (list, key = 'records') => list.reduce((n, s) => n + s[key], 0)
  return {
    records: sum(stages),
    entryStops: sum(stages.filter(s => ENTRY_STOP_KINDS.includes(s.kind))),
    summary: Object.fromEntries(SUMMARY_KINDS.map(kind => [kind, { records: sum(stages.filter(s => s.kind === kind)) }])),
    byStage: stages.map(s => ({ kind: s.kind, stage: s.stage, records: s.records, recordedAgainstAnAccount: s.recordedAgainstAnAccount,
      lastAt: julianToIso(s.lastJd), lastReason: clip(s.lastReason) })),
    recordedAgainstAnAccount: sum(stages, 'recordedAgainstAnAccount'),
    includedInTotals, note: ROSTER_WIDE_NOTE,
  }
}

const readJson = (db, key) => { try { return JSON.parse(getState(db, key) || 'null') } catch { return null } }
const FIRER_COUNTERS = ['accounts', 'permitsHeld', 'queueDepth', 'fills', 'queued', 'sent', 'rejected', 'refusedNoPermit', 'refusedUnaffordable',
  'refusedPriceBound', 'refusedRecorder', 'refusedQueueFull', 'refusedSizing', 'refusedStopFloor', 'refusedStale', 'abandoned']

/**
 * V3 C4 (WP-C PR-C1, owner order 8,991): were tick entries evaluated at all?
 * Today no account admits tick, so there are no tick refusals — and "zero
 * refusals" must never read as a pass. Per registry account: `evaluated`
 * only when a FRESH permit-feed receipt that was PUSHED to the sidecar lists
 * it (the sidecar checks nothing for an account it was never sent,
 * tick_firer.cpp returns before any per-account check when its list is
 * empty); `admitted_not_pushed` when the account admits tick but no such
 * receipt exists; otherwise `not_evaluated` with the reason. Read-only.
 */
export function tickEntryEvaluation(db, { accountId = 'all', from, to = Date.now(), now = Date.now(), includeSides = true } = {}) {
  const all = accountId === 'all'
  const registry = all
    ? db.prepare('SELECT account_id, enabled FROM accounts ORDER BY account_id LIMIT ?').all(MAX_ACCOUNTS + 1)
    : db.prepare('SELECT account_id, enabled FROM accounts WHERE account_id = ?').all(String(accountId))
  const windowFrom = Number.isSafeInteger(from) ? from : now - DAY, windowTo = Number.isSafeInteger(to) ? to : now
  const params = windowParams(accountId, windowFrom, windowTo)
  const byAccount = new Map()
  for (const r of db.prepare(`SELECT account_id, code, COUNT(*) n FROM cpp_decisions WHERE component = 'tick' AND kind IN (${TICK_KINDS_SQL})
      AND at >= @floor AND julianday(at) >= julianday(@from) AND julianday(at) < julianday(@to) ${all ? '' : 'AND account_id = @account'}
      GROUP BY account_id, code ORDER BY account_id, n DESC, code`).all(params)) {
    const id = String(r.account_id)
    if (!byAccount.has(id)) byAccount.set(id, {})
    const codes = byAccount.get(id)
    if (Object.keys(codes).length < 16) codes[clip(r.code || 'unrecorded', 64)] = r.n
  }
  const receipts = tickEntryReceipts(db, now)
  const accounts = registry.slice(0, MAX_ACCOUNTS).map(row => {
    const id = String(row.account_id), st = engineStatusFor(db, id), bases = basesFor(st)
    let status = 'not_evaluated', because = null, stoppedAt = null, stoppedReason = null, permitFeed = null
    if (Number(row.enabled) !== 1) because = 'account_disabled'
    else if (st.effectiveEntryMode === 'STOPPED') because = 'entry_mode_stopped'
    else if (st.transitionState !== 'STABLE') because = `transition:${st.transitionState}`
    else if (!bases.includes('tick')) because = 'basis_not_admitted'
    else {
      const receipt = receipts.find(r => r.accounts.some(a => String(a?.accountId) === id))
      const entry = receipt?.accounts.find(a => String(a?.accountId) === id)
      if (receipt) {
        permitFeed = { side: receipt.side, at: new Date(receipt.completedAt).toISOString(), pushed: receipt.pushed === true, complete: receipt.complete === true,
          error: receipt.error ?? null, permits: entry?.permits ?? 0, paused: entry?.paused ?? null, firstRefusal: entry?.firstRefusal ?? null,
          refused: Array.isArray(entry?.refused) ? entry.refused : [], refusedCount: entry?.refusedCount ?? 0, budget: entry?.budget ?? null }
      }
      if (receipt?.pushed === true && entry?.reached !== false) {
        status = 'evaluated'
        if (entry?.paused) { stoppedAt = 'node_permit_feed'; stoppedReason = entry.paused }
      } else {
        status = 'admitted_not_pushed'
        because = receipt ? (receipt.error || receipt.reason || 'push_not_confirmed') : 'no_fresh_feed_receipt'
      }
    }
    let readiness
    try {
      const rd = tickReadinessFor(db, id, { now: new Date(now) })
      const checks = Object.fromEntries(TICK_EVIDENCE_CHECKS.map(name => {
        const c = rd.readiness.find(x => x.check === name)
        return [name, c ? { ok: c.ok === true, observed: clip(c.observed) } : { ok: false, observed: 'check_absent' }]
      }))
      readiness = { ready: rd.ready === true, checks, blockedReasons: (rd.blockedReasons || []).slice(0, 24) }
    } catch (err) {
      readiness = { ready: false, checks: null, blockedReasons: [], unavailable: clip(err?.message || String(err)) }
    }
    return {
      // The engine record's own side stamp (entry-mode.js environmentOf): a
      // display label, never a gate (owner principle 1).
      accountId: id, environment: st.environment ?? null, enabled: Number(row.enabled) === 1,
      entryMode: { requested: st.requestedEntryMode ?? null, effective: st.effectiveEntryMode ?? null, transitionState: st.transitionState ?? null, policy: st.entryModePolicy ?? null },
      admittedBases: Array.isArray(st.admittedBases) ? st.admittedBases : null, bases,
      status, because, stoppedAt, stoppedReason, readiness,
      sidecarRefusals: byAccount.get(id) || {},
      permitFeed,
    }
  })
  let sides = null
  if (includeSides) {
    const signals = db.prepare(`SELECT side,
        CASE WHEN detail = 'shadow_cost' OR substr(detail, 1, 12) = 'shadow_cost ' THEN 'shadow_cost'
             WHEN detail = 'shadow_busy' OR substr(detail, 1, 12) = 'shadow_busy ' THEN 'shadow_busy'
             WHEN detail = 'shadow' OR substr(detail, 1, 7) = 'shadow ' THEN 'shadow'
             ELSE 'other' END outcome, COUNT(*) n
      FROM cpp_decisions WHERE component = 'tick' AND kind = 'signal'
        AND at >= @floor AND julianday(at) >= julianday(@from) AND julianday(at) < julianday(@to)
      GROUP BY side, outcome`).all(params)
    sides = ['cpp_exec', 'cpp_exec_demo'].map(side => {
      const rec = readJson(db, `${side}_tick_json`), entry = rec?.status?.entry
      const counters = entry && typeof entry === 'object'
        ? Object.fromEntries(FIRER_COUNTERS.map(k => [k, Number.isFinite(Number(entry[k])) ? Number(entry[k]) : null])) : null
      return {
        side, signalsInWindow: Object.fromEntries(['shadow', 'shadow_cost', 'shadow_busy', 'other'].map(k => [k, signals.find(s => s.side === side && s.outcome === k)?.n || 0])),
        entry: counters, statusAt: rec?.at ?? null, sinceBoot: true,
      }
    })
  }
  return {
    schemaVersion: 1, windowFrom, windowTo, receiptMaxAgeMs: TICK_RECEIPT_MAX_AGE_MS,
    accounts, accountsTruncated: registry.length > MAX_ACCOUNTS, sides,
    evaluationNote: 'Zero sidecar refusals on an account that is not_evaluated or admitted_not_pushed is not a pass: the sidecar never checked a tick entry for it. "evaluated" means a permit-feed pass pushed to the sidecar within the last six minutes with this account listed. Side counters are the sidecar\'s own, since its last boot.',
  }
}

/**
 * V3 C4 (WP-C PR-C1): the bounded per-account entry block the Node watchdog
 * contract carries for cpp-verify to relay (PR-6). Node's own records, never
 * broker-verified. A 24 h window. Over ENTRY_DIAGNOSTICS_MAX_BYTES it
 * returns an explicit incomplete block, never a silently cut one.
 */
export function entryDiagnostics(db, { now = Date.now() } = {}) {
  const from = now - DAY, to = now + 1
  const report = blockerReport(db, { accountId: 'all', from, to, now, limit: 1 })
  const tick = tickEntryEvaluation(db, { accountId: 'all', from, to, now, includeSides: false })
  const stops = new Map(), dominant = new Map()
  for (const r of report.perAccount) if (ENTRY_STOP_KINDS.includes(r.kind)) stops.set(String(r.accountId), (stops.get(String(r.accountId)) || 0) + r.records)
  for (const r of report.byStage) if (!dominant.has(String(r.accountId))) dominant.set(String(r.accountId), r)
  // V3 WEB-1: roster-wide stops are in no account's entryStopsInWindow; they
  // ride beside the accounts once, labelled, so a zero on an account is that
  // account's zero and not a roster stop gone missing.
  const rosterTop = report.rosterWide.byStage.find(s => ENTRY_STOP_KINDS.includes(s.kind))
  const head = { schemaVersion: 1, source: 'node_records', observedAtMs: now, windowFromMs: from, windowToMs: to,
    rosterWide: { entryStopsInWindow: report.rosterWide.entryStops,
      dominantStop: rosterTop ? { stage: rosterTop.stage, kind: rosterTop.kind, records: rosterTop.records, lastAt: rosterTop.lastAt, lastReason: rosterTop.lastReason } : null } }
  // A readiness read that failed for an account is not a complete block.
  const out = { ...head, complete: !tick.accountsTruncated && !tick.accounts.some(a => a.readiness.unavailable), accounts: tick.accounts.map(a => {
    const d = dominant.get(a.accountId)
    return {
      accountId: a.accountId, environment: a.environment, entryMode: a.entryMode, admittedBases: a.admittedBases, bases: a.bases,
      tick: { status: a.status, because: a.because, stoppedAt: a.stoppedAt, stoppedReason: a.stoppedReason,
        ready: a.readiness.ready, checks: a.readiness.checks, blockedReasons: a.readiness.blockedReasons,
        ...(a.readiness.unavailable ? { readinessUnavailable: a.readiness.unavailable } : {}) },
      dominantRefusal: d ? { stage: d.stage, kind: d.kind, records: d.records, lastAt: d.lastAt, lastReason: d.lastReason } : null,
      entryStopsInWindow: stops.get(a.accountId) || 0,
    }
  }) }
  if (Buffer.byteLength(JSON.stringify(out)) > ENTRY_DIAGNOSTICS_MAX_BYTES) return { ...head, complete: false, reason: 'entry_diagnostics_size_bound', accounts: [] }
  return out
}
