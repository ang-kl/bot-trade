// ---------------------------------------------------------------------------
// agent/services/refusal-ledger.js — what the refusals cost
// (§7,437·B·2, owner 08-09-2026).
//
// The risk gate refuses hundreds of proposals a day and logs each with a
// reason; "top reason: bad_rr" was the whole of what anyone could say about
// them. This scores each refused setup against the bars that followed: had
// it been taken at its own entry, stop and target, what R would it have
// reached within its horizon? Summed per reason per week, that turns a label
// into a number — the R the gate forwent (positive) or the loss it avoided
// (negative) — so a gate can be tuned against what it actually did.
//
// The rows already exist: risk_events keeps proposal_json (entry, sl, tp1,
// strategy, side, accountId) and opportunity_key, which collapses the same
// setup re-proposed every loop into one opportunity. What was missing was
// the timeframe on the two hot paths (added with this file) and a scorer.
//
// No bar table exists, so bars come from the broker through the same
// injected fetcher the loss postmortem uses, capped per cycle. The replay is
// lib/exit-replay.js's, including its refusal to guess intrabar order: a bar
// that touched both stop and target is `ambiguous`, not a win.
// ---------------------------------------------------------------------------

import { replayExit } from '../lib/exit-replay.js'
import { reasonKey } from './veto-breakdown.js'
import { resolveOpportunity } from './opportunity-identity.js'

const TF_MIN = { m1: 1, '1m': 1, m5: 5, '5m': 5, m15: 15, '15m': 15, m30: 30, '30m': 30, h1: 60, '1h': 60, h4: 240, '4h': 240, h8: 480, '8h': 480, h12: 720, '12h': 720, d1: 1440, '1d': 1440, w1: 10080, '1w': 10080 }
const MAX_HORIZON_MIN = 20 * 1440   // the book's measured median hold (№ 7,379)
const MIN_HORIZON_MIN = 240
const DEFAULT_TF = '1h'

export function tfMinutes(tf) {
  return TF_MIN[String(tf || '').toLowerCase()] ?? null
}

/** Horizon = 48 bars of the proposal's own timeframe, floored at 4h, capped at 20 days. */
export function horizonMinFor(tf) {
  const m = tfMinutes(tf) ?? tfMinutes(DEFAULT_TF)
  return Math.max(MIN_HORIZON_MIN, Math.min(MAX_HORIZON_MIN, m * 48))
}

const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }

/**
 * Refused opportunities whose horizon has elapsed and that have no score.
 * One row per opportunity_key: the first refusal's proposal levels, the
 * count of loops it was re-proposed on, and the reason as last stated.
 */
/**
 * PR-C: evidence-gate refusals are decision_log SKIPS now (services/
 * gate-skips.js), with the proposal in detail_json — the ledger used to score
 * them from risk_events. This reads them back into the same shape the
 * risk_events query produces, keyed by the SAME rule (resolveOpportunity,
 * per account|symbol|side|strategy tuple in time order, the backfill's
 * walk), so a shadow refusal is still scored for forgone R. Unscored keys
 * only; rows without a readable proposal are unscorable downstream.
 */
export function evidenceShadowRefusals(db) {
  let rows = []
  try {
    rows = db.prepare(`
      SELECT account_id, symbol, strategy, reason, detail_json, created_at
        FROM decision_log
       WHERE stage IN ('evidence_gate', 'gate_redirect') AND decision = 'skip'
       ORDER BY account_id, symbol, strategy, created_at ASC, id ASC
    `).all()
  } catch { return [] }
  const byKey = new Map()
  let prevTuple = null, prev = null
  for (const r of rows) {
    let p = null, detail = null
    try { detail = JSON.parse(r.detail_json || 'null'); p = detail?.proposal ?? null } catch { p = null }
    // A gate_redirect row's `reason` column is the HEAD (the boundary's
    // key); the full string the gate said is in detail.reason. Score under
    // the full string so reasonKey groups it with the pre-boundary history.
    const reason = detail?.reason || r.reason
    const proposal = { symbol: r.symbol, side: p?.side ?? null, strategy: r.strategy }
    const createdMs = Date.parse(String(r.created_at).replace(' ', 'T') + (/[zZ]$/.test(String(r.created_at)) ? '' : 'Z'))
    if (!Number.isFinite(createdMs)) continue
    const tuple = `${r.account_id ?? '-'}|${r.symbol}|${proposal.side ?? '-'}|${r.strategy ?? '-'}`
    const res = resolveOpportunity(proposal, { accountId: r.account_id, now: createdMs, previous: tuple === prevTuple ? prev : null })
    prevTuple = tuple
    prev = { opportunity_key: res.key, created_at: new Date(createdMs).toISOString() }
    let g = byKey.get(res.key)
    if (!g) {
      g = { opportunity_key: res.key, symbol: r.symbol, side: proposal.side, account_id: r.account_id, first_at: r.created_at, last_at: r.created_at, refusals: 0, reason, proposal_json: p ? JSON.stringify(p) : null }
      byKey.set(res.key, g)
    }
    g.refusals += 1
    if (r.created_at < g.first_at) g.first_at = r.created_at
    if (r.created_at > g.last_at) { g.last_at = r.created_at; g.reason = reason }
    if (!g.proposal_json && p) g.proposal_json = JSON.stringify(p)
  }
  if (!byKey.size) return []
  const scored = new Set(db.prepare(`SELECT opportunity_key FROM refusal_scores`).all().map(x => x.opportunity_key))
  return [...byKey.values()].filter(g => !scored.has(g.opportunity_key))
}

/**
 * The pre-boundary margin pool's per-cycle rows (symbol 'PORTFOLIO', no
 * levels) were never a refused setup: they clogged the ledger as
 * `unscorable` — ~12k keys, 24 per cycle, measured 19-09-2026. Excluded from
 * both reads so nothing is written for them.
 */
const LEGACY_PORTFOLIO_SYMBOL = 'PORTFOLIO'

/** Opportunities refused and not yet scored, both sources. */
function waitingCount(db) {
  const n = db.prepare(`
    SELECT COUNT(DISTINCT opportunity_key) AS n FROM risk_events
     WHERE approved = 0 AND opportunity_key IS NOT NULL AND COALESCE(symbol, '') <> ?
       AND opportunity_key NOT IN (SELECT opportunity_key FROM refusal_scores)
  `).get(LEGACY_PORTFOLIO_SYMBOL).n
  return n + evidenceShadowRefusals(db).length
}

export function pendingRefusals(db, { nowMs = Date.now(), limit = 50 } = {}) {
  const rows = db.prepare(`
    SELECT opportunity_key, symbol, side, account_id,
           MIN(created_at) AS first_at, MAX(COALESCE(last_at, created_at)) AS last_at,
           SUM(COALESCE(repeat_count, 1)) AS refusals,
           MAX(veto_reason) AS reason, MAX(proposal_json) AS proposal_json
      FROM risk_events
     WHERE approved = 0 AND opportunity_key IS NOT NULL AND COALESCE(symbol, '') <> ?
       AND opportunity_key NOT IN (SELECT opportunity_key FROM refusal_scores)
     GROUP BY opportunity_key
     ORDER BY first_at ASC LIMIT ?
  `).all(LEGACY_PORTFOLIO_SYMBOL, limit * 4)
    .concat(evidenceShadowRefusals(db))
    .sort((a, b) => String(a.first_at).replace('T', ' ').localeCompare(String(b.first_at).replace('T', ' ')))
  const out = []
  for (const r of rows) {
    let p = null
    try { p = JSON.parse(r.proposal_json || 'null') } catch { p = null }
    const entry = num(p?.entry), sl = num(p?.sl), tp = num(p?.tp1)
    const firstMs = Date.parse(String(r.first_at).replace(' ', 'T') + (String(r.first_at).endsWith('Z') ? '' : 'Z'))
    const tf = p?.timeframe || null
    const horizon = horizonMinFor(tf)
    const item = {
      opportunityKey: r.opportunity_key, symbol: r.symbol, side: r.side, accountId: r.account_id,
      strategy: p?.strategy || null, timeframe: tf, reason: r.reason, reasonKey: reasonKey(r.reason),
      entry, sl, tp, firstAt: r.first_at, firstMs, lastAt: r.last_at, refusals: r.refusals, horizonMin: horizon,
    }
    if (entry == null || sl == null || tp == null || !(Math.abs(entry - sl) > 0)) { item.unscorable = 'no entry, stop or target on the proposal'; out.push(item); continue }
    if (!Number.isFinite(firstMs)) { item.unscorable = 'unreadable refusal time'; out.push(item); continue }
    if (firstMs + horizon * 60_000 > nowMs) continue // horizon not elapsed — wait
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

function insertScore(db, it, { nowMs, outcome, rReached = null, exitAt = null, barsUsed = null, note = null }) {
  db.prepare(`
    INSERT OR REPLACE INTO refusal_scores (opportunity_key, account_id, symbol, side, strategy, timeframe, reason_key, reason,
      entry, sl, tp, first_at, last_at, refusals, horizon_min, scored_at, outcome, r_reached, exit_at, bars_used, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(it.opportunityKey, it.accountId, it.symbol, it.side, it.strategy, it.timeframe, it.reasonKey, it.reason,
    it.entry, it.sl, it.tp, it.firstAt, it.lastAt, it.refusals, it.horizonMin, new Date(nowMs).toISOString(),
    outcome, rReached, exitAt, barsUsed, note)
}

/**
 * Score up to `maxPerCycle` elapsed refusals against broker bars.
 * `fetchBars(symbol, tf, count, endTimeMs) → [[t,o,h,l,c,v], …]` is the
 * loss postmortem's fetcher. A fetch that throws records `fetch_failed`
 * with the message rather than retrying forever; the route reports those
 * apart from the scored population.
 */
export async function scoreRefusedOpportunities(db, fetchBars, { nowMs = Date.now(), maxPerCycle = 6, log = null } = {}) {
  const pending = pendingRefusals(db, { nowMs, limit: maxPerCycle })
  let scored = 0, unscorable = 0, failed = 0
  for (const it of pending) {
    if (it.unscorable) { insertScore(db, it, { nowMs, outcome: 'unscorable', note: it.unscorable }); unscorable++; continue }
    const tf = it.timeframe || DEFAULT_TF
    const tfMin = tfMinutes(tf) ?? 60
    const endMs = it.firstMs + it.horizonMin * 60_000
    const count = Math.min(400, Math.max(60, Math.ceil(it.horizonMin / tfMin) + 5))
    let bars = []
    try {
      bars = await fetchBars(it.symbol, tf, count, endMs)
    } catch (err) {
      insertScore(db, it, { nowMs, outcome: 'fetch_failed', note: String(err?.message || err).slice(0, 200) }); failed++; continue
    }
    const window = (Array.isArray(bars) ? bars : []).filter(b => Number(b?.[0]) >= it.firstMs)
    const r = replayExit(window, { side: it.side, entry: it.entry, sl: it.sl, tp: it.tp, openedAtMs: it.firstMs }, { timeCapMin: it.horizonMin })
    if (r.ok) {
      insertScore(db, it, { nowMs, outcome: r.reason, rReached: r.rMultiple, exitAt: r.exitAtMs ? new Date(r.exitAtMs).toISOString() : null, barsUsed: r.barsUsed ?? null })
    } else if (r.ambiguous) {
      insertScore(db, it, { nowMs, outcome: 'ambiguous', barsUsed: r.barsUsed ?? null, note: r.reason })
    } else {
      insertScore(db, it, { nowMs, outcome: window.length ? 'truncated' : 'no_bars', barsUsed: window.length, note: r.reason })
    }
    scored++
  }
  const waiting = waitingCount(db)
  if (log && (scored || unscorable || failed)) log(`Refusal ledger: ${scored} scored, ${unscorable} unscorable, ${failed} fetch failed — ${waiting} opportunity(ies) still waiting`)
  return { scored, unscorable, failed, waiting }
}

/**
 * Forgone R per reason over a window, from the scored population. `sumR`
 * over target/stop/time_cap outcomes is the cost of refusing: positive means
 * the refused setups would have paid, negative means the gate avoided
 * losses. Ambiguous and unscorable rows are counted beside it, never in it.
 */
export function refusalCostReport(db, { days = 7, now = Date.now() } = {}) {
  const since = new Date(now - days * 86_400_000).toISOString()
  const rows = db.prepare(`SELECT * FROM refusal_scores WHERE datetime(scored_at) >= datetime(?) ORDER BY scored_at DESC`).all(since)
  const byReason = {}
  const tally = (b, r) => {
    b.n++
    b.outcomes[r.outcome] = (b.outcomes[r.outcome] || 0) + 1
    if (['target', 'stop', 'stop_moved', 'time_cap'].includes(r.outcome) && num(r.r_reached) != null) {
      b.scored++; b.sumR = Math.round((b.sumR + r.r_reached) * 1000) / 1000
      if (r.r_reached > 0) b.wouldHavePaid++
    }
  }
  const total = { n: 0, scored: 0, sumR: 0, wouldHavePaid: 0, outcomes: {} }
  for (const r of rows) {
    const b = byReason[r.reason_key] || (byReason[r.reason_key] = { reason: r.reason_key, n: 0, scored: 0, sumR: 0, wouldHavePaid: 0, outcomes: {}, example: r.reason })
    tally(b, r); tally(total, r)
  }
  const reasons = Object.values(byReason).map(b => ({ ...b, meanR: b.scored ? Math.round((b.sumR / b.scored) * 1000) / 1000 : null }))
    .sort((a, b) => b.n - a.n)
  const waiting = waitingCount(db)
  return {
    days, since, total: { ...total, meanR: total.scored ? Math.round((total.sumR / total.scored) * 1000) / 1000 : null },
    reasons, waiting, recent: rows.slice(0, 50),
    note: 'sumR is the R the refused setups would have reached at their own stop/target within their horizon: positive = refused winners (cost), negative = avoided losers. Ambiguous, truncated, unscorable and fetch_failed rows are counted in n but not in sumR.',
  }
}
