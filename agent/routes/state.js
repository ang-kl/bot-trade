// ---------------------------------------------------------------------------
// agent/routes/state.js — GET endpoints for frontend dashboard
// ---------------------------------------------------------------------------

import { Router } from 'express'
import { getState } from '../db.js'
import { loadRiskConfig, DEFAULT_RISK_CONFIG, getAccountBalance, getAccountLeverage } from '../services/risk.js'
import { tierForBalance } from '../lib/contracts.js'

/**
 * Factory — returns a configured Express Router.
 * The caller (index.js) passes the better-sqlite3 `db` instance.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {import('express').Router}
 */
export default function stateRouter(db) {
  const router = Router()

  // -----------------------------------------------------------------------
  // GET /state/health
  // -----------------------------------------------------------------------
  router.get('/health', (_req, res) => {
    const symbolsJson = getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json') || '[]'
    let symbols = []
    try { symbols = JSON.parse(symbolsJson) } catch {}
    symbols = (Array.isArray(symbols) ? symbols : []).map(s => typeof s === 'string' ? { symbol: s, enabled: true } : s)
    const enabledCount = symbols.filter(s => s.enabled !== false).length
    const skippedCount = symbols.filter(s => s.force_skip).length

    const lastLoopMs = getState(db, 'last_loop_ms')
    const lastError = getState(db, 'last_error')
    const circuitBreaker = getState(db, 'circuit_breaker_tripped_at')
    const memUsage = process.memoryUsage()

    const apiHealth = {}
    try {
      apiHealth.polygon = {
        lastCall: getState(db, 'api_polygon_last_ok'),
        lastError: getState(db, 'api_polygon_last_error'),
        status: getState(db, 'api_polygon_last_ok') ? 'ok' : 'unknown',
      }
      apiHealth.anthropic = {
        lastCall: getState(db, 'api_anthropic_last_ok'),
        lastError: getState(db, 'api_anthropic_last_error'),
        status: getState(db, 'api_anthropic_last_ok') ? 'ok' : 'unknown',
      }
      apiHealth.ctrader = {
        lastCall: getState(db, 'api_ctrader_last_ok'),
        lastError: getState(db, 'api_ctrader_last_error'),
        status: getState(db, 'api_ctrader_last_ok') ? 'ok' : 'unknown',
      }
    } catch {}

    res.json({
      status: circuitBreaker ? 'breaker_tripped' : 'ok',
      uptime: process.uptime(),
      loopCount: Number(getState(db, 'loop_count') || 0),
      loopPhase: getState(db, 'loop_phase') || 'idle',
      loopStartedAt: getState(db, 'loop_started_at') || null,
      lastScanAt: getState(db, 'last_scan_at'),
      lastLoopMs: lastLoopMs ? Number(lastLoopMs) : null,
      errorsToday: Number(getState(db, 'errors_today') || 0),
      dailyTokensUsed: Number(getState(db, 'daily_tokens_used') || 0),
      dailyTokenBudget: 500000,
      lastError: lastError || null,
      circuitBreaker: circuitBreaker || null,
      memoryMB: Math.round(memUsage.rss / 1048576),
      dbSizeMB: (() => { try { const { size } = require('fs').statSync(db.name); return Math.round(size / 1048576 * 10) / 10 } catch { return null } })(),
      openTrades: (() => { try { return db.prepare("SELECT COUNT(*) as c FROM monitored_positions WHERE status = 'active'").get()?.c || 0 } catch { return 0 } })(),
      symbols: {
        total: symbols.length,
        enabled: enabledCount,
        skipped: skippedCount,
      },
      apis: apiHealth,
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/scans — latest scan results + recent DB rows
  // -----------------------------------------------------------------------
  router.get('/scans', (_req, res) => {
    const lastResults = getState(db, 'last_scan_results')
    const recentScans = db
      .prepare('SELECT * FROM scans ORDER BY scanned_at DESC LIMIT 50')
      .all()

    res.json({
      lastScanAt: getState(db, 'last_scan_at'),
      lastResults: lastResults ? (() => { try { return JSON.parse(lastResults) } catch { return null } })() : null,
      recentScans,
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/scans/:symbol — scan history for one symbol (last 50)
  // -----------------------------------------------------------------------
  router.get('/scans/:symbol', (req, res) => {
    const symbol = req.params.symbol.toUpperCase()
    const rows = db
      .prepare(
        'SELECT * FROM scans WHERE symbol = ? ORDER BY scanned_at DESC LIMIT 50'
      )
      .all(symbol)

    res.json({ symbol, scans: rows })
  })

  // -----------------------------------------------------------------------
  // GET /state/signals — latest signal per symbol
  // -----------------------------------------------------------------------
  router.get('/signals', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT s.*
         FROM signals s
         INNER JOIN (
           SELECT symbol, MAX(recorded_at) AS max_at
           FROM signals
           GROUP BY symbol
         ) latest ON s.symbol = latest.symbol AND s.recorded_at = latest.max_at
         ORDER BY s.recorded_at DESC`
      )
      .all()

    res.json({ signals: rows })
  })

  // -----------------------------------------------------------------------
  // GET /state/signals/flips — recent flips (last 100)
  // -----------------------------------------------------------------------
  router.get('/signals/flips', (_req, res) => {
    const rows = db
      .prepare(
        'SELECT * FROM signals WHERE flipped = 1 ORDER BY recorded_at DESC LIMIT 100'
      )
      .all()

    res.json({ flips: rows })
  })

  // -----------------------------------------------------------------------
  // GET /state/regime — latest regime per symbol
  // -----------------------------------------------------------------------
  router.get('/regime', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT r.*
         FROM regimes r
         INNER JOIN (
           SELECT symbol, MAX(computed_at) AS max_at
           FROM regimes
           GROUP BY symbol
         ) latest ON r.symbol = latest.symbol AND r.computed_at = latest.max_at
         ORDER BY r.symbol`
      )
      .all()

    res.json({ regimes: rows })
  })

  // -----------------------------------------------------------------------
  // GET /state/positions — active monitored positions
  // -----------------------------------------------------------------------
  router.get('/positions', (_req, res) => {
    const rows = db
      .prepare(
        "SELECT * FROM monitored_positions WHERE status = 'active' ORDER BY created_at DESC"
      )
      .all()

    res.json({ positions: rows })
  })

  // -----------------------------------------------------------------------
  // GET /state/metrics — latest performance snapshot
  // -----------------------------------------------------------------------
  router.get('/metrics', (_req, res) => {
    const row = db
      .prepare(
        'SELECT * FROM performance_snapshots ORDER BY computed_at DESC LIMIT 1'
      )
      .get()

    res.json({ metrics: row || null })
  })

  // -----------------------------------------------------------------------
  // GET /state/trades — trade journal (last 100 closed)
  // -----------------------------------------------------------------------
  router.get('/trades', (_req, res) => {
    const rows = db
      .prepare(
        "SELECT * FROM trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 100"
      )
      .all()

    res.json({ trades: rows })
  })

  // -----------------------------------------------------------------------
  // GET /state/activity — unified live event stream for the Trade Window
  // Merges scans, analyses, monitor checks, trades, regime snapshots, flips
  // into one time-sorted feed. Cheap: single UNION ALL, LIMIT-capped.
  // -----------------------------------------------------------------------
  router.get('/activity', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    const rows = db.prepare(`
      SELECT * FROM (
        SELECT 'scan'     AS kind, id, symbol, scanned_at  AS at,
               bias       AS v1,  confidence AS v2,  thesis AS note,
               trade_grade AS extra, NULL AS ref
        FROM scans
        UNION ALL
        SELECT 'analysis' AS kind, id, symbol, analyzed_at AS at,
               consensus_bias AS v1, overall_conviction AS v2, consensus_summary AS note,
               strategy AS extra, scan_id AS ref
        FROM analyses
        UNION ALL
        SELECT 'monitor'  AS kind, id, symbol, last_check_at AS at,
               last_check_action AS v1, NULL AS v2, last_check_reasoning AS note,
               thesis_status AS extra, trade_id AS ref
        FROM monitored_positions
        WHERE last_check_at IS NOT NULL
        UNION ALL
        SELECT 'trade'    AS kind, id, symbol, COALESCE(closed_at, opened_at) AS at,
               side AS v1, conviction AS v2, thesis AS note,
               status AS extra, analysis_id AS ref
        FROM trades
        UNION ALL
        SELECT 'regime'   AS kind, id, symbol, computed_at AS at,
               regime AS v1, atr_pct AS v2, trend_direction AS note,
               NULL AS extra, NULL AS ref
        FROM regimes
        UNION ALL
        SELECT 'flip'     AS kind, id, symbol, recorded_at AS at,
               bias AS v1, confidence AS v2, flip_from AS note,
               source AS extra, NULL AS ref
        FROM signals
        WHERE flipped = 1
        UNION ALL
        SELECT 'risk'     AS kind, id, symbol, created_at AS at,
               side AS v1, approved AS v2, veto_reason AS note,
               checks_json AS extra, NULL AS ref
        FROM risk_events
      )
      WHERE at IS NOT NULL
      ORDER BY at DESC
      LIMIT ?
    `).all(limit)

    res.json({ activity: rows })
  })

  // -----------------------------------------------------------------------
  // GET /state/analysis/:id — full analysis with parsed minion_reports
  // -----------------------------------------------------------------------
  router.get('/analysis/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM analyses WHERE id = ?').get(req.params.id)
    if (!row) return res.status(404).json({ error: 'analysis not found' })

    let reports = []
    try { reports = JSON.parse(row.minion_reports || '[]') } catch {}
    let synthesis = null
    try { synthesis = JSON.parse(row.synthesis || 'null') } catch {}

    res.json({
      analysis: {
        ...row,
        minion_reports: reports,
        synthesis_parsed: synthesis,
      },
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/position/:id — one monitored position + recent check history
  // -----------------------------------------------------------------------
  router.get('/position/:id', (req, res) => {
    const pos = db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(req.params.id)
    if (!pos) return res.status(404).json({ error: 'position not found' })

    // Monitor checks are stored only as last_check_* fields — return linked trade + last 20 scans of symbol for context
    const recentScans = db.prepare(
      'SELECT id, bias, confidence, thesis, trade_grade, scanned_at FROM scans WHERE symbol = ? ORDER BY scanned_at DESC LIMIT 20'
    ).all(pos.symbol)

    const trade = pos.trade_id
      ? db.prepare('SELECT * FROM trades WHERE id = ?').get(pos.trade_id)
      : null

    res.json({ position: pos, trade, recentScans })
  })

  // -----------------------------------------------------------------------
  // GET /state/config — current watchlist + armed status
  // -----------------------------------------------------------------------
  router.get('/config', (_req, res) => {
    const symbolsJson = getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json')
    res.json({
      scan_enabled: getState(db, 'scan_enabled') !== 'false',
      analyze_enabled: getState(db, 'analyze_enabled') !== 'false',
      autotrade_enabled: getState(db, 'autotrade_enabled') === 'true',
      // Backward compat: armed = autotrade_enabled
      armed: getState(db, 'autotrade_enabled') === 'true',
      symbols: symbolsJson ? (() => { try { return JSON.parse(symbolsJson) } catch { return [] } })() : [],
      watchlist: symbolsJson ? (() => { try { return JSON.parse(symbolsJson) } catch { return [] } })() : [],
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/risk-events — recent Risk Manager decisions (audit trail)
  // Query param `limit` (default 100), `symbol` optional filter
  // -----------------------------------------------------------------------
  router.get('/risk-events', (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10)))
    const rows = req.query.symbol
      ? db.prepare(
          `SELECT * FROM risk_events WHERE symbol = ? ORDER BY created_at DESC LIMIT ?`
        ).all(String(req.query.symbol).toUpperCase(), limit)
      : db.prepare(
          `SELECT * FROM risk_events ORDER BY created_at DESC LIMIT ?`
        ).all(limit)
    res.json({ rows })
  })

  // -----------------------------------------------------------------------
  // GET /state/risk-config — effective risk config (defaults merged with overrides)
  // -----------------------------------------------------------------------
  router.get('/risk-config', (_req, res) => {
    const effective = loadRiskConfig(db)
    const balance = getAccountBalance(db)
    const leverage = getAccountLeverage(db, effective)
    const tier = balance != null ? tierForBalance(balance) : null
    const derived = balance != null
      ? {
          balance,
          leverage,
          tier,
          daily_cap_usd: Number((balance * effective.dailyLossPct).toFixed(2)),
          per_trade_budget_usd: Number((balance * effective.perTradeRiskPct).toFixed(2)),
          margin_cap_usd: Number((balance * effective.maxMarginUsagePct).toFixed(2)),
          mode: 'equity_aware',
        }
      : {
          balance: null,
          leverage,
          tier: null,
          daily_cap_usd: effective.dailyLossLimit,
          per_trade_budget_usd: null,
          margin_cap_usd: null,
          mode: 'absolute_fallback',
        }
    res.json({
      defaults: DEFAULT_RISK_CONFIG,
      effective,
      derived,
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/attribution — read-only performance attribution by label dimension
  // Query params:
  //   groupBy: one of 'source'|'strategy'|'conviction'|'regime'|'session'|
  //            'timeframe'|'source_strategy'|'strategy_regime' (default: 'strategy')
  //   days:    restrict to last N days of closed trades (default 90)
  // -----------------------------------------------------------------------
  router.get('/attribution', (req, res) => {
    const allowed = {
      source:           ['source'],
      strategy:         ['label_strategy'],
      conviction:       ['label_conviction'],
      regime:           ['label_regime'],
      session:          ['label_session'],
      timeframe:        ['label_timeframe'],
      source_strategy:  ['source', 'label_strategy'],
      strategy_regime:  ['label_strategy', 'label_regime'],
    }
    const groupBy = String(req.query.groupBy || 'strategy')
    const cols = allowed[groupBy]
    if (!cols) {
      return res.status(400).json({
        error: `groupBy must be one of: ${Object.keys(allowed).join(', ')}`,
      })
    }
    const days = Math.max(1, Math.min(365, parseInt(req.query.days || '90', 10)))
    const sinceISO = new Date(Date.now() - days * 86400_000).toISOString()

    const groupExpr = cols.join(', ')
    const rows = db.prepare(`
      SELECT
        ${groupExpr},
        COUNT(*)                              AS trades,
        SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN net_pnl < 0 THEN 1 ELSE 0 END) AS losses,
        ROUND(AVG(net_pnl), 2)                AS avg_pnl,
        ROUND(SUM(net_pnl), 2)                AS total_pnl,
        ROUND(AVG(CASE WHEN net_pnl > 0 THEN net_pnl END), 2) AS avg_win,
        ROUND(AVG(CASE WHEN net_pnl < 0 THEN net_pnl END), 2) AS avg_loss,
        ROUND(
          SUM(CASE WHEN net_pnl > 0 THEN net_pnl ELSE 0 END) /
          NULLIF(-SUM(CASE WHEN net_pnl < 0 THEN net_pnl ELSE 0 END), 0),
          2
        ) AS profit_factor
      FROM trades
      WHERE status = 'closed'
        AND closed_at >= ?
      GROUP BY ${groupExpr}
      ORDER BY total_pnl DESC NULLS LAST
    `).all(sinceISO)

    // Enrich each row with win_rate for convenience.
    for (const r of rows) {
      const t = r.trades || 0
      r.win_rate = t > 0 ? Number((r.wins / t).toFixed(3)) : null
    }

    res.json({ groupBy, days, since: sinceISO, rows })
  })

  // -----------------------------------------------------------------------
  // GET /state/risk-exposure — latest risk exposure snapshot
  // -----------------------------------------------------------------------
  router.get('/risk-exposure', (_req, res) => {
    try {
      const row = db.prepare(
        'SELECT * FROM risk_exposure ORDER BY snapshot_at DESC LIMIT 1'
      ).get()
      res.json({ exposure: row || null })
    } catch {
      res.json({ exposure: null })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/metrics/history?days=30 — performance snapshots for charting
  // -----------------------------------------------------------------------
  router.get('/metrics/history', (req, res) => {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days || '30', 10)))
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    try {
      const rows = db.prepare(
        'SELECT * FROM performance_snapshots WHERE computed_at >= ? ORDER BY computed_at ASC'
      ).all(since)
      res.json({ snapshots: rows })
    } catch {
      res.json({ snapshots: [] })
    }
  })

  router.get('/analyses/latest', (_req, res) => {
    try {
      const rows = db.prepare(`
        SELECT a.*, s.bias AS scan_bias, s.confidence AS scan_confidence
        FROM analyses a
        LEFT JOIN scans s ON s.id = a.scan_id
        WHERE a.analyzed_at > datetime('now', '-24 hours')
        ORDER BY a.analyzed_at DESC
      `).all()
      res.json({ analyses: rows })
    } catch (e) {
      res.json({ analyses: [], error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/symbol-map — symbol → cTrader symbolId map (edited on the
  // UI's Connect tab)
  // -----------------------------------------------------------------------
  router.get('/symbol-map', (_req, res) => {
    try {
      const json = getState(db, 'symbol_id_map')
      res.json({ map: json ? JSON.parse(json) : {} })
    } catch (e) {
      res.json({ map: {}, error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/autotrade-timeframes — timeframes eligible for auto_trade
  // (mirrors the default in loop.js's timeframe gate)
  // -----------------------------------------------------------------------
  router.get('/autotrade-timeframes', (_req, res) => {
    let timeframes = ['4h', '1d']
    const json = getState(db, 'autotrade_timeframes')
    if (json) {
      try {
        const parsed = JSON.parse(json)
        if (Array.isArray(parsed) && parsed.length > 0) timeframes = parsed
      } catch { /* keep default */ }
    }
    res.json({ timeframes })
  })

  // -----------------------------------------------------------------------
  // GET /state/fib-rsi-filter — whether the RSI confluence gate is on
  // -----------------------------------------------------------------------
  router.get('/fib-rsi-filter', (_req, res) => {
    res.json({ on: getState(db, 'fib_rsi_filter') === 'true' })
  })

  router.get('/prices', (_req, res) => {
    try {
      const rows = db.prepare(`
        SELECT symbol, price, bias, confidence, scanned_at
        FROM scans
        WHERE id IN (SELECT MAX(id) FROM scans WHERE price IS NOT NULL GROUP BY symbol)
        ORDER BY symbol
      `).all()
      const prices = {}
      for (const r of rows) {
        prices[r.symbol] = { price: r.price, bias: r.bias, confidence: r.confidence, at: r.scanned_at }
      }
      res.json({ prices })
    } catch (e) {
      res.json({ prices: {}, error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/broker-orders — external positions + pending orders from last reconciliation
  // -----------------------------------------------------------------------
  router.get('/broker-orders', (_req, res) => {
    try {
      const pendingJson = getState(db, 'broker_pending_orders_json')
      const lastReconcileAt = getState(db, 'last_reconcile_at')
      const externalPositions = db.prepare(
        `SELECT mp.*, t.ctrader_position_id
         FROM monitored_positions mp
         LEFT JOIN trades t ON t.id = mp.trade_id
         WHERE mp.status = 'active' AND mp.source = 'external'
         ORDER BY mp.created_at DESC`
      ).all()
      let pendingOrders = []
      try { pendingOrders = JSON.parse(pendingJson || '[]') } catch {}
      res.json({ externalPositions, pendingOrders, lastReconcileAt })
    } catch (e) {
      res.json({ externalPositions: [], pendingOrders: [], lastReconcileAt: null, error: e.message })
    }
  })

  return router
}
