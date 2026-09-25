// ---------------------------------------------------------------------------
// agent/services/protection-latency.js — how long a protection amend takes, on
// every Node amend path, and how late the fast monitor was to decide it
// (V3 M5, P1/P4-6). Measurement only: nothing here decides, gates, retries or
// changes what an amend sends.
//
// WHY. "Broker-confirmed protection latency p95/p99" is a V3 acceptance
// criterion (v3-merge-release:80, v3-acceptance-sequence:87-90) and has been
// Not Verifiable: position_events stores only `at` (db.js), so no amend's round
// trip was ever recorded. The first plan wrapped five entry points; the review
// found the population biased — position-protect (the manual route and the
// Telegram button), target-restore, tp-suggest and restrategize also amend —
// and that the round trip alone misses the dominant term for Node-managed
// exits: the fast monitor's lateness from DUE to EVALUATED, 12–43 s in the
// #1085/#1086 windows against a round trip the gateway bounds at 15 s.
//
// WHAT IS RECORDED, per amend (one bounded ring for the process, seeded from
// the stored copy so natural amends accumulate across restarts):
//   · path      — which Node amend path sent it (AMEND_PATHS, a closed list);
//   · source    — the writer that asked (fast_monitor, position_manager,
//                 manual, telegram, loss_guardian, …);
//   · account   — the account SUFFIX only (…1234), never the id's other digits;
//   · sentAtMs / ackAtMs / ms — wall-clock send and answer, and the round trip
//                 on the monotonic clock (performance.now), so a wall-clock
//                 step cannot distort it. For the gateway's /amend the answer
//                 is the broker's execution event (engine.cpp /amend waits for
//                 it, 15 s); for the WS path, wsAmendPosition's response;
//   · outcome   — ok · refused · already_closed · empty · timeout · error,
//                 with an upper-case broker code when one is present
//                 (TRADING_BAD_STOPS, POSITION_NOT_FOUND). NO message text:
//                 broker messages quote prices;
//   · fast monitor only: dueAtMs (the receipt's nextDueAt), evaluatedAtMs,
//                 latenessMs (due → evaluated), preSendMs (evaluated → sent)
//                 and compositeMs = latenessMs + preSendMs + ms — due to
//                 broker answer, the figure a Node-managed exit is graded on;
//   · book_stop only: the read-back that confirms the stop (book-stop-amend.js
//                 already times it: readStartedAtMs, checkedAtMs,
//                 readDurationMs) — confirm, confirmMs (sent → confirmed by a
//                 fresh broker read) and readbackMs.
// Separately, every fast-monitor EVALUATION's due → evaluated lateness goes
// into its own ring, so the lateness term has a distribution even while
// amends are rare. A sample is counted only when the previous attempt on that
// position was itself an evaluation: after a no-quote pass (a closed market),
// a first sighting, or a pass the owner had switched off, the gap is not
// monitor lateness and is counted apart, never folded in.
//
// WHAT STAYS NOT VERIFIABLE (named in the summary, never filled in):
//   · the native trail engine's amends (source cpp_trail_engine) — made inside
//     the gateway, they never pass through Node;
//   · p95 below 20 and p99 below 100 broker-answered amends — no amendment is
//     ever forced to fill the sample;
//   · the composite on paths with no due time (slow monitor, band, routes);
//   · any grade at all: no limit is owner-confirmed.
//
// COST. Recording touches memory only. `amend_latency_json` is written at most
// once per 30 s, and only when an amend arrived; lateness-only changes ride a
// 5-minute write. Bounded: 256 amends, 512 lateness samples. Served on
// AUTHENTICATED /health only. No credentials reach this module: call sites
// hand it an account id, a position id and a source name, nothing else.
// ---------------------------------------------------------------------------
import { performance } from 'node:perf_hooks'
import { getState, setState } from '../db.js'
import { BOOT_ORIGIN_MS } from './boot-clock.js'
import { summarize } from './runtime-record.js'

export const AMEND_LATENCY_KEY = 'amend_latency_json'
export const AMEND_RING_SIZE = 256
export const LATENESS_RING_SIZE = 512
export const PERSIST_MIN_MS = 30_000
export const PERSIST_IDLE_MS = 5 * 60_000
export const MIN_N_P95 = 20
export const MIN_N_P99 = 100
const RECENT = 10
const LATENESS_WINDOW_MS = 10 * 60_000

/** Every Node path that sends an amend. Closed list; anything else is '(other)'. */
export const AMEND_PATHS = Object.freeze([
  'broker_action.move_sl',    // loop.js executeBrokerAction MOVE_SL (slow + fast monitor, session-open guard)
  'broker_action.runner_leg', // loop.js executeBrokerAction PARTIAL_EXIT, the runner leg's stop
  'book_stop',                // book-stop-amend.js amendBookStop (momentum book trail), confirmed by read-back
  'loss_guardian',            // loss-guardian.js, a stop on a naked position
  'profit_keeper',            // profit-keeper.js, the SL ratchet
  'trade_guard',              // trade-guard.js, break-even / trailing
  'position_protect',         // position-protect.js: POST /actions/position-protect, the Telegram Set-TP button
  'target_restore',           // target-restore.js, a missing target put back
  'tp_suggest',               // tp-suggest.js, a target on an adopted position
  'restrategize',             // restrategize.js, SL/TP after an owner reversal
])

export const OUTCOMES = Object.freeze(['ok', 'refused', 'already_closed', 'empty', 'timeout', 'error'])

const NATIVE_NOT_VERIFIABLE = Object.freeze({
  what: 'native trail-engine amends (source cpp_trail_engine)',
  why: 'made inside the gateway by the tick ratchet; they never pass through Node, so no Node clock sees them',
})

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

/** What an amend's resolved value says happened. Pure. */
export function classifyAmendResult(result) {
  if (result == null) return 'empty'
  if (result.alreadyClosed) return 'already_closed'
  if (result.error || result.rawError || result.ok === false) return 'refused'
  return 'ok'
}

/** What an amend's rejection says happened. Pure. */
export function classifyAmendError(err) {
  const msg = String(err?.message ?? err ?? '')
  return /timed?\s*out|timeout|deadline|abort/i.test(msg) || err?.name === 'AbortError' ? 'timeout' : 'error'
}

/**
 * The broker's upper-case code in a message, e.g. TRADING_BAD_STOPS — never
 * the message itself, which quotes prices. Null when there is none. Pure.
 */
export function errorCodeOf(...values) {
  for (const v of values) {
    if (typeof v !== 'string') continue
    const m = v.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/)
    if (m) return m[0].slice(0, 48)
  }
  return null
}

/** '…1234' for an account id; null when there is none. Pure. */
export function accountSuffix(accountId) {
  const s = String(accountId ?? '').replace(/[^0-9A-Za-z]/g, '')
  return s ? `…${s.slice(-4)}` : null
}

// Validated, not stripped: a source is a writer name from the code
// (lower-case snake), and anything else — a stray token, a message — reads as
// 'unknown' rather than being kept in a cleaned-up form.
const cleanSource = (v) => {
  const s = String(v ?? '')
  return /^[a-z][a-z0-9_:.-]{0,39}$/.test(s) ? s : 'unknown'
}
const cleanId = (v) => {
  if (v == null) return null
  const s = String(v)
  return /^[0-9A-Za-z_-]{1,24}$/.test(s) ? s : null
}
// Numbers only: '' or null must never read as 0 ms or the epoch.
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * One ring entry from what a call site knows. Pure: only fixed fields, numbers
 * and cleaned short strings survive, so nothing a caller passes by mistake
 * (credentials, prices, messages) can reach the record.
 */
export function buildAmendEntry(fields = {}, bootId = BOOT_ID) {
  const sentAtMs = finite(fields.sentAtMs)
  const ackAtMs = finite(fields.ackAtMs)
  const ms = finite(fields.ms)
  const entry = {
    at: finite(fields.at) ?? ackAtMs ?? sentAtMs ?? Date.now(),
    boot: String(bootId ?? '').slice(0, 40),
    path: AMEND_PATHS.includes(fields.path) ? fields.path : '(other)',
    source: cleanSource(fields.source),
    account: accountSuffix(fields.accountId),
    positionId: cleanId(fields.positionId),
    sentAtMs, ackAtMs,
    ms: ms == null ? null : Math.max(0, Math.round(ms)),
    outcome: OUTCOMES.includes(fields.outcome) ? fields.outcome : 'error',
    errorCode: typeof fields.errorCode === 'string' ? errorCodeOf(fields.errorCode) : null,
  }
  // The composite — only where a due time is known (the fast monitor).
  const dueAtMs = finite(fields.dueAtMs)
  const evaluatedAtMs = finite(fields.evaluatedAtMs)
  if (evaluatedAtMs != null) {
    entry.evaluatedAtMs = evaluatedAtMs
    if (sentAtMs != null) entry.preSendMs = Math.max(0, Math.round(sentAtMs - evaluatedAtMs))
    if (dueAtMs != null) {
      entry.dueAtMs = dueAtMs
      entry.latenessMs = Math.max(0, Math.round(evaluatedAtMs - dueAtMs))
      if (entry.ms != null && entry.preSendMs != null) entry.compositeMs = entry.latenessMs + entry.preSendMs + entry.ms
    }
  }
  // The book's read-back confirmation.
  if (['readback_confirmed', 'readback_mismatch', 'readback_failed'].includes(fields.confirm)) {
    entry.confirm = fields.confirm
    const confirmMs = finite(fields.confirmMs)
    const readbackMs = finite(fields.readbackMs)
    if (confirmMs != null) entry.confirmMs = Math.max(0, Math.round(confirmMs))
    if (readbackMs != null) entry.readbackMs = Math.max(0, Math.round(readbackMs))
  }
  return entry
}

// ---------------------------------------------------------------------------
// Process state
// ---------------------------------------------------------------------------
// Same identity as the boot record (runtime-record.js), so an entry can be
// matched to the boot that made it.
const BOOT_ID = `${Math.round(BOOT_ORIGIN_MS)}-${process.pid}`

let amends = []          // entries, oldest first, at most AMEND_RING_SIZE
let lateness = []        // [atMs, latenessMs], oldest first, at most LATENESS_RING_SIZE
let latenessExcluded = { first_seen: 0, after_no_quote: 0, after_other: 0 }
let dirtyAmends = false
let dirtyLateness = false
let lastPersistAt = 0
let loaded = false
let timer = null

/** Append one amend to the ring. Never throws: measurement never breaks an amend. */
export function recordAmend(fields) {
  try {
    const entry = buildAmendEntry(fields)
    amends.push(entry)
    if (amends.length > AMEND_RING_SIZE) amends = amends.slice(-AMEND_RING_SIZE)
    dirtyAmends = true
    return entry
  } catch { return null }
}

/**
 * Run one amend and record its round trip. Returns exactly what `send`
 * returns and rethrows exactly what it throws — the amend itself, its payload
 * and its caller's handling are untouched.
 *
 * meta: { path, source, accountId, positionId, dueAtMs?, evaluatedAtMs? }
 */
export async function measureAmend(meta, send, { clock = () => performance.now(), now = Date.now } = {}) {
  const sentAtMs = now()
  const began = clock()
  let result
  try {
    result = await send()
  } catch (err) {
    recordAmend({ ...meta, sentAtMs, ackAtMs: now(), ms: clock() - began,
      outcome: classifyAmendError(err), errorCode: errorCodeOf(err?.message) })
    throw err
  }
  recordAmend({ ...meta, sentAtMs, ackAtMs: now(), ms: clock() - began,
    outcome: classifyAmendResult(result),
    errorCode: errorCodeOf(result?.error, result?.rawError, result?.reason) })
  return result
}

/**
 * One fast-monitor evaluation's due → evaluated lateness. `eligible` false
 * (with a `reason`) when the gap is not monitor lateness — counted, not kept.
 */
export function noteDueLateness({ dueAtMs, evaluatedAtMs, eligible = true, reason = 'after_other' } = {}) {
  try {
    if (!eligible) {
      const k = Object.hasOwn(latenessExcluded, reason) ? reason : 'after_other'
      latenessExcluded[k]++
      return false
    }
    const due = finite(dueAtMs)
    const at = finite(evaluatedAtMs)
    if (due == null || at == null) { latenessExcluded.after_other++; return false }
    lateness.push([at, Math.max(0, Math.round(at - due))])
    if (lateness.length > LATENESS_RING_SIZE) lateness = lateness.slice(-LATENESS_RING_SIZE)
    dirtyLateness = true
    return true
  } catch { return false }
}

/**
 * Is this evaluation's gap since its due time monitor lateness? Pure.
 * `prior` is the position's preceding receipt (fast_monitor_position_work_json).
 * Only a gap that began with an evaluation is: after a closed market's
 * no-quote pass, a first sighting, or a switched-off/unmapped pass the
 * position was not late, it was not evaluable.
 */
export function latenessEligibility(prior) {
  if (!prior || !prior.nextDueAt) return { eligible: false, reason: 'first_seen' }
  if (prior.lastOutcome === 'quote_unavailable') return { eligible: false, reason: 'after_no_quote' }
  if (prior.lastOutcome !== 'evaluated' || !['evaluated', 'not_due'].includes(prior.state)) return { eligible: false, reason: 'after_other' }
  return { eligible: true }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// A percentile from fewer samples than its minimum is not served as a number
// (M5 merge-check nit, 26-09): p95 below MIN_N_P95 and p99 below MIN_N_P99
// read null, and the flags say why. A reader of p95 alone can no longer take
// a figure built from three amends for a measured tail.
export function gatedSummary(values) {
  const s = summarize(values)
  const p95Verifiable = s.n >= MIN_N_P95
  const p99Verifiable = s.n >= MIN_N_P99
  return { ...s, p95: p95Verifiable ? s.p95 : null, p99: p99Verifiable ? s.p99 : null, p95Verifiable, p99Verifiable }
}

function groupSummary(list) {
  const outcomes = Object.fromEntries(OUTCOMES.map(o => [o, 0]))
  for (const e of list) outcomes[e.outcome] = (outcomes[e.outcome] || 0) + 1
  const answered = list.filter(e => e.outcome === 'ok')
  // (summarize maps through Number, where null reads 0: filter first.)
  const rt = gatedSummary(answered.map(e => e.ms).filter(Number.isFinite))
  const attemptMs = list.map(e => e.ms).filter(Number.isFinite)
  return {
    attempts: list.length,
    outcomes,
    // Broker-answered amends only: a refusal, a timeout or a throw before the
    // wire is not a confirmation, so it is counted above, not averaged here.
    roundTripMs: rt,
    attemptMaxMs: attemptMs.length ? Math.max(...attemptMs) : null,
  }
}

/** The /health reading: round trip by path, the composite, the lateness term. */
export function amendLatencySummary(nowMs = Date.now()) {
  const list = amends.slice()
  const byPath = {}
  for (const p of [...AMEND_PATHS, '(other)']) {
    const sub = list.filter(e => e.path === p)
    if (!sub.length) continue
    byPath[p] = groupSummary(sub)
    if (p === 'book_stop') {
      const confirmed = sub.filter(e => e.confirm === 'readback_confirmed')
      byPath[p].readback = {
        confirmed: confirmed.length,
        mismatch: sub.filter(e => e.confirm === 'readback_mismatch').length,
        failed: sub.filter(e => e.confirm === 'readback_failed').length,
        confirmMs: gatedSummary(confirmed.map(e => e.confirmMs)),
      }
    }
  }
  const withComposite = list.filter(e => e.outcome === 'ok' && Number.isFinite(e.compositeMs))
  const lateWindow = lateness.filter(([at]) => at >= nowMs - LATENESS_WINDOW_MS && at <= nowMs)
  const all = groupSummary(list)
  const notVerifiable = [NATIVE_NOT_VERIFIABLE]
  if (!all.roundTripMs.p99Verifiable) {
    notVerifiable.push({
      what: 'amend round-trip p95/p99',
      why: `${all.roundTripMs.n} broker-answered amend(s) recorded; p95 needs ${MIN_N_P95} and p99 ${MIN_N_P99} natural amends — none is ever forced`,
    })
  }
  notVerifiable.push({
    what: 'composite (due → broker answer) outside the fast monitor',
    why: 'the slow monitor, the band controllers and the routes have no due time, so only their round trip is recorded',
  })
  return {
    source: 'Node amend paths (services/protection-latency.js); timing only, nothing graded — no limit is owner-confirmed',
    capacity: AMEND_RING_SIZE,
    from: list[0] ? new Date(list[0].at).toISOString() : null,
    boots: new Set(list.map(e => e.boot)).size,
    all,
    byPath,
    composite: {
      definition: 'fast monitor only: due (receipt nextDueAt) → evaluated → sent → broker answer',
      n: withComposite.length,
      compositeMs: gatedSummary(withComposite.map(e => e.compositeMs)),
      latenessMs: gatedSummary(withComposite.map(e => e.latenessMs)),
      preSendMs: gatedSummary(withComposite.map(e => e.preSendMs)),
      roundTripMs: gatedSummary(withComposite.map(e => e.ms)),
    },
    dueLateness: {
      source: 'every fast-monitor evaluation: due (receipt nextDueAt) → evaluated',
      capacity: LATENESS_RING_SIZE,
      from: lateness[0] ? new Date(lateness[0][0]).toISOString() : null,
      all: gatedSummary(lateness.map(([, v]) => v)),
      last10m: gatedSummary(lateWindow.map(([, v]) => v)),
      // Gaps that were not monitor lateness, counted since this process began.
      excluded: { ...latenessExcluded },
    },
    notVerifiable,
    recent: list.slice(-RECENT),
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// The stored form is positional — one short array per amend, with only the
// fields a live entry is BUILT from (lateness, pre-send and composite are
// re-derived on load) — so 256 amends and 512 lateness samples stay well under
// 64 KB (tested), a write the 30-second cadence can afford.
export const STORED_FIELDS = Object.freeze([
  'sentAtMs', 'ackAtMs', 'ms', 'path', 'source', 'account', 'positionId', 'outcome', 'errorCode', 'boot',
  'dueAtMs', 'evaluatedAtMs', 'confirm', 'confirmMs', 'readbackMs',
])

/** One entry as its stored tuple (trailing nulls dropped). Pure. */
export function packAmendEntry(e) {
  const out = STORED_FIELDS.map(k => e?.[k] ?? null)
  while (out.length && out[out.length - 1] == null) out.pop()
  return out
}

/**
 * One stored tuple back into an entry, through the same constructor as a live
 * one — so a stored copy edited by hand cannot carry anything a live entry
 * could not. Null when the tuple is not a valid amend. Pure.
 */
export function unpackAmendEntry(tuple) {
  if (!Array.isArray(tuple)) return null
  const f = Object.fromEntries(STORED_FIELDS.map((k, i) => [k, tuple[i] ?? null]))
  const at = Number.isFinite(f.ackAtMs) ? f.ackAtMs : f.sentAtMs
  if (!Number.isFinite(at) || !AMEND_PATHS.includes(f.path) || !OUTCOMES.includes(f.outcome)) return null
  if (f.ms != null && !Number.isFinite(f.ms)) return null
  return buildAmendEntry({ ...f, at, accountId: f.account }, f.boot)
}

/**
 * Seed the rings from the stored copy, once per process, keeping anything
 * already recorded in memory. Entries keep their `boot`, so a restart's
 * amends are attributable. Never throws.
 */
export function loadAmendLatency(db) {
  if (loaded) return false
  loaded = true
  try {
    const stored = JSON.parse(getState(db, AMEND_LATENCY_KEY) || 'null')
    if (!stored) return false
    const prior = (Array.isArray(stored.entries) ? stored.entries : []).map(unpackAmendEntry).filter(Boolean)
    amends = [...prior, ...amends].sort((a, b) => a.at - b.at).slice(-AMEND_RING_SIZE)
    const priorLate = (Array.isArray(stored.lateness) ? stored.lateness : [])
      .filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map(p => [p[0], Math.max(0, Math.round(p[1]))])
    lateness = [...priorLate, ...lateness].sort((a, b) => a[0] - b[0]).slice(-LATENESS_RING_SIZE)
    return true
  } catch { return false }
}

/**
 * Write the rings, at most once per PERSIST_MIN_MS: when an amend arrived,
 * or — for lateness alone — every PERSIST_IDLE_MS. Never throws.
 */
export function persistAmendLatency(db, { nowMs = Date.now(), force = false } = {}) {
  try {
    if (!force) {
      if (lastPersistAt && nowMs - lastPersistAt < PERSIST_MIN_MS) return { written: false, reason: 'throttled' }
      const due = dirtyAmends || (dirtyLateness && (!lastPersistAt || nowMs - lastPersistAt >= PERSIST_IDLE_MS))
      if (!due) return { written: false, reason: 'nothing new' }
    }
    setState(db, AMEND_LATENCY_KEY, JSON.stringify({
      version: 1, persistedAt: new Date(nowMs).toISOString(), boot: BOOT_ID,
      fields: STORED_FIELDS, entries: amends.map(packAmendEntry), lateness,
    }))
    lastPersistAt = nowMs
    dirtyAmends = false
    dirtyLateness = false
    return { written: true }
  } catch (err) {
    return { written: false, error: String(err?.message || err).slice(0, 200) }
  }
}

/** Seed from the stored copy, then check every 30 s. Idempotent; never holds the process open. */
export function startAmendLatencyRecord(db, { everyMs = PERSIST_MIN_MS } = {}) {
  if (timer) return false
  loadAmendLatency(db)
  timer = setInterval(() => persistAmendLatency(db), everyMs)
  timer.unref?.()
  return true
}

/** Test seam: an empty process state. */
export function _resetAmendLatencyForTests() {
  if (timer) clearInterval(timer)
  timer = null
  amends = []
  lateness = []
  latenessExcluded = { first_seen: 0, after_no_quote: 0, after_other: 0 }
  dirtyAmends = false
  dirtyLateness = false
  lastPersistAt = 0
  loaded = false
}

/** Test seam: the raw rings (copies). */
export function _amendLatencyStateForTests() {
  return { amends: amends.map(e => ({ ...e })), lateness: lateness.map(p => [...p]), excluded: { ...latenessExcluded } }
}
