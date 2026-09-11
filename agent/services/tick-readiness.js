// ---------------------------------------------------------------------------
// agent/services/tick-readiness.js — P5 (docs/tick-momentum/plan.md §2
// `readiness` / `blocked_reasons`, §10 "a read-only per-account readiness
// endpoint with every applicable value, source, age, revision, verdict and
// remedy"; register TM-07, TM-19, TM-20, TM-32).
//
// Every check is a READINESS_CHECK (entry-contracts.js): what was checked,
// whether it holds, where the value came from, what was observed and when,
// which kind of "no" it is (operator policy, broker constraint, missing
// evidence, infrastructure, integration defect) and what would remedy it.
// Derived on every read from the stored records — never cached, never
// written back — so a stale panel cannot outlive the thing it reports.
//
// This is what P6's activation gate reads: TICK_MOMENTUM can be effective
// only when `ready` is true. Nothing here changes a mode.
// ---------------------------------------------------------------------------
import { getState } from '../db.js'
import { engineStatusFor } from './entry-mode.js'
import { intentCounts } from './entry-ledger.js'
import { loadAccountHorizon, horizonAdmits } from './account-horizon.js'
import { tickSymbolNames } from './exec-guard-sync.js'
import { validationHistory } from './tick-validation.js'
import { TICK_ENTRY_STAGES } from '../lib/entry-contracts.js'

export const RECORDER_STATUS_MAX_AGE_MS = 10 * 60_000
export const DISK_STOP_PCT = 85

function sideFor(environment) { return environment === 'live' ? 'cpp_exec' : 'cpp_exec_demo' }

function readTickRecord(db, side) {
  try { return JSON.parse(getState(db, `${side}_tick_json`) || 'null') } catch { return null }
}

function replayTrialFor(db, prefix) {
  if (!prefix) return null
  try { return db.prepare('SELECT trial_id, at FROM tick_trials WHERE profile_hash = ? ORDER BY id DESC LIMIT 1').get(prefix) || null } catch { return null }
}

/** One account's readiness: the status record plus the check list. */
export function tickReadinessFor(db, accountId, { now = new Date() } = {}) {
  const id = String(accountId)
  const st = engineStatusFor(db, id)
  const nowMs = now.getTime()
  const checks = []
  const add = (check, ok, source, observed, at, blockClass, remedy) => checks.push({ check, ok, source, observed: observed == null ? null : String(observed), at: at ?? null, blockClass: ok ? null : blockClass, remedy: ok ? null : remedy })

  // registry + global halt (operator policy)
  let reg = null
  try { reg = db.prepare('SELECT enabled, mode, is_live FROM accounts WHERE account_id = ?').get(id) } catch { reg = null }
  add('account_registered', !!reg, 'accounts', reg ? `enabled=${Number(reg.enabled) === 1}` : 'absent', null, 'operator_policy', 'the account is not in the registry; discovery adds it on the next account sync')
  add('account_enabled', !!reg && Number(reg.enabled) === 1, 'accounts.enabled', reg ? String(Number(reg.enabled) === 1) : 'absent', null, 'operator_policy', 'enable the account (Accounts › Trading switches)')
  let halt = false
  try { halt = JSON.parse(getState(db, 'exec_guard_json') || '{}')?.halt === true } catch { halt = false }
  add('global_halt_clear', !halt, 'exec_guard_json.halt', String(halt), null, 'operator_policy', 'clear the emergency halt')

  // the engine record itself
  add('engine_record_valid', !st.invalid, 'engine_status_json', st.invalid ? st.invalid.join('; ') : (st.stored === false ? 'default (never written)' : 'stored'), st.updatedAt, 'integration_defect', 'the stored record fails the contract; see /state/entry-engines')
  add('transition_stable', st.transitionState === 'STABLE', 'engine_status_json.transitionState', st.transitionState, st.updatedAt, 'broker_constraint', 'wait for the drain / reconcile to settle (see /state/entry-intents)')
  let ic = { unsent: 0, inFlight: 0, unknown: 0 }
  try { ic = intentCounts(db, id) } catch { /* ledger absent */ }
  add('no_unknown_entries', ic.unknown === 0, 'entry_intents', `unknown=${ic.unknown} inFlight=${ic.inFlight}`, null, 'broker_constraint', 'resolve the UNKNOWN intent(s) from broker evidence or POST /actions/entry-intents/:id/resolve')

  // horizon / basis (TM-19)
  const decl = loadAccountHorizon(db, id)
  const hz = horizonAdmits(decl, { basis: 'tick' })
  add('horizon_admits_tick', hz.ok, 'acct:horizon_json', decl.horizon || 'undeclared', null, 'operator_policy', hz.reason || 'declare the account intraday or clear its horizon')

  // observation + feed (infrastructure / policy)
  add('observation_active', st.tickObservation !== 'OFF', 'engine_status_json.tickObservation', st.tickObservation, st.updatedAt, 'operator_policy', 'POST /actions/tick-observation { mode: "SHADOW" } (or RECORD) for this account')
  const names = tickSymbolNames(db)
  add('symbols_declared', names.length > 0, 'tick_symbols_json', `${names.length} name(s)`, null, 'operator_policy', 'POST /actions/tick-symbols with the symbols to carry')
  const side = sideFor(st.environment)
  const rec = readTickRecord(db, side)
  const recAgeMs = rec?.at ? nowMs - Date.parse(rec.at) : null
  const fresh = recAgeMs != null && recAgeMs >= 0 && recAgeMs <= RECORDER_STATUS_MAX_AGE_MS
  const status = rec?.status || null
  add('recorder_status_fresh', fresh, `${side}_tick_json.at`, rec?.at ? `${Math.round((recAgeMs || 0) / 1000)} s old` : 'never pulled', rec?.at ?? null, 'infrastructure', 'the heartbeat has not pulled /tick-status from the sidecar; check the sidecar is up')
  add('recorder_recording', !!(status && status.enabled !== false && status.recording && status.state === 'RECORDING'), `${side}:/tick-status`, status ? `${status.state}${status.recording ? '' : ' (switch off)'}${status.enabled === false ? ' (no TICK_SPOOL_PATH)' : ''}` : 'no status', rec?.at ?? null, 'infrastructure', 'set TICK_SPOOL_PATH on the sidecar and switch an account on that side to RECORD or SHADOW')
  const usage = Number(status?.disk?.usagePct)
  add('disk_reserve_clear', !!status && status.state !== 'PAUSED_RESERVE' && !(usage >= DISK_STOP_PCT), `${side}:/tick-status.disk`, status ? `${Number.isFinite(usage) ? usage : '?'}% used, ${status.disk?.availBytes != null ? (Number(status.disk.availBytes) / 1e9).toFixed(2) + ' GB free' : 'free bytes unknown'}` : 'no status', rec?.at ?? null, 'infrastructure', 'free space on the mount or raise the volume; the recorder resumes with a gap on disk')
  const gaps = Number(status?.events?.gaps ?? 0), dropped = Number(status?.events?.dropped ?? 0)
  add('feed_continuity', !!status && dropped === 0, `${side}:/tick-status.events`, status ? `gaps=${gaps} dropped=${dropped}` : 'no status', rec?.at ?? null, 'infrastructure', 'the recorder dropped events this boot (queue overflow); the strategy re-warms after a gap, and a dropping feed is not one to trade')

  // profile and evidence (missing evidence)
  const reported = status?.strategy?.profileHash || null
  const pinned = st.profileHash ? st.profileHash.slice(0, 16) : null
  add('profile_pinned', !!pinned, 'engine_status_json.profileHash', pinned || 'none', st.updatedAt, 'missing_evidence', 'import REPLAY_PASSED evidence (POST /actions/tick-validation) — the first import pins the profile')
  add('profile_matches_sidecar', !!pinned && !!reported && reported === pinned, `${side}:/tick-status.strategy.profileHash`, reported ? `sidecar ${reported}${pinned ? ` vs pinned ${pinned}` : ''}` : 'sidecar reports no strategy', rec?.at ?? null, 'integration_defect', 'the sidecar runs a different parameter profile from the one the evidence was produced with; deploy the matching profile or re-validate')
  add('shadow_strategy_running', st.tickObservation !== 'SHADOW' ? true : !!(status?.strategy?.shadow), `${side}:/tick-status.strategy.shadow`, st.tickObservation === 'SHADOW' ? String(!!status?.strategy?.shadow) : 'n/a (not in SHADOW)', rec?.at ?? null, 'integration_defect', 'the guard sync has not converged the sidecar\'s shadow switch; check the next probe')
  const trial = replayTrialFor(db, pinned)
  add('replay_evidence', !!trial, 'tick_trials', trial ? `trial ${trial.trialId} at ${trial.at}` : (pinned ? 'no trial for the pinned profile' : 'no profile pinned'), trial?.at ?? null, 'missing_evidence', 'run scripts/tick-research.mjs over sealed segments and import the trial (POST /actions/tick-trials)')
  // PR-B (owner principle 1): ONE bar for every account — SHADOW_PASSED or
  // the traded stage above it. The environment is not read here.
  const stageOk = TICK_ENTRY_STAGES.includes(st.validationStage)
  add('validation_stage', stageOk, 'engine_status_json.validationStage', st.validationStage, st.updatedAt, 'missing_evidence', 'reach SHADOW_PASSED: REPLAY_PASSED then shadow evidence over the owner-set minimums (POST /actions/tick-validation) — the same bar on every account')

  const blockedReasons = checks.filter(c => !c.ok).map(c => c.check)
  return {
    accountId: `…${id.slice(-4)}`,
    environment: st.environment,
    side,
    requestedEntryMode: st.requestedEntryMode, effectiveEntryMode: st.effectiveEntryMode, transitionState: st.transitionState,
    tickObservation: st.tickObservation, validationStage: st.validationStage,
    configRevision: st.configRevision, modeEpoch: st.modeEpoch,
    profileId: st.profileId ?? null, profileHash: pinned, sidecarProfileHash: reported,
    entryCounts: { ...st.entryCounts, ...ic },
    ready: blockedReasons.length === 0,
    readiness: checks,
    blockedReasons,
    byClass: Object.fromEntries(['operator_policy', 'broker_constraint', 'missing_evidence', 'infrastructure', 'integration_defect'].map(k => [k, checks.filter(c => !c.ok && c.blockClass === k).map(c => c.check)])),
    validationHistory: validationHistory(db, id).slice(-5),
    updatedAt: st.updatedAt,
  }
}

/** Every registry account (TM-07: discovered, never enrolled by hand). */
export function tickReadinessView(db, { now = new Date() } = {}) {
  let rows = []
  try { rows = db.prepare('SELECT account_id FROM accounts ORDER BY is_live, account_id').all() } catch { rows = [] }
  const accounts = rows.map(r => tickReadinessFor(db, r.account_id, { now }))
  return {
    at: now.toISOString(),
    accounts,
    readyCount: accounts.filter(a => a.ready).length,
    note: 'P5: derived on every read from the stored records and the last pulled sidecar status; a failing check names its class and remedy. TICK_MOMENTUM is refused until P6 reads `ready` here; no check lowers a risk limit.',
  }
}

/** The signals the sidecar rang in SHADOW (cpp_decisions tick/signal). */
export function tickSignalsView(db, { limit = 100 } = {}) {
  let rows = []
  try {
    rows = db.prepare(`SELECT at, side, ts_ms, symbol_id, code, detail FROM cpp_decisions WHERE component = 'tick' AND kind = 'signal' ORDER BY id DESC LIMIT ?`).all(Math.min(500, Math.max(1, limit)))
  } catch { rows = [] }
  let names = {}
  try { for (const r of db.prepare('SELECT symbol, symbol_id FROM symbol_hours WHERE symbol_id IS NOT NULL').all()) names[r.symbol_id] = r.symbol } catch { names = {} }
  const parse = (d) => Object.fromEntries([...String(d || '').matchAll(/(\w+)=([^\s]+)/g)].map(m => [m[1], m[2]]))
  const signals = rows.map(r => {
    const p = parse(r.detail)
    return { at: r.at, side: r.side, tsMs: r.ts_ms, symbolId: r.symbol_id, symbol: names[r.symbol_id] || null, direction: r.code, trigger2: p.trigger2 != null ? Number(p.trigger2) : null, stopDistance: p.stop != null ? Number(p.stop) : null, V: p.V != null ? Number(p.V) : null, E: p.E != null ? Number(p.E) : null, setupId: p.setup != null ? Number(p.setup) : null, profile: p.profile || null }
  })
  const byProfile = {}
  for (const s of signals) { byProfile[s.profile || '?'] = (byProfile[s.profile || '?'] || 0) + 1 }
  return { at: new Date().toISOString(), signals, count: signals.length, byProfile, note: 'P4/P5: shadow signals only — rung by the sidecar\'s strategy, nothing placed (places:false); the profile on each is the sidecar\'s parameter hash.' }
}
