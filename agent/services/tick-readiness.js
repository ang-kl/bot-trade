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
// The checks that stand between an account and SHADOWING (20-09-2026, set
// corrected the same day after review). The PAUSE_CHECKS of tick-permits.js
// are absent by design — see the note beside `shadowBlockers` below.
//
// THREE ACCOUNT-LEVEL CHECKS ARE IN, and they are not trading-specific: an
// account that is not registered, not enabled, or sitting under the global
// halt is not shadowing either, and a panel that said otherwise would be
// showing a result the system is not producing (owner principle 6). They
// cost nothing in reachability — all three pass by default.
//
// `profile_matches_sidecar` IS OUT, and this is the correction. `pinned` is
// `engine_status_json.profileHash`, written in exactly ONE place —
// tick-validation.js, inside the REPLAY_PASSED import branch — so no account
// carries a pin until replay evidence is imported. With no pin the check
// fails, and while it was in this set `shadowReady` could not be true on ANY
// production account: it reported exactly what `ready` already did. MEASURED
// against the real production shape (live account, SHADOW, symbols declared,
// TICK_SPOOL_PATH set, recorder RECORDING, strategy.shadow true, fresh pull,
// sidecar hash = the repo's default profile, no pin): `shadowReady: false`,
// `shadowBlockers: ["profile_matches_sidecar"]`. Every fixture that asserted
// the true branch ran AFTER a test helper wrote a pin — a true branch out of
// reach of the input that would produce it (CLAUDE.md failure mode 3).
//
// It is wrong on the merits too. The pin is evidence bookkeeping for TRADING
// — which parameters the replay evidence was produced against. Shadowing
// needs none of it: exec-guard-sync turns the shadow on from
// `tickObservation === 'SHADOW'` alone. And the set was incoherent with it
// in: `profile_pinned` was excluded while `profile_matches_sidecar`, which
// IS `profile_pinned` plus a match, was included.
export const SHADOW_CHECKS = Object.freeze(['account_registered', 'account_enabled', 'global_halt_clear', 'observation_active', 'symbols_declared', 'recorder_status_fresh', 'shadow_strategy_running'])

// `observation_active` passes on RECORD as well as SHADOW (it tests
// `!== 'OFF'`), and `shadow_strategy_running` short-circuits to ok when the
// account is not in SHADOW — so those two together let a RECORD-only account
// read as shadowing. `shadowReady` means "the shadow IS running on this
// account", so the SHADOW requirement is carried as this derived blocker.
//
// It is NOT a readiness check and is deliberately not added to the check
// list: adding one there would change `blockedReasons`, and `ready` is
// `blockedReasons.length === 0`. Nothing in this file may move that.
export const SHADOW_OBSERVATION_BLOCKER = 'observation_is_shadow'
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
  add('profile_matches_sidecar', !!pinned && !!reported && reported === pinned, `${side}:/tick-status.strategy.profileHash`, reported ? `sidecar ${reported}${pinned ? ` vs pinned ${pinned}` : ''}` : (status && status.enabled === false ? 'sidecar has no TICK_SPOOL_PATH (no strategy runs)' : 'sidecar reports no strategy'), rec?.at ?? null, status && status.enabled === false ? 'infrastructure' : 'integration_defect', status && status.enabled === false ? 'the sidecar has no TICK_SPOOL_PATH, so no strategy (and no profile) runs there: set TICK_SPOOL_PATH on that sidecar (ask-first, TM-27)' : 'the sidecar runs a different parameter profile from the one the evidence was produced with; deploy the matching profile or re-validate')
  // PR-H checker m-2: a sidecar without TICK_SPOOL_PATH builds no tick
  // workers (cpp-exec main.cpp), so its shadow switch can never converge —
  // the remedy must say so, not send the operator to wait for a probe.
  const noSpool = !!status && status.enabled === false
  add('shadow_strategy_running', st.tickObservation !== 'SHADOW' ? true : !!(status?.strategy?.shadow), `${side}:/tick-status.strategy.shadow`, st.tickObservation === 'SHADOW' ? (noSpool ? 'sidecar has no TICK_SPOOL_PATH (no tick workers)' : String(!!status?.strategy?.shadow)) : 'n/a (not in SHADOW)', rec?.at ?? null, noSpool ? 'infrastructure' : 'integration_defect', noSpool ? 'the sidecar has no TICK_SPOOL_PATH and builds no tick workers without one, so SHADOW cannot run there: set TICK_SPOOL_PATH on that sidecar (ask-first — it restarts the sidecar; a VOLUME is not needed for shadow; one may be needed before arming, since the disk reserve must clear, TM-27)' : 'the guard sync has not converged the sidecar\'s shadow switch; check the next probe')
  const trial = replayTrialFor(db, pinned)
  add('replay_evidence', !!trial, 'tick_trials', trial ? `trial ${trial.trialId} at ${trial.at}` : (pinned ? 'no trial for the pinned profile' : 'no profile pinned'), trial?.at ?? null, 'missing_evidence', 'POST /actions/tick-research (stage-A grid over the segments at TICK_SEGMENTS_DIR, imported into the ledger) — or scripts/tick-research.mjs beside the spool, then POST /actions/tick-trials')
  // PR-B (owner principle 1): ONE bar for every account — SHADOW_PASSED or
  // the traded stage above it. The environment is not read here.
  const stageOk = TICK_ENTRY_STAGES.includes(st.validationStage)
  add('validation_stage', stageOk, 'engine_status_json.validationStage', st.validationStage, st.updatedAt, 'missing_evidence', 'reach SHADOW_PASSED: REPLAY_PASSED then shadow evidence over the owner-set minimums (POST /actions/tick-validation) — the same bar on every account')

  const blockedReasons = checks.filter(c => !c.ok).map(c => c.check)
  // 20-09-2026: `ready` above is ONE bar for TWO different questions, and the
  // live accounts are failing it on the wrong one. `ready` gates exactly two
  // things — promotion to TICK_MOMENTUM (entry-mode.js) and, through the
  // subset PAUSE_CHECKS, the pausing of live tick permits (tick-permits.js).
  // Neither gates the SHADOW: shadowing is driven by tickObservation ===
  // 'SHADOW' through exec-guard-sync's `tickShadow`, which never reads this
  // file. So an account that could shadow today reads "not ready" on checks
  // about TRADING, which it is nowhere near.
  //
  // MEASURED: the live sidecar (cpp-acct) has no TICK_SPOOL_PATH, so
  // /tick-status answers {"enabled":false} (main.cpp) and every
  // status-derived check reads "no status" at once. That is a REPORTING
  // artefact — nothing is gated by it — and the split below names it as one.
  //
  // `recorder_recording`, `disk_reserve_clear` and `feed_continuity` are
  // DELIBERATELY excluded from the shadow set. They are the PAUSE_CHECKS
  // (tick-permits.js); they gate TRADING, not shadowing. A container
  // filesystem below the 2 GiB reserve parks the recorder at PAUSED_RESERVE
  // (tick_recorder.hpp reserveMinBytes), which stops writeRecord and nothing
  // else — the shadow strategy runs on unaffected (tick_tap.cpp). That
  // parking is a FAIL-SAFE: it withholds tick permits, so an arming attempt
  // is refused while the disk is short. It stays in `ready`, and a shadow
  // that is genuinely running is no longer reported as blocked by it.
  //
  // What `shadowReady` does NOT say: that the account is evidenced, pinned or
  // eligible to trade. It says the shadow is running there. `ready` is still
  // the only answer to the trading question and the only thing any gate reads.
  //
  // DERIVED FIELDS ONLY. `ready` and `blockedReasons` are computed above and
  // are not touched here: nothing below may change a mode, and the promotion
  // gate must keep reading the whole check list. tick-readiness.test.js
  // recomputes the old predicate over the old check list and asserts equality.
  const shadowBlockers = blockedReasons.filter(r => SHADOW_CHECKS.includes(r))
  // "is the shadow running on THIS account", not "could it be" — see
  // SHADOW_OBSERVATION_BLOCKER. Derived, never a readiness check.
  if (st.tickObservation !== 'SHADOW') shadowBlockers.push(SHADOW_OBSERVATION_BLOCKER)
  // §1 (21-09-2026), reporting only. `TICK_SPOOL_PATH` is the construction
  // gate for the WHOLE tick block on a sidecar — recorder, workers, strategy,
  // shadow books, firer and /tick-status alike (cpp-exec main.cpp:191-265,
  // :764) — so "this side has no tick block" and "the recorder is not
  // recording" are different facts with different remedies, and until now an
  // operator had to read the sidecar log to tell them apart. This names the
  // destination and why it is or is not there. It is DERIVED: it appears in
  // no check, touches neither `ready` nor `shadowReady`, and the
  // anti-regression test recomputes the old predicate over the old list.
  const recorderDestination = {
    path: status?.spoolDir ?? null,
    // AND IT CARRIES ITS OWN FRESHNESS. Every other value in this payload has
    // an `at`; without one, a sidecar that died an hour ago reports as
    // `RECORDING`, present tense — the exact shape CLAUDE.md records against
    // the protection audit, where a stale panel was believed over the thing
    // that actually updates. `recorder_status_fresh` is elsewhere in this
    // object, but a consumer rendering "the recorder destination" has no
    // reason to join against it, so staleness travels WITH the reading.
    at: rec?.at ?? null,
    stale: !!status && !fresh,
    state: !status ? 'NO_STATUS' : (!fresh ? 'STALE' : (status.enabled === false ? 'NO_SPOOL_PATH' : String(status.state || 'UNKNOWN'))),
    reason: !status
      ? 'the heartbeat has not pulled /tick-status from this side'
      : !fresh
        ? `last read ${rec?.at ?? 'unknown'} — too old to describe the sidecar now`
        : (status.enabled === false
          ? (status.reason || 'TICK_SPOOL_PATH not set — the sidecar builds no tick block at all')
          : (status.reason || null)),
  }
  return {
    recorderDestination,
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
    tradingBlockers: blockedReasons,
    shadowBlockers,
    shadowReady: shadowBlockers.length === 0,
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
    // 20-09-2026: the second count is the one to read when asking "can this
    // account shadow today". `readyCount` stays what it was — the accounts
    // cleared to TRADE — and is still the only figure any gate reads.
    shadowReadyCount: accounts.filter(a => a.shadowReady).length,
    note: 'P5: derived on every read from the stored records and the last pulled sidecar status; a failing check names its class and remedy. TICK_MOMENTUM is refused until P6 reads `ready` here; no check lowers a risk limit. `shadowReady` / `shadowBlockers` are a DERIVED read of the same checks (SHADOW_CHECKS) plus the observation_is_shadow requirement, and gate nothing: they answer "is the shadow running on this account", not "may it trade". The three PAUSE_CHECKS and the evidence checks left out of them still block trading, and `ready` is unchanged.',
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
