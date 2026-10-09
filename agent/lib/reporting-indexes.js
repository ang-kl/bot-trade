// Codex · №12,434 · 2026-10-09; codex-footprint: reporting-query.
// Additive indexes only: retained observations and report populations are unchanged.
// Called at DB upgrade and after the collector creates its optional tables.
export function ensureScannerReportingIndexes(db) {
  for (const [table, name, columns] of [
    ['scanner_mirror_candidates', 'scanner_mirror_candidate_report', 'source,account_id,host,strategy'],
    ['scanner_mirror_outcomes', 'scanner_mirror_outcome_report', 'source,outcome,reason'],
  ]) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns})`)
    }
  }
}
