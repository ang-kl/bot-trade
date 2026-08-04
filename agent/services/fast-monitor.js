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
 * Sub-cadence gate for the ticker — "has `everySec` actually elapsed for this
 * sub-task?", measured in TIME.
 *
 * WHY THIS IS NOT `tick % everyTicks(n) === 0` (incident 02-08-2026). The
 * ticker increments `tick` on every interval firing, INCLUDING the firings the
 * overlap guard skips because the previous pass is still running. The
 * sub-cadences were exact modulos on that counter, so a sub-task only ran if a
 * multiple of its period happened to coincide with a tick where the body
 * actually started — and the run-start ticks are a sparse arithmetic
 * progression whose step is the pass duration. When that step shares a factor
 * with the period, the two never meet and the sub-task NEVER RUNS.
 *
 * That is not hypothetical. `cpp_exec` went 26 hours without a single
 * heartbeat — not a failed beat, no beat at all — while a manual probe of the
 * same sidecar answered instantly. `probeCppExec` was never called, so the
 * credential re-push self-heal inside it never ran either: a fix that was
 * deployed, correct, and unreachable. `checkHeartbeats` (the stall alerter),
 * `runPnlWatch`, `runLossCap` and `runProfitRatchet` sat behind the same kind
 * of modulo — the last two ACT on money.
 *
 * Time is the thing these cadences were always specified in; the code comment
 * above even claimed they were "TIME-based". Now they are.
 *
 * Re-anchors from `nowMs` rather than the missed deadline on purpose: a pass
 * that ran late owes one run, not a backlog of them.
 */
// A slow pass must not starve the ticker.
//
// The loop wrapped these in runBudgetedSubPhase for exactly this reason. On
// the fast path the stake is higher: the 3-second tick is what re-prices spike
// windows, and tickRunning makes a long pass skip ticks rather than overlap
// them. So a keeper that hangs on a broker call would silently disable spike
// protection for as long as it hangs.
//
// The work is NOT cancelled — it finishes detached, and its own writes are
// idempotent. Only the WAIT is abandoned, so the tick returns and the ticker
// keeps its cadence.
export async function withBudget(name, budgetMs, work) {
  let timer = null
  const startedAt = Date.now()
  const raced = await Promise.race([
    Promise.resolve().then(work).then(v => ({ value: v }), e => ({ error: e })),
    // NOT unref'd, deliberately. An unref'd budget timer cannot fire when it is
    // the only thing left on the event loop, so the race never settles and the
    // caller silently returns nothing. In the ticker that never happens (the
    // 3s interval keeps the loop alive), which is exactly what makes it the
    // kind of bug you find in production rather than in a test. The timer is
    // short and cleared on both paths, so keeping it referenced costs nothing.
    new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), budgetMs) }),
  ])
  if (timer) clearTimeout(timer)
  if (raced.timedOut) {
    const msg = `${name} exceeded its ${Math.round(budgetMs / 1000)}s budget after ${Math.round((Date.now() - startedAt) / 1000)}s — wait abandoned, run continues detached`
    console.warn(`[fast-monitor] ${msg}`)
    return { timedOut: true, error: new Error(msg) }
  }
  if (raced.error) return { error: raced.error }
  return { value: raced.value }
}

export function makeCadenceGate() {
  const nextAt = new Map()
  return function due(key, everySec, nowMs) {
    const at = nextAt.get(key)
    if (at === undefined || nowMs >= at) {
      nextAt.set(key, nowMs + everySec * 1000)
      return at !== undefined // first sighting arms the timer, it does not fire
    }
    return false
  }
}

/**
 * Start the ticker. Returns a stop() handle (tests, shutdown).
 *
 * The ticker doubles as the reliability watchdog — deliberately independent
 * of the main loop so a silently dead main loop is still detected: every
 * pass beats the fast_monitor heartbeat, every 60s runs the stall check
 * (checkHeartbeats → Telegram alert), every 120s actively probes the C++
 * exec engine's GET /health when EXEC_ENGINE=cpp. Those sub-cadences are
 * gated by `due()` — see makeCadenceGate for why they are not tick counts.
 */
export function startFastMonitor(db, getCreds, deps = {}) {
  const due = deps.due ?? makeCadenceGate()
  const clock = deps.clock ?? (() => Date.now())
  // Owner 2026-07-24: default tick 3s (was 30s) so spike windows re-price at
  // tick speed; FAST_MONITOR_MS overrides, floored at 1s. Sub-task cadences
  // below are wall-clock so a faster ticker doesn't multiply pnl-watch /
  // watchdog / cpp-probe traffic.
  const tickMs = deps.tickMs ?? Math.max(1_000, Number(process.env.FAST_MONITOR_MS) || 3_000)
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
    // One clock read per pass, so every sub-cadence below judges itself
    // against the same instant.
    const nowMs = clock()
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
    // P&L drift watch — every 60s: Telegram warns when an open trade crosses
    // ±N% of balance (owner audit: nothing warned on drift).
    if (due('pnl_watch', 60, nowMs)) {
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
          // ACROSS EVERY ENABLED ACCOUNT, not just the selected one. Until
          // 2026-08-03 this called runLossCap(db, creds) — one account — so
          // every other account ran with no per-position loss cap. A USDZAR
          // position reached −$2,186 against an $800 cap because the cap was
          // never asked about that account.
          const { runLossCapAllAccounts } = await import('./loss-cap.js')
          const lc = await runLossCapAllAccounts(db, creds)
          if (lc.closes || lc.errors.length) console.log(`[fast-monitor] loss-cap: ${lc.accounts} account(s), ${lc.closes} close(s), ${lc.errors.length} error(s) ${lc.errors.join(' · ')}`)
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
      // TRADE GUARDS + PROFIT KEEPER — MOVED here from the loop, not copied.
      //
      // §43 wants protection on its own path; §36.2.3 forbids duplicating an
      // ACTING one: "Two components must not unknowingly write the same stop."
      // The protection audit only reads, so it runs on both paths deliberately.
      // These two MOVE stops and CLOSE positions, so their LOOP call sites are
      // gone — the loop no longer runs them at all.
      //
      // CORRECTION (2026-08-04): this comment used to claim they run "here and
      // ONLY here". That was written about loop.js and was wrong the moment
      // the guardian existed — guardian.js also calls runTradeGuards and
      // runProfitKeeper on every ≥0.05% price move, which is deliberate (§70.6
      // wants price-shaped rules on a price trigger) but means TWO clocks
      // enter the same module. Neither module had a re-entrancy guard, and
      // `withBudget` below abandons the WAIT rather than the work, so a slow
      // pass was still running when the next one started.
      //
      // The invariant now lives in the layers themselves: acting-layer.js's
      // singleFlight means a second caller JOINS the pass in flight instead of
      // starting another. Two clocks, one pass.
      //
      // Budgeted: the loop wrapped them in runBudgetedSubPhase for the same
      // reason, and the stake is higher here because a hung pass would make
      // tickRunning skip the 3-second ticks that spike protection depends on.
      for (const job of [
        { key: 'trade_guards', label: 'Trade guards', mod: './trade-guard.js', fn: 'runTradeGuards',
          say: r => (r.slMoves || r.partialCloses) ? `${r.slMoves} SL move(s), ${r.partialCloses} partial close(s)` : null },
        { key: 'profit_keeper', label: 'Profit Keeper', mod: './profit-keeper.js', fn: 'runProfitKeeper',
          say: r => (r.slMoves || r.closes) ? `${r.slMoves} lock(s), ${r.closes} close(s)` : null },
        // The safety net for LOSING and NAKED positions the Profit Keeper will
        // not touch. Last of the level-4 writers off the loop, and the one
        // that most needed to be: it is what puts a stop on a position that
        // has none.
        { key: 'loss_guardian', label: 'Loss Guardian', mod: './loss-guardian.js', fn: 'runLossGuardian',
          say: r => (r.stops || r.closes) ? `${r.stops} protective stop(s), ${r.closes} close(s)` : null },
      ]) {
        try {
          if (!creds?.ready) break
          const m = await import(job.mod)
          const res = await withBudget(job.key, 45_000, () => m[job.fn](db, creds, {
            notify: (text) => import('./telegram-control.js').then(t => t.notifyOwner(text)).catch(() => {}),
          }))
          const hb = deps.heartbeat ?? await import('./heartbeat.js')
          if (res.error) {
            console.error(`[fast-monitor] ${job.label} failed:`, res.error.message)
            hb.beat(db, job.key, { ok: false, error: res.error.message })
          } else {
            const line = job.say(res.value || {})
            if (line) console.log(`[fast-monitor] ${job.label}: ${line}`)
            if (res.value?.errors?.length) console.error(`[fast-monitor] ${job.label} errors: ${res.value.errors.join(' · ')}`)
            hb.beat(db, job.key, { ok: true })
          }
        } catch (err) {
          console.error(`[fast-monitor] ${job.label} threw:`, err.message)
          try {
            const hb = deps.heartbeat ?? await import('./heartbeat.js')
            hb.beat(db, job.key, { ok: false, error: err.message })
          } catch { /* heartbeat is best-effort */ }
        }
      }
      // PROTECTION AUDIT — Operating Goal Plan §43, the Non-Negotiable Rule:
      // protection must have its OWN functioning and observable path, not a
      // seat on the strategy loop.
      //
      // It had one home, inside the loop's per-account reconcile block, where
      // it shared a phase with order_monitor. On 2026-08-04 both went stalled
      // at the same instant — 961s old against a 314s expectation — because
      // that one phase had not completed. For sixteen minutes nothing asked
      // whether the open positions still had stops at the broker, and the only
      // layer still working was the broker's own.
      //
      // This path does not depend on the loop. The fast monitor has its own
      // 3s ticker and its own overlap guard, and it is where the loop's
      // watchdog lives — so it keeps auditing precisely when the loop is the
      // thing that broke. §70.7: the five-minute loop is never the sole
      // position protector.
      try {
        if (creds?.ready) {
          const { runProtectionAuditAllAccounts } = await import('./naked-position-guard.js')
          const pa = await runProtectionAuditAllAccounts(db, creds, deps)
          if (pa.naked || pa.targetless || pa.phantom) {
            console.warn(`[fast-monitor] protection audit: ${pa.naked} naked, ${pa.targetless} targetless, ${pa.phantom} stop disagreement(s) across ${pa.accounts} account(s)`)
          }
          if (pa.errors.length) console.error(`[fast-monitor] protection audit errors: ${pa.errors.join(' · ')}`)
          if (pa.unauditable.length) console.warn(`[fast-monitor] protection audit could not reach: ${pa.unauditable.join(' · ')}`)
          // BEAT ON THIS PATH TOO. The controller is what tells the operator
          // protection is being checked; if only the loop could beat it, this
          // path could run perfectly while the panel still read "stalled".
          //
          // An UNAUDITABLE account does not fail the beat — see
          // runProtectionAuditAllAccounts. 5268549's token does not cover it,
          // and letting that hold the controller red forever would train the
          // operator to ignore the one light that says their positions are
          // being checked.
          const hb = deps.heartbeat ?? await import('./heartbeat.js')
          hb.beat(db, 'protection_audit', {
            ok: pa.errors.length === 0,
            error: pa.errors.length ? pa.errors.join(' · ') : null,
          })
        }
      } catch (err) {
        console.error('[fast-monitor] protection-audit failed:', err.message)
        try {
          const hb = deps.heartbeat ?? await import('./heartbeat.js')
          hb.beat(db, 'protection_audit', { ok: false, error: err.message })
        } catch { /* heartbeat is best-effort */ }
      }
    }
    try {
      const hb = deps.heartbeat ?? await import('./heartbeat.js')
      hb.beat(db, 'fast_monitor', { ok: !tickErr, error: tickErr?.message ?? null })
      if (due('cpp_probe', 120, nowMs)) await hb.probeCppExec(db)
      if (due('watchdog', 60, nowMs)) {
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
