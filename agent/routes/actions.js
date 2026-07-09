// ---------------------------------------------------------------------------
// agent/routes/actions.js — POST endpoints for manual triggers
// ---------------------------------------------------------------------------

import { Router } from 'express'
import { getState, setState } from '../db.js'
import { runFibScan, synthesizeFibSignal, scanSymbolFib } from '../services/fib-strategy.js'
import { getCtraderCreds, getSymbolMap, ensureSymbolMap } from '../lib/ctrader-creds.js'
import { ctraderEnv } from '../lib/ctrader-env.js'
import { DEFAULT_RISK_CONFIG, loadRiskConfig, evaluateTrade, persistRiskEvent } from '../services/risk.js'
import { wsPlaceOrder, wsGetTrendbarsBatch } from '../lib/ctrader-ws.js'
import { getActiveSessions } from '../lib/sessions.js'
import { encodeLabel, parseLabel, convictionBucket, LABEL_VERSION } from '../lib/trade-labels.js'
import { parseTimeframe } from '../lib/timeframes.js'
import { getVolumeMeta, lotsToVolume } from '../lib/lot-sizing.js'

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
  return [...new Set(names.map(s => String(s).toUpperCase().trim()).filter(Boolean))].slice(0, 8)
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
      const strategy = req.body?.strategy === 'cup_handle' ? 'cup_handle' : 'fib_618_fade'

      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const map = await ensureSymbolMap(db, creds)

      const { runBacktest, walkForward } = await import('../scripts/backtest-fib.js')
      const { host, clientId, clientSecret, accessToken, accountId } = creds

      const symbols = {}
      for (const name of names) {
        const symbolId = map[name]
        if (!symbolId) {
          symbols[name] = { error: 'not offered by this broker account' }
          continue
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
              // mirror live autotrade's conviction bar unless the caller overrides
              minConviction: req.body?.minConviction != null ? Number(req.body.minConviction) : 8,
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
      const payload = { symbols, bars: count, rsiFilter: !!rsiFilter, vwapFilter: !!vwapFilter, fvgFilter: !!fvgFilter, sessionFilter, strategy, ranAt: new Date().toISOString() }
      // Persist a self-contained HTML report under backtest/results/ and hand
      // the same document to the UI for a browser download. A write failure
      // (read-only disk) must not sink the backtest itself.
      try {
        const { saveBacktestReport } = await import('../lib/backtest-report.js')
        payload.report = saveBacktestReport(payload)
      } catch (err) {
        payload.report = { error: err.message }
      }
      res.json(payload)
    } catch (err) {
      res.status(502).json({ error: err.message })
    }
  })

  // -----------------------------------------------------------------------
  // POST /actions/cup-handle-toggle — arm/disarm the SEPARATE Cup & Handle
  // strategy in the scan loop (fib fade is untouched by this flag).
  // -----------------------------------------------------------------------
  router.post('/cup-handle-toggle', (req, res) => {
    const on = !!req.body?.on
    setState(db, 'cup_handle_enabled', on ? 'true' : 'false')
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
      const rows = []
      for (const name of names) {
        const symbolId = map[name]
        if (!symbolId) { rows.push({ symbol: name, error: 'not offered by this broker account' }); continue }
        try {
          const fetched = await wsGetTrendbarsBatch(host, clientId, clientSecret, accessToken, accountId, symbolId, ['1d'], 260, 60_000)
          rows.push({ symbol: name, ...screenBars(fetched['1d'] || [], opts) })
        } catch (err) {
          rows.push({ symbol: name, error: err.message })
        }
      }
      res.json({
        rows,
        passed: rows.filter(r => r.pass).map(r => r.symbol),
        manualChecks: 'Not in broker data — check on your stock screener: P/E < 30, optionable/shortable, leading sector.',
        ranAt: new Date().toISOString(),
      })
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
  // Body: { symbol, timeframe='1h', bars=120 }
  // -----------------------------------------------------------------------
  router.post('/chart', async (req, res) => {
    try {
      const symbol = String(req.body?.symbol || '').toUpperCase()
      const timeframe = String(req.body?.timeframe || '1h')
      const count = Math.min(300, Math.max(30, Number(req.body?.bars) || 120))
      if (!symbol) return res.status(400).json({ error: 'symbol required' })

      const creds = getCtraderCreds(db)
      if (!creds.ready) return res.status(400).json({ error: 'cTrader not connected' })
      const symbolId = (await ensureSymbolMap(db, creds))[symbol]
      if (!symbolId) return res.status(404).json({ error: `Unknown symbol ${symbol} — not offered by this broker account` })

      const { host, clientId, clientSecret, accessToken, accountId } = creds
      const byPeriod = await wsGetTrendbarsBatch(host, clientId, clientSecret, accessToken, accountId, symbolId, [timeframe], count)
      const bars = byPeriod[timeframe] || []
      if (bars.length === 0) return res.status(502).json({ error: 'Broker returned no bars' })

      // Fib overlay from the same bars (closed bars only, like the scanner)
      let fib = null
      try {
        const { computeFibSignal } = await import('../services/fib-strategy.js')
        fib = computeFibSignal(bars.slice(0, -1), timeframe, {})
      } catch { /* overlay optional */ }

      res.json({
        symbol,
        timeframe,
        bars: bars.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c })),
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
        extraTimeframes,
      }

      // Scan every enabled symbol for a live setup, then rank by conviction.
      const candidates = []
      for (const w of watchlist.slice(0, 15)) {
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
      const { wsReconcile, wsSymbolsByIds, wsGetSymbolsList, wsGetLastCloses, wsGetTrader, wsGetAssets } = await import('../lib/ctrader-ws.js')

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

          // Deposit currency: trader.depositAssetId resolved via the asset list
          try {
            const [trader, assets] = await Promise.all([
              wsGetTrader(host, clientId, clientSecret, accessToken, acct.accountId),
              wsGetAssets(host, clientId, clientSecret, accessToken, acct.accountId),
            ])
            const asset = (assets.asset || []).find(a => a.assetId === trader.depositAssetId)
            out.currency = asset?.displayName || asset?.name || null
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
              sl: p.stopLoss ?? null,
              tp: p.takeProfit ?? null,
              swap: money(p.swap),
              commission: money(p.commission),
              usedMargin: money(p.usedMargin),
              openedAt: td.openTimestamp ?? null,
              label: td.label || null,
              comment: td.comment || null,
              guaranteedSl: !!p.guaranteedStopLoss,
            }
          })

          out.orders = rawOrders.map(o => {
            const td = o.tradeData || {}
            const meta = symMeta[td.symbolId] || {}
            return {
              orderId: o.orderId,
              type: orderTypeOf(o.orderType),
              symbol: meta.symbolName || `#${td.symbolId}`,
              side: sideOf(td.tradeSide),
              lots: toLots(td.volume, meta),
              minLot: toLots(meta.minVolume, meta),
              limitPrice: o.limitPrice ?? null,
              stopPrice: o.stopPrice ?? null,
              currentPrice: lastCloses[td.symbolId] ?? null,
              sl: o.stopLoss ?? null,
              tp: o.takeProfit ?? null,
              expiresAt: o.expirationTimestamp ?? null,
              label: td.label || null,
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
      res.json({ ok: true, accounts: results, fetchedAt: new Date().toISOString() })
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

      setState(db, 'ctrader_account_id', String(accountId))
      setState(db, 'ctrader_is_live', isLive ? 'true' : 'false')
      setState(db, 'ctrader_account_roles_json', JSON.stringify([{ accountId, isLive: !!isLive, autopilot: true }]))

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

      const proposal = { symbol: analysis.symbol, side, entry, sl, tp1, requestedVolume: requestedVol, strategy: analysis.strategy, conviction: analysis.overall_conviction }
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
        return res.json({ ok: false, vetoed: true, reason: `below_min_volume: ${volLots} lots < broker minimum (${volMeta.minVolume / volMeta.lotSize} lots)` })
      }
      const volume = sized.volume
      const slDistance = sl && entry ? Math.abs(entry - sl) : null
      const tpDistance = tp1 && entry ? Math.abs(tp1 - entry) : null
      const POINTS = 100000

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
        ...(slDistance ? { relativeStopLoss: Math.round(slDistance * POINTS) } : {}),
        ...(tpDistance ? { relativeTakeProfit: Math.round(tpDistance * POINTS) } : {}),
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
            thesis, initial_risk, invalidation_trigger, time_cap_at, strategy, source, label_raw, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 'active')
        `).run(analysis.symbol, tradeId, side, entryP, sl, tp1,
          analysis.consensus_summary || '', initialRisk,
          synth.invalidation_trigger || analysis.invalidation_trigger || null,
          timeCap, analysis.strategy, structuredLabel)
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
        return res.json({ ok: false, vetoed: true, reason: `below_min_volume: ${volLots} lots < broker minimum (${volMeta.minVolume / volMeta.lotSize} lots)` })
      }
      const POINTS = 100000
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
        relativeStopLoss: Math.round(slDistance * POINTS),
        ...(tpDistance ? { relativeTakeProfit: Math.round(tpDistance * POINTS) } : {}),
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
            thesis, initial_risk, strategy, source, label_raw, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'manual', ?, 'active')
        `).run(symbol, tradeInsert.lastInsertRowid, side, entryP, proposal.sl, proposal.tp1,
          'Manual order via UI', Math.abs(entryP - proposal.sl), structuredLabel)
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
