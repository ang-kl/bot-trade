// ---------------------------------------------------------------------------
// agent/loop.js — Main 5-minute scan loop
// ---------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk'
import { runScan } from './services/scanner.js'
import { runAnalysis } from './services/analyzer.js'
import { runMonitorCheck } from './services/monitor-svc.js'
import { evaluatePosition } from './services/position-manager.js'
import { runWeekendPositionCheck } from './services/weekend-watch.js'
import { evaluateTrade, loadRiskConfig, persistRiskEvent } from './services/risk.js'
import { sendScanAlert } from './services/telegram.js'
import { detectFlip } from './quant/signals.js'
import { buildContextBrief, buildScanDelta, persistScanContext } from './services/context.js'
import { getActiveSessions, nextSessionOpening, categoriseSymbol } from './lib/sessions.js'
import { encodeLabel, parseLabel, convictionBucket, LABEL_VERSION } from './lib/trade-labels.js'
import { wsPlaceOrder, wsAmendPosition, wsClosePosition, wsReconcile, wsSymbolsByIds } from './lib/ctrader-ws.js'
import { reconcilePositions } from './services/reconciler.js'
import { getState, setState } from './db.js'
import { getFreshAccessToken } from './lib/ctrader-token.js'

const LOOP_INTERVAL = 5 * 60 * 1000 // 5 minutes
const CTRADER_UNITS_PER_LOT = 10_000  // cTrader volume: 10000 = 1 lot
const MAX_CONSECUTIVE_ERRORS = 10     // hard circuit breaker — loop stops entirely
const CIRCUIT_BREAKER_RESET_MS = 30 * 60 * 1000 // 30 min manual reset window
const DAILY_TOKEN_BUDGET = 500_000    // stop API calls if daily output tokens exceed this
let loopCount = 0
let consecutiveErrors = 0
let loopRunning = false               // mutex — prevents concurrent iterations

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

async function autoTrade(db, symbol, synth, watchlistItem, accountOverride) {
  const clientId = process.env.CTRADER_CLIENT_ID
  const clientSecret = process.env.CTRADER_CLIENT_SECRET
  const accessToken = await getFreshAccessToken(db, getState, setState)
  const accountId = accountOverride?.accountId || getState(db, 'ctrader_account_id')
  const isLive = accountOverride ? !!accountOverride.isLive : getState(db, 'ctrader_is_live') === 'true'

  if (!clientId || !clientSecret || !accessToken || !accountId) {
    log(`Auto-trade skipped — cTrader credentials not configured (push via /actions/ctrader-config)`)
    return null
  }

  const side = synth.consensus_bias === 'short' ? 'SELL' : 'BUY'
  const requestedVol = watchlistItem?.maxVolume || 0.01

  // -------------------------------------------------------------------------
  // Risk Manager pre-trade gate — deterministic veto + Kelly volume scaling.
  // Runs before cTrader WS open. No LLM calls. Every evaluation is persisted
  // to risk_events for Workshop audit.
  // -------------------------------------------------------------------------
  const proposal = {
    symbol,
    side,
    entry: synth.entry ?? null,
    sl: synth.sl ?? null,
    tp1: synth.tp1 ?? null,
    requestedVolume: requestedVol,
    strategy: synth.strategy || null,
    conviction: synth.overall_conviction ?? null,
  }
  const riskResult = evaluateTrade(db, proposal, loadRiskConfig(db))
  persistRiskEvent(db, proposal, riskResult)
  if (!riskResult.approved) {
    log(`RISK VETO ${symbol} ${side}: ${riskResult.veto_reason}`)
    if (process.env.TELEGRAM_BOT_TOKEN) {
      try {
        const { sendMessage } = await import('./services/telegram.js')
        await sendMessage(`🛑 RISK VETO: ${symbol} ${side} — ${riskResult.veto_reason}`)
      } catch {}
    }
    return null
  }
  const volLots = riskResult.adjusted_volume
  if (Math.abs(volLots - requestedVol) > 0.001) {
    log(`Risk sizing: ${symbol} ${requestedVol} → ${volLots} (${riskResult.sizing_note})`)
  }
  const volume = Math.round(volLots * CTRADER_UNITS_PER_LOT)

  // We need symbolId — look it up from previously stored symbol map, or skip
  const symbolMapJson = getState(db, 'symbol_id_map')
  const symbolMap = symbolMapJson ? JSON.parse(symbolMapJson) : {}
  const symbolId = symbolMap[symbol.toUpperCase()]
  if (!symbolId) {
    log(`Auto-trade ${symbol}: symbolId unknown — call POST /actions/symbol-map to register it`)
    return null
  }

  const slDistance = synth.sl && synth.entry ? Math.abs(synth.entry - synth.sl) : null
  const tpDistance = synth.tp1 && synth.entry ? Math.abs(synth.tp1 - synth.entry) : null
  const POINTS = 100000

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
    ...(slDistance ? { relativeStopLoss: Math.round(slDistance * POINTS) } : {}),
    ...(tpDistance ? { relativeTakeProfit: Math.round(tpDistance * POINTS) } : {}),
  }

  const host = isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
  log(`Auto-trade: ${side} ${symbol} vol=${volLots} on ${isLive ? 'LIVE' : 'DEMO'}`)

  try {
    const exec = await wsPlaceOrder(host, clientId, clientSecret, accessToken, accountId, orderPayload)
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
          label_session, label_timeframe, label_regime
        ) VALUES (
          ?, ?, ?, ?, ?, ?, datetime('now'),
          'open', ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        symbol, side, executionPrice, slP, synth.tp1 ?? null, volLots,
        positionId, null, synth.strategy || null, synth.overall_conviction ?? null,
        parsedLabel.raw, parsedLabel.source, parsedLabel.version,
        parsedLabel.strategy, parsedLabel.conviction, parsedLabel.session,
        parsedLabel.timeframe, parsedLabel.regime,
      )
      const tradeId = tradeInsert.lastInsertRowid

      db.prepare(`
        INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, thesis, initial_risk, invalidation_trigger, time_cap_at, strategy, source, label_raw, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
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
      )

      return tradeId
    })

    const tradeId = persistTrade()
    log(`Auto-trade placed: ${side} ${symbol} @ ${executionPrice} posId=${positionId} tradeId=${tradeId}`)
    return { executionPrice, positionId, side, volume: volLots }
  } catch (err) {
    log(`Auto-trade FAILED for ${symbol}: ${err.message}`)
    return null
  }
}

function log(...args) {
  console.log('[loop]', ...args)
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

async function executeBrokerAction(db, s, pos, eval_) {
  const clientId = process.env.CTRADER_CLIENT_ID
  const clientSecret = process.env.CTRADER_CLIENT_SECRET
  const accessToken = await getFreshAccessToken(db, getState, setState)
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
      const res = await wsAmendPosition(host, clientId, clientSecret, accessToken, accountId, {
        positionId: ctx.positionId,
        stopLoss: eval_.newSL,
      })
      setState(db, 'api_ctrader_last_ok', new Date().toISOString())
      if (res.alreadyClosed) return { closedRemotely: true, summary: 'already_closed' }
      s.updatePositionSl.run(eval_.newSL, pos.id)
      return { summary: `SL → ${Number(eval_.newSL).toFixed(5)}` }
    }

    if (action === 'FULL_EXIT') {
      const volumeUnits = Math.round((ctx.volumeLots || 0) * CTRADER_UNITS_PER_LOT)
      if (volumeUnits <= 0) return { skipped: true, reason: 'unknown_volume' }
      const res = await wsClosePosition(host, clientId, clientSecret, accessToken, accountId, {
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
      const totalUnits = Math.round((ctx.volumeLots || 0) * CTRADER_UNITS_PER_LOT)
      const fraction = eval_.exitFraction ?? 0.5
      const closeUnits = Math.round(totalUnits * fraction)
      if (totalUnits <= 0 || closeUnits <= 0) return { skipped: true, reason: 'unknown_volume' }

      const closeRes = await wsClosePosition(host, clientId, clientSecret, accessToken, accountId, {
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
      const remainingLots = remainingUnits / CTRADER_UNITS_PER_LOT
      if (pos.trade_id) s.reduceTradeVolume.run(remainingLots, pos.trade_id)

      // Move SL for the runner leg (skip if newSL is null / same as current).
      if (eval_.newSL != null && eval_.newSL !== pos.current_sl) {
        const amendRes = await wsAmendPosition(host, clientId, clientSecret, accessToken, accountId, {
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

function prepareStatements(db) {
  if (stmts) return stmts

  stmts = {
    insertScan: db.prepare(`
      INSERT INTO scans (symbol, bias, confidence, thesis, timeframe, session_fit, trade_at, price, trade_grade, desk_note, scanned_at, loop_id)
      VALUES (@symbol, @bias, @confidence, @thesis, @timeframe, @session_fit, @trade_at, @price, @trade_grade, @desk_note, @scanned_at, @loop_id)
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
  // ---- Mutex: prevent overlapping iterations ----
  if (loopRunning) {
    log('Loop still running — skipping this tick')
    setTimeout(() => runLoop(db).catch(err => console.error('[loop] unhandled:', err.message)), LOOP_INTERVAL)
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
        } catch {}
      }
    }
    setTimeout(() => runLoop(db).catch(err => console.error('[loop] unhandled:', err.message)), CIRCUIT_BREAKER_RESET_MS)
    return
  }

  loopRunning = true
  loopCount++
  const start = Date.now()
  setState(db, 'loop_phase', 'starting')
  setState(db, 'loop_started_at', new Date().toISOString())

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
    // 1. SCAN PHASE — scan all enabled symbols
    // -----------------------------------------------------------------------
    const scanEnabled = getState(db, 'scan_enabled') !== 'false'
    const analyzeEnabled = getState(db, 'analyze_enabled') !== 'false'
    const autotradeEnabled = getState(db, 'autotrade_enabled') === 'true'
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    // Daily token budget check — pause API calls if exceeded
    const dailyTokensUsed = parseInt(getState(db, 'daily_tokens_used') || '0')
    const budgetExceeded = dailyTokensUsed >= DAILY_TOKEN_BUDGET
    if (budgetExceeded) {
      log(`Daily token budget exceeded (${dailyTokensUsed.toLocaleString()} / ${DAILY_TOKEN_BUDGET.toLocaleString()}) — skipping scan+analyze. Monitor-only mode.`)
      setState(db, 'loop_phase', `budget exceeded — monitor only`)
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
      const nextOpen = nextSessionOpening()
      const marketClosed = activeSessions.length === 0

      // 24/7 scanning — all symbols always. No market-hours filter.
      const symbols = allSymbols

      if (allSymbols.length === 0) {
        log('No enabled symbols configured')
      } else if (budgetExceeded) {
        log('Token budget exceeded — scan skipped')
      } else if (!scanEnabled) {
        log('Scan disabled — skipping')
      } else {
        if (marketClosed) {
          log(`Off-hours scan — ${symbols.length} symbol(s), market closed`)
        }

    setState(db, 'loop_phase', `scanning ${symbols.length} symbols`)
    const contextBrief = buildContextBrief(db)
    const scanDelta = buildScanDelta(db, []) // pre-scan delta (will be computed post-scan on next loop)

    // Run scan with accumulated context
    const scanResult = await runScan(client, symbols, {
      timezone: 'Asia/Singapore',
      hotThreshold: 6,
      contextBrief,
      scanDelta,
    })

    log(
      `Scan complete: ${scanResult.scans.length} symbols, ${scanResult.hot.length} hot, ${scanResult.warm.length} warm`
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
        scanned_at: now,
        loop_id: loopCount,
      })

      // Detect signal flips
      if (scan.bias && scan.bias !== 'skip') {
        detectFlip(db, scan.symbol, scan.bias, scan.confidence || 0, 'scan')
      }
    }

    setState(db, 'last_scan_at', now)
    setState(db, 'api_anthropic_last_ok', now)

    // Track daily token usage
    const scanTokens = scanResult.usage?.output_tokens || 0
    const prevTokens = parseInt(getState(db, 'daily_tokens_used') || '0')
    setState(db, 'daily_tokens_used', String(prevTokens + scanTokens))
    setState(db, 'last_scan_results', JSON.stringify(scanResult))

    // Persist scan context for next loop's delta computation
    persistScanContext(db, scanResult.scans)

    // Telegram alert for hot symbols
    if (scanResult.hot.length > 0 && process.env.TELEGRAM_BOT_TOKEN) {
      try {
        await sendScanAlert(scanResult.scans, scanResult.desk_note, '')
      } catch (err) {
        log('Telegram alert failed:', err.message)
      }
    }

    // -----------------------------------------------------------------------
    // 2. ANALYZE PHASE — deep analysis for hot symbols (max 3 per cycle)
    // -----------------------------------------------------------------------
    if (analyzeEnabled && !budgetExceeded && scanResult.hot.length > 0) {
      const hotToAnalyze = scanResult.hot.slice(0, 3)
      setState(db, 'loop_phase', `analyzing ${hotToAnalyze.join(', ')}`)
      for (const sym of hotToAnalyze) {
        try {
          const wItem =
            symbols.find(w => w.symbol === sym) || { autoTradeThreshold: 8 }

          // Pre-flight: skip analysis if ALL trade styles are disabled for this symbol
          if (wItem.allowed_styles) {
            const st = wItem.allowed_styles
            if (st.scalp === false && st.day === false && st.swing === false && st.mid_term === false) {
              log(`Style filter: ${sym} — all styles disabled, skipping analysis`)
              continue
            }
          }
          const result = await runAnalysis(client, sym, {
            autoTradeThreshold: wItem.autoTradeThreshold || 8,
          })

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

          const analyzeTokens = result.usage?.output_tokens || 0
          const cumTokens = parseInt(getState(db, 'daily_tokens_used') || '0') + analyzeTokens
          setState(db, 'daily_tokens_used', String(cumTokens))
          log(`Analysis complete: ${sym} — ${synth.consensus_bias || '?'} (${synth.overall_conviction || 0}/10) [${analyzeTokens} tokens, daily total: ${cumTokens}]`)

          // Auto-trade — only when armed and synthesis recommends it.
          // Iterate all autopilot-enabled accounts so the same signal
          // replicates across every assigned account with per-account sizing.
          // Send Telegram alert for every analysis regardless of autotrade
          if (synth.overall_conviction >= 6 && process.env.TELEGRAM_BOT_TOKEN) {
            try {
              const { sendMessage } = await import('./services/telegram.js')
              const emoji = synth.consensus_bias === 'long' ? '📈' : synth.consensus_bias === 'short' ? '📉' : '📊'
              await sendMessage(
                `${emoji} ANALYSIS: ${sym} ${synth.consensus_bias?.toUpperCase() || '?'} (${synth.overall_conviction}/10)\n${synth.synthesis || ''}\nEntry: ${synth.entry ?? '—'} SL: ${synth.sl ?? '—'} TP: ${synth.tp1 ?? '—'}`
              )
            } catch {}
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
              const s2 = syms.map(s => typeof s === 'string' ? { symbol: s } : s)
              const target = s2.find(s => s.symbol === sym)
              if (target) target.block_next_trade = false
              setState(db, 'autopilot_symbols_json', JSON.stringify(s2))
            } catch {}
          }

          if (autotradeEnabled && synth.auto_trade && synth.entry) {
            const apAccounts = getAutopilotAccounts(db)
            for (const acct of apAccounts) {
              const tradeResult = await autoTrade(db, sym, synth, wItem, acct)
              if (tradeResult && process.env.TELEGRAM_BOT_TOKEN) {
                try {
                  const { sendMessage } = await import('./services/telegram.js')
                  await sendMessage(
                    `🤖 AUTO-TRADE [${acct.accountId}]: ${tradeResult.side} ${sym} @ ${tradeResult.executionPrice ?? 'mkt'} | SL ${synth.sl ?? '—'} TP ${synth.tp1 ?? '—'}`
                  )
                } catch {}
              }
            }
          }
        } catch (err) {
          log(`Analysis failed for ${sym}:`, err.message)
        }
      }
    }

      } // end scanEnabled + symbols (scan+analyze branch)

      // ---------------------------------------------------------------------
      // 3. WEEKEND WATCH — hourly Opus pass on non-crypto open positions
      // when market is closed (and we're not already in pre-open warm-up,
      // which will run the full Analyst instead). Catches weekend catalysts
      // (Fed speak, OPEC, geopolitics) that break thesis before Monday gap.
      // ---------------------------------------------------------------------
      if (marketClosed && tradPositions.length > 0 && loopCount % 12 === 1) {
        log(`Weekend watch — reviewing ${tradPositions.length} non-crypto position(s)`)
        for (const pos of tradPositions) {
          try {
            const check = await runWeekendPositionCheck(client, pos)
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
              } catch {}
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
      try { lastScanResults = JSON.parse(lastScanResultsJson || 'null') } catch {}

      for (const pos of activePositions) {
        try {
          // Resolve current price from the most recent scan for this symbol.
          // When absent, position-manager returns HOLD + null metrics and we
          // still hand off to the LLM so the position is never skipped silently.
          const scanRow = lastScanResults?.scans?.find(sc => sc.symbol === pos.symbol)
          const currentPrice = scanRow?.price ?? null

          const eval_ = evaluatePosition(pos, { currentPrice })

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

          // External positions: skip LLM monitor — just update metrics, no token spend
          if (pos.source === 'external') continue

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

          s.updatePositionCheck.run(
            check.action,
            check.reasoning,
            new Date().toISOString(),
            check.thesis_status,
            pos.id
          )

          if (check.action === 'EXIT') {
            s.closePosition.run('closed', pos.id)
            log(`Position closed (LLM): ${pos.symbol} — ${check.reasoning}`)
          }
        } catch (err) {
          log(`Monitor check failed for ${pos.symbol}:`, err.message)
        }
      }
    } // end symbolsJson

    // -----------------------------------------------------------------------
    // 3.5. RECONCILE PHASE — every 3rd loop (~15 min)
    // -----------------------------------------------------------------------
    if (loopCount % 3 === 0) {
      try {
        const clientId = process.env.CTRADER_CLIENT_ID
        const clientSecret = process.env.CTRADER_CLIENT_SECRET
        const accessToken = await getFreshAccessToken(db, getState, setState)
        const accountId = getState(db, 'ctrader_account_id')
        const isLive = getState(db, 'ctrader_is_live') === 'true'

        if (clientId && clientSecret && accessToken && accountId) {
          setState(db, 'loop_phase', 'reconciling broker positions')
          const host = isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
          const reconcileData = await wsReconcile(host, clientId, clientSecret, accessToken, accountId)

          const allSymbolIds = [...new Set([
            ...(reconcileData.position || []).map(p => p.tradeData?.symbolId),
            ...(reconcileData.order || []).map(o => o.tradeData?.symbolId),
          ].filter(Boolean))]

          let symbolNameMap = {}
          if (allSymbolIds.length > 0) {
            const symData = await wsSymbolsByIds(host, clientId, clientSecret, accessToken, accountId, allSymbolIds)
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
          log(`Reconcile: ${result.newExternal.length} new external, ${result.closedDetected.length} closed detected, ${result.pendingOrders.length} pending orders`)

          if (result.newExternal.length > 0 && process.env.TELEGRAM_BOT_TOKEN) {
            try {
              const { sendMessage } = await import('./services/telegram.js')
              for (const ext of result.newExternal) {
                await sendMessage(`External position detected: ${ext.side} ${ext.symbol} @ ${ext.entry}`)
              }
            } catch {}
          }
        }
      } catch (err) {
        log('Reconcile phase error:', err.message)
      }
    }

    // -----------------------------------------------------------------------
    // 4. QUANT PHASE — every 6th loop (~30 min)
    // -----------------------------------------------------------------------
    if (loopCount % 6 === 0) {
      log('Quant phase — computing regime + performance snapshot')
      try {
        // Regime: summarise recent scan biases per symbol into regime state
        const recentScans = db.prepare(
          `SELECT symbol, bias, confidence, scanned_at FROM scans
           WHERE scanned_at > datetime('now', '-6 hours') ORDER BY scanned_at DESC`
        ).all()

        const bySymbol = {}
        for (const s of recentScans) {
          if (!bySymbol[s.symbol]) bySymbol[s.symbol] = []
          bySymbol[s.symbol].push(s)
        }

        for (const [symbol, rows] of Object.entries(bySymbol)) {
          const biases = rows.map(r => r.bias)
          const avgConf = rows.reduce((sum, r) => sum + (r.confidence || 0), 0) / rows.length
          const uniqueBiases = [...new Set(biases.filter(b => b && b !== 'skip'))]

          let regime = 'quiet'
          let trendDir = null
          if (uniqueBiases.length === 1 && avgConf >= 6) {
            regime = 'trending'
            trendDir = uniqueBiases[0]
          } else if (uniqueBiases.length > 1 && avgConf >= 5) {
            regime = 'volatile'
          } else if (avgConf >= 3) {
            regime = 'ranging'
          }

          db.prepare(
            `INSERT INTO regimes (symbol, regime, trend_direction, atr_pct, computed_at)
             VALUES (?, ?, ?, ?, datetime('now'))`
          ).run(symbol, regime, trendDir, avgConf)
        }

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
          const profitFactor = stats.avg_loss !== 0
            ? Math.abs((stats.avg_win || 0) / (stats.avg_loss || -1))
            : 0
          db.prepare(
            `INSERT INTO performance_snapshots (total_trades, winning_trades, losing_trades, win_rate, profit_factor, total_pnl, avg_win, avg_loss, computed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          ).run(stats.total, stats.wins, stats.losses, winRate, profitFactor, stats.total_pnl, stats.avg_win, stats.avg_loss)
        }

        log(`Regime updated for ${Object.keys(bySymbol).length} symbols`)
      } catch (err) {
        log('Quant phase error:', err.message)
      }
    }

    // -----------------------------------------------------------------------
    // 5. HOUSEKEEP
    // -----------------------------------------------------------------------
    setState(db, 'loop_count', String(loopCount))
    setState(db, 'last_loop_ms', String(Date.now() - start))
  } catch (err) {
    console.error('[loop] error:', err.message)
    consecutiveErrors++
    const errCount = parseInt(getState(db, 'errors_today') || '0') + 1
    setState(db, 'errors_today', String(errCount))
    setState(db, 'last_error', `${new Date().toISOString()} ${err.message}`)

    if (consecutiveErrors >= 5) {
      const backoff = Math.min(15 * 60_000, LOOP_INTERVAL * consecutiveErrors)
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
  const delay = Math.max(10_000, LOOP_INTERVAL - elapsed)
  setState(db, 'loop_phase', `sleeping ${Math.round(delay / 1000)}s`)
  log(`Loop #${loopCount} done in ${elapsed}ms — next in ${Math.round(delay / 1000)}s`)
  setTimeout(() => runLoop(db).catch(err => console.error('[loop] unhandled:', err.message)), delay)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function startLoop(db) {
  log('Agent loop starting...')
  setTimeout(() => runLoop(db), 5000) // 5s delay on startup
  return { getLoopCount: () => loopCount }
}
