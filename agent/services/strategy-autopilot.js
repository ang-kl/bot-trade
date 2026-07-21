// ---------------------------------------------------------------------------
// Strategy Autopilot — the evidence loop, automated (owner mode 2).
//
// Every ~24h it backtests EVERY registry strategy across the enabled
// watchlist and the autotrade timeframe ladder (walk-forward included),
// stores per-combo verdicts, and — in 'auto' mode — arms fresh GOs and
// disarms decayed combos, within hard guardrails:
//   · max N arming CHANGES per run (default 4); overflow becomes suggestions
//   · auto mode refuses to act on a LIVE account (announce + suggest only)
//   · every change is Telegram-announced and lands in action_log
//   · /pause, /killall, Disarm and the strategy toggles all outrank it
// Modes (agent_state autopilot_mode): 'off' (default) | 'suggest' | 'auto'.
//
// The DECISION step is a pure function (decideChanges) — unit-tested,
// no I/O — so the automation is auditable, not vibes.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { verdictFor } from '../lib/backtest-report.js'
import { backtestRemote } from '../lib/exec-engine.js'
import { tfMs } from '../lib/timeframes.js'
import { backtestStageStrategies } from './stage-matrix.js'
import { getActiveSessions } from '../lib/sessions.js'

const RUN_EVERY_MS = 22 * 3600_000 // legacy default (fallback only)
const BUSY_MS = 10 * 60_000        // US session — the action window
const CALM_MS = 30 * 60_000        // otherwise
const BARS = 1000

export function autopilotMode(db) {
  const m = getState(db, 'autopilot_mode')
  return m === 'auto' || m === 'suggest' ? m : 'off'
}

function hourInTz(tz) {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()))
  } catch { return null }
}

/**
 * Is the clock inside an "active" window that warrants the fast cadence? Pure —
 * the caller injects the current sessions + Tokyo hour so it's unit-testable.
 * Two owner windows:
 *   · US: Chicago/NY open until Sydney opens (NY session live, or the thin
 *     NY→Sydney handover before Asia opens).
 *   · JPN225: premarket 1h + first 4 trading hours → 08:00–13:00 JST.
 */
export function isBusyWindow(sessionLabels = [], tokyoHour = null) {
  const nyActive = sessionLabels.includes('New York')
  const asiaOpen = sessionLabels.includes('Sydney') || sessionLabels.includes('Tokyo') || sessionLabels.includes('Singapore')
  const usBusy = nyActive || (sessionLabels.length === 0 && !asiaOpen)
  const jpnBusy = tokyoHour != null && tokyoHour >= 8 && tokyoHour < 13
  return usBusy || jpnBusy
}

/**
 * Re-run cadence. An explicit autopilot_interval_ms (≥ 5 min) overrides;
 * otherwise SESSION-ADAPTIVE (owner): every 10 min inside a busy window
 * (see isBusyWindow), every 30 min otherwise.
 */
export function autopilotIntervalMs(db, opts = {}) {
  const override = Number(getState(db, 'autopilot_interval_ms'))
  if (Number.isFinite(override) && override >= 300_000) return override
  const labels = (opts.sessions ?? getActiveSessions()).map(s => s.label)
  const tokyoHour = opts.tokyoHour ?? hourInTz('Asia/Tokyo')
  return isBusyWindow(labels, tokyoHour) ? BUSY_MS : CALM_MS
}

/**
 * Pure policy: compare latest verdicts with what is currently armed and
 * produce bounded change sets.
 *
 * @param {Array<{strategy,symbol,timeframe,state}>} verdicts - latest run
 * @param {{enabledStrategies:string[], autoMatrix:Object, pendingMatrix:Object}} current
 * @param {{maxChanges?:number}} opts
 * @returns {{arm:Array, disarm:Array, suggestions:Array}}
 *   arm/disarm entries: {kind:'strategy'|'matrix'|'pending', strategy, symbol?, timeframe?}
 */
export function decideChanges(verdicts, current, opts = {}) {
  const maxChanges = opts.maxChanges ?? 4
  // Strict ARMING bar (owner): a backtest "GO" (PF≥1.1) is too loose to put
  // real money on — it armed coin-flip combos like AUDUSD·4h (PF 1.50) that
  // lose. Only a PROVEN combo gets armed. Disarm still triggers on NO-GO, so a
  // GO-below-bar armed combo is kept, not churned (live results / the Edge
  // Watchdog handle decay). Thresholds are configurable.
  const armMinPf = opts.armMinPf ?? 1.7
  const armMinWin = opts.armMinWin ?? 60
  const armMinTrades = opts.armMinTrades ?? 25
  const armGrade = (v) => (v.pf ?? 0) >= armMinPf && (v.winRate ?? 0) >= armMinWin && (v.trades ?? 0) >= armMinTrades
  const arm = []
  const disarm = []
  const has = (m, sym, tf) => Array.isArray(m?.[sym]) && m[sym].includes(tf)

  const gos = verdicts.filter(v => v.state === 'go')       // any GO protects an existing arm from disarm
  const armGos = gos.filter(armGrade)                       // only these clear the bar to be NEWLY armed
  const nogos = verdicts.filter(v => v.state === 'no-go')

  // ARM: only combos that CLEAR THE BAR. close-confirm → strategy enable +
  // per-instrument matrix entry; touch (fib only) → pending matrix entry.
  for (const v of armGos) {
    if (v.entryMode === 'touch') {
      if (!has(current.pendingMatrix, v.symbol, v.timeframe)) {
        arm.push({ kind: 'pending', strategy: v.strategy, symbol: v.symbol, timeframe: v.timeframe })
      }
      continue
    }
    if (!current.enabledStrategies.includes(v.strategy)) {
      if (!arm.some(a => a.kind === 'strategy' && a.strategy === v.strategy)) {
        arm.push({ kind: 'strategy', strategy: v.strategy })
      }
    }
    if (!has(current.autoMatrix, v.symbol, v.timeframe)) {
      arm.push({ kind: 'matrix', strategy: v.strategy, symbol: v.symbol, timeframe: v.timeframe })
    }
  }

  // DISARM: armed combos whose latest verdict is NO-GO. (Thin/GO keep their
  // arms — absence of evidence is not evidence of decay.)
  for (const [sym, tfs] of Object.entries(current.autoMatrix || {})) {
    for (const tf of tfs) {
      if (nogos.some(v => v.entryMode !== 'touch' && v.symbol === sym && v.timeframe === tf)
        && !gos.some(v => v.entryMode !== 'touch' && v.symbol === sym && v.timeframe === tf)) {
        disarm.push({ kind: 'matrix', symbol: sym, timeframe: tf })
      }
    }
  }
  for (const [sym, tfs] of Object.entries(current.pendingMatrix || {})) {
    for (const tf of tfs) {
      if (nogos.some(v => v.entryMode === 'touch' && v.symbol === sym && v.timeframe === tf)
        && !gos.some(v => v.entryMode === 'touch' && v.symbol === sym && v.timeframe === tf)) {
        disarm.push({ kind: 'pending', symbol: sym, timeframe: tf })
      }
    }
  }

  // Cap: disarms first (safety cuts jump the queue), arms fill the rest.
  const changes = [...disarm.map(d => ({ ...d, action: 'disarm' })), ...arm.map(a => ({ ...a, action: 'arm' }))]
  const applied = changes.slice(0, maxChanges)
  const overflow = changes.slice(maxChanges)
  const strip = (c) => { const rest = { ...c }; delete rest.action; return rest }
  return {
    arm: applied.filter(c => c.action === 'arm').map(strip),
    disarm: applied.filter(c => c.action === 'disarm').map(strip),
    suggestions: overflow, // keeps `action` — the suggestion text needs it
  }
}

// Replica of fib-strategy.js timeCapFor (not exported there): fixed table for
// the classic set, else 24× the bar duration clamped to the table's range.
// Must stay in lockstep — the C++ sidecar receives this as capMinutes and has
// to match what the JS engine would have used.
const TIME_CAP_MINUTES = {
  '5m': 240, '15m': 480, '30m': 720, '1h': 1440, '4h': 4320, '1d': 20160,
  '1w': 60480, '1mo': 259200,
}
function timeCapFor(timeframe) {
  return TIME_CAP_MINUTES[timeframe]
    ?? Math.min(Math.max(Math.round((tfMs(timeframe) / 60_000) * 24), 240), 259_200)
}

// Fib fast-path: try the C++ sidecar's /backtest (one call returns trades,
// stats AND wf). Returns null when the sidecar is unavailable, disabled
// (js mode), or replies with a malformed body — caller falls back to JS.
async function tryRemoteFibBacktest(bars, tf, entryMode, remote) {
  try {
    const r = await remote({
      bars: bars.map(b => [b.t, b.o, b.h, b.l, b.c, b.v]),
      timeframe: tf,
      tfMinutes: tfMs(tf) / 60_000,
      capMinutes: timeCapFor(tf) ?? null,
      entryMode,
      minConviction: 8,
    })
    if (r && r.stats && Array.isArray(r.trades) && r.wf) return r
    return null
  } catch { return null }
}

async function evaluateAll(db, creds, deps) {
  const { wsGetTrendbarsBatch } = deps.ws ?? await import('../lib/ctrader-ws.js')
  const { runBacktest, walkForward } = deps.bt ?? await import('../scripts/backtest-fib.js')
  const { getSymbolMap } = deps.credsLib ?? await import('../lib/ctrader-creds.js')

  let watch = []
  try { watch = JSON.parse(getState(db, 'autopilot_symbols_json') || '[]').filter(w => w.enabled !== false).map(w => w.symbol) } catch { /* empty */ }
  let tfs = ['4h', '1d']
  try { const t = JSON.parse(getState(db, 'autotrade_timeframes') || '[]'); if (t.length) tfs = t } catch { /* default */ }
  const map = getSymbolMap(db)

  // Stage matrix "Back Test" column: the owner picks which strategies the
  // nightly sweep evaluates (all of them by default).
  const strategiesToTest = backtestStageStrategies(db, getState)

  // Rotate the 24-symbol window through the whole watchlist (owner: "based on
  // the selected symbols") so a large watchlist is fully covered over
  // successive runs instead of only ever testing the first 24.
  const WINDOW = 24
  let cursor = Number(getState(db, 'autopilot_scan_cursor')) || 0
  if (watch.length > 0) cursor %= watch.length
  const rotated = watch.length > WINDOW ? [...watch.slice(cursor), ...watch.slice(0, cursor)] : watch
  const batch = rotated.slice(0, WINDOW)
  if (watch.length > 0) setState(db, 'autopilot_scan_cursor', String((cursor + batch.length) % watch.length))

  const verdicts = []
  const errors = []
  for (const symbol of batch) {
    const symbolId = map[symbol.toUpperCase()]
    if (!symbolId) { errors.push(`${symbol}: no symbolId`); continue }
    let byPeriod
    try {
      byPeriod = await wsGetTrendbarsBatch(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId, tfs, BARS, 60_000)
    } catch (err) { errors.push(`${symbol}: ${err.message}`); continue }
    for (const tf of tfs) {
      const bars = (byPeriod[tf] || []).slice(0, -1)
      if (bars.length < 300) continue
      for (const strat of strategiesToTest) {
        const modes = strat.pendingCapable ? ['close', 'touch'] : ['close']
        for (const entryMode of modes) {
          try {
            const opts = { timeframe: tf, strategy: strat.key, entryMode, symbol }
            // Fib fast-path: the C++ sidecar runs the identical arithmetic
            // (parity-tested); null/throw falls back to the JS engine below.
            // deps.remote lets tests force the JS path (e.g. async () => null).
            const remoteResult = strat.key === 'fib_618_fade'
              ? await tryRemoteFibBacktest(bars, tf, entryMode, deps.remote ?? backtestRemote)
              : null
            const { stats, trades } = remoteResult ?? runBacktest(bars, opts)
            const wf = remoteResult ? remoteResult.wf : walkForward(bars, opts, 4)
            const row = { ...stats, wfActive: wf.active, wfPositive: wf.positive, wfWorstMddPct: wf.worstMddPct }
            const v = verdictFor(row)
            verdicts.push({
              strategy: strat.key, symbol, timeframe: tf, entryMode,
              state: v ? v.state : 'no-go',
              trades: stats.trades || 0, pf: stats.profitFactor ?? null,
              winRate: stats.winRatePct ?? null, total: stats.totalProfitPct ?? 0,
              wf: `${wf.positive}/${wf.active}`, wfActive: wf.active, wfPositive: wf.positive,
              wfWorstMddPct: wf.worstMddPct, maxDrawdownPct: stats.maxDrawdownPct ?? null,
              losses: stats.losses ?? null,
              // downsampled cumulative-return curve for the report's chart
              equity: (() => {
                let e = 0; const pts = trades.map(t => (e += t.pnlPct, Math.round(e * 100) / 100))
                const step = Math.max(1, Math.ceil(pts.length / 60))
                return pts.filter((_, i2) => i2 % step === 0 || i2 === pts.length - 1)
              })(),
            })
          } catch (err) { errors.push(`${symbol} ${tf} ${strat.key}/${entryMode}: ${err.message}`) }
        }
      }
    }
  }
  return { verdicts, errors }
}

function applyChanges(db, changes) {
  const readJson = (k, dflt) => { try { return JSON.parse(getState(db, k) || 'null') ?? dflt } catch { return dflt } }
  const enabled = new Set(readJson('enabled_strategies_json', ['fib_618_fade']))
  const autoM = readJson('autotrade_matrix_json', {})
  const pendM = readJson('pending_matrix_json', {})
  const addTf = (m, sym, tf) => { m[sym] = [...new Set([...(m[sym] || []), tf])] }
  const dropTf = (m, sym, tf) => {
    if (!m[sym]) return
    m[sym] = m[sym].filter(x => x !== tf)
    if (m[sym].length === 0) delete m[sym]
  }
  for (const c of changes.arm) {
    if (c.kind === 'strategy') enabled.add(c.strategy)
    if (c.kind === 'matrix') addTf(autoM, c.symbol, c.timeframe)
    if (c.kind === 'pending') addTf(pendM, c.symbol, c.timeframe)
  }
  for (const c of changes.disarm) {
    if (c.kind === 'matrix') dropTf(autoM, c.symbol, c.timeframe)
    if (c.kind === 'pending') dropTf(pendM, c.symbol, c.timeframe)
  }
  setState(db, 'enabled_strategies_json', JSON.stringify([...enabled]))
  setState(db, 'autotrade_matrix_json', Object.keys(autoM).length ? JSON.stringify(autoM) : null)
  setState(db, 'pending_matrix_json', Object.keys(pendM).length ? JSON.stringify(pendM) : null)
  if (Object.keys(pendM).length) setState(db, 'pending_mode_enabled', 'true')
}

const describe = (c) =>
  c.kind === 'strategy' ? `strategy ${c.strategy}` : `${c.kind === 'pending' ? 'pending ' : ''}${c.symbol} ${c.timeframe}${c.strategy ? ` (${c.strategy})` : ''}`

/** Called once per loop cycle; runs the evaluation at most every ~22h. */
export async function maybeRunAutopilot(db, creds, deps = {}) {
  const mode = autopilotMode(db)
  if (mode === 'off' || !creds?.ready) return { skipped: mode === 'off' ? 'off' : 'no creds' }
  const last = Number(getState(db, 'autopilot_last_run_ms')) || 0
  if (Date.now() - last < autopilotIntervalMs(db)) return { skipped: 'not due' }
  setState(db, 'autopilot_last_run_ms', String(Date.now())) // set FIRST — a crash must not hot-loop the evaluator

  const notify = async (text) => {
    try { const m = await import('./telegram-control.js'); await m.notifyOwner(text) } catch { /* best effort */ }
  }

  const { verdicts, errors } = await evaluateAll(db, creds, deps)
  db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
    .run('AUTOPILOT', '/evaluate', JSON.stringify({ combos: verdicts.length, errors: errors.length }).slice(0, 2000))
  // Owner requirement: every GO/NO-GO proposal ships as a downloadable HTML
  // chart with the reasoning spelled out.
  let reportName = null
  try {
    const { saveAutopilotReport } = await import('../lib/autopilot-report.js')
    reportName = saveAutopilotReport(verdicts, { errors, ranAt: new Date().toISOString() }).filename
  } catch (err) { errors.push(`report: ${err.message}`) }
  setState(db, 'autopilot_last_verdicts_json', JSON.stringify(verdicts).slice(0, 200_000))

  const current = {
    enabledStrategies: (() => { try { return JSON.parse(getState(db, 'enabled_strategies_json') || '["fib_618_fade"]') } catch { return ['fib_618_fade'] } })(),
    autoMatrix: (() => { try { return JSON.parse(getState(db, 'autotrade_matrix_json') || '{}') || {} } catch { return {} } })(),
    pendingMatrix: (() => { try { return JSON.parse(getState(db, 'pending_matrix_json') || '{}') || {} } catch { return {} } })(),
  }
  const maxChanges = Number(getState(db, 'autopilot_max_changes')) || 4
  const changes = decideChanges(verdicts, current, { maxChanges })

  const isLive = getState(db, 'ctrader_is_live') === 'true'
  // Owner opted into full-auto on live (autopilot_allow_live). Without it, auto
  // mode still refuses to arm real money and downgrades to suggestions.
  const allowLive = getState(db, 'autopilot_allow_live') === 'true'
  const goCount = verdicts.filter(v => v.state === 'go').length
  // "GO" is the loose backtest bar (PF≥1.1) — it protects an existing arm from
  // being churned, but it is NOT the bar to be NEWLY armed. Report the ARMABLE
  // count (the strict PF≥1.7 / 60% win / 25-trade bar decideChanges enforces)
  // alongside it so the headline never overstates what the bot will actually
  // trade. Same thresholds as decideChanges' armGrade defaults.
  const armable = verdicts.filter(v => v.state === 'go' && (v.pf ?? 0) >= 1.7 && (v.winRate ?? 0) >= 60 && (v.trades ?? 0) >= 25).length
  const head = `📊 Autopilot evaluation: ${verdicts.length} combos tested, ${armable} armable (${goCount} GO at the loose bar)${errors.length ? `, ${errors.length} errors` : ''}.${reportName ? ` Full charted report: ${reportName} (Tune → Backtest → Past reports).` : ''}`

  if (mode === 'suggest' || (isLive && !allowLive)) {
    const all = [...changes.disarm.map(c => `disarm ${describe(c)}`), ...changes.arm.map(c => `arm ${describe(c)}`), ...changes.suggestions.map(c => `${c.action} ${describe(c)}`)]
    await notify(`${head}${isLive && mode === 'auto' ? ' LIVE account — auto mode refuses to act (set autopilot_allow_live to enable); suggestions only:' : ' Suggestions:'}\n${all.length ? all.join('\n') : 'no changes needed'}`)
    return { mode: 'suggest', suggested: all.length }
  }

  // auto: apply within the cap, announce everything
  applyChanges(db, changes)
  const did = [...changes.disarm.map(c => `− disarmed ${describe(c)}`), ...changes.arm.map(c => `+ armed ${describe(c)}`)]
  db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
    .run('AUTOPILOT', '/apply', JSON.stringify(did).slice(0, 2000))
  await notify(`${head}\n${did.length ? did.join('\n') : 'no changes — everything armed matches the evidence'}${changes.suggestions.length ? `\n(cap reached — ${changes.suggestions.length} more suggested, /status to review)` : ''}\n/pause stops everything.`)
  return { mode: 'auto', applied: did.length, suggested: changes.suggestions.length }
}
