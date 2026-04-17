// ---------------------------------------------------------------------------
// agent/routes/state.js — GET endpoints for frontend dashboard
// ---------------------------------------------------------------------------

import { Router } from 'express'
import { getState } from '../db.js'

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
      lastResults: lastResults ? JSON.parse(lastResults) : null,
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
  // GET /state/config — current watchlist + armed status
  // -----------------------------------------------------------------------
  router.get('/config', (_req, res) => {
    const watchlistJson = getState(db, 'watchlist_json')
    res.json({
      armed: getState(db, 'armed') === 'true',
      watchlist: watchlistJson ? JSON.parse(watchlistJson) : [],
    })
  })

  return router
}
