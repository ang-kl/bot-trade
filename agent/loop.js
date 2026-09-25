// ---------------------------------------------------------------------------
// agent/loop.js — Main 5-minute scan loop
// ---------------------------------------------------------------------------

import { createLLMClient } from './lib/llm-provider.js'
import { disarmReason } from './lib/env-disarm.js'
import { runFibScan, synthesizeFibSignal } from './services/fib-strategy.js'
import { scannerObserver, startScannerBridge } from './services/scanner-feed.js'
import { recordScannerWork } from './services/scanner-work.js'
import { enabledStrategies } from './services/strategies.js'
import { scanStageStrategies, scanFilterOptions, tradeStageGate, anyAccountTradeGate, manageStageAllows } from './services/stage-matrix.js'
import { runMonitorCheck } from './services/monitor-svc.js'
import { evaluatePosition } from './services/position-manager.js'
import { rulesForSymbol } from './services/asset-controllers.js'
import { loadManagedExit, managedExitApplies, managedCapAt, applyManagedRules } from './services/managed-exit.js'
import { recordTradePlan } from './services/trade-plans.js'
import { runWeekendPositionCheck } from './services/weekend-watch.js'
import { evaluateTrade, loadRiskConfig, persistRiskEvent, persistPostApprovalVeto, getAccountBalance, accountMarginPool, scanRates } from './services/risk.js'
import { journalMarginPoolState } from './services/margin-pool-journal.js'
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
import { getCtraderCreds, getSymbolMap, attachEntryFence } from './lib/ctrader-creds.js'
import { managePendingOrders } from './services/pending-orders.js'
import { isProducerRetired } from './lib/entry-producers.js'
import { admitEntry } from './services/entry-mode.js'
import { configureInflight, inflightSummary, describeCall, maybeStamp as maybeStampInflight } from './lib/inflight.js'
import { ctraderEnv } from './lib/ctrader-env.js'
import { reconcilePositions } from './services/reconciler.js'
import { reconcileCrossSideAccounts } from './services/cross-side-reconcile.js'
import { checkRegimeGate, latestRegime } from './services/regime-gate.js'
import { recordRegimeBlock, recordEvidenceShadow } from './services/gate-skips.js'
import { accountPregate, proposalPregate, invalidateAccountPregate } from './services/account-pregate.js'
import { markTickRepush } from './services/tick-permits.js'
import { recordPositionEvent } from './services/position-events.js'
import { recordError } from './services/error-log.js'
import { startLagMonitor, sampleLag, markLagPhase } from './services/event-loop-lag.js'
import { noteLoopEnd, stampFirst } from './services/runtime-record.js'
import { startPhaseProfile, stopPhaseProfile } from './services/cpu-profile.js'
import { recordLlmMonitorResult, shouldAlert, markAlerted } from './services/llm-monitor-health.js'
import { armedTimeframes, armedScopeGate } from './lib/timeframes.js'
import { getState, setState, closeTradeRow, insertCupHandleDiagnostic } from './db.js'
import { llmBlocked } from './lib/llm-switch.js'
// Housekeeping cadence. Wall-clock and persisted, because the loop-counter
// version never fired on a day with deploys — see housekeeping-due.js.
import { housekeepingDue, LAST_RUN_KEY } from './services/housekeeping-due.js'
import { recordFxRates } from './services/fx-rates.js'
import { roundToDigits } from './services/trade-guard.js'
import { cachedAtrForSymbol } from './services/profit-keeper.js'
import { writePerformanceSnapshots } from './services/performance-snapshots.js'

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
// Seeded once per process: see the FIRST-CYCLE SEED block in runLoop.
let crossSideEquitySeeded = false
let consecutiveErrors = 0
let loopRunning = false               // mutex — prevents concurrent iterations
let lastLoopActivityAt = Date.now()   // watchdog: stamped at cycle start/end
let pendingPhaseInFlight = false      // a budget-abandoned pending phase still executing detached
// Wave 5 (§K·15): the pending-order producer is retired in the inventory
// (lib/entry-producers.js) — fib_618_fade is OFF on every account, and the
// phase logged `Pending orders skipped: fib_618_fade not trade-armed` every
// cycle. Read once; the phase below is not scheduled and says so at boot.
const PENDING_PRODUCER_RETIRED = isProducerRetired('pending_fib_orders')
// Owner order 20-09-2026 ("retire the intraday paths, keep momentum only"):
// the SCAN's resting-limit producer is retired in the inventory, so no limit
// is rested for the next open on the scan's behalf. Read once, for the boot
// line only: the refusal itself is the fence's, keyed on the CALLING
// producer (see the closed-market branch in autoTrade), because the momentum
// account and the manual_assisted routes rest their own entries through the
// same module and must keep doing so. The STALE-LIMIT SWEEP is deliberately
// NOT retired — it reconciles rows already at the broker, and retiring a
// producer stops NEW entries only.
const CLOSED_MARKET_PRODUCER_RETIRED = isProducerRetired('closed_market_limits')

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
async function runBudgetedSubPhase(db, name, startWork, budgetMs = SUB_PHASE_BUDGET_MS, { beatOk = false } = {}) {
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
  // Only a sub-phase that does not beat for itself asks for this: its
  // FAILED beat above would otherwise stand until the next overrun, with no
  // success ever clearing it. Phases that beat inside their own work must
  // not be overwritten here — that would mask a failure they reported.
  if (beatOk) await hbeat(db, name, true)
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

export async function autoTrade(db, symbol, synth, watchlistItem, accountOverride, opts = {}) {
  // P1b: which producer this dispatch is, for the entry fence. Callers name
  // themselves (book, momentum account, burn-in, the routes); the ordinary
  // scan path is the default.
  const producerId = opts.producerId || accountOverride?.producerId || 'scan_dispatch'
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

  // THE RETIRED-PRODUCER FENCE, asked here with the proposal in hand (owner
  // order 20-09-2026). admitEntry is the one structural fence and it refuses
  // this producer wherever it is asked — exec-engine re-asks it at the last
  // Node boundary — but asking HERE is what gives the refusal its levels, so
  // the scan's proposals are scored by the refusal ledger for forgone R
  // instead of ending as a rejected trades row. Only a RETIRED refusal stops
  // the path here; every other verdict is left to the boundary, unchanged.
  {
    const retired = admitEntry(db, {
      // WP-A: no basis named — admitEntry takes it from the registered
      // producer, so a tick producer here reads entry_mode_basis, never a
      // producer_basis_conflict against a hardcoded 'bar'.
      accountId, producerId,
      proposal: {
        symbol, side, entry: synth.entry ?? null, sl: synth.sl ?? null,
        tp1: synth.tp1 ?? null, tp2: synth.tp2 ?? null, requestedVolume: requestedVol,
        strategy: synth.strategy || null, timeframe: synth.timeframe ?? null,
        conviction: synth.overall_conviction ?? null, source: synth.source || 'auto_signal',
      },
    })
    if (!retired.ok && retired.retired) {
      log(`RETIRED ${symbol} ${side} ${synth.strategy || '?'} (${producerId}): proposal recorded, no order placed`)
      return null
    }
  }

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
    // THE RETIREMENT IS KEYED ON THE PRODUCER, NOT ON THIS BRANCH (fix round,
    // 20-09-2026). `closed_market_limits` is the SCAN's resting-limit
    // producer and is retired with the scan — but the momentum account and
    // the manual_assisted routes rest their own entries through the same
    // module, and a branch-level guard retired those too. The caller's own
    // producer id travels with the fence and with the placement: a retired
    // caller is refused inside placeClosedMarketLimit (and never reaches
    // here anyway, having been refused at the top of autoTrade), a kept one
    // rests its limit exactly as before.
    try {
      const { placeClosedMarketLimit } = await import('./services/closed-market-limits.js')
      const r = await placeClosedMarketLimit(
        db,
        attachEntryFence(db, { host: isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com', clientId, clientSecret, accessToken, accountId }, { producerId }),
        symbol, synth,
        { producerId, requestedVolume: requestedVol, notify: (t) => import('./services/telegram-control.js').then(m => m.notifyOwner(t)).catch(() => {}) }
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

  // EVIDENCE GATE (owner "build it", 03-09-2026): a strategy trades live on
  // this account only where the owner hand-pinned it or where its own live
  // record clears the pre-registered bar; otherwise the proposal is refused
  // and the refusal IS its shadow record (the risk event carries the full
  // proposal). Runs before both dispatch paths. Fail-open on a read error —
  // a gate that cannot be read must not become a silent disarm of everything.
  try {
    const { evidenceGate } = await import('./services/evidence-gate.js')
    const eg = evidenceGate(db, { strategy: synth.strategy || null, accountId })
    if (!eg.allowed) {
      // PR-C: a decision_log SKIP carrying the full proposal (its shadow
      // record), not a risk_events veto — see services/gate-skips.js for
      // what read the old rows and where each reader looks now.
      recordEvidenceShadow(db, { symbol, side, synth, accountId, requestedVolume: requestedVol, gate: eg, loopId: loopCount })
      log(`SHADOW ${symbol} ${side} ${synth.strategy || '?'} on ${accountId}: ${eg.reason}`)
      return null
    }
  } catch (err) {
    log(`Evidence gate skipped (fail-open): ${err.message}`)
  }

  // HIGH-TIMEFRAME SIGNALS REST AS A LIMIT (owner-approved, 03-09-2026). A
  // strategy prices its entry at the last CLOSED bar's close and the scan
  // refreshes a series once per bar, so a market order on a 1d or 1w signal
  // reaches that price up to a bar late — NAS100 1w sat 1.2% from its
  // Friday close for three days and the entry-drift gate refused every
  // attempt. Such a signal now rests at the approved entry and expires when
  // the bar that produced it closes; the same gate, sizing, idempotency and
  // adoption as the closed-market path. Sub-threshold signals keep the
  // market path and the drift gate below. '' / 'off' disables.
  try {
    const { tfMs, nextBarCloseMs } = await import('./lib/timeframes.js')
    const htf = loadRiskConfig(db, accountId)?.htfLimitDispatch
    const minTf = String(htf?.minTf ?? '').trim().toLowerCase()
    const minMs = minTf && minTf !== 'off' ? tfMs(minTf) : 0
    const sigMs = synth.timeframe ? tfMs(synth.timeframe) : 0
    // BACKTEST-PARITY WINDOW (owner "build it", 03-09-2026): the backtester
    // fills at the NEXT bar's open, so inside htfLimitDispatch.freshnessMin after the
    // signal bar closed a market order (with the drift gate) IS the
    // backtested entry; the resting limit is the fallback for the rest of
    // the bar. A synth that says marketOnly (the momentum book, priced at
    // the live quote) never rests.
    const freshMin = Number(htf?.freshnessMin) || 0
    const lastBarCloseMs = sigMs > 0 ? (nextBarCloseMs(synth.timeframe) ?? 0) - sigMs : 0
    const fresh = freshMin > 0 && lastBarCloseMs > 0 && (Date.now() - lastBarCloseMs) <= freshMin * 60_000
    if (minMs > 0 && sigMs >= minMs && synth.marketOnly !== true && !fresh) {
      const expiresAtMs = nextBarCloseMs(synth.timeframe)
      const { placeClosedMarketLimit } = await import('./services/closed-market-limits.js')
      const r = await placeClosedMarketLimit(
        db,
        attachEntryFence(db, { host: isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com', clientId, clientSecret, accessToken, accountId }, { producerId }),
        symbol, synth,
        {
          producerId, requestedVolume: requestedVol, reason: 'htf', expiresAtMs,
          notify: (t) => import('./services/telegram-control.js').then(m => m.notifyOwner(t)).catch(() => {}),
        },
      )
      if (r.placed) log(`HTF ${synth.timeframe} signal — resting LIMIT for ${symbol} @ ${r.limitPrice} (expires at the bar's close, ${r.expiresAt})`)
      else if (r.skipped !== 'already_working') log(`HTF limit for ${symbol} ${synth.timeframe}: ${r.skipped}${r.reason ? ` — ${r.reason}` : ''}`)
      return null
    }
  } catch (err) {
    log(`HTF limit dispatch failed for ${symbol} (non-fatal, no market order placed): ${err.message}`)
    return null
  }

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
    // Scoped to the account this order is for (02-09-2026): one account's
    // stop hunts must not widen another's stops.
    const tuned = applySlWiden({ strategy: synth.strategy, entry: synth.entry, sl: synth.sl }, loadLessonTuning(db, accountId))
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

  // PR-D (owner principle 8): the trend reading the regime table holds for
  // this symbol at the moment of evaluation, recorded beside the strategy's
  // own direction reason so a later read of proposal_json can say what the
  // bot knew about the trend when it chose the side. null when no reading.
  let trendAtEvaluation = null
  try {
    const rr = latestRegime(db, symbol)
    trendAtEvaluation = rr ? { regime: rr.regime ?? null, trend_direction: rr.trend_direction ?? null, computed_at: rr.computed_at ?? null, stale: !!rr.stale } : null
  } catch { trendAtEvaluation = null }

  const proposal = {
    symbol,
    side,
    // PR-D: the direction reason stated by the strategy where it assigned its
    // bias (or `override:<reason>` for a reasoned watchlist override). null is
    // a visible gap, never a fabricated reason. Rides proposal_json.
    direction_reason: synth.direction_reason ?? null,
    trend_at_evaluation: trendAtEvaluation,
    entry: synth.entry ?? null,
    sl: synth.sl ?? null,
    tp1: synth.tp1 ?? null,
    // Second ladder level (runner target) — display-only for the order log's
    // TP cell; the broker order carries tp1, the manager banks the partial.
    tp2: synth.tp2 ?? null,
    requestedVolume: requestedVol,
    strategy: synth.strategy || null,
    // The bars the signal was computed on — rides into risk_events so a
    // refused setup can be replayed at its own timeframe (§7,437·B·2).
    timeframe: synth.timeframe ?? null,
    conviction: synth.overall_conviction ?? null,
    // Vol-target size from the momentum-account pass (§7,386·D1). The gate
    // honours it only on the momentum account for tsmom_long; elsewhere it
    // is recorded and ignored.
    sizing: synth.sizing ?? null,
    sizedVolume: synth.sizedVolume ?? null,
    // E·2: how many accounts this same signal reached the gate for, counted
    // by the dispatcher's fan-out; the gate splits each account's budget by
    // it. Null on a single-account dispatch.
    sharedAccounts: opts.sharedAccounts ?? accountOverride?.sharedAccounts ?? null,
    // Provenance for the order log: who fired this attempt (auto_signal |
    // validation_fill | …). Rides inside proposal_json — no schema change.
    source: synth.source || 'auto_signal',
    // Gate THIS account, not the selected one. The order below is placed with
    // this account's creds, so a gate that read a different account's open
    // positions would approve a duplicate every cycle.
    accountId,
  }
  const riskCfg = loadRiskConfig(db, accountId)
  const riskResult = evaluateTrade(db, proposal, riskCfg)
  // §70.9: hold the approval's own row id so the trade it produces can name it.
  const riskEventId = persistRiskEvent(db, proposal, riskResult)
  if (!riskResult.approved) {
    log(`RISK VETO ${symbol} ${side}: ${riskResult.veto_reason}`)
    await alertVetoOnce(db, symbol, side, riskResult.veto_reason)
    return null
  }
  const volLots = riskResult.adjusted_volume
  if (Math.abs(volLots - requestedVol) > 0.001) {
    log(`Risk sizing: ${symbol} ${requestedVol} → ${volLots} (${riskResult.sizing_note})`)
  }
  // STRETCHED TARGET (§7,522·B): the gate admitted this setup at a wider
  // bracket than the signal proposed. Everything below — the order's
  // relative take profit, the trades row, the fill anchor, the plan — reads
  // synth.tp1, so the override lands there once, here, with the reason.
  if (riskResult.target_override?.tp1 != null) {
    log(`Risk target: ${symbol} tp1 ${synth.tp1} → ${riskResult.target_override.tp1} (${riskResult.target_override.from}R → ${riskResult.target_override.rr}R, earned-floor stretch)`)
    synth = { ...synth, tp1: riskResult.target_override.tp1, tp1_price: riskResult.target_override.tp1 }
  }
  // WIDENED STOP (E·1): the gate floored the stop at `minStopAtrMult` hourly
  // ATRs and sized the volume on that stop. Everything below — the order's
  // relative stop, the trades row, the fill anchor — reads synth.sl, so the
  // override lands there once, here, with the reason.
  if (riskResult.stop_override?.sl != null) {
    const so = riskResult.stop_override
    log(`Risk stop: ${symbol} sl ${so.from} → ${so.sl} (hourly ATR ${so.atr1h} × ${so.mult} floor, ${so.source})`)
    synth = { ...synth, sl: so.sl, ...(synth.sl_price != null ? { sl_price: so.sl } : {}) }
  }

  // We need symbolId — THIS ACCOUNT's id (03-09-2026). The global
  // symbol_id_map belongs to the account it was built from; on ACCT-LIVE-1
  // its ids for LLY.US and GD.US were other instruments (read at 6.56 and
  // 11.52 against 1,159 and 364 on the demos) and a live limit went out at
  // 6.56. resolveSymbolId reads the account's own symbol list and refuses
  // with a reason when it cannot verify the id — a wrong instrument is worse
  // than no order.
  const { resolveSymbolId } = await import('./lib/ctrader-creds.js')
  const resolvedSymbol = await resolveSymbolId(db, {
    host: isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com', clientId, clientSecret, accessToken, accountId, ready: true,
  }, symbol)
  const symbolId = resolvedSymbol.id
  if (!symbolId) {
    // §70.8: THE ONLY GENUINELY SILENT DROP ON THIS PATH. The gate approved,
    // and this returned with nothing but a console line — no risk_events row,
    // no decision_log row. Whoever later asked "why didn't it trade?" could
    // only be told the count did not add up. Now it says so in the ledger.
    const reason = resolvedSymbol.reason || `symbol_id_unknown: ${symbol} is not in symbol_id_map — call POST /actions/symbol-map to register it`
    persistPostApprovalVeto(db, proposal, reason)
    log(`RISK VETO ${symbol} ${side}: ${reason}`)
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
    // ONE DEFINITION OF A LOT. This is the only place that holds the broker's
    // own answer, and until now it was used to place the order and then thrown
    // away — so reconciliation had to fall back to contractSize(), a hardcoded
    // table that returns 1 for every unlisted symbol. Recording it here is what
    // lets an ADOPTED position be converted with the same number the order was
    // placed with. See lib/lot-size-registry.js.
    try {
      const { rememberVolumeMeta } = await import('./lib/lot-size-registry.js')
      // AND THE BROKER'S MINIMUM, which was fetched here on every order and
      // thrown away — the same fate this registry was built to end for the
      // lot size. Measured 17-09: the risk gate sized against a GLOBAL
      // assumed 0.01-lot minimum, approved, and this line then refused the
      // order because the symbol's real minimum was higher. Recording it is
      // what lets the gate refuse BEFORE it spends an approval.
      rememberVolumeMeta(db, symbol, meta)
    } catch { /* non-fatal: sizing must never fail on bookkeeping */ }
    sized = lotsToVolume(volLots, meta)
    if (sized.belowMin) {
      const reason = `below_min_volume: ${volLots} lots (${sized.volume}) < broker minimum ${meta.minVolume} — balance too small for this symbol at the configured risk`
      persistPostApprovalVeto(db, proposal, reason)
      log(`RISK VETO ${symbol} ${side}: ${reason}`)
      await alertVetoOnce(db, symbol, side, reason, "sized volume is below the broker's minimum lot. Raise risk per trade or skip this symbol.")
      return null
    }
  } catch (err) {
    persistPostApprovalVeto(db, proposal, `sizing_failed: ${err.message}`)
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
    // No strategy may waive TP1 here. A synth without a target reaches the
    // shared execution boundary and is refused before either engine sends it.
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
  const driftGateOn = slDistance && Number(riskCfg.maxEntryDriftFracOfSL) > 0
  if (slDistance && (riskCfg.maxSpreadFracOfSL > 0 || driftGateOn)) {
    try {
      const { wsGetSpotOnce } = await import('./lib/ctrader-ws.js')
      const q = await wsGetSpotOnce(host, clientId, clientSecret, accessToken, accountId, symbolId)
      if (q) {
        const spread = q.ask - q.bid
        entrySpread = spread
        if (riskCfg.maxSpreadFracOfSL > 0 && spread > riskCfg.maxSpreadFracOfSL * slDistance) {
          const reason = `spread_too_wide: ${spread.toFixed(5)} > ${(riskCfg.maxSpreadFracOfSL * 100).toFixed(0)}% of SL distance ${slDistance.toFixed(5)}`
          persistPostApprovalVeto(db, proposal, reason)
          log(`RISK VETO ${symbol} ${side}: ${reason}`)
          await alertVetoOnce(db, symbol, side, reason, `spread too wide (${spread.toFixed(5)} vs SL ${slDistance.toFixed(5)}). Likely off-hours/rollover — the signal stays; it can fire next loop when the spread normalises.`)
          return null
        }
        // ENTRY-DRIFT GATE (owner "do both", 03-09-2026). The proposal was
        // approved at ITS entry; a market order fills at the live quote. When
        // the quote has already moved past the entry by more than
        // maxEntryDriftFracOfSL of the stop distance, the trade that would
        // fill is not the trade the gate approved (NATGAS rsi2, 02-09: 0.64R
        // of drift turned a 1.2R plan into a 0.34R trade). The signal is not
        // lost — it can fire next loop if price comes back.
        if (driftGateOn) {
          const { entryDrift, entryDriftVeto } = await import('./lib/fill-anchor.js')
          const drift = entryDrift({ side, proposalEntry: synth.entry, quote: q, slDistance })
          const reason = entryDriftVeto(riskCfg, drift, { symbolDigits })
          if (reason) {
            persistPostApprovalVeto(db, proposal, reason)
            log(`RISK VETO ${symbol} ${side}: ${reason}`)
            await alertVetoOnce(db, symbol, side, reason, `price ran ${(drift.fracOfSL * 100).toFixed(0)}% of the stop distance past the proposal entry before dispatch — the approved R:R no longer exists at this price. The signal stays; it can fire next loop if price comes back.`)
            return null
          }
        }
      }
    } catch (e) {
      log(`Spread/drift gate skipped (fail-open): ${e.message}`)
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
  // The bound is built in the column's own ISO format (lib/submission-dedupe):
  // comparing risk_events.created_at ("…T08:54:36.700Z") against
  // datetime('now', '-20 minutes') ("… 09:35:00") sorted every same-day row
  // ABOVE the bound, so the "20-minute" hold ran until midnight UTC —
  // measured 03-09-2026 on BTCUSD, 61 minutes after the ambiguous row.
  const { recentAmbiguousSubmission } = await import('./lib/submission-dedupe.js')
  const ambiguous = dupe ? null : recentAmbiguousSubmission(db, { symbol, side, accountId, windowMin: DEDUPE_WINDOW_MIN })

  if (dupe || ambiguous) {
    const reason = dupe
      ? `duplicate_submission: trade #${dupe.id} ${side} ${symbol} already recorded at ${dupe.opened_at} (${DEDUPE_WINDOW_MIN}-minute idempotency window)`
      : `duplicate_submission_ambiguous: a ${side} ${symbol} order was submitted at ${ambiguous.created_at} and its outcome is UNKNOWN (risk_event #${ambiguous.id}) — a position may already be open; not resubmitting inside the ${DEDUPE_WINDOW_MIN}-minute window`
    persistPostApprovalVeto(db, proposal, reason)
    try {
      const { recordDecision } = await import('./services/decision-log.js')
      recordDecision(db, { accountId: String(accountId), symbol, timeframe: synth.timeframe, strategy: synth.strategy, stage: 'submission_dedupe', decision: 'veto', reason })
    } catch { /* provenance never blocks */ }
    log(`RISK VETO ${symbol} ${side}: ${reason}`)
    return null
  }

  // HARD CEILING, AT THE SUBMISSION BOUNDARY. The risk gate checks this too,
  // but the seventeen DOW.US orders of 04-08-2026 never reached the gate —
  // they carry risk_event_id NULL and were adopted by the reconciler 89
  // seconds after filling. A ceiling that only the gate enforces is a ceiling
  // the rogue path walks under. Re-read here, immediately before the order
  // leaves, because the count can have changed since the verdict.
  //
  // THROUGH loadRiskConfig, for THIS account (Wave 4b). This used to parse
  // the raw global `risk_config_json` itself, so an account's overlay value
  // and a changed default were both invisible here: the gate honoured them,
  // the submission boundary did not.
  {
    const { checkSymbolCap, DEFAULT_MAX_PER_SYMBOL } = await import('./services/symbol-position-cap.js')
    let capCfg = DEFAULT_MAX_PER_SYMBOL
    try {
      const rc = loadRiskConfig(db, accountId)
      if (Number(rc.maxPositionsPerSymbol) > 0) capCfg = Number(rc.maxPositionsPerSymbol)
    } catch { /* defaults */ }
    const cap = checkSymbolCap(db, { accountId, symbol, cap: capCfg })
    if (!cap.allow) {
      persistPostApprovalVeto(db, proposal, cap.reason)
      try {
        const { recordDecision } = await import('./services/decision-log.js')
        recordDecision(db, {
          accountId: String(accountId), symbol, timeframe: synth.timeframe, strategy: synth.strategy,
          stage: 'symbol_position_cap', decision: 'veto', reason: cap.reason,
        })
      } catch { /* provenance never blocks */ }
      log(`RISK VETO ${symbol} ${side}: ${cap.reason}`)
      return null
    }
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
    // proposal_entry_price and analysis_id (02-09-2026): the intended entry
    // survives the fill being reconciled over entry_price, so slippage can be
    // computed later; and the analysis row that produced this order is
    // linked, so a scan bias can be scored against its outcome — 3,935
    // auto-trade predictions in 25 h had no outcome link before this.
    const intentId = db.prepare(`
      INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume,
                          opened_at, status, strategy, account_id, source, risk_event_id,
                          origin, origin_source, proposal_entry_price, analysis_id)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'submitting', ?, ?, 'autotrade', ?,
              'bot_market_dispatch', 'write', ?, ?)
    `).run(
      symbol, side, synth.entry ?? null, synth.sl ?? null, synth.tp1 ?? null,
      volLots, synth.strategy || null, String(accountId), riskEventId ?? null,
      Number.isFinite(Number(synth.entry)) ? Number(synth.entry) : null,
      Number.isFinite(Number(synth.analysisId)) ? Number(synth.analysisId) : null,
    ).lastInsertRowid

    // §70.8: stamp the moment the order LEAVES, so verdict -> submit is
    // measurable. entry_latency_ms below times submit -> execution event; the
    // gap this closes is the one an approval goes quiet in.
    try {
      const { recordSubmitted } = await import('./services/opportunity-disposition.js')
      recordSubmitted(db, riskEventId)
    } catch { /* provenance never blocks a submission */ }

    // Invariant 1 (owner, 31-08): decision_log used to record ONLY the
    // negative — no 'proceed' writer existed anywhere, so every denominator
    // computed from it (refusal-at-scale, the audit's `considered`) had to
    // infer admits from the trades table instead of reading them. One row
    // per dispatched order; naturally rate-bounded by the gates above it.
    try {
      const { recordDecision } = await import('./services/decision-log.js')
      recordDecision(db, {
        accountId: String(accountId), symbol, timeframe: synth.timeframe, strategy: synth.strategy,
        stage: 'dispatch', decision: 'proceed',
        reason: `order dispatched: ${side} ${volLots} lots (risk event ${riskEventId ?? 'n/a'})`,
      })
    } catch { /* provenance never blocks a submission */ }

    const submitT0 = Date.now()
    let exec
    try {
      exec = await execPlaceOrder(attachEntryFence(db, { host, clientId, clientSecret, accessToken, accountId, execGuard }, { producerId }), orderPayload)
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
    let executionPrice = exec?.deal?.executionPrice || exec?.position?.price || null
    // normPosId: one exec path returned float-formatted ids ("234698574.0")
    // which broke deal-history P&L matching and duplicate detection.
    const { normPosId } = await import('./lib/pos-id.js')
    const positionId = normPosId(exec?.position?.positionId ?? exec?.deal?.positionId)
    // THE FILL THE ANCHOR NEVER SAW (04-09-2026). The sidecar's order answer
    // is ORDER_ACCEPTED — a position id and no deal — so on the cpp path the
    // price above was null on every market fill and the fill anchoring below
    // never fired (2020.HK: filled 76.21, ledger 75.79, the manager parked
    // the stop 0.18 under the real fill and called it breakeven). The broker
    // holds the fill on the position; read it back, bounded, before any
    // ledger write. No position found → the proposal entry stands, as before.
    // LIVE read, not the sidecar's cache (measured 04-09-2026 18:56 UTC,
    // JPM.US on ACCT-DEMO-1): the first version read `execReconcile`, which
    // on the cpp path serves the sidecar's own periodic reconcile snapshot —
    // a position one second old is not in it, so all three attempts missed
    // and the ledger kept 362.15 against a 358.67 fill. `wsReconcile` asks
    // the broker directly; one authenticated round trip per fill.
    if (executionPrice == null && positionId) {
      const { confirmFill } = await import('./lib/fill-anchor.js')
      const { wsReconcile } = await import('./lib/ctrader-ws.js')
      const confirmed = await confirmFill(() => wsReconcile(host, clientId, clientSecret, accessToken, accountId), positionId)
      if (confirmed != null) {
        executionPrice = confirmed
        log(`Fill confirmed from the position read: ${symbol} ${side} @ ${confirmed} (posId=${positionId})`)
      } else {
        log(`Fill NOT confirmed for ${symbol} posId=${positionId} — the ledger keeps the proposal entry ${synth.entry}`)
      }
    }

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
    // THE BRACKET THE TRADE ACTUALLY HAS (owner "do both", 03-09-2026). The
    // order carried the stop and target as DISTANCES, so the broker anchored
    // them to the fill; the ledger used to keep the proposal's absolute
    // prices, and every later re-assert pushed the proposal-anchored target
    // back onto the fill-anchored position (NATGAS rsi2: 1.2R plan, 0.34R
    // trade). Stored here as the planned distances from the fill — the
    // geometry the gate admitted, at the price the trade exists at. With no
    // confirmed fill the proposal's prices stand, as before.
    const { anchorBracketToFill } = await import('./lib/fill-anchor.js')
    const anchored = anchorBracketToFill({ side, proposalEntry: synth.entry, fill: executionPrice, sl: synth.sl, tp1: synth.tp1, tp2: synth.tp2 })
    const slP = anchored.sl ?? null
    const tpP = anchored.tp1 ?? null
    const initialRisk = (entryP && slP) ? Math.abs(entryP - slP) : null

    let timeCap = null
    if (synth.time_cap_minutes && Number.isFinite(synth.time_cap_minutes)) {
      timeCap = new Date(Date.now() + synth.time_cap_minutes * 60_000).toISOString()
    } else if (managedExitApplies(db, accountId)) {
      // Managed-exit policy cap, WALL-CLOCK (owner, 01-09-2026: a timeframe
      // describes the bars a signal was computed on, never how long the
      // position may live — the old capBars × timeframe form projected a
      // lookback parameter into a forward hold). Signal-declared caps above
      // always win; this is the default for the silence.
      //
      // capMinutes 0 = NO policy cap (One Simple System, 28-08-2026): the
      // trail-distance sweep measured the trail alone above every cap
      // variant, so the default cap is off — only signal-declared caps
      // stamp. Set capMinutes > 0 in managed_exit_json to restore.
      const mePolicy = loadManagedExit(db)
      if (mePolicy.capMinutes > 0) {
        timeCap = managedCapAt(Date.now(), mePolicy.capMinutes)
      }
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
          slippage_price = ?, spread_at_entry = ?, entry_latency_ms = ?,
          broker_sl_initial = COALESCE(?, broker_sl_initial)
        WHERE id = ?
      `).run(
        entryP, slP, tpP, volLots,
        positionId, synth.strategy || null, synth.overall_conviction ?? null,
        parsedLabel.raw, parsedLabel.source, parsedLabel.version,
        parsedLabel.strategy, parsedLabel.conviction, parsedLabel.session,
        parsedLabel.timeframe, parsedLabel.regime,
        synth.confluenceCount ?? null,
        String(accountId),
        slippagePrice, entrySpread, entryLatencyMs,
        // The stop as the broker holds it at the fill, when the ACK carries
        // it; otherwise the reconciler stamps the first stop it observes.
        Number(exec?.position?.stopLoss) > 0 ? Number(exec.position.stopLoss) : null,
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
        tpP,
        synth.synthesis || '',
        initialRisk,
        synth.invalidation_trigger || null,
        timeCap,
        synth.strategy || null,
        parsedLabel.source,
        parsedLabel.raw,
        accountId != null ? String(accountId) : null,
      )

      // THE PLAN, AS PLANNED (§7,437·B·4): the proposal's own entry, stop and
      // target — before the fill anchor moved them — the intended hold and
      // the rule the position will live under, so the close can be scored
      // against what was meant rather than against what the row says by then.
      try {
        recordTradePlan(db, tradeId, {
          accountId, symbol, side, strategy: synth.strategy || null, timeframe: synth.timeframe ?? null,
          entry: synth.entry, sl: synth.sl, tp: synth.tp1, timeCapAt: timeCap, source: synth.source || 'auto_signal',
        })
      } catch (err) { log(`Trade plan not recorded for trade ${tradeId} (non-fatal): ${err.message}`) }

      return tradeId
    })

    const tradeId = persistTrade()
    log(`Auto-trade placed: ${side} ${symbol} @ ${executionPrice} posId=${positionId} tradeId=${tradeId}${anchored.anchored ? ` bracket anchored to fill (shift ${anchored.shift >= 0 ? '+' : ''}${Number(anchored.shift).toFixed(symbolDigits)}, sl ${slP} tp ${tpP})` : ''}`)

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
      persistPostApprovalVeto(db, proposal, `${amb ? 'order_ambiguous' : 'order_failed'}: ${err.message}`)
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
// symbol → `sym|side` of the unreasoned override last refused (logged once per item).
const unreasonedOverrideLogged = new Map()

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
  const analysisIns = s.insertAnalysis.run({
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
  // Carried on the synthesis so the dispatch can link the trade row to the
  // prediction that produced it (trades.analysis_id, 02-09-2026).
  try { synth.analysisId = Number(analysisIns?.lastInsertRowid) || null } catch { /* provenance never blocks */ }

  log(`Analysis complete: ${sym} — ${synth.consensus_bias || '?'} (${synth.overall_conviction || 0}/10) rr=${synth.risk_note || ''}`)
  // Denominator for the armed-gate waste line the analyze phase prints. One
  // count per COMPLETED analysis, under every scope; the numerator is the
  // armed gate below. A rate nobody can read is a rate nobody fixes.
  try {
    const { recordAnalysis } = await import('./services/armed-analysis-filter.js')
    recordAnalysis()
  } catch { /* measurement never blocks a dispatch */ }

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
    // MATRIX WINS OVER THE LIST (owner order, 02-09-2026). The list check
    // used to run first, so 68 of 161 matrix-armed symbol×timeframe cells
    // (3d/4d/12h/8h/1w) could never dispatch under scope 'armed': armed by
    // the autopilot, vetoed by a list nobody had widened. The matrix is the
    // arming authority — a symbol it names trades exactly the timeframes it
    // armed for it, list or no list; the list still gates symbols the matrix
    // does not name (and everything, when there is no matrix). One shared
    // reader and one shared default for the list (lib/timeframes.js) — four
    // modules used to carry their own ['4h','1d'] literal.
    const allowedTfs = armedTimeframes(db, getState)
    let matrix = null
    try { matrix = JSON.parse(getState(db, 'autotrade_matrix_json') || 'null') } catch { matrix = null /* corrupt — list gates */ }
    const scope = armedScopeGate({ symbol: sym, timeframe: synth.timeframe, allowedTfs, matrix })
    if (!scope.ok) {
      log(`${scope.via === 'matrix' ? 'Matrix' : 'Timeframe'} gate: ${sym} blocked — ${scope.reason}`)
      // A discarded analysis is a spent slot. Counted here, at the only place
      // that knows the gate refused, and summarised per pass by the analyze
      // phase — the 38-of-60 figure that motivated the pre-filter above had
      // to be grepped out of 28 minutes of production logs.
      try {
        const { recordArmedGateBlock } = await import('./services/armed-analysis-filter.js')
        recordArmedGateBlock({ symbol: sym, timeframe: synth.timeframe, reason: scope.reason })
      } catch { /* measurement never blocks a dispatch */ }
      synth.auto_trade = false
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

  // Human override: if override_bias is set, use it instead of AI's. It runs
  // BEFORE the regime gate (checker item d, 11-09-2026) so the gate judges
  // the side that will actually be dispatched, not the one it replaced.
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
      // PR-D (owner principle 8): a human flip of the direction must state
      // why. An `override_bias` with no `override_reason` on the watchlist
      // item is REFUSED — the analysis keeps the strategy's side and does
      // not auto-trade — and the refusal is a decision_log row so the
      // silence has a name. A reasoned override becomes the direction_reason.
      const overrideReason = typeof wItem.override_reason === 'string' && wItem.override_reason.trim() ? wItem.override_reason.trim() : null
      if (!overrideReason) {
        // Once per item (checker item g): the same unreasoned flag would
        // otherwise log and write a row every cycle. Re-logged when the
        // requested side changes or the reason is later filled in.
        const memo = `${sym}|${wItem.override_bias}`
        if (unreasonedOverrideLogged.get(sym) !== memo) {
          unreasonedOverrideLogged.set(sym, memo)
          log(`Direction override: ${sym} override_bias=${wItem.override_bias} REFUSED — no override_reason on the watchlist item (every trade has a reason)`)
          try {
            const { recordDecision } = await import('./services/decision-log.js')
            recordDecision(db, { symbol: sym, timeframe: synth.timeframe, strategy: synth.strategy, stage: 'watchlist_override', decision: 'skip', reason: `direction_override_unreasoned override_bias=${wItem.override_bias}` })
          } catch { /* provenance never blocks */ }
        }
        synth.auto_trade = false
      } else {
        unreasonedOverrideLogged.delete(sym)
        if (synth.consensus_bias !== wItem.override_bias && Number.isFinite(Number(synth.entry))) {
          // A FLIP mirrors the bracket about the entry (checker item d): the
          // stop and targets were built for the strategy's side, and a SELL
          // with a stop below entry is an order the broker refuses or, worse,
          // fills with the protection inverted.
          const e = Number(synth.entry)
          const mirror = (v) => (Number.isFinite(Number(v)) ? 2 * e - Number(v) : v)
          synth.sl = mirror(synth.sl); synth.tp1 = mirror(synth.tp1); synth.tp2 = mirror(synth.tp2)
          if (synth.sl_price != null) synth.sl_price = synth.sl
          if (synth.tp1_price != null) synth.tp1_price = synth.tp1
          if (synth.tp2_price != null) synth.tp2_price = synth.tp2
        }
        synth.consensus_bias = wItem.override_bias
        synth.direction_reason = `override:${overrideReason}`
      }
    }
  }

  // Regime gate: don't fade a trend, don't chase a range (owner: "trading
  // like a beginner", PF 0.15). The regimes table was computed but never
  // used to gate entries — this is the fix. Recorded as a decision_log SKIP
  // (PR-C): this is a market-state read upstream of the risk gate, not a
  // gate verdict, and writing it as a veto counted it in every veto total
  // and re-wrote it every cycle the regime held. See services/gate-skips.js.
  if (synth.auto_trade) {
    const rg = checkRegimeGate(db, synth.strategy, synth.consensus_bias, sym)
    if (rg.block) {
      log(`Regime gate: ${sym} blocked — ${rg.reason}`)
      try {
        recordRegimeBlock(db, { symbol: sym, synth, signal, reason: rg.reason, loopId: loopCount })
      } catch { /* provenance never blocks */ }
      synth.auto_trade = false
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
    // margin when the snapshot is fresh (see accountMarginPool in risk.js).
    // PER ACCOUNT, RICHEST FIRST (owner § 7,453·A, 08-09-2026). This used to
    // be `if (portfolioMarginExhausted(db)) return` — ONE account's status
    // (the selected one) ending the dispatch for all five. Now the pool is
    // read once per cycle, accounts are tried in descending headroom, and
    // only an exhausted account is skipped, by name, inside the fan-out.
    const pool = marginPoolForCycle(db)
    if (pool.length && pool.every(p => p.exhausted)) return { fired: false, synth }
    const apAccounts = pool.map(p => p.acct)
    const { accountMayTrade, symbolAllowsStrategy } = await import('./services/watchlists.js')
    const { enabledStrategies } = await import('./services/strategies.js')
    const globalArmed = enabledStrategies(db, getState).map(s => s.key)
    const { effectivePhases } = await import('./services/account-phases.js')
    // Connectivity gate input, fetched ONCE per dispatch: the sidecar's
    // authorized roster. An enabled account the broker session has not
    // authorized cannot receive an order — strategize/size/risk-gate work for
    // it is guaranteed waste, and the submit would only fail downstream.
    // null = unknown (js mode, health blip) → no account is skipped for it.
    //
    // PER SIDE (Phase 2). This used to be ONE roster compared against accounts
    // from both sides. Under a two-sidecar split that is the 05-08 outage
    // rebuilt on purpose: the demo accounts would be measured against the LIVE
    // sidecar's roster, found absent, and skipped here — before the order path
    // that Phase 1 correctly routed was ever reached. With only EXEC_URL set
    // both sides resolve to the same base and the 20s cache makes the second
    // lookup free, so this changes nothing today.
    let sidecarRosters = { live: null, demo: null }
    try {
      const { sidecarRostersBySide } = await import('./lib/exec-engine.js')
      sidecarRosters = await sidecarRostersBySide()
    } catch { /* unknown — fail open on BOTH sides */ }
    // E·2 PRE-PASS: how many accounts share this signal. Counted from the
    // two cycle-level gates every account is asked before any symbol work
    // (margin pool, account pre-gate) so the number is one per signal and
    // known before the first dispatch. A later per-symbol skip (watchlist,
    // strategy, fundable universe, proposal pre-gate, the risk gate itself)
    // leaves the survivors at 1/N of a slightly larger N — the split errs on
    // the side of LESS risk, never more, and checks.shared_signal records N.
    const sharedAccountsForSignal = apAccounts.reduce((n, a) => {
      const pe = pool.find(p => String(p.accountId) === String(a.accountId))
      if (pe?.exhausted) return n
      try { if (!accountPregate(db, a.accountId, { cycle: loopCount }).ok) return n } catch { return n }
      return n + 1
    }, 0)
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
      // MARGIN POOL GATE — this account's own headroom, not the selected
      // account's. Cheapest check first: an account over its cap cannot fund
      // any order this cycle, so nothing below is built for it. The candidate
      // goes on to the next account in the pool instead of dying here.
      const poolEntry = pool.find(p => String(p.accountId) === String(acct.accountId))
      if (poolEntry?.exhausted) {
        try {
          const { recordDecision } = await import('./services/decision-log.js')
          recordDecision(db, {
            accountId: String(acct.accountId),
            symbol: sym, timeframe: synth.timeframe, strategy: synth.strategy,
            stage: 'margin_pool', decision: 'skip',
            reason: `margin exhausted on this account (used $${poolEntry.status.usedMargin.toFixed(2)} vs cap $${poolEntry.status.cap.toFixed(2)}, ${poolEntry.status.source})`,
          })
        } catch { /* provenance never blocks */ }
        continue
      }
      // ACCOUNT PRE-GATE (PR-C, owner principle 7): the six cycle-level
      // guards — balance scope, campaign stop, daily loss cap, unknown P&L,
      // loss streak, position cap — asked ONCE per account per cycle. A
      // refused account wrote one skip row on the first symbol of the cycle
      // and writes nothing now; it is not built into an order for this
      // symbol either. The gate keeps every one of these as the backstop.
      const pregate = accountPregate(db, acct.accountId, { cycle: loopCount })
      if (!pregate.ok) {
        log(`Account pre-gate: ${sym} skipped on …${String(acct.accountId).slice(-4)} — ${pregate.reason}`)
        continue
      }
      // FUNDABLE UNIVERSE (§7,437·B·3): this account's daily budget planner
      // already knows whether the minimum lot fits its risk budget and its
      // pool headroom. An unfundable name is skipped by name here, before
      // any order is built — not sized and refused an hour later again.
      // Unknown (no record, stale record, symbol not in it) never blocks.
      try {
        const { isFundable } = await import('./services/fundable-universe.js')
        const fu = isFundable(db, acct.accountId, sym)
        if (!fu.ok) {
          log(`Fundable universe: ${sym} skipped on ${acct.accountId} — ${fu.reason}`)
          try {
            const { recordDecision } = await import('./services/decision-log.js')
            recordDecision(db, {
              accountId: String(acct.accountId),
              symbol: sym, timeframe: synth.timeframe, strategy: synth.strategy,
              stage: 'fundable_universe', decision: 'skip', reason: fu.reason,
            })
          } catch { /* provenance never blocks */ }
          continue
        }
      } catch { /* an unreadable record never blocks */ }
      // ACCOUNT HORIZON (§7,437·B·6): the account's declared horizon and
      // family set, judged per account. Nothing declared admits everything.
      try {
        const { loadAccountHorizon, horizonAdmits } = await import('./services/account-horizon.js')
        const hz = horizonAdmits(loadAccountHorizon(db, acct.accountId), { timeframe: synth.timeframe, strategy: synth.strategy })
        if (!hz.ok) {
          log(`Horizon: ${sym} skipped on ${acct.accountId} — ${hz.reason}`)
          try {
            const { recordDecision } = await import('./services/decision-log.js')
            recordDecision(db, {
              accountId: String(acct.accountId),
              symbol: sym, timeframe: synth.timeframe, strategy: synth.strategy,
              stage: 'account_horizon', decision: 'skip', reason: hz.reason,
            })
          } catch { /* provenance never blocks */ }
          continue
        }
      } catch { /* an unreadable declaration never blocks */ }
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
      const sidecarAccounts = acct.isLive ? sidecarRosters.live : sidecarRosters.demo
      if (sidecarAccounts && !sidecarAccounts.includes(String(acct.accountId))) {
        log(`Connectivity gate: ${sym} skipped on ${acct.accountId} — account not in the ${acct.isLive ? 'LIVE' : 'demo'} sidecar's authorized roster`)
        try {
          const { recordDecision } = await import('./services/decision-log.js')
          recordDecision(db, {
            accountId: String(acct.accountId),
            symbol: sym, timeframe: synth.timeframe, strategy: synth.strategy,
            stage: 'account_probe', decision: 'skip',
            reason: `enabled in registry but not in the ${acct.isLive ? 'LIVE' : 'demo'} sidecar's authorized roster — no order built until it reconnects`,
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

      // PROPOSAL PRE-GATE (PR-C): currency exposure, correlation and the R:R
      // floor for THIS symbol on THIS account, each the gate's own function,
      // each a decision_log skip rather than a risk_events veto. The lesson
      // tuner inside autoTrade may still widen the stop before the gate reads
      // it, so the gate remains the authority on the exact ratio.
      const pp = proposalPregate(db, acct.accountId, {
        symbol: sym, side: synth.consensus_bias === 'short' ? 'SELL' : 'BUY',
        strategy: synth.strategy || null, timeframe: synth.timeframe ?? null,
        entry: synth.entry ?? null, sl: synth.sl ?? null, tp1: synth.tp1 ?? null,
      }, { cycle: loopCount, account: pregate })
      if (!pp.ok) {
        log(`Proposal pre-gate: ${sym} skipped on …${String(acct.accountId).slice(-4)} — ${pp.reason}`)
        continue
      }

      // E·2: the accounts that reached THIS gate for THIS signal are the ones
      // sharing it. Counted as the fan-out goes — an account skipped above
      // never joins — and the count the first dispatch sees is the number of
      // accounts still ahead of it plus itself, which is the roster minus the
      // ones already skipped; later accounts see the same roster figure. One
      // number per signal, from the pre-pass below.
      const tradeResult = await autoTrade(db, sym, synth, acctItem, acct, { sharedAccounts: sharedAccountsForSignal })
      if (tradeResult) {
        fired = true
        // The book just changed: the next symbol re-asks the pre-gate for
        // this account instead of trusting a pre-fill verdict.
        invalidateAccountPregate(acct.accountId)
        // PR-3: the tick side's companion — the next heartbeat re-pushes
        // this account's permits so the sidecar's standing permit on the
        // filled symbol is withdrawn (position_open), not left to expire.
        markTickRepush(db, acct.accountId)
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

// Per-cycle memo for the margin POOL (owner § 7,453·A, 08-09-2026): one
// status per autopilot account, computed once per loop cycle, logged once,
// and the exhausted accounts journaled once each — not per dispatched
// symbol. Replaces the single-account pre-gate that paused every account on
// the selected account's number.
//
// Entries: { acct, accountId, status, exhausted }, richest headroom first.
// `acct` is the registry row the fan-out needs (accountId, isLive, …).
let marginPoolLoop = -1
let marginPoolMemo = []
function marginPoolForCycle(db) {
  if (marginPoolLoop === loopCount) return marginPoolMemo
  marginPoolLoop = loopCount
  const accounts = getAutopilotAccounts(db)
  const byId = new Map(accounts.map(a => [String(a.accountId), a]))
  let pool = accounts.map(a => ({ acct: a, accountId: String(a.accountId), status: null, exhausted: false }))
  try {
    const config = loadRiskConfig(db)
    let rates = null
    try { rates = scanRates(db) } catch { rates = null }
    pool = accountMarginPool(db, config, accounts.map(a => a.accountId), { rates })
      .map(p => ({ ...p, acct: byId.get(p.accountId) }))
      .filter(p => p.acct)
    const said = pool.map(p => p.status
      ? `${p.accountId}: ${p.exhausted ? 'EXHAUSTED' : `headroom $${p.status.headroom.toFixed(2)}`} (used $${p.status.usedMargin.toFixed(2)} / cap $${p.status.cap.toFixed(2)}, ${p.status.source})`
      : `${p.accountId}: no balance on record — judged by the risk gate`)
    if (pool.length) log(`Margin pool (maxMarginUsagePct=${config.maxMarginUsagePct}): ${said.join(' · ')}${pool.every(p => p.exhausted) ? ' — every account exhausted, dispatch paused this cycle' : ''}`)
    // THE VETO BOUNDARY (19-09-2026): an exhausted account is a cycle-stable
    // state, not a refused proposal. It used to be journaled here as a
    // risk_events veto under symbol 'PORTFOLIO' EVERY cycle — 1,235 rows in
    // 24 h, 100 % of the gate's vetoes, with nothing refused at the gate.
    // Now: one decision_log row per account per state change (exhausted /
    // recovered), see services/margin-pool-journal.js.
    journalMarginPoolState(db, pool, { loopId: loopCount })
  } catch (err) {
    // The pool must never break dispatch on its own error: fall back to the
    // plain roster, nobody exhausted, and say so once.
    log(`Margin pool could not be read (${err.message}) — dispatching to every account, the risk gate decides`)
  }
  marginPoolMemo = pool
  return pool
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

/**
 * Round an amend payload to a symbol's own precision. PURE and exported, so
 * the arithmetic is tested as behaviour rather than asserted from source.
 *
 * `digits` null (lookup failed) sends the values through unrounded — a
 * possible rejection beats inventing a precision.
 */
export function roundAmendPayload({ stopLoss, takeProfit, digits }, round = roundToDigits) {
  if (digits == null || !Number.isFinite(Number(digits))) return { stopLoss, takeProfit }
  return {
    stopLoss: stopLoss == null ? stopLoss : round(stopLoss, digits),
    takeProfit: takeProfit === undefined || takeProfit === null ? takeProfit : round(takeProfit, digits),
  }
}

/**
 * The symbol's digit count from the broker's cached record, or null.
 *
 * Hoisted out of the MOVE_SL branch (checker M3): the PARTIAL_EXIT branch
 * amends the runner leg with the SAME kind of raw price arithmetic and did NOT
 * round. That path was unreachable on managed accounts before PR-J
 * (partialTriggerR Infinity); the bank take now routes through it, sending
 * `peak − 1.5 × initial_risk` — exactly the shape that failed in production on
 * 2026-08-26 (`Order price = 3101.801785714286 has more digits than allowed
 * (INVALID_REQUEST)`, the stop never moving at all). One helper, both sites.
 */
async function symbolDigitsFor(db, creds, symbol) {
  try {
    const { resolveSymbolId } = await import('./lib/ctrader-creds.js')
    const symbolId = (await resolveSymbolId(db, { ...creds, ready: true }, symbol || '')).id
    if (!symbolId) return null
    const { getVolumeMeta } = await import('./lib/lot-sizing.js')
    const meta = await getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)
    return meta?.digits ?? null
  } catch { return null }
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
      // CARRY THE EXISTING TAKE PROFIT. cTrader's AMEND_POSITION_SLTP_REQ
      // REPLACES a position's protection: a payload with stopLoss and no
      // takeProfit does not mean "leave the target alone", it means "this
      // position has no target". So every SL-only amend — this one, the
      // keeper's trail, the session-open breakeven lock — silently DELETED
      // the take profit at the broker.
      //
      // Measured 17-08-2026: the 4 Aug protection audit found 8 of 12
      // positions with no take profit, and the two on ACCT-LIVE-1 that had been
      // trailed (be_moved=1) both read tp=None while their trade rows carried
      // one. The NatGas breakout was placed with a target of 2.595 and held
      // none minutes later. One cause, not several.
      //
      // pos.current_tp is the bot's own record of the target it placed, so
      // re-sending it restores the leg the broker is about to drop. undefined
      // when there genuinely is no target, which leaves the payload exactly as
      // it was — this cannot invent a TP that was never set.
      const keepTp = Number(pos.current_tp) > 0 ? Number(pos.current_tp) : undefined
      // ROUND TO THE SYMBOL'S DIGITS. The trail computes newSL as raw price
      // arithmetic (price − 1R etc), and the broker rejects prices with more
      // decimals than the symbol allows — production 2026-08-26, every pass:
      // `PM US2000: MOVE_SL FAILED — Order price = 3101.801785714286 has more
      // digits than allowed (INVALID_REQUEST)`, so the stop never moved at
      // all. The keeper and loss-guardian already round; this executor is the
      // one price-bearing path that did not. Digits come from the cached
      // symbol record; if the lookup fails the raw value goes through as
      // before — a possible rejection beats inventing a precision.
      const moveDigits = await symbolDigitsFor(db, { host, clientId, clientSecret, accessToken, accountId }, pos.symbol)
      const { stopLoss: sendSL, takeProfit: sendTp } = roundAmendPayload({ stopLoss: eval_.newSL, takeProfit: keepTp, digits: moveDigits })
      const res = await execAmendPosition({ host, clientId, clientSecret, accessToken, accountId }, {
        positionId: ctx.positionId,
        stopLoss: sendSL,
        ...(sendTp !== undefined ? { takeProfit: sendTp } : {}),
      })
      setState(db, 'api_ctrader_last_ok', new Date().toISOString())
      if (res.alreadyClosed) return { closedRemotely: true, summary: 'already_closed' }
      // Record what was SENT, not the unrounded intent — the broker holds sendSL.
      s.updatePositionSl.run(sendSL, pos.id)
      recordPositionEvent(db, {
        accountId, positionId: ctx.positionId, tradeId: pos.trade_id, symbol: pos.symbol,
        kind: 'sl_moved', fromValue: pos.current_sl ?? null, toValue: sendSL,
        reason: eval_.reason, source,
      })
      return { summary: `SL → ${Number(sendSL).toFixed(5)}` }
    }

    // Per-symbol volume math — lotSize varies by asset class; a hardcoded
    // constant here was the TRADING_BAD_VOLUME bug (see lib/lot-sizing.js).
    const volumeMeta = async () => {
      const { resolveSymbolId } = await import('./lib/ctrader-creds.js')
      const resolved = await resolveSymbolId(db, { host, clientId, clientSecret, accessToken, accountId, ready: true }, pos.symbol || '')
      const symbolId = resolved.id
      if (!symbolId) throw new Error(resolved.reason || `symbolId unknown for ${pos.symbol}`)
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
      // §5490 NULL-EXIT GUARD. Two questions before any close reaches the
      // broker: may this writer close at all, and does closing HERE do
      // anything. Both were answered "yes, always" until now, which is how 31
      // explicit closes on ACCT-DEMO-4 turned -$3,348 while 15 managed stops
      // turned +$1,510. Placed at this seam on purpose — every close-side
      // writer funnels through executeBrokerAction, so one check covers all
      // of them rather than each learning the rule separately.
      //
      // Protection writers are exempt inside the guard, not here: putting the
      // exemption in the module keeps "who may be blocked" answerable by
      // reading one file instead of tracing call sites.
      {
        const { nullExitVerdict } = await import('./services/null-exit-guard.js')
        const v = nullExitVerdict({
          writer: source,
          reason: eval_.reason,
          currentR: eval_.metrics?.currentR ?? null,
          minR: loadRiskConfig(db, accountId)?.nullExitMinR,
        })
        if (v.block) {
          // The position stays ACTIVE and its broker SL/TP still protect it.
          // Journalled rather than silent: a refused close is a decision, and
          // an unexplained non-action is exactly what makes the management
          // layer unreadable.
          recordPositionEvent(db, {
            accountId, positionId: ctx.positionId, tradeId: pos.trade_id, symbol: pos.symbol,
            kind: 'close_refused', fromValue: null, toValue: null,
            reason: `${v.why} | asked: ${eval_.reason}`, source,
          })
          log(`CLOSE REFUSED ${pos.symbol} by ${source}: ${v.why}`)
          return { skipped: true, reason: v.why }
        }
      }
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
      // ONLY the deal's execution price is an exit price.
      //
      // This used to fall back to `res.position?.price` — the POSITION's price,
      // which is where it OPENED, not where it closed. That is one of the ways
      // 56 of 190 decidable closed rows ended up with a net_pnl contradicting
      // their own entry/exit (docs/go-live-plan.md §4). Writing a wrong exit is
      // worse than writing none: `net_pnl` still arrives from the broker and is
      // correct either way, whereas a plausible-but-wrong price silently
      // corrupts realised R, the loss postmortems and the playback.
      //
      // null means closeTradeRow's COALESCE leaves the column alone, and the
      // row is marked pnl_price_mismatch if what remains disagrees with the money.
      const closePrice = res.deal?.executionPrice ?? null
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
      const unfillable = totalUnits <= 0 || closeUnits <= 0
        ? 'unknown_volume'
        : (meta.minVolume != null && closeUnits < meta.minVolume ? 'partial_below_min_volume' : null)
      if (unfillable) {
        // A partial the broker would reject is normally skipped — the runner
        // keeps its full size rather than erroring every tick.
        //
        // NOT for a decision that asked for a full exit and was only SPLIT for
        // better exit shape (checker M4). PR-J's bank take is that case: a
        // 1000-unit position with a 1000-unit step floors to 0, and before
        // PR-J it would have been closed WHOLE at the trigger. Skipping it
        // silently reintroduces the margin-hostage case the bank rule exists
        // to prevent, on exactly the smallest positions. The decision says
        // which it is; nothing else infers it.
        if (eval_.fallbackFullExitIfUnfillable) {
          return executeBrokerAction(db, s, pos, {
            ...eval_,
            action: 'FULL_EXIT',
            exitFraction: 1,
            newSL: null,
            reason: `${eval_.reason} | ${unfillable} → full exit`,
          }, source)
        }
        return { skipped: true, reason: unfillable }
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
        // THE RUNNER LEG KEEPS ITS TARGET. The MOVE_SL path above re-sends
        // current_tp; this one did not, and it fires immediately after every
        // partial — which the TP1-at-1R change (#738) made far more frequent.
        const runnerTp = Number(pos.current_tp) > 0 ? Number(pos.current_tp) : null
        // ROUNDED, same as MOVE_SL (checker M3). This branch sent raw price
        // arithmetic until PR-J and was unreachable on managed accounts; the
        // bank take makes it reachable, with a stop computed as
        // `peak − mult × distance` — the 2026-08-26 INVALID_REQUEST shape.
        const partialDigits = await symbolDigitsFor(db, { host, clientId, clientSecret, accessToken, accountId }, pos.symbol)
        const runnerSend = roundAmendPayload({ stopLoss: eval_.newSL, takeProfit: runnerTp, digits: partialDigits })
        const amendRes = await execAmendPosition({ host, clientId, clientSecret, accessToken, accountId }, {
          positionId: ctx.positionId,
          stopLoss: runnerSend.stopLoss,
          takeProfit: runnerSend.takeProfit,
        })
        setState(db, 'api_ctrader_last_ok', new Date().toISOString())
        if (!amendRes.alreadyClosed) {
          s.updatePositionSl.run(runnerSend.stopLoss, pos.id)
          recordPositionEvent(db, {
            accountId, positionId: ctx.positionId, tradeId: pos.trade_id, symbol: pos.symbol,
            kind: 'sl_moved', fromValue: pos.current_sl ?? null, toValue: runnerSend.stopLoss,
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
/**
 * Persist PR-J's exit stamps for an action the broker actually took.
 *
 * Exported so both evaluators (this loop and fast-monitor) write them the same
 * way — the 0016.HK lesson applied to persistence rather than to rules. An
 * errored or skipped action stamps NOTHING, so the next pass re-decides.
 */
export function stampExitMarks(s, pos, eval_, outcome) {
  const marks = eval_?.updates || {}
  if (!marks.time_cap_trail_at && !marks.bank_partial_at) return false
  // A HOLD that carries a mark (the cap held a winner whose stop already sat
  // at/beyond breakeven — fix-the-exits BB) sent nothing to the broker, so
  // there is no outcome to fail: the decision itself is what happened.
  const held = eval_?.action === 'HOLD'
  if (!held && (!outcome || outcome.error || outcome.skipped)) return false
  s.stampPositionExitMarks.run(
    marks.time_cap_trail_at ?? null,
    marks.bank_partial_at ?? null,
    pos.id,
  )
  return true
}

/**
 * PR-X: the account, the row and the trade on every PM line.
 *
 * WHY. The owner's 15-09 log showed `PM ABBV.US: FULL_EXIT FAILED` four times
 * a cycle against once each for UNH.US and COST.US, and NOTHING in the line
 * could distinguish "ABBV is held on four accounts" from "four rows point at
 * one position". `monitored_positions` carries `account_id` and `trade_id`;
 * the line dropped both. A repeated line that cannot say which account it is
 * about is not a log, it is a rumour — and it cost a wrong diagnosis before
 * this was written.
 */
export function posTag(pos) {
  const acct = pos?.account_id == null ? 'unscoped' : `…${String(pos.account_id).slice(-4)}`
  const trade = pos?.trade_id == null ? 'no-trade' : `t${pos.trade_id}`
  return `${pos?.symbol} [${acct} row${pos?.id} ${trade}]`
}

export async function monitorOnePosition(db, s, pos, currentPrice, client, skipLlm = () => false) {
  // Managed-exit trail (owner "c1" 25-08-2026; ONE SIMPLE SYSTEM 28-08-2026:
  // "proceed as plan", win-rate goal > 69%): on managed accounts the
  // peak-based trail is the ONLY exit-timing rule — the sweep measured
  // trail_0.5R at PF 2.41 / WR 69.2% vs the ladder variants at 1.0–1.6.
  // The merge lives in applyManagedRules so EVERY evaluator (this monitor
  // and fast-monitor.js) silences the same ladder — it silenced only here
  // until 0016.HK's bank_target_4R close, 2026-08-31.
  const rules = applyManagedRules(db, pos.account_id, rulesForSymbol(db, pos.symbol), { strategy: pos.strategy })
  // PR-J's cap trail and bank trail are ATR multiples. The ATR comes from the
  // profit keeper's in-memory cache — a read, never a fetch — and is null
  // whenever the keeper has not computed one for this symbol this bar, in
  // which case the multiplier falls back to the position's own 1R distance.
  const eval_ = evaluatePosition(pos, { currentPrice, rules, atr: cachedAtrForSymbol(db, pos.symbol) })

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
      log(`PM ${posTag(pos)}: ${eval_.action} (external, observe-only) — ${eval_.reason}`)
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
      log(`PM ${posTag(pos)}: ${eval_.action} suppressed — Live Tweak & Close is off for ${pos.strategy || 'unlabelled'}`)
      return
    }
    const outcome = await executeBrokerAction(db, s, pos, eval_)
    // PR-J stamps, written FROM THE OUTCOME (checker M4). Stamping before the
    // broker answered meant a refused amend (MARKET_CLOSED is routine here) or
    // a partial the broker would not size left the rule disarmed forever: the
    // stamp said "this already happened" while the stop had not moved and the
    // position had not banked. A stamp is a record of something that HAPPENED.
    stampExitMarks(s, pos, eval_, outcome)
    let reasoning = eval_.reason
    let thesisStatus = eval_.action === 'FULL_EXIT' ? 'broken' : 'intact'
    if (outcome.error) {
      reasoning = `${reasoning} | broker_error: ${outcome.error}`
      log(`PM ${posTag(pos)}: ${eval_.action} FAILED — ${outcome.error}`)
    } else if (outcome.skipped) {
      reasoning = `${reasoning} | intent_only: ${outcome.reason}`
      log(`PM ${posTag(pos)}: ${eval_.action} — ${eval_.reason} (intent-only, ${outcome.reason})`)
    } else {
      reasoning = `${reasoning} | broker: ${outcome.summary}`
      log(`PM ${posTag(pos)}: ${eval_.action} — ${outcome.summary}`)
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

  // A HOLD the cap decided (fix-the-exits BB) is stamped so the branch is
  // not re-decided every pass; an observe-only external row is left alone.
  if (pos.source !== 'external') stampExitMarks(s, pos, eval_, null)

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
      // Two reasons reach here now — the cycle ran out of budget, or the LLM
      // monitor is in manual. The row should say which, or a quiet account
      // reads like a stalled loop.
      `${eval_.reason} | llm_skipped: advisory monitor off (manual mode) or cycle past its soft deadline — deterministic rules only`,
      new Date().toISOString(), 'intact', pos.id
    )
    return
  }

  // Fallback: free-text theses and ambiguous cases → LLM Monitor.
  //
  // SWITCHED OFF IS NOT FAILED (owner 09-08-2026, "runs 24/7 without credit
  // from AI needed"). Returning here — before the call, before the catch —
  // is the whole point: an exhausted balance would otherwise throw ~1,900
  // times a day, each throw feeding a failure streak, a Telegram alert and a
  // stale api_anthropic_last_ok, describing a decision the owner made on
  // purpose as an outage. The deterministic rules above have already run and
  // the broker still holds the SL/TP, so this position is managed either way.
  const gate = await llmBlocked(db, getState)
  if (gate.blocked) return
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
    // §5490: THE DEFERRAL IS NOW TOTAL. The gate above only declined exits at
    // POSITIVE R, on the reasoning that "cutting a loser early on a broken
    // thesis is exactly the case an LLM read should be allowed to act on."
    // Fourteen days of production disagreed with that reasoning, measured on
    // account ACCT-DEMO-4: 12 llm_monitor exits, 2 of them positive, -$2,229.85,
    // and not one stop moved. The worst were NAS100 -$826 and USDZAR -$592 at
    // a realised 0.000R — closes AT the entry price, where the entire loss is
    // cost. Those are precisely the exits the old `r > 0` test waved through,
    // because zero is not positive.
    //
    // So llm_monitor keeps its voice and loses its hands. It is absent from
    // CLOSE_AUTHORITY in null-exit-guard.js, and this site no longer calls the
    // executor at all — calling it and being refused would be dishonest about
    // where the decision is made. Its read is journalled and alerted; a human
    // or a deterministic rule closes if it should be closed.
    const r = eval_.metrics.currentR
    log(`LLM EXIT advisory for ${pos.symbol}${r == null ? '' : ` (currentR ${r.toFixed(2)})`}: recorded, not executed — ${check.reasoning}`)
    try {
      db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
        'LLM_EXIT_ADVISORY', '/monitor',
        JSON.stringify({
          monitoredId: pos.id, symbol: pos.symbol, currentR: r, reasoning: check.reasoning,
          detail: 'LLM monitor asked for an exit. It holds no close authority (null-exit-guard.js CLOSE_AUTHORITY) — position left ACTIVE, broker SL/TP still protect, deterministic rules still manage it normally.',
        }).slice(0, 2000),
      )
    } catch { /* audit best-effort */ }
    try {
      // The thesis_status write above already marked this 'broken' where the
      // model said so, so the Desk shows the disagreement without an alert.
      // Only tell the owner when the model is calling a LOSER broken — that is
      // the case a human might actually want to act on.
      if (r != null && r < -0.5) {
        const { notify } = await import('./services/telegram.js')
        await notify(`🧠 LLM says thesis broken: ${pos.symbol} at ${r.toFixed(2)}R — advisory only, position still open. ${String(check.reasoning || '').slice(0, 300)}`)
      }
    } catch { /* alerting never blocks the monitor */ }
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
    //
    // 'preopen' is in the list because it is OURS (closed-market fills).
    // Measured 2026-08-31: upgrading misfiled preopen rows out of 'external'
    // (#787) silently removed them from THIS whitelist — last_check_at froze
    // for two days while every other position was checked minutes before.
    // The 09-08 label split touched every consumer that names sources, and
    // each one needed the lesson separately: isOurs (#787), and now the four
    // monitoring/guard whitelists.
    selectActivePositions: db.prepare(
      `SELECT * FROM monitored_positions
       WHERE status = ?
         AND COALESCE(paused, 0) = 0
         AND (source IS NULL OR source IN ('autopilot', 'preopen', 'external'))`
    ),

    updatePositionCheck: db.prepare(`
      UPDATE monitored_positions
      SET last_check_action = ?, last_check_reasoning = ?, last_check_at = ?, thesis_status = ?
      WHERE id = ?
    `),

    // be_moved / scaled_out are one-way latches, written as MAX on purpose
    // (02-09-2026, codebase audit): the loop writes them from a snapshot
    // taken BEFORE scan/analyze, and the fast monitor's trade guards set
    // them in between (trade-guard.js updGuard/updSl). A plain `= ?` wrote
    // the stale 0 back over the guard's 1, and `decideGuardActions` could
    // re-arm break-even on a position whose stop had already moved. Nothing
    // in the system ever resets either flag on purpose, so MAX loses nothing.
    updatePositionMetrics: db.prepare(`
      UPDATE monitored_positions
      SET mfe_r = ?, mae_r = ?,
          be_moved = MAX(COALESCE(be_moved, 0), COALESCE(?, 0)),
          scaled_out = MAX(COALESCE(scaled_out, 0), COALESCE(?, 0))
      WHERE id = ?
    `),

    // PR-J exit-asymmetry stamps. COALESCE, not assignment: the first stamp
    // stands, so a re-evaluation cannot re-arm either rule.
    stampPositionExitMarks: db.prepare(`
      UPDATE monitored_positions
      SET time_cap_trail_at = COALESCE(time_cap_trail_at, ?),
          bank_partial_at   = COALESCE(bank_partial_at, ?)
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
  // V3 M1: the work before the cycle's mutex (Telegram poll, the local price
  // reconcile, the digest flush) is labelled for the lag tap — unless a cycle
  // is still running, whose own phase label must not be overwritten.
  if (!loopRunning) markLagPhase('pre-cycle')
  // Owner's travel console — handle /status /pause /resume /killall from
  // Telegram BEFORE any phase runs, so a pause lands this cycle, not next.
  try {
    const { pollTelegramCommands } = await import('./services/telegram-control.js')
    const { getCtraderCreds } = await import('./lib/ctrader-creds.js')
    const { cancelOrder } = await import('./lib/exec-engine.js')
    await pollTelegramCommands(db, { cancelOrder, creds: getCtraderCreds(db) })
  } catch { /* telegram trouble must never stall trading */ }

  // Quiet hours / hourly digest. attachNotifyDb registers the open handle for
  // the choke point inside telegram.js's senders, which have no db of their
  // own; UNTIL it is called, routeOutbound sends everything immediately, so a
  // missing wiring step can never mute an alert. Re-attaching every cycle is
  // idempotent and survives a db handle being replaced under us.
  //
  // The flush runs AFTER the command poll on purpose: a /quiet off typed at
  // 06:55 takes effect on this cycle's flush rather than the next one.
  // Correct closed trades' fill prices from the broker's own ledger.
  //
  // ITS OWN STEP, deliberately. importBrokerHistory is reachable only from a
  // manual POST route, so a repair living solely there would never run. The
  // obvious alternative — hanging it off pnl-backfill, which is on the loop
  // and already writes broker_deals — is WRONG, and its tests say why: that
  // service fills a NULL price and repairs a FLAGGED row, but never overwrites
  // a present, unflagged one, because "filling a NULL is broker truth;
  // overwriting a value is a different claim". This is that different claim —
  // the broker's fill price is authoritative for a closed trade — so it is
  // made explicitly here rather than smuggled into a service that promises not
  // to make it.
  //
  // Pure local work: reads broker_deals, writes only closed `trades` rows
  // whose price disagrees, and settles to `corrected: 0` once the record
  // agrees. No broker round-trip, so it costs the cycle nothing.
  try {
    const { reconcileTradePricesToBroker } = await import('./services/broker-history-import.js')
    const fix = reconcileTradePricesToBroker(db)
    if (fix.corrected) log(`corrected ${fix.corrected} fill price(s) from the broker ledger`)
    // Keeper-truth fix (18-09-2026): fill TIME and fill VOLUME are written
    // back too, and said when they are — the read-back for that change.
    if (fix.closeTimesCorrected || fix.volumesCorrected) {
      log(`corrected ${fix.closeTimesCorrected || 0} close time(s) and ${fix.volumesCorrected || 0} fill volume(s) from the broker ledger`)
    }
    // STAMPED, NOT SWALLOWED. A thrown transaction used to come back as
    // `corrected: 0`, the same reading as "the record already agrees". The
    // error is logged and kept in state (cleared on the next clean pass) so
    // a repair that has been failing for a week is a fact, not a silence.
    if (fix.error) {
      log(`price reconcile FAILED: ${fix.error}`)
      setState(db, 'price_reconcile_last_error_json', JSON.stringify({ at: new Date().toISOString(), error: String(fix.error).slice(0, 500) }))
    } else {
      setState(db, 'price_reconcile_last_error_json', null)
    }
  } catch (err) {
    // The import or the state write itself failed — still a repair pass that
    // must never stall trading, and still a failure to record.
    log(`price reconcile FAILED: ${err.message}`)
    try { setState(db, 'price_reconcile_last_error_json', JSON.stringify({ at: new Date().toISOString(), error: String(err.message).slice(0, 500) })) } catch { /* state unwritable */ }
  }

  try {
    const digest = await import('./services/telegram-digest.js')
    digest.attachNotifyDb(db)
    const { sendMessageRaw } = await import('./services/telegram.js')
    const flushed = await digest.flushDigest(db, { send: sendMessageRaw })
    // A flush that fails hourly with its error swallowed is how the digest
    // sat "off since 11 AM" with 500 queued and no line in any log saying
    // why. The failure stays non-fatal; it just stops being invisible.
    if (!flushed.sent && flushed.reason.startsWith('error:')) log(`[digest] flush failed: ${flushed.reason}`)
  } catch { /* a held summary is not worth stalling the loop for */ }
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
    markLagPhase('idle')
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

  // LLM MONITOR: ADVISORY, AND NOW OPTIONAL (owner, 14-08-2026).
  //
  // "I like to remove the LLM assessment to manual since I don't read them as
  // often." Safe to honour, and this is why rather than on preference alone:
  // the LLM monitor has no hands. evaluatePosition runs first and RETURNS on
  // any action, so the model is only consulted about positions the
  // deterministic rules already decided to hold; and since the ACCT-DEMO-4
  // measurement (12 llm_monitor exits, -$2,229.85, not one stop moved) it has
  // been absent from CLOSE_AUTHORITY and this file no longer calls the
  // executor for it at all — see the note above the LLM EXIT advisory log.
  //
  // So its entire product is a journalled opinion and an alert. Every real
  // exit — broker SL/TP, time cap, invalidation trigger, bank target, partial,
  // runner trail, breakeven, plus the loss guardian and profit keeper — is
  // deterministic and unaffected. Turning it off removes a cost and a log
  // line, and removes nothing that protects a position. It is also what the
  // aligned plan asks for in E4 and §2.5.7.2.
  //
  // MANUAL IS THE DEFAULT. An unset key means off: the owner asked for it off,
  // and a spend that resumes silently on a fresh database is the wrong
  // direction for a knob whose only output is advice nobody reads.
  const llmMonitorManual = () => getState(db, 'llm_monitor_mode') !== 'auto'
  const skipLlmMonitor = () => llmMonitorManual() || cycleOverBudget()
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
    // Existing opt-in profiles must be usable while the dashboard times out.
    // Bounded function names/timings only; no payloads or credentials.
    if (summary.totalMs >= 1000) log(`CPU profile ${summary.phase}: ${JSON.stringify({ totalMs: summary.totalMs, idleMs: summary.idleMs, gcMs: summary.gcMs, top: summary.top.slice(0, 5) })}`)
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
    // V3 M1: the lag tap's stall record names the phase by its stable key.
    markLagPhase(key)
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
    // Between cycles: a stall the tap sees from here on happened while the
    // loop slept — an HTTP handler or a ticker, not a loop phase.
    markLagPhase('idle')
    return Object.fromEntries(ordered)
  }

  markLagPhase('starting')
  setState(db, 'loop_phase', 'starting')
  setState(db, 'loop_started_at', new Date().toISOString())

  // Keep the OAuth access token alive (daily proactive refresh; no-op if no
  // refresh token or refreshed recently — never blocks or throws).
  try {
    const { maybeRefreshCtraderToken, refreshCtraderToken } = await import('./lib/ctrader-auth.js')
    await maybeRefreshCtraderToken(db, log)
    // Reactive half (26-08-2026): the proactive call above runs once per
    // PROCESS, so a token Spotware invalidates mid-flight — measured: fresh
    // at 09:25Z, dead ~14h later — stalled every controller until a human
    // noticed. Every broker call funnels through withRetry; this hook lets
    // an auth error there trigger one cooldown-limited refresh, and the next
    // controller pass re-reads the healed token from state.
    const { setAuthErrorHook } = await import('./lib/ctrader-ws.js')
    const { tokenRefusedAccounts } = await import('./lib/token-refused.js')
    // B7: a refusal for an account the token never covered is not a rotation.
    setAuthErrorHook(() => refreshCtraderToken(db), {
      skip: (err) => err?.accountId != null && tokenRefusedAccounts(db).has(String(err.accountId)),
    })
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

  // V3 M1: whether this cycle's main block threw, for the boot record's loop
  // entries (the counter below is reset after the catch, so it cannot say).
  let cycleErrored = false
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
    // FIRST-CYCLE SEED. The reconcile block below runs on `loopCount % 3 === 0`
    // and loopCount is incremented to 1 before reaching it, so cycles 1 and 2
    // never reconcile — and until the cross-side sweep has run once, an
    // opposite-side account with no stamped balance still answers
    // getAccountBalance out of the unowned global. On a fresh database, or the
    // first cycles after a deploy, that is a window in which an account could
    // be sized against somebody else's equity.
    //
    // So the cross-side equity read is seeded ONCE, before the first dispatch,
    // and the periodic refresh in the reconcile block carries it from there.
    // Same bounded, read-only sweep — it cannot cost more than its deadline.
    if (!crossSideEquitySeeded) {
      try {
        const clientId = ctraderEnv('clientId')
        const clientSecret = ctraderEnv('clientSecret')
        const accessToken = getState(db, 'ctrader_access_token')
        const isLive = getState(db, 'ctrader_is_live') === 'true'
        if (clientId && clientSecret && accessToken) {
          const { sweepCrossSideEquity } = await import('./services/account-equity.js')
          const x = await sweepCrossSideEquity(db, { clientId, clientSecret, accessToken }, { isLive })
          crossSideEquitySeeded = true
          if (x.swept > 0) log(`Cross-side equity (seed): ${x.stamped}/${x.swept} stamped`)
        }
      } catch { /* seeding is best-effort; the periodic pass retries */ }
    }

    // P1c (docs/tick-momentum/plan.md §3, TM-14): an account switched to
    // STOPPED has its resting entry orders cancelled by stored id, and its
    // state settles QUIESCING → RECONCILING → STABLE on the broker's word.
    // The route ran the first pass; this is the retry. It returns before any
    // broker call while no account is draining, so it runs every cycle
    // rather than on the reconcile cadence. Best-effort.
    try {
      const { drainEntryOrdersPass } = await import('./services/entry-drain.js')
      const dr = await drainEntryOrdersPass(db)
      for (const d of dr.drained) {
        if (d.skipped) continue
        if (d.cancelled.length || d.failures.length || d.from !== d.transitionState) {
          log(`Entry drain …${String(d.accountId).slice(-4)} (epoch ${d.epoch}): cancelled ${d.cancelled.length} by stored id, ${d.failures.length} failed, resting ${d.resting}, unknown ${d.unknown}${d.unattributed ? `, ${d.unattributed} unattributed row(s) left alone` : ''}${d.snapshotError ? `, no broker snapshot (${d.snapshotError})` : ''} → ${d.transitionState}`)
        }
      }
      if (loopCount % 10 === 0) for (const s of dr.skipped) log(`Entry drain …${String(s.accountId).slice(-4)} skipped: ${s.reason}`)
    } catch (err) {
      log(`Entry drain pass failed (non-fatal): ${err.message}`)
    }

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
            // ACCT-DEMO-2 audited against ACCT-DEMO-1's snapshot, 4 unmatched, and
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
            const { makeTargetSuggester, makeTargetApplier } = await import('./services/tp-suggest.js')
            const protCreds = { host, clientId, clientSecret, accessToken, accountId }
            const prot = await runProtectionAudit(db, openRows, brokerSl, {
              sendMessage: notify,
              // accountId scopes the alert-mute maps. Without it this pass and
              // the per-account pass below pruned each other's mute stamps, so
              // the same position alerted every cycle (owner 04-08: the same
              // USDBRL line twice in one digest).
              accountId,
              suggestTarget: makeTargetSuggester(db, protCreds, positions),
              applyTarget: makeTargetApplier(db, protCreds),
            })
            if (prot.naked.length || prot.phantom.length || prot.targetless.length || (prot.tpDrift || []).length) {
              log(`PROTECTION AUDIT: ${prot.naked.length} position(s) with NO stop at the broker, ${prot.targetless.length} with NO take profit, ${prot.phantom.length} stop disagreement(s), ${(prot.tpDrift || []).length} target drift(s) (report only) — see action_log /protection-audit`)
            }
            // #144 DUPLICATE WATCH. findOpenDuplicates was already correct and
            // already detected both real incidents — nine 0066.HK, six
            // 0005.HK. Nothing CALLED it. It was a route, answering when asked,
            // and nobody was asking; the owner found both from a phone, a day
            // later. It rides here because this block already holds the
            // per-account scope and the notifier.
            try {
              const { duplicateWatchPass } = await import('./services/duplicate-watch.js')
              const dw = duplicateWatchPass(db, { accountId })
              for (const line of dw.alerts) {
                log(`DUPLICATE WATCH: ${line.split('\n')[0]}`)
                try {
                  db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
                    'DUPLICATE_CLUSTER', '/duplicate-watch', JSON.stringify({ accountId, line }).slice(0, 2000))
                } catch { /* audit best-effort */ }
                if (notify) { try { await notify(line) } catch { /* alerting never blocks the loop */ } }
              }
            } catch (e) { log('Duplicate watch failed (non-fatal):', e.message) }
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
          // The two best-effort blocks used to fail into an empty result —
          // a broken dedup sweep and a clean one both printed nothing.
          if (result.dedupError) log(`Reconcile: dedup sweep FAILED — ${result.dedupError}`)
          if (result.dupPnlError) log(`Reconcile: duplicate-P&L repair FAILED — ${result.dupPnlError}`)
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

          // P2a (docs/tick-momentum/plan.md §3 step 4, §9): the intent ledger
          // settles on the broker's word. Unredeemed permits expire, an
          // unanswered send becomes UNKNOWN (never failed, never filled), and
          // an open intent is resolved by the position or resting order that
          // carries its tag in this snapshot, or by the sidecar's ring.
          try {
            const { expireStale, reconcileIntents } = await import('./services/entry-ledger.js')
            const ex = expireStale(db)
            const rc = reconcileIntents(db, { accountId, positions: reconcileData.position || [], orders: reconcileData.order || [] })
            if (ex.expired || ex.unknown || rc.resolved.length) {
              log(`Entry ledger …${String(accountId).slice(-4)}: ${ex.expired} permit(s) expired, ${ex.unknown} send(s) now UNKNOWN, ${rc.resolved.length} resolved by evidence${rc.resolved.length ? ` (${rc.resolved.map(r => `${r.intentId} ${r.from}→${r.to}`).join(', ')})` : ''}, ${rc.stillOpen} still open`)
            }
            // PR-E (owner principle 4): an UNKNOWN the snapshot and the ring
            // could not settle is read against the broker's DEAL HISTORY —
            // the same pull pnl-backfill makes, one per pass and only when
            // an UNKNOWN exists (the settle itself skips otherwise). A deal
            // in the send window → FILLED; no match → the row STAYS UNKNOWN
            // and is listed (checker B1: a capped pull cannot prove absence);
            // hasMore pages are followed; a pull that fails settles nothing.
            try {
              const { settleUnknownsFromDealHistory } = await import('./services/entry-ledger.js')
              const { wsGetDeals } = await import('./lib/ctrader-ws.js')
              const dh = await settleUnknownsFromDealHistory(db, {
                accountId, getDeals: (t0, t1) => wsGetDeals(host, clientId, clientSecret, accessToken, accountId, t0, t1),
              })
              if (dh.filled?.length || dh.stillUnknown) {
                log(`Entry ledger …${String(accountId).slice(-4)} deal history: ${dh.pulled} deal(s) over ${dh.pages} page(s)${dh.truncated ? ' (TRUNCATED — coverage not claimed)' : ''}, ${dh.filled.length} FILLED${dh.filled.length ? ` (${dh.filled.map(f => `${f.intentId}→pos ${f.positionId}`).join(', ')})` : ''}, ${dh.stillUnknown} still UNKNOWN (listed, never auto-rejected)`)
              }
            } catch (err) {
              log(`Entry ledger deal-history settle failed (non-fatal): ${err.message}`)
            }
          } catch (err) {
            log(`Entry ledger reconcile failed (non-fatal): ${err.message}`)
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
            const { shouldRunPnlBackfill, dueForBackfill } =
              await import('./services/pnl-backfill.js')
            // TRIGGER ON A GAP, NOT ON A DETECTED CLOSE (2026-07-29).
            //
            // shouldRunPnlBackfill reads the reconcile result, and that
            // reconcile runs ONCE for the SELECTED account (see the single
            // reconcilePositions call above) — so a position closing on any
            // other account never reaches it. Measured on the M4 soak: Cocoa
            // closed 12:14:30Z on ACCT-DEMO-2 while ACCT-DEMO-1 was selected, and
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
              // ACCT-DEMO-2 while the selected account was ACCT-DEMO-1 — nothing
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
              // account(s) not in the sidecar's authorized roster [ACCT-DEMO-4]
              // … trying 1/1 account(s) [ACCT-DEMO-2] — 93 closed trade(s)
              // still missing net_pnl". Rows on the skipped accounts could
              // NEVER fill, so the unknown-P&L veto held the desk for three
              // days straight. The roster gates on DISPATCH and RECONCILE
              // (which do run through the sidecar) are untouched.

              let filled = 0
              let skipped = 0
              // The exit-price MAGNITUDE flag (`exit_price_suspect`) is what
              // makes the backfill re-fetch and repair a row whose recorded
              // exit is off by a factor rather than a sign. Until 02-09-2026
              // its only writer was GET /state/exit-price-suspects?sweep=1 —
              // a repair whose trigger arrived only when a human asked for
              // it (codebase audit). Pure local work; runs before the fetch
              // so this pass sees the flags it just wrote.
              let sweepSuspects = null
              try { ({ sweepExitPriceSuspects: sweepSuspects } = await import('./services/exit-price-suspects.js')) } catch { sweepSuspects = null }
              for (const acct of targets) {
                // Pacing only ever delays an account whose gap did NOT fill
                // last time — a permanently unfillable row (closing deal
                // older than the deal-history window) would otherwise buy a
                // broker fetch per account every cycle, forever.
                if (!closeSeen && !dueForBackfill(acct)) { skipped++; continue }
                try {
                  if (sweepSuspects) {
                    const sw = sweepSuspects(db, { accountId: acct })
                    if (sw.flagged || sw.cleared) log(`Exit-price suspects [${acct}]: ${sw.flagged} flagged, ${sw.cleared} cleared of ${sw.scanned} scanned`)
                  }
                  const creds = { host, clientId, clientSecret, accessToken, accountId: acct }
                  const { backfillAccountPnl } = await import('./services/cross-side-pnl.js')
                  const recovered = await backfillAccountPnl(db, { ...creds, ready: true }, { closeSeen })
                  if (recovered.skipped) { skipped++; continue }
                  if (recovered.error) throw new Error(recovered.error)
                  const bf = recovered.result
                  if (bf.positionHistory) log(`P&L position history [${acct}]: ${JSON.stringify(bf.positionHistory)}`)
                  if (bf.backfilled > 0) {
                    filled += bf.backfilled
                    log(`P&L backfill [${acct}]: filled ${bf.backfilled} broker-closed trade(s) with realized P&L`)
                  }
                } catch (e) {
                  log(`P&L backfill [${acct}] failed (non-fatal): ${e.message}`)
                }
              }

              // §70.9: BEAT IT, whatever happened. A repair that stops must be
              // visible as a stalled controller, not discovered later through
              // the veto it causes. `ok` is false only when the ledger has
              // rows the repair has never even reached — a gap it cannot fill
              // is a broker fact, a gap it never tried is our own.
              //
              // CORRECTED 02-09-2026 (codebase audit): `ok` was
              // `st.unresolved >= 0`, a count compared to zero — true unless
              // the SQL threw — so the failure this comment describes could
              // never be reported: the error text was computed and dropped,
              // consecutive_failures never moved, CONTROLLER FAILING could
              // not fire. It now keys on rows never attempted for longer than
              // the repair's own cadence (a row closed seconds ago is not a
              // failure, the paced pass may not have reached it yet).
              try {
                const { pnlReconciliationState, pnlUnreachedRows } = await import('./services/pnl-backfill.js')
                const st = pnlReconciliationState(db)
                const hb = await import('./services/heartbeat.js')
                const unreached = st.unresolved >= 0 && st.neverTriedOverdue > 0
                const detail = unreached ? { ...st, unreachedRows: pnlUnreachedRows(db) } : st
                if (unreached) log(`P&L reconciliation unreached rows: ${JSON.stringify(detail.unreachedRows)}`)
                hb.beat(db, 'pnl_reconcile', {
                  ok: st.unresolved >= 0 && !unreached,
                  error: st.unresolved < 0
                    ? 'pnl reconciliation state could not be read'
                    : unreached
                      ? `${st.neverTriedOverdue} closed trade(s) with no realised P&L have never been attempted (15+ min after close)`
                      : null,
                  detail,
                })
              } catch { /* observability only */ }

              if (filled === 0) {
                if (gapBefore === 0) {
                  log('P&L backfill: no gap this cycle — every closed trade already has realized P&L')
                } else {
                  // SPLIT BY WHAT CAN STILL BE DONE (17-09-2026). This used to
                  // print the bare `gapBefore` — every closed row with a NULL
                  // net_pnl, including the ones sweepUnresolvable has already
                  // written off with a reason. So it read "20 still missing …
                  // deal history had no matching close" every cycle for days,
                  // which a reader cannot tell from a broken repair, and which
                  // asserted something about BROKER COVERAGE for rows nobody
                  // had asked the broker about.
                  const { pnlGapBreakdown } = await import('./services/pnl-backfill.js')
                  const g = pnlGapBreakdown(db)
                  const tried = `after trying ${targets.length - skipped}/${targets.length} account(s) [${targets.join(', ')}]${skipped ? `, ${skipped} paced off` : ''}`
                  if (g.error) {
                    log(`P&L backfill: ${gapBefore} closed trade(s) missing net_pnl ${tried} — the gap could not be broken down (state unreadable), so which are still repairable is UNKNOWN`)
                  } else if (g.live === 0) {
                    // Not a failure: the ledger is honestly incomplete and the
                    // system has stopped pretending otherwise.
                    log(`P&L backfill: nothing left to repair — ${g.total} closed trade(s) have no realised P&L and all ${g.writtenOff} are written off with a reason (broker has no deal history past the horizon). They stay unknown, never zero.`)
                  } else {
                    const parts = [`${g.live} still repairable`]
                    if (g.attempted > 0) parts.push(`${g.attempted} asked for and the broker had no matching close`)
                    // The honest half: these say nothing about the broker.
                    if (g.neverTried > 0) parts.push(`${g.neverTried} never attempted${g.neverTriedOverdue > 0 ? ` (${g.neverTriedOverdue} overdue — the repair is not reaching them, which is ours, not coverage)` : ''}`)
                    if (g.writtenOff > 0) parts.push(`${g.writtenOff} already written off`)
                    log(`P&L backfill: ${g.total} closed trade(s) missing net_pnl ${tried} — ${parts.join('; ')}${g.oldestLive ? `; oldest repairable closed ${g.oldestLive}` : ''}`)
                  }
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
            // §7,437·B·2/B·4: score refused setups against the bars that
            // followed (broker fetch, capped per cycle) and score closed
            // plans against their execution (DB only). Both are records,
            // neither touches a decision.
            try {
              const { scoreRefusedOpportunities } = await import('./services/refusal-ledger.js')
              await scoreRefusedOpportunities(db, pmFetch, { maxPerCycle: 6, log })
            } catch (err) { log(`Refusal ledger failed (non-fatal): ${err.message}`) }
            try {
              const { scoreClosedPlans } = await import('./services/trade-plans.js')
              const sp = scoreClosedPlans(db)
              if (sp.scored > 0) log(`Trade plans: scored ${sp.scored} close(s) against the plan written at entry`)
            } catch (err) { log(`Trade plan scoring failed (non-fatal): ${err.message}`) }
            if (pm.classified > 0) {
              log(`Trade lessons: classified ${pm.classified} closed trade(s) — see the Desk Trade lessons`)
              // Close the learning loop: recompute the evidence-driven SL-widen
              // factors whenever new lessons land (self-clearing when the
              // stop-hunt pattern stops).
              const { refreshLessonTuning } = await import('./services/lessons-tuner.js')
              // Per account (02-09-2026): the account in play first, then
              // every other autopilot account — the sweep classifies closes
              // from all of them, and a per-account key nobody refreshes
              // would be a guard whose trigger never arrives.
              const factors = refreshLessonTuning(db, accountId)
              try {
                for (const a of getAutopilotAccounts(db)) {
                  if (String(a.accountId) !== String(accountId)) refreshLessonTuning(db, a.accountId)
                }
              } catch { /* best effort — the selected account is already refreshed */ }
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
            if (wb.exempt?.length) log(`Weekend bank: left ${wb.exempt.map(e => `${e.symbol} (position ${e.positionId})`).join(', ')} to the momentum book's stop — book rows are exempt from the sweep`)
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

          // EVERY CLOSE IS QUEUED FOR CAPTURE (owner, 17-09-2026). Not built
          // here: the broker's deal history does not carry the closing deal
          // the instant the position leaves the open list, so a record built
          // now would have no broker figures and be refused by the
          // completeness gate — a refusal caused by OUR timing rather than by
          // a real gap. The queue is durable, so a redeploy seconds after a
          // close does not lose it.
          try {
            const { enqueueCapture } = await import('./services/position-capture.js')
            for (const c of result.closedDetected || []) {
              enqueueCapture(db, { accountId, positionId: c.positionId, symbol: c.symbol })
            }
          } catch (err) {
            log(`Position capture enqueue failed: ${err.message}`)
          }

          // ...and drained here, in the same block, because this is where the
          // account's credentials are in scope. A capture that is due pulls
          // THAT position's deal window (not "the last N days"), builds the
          // record, appends it to the volume archive and offers it to
          // cpp-verify.
          //
          // The verifier is OPTIONAL and its absence is visible rather than
          // silent: until VERIFY_URL is set every record stays `unverified`,
          // which is precisely what it is. Nothing here decides a verdict on
          // the verifier's behalf — that would re-introduce the
          // self-certification the separate service exists to prevent.
          try {
            const { drainCaptureQueue, enqueueVerifyBacklog } = await import('./services/position-capture.js')
            const { verifyClient } = await import('./lib/verify-client.js')
            const verifier = verifyClient()
            // PR-AP: records built while cpp-verify was unreachable are
            // complete but never got a verdict, and their queue rows are
            // terminal, so nothing would ever revisit them. Re-arm a few per
            // pass into THIS queue rather than building a second scheduler —
            // it already paces (50 a drain), retries with backoff and gives
            // up loudly. Only when a verifier is configured: without one a
            // re-capture buys broker traffic and no answer.
            if (verifier) {
              // The pass decides what is worth saying — a non-zero arming
              // always, a zero only when its breakdown CHANGES. Logging only
              // on success is what made 18-09's zero unexplainable.
              const backlog = enqueueVerifyBacklog(db, { accountId })
              if (backlog.report) log(`Position capture [${accountId}]: ${backlog.report}`)
            }
            const drain = await drainCaptureQueue(db, {
              getDeals: async (t0, t1) => {
                const { wsGetDeals } = await import('./lib/ctrader-ws.js')
                return wsGetDeals(host, clientId, clientSecret, accessToken, accountId, t0, t1)
              },
              // The credentials travel with the call because cpp-verify holds
              // no defaults and needs POST /connect before it can answer.
              verify: verifier ? (record) => verifier(record, { host, clientId, clientSecret, accessToken, accountId }) : null,
              // B6: a symbol the lot-size registry has never seen is read from
              // the broker once, so the verifier can compare its volume.
              lotSizeFor: async (symbol) => {
                const { symbolIdFor } = await import('./services/position-history.js')
                const { getVolumeMeta } = await import('./lib/lot-sizing.js')
                const symbolId = symbolIdFor(db, symbol)
                if (symbolId == null) return null
                return getVolumeMeta(host, clientId, clientSecret, accessToken, accountId, symbolId)
              },
            })
            if (drain.due) {
              log(`Position capture: ${drain.captured} captured · ${drain.archived} archived · ${drain.verified} verified · ${drain.incomplete} still incomplete` +
                  (drain.gaveUp ? ` · ${drain.gaveUp} GAVE UP` : '') +
                  (verifier ? '' : ' (verifier unconfigured — records stay unverified)'))
              for (const e of drain.errors) log(`Position capture error: ${e}`)
            }
          } catch (err) {
            log(`Position capture drain failed: ${err.message}`)
          }

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
            const { recordAccountMoney } = await import('./services/account-money.js')
            recordAccountMoney(db, { accountId, host, trader, balance: bal })
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
              // `others` is already filtered to ONE side (`(a.is_live === 1)
              // === isLive` above), so this needs exactly that side's sidecar —
              // not EXEC_URL's. Under a split the wrong roster would skip every
              // cross-account reconcile on the other side.
              const { sidecarRosterForSide } = await import('./lib/exec-engine.js')
              const roster = await sidecarRosterForSide(isLive)
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
                        reason: `enabled in registry but not in the ${isLive ? 'LIVE' : 'demo'} sidecar's authorized roster — reconcile sweep skipped until it reconnects`,
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

                // PR-E M2 (checker, 11-09-2026): this account's intents settle
                // on ITS snapshot and ITS deal history — until now only the
                // primary pass reconciled intents, so an UNKNOWN on any other
                // account could never be resolved automatically. Same two
                // steps as the primary pass (expireStale is global and ran
                // there); best-effort per account.
                try {
                  const { reconcileIntents, settleUnknownsFromDealHistory } = await import('./services/entry-ledger.js')
                  const rc2 = reconcileIntents(db, { accountId: acc.account_id, positions: rd.position || [], orders: rd.order || [] })
                  if (rc2.resolved.length) log(`Entry ledger …${String(acc.account_id).slice(-4)}: ${rc2.resolved.length} resolved by evidence (${rc2.resolved.map(r => `${r.intentId} ${r.from}→${r.to}`).join(', ')}), ${rc2.stillOpen} still open`)
                  const { wsGetDeals } = await import('./lib/ctrader-ws.js')
                  const dh2 = await settleUnknownsFromDealHistory(db, {
                    accountId: acc.account_id, getDeals: (t0, t1) => wsGetDeals(host, clientId, clientSecret, accessToken, acc.account_id, t0, t1),
                  })
                  if (dh2.filled?.length || dh2.stillUnknown) {
                    log(`Entry ledger …${String(acc.account_id).slice(-4)} deal history: ${dh2.pulled} deal(s) over ${dh2.pages} page(s)${dh2.truncated ? ' (TRUNCATED)' : ''}, ${dh2.filled.length} FILLED, ${dh2.stillUnknown} still UNKNOWN`)
                  }
                } catch (err) {
                  log(`Entry ledger [${acc.account_id}] failed (non-fatal): ${err.message}`)
                }

                // THIS ACCOUNT'S OWN EQUITY. The primary pass above stamps the
                // selected account's balance and leverage; this sweep used to
                // reconcile positions and audit protection for every other
                // account and never ask the broker what they were worth. With
                // nothing stamped, getAccountBalance falls through to the
                // unowned global — whichever account refreshed it last — so a
                // percentage loss cap on those accounts was priced against
                // somebody else's equity (measured 2026-08-15: ACCT-LIVE-2 and
                // ACCT-DEMO-5 both reporting the selected account's 35,319.80,
                // making a 3% cap ~51x too permissive to ever bind).
                try {
                  const { stampAccountEquity } = await import('./services/account-equity.js')
                  const eq = await stampAccountEquity(
                    db, { host, clientId, clientSecret, accessToken }, acc.account_id,
                  )
                  if (eq.error) log(`Equity[${acc.account_id}]: not stamped — ${eq.error}`)
                  else if (eq.balance == null) log(`Equity[${acc.account_id}]: broker returned no usable balance`)
                } catch { /* equity is best-effort; never break the sweep */ }

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
                    const { makeTargetSuggester: mkSuggest2, makeTargetApplier: mkApply2 } =
                      await import('./services/tp-suggest.js')
                    // Same creds shape the suggester's bar fetch needs, scoped
                    // to THIS account — the pass's own snapshot, own truth, and
                    // the amend below must never land on another account.
                    const creds2 = { host, clientId, clientSecret, accessToken, accountId: acc.account_id }
                    const p2 = await runProtectionAudit(db, rows2, bp2, {
                      sendMessage: notify2, accountId: acc.account_id,
                      suggestTarget: mkSuggest2(db, creds2, pos2),
                      applyTarget: mkApply2(db, creds2),
                    })
                    if (p2.naked.length || p2.targetless.length || p2.phantom.length || (p2.tpDrift || []).length) {
                      log(`PROTECTION AUDIT[${acc.account_id}]: ${p2.naked.length} with NO stop, ${p2.targetless.length} with no take profit, ${p2.phantom.length} disagreement(s), ${(p2.tpDrift || []).length} target drift(s)`)
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

          // The opposite side has its OWN broker session. Reconcile its local
          // rows from a fresh account-identified read, without changing the
          // selected account or placing/amending/cancelling broker orders.
          const crossReconciled = await reconcileCrossSideAccounts(db, getCtraderCreds(db))
          for (const r of crossReconciled) {
            if (r.result) log(`Reconcile[${r.accountId}] cross-side: ${r.result.newExternal.length} new external, ${r.result.closedDetected.length} closed, ${(r.result.orphansClosed || []).length} orphan(s)`)
            else log(`Reconcile[${r.accountId}] cross-side: ${r.skipped ? `skipped (${r.skipped})` : `failed — ${r.error}`}`)
          }
          // Closing a local row must reach the P&L repair on the same host.
          // The earlier same-side pass cannot fetch the opposite account's
          // deals. Report these reads separately, preserving its own pacing.
          try {
            const { backfillCrossSidePnl } = await import('./services/cross-side-pnl.js')
            const recovered = await backfillCrossSidePnl(db, getCtraderCreds(db), crossReconciled)
            for (const r of recovered) {
              if (r.result) log(`P&L backfill [${r.accountId}] cross-side: ${r.result.backfilled} filled, ${r.result.scanned} deals read, ${r.result.gap} gaps before read; ${r.result.lifetimeSkipped || 0} positions outside verified lifetime window`)
              else log(`P&L backfill [${r.accountId}] cross-side: ${r.skipped ? `skipped (${r.skipped})` : `failed — ${r.error}`}`)
              if (r.result?.positionHistory) log(`P&L position history [${r.accountId}]: ${JSON.stringify(r.result.positionHistory)}`)
            }
          } catch (err) { log(`Cross-side P&L recovery failed (non-fatal): ${err.message}`) }

          // ---- CROSS-SIDE EQUITY (READ ONLY) -----------------------------
          // An account whose balance is
          // never read answers out of the unowned global — measured
          // 2026-08-16 with the session on demo, the live accounts ACCT-LIVE-2
          // and ACCT-DEMO-5 reported the selected DEMO account's 35,319.80
          // through /state/profit-ratchet while /state/account-engineering
          // showed `None` for the same two. Two endpoints, same accounts,
          // different answers.
          //
          // Reading what an account is worth is not managing it, so this
          // crosses the boundary for that ONE purpose: wsGetTrader per
          // account on that account's own host, writing only its own two
          // `acct:<id>:` keys. No positions, no orders, no audit, and never
          // the legacy global.
          try {
            const { sweepCrossSideEquity } = await import('./services/account-equity.js')
            const x = await sweepCrossSideEquity(db, { clientId, clientSecret, accessToken }, { isLive })
            crossSideEquitySeeded = true
            if (x.swept > 0 || x.skipped?.length) {
              // A failure can be SILENT: stampAccountEquity returns
              // { balance: null, error: null } when the broker answered but
              // the balance decoded to 0/NaN (an unfunded account, by the
              // `> 0` stamp gate). Filtering on r.error alone printed
              // "1/3 stamped — " with nothing after the dash — a line that
              // reports failure and cannot say why (measured 2026-08-27:
              // ACCT-LIVE-2/3, both zero-balance). Name both kinds.
              const why = x.results
                .filter(r => !r.skipped && (r.error != null || r.balance == null))
                .map(r => `${r.accountId}: ${r.error ?? 'broker answered, balance 0/unusable — not stamped'}`)
                .join(' · ')
              // B7: refused accounts are named as skipped, not asked and not failed.
              const skippedNote = x.skipped?.length
                ? ` — skipped ${x.skipped.length} (token refused): ${x.skipped.map(a => `…${String(a).slice(-4)}`).join(', ')}`
                : ''
              log(`Cross-side equity: ${x.stamped}/${x.swept} ${isLive ? 'demo' : 'live'} account(s) stamped`
                + (x.failed ? ` — ${why}` : '') + skippedNote)
            }
            // A stamp that failed on every account is a failed run; one that
            // stamped some is a run with a named gap, already logged above.
            await hbeat(db, 'cross_side_equity', !(x.swept > 0 && x.stamped === 0),
              x.swept > 0 && x.stamped === 0 ? `0/${x.swept} stamped` : null)
          } catch (err) { await hbeat(db, 'cross_side_equity', false, err?.message) /* equity is best-effort; never break the cycle */ }
          // Wave 3 (first-principles audit 19-09-2026 §K item 11): the
          // NIGHTLY equity snapshot — balance + the broker's net unrealised
          // P&L per enabled account on both sides, one row each, once every
          // 24 h on a persisted stamp (equity_snapshot_last_at) so a
          // restart resumes the schedule. Read-only against the broker,
          // bounded, best-effort: the curve shows a null night, never a
          // guessed one.
          try {
            const { equitySnapshotDue, runEquitySnapshot } = await import('./services/equity-snapshot.js')
            if (equitySnapshotDue(db)) {
              const snap = await runEquitySnapshot(db, { clientId, clientSecret, accessToken })
              const gaps = snap.results.filter(r => r.equity == null).map(r => `…${String(r.accountId).slice(-4)}: ${r.error ?? 'no equity'}`).join(' · ')
              log(`Equity snapshot: ${snap.written}/${snap.swept} account(s) written` + (snap.failed ? ` — ${gaps}` : '')
                + (snap.skipped?.length ? ` — skipped ${snap.skipped.length} (token refused)` : ''))
              await hbeat(db, 'equity_snapshot', !(snap.swept > 0 && snap.written === 0), snap.swept > 0 && snap.written === 0 ? `0/${snap.swept} written` : null)
            }
          } catch (err) { await hbeat(db, 'equity_snapshot', false, err?.message) }
          // Wave 5 (first-principles audit 19-09-2026 §K item 16): the DAILY
          // REPORT to Telegram, on the same 24 h persisted cursor shape
          // (daily_report_last_at, stamped before the work). Reads the DB
          // only — the goal table, the momentum week, the equity curve, the
          // family edge, the veto rate, arming changes, open positions — and
          // posts through the outbox so quiet hours apply.
          try {
            const { dailyReportDue, postDailyReport } = await import('./services/daily-report.js')
            if (dailyReportDue(db)) {
              const dr = await postDailyReport(db)
              log(`Daily report: ${dr.ok ? `${dr.chars} chars, ${dr.delivery}${dr.truncated ? ', truncated' : ''}` : `FAILED — ${dr.error}`}`)
              await hbeat(db, 'daily_report', dr.ok, dr.ok ? null : dr.error)
            }
          } catch (err) { await hbeat(db, 'daily_report', false, err?.message) }
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
      const { weekendQuietNow, quietUntilMs, quietScanSymbols, preOpenHoursFrom } = await import('./lib/quiet-hours.js')
      const weekendQuiet = weekendQuietNow()

      // PRE-OPEN WINDOW (owner 09-08-2026): "some markets which open on Monday
      // should start monitoring and set pre-trade 6 hours before". Quiet hours
      // and that instruction were in conflict — on a Sunday evening the
      // symbols about to open were exactly the ones narrowed out of the scan.
      // A symbol now rejoins the scan when ITS OWN next open is within the
      // window, read from the broker's schedule rather than a guessed session
      // table. Everything with nothing opening soon stays quiet as before.
      const { nextOpenInfo } = await import('./services/symbol-hours.js')
      const preOpenHours = preOpenHoursFrom(getState(db, 'pre_open_hours'))
      const nowForHours = new Date()
      const quietPick = weekendQuiet
        ? quietScanSymbols(allSymbols, categoriseSymbol, nowForHours.getTime(), {
          preOpenHours,
          hoursFor: (sym) => nextOpenInfo(db, sym, nowForHours),
        })
        : null
      const symbols = weekendQuiet ? quietPick.symbols : allSymbols
      if (weekendQuiet && quietPick.preOpen?.length) {
        log(`Pre-open window (${preOpenHours}h) — ${quietPick.preOpen.length} symbol(s) rejoin the scan before their open: ${quietPick.preOpen.join(', ')}`)
      }

      if (allSymbols.length === 0) {
        log('No enabled symbols configured')
      } else if (weekendQuiet && symbols.length === 0) {
        log(`Weekend quiet hours — no crypto on the watchlist and nothing opening within ${preOpenHours}h, so no scan or recommendations until ${new Date(quietUntilMs()).toISOString()} (Mon 01:00 SGT); monitoring/protection unaffected`)
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
          log(`Weekend quiet hours — crypto + pre-open scan (${symbols.length} of ${allSymbols.length} symbols) until ${new Date(quietUntilMs()).toISOString()} (Mon 01:00 SGT); everything with nothing opening within ${preOpenHours}h stays quiet`)
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
      ? await runFibScan(ctraderCreds, symbolMap, symbols, { hotThreshold: 6, ...stageFilterOpts, strategies, armedStrategyKeys, extraTimeframes, matrix: scanMatrix, armedTfs: extraTimeframes.length ? extraTimeframes : null, cursor: scanCursor, prioritySymbols, prioritySpikeSymbols, deadlineAt: scanDeadlineAt, onEvaluation: scannerObserver(db, ctraderCreds) })
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

    // Momentum SHADOW (owner "do ¶A·5", 02-09-2026): rank the same universe
    // by trailing return and log would-be entries/exits/refusals to
    // momentum_shadow. Off until the owner enables it, throttled to its own
    // interval, and it proposes nothing — see momentum-shadow.js. A failure
    // here is logged and the cycle moves on.
    if (ctraderCreds.ready) {
      try {
        const { runMomentumShadow } = await import('./services/momentum-shadow.js')
        // BREADTH IS THE FUEL (§7,386·D1): the momentum universe (data,
        // config/momentum-universe.json) is ranked ahead of the scan's own
        // symbols, so the shadow's maxSymbols cap never trims the universe.
        const { momentumUniverseSymbols } = await import('./services/momentum-account.js')
        const shadowSymbols = [...new Set([...momentumUniverseSymbols(db), ...symbols.map(s => String(typeof s === 'string' ? s : s?.symbol || '').toUpperCase())])].filter(Boolean)
        const ms = await runMomentumShadow(db, { symbols: shadowSymbols, symbolMap, creds: ctraderCreds, loopId: loopCount })
        if (ms.ran) log(`momentum shadow: ranked ${ms.ranked}/${ms.universe}, ${ms.rows} row(s), ${ms.holdings ?? 0} shadow holding(s)${ms.why ? ` — ${ms.why}` : ''}`)
      } catch (err) {
        log(`momentum shadow failed: ${err.message}`)
      }
    }

    // MOMENTUM BOOK (owner order 03-09-2026: "long-only momentum on demo &
    // live"): the shadow's long entries and exits become real positions on
    // every account where tsmom_long is trade-armed, sized by the risk gate
    // through autoTrade, managed by the book (trailing stop, rank exit) with
    // the keeper paused. Off until enabled; a failure is logged and the
    // cycle moves on.
    if (ctraderCreds.ready) {
      try {
        const { runMomentumBook, atrOf } = await import('./services/momentum-book.js')
        const { scanRates } = await import('./services/risk.js')
        const { getRegimeBars } = await import('./services/fib-strategy.js')
        const { wsGetSpotOnce, wsReconcile } = await import('./lib/ctrader-ws.js')
        const { amendBookStop } = await import('./services/book-stop-amend.js')
        const exec = await import('./lib/exec-engine.js')
        const { effectivePhases } = await import('./services/account-phases.js')
        const { accountMayTrade } = await import('./services/watchlists.js')
        const bookCfg = (await import('./services/momentum-book.js')).loadMomentumBook(db)
        const { isFundable } = await import('./services/fundable-universe.js')
        const mb = await runMomentumBook(db, {
          accounts: getAutopilotAccounts(db),
          credsFor: (a) => getCtraderCreds(db, a),
          now: Date.now(),
          log,
          deps: {
            autoTrade,
            symbolMap,
            // THIS ACCOUNT's id for the symbol (03-09-2026) — the global map
            // gave ACCT-LIVE-1 other instruments for LLY.US and GD.US.
            symbolIdFor: async (creds, symbol) => (await (await import('./lib/ctrader-creds.js')).resolveSymbolId(db, creds, symbol)).id,
            bars: async (creds, symbolId) => (await getRegimeBars(creds, symbolId, { preferredTfs: [bookCfg.timeframe], fallbackTf: bookCfg.timeframe, count: bookCfg.atrPeriod + 10 })).bars,
            spot: (creds, symbolId) => wsGetSpotOnce(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId).catch(() => null),
            // Read broker protection freshly, preserve its TP and confirm the
            // resulting SL before the book updates its own records.
            amend: (creds, args) => amendBookStop(creds, args, {
              amend: exec.amendPosition,
              readPosition: async (c, positionId) => {
                const rec = await wsReconcile(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId, 5000, 0)
                if (String(rec.ctidTraderAccountId) !== String(c.accountId)) throw new Error('book protection account identity mismatch')
                return (rec.position || []).find(p => String(p.positionId) === String(positionId)) || null
              },
            }),
            // Price precision for the trailed stop (04-09-2026): the amend is
            // an absolute price and the broker rejects one with more decimals
            // than the symbol allows. Cached per process in lot-sizing.
            digitsFor: async (creds, symbolId) => (await (await import('./lib/lot-sizing.js')).getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)).digits,
            close: (creds, args) => exec.closePosition(creds, args),
            // The broker's volume for a position (09-09-2026): a close without
            // one is refused by cTrader (LLY.US rank exit, 17:00 SGT).
            positionVolume: async (creds, positionId) => brokerPositionVolume((await exec.reconcile(creds)).position || [], positionId),
            phasesOn: (accountId) => !!effectivePhases(db, accountId)?.autotrade,
            mayTrade: (accountId, symbol) => accountMayTrade(db, accountId, symbol),
            // The scan's own symbols: the row-cursor accounts keep this
            // universe; the momentum universe is the momentum account's.
            scanSymbols: symbols.map(s => String(typeof s === 'string' ? s : s?.symbol || '').toUpperCase()).filter(Boolean),
            // The momentum account's universe build (§7,386·D1): lot meta for
            // affordability, this account's equity for the vol target, the
            // scan's rates for non-USD notional, the book's own ATR.
            volumeMeta: async (creds, symbolId) => (await import('./lib/lot-sizing.js')).getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId),
            equity: (accountId) => getAccountBalance(db, accountId),
            rates: () => { try { return scanRates(db) } catch { return null } },
            atrOf: (bars) => atrOf(bars, bookCfg.atrPeriod),
            // The same pool the dispatch draws on (owner § 7,453·B): an
            // exhausted account takes no book entries this pass and the
            // richest account is tried first. null = unknown, not exhausted.
            marginHeadroom: (accountId) => marginPoolForCycle(db).find(p => p.accountId === String(accountId))?.status?.headroom ?? null,
            // Wave 1: the risk gate's per-account position cap, so the book
            // sizes and enters against ONE cap.
            maxOpenPositions: (accountId) => { try { return Number(loadRiskConfig(db, String(accountId))?.maxOpenPositions) || null } catch { return null } },
            // The account's daily fundable universe (§7,437·B·3): an
            // unfundable name is skipped by name, unknown dispatches as before.
            fundable: (accountId, symbol) => isFundable(db, accountId, symbol),
          },
        })
        // PR-AX: `reclassified` prints only when non-zero. It should be a
        // one-off burst clearing the backlog of rows stranded in `exit_sent`
        // and then near-silent; a line that keeps reporting reclassifications
        // every pass means rows are re-entering the state faster than their
        // trades close, which is a different problem and worth seeing.
        if (mb.ran) log(`momentum book: ${mb.entries} entered, ${mb.exits} exited, ${mb.trailed} trailed${mb.reclassified ? `, ${mb.reclassified} exit_sent row(s) reclassified closed` : ''} on ${mb.accounts} account(s)${mb.skipped.length ? ` — ${mb.skipped.slice(0, 4).join('; ')}` : ''}`)
        if (mb.momentumAccount) log(`momentum account …${String(mb.momentumAccount.account).slice(-4)}: daily pass — ${mb.momentumAccount.entries} entered, ${mb.momentumAccount.exits} exited; universe ${mb.momentumAccount.universe?.tradable}/${mb.momentumAccount.universe?.total} tradable${mb.momentumAccount.universe?.byReason ? ` (${Object.entries(mb.momentumAccount.universe.byReason).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`)
      } catch (err) {
        log(`momentum book failed: ${err.message}`)
      }

      // FUNDABLE UNIVERSE, daily per account (§7,437·B·3, 08-09-2026). ONE
      // account per cycle, the first whose record is a day old (or was asked
      // to rebuild), so the broker sees at most one watchlist's worth of
      // lookups per loop. The record is what the fan-out and the book read.
      try {
        const { fundableDue, buildFundableUniverse } = await import('./services/fundable-universe.js')
        const { wsGetSpotOnce } = await import('./lib/ctrader-ws.js')
        const due = getAutopilotAccounts(db).find(a => fundableDue(db, a.accountId))
        if (due) {
          const creds = getCtraderCreds(db, due)
          if (!creds) throw new Error(`no credentials for …${String(due.accountId).slice(-4)}`)
          const rec = await buildFundableUniverse(db, {
            accountId: due.accountId, creds,
            deps: {
              symbolIdFor: async (c, symbol) => (await (await import('./lib/ctrader-creds.js')).resolveSymbolId(db, c, symbol)).id,
              volumeMeta: async (c, symbolId) => (await import('./lib/lot-sizing.js')).getVolumeMeta(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId, symbolId),
              spot: (c, symbolId) => wsGetSpotOnce(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId, symbolId).catch(() => null),
              rates: () => { try { return scanRates(db) } catch { return null } },
              headroomOf: (accountId) => marginPoolForCycle(db).find(p => p.accountId === String(accountId))?.status?.headroom ?? null,
            },
          })
          if (rec.complete) {
            log(`Fundable universe …${String(due.accountId).slice(-4)}: complete — ${rec.summary.fundable}/${rec.summary.total} fundable at min lot, ${rec.summary.unfundable} unfundable, ${rec.summary.unknown} not judged (${Object.entries(rec.summary.byReason).map(([k, v]) => `${k} ${v}`).join(', ') || 'empty watchlist'}) — budget $${rec.riskBudgetUsd}, headroom ${rec.headroomUsd != null ? `$${rec.headroomUsd}` : 'unknown'}`)
            await hbeat(db, 'fundable_universe')
          } else {
            log(`Fundable universe …${String(due.accountId).slice(-4)}: ${rec.judgedThisCall} judged this cycle, ${rec.remaining} of ${rec.summary.total} still pending — continues next cycle`)
          }
        }
      } catch (err) {
        log(`Fundable universe build failed (non-fatal): ${err.message}`)
        hbeat(db, 'fundable_universe', false, err.message)
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
      // FAIR SHARE ACROSS ARMED STRATEGIES (owner 05-08-2026, from the
      // Strategy Liveness card: "lots of wasted efforts ... cannot trade").
      //
      // Measured, 7 days: five armed strategies produced 3,668 signals and
      // ZERO decisions — they never reached the risk gate, because the three
      // slots below always went to the same three strategies. Conviction is
      // saturated at 9-10 across the board, so `ranked` is a wide tie and this
      // slice took whatever sorted first. vp_value has the HIGHEST average
      // conviction of any strategy and had not been analysed once.
      //
      // fairShareSlots gives each strategy present in the batch one slot,
      // least-recently-analysed first, then fills any remainder best-first as
      // before. The loud strategies still take most slots — they appear in
      // most batches — but no strategy can be starved indefinitely.
      // HORIZON GATE BEFORE ANALYSIS (§7,437·B·6, 08-09-2026). A candidate
      // whose every scan row (strategy@timeframe) NO armed account's declared
      // horizon admits is dropped here, before the analysis slots are
      // handed out — the intraday stack was being analysed sixty times an
      // hour for accounts that would never take it. Unlike the cluster rule
      // above, an emptied list is the intended outcome: nobody can trade
      // what remains, so nothing is analysed and the line says why. With no
      // declarations anywhere this filter is the identity.
      const beforeHorizon = afterCluster.length ? afterCluster : ranked
      let afterHorizon = beforeHorizon
      try {
        const { anyAccountAdmits } = await import('./services/account-horizon.js')
        const { effectivePhases: phasesOf } = await import('./services/account-phases.js')
        const horizonAccounts = getAutopilotAccounts(db).map(a => String(a.accountId)).filter(id => { try { return !!phasesOf(db, id)?.autotrade } catch { return false } })
        if (horizonAccounts.length) {
          const bySym = new Map()
          for (const sc of scanResult.scans || []) {
            if (sc.bias === 'skip' || !sc.strategy) continue
            if (!bySym.has(sc.symbol)) bySym.set(sc.symbol, [])
            bySym.get(sc.symbol).push(sc)
          }
          const dropped = []
          afterHorizon = beforeHorizon.filter(sym => {
            const rows = bySym.get(sym) || []
            if (!rows.length) return true
            const admitted = rows.some(sc => anyAccountAdmits(db, horizonAccounts, { timeframe: sc.timeframe, strategy: sc.strategy }).ok)
            if (!admitted) dropped.push({ sym, rows })
            return admitted
          })
          if (dropped.length) {
            log(`Horizon gate: ${dropped.length} candidate(s) skipped before analysis — no armed account trades that horizon: ${dropped.slice(0, 6).map(d => `${d.sym} (${d.rows.map(r => `${r.strategy}@${r.timeframe}`).join(',')})`).join(' · ')}`)
            try {
              const { recordDecision } = await import('./services/decision-log.js')
              for (const d of dropped) {
                recordDecision(db, {
                  symbol: d.sym, timeframe: d.rows[0]?.timeframe ?? null, strategy: d.rows[0]?.strategy ?? null,
                  stage: 'horizon', decision: 'skip',
                  reason: `no armed account's horizon admits ${d.rows.map(r => `${r.strategy}@${r.timeframe}`).join(', ')}`,
                })
              }
            } catch { /* provenance never blocks */ }
          }
        }
      } catch (err) {
        log(`Horizon gate failed (non-fatal, analysing the unfiltered list): ${err.message}`)
        afterHorizon = beforeHorizon
      }
      // ARMED SCOPE BEFORE THE SLOT IS SPENT (16-09-2026). Measured in
      // production over 28 minutes with `autotrade_scope = 'armed'`: 38 of
      // ~60 completed analyses were discarded by the backstop gate further
      // down this file, which only sees the timeframe AFTER synthesis. Two
      // thirds of a three-slot budget went to cells that could not trade.
      // A symbol whose scan produced NO row on a timeframe armed for it is
      // dropped here, with a reason, so the slot goes to one that can — the
      // same shape as the horizon gate above, and, like it, an emptied list
      // is the intended outcome rather than a reason to fall back. The
      // backstop gate is untouched; this only decides where the budget goes.
      // The scope check lives INSIDE filterArmedCandidates / armedPickerFor,
      // where a test can call it, rather than as an `if` here that only a
      // source-text assertion could pin. Under 'all' both are the identity.
      const autotradeScope = getState(db, 'autotrade_scope') || 'all'
      const armedAllowedTfs = armedTimeframes(db, getState)
      let armedMatrix = null
      try { armedMatrix = JSON.parse(getState(db, 'autotrade_matrix_json') || 'null') } catch { armedMatrix = null /* corrupt — the list gates */ }
      try {
        const { filterArmedCandidates } = await import('./services/armed-analysis-filter.js')
        const armedPool = filterArmedCandidates(afterHorizon, scanResult.scans, { scope: autotradeScope, allowedTfs: armedAllowedTfs, matrix: armedMatrix })
        if (armedPool.dropped.length) {
          log(`Armed scope pre-filter: ${armedPool.dropped.length} candidate(s) skipped before analysis — ${armedPool.dropped.slice(0, 6).map(d => `${d.symbol} (${d.reason})`).join(' · ')}`)
          try {
            const { recordDecision } = await import('./services/decision-log.js')
            for (const d of armedPool.dropped) {
              recordDecision(db, {
                symbol: d.symbol,
                timeframe: d.attribution?.timeframe ?? null,
                strategy: d.attribution?.strategy ?? null,
                stage: 'armed_scope_prefilter', decision: 'skip', reason: d.reason,
              })
            }
          } catch { /* provenance never blocks */ }
        }
        // Reassigned, not a new name, so the slot allocator below keeps
        // reading one list and cannot be handed the unfiltered one.
        afterHorizon = armedPool.kept
      } catch (err) {
        log(`Armed scope pre-filter failed (non-fatal, analysing the unfiltered list): ${err.message}`)
      }
      const pool = afterHorizon
      let hotToAnalyze = pool.slice(0, 3)
      let fairShare = null
      // THE LRU CLOCK IS STAMPED BY WHAT WAS ANALYSED, NOT BY WHAT WAS PLANNED
      // (checker, 16-09-2026). It used to be written here, before dispatch,
      // from `fairShare.byStrategy` — the strategies the slots were GRANTED
      // to. Under scope 'armed' the armed pick below may dispatch a different
      // strategy, so the granted one would be marked analysed without being
      // analysed (the exact defect the comment further down documents), and
      // the dispatched one's clock would never advance — leaving it
      // permanently "hungriest" in fairShareSlots' round-one sort and taking
      // other strategies' slots forever. The write now happens AFTER the
      // dispatch loop, from the strategies actually dispatched. Under scope
      // 'all' the dispatched strategy IS the granted one (the fallback reads
      // `signalsByStrategy[sym][want]`, built from the same rows the
      // allocator ranked), so that path is unchanged.
      let markLruAnalysed = null
      try {
        const { fairShareSlots, markAnalyzed, fairShareLine, LAST_ANALYZED_KEY } =
          await import('./services/analyze-fair-share.js')
        let lastAnalyzed = {}
        try { lastAnalyzed = JSON.parse(getState(db, LAST_ANALYZED_KEY) || '{}') || {} } catch { lastAnalyzed = {} }
        fairShare = fairShareSlots(scanResult.scans, pool, {
          slots: 3,
          lastAnalyzed,
          provenEdgeSymbols: provenEdgeSymbolsFrom(baseline),
        })
        if (fairShare.picked.length) {
          hotToAnalyze = fairShare.picked
          markLruAnalysed = (strategies) => {
            const keys = [...new Set((strategies || []).filter(Boolean))]
            if (keys.length) setState(db, LAST_ANALYZED_KEY, JSON.stringify(markAnalyzed(lastAnalyzed, keys)))
          }
          const line = fairShareLine(fairShare)
          if (line) log(`Analyze slots (fair share): ${line}`)
        }
      } catch (err) {
        // Slot allocation must never be the reason a cycle analyses nothing —
        // the old best-first list is already in hotToAnalyze.
        log('Fair-share slot allocation failed (non-fatal, using best-first):', err.message)
      }
      // A slot granted to a STRATEGY must dispatch that strategy's signal.
      // Until now the slot allocator picked a symbol because (say) cup_handle
      // signalled there, and then dispatch handed over `signals[sym]` — the
      // conviction winner, which was fib_confluence. So the fair share was
      // real at the allocation step and thrown away at the dispatch step, and
      // the starved strategy stayed starved while the logs said otherwise.
      const slotStrategy = new Map((fairShare?.byStrategy || []).map(b => [b.symbol, b.strategy]))
      phase(`analyzing ${hotToAnalyze.join(', ')}`, 'analyze')
      // Scope 'armed' only: among the signals this scan really produced for
      // the symbol, dispatch one on a timeframe that is armed for it. The
      // per-symbol winner (`signals[sym]`) is chosen by armed-STRATEGY then
      // conviction and never looks at the timeframe, which is why US30 was
      // analysed on 30m every pass while 12h/4d/1d/1w/3d were armed and 1d/1w
      // were right there in the scan. Nothing is invented: if no candidate is
      // on an armed timeframe this returns null, the old choice stands, and
      // the backstop gate refuses it exactly as before.
      // The picker ranks the way the scan does — armed STRATEGY first, then
      // conviction — so it cannot hand the slot to a strategy the stage gate
      // will block. `armedStrategyKeys` is the same list the scan was given.
      const { armedPickerFor, takeArmedGateStats, armedGateWasteLine } =
        await import('./services/armed-analysis-filter.js')
      const armedPick = armedPickerFor(autotradeScope, { allowedTfs: armedAllowedTfs, matrix: armedMatrix, armedStrategyKeys })
      const dispatchedStrategies = []
      for (const sym of hotToAnalyze) {
        try {
          const want = slotStrategy.get(sym)
          const fallback = (want && scanResult.signalsByStrategy?.[sym]?.[want]) || scanResult.signals[sym]
          const candidates = [...new Set([
            ...Object.values(scanResult.signalsByStrategy?.[sym] || {}),
            ...(scanResult.signals[sym] ? [scanResult.signals[sym]] : []),
          ])]
          const armed = armedPick(sym, want || null, candidates)
          if (armed && armed.signal !== fallback) {
            log(`Armed scope pick: ${sym} — analysing ${armed.reason} instead of ${fallback?.strategy || '?'}@${fallback?.timeframe || '?'} (that cell cannot trade under the current arming)`)
          }
          const dispatched = armed?.signal || fallback
          dispatchedStrategies.push(dispatched?.strategy || want || null)
          await dispatchSymbolSignal(db, s, symbols, sym, dispatched)
        } catch (err) {
          log(`Analysis failed for ${sym}:`, err.message)
        }
      }
      // The clock advances for what really ran (see the note above the
      // allocator). A symbol that threw before dispatch stamps nothing.
      if (markLruAnalysed) markLruAnalysed(dispatchedStrategies)
      // The waste rate, printed rather than inferred from log archaeology.
      // Take-and-reset: every counted analysis is reported exactly once, at
      // worst one cycle late for the pending-signals retry path. Silent when
      // nothing was discarded, so scope 'all' never sees it.
      const wasteLine = armedGateWasteLine(takeArmedGateStats())
      if (wasteLine) log(wasteLine)
    }

      try {
        recordScannerWork(db, { creds: ctraderCreds, scopeAccounts: rosterIds, symbolMap, result: scanResult,
          completedAt: Date.now(), cadenceMs: loopIntervalMs(db), nextDue: Math.max(start + loopIntervalMs(db), Date.now() + 10_000) })
      } catch { /* observation never controls the scanner or order owner */ }
      } // end scanEnabled + symbols (scan+analyze branch)

      // ---------------------------------------------------------------------
      // PENDING-ORDER MODE — resting fib-61.8% LIMIT orders, armed per
      // symbol×timeframe. Inert unless the owner enabled the flag; a failure
      // here must never take down the scan/monitor loop.
      // ---------------------------------------------------------------------
      // Wave 5 (§K·15): a retired producer's phase is not run and not
      // beaten — heartbeat.js carries the controller as retired so the panel
      // says so instead of reading it as stalled.
      if (!PENDING_PRODUCER_RETIRED) try {
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
          const pendingCreds = getCtraderCreds(db, undefined, { producerId: 'pending_fib_orders' })
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
        await hbeat(db, 'closed_market_sweep')
      } catch (err) {
        await hbeat(db, 'closed_market_sweep', false, err.message)
        log(`Closed-market limit sweep failed (non-fatal): ${err.message}`)
      }

      // BURN-IN MODE — track-record trades (owner-armed): min-size positions
      // through the full auto-trade path with tight time caps, so completed
      // round-trips accumulate fast. Inert unless burn_in_json.on AND
      // autotrade armed; a failure must never take down the loop.
      // Wave 1 of the first-principles audit (19-09-2026, §K·5): burn-in is
      // RETIRED — −$3,989 over 122 deals and 69 of the last 168 time-cap
      // closes were its probes. The loop no longer runs it whatever the
      // stored `burn_in_json.on` says; the module and its route stay for
      // the record. The heartbeat keeps its slot so the controllers table
      // reads "retired", not "stale".
      try {
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
      // LOSS GUARDIAN NOW RUNS ON THE FAST MONITOR — see fast-monitor.js.
      //
      // It is the last §41 level-4 writer that was still riding the 5-minute
      // cycle, and the one with the worst argument for being there: it places
      // a protective stop on a position that has NONE. A naked losing position
      // waiting out a slow scan is the exact case §70.7 is about.
      //
      // MOVED, not copied — it amends stops and closes positions, and
      // §36.2.3 forbids two components writing the same stop.

      // Periodic broker-truth market-hours refresh — pull each mapped
      // FX conversion legs — sizing infrastructure, refreshed on its own
      // schedule (services/fx-legs.js). Production 03-08-2026: 1,859 entries
      // in seven days died at `usd_per_lot_unknown` because USDPLN, USDNOK and
      // USDCAD had not been scanned since 01-08 and the rate table correctly
      // refuses anything older than 26 hours. The scanner looks for trades,
      // not for conversion rates; leaving the rates to it is what broke.
      // Cheap by construction: only legs older than six hours are fetched,
      // capped per cycle, so the steady state is zero broker calls.
      // V3 M1: named, so its time stops landing in whichever phase ran before
      // it — the #1079 first loop's 63,914 ms post-scan bucket could not be
      // attributed. Same for the backfill and the decision audit below.
      phase('fx legs refresh')
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
            else if (r.failed.length) {
              // Grouped BY REASON, not by symbol: "6 no usable quote (market
              // closed?)" is actionable on a Saturday and a bare symbol list
              // is not. See services/fx-legs.js.
              const byReason = new Map()
              for (const f of (r.failedWhy || [])) {
                if (!byReason.has(f.reason)) byReason.set(f.reason, [])
                byReason.get(f.reason).push(f.symbol)
              }
              const detail = byReason.size
                ? [...byReason].map(([why, syms]) => `${why}: ${syms.join(', ')}`).join(' · ')
                : r.failed.join(', ')
              log(`FX legs: ${r.failed.length} leg(s) could not be priced — ${detail}`)
            }
          }
        }
        // Beaten whether or not there was work: the beat says the phase ran.
        await hbeat(db, 'fx_legs_refresh')
      } catch (err) {
        await hbeat(db, 'fx_legs_refresh', false, err.message)
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
      phase('trade account backfill')
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
      phase('decision audit')
      try {
        const [{ shouldAlert, toText: auditText }, { readDecisionAudit }] = await Promise.all([
          import('./services/decision-audit.js'),
          import('./services/performance-populations.js'),
        ])
        // Re-derived rather than reusing the scan phase's `weekendQuiet` —
        // that binding lives inside the scan block, and reaching for it here
        // would be a ReferenceError at runtime that no test covers.
        const { weekendQuietNow } = await import('./lib/quiet-hours.js')
        const marketOpen = !weekendQuietNow()
        // Post-decision auditing is reporting/observability. Production
        // measured a 40.5s event-loop stall between scan completion and this
        // verdict on the first #1056 loop. Run the historical reads on the
        // bounded read-only report worker; a slow audit may fail its heartbeat
        // but cannot starve protection or HTTP on the trading event loop.
        const audit = await readDecisionAudit(db, { marketOpen, nowMs: Date.now() })
        setState(db, 'decision_audit_last_json', JSON.stringify(audit))
        // Verdict HISTORY (invariant 2's series, 31-08): the single state key
        // above is overwritten every cycle, so "how often was the pipeline
        // blocked last week" was unanswerable. One row per verdict change or
        // per hour, 90d prune — cheap enough to keep forever-ish, useful the
        // first time a trend question is asked.
        try {
          const last = db.prepare(
            `SELECT verdict, (julianday('now') - julianday(at)) * 86400 AS age_s
               FROM decision_audit_history ORDER BY id DESC LIMIT 1`
          ).get()
          if (!last || last.verdict !== audit.verdict || Number(last.age_s) > 3600) {
            db.prepare(
              `INSERT INTO decision_audit_history (verdict, because, considered, approved, vetoed, landed, silent_drops, top_block)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(audit.verdict, audit.because ?? null, audit.considered ?? null, audit.approved ?? null,
                  audit.vetoed ?? null, audit.landed ?? null, audit.silentDrops ?? null, audit.topBlock ?? null)
          }
        } catch { /* history is telemetry — never blocks the audit */ }
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

      // Strategy Autopilot — session-adaptive evidence sweep (10 min busy /
      // 30 min calm, autopilotIntervalMs; the old "nightly" label predated
      // that cadence). DETACHED on purpose (2026-09-01): the sweep backtests
      // a 24-symbol window × timeframes × strategies on this thread for ~3
      // minutes, and AWAITING it (even budgeted — the budget only abandons
      // the wait) held every later phase hostage. Measured before the fix:
      // loopPhaseMs.autopilot 176,635ms, six controllers stalled on each
      // ~10-min firing. The launch is recorded by phase(); the run itself is
      // fire-and-forget behind the same subPhaseInFlight overlap guard the
      // budgeted path used, plus the module's own autopilot_last_run_ms
      // stamp — a doubled run stays impossible. Heartbeat semantics: the
      // scheduling beat stays per-cycle (below), and the detached
      // continuation beats again with the run's real outcome, so a sweep
      // that starts dying shows up as a failing controller, not silence.
      // Failures must never touch the trading phases.
      try {
        if (!cycleOverBudget()) {
          phase('autopilot')
          if (subPhaseInFlight.get('autopilot')) {
            log('autopilot from a previous cycle still in flight — not relaunched (no overlap)')
          } else {
            const { maybeRunAutopilot } = await import('./services/strategy-autopilot.js')
            subPhaseInFlight.set('autopilot', true)
            maybeRunAutopilot(db, getCtraderCreds(db))
              .then((r) => {
                if (r && !r.skipped && !r.skippedOverlap) log(`Autopilot: ${JSON.stringify(r)}`)
                return hbeat(db, 'autopilot')
              })
              .catch((err) => {
                log(`Autopilot failed (non-fatal): ${err.message}`)
                return hbeat(db, 'autopilot', false, err.message).catch(() => {})
              })
              .finally(() => subPhaseInFlight.set('autopilot', false))
          }
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
      if (weekendPositions.length > 0 && loopCount % 12 === 1 && !cycleOverBudget() && !(await llmBlocked(db, getState)).blocked) {
        phase(`weekend watch (${weekendPositions.length})`, 'weekend-watch')
        log(`Weekend watch — reviewing ${weekendPositions.length} closed-market position(s)`)
        // D4b: bounded-concurrency, not one-position-at-a-time — see
        // monitorOneWeekendPosition/runWeekendWatchPhase above
        // (docs/d4-loop-block-fix-plan.md).
        // Its own tiered client: weekend_watch and position_monitor both sit on
        // the DEFAULT tier today, but sharing one client would silently pin
        // this phase to the monitor's model if either task were ever re-tiered.
        await runBudgetedSubPhase(db, 'weekend_watch', () => runWeekendWatchPhase(db, s, weekendPositions, getAnthropicClient('weekend_watch')), SUB_PHASE_BUDGET_MS * 2, { beatOk: true })
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
      }, client, skipLlmMonitor)
      // V3 M1: the first slow-monitor pass after boot (memory only; the boot
      // record persists it on its own 30-second cadence).
      stampFirst('slowMonitor', { positions: activePositions.length })

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
        stampFirst('adaptiveBreaker', { ok: true, actions: ab.actions?.length ?? 0 })
      } catch (err) {
        log(`Adaptive breaker failed (non-fatal): ${err.message}`)
        await hbeat(db, 'adaptive_breaker', false, err.message)
        stampFirst('adaptiveBreaker', { ok: false, error: err.message })
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
        if (ew.actions?.length) log(`Edge watchdog: disarmed ${ew.actions.map(a => `${a.strategy} (exp $${a.expectancy}, PF ${a.profitFactor ?? '∞'}, scopes ${a.scopes.join('/')}${a.heldPinned?.length ? `, held pins ${a.heldPinned.join('/')}` : ''})`).join(', ')}`)
        await hbeat(db, 'edge_watchdog')
        // PR-T (17-09-2026): what the watchdog and the breaker have left
        // behind. Their disarms write per-account cells that NOTHING
        // automatic ever writes back — the boot seed is the only true-writer
        // and it is seed-once by design — so the cells only accumulate.
        // Printed here, right after the actor that creates them, and printed
        // to stdout because the state routes need a bearer token that has
        // been the standing blocker since 07-09: a report the owner cannot
        // read is the same shape as a guard that cannot fire.
        //
        // Throttled to once an hour: it is a standing condition, not an
        // event, and a standing condition logged every cycle stops being read.
        try {
          const lastAt = Number(getState(db, 'arming_ratchet_logged_ms') || 0)
          if (!Number.isFinite(lastAt) || Date.now() - lastAt > 60 * 60 * 1000) {
            const { armingRatchetLine } = await import('./services/arming-ratchet.js')
            const line = armingRatchetLine(db)
            if (line) { log(line); setState(db, 'arming_ratchet_logged_ms', String(Date.now())) }
          }
        } catch { /* a report must never break the pass it rides on */ }
        // PR-AA: the OTHER half of the same picture. The ratchet above reports
        // cells the automatic actors turned OFF; this reports the cells a
        // human turned ON and what they are costing. Both are standing
        // conditions, both ride this per-cycle phase beside the actor that
        // creates them, both throttled to the hour — and deliberately NOT on
        // the housekeeping band, which is eight-hourly (the PR-Y defect).
        try {
          const lastPin = Number(getState(db, 'hand_pin_logged_ms') || 0)
          if (!Number.isFinite(lastPin) || Date.now() - lastPin > 60 * 60 * 1000) {
            const { handPinLine } = await import('./services/hand-pin-watch.js')
            const line = handPinLine(db)
            if (line) { log(line); setState(db, 'hand_pin_logged_ms', String(Date.now())) }
          }
        } catch { /* a report must never break the pass it rides on */ }
        // PR-X: (account, symbol) pairs holding more than one active row. Every
        // such row is evaluated and exited SEPARATELY by the position manager,
        // which is why one symbol can log the same FULL_EXIT several times in
        // a cycle — the behaviour the owner's 15-09 log showed for ABBV.US.
        // Silent when there are none, which is itself the answer "one position
        // per account". Hourly: a standing condition, not an event.
        //
        // IT RIDES HERE, ON A PER-CYCLE PHASE, AND NOT ON THE HOUSEKEEPING
        // BAND WHERE PR-X FIRST PUT IT. That band is an EIGHT-HOUR wall clock
        // (housekeepingDue), so an hourly throttle inside it is not a cadence
        // of an hour — it is a cadence of eight, and the comment above it said
        // "hourly" while the code could not deliver one. Measured 17-09 at
        // 08:57 UTC: the arming-ratchet line (this phase) had printed within
        // three minutes of deploy; the duplicate line had not printed at all,
        // because the band had not come round. CLAUDE.md failure mode #3: a
        // guard whose trigger is out of reach of what it guards.
        try {
          const lastDup = Number(getState(db, 'dup_positions_logged_ms') || 0)
          if (!Number.isFinite(lastDup) || Date.now() - lastDup > 60 * 60 * 1000) {
            const { duplicatePositionLine } = await import('./services/position-row-audit.js')
            const line = duplicatePositionLine(db)
            if (line) { log(line); setState(db, 'dup_positions_logged_ms', String(Date.now())) }
          }
        } catch { /* a report must never break the pass it rides on */ }
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
        const { fxDayStartSql, fxDayOpenMs, scanRates } = await import('./services/risk.js')
        const es = await import('./services/equity-stop.js')
        const dayStart = fxDayStartSql()
        const dayOpen = fxDayOpenMs()
        // Prices cross-currency stop-out estimates in accountPnlToday
        // (audit item 2) — computed once, not per account.
        const stopoutRates = scanRates(db)
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

          const { pnl, unknownCount } = es.accountPnlToday(db, acctId, dayStart, stopoutRates)
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
          // Push the trip into the C++ guard NOW rather than waiting up to a
          // probe interval (~2 min) for convergence — the halt should bind on
          // the broker path the moment the stop fires. Best-effort: a failed
          // push converges on the next heartbeat probe anyway (the sync is
          // declarative, derived from the same trippedKey this just wrote).
          try {
            const { syncExecGuard } = await import('./services/exec-guard-sync.js')
            const exec2 = await import('./lib/exec-engine.js')
            const sync = await syncExecGuard(db, exec2, { isLive: null, name: 'exec' }, { creds: getCtraderCreds(db) })
            // Same stamp the heartbeat probe writes: a push the sidecar
            // refused is a halt that did not bind, and must not read as one.
            if (sync.error) {
              log(`equity stop: exec guard push FAILED — ${sync.error}`)
              setState(db, 'exec_guard_sync_last_error_json', JSON.stringify({ at: new Date().toISOString(), error: String(sync.error).slice(0, 500) }))
            } else {
              setState(db, 'exec_guard_sync_last_error_json', null)
            }
          } catch (err) {
            // Probe convergence covers the push; the failure is still recorded.
            try { setState(db, 'exec_guard_sync_last_error_json', JSON.stringify({ at: new Date().toISOString(), error: String(err.message).slice(0, 500) })) } catch { /* state unwritable */ }
          }
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
        // A controller row for a phase that closes positions and disarms
        // accounts: a throw here used to be one log line per cycle, never a
        // status. Beaten at the END so a phase that keeps throwing shows as
        // failing, not resting.
        await hbeat(db, 'equity_stop')
        // V3 M1: the equity stop runs ONLY here, so its first evaluation after
        // a boot waits for the whole first loop — the boot record says when.
        stampFirst('equityStop', { ok: true, accounts: byAccount.size })
      } catch (err) {
        log('Equity stop check failed:', err.message)
        await hbeat(db, 'equity_stop', false, err.message)
        stampFirst('equityStop', { ok: false, error: err.message })
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
        await hbeat(db, 'performance_breaker')
        stampFirst('performanceBreaker', { ok: true, triggered: !!pb.triggered })
      } catch (err) {
        log('Performance breaker failed (non-fatal):', err.message)
        await hbeat(db, 'performance_breaker', false, err.message)
        stampFirst('performanceBreaker', { ok: false, error: err.message })
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
        // PR-D (checker MAJOR 2, 11-09-2026): the momentum universe's names
        // are ranked by the shadow and traded by the book without ever being
        // scanned, so they had no regime row and no trend reading — the
        // book's alignment was decorative for most of the universe. They get
        // a regime on the same cadence, through the same code path.
        const { momentumUniverseSymbols: regimeUniverse } = await import('./services/momentum-account.js')
        // V3 C4 (WP-B B3): the tick universe is a regime source too — the tick
        // permit feeder's direction filter reads these rows. The helper is
        // imported under ANOTHER name: `const regimeSymbols = regimeSymbols(…)`
        // would throw a TDZ ReferenceError here and the outer catch would
        // silently skip the regime writes and the automatic entry-mode switch.
        const { regimeSymbols: unionRegimeSymbols, computeRegime } = await import('./services/regime.js')
        const { tickSymbolNames } = await import('./services/exec-guard-sync.js')
        const regimeSymbols = unionRegimeSymbols({ scanned: recentScans.map(r => r.symbol), universe: regimeUniverse(db), tick: tickSymbolNames(db) }).map(symbol => ({ symbol }))

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
        for (const { symbol } of regimeSymbols) {
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
        log(`Regime (ADX/ATR) computed for ${regimeWritten}/${regimeSymbols.length} symbols (scanned, momentum universe and tick names)`)

        // PR-G (owner principle 2): the AUTOMATIC entry-mode switch, on the
        // same cadence as the regime. Only accounts under policy `auto` are
        // touched; every switch goes through requestEntryMode (readiness,
        // ack, drain, action_log) and binds the gateway as the route does.
        try {
          const { evaluateAutoEntryModes } = await import('./services/entry-mode-auto.js')
          const autoModes = await evaluateAutoEntryModes(db)
          for (const line of autoModes.lines) log(`[entry-mode] auto: ${line}`)
        } catch (err) {
          log(`[entry-mode] auto: evaluation failed (${err.message})`)
        }

        // Performance snapshot from closed trades — one row per account plus
        // the pooled row (plan P1, services/performance-snapshots.js).
        writePerformanceSnapshots(db)

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
            // The bars each symbol was correlated on, kept as they arrive.
            // The market pulse reads the SAME window rather than fetching it
            // again — one broker pass answers both questions.
            const barsSeen = {}
            const res = await computeAndStoreMatrix(db, corrSymbols, {
              maxSymbols: 24,
              fetchBars: async (sym, tf, count) => {
                const byTf = await wsGetTrendbarsBatch(host, clientId, clientSecret, accessToken, accountId, symbolMap[String(sym).toUpperCase()], [tf], count, 20_000)
                const bars = byTf[tf] || []
                barsSeen[String(sym).toUpperCase()] = bars
                return bars
              },
            }, new Date().toISOString())
            if (res.built) log(`Correlation matrix: ${res.built} symbols`)

            // MARKET PULSE — trending / herding / defended, per symbol.
            // Advisory: it writes a reading, it does not gate anything.
            try {
              const { computeAndStorePulse } = await import('./services/market-pulse.js')
              const p = computeAndStorePulse(db, barsSeen, new Date().toISOString())
              if (p.symbols) {
                log(`Market pulse: ${p.symbols} symbols · ${p.herds} herd(s) · ${p.sharp} sharp · ${p.defended} defended · ${p.divergences} divergence(s)`)
              }
            } catch (err) {
              log('Market pulse failed (non-fatal):', err.message)
            }
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
    cycleErrored = true
    console.error('[loop] error:', err.message)
    await hbeat(db, 'main_loop', false, err.message)
    consecutiveErrors++
    recordError(db, 'loop', err.message)

    if (consecutiveErrors >= 5) {
      const backoff = Math.min(15 * 60_000, loopIntervalMs(db) * consecutiveErrors)
      log(`Self-healing: ${consecutiveErrors} consecutive errors — backing off ${Math.round(backoff / 60000)}m`)
      // Persist the breakdown on the way out too: the phase that was running
      // when a cycle died is exactly the one worth seeing.
      const erroredPhaseMs = closePhases()
      // V3 M1: a cycle that died still took time and, if it was the first,
      // is still the first loop — recorded with ok: false, not skipped.
      noteLoopEnd({ startedAtMs: start, ms: Date.now() - start, phaseMs: erroredPhaseMs, ok: false })
      loopRunning = false
      lastLoopActivityAt = Date.now()
      setTimeout(() => runLoop(db).catch(err => console.error('[loop] unhandled:', err.message)), backoff)
      return
    }
  }

  consecutiveErrors = 0
  setState(db, 'circuit_breaker_tripped_at', null)

  // ---- Housekeeping: data retention (once per 8 hours, WALL CLOCK) --------
  //
  // This was `loopCount % 100 === 0`. `loopCount` is module state reset to 0
  // on every process start, so the pass fired eight hours after a RESTART, not
  // every eight hours — and the agent restarts on every deploy. On 2026-08-06
  // that was seven times before noon, with `/health` reporting two hours of
  // uptime, and `/state/dispositions` reporting `counts {}` against
  // `pendingNow 54,815`: not one risk_event had ever been settled, and the
  // 90-day retention cutoff below had never pruned anything either.
  //
  // The cadence now comes from a persisted stamp, so a restart resumes the
  // schedule instead of restarting it. See housekeeping-due.js for why the
  // condition is a tested function rather than an inline expression.
  if (housekeepingDue(getState(db, LAST_RUN_KEY))) {
    try {
      phase('housekeeping')
      // Stamped BEFORE the work, not after. A pass that throws half way must
      // not re-run on the very next loop and re-throw forever — the retention
      // deletes are the expensive part and a crash loop over them would be
      // worse than skipping one window.
      //
      // THE COMMENT HERE USED TO CLAIM "every step below is individually
      // try/caught anyway, so a partial pass still makes progress", and the
      // eight deletes immediately following it were not. So one throw skipped
      // everything after it — including the §70.8 disposition sweep — and
      // stamp-before-work kept it skipped for the next eight hours. Measured
      // in production on 2026-08-06, after #668's cadence fix had deployed:
      // 55,443 approvals, not one settled. runHousekeepingSteps makes the old
      // comment true rather than deleting it.
      setState(db, LAST_RUN_KEY, new Date().toISOString())
      const cutoff30d = new Date(Date.now() - 30 * 86400_000).toISOString()
      const cutoff90d = new Date(Date.now() - 90 * 86400_000).toISOString()
      const { runHousekeepingSteps, changesOf } = await import('./services/housekeeping-run.js')
      const pass = await runHousekeepingSteps([
        // `analyses.scan_id REFERENCES scans(id)` and foreign_keys is ON, so a
        // single old scan that an analysis still points at aborts the WHOLE
        // delete. Production ran that way for months: the step reported
        // "failed (non-fatal): FOREIGN KEY constraint failed" every pass and
        // pruned NOTHING, while scans — the highest-churn table here — grew
        // unbounded. The database reached 1,459MB that way. Excluding the
        // referenced rows is the same shape retention.js already uses for
        // analyses-vs-trades; it was simply never applied here.
        {
          // Batched with a heartbeat: fixing the FK makes months of backlog
          // deletable in ONE pass, and a single synchronous statement that
          // overruns the 12-minute watchdog would be killed, roll back, delete
          // nothing, and repeat every 8 hours.
          name: 'prune-scans',
          run: async () => (await import('./services/prune-scans.js'))
            .pruneScans(db, cutoff30d, { batch: 200, maxBatches: 5000, onProgress: () => { lastLoopActivityAt = Date.now() } }),
        },
        { name: 'prune-signals', run: () => db.prepare('DELETE FROM signals WHERE recorded_at < ?').run(cutoff30d) },
        { name: 'prune-regimes', run: () => db.prepare('DELETE FROM regimes WHERE computed_at < ?').run(cutoff30d) },
        { name: 'prune-risk-events', run: () => db.prepare('DELETE FROM risk_events WHERE created_at < ?').run(cutoff90d) },
        // Refusal scores outlive the risk_events they summarise (180 vs 90 days).
        { name: 'prune-refusal-scores', run: () => db.prepare(`DELETE FROM refusal_scores WHERE datetime(scored_at) < datetime('now', '-180 days')`).run() },
        { name: 'prune-decision-log', run: async () => (await import('./services/decision-log.js')).pruneDecisionLog(db) },
        { name: 'prune-position-events', run: async () => (await import('./services/position-events.js')).prunePositionEvents(db) },
        // cpp_decisions rides the same 90d window as the other decision sinks.
        // datetime() on both sides: at is sqlite's 'YYYY-MM-DD HH:MM:SS' while
        // the cutoff is ISO — a bare string compare would misjudge the boundary.
        { name: 'prune-cpp-decisions', run: () => db.prepare('DELETE FROM cpp_decisions WHERE datetime(at) < datetime(?)').run(cutoff90d) },
        // Divergence tracker (02-09-2026): verdict history is bounded per
        // sweep AND in time; closed arm rows age out, open arms never do —
        // an armed combo's evidence must outlive any prune while it trades.
        { name: 'prune-autopilot-verdicts', run: () => db.prepare(`DELETE FROM autopilot_verdicts WHERE datetime(ran_at) < datetime('now', '-30 days')`).run() },
        // Per-sweep PF/WR/n histogram (02-09-2026): one small row per sweep,
        // the base rate a shrinkage prior needs; 90 days is ~100 sweeps.
        { name: 'prune-autopilot-sweep-hist', run: () => db.prepare(`DELETE FROM autopilot_sweep_hist WHERE datetime(sweep_at) < datetime('now', '-90 days')`).run() },
        { name: 'prune-combo-arms', run: () => db.prepare('DELETE FROM combo_arms WHERE disarmed_at IS NOT NULL AND datetime(disarmed_at) < datetime(?)').run(cutoff90d) },
        // Inspection findings: TERMINAL rows only — live findings never age
        // out (a proposal does not expire because the owner was busy; it
        // resolves only through its falsifier). Audit history same window.
        { name: 'prune-inspection-findings', run: () => db.prepare(`DELETE FROM inspection_findings WHERE status IN ('confirmed','falsified','expired') AND datetime(at) < datetime(?)`).run(cutoff90d) },
        { name: 'prune-audit-history', run: () => db.prepare('DELETE FROM decision_audit_history WHERE datetime(at) < datetime(?)').run(cutoff90d) },
        // Long-horizon ledger retention (hardening 6c): closed trades +
        // postmortems past ~2 years (retention_json overrides; null disables).
        { name: 'prune-trade-history', run: async () => (await import('./services/retention.js')).pruneTradeHistory(db) },
        // Owner-approved 01-08 ("approve retention") — the three tables that
        // grew production's DB to 526MB, cup_handle_diagnostics alone 40%.
        { name: 'prune-operational', run: async () => (await import('./services/retention.js')).pruneOperationalTablesCooperatively(db, null, { onProgress: () => { lastLoopActivityAt = Date.now() } }) },
        // Owner 29-08 ("I don't think I need old data") — the two growers
        // housekeeping never touched: the backtest-results folder (measured
        // 4.7GB of autopilot HTML reports, ~40 new/day, never deleted) and
        // SENT telegram_outbox rows (99MB; pending rows are the digest
        // queue and are never touched).
        {
          name: 'prune-reports',
          run: async () => {
            const { loadRetentionConfig } = await import('./services/retention.js')
            return (await import('./services/report-retention.js')).pruneReports(loadRetentionConfig(db))
          },
        },
        {
          name: 'prune-outbox',
          run: () => db.prepare(
            `DELETE FROM telegram_outbox WHERE sent_at IS NOT NULL AND queued_at < ?`
          ).run(new Date(Date.now() - 14 * 86_400_000).toISOString()),
        },
        // Owner 01-09-2026 ("every stale, triggerless or dead piece goes: wire
        // it so it fires, or delete it"). The three steps below existed as
        // exported, tested, uncalled functions — each a pruner or a repair
        // with no trigger, which is failure mode #4 (a repair nothing calls).
        //
        // Two JSON blobs in agent_state that only ever grew: browser-session
        // metadata (30-day retention on dead and revoked rows, the module's
        // own default — revocations inside the window are the security
        // record and are kept) and the per-key risk-config change history,
        // global and per account, pruned to the keys DEFAULT_RISK_CONFIG
        // still declares. A retired key's history is what that module calls
        // "a setting removed from the schema"; the stored SETTING is untouched.
        { name: 'prune-browser-sessions', run: async () => (await import('./services/browser-sessions.js')).pruneSessions(db) },
        {
          name: 'prune-risk-config-history',
          run: async () => {
            const { pruneRiskConfigChanges } = await import('./services/risk-config-history.js')
            const { DEFAULT_RISK_CONFIG } = await import('./services/risk.js')
            const valid = Object.keys(DEFAULT_RISK_CONFIG)
            let dropped = pruneRiskConfigChanges(db, valid, { accountId: null })
            const scoped = db.prepare(`SELECT key FROM agent_state WHERE key LIKE 'acct:%:risk_config_changed_json'`).all()
            for (const { key } of scoped) {
              const accountId = String(key).slice('acct:'.length, -':risk_config_changed_json'.length)
              if (accountId) dropped += pruneRiskConfigChanges(db, valid, { accountId })
            }
            return dropped
          },
        },
        // UNKNOWN-P&L WRITE-OFF — owner 2026-07-30, "option 2": a closed trade
        // whose P&L is UNKNOWN keeps blocking (the backfill may still repair
        // it); one that is UNKNOWABLE stops blocking, loudly, with net_pnl
        // left NULL. mark-unresolvable.js shipped in #513 and nothing ever
        // called its writing half: the plan route could list the rows that
        // qualified, and no row was ever marked. Production 01-09-2026 held a
        // row at 4,690 attempts over 13 days — still unresolved, still
        // re-attempted every backfill pass, still counted by the reconciliation
        // heartbeat.
        //
        // BOTH HALVES of the module's evidence rule are supplied and NEITHER
        // is loosened. AGE is the module's own horizon (default 7 days).
        // EXHAUSTION is the durable per-row attempt counter — exhaustedTradeIds
        // at the backfill's own LIVE_GAP_MAX_ATTEMPTS — unioned with the
        // in-memory backoff ladder, the same two sources /state/unresolvable-plan
        // reads. A row on an account the backfill has never given up on is
        // never touched, however old. Every marking is audited by the module
        // itself (action_log PNL_UNRESOLVABLE), and nothing is computed.
        {
          name: 'write-off-unresolvable',
          run: async () => {
            const { sweepUnresolvable } = await import('./services/mark-unresolvable.js')
            const { exhaustedTradeIds, exhaustedAccounts, LIVE_GAP_MAX_ATTEMPTS } = await import('./services/pnl-backfill.js')
            const exhaustedRows = exhaustedTradeIds(db, { minAttempts: LIVE_GAP_MAX_ATTEMPTS, limit: 1000 })
            const accounts = [...new Set([
              ...exhaustedRows.map(r => r.account_id).filter(a => a != null).map(String),
              ...exhaustedAccounts(),
            ])]
            const out = sweepUnresolvable(db, { exhaustedAccounts: accounts, dryRun: false })
            return { ...out, exhaustedRows: exhaustedRows.length, exhaustedAccounts: accounts, minAttempts: LIVE_GAP_MAX_ATTEMPTS }
          },
        },
        // POSITION HISTORY SWEEP (owner, 17-09-2026). The close-triggered
        // capture is the fast path; this is the sweep behind it, so a
        // position whose capture was missed — a restart, a broker row that
        // arrived late — is still built rather than lost. Incremental: it
        // rebuilds the last 30 days, which is cheap and self-correcting, and
        // it costs no broker call because every source is already local.
        //
        // It reports what it could NOT build, by field, and that number is
        // the point: it names what this system still does not record about
        // its own trades. A sweep that only counted successes would be the
        // reporting defect this repo keeps finding.
        {
          name: 'position-history',
          run: async () => {
            const { backfillPositionHistoryCooperatively } = await import('./services/position-history.js')
            const out = await backfillPositionHistoryCooperatively(db, { sinceMs: Date.now() - 30 * 86400_000 })
            const worst = Object.entries(out.missingCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
            log(`[position-history] ${out.complete} complete · ${out.incomplete} incomplete of ${out.seen} closed position(s)` +
                (worst.length ? ` — most often missing: ${worst.map(([f, n]) => `${f} (${n})`).join(', ')}` : ''))
            return out
          },
        },
      ], { log })
      // SAY WHAT WAS WRITTEN OFF, row by row. This is the one place the
      // system stops waiting for money data, so it must never be something
      // discovered later from a total that quietly started adding up.
      const writeOff = pass.results['write-off-unresolvable'] ?? null
      if (writeOff?.marked > 0) {
        for (const r of writeOff.rows) {
          log(`UNKNOWN P&L WRITTEN OFF: trade ${r.id} ${r.symbol} on ${r.accountId}, closed ${r.closedAt} — older than the ${writeOff.horizonDays}-day deal-history horizon and the backfill exhausted its retries; net_pnl stays NULL, this row no longer blocks`)
        }
        log(`Unknown-P&L write-off: marked ${writeOff.marked} of ${writeOff.found} candidate(s) across ${writeOff.exhaustedAccounts.length} exhausted account(s) — see action_log PNL_UNRESOLVABLE`)
      } else if (writeOff && writeOff.exhaustedRows > 0) {
        log(`Unknown-P&L write-off: ${writeOff.exhaustedRows} row(s) exhausted (≥${writeOff.minAttempts} attempts) but none older than the ${writeOff.horizonDays}-day horizon on an exhausted account — still UNKNOWN, nothing written off`)
      }
      const d1 = pass.results['prune-scans']
      const d2 = pass.results['prune-signals']
      const d3 = pass.results['prune-regimes']
      const d4 = pass.results['prune-risk-events']
      const d5 = pass.results['prune-decision-log'] ?? 0
      const d6 = pass.results['prune-position-events'] ?? 0
      const d7 = pass.results['prune-trade-history'] ?? {}
      const d8 = pass.results['prune-operational'] ?? {}
      // Phase-flag tracer rows: tiny, but unbounded is unbounded. 90 days
      // matches risk_events — flips older than that are history, not evidence.
      try { db.prepare("DELETE FROM phase_flag_trace WHERE at < datetime('now', '-90 days')").run() } catch { /* housekeeping */ }
      // PR-S arming decisions, same 90 days and the same reasoning. Kept
      // deliberately LONGER than a log window, because the whole point of the
      // ledger is to answer a question weeks after the disarm — the 17-09
      // investigation failed at roughly one hour.
      try { db.prepare("DELETE FROM arming_log WHERE at < datetime('now', '-90 days')").run() } catch { /* housekeeping */ }
      // RETURN THE FREED PAGES TO THE FILESYSTEM.
      //
      // Every prune above works, and every one of them has worked for months.
      // The file still only grew, because SQLite does not shrink on DELETE —
      // freed pages go on the freelist and are reused for new rows, so a
      // database inserting faster than it deletes grows for ever however much
      // it prunes. Nothing here ran VACUUM; storage-report.js had been
      // REPORTING `freelistPages` the whole time with the comment "pages
      // already reclaimable without VACUUM", measuring the problem while
      // nothing acted on it.
      //
      // Measured cost: on 2026-08-17 the Railway volume filled and the agent
      // crash-looped on boot with SQLITE_IOERR_SHMSIZE at `journal_mode = WAL`
      // — it could not create the -shm file, so it never reached line 200.
      //
      // Runs LAST in the pass, after the deletes it is reclaiming, and refuses
      // itself unless the disk can hold a second copy — see db-compact.js.
      //
      // TWO THINGS ABOUT HOW THIS IS CALLED, both from the 19-08-2026 pass.
      //
      // FIRST, VACUUM IS NOT FREE AND better-sqlite3 IS SYNCHRONOUS. Rebuilding
      // a 1,459MB database holds the event loop for minutes. Nothing monitors
      // open positions while the thread is held — no trailing stop, no
      // break-even move, no per-position loss cap — and if the block outruns
      // the 12-minute watchdog the process is killed mid-rebuild.
      //
      // THAT IS THE HAZARD, NOT THE CAUSE OF THE 23-MINUTE STALL ON THAT BOOT,
      // and the distinction is the whole reason this paragraph was rewritten.
      // The first version of it recorded the stall as a measured VACUUM, which
      // was wrong: the logs put `loopLag=953014ms` ending at the prune-scans
      // FK failure, with the file the same size afterwards, so compaction
      // almost certainly never ran. A comment outlives a pull request, and a
      // retracted cause left in the code sends the next reader to VACUUM for a
      // stall that came from an unindexed foreign-key check.
      //
      // So: never while a position is open, and stamp the watchdog afterwards
      // so the rebuild's own duration is not counted as a stall.
      //
      // SECOND, THE SILENCE WAS ITSELF A DEFECT. The old call logged only when
      // it ran or was blocked, so a pass that simply decided "not worth it"
      // looked identical to one that never happened — which is exactly why the
      // question above had to be settled from loopLag rather than from any
      // line this code wrote. It now says what it decided, every time.
      try {
        const { runCompact, recordDeferral } = await import('./services/db-compact.js')
        // COUNT over monitored_positions, and NOT accountsWithOpenPositions().
        //
        // Two earlier versions of this line were wrong, in opposite directions.
        // The first read `FROM positions`, which is not a table in this schema:
        // it threw at prepare time, the catch below swallowed it, and
        // compaction never ran at all — the change that existed to reclaim
        // 1.4GB shipped with the reclaim switched off, because the tests
        // matched source TEXT instead of executing the query.
        //
        // The second used accountsWithOpenPositions(), which answers a
        // different question: "which ACCOUNTS have attributable exposure". It
        // excludes active rows whose account_id is NULL (real money the bot is
        // managing but cannot attribute) and its internal catch returns [], so
        // a failing query reads as "nothing is open". Both narrowings are right
        // for the account switch it was written for and wrong here: this guard
        // must fail CLOSED, because the thing it prevents is a multi-minute
        // rebuild running while nothing monitors a live position. If this
        // throws, the outer catch skips compaction — the safe side.
        const openNow = db.prepare(
          "SELECT COUNT(*) AS n FROM monitored_positions WHERE status = 'active'"
        ).get().n
        if (openNow > 0) {
          // Recorded, not just logged: a bot whose job is holding positions
          // could defer for ever, and a console line is not something anyone
          // can query later. The streak is the number that would show it.
          const d = recordDeferral(db, { reason: `${openNow} position(s) open` })
          const streak = d.consecutive > 1 ? ` (${d.consecutive} passes in a row)` : ''
          log(`housekeeping: compaction deferred — ${openNow} position(s) open, a rebuild blocks the event loop${streak}`)
        } else {
          const c = runCompact(db)
          // The rebuild held the thread; the watchdog must not read that as a
          // hang on the next tick.
          lastLoopActivityAt = Date.now()
          if (c.ran) log(`housekeeping: compacted ${Math.round((c.freedBytes || 0) / 1e6)}MB from the database file`)
          else if (c.blocked) console.warn(`[housekeeping] compaction BLOCKED — ${c.reason}`)
          else log(`housekeeping: compaction not needed — ${c.reason || 'nothing worth reclaiming'}`)
        }
      } catch (err) {
        // A cleanup must never take down the process it protects — but it must
        // not vanish either, which is how the last one went unexplained.
        log(`housekeeping: compaction failed (non-fatal): ${err.message}`)
      }
      // §70.8: settle the terminal disposition of every approval that can be
      // settled. Rides in housekeeping because it is a derivation over rows
      // that are already written — one indexed scan, no broker call — and
      // because an approval needs a few minutes of grace before "nothing
      // acted on it" is a finding rather than a race.
      // OVER-CEILING CLUSTERS — ALERT ONLY (owner, 05-08-2026: "if exist now,
      // alert only. It should not happen again."). Nothing is closed:
      // auto-closing seventeen positions on a reading is a bigger action than
      // the one that created them, and #179's nine were protected by their own
      // SL/TP throughout. Deduped on the cluster's identity and size, so a
      // standing cluster is announced once and a GROWING one speaks again.
      try {
        const { overCapClusters, clusterLine } = await import('./services/symbol-position-cap.js')
        const clusters = overCapClusters(db)
        if (clusters.length) {
          let seen = new Set()
          try { seen = new Set(JSON.parse(getState(db, 'symbol_cap_alerts') || '[]')) } catch { seen = new Set() }
          const keep = new Set()
          const fresh = []
          for (const c of clusters) {
            const key = `${c.accountId}|${c.symbol}|${c.n}`
            keep.add(key)
            if (!seen.has(key)) fresh.push(c)
          }
          setState(db, 'symbol_cap_alerts', JSON.stringify([...keep]))
          for (const c of fresh) {
            const line = clusterLine(c)
            log(`SYMBOL CAP EXCEEDED: ${line}`)
            try {
              db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
                'DETECTOR', '/symbol-cap-exceeded', JSON.stringify(c))
            } catch { /* the journal must never stall the loop */ }
            try {
              const { sendMessage } = await import('./services/telegram.js')
              await sendMessage(`⚠️ Same-symbol cluster over the hard cap\n${line}\nNothing has been closed — this is a report. New entries on this symbol are refused until it is back under the cap.`)
            } catch { /* alerting must never stall the loop */ }
          }
        }
      } catch (err) {
        log('Symbol-cap detector failed (non-fatal):', err.message)
      }

      // §70.8 OPPORTUNITY BACKFILL. New evaluations are keyed at the gate, but
      // the history the owner reads the funnel over is not, and until it is
      // every rate describes only the rows written since the migration. The
      // key is derived, so replaying the rule over old rows produces exactly
      // what the live path would have written.
      //
      // Bounded and idempotent: one batch per housekeeping pass walks the
      // backlog down and then costs a single indexed count forever after. Not
      // run at boot — a full-table rewrite is not something to put in front of
      // the first trading cycle.
      try {
        const { backfillOpportunityKeys } = await import('./services/opportunity-identity.js')
        const b = backfillOpportunityKeys(db, { limit: 5000 })
        if (b.keyed > 0) {
          log(`Opportunity backfill: keyed ${b.keyed} evaluation(s) into ${b.opportunities} opportunities, ${b.remaining} remaining`)
        }
      } catch (err) {
        log('Opportunity backfill failed (non-fatal):', err.message)
      }

      // OVER-CEILING RESTING ORDERS — the half the detector above could not
      // see. On 04-08 the DOW.US cluster was thirteen LIMIT orders resting at
      // 29.84 from 10:41, and monitored_positions stayed empty until the US
      // open turned all of them into positions at once. A detector that only
      // reads the position book announces the fire after the building is gone;
      // this one would have spoken at 10:56, on the third order, eighty-seven
      // minutes early. Alert only, same as its sibling — cancelling resting
      // orders on a reading is a bigger action than the one that placed them.
      try {
        const { overCapRestingOrders, restingLine } = await import('./services/symbol-position-cap.js')
        const resting = overCapRestingOrders(db)
        if (resting.length) {
          let seen = new Set()
          try { seen = new Set(JSON.parse(getState(db, 'resting_cap_alerts') || '[]')) } catch { seen = new Set() }
          const keep = new Set()
          const fresh = []
          for (const c of resting) {
            const key = `${c.accountId}|${c.symbol}|${c.n}`
            keep.add(key)
            if (!seen.has(key)) fresh.push(c)
          }
          setState(db, 'resting_cap_alerts', JSON.stringify([...keep]))
          for (const c of fresh) {
            const line = restingLine(c)
            log(`RESTING ORDERS OVER CAP: ${line}`)
            try {
              db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
                'DETECTOR', '/resting-cap-exceeded', JSON.stringify(c))
            } catch { /* the journal must never stall the loop */ }
            try {
              const { sendMessage } = await import('./services/telegram.js')
              await sendMessage(`⚠️ Resting limit orders stacked over the hard cap\n${line}\nThese have NOT been cancelled. They fill together the moment price reaches that level — check them before the market opens.`)
            } catch { /* alerting must never stall the loop */ }
          }
        }
      } catch (err) {
        log('Resting-order cap detector failed (non-fatal):', err.message)
      }

      // C-1 SPEAKS. The controller has been correct since #632 and nothing
      // was listening: configProposals was wired to a read route and to
      // nothing else, so the module built to catch a minRR regression caught
      // one on ACCT-DEMO-1 and had no way to say so. Danger severity only, and
      // deduped on the proposal's identity, so a standing condition alerts
      // once rather than every cycle. It PROPOSES — nothing is written.
      try {
        const { configProposals, newDangerProposals, dangerAlertText } =
          await import('./services/config-controller.js')
        const { getState: gs, setState: ss } = await import('./db.js')
        const report = configProposals(db)
        const { fresh } = newDangerProposals(db, report, { getState: gs, setState: ss })
        for (const p of fresh) {
          log(`CONFIG CONTROLLER (danger) [${p.accountId}] ${p.setting} ${p.current} → ${p.proposed}: ${p.why}`)
          try {
            db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
              'CONTROLLER', '/config-proposal-danger', JSON.stringify({
                accountId: p.accountId, rule: p.rule, setting: p.setting,
                current: p.current, proposed: p.proposed, why: p.why,
              }))
          } catch { /* the journal must never stall the loop */ }
          try {
            const { sendMessage } = await import('./services/telegram.js')
            await sendMessage(dangerAlertText(p))
          } catch { /* alerting must never stall the loop */ }
        }
      } catch (err) {
        log('Config controller alert failed (non-fatal):', err.message)
      }

      try {
        const { drainDispositions, revisitDropped } = await import('./services/opportunity-disposition.js')
        // DRAIN, not one batch. A single sweep settles at most 5,000 rows and
        // this pass runs every eight hours, so production's 55,443-row backlog
        // would have taken four days to become visible.
        const sw = drainDispositions(db)
        if (sw.written > 0) {
          log(`Dispositions: settled ${sw.written} of ${sw.scanned} in ${sw.batches} batch(es) (${JSON.stringify(sw.counts)}), ${sw.pending} still in flight`)
        }
        // HEAL, bounded (02-09-2026): approvals marked 'dropped' in the last
        // week are re-judged with sibling evidence — a post-approval refusal
        // row or a landed re-keyed retry on the same account/symbol/side.
        // JPM.US 19:53Z was counted as a silent gap while its retry was an
        // open position. Idempotent; reported only when something changed.
        const rv = revisitDropped(db, { days: 7 })
        if (rv.written > 0) log(`Dispositions: re-judged ${rv.written} 'dropped' approval(s) with sibling evidence (${JSON.stringify(rv.counts)})`)
        if (!sw.drained) log(`Dispositions: batch cap reached — backlog NOT fully settled, another pass will continue`)
        // WRITE THE OUTCOME DOWN, on a read-only route. PR #670 could name the
        // mechanism (an unguarded step cancels the sweep) but not the step,
        // because housekeeping only ever spoke through console output nobody
        // can query. A pass that reports "which steps failed, what the sweep
        // settled, when the next window is" turns the next reading of
        // /state/dispositions from an inference into a fact.
        setState(db, 'housekeeping_last_result_json', JSON.stringify({
          at: new Date().toISOString(),
          ran: pass.ran,
          failed: pass.failed,
          timings: pass.timings,
          operationalPruneErrors: pass.results['prune-operational']?.errors || [],
          dispositions: { written: sw.written, batches: sw.batches, drained: sw.drained, pending: sw.pending },
          unresolvableWriteOff: writeOff
            ? { found: writeOff.found, marked: writeOff.marked, exhaustedRows: writeOff.exhaustedRows, exhaustedAccounts: writeOff.exhaustedAccounts, ids: (writeOff.rows || []).map(r => r.id) }
            : null,
        }))
        if (sw.counts.dropped > 0) {
          // The §70.8 finding itself: the gate said yes and nothing acted.
          log(`§70.8 SILENT GAP: ${sw.counts.dropped} approval(s) produced no order — see GET /state/dispositions`)
        }
      } catch (e) { log('Disposition sweep failed (non-fatal):', e.message) }

      // Held-back scans are reported, not merely computed. If analyses
      // retention ever breaks, this number climbs while "pruned N scans" still
      // reads healthy — a diagnostic nobody prints is the exact defect this
      // area keeps producing.
      let heldScans = null
      try {
        heldScans = (await import('./services/prune-scans.js')).heldByAnalyses(db, cutoff30d)
      } catch { /* diagnostics must never break the pass they describe */ }
      // A FAILED MEASUREMENT IS NOT A ZERO. Printing `0 held` when the query
      // threw is the same lie as printing free=0MB for unknown disk space.
      const heldText = heldScans ?? '?'
      // AND A CAPPED PASS MUST NOT READ AS A DRAINED ONE. `done: false` means
      // old scans are still there and the next window is 8 hours away; without
      // this the first pass over a backlog prints a million rows pruned and
      // looks exactly like a table that is now clean.
      const scanRemainder = d1?.done === false ? ' — BATCH CAP HIT, more remain' : ''
      log(`Housekeeping: pruned ${changesOf(d1)} scans (${heldText} held by analyses)${scanRemainder}, ${changesOf(d2)} signals, ${changesOf(d3)} regimes, ${changesOf(d4)} risk_events, ${d5} decisions, ${d6} position_events, ${d7.trades ?? 0} old trades, ${(d7.postmortems ?? 0) + (d7.orphanPostmortems ?? 0)} postmortems, ${d8.cupHandle ?? 0} cup-handle diags, ${d8.analyses ?? 0} analyses, ${d8.actionLog ?? 0} action-log rows, ${pass.results['prune-browser-sessions'] ?? 0} browser sessions, ${pass.results['prune-risk-config-history'] ?? 0} risk-config history keys, ${writeOff?.marked ?? 0} unknown-P&L write-offs`
        + (pass.failed.length ? ` — ${pass.failed.length} step(s) FAILED: ${pass.failed.map(f => f.name).join(', ')}` : ''))
    } catch (err) {
      log('Housekeeping error:', err.message)
    }
  }

  loopRunning = false
  lastLoopActivityAt = Date.now()
  const elapsed = Date.now() - start
  const delay = Math.max(10_000, loopIntervalMs(db) - elapsed)
  const cyclePhaseMs = closePhases()
  // V3 M1: every cycle feeds the main-loop ring (p50/p95/p99 on /health);
  // the first one after boot is stamped with its per-phase breakdown.
  noteLoopEnd({ startedAtMs: start, ms: elapsed, phaseMs: cyclePhaseMs, ok: !cycleErrored })
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
/**
 * The watchdog's line, as a pure function so a test can pin that it names
 * the in-flight call (Wave 5, §K·15). `inflight` is the registry's summary
 * ({ oldest, count }) or null.
 */
export function watchdogLine(detail, inflight) {
  const oldest = inflight?.oldest || null
  const inflightStr = oldest
    ? `in-flight: ${describeCall(oldest)}${inflight.count > 1 ? ` (+${inflight.count - 1} more)` : ''}`
    : 'in-flight: none registered'
  return `[watchdog] LOOP HUNG — no cycle activity for ${detail.quietMin}m (limit ${detail.limitMin}m), stuck in phase "${detail.phase}" — ${inflightStr} (loop #${detail.loopCount}, started ${detail.startedAt}). Exiting for a Railway auto-restart.`
}

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
      // Wave 5 (§K·15): the stuck CALL, not just the phase. Read from the
      // in-memory registry (same process), stamped once more so the record
      // outlives the exit below.
      const inflight = inflightSummary()
      maybeStampInflight(Date.now(), true)
      const detail = {
        phase, loopCount, loopRunning, startedAt, quietMin: Math.round(quietMs / 60_000), limitMin: limit / 60_000,
        inflight: inflight.oldest ? describeCall(inflight.oldest) : null, inflightCount: inflight.count,
      }
      console.error(watchdogLine(detail, inflight))
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
  // Staging shares production's cTrader grant — an armed staging agent
  // invalidates production's token on every refresh (the 26-08-2026 token
  // war). Everything that trades or touches the broker roots here (loop,
  // fast monitor, per-minute review), so refusing here disarms all of it.
  {
    const reason = disarmReason()
    if (reason) {
      console.error(`[disarm] agent NOT starting: ${reason}`)
      return
    }
  }
  log('Agent loop starting...')
  if (PENDING_PRODUCER_RETIRED) log('[boot] pending orders: producer retired — phase not scheduled')
  setTimeout(() => runLoop(db), 5000) // 5s delay on startup
  if (CLOSED_MARKET_PRODUCER_RETIRED) log('[boot] closed-market limits: producer retired — the scan rests no limits for the next open; the momentum and manual paths rest their own under their own producer')
  // Wave 5 (§K·15): the in-flight call registry stamps its oldest call to
  // loop_inflight_json from here on, so the watchdog's finding survives the
  // restart it triggers.
  configureInflight({ db, setState })
  import('./services/broker-history-recorder.js')
    .then(m => m.startBrokerHistoryRecording(db))
    .catch(err => log('broker history recording failed to start:', err.message))
  startLoopWatchdog(db)
  // Fast position monitor — 30s ticker, volume-aware cadence per open
  // position (owner: active positions are watched in ~1 minute, not 5).
  import('./services/fast-monitor.js')
    .then(m => m.startFastMonitor(db, getCtraderCreds))
    .catch(err => log('fast-monitor failed to start:', err.message))
  import('./services/independent-protection.js')
    .then(m => m.startIndependentProtection(db))
    .catch(err => log('independent protection relay failed to start:', err.message))
  import('./services/cashflow-collector.js')
    .then(m => m.startCashflowCollector(db))
    .catch(err => log('cashflow collector failed to start:', err.message))
  // Per-minute review (§70.4) — §41's level 5, on its own ticker so it keeps
  // reviewing precisely when the loop or the fast monitor is the thing that
  // broke. Reads only: it reports when a lower-authority writer moved a stop
  // the owner placed by hand, and never writes to a position itself.
  import('./services/minute-review.js')
    .then(m => m.startMinuteReview(db))
    .catch(err => log('minute-review failed to start:', err.message))
  // Order-lifecycle flags (V3 L1): every 10 minutes on its own ticker, built
  // on the read-only report worker; writes one compact snapshot row and beats
  // order_lifecycle. Reads only — reports, never repairs.
  import('./services/order-lifecycle-ticker.js')
    .then(m => m.startOrderLifecycle(db))
    .catch(err => log('order-lifecycle failed to start:', err.message))
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
  // Scanner observation bridge (timeframe publishing + tick/candidate
  // collector): ensured at boot and every 60 s on its own timer, so it runs
  // whether or not runLoop reaches the bar scan (the breaker and skip paths
  // return early), and a crashed worker is rebuilt. Inert until
  // SCANNER_BRIDGE_ENABLED=1 and registered profiles exist; no order authority.
  try { startScannerBridge(db) } catch (err) { log('scanner bridge failed to start:', err.message) }
  return { getLoopCount: () => loopCount }
}
