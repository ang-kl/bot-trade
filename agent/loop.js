// ---------------------------------------------------------------------------
// agent/loop.js — Main 5-minute scan loop
// ---------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk'
import WebSocket from 'ws'
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
import { getState, setState } from './db.js'

const LOOP_INTERVAL = 5 * 60 * 1000 // 5 minutes
let loopCount = 0
let consecutiveErrors = 0

// ---------------------------------------------------------------------------
// cTrader auto-trade via WebSocket — places a market order when synthesis
// says auto_trade = true. Reads credentials stored via POST /actions/ctrader-config
// ---------------------------------------------------------------------------

const PT_APP_AUTH_REQ = 2100
const PT_APP_AUTH_RES = 2101
const PT_ACCOUNT_AUTH_REQ = 2102
const PT_ACCOUNT_AUTH_RES = 2103
const PT_NEW_ORDER_REQ = 2106
const PT_EXECUTION_EVENT = 2126
const PT_ORDER_ERROR_EVENT = 2132
const PT_HEARTBEAT = 51

function wsPlaceOrder(host, clientId, clientSecret, accessToken, accountId, orderPayload, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${host}:5036`)
    let hb, timer
    const done = (fn) => { clearTimeout(timer); clearInterval(hb); if (ws.readyState === WebSocket.OPEN) ws.close(); fn() }

    timer = setTimeout(() => done(() => reject(new Error('cTrader order timeout'))), timeoutMs)

    const steps = [
      { send: { payloadType: PT_APP_AUTH_REQ, payload: { clientId, clientSecret } }, expect: PT_APP_AUTH_RES },
      { send: { payloadType: PT_ACCOUNT_AUTH_REQ, payload: { ctidTraderAccountId: parseInt(accountId), accessToken } }, expect: PT_ACCOUNT_AUTH_RES },
      { send: { payloadType: PT_NEW_ORDER_REQ, payload: orderPayload }, expect: PT_EXECUTION_EVENT },
    ]
    let stepIdx = 0

    ws.on('open', () => {
      hb = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ payloadType: PT_HEARTBEAT })) }, 9000)
      ws.send(JSON.stringify({ clientMsgId: `s0`, payloadType: steps[0].send.payloadType, payload: steps[0].send.payload }))
    })

    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.payloadType === PT_HEARTBEAT) return
      if (msg.payloadType === PT_ORDER_ERROR_EVENT) {
        const e = msg.payload || {}
        return done(() => reject(new Error(`cTrader order rejected: ${e.errorCode || 'unknown'} — ${e.description || ''}`)))
      }
      if (msg.payloadType === steps[stepIdx]?.expect) {
        stepIdx++
        if (stepIdx >= steps.length) {
          return done(() => resolve(msg.payload || {}))
        }
        ws.send(JSON.stringify({ clientMsgId: `s${stepIdx}`, payloadType: steps[stepIdx].send.payloadType, payload: steps[stepIdx].send.payload }))
      }
    })

    ws.on('error', (err) => done(() => reject(new Error(`WS error: ${err.message}`))))
  })
}

async function autoTrade(db, symbol, synth, watchlistItem) {
  const clientId = process.env.CTRADER_CLIENT_ID
  const clientSecret = process.env.CTRADER_CLIENT_SECRET
  const accessToken = getState(db, 'ctrader_access_token')
  const accountId = getState(db, 'ctrader_account_id')
  const isLive = getState(db, 'ctrader_is_live') === 'true'

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
  const volume = Math.round(volLots * 10000) // cTrader units: 10000 = 1 lot

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
    const executionPrice = exec?.deal?.executionPrice || exec?.position?.price || null
    const positionId = exec?.position?.positionId || exec?.deal?.positionId || null

    // Compute initial_risk = |entry - SL|; needed for R-unit math in position-manager
    const entryP = executionPrice ?? synth.entry ?? null
    const slP = synth.sl ?? null
    const initialRisk = (entryP && slP) ? Math.abs(entryP - slP) : null

    // Compute absolute time cap from Analyst's time_cap_minutes
    let timeCap = null
    if (synth.time_cap_minutes && Number.isFinite(synth.time_cap_minutes)) {
      timeCap = new Date(Date.now() + synth.time_cap_minutes * 60_000).toISOString()
    }

    // Record trade in DB with parsed label components — fast attribution
    // queries without re-parsing the raw label string on every read.
    const parsedLabel = parseLabel(structuredLabel)
    db.prepare(`
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

    // Register in monitored_positions — fully populated for position-manager
    db.prepare(`
      INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, current_tp, thesis, initial_risk, invalidation_trigger, time_cap_at, strategy, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      symbol,
      side === 'BUY' ? 'long' : 'short',
      executionPrice,
      slP,
      synth.tp1 ?? null,
      synth.synthesis || '',
      initialRisk,
      synth.invalidation_trigger || null,
      timeCap,
      synth.strategy || null,
    )

    log(`Auto-trade placed: ${side} ${symbol} @ ${executionPrice} posId=${positionId}`)
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

    selectActivePositions: db.prepare(
      `SELECT * FROM monitored_positions WHERE status = ? AND COALESCE(paused, 0) = 0`
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

    closePosition: db.prepare(
      `UPDATE monitored_positions SET status = ? WHERE id = ?`
    ),

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
  loopCount++
  const start = Date.now()

  try {
    const s = prepareStatements(db)

    // -----------------------------------------------------------------------
    // 1. SCAN PHASE — scan all enabled symbols
    // -----------------------------------------------------------------------
    const watchlistJson = getState(db, 'watchlist_json')
    const armed = getState(db, 'armed') === 'true'
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    if (!watchlistJson) {
      log('No watchlist configured — push one via POST /actions/watchlist')
    } else {
      let watchlist
      try { watchlist = JSON.parse(watchlistJson) } catch { watchlist = [] }
      const allSymbols = (Array.isArray(watchlist) ? watchlist : [])
        .map(w => (typeof w === 'string' ? { symbol: w, enabled: true } : w))
        .filter(w => w.enabled !== false)

      // Market-closed guardrail: when no FX/equity session is active, crypto
      // (24/7) still scans normally. Non-crypto gets a weekend-watch pass on
      // any held positions + a pre-open warm-up when the first session
      // (Sydney, UTC 22:00 Sun) is within 30 minutes. Monitor phase is lifted
      // out of this block so it always runs on every position regardless.
      const activeSessions = getActiveSessions()
      const openPositions = s.selectActivePositions.all('active')
      const tradPositions = openPositions.filter(p => categoriseSymbol(p.symbol) !== 'crypto')
      const nextOpen = nextSessionOpening()
      const marketClosed = activeSessions.length === 0
      const preOpenWindow = marketClosed && nextOpen && nextOpen.minsUntil <= 30

      // Pre-open warm-up: scan the full watchlist so theses are fresh for the
      // Sydney bell. Otherwise, when market is closed, scan only 24/7 crypto.
      const symbols = marketClosed && !preOpenWindow
        ? allSymbols.filter(w => categoriseSymbol(w.symbol) === 'crypto')
        : allSymbols

      if (preOpenWindow) {
        log(`Pre-open warm-up — ${nextOpen.label} opens in ${nextOpen.minsUntil}m. Running full scan+analyze.`)
        setState(db, 'last_preopen_at', new Date().toISOString())
      }

      if (marketClosed && symbols.length === 0 && openPositions.length === 0) {
        log(`Market closed — no sessions active, no positions open. Next open: ${nextOpen?.label || '?'} in ~${Math.round((nextOpen?.minsUntil || 0) / 60)}h. Skipping scan+analyze.`)
        setState(db, 'last_skip_reason', 'market_closed')
        setState(db, 'last_skip_at', new Date().toISOString())
      } else if (symbols.length === 0) {
        if (marketClosed) {
          log(`Off-hours, no crypto in watchlist — weekend-watch on ${tradPositions.length} position(s)`)
        } else {
          log('No enabled symbols in watchlist')
        }
      } else {
        if (marketClosed && !preOpenWindow) {
          log(`Off-hours — scanning ${symbols.length} crypto symbol(s) only`)
        }

    // Build context memory for this scan
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
    if (armed && scanResult.hot.length > 0) {
      const hotToAnalyze = scanResult.hot.slice(0, 3)
      for (const sym of hotToAnalyze) {
        try {
          const wItem =
            symbols.find(w => w.symbol === sym) || { autoTradeThreshold: 8 }
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

          log(`Analysis complete: ${sym} — ${synth.consensus_bias || '?'} (${synth.overall_conviction || 0}/10)`)

          // Auto-trade — only when armed and synthesis recommends it
          if (armed && synth.auto_trade && synth.entry) {
            const tradeResult = await autoTrade(db, sym, synth, wItem)
            if (tradeResult && process.env.TELEGRAM_BOT_TOKEN) {
              try {
                const { sendMessage } = await import('./services/telegram.js')
                await sendMessage(
                  `🤖 AUTO-TRADE: ${tradeResult.side} ${sym} @ ${tradeResult.executionPrice ?? 'mkt'} | SL ${synth.sl ?? '—'} TP ${synth.tp1 ?? '—'}`
                )
              } catch {}
            }
          }
        } catch (err) {
          log(`Analysis failed for ${sym}:`, err.message)
        }
      }
    }

      } // end symbols.length > 0 (scan+analyze branch)

      // ---------------------------------------------------------------------
      // 3. WEEKEND WATCH — hourly Opus pass on non-crypto open positions
      // when market is closed (and we're not already in pre-open warm-up,
      // which will run the full Analyst instead). Catches weekend catalysts
      // (Fed speak, OPEC, geopolitics) that break thesis before Monday gap.
      // ---------------------------------------------------------------------
      if (marketClosed && !preOpenWindow && tradPositions.length > 0 && loopCount % 12 === 1) {
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

          // Deterministic rule fired — record recommendation and skip the LLM.
          // NOTE: cTrader modify / partial-close wiring lives in a follow-up
          // commit; today we only log + persist the intent so the Workshop
          // shows exactly what the bot *would* do.
          if (eval_.action !== 'HOLD') {
            s.updatePositionCheck.run(
              `PM:${eval_.action}`,
              eval_.reason,
              new Date().toISOString(),
              eval_.action === 'FULL_EXIT' ? 'broken' : 'intact',
              pos.id
            )
            log(`PM ${pos.symbol}: ${eval_.action} — ${eval_.reason}`)
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
    } // end watchlistJson

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

    // Self-healing: back off exponentially up to 15 min after 5 consecutive errors
    if (consecutiveErrors >= 5) {
      const backoff = Math.min(15 * 60_000, LOOP_INTERVAL * consecutiveErrors)
      log(`Self-healing: ${consecutiveErrors} consecutive errors — backing off ${Math.round(backoff / 60000)}m`)
      setTimeout(() => runLoop(db).catch(err => console.error('[loop] unhandled:', err.message)), backoff)
      return
    }
  }

  consecutiveErrors = 0 // reset on any success or non-fatal error path
  const elapsed = Date.now() - start
  const delay = Math.max(10_000, LOOP_INTERVAL - elapsed)
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
