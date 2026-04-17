// ---------------------------------------------------------------------------
// agent/routes/actions.js — POST endpoints for manual triggers
// ---------------------------------------------------------------------------

import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { getState, setState } from '../db.js'
import { runScan } from '../services/scanner.js'
import { runAnalysis } from '../services/analyzer.js'

/**
 * Factory — returns a configured Express Router.
 * The caller (index.js) passes the better-sqlite3 `db` instance.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {import('express').Router}
 */
export default function actionsRouter(db) {
  const router = Router()

  // Lazy-init Anthropic client (created on first use)
  let _client = null
  function getClient() {
    if (!_client) {
      _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    }
    return _client
  }

  // -----------------------------------------------------------------------
  // POST /actions/scan — trigger immediate scan
  // -----------------------------------------------------------------------
  router.post('/scan', async (req, res) => {
    try {
      const watchlistJson = getState(db, 'watchlist_json')
      if (!watchlistJson) {
        return res.status(400).json({ error: 'No watchlist configured' })
      }

      let watchlist
      try { watchlist = JSON.parse(watchlistJson) } catch {
        return res.status(500).json({ error: 'Watchlist data corrupted' })
      }
      const symbols = (Array.isArray(watchlist) ? watchlist : [])
        .map(w => (typeof w === 'string' ? { symbol: w, enabled: true } : w))
        .filter(w => w.enabled !== false)

      if (symbols.length === 0) {
        return res.status(400).json({ error: 'No enabled symbols in watchlist' })
      }

      const client = getClient()
      const scanResult = await runScan(client, symbols, {
        timezone: typeof req.body?.timezone === 'string' ? req.body.timezone : 'Asia/Singapore',
        hotThreshold: Number(req.body?.hotThreshold) || 6,
      })

      // Persist latest results to state
      setState(db, 'last_scan_at', new Date().toISOString())
      setState(db, 'last_scan_results', JSON.stringify(scanResult))

      // Persist individual scan rows
      const now = new Date().toISOString()
      const insertScan = db.prepare(`
        INSERT INTO scans (symbol, bias, confidence, thesis, timeframe, session_fit, trade_at, price, trade_grade, desk_note, scanned_at, loop_id)
        VALUES (@symbol, @bias, @confidence, @thesis, @timeframe, @session_fit, @trade_at, @price, @trade_grade, @desk_note, @scanned_at, @loop_id)
      `)

      for (const scan of scanResult.scans) {
        insertScan.run({
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
          loop_id: 0, // manual trigger
        })
      }

      res.json({ ok: true, result: scanResult })
    } catch (err) {
      console.error('[actions/scan] error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/analyze — deep analysis on a single symbol
  // -----------------------------------------------------------------------
  router.post('/analyze', async (req, res) => {
    try {
      const symbol = (req.body?.symbol || '').toUpperCase().trim()
      if (!symbol) {
        return res.status(400).json({ error: 'Missing required field: symbol' })
      }

      const client = getClient()
      const result = await runAnalysis(client, symbol, {
        autoTradeThreshold: req.body?.autoTradeThreshold || 8,
      })

      // Find latest scan for this symbol to link
      const latestScan = db
        .prepare('SELECT id FROM scans WHERE symbol = ? ORDER BY scanned_at DESC LIMIT 1')
        .get(symbol)
      const scanId = latestScan ? latestScan.id : null

      // Persist analysis
      const synth = result.synthesis || {}
      db.prepare(`
        INSERT INTO analyses (symbol, consensus_bias, overall_conviction, consensus_summary, synthesis, entry_price, sl_price, tp1_price, tp2_price, auto_trade, strategy, risk_note, minion_reports, analyzed_at, scan_id)
        VALUES (@symbol, @consensus_bias, @overall_conviction, @consensus_summary, @synthesis, @entry_price, @sl_price, @tp1_price, @tp2_price, @auto_trade, @strategy, @risk_note, @minion_reports, @analyzed_at, @scan_id)
      `).run({
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

      res.json({ ok: true, result })
    } catch (err) {
      console.error('[actions/analyze] error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/arm — enable auto-trading
  // -----------------------------------------------------------------------
  router.post('/arm', (_req, res) => {
    setState(db, 'armed', 'true')
    console.log('[actions] Armed — auto-analysis enabled')
    res.json({ ok: true, armed: true })
  })

  // -----------------------------------------------------------------------
  // POST /actions/disarm — disable auto-trading
  // -----------------------------------------------------------------------
  router.post('/disarm', (_req, res) => {
    setState(db, 'armed', 'false')
    console.log('[actions] Disarmed — auto-analysis disabled')
    res.json({ ok: true, armed: false })
  })

  // -----------------------------------------------------------------------
  // POST /actions/watchlist — update watchlist
  // -----------------------------------------------------------------------
  router.post('/watchlist', (req, res) => {
    try {
      const { symbols } = req.body || {}
      if (!symbols || !Array.isArray(symbols)) {
        return res
          .status(400)
          .json({ error: 'Missing required field: symbols (array)' })
      }

      // Accept both string[] and object[] formats
      const normalized = symbols.map(s => {
        if (typeof s === 'string') {
          return { symbol: s.toUpperCase().trim(), enabled: true }
        }
        return {
          ...s,
          symbol: (s.symbol || '').toUpperCase().trim(),
          enabled: s.enabled !== false,
        }
      })

      setState(db, 'watchlist_json', JSON.stringify(normalized))
      console.log(
        '[actions] Watchlist updated:',
        normalized.map(w => w.symbol).join(', ')
      )

      res.json({ ok: true, watchlist: normalized })
    } catch (err) {
      console.error('[actions/watchlist] error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
