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
import { isSymbolMarketOpen } from '../lib/sessions.js'

export const AFTERMATH_BARS = 12   // how many post-exit bars the verdict may use
export const MIN_AFTER_BARS = 5    // fewer than this → wait (or inconclusive)
// Owner: "some symbol traded SL so earlier or very close to entry, you need
// to be honest" — a stop hit within this many bars of entry barely gave the
// idea room to work. "thesis_wrong" (and stop_hunt) read as if the market
// had a fair say; when the hold was this short, that's misleading — the
// lesson should say so plainly instead of implying a considered thesis was
// tested over a reasonable window.
export const TIGHT_HOLD_BARS = 2

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
    afterBars: after.length,
  }
}

function verdictHunt(nBars) {
  return {
    classification: 'stop_hunt',
    detail: `Price swept the stop, then came back to the entry within ${nBars} bar(s). The direction was right — the stop was too tight or the entry too early.`,
    nBars,
  }
}
function verdictWrong(risk) {
  return {
    classification: 'thesis_wrong',
    detail: `Price continued ≥1R (${risk.toFixed(5)}) beyond the stop. The stop did its job — the idea was wrong, not the exit.`,
    risk,
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

/**
 * One imperative lesson line (<15 words) naming the deciding condition.
 *
 * Owner: "why so many are the same lesson, nothing is contextual" — every
 * branch here used to return a FIXED string regardless of the trade, so 30
 * stop-hunts on the same symbol/timeframe read as 30 identical lessons.
 * Every branch now pulls real per-trade numbers already computed by the
 * classifier (bars to reclaim, R distances, stop width) — genuinely
 * DIFFERENT trades produce genuinely different text; only trades that
 * truly share the same bars-to-reclaim etc. will still read alike, which is
 * an honest reflection of the market repeating itself, not a template.
 */
export function lessonLine(classification, ctx = {}) {
  const R = (v) => (Number.isFinite(v) ? v.toFixed(2) : null)
  // Honest caveat: the stop was hit almost immediately — barely any time for
  // the idea to work, so a "thesis wrong" / "stop too tight" read is really a
  // guess either way. Prefix, never silently baked into the main verdict.
  const tightHold = Number.isFinite(ctx.holdBars) && ctx.holdBars <= TIGHT_HOLD_BARS
    ? `Stopped within ${ctx.holdBars} bar(s) of entry — barely any room to work. `
    : ''
  switch (classification) {
    case 'stop_hunt': {
      const bars = Number.isFinite(ctx.nBars) ? `${ctx.nBars} bar(s)` : 'a few bars'
      const dist = Number.isFinite(ctx.riskDist) ? ` (${ctx.riskDist.toFixed(5)})` : ''
      return `${tightHold}Widen stop past this sweep${dist}; price reclaimed entry in ${bars}.`
    }
    case 'thesis_wrong': {
      const dist = Number.isFinite(ctx.riskDist) ? ` ${ctx.riskDist.toFixed(5)}` : ''
      return `${tightHold}Re-validate ${ctx.strategy || 'the'} entry; price ran ≥1R${dist} past the stop.`
    }
    case 'chop': {
      const bars = Number.isFinite(ctx.afterBars) ? `${ctx.afterBars} bars` : 'the aftermath'
      return `Require a stronger trend filter; ${bars} of noise, no follow-through.`
    }
    case 'time_cap': return 'Avoid setups needing more time than the cap allows.'
    case 'gave_back': {
      const mfe = R(ctx.mfeR), real = R(ctx.realizedR)
      return mfe != null && real != null
        ? `Bank earlier — peaked +${mfe}R, banked only +${real}R.`
        : 'Bank earlier; peak exceeded the exit by a full R.'
    }
    case 'clean_win': {
      const mfe = R(ctx.mfeR), real = R(ctx.realizedR)
      return mfe != null && real != null
        ? `Repeat this setup; banked +${real}R of +${mfe}R best.`
        : 'Repeat this setup; the exit captured the available move.'
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// ¶D·4 — "I didn't see the lesson learnt!"
//
// The owner, twelve minutes after a NAS100 short lost $1,013.08. There was no
// lesson because there COULD not be one yet: a verdict on what the market did
// after the exit needs MIN_AFTER_BARS (5) bars of aftermath, and on a 10-minute
// chart that is fifty minutes away. The sweep was working exactly as designed.
//
// But /state/postmortems only returns trades that already HAVE a postmortem
// row, so a trade still in its waiting period is simply absent — and absent
// reads as "nothing was learned from this", not "not yet". The fix is to say
// so: list what is pending, why, and when it will be ready.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Closed trades with no lesson yet, and the reason for each.
 *
 * Pure read. Mirrors the sweep's own eligibility rules so the two never
 * disagree about what is in the queue — a "pending" trade the sweep will
 * never pick up would be a worse lie than the blank it replaces.
 *
 * ELAPSED TIME IS NOT COMPLETED BARS (Codex review, #477). A trade closed on
 * a Friday evening accrues a whole weekend of wall clock and not one bar. So
 * every count and time here is an ESTIMATE and is named as one: `due` says
 * the wait is over BY THE CLOCK, not that the sweep will definitely classify
 * it next pass — classifyLoss counts real bars and will keep waiting if the
 * market never printed them. Reading it out of a read route would mean
 * fetching bars per trade on a page load, which is the wrong trade;
 * over-promising is fixed by saying less, not by working harder here.
 *
 * @returns {{rows:Array, waiting:number, ineligible:number}}
 *   rows[].state — 'waiting' (aftermath still accumulating) | 'due' (enough
 *   time has passed) | 'ineligible' (no outcome can be derived — it will
 *   never get a lesson).
 */
export function pendingLessons(db, { now = Date.now(), windowDays = 7, limit = 50, minAfterBars = MIN_AFTER_BARS } = {}) {
  let rows = []
  try {
    rows = db.prepare(`
      SELECT t.id, t.symbol, t.side, t.net_pnl, t.exit_price, t.entry_price,
             t.closed_at, t.close_reason, t.account_id,
             COALESCE(t.label_strategy, t.strategy) AS strategy,
             t.label_timeframe AS timeframe
        FROM trades t
        LEFT JOIN trade_postmortems pm ON pm.trade_id = t.id
       WHERE t.status = 'closed' AND pm.id IS NULL
         AND t.closed_at >= datetime('now', ?)
       ORDER BY t.closed_at DESC LIMIT ?
    `).all(`-${windowDays} days`, limit)
  } catch { return { rows: [], waiting: 0, ineligible: 0 } }

  // Best-effort: an unmapped or exotic symbol simply reports null rather than
  // blocking the whole list on a schedule lookup.
  const marketOpenFor = (sym) => {
    try { return isSymbolMarketOpen(sym) } catch { return null }
  }

  const out = []
  for (const t of rows) {
    const closedMs = sqliteMs(t.closed_at)
    if (!Number.isFinite(closedMs)) continue

    // Same eligibility test the sweep uses. A trade that fails it will never
    // produce a lesson, and saying "pending" about it would be a false promise.
    const eligible = (t.net_pnl != null && Number(t.net_pnl) !== 0)
      || (t.net_pnl == null && t.exit_price != null && t.entry_price != null)

    const tf = t.timeframe || '1h'
    const barMs = tfMs(tf) || 3_600_000
    const needMs = minAfterBars * barMs
    const elapsedMs = Math.max(0, now - closedMs)
    const barsSoFar = Math.floor(elapsedMs / barMs)
    const readyAtMs = closedMs + needMs
    const remainMin = Math.max(0, Math.ceil((readyAtMs - now) / 60_000))

    const base = {
      tradeId: t.id, symbol: t.symbol, side: t.side, strategy: t.strategy || null,
      timeframe: tf, closedAt: t.closed_at, accountId: t.account_id ?? null,
      // Named as estimates. A trade closed on a Friday evening accrues a
      // weekend of clock and no bars at all, so these are an upper bound on
      // progress, never a bar count.
      barsSoFarEstimate: barsSoFar, barsRequired: minAfterBars,
      readyAtEstimate: new Date(readyAtMs).toISOString(),
      // Cheap, already-loaded truth that explains most of the gap.
      marketOpen: marketOpenFor(t.symbol),
    }

    if (!eligible) {
      out.push({
        ...base, state: 'ineligible', readyAtEstimate: null,
        note: t.net_pnl != null && Number(t.net_pnl) === 0
          // Worth naming: a flat trade is not a bug, and it will never appear
          // in the lesson list no matter how long anyone waits.
          ? 'closed exactly flat — there is no outcome to learn from'
          : 'no realised P&L and no exit price — the outcome cannot be determined',
      })
      continue
    }

    // "the market has been closed since" is the honest reason a due trade can
    // sit unclassified, and it is the common one — most trades that look
    // overdue closed before a weekend.
    const closedNote = base.marketOpen === false ? '; the market is closed, so no new bars are printing' : ''

    out.push(barsSoFar >= minAfterBars
      ? {
        ...base, state: 'due',
        // Deliberately conditional. classifyLoss counts REAL bars and will
        // keep waiting if the market never printed them, so promising the
        // next sweep would be a new lie in place of the old blank.
        note: `${minAfterBars} bars' worth of time has passed — the next sweep classifies this once the market has actually printed that many bars${closedNote}`,
      }
      : {
        ...base, state: 'waiting',
        note: `lesson pending — needs ${minAfterBars} bars after close to see what the market did, roughly ${barsSoFar} so far on the ${tf} chart (~${remainMin} min away if the market stays open)${closedNote}`,
      })
  }

  return {
    rows: out,
    waiting: out.filter(r => r.state === 'waiting').length,
    ineligible: out.filter(r => r.state === 'ineligible').length,
  }
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
           t.confluence_count, t.account_id,
           -- VOL-GATE entry context. This SELECT names columns explicitly
           -- rather than using a star, so a column omitted here reads
           -- undefined in JS and silently writes NULL to the postmortem
           -- forever -- a failure indistinguishable from "the gate never ran".
           t.entry_vol_regime, t.entry_vol_percentile, t.position_size_ratio_applied,
           t.stop_loss_expanded_pips, t.vol_volume_divergence_flag,
           t.confluence_tool_count, t.confluence_conflict_flagged, t.vol_gate_mode,
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
    const holdBars = Number.isFinite(openedMs) ? Math.max(0, Math.round((closedMs - openedMs) / ms)) : null
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
    const lesson = lessonLine(verdict.classification, {
      strategy: t.strategy, maeR: verdict.maeR, mfeR: verdict.mfeR, realizedR: verdict.realizedR,
      nBars: verdict.nBars, afterBars: verdict.afterBars, riskDist, holdBars,
    })
    const eq = entryQuality(t.confluence_count)
    db.prepare(`
      INSERT INTO trade_postmortems
        (trade_id, symbol, strategy, timeframe, side, entry_price, exit_price, sl_price,
         net_pnl, r_multiple, classification, detail, bars_json,
         result, lesson, alpha_decay, entry_quality, account_id,
         entry_vol_regime, entry_vol_percentile, position_size_ratio_applied,
         stop_loss_expanded_pips, vol_volume_divergence_flag,
         confluence_tool_count, confluence_conflict_flagged, vol_gate_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      t.id, t.symbol, t.strategy || null, tf, t.side, t.entry_price, t.exit_price, t.sl_price,
      t.net_pnl, rMult, verdict.classification, verdict.detail,
      JSON.stringify(replay.map(b => [b.t, b.o, b.h, b.l, b.c, b.v ?? null])),
      result, lesson, decay, eq,
      // M1 lesson scoping (plan D5): the lesson inherits its TRADE's account
      // so demo lessons can never tune the live account once reads scope.
      t.account_id ?? null,
      // VOL-GATE: the volatility context this trade was OPENED in, carried
      // forward so a lesson row is self-contained — the lessons tuner reads
      // postmortems, not trades. This is the whole point of the close hook
      // the spec asked for, done in the handler that already exists rather
      // than a second one: `runLossPostmortems` already runs on every closed
      // trade, win or loss, and already computes the outcome vocabulary.
      //
      // NULL until the gate actually runs. That is the honest "not measured",
      // and it is why every bucketed report must exclude nulls rather than
      // fold them into NORMAL — a pre-gate trade is not a NORMAL-vol trade.
      t.entry_vol_regime ?? null,
      t.entry_vol_percentile ?? null,
      t.position_size_ratio_applied ?? null,
      t.stop_loss_expanded_pips ?? null,
      t.vol_volume_divergence_flag ?? null,
      t.confluence_tool_count ?? null,
      t.confluence_conflict_flagged ?? null,
      t.vol_gate_mode ?? null,
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
