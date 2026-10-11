// agent/services/research-slot.js — ONE research job at a time, across the
// research doors (the tick research replay and the bar-form job). Claude ·
// № 13,095 11-Oct (ordered № 13,093; claude-builder), plan step 8. In-process
// state, like tick-research-run.js's own single-job slot; a holder names
// what it is doing so a 409 can say so. Research only.
let slot = null

export function researchSlot() { return slot ? { ...slot } : null }

/** Take the slot; `{ ok:false, held }` when another holder has it. */
export function acquireResearchSlot(what, id, now = new Date()) {
  if (slot) return { ok: false, held: { ...slot } }
  slot = { what: String(what), id: String(id), startedAt: now.toISOString() }
  return { ok: true, slot: { ...slot } }
}

/** Release only the holder that took it; a stale release is a no-op. */
export function releaseResearchSlot(id) {
  if (slot && slot.id === String(id)) { slot = null; return true }
  return false
}
