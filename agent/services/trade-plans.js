// ---------------------------------------------------------------------------
// agent/services/trade-plans.js — the plan at entry, scored at close
// (§7,437·B·4, owner 08-09-2026).
//
// Nothing on the trades row survived as "what we meant": entry_price is
// overwritten by the fill, sl/tp by the fill anchor and later by trails or
// the momentum book's target-null, the time cap lives on monitored_positions
// (swept to closed), and the postmortem re-derives risk from whatever
// sl_price is by then. So the daily report's plan-versus-execution table has
// been empty for every close, and 24 closes carried no postmortem at all.
//
// This records the plan as its own row at the moment the intent is written —
// planned entry/stop/target, R at target, intended hold, the exit rule that
// will govern it — and scores the row when the trade closes: entry slippage
// in R (adverse positive), realised R against planned R, hold against the
// intended hold, and whether the exit reason matched the rule. The score is
// a property of execution, measurable on every close from the first one,
// with no edge assumption anywhere in it.
// ---------------------------------------------------------------------------

import { loadManagedExit, managedExitApplies } from './managed-exit.js'
import { familyOf } from './strategies.js'

const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const isLong = (side) => /^(long|buy)$/i.test(String(side || ''))

/**
 * The exit rule this position will live under, named at entry so the close
 * can be judged against it. Momentum rows trail 3×ATR with no target; a
 * signal-declared cap names its minutes; a managed account names its trail
 * (and the +1R take where the family gets one); the rest is stop-or-target.
 */
export function exitRuleFor(db, { strategy = null, source = null, accountId = null, timeCapMin = null } = {}) {
  if (/^momentum/.test(String(source || '')) || String(strategy || '') === 'tsmom_long') return 'momentum_trail_3atr'
  if (Number.isFinite(Number(timeCapMin)) && Number(timeCapMin) > 0) return `time_cap_${Math.round(Number(timeCapMin))}m`
  let applies = false
  try { applies = managedExitApplies(db, accountId) } catch { applies = false }
  if (applies) {
    const p = loadManagedExit(db)
    const fam = familyOf(strategy)
    const take = Array.isArray(p.takeAtRFamilies) && p.takeAtRFamilies.includes(fam) && p.takeAtR > 0 ? `_take${p.takeAtR}R` : ''
    return `managed_trail${p.trailR}R${take}`
  }
  return 'stop_target'
}

// X1 / W3 (25-09-2026): no real stop sits half the price away. The same
// versioned constant as order-lifecycle.js ABSURD_RISK_FRACTION (ORD-03
// plan_invalid), pinned equal by trade-plans.test.js.
export const PLAN_ABSURD_RISK_FRACTION = 0.5
export const PLAN_REFUSAL_PATH = '/trade-plans/refused'

/**
 * Why a plan cannot be what was meant: a stop or target on the wrong side of
 * the entry for the side, or a stop so far away it can only be a unit error
 * (wire points written as a price). Mirrors ORD-03's checks. [] when sound.
 */
export function planProblems({ side, entry, sl, tp = null }) {
  const e = num(entry), s = num(sl), t = num(tp)
  const dir = isLong(side) ? 1 : /^(short|sell)$/i.test(String(side || '')) ? -1 : null
  const out = []
  if (dir != null && e != null) {
    if (s != null && (dir > 0 ? s >= e : s <= e)) out.push('sl_wrong_side')
    if (t != null && (dir > 0 ? t <= e : t >= e)) out.push('tp_wrong_side')
  }
  if (e != null && e > 0 && s != null && Math.abs(e - s) / e > PLAN_ABSURD_RISK_FRACTION) out.push('risk_scale')
  return out
}

/** How many plans recordTradePlan refused, by reason — read from the action_log rows it writes. */
export function planRefusalCounts(db, { sinceIso = null } = {}) {
  const rows = db.prepare(`SELECT body FROM action_log WHERE method = 'PLAN' AND path = ? ${sinceIso ? 'AND at >= ?' : ''}`)
    .all(PLAN_REFUSAL_PATH, ...(sinceIso ? [sinceIso] : []))
  const byReason = {}
  for (const r of rows) {
    let b = null
    try { b = JSON.parse(r.body) } catch { b = null }
    for (const p of b?.problems || ['unparsed']) byReason[p] = (byReason[p] || 0) + 1
  }
  return { refused: rows.length, byReason }
}

/**
 * Write the plan for a trade. Idempotent per trade (INSERT OR REPLACE) so an
 * intent row promoted to open can re-record without duplicating.
 *
 * X1 / W3: a plan whose stop or target is on the wrong side, or whose stop
 * is absurdly far (planProblems), is REFUSED — not written — and the refusal
 * is counted (an action_log row, planRefusalCounts). A wrong plan is worse
 * than none: closed-market-limits skips its own correct plan when one
 * exists, and every score at close would be computed against it.
 */
export function recordTradePlan(db, tradeId, {
  accountId = null, symbol, side, strategy = null, timeframe = null,
  entry, sl, tp = null, timeCapAt = null, timeCapMin = null, source = null, exitRule = null, now = Date.now(),
} = {}) {
  const e = num(entry), s = num(sl), t = num(tp)
  const problems = planProblems({ side, entry: e, sl: s, tp: t })
  if (problems.length) {
    try {
      db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
        .run('PLAN', PLAN_REFUSAL_PATH, JSON.stringify({ tradeId: Number(tradeId), symbol: symbol ?? null, side: side ?? null, entry: e, sl: s, tp: t, source: source || null, problems }),
          accountId != null ? String(accountId) : null)
    } catch { /* the count is a record, never a reason to throw at the caller */ }
    return { tradeId: Number(tradeId), refused: problems, plannedR: null, riskDist: null, plannedHoldMin: null, exitRule: null }
  }
  const risk = e != null && s != null ? Math.abs(e - s) : null
  const plannedR = risk > 0 && t != null ? Math.round((Math.abs(t - e) / risk) * 1000) / 1000 : null
  let holdMin = num(timeCapMin)
  if (holdMin == null && timeCapAt) {
    const capMs = Date.parse(timeCapAt)
    if (Number.isFinite(capMs)) holdMin = Math.max(0, Math.round((capMs - now) / 60_000))
  }
  const rule = exitRule || exitRuleFor(db, { strategy, source, accountId, timeCapMin: holdMin })
  db.prepare(`
    INSERT OR REPLACE INTO trade_plans (trade_id, account_id, symbol, side, strategy, family, timeframe,
      planned_entry, planned_sl, planned_tp, planned_r, risk_dist, planned_hold_min, exit_rule, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(tradeId), accountId != null ? String(accountId) : null, String(symbol), String(side),
    strategy || null, strategy ? familyOf(strategy) : null, timeframe || null,
    e, s, t, plannedR, risk, holdMin, rule, source || null, new Date(now).toISOString(),
  )
  return { tradeId: Number(tradeId), plannedR, riskDist: risk, plannedHoldMin: holdMin, exitRule: rule }
}

/** The exit a close reason belongs to, for matching against the plan's rule. */
export function exitKind(closeReason) {
  const r = String(closeReason || '').toLowerCase()
  if (!r) return 'unknown'
  // PR-E (owner principle 4, 11-09-2026): a close the BOT did not make — the
  // reconciler's "closed at the broker …" stamp and the monitor's
  // 'already_closed' — is a named, non-attributive reason, not 'other'. It
  // never matches a rule (ruleAdmits) and the daily report counts it apart,
  // so a broker-side exit is visible as what it is rather than folded into
  // the unexplained bucket.
  if (r === 'already_closed' || /^closed at the broker/.test(r)) return 'broker_closed'
  if (/take_profit|target|tp\b|tp_hit|tp1|tp2/.test(r)) return 'target'
  if (/trail|ratchet|locked|profit_lock|be_stop|breakeven/.test(r)) return 'trail'
  if (/stop_loss|stop|sl\b|sl_hit|stopped/.test(r)) return 'stop'
  if (/time_cap|timecap|cap|expired|stale|max_hold/.test(r)) return 'time_cap'
  if (/manual|owner|user|bank|weekend|sweep/.test(r)) return 'manual'
  if (/take_at_r|\+1r|take/.test(r)) return 'take'
  return 'other'
}

/** Which exit kinds a rule admits as "the plan playing out". */
export function ruleAdmits(exitRule, kind) {
  const rule = String(exitRule || '')
  if (kind === 'stop' || kind === 'target') return true
  if (kind === 'trail') return /momentum|managed/.test(rule)
  if (kind === 'take') return /take/.test(rule)
  if (kind === 'time_cap') return /time_cap/.test(rule)
  return false
}

/**
 * Score every closed trade that has a plan and no score. DB-only, bounded.
 * Slippage is signed adverse-positive: a long filled above its planned entry
 * paid slippage; realised R is taken from realised_rr when the consistency
 * stamp has run, else from exit versus the planned entry.
 */
export function scoreClosedPlans(db, { now = Date.now(), limit = 200 } = {}) {
  const rows = db.prepare(`
    SELECT t.id, t.side, t.entry_price, t.exit_price, t.close_reason, t.hold_duration_ms, t.realised_rr, t.net_pnl,
           p.planned_entry, p.planned_sl, p.planned_tp, p.planned_r, p.risk_dist, p.planned_hold_min, p.exit_rule
      FROM trades t JOIN trade_plans p ON p.trade_id = t.id
     WHERE t.status = 'closed' AND p.scored_at IS NULL
     ORDER BY t.closed_at_ms ASC LIMIT ?
  `).all(limit)
  const upd = db.prepare(`
    UPDATE trade_plans SET scored_at = ?, entry_slippage_r = ?, realised_r = ?, hold_min = ?, hold_vs_plan = ?,
           exit_reason = ?, exit_matched = ?, score_note = ? WHERE trade_id = ?
  `)
  let scored = 0
  for (const r of rows) {
    const dir = isLong(r.side) ? 1 : -1
    const risk = num(r.risk_dist)
    const fill = num(r.entry_price), plan = num(r.planned_entry), exit = num(r.exit_price)
    const slip = risk > 0 && fill != null && plan != null ? Math.round(((fill - plan) * dir / risk) * 1000) / 1000 : null
    let realised = num(r.realised_rr)
    if (realised == null && risk > 0 && exit != null && fill != null) realised = (exit - fill) * dir / risk
    if (realised != null) realised = Math.round(realised * 1000) / 1000
    const holdMin = num(r.hold_duration_ms) != null ? Math.round(r.hold_duration_ms / 60_000) : null
    const planned = num(r.planned_hold_min)
    const holdVsPlan = holdMin != null && planned > 0 ? Math.round((holdMin / planned) * 100) / 100 : null
    const kind = exitKind(r.close_reason)
    const matched = ruleAdmits(r.exit_rule, kind) ? 1 : 0
    const note = [
      slip != null ? `slippage ${slip >= 0 ? '+' : ''}${slip}R` : 'slippage n/a',
      realised != null ? `realised ${realised}R` + (num(r.planned_r) != null ? ` of ${r.planned_r}R planned` : '') : 'realised R n/a',
      holdVsPlan != null ? `held ${holdVsPlan}× the intended hold` : holdMin != null ? `held ${holdMin}m` : 'hold n/a',
      `exit ${kind}${matched ? '' : ' (outside the rule)'} under ${r.exit_rule}`,
    ].join(' · ')
    upd.run(new Date(now).toISOString(), slip, realised, holdMin, holdVsPlan, r.close_reason || null, matched, note, r.id)
    scored++
  }
  return { scored, remaining: Math.max(0, rows.length === limit ? 1 : 0) }
}

/**
 * Coverage and the scored population over a window. Coverage is by origin so
 * the reconciler's adopted rows (which carry no plan by design) are counted
 * apart from the bot's own entries.
 */
export function tradePlansReport(db, { days = 30, now = Date.now() } = {}) {
  const sinceMs = now - days * 86_400_000
  const closed = db.prepare(`
    SELECT t.id, t.origin, p.trade_id AS has_plan, p.scored_at
      FROM trades t LEFT JOIN trade_plans p ON p.trade_id = t.id
     WHERE t.status = 'closed' AND t.closed_at_ms >= ?
  `).all(sinceMs)
  const byOrigin = {}
  for (const r of closed) {
    const k = r.origin || 'unknown'
    const b = byOrigin[k] || (byOrigin[k] = { closed: 0, planned: 0, scored: 0 })
    b.closed++; if (r.has_plan) b.planned++; if (r.scored_at) b.scored++
  }
  const bot = closed.filter(r => r.origin && r.origin !== 'reconciler_adopted')
  const coverage = {
    closed: closed.length,
    botClosed: bot.length,
    botPlanned: bot.filter(r => r.has_plan).length,
    botScored: bot.filter(r => r.scored_at).length,
    byOrigin,
  }
  const scored = db.prepare(`
    SELECT p.*, t.symbol AS t_symbol, t.closed_at_ms FROM trade_plans p JOIN trades t ON t.id = p.trade_id
     WHERE p.scored_at IS NOT NULL AND t.closed_at_ms >= ? ORDER BY t.closed_at_ms DESC LIMIT 200
  `).all(sinceMs)
  const mean = (xs) => xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null
  const slips = scored.map(r => num(r.entry_slippage_r)).filter(v => v != null)
  const rs = scored.map(r => num(r.realised_r)).filter(v => v != null)
  const holds = scored.map(r => num(r.hold_vs_plan)).filter(v => v != null)
  const aggregate = {
    n: scored.length,
    meanSlippageR: mean(slips),
    meanRealisedR: mean(rs),
    meanPlannedR: mean(scored.map(r => num(r.planned_r)).filter(v => v != null)),
    meanHoldVsPlan: mean(holds),
    exitMatchedPct: scored.length ? Math.round((scored.filter(r => r.exit_matched).length / scored.length) * 1000) / 10 : null,
  }
  const open = db.prepare(`SELECT COUNT(*) AS n FROM trade_plans p JOIN trades t ON t.id = p.trade_id WHERE t.status IN ('open','submitting')`).get().n
  return { days, coverage, aggregate, openPlans: open, recent: scored.slice(0, 50), note: 'Plans are written at entry and scored at close; a close with no plan is a coverage gap, not a score.' }
}
