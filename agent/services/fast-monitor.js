// ---------------------------------------------------------------------------
// agent/services/fast-monitor.js — fast, volume-aware monitoring of OPEN
// positions between the 5-minute main-loop cycles.
//
// Owner (2026-07-17): "for an active position, monitoring for that
// instrument reduces from 5 minutes to # minutes — and is also based on
// active market volume." So:
//
// - A dedicated 30s ticker (startFastMonitor) runs alongside the main loop.
// - Each ACTIVE bot position gets its own cadence:
//     cadence = base (`monitor_interval_min`, default 1m) scaled by the
//     instrument's relative 1-minute volume — busy market → base interval,
//     average → 2×, quiet → 3×. cadenceMs() is the pure, tested policy.
// - A due position is re-priced from a live spot quote and run through the
//   SAME deterministic rules the main loop uses (evaluatePosition →
//   executeBrokerAction): time caps, SL/TP breaches, invalidations now act
//   within about a minute instead of five.
// - External positions stay observe-only; Live Tweak & Close (stage matrix)
//   is honoured; the broker-resident SL/TP remains the tick-level backstop.
//
// Relative volume is refreshed lazily (at most once per 5 minutes per
// symbol, 20×1m bars) so the fast path stays light on the broker API.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { evaluatePosition } from './position-manager.js'
import { manageStageAllows } from './stage-matrix.js'

/**
 * Pure cadence policy: milliseconds between checks for one position.
 * relVol = latest 1m volume ÷ average of the previous bars (NaN = unknown).
 */
export function cadenceMs(relVol, baseMinutes) {
  const base = Math.max(0.5, Number(baseMinutes) || 1) * 60_000
  if (!Number.isFinite(relVol)) return base * 2 // unknown volume → middle pace
  if (relVol >= 1.5) return base                // busy market → fastest
  if (relVol >= 0.75) return base * 2
  return base * 3                               // quiet market → slowest
}

/**
 * Owner override map (agent_state monitor_overrides_json): SYMBOL → minutes.
 * An override REPLACES the volume-adaptive cadence for that symbol — the
 * owner's word beats the volume read (faster ticker for some, throttle for
 * others). Cleared symbols fall back to auto.
 */
export function loadMonitorOverrides(db) {
  try {
    const parsed = JSON.parse(getState(db, 'monitor_overrides_json') || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

/** Effective cadence: owner override (minutes) wins; otherwise volume-adaptive. */
export function effectiveCadenceMs(overrideMin, relVol, baseMin) {
  const ov = Number(overrideMin)
  if (Number.isFinite(ov) && ov > 0) return Math.max(15_000, ov * 60_000)
  return cadenceMs(relVol, baseMin)
}

/** relVol from 1m bars: last CLOSED bar's volume vs the average before it. */
export function relVolFromBars(bars) {
  if (!Array.isArray(bars) || bars.length < 6) return NaN
  const closed = bars.slice(0, -1) // drop the forming bar
  const last = closed[closed.length - 1]
  const prior = closed.slice(0, -1)
  const avg = prior.reduce((n, b) => n + (b.v || 0), 0) / prior.length
  if (!(avg > 0)) return NaN
  return (last.v || 0) / avg
}

// Per-position pacing + per-symbol volume cache. In-memory: a restart just
// re-checks everything once, which is safe.
const lastCheckAt = new Map()  // position id → ms
const volCache = new Map()     // symbol → { relVol, at }
const VOL_TTL_MS = 5 * 60_000

let running = false

/** One tick. Deps injectable for tests: { ws, exec: {executeBrokerAction, prepareStatements}, now }. */
export async function runFastMonitor(db, creds, deps = {}) {
  if (running) return { skipped: 'busy' }
  running = true
  try {
    if (!creds?.ready) return { skipped: 'no creds' }
    const now = deps.now ?? (() => Date.now())
    const baseMin = Number(getState(db, 'monitor_interval_min')) || 1

    const loopMod = deps.loop ?? await import('../loop.js')
    const s = loopMod.prepareStatements(db)
    const positions = db.prepare(
      `SELECT * FROM monitored_positions WHERE status = 'active' AND paused IS NOT 1`
    ).all()
    if (positions.length === 0) return { skipped: 'no positions', checked: 0 }

    const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
    const symbolMap = (() => { try { return JSON.parse(getState(db, 'symbol_id_map') || '{}') } catch { return {} } })()
    const overrides = loadMonitorOverrides(db)

    let checked = 0
    let acted = 0
    for (const pos of positions) {
      try {
        if (pos.source === 'external') continue            // observe-only
        if (!manageStageAllows(db, getState, pos.strategy)) continue
        const symbolId = symbolMap[String(pos.symbol).toUpperCase()]
        if (!symbolId) continue

        // Cadence: owner per-symbol override wins; otherwise volume-aware
        // (relVol cached per symbol for 5 minutes — skipped entirely when an
        // override pins the pace, sparing the bar fetch).
        const overrideMin = overrides[String(pos.symbol).toUpperCase()]
        let relVol = NaN
        if (!(Number(overrideMin) > 0)) {
          let vc = volCache.get(pos.symbol)
          if (!vc || now() - vc.at > VOL_TTL_MS) {
            try {
              const byTf = await ws.wsGetTrendbarsBatch(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId, ['1m'], 21, 15_000)
              relVol = relVolFromBars(byTf['1m'] || [])
            } catch { /* unknown volume → middle pace */ }
            vc = { relVol, at: now() }
            volCache.set(pos.symbol, vc)
          }
          relVol = vc.relVol
        }
        const due = now() - (lastCheckAt.get(pos.id) || 0) >= effectiveCadenceMs(overrideMin, relVol, baseMin)
        if (!due) continue
        lastCheckAt.set(pos.id, now())

        const q = await ws.wsGetSpotOnce(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)
        const mid = q?.bid != null && q?.ask != null ? (q.bid + q.ask) / 2 : null
        if (mid == null) continue // market closed / no feed — main loop's problem

        checked++
        const eval_ = evaluatePosition(pos, { currentPrice: mid })
        s.updatePositionMetrics.run(
          eval_.updates.mfe_r ?? pos.mfe_r ?? 0,
          eval_.updates.mae_r ?? pos.mae_r ?? 0,
          eval_.updates.be_moved ?? pos.be_moved ?? 0,
          eval_.updates.scaled_out ?? pos.scaled_out ?? 0,
          pos.id,
        )
        if (eval_.action === 'HOLD') continue
        const outcome = await loopMod.executeBrokerAction(db, s, pos, eval_)
        acted++
        const summary = outcome.error
          ? `${eval_.reason} | broker_error: ${outcome.error}`
          : outcome.skipped
            ? `${eval_.reason} | intent_only: ${outcome.reason}`
            : `${eval_.reason} | broker: ${outcome.summary}`
        s.updatePositionCheck.run(
          `FAST:${eval_.action}`,
          summary,
          new Date().toISOString(),
          eval_.action === 'FULL_EXIT' ? 'broken' : 'intact',
          pos.id,
        )
        console.log(`[fast-monitor] ${pos.symbol}: ${eval_.action} — ${summary}`)
      } catch (err) {
        console.error('[fast-monitor]', pos.symbol, err.message)
      }
    }
    return { checked, acted, positions: positions.length }
  } finally {
    running = false
  }
}

/**
 * Start the 30s ticker. Returns a stop() handle (tests, shutdown).
 *
 * The ticker doubles as the reliability watchdog — deliberately independent
 * of the main loop so a silently dead main loop is still detected: every
 * tick beats the fast_monitor heartbeat, every 2nd tick runs the stall
 * check (checkHeartbeats → Telegram alert), every 4th tick actively probes
 * the C++ exec engine's GET /health when EXEC_ENGINE=cpp.
 */
export function startFastMonitor(db, getCreds, deps = {}) {
  let tick = 0
  const t = setInterval(async () => {
    tick++
    let tickErr = null
    try {
      const creds = getCreds(db)
      await runFastMonitor(db, creds, deps)
    } catch (err) {
      tickErr = err
      console.error('[fast-monitor] tick failed:', err.message)
    }
    // P&L drift watch — every 2nd tick (~60s): Telegram warns when an open
    // trade crosses ±N% of balance (owner audit: nothing warned on drift).
    if (tick % 2 === 0) {
      try {
        const creds = getCreds(db)
        if (creds?.ready) {
          const { runPnlWatch } = await import('./pnl-watch.js')
          await runPnlWatch(db, creds)
        }
      } catch (err) {
        console.error('[fast-monitor] pnl-watch failed:', err.message)
      }
    }
    try {
      const hb = deps.heartbeat ?? await import('./heartbeat.js')
      hb.beat(db, 'fast_monitor', { ok: !tickErr, error: tickErr?.message ?? null })
      if (tick % 4 === 0) await hb.probeCppExec(db)
      if (tick % 2 === 0) {
        hb.checkHeartbeats(db, {
          notify: (text) => import('./telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
        })
      }
    } catch (err) {
      console.error('[fast-monitor] watchdog failed:', err.message)
    }
  }, deps.tickMs ?? 30_000)
  t.unref?.()
  return () => clearInterval(t)
}
