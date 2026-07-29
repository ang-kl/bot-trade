// ---------------------------------------------------------------------------
// agent/scripts/backtest-vol-gate.js — the volatility gate, ON vs OFF.
//
//   node agent/scripts/backtest-vol-gate.js [--bars 5000] [--json out.json]
//   node agent/scripts/backtest-vol-gate.js --symbols EURUSD,XAUUSD --timeframes 1h,4h
//
// WHAT THIS ANSWERS. The gate widens stops in high volatility and demands
// extra confirmation before entering. Both cost something: a wider stop loses
// more when it is hit, and a confirmation requirement forfeits entries that
// never confirm and enters the rest LATER, at a worse price. The question is
// whether the trades it saves outweigh the trades it spoils, and the answer is
// very unlikely to be the same for FX as for gold as for an index.
//
// METHOD, AND WHY IT IS THE ONLY HONEST ONE HERE.
//
//   · Same bars. Each symbol/timeframe is fetched ONCE and both runs walk the
//     identical series. Two fetches could straddle a new bar and the whole
//     difference would be the bar, not the gate.
//
//   · No lookahead. The ON run classifies volatility with
//     classifyVolFromBars, which reads only bars at or before the decision
//     index. Using the live atr_history — today's trailing year — for a bar
//     from eight months ago would flatter the gate precisely where it is being
//     judged.
//
//   · Same policy code. It calls evaluateVolGate, the function the live entry
//     path calls. A re-implementation would be measuring a copy.
//
// WHAT THIS DOES NOT MEASURE. Per-trade P&L here is a percentage, so it is
// size-agnostic. The live system sizes so (stop distance x size) is a fixed %
// of equity, which means a widened stop AUTOMATICALLY takes a smaller
// position. That drawdown benefit is real and invisible to this harness, so
// the ON column understates the gate. Said here rather than left as a
// footnote to be discovered.
//
// Rate limits: daily/intraday bars are HISTORICAL requests, capped by cTrader
// at 5/s and paced to 4/s by ctrader-ws.js. One fetch per symbol-timeframe.
// ---------------------------------------------------------------------------

import { pathToFileURL } from 'node:url'
import { runBacktest } from './backtest-fib.js'

// A spread wide enough that a single asset class cannot carry the verdict.
// The gate's premise — "rank today's ATR against this symbol's own year" — is
// explicitly a cross-asset claim, so testing it on FX alone would prove
// nothing about the claim actually being made.
export const DEFAULT_UNIVERSE = [
  { symbol: 'EURUSD', klass: 'FX major' },
  { symbol: 'GBPJPY', klass: 'FX cross (volatile)' },
  { symbol: 'USDCNH', klass: 'FX EM' },
  { symbol: 'XAUUSD', klass: 'Metal' },
  { symbol: 'NAS100', klass: 'Index' },
  { symbol: 'US500', klass: 'Index' },
  { symbol: 'USOIL', klass: 'Energy' },
  { symbol: 'BTCUSD', klass: 'Crypto' },
]

export const DEFAULT_TIMEFRAMES = ['1h', '4h']

const n2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100)

/**
 * Compare one bar series with the gate off and on.
 *
 * Pure — takes bars, returns numbers. Everything that touches the network
 * lives in main(), so this is testable without a broker.
 */
export function compareOnOff(bars, opts = {}) {
  const off = runBacktest(bars, { ...opts, volGate: false })
  const on = runBacktest(bars, { ...opts, volGate: true })

  // Field names taken from computeStats in backtest-fib.js, not guessed —
  // a mis-typed key reads `undefined`, prints as an em dash, and looks like
  // "no data" rather than "wrong key".
  const summarise = (r) => ({
    trades: r.stats.trades || 0,
    winRate: n2(r.stats.winRatePct),
    netPct: n2(r.stats.totalProfitPct),
    profitFactor: n2(r.stats.profitFactor),
    maxDrawdownPct: n2(r.stats.maxDrawdownPct),
    expectancyPct: n2(r.stats.expectancyPct),
    sharpe: n2(r.stats.sharpeAnnualized),
  })

  const a = summarise(off)
  const b = summarise(on)
  const delta = (k) => (a[k] == null || b[k] == null ? null : n2(b[k] - a[k]))

  return {
    off: a,
    on: b,
    delta: {
      trades: b.trades - a.trades,
      winRate: delta('winRate'),
      netPct: delta('netPct'),
      profitFactor: delta('profitFactor'),
      maxDrawdownPct: delta('maxDrawdownPct'),
      expectancyPct: delta('expectancyPct'),
    },
    volGate: on.volGate || null,
    // Sliced by the regime at entry, because the gate only ever acts in HIGH
    // vol — an aggregate that averages in hundreds of untouched NORMAL trades
    // will show "no effect" even when the effect on the trades it touched is
    // large. This is the number that actually answers the question.
    highVolOnly: sliceByRegime(off.trades, on.trades),
  }
}

/**
 * The gate is inert outside HIGH volatility, so compare only where it acted.
 * OFF has no regime stamp (the gate never ran), so its HIGH-vol subset cannot
 * be recovered from the trade list — reported as the ON-side view plus the
 * count, rather than a fake matched comparison.
 */
function sliceByRegime(offTrades, onTrades) {
  const high = onTrades.filter(t => t.volRegime === 'HIGH')
  if (!high.length) return { trades: 0, note: 'no entries landed in HIGH volatility — the gate never acted' }
  const wins = high.filter(t => t.pnlPct > 0).length
  const net = high.reduce((s, t) => s + t.pnlPct, 0)
  return {
    trades: high.length,
    winRate: n2((wins / high.length) * 100),
    netPct: n2(net),
    shareOfAllTrades: n2((high.length / Math.max(1, onTrades.length)) * 100),
    note: 'ON-side only — the OFF run carries no regime stamp, so this is not a matched pair',
  }
}

/** One line per row, aligned, so the table is readable in a terminal. */
export function formatTable(rows) {
  const head = ['symbol', 'class', 'tf', 'bars', 'n off', 'n on', 'net off', 'net on', 'Δnet', 'win off', 'win on', 'DD off', 'DD on', 'HIGH n']
  const body = rows.map(r => r.error
    ? [r.symbol, r.klass, r.timeframe, '—', '—', '—', '—', '—', r.error.slice(0, 24), '', '', '', '', '']
    : [
      r.symbol, r.klass, r.timeframe, String(r.bars),
      String(r.off.trades), String(r.on.trades),
      fmt(r.off.netPct), fmt(r.on.netPct), fmt(r.delta.netPct),
      fmt(r.off.winRate), fmt(r.on.winRate),
      fmt(r.off.maxDrawdownPct), fmt(r.on.maxDrawdownPct),
      String(r.highVolOnly?.trades ?? 0),
    ])
  const all = [head, ...body]
  const w = head.map((_, i) => Math.max(...all.map(r => String(r[i] ?? '').length)))
  return all.map((r, ri) =>
    r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ')
    + (ri === 0 ? '\n' + w.map(x => '-'.repeat(x)).join('  ') : '')
  ).join('\n')
}
const fmt = (x) => (x == null ? '—' : x.toFixed(2))

/**
 * The verdict, stated in the terms a decision needs. Deliberately refuses to
 * declare a winner on a thin sample: a gate evaluated on nine trades is not
 * evaluated.
 */
export function verdict(rows, { minTrades = 30 } = {}) {
  const usable = rows.filter(r => !r.error && r.off.trades >= minTrades)
  if (!usable.length) {
    return {
      call: 'INCONCLUSIVE',
      why: `no symbol/timeframe reached ${minTrades} baseline trades — the sample cannot support a verdict either way`,
    }
  }
  const better = usable.filter(r => (r.delta.netPct ?? 0) > 0)
  const worse = usable.filter(r => (r.delta.netPct ?? 0) < 0)
  const ddBetter = usable.filter(r => (r.delta.maxDrawdownPct ?? 0) < 0)
  const touched = usable.filter(r => (r.highVolOnly?.trades ?? 0) > 0)

  return {
    usableRows: usable.length,
    netBetter: better.length,
    netWorse: worse.length,
    drawdownImproved: ddBetter.length,
    rowsWhereGateActed: touched.length,
    call: touched.length === 0
      ? 'NO-OP — the gate never reached HIGH volatility on this sample; ON and OFF are the same run'
      : better.length > worse.length * 2 ? 'FAVOURS ON'
        : worse.length > better.length * 2 ? 'FAVOURS OFF'
          : 'MIXED — no consistent direction across asset classes',
    caveat: 'per-trade P&L here is size-agnostic; live sizing shrinks the position when the stop widens, so the ON side understates the real drawdown benefit',
  }
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (k, d) => {
    const i = args.indexOf(`--${k}`)
    return i >= 0 && args[i + 1] ? args[i + 1] : d
  }
  const barCount = Number(opt('bars', 5000))
  const symbols = opt('symbols', null)
  const timeframes = String(opt('timeframes', DEFAULT_TIMEFRAMES.join(','))).split(',')
  const strategy = opt('strategy', 'fib_618_fade')
  const jsonOut = opt('json', null)

  const universe = symbols
    ? symbols.split(',').map(s => ({ symbol: s.trim().toUpperCase(), klass: 'custom' }))
    : DEFAULT_UNIVERSE

  const { initDB } = await import('../db.js')
  const { getCtraderCreds, getSymbolMap } = await import('../lib/ctrader-creds.js')
  const { wsGetTrendbarsBatch, TRENDBAR_PERIODS } = await import('../lib/ctrader-ws.js')

  const db = initDB(process.env.DB_PATH || './agent.db')
  const creds = getCtraderCreds(db)
  if (!creds.ready) {
    console.error('cTrader credentials not configured — set CTRADER_CLIENT_ID/SECRET and seed the token/account in the agent DB')
    process.exit(1)
  }
  const map = getSymbolMap(db)

  const rows = []
  for (const { symbol, klass } of universe) {
    const symbolId = map[symbol]
    if (!symbolId) {
      // Named, not skipped silently — a symbol missing from the map would
      // otherwise vanish from the table and quietly narrow the universe.
      for (const tf of timeframes) rows.push({ symbol, klass, timeframe: tf, error: 'symbolId unknown' })
      continue
    }
    let fetched
    try {
      fetched = await wsGetTrendbarsBatch(
        creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId,
        symbolId, timeframes, barCount,
      )
    } catch (err) {
      for (const tf of timeframes) rows.push({ symbol, klass, timeframe: tf, error: err.message })
      continue
    }

    for (const tf of timeframes) {
      let bars = fetched[tf] || []
      const periodMs = TRENDBAR_PERIODS[tf]?.ms || 0
      const last = bars[bars.length - 1]
      if (last && last.t + periodMs > Date.now()) bars = bars.slice(0, -1)  // drop the forming bar
      if (bars.length < 300) {
        rows.push({ symbol, klass, timeframe: tf, error: `only ${bars.length} bars` })
        continue
      }
      try {
        const cmp = compareOnOff(bars, { timeframe: tf, strategy, symbol })
        rows.push({ symbol, klass, timeframe: tf, bars: bars.length, ...cmp })
      } catch (err) {
        rows.push({ symbol, klass, timeframe: tf, error: err.message })
      }
    }
  }

  console.log(`\nVolatility gate — ON vs OFF · strategy=${strategy} · ${barCount} bars requested\n`)
  console.log(formatTable(rows))
  console.log('\nVerdict:', JSON.stringify(verdict(rows), null, 2))

  if (jsonOut) {
    const fs = await import('node:fs')
    fs.writeFileSync(jsonOut, JSON.stringify({ strategy, barCount, rows, verdict: verdict(rows) }, null, 2))
    console.log(`\nwrote ${jsonOut}`)
  }
  db.close()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('vol-gate comparison failed:', err.message)
    process.exit(1)
  })
}
