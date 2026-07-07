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
import { computeFibSignal } from '../services/fib-strategy.js'

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

  const trades = []
  let pos = null            // { dir, entry, sl, tp, entryT, capMs }
  let cooldownUntil = -1

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
    })
    cooldownUntil = exitT + cooldownMs
    pos = null
  }

  for (let i = WARMUP_BARS; i < bars.length - 1; i++) {
    const next = bars[i + 1]

    if (pos) {
      // Conservative intra-bar sequencing: stop-loss checked before target.
      if (pos.dir > 0 ? next.l <= pos.sl : next.h >= pos.sl) {
        closeTrade(pos.sl, next.t, 'sl')
      } else if (pos.dir > 0 ? next.h >= pos.tp : next.l <= pos.tp) {
        closeTrade(pos.tp, next.t, 'tp')
      } else if (pos.capMs && next.t - pos.entryT >= pos.capMs) {
        closeTrade(next.c, next.t, 'time_cap')
      }
      continue
    }

    if (next.t < cooldownUntil) continue

    const signal = computeFibSignal(bars.slice(0, i + 1), timeframe, { rsiFilter: opts.rsiFilter || null })
    if (!signal || signal.rr < MIN_RR) continue

    pos = {
      dir: signal.bias === 'long' ? 1 : -1,
      entry: next.o, // fill at next bar's open, not the signal close
      sl: signal.sl,
      tp: signal.tp1,
      entryT: next.t,
      capMs: signal.time_cap_minutes ? signal.time_cap_minutes * 60_000 : 0,
    }
  }
  if (pos) closeTrade(bars[bars.length - 1].c, bars[bars.length - 1].t, 'end_of_data')

  return { trades, stats: computeStats(trades) }
}

function computeStats(trades) {
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
    exits: {
      sl: trades.filter(t => t.reason === 'sl').length,
      tp: trades.filter(t => t.reason === 'tp').length,
      time_cap: trades.filter(t => t.reason === 'time_cap').length,
    },
  }
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
