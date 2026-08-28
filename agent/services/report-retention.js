// ---------------------------------------------------------------------------
// agent/services/report-retention.js — cap the backtest-results folder.
//
// Found 2026-08-29 (owner: "bot-trade-vol is at 75% capacity. Can you purge"):
// the volume held 7.25GB of which the database explained only 2.3GB. The
// missing ~4.7GB was /data/backtest-results — 2,551 HTML reports at ~1.8MB
// each, autopilot writing ~40 a day, and NOTHING pruning the folder, ever.
// The reports moved onto the persistent volume on purpose (serial stability
// across deploys) and inherited the volume's permanence by accident.
//
// The cap is BY COUNT, newest kept, because the folder's growth is what
// matters and count is what the serial logic already reads. Manual backtest
// reports (no `autopilot-` prefix) are rarer and more deliberate, so they get
// their own (higher-value, lower-churn) allowance instead of being crowded
// out by the autopilot firehose.
//
// Config lives in retention_json alongside the DB horizons:
//   { reportsKeepAutopilot: 100, reportsKeepManual: 50 }
// null / non-finite / negative disables that class's sweep (same convention
// as every horizon in retention.js). Deletion is best-effort per file — one
// EBUSY must not abort the sweep.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { reportsDir } from '../lib/backtest-report.js'

export const REPORT_RETENTION_DEFAULTS = Object.freeze({
  reportsKeepAutopilot: 100,
  reportsKeepManual: 50,
})

/**
 * Prune the reports folder. Pure filesystem; no db.
 * @returns {{scanned:number, deleted:number, freedBytes:number, kept:number, errors:number}}
 */
export function pruneReports(cfg = {}, dir = reportsDir()) {
  const keepA = normKeep(cfg.reportsKeepAutopilot, REPORT_RETENTION_DEFAULTS.reportsKeepAutopilot)
  const keepM = normKeep(cfg.reportsKeepManual, REPORT_RETENTION_DEFAULTS.reportsKeepManual)
  const out = { scanned: 0, deleted: 0, freedBytes: 0, kept: 0, errors: 0 }
  let names = []
  try {
    names = fs.readdirSync(dir).filter(n => /^[\w.-]+\.html$/.test(n))
  } catch { return out } // no folder yet — nothing to prune
  out.scanned = names.length

  // Same ordering the listing route uses: name-sorted descending IS
  // newest-first, because every filename embeds its date + serial.
  const sorted = [...names].sort().reverse()
  const autopilot = sorted.filter(n => n.startsWith('autopilot-'))
  const manual = sorted.filter(n => !n.startsWith('autopilot-'))

  const doomed = [
    ...(keepA == null ? [] : autopilot.slice(keepA)),
    ...(keepM == null ? [] : manual.slice(keepM)),
  ]
  for (const n of doomed) {
    const p = path.join(dir, n)
    try {
      const bytes = fs.statSync(p).size
      fs.unlinkSync(p)
      out.deleted++
      out.freedBytes += bytes
    } catch { out.errors++ }
  }
  out.kept = out.scanned - out.deleted
  return out
}

function normKeep(v, dflt) {
  if (v === null) return null // explicit null disables, like the DB horizons
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return v === undefined ? dflt : null
  return Math.floor(n)
}
