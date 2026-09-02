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
import { readTradableUnion } from './watchlists.js'
import { verdictFor } from '../lib/backtest-report.js'
import { backtestRemote } from '../lib/exec-engine.js'
import { tfMs } from '../lib/timeframes.js'
import { armedTimeframes } from '../lib/timeframes.js'
import { backtestStageStrategies } from './stage-matrix.js'
import { getActiveSessions } from '../lib/sessions.js'
import { ARM_BAR } from './edge-bars.js'
import { persistSweepHistogram } from './divergence.js'

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
/**
 * The ARM BAR, from config (owner "go with C", 01-09-2026). decideChanges has
 * accepted armMinPf/armMinWin/armMinTrades overrides since it was written,
 * but the production call site never passed them — a knob with no writer,
 * the same shape earned_floor_json had before stage 2. This loader is the
 * writer's other half: `autopilot_arm_bar_json` over the ARM_BAR defaults,
 * clamped so junk can never loosen the bar to zero. Dials via
 * POST /actions/autopilot { armBar: { minPf?, minWin?, minTrades? } }.
 */
export function loadArmBar(db) {
  const num = (v, dflt, lo, hi) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
  }
  let p = null
  try { p = JSON.parse(getState(db, 'autopilot_arm_bar_json') || 'null') } catch { p = null }
  const src = p && typeof p === 'object' ? p : {}
  return {
    minPf: num(src.minPf, ARM_BAR.profitFactor, 1, 10),
    minWin: num(src.minWin, ARM_BAR.winRatePct, 10, 95),
    minTrades: Math.round(num(src.minTrades, ARM_BAR.minTrades, 5, 500)),
  }
}

/** Disarm floor as a fraction of the arm bar's PF — see decideChanges. */
export const DISARM_PF_FRACTION = 0.85
/** How long a strategy the LIVE evaluators disarmed stays off the autopilot's arm list. */
export const LIVE_DISARM_COOL_OFF_MS = 24 * 3_600_000

export function decideChanges(verdicts, current, opts = {}) {
  const maxChanges = opts.maxChanges ?? 4
  // Strict ARMING bar (owner): a backtest "GO" (PF≥1.1) is too loose to put
  // real money on — it armed coin-flip combos like AUDUSD·4h (PF 1.50) that
  // lose. Only a PROVEN combo gets armed. Thresholds are configurable.
  // Defaults from edge-bars.js — see that file for why this bar deliberately
  // differs from the go-live gate and the breaker floor.
  const armMinPf = opts.armMinPf ?? ARM_BAR.profitFactor
  const armMinWin = opts.armMinWin ?? ARM_BAR.winRatePct
  const armMinTrades = opts.armMinTrades ?? ARM_BAR.minTrades
  // SHRINKAGE PRIOR (owner plan, 02-09-2026; ML audit). ~3.9% of zero-edge
  // combos clear 1.5/55/20 at n=20 on luck alone, and the sweep tests ~1,872
  // of them. Each combo's PF and WR are shrunk toward the SWEEP-WIDE mean
  // with the weight of `k` phantom trades before the bar is applied — a
  // combo with 20 trades and a 60% win rate in a sweep averaging 45% reads
  // (20·60 + 20·45)/40 = 52.5, below a 55 bar; the same edge on 100 trades
  // reads 57.5 and arms. Evidence has to outweigh the prior to count.
  // `opts.shrink` = { k, wrMean, pfMean } computed by the caller from ALL
  // verdicts of the sweep; absent → no shrinkage (tests, manual routes).
  const shrink = opts.shrink && Number.isFinite(opts.shrink.k) && opts.shrink.k > 0 ? opts.shrink : null
  const shrunk = (v) => shrinkVerdict(v, shrink)
  const armGrade = (v) => { const s = shrunk(v); return (s.pf ?? 0) >= armMinPf && (s.winRate ?? 0) >= armMinWin && (v.trades ?? 0) >= armMinTrades }
  // DISARM FLOOR (02-09-2026, ML audit). Disarm used to trigger only on
  // NO-GO — PF below 1.1 — while arming needed 1.5: a 0.4-PF hysteresis that
  // kept a false arm in place through dozens of re-judgements of the same
  // window (~3.9% of zero-edge combos clear the bar at n=20; the sweep
  // re-runs every 10–30 min). The floor now sits at 85% of the arm bar, so
  // an arm that stops clearing anything near its own evidence is dropped.
  const disarmMinPf = opts.disarmMinPf ?? Math.max(1, armMinPf * DISARM_PF_FRACTION)
  // LIVE DISARM COOL-OFF (02-09-2026, consistency + ML audits). The adaptive
  // breaker disarmed rsi2_reversion twice on 01-09 and this function re-armed
  // it 56 and 24 minutes later on an unchanged backtest: two evaluators
  // overriding each other on the same signal. A strategy the live evaluators
  // disarmed stays off THIS list for the cool-off; the backtest cannot vote
  // against live money for a day.
  const liveDisarms = opts.liveDisarms && typeof opts.liveDisarms === 'object' ? opts.liveDisarms : {}
  const coolOffMs = opts.coolOffMs ?? LIVE_DISARM_COOL_OFF_MS
  const nowMs = opts.nowMs ?? Date.now()
  const coolingOff = (strategy) => {
    const t = Date.parse(liveDisarms[strategy] || '')
    return Number.isFinite(t) && nowMs - t < coolOffMs
  }
  const arm = []
  const disarm = []
  const cooledOff = []
  const has = (m, sym, tf) => Array.isArray(m?.[sym]) && m[sym].includes(tf)

  const gos = verdicts.filter(v => v.state === 'go' && (shrunk(v).pf ?? 0) >= disarmMinPf) // a GO above the floor protects an existing arm
  const armGos = verdicts.filter(v => v.state === 'go' && armGrade(v))                       // only these clear the bar to be NEWLY armed
  // Condemned: NO-GO, or a GO whose (shrunk) PF fell below the disarm floor.
  // A THIN verdict (edge on too few trades) stays neutral either way —
  // absence of evidence is not evidence of decay.
  const nogos = verdicts.filter(v => v.state === 'no-go' || (v.state === 'go' && Number.isFinite(v.pf) && shrunk(v).pf < disarmMinPf))

  // ARM: only combos that CLEAR THE BAR. close-confirm → strategy enable +
  // per-instrument matrix entry; touch (fib only) → pending matrix entry.
  for (const v of armGos) {
    if (coolingOff(v.strategy)) {
      if (!cooledOff.some(c => c.strategy === v.strategy)) cooledOff.push({ strategy: v.strategy, until: new Date(Date.parse(liveDisarms[v.strategy]) + coolOffMs).toISOString() })
      continue
    }
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
  // Disarm entries carry the strategy of the NO-GO verdict that condemned
  // them (divergence tracker, 02-09-2026): without it the action log could
  // not name which strategy's evidence failed, and combo_arms could not be
  // closed against the row it opened.
  for (const [sym, tfs] of Object.entries(current.autoMatrix || {})) {
    for (const tf of tfs) {
      const condemned = nogos.find(v => v.entryMode !== 'touch' && v.symbol === sym && v.timeframe === tf)
      if (condemned && !gos.some(v => v.entryMode !== 'touch' && v.symbol === sym && v.timeframe === tf)) {
        disarm.push({ kind: 'matrix', strategy: condemned.strategy, symbol: sym, timeframe: tf })
      }
    }
  }
  for (const [sym, tfs] of Object.entries(current.pendingMatrix || {})) {
    for (const tf of tfs) {
      const condemned = nogos.find(v => v.entryMode === 'touch' && v.symbol === sym && v.timeframe === tf)
      if (condemned && !gos.some(v => v.entryMode === 'touch' && v.symbol === sym && v.timeframe === tf)) {
        disarm.push({ kind: 'pending', strategy: condemned.strategy, symbol: sym, timeframe: tf })
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
    cooledOff,             // strategies the live evaluators disarmed — not re-armed this sweep
    disarmMinPf,
    shrink: shrink ? { k: shrink.k, wrMean: r2s(shrink.wrMean), pfMean: r2s(shrink.pfMean) } : null,
  }
}

const r2s = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x) * 100) / 100 : null)

/** Phantom trades the sweep-wide prior is worth against one combo's evidence. */
export const SHRINK_PRIOR_TRADES = 20

/**
 * One verdict's PF and WR pulled toward the sweep prior with the weight of
 * `shrink.k` phantom trades: w = n/(n+k), x' = w·x + (1−w)·mean. No prior
 * (null) returns the figures untouched, so callers without a sweep behave
 * exactly as before. Shared by decideChanges and the evaluation headline so
 * the two can never disagree on what "armable" means.
 */
export function shrinkVerdict(v, shrink) {
  if (!shrink || !Number.isFinite(Number(shrink.k)) || Number(shrink.k) <= 0) return { pf: v.pf, winRate: v.winRate }
  const n = Math.max(0, Number(v.trades) || 0)
  const w = n / (n + Number(shrink.k))
  // `x == null` is checked explicitly: Number(null) is 0, which would shrink
  // a "no losses yet" PF of null toward half the prior instead of leaving it.
  const sh = (x, mean) => (x != null && mean != null && Number.isFinite(Number(x)) && Number.isFinite(Number(mean)) ? w * Number(x) + (1 - w) * Number(mean) : x)
  return { pf: sh(v.pf, shrink.pfMean), winRate: sh(v.winRate, shrink.wrMean) }
}

/**
 * The sweep-wide prior for decideChanges: mean WR and mean PF over every
 * verdict that has trades, so a combo's own figures are weighed against what
 * the whole sweep says a combo looks like. Null when the sweep is too thin to
 * say anything (fewer than 30 verdicts with trades).
 */
export function sweepShrinkPrior(verdicts, { k = SHRINK_PRIOR_TRADES, minVerdicts = 30 } = {}) {
  const rows = (Array.isArray(verdicts) ? verdicts : []).filter(v => (Number(v.trades) || 0) > 0 && Number.isFinite(Number(v.winRate)))
  if (rows.length < minVerdicts) return null
  const wrMean = rows.reduce((s, v) => s + Number(v.winRate), 0) / rows.length
  const pfRows = rows.filter(v => Number.isFinite(Number(v.pf)))
  // A combo with no losses has PF null; the prior must not read that as
  // infinite. Cap each PF at 5 for the mean — the bar is at 1.5, and a prior
  // above the bar would arm everything.
  const pfMean = pfRows.length ? pfRows.reduce((s, v) => s + Math.min(5, Number(v.pf)), 0) / pfRows.length : null
  return { k, wrMean, pfMean, verdicts: rows.length }
}

const LIVE_DISARMS_KEY = 'autopilot_live_disarms_json'

/** {strategy: ISO time of the last live disarm} — read by decideChanges via maybeRunAutopilot. */
export function loadLiveDisarms(db) {
  try {
    const p = JSON.parse(getState(db, LIVE_DISARMS_KEY) || '{}')
    return p && typeof p === 'object' ? p : {}
  } catch { return {} }
}

/**
 * A LIVE evaluator (edge watchdog, adaptive breaker) disarmed a strategy.
 * Two records, one call: the cool-off stamp decideChanges honours, and the
 * combo_arms close so the divergence tracker can see that the live half —
 * not a backtest — ended the arm.
 */
export function noteLiveDisarm(db, strategy, reason, { nowMs = Date.now() } = {}) {
  if (!strategy) return
  try {
    const prev = loadLiveDisarms(db)
    setState(db, LIVE_DISARMS_KEY, JSON.stringify({ ...prev, [strategy]: new Date(nowMs).toISOString() }))
  } catch { /* a bookkeeping failure must never undo a disarm */ }
  try {
    recordComboArms(db, { arm: [], disarm: [{ kind: 'strategy', strategy }] }, { reason: String(reason || 'live'), at: new Date(nowMs).toISOString().slice(0, 19).replace('T', ' ') })
  } catch { /* same */ }
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

// Exported for the yield test: the sweep's event-loop behaviour (one
// setImmediate per combo, below) can only be pinned by driving this function
// with stubbed deps — nothing observable survives to maybeRunAutopilot's
// return value.
export async function evaluateAll(db, creds, deps) {
  const { wsGetTrendbarsBatch } = deps.ws ?? await import('../lib/ctrader-ws.js')
  const { runBacktest, walkForward } = deps.bt ?? await import('../scripts/backtest-fib.js')
  const { getSymbolMap } = deps.credsLib ?? await import('../lib/ctrader-creds.js')

  let watch = []
  // Union across enabled accounts — the nightly sweep evaluates strategies
  // for every symbol somebody trades, not just the shared list's.
  try { watch = readTradableUnion(db).filter(w => w.enabled !== false).map(w => w.symbol) } catch { /* empty */ }
  const tfs = armedTimeframes(db, getState)
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
          // Yield the event loop before every combo. The sweep is ~3 minutes
          // of synchronous backtest CPU; without this it ran as ONE unbroken
          // block (measured 01-09-2026: loopPhaseLag.autopilot maxMs 1864,
          // worstStallCpuRatio 0.99) and starved fast-monitor ticks, HTTP
          // reads and heartbeats. One yield per combo caps any single stall
          // at one backtest.
          await new Promise((resolve) => setImmediate(resolve))
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
              // Unrounded where the engine offers it (JS); the C++ fast path
              // returns rounded figures — parity there is by the same
              // rounding, and a 0.005 bar miss on fib is the accepted cost.
              trades: stats.trades || 0, pf: stats.profitFactorRaw ?? stats.profitFactor ?? null,
              winRate: stats.winRatePctRaw ?? stats.winRatePct ?? null, total: stats.totalProfitPct ?? 0,
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

/**
 * Write an autopilot decision to state. Exported for the test that pins the
 * pending-mode mirror — the set-only bug lived here and nothing above this
 * function could observe it.
 */
export function applyChanges(db, changes, opts = {}) {
  // DIVERGENCE TRACKER (owner "plan #1", 02-09-2026): snapshot the evidence
  // each arm was granted on, close the row on disarm. Never blocks the state
  // writes below — a bookkeeping failure must not stop an arm/disarm.
  try { recordComboArms(db, changes, opts) } catch { /* bookkeeping only */ }
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
  // TWO-WAY, since 05-08-2026. It used to be `if (…length) setState(…, 'true')`
  // — set-only, never cleared. So the switch could be turned off on Tune and
  // the next autopilot pass silently turned it back on, forever. Owner: the
  // Desk badge "keeps ⏳ pending armed regardless of accounts and stay like
  // that". It did, and no operator action could clear it.
  //
  // An automated writer that can only ever ARM an operator switch is not a
  // setting, it is a latch. It now MIRRORS its own matrix in both directions:
  // pending rows armed → mode on, none → mode off. The autopilot owns the
  // matrix, so the mode that matrix implies is the one it may write — and a
  // matrix it has emptied must be able to turn the mode off again.
  setState(db, 'pending_mode_enabled', Object.keys(pendM).length ? 'true' : 'false')
}

/** Does a verdict clear the arm bar? The single definition decideChanges and the history writer share. */
export function clearsArmBar(v, bar) {
  return (v?.pf ?? 0) >= bar.minPf && (v?.winRate ?? 0) >= bar.minWin && (v?.trades ?? 0) >= bar.minTrades
}

/**
 * combo_arms writer. An ARM inserts one row carrying the verdict that
 * justified it (looked up from `opts.verdicts` by strategy×symbol×timeframe
 * ×entryMode) and the bar in force; a strategy-level arm has no single combo
 * verdict, so its bt_* stay NULL — which is the finding the tracker exists to
 * surface, not a gap to paper over. A DISARM stamps the open row.
 */
export function recordComboArms(db, changes, { verdicts = [], armBar = null, reason = 'autopilot', at = null } = {}) {
  const findVerdict = (c) => verdicts.find(v =>
    v.strategy === c.strategy && v.symbol === c.symbol && v.timeframe === c.timeframe
    && (c.kind === 'pending' ? v.entryMode === 'touch' : v.entryMode !== 'touch'))
  const openRow = db.prepare(
    `SELECT id FROM combo_arms
      WHERE disarmed_at IS NULL AND kind = ? AND COALESCE(strategy,'') = COALESCE(?,'')
        AND COALESCE(symbol,'') = COALESCE(?,'') AND COALESCE(timeframe,'') = COALESCE(?,'')
      ORDER BY id DESC LIMIT 1`)
  const ins = db.prepare(
    `INSERT INTO combo_arms (armed_at, kind, strategy, symbol, timeframe, entry_mode,
       bt_pf, bt_win_rate_pct, bt_trades, bt_wf_positive, bt_wf_active,
       bar_min_pf, bar_min_win, bar_min_trades)
     VALUES (COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  // A verdict arm on a pair the boot reconcile had recorded as UNEVIDENCED
  // supersedes that row: the pair now has evidence, and the evidence-less row
  // must not stay open beside it.
  const supersede = db.prepare(
    `UPDATE combo_arms SET disarmed_at = COALESCE(?, datetime('now')), disarm_reason = 'superseded_by_verdict_arm'
      WHERE disarmed_at IS NULL AND kind = 'unevidenced' AND entry_mode = ?
        AND COALESCE(symbol,'') = COALESCE(?,'') AND COALESCE(timeframe,'') = COALESCE(?,'')`)
  for (const c of changes?.arm || []) {
    if (openRow.get(c.kind, c.strategy ?? null, c.symbol ?? null, c.timeframe ?? null)) continue
    if (c.kind === 'matrix' || c.kind === 'pending') supersede.run(at, c.kind === 'pending' ? 'touch' : 'close', c.symbol ?? null, c.timeframe ?? null)
    const v = c.kind === 'strategy' ? null : findVerdict(c)
    ins.run(
      at, c.kind, c.strategy ?? null, c.symbol ?? null, c.timeframe ?? null,
      c.kind === 'pending' ? 'touch' : (c.kind === 'matrix' ? 'close' : null),
      v?.pf ?? null, v?.winRate ?? null, v?.trades ?? null, v?.wfPositive ?? null, v?.wfActive ?? null,
      armBar?.minPf ?? null, armBar?.minWin ?? null, armBar?.minTrades ?? null,
    )
  }
  const close = db.prepare(
    `UPDATE combo_arms SET disarmed_at = COALESCE(?, datetime('now')), disarm_reason = ?
      WHERE disarmed_at IS NULL AND kind = ?
        AND COALESCE(symbol,'') = COALESCE(?,'') AND COALESCE(timeframe,'') = COALESCE(?,'')
        AND (? IS NULL OR strategy IS NULL OR strategy = ?)`)
  // A disarm also closes any evidence-less row the boot reconcile opened for
  // the same pair — otherwise it would outlive the arm it stood in for.
  const closeUnevidenced = db.prepare(
    `UPDATE combo_arms SET disarmed_at = COALESCE(?, datetime('now')), disarm_reason = ?
      WHERE disarmed_at IS NULL AND kind = 'unevidenced' AND entry_mode = ?
        AND COALESCE(symbol,'') = COALESCE(?,'') AND COALESCE(timeframe,'') = COALESCE(?,'')`)
  for (const c of changes?.disarm || []) {
    close.run(at, `${reason}_nogo`, c.kind, c.symbol ?? null, c.timeframe ?? null, c.strategy ?? null, c.strategy ?? null)
    if (c.kind === 'matrix' || c.kind === 'pending') closeUnevidenced.run(at, `${reason}_nogo`, c.kind === 'pending' ? 'touch' : 'close', c.symbol ?? null, c.timeframe ?? null)
  }
}

// The exact line shapes describe() has always written to the action log —
// the backfill below parses them, so the two must stay in lockstep.
const APPLY_LINE = /^([+−-])\s+(armed|disarmed)\s+(?:strategy\s+(\S+)|(pending\s+)?(\S+)\s+(\S+)(?:\s+\((\S+)\))?)$/

/** One action-log line → a decideChanges-shaped entry, or null. */
export function parseApplyLine(line) {
  const m = APPLY_LINE.exec(String(line || '').trim())
  if (!m) return null
  const action = m[2] === 'armed' ? 'arm' : 'disarm'
  if (m[3]) return { action, kind: 'strategy', strategy: m[3] }
  return { action, kind: m[4] ? 'pending' : 'matrix', symbol: m[5], timeframe: m[6], ...(m[7] ? { strategy: m[7] } : {}) }
}

/**
 * ONE-TIME BACKFILL of combo_arms from the action log (02-09-2026). The
 * table was added a day after autopilot began arming at the eased bar, so
 * every combo in force had no row — and would have had none until it was
 * disarmed and re-armed. The log carries every arm/disarm line since the
 * first (105 arms / 28 disarms measured), so the history is complete;
 * evidence (bt_*) is unknowable retroactively and stays NULL — those rows
 * read as unevidenced, which is the truth. Idempotent: a populated table is
 * never touched.
 */
export function backfillComboArmsFromActionLog(db) {
  const have = db.prepare('SELECT COUNT(*) AS n FROM combo_arms').get()?.n || 0
  if (have > 0) return { skipped: 'already populated', rows: have }
  const rows = db.prepare(
    `SELECT at, body FROM action_log WHERE method = 'AUTOPILOT' AND path = '/apply' ORDER BY id`
  ).all()
  let arms = 0, disarms = 0
  const tx = db.transaction(() => {
    for (const r of rows) {
      let lines = []
      try { lines = JSON.parse(r.body) } catch { continue }
      if (!Array.isArray(lines)) continue
      const changes = { arm: [], disarm: [] }
      for (const l of lines) {
        const e = parseApplyLine(l)
        if (!e) continue
        const { action, ...entry } = e
        changes[action].push(entry)
      }
      arms += changes.arm.length
      disarms += changes.disarm.length
      recordComboArms(db, changes, { at: r.at, reason: 'backfill' })
    }
  })
  tx()
  return { skipped: null, arms, disarms, rows: rows.length }
}

/**
 * BOOT RECONCILE of combo_arms against the LIVE matrices (owner, 02-09-2026:
 * "record them with no evidence, build the reconcile step").
 *
 * Measured after the backfill deployed: the table held 186 open pairs, the
 * live auto matrix 161 — 74 open rows the matrix no longer carried (disarmed
 * by a path that writes no AUTOPILOT apply line: the edge watchdog, a manual
 * timeframe change, or a disarm older than the log's retention) and 49 live
 * pairs with no row at all (armed before the retained log began). Trades on
 * the 49 would classify as evidence-less for ever while the bot traded them
 * as armed; the 74 could label a future trade symbol_tf on a phantom.
 *
 * So, every boot, idempotent: an open matrix/pending/unevidenced row whose
 * pair is not in its live matrix is stamped disarmed (reason names the
 * boot); a live pair with no open row of its entry mode gets one of kind
 * 'unevidenced' — no strategy, no bt_*, because there is no verdict on
 * record for it and the report must not credit one. A later verdict arm on
 * the pair supersedes that row (see recordComboArms). A matrix key that is
 * ABSENT is not an empty matrix: nothing is touched for that mode.
 */
export function reconcileComboArmsWithMatrix(db, { at = null } = {}) {
  const readMatrix = (key) => {
    const raw = getState(db, key)
    if (raw == null || raw === '') return null
    try { const m = JSON.parse(raw); return m && typeof m === 'object' ? m : null } catch { return null }
  }
  const pairsOf = (m) => {
    const s = new Set()
    for (const [sym, tfs] of Object.entries(m || {})) for (const tf of Array.isArray(tfs) ? tfs : []) s.add(`${String(sym).toUpperCase()}|${tf}`)
    return s
  }
  const out = { auto: { stale: 0, added: 0, skipped: null }, pending: { stale: 0, added: 0, skipped: null } }
  const modes = [
    { name: 'auto', key: 'autotrade_matrix_json', kinds: ['matrix', 'unevidenced'], entryMode: 'close' },
    { name: 'pending', key: 'pending_matrix_json', kinds: ['pending', 'unevidenced'], entryMode: 'touch' },
  ]
  const openRows = db.prepare(
    `SELECT id, kind, symbol, timeframe FROM combo_arms
      WHERE disarmed_at IS NULL AND kind IN (?, ?) AND entry_mode = ?`)
  const stamp = db.prepare(
    `UPDATE combo_arms SET disarmed_at = COALESCE(?, datetime('now')), disarm_reason = 'boot_reconcile: not armed live' WHERE id = ?`)
  const ins = db.prepare(
    `INSERT INTO combo_arms (armed_at, kind, strategy, symbol, timeframe, entry_mode)
     VALUES (COALESCE(?, datetime('now')), 'unevidenced', NULL, ?, ?, ?)`)
  const tx = db.transaction(() => {
    for (const mode of modes) {
      const m = readMatrix(mode.key)
      if (!m) { out[mode.name].skipped = 'no matrix on record'; continue }
      const live = pairsOf(m)
      const recorded = new Set()
      for (const r of openRows.all(mode.kinds[0], mode.kinds[1], mode.entryMode)) {
        const p = `${String(r.symbol || '').toUpperCase()}|${r.timeframe}`
        if (live.has(p)) { recorded.add(p); continue }
        stamp.run(at, r.id)
        out[mode.name].stale++
      }
      for (const p of live) {
        if (recorded.has(p)) continue
        const [sym, tf] = p.split('|')
        ins.run(at, sym, tf, mode.entryMode)
        out[mode.name].added++
      }
    }
  })
  tx()
  return out
}

/**
 * Bounded verdict history: per sweep, only verdicts that clear the bar or
 * concern a currently-armed combo (see autopilot_verdicts in db.js).
 */
export function persistVerdictHistory(db, verdicts, current, armBar) {
  const armedTf = (m, sym, tf) => Array.isArray(m?.[sym]) && m[sym].includes(tf)
  const keep = (Array.isArray(verdicts) ? verdicts : []).filter(v =>
    clearsArmBar(v, armBar)
    || (v.entryMode === 'touch' ? armedTf(current?.pendingMatrix, v.symbol, v.timeframe) : armedTf(current?.autoMatrix, v.symbol, v.timeframe)))
  if (!keep.length) return 0
  const ins = db.prepare(
    `INSERT INTO autopilot_verdicts (strategy, symbol, timeframe, entry_mode, state, trades, pf, win_rate_pct, wf_positive, wf_active, armable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const tx = db.transaction((rows) => {
    for (const v of rows) {
      ins.run(v.strategy, v.symbol, v.timeframe, v.entryMode ?? null, v.state ?? null,
        v.trades ?? null, Number.isFinite(v.pf) ? v.pf : null, v.winRate ?? null,
        v.wfPositive ?? null, v.wfActive ?? null, clearsArmBar(v, armBar) ? 1 : 0)
    }
  })
  tx(keep)
  return keep.length
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
  const armBar = loadArmBar(db)
  const shrink = sweepShrinkPrior(verdicts)
  const changes = decideChanges(verdicts, current, {
    maxChanges, armMinPf: armBar.minPf, armMinWin: armBar.minWin, armMinTrades: armBar.minTrades,
    liveDisarms: loadLiveDisarms(db),
    shrink,
  })
  // Divergence tracker: bounded history of the verdicts that matter, every
  // sweep, whatever mode we are in — suggest-mode owners get the record too.
  try { persistVerdictHistory(db, verdicts, current, armBar) } catch (err) { errors.push(`verdict history: ${err.message}`) }
  // Per-sweep PF/WR/n histogram over ALL verdicts (02-09-2026): the base
  // rate the bounded history above cannot supply. Measurement only.
  try { persistSweepHistogram(db, verdicts) } catch (err) { errors.push(`sweep histogram: ${err.message}`) }

  const isLive = getState(db, 'ctrader_is_live') === 'true'
  // Owner opted into full-auto on live (autopilot_allow_live). Without it, auto
  // mode still refuses to arm real money and downgrades to suggestions.
  const allowLive = getState(db, 'autopilot_allow_live') === 'true'
  const goCount = verdicts.filter(v => v.state === 'go').length
  // "GO" is the loose backtest bar (PF≥1.1) — it protects an existing arm from
  // being churned, but it is NOT the bar to be NEWLY armed. Report the ARMABLE
  // count at the SAME configured bar decideChanges just enforced (a headline
  // computed at hardcoded thresholds would drift the moment the owner dials
  // autopilot_arm_bar_json) so it never overstates what the bot will trade.
  // Shrunk with the same prior decideChanges used: a headline that counted
  // raw figures would announce combos the bar just refused.
  const armable = verdicts.filter((v) => {
    const s = shrinkVerdict(v, shrink)
    return v.state === 'go' && (s.pf ?? 0) >= armBar.minPf && (s.winRate ?? 0) >= armBar.minWin && (v.trades ?? 0) >= armBar.minTrades
  }).length
  const cooled = changes.cooledOff?.length
    ? ` ${changes.cooledOff.length} strategy(ies) held off — disarmed live, cooling until ${changes.cooledOff.map(c => `${c.strategy} ${c.until.slice(11, 16)}Z`).join(', ')}.`
    : ''
  const prior = changes.shrink
    ? ` Shrinkage prior: sweep mean WR ${changes.shrink.wrMean}% / PF ${changes.shrink.pfMean}, weight ${changes.shrink.k} trades.`
    : ''
  const head = `📊 Autopilot evaluation: ${verdicts.length} combos tested, ${armable} armable at PF≥${armBar.minPf}/W≥${armBar.minWin}%/n≥${armBar.minTrades} (${goCount} GO at the loose bar; disarm floor PF<${changes.disarmMinPf.toFixed(2)})${errors.length ? `, ${errors.length} errors` : ''}.${prior}${cooled}${reportName ? ` Full charted report: ${reportName} (Tune → Backtest → Past reports).` : ''}`

  if (mode === 'suggest' || (isLive && !allowLive)) {
    const all = [...changes.disarm.map(c => `disarm ${describe(c)}`), ...changes.arm.map(c => `arm ${describe(c)}`), ...changes.suggestions.map(c => `${c.action} ${describe(c)}`)]
    await notify(`${head}${isLive && mode === 'auto' ? ' LIVE account — auto mode refuses to act (set autopilot_allow_live to enable); suggestions only:' : ' Suggestions:'}\n${all.length ? all.join('\n') : 'no changes needed'}`)
    return { mode: 'suggest', suggested: all.length }
  }

  // auto: apply within the cap, announce everything
  applyChanges(db, changes, { verdicts, armBar })
  const did = [...changes.disarm.map(c => `− disarmed ${describe(c)}`), ...changes.arm.map(c => `+ armed ${describe(c)}`)]
  db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
    .run('AUTOPILOT', '/apply', JSON.stringify(did).slice(0, 2000))
  await notify(`${head}\n${did.length ? did.join('\n') : 'no changes — everything armed matches the evidence'}${changes.suggestions.length ? `\n(cap reached — ${changes.suggestions.length} more suggested, /status to review)` : ''}\n/pause stops everything.`)
  return { mode: 'auto', applied: did.length, suggested: changes.suggestions.length }
}
