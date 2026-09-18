// ---------------------------------------------------------------------------
// agent/services/reverify-reset.js — return the re-verify attempts that were
// spent against a verifier which could not answer.
//
// WHAT HAPPENED, and the measurement that found it (18-09-2026 04:08 UTC):
//
//   [loop] Position capture [47790949]: backlog: 0 armed of 18 unverified —
//          0 eligible, 18 at the re-verify cap (3), 0 terminal, 0 already queued
//
// Every one of that account's unverified records had exhausted its three
// re-verify attempts. The cap did exactly its job — PR-AP built it so a dead
// verifier could not re-pull every record from the broker for ever — but all
// three attempts were burned BEFORE PR-AR existed, against a cpp-verify that
// held no session and returned 409 to everything. The records are complete and
// correct; they are simply unreachable now, by a rule that was right to exist.
//
// THE UNDERLYING DESIGN GAP, stated plainly: `reverify_attempts` cannot tell
// "the verifier ANSWERED and I still have no verdict" from "the verifier could
// not answer at all". Only the first deserves to consume the cap. Fixing that
// properly means counting attempts only when a verdict was actually returned;
// this migration is the one-off repair for the rows already stranded, and the
// distinction is left for the follow-up.
//
// WHY A MARKER AND NOT AN IDEMPOTENT PREDICATE. The two existing one-shot
// passes in db.js re-run on every boot and simply stop matching once the data
// is fixed. That shape is UNSAFE here: "unverified and capped" starts matching
// again the moment the verifier has another bad run, so a predicate-only
// version would reset the cap on every restart and quietly abolish the guard
// it is meant to respect. It must run exactly once, so it records that it did.
//
// WHAT IT REFUSES TO TOUCH:
//
//   gave_up rows — terminal because the record could not be BUILT. A different
//   failure, and the count of trades this system could not describe is worth
//   keeping.
//
//   verified and disputed records — a verdict is an answer. Re-opening one
//   would eventually overwrite a real disagreement with a later agreement.
// ---------------------------------------------------------------------------

/** Named so the log line and the marker row read the same in six months. */
export const REVERIFY_RESET_ID = 'reverify-attempts-reset-2026-09-18'

/**
 * Give back the attempts, once.
 *
 * @returns {{applied:boolean, changes:number, reason?:string}}
 *   `applied:false` with `reason:'already'` is the normal steady state, not a
 *   failure — it is what "runs exactly once" looks like on the second boot.
 */
export function resetReverifyAttempts (db, { id = REVERIFY_RESET_ID } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations_applied (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      changes    INTEGER
    );
  `)

  if (db.prepare('SELECT 1 FROM migrations_applied WHERE id = ?').get(id)) {
    return { applied: false, changes: 0, reason: 'already' }
  }

  // ATOMIC WITH ITS MARKER. If the update landed and the marker did not, the
  // next boot would reset again — and a repair that can run twice is the same
  // hazard as no cap at all. better-sqlite3's transaction() rolls back both on
  // a throw.
  const run = db.transaction(() => {
    const r = db.prepare(`
      UPDATE position_capture_queue
         SET reverify_attempts = 0
       WHERE state = 'captured'
         AND reverify_attempts > 0
         AND EXISTS (
           SELECT 1 FROM position_history h
            WHERE h.account_id = position_capture_queue.account_id
              AND h.ctrader_position_id = position_capture_queue.position_id
              AND h.verification_state = 'unverified'
         )
    `).run()
    db.prepare('INSERT INTO migrations_applied (id, changes) VALUES (?, ?)').run(id, r.changes)
    return r.changes
  })

  const changes = run()
  return { applied: true, changes }
}
