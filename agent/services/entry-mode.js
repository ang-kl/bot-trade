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
// account) but not at FIRE time — that is the P2 permit; resting entry orders
// are COUNTED on a switch, not cancelled — cancel-by-stored-origin is P1c;
// TICK_MOMENTUM is refused outright until the strategy (P4) and its evidence
// (P6) exist. The Node gateway acknowledges STOPPED and TIME_BASED at once
// because for Node producers the fence IS this module, so requested and
// effective agree immediately and the transition is STABLE.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { getAccountState, setAccountState } from './account-registry.js'
import { recordDecision } from './decision-log.js'
import { ENTRY_MODES, defaultEngineStatus, validateEngineStatus } from '../lib/entry-contracts.js'
import { ENTRY_PRODUCERS } from '../lib/entry-producers.js'

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

function persist(db, status) {
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
export function requestEntryMode(db, accountId, mode, { expectedRevision = null, actor = 'owner', now = new Date() } = {}) {
  const id = String(accountId)
  if (!ENTRY_MODES.includes(mode)) return { ok: false, reason: `unknown_mode: ${mode}` }
  const cur = engineStatusFor(db, id)
  if (expectedRevision != null && Number(expectedRevision) !== cur.configRevision) {
    return { ok: false, reason: 'revision_conflict', current: cur.configRevision, expected: Number(expectedRevision) }
  }
  if (mode === 'TICK_MOMENTUM') {
    return { ok: false, reason: 'tick_engine_not_built: the tick strategy (P4) and its evidence (P6) do not exist yet', current: cur.configRevision }
  }
  const next = {
    ...cur,
    requestedEntryMode: mode,
    effectiveEntryMode: mode,   // Node acknowledges at once — the fence is admitEntry()
    transitionState: 'STABLE',
    configRevision: cur.configRevision + 1,
    modeEpoch: cur.modeEpoch + 1,
    fenceAckEpoch: cur.modeEpoch + 1,
    entryCounts: { ...cur.entryCounts, resting: countResting(db, id) },
    updatedAt: now.toISOString(),
  }
  const saved = persist(db, next)
  try {
    db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
      .run('POST', '/actions/entry-mode', JSON.stringify({ accountId: id, from: cur.effectiveEntryMode, to: mode, revision: saved.configRevision, epoch: saved.modeEpoch, resting: saved.entryCounts.resting, actor }), id)
  } catch { /* audit best-effort */ }
  return { ok: true, status: saved, changed: cur.effectiveEntryMode !== mode }
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
  if (mode === 'STOPPED') reason = 'entry_mode_stopped'
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
      entryCounts: { ...st.entryCounts, resting: countResting(db, r.account_id) },
      stored: st.stored !== false,
      invalid: st.invalid || null,
    }
  })
  return {
    at: new Date().toISOString(),
    accounts,
    note: 'P1b: Node producers are fenced by admitEntry; the VPO tier is fenced at arming only (P2 fences its fire); resting orders are counted, not cancelled (P1c); TICK_MOMENTUM is refused until P4/P6.',
    // No account may be armed by omission: a record that is absent reads OFF.
    globalHalt: (() => { try { return JSON.parse(getState(db, 'exec_guard_json') || '{}')?.halt === true } catch { return false } })(),
  }
}
