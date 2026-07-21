// ---------------------------------------------------------------------------
// agent/routes/actions.js — POST endpoints for manual triggers
// ---------------------------------------------------------------------------

import { Router } from 'express'
import { getState, setState, sweepMonitoredPositionsForAccount, sweepMonitoredPositionsForAccounts } from '../db.js'
import { runFibScan, synthesizeFibSignal, scanSymbolFib } from '../services/fib-strategy.js'
import { getCtraderCreds, getSymbolMap, ensureSymbolMap } from '../lib/ctrader-creds.js'
import { ctraderEnv } from '../lib/ctrader-env.js'
import { DEFAULT_RISK_CONFIG, loadRiskConfig, evaluateTrade, persistRiskEvent } from '../services/risk.js'
import { wsPlaceOrder, wsGetTrendbarsBatch, wsGetSpotOnce } from '../lib/ctrader-ws.js'
import { getActiveSessions } from '../lib/sessions.js'
import { encodeLabel, parseLabel, convictionBucket, LABEL_VERSION } from '../lib/trade-labels.js'
import { parseTimeframe } from '../lib/timeframes.js'
import { getVolumeMeta, lotsToVolume, relativePoints } from '../lib/lot-sizing.js'
import { amendPosition as execAmendPosition, closePosition as execClosePosition, placeOrder as execPlaceOrder, reconcile as execReconcile } from '../lib/exec-engine.js'
import { STRATEGY_REGISTRY, STRATEGY_KEYS, enabledStrategies } from '../services/strategies.js'
import { setStage } from '../services/stage-matrix.js'
import { loadPerformanceBreakerConfig } from '../services/performance-breaker.js'
import { loadSessionOpenGuardConfig } from '../services/session-open-guard.js'
import { loadCorrelationMatrixConfig } from '../services/correlation-matrix.js'
import { setAssetController } from '../services/asset-controllers.js'

/**
 * Resolve which symbols a backtest run covers.
 * Priority: explicit `symbols` list > legacy single `symbol` > every ENABLED
 * watchlist symbol (the instruments set on Tune — never a hardcoded default).
 * Uppercased, deduped, capped at 8 per run (sequential broker fetches).
 *
 * @param {{symbols?: string[], symbol?: string}|undefined} body
 * @param {string|null} watchlistJson — raw autopilot_symbols_json state
 * @returns {string[]}
 */
export function pickBacktestSymbols(body, watchlistJson) {
  let names = Array.isArray(body?.symbols) && body.symbols.length
    ? body.symbols
    : body?.symbol ? [body.symbol] : null
  if (!names) {
    try {
      const raw = JSON.parse(watchlistJson || '[]')
      names = (Array.isArray(raw) ? raw : [])
        .map(s => (typeof s === 'string' ? { symbol: s } : s))
        .filter(s => s.enabled !== false)
        .map(s => s.symbol)
    } catch { names = [] }
  }
  // Cap raised from 8 (sequential-fetch era) — fetches now run 3-wide.
  // Anything beyond the cap must be reported by the caller, never silent.
  return [...new Set(names.map(s => String(s).toUpperCase().trim()).filter(Boolean))].slice(0, 24)
}

/**
 * Factory — returns a configured Express Router.
 * The caller (index.js) passes the better-sqlite3 `db` instance.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {import('express').Router}
 */
export default function actionsRouter(db) {
  const router = Router()

  // -----------------------------------------------------------------------
  // POST /actions/backtest — walk-forward backtest of the fib strategy on
  // REAL broker bars. The go/no-go gate before arming autotrade.
  // Body: { symbols=[…], symbol (legacy single), timeframes=['4h','1d'],
  //         bars=1000, rsiFilter=false }
  // With no symbols in the body it tests every ENABLED watchlist symbol —
  // the instruments the trader set on Tune, never a hardcoded default.
  // Fetches all timeframes per symbol over one authenticated connection each.
  // -----------------------------------------------------------------------
  router.post('/backtest', async (req, res) => {
    try {
      // Requested symbols: explicit list > legacy single > enabled watchlist.
      const names = pickBacktestSymbols(
        req.body,
        getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json'),
      )
      if (names.length === 0) {
        return res.status(400).json({ error: 'No symbols to test — watchlist is empty and none were given' })
      }

      const rawTfs = Array.isArray(req.body?.timeframes) && req.body.timeframes.length
        ? req.body.timeframes : ['4h', '1d']
      // Canonicalize (free-text like "1.5h"/"90m" allowed) — reject junk
      // here with a clear 400 instead of a 502 from the bar fetcher.
      const parsedTfs = rawTfs.map(t => parseTimeframe(String(t)))
      const badTfs = rawTfs.filter((_, i) => !parsedTfs[i])
      if (badTfs.length) {
        return res.status(400).json({ error: `unreadable timeframe(s): ${badTfs.join(', ')} — use forms like 15m, 90m, 1.5h, 4h, 2d, 1w, 1M` })
      }
      const tfSeen = new Set()
      const timeframes = parsedTfs.filter(p => !tfSeen.has(p.ms) && tfSeen.add(p.ms)).map(p => p.label)
      const count = Math.min(3000, Math.max(200, Number(req.body?.bars) || 1000))
      const rsiFilter = req.body?.rsiFilter ? {} : null
      const vwapFilter = req.body?.vwapFilter ? {} : null
      const fvgFilter = req.body?.fvgFilter ? {} : null
      const sessionFilter = !!req.body?.sessionFilter
      // Any registry strategy is backtestable — unknown keys are a clear 400.
      const strategy = req.body?.strategy || 'fib_618_fade'
      if (!STRATEGY_KEYS.includes(strategy)) {
        return res.status(400).json({ error: `unknown strategy '${strategy}' — one of: ${STRATEGY_KEYS.join(', ')}` })
      }
      const entryMode = req.body?.entryMode === 'touch' ? 'touch' : 'close'
      // Evaluation profile: the DEFAULT backtest samples the setup more
      // permissively than LIVE so a testable sample appears instead of the
      // "0 trades → NO-GO everywhere" the owner hit. Live autotrade keeps its
      // own conviction>=8 / rr>=1.5 gates (untouched by this route) — these
      // numbers only govern what the backtest counts. Both overridable per
      // request; minConviction: 8 + minRr: 1.5 reproduces the strict live view.
      const EVAL_MIN_CONVICTION = 3
      const EVAL_MIN_RR = 1.2
      const minConviction = req.body?.minConviction != null ? Number(req.body.minConviction) : EVAL_MIN_CONVICTION
      const minRr = req.body?.minRr != null ? Number(req.body.minRr) : EVAL_MIN_RR

      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const map = await ensureSymbolMap(db, creds)

      const { runBacktest, walkForward } = await import('../scripts/backtest-fib.js')
      const { host, clientId, clientSecret, accessToken, accountId } = creds

      // Background job: the run belongs to the AGENT, not the browser tab
      // that fired it — navigating away no longer loses the results. The UI
      // polls GET /state/backtest-job to collect them.
      const { startBacktestJob, jobMeta } = await import('../services/backtest-job.js')
      const runWork = async () => {
      const symbols = {}
      const testOne = async (name) => {
        const symbolId = map[name]
        if (!symbolId) {
          symbols[name] = { error: 'not offered by this broker account' }
          return
        }
        try {
          const byPeriod = await wsGetTrendbarsBatch(host, clientId, clientSecret, accessToken, accountId, symbolId, timeframes, count, 60_000)
          const results = {}
          for (const tf of timeframes) {
            const bars = byPeriod[tf] || []
            if (bars.length < 100) {
              results[tf] = { error: `only ${bars.length} bars available` }
              continue
            }
            const btOpts = {
              timeframe: tf,
              rsiFilter,
              vwapFilter,
              fvgFilter,
              sessionFilter,
              symbol: name,
              strategy,
              entryMode,
              // evaluation profile (see above) — a testable sample, not the
              // strict live gate; pass minConviction:8 / minRr:1.5 to reproduce live
              minConviction,
              minRr,
            }
            const { stats } = runBacktest(bars.slice(0, -1), btOpts)
            // Walk-forward: same rule over 4 sequential segments — evidence
            // that the edge repeats, not one lucky window.
            const wf = walkForward(bars.slice(0, -1), btOpts, 4)
            results[tf] = {
              ...stats,
              barsUsed: bars.length - 1,
              wfSegments: wf.segments,
              wfActive: wf.active,
              wfPositive: wf.positive,
              wfWorstMddPct: wf.worstMddPct,
            }
          }
          symbols[name] = { results }
        } catch (err) {
          // one symbol failing (ws timeout, thin data) must not sink the rest
          symbols[name] = { error: err.message }
        }
      }
      // 3 symbols in flight — same concurrency the screener proved safe.
      for (let bi = 0; bi < names.length; bi += 3) {
        await Promise.all(names.slice(bi, bi + 3).map(testOne))
      }
      // Carry the strategy's display name + key so the report labels the run
      // that ACTUALLY ran — the renderer used to hardcode "Fib 61.8% fade" for
      // every non-cup strategy, so an RSI/EMA/VWAP run printed as fib.
      const strategyName = STRATEGY_REGISTRY.find(s => s.key === strategy)?.name || strategy
      const payload = { symbols, bars: count, rsiFilter: !!rsiFilter, vwapFilter: !!vwapFilter, fvgFilter: !!fvgFilter, sessionFilter, strategy, strategyName, entryMode, minConviction, minRr, ranAt: new Date().toISOString() }
      // Persist a self-contained HTML report under backtest/results/ and hand
      // the same document to the UI for a browser download. A write failure
      // (read-only disk) must not sink the backtest itself.
      try {
        const { saveBacktestReport } = await import('../lib/backtest-report.js')
        payload.report = saveBacktestReport(payload)
      } catch (err) {
        payload.report = { error: err.message }
      }
      // Persist the owner's backtest BASELINE so Edge health can compare
      // live results against "your edge as tested" (combo-level PF/win%).
      try {
        const combos = []
        for (const [symName, data] of Object.entries(symbols)) {
          for (const [tf, r] of Object.entries(data.results || {})) {
            if (r && !r.error) {
              combos.push({
                symbol: symName, tf,
                trades: r.trades ?? 0,
                profitFactor: r.profitFactor ?? null,
                totalProfitPct: r.totalProfitPct ?? null,
                winRatePct: r.winRatePct ?? null,
                wfPositive: r.wfPositive ?? null,
                wfActive: r.wfActive ?? null,
              })
            }
          }
        }
        const baseline = { ranAt: payload.ranAt, strategy, entryMode, bars: count, combos }
        setState(db, 'backtest_baseline_json', JSON.stringify(baseline)) // last run (back-compat)
        // Per-strategy map so Edge health can vouch for EVERY armed strategy's
        // tested edge, not just the last one backtested (owner: "why didn't you
        // update the rest of the strategies used?"). Keyed by strategy; each
        // new run for a strategy replaces that strategy's entry only.
        let all = {}
        try { all = JSON.parse(getState(db, 'backtest_baselines_json') || '{}') || {} } catch { all = {} }
        if (strategy) all[strategy] = baseline
        setState(db, 'backtest_baselines_json', JSON.stringify(all))
      } catch { /* baseline is best-effort */ }
      return payload
      } // end runWork

      const started = startBacktestJob(
        { symbols: names, timeframes, bars: count, strategy, entryMode },
        runWork,
      )
      if (started.conflict) {
        return res.status(409).json({ error: 'a backtest is already running — its results will appear when it finishes', job: jobMeta(started.conflict) })
      }
      console.log(`[actions] backtest job ${started.job.id} started: ${names.join(', ')} × ${timeframes.join('/')} (${strategy}/${entryMode})`)
      res.json({ ok: true, job: jobMeta(started.job) })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/reconcile-trades — cross-check local trade rows against
  // the BROKER's deal history (the ground truth). For each row from the
  // last 30 days:
  //   · matching deal found + local entry missing → repair entry_price
  //   · NO deal at the broker → status='rejected' (the order never filled;
  //     the row stops posing as a trade)
  // Deal windows are paged in 1-week chunks (cTrader API cap).
  // -----------------------------------------------------------------------
  router.post('/reconcile-trades', async (req, res) => {
    try {
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const { host, clientId, clientSecret, accessToken, accountId } = creds
      const rows = db.prepare(
        "SELECT * FROM trades WHERE opened_at >= datetime('now', '-30 days') ORDER BY opened_at ASC"
      ).all()
      if (rows.length === 0) return res.json({ checked: 0, confirmed: 0, repaired: 0, rejected: 0, details: [] })

      const { wsGetDeals } = await import('../lib/ctrader-ws.js')
      const toMs = (v) => Date.parse(String(v).includes('T') ? v : String(v).replace(' ', 'T') + 'Z')
      const from = Math.min(...rows.map(r => toMs(r.opened_at))) - 3_600_000
      const WEEK = 7 * 24 * 3_600_000
      const deals = []
      for (let t0 = from; t0 < Date.now(); t0 += WEEK) {
        const chunk = await wsGetDeals(host, clientId, clientSecret, accessToken, accountId, t0, Math.min(t0 + WEEK, Date.now()))
        deals.push(...(chunk.deal || []))
      }

      const map = await ensureSymbolMap(db, creds)
      const details = []
      let confirmed = 0; let repaired = 0; let rejected = 0
      const upEntry = db.prepare('UPDATE trades SET entry_price = ? WHERE id = ?')
      // trades schema calls it close_reason — exit_reason crashed the whole
      // reconcile ("no such column"), leaving fills stuck UNCONFIRMED.
      const upStatus = db.prepare("UPDATE trades SET status = 'rejected', close_reason = 'no broker fill (reconciled)' WHERE id = ?")
      for (const r of rows) {
        const symbolId = map[String(r.symbol).toUpperCase()]
        const t = toMs(r.opened_at)
        const match = deals.find(d =>
          (r.ctrader_position_id && String(d.positionId) === String(r.ctrader_position_id)) ||
          (String(d.symbolId) === String(symbolId) && Math.abs((d.executionTimestamp || 0) - t) < 15 * 60_000))
        if (match) {
          const px = match.executionPrice ?? null
          const wasNull = r.entry_price == null
          if (wasNull && px != null) { upEntry.run(px, r.id); repaired++ } else confirmed++
          details.push({ id: r.id, symbol: r.symbol, result: wasNull ? 'repaired' : 'confirmed', dealId: match.dealId ?? null, positionId: match.positionId ?? null, executionPrice: px })
        } else if (r.status !== 'rejected') {
          upStatus.run(r.id); rejected++
          details.push({ id: r.id, symbol: r.symbol, result: 'rejected', note: 'no matching deal at the broker' })
        }
      }
      res.json({ checked: rows.length, confirmed, repaired, rejected, dealsSeen: deals.length, details, ranAt: new Date().toISOString() })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/adaptive-breaker — { on: boolean, streak?: 2..10 }.
  // Loss-streak response: adapt strategy/filters via the stage matrix
  // instead of pausing (the human-style cooldown is a separate dial).
  // -----------------------------------------------------------------------
  router.post('/adaptive-breaker', async (req, res) => {
    try {
      const { loadAdaptiveBreakerConfig } = await import('../services/adaptive-breaker.js')
      const current = loadAdaptiveBreakerConfig(db)
      const next = {
        ...current,
        ...(typeof req.body?.on === 'boolean' ? { on: req.body.on } : {}),
        ...(req.body?.streak != null ? { streak: Number(req.body.streak) } : {}),
      }
      setState(db, 'adaptive_breaker_json', JSON.stringify(next))
      const clamped = loadAdaptiveBreakerConfig(db)
      console.log(`[actions] adaptive breaker ${clamped.on ? 'ON' : 'off'} at streak=${clamped.streak}`)
      res.json({ ok: true, config: clamped })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/autotrade-scope — { scope: 'all' | 'armed' }. 'all'
  // (default) lets every enabled watchlist symbol trade on any scanned
  // timeframe (armed combos stay as micro-tuning); 'armed' restores the
  // narrow armed-TF/matrix gating.
  // -----------------------------------------------------------------------
  router.post('/autotrade-scope', (req, res) => {
    const scope = String(req.body?.scope || '')
    if (scope !== 'all' && scope !== 'armed') {
      return res.status(400).json({ error: "scope must be 'all' or 'armed'" })
    }
    setState(db, 'autotrade_scope', scope)
    console.log(`[actions] autotrade scope → ${scope}`)
    res.json({ ok: true, scope })
  })

  // -----------------------------------------------------------------------
  // POST /actions/weekend-bank — { on } toggles the pre-closure profit
  // sweep: inside the last window before a long (weekend/holiday) closure,
  // positions in profit are closed to bank the move before the reopen gap.
  // -----------------------------------------------------------------------
  router.post('/weekend-bank', (req, res) => {
    const on = req.body?.on !== false
    setState(db, 'weekend_bank', on ? 'true' : 'false')
    console.log(`[actions] weekend bank → ${on ? 'ON' : 'off'}`)
    res.json({ ok: true, on })
  })

  // -----------------------------------------------------------------------
  // POST /actions/guardian-move-pct — { pct } sets the tick guardian's
  // significant-move threshold (% of price) that triggers an immediate
  // position sweep between the normal 30s ticks, instead of the 0.05%
  // default only ever being changeable via a raw agent_state write. Audit
  // finding (owner: "audit the last 20 PRs, did you do what I want") — the
  // guardian's backend logic was always correct, this control just never
  // had a route/UI in front of it.
  // -----------------------------------------------------------------------
  router.post('/guardian-move-pct', (req, res) => {
    const pct = Number(req.body?.pct)
    if (!Number.isFinite(pct) || pct <= 0 || pct > 5) {
      return res.status(400).json({ error: 'pct must be a number between 0 and 5 (percent)' })
    }
    setState(db, 'guardian_move_pct', String(pct))
    console.log(`[actions] guardian move threshold → ${pct}%`)
    res.json({ ok: true, pct })
  })

  // -----------------------------------------------------------------------
  // POST /actions/asset-controller — { class, beTriggerR?, partialTriggerR?,
  // runnerTriggerR?, runnerTrailR? } sets one asset class's trade-management
  // triggers (owner: "separate controllers for forex/indices/commodities").
  // A null/absent value for a key clears it back to the class default.
  // -----------------------------------------------------------------------
  router.post('/asset-controller', (req, res) => {
    const cls = String(req.body?.class || '')
    try {
      const view = setAssetController(db, cls, req.body || {})
      console.log(`[actions] asset controller ${cls} updated`)
      res.json({ ok: true, asset_controllers: view })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/correlation-matrix — { on?, threshold?, maxCorrelated? }
  // tunes the live-computed correlation veto (owner: "I want the
  // live-computed version").
  // -----------------------------------------------------------------------
  router.post('/correlation-matrix', (req, res) => {
    const cur = loadCorrelationMatrixConfig(db)
    const b = req.body || {}
    const next = {
      ...cur,
      on: b.on !== undefined ? b.on !== false : cur.on,
      threshold: b.threshold !== undefined ? Math.min(0.99, Math.max(0.3, Number(b.threshold) || cur.threshold)) : cur.threshold,
      maxCorrelated: b.maxCorrelated !== undefined ? Math.min(10, Math.max(1, Math.round(Number(b.maxCorrelated) || cur.maxCorrelated))) : cur.maxCorrelated,
    }
    setState(db, 'correlation_matrix_json', JSON.stringify(next))
    console.log(`[actions] correlation matrix →`, next)
    res.json({ ok: true, ...next })
  })

  // -----------------------------------------------------------------------
  // POST /actions/regime-gate — { on } toggles the regime entry gate (don't
  // fade a trend / chase a range). Owner: "trading like a beginner", PF 0.15.
  // -----------------------------------------------------------------------
  router.post('/regime-gate', (req, res) => {
    const on = req.body?.on !== false
    setState(db, 'regime_gate_json', JSON.stringify({ on }))
    console.log(`[actions] regime gate → ${on ? 'ON' : 'off'}`)
    res.json({ ok: true, on })
  })

  // -----------------------------------------------------------------------
  // POST /actions/session-open-guard — { on?, windowMin?, minR? } tunes the
  // session-open breakeven lock (owner: "when markets open, XAUUSD went
  // from profit to loss" → "build the session-open guard").
  // -----------------------------------------------------------------------
  router.post('/session-open-guard', (req, res) => {
    const cur = loadSessionOpenGuardConfig(db)
    const b = req.body || {}
    const next = {
      on: b.on !== undefined ? b.on !== false : cur.on,
      windowMin: b.windowMin !== undefined ? Math.min(120, Math.max(5, Math.round(Number(b.windowMin) || cur.windowMin))) : cur.windowMin,
      minR: b.minR !== undefined ? Math.min(0.69, Math.max(0.05, Number(b.minR) || cur.minR)) : cur.minR,
    }
    setState(db, 'session_open_guard_json', JSON.stringify(next))
    console.log(`[actions] session-open guard →`, next)
    res.json({ ok: true, ...next })
  })

  // -----------------------------------------------------------------------
  // POST /actions/performance-breaker — { on?, window?, minTrades?,
  // pfThreshold?, autoDisarm? } tunes the "all hands on deck" rolling
  // profit-factor checkpoint (owner: "what checkpoints would trigger all
  // hands on deck to turn the tide").
  // -----------------------------------------------------------------------
  router.post('/performance-breaker', (req, res) => {
    const cur = loadPerformanceBreakerConfig(db)
    const b = req.body || {}
    const next = {
      on: b.on !== undefined ? b.on !== false : cur.on,
      window: b.window !== undefined ? Math.min(200, Math.max(5, Math.round(Number(b.window) || cur.window))) : cur.window,
      minTrades: b.minTrades !== undefined ? Math.min(200, Math.max(5, Math.round(Number(b.minTrades) || cur.minTrades))) : cur.minTrades,
      pfThreshold: b.pfThreshold !== undefined ? Math.min(2, Math.max(0.1, Number(b.pfThreshold) || cur.pfThreshold)) : cur.pfThreshold,
      autoDisarm: b.autoDisarm !== undefined ? b.autoDisarm === true : cur.autoDisarm,
    }
    setState(db, 'performance_breaker_json', JSON.stringify(next))
    console.log(`[actions] performance breaker →`, next)
    res.json({ ok: true, ...next })
  })

  // -----------------------------------------------------------------------
  // POST /actions/llm-budget — { dailyCapUsd } arms the once-a-day Telegram
  // alert when estimated Anthropic spend crosses the cap. 0/null disarms.
  // -----------------------------------------------------------------------
  router.post('/llm-budget', (req, res) => {
    const raw = req.body?.dailyCapUsd
    if (raw == null || raw === '' || Number(raw) === 0) {
      setState(db, 'llm_daily_cost_alert_usd', null)
      return res.json({ ok: true, dailyCapUsd: null })
    }
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0.1 || n > 1000) {
      return res.status(400).json({ error: 'dailyCapUsd must be between 0.10 and 1000 (or 0 to disarm)' })
    }
    setState(db, 'llm_daily_cost_alert_usd', String(n))
    setState(db, 'llm_spend_alerted_day', null) // re-arm today under the new cap
    console.log(`[actions] LLM daily cost alert cap: $${n}`)
    res.json({ ok: true, dailyCapUsd: n })
  })

  // -----------------------------------------------------------------------
  // POST /actions/monitor-interval — { minutes: 1..5 } base cadence for the
  // fast position monitor (volume scales it 1×/2×/3× automatically).
  // -----------------------------------------------------------------------
  router.post('/monitor-interval', (req, res) => {
    const n = Number(req.body?.minutes)
    if (!Number.isFinite(n) || n < 0.5 || n > 5) {
      return res.status(400).json({ error: 'minutes must be between 0.5 and 5' })
    }
    setState(db, 'monitor_interval_min', String(n))
    console.log(`[actions] fast position monitor base interval: ${n}m`)
    res.json({ ok: true, minutes: n })
  })

  // -----------------------------------------------------------------------
  // POST /actions/monitor-override — { symbol, minutes } pins one symbol's
  // monitor cadence (0.25–30 min), beating the volume-adaptive pace;
  // { symbol, minutes: null } clears it back to auto.
  // -----------------------------------------------------------------------
  router.post('/monitor-override', (req, res) => {
    const symbol = String(req.body?.symbol || '').toUpperCase().trim()
    if (!symbol) return res.status(400).json({ error: 'symbol required' })
    let overrides = {}
    try { overrides = JSON.parse(getState(db, 'monitor_overrides_json') || '{}') || {} } catch { overrides = {} }
    const minutes = req.body?.minutes
    if (minutes == null || minutes === '') {
      delete overrides[symbol]
    } else {
      const n = Number(minutes)
      if (!Number.isFinite(n) || n < 0.25 || n > 30) {
        return res.status(400).json({ error: 'minutes must be between 0.25 and 30 (or null to clear back to auto)' })
      }
      overrides[symbol] = n
    }
    setState(db, 'monitor_overrides_json', JSON.stringify(overrides))
    console.log(`[actions] monitor override: ${symbol} → ${overrides[symbol] != null ? `${overrides[symbol]}m` : 'auto'}`)
    res.json({ ok: true, overrides })
  })

  // -----------------------------------------------------------------------
  // POST /actions/burn-in — arm/disarm track-record burn-in mode.
  // Body: { on: boolean, sizeMode?: 'auto'|'fixed', lots?, maxPerCycle?,
  // targetTrades?, windowDays? }. 'auto' = uncapped risk-based sizing;
  // 'fixed' pins lots 0.01–0.05. Values clamped in loadBurnInConfig.
  // -----------------------------------------------------------------------
  router.post('/burn-in', async (req, res) => {
    try {
      const { loadBurnInConfig } = await import('../services/burn-in.js')
      const current = loadBurnInConfig(db)
      const next = {
        ...current,
        ...(typeof req.body?.on === 'boolean' ? { on: req.body.on } : {}),
        ...(req.body?.sizeMode != null ? { sizeMode: String(req.body.sizeMode) } : {}),
        ...(req.body?.lots != null ? { lots: Number(req.body.lots) } : {}),
        ...(req.body?.maxPerCycle != null ? { maxPerCycle: Number(req.body.maxPerCycle) } : {}),
        ...(req.body?.targetTrades != null ? { targetTrades: Number(req.body.targetTrades) } : {}),
        ...(req.body?.windowDays != null ? { windowDays: Number(req.body.windowDays) } : {}),
      }
      // Arming (off → on) starts the pacing clock toward targetTrades.
      if (next.on && !current.on) next.startedAt = new Date().toISOString()
      setState(db, 'burn_in_json', JSON.stringify(next))
      const clamped = loadBurnInConfig(db)
      console.log(`[actions] burn-in ${clamped.on ? 'ARMED' : 'disarmed'} — size=${clamped.sizeMode === 'fixed' ? clamped.lots : 'auto'} target=${clamped.targetTrades} in ${clamped.windowDays}d mpc=${clamped.maxPerCycle}`)
      res.json({ ok: true, config: clamped })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/reconcile-pending — cancel BOT-placed resting orders the
  // local ledger no longer recognises (stale duplicates from the pre-volume
  // DB wipes). Manual cTrader orders are never touched (marker-gated).
  // -----------------------------------------------------------------------
  router.post('/reconcile-pending', async (_req, res) => {
    try {
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const { reconcileBrokerPendingOrders } = await import('../services/pending-orders.js')
      const out = await reconcileBrokerPendingOrders(db, creds)
      console.log(`[actions] reconcile-pending: ${out.cancelled.length} cancelled, ${out.kept} kept, ${out.manual} manual untouched${out.failures.length ? `, ${out.failures.length} failures` : ''}`)
      res.json({ ok: true, ...out, ranAt: new Date().toISOString() })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/broker-history — the broker's own closed-trade record
  // (every closing deal, bot-placed or manual), with realised NET P&L
  // (gross + swap + commission) exactly as cTrader's History tab shows it.
  // Body: { days? } (default 7, max 190 — covers 7d/30d/3mo/6mo, owner:
  // "should also include 30 days and 3+6 months"). Side effect: backfills
  // net_pnl/gross_pnl/exit_price onto local trades rows matched by
  // positionId, so performance stats and the Tune timeframe table use
  // broker-true numbers.
  // -----------------------------------------------------------------------
  router.post('/broker-history', async (req, res) => {
    try {
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const days = Math.min(190, Math.max(1, Number(req.body?.days) || 7))
      const { host, clientId, clientSecret, accessToken, accountId } = creds
      const { wsGetDeals, wsSymbolsByIds, wsGetSymbolsList, wsGetTrader, wsGetAssets } = await import('../lib/ctrader-ws.js')

      const WEEK = 7 * 24 * 3_600_000
      const from = Date.now() - days * 24 * 3_600_000
      const deals = []
      for (let t0 = from; t0 < Date.now(); t0 += WEEK) {
        const chunk = await wsGetDeals(host, clientId, clientSecret, accessToken, accountId, t0, Math.min(t0 + WEEK, Date.now()))
        deals.push(...(chunk.deal || []))
      }

      // Only deals that CLOSE (part of) a position carry realised P&L.
      const closing = deals.filter(d => d.closePositionDetail)

      const symbolIds = [...new Set(closing.map(d => d.symbolId).filter(Boolean))]
      const symMeta = {}
      if (symbolIds.length > 0) {
        try {
          const [symData, lightData] = await Promise.all([
            wsSymbolsByIds(host, clientId, clientSecret, accessToken, accountId, symbolIds),
            wsGetSymbolsList(host, clientId, clientSecret, accessToken, accountId),
          ])
          for (const s of (symData.symbol || [])) symMeta[s.symbolId] = { ...s }
          for (const s of (lightData.symbol || [])) {
            if (s.symbolName && symbolIds.includes(s.symbolId)) {
              symMeta[s.symbolId] = { ...(symMeta[s.symbolId] || {}), symbolName: s.symbolName }
            }
          }
        } catch { /* rows fall back to #symbolId */ }
      }

      // Currencies (owner: "closed at the broker should have all the
      // fields") — same asset-truth lookup as /actions/broker-positions:
      // deposit ccy from the trader's account, each symbol's quote ccy from
      // its quoteAssetId, FX-name fallback for symbols metadata couldn't map.
      const assetNameById = {}
      let depositCcy = null
      try {
        const [trader, assets] = await Promise.all([
          wsGetTrader(host, clientId, clientSecret, accessToken, accountId),
          wsGetAssets(host, clientId, clientSecret, accessToken, accountId),
        ])
        for (const a of (assets.asset || [])) assetNameById[a.assetId] = a.displayName || a.name || null
        depositCcy = assetNameById[trader.depositAssetId] || null
      } catch { /* currency stays null */ }

      // Bot provenance + open time (for Duration) + SL/TP come from OUR OWN
      // ledger, not the broker — cTrader deal history carries none of it
      // (no label/comment, no open-time, and a CLOSED position's SL/TP no
      // longer exists anywhere at the broker to look up). SL/TP reflect
      // whatever was last set locally, which may predate the final trail/
      // move on a scaled-out close — an approximation, not a fabrication.
      // Positions this account never opened (imported history, or before
      // the DB existed) simply get source 'MANUAL' and no SL/TP/duration,
      // same as the broker itself would show for an untracked position.
      const positionIds = [...new Set(closing.map(d => d.positionId).filter(v => v != null).map(String))]
      const localByPosition = new Map()
      if (positionIds.length > 0) {
        const placeholders = positionIds.map(() => '?').join(',')
        for (const t of db.prepare(
          `SELECT ctrader_position_id, source, label_raw, opened_at, sl_price, tp_price FROM trades WHERE ctrader_position_id IN (${placeholders})`
        ).all(...positionIds)) {
          localByPosition.set(String(t.ctrader_position_id), t)
        }
      }

      const SIDE_NAME = { 1: 'BUY', 2: 'SELL' }
      const rows = closing.map(d => {
        const cpd = d.closePositionDetail
        const m = (v) => (v == null ? null : v / Math.pow(10, cpd.moneyDigits ?? 2))
        const meta = symMeta[d.symbolId] || {}
        const lots = meta.lotSize ? Math.round((d.volume / meta.lotSize) * 100) / 100 : null
        const grossProfit = m(cpd.grossProfit)
        const swap = m(cpd.swap)
        const commission = m(cpd.commission)
        const netPnl = Math.round(((grossProfit || 0) + (swap || 0) + (commission || 0)) * 100) / 100
        // The deal's tradeSide is the CLOSING side — the position was the opposite.
        const closeSide = SIDE_NAME[d.tradeSide] || String(d.tradeSide || '')
        const side = closeSide === 'BUY' ? 'SELL' : closeSide === 'SELL' ? 'BUY' : closeSide
        const symName = String(meta.symbolName || '').toUpperCase()
        const isFxPair = symName.length === 6 && /^[A-Z]{6}$/.test(symName)
        const positionId = d.positionId != null ? String(d.positionId) : null
        const local = positionId ? localByPosition.get(positionId) : null
        const openedAt = local?.opened_at ? Date.parse(local.opened_at) : null
        const closedAt = d.executionTimestamp ?? null
        return {
          dealId: d.dealId ?? null,
          positionId,
          closedAt,
          symbol: meta.symbolName || `#${d.symbolId}`,
          side,
          lots,
          entryPrice: cpd.entryPrice ?? null,
          closePrice: d.executionPrice ?? null,
          sl: local?.sl_price ?? null,
          tp: local?.tp_price ?? null,
          openedAt: local?.opened_at ?? null,
          grossProfit,
          swap,
          commission,
          netPnl,
          quoteCcy: assetNameById[meta.quoteAssetId] || (isFxPair ? symName.slice(3) : null),
          depositCcy,
          source: local?.source || null,
          label: local?.label_raw || null,
          durationMs: (openedAt != null && closedAt != null) ? Math.max(0, closedAt - openedAt) : null,
        }
      }).sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))

      // Backfill broker-true realised P&L onto local trades rows. Partial
      // closes aggregate per position. Only rows the reconciler has already
      // marked closed are touched — a partially-closed position stays open.
      const byPosition = new Map()
      for (const r of rows) {
        if (!r.positionId) continue
        const agg = byPosition.get(r.positionId) || { net: 0, gross: 0, last: r }
        agg.net += r.netPnl || 0
        agg.gross += r.grossProfit || 0
        if ((r.closedAt || 0) >= (agg.last.closedAt || 0)) agg.last = r
        byPosition.set(r.positionId, agg)
      }
      const upd = db.prepare(
        `UPDATE trades
         SET net_pnl = ?, gross_pnl = ?,
             exit_price = COALESCE(exit_price, ?),
             closed_at = COALESCE(closed_at, ?)
         WHERE ctrader_position_id = ? AND status = 'closed'`
      )
      let backfilled = 0
      for (const [positionId, agg] of byPosition) {
        const r = upd.run(
          Math.round(agg.net * 100) / 100,
          Math.round(agg.gross * 100) / 100,
          agg.last.closePrice,
          agg.last.closedAt ? new Date(agg.last.closedAt).toISOString() : null,
          positionId,
        )
        backfilled += r.changes
      }

      const realized = Math.round(rows.reduce((s, r) => s + (r.netPnl || 0), 0) * 100) / 100
      const payload = { ok: true, days, rows, realized, backfilled, fetchedAt: new Date().toISOString() }
      // Cache the latest history so the Desk can paint instantly next visit
      // (GET /state/broker-cache) while the live fetch refreshes behind.
      try { setState(db, 'broker_history_cache_json', JSON.stringify(payload)) } catch { /* cache is best-effort */ }
      res.json(payload)
    } catch (err) {
      console.error('[actions/broker-history] error:', err.message)
      res.status(502).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // Per-position trade management (cTrader-style Modify/Protect, per trade).
  // All owner-initiated: they act directly at the broker (the user outranks
  // the bot), are logged to action_log by the /actions middleware, and go
  // through the exec engine so EXEC_ENGINE=cpp parity holds.
  // -----------------------------------------------------------------------

  // Find one live position at the broker by id (fresh reconcile every call —
  // stale ids must fail loudly, not act on a ghost).
  async function findLivePosition(creds, positionId) {
    const rec = await execReconcile(creds)
    return (rec.position || []).find(p => String(p.positionId) === String(positionId)) || null
  }

  // POST /actions/position-protect — set/replace the broker-native SL and/or
  // TP on ONE position. Body: { positionId, sl?, tp? } (absolute prices).
  router.post('/position-protect', async (req, res) => {
    try {
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const { positionId, sl, tp } = req.body || {}
      if (!positionId) return res.status(400).json({ error: 'positionId is required' })
      const args = { positionId: parseInt(positionId) }
      if (Number(sl) > 0) args.stopLoss = Number(sl)
      if (Number(tp) > 0) args.takeProfit = Number(tp)
      if (args.stopLoss == null && args.takeProfit == null) {
        return res.status(400).json({ error: 'sl or tp (absolute price) is required' })
      }
      await execAmendPosition(creds, args)
      db.prepare("UPDATE monitored_positions SET current_sl = COALESCE(?, current_sl), current_tp = COALESCE(?, current_tp) WHERE trade_id IN (SELECT id FROM trades WHERE ctrader_position_id = ?) AND status = 'active'")
        .run(args.stopLoss ?? null, args.takeProfit ?? null, String(positionId))
      res.json({ ok: true, positionId, sl: args.stopLoss ?? null, tp: args.takeProfit ?? null })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // POST /actions/order-cancel — cancel ONE resting order at the broker
  // (the Manage pop-up's Cancel). Marks any matching pending_orders ledger
  // row cancelled so the pending manager doesn't chase a ghost.
  router.post('/order-cancel', async (req, res) => {
    try {
      const orderId = req.body?.orderId
      if (!orderId) return res.status(400).json({ error: 'orderId required' })
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const { cancelOrder } = await import('../lib/exec-engine.js')
      const r = await cancelOrder(creds, { orderId })
      try {
        db.prepare(`UPDATE pending_orders SET status = 'cancelled', note = COALESCE(note, '') || ' | cancelled via Manage' WHERE order_id = ?`).run(String(orderId))
      } catch { /* ledger row optional */ }
      console.log(`[actions] order ${orderId} cancelled via Manage`)
      res.json({ ok: true, alreadyGone: !!r?.alreadyGone })
    } catch (e) {
      res.status(502).json({ error: e.message })
    }
  })

  // POST /actions/position-close — close ONE position, fully or partially.
  // Body: { positionId, lots? } (omit lots → full close).
  router.post('/position-close', async (req, res) => {
    try {
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const { positionId, lots } = req.body || {}
      if (!positionId) return res.status(400).json({ error: 'positionId is required' })
      const pos = await findLivePosition(creds, positionId)
      if (!pos) return res.status(404).json({ error: `position ${positionId} not found at the broker (already closed?)` })
      let volume = pos.tradeData?.volume
      if (Number(lots) > 0) {
        const meta = await getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, pos.tradeData?.symbolId)
        volume = Math.min(volume, Math.round(Number(lots) * meta.lotSize))
      }
      const exec = await execClosePosition(creds, { positionId: parseInt(positionId), volume })
      res.json({ ok: true, positionId, closedVolume: volume, partial: volume < (pos.tradeData?.volume ?? volume), deal: exec.deal ?? null })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // POST /actions/position-double — open a second market position, same
  // symbol/side/size as the given one. Body: { positionId }
  router.post('/position-double', async (req, res) => {
    try {
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const { positionId } = req.body || {}
      if (!positionId) return res.status(400).json({ error: 'positionId is required' })
      const pos = await findLivePosition(creds, positionId)
      if (!pos) return res.status(404).json({ error: `position ${positionId} not found at the broker` })
      const td = pos.tradeData || {}
      const label = encodeLabel({ source: 'manual', version: LABEL_VERSION, strategy: 'manual', session: getActiveSessions()[0]?.label || 'Off' })
      const exec = await execPlaceOrder(creds, {
        ctidTraderAccountId: parseInt(creds.accountId),
        symbolId: parseInt(td.symbolId),
        orderType: 'MARKET',
        tradeSide: td.tradeSide === 2 || td.tradeSide === 'SELL' ? 'SELL' : 'BUY',
        volume: td.volume,
        comment: 'abot-double',
        label,
        // Intentionally replicates an existing manual position's size with no
        // fresh stop — exempt from the naked-market bracket guard.
        allowNaked: true,
      })
      res.json({ ok: true, doubledFrom: positionId, newPositionId: exec?.position?.positionId ?? exec?.deal?.positionId ?? null })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // POST /actions/position-reverse — close the position and open the same
  // size in the OPPOSITE direction. Body: { positionId }
  router.post('/position-reverse', async (req, res) => {
    try {
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const { positionId } = req.body || {}
      if (!positionId) return res.status(400).json({ error: 'positionId is required' })
      const pos = await findLivePosition(creds, positionId)
      if (!pos) return res.status(404).json({ error: `position ${positionId} not found at the broker` })
      const td = pos.tradeData || {}
      const wasSell = td.tradeSide === 2 || td.tradeSide === 'SELL'
      await execClosePosition(creds, { positionId: parseInt(positionId), volume: td.volume })
      const label = encodeLabel({ source: 'manual', version: LABEL_VERSION, strategy: 'manual', session: getActiveSessions()[0]?.label || 'Off' })
      const exec = await execPlaceOrder(creds, {
        ctidTraderAccountId: parseInt(creds.accountId),
        symbolId: parseInt(td.symbolId),
        orderType: 'MARKET',
        tradeSide: wasSell ? 'BUY' : 'SELL',
        volume: td.volume,
        comment: 'abot-reverse',
        label,
        // Mirrors an existing manual position's size in the opposite direction
        // with no fresh stop — exempt from the naked-market bracket guard.
        allowNaked: true,
      })
      res.json({ ok: true, reversedFrom: positionId, newSide: wasSell ? 'BUY' : 'SELL', newPositionId: exec?.position?.positionId ?? exec?.deal?.positionId ?? null })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // POST /actions/position-guard — store the bot-enforced rules for ONE
  // position (break-even / trailing / partial TPs). Body:
  //   { positionId, guard: { breakEven?, trailing?, takeProfits? } | null }
  // null clears the rules. The loop's trade-guard pass enforces them.
  router.post('/position-guard', async (req, res) => {
    try {
      const { positionId, guard } = req.body || {}
      if (!positionId) return res.status(400).json({ error: 'positionId is required' })
      const row = db.prepare(
        `SELECT mp.id FROM monitored_positions mp
         JOIN trades t ON t.id = mp.trade_id
         WHERE t.ctrader_position_id = ? AND mp.status = 'active'`
      ).get(String(positionId))
      if (!row) {
        return res.status(404).json({
          error: `position ${positionId} is not in the monitor yet — it is adopted on the next reconcile pass (within one loop cycle); retry shortly`,
        })
      }
      const json = guard == null ? null : JSON.stringify(guard)
      db.prepare('UPDATE monitored_positions SET guard_json = ? WHERE id = ?').run(json, row.id)
      res.json({ ok: true, positionId, guard: guard ?? null })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/position-keeper-optout — per-position override for the
  // Profit Keeper (owner: "At the broker (which is traded by human) should
  // have a checkbox that allow/stop bot to manage after open position").
  // The account-wide Profit Keeper on/off + scope (Tune) still decides what
  // gets considered; this excludes ONE position from that regardless of
  // scope. Body: { positionId, optOut: boolean }.
  // -----------------------------------------------------------------------
  router.post('/position-keeper-optout', (req, res) => {
    try {
      const { positionId, optOut } = req.body || {}
      if (!positionId) return res.status(400).json({ error: 'positionId is required' })
      const row = db.prepare(
        `SELECT mp.id FROM monitored_positions mp
         JOIN trades t ON t.id = mp.trade_id
         WHERE t.ctrader_position_id = ? AND mp.status = 'active'`
      ).get(String(positionId))
      if (!row) {
        return res.status(404).json({
          error: `position ${positionId} is not in the monitor yet — it is adopted on the next reconcile pass (within one loop cycle); retry shortly`,
        })
      }
      db.prepare('UPDATE monitored_positions SET keeper_opt_out = ? WHERE id = ?').run(optOut ? 1 : 0, row.id)
      res.json({ ok: true, positionId, optOut: !!optOut })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // GET-equivalent: current guard rules for the UI (POST for parity with the
  // actions router's logging middleware). Body: { positionId }
  router.post('/position-guard-get', (req, res) => {
    try {
      const { positionId } = req.body || {}
      if (!positionId) return res.status(400).json({ error: 'positionId is required' })
      const row = db.prepare(
        `SELECT mp.guard_json, mp.be_moved FROM monitored_positions mp
         JOIN trades t ON t.id = mp.trade_id
         WHERE t.ctrader_position_id = ? AND mp.status = 'active'`
      ).get(String(positionId))
      let guard = null
      try { guard = row?.guard_json ? JSON.parse(row.guard_json) : null } catch { /* corrupt → null */ }
      res.json({ ok: true, positionId, guard, beMoved: !!row?.be_moved, monitored: !!row })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/exec-parity — prove the C++ sidecar matches the JS path,
  // runnable from the UI (the agent DB and both paths live HERE, not on the
  // owner's laptop). Read-only: health + credentials push + reconcile diff.
  // -----------------------------------------------------------------------
  router.post('/exec-parity', async (_req, res) => {
    try {
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const base = process.env.EXEC_URL || 'http://127.0.0.1:8091'
      const call = async (method, path, body) => {
        const r = await fetch(base + path, {
          method,
          headers: {
            authorization: `Bearer ${process.env.EXEC_SECRET || ''}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        })
        const text = await r.text()
        if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${text.slice(0, 200)}`)
        return text ? JSON.parse(text) : null
      }
      const steps = []
      await call('POST', '/connect', {
        host: creds.host, clientId: creds.clientId, clientSecret: creds.clientSecret,
        accessToken: creds.accessToken, accountId: creds.accountId,
      })
      steps.push('credentials pushed to sidecar')
      // the engine authenticates asynchronously — poll health up to ~12s
      let health = null
      for (let i = 0; i < 6; i++) {
        await new Promise(r2 => setTimeout(r2, 2000))
        health = await call('GET', '/health')
        if (health?.connected) break
      }
      steps.push(`sidecar health: connected=${!!health?.connected}`)
      if (!health?.connected) {
        return res.json({ pass: false, steps, error: 'sidecar reached but not authenticated with cTrader after 12s — check its deploy logs' })
      }
      const { wsReconcile } = await import('../lib/ctrader-ws.js')
      const [jsRec, cppRec] = await Promise.all([
        wsReconcile(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId),
        call('GET', '/positions'),
      ])
      const key = (p) => `${p.positionId}|${p.tradeData?.symbolId ?? p.symbolId}|${p.tradeData?.volume ?? p.volume}`
      const jsSet = new Set((jsRec?.position || []).map(key))
      const cppSet = new Set((cppRec?.position || []).map(key))
      const onlyJs = [...jsSet].filter(k => !cppSet.has(k))
      const onlyCpp = [...cppSet].filter(k => !jsSet.has(k))
      const match = onlyJs.length === 0 && onlyCpp.length === 0
      steps.push(`reconcile: js=${jsSet.size} cpp=${cppSet.size} positions — ${match ? 'MATCH' : 'DIFFER'}`)
      res.json({ pass: match, steps, onlyJs, onlyCpp, ranAt: new Date().toISOString() })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/loop-interval — scan/trade loop cadence in minutes (1–60).
  // Read fresh every cycle; no restart needed.
  // -----------------------------------------------------------------------
  router.post('/loop-interval', (req, res) => {
    const n = Number(req.body?.minutes)
    if (!Number.isFinite(n) || n < 1 || n > 60) {
      return res.status(400).json({ error: 'minutes must be a number between 1 and 60' })
    }
    setState(db, 'loop_interval_min', String(Math.round(n)))
    res.json({ ok: true, minutes: Math.round(n) })
  })

  // -----------------------------------------------------------------------
  // POST /actions/pending-mode — arm/disarm resting-limit-order mode.
  // Body: { on: boolean, matrix?: { SYMBOL: [timeframes] } }. The mode only
  // acts on symbol×timeframe cells present in the matrix; timeframes are
  // canonicalized exactly like the autotrade matrix (free text accepted).
  // -----------------------------------------------------------------------
  router.post('/pending-mode', (req, res) => {
    const on = !!req.body?.on
    if ('matrix' in (req.body || {})) {
      const rawMatrix = req.body.matrix
      if (rawMatrix == null || (typeof rawMatrix === 'object' && Object.keys(rawMatrix).length === 0)) {
        setState(db, 'pending_matrix_json', null)
        console.log('[actions] pending matrix cleared')
      } else if (typeof rawMatrix === 'object') {
        const clean = {}
        const bad = []
        for (const [sym, list] of Object.entries(rawMatrix)) {
          if (!Array.isArray(list)) continue
          const ptfs = list.map(t => parseTimeframe(String(t)))
          bad.push(...list.filter((_, i) => !ptfs[i]))
          const ok = ptfs.filter(Boolean)
          if (ok.length) clean[String(sym).toUpperCase().trim()] = [...new Set(ok.map(p => p.label))]
        }
        if (bad.length) {
          return res.status(400).json({ error: `unreadable timeframe(s): ${bad.join(', ')} — use forms like 15m, 90m, 1.5h, 4h, 2d, 1w, 1M` })
        }
        setState(db, 'pending_matrix_json', JSON.stringify(clean))
        console.log('[actions] pending matrix set:', Object.entries(clean).map(([k, v]) => `${k}:${v.join('/')}`).join(' '))
      }
    }
    setState(db, 'pending_mode_enabled', on ? 'true' : 'false')
    console.log(`[actions] pending-order mode ${on ? 'ENABLED' : 'disabled'}`)
    let matrixOut = null
    try { matrixOut = JSON.parse(getState(db, 'pending_matrix_json') || 'null') } catch { /* null */ }
    res.json({ on: getState(db, 'pending_mode_enabled') === 'true', matrix: matrixOut })
  })

  // -----------------------------------------------------------------------
  // POST /actions/strategies — choose which strategies the scan loop runs.
  // Body: { enabled: ['fib_618_fade', 'cup_handle', …] } — keys validated
  // against the registry; fib is ALWAYS forced on (it is the baseline the
  // pending-order and monitor plumbing assumes). The legacy
  // cup_handle_enabled flag is kept in sync for older UI/toggles.
  // -----------------------------------------------------------------------
  router.post('/strategies', (req, res) => {
    const requested = req.body?.enabled
    if (!Array.isArray(requested)) {
      return res.status(400).json({ error: 'Body must be { enabled: [strategy keys] }' })
    }
    const unknown = requested.filter(k => !STRATEGY_KEYS.includes(k))
    if (unknown.length) {
      return res.status(400).json({ error: `unknown strategy key(s): ${unknown.join(', ')} — valid: ${STRATEGY_KEYS.join(', ')}` })
    }
    const on = new Set(requested)
    const keys = STRATEGY_KEYS.filter(k => on.has(k)) // registry order
    setState(db, 'enabled_strategies_json', JSON.stringify(keys))
    // Back-compat: the old cup-handle toggle reads this flag.
    setState(db, 'cup_handle_enabled', on.has('cup_handle') ? 'true' : 'false')
    console.log('[actions] enabled strategies set:', keys.join(', '))
    res.json({
      strategies: STRATEGY_REGISTRY.map(s => ({ key: s.key, name: s.name, on: keys.includes(s.key) })),
    })
  })

  // -----------------------------------------------------------------------
  // POST /actions/validation-fill — supervised end-to-end proof of the REAL
  // auto-trade path. Body: { symbol, side?: 'long'|'short' }.
  //
  // Exists to close the "C++ first-fill watch" (open since the travel
  // handover): rather than waiting weeks for an organic conviction-8 signal,
  // the owner fires ONE deliberate 0.01-lot market order through the exact
  // code a signal would take — loop.js autoTrade(): market-hours gate → risk
  // gate (persisted to risk_events) → broker-min sizing → spread gate →
  // exec engine (C++ sidecar when EXEC_ENGINE=cpp) → structured label →
  // trades + monitored_positions. Nothing is mocked; a veto is a real veto.
  // SL 0.5% / TP 0.8% (RR 1.6) ride as broker-side protection and the
  // monitor manages the position like any bot trade. DEMO ONLY by design.
  // -----------------------------------------------------------------------
  router.post('/validation-fill', async (req, res) => {
    const symbol = String(req.body?.symbol || '').toUpperCase().trim()
    if (!symbol) return res.status(400).json({ error: 'Body must include { symbol }' })
    const bias = req.body?.side === 'short' ? 'short' : 'long'
    // EVERY refusal — even before the risk gate — lands in risk_events, so
    // the Order log answers "I tapped it and nothing happened, why?" without
    // needing the Railway logs (owner requirement: track ALL attempts).
    const side = bias === 'short' ? 'SELL' : 'BUY'
    const refuse = (status, reason, humanError) => {
      try {
        persistRiskEvent(db, { symbol, side, requestedVolume: 0.01, source: 'validation_fill' }, { approved: false, veto_reason: reason })
      } catch { /* the log must never block the answer */ }
      return res.status(status).json({ error: humanError || reason })
    }
    try {
      if (getState(db, 'ctrader_is_live') === 'true') {
        return refuse(400, 'live_account: validation fill refuses to run on a LIVE account', 'validation fill refuses to run on a LIVE account — select the demo account first')
      }
      const creds = getCtraderCreds(db)
      if (!creds.ready) return refuse(400, 'no_credentials: cTrader not configured', 'cTrader credentials not configured — link an account on Connect')
      const map = getSymbolMap(db)
      const symbolId = map[symbol]
      if (!symbolId) return refuse(400, `symbol_unknown: no symbolId for ${symbol}`, `symbolId unknown for ${symbol} — call POST /actions/symbol-map first`)

      const q = await wsGetSpotOnce(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)
      if (!q?.bid || !q?.ask) return refuse(400, 'no_live_quote: market closed or price feed unavailable', 'no live quote — market closed or price feed unavailable')
      const mid = (q.bid + q.ask) / 2
      const dir = bias === 'long' ? 1 : -1

      // Synthetic conviction-8 proposal at minimal risk. SL 0.5% clears the
      // minSLDistancePct floor (0.15%); TP 0.8% clears minRR 1.5 at RR 1.6.
      const synth = {
        consensus_bias: bias,
        entry: mid,
        sl: mid * (1 - dir * 0.005),
        tp1: mid * (1 + dir * 0.008),
        strategy: 'fib_618_fade',
        overall_conviction: 8,
        timeframe: null,
        time_cap_minutes: 240,
        synthesis: 'VALIDATION FILL — deliberate end-to-end test of the auto-trade path (owner-fired, 0.01 lot).',
        invalidation_trigger: null,
        source: 'validation_fill',
      }

      // Dynamic import keeps route wiring free of load-order surprises.
      const { autoTrade } = await import('../loop.js')
      const result = await autoTrade(db, symbol, synth, { maxVolume: 0.01 }, null)
      const lastEvent = db.prepare(
        `SELECT approved, veto_reason, created_at FROM risk_events WHERE symbol = ? ORDER BY id DESC LIMIT 1`
      ).get(symbol)

      if (result) {
        console.log(`[actions] VALIDATION FILL: ${result.side} ${symbol} @ ${result.executionPrice} posId=${result.positionId}`)
        return res.json({
          ok: true,
          filled: result,
          riskEvent: lastEvent || null,
          note: 'C++ first-fill watch: CLOSED — the auto-trade path filled at the broker. Check the position in cTrader, then close it whenever you like (the SL/TP protect it meanwhile).',
        })
      }
      res.json({
        ok: false,
        veto: lastEvent?.veto_reason || 'order not placed — no risk event recorded; check agent logs',
        riskEvent: lastEvent || null,
        note: 'The gate refused honestly — that is the same refusal a live signal would get. Fix the reason and fire again.',
      })
    } catch (e) {
      return refuse(500, `error: ${e.message}`, e.message)
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/stage-matrix — flip one cell of the strategy × stage table.
  // Body: { kind: 'strategy'|'filter', key, stage: 'scan'|'backtest'|'trade'|
  // 'manage', on: boolean }. Trade-stage writes route through the legacy keys
  // (enabled_strategies_json / fib_*_filter) so every older reader agrees.
  // -----------------------------------------------------------------------
  router.post('/stage-matrix', (req, res) => {
    const { kind, key, stage, on } = req.body || {}
    try {
      const matrix = setStage(db, { kind, key, stage, on: on === true }, { getState, setState })
      console.log(`[actions] stage-matrix: ${kind} ${key} × ${stage} → ${on === true ? 'on' : 'off'}`)
      res.json({ ok: true, ...matrix })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/autopilot — { mode, maxChanges?, allowLive?, intervalMs? }
  // The strategy autopilot's master switch. allowLive=true lets 'auto' arm a
  // LIVE account; intervalMs overrides the session-adaptive cadence.
  // -----------------------------------------------------------------------
  router.post('/autopilot', (req, res) => {
    const mode = ['off', 'suggest', 'auto'].includes(req.body?.mode) ? req.body.mode : null
    if (!mode) return res.status(400).json({ error: "mode must be 'off', 'suggest' or 'auto'" })
    setState(db, 'autopilot_mode', mode)
    if (req.body?.maxChanges != null) {
      const n = Number(req.body.maxChanges)
      if (Number.isFinite(n) && n >= 1 && n <= 20) setState(db, 'autopilot_max_changes', String(Math.round(n)))
    }
    if (req.body?.allowLive != null) setState(db, 'autopilot_allow_live', req.body.allowLive === true ? 'true' : 'false')
    if (req.body?.intervalMs != null) {
      const n = Number(req.body.intervalMs)
      // 0/null clears the override → back to the session-adaptive cadence.
      setState(db, 'autopilot_interval_ms', Number.isFinite(n) && n >= 300_000 ? String(Math.round(n)) : null)
    }
    if (req.body?.runNow) setState(db, 'autopilot_last_run_ms', '0') // next loop cycle evaluates
    res.json({
      ok: true, mode,
      maxChanges: Number(getState(db, 'autopilot_max_changes')) || 4,
      allowLive: getState(db, 'autopilot_allow_live') === 'true',
    })
  })

  // -----------------------------------------------------------------------
  // POST /actions/cup-handle-toggle — LEGACY arm/disarm for Cup & Handle
  // (fib fade is untouched). Superseded by POST /actions/strategies but kept
  // for older clients; enabledStrategies() honours this flag directly.
  // -----------------------------------------------------------------------
  router.post('/cup-handle-toggle', (req, res) => {
    const on = !!req.body?.on
    setState(db, 'cup_handle_enabled', on ? 'true' : 'false')
    // Keep the registry-era state consistent so the two switches never fight.
    try {
      const cur = JSON.parse(getState(db, 'enabled_strategies_json') || 'null')
      if (Array.isArray(cur)) {
        const keys = new Set(cur.filter(k => STRATEGY_KEYS.includes(k)))
        if (on) keys.add('cup_handle'); else keys.delete('cup_handle')
        // fib is a normal toggle now — do not force it back in
        setState(db, 'enabled_strategies_json', JSON.stringify(STRATEGY_KEYS.filter(k => keys.has(k))))
      }
    } catch { /* corrupt list — leave it; enabledStrategies() falls back safely */ }
    res.json({ on: getState(db, 'cup_handle_enabled') === 'true' })
  })

  // -----------------------------------------------------------------------
  // POST /actions/cup-screener — the C&H watchlist funnel on DAILY bars.
  // Body: { minPrice=20, minAvgVolume=0, symbols?=[] (default: enabled
  // watchlist) }. Broker-checkable filters only: price floor, avg volume,
  // relative volume > 1, SMA 20/50/200 stack. P/E, optionable/shortable and
  // sector rankings are NOT in cTrader data — the UI says so instead of
  // faking them. Capped at 100 symbols per run.
  // -----------------------------------------------------------------------
  router.post('/cup-screener', async (req, res) => {
    try {
      const names = pickBacktestSymbols(
        { symbols: req.body?.symbols },
        getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json'),
      ).slice(0, 100)
      if (names.length === 0) return res.status(400).json({ error: 'No symbols to screen — watchlist is empty' })
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const map = await ensureSymbolMap(db, creds)
      const { screenBars } = await import('../services/cup-handle.js')
      const { host, clientId, clientSecret, accessToken, accountId } = creds
      const opts = { minPrice: Number(req.body?.minPrice ?? 20), minAvgVolume: Number(req.body?.minAvgVolume ?? 0) }
      // 3 symbols at a time, 20s cap each — one slow instrument must neither
      // serialize the run into a gateway timeout nor sink the others.
      const screenOne = async (name) => {
        const symbolId = map[name]
        if (!symbolId) return { symbol: name, error: 'not offered by this broker account' }
        try {
          const fetched = await wsGetTrendbarsBatch(host, clientId, clientSecret, accessToken, accountId, symbolId, ['1d'], 260, 20_000)
          return { symbol: name, ...screenBars(fetched['1d'] || [], opts) }
        } catch (err) {
          return { symbol: name, error: err.message }
        }
      }
      // Background job (same contract as the backtest): results wait on the
      // agent in GET /state/job/cup-screener — leaving the page mid-run no
      // longer throws them away.
      const { startJob, jobMeta } = await import('../services/backtest-job.js')
      const started = startJob('cup-screener', { symbols: names, ...opts }, async () => {
        const rows = []
        for (let i = 0; i < names.length; i += 3) {
          rows.push(...await Promise.all(names.slice(i, i + 3).map(screenOne)))
        }
        return {
          rows,
          passed: rows.filter(r => r.pass).map(r => r.symbol),
          manualChecks: 'Not in broker data — check on your stock screener: P/E < 30, optionable/shortable, leading sector.',
          ranAt: new Date().toISOString(),
        }
      })
      if (started.conflict) {
        return res.status(409).json({ error: 'a screener run is already in flight — its results will appear when it finishes', job: jobMeta(started.conflict) })
      }
      res.json({ ok: true, job: jobMeta(started.job) })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /actions/instrument-tree — every instrument the broker account
  // offers, classified: asset class → category → symbols. Cached in
  // agent_state for 24h (the catalogue barely changes); ?refresh=1 forces.
  // Backs the Tune Watchlist classification tree.
  // -----------------------------------------------------------------------
  router.get('/instrument-tree', async (req, res) => {
    try {
      const CACHE_KEY = 'instrument_tree_json'
      if (!req.query.refresh) {
        const cached = getState(db, CACHE_KEY)
        if (cached) {
          const parsed = JSON.parse(cached)
          if (Date.now() - Date.parse(parsed.builtAt) < 24 * 3600_000) return res.json(parsed)
        }
      }
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const { host, clientId, clientSecret, accessToken, accountId } = creds
      const { wsGetAssetClasses, wsGetSymbolCategories, wsGetSymbolsList } = await import('../lib/ctrader-ws.js')
      const [ac, cat, sym] = await Promise.all([
        wsGetAssetClasses(host, clientId, clientSecret, accessToken, accountId),
        wsGetSymbolCategories(host, clientId, clientSecret, accessToken, accountId),
        wsGetSymbolsList(host, clientId, clientSecret, accessToken, accountId),
      ])
      const { buildInstrumentTree } = await import('../lib/instrument-tree.js')
      const tree = buildInstrumentTree(ac.assetClass || [], cat.symbolCategory || [], sym.symbol || [])
      const payload = { ...tree, builtAt: new Date().toISOString() }
      setState(db, CACHE_KEY, JSON.stringify(payload))
      res.json(payload)
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // GET /actions/stream-prices?symbols=EURUSD,BTCUSD — live tick feed.
  // Server-sent events: one cTrader spot subscription per client, ticks
  // forwarded as `data: {"symbol","bid","ask","t"}` frames. Closes with the
  // client. Capped at 10 symbols per stream.
  // -----------------------------------------------------------------------
  router.get('/stream-prices', async (req, res) => {
    try {
      const names = String(req.query.symbols || '').toUpperCase().split(',').map(s => s.trim()).filter(Boolean).slice(0, 10)
      if (names.length === 0) return res.status(400).json({ error: 'symbols query param required' })
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })

      const map = await ensureSymbolMap(db, creds)
      const idToName = {}
      const ids = []
      for (const n of names) {
        if (map[n]) { ids.push(map[n]); idToName[map[n]] = n }
      }
      if (ids.length === 0) return res.status(404).json({ error: 'none of the requested symbols are in the symbol map' })

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(`event: hello\ndata: ${JSON.stringify({ symbols: names.filter(n => map[n]) })}\n\n`)

      const { wsStreamSpots } = await import('../lib/ctrader-ws.js')
      const { host, clientId, clientSecret, accessToken, accountId } = creds
      let stream = null
      let hb = null
      const shutdown = () => {
        clearInterval(hb)
        try { stream?.close() } catch { /* already closed */ }
        try { res.end() } catch { /* client gone */ }
      }
      try {
        stream = await wsStreamSpots(host, clientId, clientSecret, accessToken, accountId, ids,
          (tick) => {
            res.write(`data: ${JSON.stringify({ symbol: idToName[tick.symbolId], bid: tick.bid, ask: tick.ask, t: tick.t })}\n\n`)
          },
          (reason) => {
            res.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`)
            shutdown()
          })
      } catch (err) {
        res.write(`event: end\ndata: ${JSON.stringify({ reason: err.message })}\n\n`)
        return shutdown()
      }
      hb = setInterval(() => res.write(': ping\n\n'), 15_000)
      req.on('close', shutdown)
    } catch (err) {
      if (!res.headersSent) res.status(502).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/chart — OHLC bars for one symbol/timeframe, plus the
  // current fib read for overlay. Powers the per-position charts in the UI.
  // Body: { symbol, timeframe='1h', bars=120,
  //         indicators?: subset of ['sma20','sma50','sma200','ema20','ema50','vwap','avwap','fvg','vp'],
  //         avwapAnchorT?: ms, vpType?: 'session'|'visible'|'fixed'|'composite',
  //         vpFromIdx?/vpToIdx? (visible|fixed range), annotate?: bool, commentary?: bool }
  // Overlays are computed SERVER-side (agent/lib/indicators.js) so Telegram
  // charts match the app EXACTLY. commentary is Gemini-only and opt-in.
  // -----------------------------------------------------------------------
  router.post('/chart', async (req, res) => {
    try {
      const symbol = String(req.body?.symbol || '').toUpperCase()
      const timeframe = String(req.body?.timeframe || '1h')
      const count = Math.min(300, Math.max(30, Number(req.body?.bars) || 120))
      // centerT (epoch ms): historical mode — window ends 1/3 of the span
      // AFTER this moment, so a past trade sits ~2/3 in with context both ways.
      const centerT = Number(req.body?.centerT) || 0
      if (!symbol) return res.status(400).json({ error: 'symbol required' })

      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const symbolId = (await ensureSymbolMap(db, creds))[symbol]
      if (!symbolId) return res.status(404).json({ error: `Unknown symbol ${symbol} — not offered by this broker account` })

      const { host, clientId, clientSecret, accessToken, accountId } = creds
      const tfDurMs = (await import('../lib/timeframes.js')).tfMs(timeframe) || 3_600_000
      const endTime = centerT ? Math.min(Date.now(), centerT + tfDurMs * Math.floor(count / 3)) : 0
      const byPeriod = await wsGetTrendbarsBatch(host, clientId, clientSecret, accessToken, accountId, symbolId, [timeframe], count, 30_000, endTime)
      const bars = byPeriod[timeframe] || []
      if (bars.length === 0) return res.status(502).json({ error: 'Broker returned no bars' })

      // Fib overlay from the same bars (closed bars only, like the scanner).
      // Skipped in historical mode — a fib read on an old window would be
      // presented as if it were current.
      let fib = null
      if (!centerT) try {
        const { computeFibSignal } = await import('../services/fib-strategy.js')
        fib = computeFibSignal(bars.slice(0, -1), timeframe, {})
      } catch { /* overlay optional */ }

      // Requested indicator overlays — server-computed via agent/lib/indicators.js
      // (mirror of src/lib/indicators.js) so every surface shows identical maths.
      const wanted = Array.isArray(req.body?.indicators) ? req.body.indicators.map(String) : []
      const overlays = {}
      if (wanted.length) {
        try {
          const ind = await import('../lib/indicators.js')
          if (wanted.includes('sma20')) overlays.sma20 = ind.smaSeries(bars, 20)
          if (wanted.includes('sma50')) overlays.sma50 = ind.smaSeries(bars, 50)
          if (wanted.includes('sma200')) overlays.sma200 = ind.smaSeries(bars, 200)
          if (wanted.includes('ema20')) overlays.ema20 = ind.emaSeries(bars, 20)
          if (wanted.includes('ema50')) overlays.ema50 = ind.emaSeries(bars, 50)
          if (wanted.includes('vwap')) overlays.vwap = ind.vwapSeries(bars, 0)
          if (wanted.includes('avwap')) {
            // anchor by timestamp; default anchor = start of series
            const anchorT = Number(req.body?.avwapAnchorT) || bars[0].t
            overlays.avwap = ind.avwapSeries(bars, anchorT)
          }
          if (wanted.includes('fvg')) overlays.fvg = ind.findFvgZones(bars)
          if (wanted.includes('vp')) {
            const vpType = ['session', 'visible', 'fixed', 'composite'].includes(req.body?.vpType) ? req.body.vpType : 'session'
            // visible/fixed use the caller's range when given, else the full series
            const fromIdx = Number.isInteger(req.body?.vpFromIdx) ? req.body.vpFromIdx : 0
            const toIdx = Number.isInteger(req.body?.vpToIdx) ? req.body.vpToIdx : bars.length - 1
            overlays.vp = ind.volumeProfile(bars, { type: vpType, fromIdx, toIdx })
          }
        } catch { /* indicators module missing/broken — overlays stay partial/empty */ }
      }

      // annotate:true → deterministic plain-words read; commentary:true → the
      // ONE optional Gemini call (null-safe; only fires with GEMINI_API_KEY).
      let annotation = null
      if (req.body?.annotate === true) {
        try {
          const { buildAnnotation, geminiCommentary } = await import('../services/annotate.js')
          annotation = buildAnnotation(db, { symbol, timeframe, bars, overlays, getState })
          annotation.commentary = req.body?.commentary === true
            ? await geminiCommentary(annotation.lines, { symbol, timeframe })
            : null
        } catch { annotation = null }
      }

      res.json({
        symbol,
        timeframe,
        bars: bars.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })),
        overlays,
        annotation,
        lastPrice: bars[bars.length - 1]?.c ?? null,
        fib: fib ? {
          bias: fib.bias,
          level618: fib.level618,
          entry: fib.entry,
          sl: fib.sl,
          tp1: fib.tp1,
          tp2: fib.tp2,
          swingA: fib.swingA,
          swingB: fib.swingB,
        } : null,
        fetchedAt: new Date().toISOString(),
      })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/scan — trigger immediate scan
  // -----------------------------------------------------------------------
  router.post('/scan', async (req, res) => {
    try {
      const symbolsJson = getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json')
      if (!symbolsJson) {
        return res.status(400).json({ error: 'No symbols configured — push via POST /actions/symbols' })
      }

      let watchlist
      try { watchlist = JSON.parse(symbolsJson) } catch {
        return res.status(500).json({ error: 'Symbol data corrupted' })
      }
      const symbols = (Array.isArray(watchlist) ? watchlist : [])
        .map(w => (typeof w === 'string' ? { symbol: w, enabled: true } : w))
        .filter(w => w.enabled !== false)

      if (symbols.length === 0) {
        return res.status(400).json({ error: 'No enabled symbols in watchlist' })
      }

      const ctraderCreds = getCtraderCreds(db)
      if (!ctraderCreds.ready) {
        return res.status(400).json({ error: 'cTrader credentials not configured — push via /actions/ctrader-config' })
      }

      const scanResult = await runFibScan(ctraderCreds, getSymbolMap(db), symbols, {
        hotThreshold: Number(req.body?.hotThreshold) || 6,
        rsiFilter: getState(db, 'fib_rsi_filter') === 'true' ? {} : null,
        vwapFilter: getState(db, 'fib_vwap_filter') === 'true' ? {} : null,
        fvgFilter: getState(db, 'fib_fvg_filter') === 'true' ? {} : null,
        strategies: enabledStrategies(db, getState), // same set the loop runs
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

      const symbolId = getSymbolMap(db)[symbol]
      if (!symbolId) {
        return res.status(400).json({ error: `symbolId unknown for ${symbol} — call POST /actions/symbol-map` })
      }
      const ctraderCreds = getCtraderCreds(db)
      if (!ctraderCreds.ready) {
        return res.status(400).json({ error: 'cTrader credentials not configured — push via /actions/ctrader-config' })
      }

      const { signal, error: scanError } = await scanSymbolFib(ctraderCreds, symbol, symbolId, {
        rsiFilter: getState(db, 'fib_rsi_filter') === 'true' ? {} : null,
        vwapFilter: getState(db, 'fib_vwap_filter') === 'true' ? {} : null,
        fvgFilter: getState(db, 'fib_fvg_filter') === 'true' ? {} : null,
        strategies: enabledStrategies(db, getState), // same set the loop runs
      })
      // An infrastructure failure (expired token, rate limit) must surface
      // as an error, not masquerade as a "no setup" verdict.
      if (scanError) {
        return res.status(502).json({ error: scanError })
      }
      const result = synthesizeFibSignal(symbol, signal, req.body?.autoTradeThreshold || 8)

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
  // Granular autopilot toggles — scan / analyze / autotrade
  // Each is independent. Scan + analyze default ON, autotrade defaults OFF.
  // -----------------------------------------------------------------------
  router.post('/scan-toggle', (req, res) => {
    const on = req.body?.on !== false
    setState(db, 'scan_enabled', on ? 'true' : 'false')
    console.log(`[actions] Scan ${on ? 'enabled' : 'disabled'}`)
    res.json({ ok: true, scan_enabled: on })
  })

  router.post('/analyze-toggle', (req, res) => {
    const on = req.body?.on !== false
    setState(db, 'analyze_enabled', on ? 'true' : 'false')
    console.log(`[actions] Analyze ${on ? 'enabled' : 'disabled'}`)
    res.json({ ok: true, analyze_enabled: on })
  })

  // -----------------------------------------------------------------------
  // POST /actions/autotrade-timeframes — set which signal timeframes may
  // auto-trade. Body: { timeframes: ["4h","1d"] }
  // -----------------------------------------------------------------------
  router.post('/autotrade-timeframes', (req, res) => {
    const tfs = req.body?.timeframes
    if (!Array.isArray(tfs) || tfs.length === 0) {
      return res.status(400).json({ error: 'timeframes must be a non-empty array, e.g. ["4h","1d"] — free-text like "90m", "1.5h", "1M" is accepted' })
    }
    // Native periods pass through; anything else must parse (90m, 1.5h, 2d,
    // 1M …) and is stored under its canonical label. Duplicates by duration
    // collapse to one ("90m" and "1.5h" are the same timeframe).
    const parsed = tfs.map(t => parseTimeframe(String(t)))
    const bad = tfs.filter((_, i) => !parsed[i])
    if (bad.length) {
      return res.status(400).json({ error: `unreadable timeframe(s): ${bad.join(', ')} — use forms like 15m, 90m, 1.5h, 4h, 2d, 1w, 1M (decimals from hours up)` })
    }
    const seen = new Set()
    const canonical = parsed.filter(p => !seen.has(p.ms) && seen.add(p.ms)).map(p => p.label)
    setState(db, 'autotrade_timeframes', JSON.stringify(canonical))

    // Optional per-instrument arming: matrix = { SYMBOL: [timeframes] }.
    // When present, a symbol only auto-trades the timeframes armed FOR IT
    // (loop.js matrix gate) — "arm anyway" on one row must not widen the
    // whole watchlist. Pass matrix: null/{} to clear back to TF-wide.
    if ('matrix' in (req.body || {})) {
      const rawMatrix = req.body.matrix
      if (rawMatrix == null || (typeof rawMatrix === 'object' && Object.keys(rawMatrix).length === 0)) {
        setState(db, 'autotrade_matrix_json', null)
        console.log('[actions] autotrade matrix cleared (TF-wide arming)')
      } else if (typeof rawMatrix === 'object') {
        const clean = {}
        for (const [sym, list] of Object.entries(rawMatrix)) {
          if (!Array.isArray(list)) continue
          const ptfs = list.map(t => parseTimeframe(String(t))).filter(Boolean)
          if (ptfs.length) clean[String(sym).toUpperCase().trim()] = [...new Set(ptfs.map(p2 => p2.label))]
        }
        setState(db, 'autotrade_matrix_json', JSON.stringify(clean))
        console.log('[actions] autotrade matrix set:', Object.entries(clean).map(([k, v]) => `${k}:${v.join('/')}`).join(' '))
      }
    }

    console.log('[actions] autotrade timeframes set:', canonical.join(', '))
    let matrixOut = null
    try { matrixOut = JSON.parse(getState(db, 'autotrade_matrix_json') || 'null') } catch { /* null */ }
    res.json({ ok: true, timeframes: canonical, matrix: matrixOut })
  })

  // -----------------------------------------------------------------------
  // POST /actions/fib-rsi-filter — toggle the RSI confluence gate on fib
  // signals. Body: { on: boolean }
  // -----------------------------------------------------------------------
  router.post('/fib-rsi-filter', (req, res) => {
    const on = req.body?.on === true
    setState(db, 'fib_rsi_filter', on ? 'true' : 'false')
    console.log(`[actions] fib RSI filter ${on ? 'enabled' : 'disabled'}`)
    res.json({ ok: true, on })
  })

  // -----------------------------------------------------------------------
  // POST /actions/trade-now — proactive burst: scan the watchlist RIGHT NOW,
  // rank live setups by conviction, and place up to N of them through the
  // SAME risk gate + order path the loop uses. No backtest ritual required —
  // the risk manager is still the last word on every one (it can veto all).
  // Body: { count=2 (max 5), minConviction=5 }
  // -----------------------------------------------------------------------
  router.post('/trade-now', async (req, res) => {
    try {
      const count = Math.min(5, Math.max(1, Number(req.body?.count) || 2))
      const minConviction = Math.min(10, Math.max(1, Number(req.body?.minConviction) || 5))
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })

      let watchlist = []
      try {
        const raw = JSON.parse(getState(db, 'autopilot_symbols_json') || '[]')
        watchlist = (Array.isArray(raw) ? raw : [])
          .map(s => (typeof s === 'string' ? { symbol: s } : s))
          .filter(s => s.enabled !== false)
      } catch { /* empty */ }
      if (watchlist.length === 0) return res.status(400).json({ error: 'watchlist is empty — add symbols on Tune' })

      const map = await ensureSymbolMap(db, creds)
      let extraTimeframes = []
      try { extraTimeframes = JSON.parse(getState(db, 'autotrade_timeframes') || '[]') } catch { /* keep [] */ }
      const scanOpts = {
        rsiFilter: getState(db, 'fib_rsi_filter') === 'true' ? {} : null,
        vwapFilter: getState(db, 'fib_vwap_filter') === 'true' ? {} : null,
        fvgFilter: getState(db, 'fib_fvg_filter') === 'true' ? {} : null,
        strategies: enabledStrategies(db, getState), // same set the loop runs
        extraTimeframes,
      }

      // Scan a batch of enabled symbols, then rank by conviction. Bounded at
      // 15 per call — this is a synchronous HTTP request, not the
      // background loop, so scanning a 1900+ symbol watchlist in one shot
      // would time out the request. A ROTATING batch (own cursor, separate
      // from the main loop's scan_cursor so a manual burst never perturbs
      // the loop's own rotation progress) means repeated clicks eventually
      // cover the whole watchlist instead of always re-scanning the same
      // first 15 forever — the exact class of bug PR #201 fixed in the main
      // loop's own scan, audited into this route too (owner: "audit the
      // last 20 PRs, did you do what I want").
      const batchSize = 15
      const cursor = watchlist.length ? Math.max(0, Number(getState(db, 'trade_now_cursor')) || 0) % watchlist.length : 0
      const batch = [...watchlist.slice(cursor), ...watchlist.slice(0, cursor)].slice(0, batchSize)
      setState(db, 'trade_now_cursor', String(watchlist.length ? (cursor + batch.length) % watchlist.length : 0))

      const candidates = []
      for (const w of batch) {
        const symbolId = map[w.symbol.toUpperCase()]
        if (!symbolId) continue
        try {
          const { signal } = await scanSymbolFib(creds, w.symbol, symbolId, scanOpts)
          if (signal && signal.conviction >= minConviction) candidates.push({ w, signal })
        } catch { /* one symbol failing must not sink the burst */ }
      }
      candidates.sort((a, b) => b.signal.conviction - a.signal.conviction)

      const { autoTrade } = await import('../loop.js')
      const attempts = []
      let placed = 0
      for (const { w, signal } of candidates) {
        if (placed >= count) break
        const synth = synthesizeFibSignal(w.symbol, signal, minConviction).synthesis
        const result = await autoTrade(db, w.symbol, synth, w, null)
        attempts.push({
          symbol: w.symbol,
          timeframe: signal.timeframe || null,
          bias: signal.bias,
          conviction: signal.conviction,
          placed: !!result,
          executionPrice: result?.executionPrice ?? null,
          positionId: result?.positionId ?? null,
          // veto/order-failure detail is in risk_events (Monitor shows it)
        })
        if (result) placed++
      }

      console.log(`[actions] trade-now: ${candidates.length} candidates ≥${minConviction}/10, ${placed}/${count} placed`)
      res.json({
        ok: true,
        requested: count,
        minConviction,
        candidates: candidates.length,
        placed,
        attempts,
        note: candidates.length === 0
          ? `No symbol currently has a 61.8% setup at conviction ≥${minConviction}/10 — a burst cannot invent setups; try again later or lower the bar.`
          : undefined,
      })
    } catch (err) {
      console.error('[actions/trade-now] error:', err.message)
      res.status(502).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/arm-benchmarks — persist the backtest stats that justified
  // the current arming, so Monitor can compare live results against them
  // (the "reality gap"). Body: { benchmarks: { "SYM|tf": {profitFactor,
  // expectancyPct, trades} } }. Overwrites wholesale on each Apply.
  // -----------------------------------------------------------------------
  router.post('/arm-benchmarks', (req, res) => {
    const b = req.body?.benchmarks
    if (b != null && typeof b !== 'object') return res.status(400).json({ error: 'benchmarks must be an object' })
    setState(db, 'arm_benchmarks_json', b && Object.keys(b).length ? JSON.stringify(b) : null)
    console.log('[actions] arm benchmarks stored:', b ? Object.keys(b).length : 0, 'pairs')
    res.json({ ok: true, pairs: b ? Object.keys(b).length : 0 })
  })

  // POST /actions/fib-vwap-filter — leg-anchored VWAP confluence gate.
  router.post('/fib-vwap-filter', (req, res) => {
    const on = req.body?.on === true
    setState(db, 'fib_vwap_filter', on ? 'true' : 'false')
    console.log(`[actions] fib VWAP filter ${on ? 'enabled' : 'disabled'}`)
    res.json({ ok: true, on })
  })

  // POST /actions/fib-fvg-filter — unfilled fair-value-gap confluence gate.
  router.post('/fib-fvg-filter', (req, res) => {
    const on = req.body?.on === true
    setState(db, 'fib_fvg_filter', on ? 'true' : 'false')
    console.log(`[actions] fib FVG filter ${on ? 'enabled' : 'disabled'}`)
    res.json({ ok: true, on })
  })

  // POST /actions/profit-keeper — configure automatic profit protection for
  // manual/external positions. Body: { on, scope, armProfitUsd, givebackPct,
  // takeProfitUsd } (partial updates merge over the stored config).
  router.post('/profit-keeper', async (req, res) => {
    try {
      const { loadProfitKeeperConfig } = await import('../services/profit-keeper.js')
      const current = loadProfitKeeperConfig(db)
      const b = req.body || {}
      const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)
      const clamp = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback)
      const next = {
        on: b.on != null ? b.on === true : current.on,
        scope: b.scope === 'all' ? 'all' : b.scope === 'external' ? 'external' : current.scope,
        mode: b.mode === 'fixed' ? 'fixed' : b.mode === 'adaptive' ? 'adaptive' : current.mode,
        // adaptive
        atrTimeframe: typeof b.atrTimeframe === 'string' && b.atrTimeframe.trim() ? b.atrTimeframe.trim() : current.atrTimeframe,
        atrPeriod: b.atrPeriod !== undefined ? Math.round(clamp(b.atrPeriod, 5, 50, current.atrPeriod)) : current.atrPeriod,
        armAtrMult: b.armAtrMult !== undefined ? clamp(b.armAtrMult, 0.1, 10, current.armAtrMult) : current.armAtrMult,
        armBalancePct: b.armBalancePct !== undefined ? clamp(b.armBalancePct, 0.01, 5, current.armBalancePct) : current.armBalancePct,
        trailAtrMult: b.trailAtrMult !== undefined ? clamp(b.trailAtrMult, 0.5, 10, current.trailAtrMult) : current.trailAtrMult,
        scaleOutFrac: b.scaleOutFrac !== undefined ? clamp(b.scaleOutFrac, 0, 0.9, current.scaleOutFrac) : current.scaleOutFrac,
        // fixed
        armProfitUsd: b.armProfitUsd !== undefined ? (num(b.armProfitUsd) ?? current.armProfitUsd) : current.armProfitUsd,
        givebackPct: b.givebackPct !== undefined ? Math.min(95, Math.max(5, Number(b.givebackPct) || current.givebackPct)) : current.givebackPct,
        // both
        takeProfitUsd: b.takeProfitUsd !== undefined ? num(b.takeProfitUsd) : current.takeProfitUsd,
      }
      setState(db, 'profit_keeper_json', JSON.stringify(next))
      console.log(`[actions] Profit Keeper ${next.on ? 'ON' : 'off'} — scope=${next.scope} arm=$${next.armProfitUsd} giveback=${next.givebackPct}%${next.takeProfitUsd ? ` tp=$${next.takeProfitUsd}` : ''}`)
      res.json({ ok: true, config: next })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /actions/loss-guardian — configure the loss-side safety net. Body:
  // { on, scope, maxAtrMult, fallbackAdversePct, maxHoldHours } (partial
  // updates merge over the stored config).
  router.post('/loss-guardian', async (req, res) => {
    try {
      const { loadLossGuardianConfig } = await import('../services/loss-guardian.js')
      const current = loadLossGuardianConfig(db)
      const b = req.body || {}
      const clamp = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback)
      const next = {
        on: b.on != null ? b.on === true : current.on,
        scope: b.scope === 'all' ? 'all' : b.scope === 'external' ? 'external' : current.scope,
        atrTimeframe: typeof b.atrTimeframe === 'string' && b.atrTimeframe.trim() ? b.atrTimeframe.trim() : current.atrTimeframe,
        atrPeriod: b.atrPeriod !== undefined ? Math.round(clamp(b.atrPeriod, 5, 50, current.atrPeriod)) : current.atrPeriod,
        maxAtrMult: b.maxAtrMult !== undefined ? clamp(b.maxAtrMult, 1, 10, current.maxAtrMult) : current.maxAtrMult,
        fallbackAdversePct: b.fallbackAdversePct !== undefined ? clamp(b.fallbackAdversePct, 0.005, 0.2, current.fallbackAdversePct) : current.fallbackAdversePct,
        // null = time cap off; a positive number arms it
        maxHoldHours: b.maxHoldHours === null ? null : (b.maxHoldHours !== undefined ? (Number(b.maxHoldHours) > 0 ? Number(b.maxHoldHours) : null) : current.maxHoldHours),
      }
      setState(db, 'loss_guardian_json', JSON.stringify(next))
      console.log(`[actions] Loss Guardian ${next.on ? 'ON' : 'off'} — scope=${next.scope} maxAtr=${next.maxAtrMult} timeCap=${next.maxHoldHours ?? 'off'}`)
      res.json({ ok: true, config: next })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // POST /actions/closed-market-limits — arm/disarm resting limit orders for
  // closed-market setups. Body: { on }.
  router.post('/closed-market-limits', async (req, res) => {
    try {
      const { loadClosedMarketLimitsConfig } = await import('../services/closed-market-limits.js')
      const current = loadClosedMarketLimitsConfig(db)
      const b = req.body || {}
      const next = { ...current, on: b.on != null ? b.on === true : current.on }
      setState(db, 'closed_market_limits_json', JSON.stringify(next))
      console.log(`[actions] Closed-market limits ${next.on ? 'ON' : 'off'}`)
      res.json({ ok: true, config: next })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/autotrade-toggle', (req, res) => {
    const on = req.body?.on === true
    setState(db, 'autotrade_enabled', on ? 'true' : 'false')
    console.log(`[actions] Auto-trade ${on ? 'enabled' : 'disabled'}`)
    res.json({ ok: true, autotrade_enabled: on })
  })

  // Backward compat: /actions/autopilot toggles autotrade only
  router.post('/autopilot', (req, res) => {
    const on = req.body?.on === true
    setState(db, 'autotrade_enabled', on ? 'true' : 'false')
    console.log(`[actions] Auto-trade (via /autopilot) ${on ? 'enabled' : 'disabled'}`)
    res.json({ ok: true, autotrade_enabled: on })
  })

  // -----------------------------------------------------------------------
  // POST /actions/arm — legacy: enable all three toggles
  // -----------------------------------------------------------------------
  router.post('/arm', (_req, res) => {
    setState(db, 'scan_enabled', 'true')
    setState(db, 'analyze_enabled', 'true')
    setState(db, 'autotrade_enabled', 'true')
    console.log('[actions] Armed — all toggles enabled')
    res.json({ ok: true, scan_enabled: true, analyze_enabled: true, autotrade_enabled: true })
  })

  // -----------------------------------------------------------------------
  // POST /actions/disarm — legacy: disable autotrade only (scan+analyze stay on)
  // -----------------------------------------------------------------------
  router.post('/disarm', (_req, res) => {
    setState(db, 'autotrade_enabled', 'false')
    console.log('[actions] Disarmed — auto-trade disabled (scan+analyze still on)')
    res.json({ ok: true, autotrade_enabled: false })
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
    setState(db, 'scan_enabled', 'false')
    setState(db, 'analyze_enabled', 'false')
    setState(db, 'autotrade_enabled', 'false')
    const r = db.prepare("UPDATE monitored_positions SET paused = 1 WHERE status = 'active'").run()
    console.log(`[actions] KILL-ALL — all toggles off, ${r.changes} positions paused`)
    res.json({ ok: true, paused: r.changes })
  })

  // -----------------------------------------------------------------------
  // POST /actions/ctrader-config — push cTrader credentials + account roles
  // Body: { accessToken, accounts: [{ accountId, isLive, autopilot, copilot }] }
  // The loop reads autopilot-enabled accounts and trades each one.
  // -----------------------------------------------------------------------
  // List every trading account an access token can operate, with balances.
  async function listCtraderAccounts(accessToken) {
    const { ctraderEnv } = await import('../lib/ctrader-env.js')
    const clientId = ctraderEnv('clientId')
    const clientSecret = ctraderEnv('clientSecret')
    if (!clientId || !clientSecret) {
      throw new Error('cTrader client id/secret env vars not set on the agent')
    }
    // Account listing works on either host; use demo.
    const { wsGetAccountsByToken, wsGetTrader, traderBalance } = await import('../lib/ctrader-ws.js')
    const data = await wsGetAccountsByToken('demo.ctraderapi.com', clientId, clientSecret, accessToken)
    const accounts = (data.ctidTraderAccount || []).map(a => ({
      accountId: a.ctidTraderAccountId,
      isLive: !!a.isLive,
      traderLogin: a.traderLogin ?? null,
      brokerTitle: a.brokerTitleShort || a.brokerName || null,
      balance: null,
    }))
    // Enrich each account with its balance (best effort — a failure just
    // leaves balance null for that account).
    await Promise.all(accounts.map(async (a) => {
      try {
        const host = a.isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
        const trader = await wsGetTrader(host, clientId, clientSecret, accessToken, a.accountId)
        const bal = traderBalance(trader)
        if (bal != null) a.balance = bal
      } catch { /* leave null */ }
    }))
    return accounts
  }

  // -----------------------------------------------------------------------
  // POST /actions/broker-positions — full per-account broker snapshot for
  // the Accounts view: every account on the stored token, with its live
  // positions (entry, now, Δpips, est. P&L, SL/TP, swap, commission,
  // margin, open time, label) and pending orders.
  // On-demand only (up to ~3 WS round-trips per account) — not on the loop.
  // -----------------------------------------------------------------------
  router.post('/broker-positions', async (req, res) => {
    try {
      const { ctraderEnv } = await import('../lib/ctrader-env.js')
      const accessToken = getState(db, 'ctrader_access_token') || ctraderEnv('accessToken')
      if (!accessToken) return res.status(400).json({ error: 'No access token stored — connect cTrader first' })
      const clientId = ctraderEnv('clientId')
      const clientSecret = ctraderEnv('clientSecret')
      const { wsReconcile, wsSymbolsByIds, wsGetSymbolsList, wsGetLastCloses, wsGetTrader, wsGetAssets, wsGetUnrealizedPnl } = await import('../lib/ctrader-ws.js')

      let accounts = await listCtraderAccounts(accessToken)
      const selectedId = getState(db, 'ctrader_account_id')
      // selectedOnly: snapshot just the bot's account (Monitor uses this —
      // 1 account × ~4 round-trips instead of 7 accounts' worth).
      if (req.body?.selectedOnly && selectedId) {
        accounts = accounts.filter(a => String(a.accountId) === String(selectedId))
      }

      const snapshotAccount = async (acct) => {
        const host = acct.isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
        const out = {
          ...acct,
          selected: String(acct.accountId) === String(selectedId),
          currency: null,
          positions: [],
          orders: [],
          error: null,
          metaError: null,
        }
        try {
          const rec = await wsReconcile(host, clientId, clientSecret, accessToken, acct.accountId)
          const rawPositions = rec.position || []
          const rawOrders = rec.order || []

          // Deposit currency: trader.depositAssetId resolved via the asset list.
          // The full asset map also names each symbol's QUOTE currency below.
          const assetNameById = {}
          try {
            const [trader, assets] = await Promise.all([
              wsGetTrader(host, clientId, clientSecret, accessToken, acct.accountId),
              wsGetAssets(host, clientId, clientSecret, accessToken, acct.accountId),
            ])
            for (const a of (assets.asset || [])) assetNameById[a.assetId] = a.displayName || a.name || null
            out.currency = assetNameById[trader.depositAssetId] || null
          } catch { /* currency stays null */ }

          if (rawPositions.length === 0 && rawOrders.length === 0) return out

          const symbolIds = [...new Set([
            ...rawPositions.map(p => p.tradeData?.symbolId),
            ...rawOrders.map(o => o.tradeData?.symbolId),
          ].filter(Boolean))]

          // Symbol metadata (name, digits, pip position, lot size, min volume).
          // A failure here must be VISIBLE — without it the table shows raw
          // numeric ids and cannot compute lots.
          // SYMBOL_BY_ID returns the FULL symbol record (lotSize, minVolume,
          // pipPosition…) but — per the Open API spec — NOT symbolName. Names
          // only exist on the LIGHT symbols list, so both calls are needed.
          const symMeta = {}
          try {
            const [symData, lightData] = await Promise.all([
              wsSymbolsByIds(host, clientId, clientSecret, accessToken, acct.accountId, symbolIds),
              wsGetSymbolsList(host, clientId, clientSecret, accessToken, acct.accountId),
            ])
            for (const s of (symData.symbol || [])) symMeta[s.symbolId] = { ...s }
            for (const s of (lightData.symbol || [])) {
              if (symbolIds.includes(s.symbolId) && s.symbolName) {
                symMeta[s.symbolId] = { ...(symMeta[s.symbolId] || {}), symbolName: s.symbolName }
              }
            }
          } catch (err) {
            out.metaError = `symbol names unavailable: ${err.message}`
          }
          let lastCloses = {}
          try {
            lastCloses = await wsGetLastCloses(host, clientId, clientSecret, accessToken, acct.accountId, symbolIds)
          } catch { /* est P&L omitted */ }
          // Broker-truth unrealized P&L in the deposit currency — the number
          // cTrader's own app shows, exact for every asset class. The price
          // estimate below stays as the fallback for older API servers.
          let pnlMap = {}
          try {
            pnlMap = await wsGetUnrealizedPnl(host, clientId, clientSecret, accessToken, acct.accountId)
          } catch { /* fall back to estimates */ }
          // Live bid/ask for position symbols only (cTrader's compulsory
          // columns) — a handful of one-shot quotes, fetched in parallel.
          let spots = {}
          try {
            const posSymbolIds = [...new Set(rawPositions.map(p => p.tradeData?.symbolId).filter(Boolean))]
            const rs2 = await Promise.all(posSymbolIds.map(id =>
              wsGetSpotOnce(host, clientId, clientSecret, accessToken, acct.accountId, id).then(q => [id, q]).catch(() => [id, null])
            ))
            spots = Object.fromEntries(rs2)
          } catch { /* bid/ask omitted */ }

          const money = (v) => (v == null ? null : v / Math.pow(10, acct.moneyDigits ?? 2))
          // volume and lotSize are both in cents-of-units, so lots is their
          // ratio — correct for every asset class (FX, metals, crypto,
          // indices), unlike a fixed per-lot constant.
          const toLots = (volume, meta) =>
            volume != null && meta.lotSize ? Math.round((volume / meta.lotSize) * 100) / 100 : null
          // The JSON bridge returns proto enums as NUMBERS.
          const SIDE_NAME = { 1: 'BUY', 2: 'SELL' }
          const sideOf = (v) => SIDE_NAME[v] || String(v || '').toUpperCase()
          const ORDER_TYPE_NAME = { 1: 'MARKET', 2: 'LIMIT', 3: 'STOP', 4: 'SL/TP', 5: 'MARKET RANGE', 6: 'STOP LIMIT' }
          const orderTypeOf = (v) => ORDER_TYPE_NAME[v] || String(v || 'ORDER').toUpperCase()
          const round5 = (v) => Math.round(v * 100000) / 100000

          // cTrader stores a live position's EXTRA TP levels (the app's
          // "Take profit 2/3…", each with its own quantity) as CLOSING
          // limit orders bound to the positionId — they are not standalone
          // pending entries. Group them onto their position as the TP
          // ladder; only true entry orders stay in the orders list.
          const isCloser = (o) => o.closingOrder === true || Number(o.positionId) > 0
          const closersByPos = {}
          for (const o of rawOrders.filter(isCloser)) {
            const pid = String(o.positionId ?? '')
            ;(closersByPos[pid] ??= []).push(o)
          }
          const entryOrders = rawOrders.filter(o => !isCloser(o))

          out.positions = rawPositions.map(p => {
            const td = p.tradeData || {}
            const meta = symMeta[td.symbolId] || {}
            const lots = toLots(td.volume, meta)
            const dir = sideOf(td.tradeSide) === 'SELL' ? -1 : 1
            const now = lastCloses[td.symbolId] ?? null
            const pipSize = meta.pipPosition != null ? Math.pow(10, -meta.pipPosition) : null
            const deltaPips = now != null && p.price != null && pipSize
              ? Math.round(((now - p.price) * dir) / pipSize * 10) / 10
              : null
            const unitsPerLot = meta.lotSize != null ? meta.lotSize / 100 : null
            const estPnlQuote = now != null && p.price != null && lots != null && unitsPerLot != null
              ? Math.round((now - p.price) * dir * lots * unitsPerLot * 100) / 100
              : null
            // Net estimate in the deposit currency — what cTrader's own
            // Positions tab shows. Price P&L is in the QUOTE currency: exact
            // for USD-quoted symbols, ÷price for USD-base pairs (USDJPY),
            // unknown for crosses (net omitted rather than mis-stated).
            const symName = String(meta.symbolName || '').toUpperCase()
            const isFxPair = symName.length === 6 && /^[A-Z]{6}$/.test(symName)
            const quoteCcy = isFxPair ? symName.slice(3) : 'USD'
            let estPnlDeposit = null
            if (estPnlQuote != null) {
              if (quoteCcy === 'USD') estPnlDeposit = estPnlQuote
              else if (isFxPair && symName.startsWith('USD') && now > 0) estPnlDeposit = estPnlQuote / now
            }
            const swapMoney = money(p.swap)
            const commissionMoney = money(p.commission)
            const estNetPnl = estPnlDeposit != null
              ? Math.round((estPnlDeposit + (swapMoney || 0) + (commissionMoney || 0)) * 100) / 100
              : null
            // Broker truth wins; estimate only fills the gap.
            const brokerPnl = pnlMap[String(p.positionId)] || null
            const netPnl = brokerPnl?.net ?? estNetPnl
            // TP ladder: closing limit orders carry the app's TP2/TP3 with
            // their per-level quantity; the position's native TP covers the
            // leftover volume. Sorted nearest-first in the profit direction.
            const closerTps = (closersByPos[String(p.positionId)] || [])
              .filter(o => o.limitPrice != null)
              .map(o => ({
                price: o.limitPrice,
                lots: toLots(o.tradeData?.volume, meta),
                at: o.utcLastUpdateTimestamp ?? null,
              }))
            const closerLots = closerTps.reduce((s, t) => s + (t.lots || 0), 0)
            const ladder = [
              ...(p.takeProfit != null
                ? [{ price: p.takeProfit, lots: lots != null ? Math.max(0, Math.round((lots - closerLots) * 100) / 100) : null, at: p.utcLastUpdateTimestamp ?? null }]
                : []),
              ...closerTps,
            ]
              .sort((a, b) => dir === 1 ? a.price - b.price : b.price - a.price)
              .map((t, i) => ({ n: i + 1, ...t }))
            return {
              positionId: p.positionId,
              symbol: meta.symbolName || `#${td.symbolId}`,
              side: sideOf(td.tradeSide),
              lots,
              rawVolume: td.volume ?? null,
              minLot: toLots(meta.minVolume, meta),
              entry: p.price ?? null,
              currentPrice: now,
              deltaPips,
              estPnlQuote, // in the symbol's QUOTE currency, price-move only (excludes swap/commission)
              estNetPnl,   // deposit-ccy ESTIMATE incl. swap + commission (fallback only)
              netPnl,      // BROKER-truth net unrealized P&L (deposit ccy) — cTrader's own figure
              grossPnl: brokerPnl?.gross ?? null,
              pnlSource: brokerPnl ? 'broker' : (estNetPnl != null ? 'estimate' : null),
              pipSize: meta.pipPosition != null ? Math.pow(10, -meta.pipPosition) : null,
              digits: meta.digits ?? null,
              sl: p.stopLoss ?? null,
              tp: p.takeProfit ?? null,
              tps: ladder.length ? ladder : null,
              bid: spots[td.symbolId]?.bid ?? null,
              ask: spots[td.symbolId]?.ask ?? null,
              swap: swapMoney,
              commission: commissionMoney,
              usedMargin: money(p.usedMargin),
              openedAt: td.openTimestamp ?? null,
              lastModifiedAt: p.utcLastUpdateTimestamp ?? null,
              // Currencies for the table (owner spec): prices quote in the
              // symbol's QUOTE currency (broker asset truth, FX-name
              // fallback); money figures are in the DEPOSIT currency.
              quoteCcy: assetNameById[meta.quoteAssetId] || (isFxPair ? quoteCcy : null),
              depositCcy: out.currency || null,
              label: td.label || null,
              // Segment open trades by what opened them (owner: "segment ...
              // by timeframe + Strategy Used column"). Parsed from the
              // structured label; null for manual/external positions.
              strategy: parseLabel(td.label || '').strategy || null,
              timeframe: parseLabel(td.label || '').timeframe || null,
              comment: td.comment || null,
              guaranteedSl: !!p.guaranteedStopLoss,
            }
          })

          out.orders = entryOrders.map(o => {
            const td = o.tradeData || {}
            const meta = symMeta[td.symbolId] || {}
            const side = sideOf(td.tradeSide)
            const trigger = o.limitPrice ?? o.stopPrice ?? null
            const oDir = side === 'SELL' ? -1 : 1
            // The app places SL/TP on pending orders as RELATIVE distances
            // (1/100000-price units); absolute fields win when present.
            const relSl = Number(o.relativeStopLoss)
            const relTp = Number(o.relativeTakeProfit)
            return {
              orderId: o.orderId,
              type: orderTypeOf(o.orderType),
              symbol: meta.symbolName || `#${td.symbolId}`,
              side,
              lots: toLots(td.volume, meta),
              minLot: toLots(meta.minVolume, meta),
              limitPrice: o.limitPrice ?? null,
              stopPrice: o.stopPrice ?? null,
              currentPrice: lastCloses[td.symbolId] ?? null,
              sl: o.stopLoss ?? (trigger != null && Number.isFinite(relSl) && relSl > 0 ? round5(trigger - oDir * relSl / 100000) : null),
              tp: o.takeProfit ?? (trigger != null && Number.isFinite(relTp) && relTp > 0 ? round5(trigger + oDir * relTp / 100000) : null),
              expiresAt: o.expirationTimestamp ?? null,
              updatedAt: o.utcLastUpdateTimestamp ?? null,
              label: td.label || null,
              // Segment pending orders the same way as open trades.
              strategy: parseLabel(td.label || '').strategy || null,
              timeframe: parseLabel(td.label || '').timeframe || null,
              comment: td.comment || null,
            }
          })
        } catch (err) {
          out.error = err.message
        }
        return out
      }

      // Snapshot accounts with small concurrency to avoid a WS burst
      const results = []
      for (let i = 0; i < accounts.length; i += 3) {
        results.push(...await Promise.all(accounts.slice(i, i + 3).map(snapshotAccount)))
      }
      const fetchedAt = new Date().toISOString()
      // Cache the SELECTED account's snapshot — the monitor hits this route
      // every ~30s, so the cache stays fresh; the Desk paints from it
      // instantly (GET /state/broker-cache) while the live call refreshes.
      try {
        const sel = results.find(a => a.selected && !a.error)
        if (sel) setState(db, 'broker_snapshot_cache_json', JSON.stringify({ account: sel, fetchedAt }))
      } catch { /* cache is best-effort */ }
      res.json({ ok: true, accounts: results, fetchedAt })
    } catch (err) {
      console.error('[actions/broker-positions] error:', err.message)
      res.status(502).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/ctrader-token — store an access token and list every
  // trading account it can operate (no account id needed from the user).
  // Body: { accessToken }
  // -----------------------------------------------------------------------
  router.post('/ctrader-token', async (req, res) => {
    try {
      const { accessToken } = req.body || {}
      if (!accessToken) return res.status(400).json({ error: 'accessToken is required' })
      const accounts = await listCtraderAccounts(accessToken)
      setState(db, 'ctrader_access_token', accessToken)
      console.log(`[actions] ctrader token stored — ${accounts.length} account(s) available`)
      res.json({ ok: true, accounts })
    } catch (err) {
      console.error('[actions/ctrader-token] error:', err.message)
      res.status(502).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/ctrader-accounts — re-list accounts from the token the
  // agent already has stored (so the UI picker survives page reloads).
  // -----------------------------------------------------------------------
  router.post('/ctrader-accounts', async (_req, res) => {
    try {
      const { ctraderEnv } = await import('../lib/ctrader-env.js')
      const accessToken = getState(db, 'ctrader_access_token') || ctraderEnv('accessToken')
      if (!accessToken) return res.status(400).json({ error: 'No access token stored — connect cTrader first' })
      const accounts = await listCtraderAccounts(accessToken)
      res.json({
        ok: true,
        accounts,
        selectedAccountId: getState(db, 'ctrader_account_id') || null,
      })
    } catch (err) {
      console.error('[actions/ctrader-accounts] error:', err.message)
      res.status(502).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/ctrader-select-account — pick the trading account and
  // auto-build the symbol → symbolId map from the broker's symbol list.
  // Body: { accountId, isLive }
  // -----------------------------------------------------------------------
  router.post('/ctrader-select-account', async (req, res) => {
    try {
      const { accountId, isLive } = req.body || {}
      if (!accountId) return res.status(400).json({ error: 'accountId is required' })
      const accessToken = getState(db, 'ctrader_access_token')
      if (!accessToken) return res.status(400).json({ error: 'No access token stored — push it first via /actions/ctrader-token' })
      const clientId = ctraderEnv('clientId')
      const clientSecret = ctraderEnv('clientSecret')

      // On a genuine account change, close local monitor rows from the old
      // account so they stop gating risk checks immediately — the reconciler
      // would only catch them on its next pass against the new account.
      const previousAccountId = getState(db, 'ctrader_account_id')
      if (previousAccountId && String(previousAccountId) !== String(accountId)) {
        const swept = sweepMonitoredPositionsForAccount(db, accountId)
        if (swept > 0) {
          console.log(`[actions] account switch ${previousAccountId} → ${accountId}: swept ${swept} stale monitored position(s)`)
        }
      }

      setState(db, 'ctrader_account_id', String(accountId))
      setState(db, 'ctrader_is_live', isLive ? 'true' : 'false')
      setState(db, 'ctrader_account_roles_json', JSON.stringify([{ accountId, isLive: !!isLive, autopilot: true }]))
      // The human-facing account number (traderLogin, e.g. 5306502) — the
      // ctidTraderAccountId above is cTrader's internal id and confused the
      // owner when the health strip showed it. Stored best-effort at select
      // time; resolved from the account list when the UI didn't send it.
      let traderLogin = req.body?.traderLogin ?? null
      if (traderLogin == null) {
        try {
          const accounts = await listCtraderAccounts(accessToken)
          traderLogin = accounts.find(a => String(a.accountId) === String(accountId))?.traderLogin ?? null
        } catch { /* cosmetic — the internal id still shows */ }
      }
      setState(db, 'ctrader_trader_login', traderLogin != null ? String(traderLogin) : null)

      const host = isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
      const { wsGetSymbolsList, wsGetTrader, traderBalance } = await import('../lib/ctrader-ws.js')
      const data = await wsGetSymbolsList(host, clientId, clientSecret, accessToken, accountId)
      const map = {}
      for (const s of (data.symbol || [])) {
        if (s.symbolName && s.symbolId != null) map[String(s.symbolName).toUpperCase()] = s.symbolId
      }
      if (Object.keys(map).length > 0) {
        setState(db, 'symbol_id_map', JSON.stringify(map))
      }

      // Pull real balance + leverage from the broker so the risk manager is
      // equity-aware without manual entry (Tune's fields remain an override).
      let balance = null
      try {
        const trader = await wsGetTrader(host, clientId, clientSecret, accessToken, accountId)
        balance = traderBalance(trader)
        if (balance != null) {
          setState(db, 'account_balance_usd', String(balance))
        }
        if (trader.leverageInCents != null) {
          setState(db, 'account_leverage', String(trader.leverageInCents / 100))
        }
      } catch (e) {
        console.warn('[actions/ctrader-select-account] balance fetch failed:', e.message)
      }

      console.log(`[actions] ctrader account ${accountId} selected (${isLive ? 'LIVE' : 'demo'}) — ${Object.keys(map).length} symbols mapped, balance ${balance ?? 'unknown'}`)
      res.json({ ok: true, accountId, isLive: !!isLive, symbolsMapped: Object.keys(map).length, balance })
    } catch (err) {
      console.error('[actions/ctrader-select-account] error:', err.message)
      res.status(502).json({ error: err.message })
    }
  })

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

        // Stale-position sweep, multi-account aware: rows belonging to ANY
        // account still in the pushed config stay active (the loop trades
        // every autopilot account); only rows from accounts that dropped out
        // of the config are closed. Legacy NULL-account rows were created
        // under the previously selected account, so they are swept only when
        // that account is itself gone from the config. An invalid/empty
        // account list sweeps nothing.
        const keepIds = accounts.map(a => a?.accountId).filter(id => id != null)
        const previousAccountId = getState(db, 'ctrader_account_id')
        const sweepNull = previousAccountId != null && !keepIds.map(String).includes(String(previousAccountId))
        const swept = sweepMonitoredPositionsForAccounts(db, keepIds, { sweepNull })
        if (swept > 0) {
          console.log(`[actions] ctrader-config: swept ${swept} monitored position(s) from accounts no longer configured`)
        }

        // Backward compat: keep legacy single-account keys in sync with
        // the first autopilot account so old code paths don't break.
        if (ap.length > 0 && ap[0].accountId != null) {
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
        // Max lots is a CAP on the risk-based size — it must be a positive
        // number (a stored -0.02 silently degraded sizing to broker minimum).
        const cap = Number(s.maxVolume)
        return {
          ...s,
          symbol: (s.symbol || '').toUpperCase().trim(),
          enabled: s.enabled !== false,
          maxVolume: Number.isFinite(cap) && cap > 0 ? Math.round(cap * 100) / 100 : undefined,
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
  // POST /actions/symbols — autopilot's own symbol universe
  // Separate from copilot watchlist. These are the symbols the bot scans
  // and trades autonomously. Each can have maxVolume + autoTradeThreshold.
  // -----------------------------------------------------------------------
  router.post('/symbols', (req, res) => {
    try {
      const { symbols } = req.body || {}
      if (!symbols || !Array.isArray(symbols)) {
        return res.status(400).json({ error: 'Missing required field: symbols (array)' })
      }
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
      setState(db, 'autopilot_symbols_json', JSON.stringify(normalized))
      console.log('[actions] Autopilot symbols updated:', normalized.map(w => w.symbol).join(', '))
      res.json({ ok: true, symbols: normalized })
    } catch (err) {
      console.error('[actions/symbols] error:', err.message)
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
  // POST /actions/reset-breaker — reset the circuit breaker after manual review
  // -----------------------------------------------------------------------
  router.post('/reset-breaker', (_req, res) => {
    setState(db, 'circuit_breaker_tripped_at', null)
    setState(db, 'errors_today', '0')
    console.log('[actions] Circuit breaker reset')
    res.json({ ok: true, message: 'Circuit breaker reset — loop will resume on next tick' })
  })

  // -----------------------------------------------------------------------
  // POST /actions/reset-data — wipe all trading data but preserve config
  // Clears: scans, analyses, trades, monitored_positions, regimes, signals,
  //         performance_snapshots, risk_events.
  // Resets: loop_count, errors_today, last_scan_at, last_error,
  //         circuit_breaker_tripped_at.
  // Preserves: autopilot_symbols_json, scan_enabled, analyze_enabled,
  //            autotrade_enabled (and everything else in agent_state).
  // -----------------------------------------------------------------------
  router.post('/reset-data', (_req, res) => {
    try {
      db.transaction(() => {
        // 1. Clear all trading data tables
        db.exec('DELETE FROM scans')
        db.exec('DELETE FROM analyses')
        db.exec('DELETE FROM trades')
        db.exec('DELETE FROM monitored_positions')
        db.exec('DELETE FROM regimes')
        db.exec('DELETE FROM signals')
        db.exec('DELETE FROM performance_snapshots')
        db.exec('DELETE FROM risk_events')

        // 2. Reset agent_state counters (preserve config / toggles)
        setState(db, 'loop_count', '0')
        setState(db, 'errors_today', '0')
        setState(db, 'last_scan_at', null)
        setState(db, 'last_error', null)
        setState(db, 'circuit_breaker_tripped_at', null)
      })()

      console.log('[actions] reset-data — all trading data cleared, counters reset')
      res.json({ ok: true, message: 'All trading data cleared and counters reset. Config and toggles preserved.' })
    } catch (err) {
      console.error('[actions/reset-data] error:', err.message)
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

  // -----------------------------------------------------------------------
  // POST /actions/symbol-config — update per-symbol overrides + style toggles
  // Body: { symbol: "EURUSD", ...overrides }
  // Merges into existing watchlist/symbols config stored in autopilot_symbols_json
  // -----------------------------------------------------------------------
  router.post('/symbol-config', (req, res) => {
    try {
      const { symbol, ...updates } = req.body || {}
      if (!symbol) return res.status(400).json({ error: 'Missing required field: symbol' })

      const key = 'autopilot_symbols_json'
      const raw = getState(db, key) || getState(db, 'watchlist_json') || '[]'
      let symbols
      try { symbols = JSON.parse(raw) } catch { symbols = [] }
      symbols = symbols.map(s => typeof s === 'string' ? { symbol: s, enabled: true } : s)

      const idx = symbols.findIndex(s => s.symbol === symbol.toUpperCase())
      if (idx === -1) return res.status(404).json({ error: `Symbol ${symbol} not in watchlist` })

      const ALLOWED = ['enabled', 'maxVolume', 'autoTradeThreshold', 'force_skip', 'override_bias', 'block_next_trade', 'allowed_styles']
      for (const k of ALLOWED) {
        if (k in updates) symbols[idx][k] = updates[k]
      }

      setState(db, key, JSON.stringify(symbols))
      console.log(`[actions] symbol-config updated for ${symbol}:`, JSON.stringify(updates))
      res.json({ ok: true, symbol: symbols[idx] })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/execute-trade — manually push a planned analysis to cTrader
  // Body: { analysisId: number }
  // Goes through the full risk gate before placing the order.
  // -----------------------------------------------------------------------
  router.post('/execute-trade', async (req, res) => {
    try {
      const { analysisId } = req.body || {}
      if (!analysisId) return res.status(400).json({ error: 'Missing analysisId' })

      const analysis = db.prepare('SELECT * FROM analyses WHERE id = ?').get(analysisId)
      if (!analysis) return res.status(404).json({ error: 'Analysis not found' })

      const synth = JSON.parse(analysis.synthesis || '{}')
      if (!synth.entry && !analysis.entry_price) {
        return res.status(400).json({ error: 'No entry price in analysis — cannot execute' })
      }
      const entry = synth.entry ?? synth.entry_price ?? analysis.entry_price
      const sl = synth.sl ?? synth.sl_price ?? analysis.sl_price
      const tp1 = synth.tp1 ?? synth.tp1_price ?? analysis.tp1_price
      const bias = analysis.consensus_bias
      if (!bias || bias === 'skip' || bias === 'neutral') {
        return res.status(400).json({ error: `Cannot execute trade with bias "${bias}"` })
      }

      const clientId = ctraderEnv('clientId')
      const clientSecret = ctraderEnv('clientSecret')
      const accessToken = getState(db, 'ctrader_access_token')
      const accountId = getState(db, 'ctrader_account_id')
      const isLive = getState(db, 'ctrader_is_live') === 'true'

      if (!clientId || !clientSecret || !accessToken || !accountId) {
        return res.status(400).json({ error: 'cTrader credentials not configured' })
      }

      const symbolMapJson = getState(db, 'symbol_id_map')
      const symbolMap = symbolMapJson ? JSON.parse(symbolMapJson) : {}
      const symbolId = symbolMap[analysis.symbol.toUpperCase()]
      if (!symbolId) {
        return res.status(400).json({ error: `Symbol ID unknown for ${analysis.symbol} — push symbol map first` })
      }

      const side = bias === 'short' ? 'SELL' : 'BUY'
      const symbolsJson = getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json') || '[]'
      let symbols = []
      try { symbols = JSON.parse(symbolsJson) } catch { /* corrupt state — use empty list */ }
      const wItem = symbols.find(s => (typeof s === 'string' ? s : s.symbol) === analysis.symbol) || {}
      const requestedVol = (typeof wItem === 'object' ? wItem.maxVolume : null) || 0.01

      const proposal = { symbol: analysis.symbol, side, entry, sl, tp1, requestedVolume: requestedVol, strategy: analysis.strategy, conviction: analysis.overall_conviction, source: 'execute_analysis' }
      const riskResult = evaluateTrade(db, proposal, loadRiskConfig(db))
      persistRiskEvent(db, proposal, riskResult)

      if (!riskResult.approved) {
        return res.json({ ok: false, vetoed: true, reason: riskResult.veto_reason, checks: riskResult.checks })
      }

      const volLots = riskResult.adjusted_volume
      // Per-symbol volume (lotSize varies by asset class) — the hardcoded
      // 10000/lot constant caused TRADING_BAD_VOLUME on every order.
      const metaHost = (getState(db, 'ctrader_is_live') === 'true') ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
      const volMeta = await getVolumeMeta(metaHost, clientId, clientSecret, accessToken, accountId, symbolId)
      const sized = lotsToVolume(volLots, volMeta)
      if (sized.belowMin) {
        const reason = `below_min_volume: ${volLots} lots < broker minimum (${volMeta.minVolume / volMeta.lotSize} lots)`
        persistRiskEvent(db, proposal, { approved: false, veto_reason: reason })
        return res.json({ ok: false, vetoed: true, reason })
      }
      const volume = sized.volume
      const slDistance = sl && entry ? Math.abs(entry - sl) : null
      const tpDistance = tp1 && entry ? Math.abs(tp1 - entry) : null

      const sessionNow = getActiveSessions()[0]?.label || 'Off'
      const regimeRow = db.prepare('SELECT regime FROM regimes WHERE symbol = ? ORDER BY computed_at DESC LIMIT 1').get(analysis.symbol)
      const structuredLabel = encodeLabel({
        source: 'autopilot',
        version: LABEL_VERSION,
        strategy: analysis.strategy || 'other',
        conviction: convictionBucket(analysis.overall_conviction),
        session: sessionNow,
        regime: regimeRow?.regime || null,
      })

      const orderPayload = {
        ctidTraderAccountId: parseInt(accountId),
        symbolId: parseInt(symbolId),
        orderType: 'MARKET',
        tradeSide: side,
        volume,
        comment: 'abot-manual',
        label: structuredLabel,
        // Snapped to the symbol's digits — finer precision is rejected by
        // the broker (INVALID_REQUEST on 2-3 digit symbols like BTCUSD).
        ...(slDistance ? { relativeStopLoss: relativePoints(slDistance, volMeta.digits) } : {}),
        ...(tpDistance ? { relativeTakeProfit: relativePoints(tpDistance, volMeta.digits) } : {}),
      }

      const host = isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
      const exec = await wsPlaceOrder(host, clientId, clientSecret, accessToken, accountId, orderPayload)
      setState(db, 'api_ctrader_last_ok', new Date().toISOString())

      const executionPrice = exec?.deal?.executionPrice || exec?.position?.price || null
      const positionId = exec?.position?.positionId || exec?.deal?.positionId || null

      const entryP = executionPrice ?? entry
      const initialRisk = (entryP && sl) ? Math.abs(entryP - sl) : null
      let timeCap = null
      if (synth.time_cap_minutes && Number.isFinite(synth.time_cap_minutes)) {
        timeCap = new Date(Date.now() + synth.time_cap_minutes * 60_000).toISOString()
      }

      const parsedLabel = parseLabel(structuredLabel)
      db.transaction(() => {
        const tradeInsert = db.prepare(`
          INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume, opened_at,
            ctrader_position_id, label_raw, label_strategy, label_conviction, label_session, source, status)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, 'manual', 'open')
        `).run(analysis.symbol, side, entryP, sl, tp1, volLots, positionId, structuredLabel,
          parsedLabel?.strategy, parsedLabel?.conviction, parsedLabel?.session)
        const tradeId = tradeInsert.lastInsertRowid

        db.prepare(`
          INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp,
            thesis, initial_risk, invalidation_trigger, time_cap_at, strategy, source, label_raw, account_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, 'active')
        `).run(analysis.symbol, tradeId, side, entryP, sl, tp1,
          analysis.consensus_summary || '', initialRisk,
          synth.invalidation_trigger || analysis.invalidation_trigger || null,
          timeCap, analysis.strategy, structuredLabel,
          accountId != null ? String(accountId) : null)
      })()

      console.log(`[actions] Manual trade executed: ${side} ${analysis.symbol} vol=${volLots} @ ${executionPrice || 'mkt'}`)
      res.json({ ok: true, side, symbol: analysis.symbol, volume: volLots, executionPrice, positionId })
    } catch (err) {
      console.error('[actions/execute-trade] error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/manual-order — place a trader-entered market order from
  // the UI. Body: { symbol, side: 'BUY'|'SELL', lots?, sl, tp? }
  // Entry is estimated from the latest 1m close; the FULL risk gate runs
  // before anything reaches the broker (same as autopilot trades).
  // -----------------------------------------------------------------------
  router.post('/manual-order', async (req, res) => {
    try {
      const { symbol: rawSymbol, side: rawSide, lots, sl, tp } = req.body || {}
      const symbol = (rawSymbol || '').toUpperCase().trim()
      const side = String(rawSide || '').toUpperCase()
      if (!symbol) return res.status(400).json({ error: 'symbol required' })
      if (side !== 'BUY' && side !== 'SELL') return res.status(400).json({ error: "side must be 'BUY' or 'SELL'" })
      if (sl == null || !Number.isFinite(Number(sl))) return res.status(400).json({ error: 'sl (stop-loss price) required — no manual orders without a stop' })

      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader credentials not configured' })
      const symbolId = (await ensureSymbolMap(db, creds))[symbol]
      if (!symbolId) return res.status(400).json({ error: `Symbol ID unknown for ${symbol} — not offered by this broker account` })

      // Entry estimate = freshest 1m close (includes the forming bar — this
      // is a price estimate for the risk gate, the order itself is MARKET).
      const barsByTf = await wsGetTrendbarsBatch(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId, ['1m'], 3)
      const m1 = barsByTf['1m'] || []
      const entry = m1.length > 0 ? m1[m1.length - 1].c : null
      if (entry == null) return res.status(502).json({ error: `Could not fetch a current price for ${symbol}` })

      const proposal = {
        symbol, side, entry,
        sl: Number(sl),
        tp1: tp != null && Number.isFinite(Number(tp)) ? Number(tp) : null,
        requestedVolume: Number(lots) > 0 ? Number(lots) : 0.01,
        strategy: 'manual',
        conviction: null,
        source: 'manual',
      }
      const riskResult = evaluateTrade(db, proposal, loadRiskConfig(db))
      persistRiskEvent(db, proposal, riskResult)
      if (!riskResult.approved) {
        return res.json({ ok: false, vetoed: true, reason: riskResult.veto_reason, checks: riskResult.checks })
      }

      const volLots = riskResult.adjusted_volume
      const volMeta = await getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)
      const sized = lotsToVolume(volLots, volMeta)
      if (sized.belowMin) {
        const reason = `below_min_volume: ${volLots} lots < broker minimum (${volMeta.minVolume / volMeta.lotSize} lots)`
        persistRiskEvent(db, proposal, { approved: false, veto_reason: reason })
        return res.json({ ok: false, vetoed: true, reason })
      }
      const slDistance = Math.abs(entry - proposal.sl)
      const tpDistance = proposal.tp1 != null ? Math.abs(proposal.tp1 - entry) : null

      const sessionNow = getActiveSessions()[0]?.label || 'Off'
      const structuredLabel = encodeLabel({
        source: 'manual', version: LABEL_VERSION, strategy: 'manual',
        conviction: null, session: sessionNow,
      })
      const orderPayload = {
        ctidTraderAccountId: parseInt(creds.accountId),
        symbolId: parseInt(symbolId),
        orderType: 'MARKET',
        tradeSide: side,
        volume: sized.volume,
        comment: 'abot-manual-ui',
        label: structuredLabel,
        // Snapped to the symbol's digits — finer precision is rejected by
        // the broker (INVALID_REQUEST on 2-3 digit symbols like BTCUSD).
        relativeStopLoss: relativePoints(slDistance, volMeta.digits),
        ...(tpDistance ? { relativeTakeProfit: relativePoints(tpDistance, volMeta.digits) } : {}),
      }

      const exec = await wsPlaceOrder(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, orderPayload)
      setState(db, 'api_ctrader_last_ok', new Date().toISOString())
      const executionPrice = exec?.deal?.executionPrice || exec?.position?.price || null
      const positionId = exec?.position?.positionId || exec?.deal?.positionId || null
      const entryP = executionPrice ?? entry
      const parsedLabel = parseLabel(structuredLabel)

      db.transaction(() => {
        const tradeInsert = db.prepare(`
          INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume, opened_at,
            ctrader_position_id, label_raw, label_strategy, label_conviction, label_session, source, status)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, 'manual', 'open')
        `).run(symbol, side, entryP, proposal.sl, proposal.tp1, volLots, positionId, structuredLabel,
          parsedLabel?.strategy, parsedLabel?.conviction, parsedLabel?.session)
        db.prepare(`
          INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp,
            thesis, initial_risk, strategy, source, label_raw, account_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'manual', ?, ?, 'active')
        `).run(symbol, tradeInsert.lastInsertRowid, side, entryP, proposal.sl, proposal.tp1,
          'Manual order via UI', Math.abs(entryP - proposal.sl), structuredLabel,
          creds.accountId != null ? String(creds.accountId) : null)
      })()

      console.log(`[actions] Manual UI order: ${side} ${symbol} vol=${volLots} @ ${executionPrice || 'mkt'}`)
      res.json({ ok: true, side, symbol, volume: volLots, executionPrice, positionId })
    } catch (err) {
      console.error('[actions/manual-order] error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/dismiss-analysis — remove a planned analysis
  // Body: { analysisId: number }
  // -----------------------------------------------------------------------
  router.post('/dismiss-analysis', (req, res) => {
    try {
      const { analysisId } = req.body || {}
      if (!analysisId) return res.status(400).json({ error: 'Missing analysisId' })
      const result = db.prepare('DELETE FROM analyses WHERE id = ?').run(analysisId)
      if (result.changes === 0) return res.status(404).json({ error: 'Analysis not found' })
      console.log(`[actions] Analysis ${analysisId} dismissed`)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
