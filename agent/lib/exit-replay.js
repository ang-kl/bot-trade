// ---------------------------------------------------------------------------
// agent/lib/exit-replay.js — what would a DIFFERENT exit rule have returned?
//
// Phase 7 of the Verified Defect Repair programme, and the question the
// Defensive-Drift audit could not answer: 60% of postmortems classify
// `time_cap`, median hold is 31 minutes, and `burn-in.js:237` sets the target
// at 1.6× the stop. Those two facts are in tension, but "the clock is costing
// us money" was an inference, not a measurement. This measures it.
//
// THE INPUT IS REAL BARS, NOT AN ESTIMATE. `trade_postmortems.bars_json`
// already stores the replay window as [[t,o,h,l,c,v], …]. Replaying those
// bar-by-bar is the difference between a counterfactual and a guess, and it is
// why this was worth waiting for rather than approximating from MFE/MAE.
//
// THE ONE HONEST PROBLEM, STATED UP FRONT. A bar records a high and a low but
// NOT THE ORDER THEY HAPPENED IN. When a single bar touches both the stop and
// the target, the outcome is genuinely unknowable from this data: intrabar
// sequence decides it and we do not have it. Every backtest that has ever
// flattered itself resolved that case by assuming the favourable order.
//
// This module refuses. Such a trade is returned `ambiguous: true` with NO
// r-multiple, and the aggregate reports the ambiguous count beside every
// figure. A rule whose apparent edge comes from thirty ambiguous bars is a
// rule about which nothing has been learned, and the number that would hide
// that is worse than no number.
//
// WHAT THIS CANNOT SEE, so it does not claim to:
//   · slippage and spread at the counterfactual exit — the replayed price is
//     the bar's price, not a fill
//   · that holding longer would have changed position sizing, margin
//     availability, or which OTHER trades were then taken
//   · anything outside the stored bar window; a rule that would have held past
//     the last bar returns `truncated`, never a made-up exit
//
// It changes nothing. It places no order, writes no row, and touches no
// threshold. It is a measuring instrument.
// ---------------------------------------------------------------------------

/** Bar tuple indices in `bars_json`. */
export const T = 0, O = 1, H = 2, L = 3, C = 4

const num = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse `trade_postmortems.bars_json` into usable bars.
 *
 * Rejects rather than repairs: a bar missing a high or low cannot be replayed,
 * and silently dropping it would shorten the window without saying so.
 *
 * @returns {{bars: Array, dropped: number}}
 */
export function parseBars(barsJson) {
  let raw = barsJson
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return { bars: [], dropped: 0 } }
  }
  if (!Array.isArray(raw)) return { bars: [], dropped: 0 }
  const bars = []
  let dropped = 0
  for (const b of raw) {
    if (!Array.isArray(b) || b.length < 5) { dropped++; continue }
    const t = num(b[T]), h = num(b[H]), l = num(b[L]), c = num(b[C])
    if (t == null || h == null || l == null || c == null || h < l) { dropped++; continue }
    bars.push(b)
  }
  return { bars, dropped }
}

/**
 * An exit rule. All fields optional; omitted means "this rule does not do that".
 *
 * @typedef {object} ExitRule
 * @property {string} name
 * @property {number} [timeCapMin]    close at market this many minutes after entry
 * @property {number} [tpR]           take profit at this multiple of the stop distance
 * @property {number} [breakevenAtR]  move the stop to entry once this R is reached
 * @property {number} [trailR]        trail the stop this many R behind the peak
 */

/** The comparison set. `baseline` is the system as it actually behaved. */
export const DEFAULT_RULES = Object.freeze([
  { name: 'as_traded' },                                  // stop and target only
  { name: 'cap_30m', timeCapMin: 30 },                    // burn-in.js "active"
  { name: 'cap_120m', timeCapMin: 120 },                  // burn-in.js "trending"
  { name: 'no_cap' },                                     // hold to stop or target
  { name: 'tp_1R', tpR: 1.0 },                            // a target 30 min can reach
  { name: 'tp_1R_cap_30m', tpR: 1.0, timeCapMin: 30 },
  { name: 'be_at_1R', breakevenAtR: 1.0 },                // free trade after 1R
  { name: 'trail_1R', trailR: 1.0 },
])

/**
 * Replay one closed trade under one exit rule.
 *
 * @param {Array} bars       [[t,o,h,l,c,v], …], t in ms, ordered oldest first
 * @param {object} trade     { side: 'long'|'short', entry, sl, tp, openedAtMs }
 * @param {ExitRule} rule
 *
 * @returns {{ok: boolean, ambiguous?: boolean, truncated?: boolean,
 *   reason: string, exitPrice?: number, exitAtMs?: number, rMultiple?: number,
 *   heldMin?: number, barsUsed?: number}}
 *
 *   ok:false with ambiguous:true — a bar touched both stop and target and the
 *     intrabar order is unknown. NOT resolved. See the header.
 *   ok:false with truncated:true — the rule would still be holding when the
 *     stored window ends. No exit is invented.
 */
export function replayExit(bars, trade, rule = {}) {
  const side = String(trade?.side || '').toLowerCase()
  const long = side === 'long' || side === 'buy'
  const entry = num(trade?.entry)
  const sl0 = num(trade?.sl)
  const openedAtMs = num(trade?.openedAtMs)

  if (entry == null || sl0 == null) return { ok: false, reason: 'no entry or stop recorded' }
  const risk = Math.abs(entry - sl0)
  if (!(risk > 0)) return { ok: false, reason: 'stop distance is zero — R is undefined' }
  if (!Array.isArray(bars) || bars.length === 0) return { ok: false, reason: 'no bars stored' }

  // The target: the rule's own tpR if it states one, else the trade's real TP.
  const tpFromRule = rule.tpR != null
    ? (long ? entry + rule.tpR * risk : entry - rule.tpR * risk)
    : num(trade?.tp)

  const capMs = rule.timeCapMin != null ? rule.timeCapMin * 60_000 : null
  const startMs = openedAtMs ?? num(bars[0][T])

  // R at a price, signed by direction.
  const rAt = (price) => (long ? price - entry : entry - price) / risk
  const done = (price, atMs, reason, barsUsed) => ({
    ok: true, reason, exitPrice: price, exitAtMs: atMs,
    rMultiple: Math.round(rAt(price) * 1000) / 1000,
    heldMin: atMs != null && startMs != null ? Math.round((atMs - startMs) / 60_000) : null,
    barsUsed,
  })

  let stop = sl0
  let peakR = 0
  let used = 0

  for (const b of bars) {
    const t = num(b[T]), hi = num(b[H]), lo = num(b[L]), close = num(b[C])
    // Bars before entry are context in the stored window, not part of the trade.
    if (startMs != null && t != null && t < startMs) continue
    used++

    const hitStop = long ? lo <= stop : hi >= stop
    const hitTp = tpFromRule != null && (long ? hi >= tpFromRule : lo <= tpFromRule)

    // THE CASE THIS MODULE EXISTS TO BE HONEST ABOUT.
    if (hitStop && hitTp) {
      return {
        ok: false, ambiguous: true, barsUsed: used,
        reason: 'one bar touched both the stop and the target — intrabar order is not recorded, so the outcome is unknowable',
      }
    }
    if (hitStop) return done(stop, t, stop === sl0 ? 'stop' : 'stop_moved', used)
    if (hitTp) return done(tpFromRule, t, 'target', used)

    // Excursion within this bar, used for break-even and trailing. Measured at
    // the FAVOURABLE extreme, which is the only excursion a bar can prove.
    const barPeakR = rAt(long ? hi : lo)
    if (barPeakR > peakR) peakR = barPeakR

    // Break-even: applied only from the NEXT bar, because arming and being
    // stopped inside the same bar is the same intrabar-order problem above.
    if (rule.breakevenAtR != null && peakR >= rule.breakevenAtR) {
      const be = entry
      if (long ? be > stop : be < stop) stop = be
    }
    if (rule.trailR != null && peakR > rule.trailR) {
      const trailed = long ? entry + (peakR - rule.trailR) * risk : entry - (peakR - rule.trailR) * risk
      if (long ? trailed > stop : trailed < stop) stop = trailed
    }

    // The clock, checked LAST: a bar that reached the target counts as a target
    // hit even if the cap also expires inside it. The cap closes at market, and
    // the market it closes at is this bar's close.
    if (capMs != null && startMs != null && t != null && t - startMs >= capMs) {
      return done(close, t, 'time_cap', used)
    }
  }

  return {
    ok: false, truncated: true, barsUsed: used,
    reason: 'the stored bar window ends while this rule is still holding — no exit is invented',
  }
}

/**
 * Aggregate replayed outcomes into the figures a decision would be made on.
 *
 * Ambiguous and truncated trades are EXCLUDED from the statistics and counted
 * beside them. `usable` is the denominator every rate here is computed over,
 * and it is reported so a rule scored on eleven trades cannot be read as a rule
 * scored on ninety.
 */
export function summariseReplay(results) {
  const list = Array.isArray(results) ? results : []
  const ok = list.filter(r => r?.ok)
  const ambiguous = list.filter(r => r?.ambiguous).length
  const truncated = list.filter(r => r?.truncated).length
  const failed = list.length - ok.length - ambiguous - truncated

  const rs = ok.map(r => r.rMultiple).filter(r => Number.isFinite(r))
  const wins = rs.filter(r => r > 0)
  const losses = rs.filter(r => r < 0)
  const sum = (a) => a.reduce((x, y) => x + y, 0)
  const round = (n, d = 3) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)
  const grossWin = sum(wins)
  const grossLoss = Math.abs(sum(losses))

  return {
    n: list.length,
    usable: rs.length,
    ambiguous,
    truncated,
    failed,
    wins: wins.length,
    losses: losses.length,
    // A rate over zero usable trades is not 0% — it is unknown, and the
    // difference is the whole point of this module.
    winRate: rs.length ? round((wins.length / rs.length) * 100, 1) : null,
    // Profit factor over R-multiples. Infinite when nothing lost, which is
    // reported as null rather than a number that would sort above everything.
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 3) : null,
    expectancyR: rs.length ? round(sum(rs) / rs.length, 3) : null,
    totalR: round(sum(rs), 3),
    medianHoldMin: medianOf(ok.map(r => r.heldMin).filter(n => Number.isFinite(n))),
    byReason: ok.reduce((acc, r) => { acc[r.reason] = (acc[r.reason] || 0) + 1; return acc }, {}),
  }
}

function medianOf(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}
