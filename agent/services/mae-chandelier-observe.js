// agent/services/mae-chandelier-observe.js
//
// What remains of the MAE/Chandelier module: Wilder's ATR and the since-entry
// trail spec the profit keeper hands to the sidecar's TrailEngine (the stop
// policy's since-entry trail, 02-10-2026). The file keeps its name because
// agent/stop-policy-callsites.test.js reads it by name.
//
// The OBSERVER that used to live here was REMOVED 03-10-2026 on the owner's
// order ("remove all three", after the statement review at № 10,812). Measured
// reason: since it was built (02-10-2026) it never produced a usable reading
// in production — GET /state/mae-chandelier at 06:25Z 03-10-2026 read
// positions 1, withBars 0, adjustable 0, receipts 0 — while its fast-monitor
// bar fetch added broker calls on every tick, and it was a third stop
// authority beside the stop policy and the profit keeper. Gone with it: the
// per-position readings and their state record (`mae_chandelier_observe_json`,
// deleted once at boot by agent/index.js), the bar cache and fetch, the fast
// tick and the timeframe pass, the amend path and its receipts, the route and
// the verifier script. Nothing here calls the broker or writes state.

export const DEFAULT_ATR_PERIOD = 22
export const DEFAULT_ATR_MULT = 3

export function wilderAtr(bars, period = DEFAULT_ATR_PERIOD) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null
  const trs = []
  for (let i = 1; i < bars.length; i++) {
    const h = Number(bars[i].h)
    const l = Number(bars[i].l)
    const pc = Number(bars[i - 1].c)
    if (![h, l, pc].every(Number.isFinite)) return null
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))
  }
  if (trs.length < period) return null
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period
  return atr
}

/**
 * The since-entry trail spec for the sidecar's TrailEngine: 3 × ATR(22)
 * behind the peak, the peak seeded at the entry. Null when the ATR or the
 * digits are missing, so the keeper drops the row rather than push a spec
 * the sidecar cannot round.
 *
 * Claude · № 14,822 15-Oct (owner order § 14,741·A PR-2; owner choice after
 * № 14,822: "peak above entry OR close in profit now"; claude-builder).
 * ONLY ONCE THE POSITION HAS SHOWN PROFIT. Measured 14-10 (§ 14,716): GBPUSD
 * #1817 and USDJPY #1846 had their fresh stops tightened by this spec 7 s
 * and 35 s after entry — the peak is seeded at the entry, so wherever 3×ATR
 * sits inside the strategy's stop the engine ratchets at once, before the
 * trade has shown anything. The spec is now withheld until the position has
 * been in profit on the exit side: the monitor's peak (`mfeR` > 0, kept
 * every loop and fast tick) or the keeper's latest close beyond the fill in
 * the trade's direction. Neither known → no spec (nothing pushed, the plan
 * stop stands). The distance, the peak seed and the engine are unchanged.
 *
 * Claude · № 14,933 15-Oct (owner § 14,932·B·1 "(a) Switch it on only from
 * +0.5R"; claude-builder). "Any profit" armed the engine on a +0.015R peak
 * (USDJPY #1881, 15-10: stop 150.21 → 157.41 on a 157.92 fill) and a +0.036R
 * peak (BTCUSD #1880: 84,601 → 82,523). The spec is now withheld until the
 * position's EXIT-SIDE PEAK (`mfeR`, mfe_exit_r — the keeper passes it only
 * when the row's side and entry are the broker position's) has reached
 * SINCE_ENTRY_MIN_PEAK_R. A close in profit no longer arms on its own: below
 * +0.5R it is not the owner's threshold, and at +0.5R the monitor's peak
 * (every loop and fast tick) already says so. Once reached it keeps
 * qualifying, since the peak never falls.
 */
export function sinceEntryTrailSpec({ positionId, accountId, symbolId, side, entry, bars, currentSl, currentTp, digits, mfeR } = {}) {
  if (!hasShownProfit({ mfeR })) return null
  const atr = wilderAtr(bars, DEFAULT_ATR_PERIOD)
  // Number(null), Number('') and Number(false) are zero, but they are not
  // broker precision. Preserve a genuine zero-digit instrument only.
  const d = typeof digits === 'number' || (typeof digits === 'string' && digits.trim() !== '') ? Number(digits) : NaN
  if (!(atr > 0) || !Number.isSafeInteger(d) || d < 0) return null
  const dir = String(side || '').toUpperCase() === 'SHORT' || String(side || '').toUpperCase() === 'SELL' ? -1 : 1
  const peak = Number(entry)
  if (!(peak > 0)) return null
  return {
    positionId: parseInt(positionId),
    ctidTraderAccountId: Number(accountId),
    symbolId,
    dir,
    trailDistance: DEFAULT_ATR_MULT * atr,
    peakPrice: peak,
    currentSl: currentSl ?? null,
    currentTp: currentTp ?? null,
    digits: d,
    // The sidecar decides per amend whether the stop it sends locks profit
    // (broker-side trailing, stop policy 02-10-2026); it needs the entry.
    entryPrice: peak,
    source: 'mae_chandelier_since_entry',
  }
}

/** № 14,933 (owner § 14,932·B·1 (a)): the exit-side peak, in R, from which the since-entry trail arms. */
export const SINCE_ENTRY_MIN_PEAK_R = 0.5

/**
 * № 14,822 / № 14,933: has the position's exit-side peak reached
 * SINCE_ENTRY_MIN_PEAK_R? `mfeR` is the monitor's recorded exit-side peak in
 * R. Unknown values — null, blank, a boolean — are not profit.
 */
export function hasShownProfit({ mfeR } = {}) {
  const m = typeof mfeR === 'number' ? mfeR
    : typeof mfeR === 'string' && mfeR.trim() !== '' ? Number(mfeR) : NaN
  return Number.isFinite(m) && m >= SINCE_ENTRY_MIN_PEAK_R
}
