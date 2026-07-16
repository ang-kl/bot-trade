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

const RUN_EVERY_MS = 22 * 3600_000 // ~nightly, drift-tolerant
const BARS = 1000

export function autopilotMode(db) {
  const m = getState(db, 'autopilot_mode')
  return m === 'auto' || m === 'suggest' ? m : 'off'
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
  const arm = []
  const disarm = []
  const has = (m, sym, tf) => Array.isArray(m?.[sym]) && m[sym].includes(tf)

  const gos = verdicts.filter(v => v.state === 'go')
  const nogos = verdicts.filter(v => v.state === 'no-go')

  // ARM: close-confirm GOs → strategy enable + per-instrument matrix entry;
  // touch GOs (fib only, entryMode 'touch') → pending matrix entry.
  for (const v of gos) {
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

  const verdicts = []
  const errors = []
  for (const symbol of watch.slice(0, 24)) {
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
              trades: stats.trades || 0, pf: stats.profitFactor ?? null, total: stats.totalProfitPct ?? 0,
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
  if (Date.now() - last < RUN_EVERY_MS) return { skipped: 'not due' }
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
  const goCount = verdicts.filter(v => v.state === 'go').length
  const head = `📊 Autopilot evaluation: ${verdicts.length} combos tested, ${goCount} GO${errors.length ? `, ${errors.length} errors` : ''}.${reportName ? ` Full charted report: ${reportName} (Tune → Backtest → Past reports).` : ''}`

  if (mode === 'suggest' || isLive) {
    const all = [...changes.disarm.map(c => `disarm ${describe(c)}`), ...changes.arm.map(c => `arm ${describe(c)}`), ...changes.suggestions.map(c => `${c.action} ${describe(c)}`)]
    await notify(`${head}${isLive && mode === 'auto' ? ' LIVE account — auto mode refuses to act; suggestions only:' : ' Suggestions:'}\n${all.length ? all.join('\n') : 'no changes needed'}`)
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
