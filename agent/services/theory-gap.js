// ---------------------------------------------------------------------------
// agent/services/theory-gap.js — read-only measurements of where a strategy's
// results diverge from its theory. Research only: no gate, order path or
// management module reads this (agent/research-isolation.test.js), and it
// writes nothing.
//
// Claude · № 13,094 11-Oct (ordered № 13,093; claude-builder).
//
// SECTION 'r-audit' (plan step 2, B6). Two readings of the same tsmom_long
// trades disagreed: the trade-review record (trade_postmortems.r_multiple)
// said PF 2.8, the ledger (trades.realised_rr) said PF 0.8–0.9. The
// mechanism found by reading: the momentum book overwrites trades.sl_price
// with every confirmed trail (momentum-book.js), the postmortem divides the
// price move by THAT stop at postmortem time (loss-postmortem.js), so a
// trailed stop shrinks the denominator and inflates |R|. realisedRR
// (trade-consistency.js) divides by broker_sl_initial first. This audit
// computes R under EVERY candidate initial stop on record for each trade and
// reports PF/expectancy per candidate, so the owner sees which field is
// right from the numbers, not from the argument.
// ---------------------------------------------------------------------------
import { realisedRR } from './trade-consistency.js'
import { closedAtMs } from '../shared/formulas.js'

export const THEORY_GAP_SECTIONS = Object.freeze(['r-audit'])
export const R_AUDIT_DEFAULT_STRATEGY = 'tsmom_long'
export const R_AUDIT_MAX_DAYS = 365

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null))
const round = (v, d = 3) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d)
const long = side => /^(buy|long)$/i.test(String(side ?? ''))

/** Candidate initial stops, in the order the ledger trusts them. */
export const STOP_CANDIDATES = Object.freeze([
  { key: 'broker_sl_initial', label: 'the stop the broker first held (trades.broker_sl_initial) — what realised_rr divides by' },
  { key: 'proposal_sl', label: 'the stop the risk gate evaluated (risk_events.proposal_json.sl)' },
  { key: 'planned_sl', label: 'the plan recorded at entry (trade_plans.planned_sl)' },
  { key: 'initial_risk', label: 'the monitor row\'s initial_risk distance (monitored_positions.initial_risk)' },
  { key: 'postmortem_sl', label: 'the stop the postmortem divided by (trade_postmortems.sl_price, read at postmortem time)' },
  { key: 'current_sl', label: 'trades.sl_price now (overwritten by every book trail on momentum rows)' },
])

/**
 * One trade's R under each candidate. `move` is the signed price move of the
 * whole trade (exit − entry, sign by side); `fillWeightedMove` the same from
 * the broker's closing deals when there was more than one.
 */
export function rUnderCandidates(t) {
  const entry = num(t.entry_price), exit = num(t.exit_price)
  const dir = long(t.side) ? 1 : -1
  const move = entry != null && exit != null ? (exit - entry) * dir : null
  const out = {}
  for (const c of STOP_CANDIDATES) {
    let risk = null
    if (c.key === 'initial_risk') risk = num(t.initial_risk)
    else { const sl = num(t[c.key]); risk = sl != null && entry != null ? Math.abs(entry - sl) : null }
    if (!(risk > 0) || move == null) { out[c.key] = { available: risk > 0, r: null, risk: round(risk, 6) }; continue }
    out[c.key] = { available: true, risk: round(risk, 6), r: round(move / risk) }
  }
  return { move: round(move, 6), under: out }
}

function stat(rs) {
  const scored = rs.filter(r => r != null)
  const pos = scored.filter(r => r > 0).reduce((a, b) => a + b, 0), neg = -scored.filter(r => r < 0).reduce((a, b) => a + b, 0)
  const wins = scored.filter(r => r > 0).length
  return {
    n: scored.length, wins, losses: scored.filter(r => r < 0).length,
    winRatePct: scored.length ? round(wins / scored.length * 100, 1) : null,
    profitFactorR: neg > 0 ? round(pos / neg, 2) : (pos > 0 ? null : null),
    lossless: scored.length > 0 && neg === 0 && pos > 0,
    expectancyR: scored.length ? round(scored.reduce((a, b) => a + b, 0) / scored.length) : null,
    netR: round(scored.reduce((a, b) => a + b, 0), 2),
  }
}

/**
 * The R-field audit for one strategy over `days`. Read-only; one query per
 * table, joined in JS so a missing side table (older rows) is counted, not
 * guessed. Runs inside the report worker (performance-populations.js).
 */
export function rAudit(db, { strategy = R_AUDIT_DEFAULT_STRATEGY, days = R_AUDIT_MAX_DAYS, now = Date.now() } = {}) {
  const since = now - Math.min(R_AUDIT_MAX_DAYS, Math.max(1, days)) * 86_400_000
  const trades = db.prepare(`SELECT id, account_id, symbol, side, origin, entry_price, exit_price, sl_price AS current_sl, tp_price,
      broker_sl_initial, realised_rr, exit_price_suspect, net_pnl, close_reason, closed_at, closed_at_ms, risk_event_id, ctrader_position_id
    FROM trades WHERE status = 'closed' AND (strategy = ? OR label_strategy = ?)`).all(strategy, strategy)
    .filter(t => { const ms = closedAtMs(t); return ms != null && ms >= since && ms <= now && !/superseded/i.test(t.close_reason || '') })
  const ids = trades.map(t => t.id)
  const byId = new Map(trades.map(t => [t.id, t]))
  const join = (sql, map) => { if (!ids.length) return; for (const r of db.prepare(sql).all()) { const t = byId.get(r.trade_id); if (t) map(t, r) } }
  const inList = `(${ids.map(() => '?').join(',') || 'NULL'})`
  const all = (sql) => (ids.length ? db.prepare(sql).all(...ids) : [])
  for (const r of all(`SELECT trade_id, planned_sl, planned_entry, risk_dist FROM trade_plans WHERE trade_id IN ${inList}`)) { const t = byId.get(r.trade_id); if (t) { t.planned_sl = r.planned_sl; t.planned_entry = r.planned_entry; t.risk_dist = r.risk_dist } }
  for (const r of all(`SELECT trade_id, sl_price, r_multiple, entry_price FROM trade_postmortems WHERE trade_id IN ${inList}`)) { const t = byId.get(r.trade_id); if (t) { t.postmortem_sl = r.sl_price; t.postmortem_r = r.r_multiple } }
  for (const r of all(`SELECT trade_id, MAX(initial_risk) AS initial_risk FROM monitored_positions WHERE trade_id IN ${inList} GROUP BY trade_id`)) { const t = byId.get(r.trade_id); if (t) t.initial_risk = r.initial_risk }
  // The proposal the gate evaluated: its stop is in proposal_json.
  const reIds = trades.map(t => t.risk_event_id).filter(v => v != null)
  if (reIds.length) {
    const byRe = new Map()
    for (const r of db.prepare(`SELECT id, proposal_json FROM risk_events WHERE id IN (${reIds.map(() => '?').join(',')})`).all(...reIds)) {
      let p = null; try { p = JSON.parse(r.proposal_json || 'null') } catch { p = null }
      byRe.set(r.id, p)
    }
    for (const t of trades) { const p = byRe.get(t.risk_event_id); if (p) { t.proposal_sl = p.sl ?? p.stop ?? p.sl_price ?? null; t.proposal_tp1 = p.tp1 ?? p.tp ?? null } }
  }
  // Closing deals: more than one for a position means a partial; a
  // lots-weighted close price gives the whole trade's move.
  const deals = all(`SELECT matched_trade_id AS trade_id, lots, close_price FROM broker_deals WHERE matched_trade_id IN ${inList} AND close_price IS NOT NULL AND lots > 0`)
  const dealsBy = new Map()
  for (const d of deals) (dealsBy.get(d.trade_id) || dealsBy.set(d.trade_id, []).get(d.trade_id)).push(d)
  void join

  const rows = []
  const perCandidate = Object.fromEntries(STOP_CANDIDATES.map(c => [c.key, []]))
  let partials = 0, pmDiffers = 0, ledgerVsPm = { agree: 0, disagree: 0, unscored: 0 }
  for (const t of trades) {
    const r = rUnderCandidates(t)
    const legs = dealsBy.get(t.id) || []
    let fillWeightedR = null
    if (legs.length > 1) {
      partials++
      const lots = legs.reduce((s, d) => s + d.lots, 0)
      const wClose = legs.reduce((s, d) => s + d.close_price * d.lots, 0) / lots
      const risk = r.under.broker_sl_initial?.risk
      if (risk > 0) fillWeightedR = round(((wClose - num(t.entry_price)) * (long(t.side) ? 1 : -1)) / risk)
    }
    const bsl = num(t.broker_sl_initial), pm = num(t.postmortem_sl)
    const pmDiff = bsl != null && pm != null && Math.abs(pm - bsl) > 1e-9
    if (pmDiff) pmDiffers++
    const ledger = Number(t.exit_price_suspect) === 1 ? null : num(t.realised_rr)
    const pmR = num(t.postmortem_r)
    if (ledger == null || pmR == null) ledgerVsPm.unscored++
    else if (Math.abs(ledger - pmR) <= 0.005) ledgerVsPm.agree++
    else ledgerVsPm.disagree++
    for (const c of STOP_CANDIDATES) perCandidate[c.key].push(r.under[c.key].r)
    rows.push({
      id: t.id, symbol: t.symbol, side: t.side, origin: t.origin, closedAt: new Date(closedAtMs(t)).toISOString(),
      entry: t.entry_price, exit: t.exit_price, move: r.move,
      stops: { broker_sl_initial: t.broker_sl_initial, proposal_sl: t.proposal_sl ?? null, planned_sl: t.planned_sl ?? null,
        initial_risk: t.initial_risk ?? null, postmortem_sl: t.postmortem_sl ?? null, current_sl: t.current_sl },
      rUnder: Object.fromEntries(Object.entries(r.under).map(([k, v]) => [k, v.r])),
      ledgerRealisedRr: ledger, ledgerSuspect: Number(t.exit_price_suspect) === 1, ledgerRecomputed: round(realisedRR({ ...t, sl_price: t.current_sl })),
      postmortemR: pmR, postmortemStopDiffersFromBrokerInitial: pmDiff,
      closingDeals: legs.length, fillWeightedR,
    })
  }
  const candidates = STOP_CANDIDATES.map(c => ({ key: c.key, label: c.label, available: perCandidate[c.key].filter(v => v != null).length, ...stat(perCandidate[c.key]) }))
  return {
    section: 'r-audit', at: new Date(now).toISOString(), strategy, days, since: new Date(since).toISOString(),
    trades: trades.length,
    candidates,
    ledgerVsPostmortem: ledgerVsPm,
    postmortemStopDiffersFromBrokerInitial: pmDiffers,
    tradesWithPartialCloses: partials,
    rows,
    note: 'Read-only. R = (exit − entry, signed by side) / |entry − candidate stop|. realised_rr (the ledger) divides by broker_sl_initial, else sl_price; the postmortem divides by trades.sl_price AT POSTMORTEM TIME, which the momentum book overwrites with every confirmed trail — so where postmortemStopDiffersFromBrokerInitial is true the postmortem R is measured against a trailed stop, not the risk taken at entry. fillWeightedR uses the lots-weighted close of every broker closing deal when a position closed in more than one leg. Nothing here is a trading figure the gates read.',
  }
}

/** The section dispatcher the report worker calls. */
export function theoryGapReport(db, { section, ...options } = {}) {
  if (section === 'r-audit') return rAudit(db, options)
  throw new RangeError(`unknown theory-gap section: ${section}`)
}
