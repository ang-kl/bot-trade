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
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      loopCount: Number(getState(db, 'loop_count') || 0),
      lastScanAt: getState(db, 'last_scan_at'),
      errorsToday: Number(getState(db, 'errors_today') || 0),
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
    const watchlistJson = getState(db, 'watchlist_json')
    res.json({
      armed: getState(db, 'armed') === 'true',
      watchlist: watchlistJson ? (() => { try { return JSON.parse(watchlistJson) } catch { return [] } })() : [],
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

  return router
}
