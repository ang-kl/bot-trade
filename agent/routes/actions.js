// ---------------------------------------------------------------------------
// agent/routes/actions.js — POST endpoints for manual triggers
// ---------------------------------------------------------------------------

import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { getState, setState } from '../db.js'
import { runScan } from '../services/scanner.js'
import { runAnalysis } from '../services/analyzer.js'
import { DEFAULT_RISK_CONFIG, loadRiskConfig } from '../services/risk.js'

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
        INSERT INTO analyses (symbol, consensus_bias, overall_conviction, consensus_summary, synthesis, entry_price, sl_price, tp1_price, tp2_price, auto_trade, strategy, risk_note, minion_reports, invalidation_trigger, time_cap_minutes, analyzed_at, scan_id)
        VALUES (@symbol, @consensus_bias, @overall_conviction, @consensus_summary, @synthesis, @entry_price, @sl_price, @tp1_price, @tp2_price, @auto_trade, @strategy, @risk_note, @minion_reports, @invalidation_trigger, @time_cap_minutes, @analyzed_at, @scan_id)
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
        invalidation_trigger: synth.invalidation_trigger || null,
        time_cap_minutes: synth.time_cap_minutes ?? null,
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
  // POST /actions/autopilot — toggle autopilot (alias for arm/disarm)
  // Body: { on: boolean }. If omitted, returns current state.
  // -----------------------------------------------------------------------
  router.post('/autopilot', (req, res) => {
    const next = req.body?.on
    if (typeof next === 'boolean') {
      setState(db, 'armed', next ? 'true' : 'false')
      console.log(`[actions] Autopilot ${next ? 'ON' : 'OFF'}`)
    }
    res.json({ ok: true, on: getState(db, 'armed') === 'true' })
  })

  // -----------------------------------------------------------------------
  // POST /actions/pause-position/:id — pause Monitor checks for one position
  // -----------------------------------------------------------------------
  router.post('/pause-position/:id', (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'invalid id' })
    const result = db.prepare('UPDATE monitored_positions SET paused = 1 WHERE id = ?').run(id)
    res.json({ ok: true, changes: result.changes })
  })

  // -----------------------------------------------------------------------
  // POST /actions/unpause-position/:id — resume Monitor checks
  // -----------------------------------------------------------------------
  router.post('/unpause-position/:id', (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'invalid id' })
    const result = db.prepare('UPDATE monitored_positions SET paused = 0 WHERE id = ?').run(id)
    res.json({ ok: true, changes: result.changes })
  })

  // -----------------------------------------------------------------------
  // POST /actions/kill-all — emergency: disarm autopilot + pause every position
  // Does NOT close cTrader positions — that's user-side via the cTrader UI
  // or via Feed close flow. This just stops the bot from acting further.
  // -----------------------------------------------------------------------
  router.post('/kill-all', (_req, res) => {
    setState(db, 'armed', 'false')
    const r = db.prepare("UPDATE monitored_positions SET paused = 1 WHERE status = 'active'").run()
    console.log(`[actions] KILL-ALL — autopilot off, ${r.changes} positions paused`)
    res.json({ ok: true, paused: r.changes })
  })

  // -----------------------------------------------------------------------
  // POST /actions/ctrader-config — push cTrader credentials + account roles
  // Body: { accessToken, accounts: [{ accountId, isLive, autopilot, copilot }] }
  // The loop reads autopilot-enabled accounts and trades each one.
  // -----------------------------------------------------------------------
  router.post('/ctrader-config', (req, res) => {
    try {
      const { accessToken, accounts } = req.body || {}
      if (!accessToken) {
        return res.status(400).json({ error: 'accessToken is required' })
      }
      setState(db, 'ctrader_access_token', accessToken)

      if (Array.isArray(accounts)) {
        setState(db, 'ctrader_account_roles_json', JSON.stringify(accounts))
        const ap = accounts.filter(a => a.autopilot)
        const cp = accounts.filter(a => a.copilot)
        console.log(`[actions] cTrader config updated — ${ap.length} autopilot, ${cp.length} copilot accounts`)

        // Backward compat: keep legacy single-account keys in sync with
        // the first autopilot account so old code paths don't break.
        if (ap.length > 0) {
          setState(db, 'ctrader_account_id', String(ap[0].accountId))
          setState(db, 'ctrader_is_live', ap[0].isLive ? 'true' : 'false')
        }
      }

      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
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

  // -----------------------------------------------------------------------
  // POST /actions/risk-config — update Risk Manager limits
  // Body: partial risk config, merged over current. Unknown keys are dropped
  // to prevent pollution. Pass empty {} to reset to defaults.
  // -----------------------------------------------------------------------
  router.post('/risk-config', (req, res) => {
    try {
      const body = req.body || {}
      if (body.reset === true) {
        setState(db, 'risk_config_json', null)
        return res.json({ ok: true, effective: DEFAULT_RISK_CONFIG })
      }
      const current = loadRiskConfig(db)
      const allowed = Object.keys(DEFAULT_RISK_CONFIG)
      const next = { ...current }
      for (const k of allowed) {
        if (k in body) next[k] = body[k]
      }
      setState(db, 'risk_config_json', JSON.stringify(next))
      console.log('[actions] Risk config updated:', next)
      res.json({ ok: true, effective: next })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/balance — set account balance (USD) and optionally leverage.
  // Body: { balance?: number, leverage?: number } or { clear: true }.
  // Leverage is e.g. 200 for 1:200, 1000 for 1:1000.
  // -----------------------------------------------------------------------
  router.post('/balance', (req, res) => {
    try {
      const body = req.body || {}
      if (body.clear === true) {
        setState(db, 'account_balance_usd', null)
        setState(db, 'account_leverage', null)
        console.log('[actions] account balance + leverage cleared')
        return res.json({ ok: true, balance: null, leverage: null })
      }
      const updates = {}
      if (body.balance !== undefined) {
        const n = Number(body.balance)
        if (!Number.isFinite(n) || n <= 0) {
          return res.status(400).json({ error: 'balance must be a positive number' })
        }
        setState(db, 'account_balance_usd', String(n))
        updates.balance = n
      }
      if (body.leverage !== undefined) {
        const n = Number(body.leverage)
        if (!Number.isFinite(n) || n <= 0) {
          return res.status(400).json({ error: 'leverage must be a positive number (e.g. 200)' })
        }
        setState(db, 'account_leverage', String(n))
        updates.leverage = n
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'nothing to update — provide balance or leverage' })
      }
      console.log('[actions] balance/leverage updated:', updates)
      res.json({ ok: true, ...updates })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/symbol-map — store symbolName → cTrader symbolId mapping
  // Required for auto-trade. Frontend fetches symbol list from cTrader and
  // pushes { map: { EURUSD: 1, XAUUSD: 42, ... } }
  // -----------------------------------------------------------------------
  router.post('/symbol-map', (req, res) => {
    try {
      const { map } = req.body || {}
      if (!map || typeof map !== 'object') {
        return res.status(400).json({ error: 'map (object) is required' })
      }
      const upper = {}
      for (const [k, v] of Object.entries(map)) {
        upper[k.toUpperCase()] = v
      }
      setState(db, 'symbol_id_map', JSON.stringify(upper))
      console.log('[actions] symbol-map updated:', Object.keys(upper).length, 'symbols')
      res.json({ ok: true, count: Object.keys(upper).length })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
