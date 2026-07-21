// ---------------------------------------------------------------------------
// agent/services/loss-postmortem.js — learn from every losing trade.
//
// Owner: "is there a code section to playback after each loss to understand
// what the market is happening?" — there wasn't. This is it.
//
// After a losing trade closes, this sweep fetches the bars around the trade
// (entry → stop → aftermath) and classifies WHAT THE MARKET DID next:
//
//   stop_hunt    — price hit the stop, then came BACK to entry within the
//                  aftermath window. The idea was right, the stop was too
//                  tight (or the entry too early).
//   thesis_wrong — price kept going AGAINST the position ≥1R beyond the stop.
//                  The stop saved money; the idea was wrong.
//   chop         — price did neither: meandered. No edge either way — the
//                  entry filter let noise through.
//   time_cap     — closed by the time cap, not the market.
//   inconclusive — not enough aftermath bars to judge honestly.
//
// The classification walks bars CHRONOLOGICALLY — whichever extreme happens
// first wins, so a crash-then-recover reads thesis_wrong, not stop_hunt.
// Everything is stored (bars included) in trade_postmortems for the Desk's
// Loss-review playback, and aggregated per strategy so a pattern ("FIB losses
// are mostly stop hunts → widen stops") is visible, not vibes.
//
// Pure classification + a small sweep. The sweep is best-effort: a bar-fetch
// hiccup must never stall the loop.
// ---------------------------------------------------------------------------

import { tfMs } from '../lib/timeframes.js'

export const AFTERMATH_BARS = 12   // how many post-exit bars the verdict may use
export const MIN_AFTER_BARS = 5    // fewer than this → wait (or inconclusive)

/**
 * Classify a closed losing trade from its surrounding bars. Pure.
 *
 * @param {{ side:string, entry_price:number, sl_price:number|null,
 *           exit_price:number|null, close_reason:string|null }} trade
 * @param {Array<{t:number,o:number,h:number,l:number,c:number,v:number}>} bars
 *        full window, chronological
 * @param {number} closedAtMs epoch ms of the close
 * @returns {{ classification:string, detail:string }|null} null = wait for more bars
 */
export function classifyLoss(trade, bars, closedAtMs, opts = {}) {
  const aftermathBars = opts.aftermathBars ?? AFTERMATH_BARS
  const minAfterBars = opts.minAfterBars ?? MIN_AFTER_BARS
  const allowPartial = opts.allowPartial ?? false

  if (/time_cap/i.test(trade.close_reason || '')) {
    return { classification: 'time_cap', detail: 'Closed by the time cap, not by the market — the setup never resolved in time.' }
  }

  const entry = Number(trade.entry_price)
  const exit = Number(trade.exit_price)
  const sl = trade.sl_price != null ? Number(trade.sl_price) : null
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) {
    return { classification: 'inconclusive', detail: 'Missing entry/exit price — cannot reconstruct the trade geometry.' }
  }
  const long = /^(buy|long)$/i.test(String(trade.side || ''))
  const risk = sl != null && Math.abs(entry - sl) > 0 ? Math.abs(entry - sl) : Math.abs(entry - exit)
  if (!(risk > 0)) {
    return { classification: 'inconclusive', detail: 'Zero risk distance — geometry unusable.' }
  }

  const after = (bars || []).filter(b => b.t > closedAtMs).slice(0, aftermathBars)
  if (after.length < minAfterBars && !allowPartial) return null // not enough aftermath yet — try next sweep

  // Adverse continuation level: 1R beyond the stop (or beyond exit when no SL).
  const stopLevel = sl != null ? sl : exit
  const contLevel = long ? stopLevel - risk : stopLevel + risk

  // Walk chronologically — first decisive event wins.
  for (const b of after) {
    const cameBack = long ? b.h >= entry : b.l <= entry
    const kept = long ? b.l <= contLevel : b.h >= contLevel
    if (kept && cameBack) {
      // Same bar did both — judge by which side the bar CLOSED on.
      const closedAdverse = long ? b.c < exit : b.c > exit
      return closedAdverse ? verdictWrong(risk) : verdictHunt(after.indexOf(b) + 1)
    }
    if (kept) return verdictWrong(risk)
    if (cameBack) return verdictHunt(after.indexOf(b) + 1)
  }
  if (after.length < minAfterBars) {
    return { classification: 'inconclusive', detail: `Only ${after.length} aftermath bar(s) available — not enough to judge honestly.` }
  }
  return {
    classification: 'chop',
    detail: `In ${after.length} bars after the stop, price neither returned to entry nor continued 1R beyond the stop — the market was noise here, and the entry filter let it through.`,
  }
}

function verdictHunt(nBars) {
  return {
    classification: 'stop_hunt',
    detail: `Price swept the stop, then came back to the entry within ${nBars} bar(s). The direction was right — the stop was too tight or the entry too early.`,
  }
}
function verdictWrong(risk) {
  return {
    classification: 'thesis_wrong',
    detail: `Price continued ≥1R (${risk.toFixed(5)}) beyond the stop. The stop did its job — the idea was wrong, not the exit.`,
  }
}

/**
 * Classify a closed WINNING trade — wins carry lessons too (owner: "two
 * tables for lesson learnt for both lost and wins"). Uses the DURING-trade
 * bars (entry → close), so no waiting for aftermath. Pure.
 *
 *   escaped   — MAE ≤ −0.8R before winning: the entry was nearly stopped and
 *               won anyway. That's luck, not edge — don't size up on it.
 *   gave_back — MFE exceeded the banked R by ≥1R: the exit engine left a
 *               full R on the table — bank earlier / trail tighter.
 *   clean_win — banked within 1R of the best the market offered.
 *
 * Priority: escaped first (a near-death entry is the bigger red flag), then
 * gave_back, else clean_win.
 */
export function classifyWin(trade, bars, openedAtMs, closedAtMs) {
  const entry = Number(trade.entry_price)
  const exit = Number(trade.exit_price)
  const sl = trade.sl_price != null ? Number(trade.sl_price) : null
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) {
    return { classification: 'inconclusive', detail: 'Missing entry/exit price — cannot reconstruct the trade geometry.' }
  }
  const long = /^(buy|long)$/i.test(String(trade.side || ''))
  const risk = sl != null && Math.abs(entry - sl) > 0
    ? Math.abs(entry - sl)
    : (Number(trade.initial_risk) > 0 ? Number(trade.initial_risk) : null)
  if (!(risk > 0)) {
    return { classification: 'inconclusive', detail: 'No stop distance on record — win quality cannot be measured in R.' }
  }
  const during = (bars || []).filter(b => b.t >= (openedAtMs || 0) && b.t <= closedAtMs)
  if (during.length === 0) {
    return { classification: 'inconclusive', detail: 'No bars from the holding period — win quality cannot be judged.' }
  }
  const dir = long ? 1 : -1
  const realizedR = ((exit - entry) * dir) / risk
  let mfeR = 0, maeR = 0
  for (const b of during) {
    mfeR = Math.max(mfeR, ((long ? b.h : b.l) - entry) * dir / risk)
    maeR = Math.min(maeR, ((long ? b.l : b.h) - entry) * dir / risk)
  }
  if (maeR <= -0.8) {
    return {
      classification: 'escaped',
      detail: `Drew down to ${maeR.toFixed(2)}R before winning — the entry was nearly stopped out. The thesis worked but the entry timing was early; don't size up until entries stop drawing down this deep.`,
      realizedR, mfeR, maeR,
    }
  }
  if (mfeR - realizedR >= 1) {
    return {
      classification: 'gave_back',
      detail: `Peaked at +${mfeR.toFixed(2)}R but banked only +${realizedR.toFixed(2)}R — ${(mfeR - realizedR).toFixed(1)}R left on the table. Bank earlier or trail tighter for this setup.`,
      realizedR, mfeR, maeR,
    }
  }
  return {
    classification: 'clean_win',
    detail: `Banked +${realizedR.toFixed(2)}R of a +${mfeR.toFixed(2)}R best — the exit engine captured what the market offered.`,
    realizedR, mfeR, maeR,
  }
}

// ---------------------------------------------------------------------------
// Trade-Lesson Extraction (owner spec) — flat key-value fields any controller
// can consume unmodified. Deterministic (no LLM): result vs the stated GOAL
// (TP1), one imperative lesson line per verdict, alpha-decay keyed on the
// EXACT Symbol+Strategy+Timeframe (a symbol running two strategies carries
// two independent edges), and Entry-quality from the recorded confluence
// count (≤2 → Watch; unrecorded → unknown, never invented).
// ---------------------------------------------------------------------------

/** Result vs GOAL (TP1): Win = reached goal; Partial = profit short of goal; Miss = loss/flat. */
export function classifyResult(trade) {
  const entry = Number(trade.entry_price), exit = Number(trade.exit_price)
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) return 'unknown'
  const dir = /^(buy|long)$/i.test(String(trade.side || '')) ? 1 : -1
  const move = (exit - entry) * dir
  // Number(null) is 0 — a missing TP must read as "no goal", not "goal 0".
  const tp1 = trade.tp_price == null ? NaN : Number(trade.tp_price)
  if (move <= 0) return 'Miss'
  if (Number.isFinite(tp1) && (tp1 - entry) * dir > 0 && move >= (tp1 - entry) * dir * 0.98) return 'Win'
  return Number.isFinite(tp1) ? 'Partial' : 'Win'
}

/** One imperative lesson line (<15 words) naming the deciding condition. */
export function lessonLine(classification, ctx = {}) {
  switch (classification) {
    case 'stop_hunt': return 'Widen stop beyond the sweep zone; direction was right.'
    case 'thesis_wrong': return `Re-validate ${ctx.strategy || 'the'} entry conditions; price continued against the thesis.`
    case 'chop': return 'Require a stronger trend filter before entry; market was noise.'
    case 'time_cap': return 'Avoid setups needing more time than the cap allows.'
    case 'gave_back': return 'Bank earlier; peak exceeded the exit by a full R.'
    case 'clean_win': return 'Repeat this setup; the exit captured the available move.'
    case 'escaped': return `Enter later in the setup; drawdown hit ${ctx.maeR != null ? ctx.maeR.toFixed(1) : '-0.8'}R first.`
    default: return 'Insufficient data; record entry context on future trades.'
  }
}

/**
 * Alpha-decay on the EXACT Symbol+Strategy+Timeframe key: of the last 5 prior
 * postmortems sharing that key, ≥3 Miss → 'decay'; <5 history →
 * 'insufficient_history'; else 'ok'. Null strategy/timeframe keys still match
 * only their own kind (IS-null comparison), never bleed across.
 */
export function alphaDecayFlag(db, trade) {
  const rows = db.prepare(`
    SELECT result FROM trade_postmortems
    WHERE symbol = ? AND strategy IS ? AND timeframe IS ?
    ORDER BY id DESC LIMIT 5
  `).all(trade.symbol, trade.strategy ?? null, trade.timeframe ?? null)
  if (rows.length < 5) return 'insufficient_history'
  const misses = rows.filter(r => r.result === 'Miss').length
  return misses >= 3 ? 'decay' : 'ok'
}

/** Entry-quality: Watch when confluence-count ≤2; unknown when never recorded. */
export function entryQuality(confluenceCount) {
  if (confluenceCount == null) return 'unknown'
  return Number(confluenceCount) <= 2 ? 'Watch' : 'OK'
}

/** Parse "YYYY-MM-DD HH:MM:SS" (sqlite, UTC) or ISO into epoch ms. */
export function sqliteMs(s) {
  if (!s) return NaN
  return Date.parse(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z')
}

/**
 * Sweep: classify closed trades — LOSSES and WINS — that have no postmortem
 * yet, over a 90-day window (owner: "run one PR to learn all past and fill it
 * in" — the loop back-fills history automatically at maxPerCycle a tick).
 * Bar fetches are ANCHORED at each trade's own close (endTime), so an old
 * trade's holding period + aftermath land inside the window instead of being
 * clipped off by a now-anchored fetch. Limits work per cycle so the loop
 * never stalls on this.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {(symbol:string, timeframe:string, count:number, endTimeMs:number) => Promise<Array>} fetchBars
 * @returns {{ examined:number, classified:number, waiting:number }}
 */
export async function runLossPostmortems(db, fetchBars, { maxPerCycle = 6, now = Date.now(), windowDays = 90 } = {}) {
  const rows = db.prepare(`
    SELECT t.id, t.symbol, t.side, t.entry_price, t.exit_price, t.sl_price,
           t.net_pnl, t.close_reason, t.opened_at, t.closed_at, t.tp_price,
           t.confluence_count,
           COALESCE(t.label_strategy, t.strategy) AS strategy,
           t.label_timeframe AS timeframe,
           (SELECT initial_risk FROM monitored_positions WHERE trade_id = t.id ORDER BY id DESC LIMIT 1) AS initial_risk
    FROM trades t
    LEFT JOIN trade_postmortems pm ON pm.trade_id = t.id
    WHERE t.status = 'closed' AND pm.id IS NULL
      AND (
        (t.net_pnl IS NOT NULL AND t.net_pnl != 0)
        -- P&L not backfilled yet (broker-closed): infer the outcome from the
        -- prices instead of skipping the trade forever — this is why only a
        -- couple of lessons appeared against dozens of closed trades.
        OR (t.net_pnl IS NULL AND t.exit_price IS NOT NULL AND t.entry_price IS NOT NULL)
      )
      AND t.closed_at >= datetime('now', ?)
    ORDER BY t.closed_at DESC
    LIMIT ?
  `).all(`-${windowDays} days`, maxPerCycle)

  let classified = 0, waiting = 0
  for (const t of rows) {
    const closedMs = sqliteMs(t.closed_at)
    if (!Number.isFinite(closedMs)) continue
    const tf = t.timeframe || '1h'
    const ms = tfMs(tf) || 3_600_000
    const openedMs = sqliteMs(t.opened_at)
    // Anchor the fetch at close + aftermath (never in the future) so history
    // back-fills correctly; size the window from entry-context to that end.
    const endTime = Math.min(now, closedMs + (AFTERMATH_BARS + 3) * ms)
    const spanMs = endTime - (((openedMs || closedMs)) - 20 * ms)
    const count = Math.min(400, Math.max(60, Math.ceil(spanMs / ms) + 5))
    let bars = []
    try {
      bars = await fetchBars(t.symbol, tf, count, endTime) || []
    } catch { /* fetch hiccup — leave for next sweep */ continue }

    // Outcome: broker-true P&L when backfilled; else inferred from prices
    // (direction-aware). A dead-flat exit with no P&L stays unclassified.
    let isWin
    if (t.net_pnl != null) {
      isWin = t.net_pnl > 0
    } else {
      const dirW = /^(buy|long)$/i.test(String(t.side || '')) ? 1 : -1
      const move = (Number(t.exit_price) - Number(t.entry_price)) * dirW
      if (!(Math.abs(move) > 0)) continue
      isWin = move > 0
    }
    // A stale loss (>24h) is classified with whatever aftermath exists rather
    // than retrying forever; a fresh one waits for enough bars. Wins classify
    // immediately (they only need the holding-period bars).
    const stale = now - closedMs > 24 * 3_600_000
    const verdict = isWin
      ? classifyWin(t, bars, openedMs, closedMs)
      : classifyLoss(t, bars, closedMs, { allowPartial: stale })
    if (verdict === null) { waiting++; continue }
    // Honesty guard: a clipped fetch window (old trade > 400 bars) can hide
    // the early holding period, so a win's MFE/MAE may be understated — say
    // so instead of overstating "clean".
    if (isWin && bars.length && Number.isFinite(openedMs) && bars[0].t > openedMs + 2 * ms) {
      verdict.detail += ' (bar window clipped — early holding period not visible, MFE/MAE may be understated)'
    }

    const riskDist = t.sl_price != null ? Math.abs(t.entry_price - t.sl_price) : (Number(t.initial_risk) > 0 ? Number(t.initial_risk) : null)
    const rMult = riskDist > 0 && t.exit_price != null && t.entry_price != null
      ? (isWin ? 1 : -1) * (Math.abs(t.entry_price - t.exit_price) / riskDist)
      : null
    // Replay window: 20 bars before entry → aftermath end (compact for the UI).
    const fromMs = (openedMs || closedMs) - 20 * ms
    const toMs = closedMs + (AFTERMATH_BARS + 2) * ms
    const replay = bars.filter(b => b.t >= fromMs && b.t <= toMs)
    // Flat controller-consumable lesson fields (owner spec). Decay is read
    // over the PRIOR same-key history, before this row lands.
    const result = classifyResult(t)
    const decay = alphaDecayFlag(db, { symbol: t.symbol, strategy: t.strategy || null, timeframe: tf })
    const lesson = lessonLine(verdict.classification, { strategy: t.strategy, maeR: verdict.maeR })
    const eq = entryQuality(t.confluence_count)
    db.prepare(`
      INSERT INTO trade_postmortems
        (trade_id, symbol, strategy, timeframe, side, entry_price, exit_price, sl_price,
         net_pnl, r_multiple, classification, detail, bars_json,
         result, lesson, alpha_decay, entry_quality)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      t.id, t.symbol, t.strategy || null, tf, t.side, t.entry_price, t.exit_price, t.sl_price,
      t.net_pnl, rMult, verdict.classification, verdict.detail,
      JSON.stringify(replay.map(b => [b.t, b.o, b.h, b.l, b.c, b.v ?? null])),
      result, lesson, decay, eq,
    )
    classified++
  }
  return { examined: rows.length, classified, waiting }
}

/** Per-strategy aggregation of loss classes — the "learning" readout. */
export function postmortemStats(db, windowDays = 30) {
  return db.prepare(`
    SELECT COALESCE(strategy, 'unlabelled') AS strategy, classification, COUNT(*) AS n
    FROM trade_postmortems
    WHERE created_at >= datetime('now', ?)
    GROUP BY COALESCE(strategy, 'unlabelled'), classification
    ORDER BY strategy, n DESC
  `).all(`-${windowDays} days`)
}
