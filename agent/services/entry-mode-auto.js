// ---------------------------------------------------------------------------
// agent/services/entry-mode-auto.js — the AUTOMATIC half of the entry-mode
// switch (PR-G, owner principle 2, 11-09-2026: "prioritise for opportunities;
// the tick-based switch is on/off per account BY A HUMAN and AUTOMATICALLY
// by the bot").
//
// One pass per quant cadence (loop.js, every 6th loop) over EVERY registry
// account whose entryModePolicy is `auto` — not the autopilot roster: an
// account that left that roster (autopilot off, manage-only) is still listed
// for tick entries by tickEntryAccountsFor, so its DEMOTION must not depend
// on the ENTER capability (checker R-1). Promotion does: an account the loop
// does not enter for is held. A `manual` account is never read for a
// decision and never written — the human's switch is theirs.
//
// WP-A (dual admission, 25-09-2026): the pass works on BASES, not on mode
// strings. PROMOTE adds tick NEXT TO bar (TIME_BASED + ['bar','tick']) —
// time entries keep running; tick alone is a human-only choice. DEMOTE
// removes tick from any account whose requested bases include it (tick
// alone or beside bar) — back to TIME_BASED, bar only. A human's override
// records the bases chosen, so a human's own "time + tick" is not read as
// "not tick" and does not block the bot.
//
// PROMOTE (tick added next to bar) needs all of these, in order:
//   1. no HUMAN OVERRIDE standing: the human's last switch (recorded by
//      requestEntryMode into entry_mode_auto_json.humanOverride) is never
//      promoted past until the human acts again — a mode or policy change —
//      or HUMAN_OVERRIDE_COOLDOWN_H lapses (checker C-1: the bot undid a
//      human's TIME_BASED within one cycle).
//   2. AUTO_PROMOTE_CYCLES consecutive READY evaluations — tickReadinessFor
//      clean AND validationStage in TICK_ENTRY_STAGES (SHADOW_PASSED or
//      above). The streak lives in entry_mode_auto_json; a failing evaluation
//      zeroes it (hysteresis), it does not advance while STOPPED (checker
//      A-1), and it is reset when the previous evaluation is older than
//      STREAK_MAX_GAP_MS — consecutive by TIME, not by evaluation count
//      (checker A-2: two ready evaluations a week ago do not count).
//   3. the side's last guard push and probe succeeded (the heartbeat's
//      EXEC_GUARD_SYNC_ERROR_KEY stamp and <side>_health_json): a promotion
//      whose push would fail only parks the account BLOCKED (checker C-2).
//   4. the opportunity rule over OPPORTUNITY_WINDOW_H: the tick path's
//      shadow-TAKEN signals on the account's sidecar side (cpp_decisions
//      component 'tick' kind 'signal', detail opening with `shadow`; the
//      sidecar's `shadow_cost` / `shadow_busy` are refused offers and do not
//      count; windowed on ts_ms, the sidecar's own clock, since `at` is the
//      ingest time) must be ≥ max(MIN_TICK_SHADOW, the time path's approvals
//      for the account — risk_events approved = 1 by DISTINCT opportunity_key
//      so a re-scored setup is one opportunity). 0 ≥ 0 does not promote
//      (checker B-1). Both counts travel on the action_log row.
//   5. requestEntryMode itself: the readiness re-check, the ack protocol, the
//      drain and the action_log row are the same code the human route runs.
// DEMOTE (→ TIME_BASED, bar only) is immediate: one evaluation that is not
// ready (or a stage below the bar) on an account whose requested bases
// include tick; the streak resets. NOTE (WP-A risk): on a dual account this
// bumps the epoch, so bar entries also pause through WARMING and the old
// epoch's RESERVED bar intents are released — tick infrastructure health
// (feed, recorder) now vetoes bar entries for one round trip.
// A promotion of the bot's own that stays BLOCKED for AUTO_BLOCKED_CYCLES
// passes is taken back to TIME_BASED by the bot, logged (checker C-2).
// HOLD otherwise: already admitting tick, STOPPED by a human (the bot
// never lifts a stop), or mid-transition (WARMING / QUIESCING / RECONCILING —
// the gateway's evidence settles those). After a switch the gateway is bound
// the way the route binds it (entry-mode-gateway.js).
// ---------------------------------------------------------------------------
import { getState } from '../db.js'
import { registryAutopilotAccounts } from './account-registry.js'
import { engineStatusFor, requestEntryMode, readAutoState, writeAutoState, AUTO_STATE_KEY, basesFor } from './entry-mode.js'
import { tickReadinessFor } from './tick-readiness.js'
import { bindEntryModeGateway } from './entry-mode-gateway.js'
import { TICK_ENTRY_STAGES } from '../lib/entry-contracts.js'

export { readAutoState, writeAutoState, AUTO_STATE_KEY }
export const AUTO_PROMOTE_CYCLES = 3
export const OPPORTUNITY_WINDOW_H = 24
export const MIN_TICK_SHADOW = 1
export const HUMAN_OVERRIDE_COOLDOWN_H = 24
export const STREAK_MAX_GAP_MS = 90 * 60_000
export const AUTO_BLOCKED_CYCLES = 2
export const AUTO_ACTOR = 'auto:readiness'

const TRANSITIONS_SETTLING = Object.freeze(['WARMING', 'QUIESCING', 'RECONCILING'])

/**
 * The opportunity counts for one account over the window: the tick path's
 * shadow-taken signals on the account's sidecar side vs the time path's
 * distinct approvals for the account. Both bounds are normalised — ts_ms in
 * epoch ms for the sidecar's rows, datetime() for risk_events, whose
 * created_at is written as ISO text (risk.js) — so a text compare against a
 * sqlite-format bound cannot over-count the since-day (checker B-2).
 */
export function opportunityCounts(db, accountId, { now = new Date(), windowH = OPPORTUNITY_WINDOW_H, side = null } = {}) {
  const sinceMs = now.getTime() - windowH * 3_600_000
  const sinceIso = new Date(sinceMs).toISOString()
  let tickShadow = 0, timeApprovals = 0
  try {
    tickShadow = db.prepare(`SELECT COUNT(*) AS n FROM cpp_decisions WHERE component = 'tick' AND kind = 'signal' AND side = ? AND (detail = 'shadow' OR detail LIKE 'shadow %') AND ts_ms IS NOT NULL AND ts_ms >= ? AND ts_ms <= ?`).get(String(side), sinceMs, now.getTime())?.n ?? 0
  } catch { tickShadow = 0 }
  try {
    timeApprovals = db.prepare(`SELECT COUNT(DISTINCT COALESCE(opportunity_key, 'row:' || id)) AS n FROM risk_events WHERE approved = 1 AND account_id = ? AND datetime(created_at) >= datetime(?) AND datetime(created_at) <= datetime(?)`).get(String(accountId), sinceIso, now.toISOString())?.n ?? 0
  } catch { timeApprovals = 0 }
  return { tickShadow, timeApprovals, windowH, since: sinceIso }
}

/**
 * The account's sidecar side in the HEARTBEAT's vocabulary — the writer of
 * cpp_decisions.side — so one collapsed sidecar named `cpp_exec` is counted
 * as such (checker note 14: readiness names the demo side `cpp_exec_demo`
 * even when only `cpp_exec` exists).
 */
export async function sidecarSideOf(db, accountId) {
  const [{ sideForAccount }, exec] = await Promise.all([import('./heartbeat.js'), import('../lib/exec-engine.js')])
  return sideForAccount(db, exec, String(accountId)) || null
}

/** Did the side's last guard push and probe succeed? (heartbeat's own stamps) */
export function sideHealth(db, sideName) {
  if (!sideName) return { ok: false, reason: 'no sidecar side for the account' }
  try {
    const err = JSON.parse(getState(db, 'exec_guard_sync_last_error_json') || 'null')
    if (err && (err.side == null || err.side === sideName)) return { ok: false, reason: `last guard push failed: ${String(err.error).slice(0, 80)}` }
  } catch { /* unreadable stamp: not a failure */ }
  try {
    const h = JSON.parse(getState(db, sideName === 'cpp_exec' ? 'cpp_exec_health_json' : `${sideName}_health_json`) || 'null')
    if (h && (h.ok === false || h.dormant === true)) return { ok: false, reason: `last probe ${h.dormant ? 'dormant' : 'failed'}${h.error ? `: ${String(h.error).slice(0, 80)}` : ''}` }
  } catch { /* unreadable: not a failure */ }
  return { ok: true, reason: null }
}

function autoPolicyAccounts(db) {
  let rows = []
  try { rows = db.prepare('SELECT account_id FROM accounts ORDER BY account_id').all() } catch { rows = [] }
  return rows.map(r => String(r.account_id)).filter(id => engineStatusFor(db, id).entryModePolicy === 'auto')
}

function tail(id) { return `…${String(id).slice(-4)}` }

/**
 * The pass. Returns every auto account's verdict and the log lines the loop
 * prints (`…last4 promoted/demoted/held (reason)`).
 */
export async function evaluateAutoEntryModes(db, {
  readiness = tickReadinessFor,
  now = new Date(),
  opportunity = opportunityCounts,
  gateway = bindEntryModeGateway,
  sideOf = sidecarSideOf,
  health = sideHealth,
  accounts = null,
  canEnter = null,
  promoteCycles = AUTO_PROMOTE_CYCLES,
  windowH = OPPORTUNITY_WINDOW_H,
  minTickShadow = MIN_TICK_SHADOW,
  overrideCooldownH = HUMAN_OVERRIDE_COOLDOWN_H,
  streakMaxGapMs = STREAK_MAX_GAP_MS,
  blockedCycles = AUTO_BLOCKED_CYCLES,
} = {}) {
  const roster = accounts ? accounts.map(String) : autoPolicyAccounts(db)
  const entering = new Set((canEnter || registryAutopilotAccounts(db).map(a => a.accountId)).map(String))
  const nowMs = now.getTime()
  const out = { at: now.toISOString(), evaluated: [], promoted: [], demoted: [], held: [], manual: [], lines: [] }
  for (const id of roster) {
    const st = engineStatusFor(db, id)
    if (st.entryModePolicy !== 'auto') { out.manual.push(id); continue } // never read for a decision, never written
    const auto = readAutoState(db, id)
    // The REQUESTED bases — what the account is asked to admit, whether or
    // not the ack has made it effective yet.
    const requested = basesFor({ ...st, effectiveEntryMode: st.requestedEntryMode })
    const verdict = { accountId: tail(id), action: 'held', reason: null, readyStreak: auto.readyStreak, mode: st.requestedEntryMode, bases: requested, transition: st.transitionState }
    const finish = (action, reason, extra = {}) => {
      verdict.action = action; verdict.reason = reason; Object.assign(verdict, extra)
      verdict.readyStreak = auto.readyStreak
      const next = { ...auto, lastEval: { at: now.toISOString(), action, reason, ...extra } }
      if (action !== 'held') next.lastAction = { at: now.toISOString(), action, reason, ...extra }
      writeAutoState(db, id, next)
      out.evaluated.push(verdict); out[action === 'held' ? 'held' : action].push(verdict)
      out.lines.push(`${verdict.accountId} ${action} (${reason})`)
    }
    // WP-A: the action is named by the caller, not read off the mode string
    // (a promotion now lands on TIME_BASED too). `bases` undefined is the
    // mode's own basis — the demotion and the take-back.
    const switchTo = async (action, mode, reason, detail, extra, bases = undefined) => {
      const r = requestEntryMode(db, id, mode, { actor: AUTO_ACTOR, now, readiness, detail, ...(bases !== undefined ? { admittedBases: bases } : {}) })
      if (!r.ok) { finish('held', `${action === 'demoted' ? 'demotion' : 'promotion'} refused: ${r.reason}`, extra); return false }
      auto.blockedCycles = 0
      const bound = await gateway(db, id, mode, { epoch: r.status.modeEpoch })
      finish(action, reason, { ...extra, epoch: r.status.modeEpoch, bases: r.bases, pushed: !!bound?.gateway?.pushed, transition: bound?.status?.transitionState || r.status.transitionState })
      return true
    }
    // A streak is consecutive by TIME: a previous evaluation older than the
    // gap is not the one before this one.
    const lastAt = auto.lastEval?.at ? Date.parse(auto.lastEval.at) : NaN
    let gapNote = ''
    if (auto.readyStreak > 0 && Number.isFinite(lastAt) && nowMs - lastAt > streakMaxGapMs) {
      gapNote = `; streak reset: previous evaluation ${Math.round((nowMs - lastAt) / 60_000)} min ago`
      auto.readyStreak = 0
    }
    // BLOCKED under the bot's own promotion: a failed push left the account
    // effective STOPPED. After N passes the bot takes it back itself rather
    // than leaving a working time-based account parked.
    if (st.transitionState === 'BLOCKED') {
      const ours = auto.lastAction?.action === 'promoted' && Number(auto.lastAction?.epoch) === st.modeEpoch
      if (!ours) { finish('held', "transition BLOCKED (not the bot's epoch)"); continue }
      auto.blockedCycles += 1
      if (auto.blockedCycles < blockedCycles) { finish('held', `transition BLOCKED under the bot's promotion (${auto.blockedCycles}/${blockedCycles})`); continue }
      auto.readyStreak = 0
      await switchTo('demoted', 'TIME_BASED', `BLOCKED for ${auto.blockedCycles} passes after the bot's promotion — taken back`, { why: 'blocked_after_auto_promotion', blockedCycles: auto.blockedCycles })
      continue
    }
    // Mid-transition: the gateway's evidence settles it; a new request now
    // would only stack epochs. The streak is neither advanced nor reset.
    if (TRANSITIONS_SETTLING.includes(st.transitionState)) { finish('held', `transition ${st.transitionState}${gapNote}`); continue }
    let rd = null
    try { rd = readiness(db, id, { now }) } catch (err) { rd = { ready: false, blockedReasons: [`readiness_error: ${err?.message || err}`], side: null } }
    const stageOk = TICK_ENTRY_STAGES.includes(st.validationStage)
    const ready = !!rd && rd.ready === true && stageOk
    if (!ready) {
      auto.readyStreak = 0
      const why = !stageOk ? `stage ${st.validationStage} below ${TICK_ENTRY_STAGES[0]}` : `not ready: ${(rd?.blockedReasons || []).slice(0, 4).join(', ') || 'readiness did not report ready'}`
      if (requested.includes('tick')) await switchTo('demoted', 'TIME_BASED', why, { why, blockedReasons: rd?.blockedReasons || [] })
      else finish('held', why)
      continue
    }
    if (st.requestedEntryMode === 'STOPPED') { finish('held', `stopped by a human; the bot never lifts a stop (streak held at ${auto.readyStreak})${gapNote}`); continue }
    auto.readyStreak += 1
    if (requested.includes('tick')) { finish('held', `already admits tick (${requested.join('+')}, ready ${auto.readyStreak})`); continue }
    // The human's last switch stands until the human acts again or the
    // cooldown lapses — the bot never promotes past it.
    // WP-A: the override blocks only when the human's choice did NOT admit
    // tick — read from its bases (an override stored before WP-A has none and
    // reads as its mode's own basis).
    const ho = auto.humanOverride
    if (ho && !basesFor({ effectiveEntryMode: ho.mode, admittedBases: Array.isArray(ho.bases) && ho.bases.length ? ho.bases : null }).includes('tick')) {
      const ageMs = nowMs - (Date.parse(ho.at) || 0)
      if (ageMs < overrideCooldownH * 3_600_000) {
        finish('held', `human set ${ho.mode} ${Math.round(ageMs / 60_000)} min ago; the bot does not promote past it for ${overrideCooldownH} h (ready ${auto.readyStreak})${gapNote}`)
        continue
      }
    }
    if (auto.readyStreak < promoteCycles) { finish('held', `ready ${auto.readyStreak}/${promoteCycles}${gapNote}`); continue }
    if (!entering.has(id)) { finish('held', `ready ${auto.readyStreak}/${promoteCycles} but not on the autopilot roster (the loop does not enter for it)`); continue }
    let side = null
    try { side = await sideOf(db, id) } catch { side = null }
    const sideName = side?.name || rd.side || null
    const hs = health(db, sideName)
    if (!hs.ok) { finish('held', `ready ${auto.readyStreak}/${promoteCycles} but side ${sideName || '?'} unhealthy: ${hs.reason}`); continue }
    const opp = opportunity(db, id, { now, windowH, side: sideName })
    const counts = { tickShadow: Number(opp?.tickShadow) || 0, timeApprovals: Number(opp?.timeApprovals) || 0, windowH, minTickShadow, side: sideName }
    const bar = Math.max(minTickShadow, counts.timeApprovals)
    if (!(counts.tickShadow >= bar)) {
      finish('held', `ready ${auto.readyStreak}/${promoteCycles} but opportunity tick ${counts.tickShadow} < max(min ${minTickShadow}, time ${counts.timeApprovals}) over ${windowH} h`, counts)
      continue
    }
    await switchTo('promoted', 'TIME_BASED', `ready ${auto.readyStreak}/${promoteCycles}, tick ${counts.tickShadow} ≥ max(min ${minTickShadow}, time ${counts.timeApprovals}) over ${windowH} h`, { readyStreak: auto.readyStreak, ...counts }, counts, [...new Set([...requested, 'bar', 'tick'])])
  }
  if (!out.evaluated.length) out.lines.push(`no account under policy auto (${out.manual.length} manual on the roster)`)
  return out
}
