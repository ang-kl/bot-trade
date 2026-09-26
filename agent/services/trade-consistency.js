// ---------------------------------------------------------------------------
// agent/services/trade-consistency.js — does a closed trade agree with itself?
//
// MEASURED 05-08-2026, production, all three demo accounts: 56 of 190
// decidable closed rows (29.5%) carry a `net_pnl` whose sign contradicts their
// own `side`, `entry_price` and `exit_price`. The worst:
//
//   id 702  JPN225  BUY   63557.3 -> 63404.5  (-152.8)   net  +$14,259.55
//   id 641  JPN225  SELL  62487.0 -> 62484.4  (  +2.6)   net   -$9,171.76
//
// A long that exits 152.8 points below its entry cannot make money. One of
// those two facts is wrong, and until now nothing in the system noticed.
//
// WHICH ONE IS WRONG. `net_pnl` comes from the broker — either
// `closePositionDetail.grossProfit` on our own close (loop.js) or the deal
// history in the backfill. That is the authority on money, and the go-live
// gate is safe: perf-ledger.js:98 classifies a win on `net_pnl`, and the 56
// contradicted rows net to only +$85.51, so win%, PF and net are unaffected.
//
// `exit_price` is the unreliable side. Only ONE close path ever supplied one
// (loop.js's position-manager close), and it fell back to `res.position.price`
// — the POSITION's price, not the deal's execution price — whenever
// `deal.executionPrice` was absent. Every other path (reconciler broker-side
// close, stale sweep, already_closed) passes no exit price at all, so whatever
// happened to be in the column survived.
//
// WHAT THIS MODULE DOES NOT CLAIM. It does not explain every one of the 56.
// Reverse-engineering id 702's +$14,259.55 from 55.57 lots and a 152.8-point
// move does not land on a clean contract size, so `side` may be wrong on some
// rows too. Rather than guess, this makes the contradiction VISIBLE and
// refuses to write a price we cannot stand behind. A row that disagrees with
// itself is now marked as such instead of being averaged into a number the
// owner is asked to bet on.
//
// AND IT GIVES US REALISED R. Every R:R the system reports today is PLANNED —
// perf-ledger.js:85-89 derives it from entry/sl/tp, i.e. from the bracket we
// SET. So `edge = winPct - requiredWinPct` compares a REALISED win rate against
// a PLANNED break-even, which is only valid if trades finish where we aimed
// them. Only 52.5% of closed trades reach a bracket at all; 25% are cut by the
// time cap. Realised R is therefore below planned R, the true break-even is
// above the 34.1% we report, and the true edge is worse than the -1.2 we print.
// ---------------------------------------------------------------------------

/**
 * Strict numeric read. `Number(null)` is 0 and `Number('')` is 0, so the
 * obvious `Number(x)` treats a MISSING exit price as a price of zero — which
 * makes every incomplete row look decidable and gives it a colossal fake price
 * move. Caught by this module's own tests before it ever ran: it would have
 * corrupted the audit on exactly the rows the audit exists to find.
 */
const num = (v) => (v == null || v === '' ? NaN : Number(v))

/** Signed price travel in the trade's own direction. null when unknowable. */
export function priceMove(trade) {
  const entry = num(trade?.entry_price)
  const exit = num(trade?.exit_price)
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) return null
  const side = String(trade?.side || '').toUpperCase()
  if (side !== 'BUY' && side !== 'SELL') return null
  return (exit - entry) * (side === 'BUY' ? 1 : -1)
}

/**
 * Realised reward-to-risk: how far the trade actually travelled, in units of
 * the risk it was opened with. The counterpart to the PLANNED R:R that
 * perf-ledger computes from the bracket.
 *
 * Deliberately measured against the ORIGINAL stop distance, not the trailed
 * one — R is the risk taken at entry, and a stop that ratcheted in later does
 * not retroactively shrink it.
 */
export function realisedRR(trade) {
  const move = priceMove(trade)
  if (move == null) return null
  const entry = num(trade?.entry_price)
  // The stop the BROKER first held, when on record, is the risk that
  // actually existed; sl_price is the proposal's stop, which the broker
  // re-anchors to the fill (02-09-2026: up to 2R apart on day-one trades).
  const brokerSl = num(trade?.broker_sl_initial)
  const sl = Number.isFinite(brokerSl) && brokerSl > 0 ? brokerSl : num(trade?.sl_price)
  if (!Number.isFinite(sl)) return null
  const risk = Math.abs(entry - sl)
  if (!(risk > 0)) return null
  return move / risk
}

/**
 * UI-5 (RS-1: "Compare gross P&L; name the fee or swap"). MEASURED
 * 26-09-2026: every one of `/state/trade-consistency`'s then-current
 * contradictions was a false alarm — a NET P&L sign flipped by a fee or a
 * swap charge, never a real price/money disagreement (#1449 by swap; the
 * other three by fees). `checkTradeConsistency` below checks NET first, same
 * as before; only when net disagrees does it ask whether GROSS P&L (before
 * fee/swap) agrees with the price move AND the net/gross gap is fully
 * accounted for by `commission` + `swap` — both, not just one, because a
 * gross-agrees coincidence with an UNEXPLAINED gap is not evidence, it is
 * exactly the kind of guess CLAUDE.md's failure mode #6 warns against.
 *
 * Returns the explanation string ('commission' | 'swap' | 'commission and
 * swap' | 'fees') or null when the gap cannot be accounted for by either —
 * a null result must never turn a flagged row into a false-alarm exoneration.
 */
export function explainFeeSwapGap(trade) {
  const gross = num(trade?.gross_pnl)
  const net = num(trade?.net_pnl)
  if (!Number.isFinite(gross) || !Number.isFinite(net)) return null
  const rawCommission = num(trade?.commission)
  const rawSwap = num(trade?.swap)
  const commission = Number.isFinite(rawCommission) ? rawCommission : 0
  const swap = Number.isFinite(rawSwap) ? rawSwap : 0
  if (commission === 0 && swap === 0) return null // nothing to name
  const gap = Math.round((net - gross) * 100) / 100
  const feeSwapSum = Math.round((commission + swap) * 100) / 100
  if (Math.abs(gap - feeSwapSum) > 0.02) return null // the gap is not (fully) fee/swap — do not name a guess
  const parts = []
  if (Math.abs(commission) > 0.005) parts.push('commission')
  if (Math.abs(swap) > 0.005) parts.push('swap')
  return parts.length ? parts.join(' and ') : 'fees'
}

/**
 * Does the money agree with the prices?
 *
 * `ok: true` with `decidable: false` means "no contradiction found because none
 * could be" — a missing exit, a missing side, a flat move or a zero P&L. Those
 * are not evidence of health and must not be counted as agreement.
 *
 * When NET P&L disagrees with the price move, GROSS P&L (before fee/swap) is
 * checked next: if gross agrees AND `explainFeeSwapGap` can name what
 * accounts for the net/gross gap, this is reported `ok: true` — the row's
 * own money agrees with its own price move; only the fee or swap moved net
 * away from it, which is not a contradiction. Every other case keeps the
 * original net-only verdict unchanged (callers that never pass `gross_pnl`
 * see byte-identical behaviour to before this change).
 *
 * @param {object} trade
 * @param {{epsilon?: number}} [opts] `epsilon` is the fraction of entry price
 *   below which a move is treated as flat, so float noise on a scratch trade is
 *   not reported as a contradiction. Default 1e-9 (effectively exact).
 */
export function checkTradeConsistency(trade, { epsilon = 1e-9 } = {}) {
  const move = priceMove(trade)
  const pnl = num(trade?.net_pnl)
  if (move == null || !Number.isFinite(pnl)) {
    return { ok: true, decidable: false, reason: 'not decidable — missing side, price or P&L', move, pnl: null }
  }
  const entry = Math.abs(num(trade?.entry_price)) || 1
  if (Math.abs(move) <= entry * epsilon || pnl === 0) {
    return { ok: true, decidable: false, reason: 'flat move or zero P&L — nothing to contradict', move, pnl }
  }
  const netOk = Math.sign(move) === Math.sign(pnl)
  if (netOk) {
    return { ok: true, decidable: true, move, pnl, reason: 'price move and P&L agree' }
  }
  const gross = num(trade?.gross_pnl)
  if (Number.isFinite(gross) && gross !== 0 && Math.sign(move) === Math.sign(gross)) {
    const explain = explainFeeSwapGap(trade)
    if (explain) {
      return {
        ok: true, decidable: true, move, pnl, gross,
        reason: `price move agrees with gross P&L ${gross}; net ${pnl} disagrees only because of ${explain}`,
      }
    }
  }
  return {
    ok: false,
    decidable: true,
    move,
    pnl,
    reason: `price moved ${move > 0 ? 'in favour' : 'against'} by ${Math.abs(move)} but P&L is ${pnl > 0 ? 'positive' : 'negative'}`,
  }
}

/**
 * Re-stamp the two audit columns — `realised_rr` and `pnl_price_mismatch` —
 * from whatever the row holds NOW. Call after any write that changes a closed
 * trade's entry price, exit price, stop or net P&L.
 *
 * WHY THIS EXISTS (measured 02-09-2026). `realised_rr` was NULL on 10 of 12
 * bot closes although every one of them carried entry, exit, stop and money.
 * The close path stamps R at close time, when a broker-side close has no exit
 * price yet (reconciler.js closes with none), so it stamps NULL — correctly.
 * The exit then arrives from the broker ledger by one of TWO writers racing
 * on the loop: pnl-backfill's fillMissingExit, which re-stamps, and
 * reconcileTradePricesToBroker, which did not. Whichever got there first
 * decided whether the row ever gained an R — and the reconcile step runs
 * every cycle, so it usually won. Every NULL row's exit_price equalled the
 * broker deal's close_price to the digit, which is that writer's signature.
 *
 * One helper, every writer, so the next writer cannot forget. Best-effort:
 * an audit column must never fail the write that triggered it. Returns the
 * stamped pair, or null when the row is absent or the write failed.
 */
export function stampRealisedAudit(db, tradeId) {
  try {
    const row = db.prepare(
      `SELECT side, entry_price, exit_price, sl_price, broker_sl_initial, net_pnl FROM trades WHERE id = ?`
    ).get(tradeId)
    if (!row) return null
    const rr = realisedRR(row)
    const check = checkTradeConsistency(row)
    const mismatch = check.decidable && !check.ok ? 1 : 0
    db.prepare(`UPDATE trades SET realised_rr = ?, pnl_price_mismatch = ? WHERE id = ?`).run(rr, mismatch, tradeId)
    return { realisedRR: rr, mismatch }
  } catch { return null }
}

/**
 * Re-stamp EVERY closed row that has both prices. The 02-09-2026 fix made
 * each writer re-stamp after its own write, but a row whose prices had
 * already been corrected before the fix never sees another write — the
 * reconcile step hits `unchanged` and moves on — so its stale or NULL R
 * would have stood for life. Measured the same day: 116 of 191 stamped bot
 * rows disagreed with recomputation and 94 more were NULL but computable.
 *
 * Pure over the db handle; the one-shot guard (a version key in agent_state)
 * lives in the caller, because this module must not import db.js (db.js
 * imports this one). Returns the counts so the boot line can say what moved.
 */
export function restampClosedTrades(db) {
  const out = { examined: 0, changed: 0, nulled: 0 }
  let rows = []
  try {
    rows = db.prepare(
      `SELECT id, realised_rr, pnl_price_mismatch FROM trades
        WHERE status = 'closed' AND entry_price IS NOT NULL AND exit_price IS NOT NULL`
    ).all()
  } catch { return out }
  const tx = db.transaction(() => {
    for (const r of rows) {
      out.examined++
      const s = stampRealisedAudit(db, r.id)
      if (!s) continue
      const before = r.realised_rr == null ? null : Number(r.realised_rr)
      const after = s.realisedRR == null ? null : Number(s.realisedRR)
      const same = (before == null && after == null)
        || (before != null && after != null && Math.abs(before - after) <= 1e-12)
      if (!same || (r.pnl_price_mismatch ?? 0) !== s.mismatch) out.changed++
      if (after == null) out.nulled++
    }
  })
  try { tx() } catch { /* a repair pass must never take the boot down */ }
  return out
}

/**
 * Every closed row that disagrees with itself, worst first.
 *
 * Fails OPEN on a schema gap, like symbol-position-cap: an audit that threw
 * would take out whatever called it, and a missing column is not a reason to
 * stop trading.
 */
export function inconsistentTrades(db, { accountId = null, limit = 200 } = {}) {
  const acct = accountId != null ? String(accountId) : null
  try {
    const rows = db.prepare(`
      SELECT id, symbol, side, entry_price, exit_price, sl_price, net_pnl, gross_pnl, commission, swap, account_id, closed_at, close_reason
        FROM trades
       WHERE status = 'closed' AND net_pnl IS NOT NULL
         AND entry_price IS NOT NULL AND exit_price IS NOT NULL
         AND (account_id = ? OR ? IS NULL)
    `).all(acct, acct)
    return rows
      .map(r => ({ ...r, check: checkTradeConsistency(r) }))
      .filter(r => r.check.decidable && !r.check.ok)
      .sort((a, b) => Math.abs(b.net_pnl) - Math.abs(a.net_pnl))
      .slice(0, limit)
  } catch { return [] }
}

/** Counts for a route or a heartbeat: how much of the book agrees with itself? */
export function consistencySummary(db, { accountId = null } = {}) {
  const acct = accountId != null ? String(accountId) : null
  try {
    const rows = db.prepare(`
      SELECT id, side, entry_price, exit_price, net_pnl, gross_pnl, commission, swap
        FROM trades
       WHERE status = 'closed' AND (account_id = ? OR ? IS NULL)
    `).all(acct, acct)
    let decidable = 0, agree = 0, contradict = 0
    for (const r of rows) {
      const c = checkTradeConsistency(r)
      if (!c.decidable) continue
      decidable++
      if (c.ok) agree++; else contradict++
    }
    return {
      closed: rows.length,
      decidable,
      agree,
      contradict,
      contradictPct: decidable ? Math.round((contradict / decidable) * 1000) / 10 : null,
    }
  } catch {
    return { closed: 0, decidable: 0, agree: 0, contradict: 0, contradictPct: null }
  }
}

/** One line per contradiction, for the log and the alert. */
export const inconsistencyLine = (t) =>
  `#${t.id} ${t.symbol} ${t.side} ${t.entry_price}→${t.exit_price}`
  + ` (move ${t.check.move > 0 ? '+' : ''}${Number(t.check.move.toFixed(5))})`
  + ` but net ${t.net_pnl > 0 ? '+' : ''}${t.net_pnl}`
  + `${t.account_id ? ` on ${t.account_id}` : ''}`
