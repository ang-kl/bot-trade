// Leaf module shared by the migration and report query. SQLite can prove
// that a literal predicate uses a partial index; bound LIKE patterns cannot
// make that proof. Keep the original LIKE semantics (including ASCII case)
// and the exact same predicates on both sides.
export const PHASE_AUDIT_PREDICATES = Object.freeze({
  switches: "method = 'AUDIT' AND (path LIKE '/phase/%' OR path LIKE '/arm/%')",
  controllerEvents: "method = 'AUDIT' AND (path LIKE '/controller/%')",
})

export function ensurePhaseAuditIndexes(db) {
  // id preserves the report order; account_id lets scoped reads discard
  // foreign-account rows before loading their potentially large JSON bodies.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_action_log_phase_switches
      ON action_log(id, account_id) WHERE ${PHASE_AUDIT_PREDICATES.switches};
    CREATE INDEX IF NOT EXISTS idx_action_log_phase_controllers
      ON action_log(id, account_id) WHERE ${PHASE_AUDIT_PREDICATES.controllerEvents};
  `)
}
