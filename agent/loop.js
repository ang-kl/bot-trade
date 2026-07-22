// ---------------------------------------------------------------------------
// agent/loop.js — Main 5-minute scan loop
// ---------------------------------------------------------------------------

import { createLLMClient } from './lib/llm-provider.js'
import { runFibScan, synthesizeFibSignal } from './services/fib-strategy.js'
import { enabledStrategies } from './services/strategies.js'
import { scanStageStrategies, scanFilterOptions, tradeStageGate, manageStageAllows } from './services/stage-matrix.js'
import { runMonitorCheck } from './services/monitor-svc.js'
import { evaluatePosition } from './services/position-manager.js'
import { rulesForSymbol } from './services/asset-controllers.js'
import { runWeekendPositionCheck } from './services/weekend-watch.js'
import { evaluateTrade, loadRiskConfig, persistRiskEvent, getAccountBalance } from './services/risk.js'
import { sendScanAlert } from './services/telegram.js'
import { detectFlip } from './quant/signals.js'
import { persistScanContext } from './services/context.js'
import { getActiveSessions, categoriseSymbol, isWeekend, isSymbolMarketOpen } from './lib/sessions.js'
import { encodeLabel, parseLabel, convictionBucket, LABEL_VERSION } from './lib/trade-labels.js'
import { wsGetSymbolsList, wsGetTrendbarsBatch } from './lib/ctrader-ws.js'
// Broker execution goes through the delegator: EXEC_ENGINE=cpp routes to the
// C++ sidecar, default 'js' is a byte-identical passthrough to ctrader-ws.
import { placeOrder as execPlaceOrder, amendPosition as execAmendPosition, closePosition as execClosePosition, reconcile as execReconcile } from './lib/exec-engine.js'
import { getCtraderCreds, getSymbolMap } from './lib/ctrader-creds.js'
import { managePendingOrders } from './services/pending-orders.js'
import { ctraderEnv } from './lib/ctrader-env.js'
import { reconcilePositions } from './services/reconciler.js'
import { checkRegimeGate } from './services/regime-gate.js'
import { getState, setState } from './db.js'

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

// Lazy singleton — only the monitor/weekend position checks call the LLM now;
// the scan/analyze pipeline is deterministic (fib-strategy.js). Provider is
// OpenAI when OPENAI_API_KEY is set (owner's primary key), else Anthropic —
// same messages.create shape either way (see lib/llm-provider.js).
let _anthropicClient = null
function getAnthropicClient() {
  if (!_anthropicClient) {
    _anthropicClient = createLLMClient()
  }
  return _anthropicClient
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

function getAutopilotAccounts(db) {
  const rolesJson = getState(db, 'ctrader_account_roles_json')
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
  }

  const host = isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'

  // Microstructure spread gate: the live spread is a cost paid the instant
  // the market order fills. If it eats more than maxSpreadFracOfSL of the SL
  // distance, the R:R this signal was approved on no longer exists (rollover /
  // off-hours spread blowouts). Best-effort — a failed quote fails OPEN.
  if (slDistance && riskCfg.maxSpreadFracOfSL > 0) {
    try {
      const { wsGetSpotOnce } = await import('./lib/ctrader-ws.js')
      const q = await wsGetSpotOnce(host, clientId, clientSecret, accessToken, accountId, symbolId)
      if (q) {
        const spread = q.ask - q.bid
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

  log(`Auto-trade: ${side} ${symbol} vol=${volLots} on ${isLive ? 'LIVE' : 'DEMO'}`)

  try {
    const exec = await execPlaceOrder({ host, clientId, clientSecret, accessToken, accountId }, orderPayload)
    setState(db, 'api_ctrader_last_ok', new Date().toISOString())
    const executionPrice = exec?.deal?.executionPrice || exec?.position?.price || null
    const positionId = exec?.position?.positionId || exec?.deal?.positionId || null

    const entryP = executionPrice ?? synth.entry ?? null
    const slP = synth.sl ?? null
    const initialRisk = (entryP && slP) ? Math.abs(entryP - slP) : null

    let timeCap = null
    if (synth.time_cap_minutes && Number.isFinite(synth.time_cap_minutes)) {
      timeCap = new Date(Date.now() + synth.time_cap_minutes * 60_000).toISOString()
    }

    // Atomic DB write: trade + monitored_position in a single transaction.
    // If either INSERT fails, neither persists — no orphan rows.
    const parsedLabel = parseLabel(structuredLabel)
    const persistTrade = db.transaction(() => {
      const tradeInsert = db.prepare(`
        INSERT INTO trades (
          symbol, side, entry_price, sl_price, tp_price, volume, opened_at,
          status, ctrader_position_id, analysis_id, strategy, conviction,
          label_raw, source, label_version, label_strategy, label_conviction,
          label_session, label_timeframe, label_regime, confluence_count
        ) VALUES (
          ?, ?, ?, ?, ?, ?, datetime('now'),
          'open', ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        symbol, side, executionPrice, slP, synth.tp1 ?? null, volLots,
        positionId, null, synth.strategy || null, synth.overall_conviction ?? null,
        parsedLabel.raw, parsedLabel.source, parsedLabel.version,
        parsedLabel.strategy, parsedLabel.conviction, parsedLabel.session,
        parsedLabel.timeframe, parsedLabel.regime,
        synth.confluenceCount ?? null,
      )
      const tradeId = tradeInsert.lastInsertRowid

      db.prepare(`
        INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, thesis, initial_risk, invalidation_trigger, time_cap_at, strategy, source, label_raw, account_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
      `).run(
        symbol,
        tradeId,
        side === 'BUY' ? 'long' : 'short',
        executionPrice,
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
    return { executionPrice, positionId, side, volume: volLots }
  } catch (err) {
    // A placement failure AFTER risk approval must be as loud as a veto —
    // silently logging it made "risk gate said OK but no trade appeared"
    // undiagnosable from the UI (real support case: two days of OKs with
    // zero positions and no explanation anywhere but Railway logs).
    log(`Auto-trade FAILED for ${symbol}: ${err.message}`)
    try {
      persistRiskEvent(db, proposal, { approved: false, veto_reason: `order_failed: ${err.message}` })
    } catch { /* audit only */ }
    setState(db, 'last_order_error', JSON.stringify({ symbol, side, error: err.message, at: new Date().toISOString() }))
    if (process.env.TELEGRAM_BOT_TOKEN) {
      try {
        const { sendMessage } = await import('./services/telegram.js')
        await sendMessage(`⚠️ ORDER FAILED after risk approval: ${symbol} ${side} — ${err.message}. The broker rejected or the connection dropped; the signal may retry next loop.`)
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
        const { formatAnalysisAlert } = await import('./services/alert-format.js')
        const newsLines = await import('./services/news-calendar.js').then(m => m.newsLinesFor(db, sym)).catch(() => [])
        await sendMessage(formatAnalysisAlert(db, { sym, synth, signal, newsLines, armed: {
          tfs: (() => { try { return JSON.parse(getState(db, 'autotrade_timeframes') || '[]') } catch { return [] } })(),
          matrix: (() => { try { return JSON.parse(getState(db, 'autotrade_matrix_json') || 'null') } catch { return null } })(),
          autotrade: getState(db, 'autotrade_enabled') === 'true',
        } }))
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
    let allowedTfs = ['4h', '1d']
    const tfJson = getState(db, 'autotrade_timeframes')
    if (tfJson) {
      try {
        const parsedTfs = JSON.parse(tfJson)
        if (Array.isArray(parsedTfs) && parsedTfs.length > 0) allowedTfs = parsedTfs
      } catch { /* keep default */ }
    }
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
    const gate = tradeStageGate(db, getState, {
      strategy: synth.strategy,
      filtersFailed: signal?.filters_failed || [],
    })
    if (!gate.ok) {
      log(`Stage gate: ${sym} blocked — ${gate.reason}`)
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

    if (isScalp && styles.scalp === false) {
      log(`Style filter: ${sym} blocked — scalp trading disabled (TTL ${ttl}m)`)
      synth.auto_trade = false
    }
    if (isDay && styles.day === false) {
      log(`Style filter: ${sym} blocked — day trading disabled (TTL ${ttl}m)`)
      synth.auto_trade = false
    }
    if (isSwing && styles.swing === false) {
      log(`Style filter: ${sym} blocked — swing trading disabled (TTL ${ttl}m)`)
      synth.auto_trade = false
    }
    if (isMidTerm && styles.mid_term === false) {
      log(`Style filter: ${sym} blocked — mid-term trading disabled (TTL ${ttl}m)`)
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
    const apAccounts = getAutopilotAccounts(db)
    for (const acct of apAccounts) {
      const tradeResult = await autoTrade(db, sym, synth, wItem, acct)
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

export async function executeBrokerAction(db, s, pos, eval_) {
  const clientId = ctraderEnv('clientId')
  const clientSecret = ctraderEnv('clientSecret')
  const accessToken = getState(db, 'ctrader_access_token')
  const accountId = getState(db, 'ctrader_account_id')
  const isLive = getState(db, 'ctrader_is_live') === 'true'

  if (!clientId || !clientSecret || !accessToken || !accountId) {
    return { skipped: true, reason: 'ctrader_not_configured' }
  }

  const ctx = s.selectBrokerContext.get(pos.id) || {}
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

    if (action === 'FULL_EXIT') {
      const meta = await volumeMeta()
      const volumeUnits = Math.round((ctx.volumeLots || 0) * meta.lotSize)
      if (volumeUnits <= 0) return { skipped: true, reason: 'unknown_volume' }
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
        s.markTradeClosed.run(closePrice, eval_.reason || 'position_manager', grossPnl, netPnl, pos.trade_id)
      }
      s.closePosition.run('closed', pos.id)
      return { closedRemotely: true, summary: res.alreadyClosed ? 'already_closed' : `closed @ ${closePrice ?? '?'}` }
    }

    if (action === 'PARTIAL_EXIT') {
      const meta = await volumeMeta()
      const totalUnits = Math.round((ctx.volumeLots || 0) * meta.lotSize)
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
        if (pos.trade_id) s.markTradeClosed.run(null, 'already_closed', null, null, pos.trade_id)
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

      // Move SL for the runner leg (skip if newSL is null / same as current).
      if (eval_.newSL != null && eval_.newSL !== pos.current_sl) {
        const amendRes = await execAmendPosition({ host, clientId, clientSecret, accessToken, accountId }, {
          positionId: ctx.positionId,
          stopLoss: eval_.newSL,
        })
        setState(db, 'api_ctrader_last_ok', new Date().toISOString())
        if (!amendRes.alreadyClosed) s.updatePositionSl.run(eval_.newSL, pos.id)
      }
      return { summary: `closed ${(fraction * 100).toFixed(0)}% · runner ${remainingLots.toFixed(2)}L` }
    }

    return { skipped: true, reason: `unhandled_action:${action}` }
  } catch (err) {
    return { error: err.message }
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
    selectBrokerContext: db.prepare(`
      SELECT t.ctrader_position_id AS positionId, t.volume AS volumeLots
      FROM monitored_positions mp
      LEFT JOIN trades t ON t.id = mp.trade_id
      WHERE mp.id = ?
    `),

    markTradeClosed: db.prepare(`
      UPDATE trades
      SET status = 'closed', closed_at = datetime('now'),
          exit_price = COALESCE(?, exit_price),
          close_reason = ?,
          gross_pnl = COALESCE(?, gross_pnl),
          net_pnl = COALESCE(?, net_pnl)
      WHERE id = ?
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
  const start = Date.now()
  console.log(`[diag] LOOP #${loopCount} start`)
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
          setState(db, 'loop_phase', 'reconciling broker positions')
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

          // Un-blind the safety brakes: a position closed at the BROKER (a
          // resting SL/TP fill — the normal stop-out) was marked closed with
          // net_pnl NULL, invisible to the daily cap, equity stop, loss-streak
          // cooldown, and the performance breaker until a human opened the
          // dashboard. Backfill broker-true realized P&L here, in the loop, so
          // every downstream brake this cycle sees the real drawdown. Runs
          // only when something actually closed at the broker and best-effort
          // (a deal-history hiccup must never stall the loop).
          if ((result.closedDetected || []).length > 0) {
            try {
              const { backfillClosedPnl } = await import('./services/pnl-backfill.js')
              const bf = await backfillClosedPnl(db, { host, clientId, clientSecret, accessToken, accountId })
              if (bf.backfilled > 0) log(`P&L backfill: filled ${bf.backfilled} broker-closed trade(s) with realized P&L`)
            } catch (err) {
              log(`P&L backfill failed (non-fatal): ${err.message}`)
            }
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
          log(`Reconcile: ${result.newExternal.length} new external, ${result.closedDetected.length} closed detected, ${(result.manualChanges || []).length} manual change(s), ${result.pendingOrders.length} pending orders`)

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
          // trades close (linking set it once; this keeps it live).
          try {
            const { wsGetTrader, traderBalance } = await import('./lib/ctrader-ws.js')
            const trader = await wsGetTrader(host, clientId, clientSecret, accessToken, accountId)
            const bal = traderBalance(trader)
            if (bal != null) setState(db, 'account_balance_usd', String(bal))
          } catch { /* best effort */ }

          if (result.newExternal.length > 0 && process.env.TELEGRAM_BOT_TOKEN) {
            try {
              const { sendMessage } = await import('./services/telegram.js')
              for (const ext of result.newExternal) {
                await sendMessage(`External position detected: ${ext.side} ${ext.symbol} @ ${ext.entry}`)
              }
            } catch { /* non-fatal */ }
          }
        }
      } catch (err) {
        log('Reconcile phase error:', err.message)
      }
    }

    // -----------------------------------------------------------------------
    // 1. SCAN PHASE — scan all enabled symbols
    // -----------------------------------------------------------------------
    const scanEnabled = getState(db, 'scan_enabled') !== 'false'
    const analyzeEnabled = getState(db, 'analyze_enabled') !== 'false'
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

      // 24/7 scanning — all symbols always. No market-hours filter.
      const symbols = allSymbols

      if (allSymbols.length === 0) {
        log('No enabled symbols configured')
      } else if (!scanEnabled) {
        log('Scan disabled — skipping')
      } else {
        if (marketClosed) {
          log(`Off-hours scan — ${symbols.length} symbol(s), market closed`)
        }

    setState(db, 'loop_phase', `scanning ${symbols.length} symbols`)

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
    const scanT0 = Date.now()
    const scanResult = ctraderCreds.ready
      ? await runFibScan(ctraderCreds, symbolMap, symbols, { hotThreshold: 6, ...stageFilterOpts, strategies, armedStrategyKeys, extraTimeframes, matrix: scanMatrix, armedTfs: extraTimeframes.length ? extraTimeframes : null, cursor: scanCursor, prioritySymbols })
      : { scans: [], hot: [], warm: [], desk_note: 'cTrader credentials not configured — scan skipped', usage: { output_tokens: 0 }, signals: {}, errors: [] }
    const scanMs = Date.now() - scanT0
    setState(db, 'last_scan_ms', String(scanMs))
    if (scanResult.next_cursor != null) setState(db, 'scan_cursor', String(scanResult.next_cursor))

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
      setState(db, 'api_ctrader_last_error', `${new Date().toISOString()} ${scanResult.errors[0]}`)
      const errorsToday0 = Number(getState(db, 'errors_today') || 0)
      setState(db, 'errors_today', String(errorsToday0 + 1))
    } else if (ctraderCreds.ready && scanResult.scans.length > 0) {
      setState(db, 'api_ctrader_last_ok', new Date().toISOString())
    }

    log(
      `Scan complete: ${scanResult.scans.length} symbols, ${scanResult.hot.length} hot, ${scanResult.warm.length} warm (${scanMs}ms, concurrency ${process.env.SCAN_CONCURRENCY || 6})`
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
          await sendScanAlert(scanResult.scans, scanResult.desk_note, '')
          setState(db, 'last_hot_alert_signature', hotSignature)
        } catch (err) {
          log('Telegram alert failed:', err.message)
        }
      }
    }

    // -----------------------------------------------------------------------
    // 2. ANALYZE PHASE — deep analysis for hot symbols (max 3 per cycle)
    // -----------------------------------------------------------------------
    if (analyzeEnabled && scanResult.hot.length > 0) {
      // Best-first slot allocation: with concurrent positions capped (owner set
      // 25), the few candidates dispatched each cycle must be the STRONGEST
      // signals, not whichever scanned first — otherwise mediocre setups fill
      // the slots and stronger later signals hit the max-positions veto. Rank
      // hot by conviction (tie-break: a symbol with a positive backtest edge).
      const { rankHotSymbols, provenEdgeSymbolsFrom } = await import('./services/signal-ranking.js')
      let baseline = null
      try { baseline = JSON.parse(getState(db, 'backtest_baseline_json') || 'null') } catch { /* none */ }
      const ranked = rankHotSymbols(scanResult.scans, scanResult.hot, { provenEdgeSymbols: provenEdgeSymbolsFrom(baseline) })
      const hotToAnalyze = ranked.slice(0, 3)
      setState(db, 'loop_phase', `analyzing ${hotToAnalyze.join(', ')}`)
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
        if (getState(db, 'pending_mode_enabled') === 'true') {
          const pendingCreds = getCtraderCreds(db)
          if (pendingCreds.ready) {
            const r = await managePendingOrders(db, pendingCreds, getSymbolMap(db), {
              notify: (text) => import('./services/telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
            })
            if (r?.summary) log(`Pending orders: ${r.summary}`)
            else if (r?.skipped) log(`Pending orders skipped: ${r.skipped}`)
          }
        }
        await hbeat(db, 'pending_orders')
      } catch (err) {
        log(`Pending-order phase failed (non-fatal): ${err.message}`)
        await hbeat(db, 'pending_orders', false, err.message)
      }

      // BURN-IN MODE — track-record trades (owner-armed): min-size positions
      // through the full auto-trade path with tight time caps, so completed
      // round-trips accumulate fast. Inert unless burn_in_json.on AND
      // autotrade armed; a failure must never take down the loop.
      try {
        const biCreds = getCtraderCreds(db)
        if (biCreds.ready) {
          const { runBurnIn } = await import('./services/burn-in.js')
          const b = await runBurnIn(db, biCreds)
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
        const { runPendingSignals } = await import('./services/pending-signals.js')
        const p = await runPendingSignals(db, psCreds)
        if (p.fired || p.expired) log(`Pending signals: ${p.fired} fired, ${p.expired} expired, ${p.checked} checked`)
        await hbeat(db, 'pending_signals')
      } catch (err) {
        log(`Pending-signals retry failed (non-fatal): ${err.message}`)
        await hbeat(db, 'pending_signals', false, err.message)
      }

      // Per-position trade guards — break-even / trailing / partial TPs the
      // owner armed on individual positions. Inert when no position has
      // rules; a failure must never take down the loop.
      try {
        const guardCreds = getCtraderCreds(db)
        if (guardCreds.ready) {
          const { runTradeGuards } = await import('./services/trade-guard.js')
          const g = await runTradeGuards(db, guardCreds, {
            notify: (text) => import('./services/telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
          })
          if (g.slMoves || g.partialCloses) log(`Trade guards: ${g.slMoves} SL move(s), ${g.partialCloses} partial close(s)`)
          if (g.errors.length) log(`Trade guards errors: ${g.errors.join(' · ')}`)
        }
        await hbeat(db, 'trade_guards')
      } catch (err) {
        log(`Trade guards failed (non-fatal): ${err.message}`)
        await hbeat(db, 'trade_guards', false, err.message)
      }

      // Profit Keeper — opt-in profit protection for manual/external
      // positions (ratchets broker-side SLs, closes on giveback). Inert
      // when off; a failure must never take down the loop.
      try {
        const keeperCreds = getCtraderCreds(db)
        if (keeperCreds.ready) {
          const { runProfitKeeper } = await import('./services/profit-keeper.js')
          const k = await runProfitKeeper(db, keeperCreds, {
            notify: (text) => import('./services/telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
          })
          if (k.slMoves || k.closes) log(`Profit Keeper: ${k.slMoves} lock(s), ${k.closes} close(s)`)
          if (k.errors.length) log(`Profit Keeper errors: ${k.errors.join(' · ')}`)
        }
        await hbeat(db, 'profit_keeper')
      } catch (err) {
        log(`Profit Keeper failed (non-fatal): ${err.message}`)
        await hbeat(db, 'profit_keeper', false, err.message)
      }

      // Loss Guardian — safety net for LOSING/naked positions the Profit
      // Keeper won't touch (it only protects gains). Conservative: places a
      // protective stop on a NAKED position and enforces an optional time cap;
      // never tightens a valid mean-reversion stop. Inert when off; non-fatal.
      try {
        const guardCreds = getCtraderCreds(db)
        if (guardCreds.ready) {
          const { runLossGuardian } = await import('./services/loss-guardian.js')
          const g = await runLossGuardian(db, guardCreds, {
            notify: (text) => import('./services/telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
          })
          if (g.stops || g.closes) log(`Loss Guardian: ${g.stops} protective stop(s), ${g.closes} close(s)`)
          if (g.errors.length) log(`Loss Guardian errors: ${g.errors.join(' · ')}`)
        }
        await hbeat(db, 'loss_guardian')
      } catch (err) {
        log(`Loss Guardian failed (non-fatal): ${err.message}`)
        await hbeat(db, 'loss_guardian', false, err.message)
      }

      // Periodic broker-truth market-hours refresh — pull each mapped
      // symbol's real trading schedule from cTrader into symbol_hours so the
      // open/closed gate scales to 1,900+ instruments without hardcoded
      // categories. Roughly once a day (every ~288 five-min loops), and once
      // shortly after boot when the table is empty. Non-fatal.
      try {
        const creds = getCtraderCreds(db)
        const haveHours = db.prepare('SELECT COUNT(*) AS n FROM symbol_hours').get().n
        if (creds.ready && (loopCount % 288 === 5 || haveHours === 0)) {
          const { refreshSymbolHours } = await import('./services/symbol-hours.js')
          const r = await refreshSymbolHours(db, creds)
          if (r.updated) log(`Market hours refreshed: ${r.updated} symbols${r.errors.length ? `, ${r.errors.length} batch error(s)` : ''}`)
          await hbeat(db, 'hours_refresh')
        }
      } catch (err) {
        log(`Market-hours refresh failed (non-fatal): ${err.message}`)
        await hbeat(db, 'hours_refresh', false, err.message)
      }

      // Strategy Autopilot — nightly evidence loop (mode-gated inside;
      // failures must never touch the trading phases).
      try {
        const { maybeRunAutopilot } = await import('./services/strategy-autopilot.js')
        const r = await maybeRunAutopilot(db, getCtraderCreds(db))
        if (r && !r.skipped) log(`Autopilot: ${JSON.stringify(r)}`)
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
      if (weekendPositions.length > 0 && loopCount % 12 === 1) {
        log(`Weekend watch — reviewing ${weekendPositions.length} closed-market position(s)`)
        for (const pos of weekendPositions) {
          try {
            const check = await runWeekendPositionCheck(client, pos)
            recordAnthropicUsage(db, check.usage || { output_tokens: check.tokens || 0 }, 'weekend_watch', check.model)
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
            log(`Weekend check failed for ${pos.symbol}:`, err.message)
          }
        }
      }

      // ---------------------------------------------------------------------
      // 4. MONITOR PHASE — always runs when positions are open, even when
      // scan+analyze was skipped (market closed, etc). Crypto positions and
      // stale FX positions still need tick checks.
      // ---------------------------------------------------------------------
      if (openPositions.length > 0) setState(db, 'loop_phase', `monitoring ${openPositions.length} positions`)
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

      for (const pos of activePositions) {
        try {
          // Current price: the fresh spot quote first, then the most recent
          // scan row as a fallback. When both are absent, position-manager
          // returns HOLD + null metrics and we still hand off to the LLM so the
          // position is never skipped silently.
          const scanRow = lastScanResults?.scans?.find(sc => sc.symbol === pos.symbol)
          const currentPrice = heldPrices[String(pos.symbol).toUpperCase()] ?? scanRow?.price ?? null

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
              continue
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
              continue
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
            continue
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
            continue
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
            continue
          }

          // Fallback: free-text theses and ambiguous cases → LLM Monitor.
          const check = await runMonitorCheck(client, {
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
          recordAnthropicUsage(db, check.usage, 'position_monitor', check.model)

          s.updatePositionCheck.run(
            check.action,
            check.reasoning,
            new Date().toISOString(),
            check.thesis_status,
            pos.id
          )

          if (check.action === 'EXIT') {
            // BUG FIX (owner: "why are 18 positions not being trimmed" — audit
            // found this): this branch used to call s.closePosition.run()
            // directly — a bare DB status flip with NO broker close. The
            // position stayed open and margin-locked at the broker forever
            // while the bot's own bookkeeping said 'closed', so nothing
            // (profit-keeper, trade-guards, this very monitor) ever looked at
            // it again. Route through the same executeBrokerAction the
            // deterministic path uses so the broker position actually closes.
            const outcome = await executeBrokerAction(db, s, pos, { action: 'FULL_EXIT', reason: check.reasoning })
            if (outcome.error) {
              log(`Position close (LLM) FAILED: ${pos.symbol} — ${outcome.error}`)
            } else if (outcome.skipped) {
              log(`Position close (LLM) intent-only for ${pos.symbol}: ${outcome.reason} — ${check.reasoning}`)
              s.closePosition.run('closed', pos.id) // no broker to close against (e.g. not configured) — DB-only, as before
            } else {
              log(`Position closed (LLM): ${pos.symbol} — ${outcome.summary} — ${check.reasoning}`)
            }
          }
        } catch (err) {
          log(`Monitor check failed for ${pos.symbol}:`, err.message)
        }
      }

      // ---------------------------------------------------------------------
      // 4a-bis. ADAPTIVE BREAKER — the machine response to a loss streak:
      // change strategy/filters via the stage matrix instead of pausing
      // (owner: cooldown pauses are for humans). Non-fatal by construction.
      // ---------------------------------------------------------------------
      try {
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
      // 4b. EQUITY STOP — daily max-drawdown circuit for OPEN positions.
      // risk.js's dailyLossPct only vetoes NEW trades; this closes everything
      // and disarms autotrade when today's realized PnL breaches the cap.
      // Fires at most once per UTC day.
      // ---------------------------------------------------------------------
      try {
        const riskCfg = loadRiskConfig(db)
        const stopPct = riskCfg.equityStopPct ?? riskCfg.dailyLossPct
        const balance = getAccountBalance(db)
        const cap = balance != null ? balance * stopPct : riskCfg.dailyLossLimit
        const dayStart = new Date()
        dayStart.setUTCHours(0, 0, 0, 0)
        const todayPnl = db
          .prepare(`SELECT COALESCE(SUM(net_pnl), 0) AS pnl FROM trades WHERE status = 'closed' AND closed_at >= ?`)
          .get(dayStart.toISOString())?.pnl || 0
        const todayUTCDate = new Date().toISOString().slice(0, 10)
        const alreadyTripped = (getState(db, 'equity_stop_tripped_at') || '').slice(0, 10) === todayUTCDate
        const botPositions = s.selectActivePositions.all('active').filter(p => p.source !== 'external')

        if (!alreadyTripped && todayPnl <= -Math.abs(cap) && botPositions.length > 0) {
          setState(db, 'equity_stop_tripped_at', new Date().toISOString())
          setState(db, 'autotrade_enabled', 'false')
          log(`EQUITY STOP: today's PnL ${todayPnl.toFixed(2)} breached cap ${cap.toFixed(2)} — closing ${botPositions.length} position(s), autotrade disarmed`)
          for (const pos of botPositions) {
            try {
              const outcome = await executeBrokerAction(db, s, pos, { action: 'FULL_EXIT', reason: 'equity_stop_daily_drawdown' })
              s.updatePositionCheck.run(
                'EQUITY_STOP',
                `daily loss ${todayPnl.toFixed(2)} breached cap ${cap.toFixed(2)} | ${outcome.error || outcome.summary || outcome.reason || 'closed'}`,
                new Date().toISOString(),
                'broken',
                pos.id
              )
            } catch (err) {
              log(`Equity stop close failed for ${pos.symbol}:`, err.message)
            }
          }
          if (process.env.TELEGRAM_BOT_TOKEN) {
            try {
              const { sendMessage } = await import('./services/telegram.js')
              await sendMessage(`🛑 EQUITY STOP: daily loss ${todayPnl.toFixed(2)} breached cap ${cap.toFixed(2)}. All positions closed, autotrade DISARMED.`)
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
    const errCount = parseInt(getState(db, 'errors_today') || '0') + 1
    setState(db, 'errors_today', String(errCount))
    setState(db, 'last_error', `${new Date().toISOString()} ${err.message}`)

    if (consecutiveErrors >= 5) {
      const backoff = Math.min(15 * 60_000, loopIntervalMs(db) * consecutiveErrors)
      log(`Self-healing: ${consecutiveErrors} consecutive errors — backing off ${Math.round(backoff / 60000)}m`)
      loopRunning = false
      setTimeout(() => runLoop(db).catch(err => console.error('[loop] unhandled:', err.message)), backoff)
      return
    }
  }

  consecutiveErrors = 0
  setState(db, 'circuit_breaker_tripped_at', null)

  // ---- Housekeeping: data retention (once per 100 loops ≈ 8 hours) ----
  if (loopCount % 100 === 0) {
    try {
      const cutoff30d = new Date(Date.now() - 30 * 86400_000).toISOString()
      const cutoff90d = new Date(Date.now() - 90 * 86400_000).toISOString()
      const d1 = db.prepare('DELETE FROM scans WHERE scanned_at < ?').run(cutoff30d)
      const d2 = db.prepare('DELETE FROM signals WHERE recorded_at < ?').run(cutoff30d)
      const d3 = db.prepare('DELETE FROM regimes WHERE computed_at < ?').run(cutoff30d)
      const d4 = db.prepare('DELETE FROM risk_events WHERE created_at < ?').run(cutoff90d)
      log(`Housekeeping: pruned ${d1.changes} scans, ${d2.changes} signals, ${d3.changes} regimes, ${d4.changes} risk_events`)
    } catch (err) {
      log('Housekeeping error:', err.message)
    }
  }

  loopRunning = false
  const elapsed = Date.now() - start
  const delay = Math.max(10_000, loopIntervalMs(db) - elapsed)
  setState(db, 'loop_phase', `sleeping ${Math.round(delay / 1000)}s`)
  console.log(`[diag] LOOP #${loopCount} end ${elapsed}ms — next in ${Math.round(delay / 1000)}s`)
  log(`Loop #${loopCount} done in ${elapsed}ms — next in ${Math.round(delay / 1000)}s`)
  setTimeout(() => runLoop(db).catch(err => console.error('[loop] unhandled:', err.message)), delay)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function startLoop(db) {
  log('Agent loop starting...')
  setTimeout(() => runLoop(db), 5000) // 5s delay on startup
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
  return { getLoopCount: () => loopCount }
}
