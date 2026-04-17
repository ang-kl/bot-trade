// ---------------------------------------------------------------------------
// agent/loop.js — Main 5-minute scan loop
// ---------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk'
import { runScan } from './services/scanner.js'
import { runAnalysis } from './services/analyzer.js'
import { runMonitorCheck } from './services/monitor-svc.js'
import { sendScanAlert } from './services/telegram.js'
import { detectFlip } from './quant/signals.js'
import { getState, setState } from './db.js'

const LOOP_INTERVAL = 5 * 60 * 1000 // 5 minutes
let loopCount = 0

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
      INSERT INTO analyses (symbol, consensus_bias, overall_conviction, consensus_summary, synthesis, entry_price, sl_price, tp1_price, tp2_price, auto_trade, strategy, risk_note, minion_reports, analyzed_at, scan_id)
      VALUES (@symbol, @consensus_bias, @overall_conviction, @consensus_summary, @synthesis, @entry_price, @sl_price, @tp1_price, @tp2_price, @auto_trade, @strategy, @risk_note, @minion_reports, @analyzed_at, @scan_id)
    `),

    selectActivePositions: db.prepare(
      `SELECT * FROM monitored_positions WHERE status = ?`
    ),

    updatePositionCheck: db.prepare(`
      UPDATE monitored_positions
      SET last_check_action = ?, last_check_reasoning = ?, last_check_at = ?, thesis_status = ?
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

    if (!watchlistJson) {
      log('No watchlist configured')
      return
    }

    const watchlist = JSON.parse(watchlistJson)
    // Support both string[] and object[] watchlists
    const symbols = (Array.isArray(watchlist) ? watchlist : [])
      .map(w => (typeof w === 'string' ? { symbol: w, enabled: true } : w))
      .filter(w => w.enabled !== false)

    if (symbols.length === 0) {
      log('No enabled symbols')
      return
    }

    // Create Anthropic client
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    // Run scan
    const scanResult = await runScan(client, symbols, {
      timezone: 'Asia/Singapore',
      hotThreshold: 6,
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
            analyzed_at: new Date().toISOString(),
            scan_id: scanId,
          })

          log(`Analysis complete: ${sym} — ${synth.consensus_bias || '?'} (${synth.overall_conviction || 0}/10)`)

          // TODO: auto-trade if synthesis.auto_trade === true
        } catch (err) {
          log(`Analysis failed for ${sym}:`, err.message)
        }
      }
    }

    // -----------------------------------------------------------------------
    // 3. MONITOR PHASE — check open positions
    // -----------------------------------------------------------------------
    const activePositions = s.selectActivePositions.all('active')
    for (const pos of activePositions) {
      try {
        const check = await runMonitorCheck(client, {
          symbol: pos.symbol,
          side: pos.side,
          entry: pos.entry_price,
          sl: pos.current_sl,
          tp1: pos.current_tp,
          thesis: pos.thesis,
        })

        s.updatePositionCheck.run(
          check.action,
          check.reasoning,
          new Date().toISOString(),
          check.thesis_status,
          pos.id
        )

        // If EXIT, close the position
        if (check.action === 'EXIT') {
          s.closePosition.run('closed', pos.id)
          log(`Position closed: ${pos.symbol} — ${check.reasoning}`)
          // TODO: Send telegram alert for position exit
        }
      } catch (err) {
        log(`Monitor check failed for ${pos.symbol}:`, err.message)
      }
    }

    // -----------------------------------------------------------------------
    // 4. QUANT PHASE — every 6th loop (~30 min)
    // -----------------------------------------------------------------------
    if (loopCount % 6 === 0) {
      // TODO: Fetch bars and update regimes for active symbols
      // TODO: Compute portfolio performance snapshot
      log('Quant phase (stub) — regime update + performance snapshot')
    }

    // -----------------------------------------------------------------------
    // 5. HOUSEKEEP
    // -----------------------------------------------------------------------
    setState(db, 'loop_count', String(loopCount))
    setState(db, 'last_loop_ms', String(Date.now() - start))
  } catch (err) {
    console.error('[loop] error:', err.message)
    const errCount = parseInt(getState(db, 'errors_today') || '0') + 1
    setState(db, 'errors_today', String(errCount))
  }

  const elapsed = Date.now() - start
  const delay = Math.max(10_000, LOOP_INTERVAL - elapsed) // minimum 10s between loops
  log(`Loop #${loopCount} done in ${elapsed}ms — next in ${Math.round(delay / 1000)}s`)
  setTimeout(() => runLoop(db), delay)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function startLoop(db) {
  log('Agent loop starting...')
  setTimeout(() => runLoop(db), 5000) // 5s delay on startup
  return { getLoopCount: () => loopCount }
}
