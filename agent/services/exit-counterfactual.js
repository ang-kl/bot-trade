// ---------------------------------------------------------------------------
// agent/services/exit-counterfactual.js — Phase 7, wired to the real ledger.
//
// Reads closed trades that have a stored bar window, replays each under every
// candidate exit rule, and reports the comparison. It is READ-ONLY: no row is
// written, no threshold read or changed, no order touched.
//
// THE RULE THAT GOVERNS WHAT MAY BE COUNTED. The repair prompt forbids using
// adopted, manual or unattributed trades as evidence of strategy edge, so this
// admits only CLEAN BOT ORIGINS by default — the trades this system actually
// decided to open. That is `cleanBotOrigin()` from #673, applied here rather
// than re-implemented.
//
// AND IT REFUSES TO ANSWER ON TOO LITTLE. `minSample` is not decoration: on
// 2026-08-06 the whole book had 37 clean rows, all from a single day, and a
// profit factor computed over those would have looked exactly as authoritative
// as one computed over a year. The report says `verdict: 'INSUFFICIENT'` and
// names the shortfall instead of printing a number nobody should act on.
// ---------------------------------------------------------------------------

import { cleanBotOrigin } from '../lib/trade-origin.js'
import { parseBars, replayExit, summariseReplay, DEFAULT_RULES } from '../lib/exit-replay.js'

/**
 * Below this many usable trades PER RULE, no comparison is reported.
 *
 * 30 is the smallest sample at which a win-rate difference of the size this is
 * looking for (60% of exits being time_cap) is distinguishable from noise at
 * all. It is a floor on being misleading, NOT a claim of significance — a real
 * significance test needs the walk-forward work this phase does not do.
 */
export const MIN_SAMPLE = 30

const ms = (s) => {
  if (s == null) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/**
 * Load the replayable population.
 *
 * A trade qualifies only with: a stored bar window, an entry, a stop, and —
 * unless `cleanOnly` is off — a clean bot origin.
 */
export function replayablePopulation(db, { days = 30, cleanOnly = true, accountId = null } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const rows = db.prepare(`
    SELECT t.id, t.symbol, t.side, t.entry_price, t.sl_price, t.tp_price,
           t.opened_at, t.closed_at, t.net_pnl, t.origin, t.account_id,
           pm.bars_json, pm.r_multiple AS actual_r, pm.classification
      FROM trades t
      JOIN trade_postmortems pm ON pm.trade_id = t.id
     WHERE t.status = 'closed' AND t.closed_at IS NOT NULL AND t.closed_at >= ?
       AND (? IS NULL OR t.account_id = ?)
     ORDER BY t.closed_at DESC
  `).all(since, accountId, accountId)

  const skipped = { not_clean_origin: 0, no_bars: 0, no_levels: 0 }
  const eligible = []
  for (const r of rows) {
    if (cleanOnly && !cleanBotOrigin(r.origin)) { skipped.not_clean_origin++; continue }
    if (r.entry_price == null || r.sl_price == null) { skipped.no_levels++; continue }
    const { bars } = parseBars(r.bars_json)
    if (!bars.length) { skipped.no_bars++; continue }
    eligible.push({ row: r, bars })
  }
  return { considered: rows.length, eligible, skipped }
}

/**
 * The counterfactual comparison.
 *
 * @returns {{verdict: 'OK'|'INSUFFICIENT', days, considered, eligible,
 *   skipped, minSample, rules: Array, actual: object|null, note: string}}
 *
 * Each rule row carries its own `usable`, `ambiguous` and `truncated` counts —
 * a rule can be under-sampled while another is fine, and one aggregate figure
 * would hide that.
 */
export function exitCounterfactual(db, {
  days = 30, rules = DEFAULT_RULES, cleanOnly = true, accountId = null, minSample = MIN_SAMPLE,
} = {}) {
  const pop = replayablePopulation(db, { days, cleanOnly, accountId })

  const perRule = (Array.isArray(rules) ? rules : []).map((rule) => {
    const results = pop.eligible.map(({ row, bars }) => replayExit(bars, {
      side: row.side,
      entry: row.entry_price,
      sl: row.sl_price,
      tp: row.tp_price,
      openedAtMs: ms(row.opened_at),
    }, rule))
    return { rule: rule.name, spec: rule, ...summariseReplay(results) }
  })

  // What the system actually returned over the SAME population, so the
  // comparison is like-for-like. Comparing a replayed rule against a
  // book-wide historical figure would compare two different trade sets — the
  // error this repo has already made three times with multi-day aggregates.
  const actualRs = pop.eligible
    .map(({ row }) => Number(row.actual_r))
    .filter(n => Number.isFinite(n))
  const actual = actualRs.length
    ? summariseReplay(actualRs.map(r => ({ ok: true, rMultiple: r, reason: 'as_recorded' })))
    : null

  const best = perRule.filter(r => r.usable >= minSample).length
  const verdict = best > 0 ? 'OK' : 'INSUFFICIENT'
  return {
    verdict,
    days,
    cleanOnly,
    minSample,
    considered: pop.considered,
    eligible: pop.eligible.length,
    skipped: pop.skipped,
    actual,
    rules: perRule,
    note: verdict === 'OK'
      ? `${pop.eligible.length} replayable trade(s) over ${days}d; ${best} of ${perRule.length} rule(s) reached the ${minSample}-trade floor. Ambiguous and truncated trades are excluded from every figure and counted beside it.`
      : `INSUFFICIENT — ${pop.eligible.length} replayable trade(s) over ${days}d, none of the ${perRule.length} rules reached the ${minSample}-trade floor. `
        + `Skipped: ${pop.skipped.not_clean_origin} not clean origin, ${pop.skipped.no_bars} without a stored bar window, ${pop.skipped.no_levels} without entry/stop. `
        + 'No comparison is reported, because a figure computed over this many trades would read exactly as authoritative as one that had earned it.',
  }
}
