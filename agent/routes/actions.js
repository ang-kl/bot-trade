// ---------------------------------------------------------------------------
// agent/routes/actions.js — POST endpoints for manual triggers
// ---------------------------------------------------------------------------

import { Router } from 'express'
import { getState, setState, sweepMonitoredPositionsForAccounts, accountsWithOpenPositions } from '../db.js'
import { runFibScan, synthesizeFibSignal, scanSymbolFib } from '../services/fib-strategy.js'
import { getCtraderCreds, getSymbolMap, ensureSymbolMap } from '../lib/ctrader-creds.js'
import { ctraderEnv } from '../lib/ctrader-env.js'
import { normPosId } from '../lib/pos-id.js'
import { DEFAULT_RISK_CONFIG, loadRiskConfig, evaluateTrade, persistRiskEvent } from '../services/risk.js'
import { noteRiskConfigChanges } from '../services/risk-config-history.js'
import { wsGetTrendbarsBatch, wsGetSpotOnce } from '../lib/ctrader-ws.js'
import { getActiveSessions, isSymbolMarketOpen } from '../lib/sessions.js'
import { encodeLabel, parseLabel, convictionBucket, LABEL_VERSION } from '../lib/trade-labels.js'
import { parseTimeframe } from '../lib/timeframes.js'
import { getVolumeMeta, lotsToVolume, relativePoints } from '../lib/lot-sizing.js'
import { describeBracketGap } from '../lib/bracket-advice.js'
import { setPhaseFlag } from '../services/phase-audit.js'
import { amendPosition as execAmendPosition, closePosition as execClosePosition, placeOrder as execPlaceOrder, reconcile as execReconcile, validateExecGuard, execBaseFor } from '../lib/exec-engine.js'
import { STRATEGY_REGISTRY, STRATEGY_KEYS, enabledStrategies } from '../services/strategies.js'
import { invalidateStateCache } from '../lib/state-cache.js'
import { setStage, accountStageTallies } from '../services/stage-matrix.js'
import { loadManualGuards, checkAddCap, inheritedBracket, mirroredBracket, isDuplicateCall } from '../services/manual-position-guards.js'
import { loadPerformanceBreakerConfig } from '../services/performance-breaker.js'
import { loadSessionOpenGuardConfig } from '../services/session-open-guard.js'
import { loadCorrelationMatrixConfig } from '../services/correlation-matrix.js'
import { setAssetController } from '../services/asset-controllers.js'
import { recordPositionEvent } from '../services/position-events.js'
import { clearErrorLog } from '../services/error-log.js'

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

  // Every successful write makes the /state/* read cache stale. Without this
  // the UI saves, re-reads, and paints the PRE-SAVE answer back over the new
  // one for up to STATE_CACHE_MS — measured directly against the agent on
  // 2026-07-29 (POST, then three GETs, all three superseded). Bumped on
  // `finish` so it happens after the handler's own writes, and only for a
  // 2xx/3xx: a rejected request changed nothing and must not throw away a
  // cache the whole dashboard is reading from.
  //
  // Declared AFTER `router` on purpose: the first draft put this block above
  // the `const`, which is a temporal dead zone — the same failure that blanked
  // every page on 2026-07-29 (#489). Lint and tests did not see that one
  // either; booting the agent did.
  router.use((req, res, next) => {
    if (req.method === 'GET') return next()
    res.on('finish', () => { if (res.statusCode < 400) invalidateStateCache() })
    next()
  })

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
      // D5 — run the volatility gate inside the backtest. OFF by default, so
      // every existing caller and every stored backtest_runs row keeps meaning
      // exactly what it meant. `volGate: 'compare'` runs BOTH over the SAME
      // bars and returns the pair: two separate requests could straddle a new
      // bar, and the whole difference would be the bar rather than the gate.
      const volGateReq = req.body?.volGate
      const volGate = volGateReq === 'compare' ? 'compare' : (volGateReq === true || volGateReq === 'on')
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
            const closed = bars.slice(0, -1)
            if (volGate === 'compare') {
              // Both sides walk the IDENTICAL series. Reported as a pair with
              // the gate's own counters, so a null result reads as "the gate
              // never reached HIGH volatility here" rather than "no effect".
              const { compareOnOff } = await import('../scripts/backtest-vol-gate.js')
              results[tf] = { ...compareOnOff(closed, btOpts), barsUsed: closed.length, volGateMode: 'compare' }
              continue
            }
            const { stats } = runBacktest(closed, { ...btOpts, volGate })
            // Walk-forward: same rule over 4 sequential segments — evidence
            // that the edge repeats, not one lucky window.
            const wf = walkForward(closed, { ...btOpts, volGate }, 4)
            results[tf] = {
              ...stats,
              barsUsed: closed.length,
              volGateMode: volGate ? 'on' : 'off',
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
      // Durable per-symbol history (owner 2026-07-28) — the HTML report dies
      // with the container disk; these rows survive redeploys and power the
      // watchlist page's backtest-history view. Errors are recorded too, so
      // "this symbol keeps failing to fetch" is visible history, not silence.
      try {
        // A5: stamp the account the run was made under. A backtest is a fact
        // about the MARKET, so this is provenance rather than ownership — the
        // watchlist-summary read deliberately still counts a symbol's run
        // whoever produced it. What the column buys is "which account's
        // session produced this history", which is the owner's "historical
        // data per workspace" ask.
        const btAcct = (() => {
          try { return req.body?.accountId != null ? String(req.body.accountId) : (getState(db, 'ctrader_account_id') || null) } catch { return null }
        })()
        const ins = db.prepare(
          `INSERT INTO backtest_runs (ran_at, strategy, entry_mode, bars, symbol, timeframe,
             trades, losses, win_rate_pct, profit_factor, total_profit_pct, wf_positive, wf_active, error, account_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        for (const [symName, data] of Object.entries(symbols)) {
          if (data.error) { ins.run(payload.ranAt, strategy, entryMode, count, symName, '-', null, null, null, null, null, null, null, String(data.error).slice(0, 300), btAcct); continue }
          for (const [tf, r] of Object.entries(data.results || {})) {
            // profitFactor is NULL when grossLoss is 0 — the losses column
            // (0 with trades > 0) is what lets the UI render that as ∞
            // instead of a dash (Codex review).
            if (r?.error) ins.run(payload.ranAt, strategy, entryMode, count, symName, tf, null, null, null, null, null, null, null, String(r.error).slice(0, 300), btAcct)
            else ins.run(payload.ranAt, strategy, entryMode, count, symName, tf, r.trades ?? 0, r.losses ?? null, r.winRatePct ?? null, Number.isFinite(r.profitFactor) ? r.profitFactor : null, r.totalProfitPct ?? null, r.wfPositive ?? null, r.wfActive ?? null, null, btAcct)
          }
        }
        db.prepare('DELETE FROM backtest_runs WHERE id NOT IN (SELECT id FROM backtest_runs ORDER BY id DESC LIMIT 2000)').run()
      } catch (err) { console.error('[backtest] history write failed:', err.message) }
      // Post-backtest watchdog pass (owner: "watchdog after backtest") — the
      // same edge watchdog the loop runs, immediately, so a strategy whose
      // LIVE results are clearly negative is disarmed the moment fresh
      // backtest optimism might otherwise leave it armed. Verdict rides in
      // the result payload for the UI to show.
      try {
        const { runEdgeWatchdog } = await import('../services/edge-watchdog.js')
        const wd = runEdgeWatchdog(db, {})
        payload.watchdog = { at: new Date().toISOString(), actions: wd.actions || [], evaluated: wd.evaluated || [], skipped: wd.skipped || null }
      } catch (err) {
        payload.watchdog = { error: err.message }
      }
      return payload
      } // end runWork

      const started = startBacktestJob(
        // volGate rides in the params so a stored/polled job says which mode
        // produced its numbers — an ON result mistaken for an OFF baseline
        // would silently corrupt every later comparison.
        { symbols: names, timeframes, bars: count, strategy, entryMode, volGate: volGate || 'off' },
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
  // POST /actions/import-broker-history — import cTrader's own deal history
  // into broker_deals (owner 2026-07-25: "read historical trades"). Body:
  // { days? } default 30, max 190. Idempotent on the broker's deal_id, so
  // running it twice over the same window refreshes rather than duplicates.
  // Deliberately does NOT write to `trades` — see the table comment in db.js:
  // the performance stats count every closed trades row and filter on
  // nothing, so importing manual/pre-bot fills there would silently move
  // them.
  router.post('/import-broker-history', async (req, res) => {
    try {
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const { host, clientId, clientSecret, accessToken, accountId } = creds
      const [{ importBrokerHistory }, ws] = await Promise.all([
        import('../services/broker-history-import.js'),
        import('../lib/ctrader-ws.js'),
      ])
      const out = await importBrokerHistory(db, {
        days: Number(req.body?.days) || 30,
        deps: {
          accountId,
          getDeals: (t0, t1) => ws.wsGetDeals(host, clientId, clientSecret, accessToken, accountId, t0, t1),
          getSymbolMeta: async (ids) => {
            const meta = {}
            const [byId, light] = await Promise.all([
              ws.wsSymbolsByIds(host, clientId, clientSecret, accessToken, accountId, ids).catch(() => ({})),
              ws.wsGetSymbolsList(host, clientId, clientSecret, accessToken, accountId).catch(() => ({})),
            ])
            for (const sm of (byId.symbol || [])) meta[sm.symbolId] = { ...sm }
            for (const sm of (light.symbol || [])) {
              if (sm.symbolName && ids.includes(sm.symbolId)) meta[sm.symbolId] = { ...(meta[sm.symbolId] || {}), symbolName: sm.symbolName }
            }
            return meta
          },
        },
      })
      res.json({ ok: true, ...out })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

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
  // POST /actions/weekend-loss-flag — { on } toggles the pre-closure LOSS
  // visibility sweep: never closes anything, just flags (action_log +
  // Telegram) any losing position inside the same pre-closure window.
  // -----------------------------------------------------------------------
  router.post('/weekend-loss-flag', (req, res) => {
    const on = req.body?.on !== false
    setState(db, 'weekend_loss_flag', on ? 'true' : 'false')
    console.log(`[actions] weekend loss flag → ${on ? 'ON' : 'off'}`)
    res.json({ ok: true, on })
  })

  // -----------------------------------------------------------------------
  // POST /actions/loss-cap — partial update of loss_cap_json (A1's
  // per-position dollar/percent floating-loss cap). Only provided keys
  // change; null explicitly disables that cap. Validated hard: this layer
  // CLOSES live positions, so a garbage write must never reach it.
  // -----------------------------------------------------------------------
  router.post('/loss-cap', async (req, res) => {
    try {
      const { loadLossCapConfig, LOSS_CAP_KEY } = await import('../services/loss-cap.js')
      const { saveWithOverlay, clearOverlay } = await import('../services/account-overlay.js')
      const b = req.body || {}
      // accountId scopes the write to that account's overlay; absent, the
      // shared config — identical to the behaviour before overlays.
      const acct = b.accountId == null ? null : String(b.accountId)
      if (b.reset === true && acct) {
        const { DEFAULT_LOSS_CAP } = await import('../services/loss-cap.js')
        clearOverlay(db, setState, LOSS_CAP_KEY, acct)
        console.log(`[actions] loss cap: overlay cleared for account ${acct}`)
        return res.json({ ok: true, lossCap: loadLossCapConfig(db, acct), accountId: acct, defaults: DEFAULT_LOSS_CAP })
      }
      const cur = loadLossCapConfig(db, acct)
      const num = (v, name, max) => {
        if (v === null) return null
        const n = Number(v)
        if (!Number.isFinite(n) || n <= 0 || (max && n > max)) throw new Error(`${name} must be a positive number${max ? ` ≤ ${max}` : ''} or null`)
        return n
      }
      const next = {
        ...cur,
        ...(b.on !== undefined ? { on: b.on !== false } : {}),
        ...(b.maxLossUsd !== undefined ? { maxLossUsd: num(b.maxLossUsd, 'maxLossUsd') } : {}),
        ...(b.maxLossPctOfBalance !== undefined ? { maxLossPctOfBalance: num(b.maxLossPctOfBalance, 'maxLossPctOfBalance', 50) } : {}),
        ...(b.scope !== undefined ? { scope: b.scope === 'bot' ? 'bot' : 'all' } : {}),
        ...(b.action !== undefined ? { action: b.action === 'alert' ? 'alert' : 'close' } : {}),
        ...(b.retryMinutes !== undefined ? { retryMinutes: num(b.retryMinutes, 'retryMinutes', 1440) } : {}),
      }
      // Only the fields this request actually named enter the store, so an
      // account overlay stays partial and a shared change still reaches the
      // fields it never pinned.
      const patch = {}
      for (const k of Object.keys(next)) if (b[k] !== undefined) patch[k] = next[k]
      const saved = saveWithOverlay(db, setState, {
        defaults: cur, baseKey: LOSS_CAP_KEY, accountId: acct, patch,
      })
      console.log(`[actions] loss cap${acct ? ` (account ${acct})` : ''} → ${saved.next.on ? 'ON' : 'off'} $${saved.next.maxLossUsd ?? '—'} / ${saved.next.maxLossPctOfBalance ?? '—'}% scope=${saved.next.scope} action=${saved.next.action}`)
      res.json({ ok: true, lossCap: saved.next, accountId: acct, overlayKeys: saved.overlayKeys })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/profit-ratchet — partial update of profit_ratchet_json
  // (A4's equity high-water staircase), plus { resetState: true } to
  // re-baseline the staircase at current equity (e.g. after a deposit).
  // -----------------------------------------------------------------------
  router.post('/profit-ratchet', async (req, res) => {
    try {
      const { loadProfitRatchetConfig, PROFIT_RATCHET_KEY } = await import('../services/profit-ratchet.js')
      const { saveWithOverlay, clearOverlay } = await import('../services/account-overlay.js')
      const b = req.body || {}
      // accountId scopes to that account's overlay. resetState (the staircase
      // wipe) stays GLOBAL on purpose — it is about stored state, not config,
      // and its per-account gesture is /actions/ratchet-account.
      const ratchetAcct = b.accountId == null ? null : String(b.accountId)
      if (b.clearOverlay === true && ratchetAcct) {
        clearOverlay(db, setState, PROFIT_RATCHET_KEY, ratchetAcct)
        console.log(`[actions] profit ratchet: overlay cleared for account ${ratchetAcct}`)
        return res.json({ ok: true, profitRatchet: loadProfitRatchetConfig(db, ratchetAcct), accountId: ratchetAcct })
      }
      const cur = loadProfitRatchetConfig(db, ratchetAcct)
      let stepUsd = cur.stepUsd
      if (b.stepUsd !== undefined) {
        if (b.stepUsd === null) stepUsd = null
        else {
          const n = Number(b.stepUsd)
          if (!Number.isFinite(n) || n < 5 || n > 100000) return res.status(400).json({ error: 'stepUsd must be $5-$100,000 or null (auto: 1% of balance, $25-$500)' })
          stepUsd = n
        }
      }
      const next = {
        ...cur,
        ...(b.on !== undefined ? { on: b.on !== false } : {}),
        stepUsd,
        ...(b.floorAction !== undefined ? { floorAction: b.floorAction === 'halt' ? 'halt' : 'flatten' } : {}),
      }
      // Partial write: only the fields this request named enter the store, so
      // an account overlay stays partial and shared changes still reach the
      // fields it never pinned.
      const rPatch = {}
      for (const k of Object.keys(next)) if (b[k] !== undefined) rPatch[k] = next[k]
      saveWithOverlay(db, setState, {
        defaults: cur, baseKey: PROFIT_RATCHET_KEY, accountId: ratchetAcct, patch: rPatch,
      })
      // SWITCHING THE LAYER OFF CLEARS ITS HOLD (owner 04-08-2026: "I remove
      // the ratchet but still see ratchet on the account I disarmed").
      // The halt is state written by a layer that is now off — it can no
      // longer be re-evaluated, re-armed or explained, so leaving it set means
      // an account stays blocked by a mechanism the owner just disabled and
      // nothing on screen can lift. Turning the ratchet ON never touches these
      // flags; only turning it OFF does, and only for the accounts the switch
      // actually covers.
      if (b.on === false) {
        const { haltKey, softKey } = await import('../services/profit-ratchet.js')
        const targets = ratchetAcct
          ? [ratchetAcct]
          : (() => {
            try { return db.prepare('SELECT account_id FROM accounts').all().map(r => String(r.account_id)) }
            catch { return [] }
          })()
        for (const id of targets) {
          setState(db, haltKey(id), 'false')
          setState(db, softKey(id), 'false')
        }
        if (targets.length) console.log(`[actions] profit ratchet off → cleared hold on ${targets.length} account(s)`)
      }
      if (b.resetState === true) {
        setState(db, 'profit_ratchet_state_json', 'null') // v1 legacy key
        // v2: every account's staircase re-baselines on its next pass, and
        // any ratchet hold is released — a reset is the owner saying "start
        // the ladder over from here".
        try {
          for (const r of db.prepare('SELECT account_id FROM accounts').all()) {
            setState(db, `acct:${r.account_id}:profit_ratchet_state_json`, 'null')
            setState(db, `acct:${r.account_id}:ratchet_halt`, 'false')
            setState(db, `acct:${r.account_id}:ratchet_soft`, 'false')
          }
        } catch { /* registry absent — nothing per-account to reset */ }
      }
      console.log(`[actions] profit ratchet${ratchetAcct ? ` (account ${ratchetAcct})` : ''} → ${next.on ? 'ON' : 'off'} step=${next.stepUsd ?? 'auto'} floorAction=${next.floorAction}${b.resetState ? ' (staircase reset)' : ''}`)
      res.json({ ok: true, profitRatchet: next, stateReset: b.resetState === true, accountId: ratchetAcct })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/ratchet-account — ONE account's ratchet hold.
  //
  // Body: { accountId, action: 'rearm' | 'keepoff' | 'rebaseline' }
  //   rearm      clear the halt and the entry pause; keep the staircase
  //   keepoff    stay halted and stop the auto re-arm watching
  //   rebaseline clear the halt AND restart the staircase from current equity
  //
  // Until now the ONLY way to clear one account's halt was the Telegram
  // [Re-arm] button (telegram-control.js). The one HTTP path that touched a
  // halt was POST /actions/profit-ratchet with { resetState: true }, which
  // walks the whole registry and clears EVERY account's staircase and hold —
  // so "unblock 5203012" meant also silently discarding the other account's
  // banked floor. A per-account gesture needs a per-account route.
  //
  // This is a money-moving route by consequence, not by mechanism: it does not
  // place an order, but clearing a halt is what lets entries resume. It sits
  // behind the same write-tier auth as every other /actions route, and it
  // never touches the S.A.T. switches — the ratchet never does, post-01-08.
  // -----------------------------------------------------------------------
  router.post('/ratchet-account', async (req, res) => {
    try {
      const b = req.body || {}
      const accountId = b.accountId != null ? String(b.accountId) : ''
      if (!accountId) return res.status(400).json({ error: 'accountId is required' })
      const action = String(b.action || 'rearm').toLowerCase()
      if (!['rearm', 'keepoff', 'rebaseline'].includes(action)) {
        return res.status(400).json({ error: "action must be 'rearm', 'keepoff' or 'rebaseline'" })
      }
      // A typo'd id would otherwise write hold keys nothing ever reads, and
      // report success — the same failure /actions/account-phases guards.
      try {
        const row = db.prepare('SELECT account_id FROM accounts WHERE account_id = ?').get(accountId)
        if (!row) return res.status(404).json({ error: `unknown account ${accountId}` })
      } catch { /* registry absent (old single-account boxes) — proceed */ }

      const pr = await import('../services/profit-ratchet.js')
      const before = pr.ratchetGate(db, accountId)
      if (action === 'rearm') pr.rearmRatchet(db, accountId)
      else if (action === 'keepoff') pr.keepRatchetOff(db, accountId)
      else pr.rebaselineRatchet(db, accountId)
      const after = pr.ratchetGate(db, accountId)

      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('POST', '/actions/ratchet-account', JSON.stringify({ accountId, action }))
      } catch { /* audit best-effort */ }
      console.log(`[actions] ratchet ${action} on ${accountId}: blocked ${before.blocked} (${before.stage ?? 'none'}) → ${after.blocked} (${after.stage ?? 'none'})`)
      res.json({
        ok: true, accountId, action,
        before, after,
        state: pr.loadRatchetState(db, accountId),
      })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/loss-guardian — partial update of loss_guardian_json.
  // maxAtrMult / fallbackAdversePct existed as config keys with NO route or
  // UI (calibration audit, A2) — the protective-stop distance was
  // effectively hardcoded in production.
  // -----------------------------------------------------------------------
  router.post('/loss-guardian', async (req, res) => {
    try {
      const { loadLossGuardianConfig, LOSS_GUARDIAN_KEY } = await import('../services/loss-guardian.js')
      const { saveWithOverlay: saveG, clearOverlay: clearG } = await import('../services/account-overlay.js')
      const gAcct = req.body?.accountId == null ? null : String(req.body.accountId)
      if (req.body?.clearOverlay === true && gAcct) {
        clearG(db, setState, LOSS_GUARDIAN_KEY, gAcct)
        console.log(`[actions] loss guardian: overlay cleared for account ${gAcct}`)
        return res.json({ ok: true, lossGuardian: loadLossGuardianConfig(db, gAcct), accountId: gAcct })
      }
      const cur = loadLossGuardianConfig(db, gAcct)
      const b = req.body || {}
      const num = (v, name, min, max) => {
        if (v === null) return null
        const n = Number(v)
        if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be ${min}-${max} or null`)
        return n
      }
      const next = {
        ...cur,
        ...(b.on !== undefined ? { on: b.on !== false } : {}),
        ...(b.scope !== undefined ? { scope: b.scope === 'external' ? 'external' : 'all' } : {}),
        ...(b.maxAtrMult !== undefined ? { maxAtrMult: num(b.maxAtrMult, 'maxAtrMult', 0.5, 10) ?? cur.maxAtrMult } : {}),
        ...(b.fallbackAdversePct !== undefined ? { fallbackAdversePct: num(b.fallbackAdversePct, 'fallbackAdversePct', 0.001, 0.2) ?? cur.fallbackAdversePct } : {}),
        ...(b.maxHoldHours !== undefined ? { maxHoldHours: num(b.maxHoldHours, 'maxHoldHours', 1, 720) } : {}),
      }
      const gPatch = {}
      for (const k of Object.keys(next)) if (req.body?.[k] !== undefined) gPatch[k] = next[k]
      saveG(db, setState, { defaults: cur, baseKey: LOSS_GUARDIAN_KEY, accountId: gAcct, patch: gPatch })
      console.log(`[actions] loss guardian → ${next.on ? 'ON' : 'off'} scope=${next.scope} atr=${next.maxAtrMult} fallback=${next.fallbackAdversePct} timeCap=${next.maxHoldHours ?? 'off'}`)
      // `config` mirrors GET /state/loss-guardian — Tune's Toggle reads
      // r.config, and the old `lossGuardian`-only reply made a successful arm
      // LOOK like it snapped back to OFF (owner report 2026-08-02). Both keys
      // stay so no caller breaks.
      res.json({ ok: true, config: next, lossGuardian: next, accountId: gAcct })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
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
  // POST /actions/vpo-settings — { enabled, config } turns the VPO feeder
  // (agent/services/vpo-feeder.js) on/off and sets which symbol/strategy
  // pairs it fetches bars + sizing for. This is agent_state (a DB write),
  // NOT the same thing as the cpp-exec sidecar's VPO_ENABLED/VPO_SYMBOLS
  // env vars — those are a separate service and control whether the
  // dispatcher itself arms/fires. Both need to be set, and `config` here
  // must name the SAME symbol/symbolId/key triples as the sidecar's
  // VPO_SYMBOLS, or the feeder pushes bars/volume the dispatcher has no
  // registered strategy to receive (owner hit this: set VPO_CONFIG_JSON as
  // a Railway env var, which this code never reads — it's DB state, set
  // here, not an env var).
  // -----------------------------------------------------------------------
  router.post('/vpo-settings', (req, res) => {
    const { enabled, config } = req.body || {}
    if (enabled !== undefined) {
      setState(db, 'vpo_enabled', enabled ? 'true' : 'false')
    }
    if (config !== undefined) {
      if (!Array.isArray(config)) {
        return res.status(400).json({ error: 'config must be an array of { key, symbol, symbolId, macroTf?, microTf? }' })
      }
      for (const entry of config) {
        if (!entry?.key || !entry?.symbol || !entry?.symbolId) {
          return res.status(400).json({ error: 'each config entry needs key, symbol, and symbolId' })
        }
      }
      setState(db, 'vpo_config_json', JSON.stringify(config))
    }
    const nowEnabled = (getState(db, 'vpo_enabled') || 'false') === 'true'
    let nowConfig = []
    try { nowConfig = JSON.parse(getState(db, 'vpo_config_json') || '[]') } catch { /* leave [] */ }
    console.log(`[actions] vpo settings → enabled=${nowEnabled} entries=${nowConfig.length}`)
    res.json({ ok: true, enabled: nowEnabled, config: nowConfig })
  })

  router.get('/vpo-settings', (_req, res) => {
    const enabled = (getState(db, 'vpo_enabled') || 'false') === 'true'
    let config = []
    try { config = JSON.parse(getState(db, 'vpo_config_json') || '[]') } catch { /* leave [] */ }
    res.json({ ok: true, enabled, config })
  })

  // -----------------------------------------------------------------------
  // GET/POST /actions/early-trim-settings — the switch T2's shadow shipped
  // without.
  //
  // #685 added early-trim as a log-only shadow reading `early_trim_json`, and
  // nothing anywhere WRITES that key: no route, no UI, no seed. The feature
  // was therefore unreachable — permanently off, with a full test suite
  // asserting how correctly it stays that way. A shadow nobody can start is
  // not a cautious shadow, it is a dead one, and the caution reads as working
  // software until somebody goes looking for the rows.
  //
  // Body: { enabled?: bool, atR?: number, frac?: number,
  //         moveSlToBreakeven?: bool }. Everything is validated by
  // earlyTrimConfig(), which silently repairs nonsense to defaults and forces
  // mode to 'log' — so the response echoes the EFFECTIVE config rather than
  // what was sent, and a rejected value is visible instead of assumed.
  //
  // Still log-only. There is no act path in early-trim.js to switch on.
  // -----------------------------------------------------------------------
  router.get('/early-trim-settings', async (_req, res) => {
    try {
      const { earlyTrimConfig } = await import('../services/early-trim.js')
      const { loadProfitKeeperConfig } = await import('../services/profit-keeper.js')
      let raw = null
      try { raw = JSON.parse(getState(db, 'early_trim_json') || 'null') } catch { raw = null }
      const cfg = earlyTrimConfig(raw)
      res.json({
        ok: true, effective: cfg,
        // The shadow runs inside the profit keeper's sweep and returns early
        // when the keeper is off (profit-keeper.js:258). Reporting
        // enabled:true while the keeper is off would describe a feature that
        // never runs, which is the same lie in a smaller box.
        profitKeeperOn: loadProfitKeeperConfig(db).on === true,
        writes: 'action_log rows, kind=early_trim_shadow, applied:false — decisions only, nothing is traded',
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  router.post('/early-trim-settings', async (req, res) => {
    try {
      const { earlyTrimConfig, DEFAULT_EARLY_TRIM } = await import('../services/early-trim.js')
      const { loadProfitKeeperConfig } = await import('../services/profit-keeper.js')
      const body = req.body || {}
      let current = null
      try { current = JSON.parse(getState(db, 'early_trim_json') || 'null') } catch { current = null }
      const merged = { ...DEFAULT_EARLY_TRIM, ...(current || {}) }
      for (const k of ['enabled', 'atR', 'frac', 'moveSlToBreakeven']) {
        if (k in body) merged[k] = body[k]
      }
      const cfg = earlyTrimConfig(merged)
      setState(db, 'early_trim_json', JSON.stringify(cfg))
      const keeperOn = loadProfitKeeperConfig(db).on === true
      console.log(`[actions] early-trim shadow → enabled=${cfg.enabled} atR=${cfg.atR} frac=${cfg.frac} keeperOn=${keeperOn}`)
      res.json({
        ok: true, effective: cfg, profitKeeperOn: keeperOn,
        // Turning the shadow on while the keeper is off produces no rows and
        // no error. Say so at the moment of the write, not in a week when the
        // record turns out to be empty.
        warning: cfg.enabled && !keeperOn
          ? 'the shadow is enabled but the Profit Keeper is OFF — the sweep it runs inside returns early, so NO rows will be written'
          : null,
      })
    } catch (err) {
      console.error('[actions/early-trim-settings] error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/exec-guard — { halt?, requireBracket?, requireTarget?,
  // maxOrderVolume? } stores the C++ sidecar's atomic order-guard knobs and
  // pushes them to the sidecar (best-effort — in js exec mode there is no
  // sidecar and the stored values simply wait until one exists). These were
  // previously settable ONLY by hand-calling the sidecar's own /config —
  // no UI, no persistence across sidecar restarts.
  // -----------------------------------------------------------------------
  router.post('/exec-guard', async (req, res) => {
    try {
      const body = req.body || {}
      let stored = {}
      try { stored = JSON.parse(getState(db, 'exec_guard_json') || '{}') } catch { /* fresh */ }
      for (const k of ['halt', 'requireBracket', 'requireTarget']) {
        if (typeof body[k] === 'boolean') stored[k] = body[k]
      }
      if (body.maxOrderVolume !== undefined) {
        const v = Number(body.maxOrderVolume)
        if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'maxOrderVolume must be a non-negative number' })
        stored.maxOrderVolume = v
      }
      setState(db, 'exec_guard_json', JSON.stringify(stored))
      let pushed = null
      try {
        const { setExecGuard } = await import('../lib/exec-engine.js')
        pushed = await setExecGuard(getCtraderCreds(db), stored)
      } catch (err) { pushed = { error: err.message } }
      console.log('[actions] exec guard updated:', stored)
      res.json({ ok: true, guard: stored, pushed })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/global-guards — { halt?, portfolioDailyLossUsd?,
  // maxTotalOpenPositions? } sets the 5A portfolio-wide capital-protection
  // knobs (evaluated across ALL accounts inside the risk gate). null/0
  // clears a numeric knob back to off. All knobs default off.
  // -----------------------------------------------------------------------
  router.post('/global-guards', (req, res) => {
    try {
      const body = req.body || {}
      let stored = {}
      try { stored = JSON.parse(getState(db, 'global_guards_json') || '{}') } catch { /* fresh */ }
      if (typeof body.halt === 'boolean') stored.halt = body.halt
      for (const k of ['portfolioDailyLossUsd', 'maxTotalOpenPositions']) {
        if (body[k] !== undefined) {
          if (body[k] === null || Number(body[k]) === 0) { stored[k] = null; continue }
          const v = Number(body[k])
          if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: `${k} must be a non-negative number or null` })
          stored[k] = v
        }
      }
      setState(db, 'global_guards_json', JSON.stringify(stored))
      console.log('[actions] global guards updated:', stored)
      res.json({ ok: true, guards: stored })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
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
  // POST /actions/llm-switch — { enabled: false } stops the bot ATTEMPTING
  // any model call. Owner 09-08-2026: "runs 24/7 without credit from AI".
  //
  // Not a budget and not a cap: those describe money, this describes whether
  // the capability is on at all. With it off the position monitor and weekend
  // watch are skipped before the call, so an exhausted balance stops producing
  // ~1,900 failures a day, a Telegram streak alert and a permanently stale
  // Anthropic health stamp. Trading is untouched — every entry, risk check,
  // sizing decision and stop/target adjustment is deterministic, and the
  // broker holds the SL/TP regardless.
  //
  // The env var LLM_DISABLED outranks this key and cannot be released from
  // here; that is the durable brake, this is the fast one.
  // -----------------------------------------------------------------------
  router.post('/llm-switch', async (req, res) => {
    const raw = req.body?.enabled
    if (typeof raw !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be true or false' })
    }
    setState(db, 'llm_disabled', raw ? null : '1')
    console.log(`[actions] LLM layer ${raw ? 'ENABLED' : 'DISABLED'} by owner`)
    // Report the EFFECTIVE state, which is not the same as what was just
    // written: LLM_DISABLED in the environment still wins.
    const { llmDisabled, llmDisabledReason } = await import('../lib/llm-switch.js')
    res.json({
      ok: true,
      requested: raw,
      effectiveEnabled: !llmDisabled(db, getState),
      disabledBy: llmDisabledReason(db, getState),
    })
  })

  // -----------------------------------------------------------------------
  // POST /actions/llm-spend-cap — { dailyCapUsd } a REAL ceiling, not an alert.
  //
  // Owner 09-08-2026, on finding ~$2,314 in 30 days against a "$5 daily cap":
  // /actions/llm-budget arms a Telegram message and stops nothing. This one
  // stops the calls. Off by default (0/null); setting it is the owner choosing
  // to trade position-review coverage for a spend ceiling.
  //
  // It reverses the reasoning at loop.js's token budget ("must not be paused
  // mid-position, so an exceeded budget warns instead of gating") — sound when
  // the only cost was tokens, no longer the whole picture at $3,000/month. What
  // pauses is a SECOND OPINION: entries, the risk gate, sizing and every
  // stop/target adjustment stay deterministic and the broker holds the SL/TP.
  // -----------------------------------------------------------------------
  router.post('/llm-spend-cap', async (req, res) => {
    const raw = req.body?.dailyCapUsd
    const { SPEND_CAP_KEY, spendCapState } = await import('../services/llm-spend.js')
    if (raw == null || raw === '' || Number(raw) === 0) {
      setState(db, SPEND_CAP_KEY, null)
      console.log('[actions] LLM hard spend cap REMOVED')
      return res.json({ ok: true, dailyCapUsd: null, ...spendCapState(db) })
    }
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0.1 || n > 1000) {
      return res.status(400).json({ error: 'dailyCapUsd must be between 0.10 and 1000 (or 0 to remove the cap)' })
    }
    setState(db, SPEND_CAP_KEY, String(n))
    console.log(`[actions] LLM hard spend cap: $${n}/day`)
    res.json({ ok: true, dailyCapUsd: n, ...spendCapState(db) })
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
  // Body: { on: boolean, lots?, maxPerCycle?, targetTrades?, windowDays? }.
  // Sizing is FIXED-ONLY (owner 2026-08-14) — lots 0.01–0.05. A `sizeMode` in
  // the body is accepted and ignored rather than 400'd, so an older client
  // still arms burn-in instead of failing; loadBurnInConfig pins the stored
  // value and the response echoes what actually took effect. Values clamped
  // in loadBurnInConfig.
  // -----------------------------------------------------------------------
  router.post('/burn-in', async (req, res) => {
    try {
      const { loadBurnInConfig } = await import('../services/burn-in.js')
      const current = loadBurnInConfig(db)
      const next = {
        ...current,
        ...(typeof req.body?.on === 'boolean' ? { on: req.body.on } : {}),
        ...(req.body?.lots != null ? { lots: Number(req.body.lots) } : {}),
        ...(req.body?.maxPerCycle != null ? { maxPerCycle: Number(req.body.maxPerCycle) } : {}),
        ...(req.body?.targetTrades != null ? { targetTrades: Number(req.body.targetTrades) } : {}),
        ...(req.body?.windowDays != null ? { windowDays: Number(req.body.windowDays) } : {}),
      }
      // Arming (off → on) starts the pacing clock toward targetTrades.
      if (next.on && !current.on) next.startedAt = new Date().toISOString()
      setState(db, 'burn_in_json', JSON.stringify(next))
      const clamped = loadBurnInConfig(db)
      console.log(`[actions] burn-in ${clamped.on ? 'ARMED' : 'disarmed'} — size=${clamped.lots} (fixed) target=${clamped.targetTrades} in ${clamped.windowDays}d mpc=${clamped.maxPerCycle}`)
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
  // COALESCE + short TTL — same reason as /broker-positions above: this route
  // opens several fresh WS connections per call (wsGetDeals per 7-day chunk,
  // plus symbol/trader/asset lookups), and Desk polls it unconditionally on
  // every tick (as often as every 5s with a position open). Uncoalesced, that
  // adds broker-WS pressure on top of the scan/monitor loop's own connections
  // — one in-flight fetch per `days` window is shared and reused briefly.
  const bhShared = new Map()
  const BH_TTL_MS = 12_000
  router.post('/broker-history', async (req, res) => {
    const days = Math.min(190, Math.max(1, Number(req.body?.days) || 7))
    let slot = bhShared.get(days)
    if (!slot) { slot = { at: 0, promise: null }; bhShared.set(days, slot) }
    if (slot.promise && Date.now() - slot.at < BH_TTL_MS) {
      try { return res.json(await slot.promise) } catch { /* stale failure — fall through to a fresh run */ }
    }
    slot.at = Date.now()
    slot.promise = (async () => {
      const creds = getCtraderCreds(db)
      if (!creds.ready) throw Object.assign(new Error('cTrader not connected'), { httpStatus: 400 })
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
      // CAST both sides — same reason as pnl-backfill.js: rows written before
      // the pos-id repair migration can carry "234698574.0", which plain
      // equality against the broker's "234698574" never matched.
      const upd = db.prepare(
        `UPDATE trades
         SET net_pnl = ?, gross_pnl = ?,
             exit_price = COALESCE(exit_price, ?),
             closed_at = COALESCE(closed_at, ?)
         WHERE CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER) AND status = 'closed'`
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
      return payload
    })()
    try {
      res.json(await slot.promise)
    } catch (err) {
      console.error('[actions/broker-history] error:', err.message)
      res.status(err.httpStatus === 400 ? 400 : 502).json({ error: err.message })
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

  // P2 manual-route bookkeeping. These two routes wrote NOTHING before, so
  // the ledger could not tell that an add or a reverse had ever happened —
  // and the dedup window has nothing to read without a record. action_log is
  // the existing generic sink; a purpose-built table is P10's job.
  const MANUAL_ROUTE_PATH = '/manual-position'
  function logManualCall(db_, route, positionId, detail) {
    try {
      db_.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
        'MANUAL', MANUAL_ROUTE_PATH,
        JSON.stringify({ route, positionId: positionId != null ? String(positionId) : null, at: Date.now(), ...detail }).slice(0, 2000),
      )
    } catch { /* audit best-effort — never blocks the action */ }
  }
  /** The recent manual calls the dedup window reads, newest first. */
  function recentManualCalls(db_, limit = 20) {
    try {
      return db_.prepare(
        `SELECT body FROM action_log WHERE method = 'MANUAL' AND path = ? ORDER BY id DESC LIMIT ?`
      ).all(MANUAL_ROUTE_PATH, limit).map(r => {
        try { return JSON.parse(r.body) } catch { return null }
      }).filter(Boolean).filter(r => r.sending || r.placed || r.reversed)
    } catch { return [] }
  }

  // POST /actions/position-protect — set/replace the broker-native SL and/or
  // TP on ONE position. Body: { positionId, sl?, tp? } (absolute prices).
  router.post('/position-protect', async (req, res) => {
    try {
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const { positionId, sl, tp } = req.body || {}
      if (!positionId) return res.status(400).json({ error: 'positionId is required' })
      // Shared with the Telegram "Set TP" button (services/position-protect.js)
      // so the two entry points cannot drift.
      const { protectPosition } = await import('../services/position-protect.js')
      const out = await protectPosition(db, creds, { positionId, sl, tp, source: 'manual' }, { amend: execAmendPosition })
      res.json(out)
    } catch (err) {
      const code = /required/.test(err.message) ? 400 : 502
      res.status(code).json({ error: err.message })
    }
  })

  // POST /actions/queued-cancel — cancel a BOT-SIDE queued order/signal
  // (owner: "when am I able to close or manage pending order?"). Body:
  // { kind: 'closed_market_limit'|'queued_signal', id }. A closed-market
  // limit that already rests at the broker (order_id set) is cancelled
  // there too, via the same path as order-cancel.
  router.post('/queued-cancel', async (req, res) => {
    try {
      const { kind, id } = req.body || {}
      if (!id || !['closed_market_limit', 'queued_signal'].includes(kind)) {
        return res.status(400).json({ error: "kind ('closed_market_limit'|'queued_signal') and id required" })
      }
      if (kind === 'queued_signal') {
        const r = db.prepare(
          `UPDATE pending_signals SET status='expired', resolved_at=datetime('now'),
             resolution_note='cancelled by owner' WHERE id = ? AND status = 'pending'`
        ).run(id)
        return res.json({ ok: true, cancelled: r.changes > 0 })
      }
      const row = db.prepare(`SELECT * FROM pending_orders WHERE id = ? AND status = 'working'`).get(id)
      if (!row) return res.json({ ok: true, cancelled: false, note: 'already gone' })
      if (row.order_id) {
        const creds = getCtraderCreds(db)
        if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected — cannot cancel the broker leg' })
        const { cancelOrder } = await import('../lib/exec-engine.js')
        await cancelOrder(creds, { orderId: row.order_id })
      }
      db.prepare(`UPDATE pending_orders SET status='cancelled', note = COALESCE(note,'') || ' · cancelled by owner' WHERE id = ?`).run(id)
      res.json({ ok: true, cancelled: true, brokerLeg: !!row.order_id })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // POST /actions/queued-veto — one-tap "kill this AND stop it recurring":
  // cancels the queued row exactly like /queued-cancel, then adds the symbol
  // to risk.blockedSymbols so autopilot can't re-queue/re-arm it (owner: the
  // tiny switch on the queued-orders table's first column — "auto-veto or
  // close"). Idempotent: re-vetoing an already-blocked symbol just no-ops the
  // config half. Body: { kind: 'closed_market_limit'|'queued_signal', id, symbol }.
  router.post('/queued-veto', async (req, res) => {
    try {
      const { kind, id, symbol } = req.body || {}
      if (!id || !['closed_market_limit', 'queued_signal'].includes(kind) || !symbol) {
        return res.status(400).json({ error: "kind ('closed_market_limit'|'queued_signal'), id and symbol required" })
      }
      let cancelled = false
      if (kind === 'queued_signal') {
        const r = db.prepare(
          `UPDATE pending_signals SET status='expired', resolved_at=datetime('now'),
             resolution_note='vetoed by owner' WHERE id = ? AND status = 'pending'`
        ).run(id)
        cancelled = r.changes > 0
      } else {
        const row = db.prepare(`SELECT * FROM pending_orders WHERE id = ? AND status = 'working'`).get(id)
        if (row) {
          if (row.order_id) {
            const creds = getCtraderCreds(db)
            if (creds.ready) {
              const { cancelOrder } = await import('../lib/exec-engine.js')
              try { await cancelOrder(creds, { orderId: row.order_id }) } catch { /* already gone at broker */ }
            }
          }
          db.prepare(`UPDATE pending_orders SET status='cancelled', note = COALESCE(note,'') || ' · vetoed by owner' WHERE id = ?`).run(id)
          cancelled = true
        }
      }
      const current = loadRiskConfig(db)
      const blocked = new Set((Array.isArray(current.blockedSymbols) ? current.blockedSymbols : []).map(s => String(s).toUpperCase()))
      const sym = String(symbol).toUpperCase()
      blocked.add(sym)
      const next = { ...current, blockedSymbols: [...blocked] }
      setState(db, 'risk_config_json', JSON.stringify(next))
      res.json({ ok: true, cancelled, blockedSymbols: next.blockedSymbols })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // POST /actions/postmortem-sweep — on-demand Trade-lessons sweep (owner:
  // "create one PR to sweep the lesson learn"). Runs a BIG batch now instead
  // of waiting for the loop's gradual 6-per-cycle back-fill. Body:
  // { batch?: number } (default 30, max 60 — each trade costs a bar fetch).
  router.post('/postmortem-sweep', async (req, res) => {
    try {
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const batch = Math.min(60, Math.max(1, Number(req.body?.batch) || 30))
      const map = await ensureSymbolMap(db, creds)
      const { runLossPostmortems } = await import('../services/loss-postmortem.js')
      const { wsGetTrendbarsBatch } = await import('../lib/ctrader-ws.js')
      const { host, clientId, clientSecret, accessToken, accountId } = creds
      const fetchBars = async (sym, tf, count, endTimeMs) => {
        const sid = map[String(sym).toUpperCase()]
        if (!sid) throw new Error(`symbolId unknown for ${sym}`)
        const byTf = await wsGetTrendbarsBatch(host, clientId, clientSecret, accessToken, accountId, sid, [tf], count, 20_000, endTimeMs || 0)
        return byTf[tf] || []
      }
      const out = await runLossPostmortems(db, fetchBars, { maxPerCycle: batch })
      // New lessons may change the tuner's evidence — refresh immediately.
      const { refreshLessonTuning } = await import('../services/lessons-tuner.js')
      const factors = refreshLessonTuning(db)
      res.json({ ok: true, ...out, tunerActive: Object.keys(factors) })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // POST /actions/backfill-label-strategy — owner: "every trade must have a
  // purpose for the edge" (edge-health's Manual/external bucket). Recovers
  // label_strategy on autopilot trades whose broker label lost attribution
  // (encoded '-' before a strategy's key existed — see trade-labels.js) by
  // matching the real, strategy-specific thesis text each module wrote at
  // open time. No broker call, no live-DB dependency beyond this process's
  // own DB — safe to run any time; a no-op past the first successful run.
  router.post('/backfill-label-strategy', async (_req, res) => {
    try {
      const { backfillLabelStrategy } = await import('../services/label-backfill.js')
      const out = backfillLabelStrategy(db)
      res.json({ ok: true, ...out })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // POST /actions/screener-search — LLM-interpreted free-text screener search
  // ("AI stocks", "network layer stocks", "P/E > 30", or a chatbot-popup
  // follow-up). Body: { query, history? }. The universe is the broker's own
  // symbol map — same source Tune's autocomplete uses — so the LLM can only
  // ever propose real, currently-offered instruments; anything it proposes
  // outside that universe is dropped server-side (see screener-search.js).
  router.post('/screener-search', async (req, res) => {
    try {
      const query = String(req.body?.query || '').trim()
      if (!query) return res.status(400).json({ error: 'query is required' })
      const history = Array.isArray(req.body?.history) ? req.body.history.slice(-10) : []

      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected — symbol universe unavailable' })
      const map = await ensureSymbolMap(db, creds)
      const universe = Object.keys(map || {})
      if (universe.length === 0) return res.status(400).json({ error: 'no symbols available from this broker account' })

      const { llmBlocked } = await import('../lib/llm-switch.js')
      const gate = await llmBlocked(db, getState)
      if (gate.blocked) {
        // 503, not 502: nothing failed. The capability is switched off, and
        // the caller should be told that rather than shown a model error.
        return res.status(503).json({ error: `LLM layer unavailable — ${gate.reason}` })
      }
      const { createLLMClient } = await import('../lib/llm-provider.js')
      const { searchScreenerSymbols } = await import('../services/screener-search.js')
      // Matching a plain-language query against a known symbol list is the
      // doc's "search"/"extraction" shape — cheapest tier.
      const llmClient = createLLMClient(process.env, { task: { type: 'screener_search' } })
      const result = await searchScreenerSymbols(llmClient, query, universe, { history })
      res.json({ ok: true, ...result })
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
      const partial = volume < (pos.tradeData?.volume ?? volume)
      const local = db.prepare(
        `SELECT mp.trade_id, mp.account_id FROM monitored_positions mp JOIN trades t ON t.id = mp.trade_id
         WHERE t.ctrader_position_id = ? AND mp.status = 'active'`
      ).get(String(positionId)) || null
      recordPositionEvent(db, {
        accountId: local?.account_id ?? creds.accountId, positionId, tradeId: local?.trade_id,
        symbol: pos.symbolName || null, kind: partial ? 'scale_out' : 'close',
        toValue: volume, source: 'manual',
      })
      res.json({ ok: true, positionId, closedVolume: volume, partial, deal: exec.deal ?? null })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // POST /actions/close-all — emergency mass-close: close EVERY open
  // position at the broker, bot-placed or manual. Requires { confirm: true }
  // in the body so a stray click/fat-fingered call can't trigger it.
  // Re-reconciles fresh (never trusts a stale local cache, same as
  // findLivePosition) and closes each position independently — one failure
  // doesn't stop the rest, and the response reports both closed and failed
  // so the caller knows exactly what still needs manual attention.
  router.post('/close-all', async (req, res) => {
    try {
      if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm: true is required' })
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const rec = await execReconcile(creds)
      const positions = rec.position || []
      const closed = []
      const failures = []
      for (const p of positions) {
        const td = p.tradeData || {}
        try {
          const exec = await execClosePosition(creds, { positionId: parseInt(p.positionId), volume: td.volume })
          closed.push({ positionId: p.positionId, symbol: p.symbolName || null, volume: td.volume, deal: exec.deal ?? null })
          const local = db.prepare(
            `SELECT mp.trade_id, mp.account_id FROM monitored_positions mp JOIN trades t ON t.id = mp.trade_id
             WHERE t.ctrader_position_id = ? AND mp.status = 'active'`
          ).get(String(p.positionId)) || null
          recordPositionEvent(db, {
            accountId: local?.account_id ?? creds.accountId, positionId: p.positionId, tradeId: local?.trade_id,
            symbol: p.symbolName || null, kind: 'close', toValue: td.volume,
            reason: 'close_all', source: 'manual',
          })
        } catch (err) {
          failures.push({ positionId: p.positionId, symbol: p.symbolName || null, error: err.message })
        }
      }
      console.log(`[actions] close-all: ${closed.length} closed, ${failures.length} failed`)
      res.json({ ok: failures.length === 0, closed, failures, ranAt: new Date().toISOString() })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // POST /actions/position-double — ADD to an existing position: same
  // symbol/side/size. Body: { positionId }
  //
  // P2 / audit F-L5-02, F-L5-03, F-L5-08. This route used to place a second
  // market order with `allowNaked: true`, write NOTHING to the DB, and apply
  // NO CAP — no counter, no check, before or after send. risk.js's
  // duplicate_symbol veto does not cover it: that veto lives in the strategy
  // gate, not here. Three guards now stand in front of the broker call, all
  // decided in services/manual-position-guards.js so each is a test:
  //   · the add cap, counted from BROKER TRUTH so a hand-placed add in the
  //     cTrader app counts against it too;
  //   · an inherited stop — the parent's stop PRICE, one level for the whole
  //     exposure. A parent with no stop is refused rather than added to naked;
  //   · a dedup window, because a client retry after a timeout was taking two.
  // The action is recorded either way, so the ledger stops being blind to it.
  router.post('/position-double', async (req, res) => {
    try {
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const { positionId } = req.body || {}
      if (!positionId) return res.status(400).json({ error: 'positionId is required' })

      const guards = loadManualGuards(db)
      const dupe = isDuplicateCall(recentManualCalls(db), { route: 'position-double', positionId }, Date.now(), guards)
      if (dupe.duplicate) return res.status(409).json({ error: dupe.reason })

      const rec = await execReconcile(creds)
      const positions = rec.position || []
      const pos = positions.find(p => String(p.positionId) === String(positionId)) || null
      if (!pos) return res.status(404).json({ error: `position ${positionId} not found at the broker` })

      const cap = checkAddCap(positions, pos, guards)
      if (!cap.ok) {
        logManualCall(db, 'position-double', positionId, { refused: cap.reason, existing: cap.existing })
        return res.status(409).json({ error: cap.reason })
      }
      const bracket = inheritedBracket(pos, guards)
      if (!bracket.ok) {
        logManualCall(db, 'position-double', positionId, { refused: bracket.reason })
        return res.status(409).json({ error: bracket.reason })
      }

      const td = pos.tradeData || {}
      const label = encodeLabel({ source: 'manual', version: LABEL_VERSION, strategy: 'manual', session: getActiveSessions()[0]?.label || 'Off' })
      logManualCall(db, 'position-double', positionId, { sending: true, volume: td.volume, stopLoss: bracket.stopLoss })
      const exec = await execPlaceOrder(creds, {
        ctidTraderAccountId: parseInt(creds.accountId),
        symbolId: parseInt(td.symbolId),
        orderType: 'MARKET',
        tradeSide: td.tradeSide === 2 || td.tradeSide === 'SELL' ? 'SELL' : 'BUY',
        volume: td.volume,
        comment: 'abot-double',
        label,
        // The add inherits the parent's protection instead of going out naked.
        stopLoss: bracket.stopLoss,
        ...(bracket.takeProfit != null ? { takeProfit: bracket.takeProfit } : {}),
      })
      const newPositionId = exec?.position?.positionId ?? exec?.deal?.positionId ?? null
      logManualCall(db, 'position-double', positionId, { placed: true, newPositionId, stopLoss: bracket.stopLoss })
      recordPositionEvent(db, {
        accountId: creds.accountId, positionId, symbol: pos.symbolName || null,
        kind: 'position_added', toValue: td.volume, reason: `new leg ${newPositionId}`,
        source: 'manual', detail: { newPositionId, stopLoss: bracket.stopLoss },
      })
      res.json({ ok: true, doubledFrom: positionId, newPositionId, stopLoss: bracket.stopLoss, existingBefore: cap.existing })
    } catch (err) {
      try { logManualCall(db, 'position-double', req.body?.positionId, { failed: err.message }) } catch { /* audit only */ }
      res.status(502).json({ error: err.message })
    }
  })

  // POST /actions/position-reverse — close the position and open the same
  // size in the OPPOSITE direction. Body: { positionId }
  //
  // P2 / audit F-L5-01, F-L5-08. Two legs, and the second one used to go out
  // naked (`allowNaked: true`). Worse, a leg-two rejection left the account
  // FLAT with the thesis abandoned and a 502 body as the only record anywhere.
  // Now: a dedup window in front, a MIRRORED bracket on the new leg (the
  // parent's own stop and target distances, flipped), and — the part that
  // matters — an explicit, loud record when leg one succeeded and leg two did
  // not, because that is the state a human must know about immediately.
  //
  // The flat window between the legs is inherent to close-then-open and is
  // NOT closed here; shrinking it needs a venue-side single-order reverse,
  // which is not verified from this repo.
  router.post('/position-reverse', async (req, res) => {
    const { positionId } = req.body || {}
    let closed = false
    try {
      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      if (!positionId) return res.status(400).json({ error: 'positionId is required' })

      const guards = loadManualGuards(db)
      const dupe = isDuplicateCall(recentManualCalls(db), { route: 'position-reverse', positionId }, Date.now(), guards)
      if (dupe.duplicate) return res.status(409).json({ error: dupe.reason })

      const pos = await findLivePosition(creds, positionId)
      if (!pos) return res.status(404).json({ error: `position ${positionId} not found at the broker` })
      const td = pos.tradeData || {}
      const wasSell = td.tradeSide === 2 || td.tradeSide === 'SELL'

      const mirror = mirroredBracket(pos, guards)
      if (!mirror.ok) {
        logManualCall(db, 'position-reverse', positionId, { refused: mirror.reason })
        return res.status(409).json({ error: mirror.reason })
      }

      const local = db.prepare(
        `SELECT mp.trade_id, mp.account_id FROM monitored_positions mp JOIN trades t ON t.id = mp.trade_id
         WHERE t.ctrader_position_id = ? AND mp.status = 'active'`
      ).get(String(positionId)) || null

      logManualCall(db, 'position-reverse', positionId, { sending: true, volume: td.volume, newSide: wasSell ? 'BUY' : 'SELL' })
      await execClosePosition(creds, { positionId: parseInt(positionId), volume: td.volume })
      closed = true
      recordPositionEvent(db, {
        accountId: local?.account_id ?? creds.accountId, positionId, tradeId: local?.trade_id,
        symbol: pos.symbolName || null, kind: 'close', toValue: td.volume,
        reason: 'reverse_leg_one', source: 'manual',
      })

      const label = encodeLabel({ source: 'manual', version: LABEL_VERSION, strategy: 'manual', session: getActiveSessions()[0]?.label || 'Off' })
      const exec = await execPlaceOrder(creds, {
        ctidTraderAccountId: parseInt(creds.accountId),
        symbolId: parseInt(td.symbolId),
        orderType: 'MARKET',
        tradeSide: wasSell ? 'BUY' : 'SELL',
        volume: td.volume,
        comment: 'abot-reverse',
        label,
        // Mirrored protection instead of a naked leg: the parent's own stop
        // and target distances, applied to the opposite side.
        ...(mirror.slDistance != null ? { relativeStopLoss: Math.round(mirror.slDistance * 100000) } : {}),
        ...(mirror.tpDistance != null ? { relativeTakeProfit: Math.round(mirror.tpDistance * 100000) } : {}),
      })
      const newPositionId = exec?.position?.positionId ?? exec?.deal?.positionId ?? null
      logManualCall(db, 'position-reverse', positionId, { reversed: true, newPositionId })
      recordPositionEvent(db, {
        accountId: local?.account_id ?? creds.accountId, positionId: newPositionId,
        symbol: pos.symbolName || null, kind: 'position_reversed', toValue: td.volume,
        reason: `reversed from ${positionId}`, source: 'manual', detail: { closedPositionId: positionId },
      })
      res.json({ ok: true, reversedFrom: positionId, newSide: wasSell ? 'BUY' : 'SELL', newPositionId })
    } catch (err) {
      // The half-done case is the one worth shouting about: the old position
      // is gone and the new one never opened, so the account is FLAT and
      // nothing else in the system knows the thesis was abandoned.
      const halfDone = closed
      try {
        logManualCall(db, 'position-reverse', positionId, halfDone
          ? { LEG_TWO_FAILED: err.message, accountFlat: true }
          : { failed: err.message })
      } catch { /* audit only */ }
      if (halfDone) {
        try {
          persistRiskEvent(db, { symbol: null, side: null }, {
            approved: false,
            veto_reason: `reverse_leg_two_failed: position ${positionId} was CLOSED and the reversed leg did NOT open (${err.message}) — the account is flat on this symbol and the thesis is abandoned`,
          })
        } catch { /* audit only */ }
        if (process.env.TELEGRAM_BOT_TOKEN) {
          try {
            const { sendMessage } = await import('../services/telegram.js')
            await sendMessage(`🛑 REVERSE HALF-DONE: position ${positionId} was closed but the reversed leg did NOT open — ${err.message}. You are FLAT on this symbol. Re-enter by hand if the thesis still holds.`)
          } catch { /* non-fatal */ }
        }
        return res.status(502).json({
          error: `reverse_leg_two_failed: closed ${positionId}, reversed leg did NOT open — ${err.message}`,
          accountFlat: true,
          closed: true,
        })
      }
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
  // GET /actions/vpo-status — plain read-only proxy to the C++ sidecar's own
  // GET /vpo-status. The agent process holds EXEC_SECRET; nothing else does,
  // so this is the only way to answer "is VPO_ENABLED armed right now, and
  // on which strategies" from outside the sidecar's own container (audit
  // 2026-07-27 DR-1/OQ-2). No request body, no side effects, no auth pushed
  // anywhere — a single outbound GET and pass-through of the response.
  // -----------------------------------------------------------------------
  router.get('/vpo-status', async (_req, res) => {
    try {
      // The SAME creds the feeder arms with (vpo-feeder.js), so the status
      // page reads the sidecar that was actually configured rather than
      // whichever one EXEC_URL names.
      const base = execBaseFor(getCtraderCreds(db))
      const r = await fetch(base + '/vpo-status', {
        headers: { authorization: `Bearer ${process.env.EXEC_SECRET || ''}` },
      })
      const text = await r.text()
      res.status(r.status).type('application/json').send(text)
    } catch (err) {
      res.status(502).json({ error: err.message })
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
      // Parity is proved against the sidecar THESE credentials route to.
      const base = execBaseFor(creds)
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
    const { kind, key, stage, on, accountId = null } = req.body || {}
    try {
      // accountId writes THAT account's overlay and nothing else; absent, the
      // global matrix — byte-identical to the behaviour before overlays.
      const matrix = setStage(db, { kind, key, stage, on: on === true, accountId }, { getState, setState })
      console.log(`[actions] stage-matrix${accountId ? ` (account ${accountId})` : ''}: ${kind} ${key} × ${stage} → ${on === true ? 'on' : 'off'}`)
      // THE TALLIES COME BACK WITH THE WRITE (review, #609). Without them the
      // page merged only strategies/filters, so the tick the operator had just
      // flipped disagreed with the per-account count underneath it until the
      // next poll — for the edited account on an overlay write, and for every
      // inheriting account on a shared one. A count that lags the thing it
      // counts is the defect the tally was added to remove.
      res.json({ ok: true, ...matrix, tallies: accountStageTallies(db, getState) })
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
      let gone = false
      const shutdown = () => {
        gone = true
        clearInterval(hb)
        try { stream?.close() } catch { /* already closed */ }
        try { res.end() } catch { /* client gone */ }
      }
      // Register BEFORE the await: a client that aborts during the websocket
      // handshake used to fire 'close' before this listener existed, so
      // shutdown never ran and the broker stream (plus its own heartbeat
      // timer) leaked — one orphan per aborted page load, forever.
      req.on('close', shutdown)
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
      // The client may have vanished during the handshake above — close the
      // stream we just opened instead of arming a heartbeat onto a dead socket.
      if (gone) return shutdown()
      hb = setInterval(() => res.write(': ping\n\n'), 15_000)
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
          if (wanted.includes('rsi14')) overlays.rsi14 = ind.rsi(bars.map(b => b.c), 14)
          if (wanted.includes('macd')) overlays.macd = ind.macd(bars.map(b => b.c))
          if (wanted.includes('stochastic')) overlays.stochastic = ind.stochastic(bars)
          if (wanted.includes('pivots')) {
            // Classic pivots from the most recent COMPLETE bar of this series —
            // not daily pivots, so the caller labels it "prior <tf> bar" honestly.
            const { classicPivots } = await import('../lib/pivot-points.js')
            const prior = bars[bars.length - 2]
            if (prior) overlays.pivots = classicPivots({ high: prior.h, low: prior.l, close: prior.c })
          }
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
      try { const { recordFxRates } = await import('../services/fx-rates.js'); recordFxRates(db, scanResult) } catch { /* best effort */ }

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
    setPhaseFlag(db, 'scan_enabled', on ? 'true' : 'false', { actor: 'owner-ui', via: '/actions/scan-toggle' })
    res.json({ ok: true, scan_enabled: on })
  })

  router.post('/analyze-toggle', (req, res) => {
    const on = req.body?.on !== false
    setPhaseFlag(db, 'analyze_enabled', on ? 'true' : 'false', { actor: 'owner-ui', via: '/actions/analyze-toggle' })
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
      // START FROM THE STORED CONFIG, not from an empty object.
      //
      // This used to build `next` field by field from a fixed list, which
      // silently DROPPED every key the list did not mention — the whole spike
      // and structure block (spikeTightenEnabled, spikeRangeAtrMult,
      // spikeTrailAtrMult, spikeBars, structureTrailEnabled,
      // structurePivotBars, structureBufferAtrMult, structureMaxAtrMult).
      // Changing armAtrMult through this route therefore reset eight unrelated
      // trailing knobs.
      //
      // It has been harmless so far only by luck: every one of those stored
      // values happened to equal its code default, and loadProfitKeeperConfig
      // merges over the defaults, so they came back identical. The first time
      // any of them is tuned away from its default, the next unrelated POST
      // reverts it — with a 200 and a reply that looks correct, because the
      // reply is built from the same truncated object.
      const next = {
        ...current,
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
        // Spike + structure trailing. Previously settable NOWHERE — no route
        // accepted them, so the only way to change how tightly a winner is
        // trailed was to edit the defaults and redeploy. Measured 16-08-2026:
        // non-burn-in winners captured a median of 23% of their planned
        // target, and the spike trail (1 x ATR ~ 0.4R behind peak, armed by a
        // single wide bar in the last three) is the most likely reason a 2R
        // plan exits at 0.2R. Tuning it needed these to be reachable.
        spikeTightenEnabled: b.spikeTightenEnabled != null ? b.spikeTightenEnabled === true : current.spikeTightenEnabled,
        spikeRangeAtrMult: b.spikeRangeAtrMult !== undefined ? clamp(b.spikeRangeAtrMult, 0.5, 10, current.spikeRangeAtrMult) : current.spikeRangeAtrMult,
        spikeTrailAtrMult: b.spikeTrailAtrMult !== undefined ? clamp(b.spikeTrailAtrMult, 0.25, 10, current.spikeTrailAtrMult) : current.spikeTrailAtrMult,
        spikeBars: b.spikeBars !== undefined ? Math.round(clamp(b.spikeBars, 1, 20, current.spikeBars)) : current.spikeBars,
        structureTrailEnabled: b.structureTrailEnabled != null ? b.structureTrailEnabled === true : current.structureTrailEnabled,
        structurePivotBars: b.structurePivotBars !== undefined ? Math.round(clamp(b.structurePivotBars, 1, 10, current.structurePivotBars)) : current.structurePivotBars,
        structureBufferAtrMult: b.structureBufferAtrMult !== undefined ? clamp(b.structureBufferAtrMult, 0, 5, current.structureBufferAtrMult) : current.structureBufferAtrMult,
        // null is MEANINGFUL here (unbounded giveback), so it is preserved
        // rather than clamped into a number — see profit-keeper.js, where an
        // absent key defaulting to 4 was itself a fix.
        structureMaxAtrMult: b.structureMaxAtrMult === null ? null
          : b.structureMaxAtrMult !== undefined ? clamp(b.structureMaxAtrMult, 0.5, 20, current.structureMaxAtrMult)
          : current.structureMaxAtrMult,
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

  // (A second POST /actions/loss-guardian used to be registered here — dead
  // code, Express only ever ran the first one (line ~568). Its atrTimeframe/
  // atrPeriod handling was unreachable, and its `config` reply key is now on
  // the live route. Removed 2026-08-02.)

  // -----------------------------------------------------------------------
  // POST /actions/bot-note — the bot's own change ledger (owner 02-08-2026:
  // "highlight in yellow border of the changes that you have change them in
  // the web-app, so I know that you had done that... these are done by bot
  // and not me and when"). Every change the agent (Claude) performs on the
  // owner's behalf is recorded here BY the agent, and the UI reads it back:
  // yellow borders on the touched sections + the sidebar Bot Changes panel.
  // Body: { what, detail?, targets?: ['sec-pipeline', ...] }. Keeps the
  // last 100 entries.
  // -----------------------------------------------------------------------
  router.post('/bot-note', (req, res) => {
    try {
      const { what, detail = null, targets = [] } = req.body || {}
      if (!what || typeof what !== 'string') return res.status(400).json({ error: 'what (string) required' })
      let list = []
      try { list = JSON.parse(getState(db, 'bot_changes_json') || '[]') } catch { list = [] }
      if (!Array.isArray(list)) list = []
      list.unshift({
        at: new Date().toISOString(),
        what: String(what).slice(0, 300),
        detail: detail != null ? String(detail).slice(0, 1000) : null,
        targets: Array.isArray(targets) ? targets.slice(0, 20).map(t => String(t).slice(0, 80)) : [],
      })
      setState(db, 'bot_changes_json', JSON.stringify(list.slice(0, 100)))
      res.json({ ok: true, count: Math.min(list.length, 100) })
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
    setPhaseFlag(db, 'autotrade_enabled', on ? 'true' : 'false', { actor: 'owner-ui', via: '/actions/autotrade-toggle' })
    res.json({ ok: true, autotrade_enabled: on })
  })

  // The legacy "/actions/autopilot toggles autotrade" route was REMOVED
  // (2026-07-31). A second POST /autopilot is registered earlier in this file
  // (the strategy-autopilot mode switch), so this one was dead code — Express
  // serves the first match. Dead is the good outcome: had the routes ever
  // been reordered, a {mode:'off'} post would have read `on === true` →
  // false and silently DISARMED autotrade — the exact class of unattributed
  // flip the phase-audit trail exists to catch. Autotrade toggling has
  // exactly one route: /actions/autotrade-toggle.

  // -----------------------------------------------------------------------
  // POST /actions/arm — legacy: enable all three toggles
  // -----------------------------------------------------------------------
  router.post('/arm', (_req, res) => {
    for (const k of ['scan_enabled', 'analyze_enabled', 'autotrade_enabled']) {
      setPhaseFlag(db, k, 'true', { actor: 'owner-ui', via: '/actions/arm' })
    }
    res.json({ ok: true, scan_enabled: true, analyze_enabled: true, autotrade_enabled: true })
  })

  // -----------------------------------------------------------------------
  // POST /actions/disarm — legacy: disable autotrade only (scan+analyze stay on)
  // -----------------------------------------------------------------------
  router.post('/disarm', (_req, res) => {
    setPhaseFlag(db, 'autotrade_enabled', 'false', { actor: 'owner-ui', via: '/actions/disarm' })
    res.json({ ok: true, autotrade_enabled: false })
  })

  // -----------------------------------------------------------------------
  // POST /actions/account-phases — Scan / Analyze / Autotrade for ONE account.
  //
  // Body: { accountId, scan?, analyze?, autotrade? } where each phase is
  //   true  → force on for this account (still subject to the master)
  //   false → off for this account only
  //   null  → clear the override, inherit the master again
  // Omitted keys are left alone, so the UI can send one switch at a time.
  //
  // Owner: "scan/analyze/autotrade should be in all account. I don't want all
  // accounts to be traded by this bot-trade in the same way."
  //
  // THE ACCOUNT MUST EXIST IN THE REGISTRY. A typo'd id would otherwise write
  // an override key that nothing ever reads — a switch that reports itself off
  // while the real account keeps trading, which is the precise failure this
  // feature exists to end.
  //
  // The master is unchanged by this route and remains an absolute veto: a
  // per-account `true` cannot arm anything while the global switch is off.
  // -----------------------------------------------------------------------
  router.post('/account-phases', async (req, res) => {
    try {
      const b = req.body || {}
      const accountId = b.accountId != null ? String(b.accountId) : ''
      if (!accountId) return res.status(400).json({ error: 'accountId is required' })
      const row = db.prepare('SELECT account_id FROM accounts WHERE account_id = ?').get(accountId)
      if (!row) return res.status(404).json({ error: `unknown account ${accountId}` })

      const { PHASES, setAccountPhases, effectivePhases, masterPhases } =
        await import('../services/account-phases.js')
      // Reject junk loudly here even though the service ignores it — a client
      // sending 'on'/'1' should learn it did nothing, not be told ok.
      for (const p of PHASES) {
        if (!(p in b)) continue
        if (b[p] !== true && b[p] !== false && b[p] !== null) {
          return res.status(400).json({ error: `${p} must be true, false or null (null = inherit)` })
        }
      }
      const patch = {}
      for (const p of PHASES) if (p in b) patch[p] = b[p]
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'nothing to set — send scan, analyze and/or autotrade' })
      }

      const result = setAccountPhases(db, accountId, patch, { actor: 'owner-ui', via: '/actions/account-phases' })
      const master = masterPhases(db)
      const effective = effectivePhases(db, accountId, master)
      const words = Object.entries(result.set)
        .map(([p, v]) => `${p}=${v === null ? 'inherit' : v ? 'on' : 'OFF'}`).join(' ')
      // S/A/T, not the first letter of each name — analyze and autotrade would
      // both print 'a' and the log line would be unreadable.
      const initials = { scan: 'S', analyze: 'A', autotrade: 'T' }
      console.log(`[actions] Account phases ${accountId}: ${words} → effective ` +
        PHASES.map(p => `${initials[p]}${effective[p] ? '+' : '-'}`).join(' '))
      res.json({ ok: true, accountId, set: result.set, master, effective })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
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
    for (const k of ['scan_enabled', 'analyze_enabled', 'autotrade_enabled']) {
      setPhaseFlag(db, k, 'false', { actor: 'owner-ui', via: '/actions/kill-all', reason: 'emergency kill-all' })
    }
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
    // Enrich each account with its balance + full trader object (best effort
    // — a failure just leaves balance null for that account). The trader
    // object is cached on the account (`_trader`) so a later snapshot in
    // this same request doesn't re-fetch it — TRADER_REQ is a fresh WS auth
    // handshake per account (~seconds each), and was previously fetched
    // TWICE per account per snapshot (here, then again in snapshotAccount).
    await Promise.all(accounts.map(async (a) => {
      try {
        const host = a.isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
        const trader = await wsGetTrader(host, clientId, clientSecret, accessToken, a.accountId)
        const bal = traderBalance(trader)
        if (bal != null) a.balance = bal
        a._trader = trader
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
  // COALESCE + short TTL — a snapshot costs ~6 fresh WS connections with full
  // auth handshakes (~20s). The Desk polls this from several widgets at once,
  // so uncoalesced it runs dozens of overlapping 20s snapshots and starves the
  // box (the owner's "everything is stale"). One in-flight snapshot is shared
  // by every caller, and its result is reused for a short window.
  const bpShared = { all: { at: 0, promise: null }, sel: { at: 0, promise: null } }
  const BP_TTL_MS = 12_000
  router.post('/broker-positions', async (req, res) => {
    const slot = bpShared[req.body?.selectedOnly ? 'sel' : 'all']
    if (slot.promise && Date.now() - slot.at < BP_TTL_MS) {
      try { return res.json(await slot.promise) } catch { /* stale failure — fall through to a fresh run */ }
    }
    slot.at = Date.now()
    slot.promise = (async () => {
      const { ctraderEnv } = await import('../lib/ctrader-env.js')
      const accessToken = getState(db, 'ctrader_access_token') || ctraderEnv('accessToken')
      if (!accessToken) throw Object.assign(new Error('No access token stored — connect cTrader first'), { httpStatus: 400 })
      const clientId = ctraderEnv('clientId')
      const clientSecret = ctraderEnv('clientSecret')
      const { wsReconcile, wsSymbolsByIds, wsGetSymbolsList, wsGetLastCloses, wsGetDailyOhlcv, wsGetTrader, wsGetAssets, wsGetUnrealizedPnl, traderBalance } = await import('../lib/ctrader-ws.js')

      let accounts = await listCtraderAccounts(accessToken)
      const selectedId = getState(db, 'ctrader_account_id')
      // selectedOnly: snapshot just the bot's account (Monitor uses this —
      // 1 account × ~4 round-trips instead of 7 accounts' worth).
      if (req.body?.selectedOnly && selectedId) {
        accounts = accounts.filter(a => String(a.accountId) === String(selectedId))
      }

      const snapshotAccount = async (acct) => {
        const host = acct.isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
        const { _trader, ...acctPublic } = acct
        const out = {
          ...acctPublic,
          selected: String(acct.accountId) === String(selectedId),
          currency: null,
          moneyDigits: _trader?.moneyDigits ?? 2,
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
          // Reuse the trader object listCtraderAccounts already fetched
          // (TRADER_REQ is a fresh WS auth handshake — don't pay for it twice).
          const assetNameById = {}
          try {
            const [trader, assets] = await Promise.all([
              _trader ? Promise.resolve(_trader) : wsGetTrader(host, clientId, clientSecret, accessToken, acct.accountId),
              wsGetAssets(host, clientId, clientSecret, accessToken, acct.accountId),
            ])
            for (const a of (assets.asset || [])) assetNameById[a.assetId] = a.displayName || a.name || null
            out.currency = assetNameById[trader.depositAssetId] || null
            out.moneyDigits = trader.moneyDigits ?? 2
          } catch { /* currency stays null */ }

          if (rawPositions.length === 0 && rawOrders.length === 0) {
            const flatBal = traderBalance({ balance: _trader?.balance, moneyDigits: out.moneyDigits }) ?? acct.balance ?? null
            out.health = {
              balance: flatBal, equity: flatBal, usedMargin: 0, freeMargin: flatBal, marginLevelPct: null,
              unrealizedNetPnl: 0, unrealizedNetPnlPct: 0,
              positionsInProfit: 0, positionsInLoss: 0,
              slGrossTotal: null, slNetTotal: null, tpGrossTotal: null, tpNetTotal: null,
              slNetTotalPct: null, tpNetTotalPct: null,
            }
            return out
          }

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
          const posSymbolIds = [...new Set(rawPositions.map(p => p.tradeData?.symbolId).filter(Boolean))]
          let spots = {}
          try {
            const rs2 = await Promise.all(posSymbolIds.map(id =>
              wsGetSpotOnce(host, clientId, clientSecret, accessToken, acct.accountId, id).then(q => [id, q]).catch(() => [id, null])
            ))
            spots = Object.fromEntries(rs2)
          } catch { /* bid/ask omitted */ }
          // Latest daily OHLCV per position symbol (owner: open-trade tables
          // need current price, OHLC, volume). For a closed market this is
          // the LAST SESSION's bar — labeled by its own timestamp, never
          // passed off as live. Best-effort like every enrichment here.
          let dailyBars = {}
          try {
            dailyBars = await wsGetDailyOhlcv(host, clientId, clientSecret, accessToken, acct.accountId, posSymbolIds)
          } catch { /* OHLCV omitted */ }

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
            // Gross/net dollar impact IF the SL or TP level is hit — same
            // price-move math as estPnlQuote/estNetPnl above, just evaluated
            // at the stop/target price instead of the current price. Reuses
            // the real symMeta (lot size, FX quote/deposit conversion)
            // already fetched for this account — no per-instrument point
            // value table to guess (owner: "gross and nett for SL and TP").
            const impactAt = (targetPrice) => {
              if (targetPrice == null || lots == null || unitsPerLot == null) return { gross: null, net: null }
              const moveQuote = Math.round((targetPrice - p.price) * dir * lots * unitsPerLot * 100) / 100
              let moveDeposit = null
              if (quoteCcy === 'USD') moveDeposit = moveQuote
              else if (isFxPair && symName.startsWith('USD') && targetPrice > 0) moveDeposit = moveQuote / targetPrice
              const net = moveDeposit != null
                ? Math.round((moveDeposit + (swapMoney || 0) + (commissionMoney || 0)) * 100) / 100
                : null
              return { gross: moveDeposit, net }
            }
            const slImpact = impactAt(p.stopLoss ?? null)
            const tpImpact = impactAt(p.takeProfit ?? null)
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
              slGrossImpact: slImpact.gross, // deposit-ccy P&L if SL hit, price-move only
              slNetImpact: slImpact.net,     // ...incl. swap + commission
              tpGrossImpact: tpImpact.gross, // deposit-ccy P&L if TP hit, price-move only
              tpNetImpact: tpImpact.net,     // ...incl. swap + commission
              tps: ladder.length ? ladder : null,
              bid: spots[td.symbolId]?.bid ?? null,
              ask: spots[td.symbolId]?.ask ?? null,
              day: dailyBars[td.symbolId] ?? null, // latest 1d bar {t,o,h,l,c,v}

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
              // For the market-open/closed pivot (owner: "columns of ...
              // market open trading, market close trading").
              marketOpen: meta.symbolName ? isSymbolMarketOpen(meta.symbolName).open : null,
            }
          })

          // Account Health aggregates — balance/equity/margin/buffer plus
          // total SL/TP dollar impact, all derived from the SAME per-position
          // figures above (not a second, possibly-inconsistent calculation —
          // this is what caused the earlier 3-way P&L mismatch the owner saw
          // across bot-trade/cTrader/Pepperstone).
          const bal = traderBalance({ balance: _trader?.balance, moneyDigits: out.moneyDigits }) ?? acct.balance ?? null
          const sumPositions = (fn) => out.positions.reduce((s, p) => {
            const v = fn(p)
            return v == null ? s : s + v
          }, 0)
          const floatingNet = out.positions.some(p => p.netPnl != null) ? sumPositions(p => p.netPnl) : null
          const usedMarginTotal = out.positions.some(p => p.usedMargin != null) ? sumPositions(p => p.usedMargin) : null
          const equity = bal != null ? Math.round((bal + (floatingNet || 0)) * 100) / 100 : null
          const freeMargin = equity != null && usedMarginTotal != null ? Math.round((equity - usedMarginTotal) * 100) / 100 : null
          const marginLevelPct = equity != null && usedMarginTotal ? Math.round((equity / usedMarginTotal) * 10000) / 100 : null
          const pctOfBalance = (v) => (v == null || !bal) ? null : Math.round((v / bal) * 10000) / 100
          out.health = {
            balance: bal,
            equity,
            usedMargin: usedMarginTotal,
            freeMargin,
            marginLevelPct,
            unrealizedNetPnl: floatingNet,
            unrealizedNetPnlPct: pctOfBalance(floatingNet),
            // Open-book shape at a glance (owner: "how many -ve lost and
            // how many +ve win") — counts from the same per-position netPnl.
            positionsInProfit: out.positions.filter(p => (p.netPnl ?? 0) > 0).length,
            positionsInLoss: out.positions.filter(p => (p.netPnl ?? 0) < 0).length,
            slGrossTotal: out.positions.some(p => p.slGrossImpact != null) ? sumPositions(p => p.slGrossImpact) : null,
            slNetTotal: out.positions.some(p => p.slNetImpact != null) ? sumPositions(p => p.slNetImpact) : null,
            tpGrossTotal: out.positions.some(p => p.tpGrossImpact != null) ? sumPositions(p => p.tpGrossImpact) : null,
            tpNetTotal: out.positions.some(p => p.tpNetImpact != null) ? sumPositions(p => p.tpNetImpact) : null,
          }
          out.health.slNetTotalPct = pctOfBalance(out.health.slNetTotal)
          out.health.tpNetTotalPct = pctOfBalance(out.health.tpNetTotal)

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
        // PER ACCOUNT TOO (owner 04-08-2026: "floating table > computation of
        // summation and individual P/L and TP/SL missing again").
        //
        // The line above caches ONE account — the selected one — under a
        // global key, and /state/positions enriched every row from it. So a
        // position on any other account matched nothing and rendered P&L,
        // price and the daily bar as "—", while the selected account's rows
        // looked fine. Which rows were blank moved with the account picker,
        // which is why it read as intermittent rather than as a scoping bug.
        //
        // This route already fetched every account's reconcile; throwing all
        // but one away was the whole defect. Bounded by the number of
        // registered accounts, and only successful snapshots are written — a
        // failed fetch must not overwrite a good cache with an empty one.
        for (const a of results) {
          if (a.error || a.accountId == null) continue
          setState(db, `acct:${String(a.accountId)}:broker_snapshot_cache_json`,
            JSON.stringify({ account: a, fetchedAt }))
        }
      } catch { /* cache is best-effort */ }
      return { ok: true, accounts: results, fetchedAt }
    })()
    try {
      res.json(await slot.promise)
    } catch (err) {
      slot.promise = null // never serve a cached failure
      console.error('[actions/broker-positions] error:', err.message)
      res.status(err.httpStatus || 502).json({ error: err.message })
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

      // REGISTER WHAT WE DISCOVER (2026-07-29). Browsing the broker's account
      // list used to leave no trace, so an account only entered the registry
      // once it was SELECTED or role-pushed. Everything that reads the
      // registry — the account roster, per-account watchlists, the compare &
      // copy panel — therefore could not see an account the operator had
      // never selected. Owner, on their live account: "How come cannot see
      // the live account?" Because it had never been selected, so it was
      // never registered.
      //
      // Registering is NOT enabling. upsertAccount inserts with enabled = 0
      // and mode = 'manage_only', and never touches those flags on a row that
      // already exists — so a discovered account becomes VISIBLE and
      // configurable without becoming tradeable. Nothing dispatches to it
      // until it is deliberately enabled, which is exactly what the
      // multi-account plan intended for non-selected live accounts.
      let registered = 0
      try {
        const { upsertAccount } = await import('../services/account-registry.js')
        for (const a of accounts) {
          if (a?.accountId == null) continue
          upsertAccount(db, {
            accountId: a.accountId,
            traderLogin: a.traderLogin ?? null,
            isLive: !!a.isLive,
            brokerLabel: a.brokerTitle || null,
          })
          registered++
        }
      } catch (e) {
        // Discovery must still answer even if the registry write fails —
        // the picker is how the operator recovers from a broken link.
        console.warn('[actions/ctrader-accounts] registry upsert failed (non-fatal):', e.message)
      }

      // REMEMBER WHAT THE BROKER SAID. This is the only place the broker's
      // account list reaches the agent, and until now it left no record — so
      // nothing could tell "this registry row was removed at the broker" from
      // "nobody has looked". Recording it is what lets the registry-fed
      // surfaces flag a vanished account instead of listing it forever.
      // Registry rows are still never deleted and `enabled` is never touched
      // here: the owner's instruction was to flag it, not act on it.
      try {
        const { recordBrokerRoster } = await import('../services/broker-roster.js')
        recordBrokerRoster(db, accounts)
      } catch (e) {
        console.warn('[actions/ctrader-accounts] roster record failed (non-fatal):', e.message)
      }

      res.json({
        ok: true,
        accounts,
        registered,
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

      // Account switch keeps managing what it leaves behind (owner
      // 2026-07-28: "switching away from an account with open positions ...
      // should be okay, don't have to warn"). It is okay precisely BECAUSE
      // of this block — without it, switching was an abandonment: the old
      // account's monitor rows were closed outright, so trailing stops, the
      // per-position loss cap, the profit ratchet and time caps all stopped
      // for positions still open at the broker, leaving only whatever SL/TP
      // the broker happened to hold.
      //
      // The original justification for the wholesale sweep — "they gate risk
      // checks for the new account" — is obsolete: both open-position
      // queries in the risk gate filter on account_id (services/risk.js:357,
      // :757), so another account's positions no longer count against this
      // one. Unattributable NULL rows DO still leak (those same queries
      // accept `account_id IS NULL`), so they are still swept.
      const previousAccountId = getState(db, 'ctrader_account_id')
      const retained = accountsWithOpenPositions(db).filter(id => id !== String(accountId))
      if (previousAccountId && String(previousAccountId) !== String(accountId)) {
        // Keep = the new account + every account still holding positions.
        // Everything else (including NULL rows) is genuinely stale.
        const swept = sweepMonitoredPositionsForAccounts(db, [String(accountId), ...retained])
        if (swept > 0) {
          console.log(`[actions] account switch ${previousAccountId} → ${accountId}: swept ${swept} unattributable/stale monitored position(s)`)
        }
        if (retained.length) {
          console.log(`[actions] account switch: still managing ${retained.length} account(s) with open positions — ${retained.join(', ')} (manage_only: no new entries, protection stays on)`)
        }
      }

      setState(db, 'ctrader_account_id', String(accountId))
      setState(db, 'ctrader_is_live', isLive ? 'true' : 'false')
      // THE ROSTER MIRRORS THE REGISTRY, IT DOES NOT OVERRULE IT (owner
      // 04-08-2026). This used to be written as "the selected account with
      // autopilot:true, plus the accounts holding open positions with
      // autopilot:false" — so every other ARMED account vanished from the
      // roster on a selection, and getAutopilotAccounts prefers this key over
      // the registry. Selection therefore disarmed accounts twice over: once
      // in the registry rows and once here.
      //
      // The roster is now the registry's own answer, so the two cannot
      // disagree. Any account the owner armed keeps autopilot:true whether or
      // not it is the one being viewed; anything else rides along with
      // autopilot:false, which keeps its stops managed without dispatching it
      // a new entry.
      try {
        const { registryAutopilotAccounts: regAuto, getEnabledAccounts: regEnabled } =
          await import('../services/account-registry.js')
        const armed = new Set(regAuto(db).map(a => String(a.accountId)))
        armed.add(String(accountId))
        const roster = regEnabled(db).map(a => ({
          accountId: String(a.accountId),
          isLive: a.is_live === 1,
          autopilot: armed.has(String(a.accountId)),
        }))
        if (!roster.some(r => r.accountId === String(accountId))) {
          roster.unshift({ accountId: String(accountId), isLive: !!isLive, autopilot: true })
        }
        setState(db, 'ctrader_account_roles_json', JSON.stringify(roster))
      } catch {
        // A registry read that fails must not leave a stale roster naming the
        // previous account: fall back to the selected one alone, which is the
        // conservative answer and what the single-account era did.
        setState(db, 'ctrader_account_roles_json', JSON.stringify([
          { accountId, isLive: !!isLive, autopilot: true },
        ]))
      }
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

      // Account Registry mirror (M0): the same sole-enabled swap the legacy
      // state keys above just performed, kept in the registry so both
      // sources always agree.
      try {
        const { syncSelectedAccount } = await import('../services/account-registry.js')
        syncSelectedAccount(db, accountId, !!isLive, traderLogin, { retainAccountIds: retained })
      } catch (e) { console.warn('[actions/ctrader-select-account] registry sync failed (non-fatal):', e.message) }

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
        const { setAccountState } = await import('../services/account-registry.js')
        if (balance != null) {
          setState(db, 'account_balance_usd', String(balance))
          setAccountState(db, accountId, 'account_balance_usd', String(balance))
        }
        if (trader.leverageInCents != null) {
          setState(db, 'account_leverage', String(trader.leverageInCents / 100))
          setAccountState(db, accountId, 'account_leverage', String(trader.leverageInCents / 100))
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

  // -----------------------------------------------------------------------
  // POST /actions/registry-account — { accountId, enabled, mode? ,
  // confirmLive? } enables/disables one registry row (M4: lifts the M0
  // sole-enabled invariant). SAFETY CARVE-OUT: enabling a LIVE account is
  // the M5 cutover gesture and requires confirmLive:true explicitly — the
  // owner's word, never a default.
  // -----------------------------------------------------------------------
  router.post('/registry-account', async (req, res) => {
    try {
      const { accountId, enabled, mode, confirmLive } = req.body || {}
      if (accountId == null || typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'need accountId and enabled:boolean' })
      }
      const { setAccountEnabled, listAccounts } = await import('../services/account-registry.js')
      // THE CARVE-OUT MOVED INTO THE SERVICE (PR B). It used to live here and
      // guard `enabled`, which was the only switch at the time. `enabled` is
      // now derived from `mode`, so the check guards what it was always for —
      // letting a LIVE account ENTER — and it lives in one place, so the
      // unarchive path is covered too instead of reaching live-active free.
      const out = setAccountEnabled(db, accountId, enabled, mode || null, { confirmLive: confirmLive === true })
      if (!out.ok) return res.status(out.error && /confirmLive/.test(out.error) ? 403 : 400).json({ error: out.error, ...out })
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('POST', '/actions/registry-account', JSON.stringify(out).slice(0, 2000))
      } catch { /* audit best-effort */ }
      console.log('[actions] registry account updated:', out)
      res.json({ ok: true, ...out, accounts: listAccounts(db) })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/account-setting { accountId, key, value?, revert? }
  // A6. Pin a setting to one account, or revert it to inheritance.
  //
  // REVERT DELETES the account row rather than copying the shared value into
  // it. A copy would freeze today's shared value and stop following later
  // changes — the drift the two-level resolver exists to avoid. Revert means
  // "follow the house rule again", not "match it once".
  // -----------------------------------------------------------------------
  router.post('/account-setting', async (req, res) => {
    try {
      const { accountId, key, value, revert } = req.body || {}
      if (accountId == null || !key) return res.status(400).json({ error: 'need accountId and key' })
      const { setOverride, clearOverride, overrideView } = await import('../services/setting-resolver.js')
      const out = revert === true
        ? clearOverride(db, accountId, key)
        : setOverride(db, accountId, key, value)
      if (!out.ok) return res.status(400).json(out)
      res.json({ ok: true, ...out, view: overrideView(db, accountId) })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/pause-disposition { accountId?, disposition?, drainHours? }
  // A3. What happens to RESTING ENTRY ORDERS when an account stops entering.
  // With accountId: a per-account override. Without: the global default.
  // Never touches protective SL/TP orders — those belong to open positions
  // and are not a pause's business.
  // -----------------------------------------------------------------------
  router.post('/pause-disposition', async (req, res) => {
    try {
      const { accountId, disposition, drainHours } = req.body || {}
      const { DISPOSITIONS, STATE_KEY } = await import('../services/pause-disposition.js')
      if (disposition != null && !DISPOSITIONS.includes(disposition)) {
        return res.status(400).json({ error: `disposition must be one of ${DISPOSITIONS.join(', ')}` })
      }
      const hours = drainHours == null ? null : Number(drainHours)
      if (hours != null && !(Number.isFinite(hours) && hours > 0)) {
        return res.status(400).json({ error: 'drainHours must be a positive number' })
      }
      let out
      if (accountId != null) {
        const { listAccounts } = await import('../services/account-registry.js')
        const row = listAccounts(db).find(a => String(a.account_id) === String(accountId))
        if (!row) return res.status(404).json({ error: `account ${accountId} is not in the registry` })
        const params = { ...row.params }
        if (disposition != null) params.pauseDisposition = disposition
        if (hours != null) params.drainHours = hours
        db.prepare('UPDATE accounts SET params = ?, updated_at = ? WHERE account_id = ?')
          .run(JSON.stringify(params), new Date().toISOString(), String(accountId))
        out = { scope: String(accountId), disposition: params.pauseDisposition ?? null, drainHours: params.drainHours ?? null }
      } else {
        let current = {}
        try { current = JSON.parse(getState(db, STATE_KEY) || '{}') || {} } catch { current = {} }
        if (disposition != null) current.disposition = disposition
        if (hours != null) current.drainHours = hours
        setState(db, STATE_KEY, JSON.stringify(current))
        out = { scope: 'global', ...current }
      }
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('POST', '/actions/pause-disposition', JSON.stringify(out).slice(0, 2000))
      } catch { /* audit best-effort */ }
      res.json({ ok: true, ...out })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/account-archive { accountId, archived:boolean, mode? }
  // A2. `archived` is the ONLY state that stops managing an account, so it is
  // the only one that can recreate the abandonment bug — trailing stops, the
  // loss cap, the ratchet and the naked-position guardian all key off active
  // monitored_positions rows. It therefore does not go through the ordinary
  // mode setter: archiveAccount refuses while the account holds open positions
  // or working entry orders, and names them in the error so the operator knows
  // what to clear rather than being told "no".
  // -----------------------------------------------------------------------
  router.post('/account-archive', async (req, res) => {
    try {
      const { accountId, archived, mode, confirmLive } = req.body || {}
      if (accountId == null || typeof archived !== 'boolean') {
        return res.status(400).json({ error: 'need accountId and archived:boolean' })
      }
      const { archiveAccount, unarchiveAccount } = await import('../services/account-capabilities.js')
      // Un-filing now re-enters the roster (enabled is derived), so this path
      // can grant a live account ENTER when mode='active' — it needs the same
      // confirmation the registry route has always had.
      const out = archived
        ? archiveAccount(db, accountId)
        : unarchiveAccount(db, accountId, mode || 'manage_only', { confirmLive: confirmLive === true })
      if (!out.ok) return res.status(409).json(out)
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('POST', '/actions/account-archive', JSON.stringify(out).slice(0, 2000))
      } catch { /* audit best-effort */ }
      const { listAccounts } = await import('../services/account-registry.js')
      res.json({ ok: true, ...out, accounts: listAccounts(db) })
    } catch (err) {
      res.status(500).json({ error: err.message })
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

        // Account Registry mirror (M0): keep the registry in step with the
        // pushed roles so both sources agree (identity/metadata only here;
        // the enabled flag follows each entry's autopilot role).
        Promise.all([
          import('../services/account-registry.js'),
          import('../services/account-capabilities.js'),
        ]).then(([{ upsertAccount }, { enabledForMode, modeForPushedEntry }]) => {
          try {
            for (const a of accounts) {
              if (a?.accountId == null) continue
              upsertAccount(db, { accountId: a.accountId, traderLogin: a.traderLogin ?? null, isLive: !!a.isLive })
              // `enabled` IS NO LONGER MIRRORED FROM THE AUTOPILOT ROLE (10-08-2026).
              //
              // This wrote `enabled = a.autopilot ? 1 : 0` alongside the mode, so
              // every account without the autopilot role was ejected from the
              // sidecar roster while keeping a mode that still claims MANAGE.
              // That pair is the unmanaged-exposure state: amends and closes
              // cannot be routed to a roster-absent account, so its open
              // positions go unwatched under a capability reading `manage: true`.
              // Six of seven production accounts sat that way this morning,
              // holding 17 positions between them, and this push recreated it
              // every time the account list was sent.
              //
              // The role decides the MODE, which is the entry question and the
              // only one it was ever qualified to answer. Roster membership
              // follows the invariant instead: non-archived means managed.
              //
              // A PUSH MUST NOT ENLIST WHAT NOBODY ENGAGED (11-08-2026).
              //
              // The first version of the fix above wrote `enabled = 1` for every
              // account in the pushed list. That traded one over-reach for
              // another: measured on production the same day, all SEVEN accounts
              // came back `enabled = 1, connectivity: active`, including the two
              // flat live rows the boot repair had been deliberately narrowed to
              // leave alone. The repair was careful and this write was not, so
              // the careless one won.
              //
              // Only the AUTOPILOT ROLE is a statement of intent. An account
              // pushed without it is being described, not engaged, so this must
              // not drag it onto the roster — and must not overwrite a mode that
              // says it is off the roster on purpose (`archived` by the owner's
              // gesture, `registered` because discovery only ever registers).
              // The rule itself lives in account-capabilities.js so it can be
              // tested directly. This route has no HTTP-level harness, and a
              // test that re-implemented the rule here would have passed for
              // both of the over-wide versions that preceded it.
              const current = db.prepare('SELECT mode FROM accounts WHERE account_id = ?').get(String(a.accountId))?.mode
              const nextMode = modeForPushedEntry(current, !!a.autopilot)
              if (nextMode) {
                db.prepare('UPDATE accounts SET enabled = ?, mode = ?, updated_at = ? WHERE account_id = ?')
                  .run(enabledForMode(nextMode) ? 1 : 0, nextMode, new Date().toISOString(), String(a.accountId))
              }
            }
          } catch (e) { console.warn('[actions/ctrader-config] registry mirror failed (non-fatal):', e.message) }
        }).catch(() => {})

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
  router.post('/symbols', async (req, res) => {
    try {
      // `account` scopes the write to ONE account's list. Absent → the shared
      // list, exactly as before, so every existing caller keeps working.
      //
      // WRITING AN ACCOUNT'S LIST ENDS ITS INHERITANCE, permanently: from here
      // it no longer follows edits to the shared list (services/watchlists.js
      // readWatchlist). That is inherent to owning a list, and the UI says so
      // before the first write rather than leaving it to be discovered when a
      // globally-added symbol fails to appear.
      const { symbols, account } = req.body || {}
      if (!symbols || !Array.isArray(symbols)) {
        return res.status(400).json({ error: 'Missing required field: symbols (array)' })
      }
      const acct = account == null || account === '' ? null : String(account)
      // A per-symbol `strategies` pick is VALIDATED against the registry, not
      // trusted. The pick narrows what may trade the symbol, so a typo'd key
      // ('cup_handel') would intersect to nothing and silently stop the symbol
      // trading altogether — a config that looks set and does the opposite of
      // what it reads. Naming the bad keys back is cheap; the UI sends them
      // from the registry, so this only ever fires on a hand-rolled call.
      const badKeys = new Set()
      for (const s of symbols) {
        if (s && typeof s === 'object' && Array.isArray(s.strategies)) {
          for (const k of s.strategies) if (!STRATEGY_KEYS.includes(String(k))) badKeys.add(String(k))
        }
      }
      if (badKeys.size) {
        return res.status(400).json({
          error: `Unknown strategy key(s): ${[...badKeys].join(', ')}. Known: ${STRATEGY_KEYS.join(', ')}`,
        })
      }

      const normalized = symbols.map(s => {
        if (typeof s === 'string') {
          return { symbol: s.toUpperCase().trim(), enabled: true }
        }
        const out = {
          ...s,
          symbol: (s.symbol || '').toUpperCase().trim(),
          enabled: s.enabled !== false,
        }
        // An empty pick means "follow the global armed set" — store it as
        // absent so the two ways of saying that cannot drift apart.
        if (Array.isArray(out.strategies) && out.strategies.length === 0) delete out.strategies
        return out
      })
      // Previously-watched record (owner 2026-07-28: a card of symbols that
      // USED to be on the list, with one-tap re-add). Diff old vs new here —
      // every watchlist write funnels through this route, so removals are
      // caught regardless of which UI gesture caused them. Newest first,
      // capped at 100; re-adding a symbol clears its entry.
      // Removal history follows the same scope as the list it describes — a
      // shared key would show one account's removals on another's card.
      const histKey = acct ? `acct:${acct}:watchlist_removed_json` : 'watchlist_removed_json'
      let forked = false
      try {
        const { readWatchlist, hasOwnWatchlist } = await import('../services/watchlists.js')
        if (acct) forked = !hasOwnWatchlist(db, acct)
        // On the FORKING write there is no prior list belonging to this
        // account, so nothing was "removed" from it — the symbols it is not
        // carrying over were only ever inherited. Recording them would fill
        // the one-tap re-add card with instruments this account never chose.
        const prev = forked ? [] : (acct
          ? readWatchlist(db, acct)
          : (() => { try { return JSON.parse(getState(db, 'autopilot_symbols_json') || '[]') || [] } catch { return [] } })())
        const now = new Set(normalized.map(s => s.symbol))
        const removed = prev
          .map(s => (typeof s === 'string' ? { symbol: s } : s))
          .filter(s => s.symbol && !now.has(String(s.symbol).toUpperCase().trim()))
        if (removed.length || now.size) {
          let hist = []
          try { hist = JSON.parse(getState(db, histKey) || '[]') || [] } catch { hist = [] }
          const at = new Date().toISOString()
          const fresh = removed.map(s => ({ symbol: String(s.symbol).toUpperCase().trim(), group: s.group || null, removedAt: at }))
          const seen = new Set(fresh.map(s => s.symbol))
          const kept = hist.filter(h => !seen.has(h.symbol) && !now.has(h.symbol))
          setState(db, histKey, JSON.stringify([...fresh, ...kept].slice(0, 100)))
        }
      } catch { /* history is best-effort — never blocks the save */ }
      if (acct) {
        const { writeWatchlist } = await import('../services/watchlists.js')
        writeWatchlist(db, acct, normalized)
        console.log(`[actions] Watchlist updated for account ${acct}${forked ? ' (now has its OWN list — no longer inherits the shared one)' : ''}:`, normalized.map(w => w.symbol).join(', '))
      } else {
        setState(db, 'autopilot_symbols_json', JSON.stringify(normalized))
        console.log('[actions] Autopilot symbols updated:', normalized.map(w => w.symbol).join(', '))
      }
      res.json({ ok: true, symbols: normalized, account: acct, forked })
    } catch (err) {
      console.error('[actions/symbols] error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/watchlist-copy — copy symbols from one account to others.
  // Body: { from, to: [], symbols?: [], mode?: 'merge'|'replace' }
  //
  // This decides which instruments an account may trade, so it is a config
  // write on the money path, not a display preference. Two consequences are
  // deliberate: `replace` is destructive and must be asked for by name, and
  // the response reports per destination what was added, updated and REMOVED
  // — "ok: true" alone would not let anyone check what just happened.
  //
  // A destination that was inheriting the shared list keeps everything it was
  // already trading and gains the copied symbols; `inherited: true` in its
  // result says the inheritance has now ended.
  // -----------------------------------------------------------------------
  router.post('/watchlist-copy', async (req, res) => {
    try {
      const { copyWatchlist } = await import('../services/watchlists.js')
      const { from, to, symbols = null, mode = 'merge' } = req.body || {}
      const report = copyWatchlist(db, { from, to, symbols, mode })
      for (const r of report.results) {
        console.log(`[actions] watchlist-copy ${report.from} → ${r.accountId} (${report.mode})`
          + ` +${r.added.length} ~${r.updated.length} -${r.removed.length} = ${r.total}`
          + (r.inherited ? ' [was inheriting the shared list]' : ''))
      }
      res.json({ ok: true, ...report })
    } catch (err) {
      console.error('[actions/watchlist-copy] error:', err.message)
      // A bad account id or an empty selection is the caller's mistake, not a
      // server fault — 400 so the UI can show the reason instead of "failed".
      res.status(400).json({ error: err.message })
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
      const allowed = Object.keys(DEFAULT_RISK_CONFIG)
      // Per-account OVERLAY (owner 02-08-2026: elevated risk on the two
      // >$50k demo accounts). body.accountId scopes the write to
      // `acct:<id>:risk_config_json` — a PARTIAL config merged over the
      // global one for that account only. reset:true clears the overlay,
      // returning the account to global limits.
      if (body.accountId != null) {
        const acctId = String(body.accountId)
        const key = `acct:${acctId}:risk_config_json`
        if (body.reset === true) {
          setState(db, key, null)
          console.log(`[actions] Risk overlay CLEARED for account ${acctId}`)
          return res.json({ ok: true, accountId: acctId, overlay: null, effective: loadRiskConfig(db, acctId) })
        }
        let overlay = {}
        try { overlay = JSON.parse(getState(db, key) || '{}') || {} } catch { overlay = {} }
        const beforeOverlay = { ...overlay }
        for (const k of allowed) {
          if (k in body) overlay[k] = body[k]
        }
        setState(db, key, JSON.stringify(overlay))
        noteRiskConfigChanges(db, beforeOverlay, overlay, { accountId: acctId, by: 'manual' })
        console.log(`[actions] Risk overlay updated for account ${acctId}:`, overlay)
        return res.json({ ok: true, accountId: acctId, overlay, effective: loadRiskConfig(db, acctId) })
      }
      if (body.reset === true) {
        setState(db, 'risk_config_json', null)
        return res.json({ ok: true, effective: DEFAULT_RISK_CONFIG })
      }
      const current = loadRiskConfig(db)
      const next = { ...current }
      for (const k of allowed) {
        if (k in body) next[k] = body[k]
      }
      setState(db, 'risk_config_json', JSON.stringify(next))
      // WHEN did each field last actually change? The Risk page's summary
      // claimed "the settings below hold these values now" without ever
      // reading them back, so a field edited after an apply left the row
      // asserting a number that was no longer there.
      noteRiskConfigChanges(db, current, next, { by: 'manual' })
      console.log('[actions] Risk config updated:', next)
      res.json({ ok: true, effective: next })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/concentrate-apply — the concentrate-to-prove change, whole.
  //
  // Body: { account, dryRun?: true, campaignPct?: 0.08, startAt?: <now>,
  //         label?: 'concentrate-to-prove', strategies?: [...] }
  //
  // DRY RUN BY DEFAULT. This replaces an account's tradable universe and arms
  // a multi-day loss limit in one call; both are config writes on the money
  // path. `dryRun: false` has to be typed, and the response of a dry run is
  // exactly the plan the real call would execute — same object, computed the
  // same way — so the review is of the thing itself and not a description.
  //
  // IT NEVER CLOSES A POSITION. The account's open-position overage is the
  // first thing blocking entries and it is reported first, with the number
  // that has to go, but closing realises P&L and stays with a human holding a
  // full-tier credential.
  //
  // The campaign anchors to the balance read HERE, at call time. Every written
  // figure for these accounts has gone stale within a day; a start equity
  // typed into a config file measures drawdown from a balance that never
  // existed, and the arithmetic looks perfect while doing it.
  // -----------------------------------------------------------------------
  router.post('/concentrate-apply', async (req, res) => {
    try {
      const { concentratePlan, CONCENTRATE_SYMBOLS, CONCENTRATE_STRATEGIES } =
        await import('../services/concentrate-plan.js')
      const { readWatchlist, writeWatchlist } = await import('../services/watchlists.js')
      const { getAccountBalance } = await import('../services/risk.js')

      const body = req.body || {}
      const acct = body.account == null || body.account === '' ? null : String(body.account)
      if (!acct) {
        // No account means the SHARED list, which every account without its
        // own list inherits. Concentrating one account by editing the list
        // five others read from is the opposite of concentrating.
        return res.status(400).json({ error: 'account is required — this change is scoped to ONE account by design' })
      }
      const dryRun = body.dryRun !== false
      const strategies = Array.isArray(body.strategies) && body.strategies.length
        ? body.strategies.map(String)
        : [...CONCENTRATE_STRATEGIES]
      const bad = strategies.filter(k => !STRATEGY_KEYS.includes(k))
      if (bad.length) {
        return res.status(400).json({ error: `Unknown strategy key(s): ${bad.join(', ')}. Known: ${STRATEGY_KEYS.join(', ')}` })
      }

      const cfg = loadRiskConfig(db, acct)
      const openPositions = db
        .prepare(`SELECT COUNT(*) AS n FROM monitored_positions
                  WHERE status = 'active' AND (account_id = ? OR account_id IS NULL)`)
        .get(acct)?.n ?? null
      const plan = concentratePlan({
        current: readWatchlist(db, acct),
        equity: getAccountBalance(db, acct),
        openPositions,
        maxOpenPositions: cfg.maxOpenPositions,
        startAt: typeof body.startAt === 'string' ? body.startAt : new Date().toISOString(),
        campaignPct: body.campaignPct == null ? 0.08 : Number(body.campaignPct),
        label: body.label || 'concentrate-to-prove',
        strategies,
      })

      if (dryRun) {
        return res.json({ ok: true, dryRun: true, account: acct, applied: null, plan })
      }

      // A plan whose campaign could not be built is not applied HALFWAY. The
      // watchlist swap raises trade frequency; the campaign is the limit that
      // makes the higher frequency survivable. Shipping the first without the
      // second is the exact trade nobody would agree to if asked.
      if (!plan.campaign) {
        return res.status(409).json({
          ok: false, account: acct, plan,
          error: 'campaign could not be armed (equity, percentage or start time unreadable) — nothing was written, '
            + 'because the watchlist change increases trade frequency and the campaign is what bounds it',
        })
      }

      const symbols = CONCENTRATE_SYMBOLS.map(s => ({ symbol: s.symbol, enabled: true, group: s.group, strategies }))
      writeWatchlist(db, acct, symbols)

      const key = `acct:${acct}:risk_config_json`
      let overlay = {}
      try { overlay = JSON.parse(getState(db, key) || '{}') || {} } catch { overlay = {} }
      const beforeOverlay = { ...overlay }
      overlay.campaign = plan.campaign
      setState(db, key, JSON.stringify(overlay))
      noteRiskConfigChanges(db, beforeOverlay, overlay, { accountId: acct, by: 'concentrate-apply' })
      invalidateStateCache()

      console.log(`[actions/concentrate-apply] account ${acct}: ${symbols.length} symbols, `
        + `${strategies.join('/')}, campaign ${(plan.campaign.maxDrawdownPct * 100).toFixed(2)}% of `
        + `${plan.campaign.startEquity} = ${plan.budgetUsd}`)

      res.json({
        ok: true, dryRun: false, account: acct, plan,
        applied: { symbols: symbols.length, strategies, campaign: plan.campaign, budgetUsd: plan.budgetUsd },
        effective: loadRiskConfig(db, acct),
        // Repeated at the top level because it is the one thing still owed and
        // the one thing this route deliberately did not do.
        stillBlocked: plan.blocker.blocked ? plan.blocker.reason : null,
      })
    } catch (err) {
      console.error('[actions/concentrate-apply] error:', err.message)
      res.status(500).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/risk-reassess — "Re-Risk". Ask a CHOSEN LLM to re-derive the
  // risk limits for the selected account, from its balance and its actual
  // closed-trade record, optionally with its watchlist in mind.
  //
  // Body: { provider: 'openai'|'anthropic', model: string,
  //         includeWatchlist?: boolean }
  //
  // PROPOSES ONLY — nothing is written to risk_config_json here. See the note
  // at the top of services/risk-reassess.js: these are the money limits, and
  // one hallucinated decimal would be enforced faithfully by the risk gate.
  // The Risk page applies whatever the owner accepts via /actions/risk-config.
  // -----------------------------------------------------------------------
  router.post('/risk-reassess', async (req, res) => {
    try {
      const { provider, model, includeWatchlist } = req.body || {}
      if (!['openai', 'anthropic'].includes(String(provider))) {
        return res.status(400).json({ error: "provider must be 'openai' or 'anthropic'" })
      }
      if (!String(model || '').trim()) {
        return res.status(400).json({ error: 'model is required — type the model name' })
      }
      // THE FIFTH LLM CONSUMER, and until now the only ungated one. Every
      // other messages.create in the tree sits behind llmBlocked — the monitor,
      // the weekend watch, cockpit explain, screener search — so with the
      // switch on, this button was the one path that still called out and
      // still spent. One manual press rather than ~1,900 passes a day, so the
      // money was small; the problem was that the boot banner announced "no
      // LLM calls will be attempted" over the top of it. A report more
      // reassuring than the code it describes is the defect this file keeps
      // producing, and an absolute claim with a known exception is the worst
      // version of it.
      //
      // 503 and the reason, matching /screener-search: nothing failed, the
      // capability is switched off, and the caller should be told which
      // switch is holding it rather than shown a model error.
      const { llmBlocked } = await import('../lib/llm-switch.js')
      const gate = await llmBlocked(db, getState)
      if (gate.blocked) {
        return res.status(503).json({ error: `LLM layer unavailable — ${gate.reason}` })
      }
      const { runReassessment } = await import('../services/risk-reassess.js')
      const accountId = getState(db, 'ctrader_account_id') || null
      const result = await runReassessment(db, {
        provider: String(provider),
        model: String(model).trim(),
        includeWatchlist: includeWatchlist === true,
        accountId,
      })
      // Audit trail: WHICH model was asked, with what scope, and how many
      // changes it proposed. The proposals themselves live in agent_state.
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
          'RISK_REASSESS', '/risk-reassess', JSON.stringify({
            provider: result.provider, model: result.model,
            includeWatchlist: result.includeWatchlist, watchlistCount: result.watchlistCount,
            proposals: result.proposals.length, accountId: result.accountId,
          }))
      } catch { /* the assessment itself is stored; a missing log line is not fatal */ }
      res.json({ ok: true, result })
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // POST /actions/risk-reassess-apply — apply SELECTED proposals from the last
  // reassessment. Body: { keys: string[], at: string }. Anything not in the
  // stored proposal set, or not proposable, is refused rather than guessed at.
  //
  // `at` BINDS THE REQUEST TO THE ASSESSMENT THE OWNER ACTUALLY READ. Without
  // it the request carried only key names, so if a second run completed in
  // another tab (or from another device) between rendering the proposals and
  // clicking Apply, this route would look up the NEWER assessment and apply
  // *its* values under the same key names — different numbers than the ones
  // reviewed and ticked, silently, on the money limits. Caught in review on
  // PR #499. A mismatch is a 409: re-read the current proposals and decide
  // again, rather than have a stale intent resolved against fresh values.
  router.post('/risk-reassess-apply', async (req, res) => {
    try {
      const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : []
      if (keys.length === 0) return res.status(400).json({ error: 'keys[] is required' })
      const at = String(req.body?.at || '')
      if (!at) return res.status(400).json({ error: 'at (the assessment timestamp being applied) is required' })
      const { loadLastAssessment, markApplied, PROPOSABLE } = await import('../services/risk-reassess.js')
      const last = loadLastAssessment(db)
      if (!last) return res.status(400).json({ error: 'no reassessment has been run yet' })
      if (last.at !== at) {
        return res.status(409).json({
          error: 'this assessment has been superseded by a newer run — reload the proposals and choose again',
          displayed: at, current: last.at,
        })
      }
      const byKey = new Map(last.proposals.map(p => [p.key, p]))
      const patch = {}
      const refused = []
      for (const k of keys) {
        if (!(k in PROPOSABLE)) { refused.push({ key: k, why: 'not a proposable setting' }); continue }
        const p = byKey.get(k)
        if (!p) { refused.push({ key: k, why: 'not part of the last assessment' }); continue }
        patch[k] = p.proposed
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'nothing applicable', refused })
      }
      // Merge into the RAW overrides, not the effective config: spreading
      // loadRiskConfig() here materialised every DEFAULT as an override, so
      // one apply turned all ~27 settings permanently "overridden" (the
      // default-dot marks went wrong, and future default changes could never
      // reach this install).
      let rawOverrides = {}
      try { rawOverrides = JSON.parse(getState(db, 'risk_config_json') || '{}') || {} } catch { rawOverrides = {} }
      const beforeEffective = loadRiskConfig(db)
      setState(db, 'risk_config_json', JSON.stringify({ ...rawOverrides, ...patch }))
      noteRiskConfigChanges(db, beforeEffective, { ...beforeEffective, ...patch }, { by: 'reassess' })
      markApplied(db, Object.keys(patch))
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
          'RISK_REASSESS_APPLY', '/risk-reassess-apply', JSON.stringify({ patch, refused }))
      } catch { /* non-fatal */ }
      console.log('[actions] risk reassessment applied:', patch)
      res.json({ ok: true, applied: patch, refused, effective: loadRiskConfig(db) })
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
  router.post('/reset-breaker', async (_req, res) => {
    setState(db, 'circuit_breaker_tripped_at', null)
    // Clears errors_today, last_error and the recent-errors ring together —
    // a cleared counter beside a stale cause list is the defect this fixes.
    clearErrorLog(db)
    try {
      const { resetCircuitBreaker } = await import('../loop.js')
      resetCircuitBreaker()
    } catch (err) {
      console.log('[actions] reset-breaker: in-process counter reset failed (non-fatal):', err.message)
    }
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
        setState(db, 'last_scan_at', null)
        clearErrorLog(db)
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

      const proposal = { symbol: analysis.symbol, side, entry, sl, tp1, requestedVolume: requestedVol, strategy: analysis.strategy, conviction: analysis.overall_conviction, source: 'execute_analysis', accountId }
      // This route places against the same `accountId` it read above, so
      // naming it here is what makes the gate and the order agree rather
      // than agreeing by coincidence.
      const riskResult = evaluateTrade(db, proposal, loadRiskConfig(db, accountId))
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
        ...(await import('../lib/order-protection.js')).stopTriggerField(loadRiskConfig(db)),
      }

      // PHASE 4 (owner-approved 2026-07-31): this route used to call
      // wsPlaceOrder directly, which meant it obeyed the exec guard (5A patched
      // that in by hand) but skipped validateOrderBracket and never reached the
      // C++ engine even when EXEC_ENGINE=cpp. naked-position-guard.js already
      // tells the owner that "an order placed through the bot could not have
      // been submitted this way (guard_no_target)" — which was untrue for this
      // route and the manual-trade route below. Going through execPlaceOrder
      // makes that claim true and gives every write ONE contract. The explicit
      // validateExecGuard call is now redundant (the chokepoint runs it first)
      // but is kept so a guard veto still lands in risk_events with the
      // proposal attached, which the thrown-error path cannot do.
      const host = isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
      const gv1 = validateExecGuard(orderPayload, getCtraderCreds(db).execGuard)
      if (!gv1.ok) {
        persistRiskEvent(db, proposal, { approved: false, veto_reason: gv1.reason })
        return res.json({ ok: false, vetoed: true, reason: gv1.reason })
      }
      let exec
      try {
        exec = await execPlaceOrder(
          { ...getCtraderCreds(db), host, clientId, clientSecret, accessToken, accountId },
          orderPayload)
      } catch (err) {
        // A guard_* refusal is a veto, not a server fault: record it against the
        // proposal and answer in the same shape as every other veto here.
        if (!/^guard_/.test(err.message)) throw err
        persistRiskEvent(db, proposal, { approved: false, veto_reason: err.message })
        // Owner 2026-07-31: name the symbol and the missing leg rather than
        // returning a bare guard_* string. `needsInput` tells the caller which
        // field to ask for; it is advice, never an automatic fill.
        const needsInput = describeBracketGap(err.message, {
          symbol: analysis.symbol, side, entry, sl, tp: tp1, digits: volMeta.digits,
          strategy: analysis.strategy, minRR: loadRiskConfig(db).minRR,
        })
        return res.json({ ok: false, vetoed: true, reason: err.message, ...(needsInput ? { needsInput } : {}) })
      }
      setState(db, 'api_ctrader_last_ok', new Date().toISOString())

      const executionPrice = exec?.deal?.executionPrice || exec?.position?.price || null
      const positionId = normPosId(exec?.position?.positionId ?? exec?.deal?.positionId)

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
            ctrader_position_id, label_raw, label_strategy, label_conviction, label_session, source, status,
            origin, origin_source)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, 'manual', 'open',
                  'manual_broker', 'write')
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
      //
      // HVN-TP (spec §4, owner ruling (b) 01-08): the SAME fetch also brings
      // 240 15m bars (~2.5 days) so a guard_no_target refusal can offer the
      // volume-structure TP candidate. Widening a fetch this route already
      // makes — not a new one; a manual trade is human-initiated, so the
      // extra weight is per-click, not per-loop.
      const barsByTf = await wsGetTrendbarsBatch(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId, ['1m', '15m'], 240)
      const m1 = barsByTf['1m'] || []
      const hvnBars = barsByTf['15m'] || []
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
        accountId: creds?.accountId ?? null,
      }
      const riskResult = evaluateTrade(db, proposal, loadRiskConfig(db, creds?.accountId ?? null))
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
        ...(await import('../lib/order-protection.js')).stopTriggerField(loadRiskConfig(db)),
      }

      // PHASE 4: same reasoning as the execute-analysis route above — one
      // contract for every broker write. This one always attaches a stop, but
      // its take profit is conditional on proposal.tp1, so before this change a
      // TP-less manual trade reached the broker despite guard_no_target.
      const gv2 = validateExecGuard(orderPayload, creds.execGuard)
      if (!gv2.ok) {
        persistRiskEvent(db, proposal, { approved: false, veto_reason: gv2.reason })
        return res.json({ ok: false, vetoed: true, reason: gv2.reason })
      }
      let exec
      try {
        exec = await execPlaceOrder(creds, orderPayload)
      } catch (err) {
        if (!/^guard_/.test(err.message)) throw err
        persistRiskEvent(db, proposal, { approved: false, veto_reason: err.message })
        const needsInput = describeBracketGap(err.message, {
          symbol, side, entry, sl: proposal.sl, tp: proposal.tp1, digits: volMeta.digits,
          strategy: 'manual', minRR: loadRiskConfig(db).minRR,
          // HVN-TP: the 15m bars fetched above — the advice computes the
          // volume-structure TP candidate on the trade's own timeframe.
          bars: hvnBars,
        })
        return res.json({ ok: false, vetoed: true, reason: err.message, ...(needsInput ? { needsInput } : {}) })
      }
      setState(db, 'api_ctrader_last_ok', new Date().toISOString())
      const executionPrice = exec?.deal?.executionPrice || exec?.position?.price || null
      const positionId = normPosId(exec?.position?.positionId ?? exec?.deal?.positionId)
      const entryP = executionPrice ?? entry
      const parsedLabel = parseLabel(structuredLabel)

      db.transaction(() => {
        const tradeInsert = db.prepare(`
          INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume, opened_at,
            ctrader_position_id, label_raw, label_strategy, label_conviction, label_session, source, status,
            origin, origin_source)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, 'manual', 'open',
                  'manual_broker', 'write')
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

  // -----------------------------------------------------------------------
  // POST /actions/sessions/:sessionId/revoke — disconnect ANOTHER browser
  // session (instr/footer_issue.md).
  //
  // Sits in /actions/* on purpose: that namespace is write-tier under the D12
  // two-tier auth, so a read-only device token cannot revoke anything.
  //
  // The rules the brief is emphatic about, and where each is enforced:
  //   * self-revocation is impossible          → revokeSession(), 409
  //   * the current session is identified from the server's own view of the
  //     request, never a client flag           → actorToken below
  //   * idempotent                             → 'already' maps to 200
  //   * rate limited                           → REVOKE_WINDOW below
  //   * audit logged, including rejected self-revokes → audit() in the service
  //   * success only after the server has acted → we answer from the result
  // -----------------------------------------------------------------------
  const revokeHits = []
  const REVOKE_WINDOW_MS = 60_000
  const REVOKE_MAX = 10
  router.post('/sessions/:sessionId/revoke', async (req, res) => {
    try {
      const now = Date.now()
      while (revokeHits.length && now - revokeHits[0] > REVOKE_WINDOW_MS) revokeHits.shift()
      if (revokeHits.length >= REVOKE_MAX) {
        return res.status(429).json({ error: 'Too many revocation attempts — wait a minute' })
      }
      revokeHits.push(now)

      const { revokeSession } = await import('../services/browser-sessions.js')
      const { dropTabsForSession } = await import('../services/client-presence.js')
      const bearer = String(req.headers.authorization || '').startsWith('Bearer ')
        ? String(req.headers.authorization).slice(7)
        : ''
      // The master secret is not a device session, so it has no id to compare
      // against — but it must still not be able to sidestep self-protection by
      // revoking whatever session it happens to be riding. Passing the bearer
      // through unchanged means the hash comparison in revokeSession() does
      // the right thing either way.
      const result = revokeSession(db, {
        sessionId: req.params.sessionId,
        actorToken: bearer,
        reason: String(req.body?.reason || 'user_requested').slice(0, 120),
        dropTabs: dropTabsForSession,
      })

      if (result.code === 'self') {
        // 409 Conflict, exactly as specified — "Return HTTP 409 or another
        // suitable conflict response if a direct self-revoke request reaches
        // the server."
        return res.status(409).json({
          error: 'This is the session you are using — it cannot disconnect itself.',
          code: 'self_revoke_forbidden',
        })
      }
      if (result.code === 'not_found') {
        return res.status(404).json({ error: 'No such session', code: 'not_found' })
      }
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}
