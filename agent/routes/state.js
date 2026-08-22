// ---------------------------------------------------------------------------
// agent/routes/state.js — GET endpoints for frontend dashboard
// ---------------------------------------------------------------------------

import { Router } from 'express'
import { strategyAttrSql } from '../lib/strategy-attribution.js'
import { createHash } from 'node:crypto'
import { getState } from '../db.js'
import { llmDisabled as llmDisabledFlag, llmDisabledReason as llmDisabledWhy } from '../lib/llm-switch.js'
import { loadRiskConfig, accountRiskOverlay, DEFAULT_RISK_CONFIG, getAccountBalance, getAccountLeverage } from '../services/risk.js'
// Static, not the dynamic import used further down: /config is a SYNC handler.
import { readWatchlist, hasOwnWatchlist } from '../services/watchlists.js'
import { tierForBalance } from '../lib/contracts.js'
import { describeLabel } from '../lib/trade-labels.js'
import { originCoverage } from '../lib/trade-origin.js'
import { STRATEGY_REGISTRY, enabledStrategies } from '../services/strategies.js'
import { stateEpoch } from '../lib/state-cache.js'
import { armedTimeframes } from '../lib/timeframes.js'
import { requestedAccount, accountWhere, countUnattributed, scopeCoverage, scopeReport } from '../lib/account-scope.js'
import { timeframePerformance } from '../services/timeframe-performance.js'
import { sizingPreview } from '../services/sizing-preview.js'
import { loadProfitKeeperConfig } from '../services/profit-keeper.js'
import { loadPerformanceBreakerConfig } from '../services/performance-breaker.js'
import { loadSessionOpenGuardConfig } from '../services/session-open-guard.js'
import { loadRegimeGateConfig } from '../services/regime-gate.js'
import { loadCorrelationMatrixConfig } from '../services/correlation-matrix.js'
import { loadPulse, pulseFor, PULSE_STATES } from '../services/market-pulse.js'
import { assetControllersView } from '../services/asset-controllers.js'
import { stageMatrixView, loadStageMatrix, stageOverlayKeys, accountStageTallies } from '../services/stage-matrix.js'
// Aliased: this handler already has a local `overlayKeys` for the RISK
// overlay, and the shadow made the call below resolve to that array.
import { overlayKeys as acctOverlayKeys } from '../services/account-overlay.js'
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
  // /sessions is excluded too: it reports a live "seen 3s ago" age, and a 10s
  // shared cache would make that figure a stale claim about a security state.
  // /unresolvable-plan is excluded because its answer depends on IN-MEMORY
  // process state (pnl-backfill's backoff ladder, via exhaustedAccounts()) that
  // no write touches — so stateEpoch() never bumps for it and the cache would
  // happily serve a superseded plan. A backfill attempt landing, or a restart
  // clearing the ladder, changes the answer with no write at all. Caught by its
  // own test: after resetting the pacing the route still reported the previous
  // candidate. A ten-second-stale list is tolerable on a dashboard; on the page
  // someone reads before writing off money data it is not.
  const NO_CACHE = new Set(['/client-ping', '/backtest-report', '/sessions', '/unresolvable-plan'])
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
      // Off is a stated position, not a fault. Without this the panel can only
      // show a stale api_anthropic_last_ok and a failure streak, which reads as
      // an outage when it is a decision — see lib/llm-switch.js.
      llmDisabled: llmDisabledFlag(db, getState),
      llmDisabledBy: llmDisabledWhy(db, getState),
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
  router.get('/scans', (req, res) => {
    const lastResults = getState(db, 'last_scan_results')
    // S1 batch 3, corrected. scans carries account_id, but db.js calls scans
    // "account-independent market observations [that] may stay NULL (global)"
    // — this is the plan's `global` mode, so it FILTERS ONLY WHEN ASKED.
    //
    // Defaulting to the selected account was wrong: a scan row is a market
    // observation and the price is the price whoever recorded it. Silently
    // dropping another account's rows would shrink the price map the UI
    // converts currencies with, which is how a scoping change becomes a
    // missing dollar figure two screens away. Coverage is still reported, so
    // the panel can say "global" out loud instead of implying per-account.
    const scope = requestedAccount(db, req)
    const acct = scope?.explicit ? accountWhere(scope, 'account_id') : { where: '', params: [], active: false }
    const recentScans = db
      .prepare(
        `SELECT * FROM scans${acct.active ? ` WHERE ${acct.where}` : ''}
         ORDER BY scanned_at DESC LIMIT 50`
      )
      .all(...acct.params)

    res.json({
      lastScanAt: getState(db, 'last_scan_at'),
      lastResults: lastResults ? (() => { try { return JSON.parse(lastResults) } catch { return null } })() : null,
      recentScans,
      accountId: scope.all ? 'all' : (scope.accountId ?? null),
      scoped: acct.active,
      scope: scopeReport(scope, scopeCoverage(db, { table: 'scans', scope })),
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
    // Global by default, like /state/scans above — filtered only when asked.
    const scope = requestedAccount(db, req)
    const acct = scope?.explicit ? accountWhere(scope, 'account_id') : { where: '', params: [], active: false }
    const rows = db
      .prepare(
        `SELECT * FROM scans WHERE symbol = ?${acct.active ? ` AND ${acct.where}` : ''}
         ORDER BY scanned_at DESC LIMIT 50`
      )
      .all(symbol, ...acct.params)

    res.json({
      symbol,
      scans: rows,
      accountId: scope.all ? 'all' : (scope.accountId ?? null),
      scoped: acct.active,
      scope: scopeReport(scope, scopeCoverage(db, {
        table: 'scans', scope, extraWhere: 'symbol = ?', extraParams: [symbol],
      })),
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/signals — latest signal per symbol
  // -----------------------------------------------------------------------
  router.get('/signals', (req, res) => {
    // S1 batch 4. The predicate goes on BOTH halves. Filtering only the outer
    // select would pick "the latest signal on any account" and then drop it if
    // it belonged to another one — the symbol would show nothing rather than
    // its own latest signal, which is a worse answer than the unscoped one.
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 'account_id')       // the inner subquery
    const outer = accountWhere(scope, 's.account_id')    // the aliased outer
    const rows = db
      .prepare(
        `SELECT s.*
         FROM signals s
         INNER JOIN (
           SELECT symbol, MAX(recorded_at) AS max_at
           FROM signals${acct.active ? ` WHERE ${acct.where}` : ''}
           GROUP BY symbol
         ) latest ON s.symbol = latest.symbol AND s.recorded_at = latest.max_at
         ${outer.active ? `WHERE ${outer.where}` : ''}
         ORDER BY s.recorded_at DESC`
      )
      .all(...acct.params, ...outer.params)

    res.json({
      signals: rows,
      accountId: scope.all ? 'all' : (scope.accountId ?? null),
      scoped: acct.active,
      scope: scopeReport(scope, scopeCoverage(db, { table: 'signals', scope })),
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/signals/flips — recent flips (last 100)
  // -----------------------------------------------------------------------
  router.get('/signals/flips', (req, res) => {
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 'account_id')
    const rows = db
      .prepare(
        `SELECT * FROM signals WHERE flipped = 1${acct.active ? ` AND ${acct.where}` : ''}
         ORDER BY recorded_at DESC LIMIT 100`
      )
      .all(...acct.params)

    res.json({
      flips: rows,
      accountId: scope.all ? 'all' : (scope.accountId ?? null),
      scoped: acct.active,
      scope: scopeReport(scope, scopeCoverage(db, {
        table: 'signals', scope, extraWhere: 'flipped = 1',
      })),
    })
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
  // -----------------------------------------------------------------------
  // GET /state/position/:id/cockpit — PHASE 1 of the cockpit live-wiring
  // prompt: the read-only snapshot SHELL, identity-first.
  //
  // :id is the DURABLE identity (monitored_positions.id), ?account is
  // REQUIRED — no silent fallback to the selected account, because a deep
  // link minted under one account must not be answered from another. Wrong
  // account and not-found are the same 404 on purpose: a probe must not
  // learn that the id exists. Everything the shell cannot vouch for is
  // status:"unknown", never a default.
  router.get('/position/:id/cockpit', async (req, res) => {
    try {
      const { cockpitSnapshot } = await import('../services/cockpit-snapshot.js')
      const scope = requestedAccount(db, req)
      const out = cockpitSnapshot(db, req.params.id, scope)
      // PHASE 2: market state from the cached symbol-hours schedule — the same
      // helper /state/positions uses. Best effort; an unknown stays null.
      if (out.status === 200) {
        try {
          const { isSymbolOpenCached } = await import('../services/symbol-hours.js')
          const o = isSymbolOpenCached(db, out.body.position.symbol)
          out.body.position.marketOpen = !!o.open
          out.body.position.marketSource = o.source || null
        } catch { /* stays null */ }
      }
      // PHASE 3: real bars + indicators through the EXISTING chart data path
      // (the same wsGetTrendbarsBatch call POST /actions/chart makes — no new
      // kind of broker traffic, and only on this explicit snapshot request,
      // never on a tick). Failure is a status on the bars block, not a 500:
      // the identity/position/account facts above are still good.
      if (out.status === 200) {
        const timeframe = /^[0-9]+[mhd]$/.test(String(req.query.timeframe || '')) ? String(req.query.timeframe) : '15m'
        const lookbackH = Math.min(168, Math.max(1, Number(req.query.lookback) || 48))
        const { buildBarsAndIndicators, barCountFor } = await import('../services/cockpit-bars.js')
        const sinceMs = Date.now() - lookbackH * 3_600_000
        let fetched = []
        let fetchError = null
        try {
          const { getCtraderCreds, ensureSymbolMap } = await import('../lib/ctrader-creds.js')
          const { wsGetTrendbarsBatch } = await import('../lib/ctrader-ws.js')
          const creds = getCtraderCreds(db)
          if (!creds.ready) throw new Error('cTrader not connected')
          const symbolId = (await ensureSymbolMap(db, creds))[out.body.position.symbol]
          if (!symbolId) throw new Error(`no symbol id for ${out.body.position.symbol}`)
          const count = barCountFor(timeframe, lookbackH * 3_600_000)
          const byPeriod = await wsGetTrendbarsBatch(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId, [timeframe], count, 30_000)
          fetched = byPeriod[timeframe] || []
        } catch (err) {
          fetchError = err.message
        }
        const built = buildBarsAndIndicators(fetched, { timeframe, sinceMs, fetchError })
        out.body.bars = built.bars
        out.body.indicators = built.indicators
        if (built.bars.status === 'unavailable') {
          out.body.advisories.push({ kind: 'bars', detail: `bars unavailable: ${built.bars.detail || 'unknown reason'}` })
        }
      }
      res.status(out.status).json(out.body)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /state/position/:id/cockpit/explain — PHASE 9: generate the OPTIONAL
  // model explanation for this position's CURRENT evidence revision.
  //
  // Deliberately a separate, explicit call rather than part of the snapshot:
  // the snapshot is a read path that repaints, and the prompt forbids calling a
  // model on a tick. This route is the only place a model is contacted, it is
  // idempotent per revision (cached), and it can only ever return an
  // explanation — with the flag off, no key, a bad answer or a network failure
  // it returns the deterministic text and says why in `reason`. It writes no
  // order state of any kind.
  router.post('/position/:id/cockpit/explain', async (req, res) => {
    try {
      const { cockpitSnapshot } = await import('../services/cockpit-snapshot.js')
      const scope = requestedAccount(db, req)
      const out = cockpitSnapshot(db, req.params.id, scope)
      if (out.status !== 200) return res.status(out.status).json(out.body)
      const { generateExplanation } = await import('../services/cockpit-explain.js')
      const explanation = await generateExplanation(db, out.body, { force: req.body?.force === true })
      res.json({ explanation, revision: out.body.meta.revision })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

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
    //
    // ENRICH FROM THE POSITION'S OWN ACCOUNT (owner 04-08-2026: "floating
    // table > computation of summation and individual P/L and TP/SL missing
    // again"). The global cache holds ONE account's snapshot — whichever was
    // selected when the monitor last ran — so every row belonging to any other
    // account matched nothing and rendered "—" for P&L, price and the daily
    // bar. Measured on production the same day: of 21 open positions, only the
    // 6 on account 47790949 carried numbers.
    //
    // Each account now caches its own snapshot (actions.js), and a row is
    // enriched from ITS account's cache. The global key stays as the fallback
    // for a row with no account_id and for a database written before this.
    const snapById = new Map()          // accountId → { positions: Map, at }
    let globalSnap = { positions: new Map(), at: null }
    const readSnap = (key) => {
      const positions = new Map()
      let at = null
      try {
        const snap = JSON.parse(getState(db, key) || 'null')
        at = snap?.fetchedAt ?? null
        for (const p of snap?.account?.positions || []) {
          if (p?.positionId != null) positions.set(String(p.positionId), p)
        }
      } catch { /* an unreadable cache enriches nothing; it never throws the list away */ }
      return { positions, at }
    }
    globalSnap = readSnap('broker_snapshot_cache_json')
    for (const id of new Set(rows.map(r => (r.account_id == null ? null : String(r.account_id))))) {
      if (id == null) continue
      const s = readSnap(`acct:${id}:broker_snapshot_cache_json`)
      // Fall back per account, not once globally: an account with no cache of
      // its own is better served by the shared one than by nothing, and an
      // account WITH one must never be read from another account's.
      snapById.set(id, s.positions.size ? s : globalSnap)
    }
    let isOpenFn = null
    try { isOpenFn = (await import('../services/symbol-hours.js')).isSymbolOpenCached } catch { isOpenFn = null }
    const enriched = rows.map(r => {
      let market_open = null, market_source = null
      try {
        if (isOpenFn) { const o = isOpenFn(db, r.symbol); market_open = !!o.open; market_source = o.source || null }
      } catch { market_open = null }
      const src = (r.account_id != null ? snapById.get(String(r.account_id)) : null) ?? globalSnap
      const sp = r.ctrader_position_id != null ? src.positions.get(String(r.ctrader_position_id)) : null
      return {
        ...r, market_open, market_source,
        live_pnl: sp?.pnl ?? sp?.netPnl ?? null,
        live_pnl_at: sp ? src.at : null,
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
    // positions' table"). legacyRows says how many of these rows carry no
    // account_id — they are INCLUDED, matching the convention used by risk.js
    // and buildPerfLedger, and counted so the count can be stated rather than
    // left as a silent assumption.
    res.json({
      positions: enriched,
      // The SHARED cache's fetch time. Per-account caches refresh at their own
      // moments, so each row carries its own `live_pnl_at` rather than being
      // stamped with one page-level timestamp that would be wrong for most of
      // them.
      snapshotAt: globalSnap.at,
      accountId: scope.all ? 'all' : (scope.accountId ?? null),
      scoped: acct.active,
      legacyRows: acct.active ? countUnattributed(db, 'monitored_positions', "status = 'active'") : 0,
      scope: scopeReport(scope, scopeCoverage(db, {
        table: 'monitored_positions', scope, extraWhere: "status = 'active'",
      })),
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
      // v2 (01-08): one staircase PER ACCOUNT — this reports each enabled
      // account's own baseline/hwm/floor/halt from the state the ratchet
      // itself last recorded. Cheap and side-effect free: no broker call, no
      // ratchet run, nothing armed or disarmed.
      let ids = []
      try { ids = db.prepare('SELECT account_id FROM accounts WHERE enabled = 1').all().map(r => String(r.account_id)) } catch { ids = [] }
      const accounts = ids.map(id => {
        const st = loadRatchetState(db, id)
        const balance = getAccountBalance(db, id)
        const step = cfg.stepUsd > 0 ? Number(cfg.stepUsd) : autoStepUsd(balance)
        const floor = st?.floor ?? null
        const hwm = st?.hwm ?? null
        return {
          accountId: id,
          balance,
          step,
          state: st,
          equity: st?.lastEquity ?? null,
          headroomFromFloor: floor != null && hwm != null ? Math.round((hwm - floor) * 100) / 100 : null,
          halted: st?.halt === true,
          keepOff: st?.keepOff === true,
          hasTriggered: !!st?.lastTriggerAt,
          lastTriggerAt: st?.lastTriggerAt ?? null,
        }
      })
      res.json({
        config: cfg,
        floorAction: cfg.floorAction,
        accounts,
        // v2 never touches this flag — reported so a reader can verify that.
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
  // GET /state/risk-reassess — the last "Re-Risk" result, plus which providers
  // this agent actually has a key for (so the UI can disable a choice that
  // cannot work instead of failing after the click). Owner: "Result below the
  // re-risk include last date/time of re-risk (watchlist symbol number)".
  router.get('/risk-reassess', async (_req, res) => {
    try {
      const { loadLastAssessment, PROPOSABLE } = await import('../services/risk-reassess.js')
      const { availableProviders } = await import('../lib/llm-provider.js')
      const { chooseModel, tierTable, ANTHROPIC_MODEL_CHOICES } = await import('../lib/model-router.js')
      // A risk reassessment is the doc's `financial_analysis` — the REASONING
      // tier. Suggesting it (rather than silently using it) keeps the owner's
      // typed choice authoritative while defaulting to the right tier.
      const suggested = chooseModel({ type: 'risk_reassess' })
      // The OpenAI options ARE this agent's three configured tiers, so the
      // dropdown offers exactly the models the operator set on Railway rather
      // than a hardcoded list that would drift out of date. Duplicates are
      // collapsed (an unconfigured PREMIUM/REASONING resolves to the DEFAULT
      // model, and offering the same id three times is noise).
      const tiers = tierTable()
      const seen = new Set()
      const openaiOptions = []
      for (const [tier, r] of Object.entries(tiers)) {
        if (seen.has(r.model)) continue
        seen.add(r.model)
        openaiOptions.push({ model: r.model, tier, source: r.source })
      }
      const { loadRiskConfig } = await import('../services/risk.js')
      const { loadRiskConfigChanges } = await import('../services/risk-config-history.js')
      const liveRisk = loadRiskConfig(db)
      res.json({
        last: loadLastAssessment(db),
        providers: availableProviders(),
        suggestedModel: { openai: suggested.model, tier: suggested.tier },
        modelOptions: { openai: openaiOptions, anthropic: ANTHROPIC_MODEL_CHOICES },
        proposable: Object.fromEntries(
          Object.entries(PROPOSABLE).map(([k, v]) => [k, { label: v.label, min: v.min, max: v.max, kind: v.kind }])
        ),
        // THE LIVE VALUES, so the proposal table can COMPARE instead of claim.
        //
        // Every number in that table used to come from the stored assessment
        // record, frozen at apply time, and the footer asserted "the settings
        // below hold these values now" without ever reading them back. Edit a
        // field afterwards and the row went on insisting its own number was
        // current while the field below disagreed — which is exactly what the
        // owner found by searching for the daily loss limit.
        live: Object.fromEntries(
          Object.keys(PROPOSABLE).map(k => [k, liveRisk?.[k] ?? null])
        ),
        // key -> { at, from, to, by }. Lets a superseded row say WHEN it
        // stopped holding rather than just that it does not.
        changed: loadRiskConfigChanges(db),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Every risk setting, global and per account, side by side (owner
  // 2026-08-04). The page could only show ONE account's effective settings at
  // a time, so "does this account run tighter than that one, and where?" could
  // not be answered without switching and remembering.
  router.get('/risk-matrix', async (_req, res) => {
    try {
      const { buildRiskMatrix } = await import('../services/risk-matrix.js')
      res.json(buildRiskMatrix(db))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

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

  router.get('/correlation', async (req, res) => {
    try {
      const { CORRELATION_CLUSTERS, clusterExposure } = await import('../services/correlation.js')
      const { loadStoredMatrix, loadPreviousMatrix, topPairs, correlationShifts } = await import('../services/correlation-matrix.js')
      // S1 batch 6. Cluster exposure is a CONCENTRATION reading — "how much
      // of one correlated basket am I holding". Summed across accounts it
      // overstates it for every account individually: three accounts each
      // holding one EUR leg read as a three-leg EUR cluster that no account
      // actually has. The risk this panel exists to show is per-account.
      const scope = requestedAccount(db, req)
      const acct = accountWhere(scope, 'account_id')
      const positions = db.prepare(
        `SELECT symbol, side FROM monitored_positions
          WHERE status = 'active'${acct.active ? ` AND ${acct.where}` : ''}`
      ).all(...acct.params)
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
        liveMatrix: (() => {
          const mcfg = loadCorrelationMatrixConfig(db)
          let prev = null
          try { prev = loadPreviousMatrix(db) } catch { /* first run */ }
          const builtAt = matrix?.builtAt || matrix?.computedAt || null
          const ageMin = builtAt ? Math.round((Date.now() - Date.parse(builtAt)) / 60_000) : null
          return {
            config: mcfg,
            // `computedAt` kept for the existing card; `builtAt` is what
            // computeAndStoreMatrix actually writes and what the age uses.
            computedAt: matrix?.computedAt || builtAt,
            builtAt,
            ageMin,
            // A matrix past maxAgeMin is IGNORED by the gate (fail open). The
            // card said "computed 4 hours ago" and left the reader to know
            // that; now it says the gate is not using it.
            stale: ageMin != null && ageMin > mcfg.maxAgeMin,
            symbols: matrix?.symbols?.length || 0,
            // THE CONTENTS, which were never surfaced. Owner: "The
            // correlation card doesn't update when market shifted" — it could
            // not, because only the timestamp and a count ever reached it.
            pairs: matrix ? topPairs(matrix, { min: Math.min(0.5, mcfg.threshold), limit: 20 }) : [],
            shifts: correlationShifts(matrix, prev, { threshold: mcfg.threshold, limit: 20 }),
            previousBuiltAt: prev?.builtAt || null,
          }
        })(),
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        scoped: acct.active,
        scope: scopeReport(scope, scopeCoverage(db, {
          table: 'monitored_positions', scope, extraWhere: "status = 'active'",
        })),
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
    // WHOSE lessons. This route answered about every account at once, so the
    // Performance page's debrief card showed the same rows no matter which
    // account was selected — the identical failure lib/account-scope.js was
    // written for, in the one section that had been missed. trade_postmortems
    // has no account_id, so the scope rides on the trade it belongs to.
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 't.account_id')
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
         WHERE (t.id IS NULL OR t.status <> 'rejected')${acct.active ? ` AND ${acct.where}` : ''}
         ORDER BY pm.id DESC LIMIT ?`
      ).all(...acct.params, limit)
    } catch { /* table appears on first boot after migration */ }
    try {
      rows = rows.map(r => ({ ...r, bars: safeParse(r.bars_json), bars_json: undefined }))
    } catch { /* keep raw rows */ }
    try {
      stats = postmortemStats(db, 30, { accountId: acct.active ? scope.accountId : null })
    } catch { /* table missing on a very old DB — stats stay empty */ }
    // ¶D·4 — "I didn't see the lesson learnt!", twelve minutes after a NAS100
    // short lost $1,013.08. There could not be one yet: a verdict needs 5 bars
    // of aftermath, which on a 10-minute chart is fifty minutes away. This
    // route only ever returned trades that already HAD a lesson, so one still
    // in its waiting period was simply absent — and absent reads as "nothing
    // was learned", not "not yet". Now it says which, and when.
    let pending = { rows: [], waiting: 0, ineligible: 0 }
    try {
      pending = pendingLessons(db, { accountId: acct.active ? scope.accountId : null })
    } catch { /* never block the lessons themselves on the pending list */ }
    res.json({
      rows, stats, pending,
      accountId: scope.all ? 'all' : (scope.accountId ?? null),
      scoped: acct.active,
    })
  })
  function safeParse(s) { try { return JSON.parse(s || 'null') } catch { return null } }

  // -----------------------------------------------------------------------
  // GET /state/unresolvable-plan — the dry run for the unknown-P&L write-off,
  // as something the owner can actually LOOK AT.
  //
  // #513 shipped the machinery and told the owner to "see the dry-run plan
  // against your own rows first" — then gave them a JS call they have no way to
  // make: nothing invokes sweepUnresolvable, there is no route, and there is no
  // Node REPL against production. The safety step the whole design rested on was
  // not performable. That gap was mine.
  //
  // THIS ROUTE CANNOT WRITE, structurally rather than by promise. It calls
  // findUnresolvableCandidates, which is a bare SELECT — NOT sweepUnresolvable
  // with dryRun:true, because a boolean that a future edit (or a query param)
  // could flip is a weaker guarantee than never importing the writing function
  // at all. Marking rows unresolvable stays a deliberate act, not a page load.
  //
  // `hasExitPrice` is the field to read first: those rows could have a REAL
  // figure computed rather than being written off, and if there are many of
  // them the honest answer is to compute, not to stop waiting.
  // -----------------------------------------------------------------------
  // GET /state/unknown-pnl — WHICH rows are holding the desk, and why.
  //
  // Owner, 2026-07-31: three days of "unknown_daily_pnl … 7 closed trade(s)
  // today have no realised P&L" on every signal. The veto is right to block;
  // what was missing is the next sentence. This route answers it per row —
  // no_broker_position_id (can never be filled: the backfill matches deals by
  // position id), unattributed_account (blocks every account AND can never be
  // written off, because the write-off candidate query filters on account),
  // account_not_enabled (no backfill pass ever runs for it), or the ordinary
  // backfill_pending — plus a count of the close_reason that produced them, so
  // a recurring daily cause is named rather than inferred.
  //
  // Read-only: a SELECT and two in-memory lists. It changes no gate.
  router.get('/unknown-pnl', async (req, res) => {
    try {
      const { unknownPnlReport } = await import('../services/unknown-pnl-report.js')
      const { exhaustedAccounts } = await import('../services/pnl-backfill.js')
      const { loadRiskConfig } = await import('../services/risk.js')
      let enabled = []
      try {
        const { getEnabledAccounts } = await import('../services/account-registry.js')
        enabled = getEnabledAccounts(db).map(a => String(a.account_id))
      } catch { /* unknown registry → every row's account counts as enabled */ }
      const cfg = (() => { try { return loadRiskConfig(db) } catch { return {} } })()
      res.json(unknownPnlReport(db, {
        graceMin: cfg.unknownPnlGraceMin,
        enabledAccounts: enabled,
        exhaustedAccounts: exhaustedAccounts(),
      }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/veto-breakdown — WHICH guard eats HOW MANY entries (owner,
  // 2026-08-01: the data-backed version of "should I loosen things to trade
  // more"). Counts risk_events vetoes grouped by reason head plus upstream
  // decision_log skips per stage, over ?days (default 7, max 90), optionally
  // ?account=… scoping the upstream rows. Read-only.
  // GET /state/campaign — the one screen that answers "how is the experiment
  // going, and how much rope is left". Owner 07-08: "how to feedback visually".
  //
  // Deliberately ONE object with a handful of numbers rather than another
  // table. The concentrate-to-prove plan exists because there is already too
  // much to read; adding a tenth dashboard would repeat the mistake it is
  // meant to correct.
  router.get('/campaign', async (req, res) => {
    try {
      const { campaignConfig, campaignReadout } = await import('../services/campaign-stop.js')
      const { loadRiskConfig } = await import('../services/risk.js')
      const scope = req.query.account != null && req.query.account !== '' ? String(req.query.account) : null
      const cfg = campaignConfig(loadRiskConfig(db, scope)?.campaign)
      let realised = null
      if (cfg.armed) {
        try {
          realised = db.prepare(
            `SELECT COALESCE(SUM(net_pnl), 0) AS pnl FROM trades
              WHERE status = 'closed' AND net_pnl IS NOT NULL
                AND REPLACE(closed_at, 'T', ' ') >= REPLACE(?, 'T', ' ')
                AND (account_id = ? OR account_id IS NULL OR ? IS NULL)`
          ).get(cfg.startAt, scope, scope)?.pnl ?? null
        } catch { realised = null }
      }
      // Trades since the campaign started, per strategy — the G2 counter. 25
      // on any one row is what makes a strategy decidable, so this is the
      // number worth watching daily.
      let perStrategy = []
      if (cfg.armed) {
        try {
          perStrategy = db.prepare(
            `SELECT COALESCE(strategy, 'unlabelled') AS strategy, COUNT(*) AS trades,
                    SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) AS wins,
                    ROUND(COALESCE(SUM(net_pnl), 0), 2) AS net
               FROM trades
              WHERE status = 'closed'
                AND REPLACE(closed_at, 'T', ' ') >= REPLACE(?, 'T', ' ')
                AND (account_id = ? OR account_id IS NULL OR ? IS NULL)
              GROUP BY 1 ORDER BY trades DESC`
          ).all(cfg.startAt, scope, scope)
        } catch { perStrategy = [] }
      }
      res.json({
        account: scope,
        ...campaignReadout({ cfg, realisedSinceStart: realised, nowMs: Date.now() }),
        perStrategy,
        // The arming bar, restated here so the page never has to hard-code it.
        decidableAt: 25,
      })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  router.get('/veto-breakdown', async (req, res) => {
    try {
      const { vetoBreakdown } = await import('../services/veto-breakdown.js')
      res.json(vetoBreakdown(db, {
        days: req.query.days,
        account: req.query.account != null && req.query.account !== '' ? String(req.query.account) : null,
        // Capped by default — this route was returning half a megabyte per
        // poll (#122). `truncated` in the response says what was left out.
        limit: req.query.limit,
      }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/opportunity-funnel — the §70.8 funnel in ONE unit.
  //
  // veto-breakdown above answers "which guard eats entries" and counts
  // EVALUATIONS. This answers "of the setups we found, how many reached the
  // market", and counts OPPORTUNITIES — 8 re-evaluations of one setup being
  // one row, not eight. Measured 05-08-2026: the scanner re-scores a setup
  // 7.9x, which is why every previous approved-minus-landed subtraction
  // produced an alarming number that was a unit error.
  //
  // ?days (fractional allowed) · ?account · ?silent=1 for the named list of
  // approvals that produced nothing. Read-only.
  router.get('/opportunity-funnel', async (req, res) => {
    try {
      const { opportunityFunnel, silentOpportunities } = await import('../services/opportunity-funnel.js')
      const opts = {
        days: req.query.days,
        account: req.query.account != null && req.query.account !== '' ? String(req.query.account) : null,
      }
      const payload = opportunityFunnel(db, opts)
      if (req.query.silent === '1' || req.query.silent === 'true') {
        // Capped: this is a diagnostic list, not a feed, and an unbounded one
        // is how /state routes started returning half a megabyte (#122).
        payload.silent = silentOpportunities(db, opts).slice(0, 200)
        payload.silentTruncated = payload.silent.length === 200
      }
      res.json(payload)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/route-timings — per-route p50/p90/p99/max and average payload
  // size, since process start.
  //
  // #125 asked where the reported 8-29s goes. It goes nowhere measurable
  // today — see route-timing.js for the numbers — so the deliverable is not a
  // speedup, it is a recorder, so the NEXT episode has data instead of a
  // reconstruction. Sorted worst-p90 first.
  // -----------------------------------------------------------------------
  router.get('/route-timings', async (req, res) => {
    try {
      const { routeTimings } = await import('../services/route-timing.js')
      res.json(routeTimings({ minSamples: Number(req.query.minSamples) || 1 }))
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // GET /state/fx-coverage?symbols=AUDPLN,EURJPY — can the sizer convert?
  //
  // Owner, 2026-08-03: "root cause usd_per_lot_unknown". It was the largest
  // veto bucket of the day (1,353) and the cause could not be settled from
  // outside, because the deciding input — the scanned-closes rates map — was
  // invisible. This runs the SAME `usdRate` the risk gate runs, so it cannot
  // drift into telling a comfortable story the sizer disagrees with.
  //
  // `?symbols=` defaults to the symbols that bucket actually named, so the
  // default call answers the question that was asked. Read-only.
  router.get('/fx-coverage', async (req, res) => {
    try {
      const { fxCoverage, missingLegsFor } = await import('../services/fx-coverage.js')
      const { scanRates } = await import('../services/risk.js')
      const probes = String(req.query.symbols || 'AUDPLN,EURJPY,AUDCAD,EURGBP,EURAUD')
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 40)
      const rates = scanRates(db)
      const out = fxCoverage(rates, probes)
      res.json({
        ...out,
        // Named legs, not just "PLN does not resolve" — a diagnosis nobody
        // can act on is not a diagnosis.
        fixes: out.unresolvable.map(c => missingLegsFor(c, rates)),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/loss-cap — the last per-position loss-cap sweep, per account.
  //
  // Owner, 2026-08-03: "check the derived pnl coverage". It could not be
  // checked, because it existed only as a console line printed when there were
  // closes or errors. `covered` / `missingPrice` are the numbers that say
  // whether the cap is watching anything at all: a pass that covers 2 of 11
  // positions is nine unprotected positions, and it must not be able to look
  // the same as a quiet, healthy pass. Read-only.
  router.get('/loss-cap', (req, res) => {
    try {
      const raw = db.prepare("SELECT value FROM agent_state WHERE key = 'loss_cap_last_pass'").get()?.value
      if (!raw) return res.json({ pass: null, note: 'no sweep recorded yet' })
      const pass = JSON.parse(raw)
      const covered = (pass.perAccount || []).reduce((s, a) => s + (a.covered || 0), 0)
      const missing = (pass.perAccount || []).reduce((s, a) => s + (a.missingPrice || 0), 0)
      res.json({
        pass,
        // Rolled up here rather than in the sweep so the stored row stays the
        // raw measurement and the arithmetic is visible at the point of use.
        coverage: {
          covered,
          missingPrice: missing,
          pct: covered + missing > 0 ? Math.round((covered / (covered + missing)) * 1000) / 10 : null,
        },
        ageSec: pass.at ? Math.round((Date.now() - Date.parse(pass.at)) / 1000) : null,
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/ws05 — Live Trade Management and Exit, as one workstream.
  //
  // §70.1. Every part of WS-05 already ran; nothing could be asked whether the
  // workstream was healthy, or by what authority each part acts. Read-only by
  // design — a workstream that also acted would be one more writer on the same
  // stops, which §36.2.3 forbids in as many words.
  // -----------------------------------------------------------------------
  router.get('/ws05', async (req, res) => {
    try {
      const { ws05Health } = await import('../services/workstream-ws05.js')
      res.json(ws05Health(db))
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // -----------------------------------------------------------------------
  // GET /state/dispositions — §70.8. What became of every approval, and how
  // long the gate's verdict took to reach the broker.
  //
  // `dropped` is the answer decision-audit.js could never give: not "the
  // counts disagree by 17" but seventeen rows with ids, symbols and times.
  // -----------------------------------------------------------------------
  router.get('/dispositions', async (req, res) => {
    try {
      const { dispositionReport } = await import('../services/opportunity-disposition.js')
      const { housekeepingStatus } = await import('../services/housekeeping-run.js')
      res.json({
        ...dispositionReport(db, {
          days: req.query.days,
          account: req.query.account != null && req.query.account !== '' ? String(req.query.account) : null,
        }),
        // WHY IS `counts` EMPTY? Before this, that question had no answer on
        // any read route — the sweep runs inside housekeeping, and housekeeping
        // only ever spoke to the console. An empty report now says whether the
        // pass has run, when it next can, and which steps failed.
        housekeeping: housekeepingStatus(db),
      })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // -----------------------------------------------------------------------
  // GET /state/config-proposals — C-1. What the record says the settings
  // should be, with the arithmetic attached. READ-ONLY BY CONSTRUCTION: the
  // controller has no write path and a test asserts it never gains one.
  //
  // Live accounts are excluded unless ?includeLive=1 — a controller's first
  // published opinion should not be about the account that can lose real
  // money, and reading it should be a decision.
  // -----------------------------------------------------------------------
  router.get('/config-proposals', async (req, res) => {
    try {
      const { configProposals } = await import('../services/config-controller.js')
      res.json(configProposals(db, {
        days: Number(req.query.days) || 30,
        minSample: Number(req.query.minSample) || undefined,
        includeLive: req.query.includeLive === '1' || req.query.includeLive === 'true',
      }))
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // -----------------------------------------------------------------------
  // GET /state/account-chrome — the account facts that belong in the page
  // frame rather than on a page (owner §5502·C).
  //
  // ONE READ, because the alternative is the chrome making five calls on every
  // page and the numbers on screen arriving from different moments. Cheap
  // enough for that: per account it is four indexed queries and no broker
  // round-trip — every figure comes from state the loop already wrote.
  // -----------------------------------------------------------------------
  router.get('/account-chrome', async (req, res) => {
    try {
      const { accountChrome, defaultChromeAccount } = await import('../services/account-chrome.js')
      const accounts = accountChrome(db)
      res.json({ accounts, defaultAccountId: defaultChromeAccount(db, accounts), at: new Date().toISOString() })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // -----------------------------------------------------------------------
  // GET /state/management-reflection — what the MANAGEMENT of recent trades
  // did, and what that says about how this desk manages trades (§70.10).
  //
  // A SCOREBOARD, not a survey. Every row is built from exits a writer CAUSED
  // — the position would still have been open without its action — priced in R
  // so symbols are comparable. Which management rule banks money and which one
  // gives it away, per writer.
  //
  // Still no tuning here: the "controlled" in "controlled adaptation" is the
  // step where a human or the lessons tuner decides.
  // -----------------------------------------------------------------------
  router.get('/management-reflection', async (req, res) => {
    try {
      const { managementScoreboard } = await import('../services/management-reflection.js')
      const scope = requestedAccount(db, req)
      const days = Math.min(90, Math.max(1, Number(req.query.days) || 14))
      res.json(managementScoreboard(db, { days, accountId: scope.all ? null : (scope.accountId ?? null) }))
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // GET /state/trade-gates — why is this strategy not trading?
  //
  // Owner, 05-08-2026: "are there too many same exactly strategy-fields
  // switches … make sure all the strategies display on the UI are not
  // conflicting with duplicate switches and result in no trading." There are
  // NINE ANDed switches across four screens and no screen held all of them, so
  // the answer to "why is nothing trading" was a tour of the UI. This is that
  // tour, done once, server-side, naming the FIRST gate that is off.
  //
  // The Pipeline matrix and the Liveness card both read THIS, which is what
  // stops the top and the bottom of the page disagreeing.
  router.get('/trade-gates', async (req, res) => {
    try {
      const { tradeGateMatrix, tradeGateChain } = await import('../services/trade-gate-resolver.js')
      const scope = requestedAccount(db, req)
      const acct = scope.all ? null : (scope.accountId ?? null)
      if (req.query.strategy) {
        return res.json(tradeGateChain(db, { accountId: acct, strategy: String(req.query.strategy) }))
      }
      res.json(tradeGateMatrix(db, { accountId: acct }))
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // GET /state/trade-consistency — does the closed book agree with itself?
  //
  // Go-live Phase 0 (docs/go-live-plan.md §4). Measured 05-08-2026, 56 of 190
  // decidable closed rows carried a net_pnl whose sign contradicted their own
  // side/entry/exit, and nothing in the system reported it. The gate is asked
  // to certify win% and PF off this table; it should be possible to ask how
  // much of it is self-consistent before betting on the answer.
  router.get('/trade-consistency', async (req, res) => {
    try {
      const { inconsistentTrades, consistencySummary, inconsistencyLine } =
        await import('../services/trade-consistency.js')
      const scope = requestedAccount(db, req)
      const acct = scope.all ? null : (scope.accountId ?? null)
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
      const rows = inconsistentTrades(db, { accountId: acct, limit })
      res.json({
        ok: true,
        accountId: acct,
        scope: scope.all ? 'all' : 'account',
        summary: consistencySummary(db, { accountId: acct }),
        rows: rows.map(r => ({
          id: r.id, symbol: r.symbol, side: r.side,
          entry: r.entry_price, exit: r.exit_price, netPnl: r.net_pnl,
          move: r.check.move, accountId: r.account_id,
          closedAt: r.closed_at, closeReason: r.close_reason,
          line: inconsistencyLine(r),
        })),
      })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  router.get('/unresolvable-plan', async (req, res) => {
    try {
      const { findUnresolvableCandidates, exhaustedAccountsFromLedger, DEFAULT_UNRESOLVABLE_HORIZON_DAYS } =
        await import('../services/mark-unresolvable.js')
      const { exhaustedAccounts } = await import('../services/pnl-backfill.js')
      const { unresolvedPnlSince } = await import('../services/unresolved-pnl.js')
      const { fxDayStartSql } = await import('../services/risk.js')

      const raw = Number(req.query.horizonDays)
      // Bounded, and a floor of 1 day: a zero/negative horizon would list every
      // unfilled row including this minute's closes, which is the opposite of
      // the age evidence the rule requires.
      const horizonDays = Number.isFinite(raw) && raw > 0
        ? Math.min(365, Math.max(1, Math.round(raw)))
        : DEFAULT_UNRESOLVABLE_HORIZON_DAYS

      // The "we tried and gave up" half of the evidence. In-memory on the
      // running agent, so a freshly restarted process reports none — which
      // correctly yields an EMPTY plan rather than a confident write-off list.
      // TWO SOURCES, UNIONED. The in-memory ladder is erased by every restart,
      // and this service redeploys on every push to main — so on its own it
      // reported "nothing qualifies" while the ledger held rows attempted eight
      // times (measured on production, 04-08-2026). `pnl_attempts` is per row
      // and durable, so it answers the same question without depending on how
      // long the process has been up.
      const inMemory = exhaustedAccounts()
      const fromLedger = exhaustedAccountsFromLedger(db)
      const exhausted = [...new Set([...inMemory, ...fromLedger])]
      const plan = findUnresolvableCandidates(db, { horizonDays, exhaustedAccounts: exhausted })

      // What the veto is doing right now, so the plan is read in context: how
      // many rows still BLOCK versus how many have already been written off.
      let blocking = null
      try {
        blocking = unresolvedPnlSince(db, fxDayStartSql(), { accountId: null })
      } catch { /* context only — never fail the plan on it */ }

      res.json({
        ok: true,
        readOnly: true,
        horizonDays,
        exhaustedAccounts: exhausted,
        // Stated out loud: an empty list here is usually "the backfill has not
        // given up on anything", not "there is nothing stuck".
        // WHICH evidence produced the list, named. "The running process gave
        // up" and "the ledger records N failed attempts per row" are different
        // strengths, and a reader deciding whether to write off money data
        // should not have to guess which one they are looking at.
        exhaustedFrom: { inMemory, ledger: fromLedger },
        note: exhausted.length === 0
          ? 'Neither the running backfill nor the persisted attempt counts show a give-up on any account. Nothing qualifies as unknowable yet — this is not the same as nothing being stuck.'
          : `Give-up evidence on ${exhausted.length} account(s)${fromLedger.length ? ` (${fromLedger.length} from persisted attempt counts, which survive restarts)` : ''}; rows below are older than ${horizonDays} days on those accounts.`,
        found: plan.length,
        // hasExitPrice first in the mind of the reader: those rows deserve a
        // computed figure rather than a write-off.
        withExitPrice: plan.filter(c => c.exit_price != null).length,
        plan: plan.map(c => ({
          id: c.id,
          symbol: c.symbol,
          side: c.side,
          accountId: c.account_id,
          closedAt: c.closed_at,
          hasExitPrice: c.exit_price != null,
        })),
        blocking: blocking && {
          stillBlocking: blocking.count,
          alreadyWrittenOff: blocking.unresolvableCount ?? 0,
          oldestClosedAt: blocking.oldestClosedAt ?? null,
          unattributedCount: blocking.unattributedCount ?? 0,
        },
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/duplicate-trades — read-only audit (owner spotted 7 identical
  // AUDUSD rows at the same timestamp in the lesson panel). Reports
  // candidate duplicate CLOSED trade records and how much they'd
  // double-count in Performance/Edge-health stats — never deletes anything.
  // -----------------------------------------------------------------------
  router.get('/duplicate-trades', async (req, res) => {
    try {
      const { findDuplicateTrades } = await import('../services/trade-integrity.js')
      const scope = requestedAccount(db, req)
      res.json({
        ...findDuplicateTrades(db, { scope }),
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        scope: scopeReport(scope, scopeCoverage(db, {
          table: 'trades', scope,
          extraWhere: "status = 'closed' AND entry_price IS NOT NULL AND net_pnl IS NOT NULL",
        })),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/open-duplicates — the same audit as /duplicate-trades, but on
  // positions that are STILL OPEN. The closed-only version correctly reported
  // two historical pairs and was completely blind to a live 0003.HK pair
  // sitting in the book. Detecting a duplicate only once it closes is
  // detecting it after the money is gone.
  router.get('/open-duplicates', async (req, res) => {
    try {
      const { findOpenDuplicates } = await import('../services/trade-integrity.js')
      const scope = requestedAccount(db, req)
      res.json({
        ...findOpenDuplicates(db, { scope }),
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        scope: scopeReport(scope, scopeCoverage(db, {
          table: 'monitored_positions', scope, extraWhere: "status = 'active'",
        })),
      })
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
      const { protectionFreshness, maxAgeSecFrom } = await import('../services/protection-freshness.js')
      // Reconcile — and so the audit — runs every 3rd loop.
      const loopMin = Number(getState(db, 'loop_interval_min'))
      const expectedSec = (Number.isFinite(loopMin) && loopMin >= 1 ? loopMin : 5) * 60 * 3
      const last = lastProtectionAudit(db, { expectedSec })
      // `freshness` is the SAME verdict the heartbeat panel now shows, computed
      // from the same function — so this route and /state/heartbeats can no
      // longer disagree about whether the audit's answer is current. They did,
      // on 2026-08-06: "ok" here, 174,009 seconds old there.
      res.json({
        ...last,
        freshness: protectionFreshness({
          at: last.at, lastAttemptAt: last.lastAttemptAt, lastAttemptError: last.lastAttemptError,
          maxAgeSec: maxAgeSecFrom(db),
        }),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/exit-counterfactual — Phase 7. What would a DIFFERENT exit rule
  // have returned over the trades this system actually decided to open?
  //
  // Read-only, and it REFUSES to report on too small a sample: `verdict:
  // 'INSUFFICIENT'` names the shortfall rather than printing a profit factor
  // that would read exactly as authoritative as one that had earned it.
  // ?days=30 &minSample=30 &allOrigins=1 (the last is NOT evidence of edge).
  router.get('/exit-counterfactual', async (req, res) => {
    try {
      const { exitCounterfactual } = await import('../services/exit-counterfactual.js')
      const days = Math.min(365, Math.max(1, Number(req.query.days) || 30))
      const minSample = Math.max(1, Number(req.query.minSample) || undefined || 30)
      const scope = requestedAccount(db, req)
      res.json(exitCounterfactual(db, {
        days, minSample,
        cleanOnly: String(req.query.allOrigins || '') !== '1',
        accountId: scope.all ? null : (scope.accountId ?? null),
      }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/lot-size-parity — where the broker's definition of a lot and our
  // hardcoded contractSize() table disagree, and by how much.
  //
  // This answers the question the 2026-08-06 audit could not: WHICH SIDE IS
  // WRONG. A row with ratio 60 means an adopted position on that symbol would be
  // recorded as 60× its real size, and that figure feeds the margin gate.
  // ?symbols=0003.HK,0005.HK to check named symbols even if never recorded.
  router.get('/lot-size-parity', async (req, res) => {
    try {
      const { lotSizeParity } = await import('../lib/lot-size-registry.js')
      const raw = String(req.query.symbols || '').trim()
      const symbols = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : null
      res.json(lotSizeParity(db, symbols))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/sizing-parity — does our arithmetic agree with the broker's?
  //
  // For every closed trade, the P&L our sizing model predicts against the P&L
  // the broker actually paid. A symbol whose `impliedFactor` sits at an FX
  // rate has a wrong quote currency, and the factor names which one. This is
  // the check that would have caught JPN225 on the day instead of three days
  // later via a coincidence — see services/sizing-parity.js.
  //
  // ?days (default 30) · ?account · ?minTrades · ?tolerance
  // -----------------------------------------------------------------------
  router.get('/sizing-parity', async (req, res) => {
    try {
      const { sizingParity } = await import('../services/sizing-parity.js')
      const days = Math.max(1, Math.min(365, Number(req.query.days) || 30))
      const acct = req.query.account == null || req.query.account === '' ? null : String(req.query.account)
      const trades = db.prepare(`
        SELECT symbol, side, entry_price, exit_price, volume, net_pnl, closed_at
        FROM trades
        WHERE status = 'closed' AND net_pnl IS NOT NULL AND exit_price IS NOT NULL
          AND closed_at >= datetime('now', ?)
          AND (? IS NULL OR account_id = ?)
      `).all(`-${days} days`, acct, acct)
      // The SAME rates table the sizing path builds (sizing-preview.js:33-41),
      // read the same way — deliberately, so a currency the sizer cannot
      // convert is one this readout cannot convert either. An audit with
      // better inputs than the thing it audits reports a health the system
      // does not have.
      const rates = {}
      try {
        const last = JSON.parse(getState(db, 'last_scan_results') || 'null')
        for (const r of (last?.scans || last?.rows || [])) {
          const px = r.price ?? r.close
          if (r.symbol && px != null) rates[String(r.symbol).toUpperCase()] = Number(px)
        }
      } catch { /* no scan yet — conversions simply resolve to null */ }
      res.json({
        ...sizingParity(trades, {
          rates,
          minTrades: Number(req.query.minTrades) || undefined,
          tolerance: Number(req.query.tolerance) || undefined,
        }),
        days,
        accountId: acct,
        ratesAvailable: Object.keys(rates).length,
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/exit-price-suspects — exit prices wrong in MAGNITUDE.
  //
  // The companion to /state/trade-consistency, which asks about DIRECTION.
  // A row can point the right way and still be wrong by a factor of fifty,
  // and until 08-08-2026 nothing looked for that — so the backfill's repair,
  // gated on the sign flag alone, never touched those rows.
  //
  // Needs no contract table or FX rate: each symbol's money-per-point is
  // derived from its own trades. See services/exit-price-suspects.js on why
  // that makes it blind to SYSTEMATIC error (which /state/sizing-parity
  // covers) and good at per-row error.
  //
  // ?days=90 · ?account · ?tolerance=3 · ?minTrades=4 · ?sweep=1 to stamp
  // -----------------------------------------------------------------------
  router.get('/exit-price-suspects', async (req, res) => {
    try {
      const { exitPriceSuspects, sweepExitPriceSuspects } = await import('../services/exit-price-suspects.js')
      const days = Math.max(1, Math.min(3650, Number(req.query.days) || 90))
      const acct = req.query.account == null || req.query.account === '' ? null : String(req.query.account)
      const opts = {
        tolerance: Number(req.query.tolerance) || undefined,
        minTrades: Number(req.query.minTrades) || undefined,
      }
      // `sweep=1` stamps exit_price_suspect so the backfill's repair can find
      // them. Opt-in rather than automatic on a GET: a read that silently
      // writes is how an audit becomes an actor nobody asked for.
      const swept = (req.query.sweep === '1' || req.query.sweep === 'true')
        ? sweepExitPriceSuspects(db, { accountId: acct, days, ...opts })
        : null
      const rows = db.prepare(`
        SELECT id, symbol, side, entry_price, exit_price, volume, net_pnl, closed_at, close_reason
          FROM trades
         WHERE status = 'closed' AND net_pnl IS NOT NULL
           AND entry_price IS NOT NULL AND exit_price IS NOT NULL
           AND closed_at >= datetime('now', ?)
           AND (account_id = ? OR ? IS NULL)
      `).all(`-${days} days`, acct, acct)
      res.json({ ...exitPriceSuspects(rows, opts), days, accountId: acct, swept })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/go-live-readiness — the 12-08 question, in one read.
  //
  // Owner, 08-08-2026: "building is a single /state/go-live-readiness read."
  //
  // Returns GO / NO / **UNMEASURABLE**. That third verdict is the whole point:
  // a pass/fail gate would have reported this account's PF 0.84 as a clean NO
  // all week while 29.5% of rows contradicted themselves and two thirds had no
  // strategy attached. NO means the edge is not there; UNMEASURABLE means fix
  // the ledger before asking again. See services/go-live-readiness.js.
  //
  // ?days=30 · ?account
  // -----------------------------------------------------------------------
  router.get('/go-live-readiness', async (req, res) => {
    try {
      const { goLiveReadiness } = await import('../services/go-live-readiness.js')
      const { loadGoal } = await import('../services/goal-tracker.js')
      const days = Math.max(1, Math.min(365, Number(req.query.days) || 30))
      const acct = req.query.account == null || req.query.account === '' ? null : String(req.query.account)
      // Every closed row with money, flags and attribution — the integrity
      // check needs the rows it would otherwise exclude, so this deliberately
      // does NOT filter on entry/exit being present the way an edge query
      // would. Filtering them out here is precisely how a dirty record starts
      // looking clean.
      //
      // BOTH columns, unmerged: `COALESCE(label_strategy, strategy)` used to
      // collapse them into one field here, and COALESCE only falls through on
      // NULL — not on the string 'other'. A row with strategy='va_breakout'
      // but label_strategy='other' (a strategy with no code in the broker
      // label vocabulary — see trade-labels.js) got 'other' from the
      // COALESCE, and strategyOf() downstream never even saw the column that
      // still had the answer. Selecting both lets strategyOf() do the
      // 'other'-is-absence reasoning it was built for.
      const rows = db.prepare(`
        SELECT id, symbol, side, entry_price, exit_price, volume, net_pnl, closed_at,
               label_strategy, strategy,
               label_timeframe, pnl_price_mismatch, exit_price_suspect
          FROM trades
         WHERE status = 'closed' AND net_pnl IS NOT NULL
           AND closed_at >= datetime('now', ?)
           AND (account_id = ? OR ? IS NULL)
      `).all(`-${days} days`, acct, acct)
      res.json({
        ...goLiveReadiness({ rows, goal: loadGoal(db), nowMs: Date.now(), windowDays: days }),
        accountId: acct,
      })
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
      const scope = requestedAccount(db, req)
      res.json({
        ...findSameSymbolClusters(db, { days, windowMinutes, scope }),
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        scope: scopeReport(scope, scopeCoverage(db, {
          table: 'trades', scope, extraWhere: 'opened_at IS NOT NULL',
        })),
      })
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
      // S1 batch 7. broker_deals carries account_id from the import itself —
      // this is BROKER truth, so an unmatched deal on another account is that
      // account's unreconciled fill, not this one's. Pooling them makes the
      // "unmatched" count read as a bigger reconciliation gap than any single
      // account has.
      const scope = requestedAccount(db, req)
      const acct = accountWhere(scope, 'account_id')
      const clauses = []
      const params = []
      if (only) clauses.push('matched_trade_id IS NULL')
      if (acct.active) { clauses.push(acct.where); params.push(...acct.params) }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
      const rows = db.prepare(`
        SELECT * FROM broker_deals${where}
        ORDER BY closed_at DESC LIMIT ?
      `).all(...params, limit)
      const tot = db.prepare(
        `SELECT COUNT(*) AS all_rows, SUM(matched_trade_id IS NULL) AS unmatched
           FROM broker_deals${acct.active ? ` WHERE ${acct.where}` : ''}`,
      ).get(...acct.params)
      res.json({
        rows, total: tot.all_rows || 0, unmatched: tot.unmatched || 0,
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        scoped: acct.active,
        scope: scopeReport(scope, scopeCoverage(db, { table: 'broker_deals', scope })),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/metrics — latest performance snapshot
  // -----------------------------------------------------------------------
  router.get('/metrics', (req, res) => {
    // S1 batch 5. A performance snapshot is a per-account fact by nature —
    // win rate and profit factor pooled across a demo and a live account
    // describe neither. This is the same shape as the Go-Live card failure,
    // one table over.
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 'account_id')
    const row = db
      .prepare(
        `SELECT * FROM performance_snapshots${acct.active ? ` WHERE ${acct.where}` : ''}
         ORDER BY computed_at DESC LIMIT 1`
      )
      .get(...acct.params)

    res.json({
      metrics: row || null,
      accountId: scope.all ? 'all' : (scope.accountId ?? null),
      scoped: acct.active,
      scope: scopeReport(scope, scopeCoverage(db, { table: 'performance_snapshots', scope })),
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/action-log — the owner's audit trail (every POST /actions).
  // ?limit=N (default 200, max 1000); ?format=text returns a plain-text file.
  router.get('/action-log', (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200))
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 'account_id')
    let rows = []
    try {
      rows = db.prepare(
        `SELECT * FROM action_log${acct.active ? ` WHERE ${acct.where}` : ''} ORDER BY id DESC LIMIT ?`
      ).all(...acct.params, limit)
    } catch { /* table appears on first boot after migration */ }
    if (req.query.format === 'text') {
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.setHeader('content-disposition', 'attachment; filename="action-log.txt"')
      return res.send(rows.map(r => `${r.at}Z  ${r.method} ${r.path}  ${r.body || ''}`).join('\n'))
    }
    res.json({
      rows,
      accountId: scope.all ? 'all' : (scope.accountId ?? null),
      scoped: acct.active,
      scope: scopeReport(scope, scopeCoverage(db, { table: 'action_log', scope })),
    })
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
      const { publicSessionId, recordHeartbeat } = await import('../services/browser-sessions.js')
      // Which session does this tab belong to? DERIVED from the request's own
      // bearer token, never from a query parameter — the session list's whole
      // security model is that the server decides who is who.
      const bearer = String(req.headers.authorization || '').startsWith('Bearer ')
        ? String(req.headers.authorization).slice(7)
        : ''
      const sid = publicSessionId(bearer)
      // Server-authoritative heartbeat stamp (the brief: "Implement a
      // server-authoritative heartbeat rather than relying only on the
      // browser clock").
      const reqIp = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()
      try {
        // tz + loc ride the heartbeat so the location is stamped ON the
        // session row and survives after the browser is gone (owner:
        // "I need IP Address and location for past window").
        recordHeartbeat(db, bearer, { ua: req.headers['user-agent'], ip: reqIp, tz: req.query.tz, loc: req.query.loc })
      } catch { /* never fail a heartbeat on bookkeeping */ }
      res.json(registerClientPing({
        tab: req.query.tab, tz: req.query.tz, page: req.query.page,
        hidden: req.query.hidden, idle: req.query.idle, closed: req.query.closed,
        sid,
        ua: req.headers['user-agent'],
        ip: reqIp,
      }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/sessions — the authenticated browser sessions on this account
  // (instr/footer_issue.md: "Returns the current authenticated user's
  // sessions with safe display fields only").
  //
  // The current session is identified from THIS request's bearer token,
  // server-side. A client-provided isCurrent flag is never read, because the
  // whole point of the endpoint is that a stale or hostile page must not be
  // able to talk the server into revoking the wrong thing.
  //
  // Never cached: it reports a live last-seen age, and the 10s /state/* cache
  // would make "seen 3s ago" a stale claim.
  router.get('/sessions', async (req, res) => {
    try {
      const { sessionsView } = await import('../services/browser-sessions.js')
      const { clientSummary } = await import('../services/client-presence.js')
      const bearer = String(req.headers.authorization || '').startsWith('Bearer ')
        ? String(req.headers.authorization).slice(7)
        : ''
      // Is this the master secret rather than a device session? The view says
      // so plainly instead of offering a Disconnect that would sign out every
      // device at once.
      const isMaster = !!bearer && (bearer === process.env.AGENT_SECRET || bearer === process.env.AGENT_SECRET_READ)
      res.json(sessionsView(db, {
        currentToken: isMaster ? null : bearer,
        isMaster,
        presence: clientSummary(),
        // For the master caller's THIS DEVICE row — what the server sees on
        // THIS request, the only honest source for it.
        callerUa: req.headers['user-agent'],
        callerIp: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
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
      const { staleRegistryAccounts, accountAtBroker } = await import('../services/broker-roster.js')
      const rows = listAccounts(db)
      // STALE ROWS, NAMED. The registry is insert-only and nothing re-syncs it,
      // so an account unticked in the cTrader app stays here forever — and if
      // it is still enabled, the loop and the sidecar keep targeting it. This
      // reports it; it does not act on it (owner 02-08-2026 chose "flag it
      // loudly, don't touch it"). `atBroker: null` means UNKNOWN — no roster,
      // or one too old to trust — and must never be rendered as "gone".
      const { rosterStatus, stale } = staleRegistryAccounts(db, rows)
      res.json({
        accounts: rows.map(a => ({ ...a, atBroker: accountAtBroker(db, a.account_id) })),
        selectedAccountId: getState(db, 'ctrader_account_id') || null,
        brokerRoster: rosterStatus,
        staleAccounts: stale,
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/account-phases — Scan / Analyze / Autotrade per account.
  //
  // Owner asked three times for per-account switches. This is the read side:
  // the master flags, plus every registry account's override (true / false /
  // null = inherit) and what it therefore may ACTUALLY do.
  //
  // `effective.source` is the field that makes the UI honest — it says whether
  // a phase is off because the MASTER is off (so a per-account switch would
  // change nothing) or because this ACCOUNT is switched off. Without it the
  // owner would flip a switch that cannot take effect and reasonably conclude
  // the switches are fake again.
  // -----------------------------------------------------------------------
  router.get('/account-phases', async (_req, res) => {
    try {
      const { phasesView } = await import('../services/account-phases.js')
      const view = phasesView(db)
      // Connectivity per account, from the sidecar's authorized roster (the
      // same fail-open source the sweeps gate on): 'active' when the broker
      // session holds the account, 'disconnected' when the session is up
      // WITHOUT it, 'unknown' when the roster itself is unknown (js mode /
      // health blip) — unknown is stated, never guessed either way.
      try {
        // PER SIDE. `view.accounts` spans both sides, so one roster cannot
        // answer for all of them. Before this, a split deployment would report
        // every demo account `disconnected` while its own sidecar was healthy —
        // a diagnostic stating the wrong side confidently, which is worse than
        // one that says `unknown`.
        const { sidecarRostersBySide } = await import('../lib/exec-engine.js')
        const rosters = await sidecarRostersBySide()
        for (const a of view.accounts) {
          const roster = a.isLive ? rosters.live : rosters.demo
          a.connectivity = roster == null ? 'unknown' : roster.includes(String(a.accountId)) ? 'active' : 'disconnected'
        }
      } catch {
        for (const a of view.accounts) a.connectivity = 'unknown'
      }
      res.json(view)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/account-engineering — what the machine is actually doing for
  // each account: enabled, mode, effective Scan/Analyze/Autotrade, whether the
  // C++ sidecar is authorised for it, open positions, last reconcile, last
  // pipeline decision.
  //
  // Owner: "The desk page should display the underlying engineering status for
  // each account you are trading or not trading … I am serious about avoiding
  // unnecessary effort and expenses."
  //
  // One route so the browser does not fan out across six endpoints — and it
  // reads only the DB: the sidecar roster comes from what probeCppExec already
  // persisted, never from an HTTP hop inside a cached GET.
  // -----------------------------------------------------------------------
  router.get('/account-engineering', async (_req, res) => {
    try {
      const { engineeringView } = await import('../services/account-engineering.js')
      res.json(engineeringView(db))
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

  // GET /state/account-analytics?account=<id>|all&days=<n>
  // Whole-period performance statistics computed over EVERY qualifying
  // closed trade (audit finding 2.1: the page was deriving its "All time"
  // tiles from /state/trades, which is capped at 100 rows — so past 100
  // trades the win rate and profit factor the owner gates live trading on
  // described the latest hundred, not the record). days omitted/0 = all time.
  router.get('/account-analytics', async (req, res) => {
    try {
      const { accountAnalytics } = await import('../services/account-analytics.js')
      const days = Number(req.query.days)
      res.json(accountAnalytics(db, {
        accountId: req.query.account ? String(req.query.account) : null,
        days: Number.isFinite(days) && days > 0 ? days : null,
      }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/account-settings?account= — A6. Which settings this account
  // has pinned and which it inherits, plus the settings that are NOT
  // overridable and why. The "why" is in the payload deliberately: a refusal
  // the operator can only discover by trying is the kind that gets worked
  // around.
  router.get('/account-settings', async (req, res) => {
    try {
      const { overrideView } = await import('../services/setting-resolver.js')
      const { viewedAccountOf, describeScope } = await import('../services/viewed-account.js')
      const viewed = viewedAccountOf(db, req)
      res.json({ scope: describeScope(viewed), ...overrideView(db, viewed.accountId) })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/workspace-log?account=&limit= — A5. The owner's "logs per
  // workspace" ask. action_log was global until this slice; rows written
  // before it carry NULL and are included, the same convention every other
  // scoped read uses — a workspace that hid its own pre-stamping history
  // would look emptier than it is.
  router.get('/workspace-log', async (req, res) => {
    try {
      const { viewedAccountOf, whereClause, describeScope } = await import('../services/viewed-account.js')
      const viewed = viewedAccountOf(db, req)
      const w = whereClause(viewed)
      const n = Math.min(Math.max(1, Number(req.query.limit) || 100), 500)
      const rows = db.prepare(
        `SELECT id, at, method, path, body, account_id FROM action_log ${w.sql} ORDER BY id DESC LIMIT ?`
      ).all(...w.params, n)
      res.json({ scope: describeScope(viewed), viewed, rows, truncated: rows.length >= n })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/workspace-backtests?account=&limit= — A5. Backtest history for
  // a workspace. A backtest is a fact about the MARKET, so account_id here is
  // PROVENANCE (which account's session produced it), not ownership: the
  // watchlist-summary coverage read still counts a symbol's run whoever made
  // it, and this route is the "what did I run on this workspace" view.
  router.get('/workspace-backtests', async (req, res) => {
    try {
      const { viewedAccountOf, whereClause, describeScope } = await import('../services/viewed-account.js')
      const viewed = viewedAccountOf(db, req)
      const w = whereClause(viewed)
      const n = Math.min(Math.max(1, Number(req.query.limit) || 200), 1000)
      const rows = db.prepare(
        `SELECT id, ran_at, strategy, symbol, timeframe, trades, win_rate_pct, profit_factor,
                total_profit_pct, error, account_id
           FROM backtest_runs ${w.sql} ORDER BY id DESC LIMIT ?`
      ).all(...w.params, n)
      res.json({ scope: describeScope(viewed), viewed, rows, truncated: rows.length >= n })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/workspace-coverage — A5, and the reason this route exists is
  // honesty. Adding a viewed-account parameter to two routes does not make
  // every read account-aware, and claiming otherwise would be the kind of
  // overclaim that costs a day later. This MEASURES it: which per-account
  // tables carry account_id, and which /state routes accept ?account=. What
  // it reports is the real state, including the gaps.
  router.get('/workspace-coverage', async (req, res) => {
    try {
      const { workspaceCoverage } = await import('../services/workspace-coverage.js')
      res.json(workspaceCoverage(db))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/pause-plan?account=<id> — A3. What the pause disposition would
  // do to this account's resting ENTRY orders right now: watch, cancel (with
  // the signal that fired), or keep — each with its drain countdown. A read,
  // never an action: the countdown must be visible BEFORE the deadline passes,
  // or supervised-drain quietly degrades into keep.
  router.get('/pause-plan', async (req, res) => {
    try {
      const { planPendingDisposition } = await import('../services/pause-disposition.js')
      const { resolveAccountId } = await import('../services/account-registry.js')
      const accountId = req.query.account ? String(req.query.account) : resolveAccountId(db)
      if (!accountId) return res.json({ accountId: null, actions: [] })
      let armed = null
      try {
        const { enabledStrategies } = await import('../services/strategies.js')
        armed = enabledStrategies(db, getState).map(s2 => s2.key)
      } catch { armed = null }
      res.json(planPendingDisposition(db, { accountId, armedStrategies: armed }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/account-traffic-lights — A4. Four lights per account (link /
  // scan / enter / manage) with a one-line reason each, plus the open-work
  // counts that make a pause decision consequential. Every light can be
  // `unknown`, and unknown is its own state rather than being folded into
  // green: a green light built on absent evidence is exactly the "believing an
  // account is quiet when it isn't" failure the lights exist to prevent.
  router.get('/account-traffic-lights', async (req, res) => {
    try {
      const { accountTrafficLights } = await import('../services/account-traffic-lights.js')
      res.json(accountTrafficLights(db))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/account-capabilities — A2/A4 feed: per account, what it may do
  // (scan / enter / manage), its mode, and how much open work it holds. The
  // `unmanagedExposure` flag is the plan's §1 invariant checked rather than
  // assumed — an account with open positions and MANAGE off is an alarm, and
  // the only way to reach it is a mode written straight into the column.
  router.get('/account-capabilities', async (req, res) => {
    try {
      const { capabilityView } = await import('../services/account-capabilities.js')
      res.json({ accounts: capabilityView(db) })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/decision-feed?account=&hours=&limit=&stage=&decision=&symbol=
  // "Why didn't it trade?" as a readable answer rather than raw rows.
  // /state/decisions returns the log verbatim, which is a developer's view: a
  // hundred `style_filter/skip` rows says nothing, because one waiting setup
  // re-logs the same skip every five-minute cycle. This returns the stage ×
  // decision × reason MIX (with distinct-symbol counts, so retries and
  // universe-wide rejections are distinguishable) alongside the newest rows.
  router.get('/decision-feed', async (req, res) => {
    try {
      const { decisionFeed } = await import('../services/decision-feed.js')
      res.json(decisionFeed(db, {
        accountId: req.query.account ? String(req.query.account) : null,
        hours: req.query.hours ? Number(req.query.hours) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        stage: req.query.stage ? String(req.query.stage) : null,
        decision: req.query.decision ? String(req.query.decision) : null,
        symbol: req.query.symbol ? String(req.query.symbol) : null,
      }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/watchlist-summary?accounts=<id,id,…>
  // Per-account watchlist facts: how many symbols this account actually
  // trades, whether that list is its own or inherited from the shared one,
  // how many of those symbols have a usable backtest on record, and which do
  // not. Answers the owner's question of 02-08-2026 — "whether the ACCOUNT
  // has how many symbols in watchlist, how many backtested" — which no
  // surface could previously state. ?accounts= lets the Connect page ask
  // about the BROKER roster, including accounts the registry has never seen.
  router.get('/watchlist-summary', async (req, res) => {
    try {
      const { accountWatchlistSummary } = await import('../services/account-watchlist-summary.js')
      const raw = req.query.accounts ? String(req.query.accounts) : ''
      const ids = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : null
      res.json(accountWatchlistSummary(db, { accountIds: ids }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET /state/goal-tracker?days=<n>
  // Progress toward the go-live gate (win rate 68%, profit factor 1.68 by
  // 12 Aug) for every registry account plus a pooled portfolio row. Answers
  // the reachability question the Performance tiles cannot: at the rate this
  // account actually closes trades, is the gate still arithmetically in play,
  // and what would the remaining trades have to do. Returns every account —
  // the panel needs the whole roster to say which ones are and are not on it,
  // so this route is deliberately not scoped by ?account=.
  router.get('/goal-tracker', async (req, res) => {
    try {
      const { goalTracker } = await import('../services/goal-tracker.js')
      const days = Number(req.query.days)
      res.json(goalTracker(db, { days: Number.isFinite(days) && days > 0 ? days : null }))
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
  // Why Cup & Handle never fires — read from the 2.6M diagnostic traces the
  // scanner has been writing all along. NOT account-scoped: the traces record
  // market structure at scan time, which is the same for every account.
  router.get('/cup-handle-funnel', async (req, res) => {
    try {
      const { cupHandleFunnel } = await import('../services/cup-handle-funnel.js')
      const days = Number(req.query.days) > 0 ? Number(req.query.days) : 7
      const bias = req.query.bias === 'long' || req.query.bias === 'short' ? req.query.bias : null
      res.json(cupHandleFunnel(db, { days, bias }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/strategy-liveness', async (req, res) => {
    try {
      const { strategyLiveness } = await import('../services/strategy-liveness.js')
      const { viewedAccountOf } = await import('../services/viewed-account.js')
      const windowDays = Number(req.query.days) > 0 ? Number(req.query.days) : undefined
      // Scoping here is PARTIAL by design: signals come from scans, which are
      // account-independent market observations. The payload's `scope` names
      // which stages were filtered.
      const viewed = viewedAccountOf(db, req)
      res.json(strategyLiveness(db, { windowDays, accountId: viewed.accountId }))
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.get('/decisions', async (req, res) => {
    try {
      const { recentDecisions } = await import('../services/decision-log.js')
      // decision_log stamps account_id on every write (decision-log.js:31).
      // This is the 3A provenance trail — "why did the bot do that" is always
      // a question about ONE account's run.
      const scope = requestedAccount(db, req)
      res.json({
        decisions: recentDecisions(db, {
          symbol: req.query.symbol ? String(req.query.symbol).toUpperCase() : null,
          stage: req.query.stage ? String(req.query.stage) : null,
          limit: req.query.limit,
          scope,
        }),
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        scope: scopeReport(scope, scopeCoverage(db, { table: 'decision_log', scope })),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/phase-audit — the S.A.T. / controller audit trail (owner,
  // 2026-07-31, after the second unexplained all-accounts autotrade drop):
  // every pipeline-switch flip with from/to/actor/via/reason, and every
  // controller stall/recovery, newest first.
  // -----------------------------------------------------------------------
  router.get('/phase-audit', async (req, res) => {
    try {
      const { recentPhaseAudit } = await import('../services/phase-audit.js')
      const { viewedAccountOf, describeScope } = await import('../services/viewed-account.js')
      const viewed = viewedAccountOf(db, req)
      res.json({
        scope: describeScope(viewed),
        audit: recentPhaseAudit(db, {
          limit: req.query.limit ? Number(req.query.limit) : 100,
          accountId: viewed.accountId,
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
      // S1 batch 4. backtest_runs joined the scoped set in the A5 migration
      // (per-account workspaces) — a backtest run under one account's config
      // is not evidence about another's.
      const scope = requestedAccount(db, req)
      const acct = accountWhere(scope, 'account_id')
      const clauses = []
      const params = []
      if (sym) { clauses.push('symbol = ?'); params.push(sym) }
      if (acct.active) { clauses.push(acct.where); params.push(...acct.params) }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
      const rows = db.prepare(
        `SELECT * FROM backtest_runs${where} ORDER BY id DESC LIMIT ?`
      ).all(...params, limit)
      const bySymbol = db.prepare(
        `SELECT symbol, COUNT(*) AS rows, MAX(ran_at) AS lastRanAt,
                SUM(COALESCE(trades, 0)) AS totalTrades,
                SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
           FROM backtest_runs${acct.active ? ` WHERE ${acct.where}` : ''}
           GROUP BY symbol ORDER BY lastRanAt DESC`
      ).all(...acct.params)
      res.json({
        rows, bySymbol,
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        scoped: acct.active,
        scope: scopeReport(scope, scopeCoverage(db, { table: 'backtest_runs', scope })),
      })
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
      legacyRows: acct.active
        ? countUnattributed(db, 'trades', "status IN ('closed','rejected')")
        : 0,
      // S1 — coverage over THESE rows, not the whole table. `legacyRows`
      // above counts NULLs across every closed trade ever; this says what
      // fraction of the answer on screen is actually this account's, which is
      // the number the Go-Live card needed and did not have.
      scope: scopeReport(scope, scopeCoverage(db, {
        table: 'trades', scope, extraWhere: "status IN ('closed','rejected')",
      })),
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/strategy-asset?days=7 — where the money actually went.
  //
  // Owner 09-08-2026, auditing the week. `/state/perf-ledger`'s per-market cut
  // said FX lost 4,342.97 at PF 0.15; a cross over the latest 100 rows said the
  // biggest single loser was fib_confluence ON STOCKS with zero winners. Both
  // were computable, neither was actionable, because an asset margin and a
  // strategy margin cannot tell "this asset is bad" from "this strategy is bad
  // at this asset" — and those call for opposite switches.
  //
  // AND the week was not readable at all: `/state/trades` is LIMIT 100 with no
  // offset and no window, so 183 trades could not be pulled through the API and
  // the 100-row sample skewed to the most recent days, under-counting FX damage
  // that happened Monday to Wednesday.
  //
  // Read-only. It decides nothing — it exists so that switching an instrument or
  // a strategy off is a measured act rather than a guess.
  // -----------------------------------------------------------------------
  router.get('/strategy-asset', async (req, res) => {
    try {
      const { strategyAssetCross } = await import('../services/strategy-asset-cross.js')
      const scope = requestedAccount(db, req)
      const acct = accountWhere(scope, 'account_id')
      // `Number(null)` is 0 and a 0-day window would silently answer "no
      // trades" over a bad parameter. Clamp into a sane band instead.
      const rawDays = req.query.days
      const days = Math.min(365, Math.max(1, Number(rawDays) > 0 ? Number(rawDays) : 7))
      const sinceMs = Date.now() - days * 86_400_000
      const since = new Date(sinceMs).toISOString()
      const rows = db.prepare(
        `SELECT symbol, net_pnl, label_strategy, strategy, closed_at
           FROM trades
          WHERE status = 'closed'
            AND COALESCE(closed_at, opened_at) >= ?
            ${acct.active ? `AND ${acct.where}` : ''}`
      ).all(since, ...acct.params)
      res.json({
        windowDays: days,
        since,
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        rowsRead: rows.length,
        ...strategyAssetCross(rows),
      })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/activity — unified live event stream for the Trade Window
  // Merges scans, analyses, monitor checks, trades, regime snapshots, flips
  // into one time-sorted feed. Cheap: single UNION ALL, LIMIT-capped.
  // -----------------------------------------------------------------------
  router.get('/activity', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200)
    // S1 batch 8. Six of the seven UNION legs carry account_id; `regimes` does
    // NOT, and that is deliberate — db.js keeps regimes global because a
    // regime is a fact about an INSTRUMENT, not an account. So the regime leg
    // is left unfiltered and the response says which legs were scoped, rather
    // than filtering on a column that does not exist or quietly dropping the
    // leg. A feed that silently loses a row type is worse than one that
    // explains why it kept it.
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 'account_id')
    const leg = acct.active ? ` AND ${acct.where}` : ''
    const legWhere = acct.active ? ` WHERE ${acct.where}` : ''
    const p = acct.params
    const rows = db.prepare(`
      SELECT * FROM (
        SELECT 'scan'     AS kind, id, symbol, scanned_at  AS at,
               bias       AS v1,  confidence AS v2,  thesis AS note,
               trade_grade AS extra, NULL AS ref
        FROM scans${legWhere}
        UNION ALL
        SELECT 'analysis' AS kind, id, symbol, analyzed_at AS at,
               consensus_bias AS v1, overall_conviction AS v2, consensus_summary AS note,
               strategy AS extra, scan_id AS ref
        FROM analyses${legWhere}
        UNION ALL
        SELECT 'monitor'  AS kind, id, symbol, last_check_at AS at,
               last_check_action AS v1, NULL AS v2, last_check_reasoning AS note,
               thesis_status AS extra, trade_id AS ref
        FROM monitored_positions
        WHERE last_check_at IS NOT NULL${leg}
        UNION ALL
        SELECT 'trade'    AS kind, id, symbol, COALESCE(closed_at, opened_at) AS at,
               side AS v1, conviction AS v2, thesis AS note,
               status AS extra, analysis_id AS ref
        FROM trades${legWhere}
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
        WHERE flipped = 1${leg}
        UNION ALL
        SELECT 'risk'     AS kind, id, symbol, created_at AS at,
               side AS v1, approved AS v2, veto_reason AS note,
               checks_json AS extra, NULL AS ref
        FROM risk_events${legWhere}
      )
      WHERE at IS NOT NULL
      ORDER BY at DESC
      LIMIT ?
    `).all(...p, ...p, ...p, ...p, ...p, ...p, limit)

    res.json({
      activity: rows,
      accountId: scope.all ? 'all' : (scope.accountId ?? null),
      scoped: acct.active,
      // Named, not implied: `regime` rows are instrument facts and stay
      // portfolio-wide even on a scoped read.
      scopedKinds: acct.active ? ['scan', 'analysis', 'monitor', 'trade', 'flip', 'risk'] : [],
      globalKinds: ['regime'],
      scope: scopeReport(scope, scopeCoverage(db, { table: 'trades', scope })),
    })
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

    // S1 batch 8. An id lookup is NOT filtered — a row asked for by primary
    // key exists or it does not, and 404-ing a real row because the sidebar
    // happens to be on another account would be a scoping change that only
    // ever loses information. What it does instead is SAY whose it is, so a
    // detail view opened from a per-account list can tell when it has landed
    // on another account's row. `null` means the row predates stamping.
    const scope = requestedAccount(db, req)
    res.json({
      analysis: {
        ...row,
        minion_reports: reports,
        synthesis_parsed: synthesis,
      },
      accountId: row.account_id ?? null,
      viewingAccountId: scope.all ? 'all' : (scope.accountId ?? null),
      foreign: !scope.all && scope.accountId != null && row.account_id != null
        && String(row.account_id) !== String(scope.accountId),
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

    // Same as /analysis/:id — reported, never filtered.
    const scope = requestedAccount(db, req)
    res.json({
      position: pos, trade, recentScans,
      accountId: pos.account_id ?? null,
      viewingAccountId: scope.all ? 'all' : (scope.accountId ?? null),
      foreign: !scope.all && scope.accountId != null && pos.account_id != null
        && String(pos.account_id) !== String(scope.accountId),
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/config — current watchlist + armed status
  // -----------------------------------------------------------------------
  router.get('/config', (req, res) => {
    // ?account=<id> scopes the watchlist to ONE account (owner 02-08-2026:
    // "I am confuse whether the ACCOUNT has how many symbols in watchlist").
    // Without it the shared list is returned, byte-for-byte as before, so
    // every existing caller is unaffected.
    const acct = req.query?.account ? String(req.query.account) : null
    let scopedSymbols = null
    let inherited = null
    if (acct) {
      try {
        scopedSymbols = readWatchlist(db, acct)
        // The UI must be able to SAY which of the two it is showing. An
        // account with no list of its own is displaying the shared one, and
        // its first edit forks it — that is a decision, not a detail.
        inherited = !hasOwnWatchlist(db, acct)
      } catch { scopedSymbols = null; inherited = null }
    }
    const symbolsJson = getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json')
    const sharedSymbols = symbolsJson ? (() => { try { return JSON.parse(symbolsJson) } catch { return [] } })() : []
    const symbolsOut = scopedSymbols ?? sharedSymbols
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
      symbols: symbolsOut,
      watchlist: symbolsOut,
      // Which account this watchlist belongs to, and whether it is really
      // that account's own. null/null when no ?account was asked for.
      watchlist_account: acct,
      watchlist_inherited: inherited,
      watchlist_shared_count: sharedSymbols.length,
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
        legacyRows: acct.active ? countUnattributed(db, 'pending_orders') : 0,
        scope: scopeReport(scope, scopeCoverage(db, { table: 'pending_orders', scope })),
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
      legacyRows: acct.active ? countUnattributed(db, 'risk_events') : 0,
      scope: scopeReport(scope, scopeCoverage(db, { table: 'risk_events', scope })),
    })
  })

  // -----------------------------------------------------------------------
  // GET /state/decisions-daily?days=N — per-day approved/vetoed decision
  // counts. The Performance equity chart used to derive its "decisions per
  // day" panel from /state/risk-events?limit=200 — on production that page
  // of events spans ~half an hour (200 vetoes arrive in minutes), so the
  // "daily" bars were one sliver of today and the 7D/30D range pills were
  // furniture. Aggregate in SQL over the real window instead.
  // -----------------------------------------------------------------------
  router.get('/decisions-daily', (req, res) => {
    try {
      const days = Math.min(365, Math.max(1, parseInt(req.query.days || '90', 10)))
      const scope = requestedAccount(db, req)
      const acct = accountWhere(scope, 'account_id')
      const clauses = [`created_at >= datetime('now', ?)`]
      const params = [`-${days} days`]
      if (acct.active) { clauses.push(acct.where); params.push(...acct.params) }
      const rows = db.prepare(
        `SELECT substr(created_at, 1, 10) AS day,
                SUM(approved = 1) AS approved,
                SUM(approved != 1 OR approved IS NULL) AS vetoed
           FROM risk_events
          WHERE ${clauses.join(' AND ')}
          GROUP BY day ORDER BY day`
      ).all(...params)
      res.json({ days, rows, accountId: scope.all ? 'all' : (scope.accountId ?? null) })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // The day's binding cap in dollars: the TIGHTER of the two brakes that are
  // switched on, or null when neither is. Deliberately the same combination
  // rule as pacedDailyCap — this is the unpaced summary the config card shows,
  // and the two disagreeing about which limit is live would be worse than the
  // card not showing one at all.
  const dailyCapOf = (cfg, balance) => {
    const pct = cfg?.dailyLossPct > 0 && balance > 0 ? balance * cfg.dailyLossPct : null
    const flat = cfg?.dailyLossLimit > 0 ? Math.abs(cfg.dailyLossLimit) : null
    const on = [pct, flat].filter(v => v != null)
    return on.length ? Number(Math.min(...on).toFixed(2)) : null
  }

  // -----------------------------------------------------------------------
  // GET /state/risk-config — effective risk config (defaults merged with overrides)
  // -----------------------------------------------------------------------
  router.get('/risk-config', (req, res) => {
    // ?account=<id> → that account's EFFECTIVE config (global merged with its
    // acct:<id>:risk_config_json overlay) plus the overlay itself, so the UI
    // can show which limits are elevated per account. No param = global.
    const acctParam = req.query.account && req.query.account !== 'all' ? String(req.query.account) : null
    // WHOSE numbers these are, always answered. The caller may not have named
    // an account; the reply still says which one it resolved to, so a UI can
    // never print this balance beside a different account's name (owner
    // 04-08-2026: "conflicting account numbers … cause the user distrust").
    const resolvedAccountId = acctParam ?? (getState(db, 'ctrader_account_id') || null)
    const effective = loadRiskConfig(db, acctParam)
    const overlay = acctParam ? accountRiskOverlay(db, acctParam) : null
    const balance = getAccountBalance(db, acctParam)
    const leverage = getAccountLeverage(db, effective, acctParam)
    const tier = balance != null ? tierForBalance(balance) : null
    const derived = balance != null
      ? {
          balance,
          leverage,
          tier,
          // BOTH daily brakes, either of which may be off (owner 04-08-2026).
          // The headline number is the one that actually binds — the tighter
          // of the checks that are on — and null when neither is, because a
          // number here would claim a limit that does not exist.
          daily_cap_usd: dailyCapOf(effective, balance),
          daily_cap_pct_usd: effective.dailyLossPct > 0
            ? Number((balance * effective.dailyLossPct).toFixed(2)) : null,
          daily_cap_flat_usd: effective.dailyLossLimit > 0
            ? Number(Math.abs(effective.dailyLossLimit).toFixed(2)) : null,
          per_trade_budget_usd: Number((balance * effective.perTradeRiskPct).toFixed(2)),
          margin_cap_usd: Number((balance * effective.maxMarginUsagePct).toFixed(2)),
          mode: 'equity_aware',
        }
      : {
          balance: null,
          leverage,
          tier: null,
          // No balance → the % check has nothing to take a fraction of, so the
          // flat cap is the only one left. Null when it too is off: the day is
          // genuinely uncapped and the page says so rather than printing a
          // number nothing enforces.
          daily_cap_usd: effective.dailyLossLimit > 0
            ? Number(Math.abs(effective.dailyLossLimit).toFixed(2)) : null,
          daily_cap_pct_usd: null,
          daily_cap_flat_usd: effective.dailyLossLimit > 0
            ? Number(Math.abs(effective.dailyLossLimit).toFixed(2)) : null,
          per_trade_budget_usd: null,
          margin_cap_usd: null,
          mode: 'absolute_fallback',
        }
    res.json({
      defaults: DEFAULT_RISK_CONFIG,
      effective,
      derived,
      // `accountId` is the SCOPE the caller asked for (null = they asked for
      // the shared config). `resolvedAccountId` is whose balance and leverage
      // `derived` actually describes — they differ exactly when nobody named
      // an account, and printing the numbers without that answer is what put
      // one account's balance beside another's name on the Trade header.
      accountId: acctParam,
      resolvedAccountId,
      overlay,
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
      // Phase 6: group by HOW the trade came to exist. The other dimensions
      // answer "which label", this one answers "did this system decide to take
      // it" — and it is the dimension that tells a strategy's own record apart
      // from positions reconciliation adopted off the broker.
      origin:           ['origin'],
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

    // S1 batch 3. This route answers "which strategy makes money" — pooled
    // across accounts it answers it for nobody. A demo account running the
    // loosened gates and the live account running the tight ones average into
    // a profit factor neither of them has.
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 'account_id')
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
        AND closed_at >= ?${acct.active ? ` AND ${acct.where}` : ''}
      GROUP BY ${groupExpr}
      ORDER BY total_pnl DESC NULLS LAST
    `).all(sinceISO, ...acct.params)

    // Enrich each row with win_rate for convenience.
    for (const r of rows) {
      const t = r.trades || 0
      r.win_rate = t > 0 ? Number((r.wins / t).toFixed(3)) : null
    }

    // ATTRIBUTION COVERAGE, printed beside the numbers rather than instead of
    // them (audit Part 2, Phase 6). A win rate computed over a mixture of this
    // system's own entries and positions adopted from the broker is not a
    // measurement of strategy edge, and until now nothing on this route said
    // what the mixture was.
    let originRows = []
    try {
      originRows = db.prepare(`
        SELECT origin FROM trades
         WHERE status = 'closed' AND closed_at >= ?${acct.active ? ` AND ${acct.where}` : ''}
      `).all(sinceISO, ...acct.params)
    } catch { originRows = [] }

    res.json({
      groupBy, days, since: sinceISO, rows,
      originCoverage: originCoverage(originRows),
      accountId: scope.all ? 'all' : (scope.accountId ?? null),
      scoped: acct.active,
      scope: scopeReport(scope, scopeCoverage(db, {
        table: 'trades', scope, extraWhere: "status = 'closed' AND closed_at >= ?", extraParams: [sinceISO],
      })),
    })
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
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 'account_id')
    try {
      const rows = db.prepare(
        `SELECT * FROM performance_snapshots WHERE computed_at >= ?${acct.active ? ` AND ${acct.where}` : ''}
         ORDER BY computed_at ASC`
      ).all(since, ...acct.params)
      res.json({
        snapshots: rows,
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        scoped: acct.active,
        scope: scopeReport(scope, scopeCoverage(db, {
          table: 'performance_snapshots', scope,
          extraWhere: 'computed_at >= ?', extraParams: [since],
        })),
      })
    } catch {
      res.json({ snapshots: [] })
    }
  })

  router.get('/analyses/latest', (req, res) => {
    // S1 batch 5. Only the ANALYSES half is scoped. The LEFT JOIN onto scans
    // is there to decorate each analysis with the scan it came from; adding
    // the predicate there too would turn the join into a filter and drop the
    // decoration whenever the scan is another account's (or, commonly, global
    // and unstamped) — losing scan_bias rather than gaining accuracy.
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 'a.account_id')
    try {
      const rows = db.prepare(`
        SELECT a.*, s.bias AS scan_bias, s.confidence AS scan_confidence
        FROM analyses a
        LEFT JOIN scans s ON s.id = a.scan_id
        WHERE a.analyzed_at > datetime('now', '-24 hours')${acct.active ? ` AND ${acct.where}` : ''}
        ORDER BY a.analyzed_at DESC
      `).all(...acct.params)
      res.json({
        analyses: rows,
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        scoped: acct.active,
        scope: scopeReport(scope, scopeCoverage(db, {
          table: 'analyses', scope, extraWhere: "analyzed_at > datetime('now', '-24 hours')",
        })),
      })
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
    const timeframes = armedTimeframes(db, getState)
    let matrix = null
    try { matrix = JSON.parse(getState(db, 'autotrade_matrix_json') || 'null') } catch { /* null */ }
    res.json({ timeframes, matrix })
  })

  // -----------------------------------------------------------------------
  // GET /state/timeframe-performance — win/loss/no-trade per autotrade
  // timeframe over rolling windows (Tune → Pipeline table)
  // -----------------------------------------------------------------------
  router.get('/timeframe-performance', (req, res) => {
    try {
      const scope = requestedAccount(db, req)
      res.json({
        ...timeframePerformance(db, { scope }),
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        scope: scopeReport(scope, scopeCoverage(db, {
          table: 'trades', scope, extraWhere: "status = 'closed'",
        })),
      })
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
  router.get('/risk-full', async (req, res) => {
    try {
      const { DEFAULT_RISK_CONFIG, loadRiskConfig, getAccountBalance, getAccountLeverage, accountRiskOverlay } = await import('../services/risk.js')
      const { accountKnown, effectiveRiskEntries, unknownQueryParams } = await import('../services/risk-effective.js')
      // STRICT PARAMETERS. This route used to read `?account=` and ignore
      // everything else, so `?accountId=47790949` returned the GLOBAL config
      // presented as an answer about that account — which is how the audit
      // came to report `minRR 1.5` for accounts gated at 4.5–6.16. A
      // parameter this route does not understand is now a 400, because
      // answering a question nobody asked, in the shape of the one they did,
      // is the failure mode being repaired.
      const unknown = unknownQueryParams(req.query, ['account'])
      if (unknown.length) {
        return res.status(400).json({
          error: 'unsupported query parameter(s)',
          unsupported: unknown,
          supported: ['account'],
          hint: 'Use ?account=<id> for one account, or omit it for the global configuration.',
        })
      }
      // ?account=<id> resolves the config THAT ACCOUNT actually trades under —
      // the global config with its overlay merged on top. Without it the
      // global config is returned exactly as before.
      const acct = req.query?.account ? String(req.query.account) : null
      // THREE STATES, NOT TWO. "no account named", "a known account" and "an
      // account id the registry has never heard of" produced identical bodies
      // before this, so a typo'd id read as plausible numbers belonging to
      // nobody. `null` means the registry itself could not be read.
      const known = accountKnown(db, acct)
      const effective = loadRiskConfig(db, acct)
      const overridden = Object.keys(DEFAULT_RISK_CONFIG).filter(
        k => JSON.stringify(effective[k]) !== JSON.stringify(DEFAULT_RISK_CONFIG[k])
      )
      // TWO KINDS OF OVERRIDE, told apart. "Differs from the default" and
      // "this account overrides the global" are different facts with different
      // fixes — one is edited on the global config, the other only exists for
      // this account — and collapsing them is how an operator changes the
      // wrong one. `overlayKeys` is the account-specific set.
      const overlay = acct ? accountRiskOverlay(db, acct) : null
      const overlayKeys = overlay ? Object.keys(overlay).filter(k => k in DEFAULT_RISK_CONFIG) : []
      const globalCfg = loadRiskConfig(db, null)
      const parse = (k, dflt) => { try { return JSON.parse(getState(db, k) || dflt) } catch { return JSON.parse(dflt) } }
      // BROKER truth wins for balance (owner saw a stale figure: the stored
      // account_balance_usd lags the broker between loop refreshes). Use the
      // latest broker snapshot when it's fresh; fall back to the stored value.
      const snap = parse('broker_snapshot_cache_json', 'null')
      const snapAgeMs = snap?.fetchedAt ? Date.now() - new Date(snap.fetchedAt).getTime() : Infinity
      const brokerBalance = snapAgeMs < 15 * 60 * 1000 ? (snap?.account?.health?.balance ?? snap?.account?.balance ?? null) : null
      res.json({
        ok: true,
        risk: {
          effective, defaults: DEFAULT_RISK_CONFIG, overridden,
          // Which account this config was resolved for (null = the global
          // config itself), the keys THIS ACCOUNT overrides, and the global
          // values they sit on top of — so the page can show what would come
          // back if the overlay were cleared.
          scopedTo: acct,
          overlayKeys,
          global: acct ? globalCfg : null,
          // WHICH of the three scope states this answer is in. `unknown_account`
          // is the one worth having: the numbers below are the global config,
          // and they belong to no account.
          accountScope: acct == null ? 'global' : known === false ? 'unknown_account' : known === true ? 'account' : 'account_unverified',
          // Per key: global, overlay, effective, and where the overlay came
          // from. Provenance is READ from the change history, never invented —
          // `source: 'unknown'` and `writtenAt: null` mean nothing recorded it.
          // `reason` is null for every key because nothing records one today.
          provenance: effectiveRiskEntries(db, acct),
        },
        account: {
          // Balance and leverage follow the same scope: an account's risk is
          // sized off ITS balance, and showing another's would make every
          // derived lot figure on the page wrong.
          balance: (acct ? getAccountBalance(db, acct) : null) ?? brokerBalance ?? getAccountBalance(db),
          balanceSource: acct ? 'stored' : (brokerBalance != null ? 'broker' : 'stored'),
          balanceFetchedAt: !acct && brokerBalance != null ? snap.fetchedAt : null,
          leverage: getAccountLeverage(db, effective, acct),
          // Pepperstone forces liquidation at 50% margin level on this
          // account — real observed history (risk.js: owner hit 16 open,
          // margin level 126% vs 50% stop-out). Broker-set, not editable.
          brokerStopOutPct: 50,
          accountId: acct ?? (getState(db, 'ctrader_account_id') || null),
          isLive: getState(db, 'ctrader_is_live') === 'true',
        },
        // TODAY'S ACTUAL ALLOWANCE, computed by the same function the risk
        // gate uses. The paced cap is a moving number, and the one thing worse
        // than not showing it is showing a second, subtly different version of
        // it: the FX-day anchor is DST-aware (17:00 New York), so a browser
        // reimplementation would drift twice a year and disagree with the veto
        // line. Null when nothing is paced.
        dailyPacing: await (async () => {
          const { fxDayOpenMs, fxDayStartSql } = await import('../services/risk.js')
          const { pacedDailyCap } = await import('../services/daily-loss-pacing.js')
          const balance = (acct ? getAccountBalance(db, acct) : null) ?? brokerBalance ?? getAccountBalance(db)
          // No balance no longer means nothing to report: the flat $ cap is a
          // live check of its own now, and with the % check inapplicable it is
          // the ONLY thing standing between the account and an uncapped day —
          // exactly the state the Risk page has to be able to warn about.
          const nowMs = Date.now()
          const id = acct ?? (getState(db, 'ctrader_account_id') || null)
          let spent = 0
          try {
            const row = db.prepare(
              `SELECT COALESCE(SUM(net_pnl), 0) AS pnl FROM trades
                WHERE status = 'closed' AND REPLACE(closed_at, 'T', ' ') >= ?
                  AND (account_id = ? OR account_id IS NULL OR ? IS NULL)`
            ).get(fxDayStartSql(nowMs), id, id)
            spent = Math.max(0, -(row?.pnl || 0))
          } catch { /* no trades table slice — report the allowance, not the spend */ }
          const p = pacedDailyCap({
            balance,
            basePct: effective.dailyLossPct,
            maxPct: effective.dailyLossPctMax,
            absoluteFallback: effective.dailyLossLimit,
            nowMs,
            dayOpenMs: fxDayOpenMs(nowMs),
            spentUsd: spent,
            perTradeRiskUsd: effective.perTradeRiskUsd > 0
              ? Number(effective.perTradeRiskUsd)
              : (balance > 0 ? balance * effective.perTradeRiskPct : 0),
          })
          return { ...p, spentUsd: spent, accountId: id, balance: balance > 0 ? balance : null }
        })(),
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
          return {
            effective: loadLossCapConfig(db, acct),
            defaults: DEFAULT_LOSS_CAP,
            accountId: acct,
            // Which fields THIS account has pinned. Named, so an override can
            // never be invisible — the same rule the risk overlay follows.
            overlayKeys: acct ? acctOverlayKeys(db, 'loss_cap_json', acct) : [],
          }
        })(),
        profitRatchet: await (async () => {
          const { loadProfitRatchetConfig, DEFAULT_PROFIT_RATCHET, loadRatchetState } = await import('../services/profit-ratchet.js')
          // WHOSE LADDER (owner 04-08-2026, three screenshots): switching the
          // account on the Risk page did not change the Live staircase —
          // baseline and high-water mark read identically for 5203012, 5306502
          // and 5268549, because this loaded the SELECTED account's ladder and
          // ignored ?account= entirely. Same defect as the balance with no
          // owner: a number rendered under a name it does not belong to.
          // The queried account wins; the selected one is only the fallback
          // for a caller that named nobody.
          const sel = acct ?? getState(db, 'ctrader_account_id')
          return {
            effective: loadProfitRatchetConfig(db, acct),
            overlayKeys: acct ? acctOverlayKeys(db, 'profit_ratchet_json', acct) : [],
            defaults: DEFAULT_PROFIT_RATCHET,
            state: sel ? loadRatchetState(db, sel) : null,
            // WHOSE ladder this is. Without the id the page can render a halt
            // it has no way to lift — POST /actions/ratchet-account is
            // per-account by design, and the alternative (reset every
            // staircase) is exactly the blunt instrument it replaced.
            accountId: sel || null,
          }
        })(),
        lossGuardian: await (async () => {
          const { loadLossGuardianConfig, DEFAULT_LOSS_GUARDIAN } = await import('../services/loss-guardian.js')
          return {
            effective: loadLossGuardianConfig(db, acct),
            defaults: DEFAULT_LOSS_GUARDIAN,
            accountId: acct,
            overlayKeys: acct ? acctOverlayKeys(db, 'loss_guardian_json', acct) : [],
          }
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
      const accountId = req.query.account && req.query.account !== 'all' ? String(req.query.account) : null
      res.json({ ok: true, accountId, rows: strategyInsights(db, { sinceDays: days, accountId }) })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // GET /state/market-pulse — trending / herding / defended, per symbol.
  //
  // Owner 05-08-2026: "Create an algo to understand movements and big moves
  // that give more awareness to the symbol trading and pending to trade."
  // This is the read side of it. Global by construction — a market regime is
  // not a property of an account, and scoping it to one would be a category
  // error the way scoping cluster exposure to all of them was.
  // -----------------------------------------------------------------------
  router.get('/market-pulse', (req, res) => {
    try {
      const sym = String(req.query.symbol || '').toUpperCase().trim()
      if (sym) return res.json({ symbol: sym, ...pulseFor(db, sym) })
      const p = loadPulse(db)
      if (!p) return res.json({ builtAt: null, states: PULSE_STATES, readings: {}, herds: [], sharp: [], defended: [], divergences: [] })
      res.json({ states: PULSE_STATES, ...p })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // -----------------------------------------------------------------------
  // GET /state/symbol-descriptions — SYMBOL → the broker's own long name.
  //
  // Owner 04-08-2026: "Add a Description column next to the symbol… XAUUSD is
  // Gold, AMD.US is AMD, GEV is GE Vernova." The names come from the cTrader
  // catalogue, which /actions/instrument-tree already fetches and caches for
  // 24h. This route serves the map OUT of that cache and NEVER calls the
  // broker: the watchlist loads on every page view, and a 1,900-instrument
  // catalogue fetch on each one would be a self-inflicted rate limit. An empty
  // map is a correct answer — symbol-taxonomy.js's curated table is the
  // fallback and covers every instrument with an unreadable ticker.
  // -----------------------------------------------------------------------
  router.get('/symbol-descriptions', (_req, res) => {
    try {
      const cached = getState(db, 'instrument_tree_json')
      if (!cached) return res.json({ descriptions: {}, cached: false, builtAt: null })
      const parsed = JSON.parse(cached)
      res.json({
        descriptions: parsed.descriptions || {},
        cached: true,
        builtAt: parsed.builtAt || null,
        // Named, not silent: a tree cached before this shipped has no
        // descriptions at all, and the UI should be able to say so rather
        // than look like the broker has no names for anything.
        count: Object.keys(parsed.descriptions || {}).length,
      })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // GET /state/watchlist-stats — LIVE per-symbol results for the Watchlist
  // table: closed trades, net P&L, win rate, and a loser flag once a symbol
  // has enough sample (n >= min_n) and is net negative. The watchlist stays
  // configuration — this is the evidence beside it.
  // -----------------------------------------------------------------------
  router.get('/watchlist-stats', (req, res) => {
    try {
      const MIN_N = 10
      // S1 batch 4. This route decides which symbols are flagged `loser` on
      // the watchlist. Pooled, a symbol that loses on one account's settings
      // is condemned on every account — and one that loses on ONLY the
      // account you are looking at is hidden by the others' wins.
      const scope = requestedAccount(db, req)
      const acct = accountWhere(scope, 'account_id')
      const rows = db.prepare(
        `SELECT UPPER(symbol) AS sym, COUNT(*) AS n, ROUND(SUM(net_pnl), 2) AS net, SUM(net_pnl > 0) AS wins,
                MAX(COALESCE(closed_at, opened_at)) AS lastAt
         FROM trades WHERE status = 'closed' AND net_pnl IS NOT NULL${acct.active ? ` AND ${acct.where}` : ''}
         GROUP BY UPPER(symbol)`
      ).all(...acct.params)
      const by = {}
      for (const r of rows) {
        by[r.sym] = {
          n: r.n,
          net: r.net,
          winRate: r.n ? Math.round((r.wins / r.n) * 100) : null,
          loser: r.n >= MIN_N && r.net < 0,
          // Owner 04-08-2026: "Live signal to add {last traded date DD/MM}".
          // The scan tells you what the bot thinks NOW; without this the row
          // never says when it last acted on that opinion, so a symbol that
          // has not traded in three weeks looks identical to one that traded
          // this morning.
          lastAt: r.lastAt || null,
        }
      }
      // DURABLE backtest counts, same request. The watchlist's "Backtest
      // trades" column read the page's in-memory `bt` state — the result of a
      // backtest run in THIS browser session — so it was empty on every fresh
      // load, which is what the owner is looking at ("Backtest trade column
      // isn't filled"). backtest_runs has carried the answer all along.
      let backtests = {}
      try {
        const btRows = db.prepare(
          `SELECT UPPER(symbol) AS sym, SUM(COALESCE(trades, 0)) AS trades,
                  COUNT(*) AS runs, MAX(ran_at) AS lastRanAt
             FROM backtest_runs${acct.active ? ` WHERE ${acct.where}` : ''}
            GROUP BY UPPER(symbol)`
        ).all(...acct.params)
        for (const r of btRows) backtests[r.sym] = { trades: r.trades || 0, runs: r.runs, lastRanAt: r.lastRanAt }
      } catch { backtests = {} }

      res.json({
        min_n: MIN_N, by, backtests,
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        scoped: acct.active,
        scope: scopeReport(scope, scopeCoverage(db, {
          table: 'trades', scope, extraWhere: "status = 'closed' AND net_pnl IS NOT NULL",
        })),
      })
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
      // ?account=<id> scopes the grid to that account's closed trades
      // (strict equality — legacy NULL-account rows only count in All).
      const acct = req.query.account && req.query.account !== 'all' ? String(req.query.account) : null
      const rows = db.prepare(
        `SELECT COALESCE(${strategyAttrSql()}, 'unlabelled') AS strat,
                COALESCE(label_timeframe, '—') AS tf,
                COUNT(*) AS n, ROUND(SUM(net_pnl), 2) AS net, SUM(net_pnl > 0) AS wins
         FROM trades
         WHERE status = 'closed' AND net_pnl IS NOT NULL AND closed_at >= datetime('now', ?)
           ${acct ? 'AND account_id = ?' : ''}
         GROUP BY strat, tf`
      ).all(`-${days} days`, ...(acct ? [acct] : []))
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

  // GET /state/bot-changes — the bot's change ledger (see /actions/bot-note):
  // what the agent changed on the owner's behalf, and when. The UI paints
  // yellow borders on the touched sections and lists entries in the sidebar.
  router.get('/bot-changes', (_req, res) => {
    let rows = []
    try { rows = JSON.parse(getState(db, 'bot_changes_json') || '[]') } catch { rows = [] }
    res.json({ rows: Array.isArray(rows) ? rows : [] })
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
  router.get('/stage-matrix', (req, res) => {
    try {
      // ?account=<id> returns what THAT account actually trades under: the
      // global matrix with its overlay merged on top, plus the list of cells
      // it has pinned so the UI can badge them rather than leaving an override
      // invisible.
      const acct = req.query?.account && req.query.account !== 'all' ? String(req.query.account) : null
      const view = stageMatrixView(db, getState)
      // A TALLY PER ACCOUNT (owner 04-08-2026: "have a count of tick/cross per
      // account"). The matrix shows one scope at a time, so "how much is armed
      // over there" was a question you could only answer by switching scope
      // and counting cells by eye — across five accounts and every stage.
      //
      // The counting lives in stage-matrix.js beside loadStageMatrix, so this
      // route and the WRITE route answer with the same numbers. They did not,
      // at first: the write returned no tallies, so a freshly-flipped tick
      // disagreed with the tally under it until the next poll.
      const tallies = accountStageTallies(db, getState)
      if (!acct) return res.json({ ...view, accountId: null, overlayKeys: [], tallies })
      const scoped = loadStageMatrix(db, getState, acct)
      res.json({ ...view, ...scoped, accountId: acct, overlayKeys: stageOverlayKeys(db, getState, acct), tallies })
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
      // The ATR sweep's own account of itself, alongside the beat. A
      // heartbeat can only say ok/failed; this says WHY — how many symbols it
      // had, how many fetches threw and with what message, and how many rows
      // exist afterwards. #170 ("atr_history empty") was unanswerable from
      // the panel alone, and that is the gap this closes.
      let atrRefresh = null
      try { atrRefresh = JSON.parse(getState(db, 'atr_refresh_last_json') || 'null') } catch { atrRefresh = null }
      // The roster invariant, reported rather than assumed. The boot repair
      // restores `mode !== 'archived' ⇒ enabled = 1`, but a writer that
      // recreates the pair at runtime would go unnoticed until the next boot —
      // and the state it creates is an account whose capabilities claim MANAGE
      // while no amend or close can reach it. Empty is the healthy answer.
      let rosterInvariant = []
      try {
        const { rosterInvariantViolations } = await import('../services/account-capabilities.js')
        rosterInvariant = rosterInvariantViolations(db)
      } catch { rosterInvariant = [] }
      res.json({ controllers: heartbeatView(db), atrRefresh, rosterInvariant })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/phase-trace — the S.A.T. tracer (owner 01-08: "setup a
  // tracer"). Every physical change to the pipeline flags (DB triggers),
  // each one attributed to its setPhaseFlag audit row or flagged as a raw
  // write with the caller's stack — or UNATTRIBUTED, which is the finding.
  // -----------------------------------------------------------------------
  router.get('/phase-trace', async (req, res) => {
    try {
      const { phaseTraceView } = await import('../services/phase-audit.js')
      res.json(phaseTraceView(db, { limit: req.query.limit ? Number(req.query.limit) : 100 }))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /state/storage — what is on the volume (owner 01-08, after growing
  // it 1GB → 5GB): DB/WAL file sizes, per-table rows+bytes, biggest state
  // keys, volume free space. On-demand diagnostics — the full-page walk is
  // too heavy to poll, so it rides the shared state cache like every read.
  // -----------------------------------------------------------------------
  router.get('/storage', async (_req, res) => {
    try {
      const { storageReport } = await import('../services/storage-report.js')
      res.json(storageReport(db))
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
      const scope = requestedAccount(db, req)
      res.json({
        ...alphaDecayView(db, { window, scope }),
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        scope: scopeReport(scope, scopeCoverage(db, {
          table: 'trades', scope, extraWhere: "status = 'closed' AND net_pnl IS NOT NULL",
        })),
      })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // /state/veto-breakdown was DECLARED TWICE. Express serves the first
  // registration and silently ignores every later one, so the second handler
  // — a simpler, account-BLIND version that split reasons on the first
  // delimiter — had never run. It was removed rather than merged: the live
  // one delegates to services/veto-breakdown.js and already accepts
  // ?account=, which is strictly more than the dead one did.
  //
  // The hazard is not the wasted lines, it is that a dead route looks alive.
  // Editing it changes nothing, and reading it tells you the endpoint is
  // account-blind when it is not. A guard test now fails the build on any
  // duplicate path in this file.

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

  // -----------------------------------------------------------------------
  // GET /state/fx-legs — the conversion rates position sizing depends on.
  //
  // This view exists because its absence cost a day. 1,859 entries in seven
  // days were vetoed `usd_per_lot_unknown` and nothing on any page said WHY:
  // the answer was that USDPLN, USDNOK and USDCAD had not been re-scanned
  // since 01-08 and had aged out of the rate table. One table of currency /
  // leg / age / state would have shown that at a glance.
  //
  // Global by declaration: FX rates are market facts, not account data.
  // -----------------------------------------------------------------------
  router.get('/fx-legs', async (_req, res) => {
    try {
      const { fxLegReport } = await import('../services/fx-legs.js')
      const { fxRatesStatus } = await import('../services/fx-rates.js')
      const { readTradableUnion } = await import('../services/watchlists.js')
      const { getSymbolMap } = await import('../lib/ctrader-creds.js')
      let symbols = []
      try { symbols = readTradableUnion(db).map(w => w.symbol).filter(Boolean) } catch { symbols = [] }
      const report = fxLegReport(db, { symbols, symbolMap: getSymbolMap(db) })
      res.json({
        ok: true,
        ...report,
        table: fxRatesStatus(db),
        watchlistSymbols: symbols.length,
        scope: { mode: 'global', reason: 'FX rates are market-wide, not per-account' },
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
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
  router.get('/broker-orders', (req, res) => {
    // S1 batch 3. externalPositions is a scoped read; pendingOrders is NOT —
    // it is a broker snapshot blob in agent_state with no account column, so
    // it stays portfolio-wide and says so rather than being filtered on a
    // field it does not have.
    const scope = requestedAccount(db, req)
    const acct = accountWhere(scope, 'mp.account_id')
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
         WHERE mp.status = 'active' AND mp.source = 'external'${acct.active ? ` AND ${acct.where}` : ''}
         ORDER BY mp.created_at DESC`
      ).all(...acct.params)
      let pendingOrders = []
      try { pendingOrders = JSON.parse(pendingJson || '[]') } catch { /* non-fatal */ }
      res.json({
        externalPositions, pendingOrders, lastReconcileAt,
        accountId: scope.all ? 'all' : (scope.accountId ?? null),
        scoped: acct.active,
        scope: scopeReport(scope, scopeCoverage(db, {
          table: 'monitored_positions', scope,
          extraWhere: "status = 'active' AND source = 'external'",
        })),
        // The broker pending-order snapshot has no account column of its own.
        pendingOrdersScoped: false,
      })
    } catch (e) {
      res.json({ externalPositions: [], pendingOrders: [], lastReconcileAt: null, error: e.message })
    }
  })

  // GET /state/ctrader-env — which variable filled each credential slot, and
  // whether the host's env value is being ignored in favour of the stored one.
  //
  // NAMES ONLY. No credential value is read into the response; `stored` and
  // `envIgnored` are booleans computed inside lib/ctrader-env.js.
  //
  // This exists because the same facts were already being written to the boot
  // log by #743 and could not be read: the Railway connector dropped the same
  // day, and a diagnostic nobody can reach answers nothing.
  //
  // The slot/conflict half shares ctraderEnvReport() with the boot lines. The
  // `envIgnored` half does NOT share a call site with index.js's seedOrExplain
  // — that function seeds as well as explains, and folding it in here would
  // mean a GET with a write in it. The two therefore restate the same rule in
  // two places, which is a real (small) drift risk; ENV_SEEDED_STATE_KEYS and
  // its test are what pin them together.
  router.get('/ctrader-env', async (_req, res) => {
    try {
      const { ctraderEnvStatus } = await import('../lib/ctrader-env.js')
      const slots = ctraderEnvStatus({ stored: (k) => getState(db, k) })
      res.json({
        slots,
        conflicts: slots.filter(s => s.conflict).map(s => s.kind),
        ignored: slots.filter(s => s.envIgnored).map(s => s.kind),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
