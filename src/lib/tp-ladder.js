// Take-profit ladder for the standard trade table (owner: cTrader allows
// many TPs — show numero, price, and lot inside the Take Profit cell).
//
// The bot's ladder today is two levels: TP1 takes the partial (default 50%,
// mirroring the position manager's partialFraction) and TP2 is the runner
// target. Lots split at the 0.01 min-lot floor; a ladder that cannot
// actually execute (total < 0.02 lots) collapses honestly to one full-size
// level instead of advertising a split the broker would reject.

const r2 = (v) => Math.round(v * 100) / 100

/**
 * @returns Array<{ n, price, lots|null, done? }> | null (no TP at all)
 */
export function tpLadder(tp1, tp2, totalLots, { scaledOut = false } = {}) {
  // Number(null) === 0, so an absent TP must be caught explicitly — a price
  // of 0 is not a target on any instrument we trade.
  const t1 = tp1 == null ? NaN : Number(tp1)
  const t2 = tp2 == null ? NaN : Number(tp2)
  if (!Number.isFinite(t1) || t1 <= 0) return null

  const total = Number(totalLots)
  const haveLots = Number.isFinite(total) && total > 0

  if (!Number.isFinite(t2) || t2 <= 0 || t2 === t1) {
    return [{ n: 1, price: t1, lots: haveLots ? total : null, done: scaledOut }]
  }

  let l1 = null
  let l2 = null
  if (haveLots) {
    l1 = Math.max(0.01, r2(total * 0.5))
    l2 = r2(total - l1)
    if (l2 < 0.01) {
      // Too small to split — one level, full size.
      return [{ n: 1, price: t1, lots: total, done: scaledOut }]
    }
  }
  return [
    { n: 1, price: t1, lots: l1, done: scaledOut },
    { n: 2, price: t2, lots: l2 },
  ]
}

// Claude · № 13,980 13-Oct (owner: Codex P2 on #1348 "TP money from held lots"; claude-builder).
// The display ladder stays on the opened lots; the MONEY at the targets is what
// the lots held now would earn. When the broker's held lots differ from the
// opened lots, a level already taken (done) earns nothing more, and the held
// lots go to the levels still open: all of them to a single open level, split
// the same way tpLadder splits when two are open.
export function heldMoneyLadder(tps, heldLots, openedLots) {
  if (!tps) return tps
  const held = Number(heldLots)
  const opened = Number(openedLots)
  if (heldLots == null || !Number.isFinite(held) || held <= 0) return tps
  if (openedLots != null && Number.isFinite(opened) && Math.abs(held - opened) < 1e-9) return tps
  const open = tps.filter(t => !t.done)
  if (open.length === 2) return tpLadder(open[0].price, open[1].price, held)
  const level = open[0] ?? tps[tps.length - 1]
  return [{ ...level, lots: held }]
}
