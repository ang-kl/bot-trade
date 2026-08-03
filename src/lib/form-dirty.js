// form-dirty — which parts of a multi-form page a background reload is
// allowed to overwrite.
//
// Owner, 04-08-2026: "i try to change but it reset. where is the save button
// for Position Protection".
//
// The Risk page holds several independent forms, each with its own Save that
// posts to its own route. After ANY save it re-reads /state/risk-full and
// pushes the whole response back into every form's local state. The same
// re-read also runs on an account switch and whenever the scope dropdown
// moves. So:
//
//   · edit the loss cap, then press Save on the guardian card → the loss-cap
//     edit is silently thrown away,
//   · flip Protection OFF, wait for any reload → it flips back ON,
//
// which is exactly "I change it and it resets", and is also why the OFF
// switch looks broken when the switch itself works fine.
//
// The rule this module encodes: a reload may refresh a form the operator has
// NOT touched, and must leave a touched one alone — UNLESS the scope changed,
// because then the numbers on screen belong to a different account and
// keeping the edits would apply them to the wrong one.

/** Mark one section edited. Returns a NEW object (safe for setState). */
export function markDirty(dirty, section) {
  if (!section || dirty?.[section]) return dirty || {}
  return { ...(dirty || {}), [section]: true }
}

/** Forget one section's edits — call after that section saves. */
export function clearDirty(dirty, section) {
  if (!dirty?.[section]) return dirty || {}
  const next = { ...dirty }
  delete next[section]
  return next
}

/** Are there unsaved edits anywhere (or in a named subset)? */
export function anyDirty(dirty, sections = null) {
  if (!dirty) return false
  const keys = sections || Object.keys(dirty)
  return keys.some(k => !!dirty[k])
}

/**
 * Which sections this reload may overwrite.
 *
 * @param {string[]} all        every section on the page
 * @param {object} dirty        { section: true } for edited-but-unsaved
 * @param {{scopeChanged?: boolean}} opts
 *   scopeChanged — the account being edited changed, so the incoming values
 *   describe a different account and MUST replace everything. Preserving
 *   edits across a scope change would write account A's numbers to account B.
 */
export function sectionsToApply(all, dirty, { scopeChanged = false } = {}) {
  const list = Array.isArray(all) ? all : []
  if (scopeChanged) return [...list]
  return list.filter(s => !dirty?.[s])
}
