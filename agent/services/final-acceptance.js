// ---------------------------------------------------------------------------
// agent/services/final-acceptance.js — V3 R2 (P8d, corrected): the P8 final
// acceptance evaluators.
//
// WHAT THIS IS. Pure functions over GET bodies an operator SAVED to files
// (the scripts/tick-shadow-preflight.mjs pattern): nothing here opens a
// socket, reads the database or calls a service. scripts/v3-final-acceptance.mjs
// is the command line around them; scripts/tick-recorder-soak.mjs grades its
// soak with soakVerdict below.
//
//   freezeManifest(start, {end, changes})   T0  the frozen scope, then drift
//   recorderDrill(before, after)            T1  the gateway restart drill
//   retentionCheck(samples)                 T2  the first natural retire
//   capacityStage(samples, stage)           T3  one capacity stage
//   e2eTrace(bodies, {window, gate})        T4  the natural end-to-end window
//   soakVerdict(report)                     P8d the recorder soak
//   finalReport({steps, rollback, cost})    T5  the report
//
// THREE VERDICTS, NEVER TWO. Each evaluator returns PASS, FAIL or
// NOT_VERIFIABLE with a NAMED reason, and the fold below decides:
//   - any FAIL makes the result FAIL, named by the first failing check;
//   - otherwise anything short of PASS makes it NOT_VERIFIABLE;
//   - and an EMPTY list of checks is NOT_VERIFIABLE, never PASS. A window with
//     no natural event, a drill with no body, a report with no step: each is
//     "nothing was shown", and nothing shown is not a pass (owner principle 6;
//     CLAUDE.md failure mode #3, the guard whose input never arrived).
// A check whose evidence is not in the saved bodies says which source and
// which key it needed. It is never guessed from a neighbouring field.
//
// WHY /state/storage IS REFUSED. It walks every table and every page
// (dbstat); run synchronously it held Node's event loop for 20.99 s in
// production (P8 spec, 25-09 08:39Z). It is not an input to any step, so a
// body shaped like it — or a file named for it — is rejected rather than read.
// ---------------------------------------------------------------------------
import { automaticProducers } from '../lib/entry-producers.js'

export const VERDICT = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', NOT_VERIFIABLE: 'NOT_VERIFIABLE' })
export const EVALUATOR_VERSION = 'v3-r2-4'
const { PASS, FAIL, NOT_VERIFIABLE: NV } = VERDICT

/** The two recorder sides, by the heartbeat's side names. */
export const SIDES = Object.freeze({
  cpp_exec: Object.freeze({ environment: 'live', service: 'cpp-acct', manifest: 'live' }),
  cpp_exec_demo: Object.freeze({ environment: 'demo', service: 'cpp-exec', manifest: 'demo' }),
})
/** The five native services whose Railway deployment ids T0 freezes. */
export const NATIVE_SERVICES = Object.freeze(['cpp-exec', 'cpp-acct', 'cpp-verify', 'cpp-scan-tick', 'cpp-scan-timeframe'])
/** Owner, 2026-09-11 (CLAUDE.md): the position caps stay as they are. */
export const OWNER_CAPS = Object.freeze({ maxOpenPositions: 5, bookMax: 8 })
export const RECORDING_WITHIN_MS = 5 * 60_000
export const GATE_WITHIN_MS = 5 * 60_000
/** A Node dispatch decision precedes its intent (loop.js autoTrade): decision, then the fenced send. */
export const ADMISSION_BEFORE_MS = 5 * 60_000
export const ADMISSION_AFTER_MS = 5_000
export const PNL_TOLERANCE = 0.01

// ---------------------------------------------------------------------------
// The fold and small readers
// ---------------------------------------------------------------------------

/** One graded check. An unknown verdict string is treated as NOT_VERIFIABLE. */
export function check(name, verdict, reason, evidence = null) {
  const v = verdict === PASS || verdict === FAIL ? verdict : NV
  return { name, verdict: v, reason: String(reason ?? ''), ...(evidence != null ? { evidence } : {}) }
}

/**
 * The fold. Empty → NOT_VERIFIABLE (never PASS). Any FAIL → FAIL, named by the
 * first. Otherwise anything not PASS → NOT_VERIFIABLE, named by the first.
 */
export function fold(name, checks, { empty = 'nothing was evaluated' } = {}) {
  const list = (checks || []).filter(Boolean)
  if (!list.length) return { name, verdict: NV, reason: empty, checks: [] }
  const failed = list.find(c => c.verdict === FAIL)
  if (failed) return { name, verdict: FAIL, reason: `${failed.name}: ${failed.reason}`, checks: list }
  const open = list.find(c => c.verdict !== PASS)
  if (open) return { name, verdict: NV, reason: `${open.name}: ${open.reason}`, checks: list }
  return { name, verdict: PASS, reason: `${list.length} check(s) passed`, checks: list }
}

const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x])
const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
/**
 * A count as the R1 view serves it: a non-negative integer, or its decimal
 * string. Anything else is null — never a boolean or an array that num() would
 * read as 1 or 0, and never a missing field read as 0: a count that was not
 * reported is not a count of nothing.
 */
const countOf = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN
  return Number.isInteger(n) && n >= 0 ? n : null
}
/** How a field that is not a count was reported, for a NOT_VERIFIABLE reason. */
const notACount = (v) => (v === undefined ? 'absent' : `not a count (${JSON.stringify(v) ?? String(v)})`)
const has = (o, k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k)
const empty = (v) => v == null || String(v).trim() === ''

/** ms from a number, an ISO string or SQLite's UTC 'YYYY-MM-DD HH:MM:SS'. */
export function toMs(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).trim()
  if (/^\d+$/.test(s)) return Number(s)
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)
  const ms = Date.parse(sqlite ? `${s.replace(' ', 'T')}Z` : s)
  return Number.isFinite(ms) ? ms : null
}
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString())
/** Account ids are redacted to '…1234' on some routes and full on others: join on the last four. */
export const acct4 = (id) => (id == null ? null : String(id).replace(/^…/, '').slice(-4))
/** A body's own observation time: `at`, `observedAtMs` or `generatedAt`. */
export const bodyAtMs = (b) => toMs(b?.at ?? b?.observedAtMs ?? b?.generatedAt ?? null)
const byAt = (a, b) => (bodyAtMs(a) ?? 0) - (bodyAtMs(b) ?? 0)
/**
 * When a body was READ, which is not always its `at`: the protection audit's
 * `at` is when the audit last ran (read time = at + ageSec), and the
 * heartbeats body carries its time on `runtime.at`.
 */
export function readAtMs(route, body) {
  if (!body) return null
  if (route === '/state/protection-audit') { const a = toMs(body.at); return a == null ? null : a + (num(body.ageSec) ?? 0) * 1000 }
  if (route === '/state/heartbeats') return toMs(body.at ?? body.runtime?.at ?? null)
  return bodyAtMs(body)
}

export class StorageBodyRefused extends Error {
  constructor(where) { super(`${where}: a GET /state/storage body is refused — it runs a synchronous dbstat walk (20.99 s on the event loop in production) and is not an input to any P8 step`); this.name = 'StorageBodyRefused' }
}
/** The storage-report shape (services/storage-report.js): files.{db,wal} and a tables list. */
export function isStorageBody(body) {
  return !!body && typeof body === 'object' && !!body.files && typeof body.files === 'object'
    && has(body.files, 'db') && has(body.files, 'wal') && Array.isArray(body.tables)
}
export function assertNotStorage(route, body, where = route) {
  if (String(route || '').replace(/\/+$/, '') === '/state/storage' || isStorageBody(body)) throw new StorageBodyRefused(where)
}

function recorderSide(body, side) {
  const s = arr(body?.sides).find(x => x?.side === side)
  return s ? { at: toMs(s.at) ?? bodyAtMs(body), status: s.status || null, rate24h: s.rate24h || null } : null
}
function segmentsSide(body, side) { return arr(body?.sides).find(x => x?.side === side) || null }
function manifestValue(rm, key) {
  const it = arr(rm?.items).find(i => i?.key === key)
  return it ? it.value : undefined
}
const recording = (st) => st?.recording === true && (st.state === 'RECORDING' || st.state === 'WARN')

// ---------------------------------------------------------------------------
// T0 — the freeze manifest
// ---------------------------------------------------------------------------

export const FREEZE_FIELDS = Object.freeze([
  { key: 'originMainSha', label: 'origin/main SHA', valid: v => /^[0-9a-f]{7,40}$/.test(String(v)) },
  { key: 'nodeCommit', label: 'Node commit (GET /state/runtime-manifest node.commit)', valid: v => /^[0-9a-f]{7,40}$/.test(String(v)) },
  { key: 'railwayDeployments', label: `Railway deployment id per native service (${NATIVE_SERVICES.join(', ')}; the sidecars report no commit until GW-1)`, valid: v => v && typeof v === 'object' && NATIVE_SERVICES.every(s => !empty(v[s])) },
  { key: 'accounts', label: 'account roster with entry modes and admitted bases (GET /state/entry-engines)', valid: v => Array.isArray(v) && v.length > 0 && v.every(a => !empty(a?.accountId) && !empty(a?.environment) && !empty(a?.effectiveEntryMode)) },
  { key: 'tickProfileHash', label: 'tick profile hash (GET /state/tick-recorder strategy.profileHash)', valid: v => /^[0-9a-f]{8,64}$/.test(String(v)) },
  { key: 'tickValidationSha256', label: 'sha256 of agent/config/tick-validation.json', valid: v => /^[0-9a-f]{64}$/.test(String(v)) },
  { key: 'caps', label: 'position caps { maxOpenPositions, bookMax }', valid: v => v && num(v.maxOpenPositions) != null && num(v.bookMax) != null },
  { key: 'partialTpPolicyVersion', label: 'partial-TP policy version', valid: v => !empty(v) },
])

const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x))

/**
 * T0. `start` is the frozen field set (the CLI builds it from saved bodies and
 * the operator's fields file). PASS needs every field present at the start AND
 * an end-of-trial manifest identical to it, field by field, except where the
 * change is recorded in `changes` ([{ field, reason, at }]). A missing field
 * is NOT_VERIFIABLE (it cannot be frozen, so drift in it cannot be seen); caps
 * other than the owner's 5/8 are a FAIL.
 */
export function freezeManifest(start, { end = null, changes = [] } = {}) {
  const checks = []
  const s = start || {}
  for (const f of FREEZE_FIELDS) {
    const v = s[f.key]
    if (v == null || (typeof v === 'string' && empty(v))) checks.push(check(`start.${f.key}`, NV, `not captured: ${f.label}`))
    else if (!f.valid(v)) checks.push(check(`start.${f.key}`, NV, `captured in an unreadable form: ${f.label}`, { value: v }))
    else checks.push(check(`start.${f.key}`, PASS, 'captured', { value: v }))
  }
  const caps = s.caps
  if (caps && num(caps.maxOpenPositions) != null && num(caps.bookMax) != null) {
    const ok = num(caps.maxOpenPositions) === OWNER_CAPS.maxOpenPositions && num(caps.bookMax) === OWNER_CAPS.bookMax
    checks.push(check('caps.owner', ok ? PASS : FAIL, ok ? 'maxOpenPositions 5 and the book 8, as the owner set them' : `caps ${caps.maxOpenPositions}/${caps.bookMax} are not the owner's 5/8 (CLAUDE.md, owner 2026-09-11)`, { caps }))
  }
  if (!end) {
    checks.push(check('frozen.throughT5', NV, 'no end-of-trial manifest was supplied, so drift cannot be graded'))
  } else {
    const recorded = new Map(arr(changes).filter(c => c && !empty(c.field) && !empty(c.reason)).map(c => [String(c.field), c]))
    for (const f of FREEZE_FIELDS) {
      const a = s[f.key], b = end[f.key]
      if (a == null || b == null) { checks.push(check(`drift.${f.key}`, NV, `${a == null ? 'start' : 'end'} value not captured`)); continue }
      if (stable(a) === stable(b)) checks.push(check(`drift.${f.key}`, PASS, 'identical at the start and the end'))
      else if (recorded.has(f.key)) checks.push(check(`drift.${f.key}`, PASS, `changed, recorded: ${recorded.get(f.key).reason}`, { from: a, to: b, change: recorded.get(f.key) }))
      else checks.push(check(`drift.${f.key}`, FAIL, 'changed during the trial and not recorded as a change', { from: a, to: b }))
    }
  }
  return { step: 'T0', ...fold('T0 freeze manifest', checks, { empty: 'no freeze manifest' }) }
}

/**
 * The freeze fields a set of saved bodies carries. The caller adds the ones no
 * GET body carries (origin/main SHA, Railway deployment ids, the policy
 * version, caps) from the operator's fields file; a body value never
 * overrides an operator value silently — both are returned.
 */
export function freezeFieldsFromBodies({ runtimeManifest = null, entryEngines = null, tickRecorder = null } = {}) {
  const out = {}
  const commit = manifestValue(runtimeManifest, 'node.commit')
  if (!empty(commit)) out.nodeCommit = String(commit)
  if (Array.isArray(entryEngines?.accounts)) {
    out.accounts = entryEngines.accounts.map(a => ({
      accountId: a.accountId, environment: a.environment, effectiveEntryMode: a.effectiveEntryMode,
      admittedBases: a.admittedBases ?? null, bases: a.bases ?? null, enabled: a.registry?.enabled ?? null,
    })).sort((a, b) => (String(a.accountId) < String(b.accountId) ? -1 : 1))
  }
  const hashes = new Set(arr(tickRecorder?.sides).map(sd => sd?.status?.strategy?.profileHash).filter(h => !empty(h)))
  if (hashes.size === 1) out.tickProfileHash = [...hashes][0]
  else if (hashes.size > 1) out.tickProfileHashConflict = [...hashes]
  return out
}

// ---------------------------------------------------------------------------
// T1 — the recovery drill at a gateway restart
// ---------------------------------------------------------------------------

function bootOf(bodies, side) {
  const m = manifestValue(bodies?.['/state/runtime-manifest'], `sidecar.${SIDES[side].manifest}.bootId`)
  if (!empty(m)) return String(m)
  const l = segmentsSide(bodies?.['/state/tick-segments'], side)?.manifest?.lastListing?.bootId
  if (!empty(l)) return String(l)
  const recs = arr(bodies?.['/state/tick-recorder'])
  const b = recs.map(r => recorderSide(r, side)?.status?.shadowPortfolio?.bootId).find(x => !empty(x))
  return b ? String(b) : null
}

/**
 * The standing producers (entry-ledger.js STANDING_PRODUCERS; pinned equal by
 * a test). Their signal_ref is the PERMIT KEY — `tick:<symbolId>` for the tick
 * producer (tick-permits.js), one key per symbol — so it recurs on every
 * permit a symbol is ever issued: two sequential fills sharing it are two
 * entries, not one entry sent twice.
 */
export const STANDING_SIGNAL_PRODUCERS = Object.freeze(['vpo_cpp_direct', 'tick_momentum'])

/**
 * Duplicate intents: two intents on one broker position, or two reached
 * intents on one signal. For a standing producer the signal key recurs by
 * design, so a duplicate is two intents on one key IN FLIGHT AT ONCE — the
 * later created before the earlier resolved (the ledger's own rule: one open
 * standing intent per account / symbol / side, entry-ledger.js openConflict).
 * A standing pair whose created or resolved time is missing cannot be judged
 * and is returned as `undetermined`, never as a duplicate and never as clear.
 */
function duplicateIntents(intents) {
  const dups = [], undetermined = []
  const byPos = new Map()
  for (const it of intents) {
    if (empty(it.brokerPositionId)) continue
    const k = `${it.account}:${it.brokerPositionId}`
    if (byPos.has(k)) dups.push({ key: `position ${it.brokerPositionId} on …${it.account}`, intents: [byPos.get(k), it.id] })
    else byPos.set(k, it.id)
  }
  const reached = new Set(['SENT', 'ACCEPTED', 'FILLED', 'UNKNOWN', 'DISPATCHING'])
  const bySignal = new Map()
  const standingBySignal = new Map()
  for (const it of intents) {
    if (empty(it.signalRef) || !reached.has(it.state)) continue
    const k = `${it.account}:${it.symbolId ?? it.symbol}:${it.side}:${it.signalRef}`
    if (STANDING_SIGNAL_PRODUCERS.includes(it.producerId)) {
      const sk = `${it.producerId}:${k}`
      if (!standingBySignal.has(sk)) standingBySignal.set(sk, [])
      standingBySignal.get(sk).push(it)
      continue
    }
    if (bySignal.has(k)) dups.push({ key: `signal ${it.signalRef} on …${it.account}`, intents: [bySignal.get(k), it.id] })
    else bySignal.set(k, it.id)
  }
  for (const list of standingBySignal.values()) {
    if (list.length < 2) continue
    const timed = list.filter(it => it.createdAtMs != null)
    if (timed.length < list.length) { undetermined.push({ key: `permit key ${list[0].signalRef} on …${list[0].account}`, intents: list.map(it => it.id), missing: 'created_at' }); continue }
    timed.sort((a, b) => a.createdAtMs - b.createdAtMs)
    // The in-flight interval of each: created → resolved (unresolved = still in flight).
    let prev = timed[0]
    for (const it of timed.slice(1)) {
      const prevEnd = prev.resolvedAtMs ?? Infinity
      if (it.createdAtMs < prevEnd) dups.push({ key: `permit key ${it.signalRef} on …${it.account}: ${prev.id} and ${it.id} in flight at once`, intents: [prev.id, it.id] })
      if ((it.resolvedAtMs ?? Infinity) > prevEnd) prev = it
    }
  }
  return { dups, undetermined }
}

/** The R1 manifest's row for this restart (restarts[]: prevBootId → bootId), or null. */
function restartRowOf(manifest, bBoot, aBoot) {
  if (!bBoot || !aBoot) return null
  return arr(manifest?.restarts).find(r => String(r?.prevBootId ?? '') === bBoot && String(r?.bootId ?? '') === aBoot) || null
}

/**
 * The durability policy a restart is judged under — V3 R1's rule
 * (tick-segment-manifest.js persistenceVerdict): A RESTART IS JUDGED BY THE
 * BOOT BEFORE IT. What a restart loses is the old boot's spool, so it counts
 * under the policy in force when Node last listed the old boot. The after
 * body's manifest names only the policy in force NOW (persistence.policy from
 * persistence.since); it governs this restart only when `since` is at or
 * before the old boot's last listing — the restart row's prevListingMs, or,
 * with no row, the before body's own lastListing of that boot (an earlier
 * listing, so a lower bound of the last one). A policy declared after that
 * listing did not govern the spool this restart lost: judging by it is how
 * R1's first draft read the X1 restart of the pre-volume live spool as a
 * permanent, false DURABLE failure. `named` (the caller's policy.<side>) is
 * the operator's statement of the old boot's policy and is taken as given.
 */
function drillPolicy({ named, bSeg, aSeg, bBoot, restartRow }) {
  if (named) return { policy: named, source: 'named by the caller' }
  const pers = aSeg?.manifest?.persistence
  const pol = pers?.policy ?? null
  if (!pol) return { policy: null, reason: 'no durability policy is in force for this side (DURABLE or EPHEMERAL_LOSS_RECORDED, agent/config/tick-spool-durability.json)' }
  const sinceMs = toMs(pers.since)
  if (sinceMs == null) return { policy: null, reason: `the R1 manifest names no start (persistence.since) for the ${pol} policy in force, so the restart cannot be placed under it` }
  const bl = bSeg?.manifest?.lastListing
  const prevListingMs = num(restartRow?.prevListingMs) ?? (bBoot && String(bl?.bootId ?? '') === bBoot ? num(bl?.atMs) : null)
  if (prevListingMs == null) return { policy: null, reason: `no listing time for boot ${bBoot ?? '(unknown)'} in the R1 manifest (restarts[].prevListingMs after, or lastListing.atMs before): a restart is judged by the policy of the boot before it (V3 R1), so it cannot be placed under one` }
  if (prevListingMs < sinceMs) return { policy: null, reason: `the ${pol} policy is in force since ${pers.since}, after boot ${bBoot} was last listed (${iso(prevListingMs)}): a restart is judged by the policy of the boot before it (V3 R1), and none in these bodies governed that boot`, evidence: { policy: pol, since: pers.since, prevListingMs } }
  return { policy: pol, since: pers.since, prevListingMs, source: restartRow ? 'the restart row' : "the before body's listing" }
}

/**
 * T1, one or both sides. `before` and `after` map a route to its saved body
 * ('/state/tick-segments', '/state/tick-recorder' — one body or several
 * samples — '/state/runtime-manifest', '/state/protection-audit',
 * '/state/entry-intents', '/state/entry-engines'), plus an optional
 * `gatewayHealth: { <side>: <the gateway's /health body> }` for the trail
 * engine. Persistence is judged under the durability policy that governed the
 * boot BEFORE the restart (drillPolicy: V3 R1's rule), read from the R1
 * manifest unless `policy` names it, and only once the manifest has listed the
 * new boot — what a restart lost is classed at that first listing.
 */
export function recorderDrill(before = {}, after = {}, { sides = Object.keys(SIDES), policy = {}, recordingWithinMs = RECORDING_WITHIN_MS } = {}) {
  const checks = []
  for (const side of sides) {
    const p = (n) => `${side}.${n}`
    const bBoot = bootOf(before, side), aBoot = bootOf(after, side)
    if (!bBoot || !aBoot) checks.push(check(p('restart'), NV, `no sidecar bootId in the ${!bBoot ? 'before' : 'after'} bodies (runtime-manifest sidecar.${SIDES[side].manifest}.bootId, or the R1 manifest's lastListing.bootId)`))
    else if (bBoot === aBoot) checks.push(check(p('restart'), NV, `the same boot ${aBoot} before and after: no restart happened between the two reads, so this is not a drill`))
    else checks.push(check(p('restart'), PASS, `boot ${bBoot} → ${aBoot}`))

    // Segments: every sealed segment from before is listed again with the same bytes, or its loss is recorded.
    const bSeg = segmentsSide(before['/state/tick-segments'], side)
    const aSeg = segmentsSide(after['/state/tick-segments'], side)
    const restartRow = restartRowOf(aSeg?.manifest, bBoot, aBoot)
    // The open segments the new boot quarantined as .torn (R1 records them on
    // the restart row): outside both policies, which judge SEALED segments.
    const rowTorn = restartRow ? num(restartRow.tornAtStart) : null
    const placed = drillPolicy({ named: policy[side] ?? null, bSeg, aSeg, bBoot, restartRow })
    const pol = placed.policy
    const listedNew = !!restartRow || (aBoot != null && String(aSeg?.manifest?.lastListing?.bootId ?? '') === aBoot)
    if (!Array.isArray(bSeg?.list) || !Array.isArray(aSeg?.list)) {
      checks.push(check(p('segments'), NV, `GET /state/tick-segments carries no per-segment list on the ${!Array.isArray(bSeg?.list) ? 'before' : 'after'} side (V3 R1 must be deployed before the drill)`))
    } else if (aSeg.truncated === true) {
      checks.push(check(p('segments'), NV, 'the after listing is truncated (more than 500 sealed segments), so a missing name cannot be told from an unlisted one'))
    } else if (!pol) {
      checks.push(check(p('segments'), NV, placed.reason, placed.evidence ?? null))
    } else if (!listedNew) {
      checks.push(check(p('segments'), NV, `the R1 manifest has not listed boot ${aBoot ?? '(unknown)'} yet (last listed: ${aSeg.manifest?.lastListing?.bootId ?? 'none'}): what a restart lost is classed at the new boot's first listing, so a segment missing now is not yet a recorded loss — save GET /state/tick-segments again after the next heartbeat probe`))
    } else {
      const afterBy = new Map(aSeg.list.map(s => [s.name, s]))
      const goneRows = arr(aSeg.manifest?.gone)
      const goneBy = new Map(goneRows.map(g => [g.name, g]))
      // The view shows the newest `gone` rows only (goneLimit, 100, ordered by
      // goneAtMs descending) and counts them all in goneTotal: a name absent
      // from a capped page may be recorded beyond it, retired or lost, and is
      // not proof of an unaccounted loss — UNLESS the page reaches back to the
      // before read. Every row beyond the page is at or before the oldest one
      // shown, so when that is at or before the before read, none of them can
      // record a segment the before body still listed, and the page covers the
      // drill. The manifest is never pruned, so after 100 lifetime gone rows
      // the page is capped for good: without this, a real never-recorded loss
      // would read NOT_VERIFIABLE forever (CLAUDE.md failure mode #3).
      const goneTotal = num(aSeg.manifest?.goneTotal)
      const paged = goneTotal != null && goneTotal > goneRows.length
      const goneAts = goneRows.map(g => num(g?.goneAtMs))
      // Every shown row must be dated: an undated row could be the oldest one.
      const oldestShownMs = goneAts.length && goneAts.every(x => x != null) ? Math.min(...goneAts) : null
      const beforeReadMs = bodyAtMs(before['/state/tick-segments']) ?? num(bSeg.manifest?.lastListing?.atMs)
      const pageReachesBefore = oldestShownMs != null && beforeReadMs != null && oldestShownMs <= beforeReadMs
      const goneCapped = paged && !pageReachesBefore
      const missing = [], resized = [], retired = [], lost = []
      for (const s of bSeg.list) {
        const a = afterBy.get(s.name)
        if (a) { if (Number(a.bytes) !== Number(s.bytes)) resized.push({ name: s.name, before: s.bytes, after: a.bytes }); continue }
        const g = goneBy.get(s.name)
        if (g?.reason === 'retired') retired.push(s.name)
        else if (g?.reason === 'lost_restart') lost.push(s.name)
        else missing.push({ name: s.name, recordedAs: g?.reason ?? null })
      }
      const unaccounted = goneCapped ? missing.filter(m => m.recordedAs != null) : missing
      const ev = { policy: pol, policySource: placed.source, ...(placed.since ? { since: placed.since, prevListingMs: placed.prevListingMs } : {}), before: bSeg.list.length, listedAgain: bSeg.list.length - missing.length - retired.length - lost.length, retired: retired.length, lostRestart: lost.length, missing, resized, tornAtStart: rowTorn, ...(paged ? { goneShown: goneRows.length, goneTotal, goneOldestShownMs: oldestShownMs, beforeReadMs, pageReachesBefore } : {}) }
      const openNote = rowTorn > 0 ? `; not covered: ${rowTorn} open segment(s) torn at the restart (see tornTail)` : ''
      if (resized.length) checks.push(check(p('segments'), FAIL, `${resized.length} sealed segment(s) listed again with different bytes`, ev))
      else if (pol === 'DURABLE' && (lost.length || unaccounted.length)) checks.push(check(p('segments'), FAIL, `DURABLE spool: ${lost.length + unaccounted.length} sealed segment(s) from before are gone (${[...lost, ...unaccounted.map(m => m.name)].slice(0, 3).join(', ')})`, ev))
      else if (unaccounted.length) checks.push(check(p('segments'), FAIL, `${unaccounted.length} sealed segment(s) from before are gone and the manifest does not record them as lost or retired (${unaccounted.slice(0, 3).map(m => m.name).join(', ')})`, ev))
      else if (missing.length) checks.push(check(p('segments'), NV, `${missing.length} sealed segment(s) from before are not listed again and not among the ${goneRows.length} newest gone rows the manifest shows (of ${goneTotal}), and that page does not reach back to the before read (oldest row shown ${iso(oldestShownMs) ?? 'undated'}, before read ${iso(beforeReadMs) ?? 'undated'}): they may be recorded beyond it, so a retire cannot be told from a loss (${missing.slice(0, 3).map(m => m.name).join(', ')})`, ev))
      else checks.push(check(p('segments'), PASS, pol === 'DURABLE' ? `every sealed segment from before is listed again with the same bytes (${retired.length} retired oldest-first)${openNote}` : `ephemeral by declaration: ${ev.listedAgain} listed again, ${lost.length} recorded lost_restart by name, ${retired.length} retired${openNote}`, ev))
    }

    // Recording within 5 minutes of the restart.
    const startedAt = num(manifestValue(after['/state/runtime-manifest'], `sidecar.${SIDES[side].manifest}.startedAtMs`))
    const samples = arr(after['/state/tick-recorder']).map(b => recorderSide(b, side)).filter(x => x?.status).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    const last = samples.length ? samples[samples.length - 1] : null
    if (startedAt == null) checks.push(check(p('recordingResumed'), NV, `no sidecar start time in the after runtime-manifest (sidecar.${SIDES[side].manifest}.startedAtMs)`))
    else if (!samples.length) checks.push(check(p('recordingResumed'), NV, 'no after GET /state/tick-recorder sample for this side'))
    else {
      const deadline = startedAt + recordingWithinMs
      const inside = samples.filter(x => x.at != null && x.at >= startedAt && x.at <= deadline)
      const firstRec = inside.find(x => recording(x.status))
      if (firstRec) checks.push(check(p('recordingResumed'), PASS, `${firstRec.status.state} ${Math.round((firstRec.at - startedAt) / 1000)} s after the sidecar started`))
      else if (inside.length) checks.push(check(p('recordingResumed'), FAIL, `not recording in any of ${inside.length} sample(s) inside ${recordingWithinMs / 60_000} min of the start (last state ${inside[inside.length - 1].status.state})`))
      else if (last && !recording(last.status) && (last.at ?? 0) > deadline) checks.push(check(p('recordingResumed'), FAIL, `still ${last.status.state} ${Math.round(((last.at ?? 0) - startedAt) / 60_000)} min after the sidecar started`))
      else checks.push(check(p('recordingResumed'), NV, `no sample inside ${recordingWithinMs / 60_000} min of the start; save GET /state/tick-recorder each minute after the restart`))
    }
    const st = last?.status
    if (st) {
      const dropped = num(st.events?.dropped), werr = num(st.segments?.writeErrors)
      if (dropped == null || werr == null) checks.push(check(p('dropsAndWriteErrors'), NV, 'the recorder status carries no dropped / writeErrors counter'))
      else checks.push(check(p('dropsAndWriteErrors'), dropped === 0 && werr === 0 ? PASS : FAIL, `dropped ${dropped}, writeErrors ${werr} since the restart`))
      // The recorder's own per-boot count, or the one R1 recorded on the restart row.
      const torn = num(st.segments?.tornAtStart) ?? rowTorn
      const tornBytes = num(st.segments?.tornBytes), salvaged = num(st.segments?.salvaged)
      if (torn == null) checks.push(check(p('tornTail'), NV, 'the recorder status carries no tornAtStart'))
      else if (torn === 0) checks.push(check(p('tornTail'), PASS, 'no torn tail at start: the old boot sealed its segment (or the spool was ephemeral)'))
      else if ((salvaged != null && salvaged >= torn) || tornBytes != null) checks.push(check(p('tornTail'), PASS, salvaged != null && salvaged >= torn ? `${torn} torn tail(s) salvaged` : `${torn} torn tail(s) counted under the cap (tornBytes ${tornBytes})`))
      else checks.push(check(p('tornTail'), NV, `${torn} torn tail(s) at start and the recorder reports neither salvage nor torn bytes (P8c, GW-1): the torn file sits outside the cap`))
      const gaps = num(st.events?.gaps)
      if (!recording(st)) checks.push(check(p('restartGap'), NV, `the recorder is ${st.state}: no segment is open yet, so no restart gap can be on disk`))
      else if (gaps == null) checks.push(check(p('restartGap'), NV, 'the recorder status carries no gap counter'))
      else if (gaps >= 1) checks.push(check(p('restartGap'), PASS, `${gaps} gap record(s) written this boot (the reason is in the segment, not the GET body)`))
      else checks.push(check(p('restartGap'), FAIL, 'recording with no gap record this boot: the restart is an unmarked gap on disk (P8c item 4 writes GAP_RESTART at every boot)'))
    }
    // Subscriptions: symbols quoting again.
    const bLast = arr(before['/state/tick-recorder']).map(b => recorderSide(b, side)).filter(x => x?.status).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).pop()
    const bSyms = Array.isArray(bLast?.status?.perSymbol) ? bLast.status.perSymbol.length : null
    const aSyms = Array.isArray(st?.perSymbol) ? st.perSymbol.length : null
    if (bSyms == null || aSyms == null) checks.push(check(p('subscriptions'), NV, 'perSymbol missing from a GET /state/tick-recorder body'))
    else if (aSyms >= bSyms) checks.push(check(p('subscriptions'), PASS, `${aSyms} symbol(s) quoting after, ${bSyms} before`))
    else checks.push(check(p('subscriptions'), NV, `${aSyms} of ${bSyms} symbol(s) have quoted since the restart; a symbol with no quote yet is not proof of a lost subscription (the list is on the gateway's authenticated /health)`))
    // Management: the trail engine is tracking again.
    const gh = after.gatewayHealth?.[side]
    if (!gh) checks.push(check(p('managementResumed'), NV, "the gateway's /health (trail engine, reconcile) was not saved after the restart"))
    else {
      const tracked = num(gh.trail?.tracked), rec = num(gh.lastReconcileAt)
      if (gh.connected !== true) checks.push(check(p('managementResumed'), FAIL, 'the gateway reports connected=false after the restart'))
      else if (tracked == null || rec == null) checks.push(check(p('managementResumed'), NV, 'the saved gateway /health carries no trail.tracked or lastReconcileAt'))
      else if (startedAt != null && rec < startedAt) checks.push(check(p('managementResumed'), NV, 'the gateway has not completed a reconcile since it started'))
      else checks.push(check(p('managementResumed'), PASS, `connected, reconciled at ${iso(rec)}, trail engine tracking ${tracked} position(s)`))
    }
  }
  // Book-wide: the protection audit after the restart, the intents, the roster.
  const starts = sides.map(s => num(manifestValue(after['/state/runtime-manifest'], `sidecar.${SIDES[s].manifest}.startedAtMs`))).filter(x => x != null)
  const latestStart = starts.length ? Math.max(...starts) : null
  const bpa = before['/state/protection-audit'], apa = after['/state/protection-audit']
  if (!apa) checks.push(check('protection', NV, 'no GET /state/protection-audit after the restart'))
  else if (!apa.hasRun || apa.stale) checks.push(check('protection', NV, `the audit after the restart is ${!apa.hasRun ? 'never run' : 'stale'}`))
  else if (latestStart != null && (toMs(apa.at) ?? 0) < latestStart) checks.push(check('protection', NV, `the audit (${apa.at}) predates the restart (${iso(latestStart)}): it does not show the positions re-adopted`))
  else {
    const worse = (k) => (num(apa[k]) ?? 0) > (num(bpa?.[k]) ?? 0)
    const ev = { before: bpa ? { checked: bpa.checked, naked: bpa.naked, targetless: bpa.targetless, unmatched: bpa.unmatched } : null, after: { at: apa.at, checked: apa.checked, naked: apa.naked, targetless: apa.targetless, unmatched: apa.unmatched } }
    if ((num(apa.naked) ?? 0) > 0 || (num(apa.targetless) ?? 0) > 0) checks.push(check('protection', FAIL, `after the restart: ${apa.naked} naked, ${apa.targetless} targetless${worse('naked') || worse('targetless') ? ' (worse than before)' : ''}`, ev))
    else if ((num(apa.unmatched) ?? 0) > 0) checks.push(check('protection', NV, `${apa.unmatched} position(s) could not be matched to broker truth after the restart`, ev))
    else checks.push(check('protection', PASS, `${apa.checked ?? '?'} position(s) verified protected after the restart (Goal Plan §65.1.9: a restart adopts and protects existing positions)`, ev))
  }
  const ai = after['/state/entry-intents']
  if (!ai) checks.push(check('intents', NV, 'no GET /state/entry-intents after the restart'))
  else {
    const unknown = Object.entries(ai.countsByAccount || {}).filter(([, c]) => (num(c?.UNKNOWN) ?? 0) > 0)
    const { dups, undetermined } = duplicateIntents(intentsOf(ai))
    if (unknown.length) checks.push(check('intents', FAIL, `UNKNOWN intents after the restart on ${unknown.map(([a, c]) => `${a} (${c.UNKNOWN})`).join(', ')}`))
    else if (dups.length) checks.push(check('intents', FAIL, `duplicate intents: ${dups.map(d => d.key).join('; ')}`, { dups }))
    else if (undetermined.length) checks.push(check('intents', NV, `standing intents sharing a permit key carry no created time, so overlap cannot be judged: ${undetermined.map(d => d.key).join('; ')}`, { undetermined }))
    else checks.push(check('intents', PASS, 'no UNKNOWN and no duplicate intent after the restart'))
  }
  const be = before['/state/entry-engines'], ae = after['/state/entry-engines']
  if (!be || !ae) checks.push(check('roster', NV, `no GET /state/entry-engines ${!be ? 'before' : 'after'} the restart`))
  else {
    const key = (a) => stable({ id: a.accountId, env: a.environment, mode: a.effectiveEntryMode, bases: a.bases ?? a.admittedBases ?? null, enabled: a.registry?.enabled ?? null })
    const b = new Set(arr(be.accounts).map(key)), a = new Set(arr(ae.accounts).map(key))
    const lostAccts = [...b].filter(x => !a.has(x)), gained = [...a].filter(x => !b.has(x))
    if (lostAccts.length || gained.length) checks.push(check('roster', FAIL, `the account roster changed across the restart (${lostAccts.length} gone or changed, ${gained.length} new or changed)`, { before: [...b], after: [...a] }))
    else checks.push(check('roster', PASS, `${a.size} account(s) with the same environment, entry mode and bases`))
  }
  return { step: 'T1', ...fold('T1 recovery drill', checks, { empty: 'no side was evaluated' }) }
}

// ---------------------------------------------------------------------------
// T2 — retention at the first natural retire
// ---------------------------------------------------------------------------

/**
 * T2. `samples.segments`: saved GET /state/tick-segments bodies (with the R1
 * manifest); `samples.recorder`: saved GET /state/tick-recorder bodies (the
 * hourly-ish samples either side of the first retire). The plan counts open
 * and torn bytes inside the cap (tick plan :171); `allowOpenSegmentOverCap`
 * relaxes that to the recorder's built behaviour (retire() keeps SEALED bytes
 * under the cap, so the open segment can pass it by up to one segment) — an
 * owner decision, so it is off unless asked for.
 */
export function retentionCheck(samples = {}, { sides = Object.keys(SIDES), allowOpenSegmentOverCap = false } = {}) {
  const checks = []
  const segs = arr(samples.segments).slice().sort(byAt)
  const recs = arr(samples.recorder).slice().sort(byAt)
  for (const side of sides) {
    const p = (n) => `${side}.${n}`
    const lastSeg = segs.length ? segmentsSide(segs[segs.length - 1], side) : null
    const m = lastSeg?.manifest
    if (!m) { checks.push(check(p('manifest'), NV, 'no R1 segment manifest for this side in the saved GET /state/tick-segments bodies')); continue }
    // A missing or non-numeric count is not a count of zero: NOT_VERIFIABLE, named.
    const unexplained = countOf(m.unexplained)
    const goneUnexplained = arr(m.gone).filter(g => g.reason === 'unexplained').map(g => g.name)
    if (unexplained == null) checks.push(check(p('unexplained'), NV, `the R1 manifest's unexplained count (manifest.unexplained) is ${notACount(m.unexplained)}, so a sealed segment that vanished within one boot cannot be ruled out`))
    else checks.push(check(p('unexplained'), unexplained === 0 ? PASS : FAIL, unexplained === 0 ? 'no sealed segment vanished without a retire to explain it' : `${unexplained} sealed segment(s) vanished within one boot with no retire to explain them (${goneUnexplained.slice(0, 3).join(', ')})`))
    const retired = num(m.retired) ?? 0
    const retiredRows = arr(m.gone).filter(g => g.reason === 'retired')
    if (retired === 0) checks.push(check(p('retireObserved'), NV, `no segment has been retired yet (${m.listedBytes ?? '?'} B sealed): retention is observed at the first natural retire`))
    else checks.push(check(p('retireObserved'), PASS, `${retired} segment(s) retired oldest-first at the cap`))
    const rv = m.retention?.verdict
    checks.push(check(p('manifestVerdict'), rv === 'VERIFIED' ? PASS : rv === 'FAILED' ? FAIL : NV, `R1 retention: ${rv ?? 'absent'}${m.retention?.reason ? ` — ${m.retention.reason}` : ''}`))
    // Bytes under the cap, sample by sample.
    const sideRecs = recs.map(b => recorderSide(b, side)).filter(x => x?.status)
    if (!sideRecs.length) checks.push(check(p('underCap'), NV, 'no GET /state/tick-recorder sample for this side'))
    else {
      const over = [], tornUnknown = []
      for (const r of sideRecs) {
        const sg = r.status.segments || {}
        const cap = num(r.status.limits?.spoolCapBytes) ?? num(sg.spoolCapBytes)
        const sealed = num(sg.sealedBytes), open = num(sg.openBytes), torn = num(sg.tornBytes), segB = num(sg.segmentBytes) ?? 0
        if (cap == null || sealed == null || open == null) { tornUnknown.push({ at: iso(r.at), missing: 'cap / sealedBytes / openBytes' }); continue }
        const total = sealed + open + (torn ?? 0)
        const limit = allowOpenSegmentOverCap ? cap + segB : cap
        if (total > limit) over.push({ at: iso(r.at), sealed, open, torn, cap, overBy: total - cap })
        else if (torn == null) tornUnknown.push({ at: iso(r.at), missing: 'tornBytes' })
      }
      if (over.length) checks.push(check(p('underCap'), FAIL, `${over.length} sample(s) over the ${over[0].cap} B cap by up to ${Math.max(...over.map(o => o.overBy))} B (sealed + open${allowOpenSegmentOverCap ? '' : ' — the plan counts the open segment inside the cap, tick plan :171'})`, { over }))
      else if (tornUnknown.length) checks.push(check(p('underCap'), NV, `sealed + open is under the cap in every sample, but ${tornUnknown.length} sample(s) report no ${tornUnknown[0].missing}: torn files are outside the count until P8c (GW-1) reports them`, { samples: tornUnknown.length }))
      else checks.push(check(p('underCap'), PASS, `sealed + open + torn under the cap in all ${sideRecs.length} sample(s)`))
    }
    // Evidence either side of the first retire.
    const firstRetire = retiredRows.map(g => num(g.goneAtMs)).filter(x => x != null).sort((a, b) => a - b)[0] ?? null
    if (firstRetire == null) checks.push(check(p('bracketed'), NV, 'no retire time in the manifest to bracket'))
    else {
      const beforeN = sideRecs.filter(r => r.at != null && r.at < firstRetire).length
      const afterN = sideRecs.filter(r => r.at != null && r.at > firstRetire).length
      // The manifest view lists at most 100 gone rows, newest first: this is the earliest LISTED retire.
      checks.push(check(p('bracketed'), beforeN && afterN ? PASS : NV, beforeN && afterN ? `${beforeN} sample(s) before and ${afterN} after the earliest listed retire (${iso(firstRetire)})` : `the samples do not bracket the earliest listed retire (${iso(firstRetire)}): ${beforeN} before, ${afterN} after`))
    }
  }
  return { step: 'T2', ...fold('T2 retention', checks, { empty: 'no side was evaluated' }) }
}

// ---------------------------------------------------------------------------
// T3 — one capacity stage
// ---------------------------------------------------------------------------

function counterDeltas(samples, key) {
  // Counters reset on a sidecar restart: sum the non-negative deltas (tickRate24h's rule).
  let total = 0
  for (let i = 1; i < samples.length; i++) total += Math.max(0, (num(key(samples[i])) ?? 0) - (num(key(samples[i - 1])) ?? 0))
  return total
}

/**
 * T3. `samples`: saved GET /state/tick-recorder bodies across the stage.
 * `stage`: { side, symbols, requiredRetentionDays, rssMiB, rssBoundMiB,
 * protectionLatency: { p95Ms, p99Ms, limitP95Ms, limitP99Ms }, afterQualification }.
 * The owner inputs it needs and does not have (latency limits, the RSS bound,
 * the retention days) read NOT_VERIFIABLE, never a default.
 */
export function capacityStage(samples = [], stage = {}) {
  const checks = []
  const side = stage.side
  if (!SIDES[side]) return { step: 'T3', ...fold('T3 capacity stage', [check('stage.side', NV, `no known side named (${Object.keys(SIDES).join(' or ')})`)]) }
  const s = arr(samples).map(b => recorderSide(b, side)).filter(x => x?.status && x.at != null).sort((a, b) => a.at - b.at)
  if (s.length < 2) return { step: 'T3', ...fold('T3 capacity stage', [check('samples', NV, `${s.length} sample(s) for ${side}; a stage needs samples across 24 h`)]) }
  const spanH = (s[s.length - 1].at - s[0].at) / 3_600_000
  checks.push(check('span', spanH >= 24 ? PASS : NV, `${spanH.toFixed(1)} h of samples (a stage holds 24 h)`))
  const last = s[s.length - 1].status
  const syms = Array.isArray(last.perSymbol) ? last.perSymbol.length : null
  if (num(stage.symbols) == null) checks.push(check('symbols', NV, 'the stage declares no symbol count'))
  else if (syms == null) checks.push(check('symbols', NV, 'perSymbol missing from the last sample'))
  else checks.push(check('symbols', syms >= Number(stage.symbols) ? PASS : NV, `${syms} of ${stage.symbols} symbol(s) quoted${syms >= Number(stage.symbols) ? '' : ' (a symbol with no quote is not proof it was not carried)'}`))
  const dropped = counterDeltas(s, x => x.status.events?.dropped)
  const paused = counterDeltas(s, x => x.status.events?.pausedDrops)
  const werr = counterDeltas(s, x => x.status.segments?.writeErrors)
  checks.push(check('dropped', dropped === 0 ? PASS : FAIL, `${dropped} event(s) dropped on a full queue during the stage`))
  checks.push(check('reservePauses', paused === 0 ? PASS : FAIL, `${paused} event(s) refused by the free-space reserve during the stage`))
  checks.push(check('writeErrors', werr === 0 ? PASS : FAIL, `${werr} write error(s) during the stage`))
  const gaps = counterDeltas(s, x => x.status.events?.gaps)
  const gens = counterDeltas(s, x => x.status.generation)
  let restarts = 0
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1].status.shadowPortfolio?.bootId, b = s[i].status.shadowPortfolio?.bootId
    if (a && b && a !== b) restarts++
  }
  checks.push(check('gaps', gaps <= gens + restarts ? PASS : NV, gaps <= gens + restarts ? `${gaps} gap(s), each within ${gens} reconnect(s) and ${restarts} restart(s)` : `${gaps} gap(s) against ${gens} reconnect(s) and ${restarts} restart(s): the rest are unexplained by these counters (their reasons are in the segment records)`))
  const notRec = s.filter(x => !recording(x.status))
  checks.push(check('recording', notRec.length ? FAIL : PASS, notRec.length ? `${notRec.length} sample(s) not recording (${notRec[0].status.state} at ${iso(notRec[0].at)})` : 'recording in every sample'))
  const bpd = num(s[s.length - 1].rate24h?.bytesPerDay)
  const cap = num(last.limits?.spoolCapBytes) ?? num(last.segments?.spoolCapBytes)
  if (num(stage.requiredRetentionDays) == null) checks.push(check('retentionHorizon', NV, 'the owner has not set the retention days (H-P8-2)'))
  else if (bpd == null || !(bpd > 0) || cap == null) checks.push(check('retentionHorizon', NV, 'no measured bytes/day or spool cap in the last sample'))
  else {
    const days = cap / bpd
    checks.push(check('retentionHorizon', days >= Number(stage.requiredRetentionDays) ? PASS : FAIL, `the ${cap} B spool holds ${days.toFixed(1)} day(s) at ${bpd} B/day; required ${stage.requiredRetentionDays}`))
  }
  const pl = stage.protectionLatency
  if (!pl || num(pl.limitP95Ms) == null || num(pl.limitP99Ms) == null) checks.push(check('protectionLatency', NV, 'no owner latency limits (H-P8-4)'))
  else if (num(pl.p95Ms) == null || num(pl.p99Ms) == null) checks.push(check('protectionLatency', NV, 'no attributable broker-confirmed protection latency is captured yet (P1/P4)'))
  else checks.push(check('protectionLatency', pl.p95Ms <= pl.limitP95Ms && pl.p99Ms <= pl.limitP99Ms ? PASS : FAIL, `p95 ${pl.p95Ms} ms (limit ${pl.limitP95Ms}), p99 ${pl.p99Ms} ms (limit ${pl.limitP99Ms})`))
  if (num(stage.rssBoundMiB) == null) checks.push(check('rss', NV, 'no owner-confirmed RSS bound (tick plan :151 proposes 128 MiB)'))
  else if (num(stage.rssMiB) == null) checks.push(check('rss', NV, 'no RSS measurement for the stage'))
  else checks.push(check('rss', stage.rssMiB <= stage.rssBoundMiB ? PASS : FAIL, `${stage.rssMiB} MiB against a ${stage.rssBoundMiB} MiB bound`))
  checks.push(check('afterQualification', stage.afterQualification === true ? PASS : NV, stage.afterQualification === true ? 'run after qualification (the evidence universe is not split)' : 'not declared as run after qualification: a stage changes the carried universe the 48 h shadow is pooled over'))
  return { step: 'T3', side, symbols: stage.symbols ?? null, ...fold('T3 capacity stage', checks) }
}

// ---------------------------------------------------------------------------
// T4 — the natural end-to-end window
// ---------------------------------------------------------------------------

/**
 * The GET routes the trace reads, and the join keys each carries. A link whose
 * key is not in its source reads NOT_VERIFIABLE and names the source.
 */
export const E2E_SOURCES = Object.freeze({
  '/state/entry-intents': "the spine: intent id, account (last four), symbol / symbolId, side, producerId, basis, state, resolution source, error code, broker order and position ids, created and resolved times (open[] and recent[]; recent[] carries the broker ids from V3 R2)",
  '/state/decisions': "decision_log rows (account, symbol, stage, decision, reason, created_at): stage 'dispatch' decision 'proceed' is Node's admission of a bar entry (loop.js autoTrade); skip / veto rows are refusals",
  '/state/scanner-mirrors': 'scanner observation status and candidate COUNTS by source / account / host / strategy — no per-candidate id',
  '/state/momentum-targets': 'per momentum entry: tradeId, positionId, evidenceValid / evidenceId (the candidate evidence) and partialState',
  '/state/protection-audit': "the audit's time, freshness and naked / targetless / unmatched counts across every open position — not per position (one body, or several snapshots)",
  '/state/position-history': 'closed positions: ctrader_position_id, net_pnl, realised_r, close_reason, closed_at_ms, verification_state',
  '/state/broker-deals': "the broker's closing deals: deal_id, position_id, net_pnl, closed_at",
})
/** Read by the recorder-gap check when saved (start: the gate's body; end: the window's). */
export const E2E_RECORDER_SOURCES = Object.freeze(['/state/tick-segments', '/state/tick-recorder'])
export const E2E_GATE_SOURCES = Object.freeze(['/state/protection-audit', '/state/entry-intents', '/state/watchdog', '/state/heartbeats', '/state/scanner-mirrors', '/state/tick-recorder'])

const REACHED = new Set(['DISPATCHING', 'SENT', 'ACCEPTED', 'FILLED', 'UNKNOWN'])

/** Every intent in a GET /state/entry-intents body, open and recent, one shape. */
export function intentsOf(body) {
  const out = new Map()
  for (const r of arr(body?.recent)) {
    out.set(r.id, {
      id: r.id, account: acct4(r.account_id), symbol: r.symbol ?? null, symbolId: r.symbol_id ?? null, side: r.side ?? null,
      producerId: r.producer_id ?? null, basis: r.basis ?? null, state: r.state, errorCode: r.error_code ?? null,
      resolutionSource: r.resolution_source ?? null, createdAtMs: toMs(r.created_at), resolvedAtMs: toMs(r.resolved_at),
      brokerOrderId: r.broker_order_id ?? null, brokerPositionId: r.broker_position_id != null ? String(r.broker_position_id) : null,
      signalRef: r.signal_ref ?? null, carriesBrokerIds: has(r, 'broker_position_id'),
    })
  }
  for (const r of arr(body?.open)) {
    if (out.has(r.id)) continue
    out.set(r.id, {
      id: r.id, account: acct4(r.accountId), symbol: r.symbol ?? null, symbolId: r.symbolId ?? null, side: r.side ?? null,
      producerId: r.producerId ?? null, basis: null, state: r.state, errorCode: r.errorCode ?? null, resolutionSource: null,
      createdAtMs: toMs(r.createdAt), resolvedAtMs: null, brokerOrderId: r.brokerOrderId ?? null,
      brokerPositionId: r.brokerPositionId != null ? String(r.brokerPositionId) : null, signalRef: null, carriesBrokerIds: has(r, 'brokerPositionId'),
    })
  }
  return [...out.values()]
}

/** Wilson score interval for a proportion (95 % by default). */
export function wilson(wins, n, z = 1.959963984540054) {
  if (!(n > 0)) return null
  const p = wins / n, z2 = z * z
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n)
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
  return [Math.max(0, +(centre - half).toFixed(4)), Math.min(1, +(centre + half).toFixed(4))]
}

/**
 * Whether a saved newest-first list covers everything since `fromMs`. The
 * routes cut the list at the request's ?limit, and the body does not say what
 * that limit was — so fewer rows than the DEFAULT page (50 intents, 100
 * decisions) is no proof: a body saved with ?limit=10 is cut the same way. A
 * list covers the window only when its oldest row is at or before `fromMs`
 * (every newer row is then in it), or when it is empty (the routes clamp
 * ?limit to at least 1, so an empty page is the whole table).
 */
function reachesBack(rows, timeOf, fromMs) {
  if (!rows.length) return true
  const oldest = Math.min(...rows.map(r => timeOf(r) ?? Infinity))
  return oldest <= fromMs
}
function truncatedIntents(body, fromMs) {
  return !reachesBack(arr(body?.recent), r => toMs(r.resolved_at), fromMs)
}
function truncatedDecisions(body, fromMs) {
  return !reachesBack(arr(body?.decisions), r => toMs(r.created_at), fromMs)
}

function traceEntry(e, ctx) {
  const links = []
  const L = (name, verdict, reason, evidence) => links.push(check(name, verdict, reason, evidence))
  const posId = e.brokerPositionId
  const tgt = posId ? arr(ctx.targets?.rows).find(r => String(r.positionId) === posId) : null
  const ph = posId ? arr(ctx.history?.recent).find(r => String(r.ctrader_position_id) === posId && acct4(r.account_id) === e.account) : null
  const deals = posId ? arr(ctx.deals?.rows).filter(d => String(d.position_id) === posId && acct4(d.account_id) === e.account) : []
  const fillAt = e.state === 'FILLED' ? (e.resolvedAtMs ?? e.createdAtMs) : null
  const isTick = e.basis === 'tick' || e.producerId === 'tick_momentum'

  // 1. candidate
  if (isTick) {
    if (!ctx.mirrors) L('candidate', NV, 'GET /state/scanner-mirrors was not saved')
    else if (ctx.mirrors.status === 'unavailable') L('candidate', NV, `scanner observation unavailable (${ctx.mirrors.reason ?? 'no reason'})`)
    else L('candidate', NV, '/state/scanner-mirrors carries candidate COUNTS by source/account/strategy, not a per-candidate id: this tick entry cannot be joined to its candidate')
  } else if (!ctx.targets) L('candidate', NV, 'GET /state/momentum-targets was not saved')
  else if (!posId) L('candidate', NV, 'the intent carries no broker position id to join /state/momentum-targets on')
  else if (!tgt) L('candidate', NV, `no /state/momentum-targets row for position ${posId}${ctx.targets.truncated ? ' (the body is truncated: save it with ?account=all&limit=100)' : ''}`)
  else if (tgt.evidenceValid !== true) L('candidate', FAIL, `the momentum target row for position ${posId} carries invalid candidate evidence`, { tradeId: tgt.tradeId })
  else L('candidate', PASS, `momentum candidate evidence ${tgt.evidenceId} (trade ${tgt.tradeId})`)

  // 2. admission
  if (isTick) L('admission', NV, "a tick fire is admitted by the keeper's standing permit (tick-permits.js); /state/decisions carries no per-fire decision row")
  else if (!ctx.decisions) L('admission', NV, 'GET /state/decisions was not saved')
  else if (e.createdAtMs == null) L('admission', NV, 'the intent carries no created time (created_at) to join the decision on')
  else {
    const hits = arr(ctx.decisions.decisions).filter(d => d.stage === 'dispatch' && d.decision === 'proceed' && acct4(d.account_id) === e.account
      && (e.symbol == null || d.symbol == null || String(d.symbol).toUpperCase() === String(e.symbol).toUpperCase())
      && (() => { const t = toMs(d.created_at); return t != null && t >= e.createdAtMs - ADMISSION_BEFORE_MS && t <= e.createdAtMs + ADMISSION_AFTER_MS })())
    if (hits.length === 1) L('admission', empty(hits[0].reason) ? FAIL : PASS, empty(hits[0].reason) ? `decision ${hits[0].id} admitted it with no reason` : `decision ${hits[0].id}: ${hits[0].reason}`)
    else if (hits.length > 1) L('admission', NV, `${hits.length} dispatch decisions on …${e.account} within the join window${e.symbol == null ? ' and the intent carries no symbol' : ''}: ambiguous`)
    else if (truncatedDecisions(ctx.decisions, e.createdAtMs - ADMISSION_BEFORE_MS)) L('admission', NV, 'the saved /state/decisions body does not reach back to this intent (save it with ?account=all&limit=1000)')
    else L('admission', FAIL, `no stage 'dispatch' decision 'proceed' on …${e.account} within ${ADMISSION_BEFORE_MS / 60_000} min before the intent`)
  }

  // 3. intent
  if (e.state === 'UNKNOWN') L('intent', FAIL, 'the entry outcome is UNKNOWN at the end of the window')
  else if (e.state === 'FILLED' || e.state === 'ACCEPTED') L('intent', empty(e.resolutionSource) ? NV : PASS, empty(e.resolutionSource) ? `${e.state} with no resolution source` : `${e.state} by ${e.resolutionSource}`)
  else L('intent', NV, `still ${e.state} at the end of the window`)

  // 4. fill
  if (e.state === 'FILLED') {
    if (posId) L('fill', PASS, `broker position ${posId}`)
    else if (!e.carriesBrokerIds) L('fill', NV, 'this /state/entry-intents build does not carry broker_position_id on recent intents')
    else L('fill', FAIL, 'FILLED with no broker position id')
  } else if (e.state === 'ACCEPTED') L('fill', NV, `resting order${e.brokerOrderId ? ` ${e.brokerOrderId}` : ''} accepted and not filled inside the window`)
  else L('fill', NV, `no fill: the intent is ${e.state}`)

  // 5. protection
  if (fillAt == null) L('protection', NV, 'no fill time')
  else {
    const snaps = ctx.audits.filter(a => a.hasRun && !a.stale && (toMs(a.at) ?? -Infinity) >= fillAt).sort((a, b) => toMs(a.at) - toMs(b.at))
    const first = snaps[0]
    if (!first) L('protection', NV, 'no fresh protection audit after the fill was saved')
    else if ((num(first.naked) ?? 0) > 0 || (num(first.targetless) ?? 0) > 0 || (num(first.unmatched) ?? 0) > 0) L('protection', NV, `the first audit after the fill (${first.at}) is not clean (naked ${first.naked}, targetless ${first.targetless}, unmatched ${first.unmatched}); the book-wide check names it`)
    else if (ph && num(ph.closed_at_ms) != null && ph.closed_at_ms < toMs(first.at)) L('protection', NV, `closed at ${iso(ph.closed_at_ms)}, before the first audit after its fill (${first.at})`)
    else if (ctx.deadlineMs == null) L('protection', NV, `protected no later than ${first.at} (${Math.round((toMs(first.at) - fillAt) / 1000)} s after the fill), but the owner has set no protection deadline (H-P8-5)`)
    else if (toMs(first.at) - fillAt <= ctx.deadlineMs) L('protection', PASS, `stop and target present no later than ${Math.round((toMs(first.at) - fillAt) / 1000)} s after the fill (deadline ${ctx.deadlineMs / 1000} s)`)
    else L('protection', NV, `the first clean audit after the fill is ${Math.round((toMs(first.at) - fillAt) / 1000)} s later, past the ${ctx.deadlineMs / 1000} s deadline; save audits more often (the position may have been protected sooner)`)
  }

  // 6. exits (partial TP1 and the runner)
  const partial = tgt?.partialState ?? null
  const closed = !!ph || deals.length > 0
  if (!posId) L('exits', NV, 'no position')
  else if (partial === 'AMBIGUOUS') L('exits', FAIL, `the partial TP1 on position ${posId} is AMBIGUOUS: its outcome is unknown`)
  else if (!closed) L('exits', NV, `position ${posId} is still open at the end of the window; its exits are observed when the broker closes it naturally`)
  else if (!ctx.deals) L('exits', NV, 'GET /state/broker-deals was not saved')
  else if (!deals.length) L('exits', NV, `position ${posId} is closed in position-history but the saved /state/broker-deals body has no deal for it (import not yet run, or outside its rows)`)
  else if ((partial === 'RECEIVED' || partial === 'CONFIRMED') && deals.length < 2) L('exits', FAIL, `the partial TP1 is ${partial} but the broker shows ${deals.length} closing deal for position ${posId} (TP1 and the runner are two)`, { deals: deals.map(d => d.deal_id) })
  else L('exits', PASS, `${deals.length} closing deal(s) at the broker${partial ? `; partial TP1 ${partial}` : ''}`, { deals: deals.map(d => d.deal_id) })

  // 7. P&L
  if (!posId) L('pnl', NV, 'no position')
  else if (!ctx.history) L('pnl', NV, 'GET /state/position-history was not saved')
  else if (!ph) L('pnl', NV, closed ? `no position-history row for ${posId} (still being captured, or outside the body's rows)` : 'open at the end of the window')
  else if (num(ph.net_pnl) == null || num(ph.realised_r) == null) L('pnl', FAIL, `unknown P&L: net_pnl ${ph.net_pnl}, realised_r ${ph.realised_r}`)
  else if (empty(ph.close_reason) || /^unknown$/i.test(String(ph.close_reason))) L('pnl', FAIL, 'unknown close reason (owner principle 4: every trade has a reason)')
  else if (ph.verification_state === 'disputed') L('pnl', FAIL, 'the independent verifier disputes this position record')
  else if (!deals.length) L('pnl', NV, 'no broker deal to match the realised P&L against')
  else {
    const brokerNet = +deals.reduce((a, d) => a + (num(d.net_pnl) ?? 0), 0).toFixed(8)
    const ok = Math.abs(brokerNet - Number(ph.net_pnl)) <= PNL_TOLERANCE + 1e-9
    L('pnl', ok ? PASS : FAIL, ok ? `net ${ph.net_pnl} matches the broker deals (${brokerNet}); ${(+ph.realised_r).toFixed(3)} R` : `position-history net_pnl ${ph.net_pnl} disagrees with the sum of the broker deals' net_pnl ${brokerNet} (field net_pnl, ${deals.length} deal(s))`)
  }
  const verdict = fold(`entry ${e.id}`, links)
  return { id: e.id, account: `…${e.account}`, producerId: e.producerId, basis: e.basis, state: e.state, positionId: posId, closed: !!ph, realisedR: ph ? num(ph.realised_r) : null, ...verdict }
}

/**
 * V3 K1c: which part of the watchdog's calendar export was cut, from the
 * saved /state/watchdog body (`calendarExport`, scanner-work.js
 * watchdogCalendars), for the gate.calendars reason. '' for a body without
 * the split. Words only: the verdict is not read from here.
 */
function calendarExportSplit(wd) {
  const part = (name, p, plus = '') => {
    const total = num(p?.total), exported = num(p?.exported), cut = num(p?.cut)
    return total == null || exported == null ? null : `${name} ${exported} of ${total}${plus} exported${cut ? ` (${cut} cut)` : ''}`
  }
  const retained = wd?.calendarExport?.retained
  const parts = [part('demanded', wd?.calendarExport?.demanded), part('retained', retained, retained?.totalIsLowerBound === true ? '+' : '')].filter(Boolean)
  if (wd?.demandComplete === false) parts.push('the demand itself is incomplete')
  return parts.length ? `: ${parts.join(', ')}` : ''
}

/**
 * T4. `bodies` maps each route to the body saved at the END of the window
 * (E2E_SOURCES, plus the recorder routes); /state/protection-audit may be an
 * array of snapshots. `gate` maps E2E_GATE_SOURCES to bodies saved at the
 * START. `window` is { fromMs, toMs }. `deadlineMs` is the owner's protection
 * deadline; `waive` lists owner waivers ('calendars').
 *
 * PASS needs at least one natural entry fully linked and nothing failed; a
 * window with no natural entry is NOT_VERIFIABLE whatever else holds — no
 * forced trade stands in for one.
 */
export function e2eTrace(bodies = {}, { window = {}, gate = null, deadlineMs = null, waive = [] } = {}) {
  const fromMs = toMs(window.fromMs ?? window.from), toMsEnd = toMs(window.toMs ?? window.to)
  const checks = []
  const natural = new Set(automaticProducers().map(p => p.id))
  if (fromMs == null || toMsEnd == null || toMsEnd <= fromMs) {
    return { step: 'T4', ...fold('T4 natural end-to-end', [check('window', NV, 'no readable window { from, to }')]), entries: [], report: null }
  }
  const missing = Object.keys(E2E_SOURCES).filter(r => bodies[r] == null)
  checks.push(check('sources', missing.length ? NV : PASS, missing.length ? `not saved: ${missing.join(', ')}` : `all ${Object.keys(E2E_SOURCES).length} named sources saved`))

  // The entry gate, read at the start.
  const gateChecks = []
  if (!gate) gateChecks.push(check('gate', NV, `the entry gate bodies were not saved at the window start (${E2E_GATE_SOURCES.join(', ')})`))
  else {
    for (const r of E2E_GATE_SOURCES) {
      const b = arr(gate[r])[0]
      const at = readAtMs(r, b)
      if (!b) gateChecks.push(check(`gate${r}`, NV, 'not saved at the start'))
      else if (at == null || Math.abs(at - fromMs) > GATE_WITHIN_MS) gateChecks.push(check(`gate${r}.readAt`, NV, `read ${at == null ? 'at an unknown time' : `${Math.round(Math.abs(at - fromMs) / 60_000)} min from the start`}; the gate is read within ${GATE_WITHIN_MS / 60_000} min`))
    }
    const pa = arr(gate['/state/protection-audit'])[0]
    if (pa) gateChecks.push(check('gate.protection', !pa.hasRun || pa.stale ? NV : (num(pa.naked) ?? 0) > 0 || (num(pa.targetless) ?? 0) > 0 ? FAIL : PASS, !pa.hasRun || pa.stale ? 'the protection audit is not fresh at the start' : `naked ${pa.naked}, targetless ${pa.targetless} at the start`))
    const gi = gate['/state/entry-intents']
    if (gi) {
      const unknown = Object.entries(gi.countsByAccount || {}).filter(([, c]) => (num(c?.UNKNOWN) ?? 0) > 0)
      gateChecks.push(check('gate.unknownIntents', unknown.length ? FAIL : PASS, unknown.length ? `UNKNOWN intents at the start on ${unknown.map(([a]) => a).join(', ')}` : 'no UNKNOWN intent at the start'))
    }
    const wd = gate['/state/watchdog']
    if (wd) {
      const waived = arr(waive).includes('calendars')
      // V3 K1c: the verdict stays the watchdog's calendarsComplete (a retained
      // calendar can be one a cpp-scan-tick row needs); the reason names which
      // part of the export was cut, so a waiver is decided on that evidence.
      const split = calendarExportSplit(wd)
      gateChecks.push(check('gate.calendars', wd.calendarsComplete === true || waived ? PASS : NV, wd.calendarsComplete === true ? 'calendars complete' : waived ? `calendars incomplete, waived by the owner${split}` : `watchdog calendarsComplete is false at the start${split} (the owner may waive it)`))
    }
    const hb = gate['/state/heartbeats']
    if (hb) {
      const c = arr(hb.controllers).find(x => x?.name === 'pnl_reconcile')
      gateChecks.push(check('gate.pnlReconcile', !c ? NV : (c.status === 'error' && c.error_is_current !== false) ? FAIL : PASS, !c ? 'no pnl_reconcile controller in /state/heartbeats' : `pnl_reconcile ${c.status}${c.status === 'error' ? `: ${c.last_error ?? ''}` : ''}`))
    }
    const sm = gate['/state/scanner-mirrors']
    if (sm) gateChecks.push(check('gate.scannerMirrors', sm.status === 'unavailable' ? NV : PASS, sm.status === 'unavailable' ? `scanner observation unavailable at the start (${sm.reason ?? ''})` : 'scanner observation available'))
    const tr = gate['/state/tick-recorder']
    if (tr) {
      for (const side of Object.keys(SIDES)) {
        const st = recorderSide(tr, side)?.status
        if (!st) { gateChecks.push(check(`gate.recorder.${side}`, NV, 'not in the body')); continue }
        if ((num(st.events?.dropped) ?? 0) > 0) gateChecks.push(check(`gate.recorder.${side}`, FAIL, `${st.events.dropped} event(s) dropped this boot at the start`))
        else gateChecks.push(check(`gate.recorder.${side}`, recording(st) ? PASS : NV, `${st.state} with 0 drops`))
      }
    }
  }
  checks.push(fold('gate', gateChecks))

  // Book-wide checks over the window.
  const audits = arr(bodies['/state/protection-audit']).filter(Boolean)
  const inWindow = audits.filter(a => { const t = toMs(a.at); return t != null && t >= fromMs && t <= toMsEnd + GATE_WITHIN_MS })
  if (!inWindow.length) checks.push(check('nakedOrTargetless', NV, 'no protection audit read inside the window'))
  else {
    const bad = inWindow.filter(a => (num(a.naked) ?? 0) > 0 || (num(a.targetless) ?? 0) > 0)
    const stale = inWindow.filter(a => !a.hasRun || a.stale)
    checks.push(check('nakedOrTargetless', bad.length ? FAIL : stale.length === inWindow.length ? NV : PASS, bad.length ? `audit ${bad[0].at}: ${bad[0].naked} naked, ${bad[0].targetless} targetless` : stale.length === inWindow.length ? 'every audit read in the window is stale' : `${inWindow.length - stale.length} fresh audit(s) in the window: 0 naked, 0 targetless`))
  }
  const intentsBody = bodies['/state/entry-intents']
  const intents = intentsOf(intentsBody)
  const dated = (i) => i.createdAtMs ?? i.resolvedAtMs
  const windowIntents = intents.filter(i => { const t = dated(i); return t != null && t >= fromMs && t <= toMsEnd })
  const undated = intents.filter(i => dated(i) == null).length
  if (intentsBody) {
    const trunc = truncatedIntents(intentsBody, fromMs)
    checks.push(check('coverage.intents', trunc || undated ? NV : PASS, trunc ? 'the saved /state/entry-intents recent[] does not reach back to the window start (save ?limit=200; a window with more resolutions needs a shorter window)' : undated ? `${undated} intent(s) carry no time and cannot be placed in or out of the window` : 'the saved intents reach back past the window start'))
    const unknownNow = Object.entries(intentsBody.countsByAccount || {}).filter(([, c]) => (num(c?.UNKNOWN) ?? 0) > 0)
    checks.push(check('unknownIntents', unknownNow.length ? FAIL : PASS, unknownNow.length ? `UNKNOWN intents at the end on ${unknownNow.map(([a, c]) => `${a} (${c.UNKNOWN})`).join(', ')}` : 'no UNKNOWN intent at the end'))
    const { dups, undetermined } = duplicateIntents(windowIntents)
    checks.push(check('duplicateIntents', dups.length ? FAIL : undetermined.length ? NV : PASS, dups.length ? dups.map(d => d.key).join('; ')
      : undetermined.length ? `standing intents sharing a permit key carry no created time, so overlap cannot be judged: ${undetermined.map(d => d.key).join('; ')}`
        : 'no two intents share a broker position or a signal, and no two standing intents on one permit key were in flight at once'))
  }
  const refusalProblems = []
  for (const i of windowIntents) {
    if ((i.state === 'REJECTED' || i.state === 'RELEASED') && empty(i.errorCode)) refusalProblems.push(`intent ${i.id} ${i.state} with no error code`)
    if (i.state === 'EXPIRED' && empty(i.resolutionSource)) refusalProblems.push(`intent ${i.id} EXPIRED with no resolution source`)
  }
  const decisionsBody = bodies['/state/decisions']
  if (decisionsBody) {
    for (const d of arr(decisionsBody.decisions)) {
      const t = toMs(d.created_at)
      if (t == null || t < fromMs || t > toMsEnd) continue
      if ((d.decision === 'skip' || d.decision === 'veto') && empty(d.reason)) refusalProblems.push(`decision ${d.id} (${d.stage}) ${d.decision} with no reason`)
      if (/^unknown$/i.test(String(d.reason ?? '').trim())) refusalProblems.push(`decision ${d.id} (${d.stage}) gives "unknown" as its reason`)
    }
  }
  if (!decisionsBody && !refusalProblems.length) checks.push(check('refusalReasons', NV, 'GET /state/decisions was not saved, so refusals cannot be checked for reasons'))
  else checks.push(check('refusalReasons', refusalProblems.length ? FAIL : decisionsBody && truncatedDecisions(decisionsBody, fromMs) ? NV : PASS, refusalProblems.length ? refusalProblems.slice(0, 5).join('; ') : decisionsBody && truncatedDecisions(decisionsBody, fromMs) ? 'the saved /state/decisions body does not reach back to the window start' : 'every refusal in the window carries a reason'))

  // Recorder gaps: unexplained manifest losses and counters over the window.
  const recEnd = bodies['/state/tick-recorder'], recStart = gate?.['/state/tick-recorder']
  const segEnd = bodies['/state/tick-segments']
  const gapChecks = []
  for (const side of Object.keys(SIDES)) {
    // A missing manifest or a missing / non-numeric count is not a count of
    // zero: NOT_VERIFIABLE with the source and key named, never PASS.
    const m = segmentsSide(segEnd, side)?.manifest
    const unexplained = countOf(m?.unexplained)
    if (!m) gapChecks.push(check(`recorder.${side}.manifest`, NV, 'no R1 segment manifest for this side in the saved end-of-window GET /state/tick-segments body (manifest.unexplained)'))
    else if (unexplained == null) gapChecks.push(check(`recorder.${side}.manifest`, NV, `the R1 manifest's unexplained count (manifest.unexplained) is ${notACount(m.unexplained)}, so an unexplained segment loss cannot be ruled out`))
    else gapChecks.push(check(`recorder.${side}.manifest`, unexplained > 0 ? FAIL : PASS, `${unexplained} unexplained segment loss(es)`))
    const a = recorderSide(arr(recStart)[0], side)?.status, b = recorderSide(arr(recEnd)[0], side)?.status
    if (!a || !b) { gapChecks.push(check(`recorder.${side}.counters`, NV, 'GET /state/tick-recorder not saved at both the start and the end')); continue }
    if (a.shadowPortfolio?.bootId && b.shadowPortfolio?.bootId && a.shadowPortfolio.bootId !== b.shadowPortfolio.bootId) { gapChecks.push(check(`recorder.${side}.counters`, NV, 'the sidecar restarted inside the window: its counters reset')); continue }
    const d = (k1, k2) => (num(b[k1]?.[k2]) ?? 0) - (num(a[k1]?.[k2]) ?? 0)
    const lost = d('events', 'dropped') + d('events', 'pausedDrops')
    const gapsN = d('events', 'gaps'), gens = (num(b.generation) ?? 0) - (num(a.generation) ?? 0)
    if (lost > 0) gapChecks.push(check(`recorder.${side}.counters`, FAIL, `${lost} event(s) dropped or refused by the reserve inside the window`))
    // Drops and reserve refusals already failed above, so what is left over the
    // reconnects is not proven lost: a keeper switch-off writes GAP_SWITCHED_OFF
    // with no reconnect (cpp-exec tick_recorder.cpp writerLoop), and the GET body
    // counts gaps without their reasons. T3 grades the same condition this way.
    else if (gapsN > gens) gapChecks.push(check(`recorder.${side}.counters`, NV, `${gapsN} gap(s) inside the window against ${gens} reconnect(s): the rest are not explained by these counters (a keeper switch-off writes a gap with no reconnect; the reasons are in the segment records)`))
    else gapChecks.push(check(`recorder.${side}.counters`, PASS, `${gapsN} gap(s), each a reconnect`))
  }
  checks.push(fold('recorderGaps', gapChecks))

  // The entries.
  const excluded = []
  const entries = []
  for (const i of windowIntents) {
    if (!natural.has(i.producerId)) { if (REACHED.has(i.state)) excluded.push({ id: i.id, producerId: i.producerId, reason: 'not a natural event: a manual or retired producer' }); continue }
    if (!REACHED.has(i.state)) continue
    entries.push(traceEntry(i, {
      targets: bodies['/state/momentum-targets'] || null, history: bodies['/state/position-history'] || null,
      deals: bodies['/state/broker-deals'] || null, decisions: decisionsBody || null,
      mirrors: bodies['/state/scanner-mirrors'] || null, audits, deadlineMs: num(deadlineMs),
    }))
  }
  if (!intentsBody) checks.push(check('entries', NV, 'GET /state/entry-intents was not saved: no entry can be found'))
  else if (!entries.length) checks.push(check('entries', NV, `no natural entry reached the broker between ${iso(fromMs)} and ${iso(toMsEnd)}; no forced trade stands in for one`))
  else {
    const failed = entries.find(e => e.verdict === FAIL)
    const linked = entries.filter(e => e.verdict === PASS)
    if (failed) checks.push(check('entries', FAIL, `entry ${failed.id} — ${failed.reason}`))
    else if (linked.length) checks.push(check('entries', PASS, `${linked.length} of ${entries.length} natural entr${entries.length === 1 ? 'y' : 'ies'} fully linked; the rest are open or unverifiable, none broken`))
    else checks.push(check('entries', NV, `none of ${entries.length} natural entr${entries.length === 1 ? 'y is' : 'ies are'} fully linked: first ${entries[0].id} — ${entries[0].reason}`))
  }

  // Reported, not graded (D1/D2): PF in R and the win rate with its interval.
  const rs = entries.filter(e => e.closed && e.realisedR != null).map(e => e.realisedR)
  const wins = rs.filter(r => r > 0).length
  const pos = rs.filter(r => r > 0).reduce((a, r) => a + r, 0), neg = -rs.filter(r => r < 0).reduce((a, r) => a + r, 0)
  const report = { graded: false, closed: rs.length, wins, winRate: rs.length ? +(wins / rs.length).toFixed(4) : null, wilson95: wilson(wins, rs.length), profitFactorR: neg > 0 ? +(pos / neg).toFixed(4) : null, netR: +rs.reduce((a, r) => a + r, 0).toFixed(4), metric: 'realised_r from GET /state/position-history over the closed natural entries of the window' }
  return { step: 'T4', window: { from: iso(fromMs), to: iso(toMsEnd) }, ...fold('T4 natural end-to-end', checks), entries, excluded, report }
}

// ---------------------------------------------------------------------------
// P8d — the recorder soak
// ---------------------------------------------------------------------------

export const SOAK_FULL_SECONDS = 24 * 3600
/** Which counter each injected fault must move (tick plan §16: faults produce accurate counters). */
export const FAULT_COUNTERS = Object.freeze({
  probe_low: 'pausedDrops', probe_full: 'pausedDrops', eio_write: 'writeErrors', short_write: 'writeErrors',
  enospc_write: 'writeErrors', eio_fsync: 'writeErrors', rename_fail: 'writeErrors', unlink_fail: 'writeErrors',
  unwritable: 'writeErrors', chmod_ro: 'writeErrors', fill: 'pausedDrops', exhaust_inodes: 'writeErrors', reconnect: 'gaps', slow: null,
})
/**
 * Write faults that are NOT a shortage of space: the recorder must not end
 * them in PAUSED_RESERVE, the free-space pause, or an unwritable spool is
 * reported as a full disk. ENOSPC and inode exhaustion are left out — a full
 * disk read as a reserve pause is the right reading.
 */
export const NOT_A_SPACE_FAULT = Object.freeze(['eio_write', 'short_write', 'eio_fsync', 'rename_fail', 'unlink_fail', 'unwritable', 'chmod_ro'])

/**
 * Grades a scripts/tick-recorder-soak-driver.cpp report. The driver measures;
 * this decides. Loss the recorder's own counters do not account for is a
 * FAIL; a fault that moved no counter is a FAIL; a fault that could not be
 * applied here (no shim, root ignores chmod, no mount permission) is
 * NOT_VERIFIABLE; a run shorter than 24 h is NOT_VERIFIABLE as the soak (it
 * may still be a useful smoke run).
 */
export function soakVerdict(report, { requiredSeconds = SOAK_FULL_SECONDS, rssBoundMiB = null, allowOpenSegmentOverCap = false } = {}) {
  const checks = []
  if (!report || typeof report !== 'object' || !report.final) return { step: 'soak', ...fold('P8d recorder soak', [check('report', NV, 'no driver report (or the driver died before its final accounting)')]) }
  const cfg = report.config || {}, fin = report.final, st = fin.stats || {}, disk = fin.disk || {}
  const ran = num(fin.elapsedS) ?? 0
  checks.push(check('duration', ran >= requiredSeconds ? PASS : NV, `${ran.toFixed(0)} s run; the soak is ${requiredSeconds} s${ran >= requiredSeconds ? '' : ' (this is a smoke run, not the soak)'}`))
  const target = (num(cfg.symbols) ?? 0) * (num(cfg.ratePerSymbol) ?? 0)
  const achieved = num(fin.offeredPerSecBase)
  checks.push(check('rate', target > 0 && achieved != null && achieved >= 0.95 * target ? PASS : NV, `${achieved ?? '?'} ev/s offered outside bursts against ${target} ev/s asked (${cfg.symbols} symbols × ${cfg.ratePerSymbol} ev/s)`))
  const bursts = num(fin.offeredPerSecBurst)
  checks.push(check('bursts', bursts != null && target > 0 && bursts >= 0.9 * target * (num(cfg.burstFactor) ?? 1) ? PASS : NV, `${bursts ?? '?'} ev/s offered in bursts against ${target * (num(cfg.burstFactor) ?? 1)} asked`))
  // Accounting: every event offered while recording is written, dropped or refused — by the recorder's own counters.
  const offered = num(fin.offeredWhileOn), quotesWritten = (num(st.recordsWritten) ?? 0) - (num(st.gaps) ?? 0)
  const accounted = quotesWritten + (num(st.dropped) ?? 0) + (num(st.pausedDrops) ?? 0)
  if (offered == null) checks.push(check('counters', NV, 'the driver did not report what it offered'))
  else checks.push(check('counters', offered === accounted ? PASS : FAIL, `offered ${offered} = written ${quotesWritten} + dropped ${st.dropped} + refused ${st.pausedDrops} → ${accounted}`))
  // Disk: every counted write is a readable record on disk.
  if (num(disk.unreadSegments) > 0) checks.push(check('disk', NV, `${disk.unreadSegments} segment(s) retired before the driver could read them; make segments live longer than the sampling interval`))
  else {
    const onDisk = num(disk.quoteRecords)
    const missing = quotesWritten - (onDisk ?? 0)
    if (onDisk == null) checks.push(check('disk', NV, 'the driver did not read the spool back'))
    else if (missing === 0 && !(num(disk.truncatedSegments) > 0)) checks.push(check('disk', PASS, `${onDisk} quote record(s) read back from ${disk.segmentsRead} segment(s), every checksum good`))
    else checks.push(check('disk', FAIL, `${Math.max(0, missing)} record(s) the recorder counted as written are not readable on disk${num(disk.truncatedSegments) > 0 ? `; ${disk.truncatedSegments} segment(s) stop at a bad checksum` : ''}${(num(st.writeErrors) ?? 0) > 0 ? ` — ${st.writeErrors} write error(s) were counted, but no counter says how many records they lost` : ' with no error counted'}`, { quotesWritten, onDisk, truncatedSegments: disk.truncatedSegments ?? 0, writeErrors: st.writeErrors ?? 0 }))
  }
  // Gap records on disk against the counters.
  const g = disk.gapBids || {}
  if (num(st.pausedDrops) > 0) checks.push(check('gaps.reserve', num(g.reservePause) === num(st.pausedDrops) ? PASS : FAIL, `GAP_RESERVE_PAUSE records on disk count ${g.reservePause ?? 0} refused event(s); the counter says ${st.pausedDrops}`))
  if (num(st.dropped) > 0) checks.push(check('gaps.overflow', num(g.queueOverflow) === num(st.dropped) ? PASS : FAIL, `GAP_QUEUE_OVERFLOW records on disk count ${g.queueOverflow ?? 0} dropped event(s); the counter says ${st.dropped}`))
  // Bounds.
  const cap = num(cfg.spoolCapBytes), segB = num(cfg.segmentBytes) ?? 0, peak = num(fin.peakSpoolBytes)
  if (cap != null && peak != null) checks.push(check('bound.spool', peak <= (allowOpenSegmentOverCap ? cap + segB : cap) ? PASS : FAIL, `peak sealed + open ${peak} B against the ${cap} B cap${allowOpenSegmentOverCap ? ' (+ one open segment allowed)' : ''}`))
  const rss = num(fin.peakRssKiB)
  if (rssBoundMiB == null) checks.push(check('bound.rss', NV, `peak RSS ${rss != null ? (rss / 1024).toFixed(1) : '?'} MiB; no owner-confirmed bound (tick plan :151 proposes 128 MiB)`))
  else checks.push(check('bound.rss', rss != null && rss / 1024 <= rssBoundMiB ? PASS : FAIL, `peak RSS ${rss != null ? (rss / 1024).toFixed(1) : '?'} MiB against ${rssBoundMiB} MiB`))
  // Each scripted fault: applied, and the counter it must move moved.
  for (const f of arr(report.faults)) {
    const name = `fault.${f.kind}@${f.atS}s`
    if (['none', 'probe_ok', 'restore', 'unfill', 'free_inodes'].includes(f.kind)) continue
    if (!f.applied) { checks.push(check(name, NV, `not applied: ${f.note || 'no reason given'}`)); continue }
    // A fault that met no call in its window proves nothing either way: the
    // recorder had nothing to count (e.g. a probe fault shorter than its probe interval).
    if (num(f.hits) === 0) { checks.push(check(name, NV, 'applied, but no call the fault breaks happened inside its window: hold it longer than the recorder\'s interval for that call')); continue }
    const counter = FAULT_COUNTERS[f.kind]
    if (counter === undefined) { checks.push(check(name, NV, `unknown fault kind ${f.kind}`)); continue }
    if (counter === null) { checks.push(check(name, num(f.hits) > 0 ? PASS : NV, num(f.hits) > 0 ? `applied to ${f.hits} call(s) (${f.note || 'no counter expected'})` : 'applied, but the driver reported no calls it met', { moved: f.moved ?? null })); continue }
    const moved = num(f.moved?.[counter])
    if (moved == null) checks.push(check(name, NV, `the driver did not report ${counter} across the fault window`))
    else if (moved > 0 && NOT_A_SPACE_FAULT.includes(f.kind) && f.stateAtEnd === 'PAUSED_RESERVE') checks.push(check(name, FAIL, `${counter} +${moved}, but the recorder ended the fault PAUSED_RESERVE: the ${f.kind} fault is reported as a free-space pause${num(f.moved?.pausedDrops) > 0 ? ` and ${f.moved.pausedDrops} event(s) were counted as reserve refusals` : ''}`, { moved: f.moved, hits: f.hits ?? null, stateAtEnd: f.stateAtEnd }))
    else checks.push(check(name, moved > 0 ? PASS : FAIL, moved > 0 ? `${counter} +${moved} during the fault` : `the fault was applied${num(f.hits) > 0 ? ` and failed ${f.hits} call(s)` : ''}, and ${counter} did not move: the recorder did not count it`, { moved: f.moved, hits: f.hits ?? null }))
  }
  const unacc = num(fin.unaccountedLoss)
  checks.push(check('driverAccounting', unacc == null ? NV : unacc === 0 ? PASS : FAIL, unacc == null ? 'the driver reported no loss accounting' : unacc === 0 ? 'no loss the recorder did not count' : `${unacc} record(s) lost with no counter accounting for them`))
  return { step: 'soak', sourceSha256: report.sourceSha256 ?? null, ...fold('P8d recorder soak', checks) }
}

// ---------------------------------------------------------------------------
// T5 — the final report
// ---------------------------------------------------------------------------

export const FINAL_STEPS = Object.freeze(['T0', 'T1', 'T1b', 'T2', 'T3', 'T4', 'soak'])

/**
 * T5. `steps` maps a step to its evaluator result. `rollback` is
 * { rehearsed, evidence, deployments, owner }: a list of Railway deployment
 * ids alone is NOT a rollback PASS (rev-3:490 needs rollback evidenced).
 * `cost` is { monthlyUsd, ceilingUsd, readBy, at }, read by the owner from
 * Railway usage (the app cannot see billing).
 */
export function finalReport({ steps = {}, rollback = null, cost = null, generatedAtMs = Date.now() } = {}) {
  const checks = []
  for (const s of FINAL_STEPS) {
    const r = steps[s]
    checks.push(r ? check(s, r.verdict, r.reason) : check(s, NV, 'not run'))
  }
  if (!rollback) checks.push(check('rollback', NV, 'no rollback record'))
  else if (rollback.rehearsed === true && !empty(rollback.evidence)) checks.push(check('rollback', PASS, `rehearsed: ${rollback.evidence}`, { deployments: rollback.deployments ?? null, owner: rollback.owner ?? null }))
  else checks.push(check('rollback', NV, `${rollback.deployments ? `${Object.keys(rollback.deployments).length} deployment id(s) recorded` : 'no deployment ids'}, not rehearsed: a list of ids is not a rollback`, { deployments: rollback.deployments ?? null, owner: rollback.owner ?? null }))
  if (!cost || num(cost.monthlyUsd) == null) checks.push(check('cost', NV, 'no monthly cost read by the owner from Railway usage'))
  else if (num(cost.ceilingUsd) == null) checks.push(check('cost', NV, `${cost.monthlyUsd} USD a month read by ${cost.readBy ?? '?'}; no ceiling set`))
  else checks.push(check('cost', cost.monthlyUsd <= cost.ceilingUsd ? PASS : FAIL, `${cost.monthlyUsd} USD a month against a ${cost.ceilingUsd} USD ceiling (read by ${cost.readBy ?? '?'} at ${cost.at ?? '?'})`))
  return { step: 'T5', evaluatorVersion: EVALUATOR_VERSION, generatedAt: iso(generatedAtMs), ...fold('V3 P8 final acceptance', checks), steps }
}
