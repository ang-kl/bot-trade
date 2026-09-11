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
// WHAT THIS PHASE DOES NOT DO (and says so): the C++ VPO tier is fenced at
// ARMING time (vpo-feeder.js refuses the /vpo-config push for a STOPPED
// account) but not at FIRE time — that is the P2 permit; TICK_MOMENTUM is
// refused outright until the strategy (P4) and its evidence (P6) exist. The
// Node gateway acknowledges STOPPED and TIME_BASED at once because for Node
// producers the fence IS this module, so requested and effective agree
// immediately. P1c (entry-drain.js, 11-09-2026): a switch to STOPPED with
// resting entry orders enters QUIESCING; the drain cancels them by stored id
// and settles RECONCILING → STABLE on the broker's word.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import { getState, setState } from '../db.js'
import { getAccountState, setAccountState } from './account-registry.js'
import { recordDecision } from './decision-log.js'
import { ENTRY_MODES, OBSERVATION_MODES, defaultEngineStatus, validateEngineStatus } from '../lib/entry-contracts.js'
import { ENTRY_PRODUCERS } from '../lib/entry-producers.js'
// P2a: the intent ledger (a function-only cycle: entry-ledger imports the
// fence from here; nothing on either side runs at module load).
import { releaseOldEpoch, intentCounts } from './entry-ledger.js'

export const ENGINE_STATUS_KEY = 'engine_status_json'

const MODE_BASIS = Object.freeze({ TIME_BASED: 'bar', TICK_MOMENTUM: 'tick', STOPPED: null })

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

/** The account's engine record; a missing or invalid record reads as the
 *  fully-OFF default and is NOT written back (a read never writes). */
export function engineStatusFor(db, accountId) {
  const id = String(accountId)
  const environment = environmentOf(db, id)
  let stored = null
  try { stored = JSON.parse(getAccountState(db, id, ENGINE_STATUS_KEY) || 'null') } catch { stored = null }
  if (stored && typeof stored === 'object') {
    const v = validateEngineStatus(stored)
    if (v.ok) return { ...stored, invalid: undefined }
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
 * Owner-facing mode change. Refuses a stale revision, refuses TICK_MOMENTUM
 * until the tick engine exists, otherwise bumps configRevision and modeEpoch
 * and acknowledges (Node is the gateway for Node producers in this phase).
 */
export function requestEntryMode(db, accountId, mode, { expectedRevision = null, actor = 'owner', now = new Date(), readiness = null } = {}) {
  const id = String(accountId)
  if (!ENTRY_MODES.includes(mode)) return { ok: false, reason: `unknown_mode: ${mode}` }
  const cur = engineStatusFor(db, id)
  if (expectedRevision != null && Number(expectedRevision) !== cur.configRevision) {
    return { ok: false, reason: 'revision_conflict', current: cur.configRevision, expected: Number(expectedRevision) }
  }
  // P6b (plan §3 P6b, §14 P7): TICK_MOMENTUM is admitted ONLY on a demo
  // account whose readiness (tick-readiness.js: registry, halt, record,
  // horizon, observation, recorder, disk, feed, pinned profile, replay
  // evidence, validation stage) is clean at the moment of the request. The
  // readiness function is injected by the route so this module stays free
  // of the sidecar's status tables; a caller that passes none is refused —
  // there is no unchecked path into tick trading. Live stays refused until
  // P7's LIVE_APPROVED gate exists as code.
  if (mode === 'TICK_MOMENTUM') {
    if (typeof readiness !== 'function') return { ok: false, reason: 'tick_readiness_unavailable: TICK_MOMENTUM needs the readiness check the route supplies', current: cur.configRevision }
    if (cur.environment !== 'demo') return { ok: false, reason: `tick_live_refused: TICK_MOMENTUM is admitted on demo accounts only until P7 (this account is ${cur.environment})`, current: cur.configRevision }
    let rd = null
    try { rd = readiness(db, id) } catch (err) { return { ok: false, reason: `tick_readiness_error: ${err?.message || err}`, current: cur.configRevision } }
    if (!rd || rd.ready !== true) {
      const blocked = Array.isArray(rd?.blockedReasons) && rd.blockedReasons.length ? rd.blockedReasons.join(', ') : 'readiness did not report ready'
      return { ok: false, reason: `tick_not_ready: ${blocked}`, current: cur.configRevision, blockedReasons: rd?.blockedReasons || [] }
    }
  }
  const resting = countResting(db, id)
  const nextEpoch = cur.modeEpoch + 1
  // P2a (plan §3 step 1): RESERVED intents of the old epoch are never sent;
  // DISPATCHING / SENT ones stay in flight (step 2) and UNKNOWN ones keep the
  // state RECONCILING (step 4) until the broker's evidence resolves them.
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
    // The ack is the sidecar's echo of THIS epoch, not our own write. Kept
    // as it was until then, so a reader can see the fence is not yet bound.
    fenceAckEpoch: cur.fenceAckEpoch,
    entryCounts: { unsent: ledger.unsent, inFlight: ledger.inFlight, resting, unknown },
    updatedAt: now.toISOString(),
  }
  const saved = writeEngineStatus(db, next)
  try {
    db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
      .run('POST', '/actions/entry-mode', JSON.stringify({ accountId: id, from: cur.effectiveEntryMode, to: mode, revision: saved.configRevision, epoch: saved.modeEpoch, resting: saved.entryCounts.resting, transition: saved.transitionState, actor }), id)
  } catch { /* audit best-effort */ }
  return { ok: true, status: saved, changed: cur.requestedEntryMode !== mode || cur.effectiveEntryMode !== saved.effectiveEntryMode }
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
 * P3b: the owner's tick-observation declaration from the repo
 * (config/tick-observation.json), applied ONCE per file content — the same
 * rule as the strategy-pin seed: the file is the initial declaration, a
 * later switch through the routes stands across deploys until the file
 * changes. Exists because the bearer token is lost and the routes are the
 * only other way to throw the switch. Never writes the engine record when
 * nothing changes; unknown accounts and refused modes are reported.
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
  if (seeded?.hash === hash) {
    // Already applied for this content: what the operator did since stands.
    for (const id of Object.keys(cfg.accounts || {})) if (!id.startsWith('_')) out.unchanged.push(id)
    return out
  }
  const accounts = cfg.accounts && typeof cfg.accounts === 'object' ? cfg.accounts : {}
  for (const [accountId, mode] of Object.entries(accounts)) {
    if (accountId.startsWith('_')) continue
    if (!/^[0-9]+$/.test(accountId)) { out.skipped.push(`${accountId}: malformed id`); continue }
    let known = false
    try { known = !!db.prepare('SELECT 1 FROM accounts WHERE account_id = ?').get(accountId) } catch { known = false }
    if (!known) { out.skipped.push(`…${accountId.slice(-4)}: not in the registry`); continue }
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
  setState(db, 'tick_observation_seed_json', JSON.stringify({ hash, at: new Date().toISOString(), applied: out.applied, symbols: out.symbols }))
  return out
}

// One refusal record per (account, producer, epoch): the loop asks every
// cycle and a decision_log row per cycle is noise, not evidence.
const refusalsSeen = new Map()

/**
 * The fence. Automatic producers are admitted only when the account's
 * effective mode has the producer's basis; manual families always pass here.
 */
export function admitEntry(db, { accountId, producerId, basis = 'bar' }) {
  const id = accountId != null ? String(accountId) : null
  const producer = ENTRY_PRODUCERS.find(p => p.id === producerId)
  if (!producer) return { ok: false, reason: `unknown_producer: ${producerId}`, modeEpoch: null }
  if (id == null) return { ok: false, reason: 'no_account', modeEpoch: null }
  const st = engineStatusFor(db, id)
  if (producer.family !== 'automatic') return { ok: true, reason: null, modeEpoch: st.modeEpoch, mode: st.effectiveEntryMode, family: producer.family }
  const mode = st.effectiveEntryMode
  let reason = null
  // AUDIT 11-09-2026 (plan §3.4): a transition in progress admits nothing
  // automatic — a drain (QUIESCING), an unknown outcome (RECONCILING), an
  // unacknowledged fence (WARMING) or a failed push (BLOCKED) each hold the
  // engine off, and the reason names the state so a reader can tell "stopped
  // by the owner" from "stopped until the broker's evidence arrives".
  if (st.transitionState !== 'STABLE') reason = `entry_mode_transition: ${st.transitionState}`
  else if (mode === 'STOPPED') reason = 'entry_mode_stopped'
  else if (MODE_BASIS[mode] !== basis) reason = `entry_mode_basis: ${mode} admits ${MODE_BASIS[mode]} producers, ${producerId} is ${basis}`
  if (reason) {
    const key = `${id}:${producerId}:${st.modeEpoch}`
    if (!refusalsSeen.has(key)) {
      refusalsSeen.set(key, true)
      try { recordDecision(db, { accountId: id, stage: 'entry_mode', decision: 'skip', reason, detail: { producerId, basis, mode, epoch: st.modeEpoch } }) } catch { /* best effort */ }
    }
    return { ok: false, reason, modeEpoch: st.modeEpoch, mode }
  }
  return { ok: true, reason: null, modeEpoch: st.modeEpoch, mode, family: producer.family }
}

/** Test seam: forget the per-epoch refusal dedupe. */
export function _resetRefusalDedupe() { refusalsSeen.clear() }

/** Every registry account's record, for GET /state/entry-engines. */
export function entryEnginesView(db) {
  let rows = []
  try { rows = db.prepare('SELECT account_id, is_live, enabled, mode FROM accounts ORDER BY is_live, account_id').all() } catch { rows = [] }
  const accounts = rows.map(r => {
    const st = engineStatusFor(db, r.account_id)
    return {
      accountId: `…${String(r.account_id).slice(-4)}`,
      environment: st.environment,
      registry: { enabled: Number(r.enabled) === 1, mode: r.mode },
      requestedEntryMode: st.requestedEntryMode,
      effectiveEntryMode: st.effectiveEntryMode,
      transitionState: st.transitionState,
      tickObservation: st.tickObservation,
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
    note: 'Node producers are fenced by admitEntry (P1b) and the VPO tier by its permits at the sidecar\'s send (P2a); on STOPPED the account\'s resting entry orders are cancelled by stored id and the state settles QUIESCING → RECONCILING → STABLE (P1c); an ACTIVE mode takes effect only after the sidecar echoes the new epoch (WARMING → STABLE) and never while an entry outcome is UNKNOWN (11-09-2026 audit); TICK_MOMENTUM is admitted only on a demo account whose readiness (tick-readiness.js) is clean at the request and only through the route that supplies that check (P6b); live stays refused until P7.',
    // No account may be armed by omission: a record that is absent reads OFF.
    globalHalt: (() => { try { return JSON.parse(getState(db, 'exec_guard_json') || '{}')?.halt === true } catch { return false } })(),
  }
}
