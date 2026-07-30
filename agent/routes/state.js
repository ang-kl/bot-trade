// ---------------------------------------------------------------------------
// agent/routes/state.js — GET endpoints for frontend dashboard
// ---------------------------------------------------------------------------

import { Router } from 'express'
import { createHash } from 'node:crypto'
import { getState } from '../db.js'
import { loadRiskConfig, DEFAULT_RISK_CONFIG, getAccountBalance, getAccountLeverage } from '../services/risk.js'
import { tierForBalance } from '../lib/contracts.js'
import { describeLabel } from '../lib/trade-labels.js'
import { STRATEGY_REGISTRY, enabledStrategies } from '../services/strategies.js'
import { stateEpoch } from '../lib/state-cache.js'
import { requestedAccount, accountWhere, countUnattributed } from '../lib/account-scope.js'
import { timeframePerformance } from '../services/timeframe-performance.js'
import { sizingPreview } from '../services/sizing-preview.js'
import { loadProfitKeeperConfig } from '../services/profit-keeper.js'
import { loadPerformanceBreakerConfig } from '../services/performance-breaker.js'
import { loadSessionOpenGuardConfig } from '../services/session-open-guard.js'
import { loadRegimeGateConfig } from '../services/regime-gate.js'
import { loadCorrelationMatrixConfig } from '../services/correlation-matrix.js'
import { assetControllersView } from '../services/asset-controllers.js'
import { stageMatrixView } from '../services/stage-matrix.js'
import { currentJob, getJob, jobMeta } from '../services/backtest-job.js'
import { postmortemStats, pendingLessons } from '../services/loss-postmortem.js'
import { readRecentErrors } from '../services/error-log.js'

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
  // Server-side response cache (owner 2026-07-28: "some information already
  // cache or store in the backend, do you need to recompute and send"). The
  // expensive /state/* aggregations (perf-ledger, risk-full, trades slices)
  // were recomputed FROM SCRATCH for every poll from every open tab — six
  // tabs polling every 5-20s meant the same ledger rebuilt dozens of times a
  // minute on the same box that runs the trading loop. One compute now
  // serves everyone for STATE_CACHE_MS (default 10s — inside every page's
  // poll cadence, so data is never staler than one poll), and an ETag lets
  // the browser skip re-downloading an unchanged payload entirely.
  // client-ping is excluded: each ping must register (it IS a write in
  // read-clothing), and the roster must stay per-second live.
  // -----------------------------------------------------------------------
  const respCache = new Map() // originalUrl → { body, etag, at }
  const STATE_CACHE_MS = Math.max(1000, Number(process.env.STATE_CACHE_MS || 10_000))
  const NO_CACHE = new Set(['/client-ping', '/backtest-report'])
  // Single-flight (incident 2026-07-28 ~03:10 UTC): after a redeploy every
  // open tab cold-missed the cache at once, and each miss ran its OWN full
  // synchronous aggregation (perf-ledger etc.) on the event loop — reads
  // stacked until even 401 rejections took 30s+ and the site read as dead.
  // Now the FIRST miss for a URL computes; every concurrent request for the
  // same URL parks and is answered from that one result the moment it lands.
  const inflight = new Map() // originalUrl → [{ req, res }] parked waiters
  // `flight` identity-checks EVERY settle path (Codex review): an abandoned
  // leader whose client disconnected mid-await can still reach res.json
  // later, and without this check it would hand its stale result to a NEWER
  // leader's waiters and strand that leader unable to coalesce its own.
  const settleWaiters = (key, flight, fn) => {
    if (inflight.get(key) !== flight) return
    inflight.delete(key)
    for (const w of flight) { try { fn(w) } catch { /* client gone */ } }
  }
  router.use((req, res, next) => {
    if (req.method !== 'GET' || NO_CACHE.has(req.path)) return next()
    const key = req.originalUrl
    const hit = respCache.get(key)
    // An entry from before the last write is not merely old, it is WRONG —
    // see lib/state-cache.js. Age alone let a save be followed by up to ten
    // seconds of the pre-save answer.
    if (hit && hit.epoch === stateEpoch() && Date.now() - hit.at < STATE_CACHE_MS) {
      res.setHeader('etag', hit.etag)
      res.setHeader('x-cache', 'hit')
      if (req.headers['if-none-match'] === hit.etag) return res.status(304).end()
      return res.type('application/json').send(hit.body)
    }
    if (inflight.has(key)) { inflight.get(key).push({ req, res }); return }
    const myFlight = []
    inflight.set(key, myFlight)
    const origJson = res.json.bind(res)
    res.json = (obj) => {
      try {
        const body = JSON.stringify(obj)
        const etag = `W/"${createHash('sha1').update(body).digest('base64url').slice(0, 16)}"`
        const status = res.statusCode
        if (status < 400) {
          respCache.set(key, { body, etag, at: Date.now(), epoch: stateEpoch() })
          if (respCache.size > 300) { // bound: drop the oldest entry
            let oldK = null, oldAt = Infinity
            for (const [k, v] of respCache) if (v.at < oldAt) { oldAt = v.at; oldK = k }
            if (oldK) respCache.delete(oldK)
          }
        }
        // Answer everyone who piled up behind this compute — errors too, at
        // the same status, so a failing route fails fast for all callers
        // instead of each retrying the same broken compute serially.
        settleWaiters(key, myFlight, (w) => {
          w.res.status(status)
          w.res.setHeader('etag', etag)
          w.res.setHeader('x-cache', 'coalesced')
          if (status < 400 && w.req.headers['if-none-match'] === etag) { w.res.status(304); return w.res.end() }
          return w.res.type('application/json').send(body)
        })
        res.setHeader('etag', etag)
        res.setHeader('x-cache', 'miss')
        if (req.headers['if-none-match'] === etag) return res.status(304).end()
        return res.type('application/json').send(body)
      } catch {
        settleWaiters(key, myFlight, (w) => w.res.status(503).json({ error: 'busy — retry shortly' }))
        return origJson(obj)
      }
    }
    // Leader finished WITHOUT res.json (res.send route, thrown error, client
    // abort): release any parked waiters with a fast retryable answer rather
    // than leaving them to hang into their own 45s timeouts.
    res.on('close', () => {
      settleWaiters(key, myFlight, (w) => w.res.status(503).json({ error: 'busy — retry shortly' }))
    })
    next()
  })

  // -----------------------------------------------------------------------
  // GET /state/health
  // -----------------------------------------------------------------------
  router.get('/health', (_req, res) => {
    const symbolsJson = getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json') || '[]'
    let symbols = []
    try { symbols = JSON.parse(symbolsJson) } catch { /* non-fatal */ }
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
    } catch { /* non-fatal */ }

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
      // The causes behind errorsToday — see services/error-log.js. Without
      // this the counter is a number the owner cannot resolve to anything.
      recentErrors: readRecentErrors(db),
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
      // Readiness — everything the UI needs to say "you can trade now"
      broker: {
        linked: !!getState(db, 'ctrader_account_id'),
        accountId: getState(db, 'ctrader_account_id') || null,
        // Human account number (e.g. 5306502) — accountId is cTrader's
        // internal id; the UI shows traderLogin when available.
        traderLogin: getState(db, 'ctrader_trader_login') || null,
        isLive: getState(db, 'ctrader_is_live') === 'true',
        symbolsMapped: (() => { try { return Object.keys(JSON.parse(getState(db, 'symbol_id_map') || '{}')).length } catch { return 0 } })(),
        balance: Number(getState(db, 'account_balance_usd')) || null,
      },
      scanEnabled: getState(db, 'scan_enabled') !== 'false',
      analyzeEnabled: getState(db, 'analyze_enabled') !== 'false',
      autotradeEnabled: getState(db, 'autotrade_enabled') === 'true',
      pendingModeEnabled: getState(db, 'pending_mode_enabled') === 'true',
      // Set when the daily equity stop auto-disarmed autotrade — the UI must
      // show WHY autotrade turned itself off, not just that it did.
      equityStopTrippedAt: getState(db, 'equity_stop_tripped_at') || null,
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
  // GET /state/llm-monitor-health — owner (2026-07-27): "I need to be
  // alerted if any of the LLM failed and you still continue." Read-only
  // status the frontend polls to show a small degraded-state icon.
  // -----------------------------------------------------------------------
  router.get('/llm-monitor-health', async (_req, res) => {
    const { getLlmMonitorHealth } = await import('../services/llm-monitor-health.js')
    res.json(getLlmMonitorHealth(db))
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
  // SCOPED (owner 2026-07-30: "All the live positions in performance, trade,
  // monitor, desk are the same when i switch account. this is serious"). This
  // query used to be `WHERE mp.status = 'active'` and nothing else, so it
  // returned every enabled account's positions and switching accounts changed
  // nothing on screen. `?account=all` opts back into the portfolio view.
  router.get('/positions', async (req, res) => {
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 'mp.account_id')
    // Volume + broker fill time + ctrader_position_id live on the linked
    // trades row — joined in so the Open positions table can show Qty, the
    // real opened time, AND match the live-broker enrichment map (P&L, ccy,
    // margin, bid/ask, commission, swap) by position id. Without that last
    // column every enrichment lookup missed and P&L/To TP/SL always read
    // "—" (owner: "I mentioned in earlier PR that Open positions should
    // have 'P&L, To TP/SL'").
    const rows = db
      .prepare(
        `SELECT mp.*, t.volume AS volume, t.opened_at AS opened_at, t.ctrader_position_id AS ctrader_position_id, a.tp2_price AS tp2_price
         FROM monitored_positions mp
         LEFT JOIN trades t ON t.id = mp.trade_id
         LEFT JOIN analyses a ON a.id = t.analysis_id
         WHERE mp.status = 'active'${acct.active ? ` AND ${acct.where}` : ''}
         ORDER BY mp.created_at DESC`
      )
      .all(...acct.params)

    // Owner (2026-07-24, Friday evening): open trades were stuck over a
    // market closure the UI never surfaced — every open position now carries
    // its market state (broker-truth symbol_hours schedule, heuristic
    // fallback) plus the latest computed P&L from the broker snapshot cache
    // (the ~30s monitor refresh), so the UI can split OPEN/FLOATING from
    // OPEN-BUT-MARKET-CLOSED and show real numbers. Best effort — a failure
    // here must never break the positions list.
    let snapPositions = new Map()
    let snapAt = null
    try {
      const snap = JSON.parse(getState(db, 'broker_snapshot_cache_json') || 'null')
      snapAt = snap?.fetchedAt ?? null
      for (const p of snap?.account?.positions || []) {
        if (p?.positionId != null) snapPositions.set(String(p.positionId), p)
      }
    } catch { snapPositions = new Map() }
    let isOpenFn = null
    try { isOpenFn = (await import('../services/symbol-hours.js')).isSymbolOpenCached } catch { isOpenFn = null }
    const enriched = rows.map(r => {
      let market_open = null, market_source = null
      try {
        if (isOpenFn) { const o = isOpenFn(db, r.symbol); market_open = !!o.open; market_source = o.source || null }
      } catch { market_open = null }
      const sp = r.ctrader_position_id != null ? snapPositions.get(String(r.ctrader_position_id)) : null
      return {
        ...r, market_open, market_source,
        live_pnl: sp?.pnl ?? sp?.netPnl ?? null,
        live_pnl_at: sp ? snapAt : null,
        // Owner (open-trade tables): current price + latest daily OHLCV.
        // For a closed market these are the last computed values before/at
        // close — day.t says which session the bar belongs to.
        live_price: sp?.currentPrice ?? null,
        live_bid: sp?.bid ?? null,
        live_ask: sp?.ask ?? null,
        day: sp?.day ?? null,
      }
    })

    // accountId travels WITH the rows so the UI can name whose positions these
    // are beside the table (owner: "I still cannot know which account I am
    // trading in the page — can you state on the beside of the 'Open
    // positions' table"). unattributed says how many active rows were hidden
    // for carrying no account_id, so pre-M1 rows never vanish silently.
    res.json({
      positions: enriched,
      snapshotAt: snapAt,
      accountId: scope.all ? 'all' : (scope.accountId ?? null),
      scoped: acct.active,
      unattributed: acct.active ? countUnattributed(db, 'monitored_positions', "status = 'active'") : 0,
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/depth?symbol=EURUSD | ?symbolId=1 [&levels=10] — L2 depth
  // probe. Proxies the C++ sidecar's /depth (the agent holds EXEC_SECRET;
  // dashboards and operators hold only AGENT_SECRET) and returns the raw
  // {enabled, active, book} verbatim: enabled:false = DEPTH_FEED_ENABLED
  // unset sidecar-side, active:false = feed not running or broker rejected
  // the subscription, book:null = subscribed but no events yet. Used to
  // verify depth empirically on staging before trusting captured rows.
  // -----------------------------------------------------------------------
  router.get('/depth', async (req, res) => {
    let symbolId = Number(req.query.symbolId)
    const symbol = String(req.query.symbol || '').toUpperCase()
    if (!Number.isFinite(symbolId) || symbolId <= 0) {
      symbolId = null
      if (symbol) {
        try {
          const map = JSON.parse(getState(db, 'symbol_id_map') || '{}')
          if (Number.isFinite(Number(map[symbol]))) symbolId = Number(map[symbol])
        } catch { symbolId = null }
      }
    }
    if (!symbolId) {
      res.status(400).json({ error: 'need symbolId, or symbol present in symbol_id_map' })
      return
    }
    const levels = Math.min(50, Math.max(1, Number(req.query.levels) || 10))
    try {
      const { fetchDepthRaw } = await import('../services/depth-capture.js')
      const raw = await fetchDepthRaw(symbolId, { levels, timeoutMs: 5000 })
      if (!raw) {
        res.status(503).json({ error: 'no depth response (js exec mode, or sidecar unreachable)', execEngine: process.env.EXEC_ENGINE || 'js', symbolId })
        return
      }
      res.json({ symbolId, ...raw })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/orders — the broker resting-order ledger (working + recently
  // gone). Owner: "keep records of these" — resting entry orders fill even when
  // the bot's switches are OFF, so they get a durable record with lifecycle.
  // -----------------------------------------------------------------------
  router.get('/orders', (req, res) => {
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 'account_id')
    const and = acct.active ? ` AND ${acct.where}` : ''
    let working = [], recentlyGone = [], queued = []
    try {
      working = db.prepare(
        `SELECT * FROM broker_orders WHERE status = 'working'${and} ORDER BY last_seen DESC`
      ).all(...acct.params)
      recentlyGone = db.prepare(
        `SELECT * FROM broker_orders WHERE status = 'gone' AND gone_at >= datetime('now', '-24 hours')${and}
         ORDER BY gone_at DESC LIMIT 100`
      ).all(...acct.params)
    } catch { /* table may not exist on a very old DB */ }
    // BOT-SIDE queues (owner: "there are many but you keep waiting" — these
    // exist before anything rests at the broker, so the ledger must show
    // them or it reads as empty while work is queued):
    //  · pending_orders  — closed-market limits parked by the bot (excluded
    //    when the same order_id already shows in broker_orders working)
    //  · pending_signals — signals queued for market open / conditions
    try {
      const po = db.prepare(
        `SELECT * FROM pending_orders WHERE status = 'working'${and}
           AND (order_id IS NULL OR order_id NOT IN (SELECT order_id FROM broker_orders WHERE status = 'working'))
         ORDER BY id DESC LIMIT 100`
      ).all(...acct.params)
      queued.push(...po.map(o => ({
        id: o.id, kind: 'closed_market_limit', symbol: o.symbol, side: o.dir > 0 ? 'BUY' : 'SELL',
        order_type: 'LIMIT', volume: o.volume, limit_price: o.level, sl: o.sl, tp: o.tp,
        strategy: o.strategy || null, order_id: o.order_id || null,
        timeframe: o.timeframe, queued_at: o.placed_at, expires_at: o.expires_at, note: o.note,
      })))
    } catch { /* table optional */ }
    try {
      const ps = db.prepare(
        `SELECT * FROM pending_signals WHERE status = 'pending'${and} ORDER BY id DESC LIMIT 100`
      ).all(...acct.params)
      queued.push(...ps.map(s => ({
        id: s.id, kind: 'queued_signal', symbol: s.symbol,
        side: /long|buy/i.test(s.bias || '') ? 'BUY' : 'SELL',
        strategy: s.strategy, timeframe: s.timeframe, conviction: s.conviction,
        queued_at: s.queued_at, expires_at: s.expires_at, note: s.market_reason,
      })))
    } catch { /* table optional */ }
    res.json({
      working, recentlyGone, queued, workingCount: working.length,
      accountId: scope.all ? 'all' : (scope.accountId ?? null),
      scoped: acct.active,
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/correlation — the correlation-symbols controller, made
  // VISIBLE (owner: "when are you going to use all the correlation-symbols
  // controller" — it vetoes live but had no UI). Returns the curated
  // clusters, each cluster's LIVE net exposure from active positions, the
  // caps, and the rolling-matrix config + freshness.
  // -----------------------------------------------------------------------
  // GET /state/profit-ratchet — READ ONLY. The staircase's own account of
  // itself: config, the step it is using, the high-water mark, the protected
  // floor, how far equity sits above that floor, and whether it has ever
  // fired. This exists because autotrade disarmed itself on staging between
  // 12:32Z and 13:07Z on 2026-07-29 with no manual disarm, no route call and
  // no PERF_BREAKER row, and the ratchet — which disarms without necessarily
  // flattening — could not be inspected from outside the DB.
  //
  // Writes NOTHING. It does not run the ratchet, does not touch the
  // staircase, and cannot arm or disarm anything.
  router.get('/profit-ratchet', async (_req, res) => {
    try {
      const { loadProfitRatchetConfig, loadRatchetState, autoStepUsd } = await import('../services/profit-ratchet.js')
      const cfg = loadProfitRatchetConfig(db)
      const st = loadRatchetState(db)
      const balance = getAccountBalance(db)
      const step = cfg.stepUsd > 0 ? Number(cfg.stepUsd) : autoStepUsd(balance)
      // Equity here is the LAST known figure the ratchet itself recorded, not
      // a fresh broker call — this route must stay cheap and side-effect free.
      const floor = st?.floor ?? null
      const hwm = st?.hwm ?? null
      res.json({
        config: cfg,
        balance,
        step,
        state: st,
        // The two numbers that decide whether the ratchet fired: how far the
        // high-water mark sits above the protected floor, and whether the
        // ratchet has ever triggered (which is what disarms autotrade).
        headroomFromFloor: floor != null && hwm != null ? Math.round((hwm - floor) * 100) / 100 : null,
        hasTriggered: !!st?.lastTriggerAt,
        lastTriggerAt: st?.lastTriggerAt ?? null,
        // 'flatten' closes BOT positions on trigger; 'halt' only disarms.
        // A disarm with positions still open is consistent with 'halt', or
        // with 'flatten' finding no autopilot-sourced rows to close.
        floorAction: cfg.floorAction,
        autotradeEnabled: getState(db, 'autotrade_enabled') === 'true',
      })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // GET /state/cluster-conviction — what the correlation clusters say about
  // the CURRENT scan, read offensively rather than as a veto. Shows every
  // group that agrees, its best member, and the symbols that group would
  // rather not open separately. Read only; runs the same pure function the
  // loop runs, against the latest stored scan.
  router.get('/cluster-conviction', async (_req, res) => {
    try {
      const { clusterConviction, loadClusterConvictionConfig } = await import('../services/cluster-conviction.js')
      const { loadStoredMatrix } = await import('../services/correlation-matrix.js')
      // The newest scan row per symbol — one scan cycle's view, not a mix of
      // cycles (a stale row for one symbol would fabricate agreement).
      const scans = db.prepare(`
        SELECT symbol, bias, confidence FROM scans
         WHERE id IN (SELECT MAX(id) FROM scans GROUP BY symbol)
           AND datetime(scanned_at) >= datetime('now', '-1 day')
      `).all()
      let liveMatrix = null
      try { liveMatrix = loadStoredMatrix(db) } catch { /* none yet */ }
      const cfg = loadClusterConvictionConfig(db)
      const read = clusterConviction(
        scans.map(s2 => ({ symbol: s2.symbol, bias: s2.bias, conviction: s2.confidence })),
        { config: cfg, liveMatrix },
      )
      res.json({
        config: cfg,
        scanned: scans.length,
        matrixSymbols: liveMatrix?.symbols?.length || 0,
        ...read,
      })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/correlation', async (_req, res) => {
    try {
      const { CORRELATION_CLUSTERS, clusterExposure } = await import('../services/correlation.js')
      const { loadStoredMatrix } = await import('../services/correlation-matrix.js')
      const positions = db.prepare(
        `SELECT symbol, side FROM monitored_positions WHERE status = 'active'`
      ).all()
      const exposure = clusterExposure(positions, null)
      const cfg = loadRiskConfig(db)
      let matrix = null
      try { matrix = loadStoredMatrix(db) } catch { /* none yet */ }
      res.json({
        clusters: CORRELATION_CLUSTERS.map(c => ({
          key: c.key, label: c.label, members: c.members,
          net: exposure[c.key]?.net ?? 0,
          held: (exposure[c.key]?.members || []).map(m => `${m.symbol} ${m.side} (${m.contribution > 0 ? '+' : ''}${m.contribution})`),
        })),
        maxClusterExposure: cfg.maxClusterExposure,
        maxCurrencyExposure: cfg.maxCurrencyExposure,
        liveMatrix: {
          config: loadCorrelationMatrixConfig(db),
          computedAt: matrix?.computedAt || null,
          symbols: matrix?.symbols?.length || 0,
        },
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/postmortems — post-loss playback: what the market did after
  // each losing trade, with replay bars + per-strategy loss-class stats.
  // -----------------------------------------------------------------------
  router.get('/postmortems', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30))
    let rows = [], stats = []
    try {
      // Trade-Lesson field spec (owner) asks for Lot / TP1 / TP2 /
      // Confluence-count alongside the flat lesson fields — none of those
      // live on trade_postmortems itself, so join back to the trade (lot,
      // TP1, confluence_count) and its analysis (TP2, laddered target).
      // Aliased names only — never shadows pm's own snapshotted prices.
      // trade_closed_at/trade_opened_at: pm.created_at is when the SWEEP
      // classified this row, not when the trade happened — backfilling 90
      // days of history in one run (or one sweep classifying several
      // trades) stamps many rows with nearly the SAME created_at. Codex
      // review (PR #265) caught the UI using that for its date/time column,
      // which defeated the point of adding it. Use the trade's own timestamp.
      rows = db.prepare(
        `SELECT pm.*, t.volume AS lot, t.tp_price AS tp1_price, t.thesis AS setup_thesis,
                t.confluence_count AS confluence_count, a.tp2_price AS tp2_price,
                t.closed_at AS trade_closed_at, t.opened_at AS trade_opened_at
         FROM trade_postmortems pm
         LEFT JOIN trades t ON t.id = pm.trade_id
         LEFT JOIN analyses a ON a.id = t.analysis_id
         WHERE t.id IS NULL OR t.status <> 'rejected'
         ORDER BY pm.id DESC LIMIT ?`
      ).all(limit)
    } catch { /* table appears on first boot after migration */ }
    try {
      rows = rows.map(r => ({ ...r, bars: safeParse(r.bars_json), bars_json: undefined }))
    } catch { /* keep raw rows */ }
    try {
      stats = postmortemStats(db)
    } catch { /* table missing on a very old DB — stats stay empty */ }
    // ¶D·4 — "I didn't see the lesson learnt!", twelve minutes after a NAS100
    // short lost $1,013.08. There could not be one yet: a verdict needs 5 bars
    // of aftermath, which on a 10-minute chart is fifty minutes away. This
    // route only ever returned trades that already HAD a lesson, so one still
    // in its waiting period was simply absent — and absent reads as "nothing
    // was learned", not "not yet". Now it says which, and when.
    let pending = { rows: [], waiting: 0, ineligible: 0 }
    try {
      pending = pendingLessons(db)
    } catch { /* never block the lessons themselves on the pending list */ }
    res.json({ rows, stats, pending })
  })
  function safeParse(s) { try { return JSON.parse(s || 'null') } catch { return null } }

  // -----------------------------------------------------------------------
  // GET /state/duplicate-trades — read-only audit (owner spotted 7 identical
  // AUDUSD rows at the same timestamp in the lesson panel). Reports
  // candidate duplicate CLOSED trade records and how much they'd
  // double-count in Performance/Edge-health stats — never deletes anything.
  // -----------------------------------------------------------------------
  router.get('/duplicate-trades', async (_req, res) => {
    try {
      const { findDuplicateTrades } = await import('../services/trade-integrity.js')
      res.json(findDuplicateTrades(db))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/open-duplicates — the same audit as /duplicate-trades, but on
  // positions that are STILL OPEN. The closed-only version correctly reported
  // two historical pairs and was completely blind to a live 0003.HK pair
  // sitting in the book. Detecting a duplicate only once it closes is
  // detecting it after the money is gone.
  router.get('/open-duplicates', async (_req, res) => {
    try {
      const { findOpenDuplicates } = await import('../services/trade-integrity.js')
      res.json(findOpenDuplicates(db))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/protection-audit — the last known answer to "is every open
  // position actually protected?", ALWAYS with its age.
  //
  // ¶D·2. During the 2026-07-29 broker outage the panel read "Position
  // protection audit — idle", which is indistinguishable from "checked
  // everything, all clear". A safety check that goes silent exactly when the
  // system is degraded is worse than one that was never built, because the
  // silence reads as reassurance. This route never blanks: it reports the last
  // completed audit, how old it is, and whether it is still being confirmed.
  router.get('/protection-audit', async (_req, res) => {
    try {
      const { lastProtectionAudit } = await import('../services/naked-position-guard.js')
      // Reconcile — and so the audit — runs every 3rd loop.
      const loopMin = Number(getState(db, 'loop_interval_min'))
      const expectedSec = (Number.isFinite(loopMin) && loopMin >= 1 ? loopMin : 5) * 60 * 3
      res.json(lastProtectionAudit(db, { expectedSec }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/symbol-clusters — 2+ DISTINCT fills on one account+symbol
  // inside a window (owner: "double or triple trading symbols for past EU and
  // NY sessions"). /state/duplicate-trades only sees identical-value records;
  // this sees real separate fills stacked on one symbol, attributed to the
  // code path that opened each leg. Query: ?days=14&windowMinutes=60
  router.get('/symbol-clusters', async (req, res) => {
    try {
      const { findSameSymbolClusters } = await import('../services/trade-integrity.js')
      const days = Math.min(365, Math.max(1, Number(req.query.days) || 14))
      const windowMinutes = Math.min(1440, Math.max(1, Number(req.query.windowMinutes) || 60))
      res.json(findSameSymbolClusters(db, { days, windowMinutes }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/broker-deals — imported broker deal history (broker_deals),
  // newest close first. ?limit= (default 200, max 1000) &unmatchedOnly=1 to
  // show only fills the bot has no local trade row for.
  router.get('/broker-deals', (req, res) => {
    try {
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200))
      const only = String(req.query.unmatchedOnly || '') === '1'
      const rows = db.prepare(`
        SELECT * FROM broker_deals
        ${only ? 'WHERE matched_trade_id IS NULL' : ''}
        ORDER BY closed_at DESC LIMIT ?
      `).all(limit)
      const tot = db.prepare(
        'SELECT COUNT(*) AS all_rows, SUM(matched_trade_id IS NULL) AS unmatched FROM broker_deals',
      ).get()
      res.json({ rows, total: tot.all_rows || 0, unmatched: tot.unmatched || 0 })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
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
  // GET /state/action-log — the owner's audit trail (every POST /actions).
  // ?limit=N (default 200, max 1000); ?format=text returns a plain-text file.
  router.get('/action-log', (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200))
    let rows = []
    try {
      rows = db.prepare('SELECT * FROM action_log ORDER BY id DESC LIMIT ?').all(limit)
    } catch { /* table appears on first boot after migration */ }
    if (req.query.format === 'text') {
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.setHeader('content-disposition', 'attachment; filename="action-log.txt"')
      return res.send(rows.map(r => `${r.at}Z  ${r.method} ${r.path}  ${r.body || ''}`).join('\n'))
    }
    res.json({ rows })
  })

  // -----------------------------------------------------------------------
  // GET /state/client-ping — dashboard-tab presence heartbeat (owner
  // 2026-07-28: "monitor the number of website open ... and timezone").
  // A GET on purpose: read-tier device tokens can call it, and it changes
  // nothing durable — the roster is in-memory with a 90s TTL. Each tab
  // pings ~30s with its id/tz/page/visibility; the response is the live
  // roster so any tab can render "N tabs open". Also on /health.
  router.get('/client-ping', async (req, res) => {
    try {
      const { registerClientPing } = await import('../services/client-presence.js')
      res.json(registerClientPing({
        tab: req.query.tab, tz: req.query.tz, page: req.query.page,
        hidden: req.query.hidden, idle: req.query.idle, closed: req.query.closed,
        ua: req.headers['user-agent'],
        ip: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
      }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/accounts — the Account Registry (multi-account plan, M0).
  // Read-only view: which accounts exist, which one is enabled, mode,
  // metadata. The registry itself is written only by
  // services/account-registry.js.
  router.get('/accounts', async (_req, res) => {
    try {
      const { listAccounts } = await import('../services/account-registry.js')
      res.json({
        accounts: listAccounts(db),
        selectedAccountId: getState(db, 'ctrader_account_id') || null,
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/watchlists — every account's watchlist, plus the diff between
  // any two (?source=&destination=).
  //
  // `inherited` on each account is the fact that makes the compare readable:
  // an account with no list of its own is showing the SHARED list, and two
  // accounts both inheriting will look identical because they literally are
  // the same list — not because someone synced them.
  // -----------------------------------------------------------------------
  router.get('/watchlists', async (req, res) => {
    try {
      const { listAccounts } = await import('../services/account-registry.js')
      const { readWatchlist, hasOwnWatchlist, diffWatchlists } = await import('../services/watchlists.js')
      const { loadRiskConfig, getAccountLeverage, requiredMargin } = await import('../services/risk.js')

      // LAST TRADED, per account per symbol — the operator's sketch asks for
      // it because "this account has never touched that symbol" is the thing
      // that makes a copy decision obvious. Legacy rows carry a NULL
      // account_id; they belong to the account that was selected at the time,
      // so they count for the currently-selected one rather than for nobody.
      const selected = getState(db, 'ctrader_account_id') || null
      const lastTraded = {}
      try {
        for (const r of db.prepare(
          `SELECT COALESCE(account_id, ?) AS acct, symbol, MAX(COALESCE(closed_at, opened_at)) AS last
             FROM trades WHERE symbol IS NOT NULL GROUP BY acct, symbol`
        ).all(selected)) {
          if (!r.acct) continue
          ;(lastTraded[String(r.acct)] ||= {})[r.symbol] = r.last
        }
      } catch { /* no history is a blank cell, not an error */ }

      // MARGIN PER LOT — what one standard lot of this instrument commits on
      // THIS account, at its own leverage. It is an estimate off the last
      // scanned price, so a symbol with no cached price reports null and the
      // UI shows a dash rather than a confident zero.
      const riskCfg = loadRiskConfig(db)
      const prices = {}
      try {
        const last = JSON.parse(getState(db, 'last_scan_results') || 'null')
        for (const r of (last?.scans || last?.rows || [])) {
          const px = Number(r.price ?? r.close)
          if (Number.isFinite(px) && px > 0) prices[String(r.symbol).toUpperCase()] = px
        }
      } catch { /* no scan cache — every margin cell is a dash */ }

      const accounts = listAccounts(db).map(a => {
        const rawItems = readWatchlist(db, a.account_id)
        const lev = getAccountLeverage(db, riskCfg, a.account_id)
        const traded = lastTraded[String(a.account_id)] || {}
        const items = rawItems.map(i => {
          const px = prices[i.symbol]
          return {
            ...i,
            lastTradedAt: traded[i.symbol] ?? null,
            marginPerLotUsd: px
              ? Number(requiredMargin(i.symbol, 1, px, lev).marginRequired.toFixed(2))
              : null,
          }
        })
        return {
          accountId: a.account_id,
          // THE SAME ACCOUNT HAS TWO IDs. `account_id` is cTrader's
          // ctidTraderAccountId (4xxxxxxx); `trader_login` is the broker login
          // (5xxxxxx) — and the login is the ONLY one the operator ever sees
          // elsewhere, because the account picker on this same page is built
          // from the broker's account list. Owner, 2026-07-29: "the account I
          // pick to trade starts with five but the account I selected as
          // source to copy the watchlist starts with four — how do I know
          // which one am I using now?" Exactly right: they could not. Both
          // travel now, and `isSelected` marks the one the bot actually trades.
          traderLogin: a.trader_login || null,
          brokerLabel: a.broker_label || null,
          isSelected: selected != null && String(a.account_id) === String(selected),
          isLive: a.is_live === 1,
          enabled: a.enabled === 1,
          mode: a.mode,
          leverage: lev,
          inherited: !hasOwnWatchlist(db, a.account_id),
          count: items.length,
          enabledCount: items.filter(i => i.enabled !== false).length,
          items,
        }
      })
      const src = req.query.source ? String(req.query.source) : null
      const dst = req.query.destination ? String(req.query.destination) : null
      const diff = src && dst
        ? diffWatchlists(readWatchlist(db, src), readWatchlist(db, dst))
        : null
      res.json({
        accounts,
        shared: readWatchlist(db, null),
        selectedAccountId: selected,
        diff,
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/perf-ledger — the Performance Ledger aggregation (design_
  // claude PR B): timeframe windows × market categories × account, with
  // carry-forward. ?account=<id>|all (default all).
  router.get('/perf-ledger', async (req, res) => {
    try {
      const { buildPerfLedger } = await import('../services/perf-ledger.js')
      res.json(buildPerfLedger(db, {
        accountId: req.query.account ? String(req.query.account) : null,
      }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/decisions — 3A decision provenance: recent controller
  // decisions (skips included), newest first. ?symbol= &stage= &limit=
  // filter. Risk-gate vetoes remain in risk_events; this covers the stages
  // upstream of the gate.
  // GET /state/strategy-liveness — is each armed strategy actually alive?
  //
  // Answers the question that Cup & Handle went weeks without anyone being able
  // to ask: a strategy that is armed, backtests well, and produces nothing looks
  // exactly like a strategy waiting for a setup. This separates them.
  router.get('/strategy-liveness', async (req, res) => {
    try {
      const { strategyLiveness } = await import('../services/strategy-liveness.js')
      const windowDays = Number(req.query.days) > 0 ? Number(req.query.days) : undefined
      res.json(strategyLiveness(db, { windowDays }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/decisions', async (req, res) => {
    try {
      const { recentDecisions } = await import('../services/decision-log.js')
      res.json({
        decisions: recentDecisions(db, {
          symbol: req.query.symbol ? String(req.query.symbol).toUpperCase() : null,
          stage: req.query.stage ? String(req.query.stage) : null,
          limit: req.query.limit,
        }),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/weekend-loss-flags — losing positions flagged ahead of a
  // long market closure (weekend-loss-flag.js). Reads the sweep's own
  // one-shot `wl_flagged_*` markers, which self-expire once the closure
  // passes — so this list empties itself, no dismiss plumbing needed.
  router.get('/weekend-loss-flags', async (_req, res) => {
    try {
      const { parseWeekendFlags } = await import('../services/weekend-loss-flag.js')
      const rows = db.prepare("SELECT key, value FROM agent_state WHERE key LIKE 'wl_flagged_%'").all()
      res.json({ flags: parseWeekendFlags(rows) })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/backtest-reports — saved run reports (newest first). Reads
  // the SAME resolved directory saveBacktestReport writes to (persistent
  // volume on Railway via DB_PATH, cwd in local dev).
  // -----------------------------------------------------------------------
  // GET /state/backtest-job — status/result of the background backtest run.
  // The POST returns immediately; ANY page (or a later visit) collects the
  // results here — leaving Tune mid-run no longer loses them.
  // -----------------------------------------------------------------------
  router.get('/backtest-job', (_req, res) => {
    const job = currentJob()
    res.json({
      job: jobMeta(job),
      result: job?.status === 'done' ? job.result : null,
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/job/:kind — generic background-job status/result (screener,
  // future slow actions). Same contract as /state/backtest-job.
  // -----------------------------------------------------------------------
  router.get('/job/:kind', (req, res) => {
    const job = getJob(String(req.params.kind || ''))
    res.json({
      job: jobMeta(job),
      result: job?.status === 'done' ? job.result : null,
    })
  })

  router.get('/backtest-reports', async (_req, res) => {
    try {
      const fs = await import('node:fs')
      const { reportsDir } = await import('../lib/backtest-report.js')
      const dir = reportsDir()
      const names = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(n => /^[\w.-]+\.html$/.test(n)).sort().reverse()
        : []
      res.json({ reports: names })
    } catch (err) { res.status(500).json({ error: err.message }) }
  })

  router.get('/backtest-reports/:name', async (req, res) => {
    try {
      const name = String(req.params.name)
      if (!/^[\w.-]+\.html$/.test(name)) return res.status(400).json({ error: 'bad report name' })
      const fs = await import('node:fs')
      const path = await import('node:path')
      const { reportsDir } = await import('../lib/backtest-report.js')
      const file = path.join(reportsDir(), name)
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'report not found' })
      res.json({ name, html: fs.readFileSync(file, 'utf8') })
    } catch (err) { res.status(500).json({ error: err.message }) }
  })

  // -----------------------------------------------------------------------
  // GET /state/backtest-history?symbol=&limit= — durable per-symbol backtest
  // record (backtest_runs table; survives redeploys, unlike the HTML
  // reports). Rows newest first, plus a per-symbol rollup for the watchlist.
  // -----------------------------------------------------------------------
  router.get('/backtest-history', (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
      const sym = String(req.query.symbol || '').toUpperCase().trim()
      const rows = sym
        ? db.prepare('SELECT * FROM backtest_runs WHERE symbol = ? ORDER BY id DESC LIMIT ?').all(sym, limit)
        : db.prepare('SELECT * FROM backtest_runs ORDER BY id DESC LIMIT ?').all(limit)
      const bySymbol = db.prepare(
        `SELECT symbol, COUNT(*) AS rows, MAX(ran_at) AS lastRanAt,
                SUM(COALESCE(trades, 0)) AS totalTrades,
                SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
           FROM backtest_runs GROUP BY symbol ORDER BY lastRanAt DESC`
      ).all()
      res.json({ rows, bySymbol })
    } catch (err) { res.status(500).json({ error: err.message }) }
  })

  // -----------------------------------------------------------------------
  // GET /state/watchlist-removed — symbols that used to be on the watchlist
  // (recorded by POST /actions/symbols on every save), newest first.
  // -----------------------------------------------------------------------
  router.get('/watchlist-removed', (_req, res) => {
    try {
      let hist = []
      try { hist = JSON.parse(getState(db, 'watchlist_removed_json') || '[]') || [] } catch { hist = [] }
      res.json({ removed: hist })
    } catch (err) { res.status(500).json({ error: err.message }) }
  })

  // GET /state/trades — trade journal (last 100 closed)
  // -----------------------------------------------------------------------
  router.get('/trades', (req, res) => {
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 'account_id')
    const rows = db
      .prepare(
        `SELECT * FROM trades WHERE status IN ('closed', 'rejected')${acct.active ? ` AND ${acct.where}` : ''}
         ORDER BY COALESCE(closed_at, opened_at) DESC LIMIT 100`
      )
      .all(...acct.params)

    // ¶D·3 — decode the label here so every reader gets the same words.
    // The owner, on a NAS100 short that lost $1,013.08: "I don't know was
    // strategy used." The trade carried AP|v1|FIB|HI|SYD|10m — every fact
    // needed to answer that was recorded, and rendered as a code. Attribution
    // that has to be decoded by hand is not attribution.
    res.json({
      trades: rows.map(r => ({ ...r, label_decoded: describeLabel(r.label_raw).text })),
      accountId: scope.all ? 'all' : (scope.accountId ?? null),
      scoped: acct.active,
      unattributed: acct.active
        ? countUnattributed(db, 'trades', "status IN ('closed','rejected')")
        : 0,
    })
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
    try { reports = JSON.parse(row.minion_reports || '[]') } catch { /* non-fatal */ }
    let synthesis = null
    try { synthesis = JSON.parse(row.synthesis || 'null') } catch { /* non-fatal */ }

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
    // Full registry with the trader's on/off choices — the UI renders this
    // list instead of hardcoding strategy names.
    const onKeys = new Set(enabledStrategies(db, getState).map(s => s.key))
    res.json({
      scan_enabled: getState(db, 'scan_enabled') !== 'false',
      cup_handle_enabled: getState(db, 'cup_handle_enabled') === 'true',
      strategies: STRATEGY_REGISTRY.map(s => ({ key: s.key, name: s.name, on: onKeys.has(s.key) })),
      loop_interval_min: Number(getState(db, 'loop_interval_min')) || 5,
      autopilot_mode: (() => { const m = getState(db, 'autopilot_mode'); return m === 'auto' || m === 'suggest' ? m : 'off' })(),
      autopilot_last_run_ms: Number(getState(db, 'autopilot_last_run_ms')) || null,
      selected_account_id: getState(db, 'ctrader_account_id') || null,
      analyze_enabled: getState(db, 'analyze_enabled') !== 'false',
      autotrade_enabled: getState(db, 'autotrade_enabled') === 'true',
      // Backward compat: armed = autotrade_enabled
      armed: getState(db, 'autotrade_enabled') === 'true',
      symbols: symbolsJson ? (() => { try { return JSON.parse(symbolsJson) } catch { return [] } })() : [],
      watchlist: symbolsJson ? (() => { try { return JSON.parse(symbolsJson) } catch { return [] } })() : [],
      pending_mode_enabled: getState(db, 'pending_mode_enabled') === 'true',
      pending_matrix: (() => { try { return JSON.parse(getState(db, 'pending_matrix_json') || 'null') } catch { return null } })(),
      autotrade_scope: getState(db, 'autotrade_scope') || 'all',
      weekend_bank: (getState(db, 'weekend_bank') || 'true') !== 'false',
      guardian_move_pct: Number(getState(db, 'guardian_move_pct')) || 0.05,
      performance_breaker: loadPerformanceBreakerConfig(db),
      session_open_guard: loadSessionOpenGuardConfig(db),
      regime_gate: loadRegimeGateConfig(db),
      correlation_matrix: loadCorrelationMatrixConfig(db),
      asset_controllers: assetControllersView(db),
      burn_in: (() => { try { const p = JSON.parse(getState(db, 'burn_in_json') || 'null'); return p && typeof p === 'object' ? p : { on: false } } catch { return { on: false } } })(),
      adaptive_breaker: (() => { try { const p = JSON.parse(getState(db, 'adaptive_breaker_json') || 'null'); return p && typeof p === 'object' ? { on: p.on !== false, streak: p.streak ?? 3 } : { on: true, streak: 3 } } catch { return { on: true, streak: 3 } } })(),
      monitor_interval_min: Number(getState(db, 'monitor_interval_min')) || 1,
      monitor_overrides: (() => { try { const p = JSON.parse(getState(db, 'monitor_overrides_json') || '{}'); return p && typeof p === 'object' ? p : {} } catch { return {} } })(),
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/pending-orders — resting-limit-order lifecycle rows
  // -----------------------------------------------------------------------
  router.get('/pending-orders', (req, res) => {
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 'account_id')
    try {
      const rows = db.prepare(
        `SELECT * FROM pending_orders${acct.active ? ` WHERE ${acct.where}` : ''} ORDER BY id DESC LIMIT 50`
      ).all(...acct.params)
      res.json({
        rows,
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        scoped: acct.active,
        unattributed: acct.active ? countUnattributed(db, 'pending_orders') : 0,
      })
    } catch (e) {
      res.json({ rows: [], error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/risk-events — recent Risk Manager decisions (audit trail)
  // Query param `limit` (default 100), `symbol` optional filter
  // -----------------------------------------------------------------------
  router.get('/risk-events', (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10)))
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 'account_id')
    const clauses = []
    const params = []
    if (req.query.symbol) { clauses.push('symbol = ?'); params.push(String(req.query.symbol).toUpperCase()) }
    if (acct.active) { clauses.push(acct.where); params.push(...acct.params) }
    const rows = db.prepare(
      `SELECT * FROM risk_events${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY created_at DESC LIMIT ?`
    ).all(...params, limit)
    res.json({
      rows,
      accountId: scope.all ? 'all' : (scope.accountId ?? null),
      scoped: acct.active,
      unattributed: acct.active ? countUnattributed(db, 'risk_events') : 0,
    })
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
    let matrix = null
    try { matrix = JSON.parse(getState(db, 'autotrade_matrix_json') || 'null') } catch { /* null */ }
    res.json({ timeframes, matrix })
  })

  // -----------------------------------------------------------------------
  // GET /state/timeframe-performance — win/loss/no-trade per autotrade
  // timeframe over rolling windows (Tune → Pipeline table)
  // -----------------------------------------------------------------------
  router.get('/timeframe-performance', (_req, res) => {
    try {
      res.json(timeframePerformance(db))
    } catch (e) {
      res.json({ windows: [], rows: [], error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/broker-cache — the LAST broker snapshot + 7d history, served
  // from SQLite in milliseconds. The live WS fetches refresh these caches
  // (and the monitor refreshes the snapshot every ~30s), so the Desk paints
  // instantly with data at most a few loops old, then swaps in live truth.
  // -----------------------------------------------------------------------
  router.get('/broker-cache', (_req, res) => {
    const parse = (k) => { try { return JSON.parse(getState(db, k) || 'null') } catch { return null } }
    res.json({
      snapshot: parse('broker_snapshot_cache_json'),
      history: parse('broker_history_cache_json'),
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/risk-full — everything the Risk page shows in ONE call:
  // effective risk config vs defaults (so the UI can mark what's overridden),
  // account balance/leverage, the broker's real stop-out level, guardian /
  // weekend-bank toggles, the C++ exec-guard knobs, and VPO settings.
  // -----------------------------------------------------------------------
  router.get('/risk-full', async (_req, res) => {
    try {
      const { DEFAULT_RISK_CONFIG, loadRiskConfig, getAccountBalance, getAccountLeverage } = await import('../services/risk.js')
      const effective = loadRiskConfig(db)
      const overridden = Object.keys(DEFAULT_RISK_CONFIG).filter(
        k => JSON.stringify(effective[k]) !== JSON.stringify(DEFAULT_RISK_CONFIG[k])
      )
      const parse = (k, dflt) => { try { return JSON.parse(getState(db, k) || dflt) } catch { return JSON.parse(dflt) } }
      // BROKER truth wins for balance (owner saw a stale figure: the stored
      // account_balance_usd lags the broker between loop refreshes). Use the
      // latest broker snapshot when it's fresh; fall back to the stored value.
      const snap = parse('broker_snapshot_cache_json', 'null')
      const snapAgeMs = snap?.fetchedAt ? Date.now() - new Date(snap.fetchedAt).getTime() : Infinity
      const brokerBalance = snapAgeMs < 15 * 60 * 1000 ? (snap?.account?.health?.balance ?? snap?.account?.balance ?? null) : null
      res.json({
        ok: true,
        risk: { effective, defaults: DEFAULT_RISK_CONFIG, overridden },
        account: {
          balance: brokerBalance ?? getAccountBalance(db),
          balanceSource: brokerBalance != null ? 'broker' : 'stored',
          balanceFetchedAt: brokerBalance != null ? snap.fetchedAt : null,
          leverage: getAccountLeverage(db, effective),
          // Pepperstone forces liquidation at 50% margin level on this
          // account — real observed history (risk.js: owner hit 16 open,
          // margin level 126% vs 50% stop-out). Broker-set, not editable.
          brokerStopOutPct: 50,
          accountId: getState(db, 'ctrader_account_id') || null,
          isLive: getState(db, 'ctrader_is_live') === 'true',
        },
        guardian: {
          enabled: (getState(db, 'guardian') || 'true') !== 'false',
          movePct: Number(getState(db, 'guardian_move_pct')) || 0.05,
        },
        weekendBank: (getState(db, 'weekend_bank') || 'true') !== 'false',
        weekendLossFlag: (getState(db, 'weekend_loss_flag') || 'true') !== 'false',
        // Real-time margin (broker truth) — the monitor refreshes the broker
        // snapshot ~30s; the Risk page's lot-sizing card explains sizing
        // against THESE numbers, the same ones the risk gate now uses.
        margin: (() => {
          try {
            const snap = JSON.parse(getState(db, 'broker_snapshot_cache_json') || 'null')
            const h = snap?.account?.health
            if (!h) return null
            return {
              usedMargin: h.usedMargin ?? null,
              freeMargin: h.freeMargin ?? null,
              equity: h.equity ?? null,
              marginLevelPct: h.marginLevelPct ?? null,
              fetchedAt: snap.fetchedAt ?? null,
            }
          } catch { return null }
        })(),
        execGuard: parse('exec_guard_json', '{}'),
        globalGuards: parse('global_guards_json', '{}'),
        vpo: {
          enabled: (getState(db, 'vpo_enabled') || 'false') === 'true',
          config: parse('vpo_config_json', '[]'),
        },
        // A2 rework (owner 2026-07-28): the two new protection layers ride
        // in the same single call — effective config (defaults merged) plus,
        // for the ratchet, the live staircase state to render.
        lossCap: await (async () => {
          const { loadLossCapConfig, DEFAULT_LOSS_CAP } = await import('../services/loss-cap.js')
          return { effective: loadLossCapConfig(db), defaults: DEFAULT_LOSS_CAP }
        })(),
        profitRatchet: await (async () => {
          const { loadProfitRatchetConfig, DEFAULT_PROFIT_RATCHET } = await import('../services/profit-ratchet.js')
          return {
            effective: loadProfitRatchetConfig(db),
            defaults: DEFAULT_PROFIT_RATCHET,
            state: parse('profit_ratchet_state_json', 'null'),
          }
        })(),
        lossGuardian: await (async () => {
          const { loadLossGuardianConfig, DEFAULT_LOSS_GUARDIAN } = await import('../services/loss-guardian.js')
          return { effective: loadLossGuardianConfig(db), defaults: DEFAULT_LOSS_GUARDIAN }
        })(),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/strategy-insights?days=N — per-strategy forecast-vs-actual
  // over closed trades (owner: "how the strategy forecast to actual
  // win/lost"). Same rows Performance counts; 'rejected' repairs excluded.
  // -----------------------------------------------------------------------
  router.get('/strategy-insights', async (req, res) => {
    try {
      const { strategyInsights } = await import('../services/strategy-insights.js')
      const days = Number(req.query.days) > 0 ? Number(req.query.days) : null
      res.json({ ok: true, rows: strategyInsights(db, { sinceDays: days }) })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/watchlist-stats — LIVE per-symbol results for the Watchlist
  // table: closed trades, net P&L, win rate, and a loser flag once a symbol
  // has enough sample (n >= min_n) and is net negative. The watchlist stays
  // configuration — this is the evidence beside it.
  // -----------------------------------------------------------------------
  router.get('/watchlist-stats', (_req, res) => {
    try {
      const MIN_N = 10
      const rows = db.prepare(
        `SELECT UPPER(symbol) AS sym, COUNT(*) AS n, ROUND(SUM(net_pnl), 2) AS net, SUM(net_pnl > 0) AS wins
         FROM trades WHERE status = 'closed' AND net_pnl IS NOT NULL GROUP BY UPPER(symbol)`
      ).all()
      const by = {}
      for (const r of rows) {
        by[r.sym] = {
          n: r.n,
          net: r.net,
          winRate: r.n ? Math.round((r.wins / r.n) * 100) : null,
          loser: r.n >= MIN_N && r.net < 0,
        }
      }
      res.json({ min_n: MIN_N, by })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // -----------------------------------------------------------------------
  // GET /state/strategy-tf-performance?days=30 — the RECONCILED grid the
  // owner asked for: strategy × timeframe, ONE shared window, closed trades
  // only. Unlabelled trades and unknown timeframes get their own row/column
  // instead of vanishing, so the grid total always equals the trade count.
  // -----------------------------------------------------------------------
  router.get('/strategy-tf-performance', (req, res) => {
    try {
      const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30))
      const rows = db.prepare(
        `SELECT COALESCE(label_strategy, strategy, 'unlabelled') AS strat,
                COALESCE(label_timeframe, '—') AS tf,
                COUNT(*) AS n, ROUND(SUM(net_pnl), 2) AS net, SUM(net_pnl > 0) AS wins
         FROM trades
         WHERE status = 'closed' AND net_pnl IS NOT NULL AND closed_at >= datetime('now', ?)
         GROUP BY strat, tf`
      ).all(`-${days} days`)
      const tfSet = new Set()
      const byStrat = {}
      let total = 0
      for (const r of rows) {
        tfSet.add(r.tf)
        total += r.n
        const s = (byStrat[r.strat] ??= { strategy: r.strat, cells: {}, total: { n: 0, net: 0 } })
        s.cells[r.tf] = { n: r.n, net: r.net, winRate: r.n ? Math.round((r.wins / r.n) * 100) : null }
        s.total.n += r.n
        s.total.net = Math.round((s.total.net + r.net) * 100) / 100
      }
      const ms = (tf) => { const m = String(tf).match(/^(\d+(?:\.\d+)?)(m|h|d|w|mo)$/); return m ? Number(m[1]) * { m: 1, h: 60, d: 1440, w: 10080, mo: 43200 }[m[2]] : Infinity }
      const timeframes = [...tfSet].sort((a, b) => ms(a) - ms(b))
      const strategies = Object.values(byStrat).sort((a, b) => b.total.n - a.total.n)
      res.json({ days, total_closed: total, timeframes, strategies })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // -----------------------------------------------------------------------
  // GET /state/profit-keeper — the automatic profit-protection policy
  // -----------------------------------------------------------------------
  router.get('/profit-keeper', (_req, res) => {
    res.json({ config: loadProfitKeeperConfig(db) })
  })

  // GET /state/loss-guardian — the loss-side safety-net policy
  router.get('/loss-guardian', async (_req, res) => {
    const { loadLossGuardianConfig } = await import('../services/loss-guardian.js')
    res.json({ config: loadLossGuardianConfig(db) })
  })

  // GET /state/closed-market-limits — resting-limit-orders policy
  router.get('/closed-market-limits', async (_req, res) => {
    const { loadClosedMarketLimitsConfig } = await import('../services/closed-market-limits.js')
    res.json({ config: loadClosedMarketLimitsConfig(db) })
  })

  // -----------------------------------------------------------------------
  // GET /state/sizing-preview — dynamic per-symbol lot sizing for the
  // Watchlist table (same math as the live risk gate)
  // -----------------------------------------------------------------------
  router.get('/sizing-preview', (_req, res) => {
    try {
      res.json(sizingPreview(db))
    } catch (e) {
      res.json({ rows: [], error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/fib-rsi-filter — whether the RSI confluence gate is on
  // -----------------------------------------------------------------------
  router.get('/fib-rsi-filter', (_req, res) => {
    res.json({ on: getState(db, 'fib_rsi_filter') === 'true' })
  })

  // -----------------------------------------------------------------------
  // GET /state/stage-matrix — the Tune Pipeline strategy × stage table:
  // per-cell on/off (trade column derived live from the legacy keys) plus
  // 30-day usage counts per cell.
  // -----------------------------------------------------------------------
  router.get('/stage-matrix', (_req, res) => {
    try {
      res.json(stageMatrixView(db, getState))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/heartbeats — controller reliability: every background
  // controller's last beat, failure streak, and OK/STALLED/ERROR status,
  // plus the C++ exec engine's probed liveness when EXEC_ENGINE=cpp.
  // -----------------------------------------------------------------------
  router.get('/heartbeats', async (_req, res) => {
    try {
      const { heartbeatView } = await import('../services/heartbeat.js')
      res.json({ controllers: heartbeatView(db) })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/market-hours?symbols=A,B — open/closed per symbol plus WHEN
  // a closed market next opens (broker schedule when cached; heuristic
  // symbols report open/closed only). Default scope: watchlist + active
  // positions.
  // -----------------------------------------------------------------------
  router.get('/market-hours', async (req, res) => {
    try {
      const { nextOpenInfo } = await import('../services/symbol-hours.js')
      let symbols = String(req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      if (symbols.length === 0) {
        const wl = (() => { try { return JSON.parse(getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json') || '[]') } catch { return [] } })()
        const wlSyms = (Array.isArray(wl) ? wl : []).map(w => (typeof w === 'string' ? w : w.symbol)).filter(Boolean)
        const posSyms = db.prepare(`SELECT DISTINCT symbol FROM monitored_positions WHERE status = 'active'`).all().map(r => r.symbol)
        symbols = [...new Set([...wlSyms, ...posSyms].map(s => String(s).toUpperCase()))]
      }
      const hours = {}
      for (const sym of symbols.slice(0, 300)) hours[sym] = nextOpenInfo(db, sym)
      res.json({ hours })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/llm-spend — token usage + estimated USD (today/7d/30d,
  // per purpose×model, monthly projection). The no-bill-shock dashboard.
  // -----------------------------------------------------------------------
  router.get('/llm-spend', async (_req, res) => {
    try {
      const { spendView } = await import('../services/llm-spend.js')
      res.json(spendView(db))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/alpha-decay?window=30 — edge-erosion read: rolling expectancy
  // per strategy (recent window vs prior) + expectancy by entry lag.
  // -----------------------------------------------------------------------
  router.get('/alpha-decay', async (req, res) => {
    try {
      const window = Math.min(100, Math.max(10, parseInt(req.query.window || '30', 10)))
      const { alphaDecayView } = await import('../services/alpha-decay.js')
      res.json(alphaDecayView(db, { window }))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/veto-breakdown?days=30 — WHY trades were vetoed, grouped by
  // reason family (symbol_cooldown, market_closed, spread…). The stage
  // matrix shows how many; this shows what actually blocked them.
  // -----------------------------------------------------------------------
  router.get('/veto-breakdown', (req, res) => {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days || '30', 10)))
    try {
      const rows = db.prepare(
        `SELECT approved, veto_reason FROM risk_events
          WHERE datetime(created_at) >= datetime('now', ?)`
      ).all(`-${days} days`)
      const byReason = {}
      let ok = 0
      for (const r of rows) {
        if (r.approved) { ok++; continue }
        const key = String(r.veto_reason || 'unknown').split(/[:\s]/)[0] || 'unknown'
        byReason[key] = (byReason[key] || 0) + 1
      }
      res.json({
        days,
        ok,
        vetoes: Object.entries(byReason)
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
      })
    } catch (e) {
      res.json({ days, ok: 0, vetoes: [], error: e.message })
    }
  })

  // GET /state/arm-benchmarks — backtest stats stored at Apply time
  router.get('/arm-benchmarks', (_req, res) => {
    let benchmarks = null
    try { benchmarks = JSON.parse(getState(db, 'arm_benchmarks_json') || 'null') } catch { /* null */ }
    res.json({ benchmarks })
  })

  // GET /state/fib-vwap-filter / fib-fvg-filter — confluence gate states
  router.get('/fib-vwap-filter', (_req, res) => {
    res.json({ on: getState(db, 'fib_vwap_filter') === 'true' })
  })
  router.get('/fib-fvg-filter', (_req, res) => {
    res.json({ on: getState(db, 'fib_fvg_filter') === 'true' })
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
      // Volume lives on the linked trades row, not monitored_positions —
      // without this join every external position's Qty read "—" (owner:
      // "At the broker missing QTY").
      const externalPositions = db.prepare(
        `SELECT mp.*, t.ctrader_position_id, t.volume AS volume
         FROM monitored_positions mp
         LEFT JOIN trades t ON t.id = mp.trade_id
         WHERE mp.status = 'active' AND mp.source = 'external'
         ORDER BY mp.created_at DESC`
      ).all()
      let pendingOrders = []
      try { pendingOrders = JSON.parse(pendingJson || '[]') } catch { /* non-fatal */ }
      res.json({ externalPositions, pendingOrders, lastReconcileAt })
    } catch (e) {
      res.json({ externalPositions: [], pendingOrders: [], lastReconcileAt: null, error: e.message })
    }
  })

  return router
}
