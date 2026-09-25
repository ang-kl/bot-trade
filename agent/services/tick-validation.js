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
//   SHADOW_PASSED → TRADED_PASSED the account's OWN closed tick trades in R
//                                 (PR-B, owner principle 1: one stage for
//                                 every account — the demo-only stage and
//                                 the typed live approval it replaced are
//                                 read back as this one by engineStatusFor)
//   any → UNVALIDATED             a reset, with a reason (evidence withdrawn,
//                                 profile changed)
//
// The thresholds (agent/config/tick-validation.json) are risk limits the
// owner holds: a null threshold refuses every import at that stage with
// `thresholds_unset`. That is the ask-first rule (plan §12, CLAUDE.md P7)
// built in — the importer cannot pass a stage on a number nobody set.
// PR-H (11-09-2026): the owner SET them (docs/owner-principles-plan-2026-09-11.md
// §2 / §4 PR-H). Replay key mapping: `replay.minTestNetR` (the test block's
// net R ≥ x) is REPLACED by `replay.minExpectancyLowerR`, judged on the same
// TEST block — the out-of-sample block, plan §7 — as the bootstrap 5th
// percentile of its trades' R (lib/tick-replay-sim.js expectancyLowerR, the
// statistic the shadow stage already uses). A trial whose test block is
// withheld (a research run without includeTest) carries no such figure and
// cannot pass; a trial imported before the replayer wrote the figure reads
// null and cannot pass either — it is re-run, not waved through. The other
// three replay checks are unchanged: `trades` and `profitFactor` and
// `maxDrawdownR` read the trial's whole summary. `replayChecks` is exported
// so POST /actions/tick-research can report the verdict without moving a
// stage.
//
// What this never does: read strategy pins, the evidence gate, or any
// bar-strategy track record (TM-20: promotion cannot borrow time-strategy
// evidence); accept a trial whose profile differs from the pinned one;
// skip a stage; write anything on a refused import.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs'

import { getAccountState, setAccountState } from './account-registry.js'
import { getState } from '../db.js'
import { engineStatusFor, writeEngineStatus, basesFor } from './entry-mode.js'
import { VALIDATION_STAGES } from '../lib/entry-contracts.js'
import { profileHashFull, normalizeParams, PROFILE_ID } from '../lib/tick-strategy.js'
import { shadowPortfolio, sideCostSchedule } from './tick-shadow.js'
import { loadRepoSchedule, normalizeSchedule, rowChargedUnder, scheduleHash } from '../lib/tick-cost-schedule.js'
import { TICK_PRODUCER } from './entry-ledger.js'
import { realisedRR } from './trade-consistency.js'

export const TICK_VALIDATION_KEY = 'tick_validation_json'
export const THRESHOLDS_FILE = new URL('../config/tick-validation.json', import.meta.url)

const ORDER = VALIDATION_STAGES // ['UNVALIDATED', 'REPLAY_PASSED', 'SHADOW_PASSED', 'TRADED_PASSED']

export function loadThresholds({ file = THRESHOLDS_FILE } = {}) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    return {
      replay: { minTrades: num(raw?.replay?.minTrades), minProfitFactor: num(raw?.replay?.minProfitFactor), maxDrawdownR: num(raw?.replay?.maxDrawdownR), minExpectancyLowerR: num(raw?.replay?.minExpectancyLowerR), minTestTrades: num(raw?.replay?.minTestTrades) },
      shadow: { minSignals: num(raw?.shadow?.minSignals), minHours: num(raw?.shadow?.minHours), minTrades: num(raw?.shadow?.minTrades), minLosses: num(raw?.shadow?.minLosses), minProfitFactor: num(raw?.shadow?.minProfitFactor), minExpectancyLowerR: num(raw?.shadow?.minExpectancyLowerR), maxDrawdownR: num(raw?.shadow?.maxDrawdownR), maxResetSharePct: num(raw?.shadow?.maxResetSharePct) },
      traded: { minTrades: num(raw?.traded?.minTrades), minProfitFactor: num(raw?.traded?.minProfitFactor), maxDrawdownR: num(raw?.traded?.maxDrawdownR) },
    }
  } catch {
    return { replay: {}, shadow: {}, traded: {} }
  }
}

/**
 * PR-B: the TRADED stage's evidence — the account's OWN closed tick trades,
 * in R. Lineage is the entry ledger: a trade counts iff its broker position
 * was FILLED from a `tick_momentum` intent on this account (entry_intents →
 * trades.ctrader_position_id), so a time-based close on the same account
 * can never stand in for tick evidence (TM-20). R is realisedRR: the move
 * over the risk taken at entry. Profit factor is gross R won / gross R lost
 * (null with no losing trade — undefined, never infinite); drawdown is the
 * closed-equity drawdown in R, entry order.
 */
export function tradedTickEvidence(db, accountId) {
  let rows = []
  try {
    rows = db.prepare(`
      SELECT t.id, t.side, t.entry_price, t.exit_price, t.sl_price, t.broker_sl_initial, t.net_pnl, t.closed_at
        FROM trades t
        JOIN entry_intents i ON CAST(i.broker_position_id AS TEXT) = CAST(t.ctrader_position_id AS TEXT) AND i.account_id = t.account_id
       WHERE t.account_id = ? AND t.status = 'closed' AND t.ctrader_position_id IS NOT NULL
         AND i.producer_id = ? AND i.state = 'FILLED'
       GROUP BY t.id ORDER BY t.closed_at, t.id`).all(String(accountId), TICK_PRODUCER)
  } catch { rows = [] }
  const rs = rows.map(r => realisedRR(r)).filter(r => Number.isFinite(r))
  let grossWin = 0, grossLoss = 0, losses = 0, equity = 0, peak = 0, maxDD = 0
  for (const r of rs) {
    if (r > 0) grossWin += r; else if (r < 0) { grossLoss += -r; losses++ }
    equity += r; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity)
  }
  const round = (x) => Math.round(x * 1000) / 1000
  return {
    trades: rs.length, losses, unscorable: rows.length - rs.length,
    netR: round(equity),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    maxDrawdownR: round(maxDD),
    firstAt: rows[0]?.closed_at ?? null, lastAt: rows[rows.length - 1]?.closed_at ?? null,
  }
}

/**
 * PR-H: the replay stage's four checks over one trial (P4 ledger shape:
 * summary + blocks), against the owner's replay thresholds. `trades`,
 * `profitFactor` and `maxDrawdownR` read the whole summary; the expectancy
 * lower bound reads the TEST block (out of sample) and is null — failing —
 * when that block is withheld or predates the figure. The test block must
 * also hold at least `minTestTrades` trades (checker 11-09-2026: blocks are
 * cut by EVENT index, so a two-trade block carried a bootstrap figure and
 * a zero-trade block with a pasted figure passed; a block with no finite
 * trade count is refused too). Pure: reads nothing, writes nothing, so the
 * research route can report a verdict without moving the stage.
 */
export function replayChecks(trial, replay, { schedule = null } = {}) {
  const s = trial?.summary || {}
  // PR-L (checker, on §16.7): a trial replayed at ZERO cost cannot pass. The
  // replayer records what it charged on the trial's own sim — the class it
  // resolved (`costSource: 'class'`, not the schedule's fallback and not
  // 'none') and the four cost terms.
  //
  // ROUND-TWO CHECKER, MAJOR 2: `charged` was `> 0` and nothing more, so
  // `commissionBpsPerSide: 1e-12` cleared the rung and a trial at 1e-9
  // promoted an account end to end. The trial's `sim` arrives from OUTSIDE —
  // `body.sim.costs` wins over the repo default in researchPlan, and POST
  // /actions/tick-trials imports JSON produced off-box. The shadow rung pins
  // to scheduleHash(repo); this one now pins the same way: the sim's four
  // cost terms must EQUAL the repo schedule's row for the class it claims.
  const sim = trial?.sim || {}
  const repo = schedule || loadRepoSchedule()
  const term = (k) => Number(sim[k]) || 0
  const charged = term('commissionWirePerSide') > 0 || term('commissionBpsPerSide') > 0
    || term('slippageWirePerSide') > 0 || term('slippageBpsPerSide') > 0
    || term('commissionPerSide') > 0 || term('slippage') > 0
  const matches = rowChargedUnder({
    cost_class: sim.costClass,
    commission_wire: term('commissionWirePerSide'), commission_bps: term('commissionBpsPerSide'),
    slippage_wire: term('slippageWirePerSide'), slippage_bps: term('slippageBpsPerSide'),
  }, repo)
  const test = (trial?.blocks || []).find(b => b.name === 'test') || null
  const testLower = test && !test.withheld && typeof test.expectancyLowerR === 'number' && Number.isFinite(test.expectancyLowerR) ? test.expectancyLowerR : null
  const pf = typeof s.profitFactor === 'number' && Number.isFinite(s.profitFactor) ? s.profitFactor : null
  const testTrades = test && !test.withheld && typeof test.trades === 'number' && Number.isFinite(test.trades) ? test.trades : null
  const checks = {
    trades: { observed: Number(s.trades ?? 0), min: replay.minTrades, ok: Number(s.trades ?? 0) >= replay.minTrades },
    profitFactor: { observed: pf, min: replay.minProfitFactor, ok: pf != null && pf >= replay.minProfitFactor },
    maxDrawdownR: { observed: Number(s.maxDrawdownR ?? Infinity), max: replay.maxDrawdownR, ok: Number(s.maxDrawdownR ?? Infinity) <= replay.maxDrawdownR },
    testTrades: { observed: testTrades, min: replay.minTestTrades, ok: testTrades != null && testTrades >= replay.minTestTrades, block: 'test', withheld: !!(test && test.withheld) },
    expectancyLowerR: { observed: testLower, min: replay.minExpectancyLowerR, ok: testLower != null && testLower >= replay.minExpectancyLowerR, block: 'test', withheld: !!(test && test.withheld) },
    costModel: {
      observed: sim.costSource ?? 'unrecorded', costClass: sim.costClass ?? null, charged,
      schedule: matches.ok ? 'repo' : matches.reason, repoHash: Object.keys(repo.classes || {}).length ? scheduleHash(repo) : null,
      ok: sim.costSource === 'class' && charged === true && matches.ok === true,
      note: 'a trial replayed at zero cost, at a schedule that is not this repo\'s, or charged the fallback because its symbol id was never classified, cannot pass the replay rung',
    },
  }
  const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k)
  return { ok: failed.length === 0, failed, checks }
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
  // PR-L: `sim` is read back too — the replay rung judges the cost model the
  // trial was replayed at, and it was being dropped on the way out of the
  // ledger, so the check would have read 'unrecorded' on every stored trial.
  let sim = null
  try { sim = JSON.parse(r.sim_json) } catch { sim = null }
  return { trialId: r.trial_id, at: r.at, strategyId: r.strategy_id, version: r.version, profileHash: r.profile_hash, params: JSON.parse(r.params_json), sim, summary: JSON.parse(r.summary_json), blocks: JSON.parse(r.blocks_json) }
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
    rows = db.prepare(`SELECT id, at, body FROM action_log WHERE path = '/actions/tick-observation' AND account_id = ? ORDER BY id`).all(String(accountId))
  } catch { rows = [] }
  const switches = []
  for (const r of rows) { try { const b = JSON.parse(r.body); if (b?.to) switches.push({ id: r.id, at: r.at, to: b.to }) } catch { /* skip */ } }
  // Seconds resolution on both sides: action_log.at is datetime('now')
  // (no millis) while the pin's `at` carries them, so a switch recorded in
  // the pin's own second must not sort before it (PR-H: the pin itself
  // records the window's opening when the account is already in SHADOW).
  const pinKey = pinnedAtIso ? pinnedAtIso.replace(' ', 'T').replace(/\.\d+Z?$/, '').replace(/Z$/, '') : null
  const afterPin = pinKey ? switches.filter(sw => sw.at.replace(' ', 'T').replace(/\.\d+Z?$/, '') >= pinKey) : switches
  const first = afterPin.find(sw => sw.to === 'SHADOW') || null
  if (!first) return { since: null, broken: false, switches: afterPin }
  // Ordered by action_log.id, not by the seconds-resolution `at`: a switch
  // away in the same second as the opening row is still a break (checker
  // m-1, 11-09-2026 — the string compare on `at` hid it).
  const brokenBy = afterPin.find(sw => sw.id > first.id && sw.to !== 'SHADOW') || null
  return { since: first.at, broken: !!brokenBy, brokenBy, switches: afterPin }
}

/**
 * Import one piece of evidence and move the stage by exactly one step (or
 * reset). Returns { ok, reason, ... } and writes nothing when refused.
 *
 *   stage 'REPLAY_PASSED'  evidence { trialId }
 *   stage 'SHADOW_PASSED'  evidence {} (read from cpp_decisions)
 *   stage 'TRADED_PASSED'  evidence {} (read from the account's own closed tick trades)
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
    // WP-A (dual admission, 25-09-2026): a reset on an account that admits
    // tick — TICK_MOMENTUM, or TIME_BASED + ['bar','tick'] — would write a
    // record the contract refuses (tick admitted below SHADOW_PASSED) and
    // throw a 500. Refused with a named reason instead, before anything is
    // written: remove tick through POST /actions/entry-mode first. Nothing is
    // cleared behind the owner's back — the admitted set is the owner's.
    // The contract (entry-contracts.js) counts tick as admitted whenever the
    // effective mode is TICK_MOMENTUM, whatever the set says — so a
    // TICK_MOMENTUM account narrowed through the overlay to ['bar'] (basesFor
    // then answers bar alone) is refused on the MODE too, here, rather than
    // thrown out of writeEngineStatus as a 500 (checker nit 1, 25-09-2026).
    // The requested mode is asked as well: a WARMING TICK_MOMENTUM request
    // would write an effective tick mode at its ack.
    const admitted = [...new Set([...basesFor(cur), ...basesFor({ ...cur, effectiveEntryMode: cur.requestedEntryMode }), ...(Array.isArray(cur.admittedBases) ? cur.admittedBases : [])])]
    const tickMode = cur.effectiveEntryMode === 'TICK_MOMENTUM' || cur.requestedEntryMode === 'TICK_MOMENTUM'
    if (admitted.includes('tick') || tickMode) {
      const modeNote = tickMode && !admitted.includes('tick') ? `; effective ${cur.effectiveEntryMode}, and the contract counts TICK_MOMENTUM as admitting tick whatever the set` : ''
      return { ok: false, reason: `tick_admitted: the account admits ${admitted.join('+') || 'nothing'} (requested ${cur.requestedEntryMode}${modeNote}); remove tick through POST /actions/entry-mode (Time-based or Stop) before resetting its evidence`, bases: admitted }
    }
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
      const { failed, checks } = replayChecks(trial, th.replay)
      if (failed.includes('testTrades')) return { ok: false, reason: 'test_block_too_small', failed, checks, note: `the test block holds ${checks.testTrades.observed ?? 'no counted'} trade(s); the bootstrap bound needs at least ${th.replay.minTestTrades}` }
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
      // ROUND-TWO CHECKER, BLOCKER 1/2: the verdict is computed ONLY over rows
      // the sidecar's book demonstrably charged THE SCHEDULE IT REPORTED —
      // each row's four recorded cost terms equal to that schedule's class
      // row, and each row's own netR consistent with them. That is the path
      // from the verdict back to what a book actually subtracted; the four
      // /health checks below prove only what the sidecar SAID.
      let sim = null
      try { sim = JSON.parse(getState(db, `${side}_tick_json`) || 'null')?.status?.shadowPortfolio?.sim ?? null } catch { sim = null }
      const sidecarCosts = sim && sim.costs && typeof sim.costs === 'object' ? sim.costs : null
      const chargedUnder = sidecarCosts ? normalizeSchedule(sidecarCosts) : null
      const pf = shadowPortfolio(db, { side, profilePrefix: prefix, sinceMs: Date.parse(since.replace(' ', 'T') + 'Z'), chargedUnder })
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
      // PR-L: the COST SCHEDULE that produced this verdict, on the record.
      // The sidecar echoes the schedule its books run at inside `sim.costs`;
      // the hash of that is what pins the verdict to one cost model, and the
      // repo's own hash beside it makes a drift between the two visible
      // instead of implied. A sidecar that reports no sim leaves the hash
      // NULL and says so — never the repo's, which it may not be running.
      const repoSchedule = loadRepoSchedule()
      const repoHash = Object.keys(repoSchedule.classes).length ? scheduleHash(repoSchedule) : null
      const costSchedule = {
        hash: sidecarCosts ? scheduleHash(sidecarCosts) : null,
        source: sidecarCosts ? 'sidecar_reported_sim' : (sim ? 'sidecar_sim_without_costs' : 'sidecar_sim_unavailable'),
        fallbackClass: sidecarCosts ? normalizeSchedule(sidecarCosts).fallbackClass : null,
        classes: sidecarCosts ? normalizeSchedule(sidecarCosts).classes : null,
        symbolsPriced: sidecarCosts && sidecarCosts.symbolClass && typeof sidecarCosts.symbolClass === 'object' ? Object.keys(sidecarCosts.symbolClass).length : 0,
        repoHash,
        matchesRepo: sidecarCosts != null && repoHash != null ? scheduleHash(sidecarCosts) === repoHash : null,
      }
      const portfolio = { costAudit: pf.costAudit, trades: pf.trades, losses: pf.losses, netR: pf.netR, profitFactor: pf.profitFactor, expectancyLowerR: pf.expectancyLowerR, maxDrawdownR: pf.maxDrawdownR, maxConcurrentOpen: pf.maxConcurrentOpen, exits: pf.exits, resets: pf.resets, lost: pf.lost, resetSharePct: pf.resetSharePct, hours: pf.hours, symbols: pf.symbols }
      // Provenance (plan §7): the sim the book ran at, the sidecar boots the
      // trades came from, the window's switches — on the record, not implied.
      const anyCharged = costSchedule.classes
        ? Object.values(costSchedule.classes).some(c => c.commissionWirePerSide > 0 || c.commissionBpsPerSide > 0 || c.slippageWirePerSide > 0 || c.slippageBpsPerSide > 0)
        : false
      const charged = anyCharged || Number(sim?.slippage) > 0 || Number(sim?.commissionPerSide) > 0
      // CHECKER BLOCKER 1 + 2: four BLOCKING checks, so the schedule is not
      // merely recorded NEXT TO the verdict but stands between the evidence
      // and the stage. Each has its own name in `failed`.
      //   scheduleKnown   — the sidecar told us what it charges, at all
      //   scheduleCharged — what it charges is not zero
      //   scheduleMatchesRepo — it is the schedule this repo holds, not a drift
      //   symbolMap       — it prices at least one symbol, and prices the SAME
      //                     symbols the keeper last pushed (a stale map hashes
      //                     identically, because the map is not in the hash)
      const costMap = sideCostSchedule(db, side)
      const sidecarMap = sidecarCosts && sidecarCosts.symbolClass && typeof sidecarCosts.symbolClass === 'object' ? sidecarCosts.symbolClass : {}
      const pushedMap = costMap.symbolClass || {}
      const mapKeys = Object.keys(sidecarMap)
      const mapAgrees = mapKeys.length > 0 && mapKeys.length === Object.keys(pushedMap).length
        && mapKeys.every(k => String(pushedMap[k] || '') === String(sidecarMap[k]))
      const costChecks = {
        costScheduleKnown: { observed: costSchedule.source, expected: 'sidecar_reported_sim', ok: costSchedule.source === 'sidecar_reported_sim' && costSchedule.hash != null },
        costScheduleCharged: { observed: charged, expected: true, ok: charged === true },
        costScheduleMatchesRepo: { observed: costSchedule.matchesRepo, sidecar: costSchedule.hash, repo: costSchedule.repoHash, ok: costSchedule.matchesRepo === true },
        costSymbolMap: { observed: costSchedule.symbolsPriced, pushed: Object.keys(pushedMap).length, agrees: mapAgrees, ok: costSchedule.symbolsPriced > 0 && mapAgrees },
        // The one that reaches the books. The four above are the sidecar's
        // self-declaration and the keeper comparing its map to its own; this
        // one says every row the verdict rests on carries that schedule's own
        // numbers and spent them. Without it, six rows with `cost_class:'fx'`
        // and four zero cost terms passed the whole gate.
        costRowsCharged: {
          observed: pf.costAudit.charged, closed: pf.costAudit.closed,
          preCostModel: pf.costAudit.preCostModel, refused: pf.costAudit.refused,
          min: th.shadow.minTrades,
          // An EMPTY window is not a cost-model problem — there is simply no
          // evidence yet, and `trades` below says so. This check speaks only
          // when closed rows exist: then the bar must be met by rows that
          // were demonstrably charged, not by rows that merely claim a class.
          ok: (pf.costAudit.closed ?? 0) === 0 || (pf.costAudit.charged ?? 0) >= th.shadow.minTrades,
        },
      }
      Object.assign(checks, costChecks)
      const provenance = {
        sim, bootIds: pf.bootIds, window: { since, pinnedAt, switches: win.switches },
        // PR-L: the schedule this verdict was earned under, so a verdict can
        // never be read as if it had been earned under another one.
        costSchedule,
        costSensitivity: pf.costSensitivity ?? null,
        costsNote: charged
          ? `per-symbol-class cost schedule ${costSchedule.hash || '(unhashable)'}${costSchedule.matchesRepo === false ? ' — DIFFERS from the repo schedule ' + costSchedule.repoHash : ''}`
          : 'spread-only costs (no per-class schedule and no absolute slippage/commission) — this profit factor is an upper bound',
      }
      const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k)
      const costFailed = failed.filter(k => k in costChecks)
      if (costFailed.length) {
        return {
          ok: false, reason: 'shadow_cost_model_unproven', failed, costFailed, checks,
          note: 'the shadow figures cannot be shown to have been earned under a charged cost model, so they cannot move the stage. ' +
            `In this window: ${pf.costAudit.closed} closed row(s), of which ${pf.costAudit.charged ?? 0} were charged the schedule the sidecar reports; ` +
            `${pf.costAudit.preCostModel} predate the cost model entirely, and ${pf.costAudit.lostRestart} open trade(s) were lost to a restart and have no result.`,
          evidence: { signals: ev, portfolio, provenance },
        }
      }
      if (failed.length) return { ok: false, reason: 'shadow_below_threshold', failed, checks, evidence: { signals: ev, portfolio, provenance } }
      record.evidence = { side, since, signals: ev, portfolio, provenance, checks }
      next.validationStage = 'SHADOW_PASSED'
    } else if (stage === 'TRADED_PASSED') {
      // PR-B (owner principle 1): the same stage on every account, judged on
      // the account's own closed tick trades — no environment test. PR-H set
      // the thresholds; a null here still refuses (thresholds_unset).
      const missing = unset(th.traded)
      if (missing.length) return { ok: false, reason: 'thresholds_unset', unset: missing.map(k => `traded.${k}`) }
      if (!cur.profileHash) return { ok: false, reason: 'no_profile_pinned' }
      const ev = tradedTickEvidence(db, id)
      const checks = {
        trades: { observed: ev.trades, min: th.traded.minTrades, ok: ev.trades >= th.traded.minTrades },
        profitFactor: { observed: ev.profitFactor, min: th.traded.minProfitFactor, ok: ev.profitFactor != null && ev.profitFactor >= th.traded.minProfitFactor },
        maxDrawdownR: { observed: ev.maxDrawdownR, max: th.traded.maxDrawdownR, ok: ev.maxDrawdownR <= th.traded.maxDrawdownR },
      }
      const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k)
      if (failed.length) return { ok: false, reason: 'traded_below_threshold', failed, checks, evidence: ev }
      record.evidence = { traded: ev, checks }
      next.validationStage = 'TRADED_PASSED'
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
  // PR-H (owner principle 3): the shadow window opens at the FIRST SHADOW
  // switch AFTER the pin (shadowWindow). With config/tick-observation.json
  // seeding SHADOW on every account at boot, the switch predates the pin
  // on every account and SHADOW_PASSED would refuse shadow_switch_unrecorded
  // for ever unless an operator re-posted the switch by hand. So the pin
  // itself records the opening when the account is already in SHADOW — at
  // the pin's own time, which no operator chooses, so no losing stretch
  // can be excluded by it. Written only on a successful pin (nothing above
  // runs on a refusal).
  if (stage === 'REPLAY_PASSED' && cur.tickObservation === 'SHADOW') {
    try {
      db.prepare('INSERT INTO action_log (at, method, path, body, account_id) VALUES (?, ?, ?, ?, ?)')
        .run(now.toISOString().slice(0, 19).replace('T', ' '), 'POST', '/actions/tick-observation', JSON.stringify({ accountId: id, from: 'SHADOW', to: 'SHADOW', revision: saved.configRevision, actor: 'tick-validation:pin', note: 'already in SHADOW at the pin: the shadow window opens here' }), id)
    } catch { /* audit best-effort */ }
  }
  return { ok: true, status: saved, record }
}
