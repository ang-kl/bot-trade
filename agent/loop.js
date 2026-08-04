// ---------------------------------------------------------------------------
// agent/loop.js — Main 5-minute scan loop
// ---------------------------------------------------------------------------

import { createLLMClient } from './lib/llm-provider.js'
import { runFibScan, synthesizeFibSignal } from './services/fib-strategy.js'
import { enabledStrategies } from './services/strategies.js'
import { scanStageStrategies, scanFilterOptions, tradeStageGate, anyAccountTradeGate, manageStageAllows } from './services/stage-matrix.js'
import { runMonitorCheck } from './services/monitor-svc.js'
import { evaluatePosition } from './services/position-manager.js'
import { rulesForSymbol } from './services/asset-controllers.js'
import { runWeekendPositionCheck } from './services/weekend-watch.js'
import { evaluateTrade, loadRiskConfig, persistRiskEvent, getAccountBalance, getAccountLeverage, portfolioMarginStatus } from './services/risk.js'
import { registryAutopilotAccounts, setAccountState } from './services/account-registry.js'
import { sendScanAlert } from './services/telegram.js'
import { detectFlip } from './quant/signals.js'
import { persistScanContext } from './services/context.js'
import { getActiveSessions, categoriseSymbol, isWeekend, isSymbolMarketOpen } from './lib/sessions.js'
import { encodeLabel, parseLabel, convictionBucket, LABEL_VERSION } from './lib/trade-labels.js'
import { wsGetSymbolsList, wsGetTrendbarsBatch, isAmbiguousSubmitError } from './lib/ctrader-ws.js'
// Broker execution goes through the delegator: EXEC_ENGINE=cpp routes to the
// C++ sidecar, default 'js' is a byte-identical passthrough to ctrader-ws.
import { placeOrder as execPlaceOrder, amendPosition as execAmendPosition, closePosition as execClosePosition, reconcile as execReconcile } from './lib/exec-engine.js'
import { getCtraderCreds, getSymbolMap } from './lib/ctrader-creds.js'
import { managePendingOrders } from './services/pending-orders.js'
import { ctraderEnv } from './lib/ctrader-env.js'
import { reconcilePositions } from './services/reconciler.js'
import { checkRegimeGate } from './services/regime-gate.js'
import { recordPositionEvent } from './services/position-events.js'
import { recordError } from './services/error-log.js'
import { startLagMonitor, sampleLag } from './services/event-loop-lag.js'
import { startPhaseProfile, stopPhaseProfile } from './services/cpu-profile.js'
import { recordLlmMonitorResult, shouldAlert, markAlerted } from './services/llm-monitor-health.js'
import { armedTimeframes } from './lib/timeframes.js'
import { getState, setState, closeTradeRow, insertCupHandleDiagnostic } from './db.js'
import { recordFxRates } from './services/fx-rates.js'

const LOOP_INTERVAL = 5 * 60 * 1000 // default; Tune can override (loop_interval_min)

// Owner-configurable cadence, re-read every cycle so a Tune change applies
// without a restart. Clamped 1–60 min.
function loopIntervalMs(db) {
  const n = Number(getState(db, 'loop_interval_min'))
  if (Number.isFinite(n) && n >= 1 && n <= 60) return n * 60_000
  return LOOP_INTERVAL
}
// Controller heartbeat: every background controller stamps a beat per run so
// the watchdog (on the fast-monitor ticker) can flag silent stalls. Must
// never take a controller down, hence the swallow-all wrapper.
async function hbeat(db, name, ok = true, error = null) {
  try {
    const { beat } = await import('./services/heartbeat.js')
    beat(db, name, { ok, error: error ? String(error) : null })
  } catch { /* heartbeat is observability — never fatal */ }
}

// Telegram veto alerts, deduped: the scan re-proposes the same trade every
// loop, so an unchanged veto (same symbol+side+reason family) would ping the
// owner every 5 minutes (owner hit this at Monday open: duplicate_symbol ×3
// symbols × every loop). Alert once per family, re-alert after 6h or when
// the reason changes. Text goes through the shared trader-word humanizer —
// also fixes Telegram's markdown eating snake_case underscores.
const VETO_ALERT_MUTE_MS = 6 * 3600_000
async function alertVetoOnce(db, symbol, side, reason, textOverride = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return
  const family = String(reason || 'veto').split(/[:\s]/)[0] || 'veto'
  const key = `veto_tg_${symbol}_${side}`
  try {
    const prev = JSON.parse(getState(db, key) || 'null')
    if (prev && prev.family === family && Date.now() - prev.at < VETO_ALERT_MUTE_MS) return
  } catch { /* treat as fresh */ }
  setState(db, key, JSON.stringify({ family, at: Date.now() }))
  try {
    const { sendMessage } = await import('./services/telegram.js')
    const { humanVeto } = await import('../src/lib/veto-words.js')
    await sendMessage(`🛑 RISK VETO: ${symbol} ${side} — ${textOverride || humanVeto(reason)} (repeats muted 6h)`)
  } catch { /* non-fatal */ }
}

const MAX_CONSECUTIVE_ERRORS = 10     // hard circuit breaker — loop stops entirely
const CIRCUIT_BREAKER_RESET_MS = 30 * 60 * 1000 // 30 min manual reset window
const DAILY_TOKEN_BUDGET = 500_000    // warn when daily LLM output tokens exceed this
let loopCount = 0
let consecutiveErrors = 0
let loopRunning = false               // mutex — prevents concurrent iterations
let lastLoopActivityAt = Date.now()   // watchdog: stamped at cycle start/end
let pendingPhaseInFlight = false      // a budget-abandoned pending phase still executing detached

// Sub-phase time budgets (incident follow-up, 2026-07-28: the loop re-hung
// AFTER the pending-phase budget shipped, and /health showed "pending
// orders" for 8+ minutes — because that label covers EVERY block between
// the pending phase and the monitor phase, and only managePendingOrders
// itself had a budget. Any of burn-in / pending-signals / trade-guards /
// profit-keeper / loss-guardian / hours-refresh / autopilot could still
// hang the cycle forever behind one stuck broker await.) Same contract as
// the pending budget: on breach the CYCLE moves on, the abandoned run
// finishes detached, and the next cycle SKIPS that sub-phase while it is
// still in flight (these phases place/amend real orders — two interleaved
// runs must never happen). Each sub-phase also stamps its own loop_phase
// so /health forensics name the actual culprit next time.
const subPhaseInFlight = new Map()    // name → true while a detached run is still executing
const SUB_PHASE_BUDGET_MS = Math.max(10_000, Number(process.env.LOOP_SUBPHASE_BUDGET_MS || 90_000))

// L3 idempotency window. WAS THREE MINUTES, AND THAT MADE IT INERT.
//
// A loop cycle on production runs ~3.5-5 minutes (heartbeat.js documents the
// measurement: `loop_interval_min` was 1 while cycles took ~3.5 min). A
// three-minute window therefore expired BEFORE the next cycle asked, so the
// guard never once blocked the retry it exists to block. It has to outlast a
// cycle, with margin, or it is decoration.
//
// 20 minutes: comfortably past the slowest observed cycle, and short enough
// that a genuinely-failed entry is retryable within the same session. The
// direction of the error is the deciding argument — suppressing a real entry
// costs one opportunity; resubmitting onto a live fill costs money, nine
// times over on 0066.HK.
export const DEDUPE_WINDOW_MIN = Math.max(5, Number(process.env.SUBMIT_DEDUPE_WINDOW_MIN) || 20)
const DEDUPE_WINDOW_SQL = `-${DEDUPE_WINDOW_MIN} minutes`

/**
 * Run one loop sub-phase under a wall-clock budget with a no-overlap guard.
 * `startWork` is only called when no previous run is in flight. Returns the
 * work's own result, `{ skippedOverlap: true }`, or `{ timedOut: true }`.
 * Failures REJECT so each call site's existing non-fatal catch handles them.
 */
async function runBudgetedSubPhase(db, name, startWork, budgetMs = SUB_PHASE_BUDGET_MS) {
  if (subPhaseInFlight.get(name)) {
    log(`${name} from a previous cycle still in flight — skipping this cycle (no overlap)`)
    return { skippedOverlap: true }
  }
  const startedAt = Date.now()
  const work = startWork()
  subPhaseInFlight.set(name, true)
  work.catch(() => {}).finally(() => subPhaseInFlight.set(name, false))
  let timer
  const r = await Promise.race([
    work,
    new Promise(resolve => { timer = setTimeout(() => resolve({ __timedOut: true }), budgetMs); timer.unref?.() }),
  ])
  clearTimeout(timer)
  if (r?.__timedOut) {
    log(`${name} exceeded its ${Math.round(budgetMs / 1000)}s budget after ${Math.round((Date.now() - startedAt) / 1000)}s — abandoning the wait, cycle continues (run finishes detached)`)
    await hbeat(db, name, false, `budget ${Math.round(budgetMs / 1000)}s exceeded`)
    return { timedOut: true }
  }
  return r
}

/**
 * Clear the in-process consecutive-error count. POST /actions/reset-breaker
 * was only clearing the DB-persisted `circuit_breaker_tripped_at`/`errors_today`
 * — the trip condition at the top of runLoop() checks the in-memory
 * `consecutiveErrors` counter above, which a route handler in a different
 * module can't reach directly. Without this, a "successful" manual reset
 * looked fine in the response but the very next tick re-tripped the breaker
 * instantly (consecutiveErrors was still >= MAX_CONSECUTIVE_ERRORS), so the
 * loop stayed halted until the whole process restarted.
 */
export function resetCircuitBreaker() {
  consecutiveErrors = 0
}

/**
 * ¶D·2 — the protection audit could not run this cycle. Record why, and beat
 * the controller as FAILED rather than not at all.
 *
 * During the 2026-07-29 broker outage the panel read "Position protection
 * audit — idle", which is what a controller that has never run looks like and
 * reads as a resting state. It was neither resting nor fine: nothing was
 * checking whether open positions still had stops, at precisely the moment
 * execution was degraded. A not-beat is silence; a failed beat is a fact.
 */
async function noteProtectionAuditBlocked(db, reason) {
  try {
    const { recordAuditUnavailable } = await import('./services/naked-position-guard.js')
    recordAuditUnavailable(db, reason)
    const { beat } = await import('./services/heartbeat.js')
    beat(db, 'protection_audit', { ok: false, error: reason })
  } catch { /* a bookkeeping failure must never break the loop */ }
}

// Lazy singleton — only the monitor/weekend position checks call the LLM now;
// the scan/analyze pipeline is deterministic (fib-strategy.js). Provider is
// OpenAI when OPENAI_API_KEY is set (owner's primary key), else Anthropic —
// same messages.create shape either way (see lib/llm-provider.js).
// One client per TASK TIER, not one client overall: the model id is baked into
// the client at construction (the OpenAI wrapper closes over it), so a single
// shared client cannot serve two tiers. Both users of this cache — the position
// monitor and the weekend watch — sit on the DEFAULT tier, which is deliberate
// and argued in model-router.js: they are the highest-volume LLM calls in the
// system and they are a fallback opinion, not the decision.
const _llmClients = new Map()
function getAnthropicClient(taskType = 'position_monitor') {
  if (!_llmClients.has(taskType)) {
    _llmClients.set(taskType, createLLMClient(process.env, { task: { type: taskType } }))
  }
  return _llmClients.get(taskType)
}

// Count monitor/weekend LLM usage against the daily budget and stamp the
// Anthropic health key — these are the only remaining Anthropic call sites,
// so they own the health signal (the scan must not stamp it).
function recordAnthropicUsage(db, usage, purpose = 'monitor', model = null) {
  const tokens = usage?.output_tokens || 0
  if (tokens > 0) {
    const prev = parseInt(getState(db, 'daily_tokens_used') || '0')
    setState(db, 'daily_tokens_used', String(prev + tokens))
  }
  setState(db, 'api_anthropic_last_ok', new Date().toISOString())
  // Persist the FULL usage (input + output + cache) to token_usage so the
  // owner sees real dollars, not just an output-token counter. Non-fatal.
  import('./services/llm-spend.js')
    .then(m => m.recordTokenUsage(db, { purpose, model, usage }))
    .catch(() => { /* cost accounting must never break trading */ })
}

// ---------------------------------------------------------------------------
// cTrader auto-trade via WebSocket — places a market order when synthesis
// says auto_trade = true. Reads credentials stored via POST /actions/ctrader-config.
// Low-level WS client lives in ./lib/ctrader-ws.js (unit-testable, reused
// by wsAmendPosition / wsClosePosition on the monitor hot path).
// ---------------------------------------------------------------------------

export function getAutopilotAccounts(db) {
  // Multi-account roles pushed via /actions/ctrader-config keep their
  // legacy precedence (that flow already trades several accounts and
  // predates the registry) — the registry mirrors it on push, so both
  // sources agree; ordering here is belt-and-braces for M0.
  const rolesJson = getState(db, 'ctrader_account_roles_json')
  if (rolesJson) {
    try {
      const roles = JSON.parse(rolesJson).filter(a => a.autopilot)
      // THE LEGACY PATH MUST STILL RESPECT THE REGISTRY (audit F-POLICY-01,
      // 03-08-2026). This branch returns roles filtered on `autopilot` ALONE
      // and takes precedence over the registry, so `mode` and `enabled` were
      // both bypassed whenever more than one role carried autopilot. The
      // registry route below has always filtered on the `enter` capability;
      // this one did not, which meant an account marked `manage_only` — or
      // marked `enabled = 0`, including the LIVE account — could be dispatched
      // an entry through the older config flow.
      //
      // Intersect rather than replace: the legacy precedence is kept (it
      // predates the registry and still decides ORDER and role metadata), but
      // an account the registry refuses to let enter is dropped from it.
      // If the registry cannot answer at all, the legacy list stands as
      // before — a registry outage must not silently stop trading, and the
      // per-account risk gate still runs downstream either way.
      if (roles.length > 1) {
        let allowed = null
        try {
          allowed = new Set(registryAutopilotAccounts(db).map(a => String(a.accountId)))
        } catch { allowed = null }
        if (allowed == null || allowed.size === 0) return roles
        const kept = roles.filter(a => allowed.has(String(a.accountId)))
        const dropped = roles.length - kept.length
        if (dropped > 0) {
          log(`Entry roster: ${dropped} legacy autopilot role(s) dropped — the registry does not permit them to enter (mode/enabled)`)
        }
        if (kept.length > 1) return kept
        if (kept.length === 1) return kept
        // Every legacy role is refused: fall through to the registry, which
        // is the stricter answer, rather than returning an empty roster and
        // reporting it as "no accounts configured".
      }
    } catch { /* fall through */ }
  }
  // Account Registry (M0 shim): the enabled/active rows. With exactly one
  // enabled account this returns precisely what the legacy path returned.
  try {
    const regs = registryAutopilotAccounts(db)
    if (regs.length > 0) return regs
  } catch { /* registry not available — legacy below */ }
  if (rolesJson) {
    try {
      return JSON.parse(rolesJson).filter(a => a.autopilot)
    } catch { /* fall through to legacy */ }
  }
  const id = getState(db, 'ctrader_account_id')
  if (!id) return []
  return [{ accountId: id, isLive: getState(db, 'ctrader_is_live') === 'true' }]
}

export async function autoTrade(db, symbol, synth, watchlistItem, accountOverride) {
  const clientId = ctraderEnv('clientId')
  const clientSecret = ctraderEnv('clientSecret')
  const accessToken = getState(db, 'ctrader_access_token')
  const accountId = accountOverride?.accountId || getState(db, 'ctrader_account_id')
  const isLive = accountOverride ? !!accountOverride.isLive : getState(db, 'ctrader_is_live') === 'true'

  if (!clientId || !clientSecret || !accessToken || !accountId) {
    log(`Auto-trade skipped — cTrader credentials not configured (push via /actions/ctrader-config)`)
    return null
  }

  const side = synth.consensus_bias === 'short' ? 'SELL' : 'BUY'
  // Per-symbol Max lots is an OPTIONAL cap. No cap → null → the risk gate
  // sizes purely from balance × risk% (the owner's dynamic sizing). The old
  // 0.01 fallback silently compressed every uncapped trade. Legacy junk
  // (negative caps) still never reaches the gate.
  const requestedVol = Number(watchlistItem?.maxVolume) > 0 ? Number(watchlistItem.maxVolume) : null

  // Market-hours gate: a MARKET order into a closed market is a guaranteed
  // broker rejection — stocks/indices trade the NY session only, FX/metals
  // close on weekends. The signal isn't lost: it's queued (pending_signals)
  // and re-checked against a FRESH scan the moment the symbol's own market
  // reopens — see services/pending-signals.js and its runPendingSignals()
  // loop.js phase (owner: "do you separate which one you would trade based
  // on market open... which will trade later when NY opens?").
  // Broker-truth schedule (symbol_hours table) when cached; the sessions.js
  // heuristic is the fallback for symbols not yet refreshed.
  const { isSymbolOpenCached } = await import('./services/symbol-hours.js')
  const marketGate = isSymbolOpenCached(db, symbol)
  if (!marketGate.open) {
    // Closed market: a MARKET order would be rejected. Owner decision
    // (Option A, on by default): place a RESTING LIMIT order at the setup's
    // entry — locked in, visible, fills at open — as the SINGLE source of the
    // fill (no internal re-fire queue, so no double-fill). The limit clears
    // the SAME risk gate. One order per symbol; a fresher read replaces it.
    // If the feature is OFF, fall back to the legacy internal re-fire queue.
    try {
      const { placeClosedMarketLimit } = await import('./services/closed-market-limits.js')
      const r = await placeClosedMarketLimit(
        db,
        { host: isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com', clientId, clientSecret, accessToken, accountId },
        symbol, synth,
        { requestedVolume: requestedVol, notify: (t) => import('./services/telegram-control.js').then(m => m.notifyOwner(t)).catch(() => {}) }
      )
      if (r.placed) {
        log(`Closed market — resting LIMIT for ${symbol} @ ${r.limitPrice} (fills at open, expires ${r.expiresAt})`)
      } else if (r.skipped === 'off') {
        // Legacy path: queue the signal internally and re-fire at reopen.
        const dedupeKey = `mkt_closed_logged_${symbol}`
        if (getState(db, dedupeKey) !== 'y') {
          persistRiskEvent(db, {
            symbol, side,
            entry: synth.entry ?? null, sl: synth.sl ?? null,
            tp1: synth.tp1 ?? null, tp2: synth.tp2 ?? null,
            requestedVolume: requestedVol,
            strategy: synth.strategy || null,
            source: synth.source || 'auto_signal',
          }, { approved: false, veto_reason: `market_closed: ${marketGate.reason}` })
          setState(db, dedupeKey, 'y')
        }
        const { queuePendingSignal } = await import('./services/pending-signals.js')
        queuePendingSignal(db, symbol, synth, marketGate.reason)
        log(`Auto-trade deferred (queued) — ${marketGate.reason}`)
      } else {
        log(`Closed-market limit for ${symbol}: ${r.skipped}${r.reason ? ` — ${r.reason}` : ''}`)
      }
    } catch (err) {
      log(`Closed-market handling failed for ${symbol} (non-fatal): ${err.message}`)
    }
    return null
  }
  setState(db, `mkt_closed_logged_${symbol}`, null) // market open again — re-arm the one-shot

  // -------------------------------------------------------------------------
  // Risk Manager pre-trade gate — deterministic veto + Kelly volume scaling.
  // Runs before cTrader WS open. No LLM calls. Every evaluation is persisted
  // to risk_events for Workshop audit.
  // -------------------------------------------------------------------------
  // Lessons tuner — when a strategy's recent losses are dominated by stop
  // hunts, widen its stop at proposal time (evidence-driven, self-clearing).
  // synth.sl itself is updated so the risk gate, spread gate, broker order
  // and DB rows all see the SAME widened stop; risk-based sizing keeps the
  // $ risk constant on the wider distance (fewer lots, same budget).
  try {
    const { loadLessonTuning, applySlWiden, isDecayed } = await import('./services/lessons-tuner.js')
    const tuned = applySlWiden({ strategy: synth.strategy, entry: synth.entry, sl: synth.sl }, loadLessonTuning(db))
    if (tuned.note) { synth.sl = tuned.signal.sl; log(`${symbol}: ${tuned.note}`) }
    // Alpha-decay cool-off — this EXACT Symbol+Strategy+Timeframe edge's last
    // postmortem said the edge is decaying. Skip the trade rather than just
    // display the flag; self-clears the moment a Win/Partial lands.
    if (isDecayed(db, symbol, synth.strategy, synth.timeframe)) {
      log(`${symbol}: lesson_tuner: alpha-decay cool-off — skipping ${synth.strategy || 'signal'}/${synth.timeframe || '?'} (last postmortem flagged decay for this exact edge)`)
      try {
        const { recordDecision } = await import('./services/decision-log.js')
        recordDecision(db, { symbol, timeframe: synth.timeframe, strategy: synth.strategy, stage: 'lesson_decay', decision: 'skip', reason: 'alpha_decay_cooloff' })
      } catch { /* provenance never blocks */ }
      return null
    }
  } catch { /* tuner is optional — never blocks a trade */ }

  const proposal = {
    symbol,
    side,
    entry: synth.entry ?? null,
    sl: synth.sl ?? null,
    tp1: synth.tp1 ?? null,
    // Second ladder level (runner target) — display-only for the order log's
    // TP cell; the broker order carries tp1, the manager banks the partial.
    tp2: synth.tp2 ?? null,
    requestedVolume: requestedVol,
    strategy: synth.strategy || null,
    conviction: synth.overall_conviction ?? null,
    // Provenance for the order log: who fired this attempt (auto_signal |
    // validation_fill | …). Rides inside proposal_json — no schema change.
    source: synth.source || 'auto_signal',
  }
  const riskCfg = loadRiskConfig(db)
  const riskResult = evaluateTrade(db, proposal, riskCfg)
  persistRiskEvent(db, proposal, riskResult)
  if (!riskResult.approved) {
    log(`RISK VETO ${symbol} ${side}: ${riskResult.veto_reason}`)
    await alertVetoOnce(db, symbol, side, riskResult.veto_reason)
    return null
  }
  const volLots = riskResult.adjusted_volume
  if (Math.abs(volLots - requestedVol) > 0.001) {
    log(`Risk sizing: ${symbol} ${requestedVol} → ${volLots} (${riskResult.sizing_note})`)
  }

  // We need symbolId — look it up from previously stored symbol map, or skip
  const symbolMapJson = getState(db, 'symbol_id_map')
  const symbolMap = symbolMapJson ? JSON.parse(symbolMapJson) : {}
  const symbolId = symbolMap[symbol.toUpperCase()]
  if (!symbolId) {
    log(`Auto-trade ${symbol}: symbolId unknown — call POST /actions/symbol-map to register it`)
    return null
  }

  // Volume in the symbol's OWN units (lotSize is per-symbol; a hardcoded
  // per-lot constant sent every order ~1000× too small → TRADING_BAD_VOLUME).
  const hostForMeta = isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
  let sized
  let symbolDigits = 5 // price precision for relative SL/TP snapping below
  const { getVolumeMeta, lotsToVolume, relativePoints } = await import('./lib/lot-sizing.js')
  try {
    const meta = await getVolumeMeta(hostForMeta, clientId, clientSecret, accessToken, accountId, symbolId)
    symbolDigits = meta.digits ?? 5
    sized = lotsToVolume(volLots, meta)
    if (sized.belowMin) {
      const reason = `below_min_volume: ${volLots} lots (${sized.volume}) < broker minimum ${meta.minVolume} — balance too small for this symbol at the configured risk`
      persistRiskEvent(db, proposal, { approved: false, veto_reason: reason })
      log(`RISK VETO ${symbol} ${side}: ${reason}`)
      await alertVetoOnce(db, symbol, side, reason, "sized volume is below the broker's minimum lot. Raise risk per trade or skip this symbol.")
      return null
    }
  } catch (err) {
    persistRiskEvent(db, proposal, { approved: false, veto_reason: `sizing_failed: ${err.message}` })
    log(`Auto-trade ${symbol}: sizing failed — ${err.message}`)
    return null
  }
  const volume = sized.volume

  const slDistance = synth.sl && synth.entry ? Math.abs(synth.entry - synth.sl) : null
  const tpDistance = synth.tp1 && synth.entry ? Math.abs(synth.tp1 - synth.entry) : null

  // Build the structured attribution label — visible in the native cTrader
  // Orders/History columns and used for per-strategy / per-regime analytics.
  const sessionNow = getActiveSessions()[0]?.label || 'Off'
  const regimeRow = db
    .prepare(`SELECT regime FROM regimes WHERE symbol = ? ORDER BY computed_at DESC LIMIT 1`)
    .get(symbol)
  const structuredLabel = encodeLabel({
    source: 'autopilot',
    version: LABEL_VERSION,
    strategy: synth.strategy || 'other',
    conviction: convictionBucket(synth.overall_conviction),
    session: sessionNow,
    timeframe: synth.timeframe || null,
    regime: regimeRow?.regime || null,
  })

  const orderPayload = {
    ctidTraderAccountId: parseInt(accountId),
    symbolId: parseInt(symbolId),
    orderType: 'MARKET',
    tradeSide: side,
    volume,
    comment: 'abot-auto',
    label: structuredLabel,
    // Snapped to the symbol's digits — raw 1/100000 rounding is finer than
    // 2-3 digit symbols allow and the broker rejects it (INVALID_REQUEST).
    ...(slDistance ? { relativeStopLoss: relativePoints(slDistance, symbolDigits) } : {}),
    ...(tpDistance ? { relativeTakeProfit: relativePoints(tpDistance, symbolDigits) } : {}),
    // Spike protection: broker-side stop trigger method (config-gated no-op
    // when unset — see lib/order-protection.js).
    ...(await import('./lib/order-protection.js')).stopTriggerField(riskCfg),
  }

  const host = isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'

  // Microstructure spread gate: the live spread is a cost paid the instant
  // the market order fills. If it eats more than maxSpreadFracOfSL of the SL
  // distance, the R:R this signal was approved on no longer exists (rollover /
  // off-hours spread blowouts). Best-effort — a failed quote fails OPEN.
  let entrySpread = null // forensics: captured by the spread gate when it runs
  if (slDistance && riskCfg.maxSpreadFracOfSL > 0) {
    try {
      const { wsGetSpotOnce } = await import('./lib/ctrader-ws.js')
      const q = await wsGetSpotOnce(host, clientId, clientSecret, accessToken, accountId, symbolId)
      if (q) {
        const spread = q.ask - q.bid
        entrySpread = spread
        if (spread > riskCfg.maxSpreadFracOfSL * slDistance) {
          const reason = `spread_too_wide: ${spread.toFixed(5)} > ${(riskCfg.maxSpreadFracOfSL * 100).toFixed(0)}% of SL distance ${slDistance.toFixed(5)}`
          persistRiskEvent(db, proposal, { approved: false, veto_reason: reason })
          log(`RISK VETO ${symbol} ${side}: ${reason}`)
          await alertVetoOnce(db, symbol, side, reason, `spread too wide (${spread.toFixed(5)} vs SL ${slDistance.toFixed(5)}). Likely off-hours/rollover — the signal stays; it can fire next loop when the spread normalises.`)
          return null
        }
      }
    } catch (e) {
      log(`Spread gate skipped (fail-open): ${e.message}`)
    }
  }

  // L3 submission idempotency (the 4x-duplicate USDIDR incident class): a
  // just-recorded trade on the same account+symbol+side within the window
  // means THIS submission is a duplicate — a re-dispatch, a retry echo, or
  // two paths racing. The broker call is not idempotent, so the dedupe has
  // to happen before it, from our own ledger.
  const dupe = db.prepare(`
    SELECT id, opened_at FROM trades
    WHERE symbol = ? AND side = ? AND opened_at >= datetime('now', ?)
      AND (account_id = ? OR account_id IS NULL)
    ORDER BY id DESC LIMIT 1
  `).get(symbol, side, DEDUPE_WINDOW_SQL, String(accountId))

  // AUDIT F-L4-01: the dedupe above reads `trades`, which the AMBIGUOUS
  // failure path never writes. wsPlaceOrder correctly refuses to retry after
  // NEW_ORDER_REQ went out — the broker may have filled it and only the
  // EXECUTION_EVENT was lost — so that submission leaves a risk_events row and
  // NO trade row. On the next cycle the dedupe found nothing and the same
  // signal could be submitted again against a position that may already be
  // live. The guard protected against the retry it had disabled, and not
  // against the one path that still doubled.
  //
  // An ambiguous submission is therefore treated as "a position may exist" for
  // the same window. The direction of the error matters: suppressing a real
  // entry costs an opportunity, resubmitting onto a live fill costs money. A
  // plain `order_failed` (broker REJECTED it — provably no position) is NOT
  // caught here, so ordinary rejections still retry next cycle as before.
  const ambiguous = dupe ? null : db.prepare(`
    SELECT id, created_at FROM risk_events
    WHERE symbol = ? AND side = ? AND approved = 0
      AND veto_reason LIKE 'order_ambiguous:%'
      AND created_at >= datetime('now', ?)
      AND (account_id = ? OR account_id IS NULL)
    ORDER BY id DESC LIMIT 1
  `).get(symbol, side, DEDUPE_WINDOW_SQL, String(accountId))

  if (dupe || ambiguous) {
    const reason = dupe
      ? `duplicate_submission: trade #${dupe.id} ${side} ${symbol} already recorded at ${dupe.opened_at} (${DEDUPE_WINDOW_MIN}-minute idempotency window)`
      : `duplicate_submission_ambiguous: a ${side} ${symbol} order was submitted at ${ambiguous.created_at} and its outcome is UNKNOWN (risk_event #${ambiguous.id}) — a position may already be open; not resubmitting inside the ${DEDUPE_WINDOW_MIN}-minute window`
    persistRiskEvent(db, proposal, { approved: false, veto_reason: reason })
    try {
      const { recordDecision } = await import('./services/decision-log.js')
      recordDecision(db, { accountId: String(accountId), symbol, timeframe: synth.timeframe, strategy: synth.strategy, stage: 'submission_dedupe', decision: 'veto', reason })
    } catch { /* provenance never blocks */ }
    log(`RISK VETO ${symbol} ${side}: ${reason}`)
    return null
  }

  log(`Auto-trade: ${side} ${symbol} vol=${volLots} on ${isLive ? 'LIVE' : 'DEMO'}`)

  try {
    // execGuard rides along so the 5A kill switch / volume cap enforce on
    // this hand-assembled creds path exactly like getCtraderCreds callers.
    let execGuard = null
    try { execGuard = JSON.parse(getState(db, 'exec_guard_json') || 'null') } catch { /* no guard */ }
    // (a) WRITE-AHEAD INTENT. The ledger row is created BEFORE the broker is
    // called, in status 'submitting', and promoted to 'open' once the ACK
    // lands. Until 2026-08-03 the row was written only AFTER a successful
    // ACK, so a timeout, a crash, or a redeploy in that window left an order
    // live at the broker with nothing in the ledger — and `duplicate_symbol`
    // (risk.js:809) reads the ledger, so the next cycle could not see the
    // position it was about to duplicate.
    //
    // With the intent row present, that same query sees a row on the very
    // next cycle whatever happens next, so the guard closes even if this
    // process dies between these two statements. A stranded 'submitting' row
    // is itself a finding — the reconciler resolves it against broker truth,
    // and the post-decision auditor counts it.
    const intentId = db.prepare(`
      INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume,
                          opened_at, status, strategy, account_id, source)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'submitting', ?, ?, 'autotrade')
    `).run(
      symbol, side, synth.entry ?? null, synth.sl ?? null, synth.tp1 ?? null,
      volLots, synth.strategy || null, String(accountId),
    ).lastInsertRowid

    const submitT0 = Date.now()
    let exec
    try {
      exec = await execPlaceOrder({ host, clientId, clientSecret, accessToken, accountId, execGuard }, orderPayload)
    } catch (err) {
      // Mark the intent by OUTCOME rather than deleting it. A provably-unsent
      // order is dead and must not block the next attempt; an ambiguous one
      // may be live and MUST block it. Deleting on both would restore the very
      // hole this row was added to close.
      const { isAmbiguousOrderOutcome } = await import('./lib/exec-fallback.js')
      const unknown = isAmbiguousSubmitError(err) || isAmbiguousOrderOutcome(err)
      try {
        db.prepare(`UPDATE trades SET status = ? WHERE id = ?`)
          .run(unknown ? 'unconfirmed' : 'rejected', intentId)
      } catch { /* the throw below is the report */ }
      throw err
    }
    const entryLatencyMs = Date.now() - submitT0
    setState(db, 'api_ctrader_last_ok', new Date().toISOString())
    const executionPrice = exec?.deal?.executionPrice || exec?.position?.price || null
    // normPosId: one exec path returned float-formatted ids ("234698574.0")
    // which broke deal-history P&L matching and duplicate detection.
    const { normPosId } = await import('./lib/pos-id.js')
    const positionId = normPosId(exec?.position?.positionId ?? exec?.deal?.positionId)

    // THE PRICE EVERY LEDGER WRITE MUST USE. `executionPrice` is the broker's
    // confirmed fill and is frequently ABSENT — a market order's deal can land
    // after the ACK, and the C++ sidecar returns a positionId without one. When
    // it is missing, the signal's intended entry is the best number available
    // and is very close to the fill for the limit orders this system mostly
    // places.
    //
    // This variable already existed and was already used for `initialRisk`
    // below — but the two writes that STORE the price passed the raw
    // `executionPrice` instead. Production proved it: rows carrying
    // `initial_risk: 3.043` (computed here, from entryP) alongside
    // `entry_price: null` (from executionPrice), one line apart in the same
    // function. Downstream, the time cap could not be evaluated (#580) and the
    // SL/TP money column reported notional instead of risk (#581).
    //
    // `slippage_price` still keys off `executionPrice` alone, so a row where
    // the fill was never confirmed remains identifiable: entry present,
    // slippage null.
    const entryP = executionPrice ?? synth.entry ?? null
    // Forensics (Performance Ledger collect-forward): signed adverse-positive
    // slippage vs the signal's intended entry, and market context at open —
    // relative 1m volume and which side of session VWAP the fill landed.
    // Best-effort: any failure leaves NULLs, never blocks the trade write.
    const slippagePrice = (executionPrice != null && Number.isFinite(Number(synth.entry)))
      ? (side === 'BUY' ? executionPrice - synth.entry : synth.entry - executionPrice)
      : null
    // (c) FORENSICS MOVED. These two calls — an L2 depth snapshot and a 60-bar
    // 1m fetch (10s timeout) — used to run BETWEEN the broker ACK and the
    // ledger write, holding the critical window open for up to ~10 seconds
    // per entry. They are collect-forward analytics; nothing decides on them.
    // They now run AFTER the row exists and patch it in place, so a crash
    // costs a null column instead of an untracked live position.
    let rvolOpen = null, vwapSideOpen = null
    let depthJson = null, depthImb = null
    const slP = synth.sl ?? null
    const initialRisk = (entryP && slP) ? Math.abs(entryP - slP) : null

    let timeCap = null
    if (synth.time_cap_minutes && Number.isFinite(synth.time_cap_minutes)) {
      timeCap = new Date(Date.now() + synth.time_cap_minutes * 60_000).toISOString()
    }

    // Atomic DB write: promote the intent row to 'open' and create its
    // monitored_position, in a single transaction. If either statement fails,
    // neither persists.
    //
    // This is an UPDATE, not an INSERT: the row already exists, written before
    // the broker was called (see the write-ahead intent above). Inserting a
    // second row here would leave the 'submitting' one stranded and put two
    // ledger entries behind one broker position — the accounting version of
    // the bug this change exists to fix.
    const parsedLabel = parseLabel(structuredLabel)
    const persistTrade = db.transaction(() => {
      db.prepare(`
        UPDATE trades SET
          entry_price = ?, sl_price = ?, tp_price = ?, volume = ?,
          opened_at = datetime('now'), status = 'open',
          ctrader_position_id = ?, strategy = ?, conviction = ?,
          label_raw = ?, source = ?, label_version = ?, label_strategy = ?,
          label_conviction = ?, label_session = ?, label_timeframe = ?,
          label_regime = ?, confluence_count = ?, account_id = ?,
          slippage_price = ?, spread_at_entry = ?, entry_latency_ms = ?
        WHERE id = ?
      `).run(
        entryP, slP, synth.tp1 ?? null, volLots,
        positionId, synth.strategy || null, synth.overall_conviction ?? null,
        parsedLabel.raw, parsedLabel.source, parsedLabel.version,
        parsedLabel.strategy, parsedLabel.conviction, parsedLabel.session,
        parsedLabel.timeframe, parsedLabel.regime,
        synth.confluenceCount ?? null,
        String(accountId),
        slippagePrice, entrySpread, entryLatencyMs,
        intentId,
      )
      const tradeId = intentId

      db.prepare(`
        INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, thesis, initial_risk, invalidation_trigger, time_cap_at, strategy, source, label_raw, account_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
      `).run(
        symbol,
        tradeId,
        side === 'BUY' ? 'long' : 'short',
        entryP,
        slP,
        synth.tp1 ?? null,
        synth.synthesis || '',
        initialRisk,
        synth.invalidation_trigger || null,
        timeCap,
        synth.strategy || null,
        parsedLabel.source,
        parsedLabel.raw,
        accountId != null ? String(accountId) : null,
      )

      return tradeId
    })

    const tradeId = persistTrade()
    log(`Auto-trade placed: ${side} ${symbol} @ ${executionPrice} posId=${positionId} tradeId=${tradeId}`)

    // (c) Collect-forward analytics, AFTER the position is fully recorded.
    // Every failure here leaves a NULL column and nothing else — the trade is
    // already durable, monitored and visible to the duplicate guard.
    try {
      const { captureDepthAtEntry } = await import('./services/depth-capture.js')
      const d = await captureDepthAtEntry(symbolId)
      depthJson = d.depthJson
      depthImb = d.depthImbalance
    } catch { /* depth optional */ }
    try {
      const [{ relVolFromBars }, ind] = await Promise.all([
        import('./services/fast-monitor.js'), import('./lib/indicators.js'),
      ])
      const byTf = await wsGetTrendbarsBatch(host, clientId, clientSecret, accessToken, accountId, symbolId, ['1m'], 60, 10_000)
      const bars1m = byTf['1m'] || []
      const rv = relVolFromBars(bars1m.slice(-21))
      if (Number.isFinite(rv)) rvolOpen = Math.round(rv * 100) / 100
      const vw = ind.vwapAnchored(bars1m)
      const lastVw = Array.isArray(vw) ? vw[vw.length - 1] : null
      if (lastVw != null && entryP != null) vwapSideOpen = entryP >= lastVw ? 'above' : 'below'
    } catch { /* context optional */ }
    try {
      db.prepare(`UPDATE trades SET rvol_open = ?, vwap_side_open = ?, depth_json = ?, depth_imbalance = ? WHERE id = ?`)
        .run(rvolOpen, vwapSideOpen, depthJson, depthImb, tradeId)
    } catch { /* forensics must never undo a recorded trade */ }

    return { executionPrice, positionId, side, volume: volLots }
  } catch (err) {
    // A placement failure AFTER risk approval must be as loud as a veto —
    // silently logging it made "risk gate said OK but no trade appeared"
    // undiagnosable from the UI (real support case: two days of OKs with
    // zero positions and no explanation anywhere but Railway logs).
    // AUDIT F-L4-01: separate the two failure shapes, because they mean
    // opposite things for what may exist at the broker.
    //   order_failed    — the broker refused it, or the socket died BEFORE the
    //                     request went out. No position. Retrying is correct.
    //   order_ambiguous — the request WAS sent and no execution event came
    //                     back. A position may be open right now. The dedupe
    //                     above reads these rows, so the next cycle will not
    //                     resubmit inside the window.
    // BOTH verdicts. `isAmbiguousSubmitError` recognises Node's WS path (the
    // `after sending <NEW_ORDER_REQ>` marker wsRun stamps); the sidecar path
    // never passes through wsRun, so its timeouts carried no marker and were
    // being recorded as `order_failed` = "provably no position, retry is
    // correct". That misclassification is the root cause of the 9x 0066.HK
    // duplicate. isAmbiguousOrderOutcome defaults to UNKNOWN and only clears
    // when non-submission is provable.
    const { isAmbiguousOrderOutcome } = await import('./lib/exec-fallback.js')
    const amb = isAmbiguousSubmitError(err) || isAmbiguousOrderOutcome(err)
    log(`Auto-trade ${amb ? 'AMBIGUOUS' : 'FAILED'} for ${symbol}: ${err.message}`)
    try {
      persistRiskEvent(db, proposal, {
        approved: false,
        veto_reason: `${amb ? 'order_ambiguous' : 'order_failed'}: ${err.message}`,
      })
    } catch { /* audit only */ }
    setState(db, 'last_order_error', JSON.stringify({ symbol, side, error: err.message, ambiguous: amb, at: new Date().toISOString() }))
    if (process.env.TELEGRAM_BOT_TOKEN) {
      try {
        const { sendMessage } = await import('./services/telegram.js')
        await sendMessage(amb
          ? `⚠️ ORDER OUTCOME UNKNOWN: ${symbol} ${side} — the order was SENT and no confirmation came back (${err.message}). A position may be open at the broker. Check cTrader before acting; the bot will not resubmit for ${DEDUPE_WINDOW_MIN} minutes.`
          : `⚠️ ORDER FAILED after risk approval: ${symbol} ${side} — ${err.message}. The broker rejected it or the connection dropped before it was sent; the signal may retry next loop.`)
      } catch { /* non-fatal */ }
    }
    return null
  }
}

function log(...args) {
  console.log('[loop]', ...args)
}

// ---------------------------------------------------------------------------
// Per-symbol synthesis → gate chain → auto-trade dispatch. Shared by the live
// scan/analyze phase below (which only walks the top 3 hot symbols per
// cycle) and the pending-signals retry phase (services/pending-signals.js),
// which re-fires this SAME chain — never a stored stale synth — the moment a
// closed-market symbol's exchange reopens. One function means a gate added
// here protects both paths; `signal` is the raw fib-strategy signal for
// `sym` (scanResult.signals[sym] on the live path, a fresh re-scan on the
// pending-signal retry path).
// ---------------------------------------------------------------------------
export async function dispatchSymbolSignal(db, s, symbols, sym, signal) {
  const wItem = symbols.find(w => w.symbol === sym) || { autoTradeThreshold: 8 }

  // Pre-flight: skip analysis if ALL trade styles are disabled for this symbol
  if (wItem.allowed_styles) {
    const st = wItem.allowed_styles
    if (st.scalp === false && st.day === false && st.swing === false && st.mid_term === false) {
      log(`Style filter: ${sym} — all styles disabled, skipping analysis`)
      try {
        const { recordDecision } = await import('./services/decision-log.js')
        recordDecision(db, { symbol: sym, stage: 'style_filter', decision: 'skip', reason: 'all_styles_disabled' })
      } catch { /* provenance never blocks */ }
      return { fired: false, synth: null }
    }
  }
  const result = synthesizeFibSignal(sym, signal, wItem.autoTradeThreshold || 8)

  // Find latest scan id for this symbol to link
  const latestScan = s.latestScanForSymbol.get(sym)
  const scanId = latestScan ? latestScan.id : null

  const synth = result.synthesis || {}
  s.insertAnalysis.run({
    symbol: result.symbol,
    consensus_bias: synth.consensus_bias || null,
    overall_conviction: synth.overall_conviction ?? null,
    consensus_summary: synth.consensus_summary || synth.synthesis || null,
    synthesis: JSON.stringify(synth),
    entry_price: synth.entry_price ?? synth.entry ?? null,
    sl_price: synth.sl_price ?? synth.sl ?? null,
    tp1_price: synth.tp1_price ?? synth.tp1 ?? null,
    tp2_price: synth.tp2_price ?? synth.tp2 ?? null,
    auto_trade: synth.auto_trade ? 1 : 0,
    strategy: synth.strategy || null,
    risk_note: synth.risk_note || null,
    minion_reports: JSON.stringify(result.reports || []),
    invalidation_trigger: synth.invalidation_trigger || null,
    time_cap_minutes: synth.time_cap_minutes ?? null,
    analyzed_at: new Date().toISOString(),
    scan_id: scanId,
  })

  log(`Analysis complete: ${sym} — ${synth.consensus_bias || '?'} (${synth.overall_conviction || 0}/10) rr=${synth.risk_note || ''}`)

  // Auto-trade — only when armed and synthesis recommends it.
  // Iterate all autopilot-enabled accounts so the same signal
  // replicates across every assigned account with per-account sizing.
  // Telegram alert per analysis, deduped on the zone signature —
  // a persisting fib zone re-analyzes every loop with near-identical
  // numbers and must not re-ping every 5 minutes.
  if (synth.overall_conviction >= 6 && process.env.TELEGRAM_BOT_TOKEN) {
    const alertKey = `last_analysis_alert_${sym}`
    const alertSig = signal ? `${signal.timeframe}@${signal.level618}` : String(synth.entry)
    if (alertSig !== getState(db, alertKey)) {
      try {
        const { sendMessage } = await import('./services/telegram.js')
        const { formatAnalysisAlert, signalButtons } = await import('./services/alert-format.js')
        const newsLines = await import('./services/news-calendar.js').then(m => m.newsLinesFor(db, sym)).catch(() => [])
        await sendMessage(formatAnalysisAlert(db, { sym, synth, signal, newsLines, armed: {
          tfs: (() => { try { return JSON.parse(getState(db, 'autotrade_timeframes') || '[]') } catch { return [] } })(),
          matrix: (() => { try { return JSON.parse(getState(db, 'autotrade_matrix_json') || 'null') } catch { return null } })(),
          autotrade: getState(db, 'autotrade_enabled') === 'true',
        } }), { buttons: signalButtons({ sym, tf: signal?.timeframe || synth.timeframe, strategy: synth.strategy }) })
        setState(db, alertKey, alertSig)
      } catch { /* non-fatal */ }
    }
  }

  // Autotrade SCOPE (owner 2026-07-17): the backtest arms combos, but
  // auto-trade is the intelligent full-watchlist trader. Default
  // scope 'all' = every enabled watchlist symbol × every scanned
  // timeframe may trade (backtest-armed combos remain micro-tuning:
  // the scan prefers them where present). scope 'armed' restores the
  // narrow behaviour: only the armed TF list / per-symbol matrix.
  // Either way the risk gate, stage matrix, market hours, exposure
  // caps and equity stop still veto — scope decides what is
  // CONSIDERED, the gates decide what EXECUTES.
  if (synth.auto_trade && (getState(db, 'autotrade_scope') || 'all') === 'armed') {
    // One shared reader and one shared default (lib/timeframes.js) — four
    // modules used to carry their own ['4h','1d'] literal.
    const allowedTfs = armedTimeframes(db, getState)
    if (!allowedTfs.includes(synth.timeframe)) {
      log(`Timeframe gate: ${sym} blocked — ${synth.timeframe} not in autotrade_timeframes [${allowedTfs.join(',')}]`)
      synth.auto_trade = false
    }

    // Per-instrument arming (autotrade_matrix_json = {SYM: [tfs]}):
    // when the matrix exists, a symbol only trades the timeframes the
    // trader armed FOR THAT SYMBOL — "arm anyway" on NATGAS 2h must
    // not arm 2h for the whole watchlist. Absent matrix = legacy
    // TF-wide behaviour.
    if (synth.auto_trade) {
      const matrixJson = getState(db, 'autotrade_matrix_json')
      if (matrixJson) {
        try {
          const matrix = JSON.parse(matrixJson)
          if (matrix && typeof matrix === 'object' && Object.keys(matrix).length > 0) {
            const armedForSym = matrix[sym.toUpperCase()] || []
            if (!armedForSym.includes(synth.timeframe)) {
              log(`Matrix gate: ${sym} blocked — ${synth.timeframe} not armed for this symbol (armed: ${armedForSym.join(',') || 'none'})`)
              synth.auto_trade = false
            }
          }
        } catch { /* corrupt matrix — fall back to TF-wide */ }
      }
    }
  }
  if (synth.auto_trade) {
    // Stage-matrix gate (Tune → Pipeline table): the scan now covers
    // MORE than what may trade — the strategy's "Auto Trade & Open"
    // cell must be on, and no trade-armed filter may have failed at
    // scan time (filters run in annotate mode there).
    // UNION, not verdict (04-08-2026). The stage matrix is now per-account:
    // one account may have armed a strategy the global matrix has off. This
    // check therefore only stops work NOBODY could act on; the authoritative
    // per-account decision happens inside the dispatch fan-out below, where
    // the account is known. With no overlays anywhere this is identical to the
    // single global gate it replaces.
    const rosterForGate = getAutopilotAccounts(db).map(a => String(a.accountId))
    const gate = anyAccountTradeGate(db, getState, {
      strategy: synth.strategy,
      filtersFailed: signal?.filters_failed || [],
      accountIds: rosterForGate,
    })
    if (!gate.ok) {
      log(`Stage gate: ${sym} blocked — ${gate.reason}`)
      // 2026-07-29: this was a stdout line and NOTHING else. It is the most
      // common reason a signal never trades — on staging it silently blocked
      // every dispatch for a full day (vwap_trend / donchian_breakout /
      // fib_confluence all proposing with auto_trade:true while their trade
      // cell was off) — and because it recorded nothing, `risk_events` and
      // `decision_log` were both EMPTY, which reads as "the bot considered
      // nothing" rather than "the bot considered plenty and this gate said
      // no". Every other gate on this path already leaves a row; this one
      // now does too.
      try {
        const { recordDecision } = await import('./services/decision-log.js')
        recordDecision(db, {
          symbol: sym, timeframe: synth.timeframe, strategy: synth.strategy,
          stage: 'stage_matrix', decision: 'skip', reason: gate.reason,
        })
      } catch { /* provenance never blocks */ }
      synth.auto_trade = false
    }
  }

  // Regime gate: don't fade a trend, don't chase a range (owner: "trading
  // like a beginner", PF 0.15). The regimes table was computed but never
  // used to gate entries — this is the fix. Records a veto so the block is
  // auditable in Risk decisions, same as every other gate.
  if (synth.auto_trade) {
    const rg = checkRegimeGate(db, synth.strategy, synth.consensus_bias, sym)
    if (rg.block) {
      log(`Regime gate: ${sym} blocked — ${rg.reason}`)
      try {
        persistRiskEvent(db, { symbol: sym, side: synth.consensus_bias === 'short' ? 'SELL' : 'BUY', strategy: synth.strategy, entry: signal?.entry ?? null }, { approved: false, veto_reason: rg.reason })
      } catch { /* audit best-effort */ }
      synth.auto_trade = false
    }
  }

  // Human override: if override_bias is set, use it instead of AI's
  if (wItem.override_bias && ['long', 'short', 'neutral', 'skip'].includes(wItem.override_bias)) {
    if (wItem.override_bias === 'skip' || wItem.override_bias === 'neutral') {
      if (synth.auto_trade) {
        try {
          const { recordDecision } = await import('./services/decision-log.js')
          recordDecision(db, { symbol: sym, timeframe: synth.timeframe, strategy: synth.strategy, stage: 'watchlist_override', decision: 'skip', reason: `override_bias=${wItem.override_bias}` })
        } catch { /* provenance never blocks */ }
      }
      synth.auto_trade = false
    } else {
      synth.consensus_bias = wItem.override_bias
    }
  }

  // Style filter: check if time_cap_minutes matches allowed trade types
  if (wItem.allowed_styles && synth.auto_trade) {
    const ttl = synth.time_cap_minutes || 180
    const styles = wItem.allowed_styles
    const isScalp = ttl <= 30
    const isDay = ttl > 30 && ttl <= 480
    const isSwing = ttl > 480 && ttl <= 10080
    const isMidTerm = ttl > 10080

    // One classification, one branch — the four separate ifs could each fire
    // independently and log twice for one decision. TTL buckets are disjoint,
    // so naming the bucket once is both simpler and honest about what was
    // actually decided.
    const style = isScalp ? 'scalp' : isDay ? 'day' : isSwing ? 'swing' : isMidTerm ? 'mid_term' : null
    if (style && styles[style] === false) {
      log(`Style filter: ${sym} blocked — ${style.replace('_', '-')} trading disabled (TTL ${ttl}m)`)
      // Same omission as the stage gate above: silent in the DB until now.
      try {
        const { recordDecision } = await import('./services/decision-log.js')
        recordDecision(db, {
          symbol: sym, timeframe: synth.timeframe, strategy: synth.strategy,
          stage: 'style_filter', decision: 'skip', reason: `${style}_disabled ttl=${ttl}m`,
        })
      } catch { /* provenance never blocks */ }
      synth.auto_trade = false
    }
  }

  // Human override: block_next_trade — one-time veto then auto-clear
  if (wItem.block_next_trade && synth.auto_trade) {
    log(`Block next trade: ${sym} — human veto, clearing flag`)
    synth.auto_trade = false
    // Clear the flag after use
    const symbolsJsonCurrent = getState(db, 'autopilot_symbols_json') || '[]'
    try {
      const syms = JSON.parse(symbolsJsonCurrent)
      const s2 = syms.map(s2i => typeof s2i === 'string' ? { symbol: s2i } : s2i)
      const target = s2.find(s2i => s2i.symbol === sym)
      if (target) target.block_next_trade = false
      setState(db, 'autopilot_symbols_json', JSON.stringify(s2))
    } catch { /* non-fatal */ }
  }

  let fired = false
  if (getState(db, 'autotrade_enabled') === 'true' && synth.auto_trade && synth.entry) {
    // Portfolio margin pre-gate — ONE cheap aggregate check before any
    // per-account sizing work. When open positions already consume the
    // whole margin cap, every proposal ends in the same insufficient_margin
    // veto AFTER the full strategize+size pipeline has run (owner
    // 2026-07-24: 67 identical margin vetoes in a day — "waste all the
    // effort to strategise"). Skip the dispatch outright and record ONE
    // risk event per loop cycle instead of one per symbol. Broker-truth
    // margin when the snapshot is fresh (see portfolioMarginStatus).
    if (portfolioMarginExhausted(db)) return { fired: false, synth }
    const apAccounts = getAutopilotAccounts(db)
    const { accountMayTrade, symbolAllowsStrategy } = await import('./services/watchlists.js')
    const { enabledStrategies } = await import('./services/strategies.js')
    const globalArmed = enabledStrategies(db, getState).map(s => s.key)
    const { effectivePhases } = await import('./services/account-phases.js')
    // Connectivity gate input, fetched ONCE per dispatch: the sidecar's
    // authorized roster. An enabled account the broker session has not
    // authorized cannot receive an order — strategize/size/risk-gate work for
    // it is guaranteed waste, and the submit would only fail downstream.
    // null = unknown (js mode, health blip) → no account is skipped for it.
    let sidecarAccounts = null
    try {
      const { sidecarRoster } = await import('./lib/exec-engine.js')
      sidecarAccounts = await sidecarRoster()
    } catch { /* unknown — fail open */ }
    for (const acct of apAccounts) {
      // PER-ACCOUNT AUTOTRADE GATE — the enforcement point for the owner's
      // independent switches. Without this the switches would be decorative:
      // the UI would show autotrade OFF for an account and the loop would keep
      // sending it orders.
      //
      // Placed FIRST in the per-account body on purpose. Everything below —
      // the watchlist gate, the strategy gate, sizing, the risk gate — is work
      // done in order to build an order for THIS account, and an account that
      // may not trade should not pay for any of it (owner: "I am serious about
      // avoiding unnecessary effort and expenses").
      //
      // The master flag is already checked upstream at the synth level; this is
      // the per-account override, and effectivePhases keeps the master an AND so
      // a per-account ON can never defeat a global OFF.
      //
      // ALL THREE phases gate here, in pipeline order. Scan and analyze are
      // shared work done once per cycle, so switching either off for one
      // account cannot un-scan the symbol — but it must still stop the account
      // acting on a stage it is switched out of, otherwise "Scan off" on that
      // account would sit above a trade the account just took.
      const phases = effectivePhases(db, acct.accountId)
      const offPhase = ['scan', 'analyze', 'autotrade'].find(p => !phases[p])
      if (offPhase) {
        log(`Phase gate: ${sym} skipped on ${acct.accountId} — ${offPhase} off (${phases.source[offPhase]})`)
        try {
          const { recordDecision } = await import('./services/decision-log.js')
          recordDecision(db, {
            accountId: String(acct.accountId),
            symbol: sym, timeframe: synth.timeframe, strategy: synth.strategy,
            stage: `account_${offPhase}`, decision: 'skip',
            reason: `${offPhase} is off for this account (${phases.source[offPhase]})`,
          })
        } catch { /* provenance never blocks */ }
        continue
      }

      // PER-ACCOUNT STAGE GATE — the authoritative one. The signal-level check
      // above is a union across the roster, so a strategy this ACCOUNT has not
      // armed can still arrive here. Placed right after the phase gate and
      // before any sizing work, for the same reason that one is first: an
      // account that may not trade this strategy should not pay for building
      // an order it will never send.
      const acctGate = tradeStageGate(db, getState, {
        strategy: synth.strategy,
        filtersFailed: signal?.filters_failed || [],
        accountId: String(acct.accountId),
      })
      if (!acctGate.ok) {
        log(`Stage gate: ${sym} skipped on ${acct.accountId} — ${acctGate.reason}`)
        try {
          const { recordDecision } = await import('./services/decision-log.js')
          recordDecision(db, {
            accountId: String(acct.accountId),
            symbol: sym, timeframe: synth.timeframe, strategy: synth.strategy,
            stage: 'stage_matrix', decision: 'skip', reason: acctGate.reason,
          })
        } catch { /* provenance never blocks */ }
        continue
      }

      // RATCHET GATE (v2) — the profit ratchet no longer touches the S.A.T.
      // switches; its hold lives here instead. 'soft' = inside the warning
      // band (entries paused, reversible on recovery); 'halt' = floor
      // confirmed (cleared by auto re-arm or the owner's [Re-arm] button).
      // The owner's switches above stay exactly as the owner set them.
      try {
        const { ratchetGate } = await import('./services/profit-ratchet.js')
        const rg = ratchetGate(db, acct.accountId)
        if (rg.blocked) {
          log(`Ratchet gate: ${sym} skipped on ${acct.accountId} — ratchet ${rg.stage}`)
          const { recordDecision } = await import('./services/decision-log.js')
          recordDecision(db, {
            accountId: String(acct.accountId),
            symbol: sym, timeframe: synth.timeframe, strategy: synth.strategy,
            stage: 'ratchet_gate', decision: 'skip',
            reason: rg.stage === 'halt'
              ? 'profit ratchet halt — floor was hit; re-arm via Telegram button or wait for auto re-arm'
              : 'profit ratchet soft pause — equity inside the warning band above the floor',
          })
          continue
        }
      } catch { /* gate provenance never blocks dispatch */ }

      // CONNECTIVITY GATE — an account the sidecar has not authorized gets no
      // order built for it this cycle. Skips are recorded, and the account
      // rejoins automatically the moment the roster reports it again (the
      // heartbeat's roster-drift re-push is the recovery mechanism).
      if (sidecarAccounts && !sidecarAccounts.includes(String(acct.accountId))) {
        log(`Connectivity gate: ${sym} skipped on ${acct.accountId} — account not in the sidecar's authorized roster`)
        try {
          const { recordDecision } = await import('./services/decision-log.js')
          recordDecision(db, {
            accountId: String(acct.accountId),
            symbol: sym, timeframe: synth.timeframe, strategy: synth.strategy,
            stage: 'account_probe', decision: 'skip',
            reason: 'enabled in registry but not in the sidecar authorized roster — no order built until it reconnects',
          })
        } catch { /* provenance never blocks */ }
        continue
      }

      // PER-ACCOUNT MEMBERSHIP GATE. The scan universe is the union of every
      // enabled account's watchlist, so a symbol reaching here may belong to
      // only some of them. Until an account owns a list this resolves to the
      // shared one and passes exactly what it passed before.
      //
      // It records a decision rather than skipping quietly: the stage-matrix
      // gate blocked every dispatch for a day while writing only to stdout,
      // and nothing in the DB showed why (see agent/dispatch-skip-provenance
      // .test.js). Every gate on this path leaves a row.
      const member = accountMayTrade(db, acct.accountId, sym)
      if (!member.ok) {
        log(`Watchlist gate: ${sym} not tradable on ${acct.accountId} — ${member.reason}`)
        try {
          const { recordDecision } = await import('./services/decision-log.js')
          recordDecision(db, {
            accountId: String(acct.accountId),
            symbol: sym, timeframe: synth.timeframe, strategy: synth.strategy,
            stage: 'account_watchlist', decision: 'skip', reason: member.reason,
          })
        } catch { /* provenance never blocks */ }
        continue
      }
      // The account's OWN row wins on sizing and thresholds — a copied symbol
      // carries its lot cap, and a cap that silently reverted to the shared
      // list's would resize the trade.
      const acctItem = { ...wItem, ...member.item }

      // PER-SYMBOL STRATEGY GATE. A symbol row may narrow which of the armed
      // strategies are allowed to trade it — "run RSI-2 on this one, not the
      // breakout". It can only ever narrow: a row cannot arm something the
      // operator disarmed globally, or a strategy with no backtest behind it
      // would reach capital through a watchlist edit.
      //
      // Enforced here rather than in the scan because the scan has no account
      // in scope, and two accounts may pick differently for the same symbol.
      // The cost is one wasted compute per suppressed signal; the alternative
      // is a scan that is wrong for whichever account it did not pick.
      const stratGate = symbolAllowsStrategy(acctItem, synth.strategy, globalArmed)
      if (!stratGate.ok) {
        log(`Symbol strategy gate: ${sym} on ${acct.accountId} — ${stratGate.reason}`)
        try {
          const { recordDecision } = await import('./services/decision-log.js')
          recordDecision(db, {
            accountId: String(acct.accountId),
            symbol: sym, timeframe: synth.timeframe, strategy: synth.strategy,
            stage: 'symbol_strategy', decision: 'skip', reason: stratGate.reason,
          })
        } catch { /* provenance never blocks */ }
        continue
      }

      const tradeResult = await autoTrade(db, sym, synth, acctItem, acct)
      if (tradeResult) {
        fired = true
        if (process.env.TELEGRAM_BOT_TOKEN) {
          try {
            const { sendMessage } = await import('./services/telegram.js')
            await sendMessage(
              `🤖 AUTO-TRADE [${acct.accountId}]: ${tradeResult.side} ${sym} @ ${tradeResult.executionPrice ?? 'mkt'} | SL ${synth.sl ?? '—'} TP ${synth.tp1 ?? '—'}`
            )
          } catch { /* non-fatal */ }
        }
      }
    }
  }
  return { fired, synth }
}

// Per-cycle memo for the portfolio margin pre-gate: the aggregate is the
// same for every symbol within one loop cycle, so compute it once and
// journal the exhausted state once — not per dispatched symbol.
let marginGateLoop = -1
let marginGateExhausted = false
function portfolioMarginExhausted(db) {
  if (marginGateLoop === loopCount) return marginGateExhausted
  marginGateLoop = loopCount
  marginGateExhausted = false
  try {
    const config = loadRiskConfig(db)
    const balance = getAccountBalance(db)
    if (!(balance > 0)) return false
    const pm = portfolioMarginStatus(db, config, { balance, leverage: getAccountLeverage(db, config) })
    if (pm && pm.headroom <= 0) {
      marginGateExhausted = true
      log(`Autotrade dispatch paused this cycle: portfolio margin exhausted — ${pm.source} used $${pm.usedMargin.toFixed(2)} vs cap $${pm.cap.toFixed(2)} (maxMarginUsagePct=${config.maxMarginUsagePct}). No sizing attempted; close/shrink positions or raise the cap to resume.`)
      try {
        persistRiskEvent(db, { symbol: 'PORTFOLIO', side: '—' }, {
          approved: false,
          veto_reason: `portfolio_margin_exhausted used=${pm.usedMargin.toFixed(2)} cap=${pm.cap.toFixed(2)} source=${pm.source}`,
          checks: {
            margin_used_usd: Number(pm.usedMargin.toFixed(2)),
            margin_cap_usd: Number(pm.cap.toFixed(2)),
            margin_source: pm.source,
          },
        })
      } catch { /* journaling is best-effort */ }
    }
  } catch { /* the pre-gate must never break dispatch on its own error */ }
  return marginGateExhausted
}

// ---------------------------------------------------------------------------
// Broker-action executor — maps position-manager decisions onto cTrader.
//
//   MOVE_SL       → AMEND_POSITION_SLTP_REQ
//   PARTIAL_EXIT  → CLOSE_POSITION_REQ (fraction of volume), then AMEND for trail SL
//   FULL_EXIT     → CLOSE_POSITION_REQ (full volume)
//
// Returns a structured outcome used to compose last_check_reasoning so the
// Workshop activity feed surfaces what actually happened at the broker, not
// just the bot's intent.
//
// If credentials are absent (e.g. keeper running without cTrader config),
// the executor returns { skipped: true } and the caller falls back to the
// pre-existing log-only behaviour so local/offline runs still function.
// ---------------------------------------------------------------------------

/**
 * Which account (and therefore which host) a position must be managed on.
 *
 * AUDIT F-L4-02: this used to read `ctrader_account_id` and `ctrader_is_live`
 * from global state, so with more than one account enabled a close or SL amend
 * for account B was issued on account A's session — and because
 * `ctrader_is_live` also picks the HOST, a demo position could be addressed
 * against the live host. The failure surfaces as POSITION_NOT_FOUND, which the
 * amend path treats as "already closed", so a live position could be recorded
 * as gone.
 *
 * The position's own `account_id` now decides, with its live/demo side read
 * from the accounts registry. Refusals are explicit, never a silent fallback
 * to whichever account happens to be selected:
 *   · rowAccountId null (legacy, pre-stamping rows) → the selected account,
 *     which is what those rows were created under. Unchanged behaviour.
 *   · rowAccountId present but absent from the registry → REFUSE. Guessing a
 *     host for an unknown account is exactly the mis-route this prevents.
 *
 * Exported for tests.
 */
export function resolveActionAccount(db, rowAccountId) {
  const selected = getState(db, 'ctrader_account_id')
  if (rowAccountId == null || String(rowAccountId) === String(selected)) {
    return { accountId: selected, isLive: getState(db, 'ctrader_is_live') === 'true', source: 'selected' }
  }
  let row = null
  try {
    row = db.prepare('SELECT account_id, is_live FROM accounts WHERE account_id = ?').get(String(rowAccountId)) || null
  } catch { /* registry may predate this — fall through to the refusal */ }
  if (!row) return { accountId: null, isLive: null, source: 'unknown_account' }
  return { accountId: String(row.account_id), isLive: row.is_live === 1, source: 'registry' }
}

/**
 * May a caller mark a position closed in the DB after the executor returned
 * `skipped`? Only when there is provably no broker to close against.
 *
 * AUDIT F-L6-02: every other skip reason means a LIVE broker position may
 * exist, and flipping the local row to 'closed' there hides it from every
 * manager (they all read status='active'). Exported so the rule is under test
 * rather than living as an inline string comparison.
 */
export function mayCloseDbOnlyAfterSkip(reason) {
  return reason === 'ctrader_not_configured'
}

/**
 * The broker's OWN volume for one position in a reconcile snapshot, in the
 * protocol's units — or null when the snapshot doesn't carry it. Pure and
 * exported for tests: this is the number a close must send, because any
 * lots→units reconversion on our side can disagree with what the broker
 * holds (the 2026-08-01 100× TRADING_BAD_VOLUME on adopted crypto rows).
 */
export function brokerPositionVolume(brokerPositions, positionId) {
  const bp = (brokerPositions || []).find(p => String(p?.positionId) === String(positionId))
  const v = Number(bp?.tradeData?.volume)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null
}

export async function executeBrokerAction(db, s, pos, eval_, source = 'position_manager') {
  const clientId = ctraderEnv('clientId')
  const clientSecret = ctraderEnv('clientSecret')
  const accessToken = getState(db, 'ctrader_access_token')

  const ctx = s.selectBrokerContext.get(pos.id) || {}
  const acct = resolveActionAccount(db, ctx.accountId ?? null)
  if (acct.source === 'unknown_account') {
    // The row names an account the registry does not know. Managing it on the
    // selected account's session is how a demo position reaches the live host.
    return { skipped: true, reason: `account_not_in_registry:${ctx.accountId}` }
  }
  const accountId = acct.accountId
  const isLive = acct.isLive

  if (!clientId || !clientSecret || !accessToken || !accountId) {
    return { skipped: true, reason: 'ctrader_not_configured' }
  }

  if (!ctx.positionId) {
    return { skipped: true, reason: 'no_ctrader_position_id' }
  }

  const host = isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
  const action = eval_.action

  try {
    if (action === 'MOVE_SL') {
      const res = await execAmendPosition({ host, clientId, clientSecret, accessToken, accountId }, {
        positionId: ctx.positionId,
        stopLoss: eval_.newSL,
      })
      setState(db, 'api_ctrader_last_ok', new Date().toISOString())
      if (res.alreadyClosed) return { closedRemotely: true, summary: 'already_closed' }
      s.updatePositionSl.run(eval_.newSL, pos.id)
      recordPositionEvent(db, {
        accountId, positionId: ctx.positionId, tradeId: pos.trade_id, symbol: pos.symbol,
        kind: 'sl_moved', fromValue: pos.current_sl ?? null, toValue: eval_.newSL,
        reason: eval_.reason, source,
      })
      return { summary: `SL → ${Number(eval_.newSL).toFixed(5)}` }
    }

    // Per-symbol volume math — lotSize varies by asset class; a hardcoded
    // constant here was the TRADING_BAD_VOLUME bug (see lib/lot-sizing.js).
    const volumeMeta = async () => {
      const symbolMap = JSON.parse(getState(db, 'symbol_id_map') || '{}')
      const symbolId = symbolMap[(pos.symbol || '').toUpperCase()]
      if (!symbolId) throw new Error(`symbolId unknown for ${pos.symbol}`)
      const { getVolumeMeta } = await import('./lib/lot-sizing.js')
      return getVolumeMeta(host, clientId, clientSecret, accessToken, accountId, symbolId)
    }

    // BROKER-TRUTH CLOSE VOLUME (production 2026-08-01, Railway log):
    // `Position close (LLM) FAILED: XRPUSD — closeVolume 1000000.00 is bigger
    // than position volume 10000.00 (TRADING_BAD_VOLUME)` — retrying every
    // loop, position never closing. Root cause: ADOPTED rows store lots via
    // reconciler's contractSize() table while this path multiplies by the
    // broker's real lotSize; for crypto the two conventions disagree 100×.
    // Rather than trust either conversion, close what the broker says it
    // holds: fetch the live snapshot and use ITS volume. The computed figure
    // remains only a fallback for a snapshot that could not be read.
    const brokerSnapshot = async () => {
      try {
        const rec = await execReconcile({ host, clientId, clientSecret, accessToken, accountId })
        return { ok: true, positions: rec.position || [] }
      } catch { return { ok: false, positions: [] } }
    }

    if (action === 'FULL_EXIT') {
      const snap = await brokerSnapshot()
      if (snap.ok && !snap.positions.some(p => String(p?.positionId) === String(ctx.positionId))) {
        // The broker no longer holds this position — closing "again" would
        // only error forever. Record reality and stand down.
        if (pos.trade_id) closeTradeRow(db, pos.trade_id, { closeReason: 'already_closed' })
        s.closePosition.run('closed', pos.id)
        return { closedRemotely: true, summary: 'already_closed' }
      }
      let volumeUnits = brokerPositionVolume(snap.positions, ctx.positionId)
      if (volumeUnits == null) {
        const meta = await volumeMeta()
        volumeUnits = Math.round((ctx.volumeLots || 0) * meta.lotSize)
      }
      if (!(volumeUnits > 0)) return { skipped: true, reason: 'unknown_volume' }
      const res = await execClosePosition({ host, clientId, clientSecret, accessToken, accountId }, {
        positionId: ctx.positionId,
        volume: volumeUnits,
      })
      setState(db, 'api_ctrader_last_ok', new Date().toISOString())
      const closePrice = res.deal?.executionPrice || res.position?.price || null
      const cpd = res.deal?.closePositionDetail || {}
      const grossPnl = typeof cpd.grossProfit === 'number' ? cpd.grossProfit / 100 : null
      const netPnl = cpd.grossProfit != null
        ? ((cpd.grossProfit || 0) - Math.abs(cpd.commission || 0) - Math.abs(cpd.swap || 0)) / 100
        : null
      if (pos.trade_id) {
        closeTradeRow(db, pos.trade_id, { exitPrice: closePrice, closeReason: eval_.reason || 'position_manager', grossPnl, netPnl })
      }
      s.closePosition.run('closed', pos.id)
      recordPositionEvent(db, {
        accountId, positionId: ctx.positionId, tradeId: pos.trade_id, symbol: pos.symbol,
        kind: 'close', priceAt: closePrice, reason: eval_.reason || 'position_manager', source,
      })
      return { closedRemotely: true, summary: res.alreadyClosed ? 'already_closed' : `closed @ ${closePrice ?? '?'}` }
    }

    if (action === 'PARTIAL_EXIT') {
      const meta = await volumeMeta()
      // Same broker-truth base as FULL_EXIT: a fraction of what the broker
      // actually holds, not of our reconversion. Falls back to the computed
      // figure only when the snapshot could not be read.
      const snap = await brokerSnapshot()
      const totalUnits = brokerPositionVolume(snap.positions, ctx.positionId)
        ?? Math.round((ctx.volumeLots || 0) * meta.lotSize)
      const fraction = eval_.exitFraction ?? 0.5
      let closeUnits = Math.round(totalUnits * fraction)
      if (meta.stepVolume) closeUnits = Math.floor(closeUnits / meta.stepVolume) * meta.stepVolume
      if (totalUnits <= 0 || closeUnits <= 0) return { skipped: true, reason: 'unknown_volume' }
      // A partial that the broker would reject (below min lot) is skipped —
      // the runner keeps its full size rather than erroring every tick.
      if (meta.minVolume != null && closeUnits < meta.minVolume) {
        return { skipped: true, reason: 'partial_below_min_volume' }
      }

      const closeRes = await execClosePosition({ host, clientId, clientSecret, accessToken, accountId }, {
        positionId: ctx.positionId,
        volume: closeUnits,
      })
      setState(db, 'api_ctrader_last_ok', new Date().toISOString())
      if (closeRes.alreadyClosed) {
        if (pos.trade_id) closeTradeRow(db, pos.trade_id, { closeReason: 'already_closed' })
        s.closePosition.run('closed', pos.id)
        return { closedRemotely: true, summary: 'already_closed' }
      }

      // Persist the reduced lot count so the next monitor tick knows the
      // runner size. cTrader returns the remaining position but we track
      // lots not cTrader units on our side.
      const remainingUnits = totalUnits - closeUnits
      const remainingLots = remainingUnits / meta.lotSize
      if (pos.trade_id) s.reduceTradeVolume.run(remainingLots, pos.trade_id)
      // Re-baseline the tamper watch: this volume change is OURS, so the
      // next reconcile must stamp fresh instead of flagging it as manual.
      try {
        db.prepare('UPDATE monitored_positions SET broker_volume_units = NULL WHERE id = ?').run(pos.id)
      } catch { /* watch column optional */ }
      recordPositionEvent(db, {
        accountId, positionId: ctx.positionId, tradeId: pos.trade_id, symbol: pos.symbol,
        kind: 'scale_out', toValue: closeUnits, reason: eval_.reason, source,
      })

      // Move SL for the runner leg (skip if newSL is null / same as current).
      if (eval_.newSL != null && eval_.newSL !== pos.current_sl) {
        const amendRes = await execAmendPosition({ host, clientId, clientSecret, accessToken, accountId }, {
          positionId: ctx.positionId,
          stopLoss: eval_.newSL,
        })
        setState(db, 'api_ctrader_last_ok', new Date().toISOString())
        if (!amendRes.alreadyClosed) {
          s.updatePositionSl.run(eval_.newSL, pos.id)
          recordPositionEvent(db, {
            accountId, positionId: ctx.positionId, tradeId: pos.trade_id, symbol: pos.symbol,
            kind: 'sl_moved', fromValue: pos.current_sl ?? null, toValue: eval_.newSL,
            reason: `${eval_.reason} | runner leg`, source,
          })
        }
      }
      return { summary: `closed ${(fraction * 100).toFixed(0)}% · runner ${remainingLots.toFixed(2)}L` }
    }

    return { skipped: true, reason: `unhandled_action:${action}` }
  } catch (err) {
    return { error: err.message }
  }
}

// D4 (2026-07-27): the monitor phase used to await runMonitorCheck (an LLM
// round trip) one position at a time, serially — with 28 open positions at
// ~2-4s each, a single tick took 60-120s, during which the whole Express
// server was unresponsive (docs/d4-loop-block-fix-plan.md). This function is
// the per-position body, extracted so the caller can run it at bounded
// concurrency (mirrors the existing held-prices.js price-fetch pattern)
// instead of one-at-a-time. Behavior is unchanged — same deterministic
// rules first, same LLM fallback, same broker execution — only the
// scheduling changed. Exported standalone (db/s/pos/currentPrice/client all
// passed in, no closure over runLoop state) so it's unit-testable in
// isolation, same as evaluatePosition/executeBrokerAction.
export async function monitorOnePosition(db, s, pos, currentPrice, client, skipLlm = () => false) {
  const eval_ = evaluatePosition(pos, { currentPrice, rules: rulesForSymbol(db, pos.symbol) })

  // Persist MFE/MAE and any flag flips every loop, regardless of action.
  s.updatePositionMetrics.run(
    eval_.updates.mfe_r ?? pos.mfe_r ?? 0,
    eval_.updates.mae_r ?? pos.mae_r ?? 0,
    eval_.updates.be_moved ?? pos.be_moved ?? 0,
    eval_.updates.scaled_out ?? pos.scaled_out ?? 0,
    pos.id
  )

  // Deterministic rule fired — execute it at the broker (MOVE_SL /
  // PARTIAL_EXIT / FULL_EXIT) then persist what happened. The executor
  // handles "position already closed" races gracefully and returns a
  // summary string that rides along inside last_check_reasoning so the
  // Workshop feed shows intent *and* broker outcome on one row.
  if (eval_.action !== 'HOLD') {
    // External positions: observe only — log what we'd do but don't touch the broker
    if (pos.source === 'external') {
      s.updatePositionCheck.run(
        `EXT:${eval_.action}`,
        `${eval_.reason} | external: observe_only`,
        new Date().toISOString(),
        eval_.action === 'FULL_EXIT' ? 'broken' : 'intact',
        pos.id
      )
      log(`PM ${pos.symbol}: ${eval_.action} (external, observe-only) — ${eval_.reason}`)
      return
    }
    // Stage-matrix "Live Tweak & Close" gate: when the position's
    // strategy has that cell off, the monitor records intent but
    // never touches the broker. Broker-resident SL/TP and any
    // owner-armed per-position guards still protect the position.
    if (!manageStageAllows(db, getState, pos.strategy)) {
      s.updatePositionCheck.run(
        `MGMT-OFF:${eval_.action}`,
        `${eval_.reason} | live_tweak_disabled: ${pos.strategy || 'unlabelled'} is OFF in Live Tweak & Close — broker SL/TP still protect`,
        new Date().toISOString(),
        eval_.action === 'FULL_EXIT' ? 'broken' : 'intact',
        pos.id
      )
      log(`PM ${pos.symbol}: ${eval_.action} suppressed — Live Tweak & Close is off for ${pos.strategy || 'unlabelled'}`)
      return
    }
    const outcome = await executeBrokerAction(db, s, pos, eval_)
    let reasoning = eval_.reason
    let thesisStatus = eval_.action === 'FULL_EXIT' ? 'broken' : 'intact'
    if (outcome.error) {
      reasoning = `${reasoning} | broker_error: ${outcome.error}`
      log(`PM ${pos.symbol}: ${eval_.action} FAILED — ${outcome.error}`)
    } else if (outcome.skipped) {
      reasoning = `${reasoning} | intent_only: ${outcome.reason}`
      log(`PM ${pos.symbol}: ${eval_.action} — ${eval_.reason} (intent-only, ${outcome.reason})`)
    } else {
      reasoning = `${reasoning} | broker: ${outcome.summary}`
      log(`PM ${pos.symbol}: ${eval_.action} — ${outcome.summary}`)
      if (outcome.closedRemotely) thesisStatus = 'broken'
    }
    s.updatePositionCheck.run(
      `PM:${eval_.action}`,
      reasoning,
      new Date().toISOString(),
      thesisStatus,
      pos.id
    )
    return
  }

  // External positions: skip LLM monitor — just update metrics, no
  // token spend. Still stamp a HOLD checkpoint (owner: "why are you
  // not monitoring" — this position WAS evaluated every cycle, the
  // UI just never said so, because only a non-HOLD verdict used to
  // get persisted here — a real position sitting well inside its
  // rules for hours looked identical to one that was never checked).
  if (pos.source === 'external') {
    s.updatePositionCheck.run(
      'HOLD', `${eval_.reason} | external: observe_only`, new Date().toISOString(), 'intact', pos.id
    )
    return
  }

  // Live Tweak & Close off for this strategy → no LLM monitor either
  // (its EXIT would close the DB record while the broker still
  // holds) — still stamp the HOLD check, same reasoning as above.
  if (!manageStageAllows(db, getState, pos.strategy)) {
    s.updatePositionCheck.run(
      'HOLD',
      `${eval_.reason} | live_tweak_disabled: ${pos.strategy || 'unlabelled'} is OFF in Live Tweak & Close — broker SL/TP still protect`,
      new Date().toISOString(), 'intact', pos.id
    )
    return
  }

  // Cycle past its soft deadline → deterministic rules already ran above;
  // skip only the LLM read this cycle (broker SL/TP + fast-monitor still
  // protect). A stamped HOLD keeps the UI honest about what happened.
  if (skipLlm()) {
    s.updatePositionCheck.run(
      'HOLD',
      `${eval_.reason} | llm_skipped: cycle past its soft deadline — deterministic rules only this cycle`,
      new Date().toISOString(), 'intact', pos.id
    )
    return
  }

  // Fallback: free-text theses and ambiguous cases → LLM Monitor.
  let check
  try {
    check = await runMonitorCheck(client, {
      symbol: pos.symbol,
      side: pos.side,
      entry: pos.entry_price,
      currentPrice,
      sl: pos.current_sl,
      tp1: pos.current_tp,
      thesis: pos.thesis,
      holdTime: eval_.metrics.minutesInTrade
        ? `${Math.round(eval_.metrics.minutesInTrade)}m`
        : null,
    })
  } catch (err) {
    // Owner (2026-07-27): "I need to be alerted if any of the LLM
    // failed and you still continue" — this used to be silently
    // swallowed by the outer per-position catch below, with no
    // distinction from a DB/broker error. Tracked here specifically
    // so a sustained LLM outage (e.g. an exhausted credit balance)
    // surfaces — trading itself is unaffected: the deterministic
    // rules above already ran, and the broker-side SL/TP still
    // protects the position regardless of whether the LLM answers.
    const health = recordLlmMonitorResult(db, { ok: false, reason: err.message })
    log(`LLM monitor check failed for ${pos.symbol} (streak ${health?.failStreak ?? '?'}):`, err.message)
    if (health && shouldAlert(health.failStreak, health.lastAlertAt)) {
      if (process.env.TELEGRAM_BOT_TOKEN) {
        try {
          const { sendMessage } = await import('./services/telegram.js')
          await sendMessage(`\u{1F6AB} LLM monitor unavailable — ${health.failStreak} consecutive failures. Trading continues (deterministic rules + broker SL/TP unaffected), but position reviews are not getting a fresh LLM read. Last error: ${err.message}`)
        } catch { /* non-fatal */ }
      }
      markAlerted(db)
    }
    return
  }
  recordAnthropicUsage(db, check.usage, 'position_monitor', check.model)
  recordLlmMonitorResult(db, { ok: true })

  s.updatePositionCheck.run(
    check.action,
    check.reasoning,
    new Date().toISOString(),
    check.thesis_status,
    pos.id
  )

  if (check.action === 'EXIT') {
    // D13 (audit F-L7-03): a text-generation judgement call should not be
    // able to close a live position on its own — the thesis text it
    // reasons over is itself partly model-authored and stored, so text
    // that passed through the database could otherwise influence a live
    // exit unchecked. Require a deterministic condition to agree first:
    // reuse the same currentR the deterministic rules already computed
    // this tick (evaluatePosition, above). A position sitting at a clear
    // R-multiple profit has no price-based corroboration for "exit now" —
    // that EXIT becomes advisory only, logged but not executed. A losing
    // or breakeven-or-worse position (currentR <= 0, or unknown because
    // price/risk data is missing) still executes normally: cutting a
    // loser early on a broken thesis is exactly the case an LLM read
    // should be allowed to act on.
    const r = eval_.metrics.currentR
    if (r != null && r > 0) {
      log(`LLM EXIT deferred for ${pos.symbol}: currentR ${r.toFixed(2)} is positive — deterministic gate declined, no broker action taken. ${check.reasoning}`)
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
          'LLM_EXIT_DEFERRED', '/monitor',
          JSON.stringify({
            monitoredId: pos.id, symbol: pos.symbol, currentR: r, reasoning: check.reasoning,
            detail: 'LLM monitor asked for an exit while currentR was positive — deterministic gate declined. Position left ACTIVE and unmanaged by this decision; broker SL/TP still protect.',
          }).slice(0, 2000),
        )
      } catch { /* audit best-effort */ }
      return
    }

    // BUG FIX (owner: "why are 18 positions not being trimmed" — audit
    // found this): this branch used to call s.closePosition.run()
    // directly — a bare DB status flip with NO broker close. The
    // position stayed open and margin-locked at the broker forever
    // while the bot's own bookkeeping said 'closed', so nothing
    // (profit-keeper, trade-guards, this very monitor) ever looked at
    // it again. Route through the same executeBrokerAction the
    // deterministic path uses so the broker position actually closes.
    const outcome = await executeBrokerAction(db, s, pos, { action: 'FULL_EXIT', reason: check.reasoning }, 'llm_monitor')
    if (outcome.error) {
      log(`Position close (LLM) FAILED: ${pos.symbol} — ${outcome.error}`)
    } else if (outcome.skipped) {
      // AUDIT F-L6-02: this used to DB-close on ANY skip reason. The
      // comment said "no broker to close against", but `skipped` also
      // covers no_ctrader_position_id, unknown_volume and
      // account_not_in_registry — cases where a LIVE broker position
      // exists. Flipping the local row to 'closed' there re-created
      // exactly the bug the block above says was fixed: the position
      // survives at the broker with nothing watching it, because every
      // manager reads status='active'.
      //
      // Only the genuinely-no-broker case may close DB-only. Every
      // other skip leaves the row ACTIVE so the next tick retries, and
      // says so loudly rather than quietly.
      if (mayCloseDbOnlyAfterSkip(outcome.reason)) {
        log(`Position close (LLM) intent-only for ${pos.symbol}: ${outcome.reason} — ${check.reasoning}`)
        s.closePosition.run('closed', pos.id) // no broker configured at all — DB-only, as before
      } else {
        log(`Position close (LLM) NOT EXECUTED for ${pos.symbol}: ${outcome.reason} — position left ACTIVE (a broker position may still be open) — ${check.reasoning}`)
        try {
          db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
            'CLOSE_NOT_EXECUTED', '/monitor',
            JSON.stringify({
              monitoredId: pos.id, symbol: pos.symbol, reason: outcome.reason,
              detail: 'LLM monitor asked for an exit; the executor could not reach the broker position. Row left active on purpose — do NOT read this as closed.',
            }).slice(0, 2000),
          )
        } catch { /* audit best-effort */ }
      }
    } else {
      log(`Position closed (LLM): ${pos.symbol} — ${outcome.summary} — ${check.reasoning}`)
    }
  }
}

// Bounded concurrency, mirroring held-prices.js's existing chunk-then-
// Promise.all pattern — the same fix shape applied to the monitor phase's
// per-position LLM calls (see monitorOnePosition's header comment).
export const MONITOR_CONCURRENCY = 4

export async function runMonitorPhase(db, s, positions, currentPriceOf, client, skipLlm = () => false) {
  for (let i = 0; i < positions.length; i += MONITOR_CONCURRENCY) {
    // Progress in the phase label — a stall here now reads "monitoring 22
    // positions (9-12)" instead of a frozen count (incident forensics).
    setState(db, 'loop_phase', `monitoring ${positions.length} positions (${i + 1}-${Math.min(i + MONITOR_CONCURRENCY, positions.length)})`)
    const chunk = positions.slice(i, i + MONITOR_CONCURRENCY)
    await Promise.all(chunk.map(pos =>
      monitorOnePosition(db, s, pos, currentPriceOf(pos), client, skipLlm).catch(err => {
        log(`Monitor check failed for ${pos.symbol}:`, err.message)
      })
    ))
  }
}

// D4b: the weekend-watch phase had the identical serial-per-position-LLM-call
// anti-pattern as the routine monitor phase — same fix, same shape.
export async function monitorOneWeekendPosition(db, s, pos, client) {
  try {
    const check = await runWeekendPositionCheck(client, pos)
    recordAnthropicUsage(db, check.usage || { output_tokens: check.tokens || 0 }, 'weekend_watch', check.model)
    recordLlmMonitorResult(db, { ok: true })
    // Store the full payload (citations, searches_used, watch_events)
    // in last_check_reasoning as JSON so Workshop can render the audit
    // trail — user sees WHICH headlines triggered the call.
    const reasoningPayload = JSON.stringify({
      reasoning: check.reasoning,
      gap_risk: check.gap_risk,
      watch_events: check.watch_events,
      citations: check.citations,
      searches_used: check.searches_used,
      suggested_sl: check.suggested_sl,
      confidence: check.confidence,
    })
    s.updatePositionCheck.run(
      `WEEKEND:${check.action}`,
      reasoningPayload,
      new Date().toISOString(),
      check.thesis_status,
      pos.id
    )
    log(`Weekend ${pos.symbol}: ${check.thesis_status}/${check.gap_risk} — ${check.action} (${check.searches_used} searches, ${check.citations.length} citations)`)

    // Alert user if thesis broke or gap risk is high — include top citation URL
    if ((check.thesis_status === 'broken' || check.gap_risk === 'high') && process.env.TELEGRAM_BOT_TOKEN) {
      try {
        const { sendMessage } = await import('./services/telegram.js')
        const emoji = check.thesis_status === 'broken' ? '⚠️' : '🌊'
        const topCite = check.citations[0]
        const citeLine = topCite?.url ? `\nSource: ${topCite.title || topCite.url}\n${topCite.url}` : ''
        await sendMessage(
          `${emoji} WEEKEND WATCH: ${pos.symbol} ${pos.side} — ${check.thesis_status}/${check.gap_risk} gap\n${check.reasoning}\nAction at open: ${check.action}${citeLine}`
        )
      } catch { /* non-fatal */ }
    }
  } catch (err) {
    const health = recordLlmMonitorResult(db, { ok: false, reason: err.message })
    log(`Weekend check failed for ${pos.symbol} (streak ${health?.failStreak ?? '?'}):`, err.message)
    if (health && shouldAlert(health.failStreak, health.lastAlertAt)) {
      if (process.env.TELEGRAM_BOT_TOKEN) {
        try {
          const { sendMessage } = await import('./services/telegram.js')
          await sendMessage(`\u{1F6AB} LLM monitor unavailable — ${health.failStreak} consecutive failures. Trading continues (deterministic rules + broker SL/TP unaffected). Last error: ${err.message}`)
        } catch { /* non-fatal */ }
      }
      markAlerted(db)
    }
  }
}

export async function runWeekendWatchPhase(db, s, positions, client) {
  for (let i = 0; i < positions.length; i += MONITOR_CONCURRENCY) {
    const chunk = positions.slice(i, i + MONITOR_CONCURRENCY)
    await Promise.all(chunk.map(pos => monitorOneWeekendPosition(db, s, pos, client)))
  }
}

// ---------------------------------------------------------------------------
// Prepared-statement helpers (created once per db)
// ---------------------------------------------------------------------------

let stmts = null

export function prepareStatements(db) {
  if (stmts) return stmts

  stmts = {
    insertScan: db.prepare(`
      INSERT INTO scans (symbol, bias, confidence, thesis, timeframe, session_fit, trade_at, price, trade_grade, desk_note, strategy, scanned_at, loop_id)
      VALUES (@symbol, @bias, @confidence, @thesis, @timeframe, @session_fit, @trade_at, @price, @trade_grade, @desk_note, @strategy, @scanned_at, @loop_id)
    `),

    insertAnalysis: db.prepare(`
      INSERT INTO analyses (symbol, consensus_bias, overall_conviction, consensus_summary, synthesis, entry_price, sl_price, tp1_price, tp2_price, auto_trade, strategy, risk_note, minion_reports, invalidation_trigger, time_cap_minutes, analyzed_at, scan_id)
      VALUES (@symbol, @consensus_bias, @overall_conviction, @consensus_summary, @synthesis, @entry_price, @sl_price, @tp1_price, @tp2_price, @auto_trade, @strategy, @risk_note, @minion_reports, @invalidation_trigger, @time_cap_minutes, @analyzed_at, @scan_id)
    `),

    // Autopilot monitors its own positions + external positions (observe-only).
    // Legacy rows (pre-migration) have NULL source and are treated as autopilot.
    // Copilot/manual trades are excluded — the human owns those decisions.
    selectActivePositions: db.prepare(
      `SELECT * FROM monitored_positions
       WHERE status = ?
         AND COALESCE(paused, 0) = 0
         AND (source IS NULL OR source IN ('autopilot', 'external'))`
    ),

    updatePositionCheck: db.prepare(`
      UPDATE monitored_positions
      SET last_check_action = ?, last_check_reasoning = ?, last_check_at = ?, thesis_status = ?
      WHERE id = ?
    `),

    updatePositionMetrics: db.prepare(`
      UPDATE monitored_positions
      SET mfe_r = ?, mae_r = ?, be_moved = ?, scaled_out = ?
      WHERE id = ?
    `),

    updatePositionSl: db.prepare(`
      UPDATE monitored_positions SET current_sl = ? WHERE id = ?
    `),

    closePosition: db.prepare(
      `UPDATE monitored_positions SET status = ? WHERE id = ?`
    ),

    // Broker-side context for a monitored position: pulls the cTrader
    // position id + current volume (lots) from the trades row linked via
    // trade_id. Legacy monitored_positions (pre trade_id migration) return
    // NULL fields and the executor skips the broker call.
    // account_id rides along so executeBrokerAction manages each position on
    // ITS OWN account and host, not on whichever account is selected globally
    // (audit F-L4-02). The monitored row is the authority; the trade row is the
    // fallback for rows stamped before monitored_positions carried the column.
    selectBrokerContext: db.prepare(`
      SELECT t.ctrader_position_id AS positionId, t.volume AS volumeLots,
             COALESCE(mp.account_id, t.account_id) AS accountId
      FROM monitored_positions mp
      LEFT JOIN trades t ON t.id = mp.trade_id
      WHERE mp.id = ?
    `),

    reduceTradeVolume: db.prepare(`
      UPDATE trades SET volume = ? WHERE id = ?
    `),

    latestScanForSymbol: db.prepare(`
      SELECT id FROM scans WHERE symbol = ? ORDER BY scanned_at DESC LIMIT 1
    `),
  }

  return stmts
}

// ---------------------------------------------------------------------------
// Core loop iteration
// ---------------------------------------------------------------------------

async function runLoop(db) {
  // Owner's travel console — handle /status /pause /resume /killall from
  // Telegram BEFORE any phase runs, so a pause lands this cycle, not next.
  try {
    const { pollTelegramCommands } = await import('./services/telegram-control.js')
    const { getCtraderCreds } = await import('./lib/ctrader-creds.js')
    const { cancelOrder } = await import('./lib/exec-engine.js')
    await pollTelegramCommands(db, { cancelOrder, creds: getCtraderCreds(db) })
  } catch { /* telegram trouble must never stall trading */ }
  // ---- Mutex: prevent overlapping iterations ----
  if (loopRunning) {
    log('Loop still running — skipping this tick')
    setTimeout(() => runLoop(db).catch(err => console.error('[loop] unhandled:', err.message)), loopIntervalMs(db))
    return
  }

  // ---- Circuit breaker: hard stop after too many consecutive failures ----
  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    const tripped = getState(db, 'circuit_breaker_tripped_at')
    if (!tripped) {
      setState(db, 'circuit_breaker_tripped_at', new Date().toISOString())
      log(`CIRCUIT BREAKER TRIPPED — ${consecutiveErrors} consecutive errors. Loop halted.`)
      if (process.env.TELEGRAM_BOT_TOKEN) {
        try {
          const { sendMessage } = await import('./services/telegram.js')
          await sendMessage(`🔴 CIRCUIT BREAKER: Agent loop halted after ${consecutiveErrors} consecutive errors. Manual reset required via POST /actions/reset-breaker`)
        } catch { /* non-fatal */ }
      }
    }
    setTimeout(() => runLoop(db).catch(err => console.error('[loop] unhandled:', err.message)), CIRCUIT_BREAKER_RESET_MS)
    return
  }

  loopRunning = true
  loopCount++
  lastLoopActivityAt = Date.now()
  const start = Date.now()
  // Cycle soft deadline (incident 2026-07-28, third fix of the night: the
  // per-sub-phase budgets each held, but under a SYSTEMIC slowdown — every
  // broker/LLM call slow at once — their SUM (6×90s + 2×180s + scan +
  // monitor) still crossed the 12-min watchdog, so cycles never completed
  // and loopCount sat frozen while the watchdog crash-looped the process.
  // Past this deadline the cycle sheds load instead of dying: optional
  // management sub-phases are skipped outright, the monitor phase drops to
  // deterministic-rules-only (no LLM reads — broker SL/TP and fast-monitor
  // still protect), and the cycle COMPLETES. A degraded finished cycle
  // beats a perfect one the watchdog never lets finish.)
  const CYCLE_SOFT_DEADLINE_MS = Math.max(120_000, Number(process.env.CYCLE_SOFT_DEADLINE_MS || 7 * 60_000))
  const cycleOverBudget = () => Date.now() - start > CYCLE_SOFT_DEADLINE_MS
  console.log(`[diag] LOOP #${loopCount} start`)

  // -------------------------------------------------------------------------
  // Phase accounting (2026-07-28). `loop_phase` was being stamped 'monitoring
  // N positions' and then not re-stamped until 'sleeping' at the very end of
  // the cycle — so the four breakers, the whole QUANT block and the 8-hourly
  // retention DELETEs all reported as "monitoring". Every read-stall report
  // therefore blamed the monitor phase for a window it barely occupies, and
  // the tuning that followed was aimed at the wrong code.
  //
  // phase() replaces the bare setState so each sub-phase both NAMES itself and
  // records how long the previous one took. `loop_phase_ms_json` then carries
  // the per-cycle breakdown, which is what makes "reads stall for 8-29s"
  // answerable instead of arguable.
  // -------------------------------------------------------------------------
  // Alongside wall-clock, each phase records its EVENT-LOOP DELAY — how long a
  // callback that was ready to run had to wait. Wall-clock alone cannot tell a
  // phase that spends 60s waiting on the broker (event loop free, HTTP fine)
  // from one that spends 60s in thousands of small CPU bursts (HTTP starved).
  // Those two need opposite fixes. See services/event-loop-lag.js.
  // Idempotent — covers contexts that run the loop without agent/index.js
  // (tests, scripts), so a phase never reports lag of "unknown" for want of a
  // monitor nobody started.
  startLagMonitor()
  const phaseMs = {}
  const phaseLag = {}
  let phaseName = 'starting'
  let phaseStart = start
  // `key` keeps the ms buckets stable when the visible label carries data —
  // 'analyzing EURUSD, XAUUSD' must not become its own bucket every cycle.
  // Where the profile summaries land. Keyed by phase so arming two phases at
  // once doesn't have them overwrite each other, and merged on every arrival
  // because the inspector hands results back asynchronously — possibly after
  // closePhases() has already run.
  const cpuProfiles = {}
  const takeProfile = (summary) => {
    cpuProfiles[summary.phase] = summary
    try { setState(db, 'loop_cpu_profile_json', JSON.stringify(cpuProfiles)) } catch { /* diagnostics are best-effort */ }
  }
  const phase = (name, key = name) => {
    const now = Date.now()
    phaseMs[phaseName] = (phaseMs[phaseName] || 0) + (now - phaseStart)
    const lag = sampleLag()
    if (lag) phaseLag[phaseName] = lag
    // Profile boundaries ride on the phase boundaries, so an armed phase is
    // sampled over exactly the window its wall-clock and lag numbers describe.
    stopPhaseProfile(takeProfile)
    phaseName = key
    phaseStart = now
    setState(db, 'loop_phase', name)
    startPhaseProfile(key)
  }
  const closePhases = () => {
    phaseMs[phaseName] = (phaseMs[phaseName] || 0) + (Date.now() - phaseStart)
    const lag = sampleLag()
    if (lag) phaseLag[phaseName] = lag
    stopPhaseProfile(takeProfile)
    // Slowest first — the answer to "what is holding the loop" should be the
    // first thing read, not something to scan a list for.
    const ordered = Object.entries(phaseMs)
      .filter(([, ms]) => ms >= 1)
      .sort((a, b) => b[1] - a[1])
    setState(db, 'loop_phase_ms_json', JSON.stringify(Object.fromEntries(ordered)))
    // Worst-blocking first, for the same reason.
    const byLag = Object.entries(phaseLag)
      .filter(([, l]) => l.maxMs != null)
      .sort((a, b) => b[1].maxMs - a[1].maxMs)
    setState(db, 'loop_phase_lag_json', JSON.stringify(Object.fromEntries(byLag)))
  }

  setState(db, 'loop_phase', 'starting')
  setState(db, 'loop_started_at', new Date().toISOString())

  // Keep the OAuth access token alive (daily proactive refresh; no-op if no
  // refresh token or refreshed recently — never blocks or throws).
  try {
    const { maybeRefreshCtraderToken } = await import('./lib/ctrader-auth.js')
    await maybeRefreshCtraderToken(db, log)
  } catch { /* auth module optional */ }

  // Reset daily error counter at midnight UTC
  const lastReset = getState(db, 'errors_reset_date')
  const todayUTC = new Date().toISOString().slice(0, 10)
  if (lastReset !== todayUTC) {
    // Deliberately does NOT clear the recent-errors ring: the counter is a
    // daily figure, the ring is forensic history. Every ring entry carries its
    // own timestamp, so yesterday's causes sitting beside errorsToday: 0 reads
    // correctly — and losing them at midnight is exactly how a failure that
    // started at 23:50 becomes unexplainable.
    setState(db, 'errors_today', '0')
    setState(db, 'daily_tokens_used', '0')
    setState(db, 'errors_reset_date', todayUTC)
  }

  try {
    const s = prepareStatements(db)

    // -----------------------------------------------------------------------
    // 0. RECONCILE PHASE — every 3rd loop (~15 min)
    //
    // Runs BEFORE scan/autoTrade, not after. Owner hit this live: a manual
    // NatGas LONG opened at 07:38 PM, then the bot opened a NatGas SHORT at
    // 08:02 PM in the very next loop — risk.js's `duplicate_symbol` veto (any
    // active row on the symbol blocks a new proposal, regardless of side)
    // WOULD have caught it, but only sees `monitored_positions`, which a
    // manual position only enters via this reconcile phase. With reconcile
    // running after the scan/dispatch phase in the same tick, a manual
    // position could sit unreconciled through one whole extra loop before the
    // veto could ever see it. Reconciling first closes that gap to "worst
    // case one reconcile cycle" instead of "one reconcile cycle plus one
    // scan/dispatch ordering".
    // -----------------------------------------------------------------------
    if (loopCount % 3 === 0) {
      try {
        const clientId = ctraderEnv('clientId')
        const clientSecret = ctraderEnv('clientSecret')
        const accessToken = getState(db, 'ctrader_access_token')
        const accountId = getState(db, 'ctrader_account_id')
        const isLive = getState(db, 'ctrader_is_live') === 'true'

        if (clientId && clientSecret && accessToken && accountId) {
          phase('reconciling broker positions')
          const host = isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
          const reconcileData = await execReconcile({ host, clientId, clientSecret, accessToken, accountId })

          const allSymbolIds = [...new Set([
            ...(reconcileData.position || []).map(p => p.tradeData?.symbolId),
            ...(reconcileData.order || []).map(o => o.tradeData?.symbolId),
          ].filter(Boolean))]

          // Names come from the LIGHT symbols list — SYMBOL_BY_ID returns the
          // full record, which has no symbolName field.
          let symbolNameMap = {}
          if (allSymbolIds.length > 0) {
            const symData = await wsGetSymbolsList(host, clientId, clientSecret, accessToken, accountId)
            for (const s2 of (symData.symbol || [])) {
              symbolNameMap[s2.symbolId] = s2.symbolName
            }
          }

          const positions = (reconcileData.position || []).map(p => ({
            ...p,
            symbolName: symbolNameMap[p.tradeData?.symbolId] || null,
          }))
          const orders = (reconcileData.order || []).map(o => ({
            ...o,
            symbolName: symbolNameMap[o.tradeData?.symbolId] || null,
          }))

          const result = reconcilePositions(db, positions, orders, (k, v) => setState(db, k, v))
          setState(db, 'api_ctrader_last_ok', new Date().toISOString())

          // PROTECTION AUDIT (owner report 2026-07-29). Every other stop guard
          // in this system fires at the MOMENT OF ACTION — risk.js refuses to
          // open without a bracket, manual-position-guards refuses to add to a
          // naked one. Nothing asked, of the positions already open, whether
          // they are STILL protected. A bracket can go missing after entry: a
          // failed amend, a broker-side cancellation, a position adopted from
          // the broker that never had one. The ETHUSD short that prompted this
          // ran unprotected and the ledger called it "stopped beyond the SL".
          //
          // Runs here because broker truth is already in hand — no extra
          // broker calls — and it reads the BROKER's stop, not ours, because
          // our own record only proves what we believe.
          try {
            const { runProtectionAudit } = await import('./services/naked-position-guard.js')
            // ctrader_position_id lives on TRADES, not monitored_positions.
            // The original query selected it straight off monitored_positions
            // and threw `no such column` on every single pass — so the
            // protection audit has never once run since it shipped in #476,
            // and the panel's "idle" was that crash, not a resting state.
            // Found 2026-07-29 02:51 only because ¶D·2's failed-beat put the
            // message somewhere a human could read it.
            // SCOPED TO THIS ACCOUNT. `positions` is the broker snapshot for
            // `accountId` alone, so auditing every account's rows against it
            // marks all the others `unmatched` — checked but never verified.
            // Staging showed exactly that on 2026-07-29: 4 open positions on
            // 46130058 audited against 43097342's snapshot, 4 unmatched, and
            // the panel said "all protected". Other accounts are audited in
            // the per-account reconcile pass below, against their own truth.
            const openRows = db.prepare(
              `SELECT mp.id, mp.trade_id, mp.symbol, mp.current_sl, mp.account_id, mp.source,
                      t.ctrader_position_id
                 FROM monitored_positions mp
                 LEFT JOIN trades t ON t.id = mp.trade_id
                WHERE mp.status = 'active' AND t.ctrader_position_id IS NOT NULL
                  AND (mp.account_id = ? OR mp.account_id IS NULL)`
            ).all(String(accountId))
            const brokerSl = positions.map(p => ({
              positionId: p.positionId,
              stopLoss: p.stopLoss ?? null,
              takeProfit: p.takeProfit ?? null,
            }))
            let notify = null
            if (process.env.TELEGRAM_BOT_TOKEN) {
              notify = (await import('./services/telegram.js')).sendMessage
            }
            const { makeTargetSuggester } = await import('./services/tp-suggest.js')
            const prot = await runProtectionAudit(db, openRows, brokerSl, {
              sendMessage: notify,
              suggestTarget: makeTargetSuggester(db, { host, clientId, clientSecret, accessToken, accountId }, positions),
            })
            if (prot.naked.length || prot.phantom.length || prot.targetless.length) {
              log(`PROTECTION AUDIT: ${prot.naked.length} position(s) with NO stop at the broker, ${prot.targetless.length} with NO take profit, ${prot.phantom.length} stop disagreement(s) — see action_log /protection-audit`)
            }
            const { beat: beatProt } = await import('./services/heartbeat.js')
            beatProt(db, 'protection_audit')
          } catch (err) {
            log('Protection audit failed (non-fatal):', err.message)
            // ¶D·2 covered the WRONG failure mode. It handled "reconcile threw"
            // and "no credentials", but not "the audit block itself threw" —
            // which left this catch logging and moving on WITHOUT a beat, so
            // the controller sat at `idle` (runs=0) exactly as the owner
            // originally reported. Found on staging 2026-07-29 02:33 with the
            // fix already deployed: protection_audit still idle, runs=0.
            //
            // A not-beat is silence. Beat it as FAILED so a throw in here is a
            // visible STALLED/failing controller instead of a resting one.
            await noteProtectionAuditBlocked(db, `protection audit threw: ${err.message}`)
          }
          if ((result.orphansClosed || []).length > 0) {
            log(`Reconcile: closed ${result.orphansClosed.length} stale open trade(s) whose broker position is gone (ledger drift cleanup)`)
          }
          if ((result.dupsClosed || []).length > 0) {
            log(`Reconcile: closed ${result.dupsClosed.length} DUPLICATE open trade(s) sharing a broker position (re-adoption leak cleanup)`)
          }
          if ((result.relinked || []).length > 0) {
            log(`Reconcile: re-linked ${result.relinked.length} position(s) to their existing trade instead of duplicating (leak prevented)`)
          }
          if ((result.ordersGone || []).length > 0) {
            log(`Reconcile: ${result.ordersGone.length} resting order(s) left the book (filled or cancelled) — the monitor adopts any resulting position`)
          }
          // Trigger-monitor controller: the broker_orders ledger was just synced
          // and fills detected (reconcilePositions → syncBrokerOrders). Beat it
          // so the stall watchdog covers order-fill tracking independently of
          // the placement controller (pending_orders).
          await hbeat(db, 'order_monitor')

          // Broker resting-order cleanup (owner-approved build 2, 2026-07-27:
          // "i see duplication" — 82 resting orders fed a margin call). The
          // sweep previously existed only behind a manual HTTP route and only
          // recognised pending-fib labels, so pending-closed orphans and
          // ledger-desynced duplicates accumulated at the broker forever.
          // Runs here every reconcile pass on the order snapshot fetched
          // above — no second reconcile round-trip. Best-effort.
          try {
            const { reconcileBrokerPendingOrders } = await import('./services/pending-orders.js')
            const sw = await reconcileBrokerPendingOrders(db, { host, clientId, clientSecret, accessToken, accountId }, { brokerOrders: reconcileData.order || [] })
            if (sw.cancelled.length > 0) {
              log(`Broker order cleanup: cancelled ${sw.cancelled.length} stale/duplicate bot order(s) (${sw.kept} kept, ${sw.manual} manual untouched)`)
            }
          } catch (err) {
            log(`Broker order cleanup failed (non-fatal): ${err.message}`)
          }

          // Un-blind the safety brakes: a position closed at the BROKER (a
          // resting SL/TP fill — the normal stop-out) was marked closed with
          // net_pnl NULL, invisible to the daily cap, equity stop, loss-streak
          // cooldown, and the performance breaker until a human opened the
          // dashboard. Backfill broker-true realized P&L here, in the loop, so
          // every downstream brake this cycle sees the real drawdown. Runs
          // whenever ANY reconcile path closed a trade this cycle — not just
          // closedDetected. The orphan sweep and dedup sweep (reconciler.js)
          // also close trades with net_pnl left NULL but never populate
          // closedDetected, so a trade closed only via those two paths could
          // never trigger this backfill and sat permanently excluded from
          // Edge Health (alpha-decay.js's `net_pnl IS NOT NULL` read) — not a
          // transient gap, a silent one. backfillClosedPnl self-gates on its
          // own COUNT(*) check, so widening the trigger here adds no
          // unnecessary broker calls. Best-effort (a deal-history hiccup must
          // never stall the loop).
          try {
            const { backfillClosedPnl, shouldRunPnlBackfill, dueForBackfill, noteBackfillAttempt } =
              await import('./services/pnl-backfill.js')
            // TRIGGER ON A GAP, NOT ON A DETECTED CLOSE (2026-07-29).
            //
            // shouldRunPnlBackfill reads the reconcile result, and that
            // reconcile runs ONCE for the SELECTED account (see the single
            // reconcilePositions call above) — so a position closing on any
            // other account never reaches it. Measured on the M4 soak: Cocoa
            // closed 12:14:30Z on 46130058 while 43097342 was selected, and
            // none of the eight closed trades gained a net_pnl. Fixing the
            // fetch (#494) was not enough while the trigger above it was
            // still single-account.
            //
            // "Is any closed trade missing its money?" is a question about our
            // own database. It cannot be wrong about which account it asks.
            // A detected close still forces an immediate attempt, so a fresh
            // stop-out is filled the same cycle instead of waiting on pacing.
            const closeSeen = shouldRunPnlBackfill(result)
            {
              // Cheap pre-check so the log can tell "nothing was missing"
              // apart from "something was missing and still is after this
              // attempt" — those two are otherwise indistinguishable from
              // bf.backfilled === 0 alone, and the second one is exactly the
              // stuck-trade case that must stay visible in logs, not silent.
              const gapBefore = db.prepare(
                `SELECT COUNT(*) AS n FROM trades WHERE status = 'closed' AND net_pnl IS NULL`
              ).get()?.n || 0

              // EVERY ENABLED ACCOUNT ON THIS SIDE, not just the selected one.
              // This ran single-account until 2026-07-29: it counted the gap
              // across all accounts, then asked ONE account's deal history to
              // fill it. On the M4 soak that meant seven closed trades on
              // 46130058 while the selected account was 43097342 — nothing
              // matched, and the log blamed "deal-history coverage" every
              // cycle when the coverage was fine.
              //
              // It is a safety gap, not a reporting one: the daily-loss veto,
              // equity stop, loss-streak cooldown, performance breaker and
              // Kelly veto all key on realised P&L, so on every account except
              // the selected one they were blind to broker-side stop-outs —
              // exactly the losers that close at the broker.
              let targets = [String(accountId)]
              try {
                const { getEnabledAccounts } = await import('./services/account-registry.js')
                const same = getEnabledAccounts(db)
                  .filter(a => (a.is_live === 1) === isLive)
                  .map(a => String(a.account_id))
                if (same.length) targets = [...new Set([String(accountId), ...same])]
              } catch { /* registry unavailable — selected account only, as before */ }

              // NO SIDECAR-ROSTER GATE HERE — deliberately removed 2026-07-31.
              //
              // The gate (added with the other roster gates on 2026-07-30)
              // skipped every account the sidecar hadn't authorized, on the
              // theory that "a disconnected account's fetch can only time
              // out". That theory was wrong for THIS call: backfillClosedPnl
              // fetches deal history over the Node WS path (wsGetDeals) with
              // the OAuth token, which authorizes ANY account under the cTID
              // on its own ephemeral connection — the sidecar's session is
              // not involved at all.
              //
              // Measured on production 2026-07-31: "P&L backfill: skipping 1
              // account(s) not in the sidecar's authorized roster [47790949]
              // … trying 1/1 account(s) [46130058] — 93 closed trade(s)
              // still missing net_pnl". Rows on the skipped accounts could
              // NEVER fill, so the unknown-P&L veto held the desk for three
              // days straight. The roster gates on DISPATCH and RECONCILE
              // (which do run through the sidecar) are untouched.

              let filled = 0
              let skipped = 0
              for (const acct of targets) {
                // Pacing only ever delays an account whose gap did NOT fill
                // last time — a permanently unfillable row (closing deal
                // older than the deal-history window) would otherwise buy a
                // broker fetch per account every cycle, forever.
                if (!closeSeen && !dueForBackfill(acct)) { skipped++; continue }
                try {
                  const creds = { host, clientId, clientSecret, accessToken, accountId: acct }
                  const bf = await backfillClosedPnl(db, creds, { accountId: acct })
                  noteBackfillAttempt(acct, bf)
                  if (bf.backfilled > 0) {
                    filled += bf.backfilled
                    log(`P&L backfill [${acct}]: filled ${bf.backfilled} broker-closed trade(s) with realized P&L`)
                  }
                } catch (e) {
                  log(`P&L backfill [${acct}] failed (non-fatal): ${e.message}`)
                }
              }

              if (filled === 0) {
                if (gapBefore === 0) {
                  log('P&L backfill: no gap this cycle — every closed trade already has realized P&L')
                } else {
                  log(`P&L backfill: ${gapBefore} closed trade(s) still missing net_pnl after trying ${targets.length - skipped}/${targets.length} account(s) [${targets.join(', ')}]${skipped ? `, ${skipped} paced off` : ''} — deal history had no matching close`)
                }
              }
            }
          } catch (err) {
            log(`P&L backfill failed (non-fatal): ${err.message}`)
          }

          // Post-loss playback — classify what the market did after each
          // losing trade (stop_hunt / thesis_wrong / chop) and store the
          // replay bars, so losses become data instead of just damage
          // (owner: "playback after each loss to understand what the market
          // is happening"). Best-effort; capped per cycle.
          try {
            const { runLossPostmortems } = await import('./services/loss-postmortem.js')
            const symbolMap2 = JSON.parse(getState(db, 'symbol_id_map') || '{}')
            const pmFetch = async (sym, tf, count, endTimeMs) => {
              const sid = symbolMap2[String(sym).toUpperCase()]
              if (!sid) throw new Error(`symbolId unknown for ${sym}`)
              // endTime anchors old trades' windows at their own close so the
              // 90-day history back-fill sees the right bars, not today's.
              const byTf = await wsGetTrendbarsBatch(host, clientId, clientSecret, accessToken, accountId, sid, [tf], count, 20_000, endTimeMs || 0)
              return byTf[tf] || []
            }
            const pm = await runLossPostmortems(db, pmFetch)
            if (pm.classified > 0) {
              log(`Trade lessons: classified ${pm.classified} closed trade(s) — see the Desk Trade lessons`)
              // Close the learning loop: recompute the evidence-driven SL-widen
              // factors whenever new lessons land (self-clearing when the
              // stop-hunt pattern stops).
              const { refreshLessonTuning } = await import('./services/lessons-tuner.js')
              const factors = refreshLessonTuning(db)
              const keys = Object.keys(factors)
              if (keys.length) log(`Lesson tuner ACTIVE: ${keys.map(k => `${k} SL×${factors[k].factor} (${factors[k].evidence})`).join(' · ')}`)
            }
          } catch (err) {
            log(`Trade lessons sweep failed (non-fatal): ${err.message}`)
          }

          // Close-completeness sweep — a closed trade that never got a P&L
          // backfill AND/OR a postmortem is otherwise invisible forever
          // (confirmed gap: loss-postmortem.js's own query excludes a row
          // with BOTH net_pnl and exit_price still null). Periodic, not
          // every cycle — this is a slow-moving completeness check, not a
          // live safety brake.
          if (loopCount % 12 === 0) {
            try {
              const { runCloseCompletenessSweep } = await import('./services/close-completeness.js')
              const cc = await runCloseCompletenessSweep(db)
              if (cc.flagged > 0) log(`Close-completeness: ${cc.flagged} closed trade(s) still missing P&L and/or a postmortem`)
            } catch (err) {
              log(`Close-completeness sweep failed (non-fatal): ${err.message}`)
            }
          }

          // Proving sweep — an ARMED strategy with no backtest GO on record
          // gets a real backtest queued (one per day, one at a time) so
          // "ARMED but unproven" advisories resolve themselves with evidence.
          try {
            const { runProvingSweep } = await import('./services/proving-sweep.js')
            const pv = await runProvingSweep(db)
            if (pv.queued) log(`Proving sweep: queued GO backtest for armed-but-unproven '${pv.queued}'`)
          } catch (err) {
            log(`Proving sweep failed (non-fatal): ${err.message}`)
          }

          // Weekend bank — inside the last window before a LONG closure
          // (weekend/holiday), close any position in profit, bot or owner:
          // floating profit held through a closure is gap risk, and the
          // owner is often asleep at these hours (owner order 2026-07-20).
          try {
            const { runWeekendBank } = await import('./services/weekend-bank.js')
            const wb = await runWeekendBank(db, { host, clientId, clientSecret, accessToken, accountId }, positions)
            if (wb.banked?.length) log(`Weekend bank: closed ${wb.banked.map(b => `${b.symbol} +${b.movePct}%`).join(', ')} ahead of the long closure`)
            await hbeat(db, 'weekend_bank', true)
          } catch (err) {
            log(`Weekend bank check failed: ${err.message}`)
            await hbeat(db, 'weekend_bank', false, err.message)
          }

          // Weekend loss flag — same window, but for LOSING positions.
          // Deliberately never closes anything (weekend-bank.js's own
          // reasoning against selling losers into a thin pre-close market
          // still holds); this only makes them visible — action_log +
          // Telegram — so the owner can decide manually before the close.
          try {
            const { runWeekendLossFlag } = await import('./services/weekend-loss-flag.js')
            const wl = await runWeekendLossFlag(db, { host, clientId, clientSecret, accessToken, accountId }, positions)
            if (wl.flagged?.length) log(`Weekend loss flag: ${wl.flagged.map(f => `${f.symbol} ${f.movePct}%`).join(', ')} ahead of the long closure — left open, owner notified`)
            await hbeat(db, 'weekend_loss_flag', true)
          } catch (err) {
            log(`Weekend loss flag check failed: ${err.message}`)
            await hbeat(db, 'weekend_loss_flag', false, err.message)
          }
          log(`Reconcile: ${result.newExternal.length} new external, ${result.closedDetected.length} closed detected, ${(result.manualChanges || []).length} manual change(s), ${result.pendingOrders.length} pending orders`)

          // Ledger resyncs are bookkeeping, not tampering — logged, never
          // alerted. Named per position on purpose: a row that keeps needing
          // a resync means something is writing a stop the broker rejects,
          // and that is worth seeing rather than silently smoothing over.
          for (const ls of result.ledgerSynced || []) {
            log(`Ledger resync: ${ls.symbol} position ${ls.positionId} ${ls.kind === 'sl_resync' ? 'stop loss' : 'take profit'} ${ls.from ?? '—'} → ${ls.to ?? '—'} (our record had drifted from broker truth)`)
            try {
              db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
                'LEDGER_RESYNC', '/reconcile', JSON.stringify(ls).slice(0, 2000))
            } catch { /* audit best-effort */ }
          }

          // Tamper watch — the owner changed a bot-tracked position in the
          // cTrader app (reverse / volume / SL / TP). Alert loudly, audit it,
          // and let the monitor manage the adopted broker truth.
          for (const mc of result.manualChanges || []) {
            // Re-strategize: verify the changed trade against the market and
            // recalibrate (reversal → fresh ATR-based SL/TP amended at the
            // broker; volume/level edits → risk audit). Never fatal.
            let outcome = null
            let tail = ''
            try {
              const rs = await import('./services/restrategize.js')
              outcome = await rs.restrategizeAfterTamper(db, { host, clientId, clientSecret, accessToken, accountId }, mc)
              tail = rs.summarize(outcome)
            } catch { /* verdict optional */ }
            const text = mc.kind === 'reversed'
              ? `⚠️ MANUAL CHANGE: ${mc.symbol} position ${mc.positionId} was REVERSED at the broker (${mc.from}→${mc.to}). Original thesis no longer applies.${tail}`
              : mc.kind === 'volume'
                ? `⚠️ MANUAL CHANGE: ${mc.symbol} position ${mc.positionId} volume changed at the broker (${mc.from}→${mc.to} units) outside the bot.${tail}`
                : `⚠️ MANUAL CHANGE: ${mc.symbol} position ${mc.positionId} ${mc.kind === 'sl_moved' ? 'stop loss' : 'take profit'} moved at the broker (${mc.from ?? '—'}→${mc.to ?? '—'}) outside the bot. Adopted as the managed level.${tail}`
            log(text)
            try {
              db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
                .run('TAMPER', '/reconcile', JSON.stringify({ ...mc, outcome }).slice(0, 2000))
            } catch { /* audit best-effort */ }
            try {
              const { notifyOwner } = await import('./services/telegram-control.js')
              await notifyOwner(text)
            } catch { /* non-fatal */ }
          }

          // Refresh the real account balance so risk sizing tracks equity as
          // trades close (linking set it once; this keeps it live). M1c: the
          // same values are stamped under acct:<id>: keys so per-account
          // guard reads resolve the RIGHT equity once multiple accounts run.
          try {
            const { wsGetTrader, traderBalance } = await import('./lib/ctrader-ws.js')
            const trader = await wsGetTrader(host, clientId, clientSecret, accessToken, accountId)
            const bal = traderBalance(trader)
            if (bal != null) {
              setState(db, 'account_balance_usd', String(bal))
              setAccountState(db, accountId, 'account_balance_usd', String(bal))
            }
            if (trader?.leverageInCents > 0) {
              setAccountState(db, accountId, 'account_leverage', String(trader.leverageInCents / 100))
            }
          } catch { /* best effort */ }

          if (result.newExternal.length > 0 && process.env.TELEGRAM_BOT_TOKEN) {
            try {
              const { sendMessage } = await import('./services/telegram.js')
              for (const ext of result.newExternal) {
                await sendMessage(`External position detected: ${ext.side} ${ext.symbol} @ ${ext.entry}`)
              }
            } catch { /* non-fatal */ }
          }

          // ---- M2: reconcile every OTHER enabled same-side account --------
          // The registry's enabled roster (minus the selected primary, minus
          // cross-side accounts — a demo account never rides the live
          // session). Each account's snapshot reconciles with account-scoped
          // sweeps (reconciler opts.accountId), so one account's truth can
          // never close another's rows; its state keys land under the
          // acct:<id>: namespace. Best-effort per account — one broken
          // account must not take down the others' reconciliation.
          try {
            const { getEnabledAccounts, setAccountState } = await import('./services/account-registry.js')
            let others = getEnabledAccounts(db).filter(a =>
              String(a.account_id) !== String(accountId) && (a.is_live === 1) === isLive)
            // Gate on the sidecar's authorized roster: an enabled account the
            // broker session has NOT authorized (auth refused, dropped, or the
            // owner unticked it in cTrader) cannot be reconciled — probing it
            // buys a timeout per account per cycle and nothing else. Roster
            // null = unknown → probe all, exactly as before this gate.
            try {
              const { sidecarRoster } = await import('./lib/exec-engine.js')
              const roster = await sidecarRoster()
              if (roster) {
                const off = others.filter(a => !roster.includes(String(a.account_id)))
                if (off.length) {
                  others = others.filter(a => roster.includes(String(a.account_id)))
                  log(`Reconcile: skipping ${off.length} enabled account(s) not in the sidecar's authorized roster [${off.map(a => a.account_id).join(', ')}]`)
                  try {
                    const { recordDecision } = await import('./services/decision-log.js')
                    for (const a of off) {
                      recordDecision(db, {
                        accountId: String(a.account_id), stage: 'account_probe', decision: 'skip',
                        reason: 'enabled in registry but not in the sidecar authorized roster — reconcile sweep skipped until it reconnects',
                      })
                    }
                  } catch { /* decision log is best-effort */ }
                }
              }
            } catch { /* roster probe failed — probe all, as before */ }
            for (const acc of others) {
              try {
                const rd = await execReconcile({ host, clientId, clientSecret, accessToken, accountId: acc.account_id })
                // The primary pass only fetched the symbol-name list when IT
                // had positions — fetch on demand if this account has rows
                // the map can't name.
                const needsNames = [...(rd.position || []), ...(rd.order || [])]
                  .some(x => x.tradeData?.symbolId && !symbolNameMap[x.tradeData.symbolId])
                if (needsNames) {
                  try {
                    const symData = await wsGetSymbolsList(host, clientId, clientSecret, accessToken, acc.account_id)
                    for (const s2 of (symData.symbol || [])) symbolNameMap[s2.symbolId] = s2.symbolName
                  } catch { /* names degrade to ID:x */ }
                }
                const pos2 = (rd.position || []).map(p => ({ ...p, symbolName: symbolNameMap[p.tradeData?.symbolId] || null }))
                const ord2 = (rd.order || []).map(o => ({ ...o, symbolName: symbolNameMap[o.tradeData?.symbolId] || null }))
                const r2 = reconcilePositions(db, pos2, ord2,
                  (k, v) => setAccountState(db, acc.account_id, k, v),
                  { accountId: acc.account_id })
                log(`Reconcile[${acc.account_id}]: ${r2.newExternal.length} new external, ${r2.closedDetected.length} closed, ${(r2.orphansClosed || []).length} orphan(s)`)

                // Audit THIS account against ITS OWN broker truth. Without
                // this, every position on a non-primary account is `unmatched`
                // — counted as checked and never actually verified. On staging
                // that meant all four live positions, i.e. the whole book.
                try {
                  const { runProtectionAudit } = await import('./services/naked-position-guard.js')
                  const rows2 = db.prepare(
                    `SELECT mp.id, mp.trade_id, mp.symbol, mp.current_sl, mp.account_id, mp.source,
                            t.ctrader_position_id
                       FROM monitored_positions mp
                       LEFT JOIN trades t ON t.id = mp.trade_id
                      WHERE mp.status = 'active' AND t.ctrader_position_id IS NOT NULL
                        AND mp.account_id = ?`
                  ).all(String(acc.account_id))
                  if (rows2.length) {
                    const bp2 = pos2.map(p => ({
                      positionId: p.positionId,
                      stopLoss: p.stopLoss ?? null,
                      takeProfit: p.takeProfit ?? null,
                    }))
                    let notify2 = null
                    if (process.env.TELEGRAM_BOT_TOKEN) notify2 = (await import('./services/telegram.js')).sendMessage
                    const { makeTargetSuggester: mkSuggest2 } = await import('./services/tp-suggest.js')
                    const p2 = await runProtectionAudit(db, rows2, bp2, {
                      sendMessage: notify2, accountId: acc.account_id,
                      // Same creds shape the suggester's bar fetch needs, scoped
                      // to THIS account — the pass's own snapshot, own truth.
                      suggestTarget: mkSuggest2(db, { host, clientId, clientSecret, accessToken, accountId: acc.account_id }, pos2),
                    })
                    if (p2.naked.length || p2.targetless.length || p2.phantom.length) {
                      log(`PROTECTION AUDIT[${acc.account_id}]: ${p2.naked.length} with NO stop, ${p2.targetless.length} with no take profit, ${p2.phantom.length} disagreement(s)`)
                    }
                  }
                } catch (e2) {
                  log(`Protection audit[${acc.account_id}] failed (non-fatal): ${e2.message}`)
                }
              } catch (e) {
                log(`Reconcile[${acc.account_id}] failed (non-fatal): ${e.message}`)
              }
            }
          } catch { /* registry optional on old DBs */ }
        } else {
          // No credentials — the audit cannot run, and saying nothing would
          // read on screen as "checked, all clear". ¶D·2.
          await noteProtectionAuditBlocked(db, 'broker credentials not configured')
        }
      } catch (err) {
        log('Reconcile phase error:', err.message)
        // The 2026-07-29 case: the broker was unreachable, so the protection
        // audit never ran and the panel read "idle". Record the gap so the
        // last known state can be reported WITH the fact that it is no longer
        // being confirmed, instead of a blank.
        await noteProtectionAuditBlocked(db, `reconcile failed: ${err.message}`)
      }
    }

    // -----------------------------------------------------------------------
    // 1. SCAN PHASE — scan all enabled symbols
    // -----------------------------------------------------------------------
    // Keep the economic-calendar cache warm for the news-window gate (6h
    // TTL server-side; this is a no-op most cycles and NEVER blocks — the
    // gate itself only ever reads the cache synchronously).
    try {
      const { refreshNewsCalendar } = await import('./services/news-calendar.js')
      await refreshNewsCalendar(db)
    } catch { /* no data = no gate */ }

    const scanEnabled = getState(db, 'scan_enabled') !== 'false'
    const analyzeEnabled = getState(db, 'analyze_enabled') !== 'false'
    // Per-account phase switches, aggregated: scan and analyze are ONE piece of
    // shared work per cycle, so the only honest saving is to stop entirely when
    // no account the loop would dispatch to still wants the result. With no
    // overrides set (the default) these are both true and nothing changes.
    const { phaseWanted } = await import('./services/account-phases.js')
    // A2. The roster for the SCAN question is the set of accounts that may
    // SCAN, which is not the set that may ENTER. Asking getAutopilotAccounts
    // (an entry-capability read) made a `manage_only` account's scan
    // preference invisible: it wants its insight history kept warm while it
    // enters nothing, and under the old roster it was not consulted at all.
    // Falls back to the entry roster if the registry cannot answer, so a
    // registry problem cannot silently stop scanning altogether.
    const { scanAccountIds } = await import('./services/account-capabilities.js')
    let scanRoster = []
    try { scanRoster = scanAccountIds(db) } catch { scanRoster = [] }
    const enterRoster = getAutopilotAccounts(db).map(a => String(a.accountId))
    const rosterIds = scanRoster.length > 0 ? scanRoster : enterRoster
    const scanWanted = phaseWanted(db, 'scan', rosterIds)
    const analyzeWanted = phaseWanted(db, 'analyze', rosterIds)
    const client = getAnthropicClient()

    // Daily token budget — reporting only. Scan/analyze are deterministic
    // (zero tokens) since the fib migration; the remaining Anthropic
    // consumers are the monitor/weekend position-safety checks, which must
    // not be paused mid-position, so an exceeded budget warns instead of
    // gating.
    const dailyTokensUsed = parseInt(getState(db, 'daily_tokens_used') || '0')
    if (dailyTokensUsed >= DAILY_TOKEN_BUDGET) {
      log(`Daily token budget exceeded (${dailyTokensUsed.toLocaleString()} / ${DAILY_TOKEN_BUDGET.toLocaleString()}) — monitor/weekend LLM checks still running.`)
    }

    // Autopilot's own symbol universe, falling back to legacy watchlist
    const symbolsJson = getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json')

    if (!symbolsJson) {
      log('No symbols configured — push via POST /actions/symbols')
    } else {
      let parsed
      try { parsed = JSON.parse(symbolsJson) } catch { parsed = [] }
      const allSymbols = (Array.isArray(parsed) ? parsed : [])
        .map(w => (typeof w === 'string' ? { symbol: w, enabled: true } : w))
        .filter(w => w.enabled !== false)
        .filter(w => !w.force_skip)

      const activeSessions = getActiveSessions()
      const openPositions = s.selectActivePositions.all('active')
      const tradPositions = openPositions.filter(p => categoriseSymbol(p.symbol) !== 'crypto')
      
      const marketClosed = activeSessions.length === 0

      // Weekend quiet hours (owner 01-08-2026): no scan and no Telegram
      // recommendation from Saturday 00:00 SGT until Monday 01:00 SGT —
      // a weekend scan reads Friday's stale close dressed up as a signal.
      // CRYPTO EXEMPTION (owner-approved the same evening): crypto trades a
      // live 24/7 market, so during quiet the scan narrows to crypto-only
      // instead of going silent — analyze/recommend/autotrade downstream see
      // only what was scanned, so the exemption propagates by construction.
      // ONLY the scan/analyze/recommendation phase is silenced; monitoring,
      // protection, guards, reconcile and the P&L backfill run unchanged.
      const { weekendQuietNow, quietUntilMs, quietScanSymbols } = await import('./lib/quiet-hours.js')
      const weekendQuiet = weekendQuietNow()

      // 24/7 scanning — all symbols always (no market-hours filter), except
      // weekend quiet narrows the list to crypto.
      const symbols = weekendQuiet
        ? quietScanSymbols(allSymbols, categoriseSymbol).symbols
        : allSymbols

      if (allSymbols.length === 0) {
        log('No enabled symbols configured')
      } else if (weekendQuiet && symbols.length === 0) {
        log(`Weekend quiet hours — no crypto on the watchlist, so no scan or recommendations until ${new Date(quietUntilMs()).toISOString()} (Mon 01:00 SGT); monitoring/protection unaffected`)
        try {
          const { recordDecision } = await import('./services/decision-log.js')
          recordDecision(db, { stage: 'weekend_quiet', decision: 'skip', reason: 'weekend quiet hours (Sat 00:00 → Mon 01:00 SGT)', loopId: loopCount })
        } catch { /* diagnostics only */ }
      } else if (!scanEnabled) {
        log('Scan disabled — skipping')
      } else if (!scanWanted) {
        log(`Scan off on every trading account (${rosterIds.join(', ')}) — skipping; nothing would use the result`)
      } else {
        if (weekendQuiet) {
          log(`Weekend quiet hours — crypto-only scan (${symbols.length} of ${allSymbols.length} symbols) until ${new Date(quietUntilMs()).toISOString()} (Mon 01:00 SGT); non-crypto stays quiet`)
          try {
            const { recordDecision } = await import('./services/decision-log.js')
            recordDecision(db, { stage: 'weekend_quiet', decision: 'skip', reason: 'weekend quiet hours (Sat 00:00 → Mon 01:00 SGT) — non-crypto silenced; crypto exempt', loopId: loopCount })
          } catch { /* diagnostics only */ }
        }
        if (marketClosed) {
          log(`Off-hours scan — ${symbols.length} symbol(s), market closed`)
        }

    phase(`scanning ${symbols.length} symbols`, 'scan')

    // Deterministic 61.8% Fibonacci retracement fade scan — no LLM calls.
    // Needs cTrader trendbar access (symbol map + credentials); skip cleanly
    // if not configured yet.
    const symbolMap = getSymbolMap(db)
    const ctraderCreds = getCtraderCreds(db)

    // Stage matrix (Tune → Pipeline): the SCAN column decides what gets
    // computed — wide by default, so every conviction is analysed. Filters
    // resolve to strict (scan cell on), annotate (trade cell on — signal
    // survives, failure recorded in filters_failed for the trade gate), or
    // off. The trade column is enforced later, at Auto Trade & Open.
    const strategies = scanStageStrategies(db, getState)
    // Keys of strategies ARMED to trade (Auto Trade & Open). The scanner still
    // computes every scan-staged strategy, but pickBestSignal prefers an armed
    // one so a selective armed strategy (RSI-2/VP) isn't shadowed by a
    // higher-conviction UNARMED one (FIB) that only gets vetoed — the reason
    // armed RSI-2/VP sat at 0 trades for hours.
    const armedStrategyKeys = enabledStrategies(db, getState).map(s => s.key)
    const stageFilterOpts = scanFilterOptions(db, getState)
    // Custom autotrade timeframes (e.g. 1.5h) must be scanned too — the
    // classic scan set only covers the native ladder.
    let extraTimeframes = []
    try { extraTimeframes = JSON.parse(getState(db, 'autotrade_timeframes') || '[]') } catch { /* keep [] */ }
    let scanMatrix = null
    try { scanMatrix = JSON.parse(getState(db, 'autotrade_matrix_json') || 'null') } catch { /* null */ }
    // Full-watchlist rotation: held symbols always scan (the monitor needs
    // their prices); the rest rotate via the persisted cursor so all 50+
    // symbols are covered every few runs instead of only the first 15 ever.
    let prioritySymbols = []
    try {
      prioritySymbols = db.prepare(`SELECT DISTINCT UPPER(symbol) AS s FROM monitored_positions WHERE status = 'active'`).all().map(r => r.s)
    } catch { /* none */ }
    const scanCursor = Number(getState(db, 'scan_cursor')) || 0
    // Owner (2026-07-26): "when market volume spike, check immediately" — the
    // guardian's tick stream flags a flat watchlist symbol that just spiked
    // (services/guardian.js); consumed once here so it jumps the rotation
    // queue instead of waiting its turn. Best-effort: a failure here just
    // means ordinary rotation, never blocks the scan.
    let prioritySpikeSymbols = []
    try {
      const { takeScanPrioritySymbols } = await import('./services/guardian.js')
      prioritySpikeSymbols = takeScanPrioritySymbols(db)
    } catch { /* rotation proceeds unboosted */ }
    const scanT0 = Date.now()
    // The scan gets at most HALF the cycle's soft deadline (incident
    // 2026-07-28: broker throttling stretched each symbol to ~29s, the scan
    // alone ran 7+ minutes, and /health starved — the owner couldn't load
    // the site). Past its share the scan returns partial results and the
    // cycle moves on; the rotation cursor keeps coverage honest over runs.
    const scanDeadlineAt = start + Math.floor(CYCLE_SOFT_DEADLINE_MS / 2)
    const scanResult = ctraderCreds.ready
      ? await runFibScan(ctraderCreds, symbolMap, symbols, { hotThreshold: 6, ...stageFilterOpts, strategies, armedStrategyKeys, extraTimeframes, matrix: scanMatrix, armedTfs: extraTimeframes.length ? extraTimeframes : null, cursor: scanCursor, prioritySymbols, prioritySpikeSymbols, deadlineAt: scanDeadlineAt })
      : { scans: [], hot: [], warm: [], desk_note: 'cTrader credentials not configured — scan skipped', usage: { output_tokens: 0 }, signals: {}, errors: [] }
    if (scanResult.deadlineHit) log(`Scan hit its deadline (${Math.round((Date.now() - scanT0) / 1000)}s) — partial batch, broker calls running slow`)
    const scanMs = Date.now() - scanT0
    setState(db, 'last_scan_ms', String(scanMs))
    if (scanResult.next_cursor != null) setState(db, 'scan_cursor', String(scanResult.next_cursor))

    // Cup & Handle Silence Diagnostics (Part A, owner-approved 2026-07-22) —
    // rides on the existing cup_handle enable toggle: only non-empty when the
    // strategy was actually armed for this scan, so this is a no-op otherwise.
    for (const t of scanResult.cupHandleDiagnostics || []) {
      try {
        insertCupHandleDiagnostic(db, { ...t, loop_id: loopCount })
      } catch (err) {
        log(`cup_handle_diagnostics insert failed: ${err.message}`)
      }
    }

    if (!ctraderCreds.ready) {
      const missing = [
        !ctraderCreds.clientId && 'clientId',
        !ctraderCreds.clientSecret && 'clientSecret',
        !ctraderCreds.accessToken && 'accessToken',
        !ctraderCreds.accountId && 'accountId (link an account on the Connect tab)',
      ].filter(Boolean).join(', ')
      log(`Fib scan skipped — missing cTrader ${missing}`)
    }

    // Surface fetch failures — an expired token or rate limit must not be
    // indistinguishable from "no setups found".
    if (scanResult.errors?.length) {
      log(`Scan fetch errors (${scanResult.errors.length}): ${scanResult.errors[0]}`)
      // Through recordError so this bump also lands in `last_error` and the
      // recent-errors ring. It used to write api_ctrader_last_error only,
      // which is why /health could show 21 errors with an April lastError.
      recordError(db, 'scan-fetch', scanResult.errors[0], { extraKey: 'api_ctrader_last_error' })
    } else if (ctraderCreds.ready && scanResult.scans.length > 0) {
      setState(db, 'api_ctrader_last_ok', new Date().toISOString())
    }

    log(
      `Scan complete: ${scanResult.scans.length} symbols, ${scanResult.hot.length} hot, ${scanResult.warm.length} warm (${scanMs}ms, concurrency ${process.env.SCAN_CONCURRENCY || 6})` +
      (prioritySpikeSymbols.length ? ` — spike-priority: ${prioritySpikeSymbols.join(', ')}` : '')
    )

    // Persist scans
    const now = new Date().toISOString()
    for (const scan of scanResult.scans) {
      s.insertScan.run({
        symbol: scan.symbol,
        bias: scan.bias || null,
        confidence: scan.confidence ?? null,
        thesis: scan.thesis || null,
        timeframe: scan.timeframe || null,
        session_fit: scan.session_fit || null,
        trade_at: scan.trade_at || null,
        price: scan.price ?? null,
        trade_grade: scan.trade_grade || null,
        desk_note: scanResult.desk_note || null,
        strategy: scan.strategy || null,
        scanned_at: now,
        loop_id: loopCount,
      })

      // Detect signal flips
      if (scan.bias && scan.bias !== 'skip') {
        detectFlip(db, scan.symbol, scan.bias, scan.confidence || 0, 'scan')
      }
    }

    setState(db, 'last_scan_at', now)
    setState(db, 'last_scan_results', JSON.stringify(scanResult))
    // Remember this batch's closes in the persistent FX table — the risk
    // gate's cross-pair sizing reads it, and a 15-of-221 rotation means the
    // last batch alone cannot supply a conversion leg (see fx-rates.js).
    recordFxRates(db, scanResult)

    // Persist scan context for next loop's delta computation
    persistScanContext(db, scanResult.scans)

    // Telegram alert for hot symbols — deduped on the signal signature
    // (symbol@timeframe@level). A fib zone persists across many 5-minute
    // loops; without dedup the identical alert fires every loop until price
    // leaves the zone.
    if (scanResult.hot.length > 0 && process.env.TELEGRAM_BOT_TOKEN) {
      const hotSignature = scanResult.hot
        .map(sym => {
          const sig = scanResult.signals[sym]
          return sig ? `${sym}@${sig.timeframe}@${sig.level618}` : sym
        })
        .sort()
        .join('|')
      if (hotSignature !== getState(db, 'last_hot_alert_signature')) {
        try {
          // Market-open-day filter (owner 01-08): a setup is only recommended
          // on a day its own market trades — open now, or opening later the
          // same SGT day. Filtered symbols drop to the "skipped" line rather
          // than vanishing, so the alert stays honest about what it omitted.
          const { recommendableToday } = await import('./lib/quiet-hours.js')
          // nextOpenInfo (not the bare open check) — recommendableToday needs
          // next_open_at to decide "opens later TODAY" vs "shut all day".
          const { nextOpenInfo } = await import('./services/symbol-hours.js')
          const canRec = (sym) => {
            try { return recommendableToday(nextOpenInfo(db, sym)) } catch { return true }
          }
          const alertScans = scanResult.scans.map(sc =>
            (sc.bias !== 'skip' && sc.bias !== 'neutral' && !canRec(sc.symbol))
              ? { ...sc, bias: 'skip' }
              : sc)
          const setups = alertScans.filter(sc => sc.bias !== 'skip' && sc.bias !== 'neutral')
          if (setups.length > 0) {
            const { scanAlertButtons } = await import('./services/alert-format.js')
            await sendScanAlert(alertScans, scanResult.desk_note, '', { buttons: scanAlertButtons(setups) })
          } else {
            log('Scan alert suppressed — every setup is on a market that does not open today')
          }
          setState(db, 'last_hot_alert_signature', hotSignature)
        } catch (err) {
          log('Telegram alert failed:', err.message)
        }
      }
    }

    // -----------------------------------------------------------------------
    // 2. ANALYZE PHASE — deep analysis for hot symbols (max 3 per cycle)
    // -----------------------------------------------------------------------
    if (analyzeEnabled && !analyzeWanted && scanResult.hot.length > 0) {
      log(`Analyze off on every trading account (${rosterIds.join(', ')}) — skipping ${scanResult.hot.length} hot symbol(s)`)
    }
    if (analyzeEnabled && analyzeWanted && scanResult.hot.length > 0) {
      // Best-first slot allocation: with concurrent positions capped (owner set
      // 25), the few candidates dispatched each cycle must be the STRONGEST
      // signals, not whichever scanned first — otherwise mediocre setups fill
      // the slots and stronger later signals hit the max-positions veto. Rank
      // hot by conviction (tie-break: a symbol with a positive backtest edge).
      const { rankHotSymbols, provenEdgeSymbolsFrom } = await import('./services/signal-ranking.js')
      let baseline = null
      try { baseline = JSON.parse(getState(db, 'backtest_baseline_json') || 'null') } catch { /* none */ }
      const ranked = rankHotSymbols(scanResult.scans, scanResult.hot, { provenEdgeSymbols: provenEdgeSymbolsFrom(baseline) })

      // CLUSTER CONVICTION (owner 2026-07-29: "Correlation clusters ... better
      // use as a strategy"). When most members of a correlated group point the
      // same way, that is one macro bet showing up N times — take the best
      // expression of it, not all N. This is the shape of the 29-07 production
      // day: four fib_618_fade entries in five minutes, −2,317.70 between them.
      //
      // SHIPS LOG-ONLY. `enforce` defaults false, so this records what it WOULD
      // have done and changes nothing until the owner has seen it run against
      // real scans. Never allowed to take the loop down.
      let clusterRead = null
      try {
        const { clusterConviction, loadClusterConvictionConfig } = await import('./services/cluster-conviction.js')
        const { loadStoredMatrix } = await import('./services/correlation-matrix.js')
        let liveMatrix = null
        try { liveMatrix = loadStoredMatrix(db) } catch { /* none computed yet */ }
        clusterRead = clusterConviction(
          (scanResult.scans || []).map(sc => ({ symbol: sc.symbol, bias: sc.bias, conviction: sc.confidence })),
          { config: loadClusterConvictionConfig(db), liveMatrix },
        )
        if (clusterRead.groups.length) {
          const { recordDecision } = await import('./services/decision-log.js')
          for (const g of clusterRead.groups) {
            log(`Cluster agreement: ${g.label} ${g.direction > 0 ? 'LONG' : 'SHORT'} ${g.agree}/${g.total} — best ${g.best.symbol}${clusterRead.enforce ? '' : ' (observe only)'}`)
            for (const other of g.others) {
              recordDecision(db, {
                symbol: other,
                stage: 'cluster_conviction',
                decision: clusterRead.enforce ? 'skip' : 'observe',
                reason: `same bet as ${g.best.symbol} via ${g.label} (${g.agree}/${g.total} agree)`,
              })
            }
          }
        }
      } catch (err) {
        log('Cluster conviction read failed (non-fatal):', err.message)
      }

      // Only ENFORCE mode reshapes the slot allocation. Superseded symbols drop
      // out; the group's best member keeps its place. If that would empty the
      // list entirely the original ranking stands — collapsing a cycle to zero
      // trades is a bigger change than this feature is allowed to make.
      const afterCluster = clusterRead?.enforce
        ? ranked.filter(sym => !clusterRead.supersededBy[String(sym).toUpperCase()])
        : ranked
      const hotToAnalyze = (afterCluster.length ? afterCluster : ranked).slice(0, 3)
      phase(`analyzing ${hotToAnalyze.join(', ')}`, 'analyze')
      for (const sym of hotToAnalyze) {
        try {
          await dispatchSymbolSignal(db, s, symbols, sym, scanResult.signals[sym])
        } catch (err) {
          log(`Analysis failed for ${sym}:`, err.message)
        }
      }
    }

      } // end scanEnabled + symbols (scan+analyze branch)

      // ---------------------------------------------------------------------
      // PENDING-ORDER MODE — resting fib-61.8% LIMIT orders, armed per
      // symbol×timeframe. Inert unless the owner enabled the flag; a failure
      // here must never take down the scan/monitor loop.
      // ---------------------------------------------------------------------
      try {
        phase('pending orders')
        // TIME BUDGET + NO-OVERLAP (owner-approved 2026-07-27, root-cause fix
        // for the day's hang→watchdog-restart cycle: /health's loopPhase
        // forensics caught the loop stuck HERE on every observed hang). The
        // phase gets a hard wall-clock budget; on breach the CYCLE moves on —
        // the monitor phase for open positions must never wait behind a stuck
        // pending await again. The abandoned run keeps executing detached
        // until its own awaits settle, so the in-flight flag makes the next
        // cycle SKIP its pending phase rather than run two concurrently
        // (managePendingOrders cancels/places real broker orders — two
        // interleaved runs could double-place).
        if (cycleOverBudget()) {
          log('Cycle past soft deadline — skipping pending-order phase this cycle')
        } else if (pendingPhaseInFlight) {
          log('Pending-order phase from a previous cycle still in flight — skipping this cycle (no overlap)')
        } else if (getState(db, 'pending_mode_enabled') === 'true') {
          const pendingCreds = getCtraderCreds(db)
          if (pendingCreds.ready) {
            const budgetMs = Math.max(10_000, Number(process.env.PENDING_PHASE_BUDGET_MS || 90_000))
            const startedAt = Date.now()
            const work = managePendingOrders(db, pendingCreds, getSymbolMap(db), {
              notify: (text) => import('./services/telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
            })
            pendingPhaseInFlight = true
            // The detached run must clear the flag AND never surface an
            // unhandled rejection once the cycle has moved on without it.
            work.catch(() => {}).finally(() => { pendingPhaseInFlight = false })
            let timer
            const r = await Promise.race([
              work,
              new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), budgetMs); timer.unref?.() }),
            ]).catch(err => ({ failed: err.message }))
            clearTimeout(timer)
            if (r?.timedOut) {
              log(`Pending-order phase exceeded its ${Math.round(budgetMs / 1000)}s budget after ${Math.round((Date.now() - startedAt) / 1000)}s — abandoning the wait, cycle continues (run finishes detached)`)
              await hbeat(db, 'pending_orders', false, `budget ${Math.round(budgetMs / 1000)}s exceeded`)
            } else if (r?.failed) {
              throw new Error(r.failed)
            } else {
              if (r?.summary) log(`Pending orders: ${r.summary}`)
              else if (r?.skipped) log(`Pending orders skipped: ${r.skipped}`)
            }
          }
        }
        if (!pendingPhaseInFlight) await hbeat(db, 'pending_orders')
      } catch (err) {
        log(`Pending-order phase failed (non-fatal): ${err.message}`)
        await hbeat(db, 'pending_orders', false, err.message)
      }

      // ---------------------------------------------------------------------
      // CLOSED-MARKET LIMIT SWEEP — pure DB reconciliation, no network call.
      // Retires pending_orders rows (note='pending-closed') left orphaned by
      // a rejection/cancel/expiry at the broker. Runs every cycle regardless
      // of whether any symbol hits the closed-market branch THIS cycle —
      // before this fix, a row's only exit was that exact symbol signaling
      // again (owner: "pending order lapse more than a day").
      // ---------------------------------------------------------------------
      try {
        const { reconcileStaleClosedMarketLimits } = await import('./services/closed-market-limits.js')
        const r = reconcileStaleClosedMarketLimits(db)
        if (r.filled || r.expired) log(`Closed-market limit sweep: ${r.filled} filled, ${r.expired} expired, ${r.stillWorking} still working`)
      } catch (err) {
        log(`Closed-market limit sweep failed (non-fatal): ${err.message}`)
      }

      // BURN-IN MODE — track-record trades (owner-armed): min-size positions
      // through the full auto-trade path with tight time caps, so completed
      // round-trips accumulate fast. Inert unless burn_in_json.on AND
      // autotrade armed; a failure must never take down the loop.
      try {
        const biCreds = getCtraderCreds(db)
        if (biCreds.ready && !cycleOverBudget()) {
          phase('burn-in')
          const { runBurnIn } = await import('./services/burn-in.js')
          const b = await runBudgetedSubPhase(db, 'burn_in', () => runBurnIn(db, biCreds))
          if (b?.placed || b?.attempted) log(`Burn-in: ${b.summary}`)
        }
        await hbeat(db, 'burn_in')
      } catch (err) {
        log(`Burn-in failed (non-fatal): ${err.message}`)
        await hbeat(db, 'burn_in', false, err.message)
      }

      // PENDING-SIGNALS RETRY — signals deferred by autoTrade() because their
      // symbol's own market was closed (owner: "do you separate which one
      // you would trade based on market open... which will trade later when
      // NY opens?"). Every cycle, regardless of scan rotation: the instant a
      // queued symbol's market reopens it's re-checked against a FRESH scan
      // and fired through the same gate chain — never blind on stale prices.
      try {
        const psCreds = getCtraderCreds(db)
        if (!cycleOverBudget()) {
          phase('pending signals')
          const { runPendingSignals } = await import('./services/pending-signals.js')
          const p = await runBudgetedSubPhase(db, 'pending_signals', () => runPendingSignals(db, psCreds))
          if (p.fired || p.expired) log(`Pending signals: ${p.fired} fired, ${p.expired} expired, ${p.checked} checked`)
        }
        await hbeat(db, 'pending_signals')
      } catch (err) {
        log(`Pending-signals retry failed (non-fatal): ${err.message}`)
        await hbeat(db, 'pending_signals', false, err.message)
      }

      // TRADE GUARDS + PROFIT KEEPER NOW RUN ON THE FAST MONITOR, not here.
      //
      // Operating Goal Plan §70.7: "Ensure the five-minute strategy loop is
      // never the sole position protector." Both of these MOVE stops and CLOSE
      // positions, and both were bolted to this cycle — so break-even moves,
      // trailing and profit locks stopped whenever a scan ran long, which is
      // precisely when a fast market makes them matter.
      //
      // They were MOVED rather than duplicated. §36.2.3: "Two components must
      // not unknowingly write the same stop." The protection audit reads only,
      // so it deliberately runs on both paths; an acting layer must have
      // exactly one writer. See services/fast-monitor.js, 60s band.

      // Loss Guardian — safety net for LOSING/naked positions the Profit
      // Keeper won't touch (it only protects gains). Conservative: places a
      // protective stop on a NAKED position and enforces an optional time cap;
      // never tightens a valid mean-reversion stop. Inert when off; non-fatal.
      try {
        const guardCreds = getCtraderCreds(db)
        if (guardCreds.ready && !cycleOverBudget()) {
          phase('loss guardian')
          const { runLossGuardian } = await import('./services/loss-guardian.js')
          const g = await runBudgetedSubPhase(db, 'loss_guardian', () => runLossGuardian(db, guardCreds, {
            notify: (text) => import('./services/telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
          }))
          if (g.stops || g.closes) log(`Loss Guardian: ${g.stops} protective stop(s), ${g.closes} close(s)`)
          if (g.errors?.length) log(`Loss Guardian errors: ${g.errors.join(' · ')}`)
        }
        await hbeat(db, 'loss_guardian')
      } catch (err) {
        log(`Loss Guardian failed (non-fatal): ${err.message}`)
        await hbeat(db, 'loss_guardian', false, err.message)
      }

      // Periodic broker-truth market-hours refresh — pull each mapped
      // FX conversion legs — sizing infrastructure, refreshed on its own
      // schedule (services/fx-legs.js). Production 03-08-2026: 1,859 entries
      // in seven days died at `usd_per_lot_unknown` because USDPLN, USDNOK and
      // USDCAD had not been scanned since 01-08 and the rate table correctly
      // refuses anything older than 26 hours. The scanner looks for trades,
      // not for conversion rates; leaving the rates to it is what broke.
      // Cheap by construction: only legs older than six hours are fetched,
      // capped per cycle, so the steady state is zero broker calls.
      try {
        const creds = getCtraderCreds(db)
        if (creds.ready && !cycleOverBudget()) {
          const { refreshFxLegs } = await import('./services/fx-legs.js')
          const { readTradableUnion } = await import('./services/watchlists.js')
          let symbols = []
          try { symbols = readTradableUnion(db).map(w => w.symbol).filter(Boolean) } catch { symbols = [] }
          if (symbols.length) {
            const symbolMap = getSymbolMap(db)
            const { wsGetSpotOnce } = await import('./lib/ctrader-ws.js')
            const r = await refreshFxLegs(db, {
              symbols, symbolMap,
              getSpot: (sid) => wsGetSpotOnce(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, sid),
            })
            if (r.fetched.length) log(`FX legs refreshed: ${r.fetched.join(', ')}${r.failed.length ? ` (failed: ${r.failed.join(', ')})` : ''}`)
            else if (r.failed.length) log(`FX legs: ${r.failed.length} leg(s) could not be priced — ${r.failed.join(', ')}`)
          }
        }
      } catch (err) {
        log(`FX leg refresh failed (non-fatal): ${err.message}`)
      }

      // symbol's real trading schedule from cTrader into symbol_hours so the
      // open/closed gate scales to 1,900+ instruments without hardcoded
      // categories. Roughly once a day (every ~288 five-min loops), and once
      // shortly after boot when the table is empty. Non-fatal.
      try {
        const creds = getCtraderCreds(db)
        const haveHours = db.prepare('SELECT COUNT(*) AS n FROM symbol_hours').get().n
        if (creds.ready && !cycleOverBudget() && (loopCount % 288 === 5 || haveHours === 0)) {
          phase('market-hours refresh')
          const { refreshSymbolHours } = await import('./services/symbol-hours.js')
          // Hours refresh sweeps 1,900+ symbols in batches — give it a wider
          // budget than the order-touching phases, but still bounded.
          const r = await runBudgetedSubPhase(db, 'hours_refresh', () => refreshSymbolHours(db, creds), SUB_PHASE_BUDGET_MS * 2)
          if (r.updated) log(`Market hours refreshed: ${r.updated} symbols${r.errors?.length ? `, ${r.errors.length} batch error(s)` : ''}`)
          await hbeat(db, 'hours_refresh')
        }
      } catch (err) {
        log(`Market-hours refresh failed (non-fatal): ${err.message}`)
        await hbeat(db, 'hours_refresh', false, err.message)
      }

      // D6 — daily ATR baseline refresh (vol-gate spec §2: "recompute the
      // rolling window daily, not per-signal").
      //
      // Without this the atr_history table stays EMPTY, classifyVolRegime can
      // never place a symbol in its own volatility distribution, and the whole
      // volatility gate is inert while looking installed — the worst kind of
      // dead feature, because every downstream reading says NORMAL and nobody
      // can tell that from a real verdict.
      //
      // Once a day (every ~288 five-min loops), and once shortly after boot
      // while the table is empty so a fresh deploy self-seeds instead of
      // waiting a day. Daily bars are HISTORICAL requests — capped by cTrader
      // at 5/s, paced to 4/s by ctrader-ws.js's shared bucket — so this is
      // deliberately a once-a-day sweep. Doing it per-signal is exactly the
      // 2026-07-28 throttling incident.
      try {
        const creds = getCtraderCreds(db)
        const haveAtr = db.prepare('SELECT COUNT(*) AS n FROM atr_history').get().n
        // The empty-table trigger is a SELF-SEED for a fresh deploy, not a
        // retry loop. Without a back-off, a sweep that writes nothing (no
        // symbols, every fetch failing) re-fires every 5 minutes forever and
        // spends broker calls on it — which is what staging was doing.
        const lastAtrTry = Number(getState(db, 'atr_refresh_last_attempt_ms')) || 0
        const seedBackoffOk = Date.now() - lastAtrTry > 3600_000
        // #170, SECOND DEFECT (2026-08-03): the daily cadence was
        // `loopCount % 288 === 11`. `loopCount` is a module-level variable
        // initialised to 0 at the top of this file, so it resets on every
        // process start — and 288 five-minute loops is a day, meaning loop 11
        // lands ~55 minutes after boot. On a host that redeploys or restarts
        // more often than that, the daily sweep NEVER RUNS. The empty-table
        // self-seed masked it: while atr_history was empty something still
        // fired hourly, so the bug only becomes visible once the table has
        // rows — at which point the baseline silently ages and every symbol
        // reads NORMAL again, which is the exact failure #170 is about.
        //
        // The schedule now hangs off the controller's own last SUCCESS, which
        // is already recorded in controller_heartbeats and already survives a
        // restart. `seedBackoffOk` still caps attempts at one an hour, so a
        // sweep that keeps failing costs the broker one burst per hour rather
        // than one per five-minute loop.
        const { lastOkMs } = await import('./services/heartbeat.js')
        const atrLastOk = lastOkMs(db, 'atr_refresh')
        const atrDue = Date.now() - atrLastOk > 86_400_000
        if (creds.ready && !cycleOverBudget() && seedBackoffOk && (atrDue || haveAtr === 0)) {
          setState(db, 'atr_refresh_last_attempt_ms', String(Date.now()))
          phase('ATR baseline refresh')
          const { refreshAtrHistory, pruneAtrHistory, ATR_BAR_PERIOD_KEY } = await import('./services/vol-gate.js')
          // #170, THIRD DEFECT: this read the map raw. `symbol_id_map` is
          // written when an account is linked, and a DB wipe, a fresh volume
          // or a never-relinked account leaves it EMPTY — in which case every
          // symbol here throws "symbolId unknown" and the sweep reports 0/N
          // with a perfectly accurate error message that names the wrong
          // cause. `ensureSymbolMap` is the existing self-heal (it downloads
          // the broker's light symbol list and persists it) and every other
          // consumer that cannot proceed without the map already uses it.
          // One extra broker call at most once an hour, and only when the map
          // is genuinely empty.
          const { ensureSymbolMap } = await import('./lib/ctrader-creds.js')
          let symbolMap = {}
          try { symbolMap = await ensureSymbolMap(db, creds) } catch { symbolMap = getSymbolMap(db) }
          // #170, ROOT CAUSE (production, 2026-08-02): this read the raw
          // watchlist JSON and handed the parsed array straight to
          // refreshAtrHistory, which does `String(raw).toUpperCase()`. The
          // watchlist has been an array of OBJECTS ({symbol, enabled, …}) since
          // the per-symbol settings work, so every entry stringified to
          // "[OBJECT OBJECT]", missed the symbol map, and threw "symbolId
          // unknown". The instrumentation added earlier today is what made it
          // legible: 23 symbols, 23 failures, 0 rows, and the error text
          // literally containing [OBJECT OBJECT].
          //
          // The 2026-07-29 fix above was real but addressed a DIFFERENT
          // failure (an empty list winning over a populated one), and its
          // `firstNonEmpty` returned raw entries — so the shape bug survived
          // underneath it.
          //
          // Reading through readTradableUnion is the durable fix rather than
          // mapping `.symbol` here: it is the same normaliser every other
          // universe consumer uses, it accepts both the legacy string form and
          // the object form, and it spans the accounts' lists. A future change
          // to the stored shape now lands in one place instead of silently
          // re-breaking this sweep.
          const { readTradableUnion } = await import('./services/watchlists.js')
          let symbols = []
          try {
            symbols = readTradableUnion(db)
              .filter(w => w.enabled !== false)
              .map(w => w.symbol)
              .filter(Boolean)
          } catch { symbols = [] }
          // Legacy fallback, normalised the same way — a bare string list is
          // still valid on the wire and must not be rejected for not being
          // objects.
          if (!symbols.length) {
            try {
              const raw = JSON.parse(getState(db, 'watchlist_json') || '[]')
              if (Array.isArray(raw)) {
                symbols = raw
                  .map(w => (typeof w === 'string' ? w : w?.symbol))
                  .filter(Boolean)
                  .map(x => String(x).toUpperCase())
              }
            } catch { /* a malformed legacy key must not stop the sweep */ }
          }
          const atrFetch = async (sym, count) => {
            const sid = symbolMap[String(sym).toUpperCase()]
            if (!sid) throw new Error(`symbolId unknown for ${sym}`)
            const byTf = await wsGetTrendbarsBatch(
              creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId,
              sid, [ATR_BAR_PERIOD_KEY], count, 20_000, 0)
            return byTf[ATR_BAR_PERIOD_KEY] || []
          }
          if (!symbols.length) {
            // Say it, and beat FAILED. A sweep with no symbols that beats OK
            // looks identical to a sweep that worked, and every downstream vol
            // reading would sit at NORMAL for want of a baseline nobody knew
            // was missing — the same class of silent-reassurance bug as the
            // protection audit reading "idle".
            log('ATR baseline: no symbols in autopilot_symbols_json or watchlist_json — nothing to refresh')
            await hbeat(db, 'atr_refresh', false, 'no symbols configured')
          } else if (!Object.keys(symbolMap).length) {
            // Distinct from "every fetch failed". N identical "symbolId
            // unknown" errors describe the symptom; this names the cause once,
            // and spends no broker calls proving it N times.
            log(`ATR baseline: symbol_id_map is empty — ${symbols.length} symbols cannot be resolved to broker ids; relink the account`)
            await hbeat(db, 'atr_refresh', false, `symbol_id_map empty — ${symbols.length} symbols unresolvable`)
          } else {
          // COLLECT THE REASONS, not just the count. refreshAtrHistory has
          // always taken an onError hook and this caller has never passed
          // one, so `failed: 200` arrived with no clue whether those were
          // unknown symbol ids, broker throttling, or a dead socket — and
          // #170 is exactly "the table is empty and nobody can say why".
          const fetchErrors = []
          const r = await runBudgetedSubPhase(db, 'atr_refresh',
            () => refreshAtrHistory(db, symbols, atrFetch, {
              onError: (sym, err) => {
                if (fetchErrors.length < 5) fetchErrors.push(`${sym}: ${String(err?.message || err).slice(0, 120)}`)
              },
            }), SUB_PHASE_BUDGET_MS * 2)
          const ran = r && !r.timedOut && !r.skippedOverlap
          if (ran) {
            // Name the misses. A symbol silently absent from atr_history reads
            // downstream as "normal volatility", which is a verdict it never
            // earned.
            log(`ATR baseline: ${r.updated}/${r.symbols} symbols refreshed${r.failed ? `, ${r.failed} fetch failure(s)` : ''}${r.skipped?.length ? `, ${r.skipped.length} skipped (too little history)` : ''}${fetchErrors.length ? ` — e.g. ${fetchErrors[0]}` : ''}`)
            try { pruneAtrHistory(db) } catch { /* pruning is housekeeping */ }
          }
          // WHY THE SWEEP DID WHAT IT DID, somewhere durable. The log line
          // above evaporates; the heartbeat says only ok/failed. This is the
          // same shape as protection_audit_last_json and exists for the same
          // reason — so the next person asking "why is atr_history empty"
          // reads an answer instead of re-deriving one.
          try {
            setState(db, 'atr_refresh_last_json', JSON.stringify({
              at: new Date().toISOString(),
              ran, timedOut: !!r?.timedOut, skippedOverlap: !!r?.skippedOverlap,
              symbols: symbols.length,
              updated: r?.updated ?? null, failed: r?.failed ?? null,
              skipped: r?.skipped?.length ?? null,
              skippedSample: (r?.skipped || []).slice(0, 5),
              errors: fetchErrors,
              rowsAfter: db.prepare('SELECT COUNT(*) AS n FROM atr_history').get().n,
            }))
          } catch { /* status reporting must never break the sweep */ }
          // An OK beat means the sweep RAN — and only then. It used to beat OK
          // unconditionally, two lines under a comment warning against exactly
          // that: a timeout had already beaten FAILED inside
          // runBudgetedSubPhase, and this overwrote it, so a sweep that blew
          // its 180s budget reported healthy. A sweep where EVERY fetch threw
          // is not "a working controller reporting a data problem" either — it
          // is a controller that did nothing, and the vol gate is inert behind
          // it. Legitimate thin-history skips still count as a healthy run.
          if (!ran) {
            // The timeout path already beat FAILED with its own reason; do not
            // stamp over it with a vaguer one.
            if (r?.skippedOverlap) await hbeat(db, 'atr_refresh', false, 'previous sweep still in flight')
          } else if (r.updated === 0 && r.failed > 0) {
            await hbeat(db, 'atr_refresh', false, `every fetch failed (${r.failed}/${r.symbols})${fetchErrors.length ? ` — ${fetchErrors[0]}` : ''}`)
          } else {
            await hbeat(db, 'atr_refresh')
          }
          }
        }
      } catch (err) {
        log(`ATR baseline refresh failed (non-fatal): ${err.message}`)
        await hbeat(db, 'atr_refresh', false, err.message)
      }

      // Give historical trades their account back. The Go-Live Gate card was
      // showing the SAME pooled history under six per-account headings —
      // including the one labelled LIVE — because every closed trade had a
      // NULL account_id and the scoped-read convention hands NULL rows to
      // whoever asks. Bounded per pass; idempotent once drained.
      try {
        const { backfillTradeAccounts } = await import('./services/trade-account-backfill.js')
        const bf = backfillTradeAccounts(db)
        if (bf.stamped > 0) log(`Trade account backfill: stamped ${bf.stamped}, ${bf.remaining} still stampable, ${bf.unknowable} have no position row to learn it from`)
      } catch { /* reporting repair, never fatal */ }

      // ---------------------------------------------------------------
      // DECISION AUDIT — the check AFTER the risk gate has decided.
      //
      // Owner, 2026-08-03: "you are to ... actively check risk decision
      // after it has been completed". Runs LAST in the cycle, once the
      // scan/analyse/dispatch/risk phases above have written everything they
      // are going to write, and asks the question no controller asked: of
      // everything considered this FX day, what reached the gate, what did
      // the gate approve, and if nothing traded, WHICH stage consumed it.
      //
      // Every controller already has a heartbeat, so a loop that STOPS is
      // caught. A loop that runs perfectly and achieves nothing is not — it
      // beats OK on every controller and looks exactly like a quiet market.
      // That is the shape of #170 and of the protection audit reading "idle",
      // and this closes it for the entry path.
      // ---------------------------------------------------------------
      try {
        const { auditDecisions, shouldAlert, toText: auditText } =
          await import('./services/decision-audit.js')
        // Re-derived rather than reusing the scan phase's `weekendQuiet` —
        // that binding lives inside the scan block, and reaching for it here
        // would be a ReferenceError at runtime that no test covers.
        const { weekendQuietNow } = await import('./lib/quiet-hours.js')
        const marketOpen = !weekendQuietNow()
        const audit = auditDecisions(db, { marketOpen })
        setState(db, 'decision_audit_last_json', JSON.stringify(audit))
        const alert = shouldAlert(audit, { marketOpen })
        if (alert) {
          log(`DECISION AUDIT [${alert.level}]: ${alert.text}`)
          // Once per streak, not once per cycle. A monitor that fires every
          // five minutes teaches the owner to ignore it, and then the one
          // time it matters it looks like the other 287 that day — the same
          // discipline heartbeat.js applies to stall alerts.
          const prevKey = getState(db, 'decision_audit_alert_key') || ''
          const key = `${audit.verdict}:${audit.topSkipStages?.[0]?.key || audit.topVetoes?.[0]?.key || ''}`
          if (key !== prevKey) {
            setState(db, 'decision_audit_alert_key', key)
            if (process.env.TELEGRAM_BOT_TOKEN) {
              try {
                const { sendMessage } = await import('./services/telegram.js')
                await sendMessage(`⚠️ ${alert.text}\n\n${auditText(audit)}`)
              } catch { /* an alert that cannot send must not break the loop */ }
            }
          }
        } else {
          setState(db, 'decision_audit_alert_key', '')
        }
        await hbeat(db, 'decision_audit')
      } catch (err) {
        // Beat FAILED rather than staying silent — an auditor that quietly
        // stops is the exact bug it was built to detect.
        await hbeat(db, 'decision_audit', false, err.message)
      }

      // Strategy Autopilot — nightly evidence loop (mode-gated inside;
      // failures must never touch the trading phases).
      try {
        if (!cycleOverBudget()) {
          phase('autopilot')
          const { maybeRunAutopilot } = await import('./services/strategy-autopilot.js')
          const r = await runBudgetedSubPhase(db, 'autopilot', () => maybeRunAutopilot(db, getCtraderCreds(db)), SUB_PHASE_BUDGET_MS * 2)
          if (r && !r.skipped && !r.skippedOverlap && !r.timedOut) log(`Autopilot: ${JSON.stringify(r)}`)
        }
        await hbeat(db, 'autopilot')
      } catch (err) {
        log(`Autopilot failed (non-fatal): ${err.message}`)
        await hbeat(db, 'autopilot', false, err.message)
      }

      // ---------------------------------------------------------------------
      // 3. WEEKEND WATCH — hourly Opus pass on non-crypto open positions
      // when market is closed (and we're not already in pre-open warm-up,
      // which will run the full Analyst instead). Catches weekend catalysts
      // (Fed speak, OPEC, geopolitics) that break thesis before Monday gap.
      // ---------------------------------------------------------------------
      // Only during the ACTUAL weekend (Fri 21:00→Sun 22:00 UTC), and only
      // for positions whose OWN market is closed — not the ~1h daily NY→Sydney
      // lull that getActiveSessions() reports as "no session" (owner: NatGas
      // was stamped WEEKEND:HOLD on a weekday while NYMEX had its own hours).
      const weekendNow = isWeekend()
      const weekendPositions = weekendNow
        ? tradPositions.filter(p => !isSymbolMarketOpen(p.symbol).open)
        : []
      if (weekendPositions.length > 0 && loopCount % 12 === 1 && !cycleOverBudget()) {
        phase(`weekend watch (${weekendPositions.length})`, 'weekend-watch')
        log(`Weekend watch — reviewing ${weekendPositions.length} closed-market position(s)`)
        // D4b: bounded-concurrency, not one-position-at-a-time — see
        // monitorOneWeekendPosition/runWeekendWatchPhase above
        // (docs/d4-loop-block-fix-plan.md).
        // Its own tiered client: weekend_watch and position_monitor both sit on
        // the DEFAULT tier today, but sharing one client would silently pin
        // this phase to the monitor's model if either task were ever re-tiered.
        await runBudgetedSubPhase(db, 'weekend_watch', () => runWeekendWatchPhase(db, s, weekendPositions, getAnthropicClient('weekend_watch')), SUB_PHASE_BUDGET_MS * 2)
      }

      // ---------------------------------------------------------------------
      // 4. MONITOR PHASE — always runs when positions are open, even when
      // scan+analyze was skipped (market closed, etc). Crypto positions and
      // stale FX positions still need tick checks.
      // ---------------------------------------------------------------------
      if (openPositions.length > 0) phase(`monitoring ${openPositions.length} positions`, 'monitor')
      const activePositions = openPositions.length > 0
        ? openPositions
        : s.selectActivePositions.all('active')
      const lastScanResultsJson = getState(db, 'last_scan_results')
      let lastScanResults = null
      try { lastScanResults = JSON.parse(lastScanResultsJson || 'null') } catch { /* non-fatal */ }

      // Cheap price refresh for held positions — one spot quote each, decoupled
      // from the heavy new-setup scan (held symbols are no longer force-scanned,
      // so monitoring can't crowd out hunting). This is the PRIMARY price for
      // the deterministic rules; the last scan row is only a fallback for a
      // symbol whose quote failed this cycle.
      let heldPrices = {}
      if (activePositions.length > 0) {
        try {
          const monCreds = getCtraderCreds(db)
          if (monCreds.ready) {
            const { refreshHeldPrices } = await import('./services/held-prices.js')
            const monSymbolMap = getSymbolMap(db)
            heldPrices = await refreshHeldPrices(monCreds, monSymbolMap, activePositions.map(p => p.symbol))
          }
        } catch (err) {
          log(`Held-price refresh failed (non-fatal): ${err.message}`)
        }
      }

      // D4: bounded-concurrency, not one-position-at-a-time — see
      // monitorOnePosition/runMonitorPhase above (docs/d4-loop-block-fix-plan.md).
      await runMonitorPhase(db, s, activePositions, pos => {
        const scanRow = lastScanResults?.scans?.find(sc => sc.symbol === pos.symbol)
        return heldPrices[String(pos.symbol).toUpperCase()] ?? scanRow?.price ?? null
      }, client, cycleOverBudget)

      // ---------------------------------------------------------------------
      // 4a-bis. ADAPTIVE BREAKER — the machine response to a loss streak:
      // change strategy/filters via the stage matrix instead of pausing
      // (owner: cooldown pauses are for humans). Non-fatal by construction.
      // ---------------------------------------------------------------------
      try {
        phase('adaptive breaker')
        const { runAdaptiveBreaker } = await import('./services/adaptive-breaker.js')
        const ab = runAdaptiveBreaker(db, {
          notify: (text) => import('./services/telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
        })
        if (ab.actions?.length) log(`Adaptive breaker: ${ab.actions.map(a => `${a.strategy}→${a.did}`).join(', ')}`)
        await hbeat(db, 'adaptive_breaker')
      } catch (err) {
        log(`Adaptive breaker failed (non-fatal): ${err.message}`)
        await hbeat(db, 'adaptive_breaker', false, err.message)
      }

      // ---------------------------------------------------------------------
      // 4a-ii. EDGE WATCHDOG — per-strategy alpha-decay enforcement. Catches a
      // strategy grinding to NEGATIVE EXPECTANCY without ever stringing a loss
      // streak (which adaptive-breaker needs) and without dragging the
      // AGGREGATE profit factor under (which performance-breaker needs). Now
      // that broker stop-outs are backfilled, this runs on honest numbers.
      // ---------------------------------------------------------------------
      try {
        phase('edge watchdog')
        const { runEdgeWatchdog } = await import('./services/edge-watchdog.js')
        const ew = runEdgeWatchdog(db, {
          notify: (text) => import('./services/telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
        })
        if (ew.actions?.length) log(`Edge watchdog: disarmed ${ew.actions.map(a => `${a.strategy} (exp $${a.expectancy}, PF ${a.profitFactor ?? '∞'})`).join(', ')}`)
        await hbeat(db, 'edge_watchdog')
      } catch (err) {
        log(`Edge watchdog failed (non-fatal): ${err.message}`)
        await hbeat(db, 'edge_watchdog', false, err.message)
      }

      // ---------------------------------------------------------------------
      // 4b. EQUITY STOP — daily max-drawdown circuit for OPEN positions,
      // PER ACCOUNT. risk.js's dailyLossPct only vetoes NEW trades; this
      // closes an account's positions and disarms THAT account when its own
      // realised P&L breaches its own cap. Fires at most once per FX day per
      // account (17:00 NY roll — owner sign-off 2026-07-24, same anchor as
      // the risk gate's daily-loss check).
      //
      // WHY PER ACCOUNT (owner, 2026-07-30, asked and answered explicitly).
      // The previous version compared a cap sized from the SELECTED account's
      // balance against a loss summed across EVERY account, then set the
      // MASTER `autotrade_enabled` flag off. Since account-phases computes
      // `effective = master AND (override ?? master)`, master OFF is an
      // absolute veto — so every per-account Autotrade switch the owner had
      // set was silently overridden the moment any single account had a bad
      // day. That is the "autotrade drops from the accounts" they reported.
      // Portfolio-wide protection is NOT lost: it lives in global-guards.js
      // (5A portfolio halt / portfolio daily-loss cap), which this had been
      // duplicating badly. See services/equity-stop.js for the full note.
      // ---------------------------------------------------------------------
      try {
        phase('equity stop')
        const riskCfg = loadRiskConfig(db)
        const stopPct = riskCfg.equityStopPct ?? riskCfg.dailyLossPct
        const { fxDayStartSql, fxDayOpenMs } = await import('./services/risk.js')
        const es = await import('./services/equity-stop.js')
        const dayStart = fxDayStartSql()
        const dayOpen = fxDayOpenMs()
        // Every position this bot owns, grouped by the account it belongs to.
        // `source !== 'external'` keeps hands off positions the bot did not open.
        const byAccount = new Map()
        for (const p of s.selectActivePositions.all('active')) {
          if (p.source === 'external') continue
          const key = p.account_id == null ? null : String(p.account_id)
          if (!byAccount.has(key)) byAccount.set(key, [])
          byAccount.get(key).push(p)
        }

        for (const [acctId, positions] of byAccount) {
          // A position with no account_id cannot be attributed, so it cannot be
          // judged against any one account's cap. Skipping it is deliberate:
          // charging it to every account is precisely the bug being removed.
          // It is still covered by the portfolio layer and by its own SL/TP.
          if (acctId == null) {
            log(`Equity stop: ${positions.length} position(s) have no account_id — not attributable to any cap, left to the portfolio guards`)
            continue
          }
          if (es.alreadyTrippedToday(db, acctId, dayOpen)) continue

          const { pnl, unknownCount } = es.accountPnlToday(db, acctId, dayStart)
          const verdict = es.evaluateAccount({
            pnl,
            balance: getAccountBalance(db, acctId),
            stopPct,
            fallbackLimit: riskCfg.dailyLossLimit,
            openPositions: positions.length,
            unknownCount,
          })
          if (!verdict.breach) continue

          // Disarm THIS account only, via its per-account override. The master
          // flag is never touched here — the panic button stays the owner's.
          const key = es.disarmAccount(db, acctId)
          log(`EQUITY STOP ${acctId}: ${verdict.reason} — closing ${positions.length} position(s), ${key}=false (master untouched)`)

          let closed = 0
          for (const pos of positions) {
            try {
              const outcome = await executeBrokerAction(db, s, pos, { action: 'FULL_EXIT', reason: 'equity_stop_daily_drawdown' }, 'equity_stop')
              closed++
              s.updatePositionCheck.run(
                'EQUITY_STOP',
                `${verdict.reason} | ${outcome.error || outcome.summary || outcome.reason || 'closed'}`,
                new Date().toISOString(),
                'broken',
                pos.id
              )
            } catch (err) {
              log(`Equity stop close failed for ${pos.symbol} on ${acctId}:`, err.message)
            }
          }

          // MAKE IT VISIBLE. The owner's complaint was not just that trading
          // stopped, it was that nothing on screen said why — the old version
          // only wrote to stdout. action_log for the ops journal, decision_log
          // for the per-account feed, Telegram for the push, all naming the
          // account.
          es.recordDisarm(db, { accountId: acctId, reason: verdict.reason, pnl: verdict.pnl, cap: verdict.cap, positionsClosed: closed })
          try {
            // Imported here, not at module scope — decision-log is loaded
            // lazily at every other call site in this file for the same reason
            // (keeps the loop's cold-start import graph small).
            const { recordDecision } = await import('./services/decision-log.js')
            recordDecision(db, {
              accountId: acctId,
              stage: 'equity_stop',
              decision: 'halt',
              reason: verdict.reason,
              detail: { pnl: verdict.pnl, cap: verdict.cap, positionsClosed: closed, unknownCount },
            })
          } catch { /* the decision feed must not block the stop */ }
          if (process.env.TELEGRAM_BOT_TOKEN) {
            try {
              const { sendMessage } = await import('./services/telegram.js')
              await sendMessage(`🛑 EQUITY STOP on account ${acctId}: daily loss ${verdict.pnl.toFixed(2)} breached its cap ${Math.abs(verdict.cap).toFixed(2)}. ${closed} position(s) closed. Autotrade DISARMED FOR THIS ACCOUNT ONLY — other accounts keep their own switches.`)
            } catch { /* non-fatal */ }
          }
        }
      } catch (err) {
        log('Equity stop check failed:', err.message)
      }

      // ---------------------------------------------------------------------
      // 4c. PERFORMANCE BREAKER — the "all hands on deck" checkpoint. Equity
      // stop catches a bad DAY; adaptive breaker catches a bad STREAK on one
      // strategy; this catches a structurally bad EDGE that never strings 3
      // losses in a row but still bleeds — same rolling profit-factor/
      // expectancy numbers the Desk Performance panel shows (owner: "what
      // checkpoints would trigger all hands on deck").
      // ---------------------------------------------------------------------
      try {
        phase('performance breaker')
        const { runPerformanceBreaker } = await import('./services/performance-breaker.js')
        const pb = runPerformanceBreaker(db, {
          notify: (text) => import('./services/telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
        })
        if (pb.triggered) log(`Performance breaker: PF ${pb.stats.profitFactor} over ${pb.stats.trades} trades${pb.autoDisarmed ? ' — autotrade disarmed' : ''}`)
      } catch (err) {
        log('Performance breaker failed (non-fatal):', err.message)
      }
    } // end symbolsJson

    // -----------------------------------------------------------------------
    // 4. QUANT PHASE — every 6th loop (~30 min)
    // -----------------------------------------------------------------------
    if (loopCount % 6 === 0) {
      phase('quant')
      log('Quant phase — computing regime + performance snapshot')
      try {
        // Regime from REAL price structure, not the bot's own scan confidence
        // (the audit's Class-1A/2 finding: the old regime averaged scan
        // confidence — diluted by every 'skip' — into 'quiet'/'ranging' and
        // wrote that same number into atr_pct labelled "ATR%"; the gate it
        // feeds therefore blocked almost nothing). Now: Wilder ADX + DI for
        // trend strength/direction, an ATR-expansion ratio for volatility, and
        // a real ATR% — emitting the same four labels regime-gate.js expects.
        const recentScans = db.prepare(
          `SELECT DISTINCT symbol FROM scans WHERE scanned_at > datetime('now', '-6 hours')`
        ).all()

        const { computeRegime } = await import('./services/regime.js')
        const { getRegimeBars } = await import('./services/fib-strategy.js')
        const clientId = ctraderEnv('clientId')
        const clientSecret = ctraderEnv('clientSecret')
        const accessToken = getState(db, 'ctrader_access_token')
        const accountId = getState(db, 'ctrader_account_id')
        const isLive = getState(db, 'ctrader_is_live') === 'true'
        const host = isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
        const regimeSymbolMap = JSON.parse(getState(db, 'symbol_id_map') || '{}')
        const regimeCreds = { host, clientId, clientSecret, accessToken, accountId }
        const insRegime = db.prepare(
          `INSERT INTO regimes (symbol, regime, trend_direction, atr_pct, computed_at)
           VALUES (?, ?, ?, ?, datetime('now'))`
        )
        let regimeWritten = 0
        for (const { symbol } of recentScans) {
          const sid = regimeSymbolMap[String(symbol).toUpperCase()]
          if (!sid) continue
          try {
            const { bars } = await getRegimeBars(regimeCreds, sid)
            const r = computeRegime(bars)
            // Never write a fabricated regime — an unknown one fails the gate
            // OPEN, exactly like the rest of the risk chain.
            if (r.regime === 'unknown') continue
            insRegime.run(symbol, r.regime, r.trendDir, r.atrPct)
            regimeWritten++
          } catch { /* one symbol's fetch must not sink the quant phase */ }
        }
        log(`Regime (ADX/ATR) computed for ${regimeWritten}/${recentScans.length} scanned symbols`)

        // Performance snapshot from closed trades
        const stats = db.prepare(
          `SELECT COUNT(*) as total,
                  SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) as wins,
                  SUM(CASE WHEN net_pnl <= 0 THEN 1 ELSE 0 END) as losses,
                  SUM(net_pnl) as total_pnl,
                  AVG(CASE WHEN net_pnl > 0 THEN net_pnl END) as avg_win,
                  AVG(CASE WHEN net_pnl <= 0 THEN net_pnl END) as avg_loss
           FROM trades WHERE status = 'closed'`
        ).get()

        if (stats && stats.total > 0) {
          const winRate = stats.wins / stats.total
          // TRUE profit factor = gross win / gross loss. The old formula was
          // |avg_win / avg_loss| — the PAYOFF ratio, which ignores how OFTEN
          // you win, so at a 19% win rate it overstated PF ~4x (a real 0.15
          // showed as ~0.64). Reconstruct the gross sums from the averages ×
          // counts. Same null-on-no-losses convention as performance-breaker.
          const grossWin = (stats.avg_win || 0) * stats.wins
          const grossLoss = Math.abs((stats.avg_loss || 0) * stats.losses)
          const profitFactor = grossLoss > 0
            ? Math.round((grossWin / grossLoss) * 100) / 100
            : (grossWin > 0 ? null : 0)
          db.prepare(
            `INSERT INTO performance_snapshots (total_trades, winning_trades, losing_trades, win_rate, profit_factor, total_pnl, avg_win, avg_loss, computed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          ).run(stats.total, stats.wins, stats.losses, winRate, profitFactor, stats.total_pnl, stats.avg_win, stats.avg_loss)
        }

        // Live correlation matrix (owner: "I want the live-computed
        // version") — held positions + watchlist, correlated on recent 1h
        // returns, cached for the risk gate's live-correlation veto.
        try {
          const clientId = ctraderEnv('clientId')
          const clientSecret = ctraderEnv('clientSecret')
          const accessToken = getState(db, 'ctrader_access_token')
          const accountId = getState(db, 'ctrader_account_id')
          const isLive = getState(db, 'ctrader_is_live') === 'true'
          const host = isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
          if (clientId && clientSecret && accessToken && accountId) {
            const symbolMap = (() => { try { return JSON.parse(getState(db, 'symbol_id_map') || '{}') } catch { return {} } })()
            const held = db.prepare(`SELECT DISTINCT symbol FROM monitored_positions WHERE status = 'active'`).all().map(r => r.symbol)
            // `symbols` (the scan-phase list) isn't in scope in the quant
            // phase — use held positions plus whatever the recent scans
            // covered, which is what actually needs correlating.
            const corrSymbols = [...new Set([...held, ...recentScans.map(r => r.symbol)])].filter(sym => symbolMap[String(sym).toUpperCase()])
            const { computeAndStoreMatrix } = await import('./services/correlation-matrix.js')
            const res = await computeAndStoreMatrix(db, corrSymbols, {
              maxSymbols: 24,
              fetchBars: async (sym, tf, count) => {
                const byTf = await wsGetTrendbarsBatch(host, clientId, clientSecret, accessToken, accountId, symbolMap[String(sym).toUpperCase()], [tf], count, 20_000)
                return byTf[tf] || []
              },
            }, new Date().toISOString())
            if (res.built) log(`Correlation matrix: ${res.built} symbols`)
          }
        } catch (err) {
          log('Correlation matrix failed (non-fatal):', err.message)
        }
      } catch (err) {
        log('Quant phase error:', err.message)
      }
    }

    // -----------------------------------------------------------------------
    // 5. HOUSEKEEP
    // -----------------------------------------------------------------------
    setState(db, 'loop_count', String(loopCount))
    setState(db, 'last_loop_ms', String(Date.now() - start))

    // LLM daily cost cap — owner-armed, alerts once per day when crossed.
    try {
      const { checkSpendAlert } = await import('./services/llm-spend.js')
      checkSpendAlert(db, {
        notify: (text) => import('./services/telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
      })
    } catch { /* non-fatal */ }

    // Daily journal — once per UTC day, yesterday's trading written down
    // (trades, net, win rate, gate pressure) to Telegram + agent_state.
    try {
      const { sendDailyJournal } = await import('./services/journal.js')
      await sendDailyJournal(db)
    } catch { /* non-fatal */ }

    await hbeat(db, 'main_loop')
  } catch (err) {
    console.error('[loop] error:', err.message)
    await hbeat(db, 'main_loop', false, err.message)
    consecutiveErrors++
    recordError(db, 'loop', err.message)

    if (consecutiveErrors >= 5) {
      const backoff = Math.min(15 * 60_000, loopIntervalMs(db) * consecutiveErrors)
      log(`Self-healing: ${consecutiveErrors} consecutive errors — backing off ${Math.round(backoff / 60000)}m`)
      // Persist the breakdown on the way out too: the phase that was running
      // when a cycle died is exactly the one worth seeing.
      closePhases()
      loopRunning = false
      lastLoopActivityAt = Date.now()
      setTimeout(() => runLoop(db).catch(err => console.error('[loop] unhandled:', err.message)), backoff)
      return
    }
  }

  consecutiveErrors = 0
  setState(db, 'circuit_breaker_tripped_at', null)

  // ---- Housekeeping: data retention (once per 100 loops ≈ 8 hours) ----
  if (loopCount % 100 === 0) {
    try {
      phase('housekeeping')
      const cutoff30d = new Date(Date.now() - 30 * 86400_000).toISOString()
      const cutoff90d = new Date(Date.now() - 90 * 86400_000).toISOString()
      const d1 = db.prepare('DELETE FROM scans WHERE scanned_at < ?').run(cutoff30d)
      const d2 = db.prepare('DELETE FROM signals WHERE recorded_at < ?').run(cutoff30d)
      const d3 = db.prepare('DELETE FROM regimes WHERE computed_at < ?').run(cutoff30d)
      const d4 = db.prepare('DELETE FROM risk_events WHERE created_at < ?').run(cutoff90d)
      const { pruneDecisionLog } = await import('./services/decision-log.js')
      const d5 = pruneDecisionLog(db)
      const { prunePositionEvents } = await import('./services/position-events.js')
      const d6 = prunePositionEvents(db)
      // Long-horizon ledger retention (hardening 6c): closed trades +
      // postmortems past ~2 years (retention_json overrides; null disables).
      const { pruneTradeHistory, pruneOperationalTables } = await import('./services/retention.js')
      const d7 = pruneTradeHistory(db)
      // Owner-approved 01-08 ("approve retention") — the three tables that
      // grew production's DB to 526MB, cup_handle_diagnostics alone 40%.
      const d8 = pruneOperationalTables(db)
      // Phase-flag tracer rows: tiny, but unbounded is unbounded. 90 days
      // matches risk_events — flips older than that are history, not evidence.
      try { db.prepare("DELETE FROM phase_flag_trace WHERE at < datetime('now', '-90 days')").run() } catch { /* housekeeping */ }
      log(`Housekeeping: pruned ${d1.changes} scans, ${d2.changes} signals, ${d3.changes} regimes, ${d4.changes} risk_events, ${d5} decisions, ${d6} position_events, ${d7.trades} old trades, ${d7.postmortems + d7.orphanPostmortems} postmortems, ${d8.cupHandle} cup-handle diags, ${d8.analyses} analyses, ${d8.actionLog} action-log rows`)
    } catch (err) {
      log('Housekeeping error:', err.message)
    }
  }

  loopRunning = false
  lastLoopActivityAt = Date.now()
  const elapsed = Date.now() - start
  const delay = Math.max(10_000, loopIntervalMs(db) - elapsed)
  closePhases()
  setState(db, 'loop_phase', `sleeping ${Math.round(delay / 1000)}s`)
  console.log(`[diag] LOOP #${loopCount} end ${elapsed}ms — next in ${Math.round(delay / 1000)}s`)
  log(`Loop #${loopCount} done in ${elapsed}ms — next in ${Math.round(delay / 1000)}s`)
  setTimeout(() => runLoop(db).catch(err => console.error('[loop] unhandled:', err.message)), delay)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Loop watchdog (owner-approved 2026-07-27, audit F-L7-06/OQ-4): the loop
// hung mid-cycle four times in one day — each hang left every open position
// unmanaged until a HUMAN noticed and restarted Railway. This is the floor
// under that: a plain timer (an unresolved await in a phase does not block
// the event loop, so this timer still fires) that exits the process when no
// cycle has started or finished for too long. Railway's restartPolicyType
// ON_FAILURE brings it straight back up.
//
// Two limits, because "quiet" means different things mid-cycle vs. between:
//  - mid-cycle (loopRunning): a cycle normally takes ≤2 min; stuck past
//    LOOP_WATCHDOG_MINUTES (default 12) = a hung await → exit.
//  - between cycles: the error path legitimately backs off up to 15 min, so
//    only a gap past ~2× that means the setTimeout re-arm chain itself died.
// A tripped circuit breaker is a DELIBERATE halt awaiting a human reset —
// never watchdog-restarted (a fresh process would zero consecutiveErrors and
// defeat the breaker). Set LOOP_WATCHDOG_MINUTES=0 to disable.
// ---------------------------------------------------------------------------
function startLoopWatchdog(db) {
  const minutes = Number(process.env.LOOP_WATCHDOG_MINUTES ?? 12)
  if (!(minutes > 0)) { log('Loop watchdog DISABLED (LOOP_WATCHDOG_MINUTES=0)'); return }
  const midCycleMs = minutes * 60_000
  const idleMs = Math.max(midCycleMs, 30 * 60_000)
  log(`Loop watchdog armed: mid-cycle limit ${minutes}m, idle limit ${idleMs / 60_000}m`)
  const t = setInterval(() => {
    try {
      const quietMs = Date.now() - lastLoopActivityAt
      const limit = loopRunning ? midCycleMs : idleMs
      if (quietMs < limit) return
      if (getState(db, 'circuit_breaker_tripped_at')) return
      const phase = getState(db, 'loop_phase') || 'unknown'
      const startedAt = getState(db, 'loop_started_at') || 'unknown'
      const detail = { phase, loopCount, loopRunning, startedAt, quietMin: Math.round(quietMs / 60_000), limitMin: limit / 60_000 }
      console.error(`[watchdog] LOOP HUNG — no cycle activity for ${detail.quietMin}m (limit ${detail.limitMin}m), stuck in phase "${phase}" (loop #${loopCount}, started ${startedAt}). Exiting for a Railway auto-restart.`)
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('WATCHDOG_EXIT', '/loop', JSON.stringify(detail))
      } catch { /* the exit itself is the point */ }
      process.exit(1)
    } catch { /* watchdog must never throw */ }
  }, 60_000)
  t.unref?.()
}

export function startLoop(db) {
  log('Agent loop starting...')
  setTimeout(() => runLoop(db), 5000) // 5s delay on startup
  startLoopWatchdog(db)
  // Fast position monitor — 30s ticker, volume-aware cadence per open
  // position (owner: active positions are watched in ~1 minute, not 5).
  import('./services/fast-monitor.js')
    .then(m => m.startFastMonitor(db, getCtraderCreds))
    .catch(err => log('fast-monitor failed to start:', err.message))
  // Tick-driven guardian — live spot subscription on symbols with open
  // positions; guard sweeps fire on price movement, the loop stays the
  // guaranteed backstop (owner: attention proportional to risk).
  import('./services/guardian.js')
    .then(m => m.startGuardian(db, getCtraderCreds))
    .catch(err => log('guardian failed to start:', err.message))
  // Virtual Pending Order feeder — pushes real trendbars + real risk.js
  // sizing to the C++ sidecar (agent_state `vpo_enabled`, off by default).
  // No-ops immediately (cheap agent_state read) when VPO isn't configured.
  import('./services/vpo-feeder.js')
    .then(m => m.startVpoFeeder(db))
    .catch(err => log('vpo-feeder failed to start:', err.message))
  return { getLoopCount: () => loopCount }
}
