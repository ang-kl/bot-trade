// risk-view — how much of the Risk page is on screen at once.
//
// Owner, 04-08-2026: "i find the RISK page becomes complicated."
//
// The page carries 35 numeric fields, 9 cards and a dozen switches. Nearly all
// of them are correct and nearly all of them are set once and never touched
// again — but they compete for attention with the four or five that actually
// get changed, which is what makes it feel like a control room instead of a
// settings page.
//
// TWO RULES, and the second is the one that matters:
//
//  1. ESSENTIALS is the default: the knobs that get changed, plus everything
//     that can stop a loss. Advanced groups collapse; reference cards hide.
//     EVERYTHING is byte-for-byte the page as it was — no control is removed
//     by this module, only deferred.
//
//  2. NOTHING NON-DEFAULT MAY HIDE. A collapsed group that quietly contains a
//     changed setting is the same failure as the reset bug: state the operator
//     cannot see and did not intend. A group holding a changed value says so
//     on its header, and a group holding an UNSAVED edit is forced open — you
//     can never be one collapsed panel away from losing work.

export const ESSENTIALS = 'essentials'
export const EVERYTHING = 'everything'
const KEY = 'risk_view_mode'

/** Read the saved mode. Anything unrecognised (or no storage) = essentials. */
export function loadRiskMode(storage) {
  try {
    const v = (storage ?? globalThis.localStorage)?.getItem(KEY)
    return v === EVERYTHING ? EVERYTHING : ESSENTIALS
  } catch { return ESSENTIALS }
}

export function saveRiskMode(mode, storage) {
  try {
    ;(storage ?? globalThis.localStorage)?.setItem(KEY, mode === EVERYTHING ? EVERYTHING : ESSENTIALS)
  } catch { /* private mode — the choice just won't persist */ }
}

/**
 * Is an Advanced group open right now?
 *
 * `dirty` wins over everything: an unsaved edit must never be hidden behind a
 * collapsed header. `everything` mode opens all of them. Otherwise it is
 * whatever the operator last did with this particular group.
 */
export function groupOpen({ mode, userOpen = false, dirty = false } = {}) {
  if (dirty) return true
  if (mode === EVERYTHING) return true
  return !!userOpen
}

/**
 * The header line for a collapsed group: how much is in there, and whether any
 * of it differs from the shipped default. "3 settings" is skippable;
 * "3 settings · 1 changed" is not, which is the entire point.
 */
export function groupSummary({ total = 0, changed = 0, dirty = false } = {}) {
  const parts = [`${total} setting${total === 1 ? '' : 's'}`]
  if (changed > 0) parts.push(`${changed} changed from default`)
  if (dirty) parts.push('unsaved')
  return parts.join(' · ')
}

/**
 * Which whole cards are reference or expert material, hidden in essentials.
 *
 * The emergency Close-All card is deliberately NOT here. A page that hides the
 * panic button to look tidier has optimised the wrong thing.
 */
export const DEFERRED_CARDS = ['sec-sizing', 'sec-cpp', 'sec-example-live', 'sec-example-cpp', 'sec-scope']

export function cardVisible(id, mode) {
  if (mode === EVERYTHING) return true
  return !DEFERRED_CARDS.includes(id)
}
