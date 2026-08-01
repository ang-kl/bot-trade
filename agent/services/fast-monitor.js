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
import { rulesForSymbol } from './asset-controllers.js'
import { manageStageAllows } from './stage-matrix.js'
import { isSymbolOpenCached } from './symbol-hours.js'

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

// Owner: "if the market volume is active... if sudden dip or spike what must
// you do?" A spike is a % move since the LAST check that's too fast for the
// elapsed time — pure math over data this ticker already fetches (no extra
// broker call), so it costs nothing to check every tick. SPIKE_HOLD_MS keeps
// a symbol at the fastest cadence for a while after a spike even if relVol
// itself hasn't caught up yet (relVol is a 5min-stale lagging read; a spike
// is the leading signal that a symbol just became "busy").
export const SPIKE_PCT_PER_MIN = 0.4 // % move per minute that counts as a spike
const SPIKE_HOLD_MS = 5 * 60_000

/** True when `mid` moved fast enough since (`prevMid`,`prevAt`) to be a spike. */
export function isSpikeMove(prevMid, prevAt, mid, now, pctPerMin = SPIKE_PCT_PER_MIN) {
  if (prevMid == null || !(prevMid > 0) || mid == null || !(prevAt < now)) return false
  const elapsedMin = Math.max(1 / 60, (now - prevAt) / 60_000) // floor at 1s — avoids a divide-by-near-zero false spike
  const movePct = Math.abs(mid - prevMid) / prevMid * 100
  return (movePct / elapsedMin) >= pctPerMin
}

// Hardening batch (owner-approved build 6a): a quote that stops MOVING while
// its market is open is a different failure from a quote that stops ARRIVING —
// wsGetSpotOnce keeps succeeding, mid stays non-null, every layer looks
// healthy, yet SL/TP decisions are being made on a fossil price (frozen feed,
// stale symbol subscription, broker-side halt). Track the last DISTINCT mid
// per held symbol; unchanged past the threshold while the market is open →
// one owner alert per freeze episode, cleared the moment the price moves.
export const FROZEN_QUOTE_DEFAULT_MIN = 10

/**
 * Pure episode tracker. rec = { mid, changedAt, alerted } | undefined.
 * Returns { rec, alert, recovered } — alert fires at most once per episode.
 */
export function frozenQuoteUpdate(rec, mid, nowMs, thresholdMs) {
  if (!rec || rec.mid !== mid) {
    return { rec: { mid, changedAt: nowMs, alerted: false }, alert: false, recovered: !!rec?.alerted }
  }
  if (!rec.alerted && thresholdMs > 0 && nowMs - rec.changedAt >= thresholdMs) {
    return { rec: { ...rec, alerted: true }, alert: true, recovered: false }
  }
  return { rec, alert: false, recovered: false }
}

// Per-position pacing + per-symbol volume cache. In-memory: a restart just
// re-checks everything once, which is safe.
const lastCheckAt = new Map()  // position id → ms
const lastPriceAt = new Map()  // position id → { mid, at }
const spikeUntil = new Map()   // symbol → ms timestamp; forces fastest cadence until then
const volCache = new Map()     // symbol → { relVol, at }
const quoteFreeze = new Map()  // symbol → { mid, changedAt, alerted }
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
          // A recent spike is a leading signal relVol (5min-stale) hasn't
          // caught up to yet — hold this symbol at the fastest cadence
          // regardless of what the lagging volume read says.
          const spikeExpiry = spikeUntil.get(pos.symbol)
          if (spikeExpiry && now() < spikeExpiry) relVol = Math.max(relVol || 0, 2)
        }
        // During an active spike window the per-position cadence is bypassed
        // entirely — the position re-prices on EVERY ticker tick (default 3s)
        // so profit-banking/exit rules act inside the spike, not after it
        // (owner 2026-07-24: sub-3-second spike losses).
        const spikeActive = (spikeUntil.get(pos.symbol) || 0) > now()
        const due = spikeActive ||
          now() - (lastCheckAt.get(pos.id) || 0) >= effectiveCadenceMs(overrideMin, relVol, baseMin)
        if (!due) continue
        lastCheckAt.set(pos.id, now())

        const q = await ws.wsGetSpotOnce(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)
        const mid = q?.bid != null && q?.ask != null ? (q.bid + q.ask) / 2 : null
        if (mid == null) continue // market closed / no feed — main loop's problem

        // Frozen-quote watch (FROZEN_QUOTE_MIN, minutes; 0 disables). Only
        // while the market is open — a flat weekend quote is normal, not a
        // frozen feed. One alert per episode, self-clearing on movement.
        const frozenMin = Number(process.env.FROZEN_QUOTE_MIN ?? FROZEN_QUOTE_DEFAULT_MIN)
        if (frozenMin > 0) {
          const fq = frozenQuoteUpdate(quoteFreeze.get(pos.symbol), mid, now(), frozenMin * 60_000)
          quoteFreeze.set(pos.symbol, fq.rec)
          if (fq.alert) {
            let open = true
            try { open = isSymbolOpenCached(db, pos.symbol).open !== false } catch { /* unknown → assume open, alert */ }
            if (open) {
              const mins = Math.round((now() - fq.rec.changedAt) / 60_000)
              const msg = `🧊 Frozen quote: ${pos.symbol} has printed ${mid} unchanged for ${mins}m while its market is open — SL/TP decisions may be running on a stale feed. Held position ${pos.side} from ${pos.entry_price}.`
              console.warn(`[fast-monitor] ${msg}`)
              import('./telegram-control.js').then(m => m.notifyOwner(msg)).catch(() => {})
            } else {
              // Closed market → not a freeze; restart the episode quietly.
              quoteFreeze.set(pos.symbol, { mid, changedAt: now(), alerted: false })
            }
          } else if (fq.recovered) {
            console.log(`[fast-monitor] ${pos.symbol}: quote moving again after freeze`)
          }
        }

        const prevPrice = lastPriceAt.get(pos.id)
        if (isSpikeMove(prevPrice?.mid, prevPrice?.at, mid, now())) {
          spikeUntil.set(pos.symbol, now() + SPIKE_HOLD_MS)
          console.log(`[fast-monitor] ${pos.symbol}: volatility spike detected — fast-tracking checks for ${Math.round(SPIKE_HOLD_MS / 60000)}m`)
        }
        lastPriceAt.set(pos.id, { mid, at: now() })

        checked++
        const eval_ = evaluatePosition(pos, { currentPrice: mid, rules: rulesForSymbol(db, pos.symbol) })
        s.updatePositionMetrics.run(
          eval_.updates.mfe_r ?? pos.mfe_r ?? 0,
          eval_.updates.mae_r ?? pos.mae_r ?? 0,
          eval_.updates.be_moved ?? pos.be_moved ?? 0,
          eval_.updates.scaled_out ?? pos.scaled_out ?? 0,
          pos.id,
        )
        if (eval_.action === 'HOLD') {
          // Same truthfulness fix as the main loop's monitor phase (owner:
          // "why are you not monitoring") — a HOLD verdict used to write
          // nothing, so a position checked every 30-90s for hours looked
          // identical in the UI to one that was never touched.
          s.updatePositionCheck.run('FAST:HOLD', eval_.reason, new Date().toISOString(), 'intact', pos.id)
          continue
        }
        const outcome = await loopMod.executeBrokerAction(db, s, pos, eval_, 'fast_monitor')
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
  // Owner 2026-07-24: default tick 3s (was 30s) so spike windows re-price at
  // tick speed; FAST_MONITOR_MS overrides, floored at 1s. Sub-task cadences
  // below are TIME-based (everyTicks) so a faster ticker doesn't multiply
  // pnl-watch / watchdog / cpp-probe traffic.
  const tickMs = deps.tickMs ?? Math.max(1_000, Number(process.env.FAST_MONITOR_MS) || 3_000)
  const everyTicks = (secs) => Math.max(1, Math.round((secs * 1000) / tickMs))
  // WHOLE-TICK overlap guard (incident 2026-07-28: the site became
  // unreachable while the loop itself was healthy). setInterval does not
  // await an async callback, and only runFastMonitor was guarded — every
  // 3s the tick ALSO launched an unguarded session-open-guard pass, which
  // walks open positions serially opening a NEW websocket (+ its own 9s
  // heartbeat timer) per position with a 6s timeout each. With a dozen
  // positions and a slow broker one pass outlives twenty ticks, so copies
  // stacked into dozens of concurrent broker sockets — self-inflicted rate
  // limiting, and enough synchronous SQLite interleaving to starve HTTP
  // reads until even a 401 took 30s. One flag now covers the entire body:
  // a pass that overruns skips ticks instead of multiplying them.
  let tickRunning = false
  let skipped = 0
  const t = setInterval(async () => {
    tick++
    if (tickRunning) {
      skipped++
      // Still beat — a busy monitor is not a stalled one, and skipping the
      // heartbeat would trip the watchdog's stall alert on our own backlog.
      try {
        const hb = deps.heartbeat ?? await import('./heartbeat.js')
        hb.beat(db, 'fast_monitor', { ok: true, error: null, detail: { busy: true, skipped } })
      } catch { /* heartbeat is best-effort */ }
      if (skipped === 1 || skipped % 20 === 0) console.warn(`[fast-monitor] previous pass still running — skipped ${skipped} tick(s)`)
      return
    }
    tickRunning = true
    // ONE creds read per tick: this was called five times per tick, each
    // doing several getState reads plus a JSON.parse of the symbol map.
    const creds = getCreds(db)
    try {
    skipped = 0
    let tickErr = null
    try {
      await runFastMonitor(db, creds, deps)
    } catch (err) {
      tickErr = err
      console.error('[fast-monitor] tick failed:', err.message)
    }
    // Session-open guard — every tick, but a no-op outside the first
    // minutes after a major session opens: locks SL to breakeven on
    // positions already in decent profit, since opens are where reversals
    // hit hardest (owner: XAUUSD +$218 → −$261 across a session open).
    try {
      if (creds?.ready) {
        const { runSessionOpenGuard } = await import('./session-open-guard.js')
        await runSessionOpenGuard(db, creds, {
          ...deps,
          notify: (text) => import('./telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
        })
      }
    } catch (err) {
      console.error('[fast-monitor] session-open-guard failed:', err.message)
    }
    // P&L drift watch — every 2nd tick (~60s): Telegram warns when an open
    // trade crosses ±N% of balance (owner audit: nothing warned on drift).
    if (tick % everyTicks(60) === 0) {
      try {
        if (creds?.ready) {
          const { runPnlWatch } = await import('./pnl-watch.js')
          await runPnlWatch(db, creds)
        }
      } catch (err) {
        console.error('[fast-monitor] pnl-watch failed:', err.message)
      }
      // Hard per-position loss cap (owner 2026-07-28, the GOOGL −$900 case):
      // same 60s broker-truth cadence, but this one ACTS — closes a position
      // whose floating loss breached the $/% cap instead of only messaging.
      try {
        if (creds?.ready) {
          const { runLossCap } = await import('./loss-cap.js')
          const lc = await runLossCap(db, creds)
          if (lc.closes || lc.errors.length) console.log(`[fast-monitor] loss-cap: ${lc.closes} close(s), ${lc.errors.length} error(s) ${lc.errors.join(' · ')}`)
        }
      } catch (err) {
        console.error('[fast-monitor] loss-cap failed:', err.message)
      }
      // Profit ratchet v2 (owner-approved A4, reworked 01-08): PER-ACCOUNT
      // equity staircases — soft warning band, hysteresis on the hard floor,
      // per-account halt/flatten, auto re-arm. Never touches the S.A.T. keys.
      try {
        if (creds?.ready) {
          const { runProfitRatchet } = await import('./profit-ratchet.js')
          const pr = await runProfitRatchet(db, creds)
          for (const a of pr?.accounts || []) {
            if (a.triggered) console.log(`[fast-monitor] profit-ratchet TRIGGERED on ${a.accountId} at equity ${a.equity} — ${a.closes} close(s)`)
            else if (a.rearmed) console.log(`[fast-monitor] profit-ratchet re-armed on ${a.accountId} at equity ${a.equity}`)
          }
        }
      } catch (err) {
        console.error('[fast-monitor] profit-ratchet failed:', err.message)
      }
    }
    try {
      const hb = deps.heartbeat ?? await import('./heartbeat.js')
      hb.beat(db, 'fast_monitor', { ok: !tickErr, error: tickErr?.message ?? null })
      if (tick % everyTicks(120) === 0) await hb.probeCppExec(db)
      if (tick % everyTicks(60) === 0) {
        hb.checkHeartbeats(db, {
          notify: (text) => import('./telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
        })
      }
    } catch (err) {
      console.error('[fast-monitor] watchdog failed:', err.message)
    }
    } finally {
      tickRunning = false
    }
  // Owner 2026-07-24: default tick 3s (was 30s) so profit-banking and stop
  // management react inside spike moves; FAST_MONITOR_MS overrides, floored
  // at 1s to keep broker RPC volume inside the 50 req/s connection budget.
  }, tickMs)
  t.unref?.()
  return () => clearInterval(t)
}
