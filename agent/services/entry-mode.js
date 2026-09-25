// ---------------------------------------------------------------------------
// agent/services/entry-mode.js — the per-account entry engine: which family
// of automatic producer may open NEW RISK on an account right now.
//
// Phase P1b of docs/tick-momentum/plan.md (§2 the account record, §3 start /
// stop / switch, §13 every producer rejects a stale mode at the final
// admission boundary; blockers B11, B13; register rows TM-06, TM-10, TM-11,
// TM-16, TM-39). 11-09-2026.
//
// THE RECORD is lib/entry-contracts.js's EngineStatus, one per account, in
// agent_state under `acct:<id>:engine_status_json`. An account with no record
// is TIME_BASED with tick observation OFF (defaultEngineStatus) — the plan's
// "adding the feature does not stop today's time strategies or enable tick
// orders". A read never writes; only requestEntryMode() does.
//
// THE FENCE is admitEntry(): every automatic producer calls it before it
// places, and exec-engine.placeOrder() calls it AGAIN through
// creds.entryAdmission immediately before dispatch, so a producer that
// forgot the first call is still refused at the last Node boundary. Manual
// orders (the manual and manual_assisted families) are admitted under every
// mode: plan §3, a manual order is labelled MANUAL and keeps its own risk
// authority; it is never a hidden automatic fallback, and the emergency
// halt (exec guard) still binds it.
//
// WHAT THE FENCE ADMITS IS THE BASES, not the mode string (PR-3, WP-A
// 25-09-2026): basesFor() below is the admitted set — `admittedBases` when
// set, else the mode's own basis — so TIME_BASED + ['bar','tick'] ("time +
// tick") admits tick producers exactly as TICK_MOMENTUM does, and every
// writer gates ANY target that admits tick (the mode or the set) on the
// injected readiness and the contract's evidence (a pinned profile and
// SHADOW_PASSED) before anything is written. An active mode (TIME_BASED or
// TICK_MOMENTUM, with or without a set) takes effect only when the gateway
// echoes the new epoch (WARMING → STABLE, acknowledgeEntryEpochs); STOPPED
// takes effect at once. P1c (entry-drain.js, 11-09-2026): a switch to
// STOPPED with resting entry orders enters QUIESCING; the drain cancels them
// by stored id and settles RECONCILING → STABLE on the broker's word.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import { getState, setState } from '../db.js'
import { getAccountState, setAccountState } from './account-registry.js'
import { recordDecision } from './decision-log.js'
import { recordProducerRetired } from './gate-skips.js'
import { ENTRY_MODES, OBSERVATION_MODES, ENTRY_MODE_POLICIES, SIGNAL_BASES, defaultEngineStatus, validateEngineStatus } from '../lib/entry-contracts.js'
import { ENTRY_PRODUCERS } from '../lib/entry-producers.js'
// P2a: the intent ledger (a function-only cycle: entry-ledger imports the
// fence from here; nothing on either side runs at module load).
import { releaseOldEpoch, releaseRemovedBases, intentCounts } from './entry-ledger.js'
import { DEFAULT_GAP_MS } from './opportunity-identity.js'

export const ENGINE_STATUS_KEY = 'engine_status_json'

const MODE_BASIS = Object.freeze({ TIME_BASED: 'bar', TICK_MOMENTUM: 'tick', STOPPED: null })

/**
 * PR-3 (dual-basis arbitration, 21-09-2026): the signal bases an account
 * admits right now. `admittedBases` on the record, when set, is the whole
 * answer; null is the mode's own basis — the one-mode behaviour of before,
 * byte for byte. STOPPED admits nothing whatever the overlay says: the
 * overlay widens WHICH producers an active engine admits, it is not a way
 * past the stop. Every reader of "is this account a tick account" asks this
 * (admitEntry, the tick permit feeder, the guard sync's placing list) so the
 * two pushes cannot disagree.
 */
export function basesFor(st) {
  if (!st || st.effectiveEntryMode === 'STOPPED') return []
  if (Array.isArray(st.admittedBases) && st.admittedBases.length) return [...st.admittedBases]
  const b = MODE_BASIS[st.effectiveEntryMode]
  return b ? [b] : []
}

function environmentOf(db, accountId) {
  try {
    const row = db.prepare('SELECT is_live FROM accounts WHERE account_id = ?').get(String(accountId))
    if (row) return Number(row.is_live) === 1 ? 'live' : 'demo'
  } catch { /* no registry */ }
  return 'demo'
}

function countResting(db, accountId) {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM pending_orders WHERE status = 'working' AND account_id = ?`).get(String(accountId))?.n ?? 0
  } catch { return 0 }
}

/**
 * PR-B (owner principle 1): the ladder lost its environment tier. A record
 * written before that with the demo-only stage or the typed live approval
 * reads as TRADED_PASSED — both meant "this account's own tick trades were
 * judged good enough", which is what TRADED_PASSED now means for every
 * account. Read-side only: the stored text is rewritten on the next write.
 */
const LEGACY_STAGE_ALIASES = Object.freeze({ DEMO_PASSED: 'TRADED_PASSED', LIVE_APPROVED: 'TRADED_PASSED' })
export function normaliseLegacyStage(status) {
  const alias = LEGACY_STAGE_ALIASES[status?.validationStage]
  return alias ? { ...status, validationStage: alias } : status
}

/** The account's engine record; a missing or invalid record reads as the
 *  fully-OFF default and is NOT written back (a read never writes). */
export function engineStatusFor(db, accountId) {
  const id = String(accountId)
  const environment = environmentOf(db, id)
  let stored = null
  try { stored = JSON.parse(getAccountState(db, id, ENGINE_STATUS_KEY) || 'null') } catch { stored = null }
  if (stored && typeof stored === 'object') {
    stored = normaliseLegacyStage(stored)
    const v = validateEngineStatus(stored)
    // PR-G: a record written before the policy existed reads as `manual` —
    // the bot is never handed an account by omission.
    if (v.ok) return { ...stored, entryModePolicy: ENTRY_MODE_POLICIES.includes(stored.entryModePolicy) ? stored.entryModePolicy : 'manual', admittedBases: Array.isArray(stored.admittedBases) ? stored.admittedBases : null, invalid: undefined }
    return { ...defaultEngineStatus({ accountId: id, environment }), stored: false, invalid: v.errors }
  }
  return { ...defaultEngineStatus({ accountId: id, environment }), stored: false }
}

/** The only writer of the record: validated, or refused with the reasons. */
export function writeEngineStatus(db, status) {
  const { stored, invalid, ...clean } = status // eslint-disable-line no-unused-vars
  const v = validateEngineStatus(clean)
  if (!v.ok) throw new Error(`engine status invalid: ${v.errors.join('; ')}`)
  setAccountState(db, clean.accountId, ENGINE_STATUS_KEY, JSON.stringify(clean))
  return clean
}

/**
 * PR-G: the bot's per-account memory for the automatic switch
 * (acct:<id>:entry_mode_auto_json). Lives here, not in entry-mode-auto.js,
 * because the HUMAN's switch must write it too (the checker's C-1 / A-1
 * counterexamples: a human's TIME_BASED was re-promoted on the next pass
 * from a streak the hold cycles had kept growing). readyStreak: consecutive
 * ready evaluations; lastEval / lastAction: what the pass last did;
 * humanOverride: { mode, at, epoch } — the human's last switch, past which
 * the bot never promotes until the human acts again or the cooldown lapses;
 * blockedCycles: passes seen BLOCKED under the bot's own epoch.
 */
export const AUTO_STATE_KEY = 'entry_mode_auto_json'
const EMPTY_AUTO_STATE = Object.freeze({ readyStreak: 0, lastEval: null, lastAction: null, humanOverride: null, blockedCycles: 0 })
export function readAutoState(db, accountId) {
  try {
    const st = JSON.parse(getAccountState(db, String(accountId), AUTO_STATE_KEY) || 'null')
    if (st && typeof st === 'object') {
      return { readyStreak: Number(st.readyStreak) || 0, lastEval: st.lastEval ?? null, lastAction: st.lastAction ?? null, humanOverride: st.humanOverride ?? null, blockedCycles: Number(st.blockedCycles) || 0 }
    }
  } catch { /* fall through */ }
  return { ...EMPTY_AUTO_STATE }
}
export function writeAutoState(db, accountId, st) {
  const clean = { ...EMPTY_AUTO_STATE, ...st }
  setAccountState(db, String(accountId), AUTO_STATE_KEY, JSON.stringify(clean))
  return clean
}

/**
 * PR-3 / WP-A: the shape rules of an admitted set, shared by both writers
 * (requestAdmittedBases and requestEntryMode). An array of SIGNAL_BASES, no
 * duplicates, never empty — or null for the mode's own basis. Asked FIRST,
 * before anything reads the set (a non-array must not reach `.includes`).
 */
function admittedBasesShapeRefusal(cur, want) {
  if (want == null) return null
  if (!Array.isArray(want)) return { ok: false, reason: 'admitted_bases_invalid: an array of bases or null', current: cur.configRevision }
  const { stored, invalid, ...clean } = cur // eslint-disable-line no-unused-vars
  const probe = validateEngineStatus({ ...clean, admittedBases: want })
  const errs = probe.errors.filter(e => e.startsWith('admittedBases'))
  if (errs.length) return { ok: false, reason: `admitted_bases_invalid: ${errs.join('; ')}`, current: cur.configRevision }
  for (const b of want) if (!SIGNAL_BASES.includes(b)) return { ok: false, reason: `admitted_bases_invalid: '${b}' not in [${SIGNAL_BASES.join(', ')}]`, current: cur.configRevision }
  return null
}

/**
 * PR-3 / WP-A: the contract's evidence rules (entry-contracts.js: a pinned
 * profile and SHADOW_PASSED while tick is admitted) asked as a REFUSAL, on
 * the record the write — or, for a mode switch, the ACK — will produce, so
 * a record the contract would reject is never stored to fail later inside
 * writeEngineStatus. Only the evidence and set errors count here; the
 * transition rules belong to the write itself.
 */
function evidenceRefusal(cur, shape, label) {
  const { stored, invalid, ...clean } = cur // eslint-disable-line no-unused-vars
  const full = validateEngineStatus({ ...clean, ...shape })
  const errs = full.errors.filter(e => e.startsWith('profileHash') || e.startsWith('validationStage') || e.startsWith('admittedBases'))
  if (!errs.length) return null
  return { ok: false, reason: `${label}: ${errs.join('; ')}`, current: cur.configRevision, errors: errs }
}

/** The readiness gate, one body for both writers. Null when ready. */
function readinessRefusal(db, id, cur, readiness, what) {
  if (typeof readiness !== 'function') return { ok: false, reason: `tick_readiness_unavailable: ${what} needs the readiness check the route supplies`, current: cur.configRevision }
  let rd = null
  try { rd = readiness(db, id) } catch (err) { return { ok: false, reason: `tick_readiness_error: ${err?.message || err}`, current: cur.configRevision } }
  if (!rd || rd.ready !== true) {
    const blocked = Array.isArray(rd?.blockedReasons) && rd.blockedReasons.length ? rd.blockedReasons.join(', ') : 'readiness did not report ready'
    return { ok: false, reason: `tick_not_ready: ${blocked}`, current: cur.configRevision, blockedReasons: rd?.blockedReasons || [] }
  }
  return null
}

/**
 * Owner-facing mode change. Refuses a stale revision; refuses any target
 * that admits tick unless readiness is clean and the evidence is pinned;
 * otherwise bumps configRevision and modeEpoch and waits for the gateway's
 * echo (WARMING → STABLE).
 *
 * WP-A (dual admission, 25-09-2026): `admittedBases` may ride on the switch
 * — one request sets the mode AND its bases (TIME_BASED + ['bar','tick'] is
 * "time + tick") and gets the whole ack protocol. Omitted (undefined) or
 * null is the mode's own basis, exactly as before. The set must contain the
 * mode's own basis (TIME_BASED ⇒ bar, TICK_MOMENTUM ⇒ tick) and STOPPED
 * takes none.
 */
export function requestEntryMode(db, accountId, mode, { expectedRevision = null, actor = 'owner', now = new Date(), readiness = null, detail = null, admittedBases = undefined } = {}) {
  const id = String(accountId)
  if (!ENTRY_MODES.includes(mode)) return { ok: false, reason: `unknown_mode: ${mode}` }
  const cur = engineStatusFor(db, id)
  if (expectedRevision != null && Number(expectedRevision) !== cur.configRevision) {
    return { ok: false, reason: 'revision_conflict', current: cur.configRevision, expected: Number(expectedRevision) }
  }
  // PR-G (owner principle 2): the bot's own pass (actor `auto:*`) may throw
  // the switch only on an account whose policy is `auto`. A `manual` account
  // is the human's alone — refused here, at the one writer, so no automatic
  // caller can route around it.
  if (String(actor).startsWith('auto:') && cur.entryModePolicy !== 'auto') {
    return { ok: false, reason: 'policy_manual', current: cur.configRevision, policy: cur.entryModePolicy }
  }
  // WP-A: the set's SHAPE is checked before anything reads it — a malformed
  // body is a 400 with a named reason, never a TypeError.
  const want = admittedBases === undefined ? null : admittedBases
  const shape = admittedBasesShapeRefusal(cur, want)
  if (shape) return shape
  if (want != null) {
    if (mode === 'STOPPED') return { ok: false, reason: 'admitted_bases_invalid: STOPPED admits nothing', current: cur.configRevision }
    // The review's B1: a set without the mode's own basis (TICK_MOMENTUM +
    // ['bar']) would skip the readiness gate below yet be stored as
    // TICK_MOMENTUM, and the ack would then write an effective tick mode
    // the contract refuses. Refused here, in the writer.
    if (!want.includes(MODE_BASIS[mode])) return { ok: false, reason: `admitted_bases_invalid: ${mode} must admit its own basis '${MODE_BASIS[mode]}'`, current: cur.configRevision }
  }
  const after = mode === 'STOPPED' ? [] : (want ?? basesFor({ effectiveEntryMode: mode, admittedBases: null }))
  // P6b (plan §3 P6b): a target that admits TICK — TICK_MOMENTUM, or any
  // mode whose set carries 'tick' — is admitted ONLY on an account whose
  // readiness (tick-readiness.js: registry, halt, record, horizon,
  // observation, recorder, disk, feed, pinned profile, replay evidence,
  // validation stage) is clean at the moment of the request. The readiness
  // function is injected by the route so this module stays free of the
  // sidecar's status tables; a caller that passes none is refused — there
  // is no unchecked path into tick trading.
  //
  // PR-B (owner principle 1, 11-09-2026): readiness is the ONLY gate. The
  // environment test that used to sit here (`tick_live_refused`, demo only
  // until a typed live approval) is gone — an account is only how much is
  // inside it, and the evidence bar is the same on every account.
  if (mode === 'TICK_MOMENTUM' || after.includes('tick')) {
    const refused = readinessRefusal(db, id, cur, readiness, mode === 'TICK_MOMENTUM' ? 'TICK_MOMENTUM' : 'admitting tick')
    if (refused) return refused
  }
  // WP-A (review B1): the evidence rules asked on the record the ACK will
  // write (requested = effective = mode, STABLE, this set) — asked AFTER the
  // readiness gate so the reason a caller sees is the readiness one when both
  // would refuse, and BEFORE releaseOldEpoch so a refusal writes and
  // releases nothing.
  const evidence = evidenceRefusal(cur, { requestedEntryMode: mode, effectiveEntryMode: mode, transitionState: 'STABLE', admittedBases: want }, want != null ? 'admitted_bases_refused' : 'tick_evidence_refused')
  if (evidence) return evidence
  const resting = countResting(db, id)
  const nextEpoch = cur.modeEpoch + 1
  // P2a (plan §3 step 1): RESERVED intents of the old epoch are never sent;
  // DISPATCHING / SENT ones stay in flight (step 2) and UNKNOWN ones keep the
  // state RECONCILING (step 4) until the broker's evidence resolves them.
  // WP-A RISK (named, not fixed here): adding or removing tick now bumps the
  // epoch too, so EVERY add/remove of tick releases every RESERVED intent of
  // the old epoch — bar and manual ones included, not only tick's — and bar
  // entries pause through WARMING for the push round trip. That is the
  // mode-switch behaviour applied to dual toggles; the overlay-only path
  // (requestAdmittedBases) releases only the removed basis.
  let ledger = { unsent: 0, inFlight: 0, unknown: 0 }
  try { releaseOldEpoch(db, id, nextEpoch, { now: now.getTime() }); ledger = intentCounts(db, id) } catch { /* ledger table absent on an old schema */ }
  const unknown = Math.max(cur.entryCounts.unknown, ledger.unknown)
  // P1c: STOPPED with resting entry orders enters QUIESCING — entry-drain.js
  // cancels them by stored id and settles the state on the broker's word.
  //
  // AUDIT 11-09-2026 (plan §3.4 / §3.6, register TM-14 / TM-10): the
  // EFFECTIVE mode is no longer the requested one written in the same
  // breath. STOPPED takes effect at once — the Node fence (admitEntry) is
  // the thing that stops entries, and it reads this record. An ACTIVE mode
  // (TIME_BASED, TICK_MOMENTUM) takes effect only when (1) no entry outcome
  // is UNKNOWN — an unknown outcome prevents activation of the new engine —
  // and (2) the gateway has acknowledged the new epoch: the sidecar echoes
  // it on the push (acknowledgeEntryEpochs), and until then the state is
  // WARMING with new automatic entries stopped; a failed push is BLOCKED
  // (markEntryModeBlocked), never a silent fall-back to time trading.
  const active = mode !== 'STOPPED'
  const transitionState = mode === 'STOPPED' && resting > 0 ? 'QUIESCING'
    : unknown > 0 ? 'RECONCILING'
    : active ? 'WARMING' : 'STABLE'
  const next = {
    ...cur,
    requestedEntryMode: mode,
    effectiveEntryMode: active ? 'STOPPED' : mode, // active modes wait for the ack
    transitionState,
    configRevision: cur.configRevision + 1,
    modeEpoch: nextEpoch,
    // WP-A: a mode switch is a fresh declaration of its bases — the set
    // given with it (gated above), or null for the mode's own basis. An old
    // overlay never rides across a switch that does not restate it. (The old
    // epoch's RESERVED rows of every basis were released just above.)
    admittedBases: want == null ? null : [...want],
    // The ack is the sidecar's echo of THIS epoch, not our own write. Kept
    // as it was until then, so a reader can see the fence is not yet bound.
    fenceAckEpoch: cur.fenceAckEpoch,
    entryCounts: { unsent: ledger.unsent, inFlight: ledger.inFlight, resting, unknown },
    updatedAt: now.toISOString(),
  }
  const saved = writeEngineStatus(db, next)
  try {
    db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
      .run('POST', '/actions/entry-mode', JSON.stringify({ accountId: id, from: cur.effectiveEntryMode, to: mode, bases: { from: basesFor({ ...cur, effectiveEntryMode: cur.requestedEntryMode }), to: after }, revision: saved.configRevision, epoch: saved.modeEpoch, resting: saved.entryCounts.resting, transition: saved.transitionState, actor, ...(detail && typeof detail === 'object' ? { detail } : {}) }), id)
  } catch { /* audit best-effort */ }
  // PR-G: a HUMAN's switch zeroes the bot's streak and is remembered as an
  // override — the pass never promotes past it until the human acts again
  // or the cooldown lapses (entry-mode-auto.js). The bot's own switches
  // leave the streak to the pass.
  if (!String(actor).startsWith('auto:')) {
    try { writeAutoState(db, id, { ...readAutoState(db, id), readyStreak: 0, blockedCycles: 0, humanOverride: { mode, bases: after, at: now.toISOString(), epoch: saved.modeEpoch, actor: String(actor) } }) } catch { /* memory best-effort */ }
  }
  const changed = cur.requestedEntryMode !== mode || cur.effectiveEntryMode !== saved.effectiveEntryMode ||
    JSON.stringify(cur.admittedBases ?? null) !== JSON.stringify(saved.admittedBases ?? null)
  return { ok: true, status: saved, changed, bases: after }
}

/**
 * PR-3 (dual-basis arbitration, 21-09-2026): set — or clear with null — the
 * bases the account admits on top of its mode. The ONLY writer of
 * `admittedBases`, reached through POST /actions/entry-mode (the route that
 * carries ENTRY_MODE_POLICIES) with `expectedRevision`; bumps
 * configRevision, never modeEpoch — the fence's epoch names a mode change,
 * and this is not one. Rules, in order: the revision check; the PR-G actor
 * policy; the set validated by the contract (SIGNAL_BASES only, no
 * duplicates, never empty); ADDING 'tick' to what the account admits today
 * (basesFor) passes the SAME readiness predicate that gates a promotion to
 * TICK_MOMENTUM — a not-ready account cannot get ['tick'] or ['bar','tick'],
 * with or without a readiness function; a basis REMOVED has its RESERVED
 * intents released now (`basis_withdrawn`, releaseRemovedBases), not left
 * for the sidecar to spend.
 */
export function requestAdmittedBases(db, accountId, bases, { expectedRevision = null, actor = 'owner', now = new Date(), readiness = null } = {}) {
  const id = String(accountId)
  const cur = engineStatusFor(db, id)
  if (cur.invalid) return { ok: false, reason: 'engine_record_invalid', current: cur.configRevision }
  if (expectedRevision != null && Number(expectedRevision) !== cur.configRevision) {
    return { ok: false, reason: 'revision_conflict', current: cur.configRevision, expected: Number(expectedRevision) }
  }
  if (String(actor).startsWith('auto:') && cur.entryModePolicy !== 'auto') {
    return { ok: false, reason: 'policy_manual', current: cur.configRevision, policy: cur.entryModePolicy }
  }
  const want = bases == null ? null : bases
  const shape = admittedBasesShapeRefusal(cur, want)
  if (shape) return shape
  const before = basesFor(cur)
  const after = want == null ? basesFor({ ...cur, admittedBases: null }) : want
  if (after.includes('tick') && !before.includes('tick')) {
    const refused = readinessRefusal(db, id, cur, readiness, 'admitting tick')
    if (refused) return refused
  }
  // PR-3 (checker, 21-09-2026): the contract's own evidence rules bind the
  // admitted set too (entry-contracts.js: a pinned profile and SHADOW_PASSED
  // while tick is admitted). Asked AFTER the readiness gate so the reason a
  // caller sees is the readiness one when both would refuse, and asked as a
  // refusal rather than left to writeEngineStatus's throw.
  if (want != null) {
    const evidence = evidenceRefusal(cur, { admittedBases: want }, 'admitted_bases_refused')
    if (evidence) return evidence
  }
  const removed = before.filter(b => !after.includes(b))
  let released = 0
  if (removed.length) { try { released = releaseRemovedBases(db, id, removed, { now: now.getTime() }).released } catch { /* ledger table absent */ } }
  const next = { ...cur, admittedBases: want == null ? null : [...want], configRevision: cur.configRevision + 1, updatedAt: now.toISOString() }
  const saved = writeEngineStatus(db, next)
  try {
    db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
      .run('POST', '/actions/entry-mode', JSON.stringify({ accountId: id, admittedBases: { from: cur.admittedBases ?? null, to: saved.admittedBases ?? null }, effective: { from: before, to: basesFor(saved) }, released, revision: saved.configRevision, epoch: saved.modeEpoch, actor }), id)
  } catch { /* audit best-effort */ }
  // WP-A (PR-G C-1): a HUMAN's change of the admitted set binds the bot's
  // pass the way a mode switch does — the streak is zeroed and the override
  // records the bases the human chose, so the pass never re-adds (or keeps
  // re-adding) tick past the human's word inside the cooldown.
  if (!String(actor).startsWith('auto:')) {
    try { writeAutoState(db, id, { ...readAutoState(db, id), readyStreak: 0, blockedCycles: 0, humanOverride: { mode: saved.requestedEntryMode, bases: basesFor({ ...saved, effectiveEntryMode: saved.requestedEntryMode }), at: now.toISOString(), epoch: saved.modeEpoch, actor: String(actor) } }) } catch { /* memory best-effort */ }
  }
  const changed = JSON.stringify(cur.admittedBases ?? null) !== JSON.stringify(saved.admittedBases ?? null)
  return { ok: true, status: saved, changed, bases: basesFor(saved), removed, released }
}

/**
 * AUDIT 11-09-2026 (plan §3.6): the gateway's acknowledgement. Called with
 * the sidecar's echoed entry epochs — from the push's own response and from
 * every probe's reported guard. An account whose echoed epoch equals its
 * modeEpoch has its fence bound (fenceAckEpoch); one that was WARMING (or
 * BLOCKED after a failed push) with no unknown entry becomes STABLE with the
 * requested mode effective. Anything else is left alone: the ack never
 * settles a drain or a reconcile — the broker's evidence does (entry-drain).
 * Returns the accounts that changed.
 */
export function acknowledgeEntryEpochs(db, epochs, { now = new Date(), source = 'probe' } = {}) {
  const changed = []
  if (!epochs || typeof epochs !== 'object') return changed
  for (const [rawId, rawEpoch] of Object.entries(epochs)) {
    // WP-A (review): one bad record must not stop every later account's
    // fence from binding — a dual record re-validates its evidence at this
    // write, and a throw here used to leave the loop (swallowed upstream by
    // syncExecGuard), so every account after it in the echoed map stayed
    // WARMING. Logged and skipped instead.
    try {
      const id = String(rawId), epoch = Number(rawEpoch)
      if (!Number.isFinite(epoch)) continue
      const cur = engineStatusFor(db, id)
      if (cur.invalid || cur.stored === false) continue        // nothing requested here, nothing to bind
      if (epoch !== cur.modeEpoch) continue                    // an older epoch echoed: the fence is not bound yet
      if (cur.fenceAckEpoch === epoch && cur.transitionState !== 'WARMING' && cur.transitionState !== 'BLOCKED') continue
      let unknown = cur.entryCounts.unknown
      try { unknown = Math.max(unknown, intentCounts(db, id).unknown) } catch { /* ledger absent */ }
      const next = { ...cur, fenceAckEpoch: epoch, updatedAt: now.toISOString() }
      if ((cur.transitionState === 'WARMING' || cur.transitionState === 'BLOCKED') && unknown === 0) {
        next.transitionState = 'STABLE'
        next.effectiveEntryMode = cur.requestedEntryMode
      } else if (cur.transitionState === 'BLOCKED') {
        next.transitionState = 'RECONCILING'                   // the fence is bound; the unknown still holds activation
      }
      const saved = writeEngineStatus(db, next)
      changed.push({ accountId: id, epoch, transitionState: saved.transitionState, effectiveEntryMode: saved.effectiveEntryMode })
      try {
        db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
          .run('ACK', '/entry-mode/ack', JSON.stringify({ accountId: id, epoch, source, transition: saved.transitionState, effective: saved.effectiveEntryMode }), id)
      } catch { /* audit best-effort */ }
    } catch (err) {
      console.warn(`[entry-mode] ack …${String(rawId).slice(-4)} skipped: ${err?.message || err}`)
      // Checker nit 6 (WP-A follow-up, 25-09-2026): the skip is VISIBLE, not
      // only a console line — the account stays WARMING, and without this
      // row nothing on record says the echo DID arrive and was refused (the
      // panel would keep saying "until the executor echoes epoch N"). One
      // ACK_REFUSED row per refused echo, naming the contract's reason.
      try {
        db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
          .run('ACK_REFUSED', '/entry-mode/ack', JSON.stringify({ accountId: String(rawId), epoch: Number(rawEpoch), source, reason: String(err?.message || err).slice(0, 300) }), String(rawId))
      } catch { /* audit best-effort */ }
    }
  }
  return changed
}

/**
 * AUDIT 11-09-2026 (plan §3.6): the push to the gateway failed. The account
 * stays visibly BLOCKED with new automatic entries stopped until a later
 * push (the probe's convergence) is acknowledged — never a silent fall-back.
 */
export function markEntryModeBlocked(db, accountId, reason, { now = new Date() } = {}) {
  const id = String(accountId)
  const cur = engineStatusFor(db, id)
  if (cur.invalid) return { ok: false, reason: 'engine_record_invalid' }
  if (cur.fenceAckEpoch === cur.modeEpoch && cur.transitionState === 'STABLE') return { ok: true, status: cur, changed: false } // already bound: nothing to block
  const saved = writeEngineStatus(db, { ...cur, transitionState: 'BLOCKED', effectiveEntryMode: 'STOPPED', updatedAt: now.toISOString() })
  try {
    db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
      .run('BLOCK', '/entry-mode/blocked', JSON.stringify({ accountId: id, epoch: cur.modeEpoch, requested: cur.requestedEntryMode, reason: String(reason).slice(0, 300) }), id)
  } catch { /* audit best-effort */ }
  return { ok: true, status: saved, changed: true }
}

/**
 * P3a: the per-account tick OBSERVATION switch (plan §2 `tick_observation`:
 * OFF | RECORD | SHADOW). RECORD asks the account's sidecar to record the
 * feed it carries (exec-guard-sync.js derives the side's `tickRecord` from
 * it); it changes no entry authority — the mode epoch is untouched, only
 * configRevision moves. SHADOW (admitted since P4) runs the strategy on the
 * sidecar's workers, signalling only. Observation can run while time entries
 * continue.
 */
export function requestTickObservation(db, accountId, mode, { expectedRevision = null, actor = 'owner', now = new Date() } = {}) {
  const id = String(accountId)
  if (!OBSERVATION_MODES.includes(mode)) return { ok: false, reason: `unknown_observation_mode: ${mode}` }
  const cur = engineStatusFor(db, id)
  if (expectedRevision != null && Number(expectedRevision) !== cur.configRevision) {
    return { ok: false, reason: 'revision_conflict', current: cur.configRevision, expected: Number(expectedRevision) }
  }
  // P4: SHADOW is admitted — tick_momentum_breakout v1 exists (cpp-exec
  // tick_strategy.*, reference agent/lib/tick-strategy.js) and runs on the
  // sidecar's workers signalling into the decision ring, placing nothing;
  // the exec guard sync pushes the side's tickShadow switch.
  const next = { ...cur, tickObservation: mode, configRevision: cur.configRevision + 1, updatedAt: now.toISOString() }
  const saved = writeEngineStatus(db, next)
  try {
    db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
      .run('POST', '/actions/tick-observation', JSON.stringify({ accountId: id, from: cur.tickObservation, to: mode, revision: saved.configRevision, actor }), id)
  } catch { /* audit best-effort */ }
  return { ok: true, status: saved, changed: cur.tickObservation !== mode }
}

/**
 * PR-G (owner principle 2): the per-account switch POLICY — `manual` (a
 * human throws the entry-mode switch) or `auto` (the bot's readiness pass
 * may throw it too, as actor `auto:readiness`). Changes no mode and no
 * epoch: only configRevision moves, so a stale caller is still refused.
 */
export function requestEntryModePolicy(db, accountId, policy, { expectedRevision = null, actor = 'owner', now = new Date() } = {}) {
  const id = String(accountId)
  const want = String(policy).toLowerCase()
  if (!ENTRY_MODE_POLICIES.includes(want)) return { ok: false, reason: `unknown_policy: ${policy}` }
  const cur = engineStatusFor(db, id)
  if (expectedRevision != null && Number(expectedRevision) !== cur.configRevision) {
    return { ok: false, reason: 'revision_conflict', current: cur.configRevision, expected: Number(expectedRevision) }
  }
  const next = { ...cur, entryModePolicy: want, configRevision: cur.configRevision + 1, updatedAt: now.toISOString() }
  const saved = writeEngineStatus(db, next)
  // A policy change is the human acting: the bot starts from a clean memory
  // (no streak, no override, no blocked count) under the new policy.
  if (cur.entryModePolicy !== want) { try { writeAutoState(db, id, {}) } catch { /* memory best-effort */ } }
  try {
    db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
      .run('POST', '/actions/entry-mode-policy', JSON.stringify({ accountId: id, from: cur.entryModePolicy, to: want, revision: saved.configRevision, actor }), id)
  } catch { /* audit best-effort */ }
  return { ok: true, status: saved, changed: cur.entryModePolicy !== want }
}

/**
 * PR-G: the owner's switch-policy declaration from the repo
 * (config/entry-mode-policy.json), applied ONCE per file content on the
 * tick-observation seed's rule: `_all` expands to every enabled registry
 * account, a per-id key wins for that id, an account enabled after the file
 * was applied is seeded on its first boot (the `reached` list), and a later
 * change through POST /actions/entry-mode-policy stands until the file
 * changes. State key: entry_mode_policy_seed_json.
 */
export function seedEntryModePolicyFromConfig(db, { file = null, log = () => {} } = {}) {
  const out = { applied: [], unchanged: [], skipped: [], error: null }
  let cfg = null
  try {
    cfg = JSON.parse(readFileSync(file || new URL('../config/entry-mode-policy.json', import.meta.url), 'utf8'))
  } catch (err) {
    out.error = `entry-mode-policy.json unreadable: ${err.message}`
    return out
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { out.error = 'entry-mode-policy.json is not an object'; return out }
  const accounts = cfg.accounts && typeof cfg.accounts === 'object' ? cfg.accounts : {}
  const hash = createHash('sha256').update(JSON.stringify({ accounts })).digest('hex').slice(0, 16)
  let seeded = null
  try { seeded = JSON.parse(getState(db, 'entry_mode_policy_seed_json') || 'null') } catch { seeded = null }
  const hasAll = Object.prototype.hasOwnProperty.call(accounts, '_all')
  const reached = new Set(Array.isArray(seeded?.reached) ? seeded.reached.map(String) : [])
  let entries = expandAllAccounts(db, accounts)
  const sameContent = seeded?.hash === hash
  if (sameContent) {
    for (const [id] of entries) if (!hasAll || reached.has(id)) out.unchanged.push(id)
    entries = hasAll ? entries.filter(([id]) => !reached.has(id)) : []
    if (!entries.length) return out
  } else if (seeded?.accounts && typeof seeded.accounts === 'object') {
    // Changed content: only an id whose DECLARED value changed (its own key,
    // or `_all` when it has no key) is re-applied. An operator's route-set
    // policy on an id whose declaration did not move stands — the checker's
    // finding: hashing the whole map flipped every account on any edit.
    const declared = (map, id) => (Object.prototype.hasOwnProperty.call(map, id) ? String(map[id]) : (Object.prototype.hasOwnProperty.call(map, '_all') ? String(map._all) : null))
    entries = entries.filter(([id, v]) => !reached.has(id) || declared(seeded.accounts, id) !== String(v))
    for (const [id] of expandAllAccounts(db, accounts)) if (!entries.some(([e]) => e === id)) out.unchanged.push(id)
  }
  for (const [accountId, policy] of entries) {
    if (!/^[0-9]+$/.test(accountId)) { out.skipped.push(`${accountId}: malformed id`); continue }
    let known = false
    try { known = !!db.prepare('SELECT 1 FROM accounts WHERE account_id = ?').get(accountId) } catch { known = false }
    if (!known) { out.skipped.push(`…${accountId.slice(-4)}: not in the registry`); continue }
    reached.add(accountId)
    const want = String(policy).toLowerCase()
    const cur = engineStatusFor(db, accountId).entryModePolicy
    if (cur === want) { out.unchanged.push(accountId); continue }
    const r = requestEntryModePolicy(db, accountId, want, { actor: 'config/entry-mode-policy.json' })
    if (r.ok) {
      out.applied.push(`…${accountId.slice(-4)}:${want}`)
      log(`[boot] entry-mode policy …${accountId.slice(-4)}: ${cur} → ${want} (from config/entry-mode-policy.json)`)
    } else {
      out.skipped.push(`…${accountId.slice(-4)}: ${r.reason}`)
    }
  }
  setState(db, 'entry_mode_policy_seed_json', JSON.stringify(sameContent
    ? { ...seeded, reached: [...reached].sort() }
    : { hash, at: new Date().toISOString(), applied: out.applied, accounts, reached: [...reached].sort() }))
  return out
}

/**
 * Expand `_all` in a per-account config map to every ENABLED registry
 * account (PR-B, owner principle 9: setups are for all accounts and not
 * hardcoded). Explicit per-id keys still win over `_all` for that id; other
 * `_`-prefixed keys are the file's own notes. Returns [[accountId, value]].
 */
export function expandAllAccounts(db, map) {
  const entries = map && typeof map === 'object' ? Object.entries(map) : []
  const explicit = entries.filter(([k]) => !k.startsWith('_'))
  const all = entries.find(([k]) => k === '_all')
  if (!all) return explicit
  let ids = []
  try { ids = db.prepare('SELECT account_id FROM accounts WHERE enabled = 1 ORDER BY account_id').all().map(r => String(r.account_id)) } catch { ids = [] }
  const named = new Set(explicit.map(([k]) => k))
  return [...explicit, ...ids.filter(id => !named.has(id)).map(id => [id, all[1]])]
}

/**
 * P3b: the owner's tick-observation declaration from the repo
 * (config/tick-observation.json), applied ONCE per file content — the same
 * rule as the strategy-pin seed: the file is the initial declaration, a
 * later switch through the routes stands across deploys until the file
 * changes. Exists because the bearer token is lost and the routes are the
 * only other way to throw the switch. Never writes the engine record when
 * nothing changes; unknown accounts and refused modes are reported.
 *
 * PR-B: `accounts._all` applies to every enabled registry account. The seed
 * record keeps the ids `_all` has reached, so an account enabled AFTER the
 * file was applied is still seeded on its first boot (the content hash alone
 * would have skipped it), while every account already reached keeps what
 * the operator did since.
 */
export function seedTickObservationFromConfig(db, { file = null, universeFile = null, log = () => {} } = {}) {
  const out = { applied: [], unchanged: [], skipped: [], symbols: null, error: null }
  let cfg = null
  try {
    cfg = JSON.parse(readFileSync(file || new URL('../config/tick-observation.json', import.meta.url), 'utf8'))
  } catch (err) {
    out.error = `tick-observation.json unreadable: ${err.message}`
    return out
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { out.error = 'tick-observation.json is not an object'; return out }
  const content = JSON.stringify({ accounts: cfg.accounts ?? null, symbols: cfg.symbols ?? null })
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
  let seeded = null
  try { seeded = JSON.parse(getState(db, 'tick_observation_seed_json') || 'null') } catch { seeded = null }
  const accounts = cfg.accounts && typeof cfg.accounts === 'object' ? cfg.accounts : {}
  const hasAll = Object.prototype.hasOwnProperty.call(accounts, '_all')
  const reached = new Set(Array.isArray(seeded?.reached) ? seeded.reached.map(String) : [])
  let entries = expandAllAccounts(db, accounts)
  const sameContent = seeded?.hash === hash
  if (sameContent) {
    // Already applied for this content: what the operator did since stands.
    // Under `_all`, only an account the seed has never reached is still due.
    for (const [id] of entries) if (!hasAll || reached.has(id)) out.unchanged.push(id)
    entries = hasAll ? entries.filter(([id]) => !reached.has(id)) : []
    if (!entries.length) return out
  }
  for (const [accountId, mode] of entries) {
    if (!/^[0-9]+$/.test(accountId)) { out.skipped.push(`${accountId}: malformed id`); continue }
    let known = false
    try { known = !!db.prepare('SELECT 1 FROM accounts WHERE account_id = ?').get(accountId) } catch { known = false }
    if (!known) { out.skipped.push(`…${accountId.slice(-4)}: not in the registry`); continue }
    reached.add(accountId)
    const want = String(mode).toUpperCase()
    const cur = engineStatusFor(db, accountId).tickObservation
    if (cur === want) { out.unchanged.push(accountId); continue }
    const r = requestTickObservation(db, accountId, want, { actor: 'config/tick-observation.json' })
    if (r.ok) {
      out.applied.push(`…${accountId.slice(-4)}:${want}`)
      log(`[boot] tick observation …${accountId.slice(-4)}: ${cur} → ${want} (from config/tick-observation.json)`)
    } else {
      out.skipped.push(`…${accountId.slice(-4)}: ${r.reason}`)
    }
  }
  if (sameContent) {
    // A late-joining account under `_all`: record it reached, touch nothing else.
    setState(db, 'tick_observation_seed_json', JSON.stringify({ ...seeded, reached: [...reached].sort() }))
    return out
  }
  let names = null
  if (cfg.symbols === 'momentum-universe') {
    try {
      const u = JSON.parse(readFileSync(universeFile || new URL('../config/momentum-universe.json', import.meta.url), 'utf8'))
      names = []
      for (const [cls, list] of Object.entries(u)) if (!cls.startsWith('_') && Array.isArray(list)) for (const n of list) names.push(String(n))
    } catch (err) { out.skipped.push(`symbols: momentum-universe.json unreadable: ${err.message}`) }
  } else if (Array.isArray(cfg.symbols)) {
    names = cfg.symbols.map(String)
  }
  if (names) {
    names = [...new Set(names.map(n => n.trim().toUpperCase()).filter(n => /^[A-Z0-9._-]{2,24}$/.test(n)))]
    setState(db, 'tick_symbols_json', JSON.stringify(names))
    out.symbols = names.length
  }
  setState(db, 'tick_observation_seed_json', JSON.stringify({ hash, at: new Date().toISOString(), applied: out.applied, symbols: out.symbols, reached: [...reached].sort() }))
  return out
}

// One refusal record per (account, producer, epoch): the loop asks every
// cycle and a decision_log row per cycle is noise, not evidence.
const refusalsSeen = new Map()

// A RETIRED producer's refusal is the retired stack's EVIDENCE, so it is
// deduped on the opportunity's own rule rather than remembered forever: one
// row per setup per opportunity window, which is the gap the ledger already
// uses to decide that a setup re-proposed after a quiet spell is a NEW
// opportunity (services/opportunity-identity.js). A minute of slack past the
// gap keeps two consecutive rows from collapsing back into one opportunity.
// Without a window the first row would be the only row a setup ever wrote —
// which is not "the scan keeps producing evidence", it is one snapshot and
// then silence.
export const RETIRED_REFUSAL_WINDOW_MS = DEFAULT_GAP_MS + 60_000
const RETIRED_SEEN_MAX = 5_000
const retiredSeen = new Map()   // key -> ms of the row last written

function retiredRefusalIsDue(key, nowMs) {
  const last = retiredSeen.get(key)
  if (last != null && nowMs - last < RETIRED_REFUSAL_WINDOW_MS) return false
  // Bounded: the scan's universe times the accounts is small, but a long-
  // lived process must not accumulate keys for symbols that stopped signalling.
  if (retiredSeen.size >= RETIRED_SEEN_MAX) {
    for (const [k, at] of retiredSeen) if (nowMs - at >= 2 * RETIRED_REFUSAL_WINDOW_MS) retiredSeen.delete(k)
  }
  retiredSeen.set(key, nowMs)
  return true
}

/**
 * The fence. Automatic producers are admitted only when the account's
 * effective mode has the producer's basis; manual families always pass here.
 */
export function admitEntry(db, { accountId, producerId, basis = null, proposal = null, now = Date.now() }) {
  const id = accountId != null ? String(accountId) : null
  const producer = ENTRY_PRODUCERS.find(p => p.id === producerId)
  if (!producer) return { ok: false, reason: `unknown_producer: ${producerId}`, modeEpoch: null }
  if (id == null) return { ok: false, reason: 'no_account', modeEpoch: null }
  const st = engineStatusFor(db, id)
  // WP-A (25-09-2026): the basis is the REGISTERED producer's, not a 'bar'
  // default — a caller that names none is admitted under what the producer
  // is, and one that names a different basis is refused below
  // (producer_basis_conflict). Manual families declare no basis.
  const declared = producer.basis ?? null
  const asked = basis ?? declared
  // RETIRED PRODUCERS (owner order 20-09-2026: "retire the intraday paths,
  // keep momentum only"). ONE structural fence, and it is FIRST — before the
  // mode and basis checks, so the reason a reader sees is the true one and
  // not "entry_mode_basis" for a path that is gone whatever the mode says.
  // Marking a producer `retired` in lib/entry-producers.js is therefore
  // sufficient on its own; entry-producers.test.js pins that it cannot
  // silently do nothing. Manual and manual_assisted families are not
  // retired — the owner keeps every hand route.
  if (producer.retired) {
    const reason = `producer_retired: ${producerId} — ${producer.retired}`
    // DEDUPE, the gate_redirect rule: a refusal that is stable for the whole
    // cycle must not write a row per symbol per cycle.
    //
    // WITH a proposal the row is evidence, so it is deduped per setup on the
    // opportunity window (above): one scoreable row per setup per window, not
    // one per loop and not one for all time. WITHOUT a proposal there is
    // nothing to score — those asks come from the producers' own modules, not
    // from the scan — so one row per account / producer / epoch is the whole
    // record, and the refusal ledger skips them for having no levels.
    const key = `retired:${id}:${producerId}:${st.modeEpoch}:${proposal?.symbol ?? '-'}:${proposal?.side ?? '-'}:${proposal?.strategy ?? '-'}`
    const due = proposal ? retiredRefusalIsDue(key, now) : !refusalsSeen.has(key)
    if (due) {
      if (!proposal) refusalsSeen.set(key, true)
      try { recordProducerRetired(db, { accountId: id, producerId, reason, basis: asked, proposal }) } catch { /* best effort */ }
    }
    return { ok: false, reason, retired: true, modeEpoch: st.modeEpoch, mode: st.effectiveEntryMode, family: producer.family }
  }
  if (producer.family !== 'automatic') return { ok: true, reason: null, modeEpoch: st.modeEpoch, mode: st.effectiveEntryMode, family: producer.family, basis: asked }
  const mode = st.effectiveEntryMode
  let reason = null
  // AUDIT 11-09-2026 (plan §3.4): a transition in progress admits nothing
  // automatic — a drain (QUIESCING), an unknown outcome (RECONCILING), an
  // unacknowledged fence (WARMING) or a failed push (BLOCKED) each hold the
  // engine off, and the reason names the state so a reader can tell "stopped
  // by the owner" from "stopped until the broker's evidence arrives".
  //
  // WP-A: a caller that declares a basis other than the registry's is
  // refused FIRST — a tick producer asked as 'bar' must not pass a bar-only
  // account. (Every explicit caller in the repo matches the registry today,
  // so this fires only on a new mislabelled caller.)
  if (basis != null && declared != null && basis !== declared) reason = `producer_basis_conflict: ${producerId} is ${declared}, asked as ${basis}`
  else if (st.transitionState !== 'STABLE') reason = `entry_mode_transition: ${st.transitionState}`
  else if (mode === 'STOPPED') reason = 'entry_mode_stopped'
  else if (!basesFor(st).includes(asked)) reason = `entry_mode_basis: ${mode} admits ${basesFor(st).join('+')} producers, ${producerId} is ${asked}`
  if (reason) {
    const key = `${id}:${producerId}:${st.modeEpoch}`
    if (!refusalsSeen.has(key)) {
      refusalsSeen.set(key, true)
      try { recordDecision(db, { accountId: id, stage: 'entry_mode', decision: 'skip', reason, detail: { producerId, basis: asked, mode, epoch: st.modeEpoch } }) } catch { /* best effort */ }
    }
    return { ok: false, reason, modeEpoch: st.modeEpoch, mode, basis: asked }
  }
  return { ok: true, reason: null, modeEpoch: st.modeEpoch, mode, family: producer.family, basis: asked }
}

/** Test seam: forget the per-epoch refusal dedupe. */
export function _resetRefusalDedupe() { refusalsSeen.clear(); retiredSeen.clear() }

/** Every registry account's record, for GET /state/entry-engines. */
export function entryEnginesView(db, { includeRoutingIdentity = false } = {}) {
  let rows = []
  try { rows = db.prepare('SELECT account_id, is_live, enabled, mode FROM accounts ORDER BY is_live, account_id').all() } catch { rows = [] }
  const accounts = rows.map(r => {
    const st = engineStatusFor(db, r.account_id)
    return {
      accountId: `…${String(r.account_id).slice(-4)}`,
      // Only the authenticated control view opts in; ordinary reports retain
      // their redacted identity. Bind actions to this record, never its suffix.
      ...(includeRoutingIdentity ? { routingAccountId: String(r.account_id) } : {}),
      environment: st.environment,
      registry: { enabled: Number(r.enabled) === 1, mode: r.mode },
      requestedEntryMode: st.requestedEntryMode,
      effectiveEntryMode: st.effectiveEntryMode,
      transitionState: st.transitionState,
      tickObservation: st.tickObservation,
      entryModePolicy: st.entryModePolicy,
      admittedBases: st.admittedBases ?? null,
      bases: basesFor(st),
      validationStage: st.validationStage,
      configRevision: st.configRevision,
      modeEpoch: st.modeEpoch,
      entryCounts: { ...st.entryCounts, resting: countResting(db, r.account_id), ...(() => { try { return intentCounts(db, r.account_id) } catch { return {} } })() },
      stored: st.stored !== false,
      invalid: st.invalid || null,
    }
  })
  return {
    at: new Date().toISOString(),
    accounts,
    note: 'Node producers are fenced by admitEntry (P1b) and the VPO tier by its permits at the sidecar\'s send (P2a); on STOPPED the account\'s resting entry orders are cancelled by stored id and the state settles QUIESCING → RECONCILING → STABLE (P1c); an ACTIVE mode takes effect only after the sidecar echoes the new epoch (WARMING → STABLE) and never while an entry outcome is UNKNOWN (11-09-2026 audit); tick — alone (TICK_MOMENTUM) or beside bar (TIME_BASED with admittedBases [bar, tick]) — is admitted on any account whose readiness (tick-readiness.js) is clean and whose evidence is pinned at the request, with the same bar for demo and live (P6b, PR-B), and only through the route that supplies that check; `bases` is what the Node fence admits now, and the sidecar places tick only for STABLE accounts it is sent in tickEntryAccounts.',
    // No account may be armed by omission: a record that is absent reads OFF.
    globalHalt: (() => { try { return JSON.parse(getState(db, 'exec_guard_json') || '{}')?.halt === true } catch { return false } })(),
  }
}
