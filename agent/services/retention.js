// ---------------------------------------------------------------------------
// agent/services/retention.js — long-horizon retention sweep for the two
// tables the 8-hourly housekeeping block deliberately never touched: trades
// and trade_postmortems (hardening batch 6c). Everything else the loop
// prunes is diagnostic exhaust (scans, signals, risk_events, …); trades are
// the P&L LEDGER, so the default here is measured in years, the sweep only
// ever removes CLOSED trades, and the whole thing can be disabled by
// setting a horizon to null.
//
// Config lives in agent_state `retention_json`:
//   { tradesDays: 730, postmortemsDays: 730 }
// A null (or non-positive) horizon disables that table's sweep entirely.
// A pruned trade takes its postmortem with it in the same pass (FK-safe
// child-first delete; reported as orphanPostmortems).
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

export const DEFAULT_RETENTION = {
  tradesDays: 730,       // ~2 years of closed-trade ledger
  postmortemsDays: 730,  // keep the forensics as long as the trades
  // Owner-approved 01-08 ("approve retention"), sized from production's
  // /state/storage: cup_handle_diagnostics was 2.13M rows / 209MB — 40% of
  // the whole database — with analyses (38MB) and action_log unpruned behind
  // it. Same convention as above: null (or ≤0) disables that sweep.
  cupHandleDays: 30,     // per-scan pattern diagnostics — a month is plenty to debug a detector
  analysesDays: 90,      // LLM analysis blobs; rows a trade references are ALWAYS spared (FK)
  actionLogDays: 365,    // request journal — but AUDIT + PHASE_RAW_WRITE rows are exempt forever
  // V3 R1 (P8b): the tick recorder's hourly samples (heartbeat.js
  // pullTickStatus: one row per side per hour, per_symbol up to 8 KB, so at
  // most ~140 MB a year for both sides). A bound the owner can set through
  // POST /actions/storage-purge { retention: { tickStatusSamplesDays: N } };
  // null until the owner answers the retention question (H-P8-2), so nothing
  // is deleted by default. The segment manifest (tick_segment_manifest,
  // tick_segment_boots) is evidence for the recovery and retention checks and
  // has no horizon: one row per sealed segment, about 3 a day per side.
  tickStatusSamplesDays: null,
}

export function loadRetentionConfig(db) {
  try {
    const saved = JSON.parse(getState(db, 'retention_json') || 'null')
    return { ...DEFAULT_RETENTION, ...(saved || {}) }
  } catch {
    return { ...DEFAULT_RETENTION }
  }
}

/**
 * One sweep. Returns { trades, postmortems, orphanPostmortems, keptReferenced }.
 * - trades: only status='closed' rows whose closed_at is past the horizon —
 *   open/working/rejected rows are NEVER touched regardless of age (an old
 *   open row is a reconciliation problem, not garbage).
 * - postmortems: past their own horizon (orphanPostmortems counts the ones
 *   removed with their pruned parent trade — FK-safe, child before parent).
 * - keptReferenced: due trades spared because a monitored_positions row still
 *   references them. See the long note at the exclusion — without it, ONE such
 *   trade made the bulk DELETE raise a foreign-key error and prune nothing.
 * closed_at is REPLACE-normalized the same way as every other cross-format
 * timestamp comparison in this codebase (space- vs T-separated).
 */
export function pruneTradeHistory(db, cfg = null) {
  const c = cfg || loadRetentionConfig(db)
  const out = { trades: 0, postmortems: 0, orphanPostmortems: 0, keptReferenced: 0 }

  const horizon = (days) => {
    const d = Number(days)
    if (!Number.isFinite(d) || d <= 0) return null
    return new Date(Date.now() - d * 86_400_000).toISOString().replace('T', ' ')
  }

  const tCut = horizon(c.tradesDays)
  if (tCut) {
    // A TRADE STILL REFERENCED BY monitored_positions CANNOT BE DELETED, AND
    // TRYING TAKES THE WHOLE SWEEP DOWN WITH IT.
    //
    // db.js:556 sets `PRAGMA foreign_keys = ON`, and
    // monitored_positions.trade_id is `REFERENCES trades(id)` with no ON DELETE
    // clause — so the default NO ACTION applies. This sweep deleted in ONE bulk
    // statement, so a single referenced row made that statement raise
    // "FOREIGN KEY constraint failed" and roll back, taking every
    // unreferenced due trade with it. Measured, not inferred: two due trades,
    // one referenced, and the DELETE removes NEITHER.
    //
    // So the failure mode is not an orphaned row — the FK prevents that. It is
    // that retention silently stops working. monitored_positions rows are kept
    // after they close, so any closed trade that ever had one is a permanent
    // blocker, and on a real database that is most of them. The sweep would
    // throw on every run, for ever, pruning nothing.
    //
    // Excluding referenced trades is the conservative fix: the ledger row is
    // kept for anything the system still holds a position record for, and every
    // other due trade is actually pruned. Deleting or re-pointing the
    // monitored_positions rows instead would be a policy decision about the
    // owner's history, which is not retention's call to make.
    //
    // Status is deliberately NOT part of the exclusion — the FK does not care
    // whether the monitored row is 'active' or 'closed', so neither can this.
    const dueTrades = `SELECT id FROM trades
       WHERE status = 'closed' AND closed_at IS NOT NULL
         AND REPLACE(closed_at, 'T', ' ') < ?
         AND id NOT IN (
           SELECT trade_id FROM monitored_positions WHERE trade_id IS NOT NULL
         )`
    // Reported so a sweep that prunes less than expected explains itself,
    // instead of looking like a horizon that is set wrong.
    out.keptReferenced = db.prepare(
      `SELECT COUNT(*) AS n FROM trades
        WHERE status = 'closed' AND closed_at IS NOT NULL
          AND REPLACE(closed_at, 'T', ' ') < ?
          AND id IN (
            SELECT trade_id FROM monitored_positions WHERE trade_id IS NOT NULL
          )`
    ).get(tCut).n
    // Children first — trade_postmortems.trade_id carries an FK to trades,
    // so a pruned trade's postmortem must go in the same pass (an orphaned
    // replay window would explain a trade that no longer exists anyway). Same
    // predicate as the parent delete, so the two cannot diverge and a kept
    // parent never loses its forensics.
    out.orphanPostmortems = db.prepare(
      `DELETE FROM trade_postmortems WHERE trade_id IN (${dueTrades})`
    ).run(tCut).changes
    out.trades = db.prepare(
      `DELETE FROM trades WHERE id IN (${dueTrades})`
    ).run(tCut).changes
  }

  const pCut = horizon(c.postmortemsDays)
  if (pCut) {
    out.postmortems = db.prepare(
      `DELETE FROM trade_postmortems WHERE REPLACE(created_at, 'T', ' ') < ?`
    ).run(pCut).changes
  }
  return out
}

/**
 * Owner-approved sweep (01-08) for the three operational tables the 8-hourly
 * housekeeping never touched. Returns { cupHandle, analyses, actionLog }.
 *
 * - cup_handle_diagnostics: pure detector exhaust — one row per symbol per
 *   scan, forever. Production had 2.13M rows; nothing reads past a few weeks.
 * - analyses: rows REFERENCED BY A TRADE ARE SPARED, whatever their age —
 *   trades.analysis_id is an enforced FK (PRAGMA foreign_keys=ON), so
 *   deleting a referenced row would abort the whole bulk DELETE exactly like
 *   the referenced-trades case documented above. The ledger keeps its
 *   provenance; only unreferenced analysis blobs age out.
 * - action_log: AUDIT and PHASE_RAW_WRITE rows are EXEMPT FOREVER — that is
 *   the S.A.T./controller audit trail and the raw-write tracer, and evidence
 *   does not expire. Everything else (request exhaust) ages out at a year.
 */
function operationalPruners(db, cfg) {
  const c = cfg || loadRetentionConfig(db)
  const horizon = days => {
    const d = Number(days)
    return Number.isFinite(d) && d > 0
      ? new Date(Date.now() - d * 86_400_000).toISOString().replace('T', ' ') : null
  }
  // tick_status_samples keys on at_ms (epoch ms), not a text timestamp.
  const horizonMs = days => {
    const d = Number(days)
    return days != null && Number.isFinite(d) && d > 0 ? Date.now() - d * 86_400_000 : null
  }
  return [
    { key: 'cupHandle', table: 'cup_handle_diagnostics', cutoff: horizon(c.cupHandleDays),
      where: "REPLACE(created_at, 'T', ' ') < ?" },
    { key: 'analyses', table: 'analyses', cutoff: horizon(c.analysesDays),
      where: "REPLACE(analyzed_at, 'T', ' ') < ? AND id NOT IN (SELECT analysis_id FROM trades WHERE analysis_id IS NOT NULL)" },
    { key: 'actionLog', table: 'action_log', cutoff: horizon(c.actionLogDays),
      where: "REPLACE(at, 'T', ' ') < ? AND (method IS NULL OR method NOT IN ('AUDIT', 'PHASE_RAW_WRITE'))" },
    // Off (null) by default — see DEFAULT_RETENTION.tickStatusSamplesDays.
    { key: 'tickStatusSamples', table: 'tick_status_samples', cutoff: horizonMs(c.tickStatusSamplesDays),
      where: 'at_ms < ?' },
  ].filter(p => p.cutoff !== null)
}

export function pruneOperationalTables(db, cfg = null) {
  const out = { cupHandle: 0, analyses: 0, actionLog: 0 }
  for (const p of operationalPruners(db, cfg)) {
    try { out[p.key] = db.prepare(`DELETE FROM ${p.table} WHERE ${p.where}`).run(p.cutoff).changes }
    catch { /* retain the existing compatibility path for manual callers */ }
  }
  return out
}

// Housekeeping must yield between bounded primary-key windows. Bounding only
// DELETE matches still permits a full-table scan when few rows have expired.
// A fixed high-water mark excludes new rows until the next scheduled pass.
export async function pruneOperationalTablesCooperatively(db, cfg = null, { onProgress } = {}) {
  const out = { cupHandle: 0, analyses: 0, actionLog: 0, errors: [] }
  for (const p of operationalPruners(db, cfg)) {
    try {
      const end = db.prepare(`SELECT MAX(id) id FROM ${p.table}`).get().id
      let cursor = 0
      const page = db.prepare(`SELECT id FROM ${p.table} WHERE id > ? AND id <= ? ORDER BY id LIMIT 200`)
      const remove = db.prepare(`DELETE FROM ${p.table} WHERE id > ? AND id <= ? AND ${p.where}`)
      out[p.key] = out[p.key] ?? 0 // an opt-in table's key appears only when its sweep runs
      while (end != null && cursor < end) {
        const ids = page.all(cursor, end)
        if (!ids.length) break
        const next = ids.at(-1).id
        out[p.key] += remove.run(cursor, next, p.cutoff).changes
        cursor = next
        onProgress?.({ table: p.table, cursor, end })
        await new Promise(resolve => setImmediate(resolve))
      }
    } catch (error) { out.errors.push({ table: p.table, message: error.message }) }
  }
  return out
}
