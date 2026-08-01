// ---------------------------------------------------------------------------
// agent/scripts/backtest-fib.js — walk-forward backtest of the PRODUCTION
// fib 61.8% fade rule (computeFibSignal) on cTrader history.
//
//   node agent/scripts/backtest-fib.js --symbol EURUSD --timeframe 4h \
//     --bars 3000 --cost-pct 0.02 [--all-timeframes]
//
// Credentials come from the agent DB (DB_PATH env, default ./agent.db) +
// CTRADER_CLIENT_ID/SECRET env vars — same getCtraderCreds path the live
// loop uses.
//
// Honesty notes (this is deliberately more conservative than the reference
// backtest, which assumed perfect fills and zero costs):
// - entries fill at the NEXT bar's open, not the signal bar's close
// - --cost-pct (default 0.02% round trip) is deducted from every trade
// - when SL and TP are both inside one bar, SL wins (conservative)
// - the production per-symbol cooldown (240 min) is simulated
// - signals below risk.js's minRR (1.5) are skipped, as the live gate would
// ---------------------------------------------------------------------------

import { pathToFileURL } from 'node:url'
// Strategies resolve through the registry — any registry key is backtestable.
import { STRATEGY_REGISTRY, strategyByKey, minRrFor } from '../services/strategies.js'
// HVN-TP G4 sweep: the SAME target rule the advice path offers, so what the
// sweep measures is what the trader is shown.
import { hvnTargetPrice } from '../lib/bracket-advice.js'
import { inPrimeSession } from '../lib/sessions.js'
// D5 — the volatility gate, evaluated point-in-time. classifyVolFromBars reads
// only bars at or before the decision index, so the ON run cannot be flattered
// by a distribution its trader could not have seen. evaluateVolGate is the
// SAME function the live entry path calls; the backtest does not re-implement
// the policy, it only supplies the inputs and applies the outputs.
import { classifyVolFromBars, ATR_PERIOD } from '../services/vol-gate.js'
import { evaluateVolGate } from '../services/vol-adjust.js'
import { meanAtr } from '../services/regime.js'

/**
 * Resolve whether `bar` exits the position, honestly:
 * - SL before TP when both are inside the bar (conservative)
 * - a bar that OPENS beyond the SL fills at that open, not the SL — gap
 *   slippage is real (weekend gaps on indices/commodities)
 * - a bar that opens beyond the TP still books only the TP (never better)
 * @returns {{price:number, reason:string}|null}
 */
/**
 * Resolve a resting limit order against a bar (touch-fill mode):
 * 'cancel' when the bar CLOSES beyond the stop (setup invalidated before
 * fill) or the order expired; 'fill' when the bar's range touches the level.
 * Cancel is checked first — a bar that blows through the level to beyond
 * the stop would fill a real limit, but modelling it as a fill would book
 * an instant loss the close-confirmed rule never takes; counting it as a
 * cancel is the OPTIMISTIC branch, so the honest reading is a coin we
 * deliberately call AGAINST the strategy elsewhere (SL-first). Documented
 * trade-off, revisit with tick data.
 * @returns {'fill'|'cancel'|null}
 */
export function resolvePending(pending, bar) {
  if (bar.t >= pending.expireT) return 'cancel'
  if (pending.dir > 0 ? bar.c <= pending.sl : bar.c >= pending.sl) return 'cancel'
  if (bar.l <= pending.level && pending.level <= bar.h) return 'fill'
  return null
}

export function resolveExit(pos, bar) {
  if (pos.dir > 0 ? bar.l <= pos.sl : bar.h >= pos.sl) {
    const price = pos.dir > 0 ? Math.min(pos.sl, bar.o) : Math.max(pos.sl, bar.o)
    return { price, reason: 'sl' }
  }
  if (pos.dir > 0 ? bar.h >= pos.tp : bar.l <= pos.tp) {
    return { price: pos.tp, reason: 'tp' }
  }
  if (pos.capMs && bar.t - pos.entryT >= pos.capMs) {
    return { price: bar.c, reason: 'time_cap' }
  }
  return null
}

const WARMUP_BARS = 30
const MIN_RR = 1.5
const DEFAULT_COST_PCT = 0.02
const DEFAULT_COOLDOWN_MIN = 240

/**
 * Walk-forward simulation over CLOSED bars using the production signal rule.
 *
 * @param {Array<{t,o,h,l,c,v}>} bars - ascending closed bars
 * @param {{timeframe: string, costPct?: number, cooldownMinutes?: number}} opts
 * @returns {{trades: Array, stats: object}}
 */
export function runBacktest(bars, opts) {
  const { timeframe } = opts
  const costPct = opts.costPct ?? DEFAULT_COST_PCT
  const cooldownMs = (opts.cooldownMinutes ?? DEFAULT_COOLDOWN_MIN) * 60_000
  // R:R floor for THIS run. Defaults to the live risk gate (1.5); the backtest
  // route lowers it (evaluation profile) so a strategy whose targets sit just
  // under 1.5 still produces a testable sample. A strategy with its OWN lower
  // floor (a high-win-rate mean-reversion system) uses that, so the backtest
  // counts the same trades the live risk gate would — matching risk.js.
  const minRr = minRrFor(opts.strategy, opts.minRr ?? MIN_RR)

  const touchMode = opts.entryMode === 'touch'
  // HVN-TP G4 sweep (instr/hvn-targeted-tp-spec.md §6). tpMode:
  //   'rrFloor'   (default) — the strategy's own tp1, byte-identical to today
  //   'hvn-edge'  — replace tp1 with the HVN near-edge target when one
  //                 qualifies (same suppression rules as the advice path:
  //                 below the strategy floor or beyond 3× it → fall back)
  //   'nearer-of' — whichever of tp1 / HVN target is CLOSER to entry
  // hvnFraction varies HVN_MIN_POC_FRACTION (0.6/0.7/0.8); hvnLookback caps
  // the profile window in bars (default 240 — what the manual route fetches).
  const tpMode = opts.tpMode === 'hvn-edge' || opts.tpMode === 'nearer-of' ? opts.tpMode : 'rrFloor'
  const hvnLookback = Number.isFinite(opts.hvnLookback) ? opts.hvnLookback : 240
  const tpFor = (dir, entry, sl, signalTp, i) => {
    if (tpMode === 'rrFloor') return signalTp
    const win = bars.slice(Math.max(0, i + 1 - hvnLookback), i + 1)
    const hvn = hvnTargetPrice({ entry, sl, bars: win, rrFloor: minRr, minPocFraction: opts.hvnFraction })
    if (hvn == null) return signalTp
    if (tpMode === 'hvn-edge') return hvn
    return dir === 1 ? Math.min(signalTp, hvn) : Math.max(signalTp, hvn)
  }
  // D5 — vol gate OFF by default so every existing caller is byte-identical.
  const volGateOn = opts.volGate === true || opts.volGate === 'on'
  const trades = []
  let pos = null            // { dir, entry, sl, tp, entryT, capMs }
  let pending = null        // touch mode: resting limit at the 61.8 level
  let cooldownUntil = -1
  // Counters so an ON run can say WHY it differs, not just that it does.
  const volStats = { high: 0, normal: 0, low: 0, stopsWidened: 0, confirmationsRequired: 0, confirmationsTimedOut: 0 }

  /**
   * The gate's verdict for the bar being decided on, or null when it is off.
   * Inputs the adjusters need (atr, relativeVolume) are derived from the same
   * bars, using regime.js's meanAtr — the single owner of ATR in this system.
   */
  const gateAt = (i, signal) => {
    if (!volGateOn) return null
    const vol = classifyVolFromBars(bars, i, { period: ATR_PERIOD, lookback: opts.volLookback ?? 252 })
    const atr = meanAtr(bars, ATR_PERIOD, i)
    // Relative volume against the same trailing window the ATR percentile
    // uses, so §3.4's thin-participation test is on a comparable basis.
    let relativeVolume = null
    const from = Math.max(0, i - 20)
    let vsum = 0, vn = 0
    for (let k = from; k < i; k++) { const v = Number(bars[k]?.v); if (Number.isFinite(v)) { vsum += v; vn++ } }
    const vnow = Number(bars[i]?.v)
    if (vn > 0 && vsum > 0 && Number.isFinite(vnow)) relativeVolume = vnow / (vsum / vn)

    if (vol.regime === 'HIGH') volStats.high++
    else if (vol.regime === 'LOW') volStats.low++
    else volStats.normal++

    return evaluateVolGate(vol, [{
      strategy: opts.strategy,
      atr: Number.isFinite(atr) && atr > 0 ? atr : null,
      relativeVolume,
      originVolRegime: signal?.origin_vol_regime || null,
    }], { mode: 'enforce' })
  }

  /**
   * Apply the gate's stop widening. The widening always moves the stop AWAY
   * from entry — never toward it — so this can only ever loosen a stop, never
   * tighten one into the market.
   *
   * Note on sizing: the live system derives lots so (stop distance x size) is
   * a fixed % of equity, which means a wider stop AUTOMATICALLY shrinks the
   * position. This backtest reports per-trade pnlPct, which is size-agnostic,
   * so the ON run shows the stop's effect on WIN RATE and R, not the
   * accompanying size reduction. That understates the gate's drawdown benefit
   * and is stated here rather than left for a reader to discover.
   */
  const widenStop = (dir, entry, sl, verdict) => {
    const w = Number(verdict?.stopWidenPrice)
    if (!Number.isFinite(w) || w <= 0) return sl
    volStats.stopsWidened++
    return dir === 1 ? sl - w : sl + w
  }

  const closeTrade = (exitPrice, exitT, reason) => {
    const gross = pos.dir * ((exitPrice - pos.entry) / pos.entry) * 100
    trades.push({
      dir: pos.dir,
      entry: pos.entry,
      exit: exitPrice,
      entryT: pos.entryT,
      exitT,
      pnlPct: gross - costPct,
      reason,
      // Carried from the signal that opened this trade, when the strategy
      // provides it (undefined for strategies that don't) — lets
      // computeStats report how often a stop-clamp band actually binds,
      // instead of that being invisible outside the live position rows.
      slAtrMult: pos.slAtrMult,
      slWidenedToFloor: pos.slWidenedToFloor,
      // D5 — the vol regime at entry, so an ON run can be sliced by regime
      // instead of only compared in aggregate.
      volRegime: pos.volRegime ?? null,
    })
    cooldownUntil = exitT + cooldownMs
    pos = null
  }

  for (let i = WARMUP_BARS; i < bars.length - 1; i++) {
    const next = bars[i + 1]

    if (pos) {
      const exit = resolveExit(pos, next)
      if (exit) closeTrade(exit.price, next.t, exit.reason)
      continue
    }

    if (pending) {
      const r = resolvePending(pending, next)
      if (r === 'cancel') { pending = null }
      else if (r === 'fill') {
        pos = {
          dir: pending.dir, entry: pending.level, sl: pending.sl, tp: pending.tp,
          entryT: next.t, capMs: pending.capMs,
          slAtrMult: pending.slAtrMult, slWidenedToFloor: pending.slWidenedToFloor,
          volRegime: pending.volRegime ?? null,
        }
        pending = null
        const sameBar = resolveExit(pos, next)
        if (sameBar) closeTrade(sameBar.price, next.t, sameBar.reason)
        continue
      }
      // while an order rests, no new setups are sought (one order at a time)
      continue
    }

    if (next.t < cooldownUntil) continue
    // Session filter (off by default): only enter when the instrument's
    // market is in its prime-liquidity window at the entry bar's time.
    if (opts.sessionFilter && opts.symbol && !inPrimeSession(opts.symbol, next.t)) continue

    // Registry-resolved strategy; unknown keys fall back to the baseline
    // (first registry entry = fib). Touch (resting-order) mode only applies
    // to pendingCapable strategies — others always enter at market.
    const strat = strategyByKey(opts.strategy) || STRATEGY_REGISTRY[0]
    const signal = strat.compute(bars.slice(0, i + 1), timeframe, {
      rsiFilter: opts.rsiFilter || null,
      vwapFilter: opts.vwapFilter || null,
      fvgFilter: opts.fvgFilter || null,
      // touch mode: fib zones are valid resting-order levels pre-touch
      pendingSetup: touchMode && strat.pendingCapable,
      // strategies with an internal rr gate honour the run's floor
      minRr,
    })
    if (!signal || signal.rr < minRr) continue
    // Fidelity with live autotrade: only take entries the bot would actually
    // fire on (conviction >= 8 by default, same bar as synthesizeFibSignal).
    // Pass minConviction: 0 to test every zone touch instead.
    if (signal.conviction < (opts.minConviction ?? 8)) continue

    // D5 — the volatility gate, at the moment of the entry decision.
    const dir0 = signal.bias === 'long' ? 1 : -1
    const verdict = gateAt(i, signal)

    // Confirmation candles: the gate wants N more closes in the signal's
    // direction before committing. Modelled as a real wait — the entry moves
    // to a LATER bar at a WORSE price, which is the honest cost of confirming.
    // If the move does not confirm, the trade is never taken.
    if (verdict?.confirmationCandles > 0) {
      const need = verdict.confirmationCandles
      volStats.confirmationsRequired++
      let ok = true
      for (let k = 1; k <= need; k++) {
        const b = bars[i + k]
        const prev = bars[i + k - 1]
        if (!b || !prev) { ok = false; break }
        if (dir0 === 1 ? !(b.c > prev.c) : !(b.c < prev.c)) { ok = false; break }
      }
      if (!ok) { volStats.confirmationsTimedOut++; continue }
      // Skip the bars we waited through so the loop cannot re-enter on them.
      const entryBar = bars[i + need + 1]
      if (!entryBar) continue
      pos = {
        dir: dir0,
        entry: entryBar.o,
        sl: widenStop(dir0, entryBar.o, signal.sl, verdict),
        tp: tpFor(dir0, entryBar.o, widenStop(dir0, entryBar.o, signal.sl, verdict), signal.tp1, i + need),
        entryT: entryBar.t,
        capMs: signal.time_cap_minutes ? signal.time_cap_minutes * 60_000 : 0,
        slAtrMult: signal.sl_atr_mult,
        slWidenedToFloor: signal.sl_widened_to_floor,
        volRegime: verdict.entryVolRegime,
      }
      i += need
      const sameBarC = resolveExit(pos, entryBar)
      if (sameBarC) closeTrade(sameBarC.price, entryBar.t, sameBarC.reason)
      continue
    }

    if (touchMode && strat.pendingCapable) {
      // Park a limit at the level instead of entering at market. TTL = the
      // signal's own time cap — a zone older than its trade horizon is stale.
      const capMs = signal.time_cap_minutes ? signal.time_cap_minutes * 60_000 : 86_400_000
      pending = {
        dir: dir0,
        level: signal.entry, // = level618 in pendingSetup mode
        sl: widenStop(dir0, signal.entry, signal.sl, verdict),
        tp: tpFor(dir0, signal.entry, widenStop(dir0, signal.entry, signal.sl, verdict), signal.tp1, i),
        capMs,
        expireT: next.t + capMs,
        slAtrMult: signal.sl_atr_mult,
        slWidenedToFloor: signal.sl_widened_to_floor,
        volRegime: verdict?.entryVolRegime ?? null,
      }
      continue
    }
    pos = {
      dir: dir0,
      entry: next.o, // fill at next bar's open, not the signal close
      sl: widenStop(dir0, next.o, signal.sl, verdict),
      tp: tpFor(dir0, next.o, widenStop(dir0, next.o, signal.sl, verdict), signal.tp1, i),
      entryT: next.t,
      capMs: signal.time_cap_minutes ? signal.time_cap_minutes * 60_000 : 0,
      slAtrMult: signal.sl_atr_mult,
      slWidenedToFloor: signal.sl_widened_to_floor,
      volRegime: verdict?.entryVolRegime ?? null,
    }
    // The entry bar's own range can hit the SL/TP after the open fill —
    // skipping it understated losses (audit flaw #1).
    const sameBar = resolveExit(pos, next)
    if (sameBar) closeTrade(sameBar.price, next.t, sameBar.reason)
  }
  if (pos) closeTrade(bars[bars.length - 1].c, bars[bars.length - 1].t, 'end_of_data')

  return {
    trades,
    stats: computeStats(trades),
    ...(volGateOn ? { volGate: volStats } : {}),
  }
}

export function computeStats(trades) {
  const n = trades.length
  if (n === 0) return { trades: 0 }
  const wins = trades.filter(t => t.pnlPct > 0)
  const losses = trades.filter(t => t.pnlPct <= 0)
  const grossWin = wins.reduce((s, t) => s + t.pnlPct, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0))

  let equity = 0
  let peak = 0
  let maxDrawdown = 0
  for (const t of trades) {
    equity += t.pnlPct
    if (equity > peak) peak = equity
    if (peak - equity > maxDrawdown) maxDrawdown = peak - equity
  }

  const round2 = x => Math.round(x * 100) / 100
  const mean = trades.reduce((s, t) => s + t.pnlPct, 0) / n
  // Risk metrics per FinWorld (KDD'26) Appendix D Table 7 — see
  // doc_reference/FinWorld-KDD26-notes.md. rf = 0; annualisation factor is
  // trades-per-year over the tested span (per-trade return series).
  const std = Math.sqrt(trades.reduce((s, t) => s + (t.pnlPct - mean) ** 2, 0) / n)
  const spanYears = n > 1 ? (trades[n - 1].exitT - trades[0].entryT) / (365.25 * 86_400_000) : 0
  const perYear = spanYears > 0 ? n / spanYears : 0
  const sharpe = std > 0 && perYear > 0 ? (mean / std) * Math.sqrt(perYear) : null
  // Sortino: penalise only downside deviation
  const dd = Math.sqrt(trades.reduce((s, t) => s + Math.min(t.pnlPct, 0) ** 2, 0) / n)
  const sortino = dd > 0 && perYear > 0 ? (mean / dd) * Math.sqrt(perYear) : null
  // ARR: compounded annualised return over the span
  const growth = trades.reduce((g, t) => g * (1 + t.pnlPct / 100), 1)
  const arr = spanYears > 0 ? (Math.pow(growth, 1 / spanYears) - 1) * 100 : null
  const calmar = arr != null && maxDrawdown > 0 ? arr / maxDrawdown : null
  const vol = perYear > 0 ? std * Math.sqrt(perYear) : null
  return {
    arrPct: arr != null ? round2(arr) : null,
    sortinoAnnualized: sortino != null ? round2(sortino) : null,
    calmarRatio: calmar != null ? round2(calmar) : null,
    volAnnualizedPct: vol != null ? round2(vol) : null,
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRatePct: round2((wins.length / n) * 100),
    avgProfitPct: round2(mean),
    // expectancy = average % per trade after costs — the "is there an edge" number
    expectancyPct: round2(mean),
    totalProfitPct: round2(equity),
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
    sharpeAnnualized: sharpe != null ? round2(sharpe) : null,
    maxDrawdownPct: round2(maxDrawdown),
    avgDurationMin: round2(trades.reduce((s, t) => s + (t.exitT - t.entryT), 0) / n / 60_000),
    // Tail risk (Riskfolio-Lib's core downside measure): CVaR(95) = mean of
    // the worst 5% of trades. With small N this is simply the worst trade —
    // which is itself the honest answer.
    cvar95Pct: round2(cvar95(trades.map(t => t.pnlPct))),
    // Distribution of drawdowns, not one lucky path: bootstrap-resample the
    // trade sequence 1000× and take the 95th-percentile max drawdown. See
    // doc_reference/microstructure-frequent-trading-notes.md §3.
    mddP95Pct: round2(bootstrapMddP95(trades.map(t => t.pnlPct))),
    exits: {
      sl: trades.filter(t => t.reason === 'sl').length,
      tp: trades.filter(t => t.reason === 'tp').length,
      time_cap: trades.filter(t => t.reason === 'time_cap').length,
    },
    // Rollup of the per-signal stop-clamp telemetry (agent/services/
    // ema-pullback.js's sl_atr_mult / sl_widened_to_floor, or any future
    // strategy that reports the same two fields). null for strategies that
    // don't report it, rather than a misleading zero — "no data" and "the
    // clamp never bound" are different claims. This answers, with counts
    // instead of a guess, whether a stop-distance band is actually shaping
    // trades or sitting unused.
    //
    // What this CANNOT show: a signal vetoed by the ceiling never becomes a
    // trade, so it never reaches this array — "how often did the ceiling
    // refuse a setup" needs counting at the signal level, not here.
    slClamp: (() => {
      const withMult = trades.filter(t => typeof t.slAtrMult === 'number')
      if (!withMult.length) return null
      const widened = withMult.filter(t => t.slWidenedToFloor === true).length
      const mults = withMult.map(t => t.slAtrMult)
      return {
        reporting: withMult.length,
        widenedToFloor: widened,
        widenedToFloorPct: round2((widened / withMult.length) * 100),
        minMult: round2(Math.min(...mults)),
        maxMult: round2(Math.max(...mults)),
        avgMult: round2(mults.reduce((s, m) => s + m, 0) / mults.length),
      }
    })(),
  }
}

/**
 * Walk-forward evaluation: split the bar series into K sequential segments,
 * run the SAME simulation on each, and report per-segment outcomes. One
 * 1,000-bar window is one draw — the literature's majority-pass gate
 * (doc_reference/algo-quant-practice-notes.md §3.1) needs segment evidence.
 * Each segment re-warms up (WARMUP_BARS lost per segment — acceptable).
 *
 * @returns {{segments: Array<{trades:number,totalProfitPct:number,maxDrawdownPct:number}>, active:number, positive:number, worstMddPct:number}}
 */
export function walkForward(bars, opts, K = 4) {
  const segLen = Math.floor(bars.length / K)
  const segments = []
  for (let k = 0; k < K; k++) {
    const slice = bars.slice(k * segLen, k === K - 1 ? bars.length : (k + 1) * segLen)
    const { stats } = runBacktest(slice, opts)
    segments.push({
      trades: stats.trades || 0,
      totalProfitPct: stats.totalProfitPct ?? 0,
      maxDrawdownPct: stats.maxDrawdownPct ?? 0,
    })
  }
  const active = segments.filter(s => s.trades > 0)
  return {
    segments,
    active: active.length,
    positive: active.filter(s => s.totalProfitPct > 0).length,
    worstMddPct: Math.max(0, ...segments.map(s => s.maxDrawdownPct || 0)),
  }
}

/** CVaR(alpha): mean of the worst (1-alpha) share of per-trade returns. */
export function cvar95(returns, alpha = 0.95) {
  const sorted = [...returns].sort((a, b) => a - b)
  const k = Math.max(1, Math.floor(sorted.length * (1 - alpha)))
  return sorted.slice(0, k).reduce((s, r) => s + r, 0) / k
}

/**
 * Bootstrap the trade-return sequence B times (sampling with replacement,
 * seeded PRNG so results are reproducible) and return the 95th-percentile
 * max drawdown across resamples. A single backtest path shows ONE ordering
 * of wins and losses; the same trades in an unluckier order draw down more.
 */
export function bootstrapMddP95(returns, B = 1000, seed = 42) {
  const n = returns.length
  if (n === 0) return 0
  // mulberry32 — tiny deterministic PRNG (seeded for reproducible reports)
  let s = seed >>> 0
  const rand = () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const mdds = new Array(B)
  for (let b = 0; b < B; b++) {
    let equity = 0, peak = 0, mdd = 0
    for (let i = 0; i < n; i++) {
      equity += returns[Math.floor(rand() * n)]
      if (equity > peak) peak = equity
      if (peak - equity > mdd) mdd = peak - equity
    }
    mdds[b] = mdd
  }
  mdds.sort((a, b) => a - b)
  return mdds[Math.min(B - 1, Math.floor(B * 0.95))]
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { bars: 3000, costPct: DEFAULT_COST_PCT, timeframe: '4h' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--symbol') args.symbol = argv[++i]
    else if (a === '--timeframe') args.timeframe = argv[++i]
    else if (a === '--bars') args.bars = parseInt(argv[++i])
    else if (a === '--cost-pct') args.costPct = parseFloat(argv[++i])
    else if (a === '--all-timeframes') args.all = true
    else if (a === '--rsi-filter') args.rsiFilter = {}
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.symbol) {
    console.error('Usage: node agent/scripts/backtest-fib.js --symbol EURUSD [--timeframe 4h] [--bars 3000] [--cost-pct 0.02] [--all-timeframes]')
    process.exit(1)
  }

  const { initDB } = await import('../db.js')
  const { getCtraderCreds, getSymbolMap } = await import('../lib/ctrader-creds.js')
  const { wsGetTrendbarsBatch, TRENDBAR_PERIODS } = await import('../lib/ctrader-ws.js')

  const db = initDB(process.env.DB_PATH || './agent.db')
  const creds = getCtraderCreds(db)
  if (!creds.ready) {
    console.error('cTrader credentials not configured (CTRADER_CLIENT_ID/SECRET env + ctrader_access_token/account_id in agent DB)')
    process.exit(1)
  }
  const symbolId = getSymbolMap(db)[args.symbol.toUpperCase()]
  if (!symbolId) {
    console.error(`symbolId unknown for ${args.symbol} — populate symbol_id_map first (POST /actions/symbol-map)`)
    process.exit(1)
  }

  const timeframes = args.all ? ['1d', '4h', '1h', '30m', '15m', '5m'] : [args.timeframe]
  const fetched = await wsGetTrendbarsBatch(
    creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId,
    symbolId, timeframes, args.bars,
  )

  console.log(`\n${args.symbol} — fib 61.8% fade backtest (cost ${args.costPct}%/trade, next-open fills, SL-first)\n`)
  for (const tf of timeframes) {
    let bars = fetched[tf] || []
    // Drop the forming bar — same closed-bar rule as production.
    const periodMs = TRENDBAR_PERIODS[tf]?.ms || 0
    const last = bars[bars.length - 1]
    if (last && last.t + periodMs > Date.now()) bars = bars.slice(0, -1)

    const { stats } = runBacktest(bars, { timeframe: tf, costPct: args.costPct, rsiFilter: args.rsiFilter || null })
    console.log(`[${tf}] bars=${bars.length}`, JSON.stringify(stats))
  }
  db.close()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('backtest failed:', err.message)
    process.exit(1)
  })
}
