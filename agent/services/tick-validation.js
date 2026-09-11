// ---------------------------------------------------------------------------
// agent/services/tick-validation.js — P5 (docs/tick-momentum/plan.md §2, §7,
// §12; register TM-20): the validation-stage importer.
//
// The account record's `validationStage` moves ONLY through here, one stage
// at a time, on evidence that names the profile it was produced with:
//
//   UNVALIDATED → REPLAY_PASSED   a trial in tick_trials (P4 ledger) whose
//                                 profile hash the record pins — or, on the
//                                 first import, PINS the record to that hash
//   REPLAY_PASSED → SHADOW_PASSED the shadow's OWN portfolio (P6a): closed
//                                 shadow trades under the SAME profile since
//                                 the account's SHADOW switch — trades, profit
//                                 factor and drawdown in R — plus the signal
//                                 count and hours
//   SHADOW_PASSED → DEMO_PASSED   closed tick trades on a demo account
//                                 (P6 produces them; refused until then)
//   DEMO_PASSED → LIVE_APPROVED   the owner's word, typed as the stage name
//   any → UNVALIDATED             a reset, with a reason (evidence withdrawn,
//                                 profile changed)
//
// The thresholds (agent/config/tick-validation.json) are risk limits the
// owner holds: a null threshold refuses every import at that stage with
// `thresholds_unset`. That is the ask-first rule (plan §12, CLAUDE.md P7)
// built in — the importer cannot pass a stage on a number nobody set.
//
// What this never does: read strategy pins, the evidence gate, or any
// bar-strategy track record (TM-20: promotion cannot borrow time-strategy
// evidence); accept a trial whose profile differs from the pinned one;
// skip a stage; write anything on a refused import.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs'

import { getAccountState, setAccountState } from './account-registry.js'
import { getState } from '../db.js'
import { engineStatusFor, writeEngineStatus } from './entry-mode.js'
import { VALIDATION_STAGES } from '../lib/entry-contracts.js'
import { profileHashFull, normalizeParams, PROFILE_ID } from '../lib/tick-strategy.js'
import { shadowPortfolio } from './tick-shadow.js'

export const TICK_VALIDATION_KEY = 'tick_validation_json'
export const THRESHOLDS_FILE = new URL('../config/tick-validation.json', import.meta.url)

const ORDER = VALIDATION_STAGES // ['UNVALIDATED', 'REPLAY_PASSED', 'SHADOW_PASSED', 'DEMO_PASSED', 'LIVE_APPROVED']

export function loadThresholds({ file = THRESHOLDS_FILE } = {}) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    return {
      replay: { minTrades: num(raw?.replay?.minTrades), minProfitFactor: num(raw?.replay?.minProfitFactor), minTestNetR: num(raw?.replay?.minTestNetR), maxDrawdownR: num(raw?.replay?.maxDrawdownR) },
      shadow: { minSignals: num(raw?.shadow?.minSignals), minHours: num(raw?.shadow?.minHours), minTrades: num(raw?.shadow?.minTrades), minLosses: num(raw?.shadow?.minLosses), minProfitFactor: num(raw?.shadow?.minProfitFactor), minExpectancyLowerR: num(raw?.shadow?.minExpectancyLowerR), maxDrawdownR: num(raw?.shadow?.maxDrawdownR), maxResetSharePct: num(raw?.shadow?.maxResetSharePct) },
      demo: { minClosedTrades: num(raw?.demo?.minClosedTrades), minProfitFactor: num(raw?.demo?.minProfitFactor), maxDrawdownR: num(raw?.demo?.maxDrawdownR) },
    }
  } catch {
    return { replay: {}, shadow: {}, demo: {} }
  }
}

function unset(group) {
  return Object.entries(group || {}).filter(([, v]) => v == null).map(([k]) => k)
}

export function validationHistory(db, accountId) {
  try { return JSON.parse(getAccountState(db, String(accountId), TICK_VALIDATION_KEY) || '[]') || [] } catch { return [] }
}

function trialById(db, trialId) {
  let r = null
  try { r = db.prepare('SELECT * FROM tick_trials WHERE trial_id = ?').get(String(trialId)) } catch { r = null }
  if (!r) return null
  return { trialId: r.trial_id, at: r.at, strategyId: r.strategy_id, version: r.version, profileHash: r.profile_hash, params: JSON.parse(r.params_json), summary: JSON.parse(r.summary_json), blocks: JSON.parse(r.blocks_json) }
}

/** Shadow signals rung on the account's side under a profile since a time. */
export function shadowSignalEvidence(db, { side, profilePrefix, sinceIso }) {
  let rows = []
  try {
    rows = db.prepare(`SELECT at, ts_ms, symbol_id, code, detail FROM cpp_decisions WHERE side = ? AND component = 'tick' AND kind = 'signal' AND at >= ? ORDER BY id`).all(side, sinceIso)
  } catch { rows = [] }
  const matching = rows.filter(r => String(r.detail || '').includes(`profile=${profilePrefix}`))
  const first = matching[0]?.at || null, last = matching[matching.length - 1]?.at || null
  const hours = first && last ? (Date.parse(last + 'Z') - Date.parse(first + 'Z')) / 3_600_000 : 0
  return { signals: matching.length, otherProfile: rows.length - matching.length, symbols: new Set(matching.map(r => r.symbol_id)).size, firstAt: first, lastAt: last, hours: +Math.max(0, hours).toFixed(2) }
}

/**
 * The observation window (Statistics auditor, 11-09-2026): it opens at the
 * FIRST SHADOW switch after the profile was pinned and must run unbroken —
 * any switch away from SHADOW after that breaks it, and the stage refuses
 * until the profile is re-pinned (a reset to UNVALIDATED). Before this the
 * window opened at the LATEST switch, so cycling SHADOW→OFF→SHADOW after a
 * losing stretch excluded it: an owner-resettable peeking channel.
 */
export function shadowWindow(db, accountId, pinnedAtIso) {
  let rows = []
  try {
    rows = db.prepare(`SELECT at, body FROM action_log WHERE path = '/actions/tick-observation' AND account_id = ? ORDER BY id`).all(String(accountId))
  } catch { rows = [] }
  const switches = []
  for (const r of rows) { try { const b = JSON.parse(r.body); if (b?.to) switches.push({ at: r.at, to: b.to }) } catch { /* skip */ } }
  const afterPin = pinnedAtIso ? switches.filter(sw => sw.at.replace(' ', 'T') >= pinnedAtIso.replace(' ', 'T').replace(/Z$/, '')) : switches
  const first = afterPin.find(sw => sw.to === 'SHADOW') || null
  if (!first) return { since: null, broken: false, switches: afterPin }
  const later = afterPin.filter(sw => sw.at > first.at)
  const brokenBy = later.find(sw => sw.to !== 'SHADOW') || null
  return { since: first.at, broken: !!brokenBy, brokenBy, switches: afterPin }
}

/**
 * Import one piece of evidence and move the stage by exactly one step (or
 * reset). Returns { ok, reason, ... } and writes nothing when refused.
 *
 *   stage 'REPLAY_PASSED'  evidence { trialId }
 *   stage 'SHADOW_PASSED'  evidence {} (read from cpp_decisions)
 *   stage 'DEMO_PASSED'    evidence { closedTrades, profitFactor, maxDrawdownR } (P6 supplies)
 *   stage 'LIVE_APPROVED'  evidence { approval: 'LIVE_APPROVED' } typed by the owner
 *   stage 'UNVALIDATED'    evidence { reason }
 */
export function importTickValidation(db, { accountId, stage, evidence = {}, actor = 'owner', now = new Date(), thresholds = null, file = THRESHOLDS_FILE } = {}) {
  const id = String(accountId || '')
  if (!id) return { ok: false, reason: 'no_account' }
  if (!ORDER.includes(stage)) return { ok: false, reason: `unknown_stage: ${stage}` }
  const th = thresholds || loadThresholds({ file })
  const cur = engineStatusFor(db, id)
  if (cur.invalid) return { ok: false, reason: 'engine_record_invalid', invalid: cur.invalid }
  const from = cur.validationStage
  const fromIdx = ORDER.indexOf(from), toIdx = ORDER.indexOf(stage)
  let record = { stage, from, at: now.toISOString(), actor, evidence: {}, profileHash: cur.profileHash }
  let next = { ...cur }

  if (stage === 'UNVALIDATED') {
    if (from === 'UNVALIDATED') return { ok: false, reason: 'already_unvalidated' }
    if (!evidence.reason) return { ok: false, reason: 'reset_needs_reason' }
    record.evidence = { reason: String(evidence.reason) }
    next.validationStage = 'UNVALIDATED'
  } else {
    if (toIdx !== fromIdx + 1) return { ok: false, reason: `stage_order: ${from} → ${stage} is not the next stage (${ORDER[fromIdx + 1] || 'none'})` }
    if (stage === 'REPLAY_PASSED') {
      const missing = unset(th.replay)
      if (missing.length) return { ok: false, reason: 'thresholds_unset', unset: missing.map(k => `replay.${k}`), note: 'owner-held risk limits (agent/config/tick-validation.json); nothing passes on a number nobody set' }
      const trial = evidence.trialId ? trialById(db, evidence.trialId) : null
      if (!trial) return { ok: false, reason: 'trial_not_found', trialId: evidence.trialId ?? null }
      const full = profileHashFull(normalizeParams(trial.params))
      if (!full.startsWith(trial.profileHash)) return { ok: false, reason: 'trial_hash_mismatch', note: 'the trial\'s stored hash does not match its own parameters' }
      if (cur.profileHash && cur.profileHash !== full) return { ok: false, reason: 'profile_mismatch', pinned: cur.profileHash.slice(0, 16), trial: trial.profileHash, note: 'evidence for another profile cannot promote this one (TM-20); reset to UNVALIDATED to re-pin' }
      const test = (trial.blocks || []).find(b => b.name === 'test') || null
      const s = trial.summary || {}
      const checks = {
        trades: { observed: Number(s.trades ?? 0), min: th.replay.minTrades, ok: Number(s.trades ?? 0) >= th.replay.minTrades },
        profitFactor: { observed: Number(s.profitFactor ?? 0), min: th.replay.minProfitFactor, ok: Number(s.profitFactor ?? 0) >= th.replay.minProfitFactor },
        testNetR: { observed: Number(test?.netR ?? 0), min: th.replay.minTestNetR, ok: test != null && Number(test.netR ?? 0) >= th.replay.minTestNetR },
        maxDrawdownR: { observed: Number(s.maxDrawdownR ?? Infinity), max: th.replay.maxDrawdownR, ok: Number(s.maxDrawdownR ?? Infinity) <= th.replay.maxDrawdownR },
      }
      const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k)
      if (failed.length) return { ok: false, reason: 'replay_below_threshold', failed, checks }
      record.evidence = { trialId: trial.trialId, profile: trial.profileHash, checks }
      record.profileHash = full
      next.profileHash = full
      next.profileId = PROFILE_ID
      next.validationStage = 'REPLAY_PASSED'
    } else if (stage === 'SHADOW_PASSED') {
      const missing = unset(th.shadow)
      if (missing.length) return { ok: false, reason: 'thresholds_unset', unset: missing.map(k => `shadow.${k}`) }
      if (!cur.profileHash) return { ok: false, reason: 'no_profile_pinned' }
      if (cur.tickObservation !== 'SHADOW') return { ok: false, reason: 'observation_not_shadow', observed: cur.tickObservation }
      const pinnedAt = [...validationHistory(db, id)].reverse().find(h => h.stage === 'REPLAY_PASSED' && h.profileHash === cur.profileHash)?.at || null
      const win = shadowWindow(db, id, pinnedAt)
      if (!win.since) return { ok: false, reason: 'shadow_switch_unrecorded', note: 'no /actions/tick-observation SHADOW row in action_log for this account since the profile was pinned', switches: win.switches }
      if (win.broken) return { ok: false, reason: 'shadow_window_broken', note: 'the observation left SHADOW after the window opened; the window cannot be re-opened by switching back (that would let a losing stretch be excluded) — reset to UNVALIDATED and re-pin the profile', brokenBy: win.brokenBy, switches: win.switches }
      const since = win.since
      const side = cur.environment === 'live' ? 'cpp_exec' : 'cpp_exec_demo'
      const prefix = cur.profileHash.slice(0, 16)
      const ev = shadowSignalEvidence(db, { side, profilePrefix: prefix, sinceIso: since })
      // P6a (plan §2): the shadow's OWN portfolio is the evidence — closed
      // shadow trades under this profile since the window opened, judged in
      // R: enough trades AND enough losses (a profit factor with no losing
      // trade is undefined, never infinite), the profit factor, the 5th
      // percentile of bootstrapped expectancy, the closed-equity drawdown,
      // and the share of trades that were marked at a reset or lost to a
      // restart rather than closed by the rule.
      const pf = shadowPortfolio(db, { side, profilePrefix: prefix, sinceMs: Date.parse(since.replace(' ', 'T') + 'Z') })
      const checks = {
        signals: { observed: ev.signals, min: th.shadow.minSignals, ok: ev.signals >= th.shadow.minSignals },
        hours: { observed: ev.hours, min: th.shadow.minHours, ok: ev.hours >= th.shadow.minHours },
        trades: { observed: pf.trades, min: th.shadow.minTrades, ok: pf.trades >= th.shadow.minTrades },
        losses: { observed: pf.losses, min: th.shadow.minLosses, ok: pf.losses >= th.shadow.minLosses },
        profitFactor: { observed: pf.profitFactor, min: th.shadow.minProfitFactor, ok: pf.profitFactor != null && pf.profitFactor >= th.shadow.minProfitFactor },
        expectancyLowerR: { observed: pf.expectancyLowerR, min: th.shadow.minExpectancyLowerR, ok: pf.expectancyLowerR != null && pf.expectancyLowerR >= th.shadow.minExpectancyLowerR },
        maxDrawdownR: { observed: pf.maxDrawdownR, max: th.shadow.maxDrawdownR, ok: pf.maxDrawdownR <= th.shadow.maxDrawdownR },
        resetSharePct: { observed: pf.resetSharePct, max: th.shadow.maxResetSharePct, ok: pf.resetSharePct != null && pf.resetSharePct <= th.shadow.maxResetSharePct },
      }
      let sim = null
      try { sim = JSON.parse(getState(db, `${side}_tick_json`) || 'null')?.status?.shadowPortfolio?.sim ?? null } catch { sim = null }
      const portfolio = { trades: pf.trades, losses: pf.losses, netR: pf.netR, profitFactor: pf.profitFactor, expectancyLowerR: pf.expectancyLowerR, maxDrawdownR: pf.maxDrawdownR, maxConcurrentOpen: pf.maxConcurrentOpen, exits: pf.exits, resets: pf.resets, lost: pf.lost, resetSharePct: pf.resetSharePct, hours: pf.hours, symbols: pf.symbols }
      // Provenance (plan §7): the sim the book ran at, the sidecar boots the
      // trades came from, the window's switches — on the record, not implied.
      const provenance = { sim, bootIds: pf.bootIds, window: { since, pinnedAt, switches: win.switches }, costsNote: sim && (Number(sim.slippage) > 0 || Number(sim.commissionPerSide) > 0) ? 'owner-set slippage/commission' : 'spread-only costs (slippage and commission 0)' }
      const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k)
      if (failed.length) return { ok: false, reason: 'shadow_below_threshold', failed, checks, evidence: { signals: ev, portfolio, provenance } }
      record.evidence = { side, since, signals: ev, portfolio, provenance, checks }
      next.validationStage = 'SHADOW_PASSED'
    } else if (stage === 'DEMO_PASSED') {
      const missing = unset(th.demo)
      if (missing.length) return { ok: false, reason: 'thresholds_unset', unset: missing.map(k => `demo.${k}`) }
      if (cur.environment !== 'demo') return { ok: false, reason: 'not_a_demo_account' }
      // P6 produces the demo trades and passes them here; until then every
      // import lands on this refusal, honestly.
      return { ok: false, reason: 'demo_evidence_not_produced: the tick entry path (P6) has not produced closed tick trades' }
    } else if (stage === 'LIVE_APPROVED') {
      if (evidence.approval !== 'LIVE_APPROVED') return { ok: false, reason: 'approval_word_required', note: 'the owner types the stage name as evidence.approval' }
      if (actor !== 'owner') return { ok: false, reason: 'owner_only' }
      record.evidence = { approval: 'LIVE_APPROVED' }
      next.validationStage = 'LIVE_APPROVED'
    }
  }
  next.configRevision = cur.configRevision + 1
  next.updatedAt = now.toISOString()
  const saved = writeEngineStatus(db, next)
  const history = validationHistory(db, id)
  history.push({ ...record, revision: saved.configRevision })
  setAccountState(db, id, TICK_VALIDATION_KEY, JSON.stringify(history.slice(-50)))
  try {
    db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
      .run('POST', '/actions/tick-validation', JSON.stringify({ accountId: id, from, to: saved.validationStage, revision: saved.configRevision, profile: saved.profileHash ? saved.profileHash.slice(0, 16) : null, actor }), id)
  } catch { /* audit best-effort */ }
  return { ok: true, status: saved, record }
}
