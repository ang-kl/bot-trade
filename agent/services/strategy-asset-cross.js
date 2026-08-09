// agent/services/strategy-asset-cross.js — where the money actually goes.
//
// WHY THIS EXISTS (09-08-2026). The owner asked what happened to the week. The
// answer available was `/state/perf-ledger`'s per-MARKET cut, which said FX lost
// 4,342.97 over 70 trades at PF 0.15 — 76% of the week. That reading pointed at
// an asset class, so the obvious action was "do something about FX".
//
// Then a hand-rolled cross over the most recent 100 closed trades said something
// different: the largest single loser was `fib_confluence on stocks`, 21 trades,
// −2,459.46, ZERO winners. Same account, same week, two incompatible stories —
// because one cut is by asset and the other is by strategy, and neither alone
// can tell you whether an asset class is bad or one strategy is bad AT an asset
// class. Turning off FX when the fault is a strategy that happens to trade FX
// throws away the profitable half; turning off a strategy when the fault is the
// asset does the same in reverse.
//
// AND NEITHER ANSWER WAS TRUSTWORTHY, which is the sharper problem. The only
// per-trade route, `/state/trades`, is `LIMIT 100` hard-coded with no offset and
// no window — so the 183 trades of that week could not be read out of the API at
// all. The 100-row sample skewed to the most recent days and under-counted the
// FX damage, which happened Monday to Wednesday. A week the owner cannot query
// is a week nobody can attribute.
//
// So this module does the cross over a REAL window, server-side, from the same
// rows the ledger uses. It decides nothing and changes nothing: it is the
// measurement that has to exist before anyone switches an instrument or a
// strategy off with the deadline this close.

/**
 * Asset class from the symbol, by the same families the watchlist uses.
 *
 * Deliberately string-matched here rather than imported from the watchlist
 * taxonomy: this reader must keep working for symbols that have since been
 * trimmed off the watchlist, and a closed trade's asset class is a fact about
 * the past that a present-day config must not be able to rewrite.
 */
export function assetClassOf(symbol) {
  const s = String(symbol || '').toUpperCase()
  if (!s) return 'unknown'
  if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|LTC|BCH|DOT|AVAX|LINK|MATIC)/.test(s)) return 'crypto'
  if (/^(XAU|XAG|XPT|XPD)/.test(s) || /COPPER/.test(s)) return 'metal'
  if (/NATGAS|OIL|WTI|BRENT|GASOLINE/.test(s)) return 'energy'
  if (/WHEAT|CORN|SUGAR|COFFEE|COCOA|COTTON|SOYBEAN/.test(s)) return 'soft'
  if (/^(US2000|US30|US500|NAS100|SPX|GER40|FRA40|UK100|JPN225|HK50|AUS200|EUSTX|CHINA)/.test(s)) return 'index'
  if (/\.(US|HK|DE|UK|AU)$/.test(s)) return 'stock'
  if (/^[A-Z]{6}$/.test(s)) return 'fx'
  return 'other'
}

/** Profit factor, or null when there is nothing to divide by. */
function profitFactor(gross, loss) {
  if (!(loss > 0)) return null   // no losses is not an infinite edge — see edgeOf
  return Math.round((gross / loss) * 100) / 100
}

function emptyCell() {
  return { trades: 0, net: 0, wins: 0, grossWin: 0, grossLoss: 0 }
}

function addTrade(cell, pnl) {
  cell.trades++
  cell.net += pnl
  if (pnl > 0) { cell.wins++; cell.grossWin += pnl } else { cell.grossLoss += Math.abs(pnl) }
}

function finish(cell, extra = {}) {
  return {
    ...extra,
    trades: cell.trades,
    net: Math.round(cell.net * 100) / 100,
    winRatePct: cell.trades ? Math.round((cell.wins / cell.trades) * 1000) / 10 : null,
    profitFactor: profitFactor(cell.grossWin, cell.grossLoss),
  }
}

/**
 * The cross, plus both margins.
 *
 * ONLY ROWS WITH A REALISED net_pnl COUNT. A row whose P&L never resolved is
 * not a zero — treating it as one is the defect that made the daily-loss total
 * under-count, and it would show here as a free trade that neither won nor
 * lost. They are reported as `unresolved` instead, so the reader can see how
 * much of the week the answer is missing.
 *
 * @param {Array} rows closed trades: { symbol, net_pnl, label_strategy, strategy, closed_at }
 * @returns {{cells, byStrategy, byAsset, totals, unresolved, worst}}
 */
export function strategyAssetCross(rows = []) {
  const cells = new Map()      // "asset|strategy"
  const byStrategy = new Map()
  const byAsset = new Map()
  const all = emptyCell()
  let unresolved = 0

  for (const r of rows || []) {
    const pnl = r?.net_pnl
    if (pnl == null || !Number.isFinite(Number(pnl))) { unresolved++; continue }
    const n = Number(pnl)
    const asset = assetClassOf(r.symbol)
    // `label_strategy` is broker-label truth; `strategy` is our own column and
    // the fallback. 'other' is a real bucket, not a missing value — two thirds
    // of this account's history sits in it and hiding that would flatter the
    // attribution.
    const strategy = r.label_strategy || r.strategy || 'other'
    const key = `${asset}|${strategy}`
    if (!cells.has(key)) cells.set(key, emptyCell())
    if (!byStrategy.has(strategy)) byStrategy.set(strategy, emptyCell())
    if (!byAsset.has(asset)) byAsset.set(asset, emptyCell())
    addTrade(cells.get(key), n)
    addTrade(byStrategy.get(strategy), n)
    addTrade(byAsset.get(asset), n)
    addTrade(all, n)
  }

  const cellRows = [...cells.entries()]
    .map(([k, c]) => finish(c, { asset: k.split('|')[0], strategy: k.split('|').slice(1).join('|') }))
    .sort((a, b) => a.net - b.net)

  return {
    cells: cellRows,
    byStrategy: [...byStrategy.entries()].map(([k, c]) => finish(c, { strategy: k })).sort((a, b) => a.net - b.net),
    byAsset: [...byAsset.entries()].map(([k, c]) => finish(c, { asset: k })).sort((a, b) => a.net - b.net),
    totals: finish(all),
    unresolved,
    // THE ONE LINE AN OPERATOR ACTS ON. Naming the worst CELL rather than the
    // worst row of either margin is the whole point of crossing them: it says
    // "this strategy, at this asset class", which is a switch someone can
    // actually throw without also throwing away the profitable half.
    worst: cellRows.length ? cellRows[0] : null,
  }
}
