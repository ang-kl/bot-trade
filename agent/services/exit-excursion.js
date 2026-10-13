// agent/services/exit-excursion.js — the excursion measured at the price a
// position closes at (the bid for a long, the ask for a short).
//
// Claude · 13-Oct (owner: audit fix "4 MAE/MFE exit side"; Codex round 2 on
// #1356 answered "Separate columns"; claude-builder). mfe_r / mae_r are read
// from the mid and the managed trail sets its stop from mfe_r
// (position-manager.js managedPeakR), so moving them to the exit side would
// loosen live stops by up to half the spread. The exit-side figures are kept
// in their own columns instead — for reports and audits; nothing decides on
// them. Each writer of mfe_r/mae_r (fast monitor, slow monitor, paused-row
// pass) records here beside it. Widen only, like mfe_r/mae_r. A row first
// recorded here after it opened is marked by exit_excursion_from: its figures
// cover from then on, not from entry.
import { currentR } from './position-manager.js'

/**
 * Widen the row's exit-side excursion with the R at `exitPrice`. Returns true
 * when a row was written. Codex P2 on #1356 (owner: "Guard every write"): a
 * quote can be read before a row closes and written after, so the write is a
 * compare-and-set — only while the row is still active, and with
 * `paused: true` (the paused-row pass) only while it is still paused, the same
 * condition as that pass's own mid write. A quote observed after the holding
 * period can never widen a closed row.
 */
export function recordExitExcursion(db, pos, exitPrice, { now = Date.now(), paused = false } = {}) {
  const p = Number(exitPrice)
  if (!(p > 0) || pos?.id == null) return false
  const r = currentR(pos, p)
  if (r == null || !Number.isFinite(r)) return false
  return db.prepare(`UPDATE monitored_positions
    SET mfe_exit_r = MAX(COALESCE(mfe_exit_r, 0), ?), mae_exit_r = MIN(COALESCE(mae_exit_r, 0), ?),
        exit_excursion_from = COALESCE(exit_excursion_from, ?)
    WHERE id = ? AND status = 'active'${paused ? ' AND COALESCE(paused, 0) = 1' : ''}`).run(Math.max(0, r), Math.min(0, r), new Date(now).toISOString(), pos.id).changes === 1
}
