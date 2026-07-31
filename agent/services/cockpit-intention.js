// ---------------------------------------------------------------------------
// cockpit-intention.js — PHASE 5 of the cockpit live-wiring prompt: the
// deterministic intention, armed-actions and invalidation block.
//
// Everything here is READ + RESTATE. The sources are the ones the bot already
// manages positions with: the monitored_positions row (thesis, invalidation
// trigger, time cap, guard_json, the last_check_* review columns), the trade
// and its analysis row, the asset-class R-rules (rulesForSymbol — the SAME
// merge position-manager runs with), the profit-keeper config, and the
// halt/pause flags. The prompt's rule: intention explains what the bot is
// CONFIGURED to do next, not what it hopes will happen — so every trigger
// stated below is a rule the management code actually enforces, attributed to
// the module that enforces it.
//
// Evidence discipline: every claim carries stable evidence IDs, resolvable in
// the returned evidenceIndex (id → {source, asOf, value}). The deterministic
// explanation appends its evidence IDs to every sentence in [brackets] so the gate
// test can verify no sentence floats free of the bundle. A rule is not
// evidence that its trigger is met: distances/ETAs are computed only when a
// live price exists; otherwise they are null, never a guess.
// ---------------------------------------------------------------------------
import { getState } from '../db.js'
import { rulesForSymbol } from './asset-controllers.js'
import { currentR, priceAtR, evaluatePosition, _internal as pmInternal } from './position-manager.js'
import { loadProfitKeeperConfig } from './profit-keeper.js'
import { loadGlobalGuards } from './global-guards.js'
import { loadRiskConfig } from './risk.js'
import { trippedKey } from './equity-stop.js'

const parseJson = (s) => { try { return s ? JSON.parse(s) : null } catch { return null } }

/**
 * Build the contract's intention block for one position.
 *
 * @param {object} db better-sqlite3 handle
 * @param {object} row monitored_positions JOIN trades row (needs the mp.*
 *   columns plus trade_strategy/conviction/analysis_id from the snapshot's
 *   SELECT)
 * @param {object|null} live this position's row from the broker snapshot
 *   cache (already account-checked by the caller), or null
 * @param {string|null} liveAt cache fetchedAt
 * @param {string} revision meta.revision — stamped on the explanation so
 *   callers cache it correctly
 * @param {number} nowMs
 */
export function buildIntention(db, row, live, liveAt, revision, nowMs = Date.now()) {
  const now = new Date(nowMs)
  const accountId = row.account_id == null ? null : String(row.account_id)
  const evidenceIndex = {}
  const ev = (id, source, asOf, value) => {
    if (!(id in evidenceIndex)) evidenceIndex[id] = { source, asOf: asOf ?? null, value: value ?? null }
    return id
  }

  // --- Stored plan facts ---------------------------------------------------
  const mpId = row.id
  const thesis = row.thesis ?? null
  if (thesis != null) ev(`mp:${mpId}:thesis`, 'monitored_positions.thesis', row.created_at, thesis)

  const analysis = row.analysis_id != null
    ? (() => { try { return db.prepare('SELECT synthesis, risk_note, tp1_price, tp2_price, time_cap_minutes FROM analyses WHERE id = ?').get(row.analysis_id) } catch { return null } })()
    : null
  const entryRationale = analysis?.risk_note ?? null
  if (entryRationale != null) ev(`analysis:${row.analysis_id}:risk_note`, 'analyses.risk_note', null, entryRationale)

  const guard = parseJson(row.guard_json)
  if (guard) ev(`mp:${mpId}:guard_json`, 'monitored_positions.guard_json', null, guard)

  // The rules position-manager actually applies to this symbol: global
  // defaults ← asset-class defaults ← owner overrides.
  const rules = rulesForSymbol(db, row.symbol)
  const rulesEv = ev(`rules:${rules._assetClass}`, 'asset-controllers rulesForSymbol (position-manager defaults ← class ← owner override)', null,
    { beTriggerR: rules.beTriggerR, partialTriggerR: rules.partialTriggerR, runnerTriggerR: rules.runnerTriggerR, runnerTrailR: rules.runnerTrailR, bankTriggerR: rules.bankTriggerR })

  const keeperCfg = loadProfitKeeperConfig(db)
  const keeperApplies = keeperCfg.on && !guard && row.keeper_opt_out !== 1 &&
    (keeperCfg.scope === 'all'
      ? (row.source == null || ['autopilot', 'external', 'manual'].includes(row.source))
      : ['external', 'manual'].includes(row.source))
  if (keeperApplies) ev('state:profit_keeper_json', 'agent_state.profit_keeper_json', null, { mode: keeperCfg.mode, scope: keeperCfg.scope })

  // Which module manages this position — the same precedence the loop runs:
  // guard_json rows belong to trade-guard (keeper and guardian skip them),
  // external/manual rows to the profit keeper, bot rows to position-manager.
  const manager = guard ? 'trade_guard' : keeperApplies ? 'profit_keeper' : 'position_manager'

  // --- Live-derived R (never guessed) --------------------------------------
  const price = live?.price ?? null
  const posShape = { side: row.side, entry_price: row.entry_price, initial_risk: row.initial_risk }
  const r = price != null ? currentR(posShape, price) : null
  if (price != null) ev('snapshot:price', 'broker-snapshot-cache', liveAt, price)

  // --- Blocking / pause state ----------------------------------------------
  const execGuard = parseJson(getState(db, 'exec_guard_json'))
  const globalGuards = loadGlobalGuards(db)
  const execHalt = execGuard?.halt === true
  const globalHalt = globalGuards?.halt === true
  if (execHalt) ev('state:exec_guard_json', 'agent_state.exec_guard_json', null, { halt: true })
  if (globalHalt) ev('state:global_guards_json', 'agent_state.global_guards_json', null, { halt: true })
  const paused = row.paused === 1
  if (paused) ev(`mp:${mpId}:paused`, 'monitored_positions.paused', null, 1)
  const equityTrippedAt = accountId != null ? (getState(db, trippedKey(accountId)) || null) : null
  if (equityTrippedAt) ev(`state:${trippedKey(accountId)}`, 'agent_state (equity stop)', equityTrippedAt, equityTrippedAt)

  // --- currentDecision: the bot's LATEST recorded review, verbatim ---------
  const lastAction = row.last_check_action ?? null
  let lastReason = row.last_check_reasoning ?? null
  // The weekend watch stores its reasoning as a JSON payload — surface the
  // human sentence, keep the rest as evidence.
  const weekendDetail = lastAction?.startsWith('WEEKEND:') ? parseJson(lastReason) : null
  if (weekendDetail?.reasoning) lastReason = weekendDetail.reasoning
  const checkEv = lastAction != null
    ? ev(`mp:${mpId}:last_check`, `monitored_positions.last_check_* (writer: ${reviewSource(lastAction)})`, row.last_check_at,
        { action: lastAction, thesis_status: row.thesis_status ?? null, ...(weekendDetail ? { weekend: weekendDetail } : {}) })
    : null

  const state =
    paused ? 'paused'
    : (execHalt || globalHalt || equityTrippedAt) ? 'blocked'
    : lastAction == null ? 'unknown'
    : isExitAction(lastAction) || row.thesis_status === 'broken' ? 'exiting'
    : isManageAction(lastAction) ? 'managing'
    : 'holding'

  const currentDecision = {
    state,
    action: lastAction,
    reason: lastReason,
    evidence: [
      ...(checkEv ? [checkEv] : []),
      ...(row.thesis_status != null && thesis != null ? [`mp:${mpId}:thesis`] : []),
      ...(paused ? [`mp:${mpId}:paused`] : []),
      ...(execHalt ? ['state:exec_guard_json'] : []),
      ...(globalHalt ? ['state:global_guards_json'] : []),
      ...(equityTrippedAt ? [`state:${trippedKey(accountId)}`] : []),
    ],
    asOf: row.last_check_at ?? null,
    source: lastAction != null ? reviewSource(lastAction) : null,
  }

  // --- Armed actions: every rule currently configured to act ---------------
  const dir = row.side === 'short' || String(row.side).toUpperCase() === 'SELL' ? -1 : 1
  const armed = []
  const dist = (target) => price != null && target != null ? Math.abs(target - price) : null

  if (row.time_cap_at) {
    ev(`mp:${mpId}:time_cap`, 'monitored_positions.time_cap_at', null, row.time_cap_at)
    armed.push({ kind: 'time_cap_exit', trigger: `full exit when now ≥ ${row.time_cap_at}`, triggerPrice: null, distance: null, eta: row.time_cap_at, armed: manager === 'position_manager', ruleSource: 'position_manager', evidence: [`mp:${mpId}:time_cap`] })
  }
  if (guard) {
    for (let i = 0; i < (guard.takeProfits || []).length; i++) {
      const leg = guard.takeProfits[i]
      if (!leg || leg.done || !(Number(leg.price) > 0)) continue
      armed.push({ kind: 'scale_out', trigger: `close ${leg.lots} lots at ${leg.price}`, triggerPrice: Number(leg.price), distance: dist(Number(leg.price)), eta: null, armed: true, ruleSource: 'trade_guard', evidence: [`mp:${mpId}:guard_json`] })
    }
    if (guard.breakEven?.on && row.be_moved !== 1) {
      // Pip size is a broker fact the read path does not fetch — the trigger
      // is stated in the rule's own units, price left unknown.
      armed.push({ kind: 'break_even', trigger: `SL to entry±${guard.breakEven.offsetPips ?? 0} pips once +${guard.breakEven.triggerPips} pips in profit`, triggerPrice: null, distance: null, eta: null, armed: true, ruleSource: 'trade_guard', evidence: [`mp:${mpId}:guard_json`] })
    }
    if (guard.trailing?.on) {
      armed.push({ kind: 'trail', trigger: `SL follows price at ${guard.trailing.distancePips} pips (tighten-only)`, triggerPrice: null, distance: null, eta: null, armed: true, ruleSource: 'trade_guard', evidence: [`mp:${mpId}:guard_json`] })
    }
  }
  if (manager === 'position_manager' && row.initial_risk > 0 && row.entry_price > 0) {
    const rTargets = []
    if (row.scaled_out !== 1 && rules.partialTriggerR > 0) rTargets.push({ kind: 'scale_out', rr: rules.partialTriggerR, what: `close ${Math.round((rules.partialFraction ?? 0.5) * 100)}%` })
    if (rules.bankTriggerR > 0) rTargets.push({ kind: 'bank_exit', rr: rules.bankTriggerR, what: 'bank the whole position' })
    if (row.be_moved !== 1 && rules.beTriggerR > 0) rTargets.push({ kind: 'break_even', rr: rules.beTriggerR, what: 'SL to entry' })
    if (row.scaled_out === 1 && rules.runnerTriggerR > 0) rTargets.push({ kind: 'trail', rr: rules.runnerTriggerR, what: `trail ${rules.runnerTrailR}R behind price` })
    for (const t of rTargets) {
      const tp = priceAtR(posShape, t.rr)
      armed.push({ kind: t.kind, trigger: `${t.what} at +${t.rr}R`, triggerPrice: tp, distance: dist(tp), eta: null, armed: true, ruleSource: 'position_manager', evidence: [rulesEv] })
    }
  }
  if (manager === 'profit_keeper') {
    const trigger = keeperCfg.mode === 'fixed'
      ? `arm giveback lock once profit ≥ $${keeperCfg.armProfitUsd} (keep ${100 - keeperCfg.givebackPct}% of peak)`
      : `arm Chandelier trail (${keeperCfg.trailAtrMult}×ATR) once peak profit ≥ max(${keeperCfg.armAtrMult}×ATR-value, ${keeperCfg.armBalancePct}% of balance)`
    armed.push({ kind: 'trail_arm', trigger, triggerPrice: null, distance: null, eta: null, armed: true, ruleSource: 'profit_keeper', evidence: ['state:profit_keeper_json'] })
    if (keeperCfg.takeProfitUsd > 0) {
      armed.push({ kind: 'take_profit', trigger: `close at +$${keeperCfg.takeProfitUsd} profit`, triggerPrice: null, distance: null, eta: null, armed: true, ruleSource: 'profit_keeper', evidence: ['state:profit_keeper_json'] })
    }
  }
  if (row.current_tp != null) {
    ev(`mp:${mpId}:tp`, 'monitored_positions.current_tp', null, row.current_tp)
    armed.push({ kind: 'tp_exit', trigger: `broker TP at ${row.current_tp}`, triggerPrice: row.current_tp, distance: dist(row.current_tp), eta: null, armed: true, ruleSource: 'broker', evidence: [`mp:${mpId}:tp`] })
  }

  // nextAction = the nearest measurable trigger; when nothing is measurable
  // (no live price), the time cap is the only trigger with a real ETA.
  const measurable = armed.filter(a => a.distance != null).sort((a, b) => a.distance - b.distance)
  const nextAction = measurable[0] ?? armed.find(a => a.eta != null) ?? armed[0] ?? {
    kind: null, trigger: null, triggerPrice: null, distance: null, eta: null, armed: false, ruleSource: null, evidence: [],
  }

  // --- Invalidation watch ---------------------------------------------------
  const invalidation = []
  if (row.invalidation_trigger) {
    ev(`mp:${mpId}:invalidation_trigger`, 'monitored_positions.invalidation_trigger', row.created_at, row.invalidation_trigger)
    const parsed = pmInternal.parsePriceTrigger(row.invalidation_trigger)
    invalidation.push({
      kind: 'stored_trigger',
      condition: row.invalidation_trigger,
      state: parsed ? (price != null ? (parsed.fired(price) ? 'met' : 'watching') : 'unknown') : 'stored',
      machineEvaluable: !!parsed,
      source: 'analysis → monitored_positions.invalidation_trigger',
      asOf: price != null ? liveAt : null,
      evidence: [`mp:${mpId}:invalidation_trigger`, ...(price != null ? ['snapshot:price'] : [])],
    })
  }
  if (row.thesis_status != null) {
    invalidation.push({
      kind: 'thesis',
      condition: 'stored thesis no longer intact per the latest monitor review',
      state: row.thesis_status === 'broken' ? 'met' : row.thesis_status === 'intact' ? 'watching' : 'warning',
      thesisStatus: row.thesis_status,
      source: 'monitored_positions.thesis_status',
      asOf: row.last_check_at ?? null,
      evidence: checkEv ? [checkEv] : [],
    })
  }
  if (row.time_cap_at) {
    const cap = new Date(row.time_cap_at)
    invalidation.push({
      kind: 'time_cap',
      condition: `held past ${row.time_cap_at}`,
      state: Number.isFinite(cap.getTime()) && now >= cap ? 'met' : 'watching',
      source: 'monitored_positions.time_cap_at',
      asOf: new Date(nowMs).toISOString(),
      evidence: [`mp:${mpId}:time_cap`],
    })
  }
  if (row.current_sl != null) {
    ev(`mp:${mpId}:sl`, 'monitored_positions.current_sl', null, row.current_sl)
    invalidation.push({
      kind: 'stop_loss',
      condition: `price ${dir === 1 ? '≤' : '≥'} ${row.current_sl} (broker-side stop)`,
      state: 'armed',
      triggerPrice: row.current_sl,
      distance: dist(row.current_sl),
      source: 'broker (native SL, mirrored in monitored_positions.current_sl)',
      asOf: null,
      evidence: [`mp:${mpId}:sl`],
    })
  }
  if (equityTrippedAt) {
    invalidation.push({
      kind: 'equity_stop',
      condition: 'account equity stop tripped — autotrade disarmed for this account',
      state: 'met',
      source: 'agent_state equity stop',
      asOf: equityTrippedAt,
      evidence: [`state:${trippedKey(accountId)}`],
    })
  }
  const riskCfg = (() => { try { return loadRiskConfig(db) } catch { return null } })()
  if (Number.isFinite(riskCfg?.dailyLossPct) && riskCfg.dailyLossPct > 0) {
    ev('risk_config:dailyLossPct', 'agent_state.risk_config_json', null, riskCfg.dailyLossPct)
    invalidation.push({
      kind: 'daily_loss_cap',
      condition: `FX-day realized loss reaches ${riskCfg.dailyLossPct * 100}% of balance (blocks new entries; usage in the account block)`,
      state: 'watching',
      source: 'risk config',
      asOf: null,
      evidence: ['risk_config:dailyLossPct'],
    })
  }

  // --- Deterministic what-would-the-manager-do-now (position_manager only) --
  // evaluatePosition is the loop's own pure verdict function — reused, not
  // reimplemented. Only meaningful for rows position-manager actually manages.
  let verdictNow = null
  if (manager === 'position_manager' && price != null) {
    try {
      const v = evaluatePosition({ ...row }, { currentPrice: price, now, rules })
      verdictNow = { action: v.action, reason: v.reason, asOf: liveAt, source: 'position_manager evaluatePosition (recomputed on this snapshot)' }
      ev('derived:verdict-now', verdictNow.source, liveAt, { action: v.action, reason: v.reason })
    } catch { verdictNow = null }
  }

  // --- Deterministic explanation: every sentence carries evidence IDs ------
  const sentences = []
  const sideWord = dir === 1 ? 'LONG' : 'SHORT'
  if (state === 'paused') {
    sentences.push(`Monitoring for this ${sideWord} ${row.symbol} position is paused — the bot records it but takes no management action. [mp:${mpId}:paused]`)
  } else if (state === 'blocked') {
    const why = [execHalt ? 'the execution kill switch is on [state:exec_guard_json]' : null, globalHalt ? 'the portfolio halt is on [state:global_guards_json]' : null, equityTrippedAt ? `the account equity stop tripped [state:${trippedKey(accountId)}]` : null].filter(Boolean)
    sentences.push(`Management actions for this ${sideWord} ${row.symbol} position are blocked: ${why.join('; ')}.`)
  } else if (lastAction != null) {
    const verb = state === 'exiting' ? 'Exiting' : state === 'managing' ? 'Managing' : 'Holding'
    const thesisBit = row.thesis_status != null ? ` with the stored thesis ${row.thesis_status}` : ''
    sentences.push(`${verb} ${sideWord} ${row.symbol}${thesisBit}: the latest review (${reviewSource(lastAction)}, ${row.last_check_at ?? 'time unknown'}) recorded ${lastAction}${lastReason ? ` — ${String(lastReason).slice(0, 160)}` : ''}. [${currentDecision.evidence.join(', ')}]`)
  } else {
    sentences.push(`No monitor review has been recorded for this ${sideWord} ${row.symbol} position yet — its management state is unknown, not assumed. [mp:${mpId}:${thesis != null ? 'thesis' : 'sl'}]`)
  }
  if (nextAction.kind != null) {
    const distBit = nextAction.distance != null ? ` (${nextAction.distance.toPrecision(3)} away from the cached price [snapshot:price])` : nextAction.eta != null ? ` (due ${nextAction.eta})` : ''
    sentences.push(`The next configured action is ${nextAction.kind}: ${nextAction.trigger}${distBit}; no action is taken while the trigger is unmet. [${nextAction.evidence.join(', ')}]`)
  }
  if (verdictNow != null) {
    sentences.push(`Recomputing the deterministic rules against the cached price agrees: ${verdictNow.action} (${verdictNow.reason}). [derived:verdict-now]`)
  }
  if (price == null) {
    sentences.push(`No live price for this position in the broker snapshot cache — R, trigger distances and ETAs are unknown rather than estimated. [mp:${mpId}:${row.current_sl != null ? 'sl' : 'thesis'}]`)
  }

  return {
    strategy: row.strategy ?? row.trade_strategy ?? null,
    strategyVersion: null, // no strategy versioning exists in this app — unknown, not invented
    source: 'local-db (monitored_positions + trades + analyses + rule state)',
    side: row.side ?? null,
    conviction: row.conviction ?? null,
    thesis,
    entryRationale,
    initialRisk: row.initial_risk ?? null,
    targetPlan: armed.filter(a => ['scale_out', 'bank_exit', 'tp_exit', 'take_profit'].includes(a.kind)),
    timeCapAt: row.time_cap_at ?? null,
    manager,
    currentDecision,
    nextAction,
    armedActions: armed,
    invalidation,
    verdictNow,
    currentR: r != null ? Number(r.toPrecision(4)) : null,
    explanation: {
      text: sentences.join(' '),
      mode: 'deterministic',
      model: null,
      generatedAt: new Date(nowMs).toISOString(),
      evidenceRevision: revision,
    },
    evidenceIndex,
    status: 'derived',
  }
}

/** Which module wrote a last_check_action value — from its own prefix convention. */
function reviewSource(action) {
  const a = String(action)
  if (a.startsWith('FAST:')) return 'fast_monitor'
  if (a.startsWith('WEEKEND:')) return 'weekend_watch'
  if (a.startsWith('GUARD:')) return 'session_open_guard'
  if (a === 'EQUITY_STOP') return 'equity_stop'
  if (a.startsWith('profit_keeper')) return 'profit_keeper'
  return 'monitor'
}

function isExitAction(action) {
  const a = String(action).replace(/^(FAST:|WEEKEND:)/, '')
  return ['EXIT', 'FULL_EXIT', 'CLOSE', 'EQUITY_STOP', 'profit_keeper_close'].includes(a)
}

function isManageAction(action) {
  const a = String(action).replace(/^(FAST:|WEEKEND:|GUARD:)/, '')
  return ['TIGHTEN_SL', 'SCALE_OUT', 'PARTIAL_EXIT', 'MOVE_SL', 'ADD', 'BE', 'profit_keeper_scaleout', 'profit_keeper_lock'].includes(a)
}
