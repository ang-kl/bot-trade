// card-open — remembers whether a Card (OD-17 = D19/D8, the 26-09 UI plan)
// is open or collapsed, per section id, across reloads AND remounts.
//
// Before this file, Card.jsx's collapse state was a plain `useState`, so it
// reset to `defaultCollapsed` on every reload (Card.jsx:57) and, for cards
// remounted by a changing `key` — the "Recorded entry blockers" card is
// remounted on every account switch via `key={`blockers:${acct}`}`
// (Performance.jsx) — on every switch too. The owner's report ("it forgets
// its state") named exactly this.
//
// Storage is INJECTED, the same shape as lib/risk-view.js's
// loadRiskMode/saveRiskMode: a store that throws (private mode, a sandboxed
// iframe, or a test double) degrades to the caller's own default instead of
// crashing the page or the card.
//
// Only a card with a stable id (one of nav-tree.js's `sec-*` anchors)
// persists. A card with no id has no key to store under and keeps its old
// per-mount default — unchanged behaviour, not a regression.

const PREFIX = 'card_open_'

/**
 * Was this card open last time, for this id? Returns `defaultOpen` when
 * there is no id, nothing was ever stored, the stored value is not one of
 * the two this module writes, or the store throws.
 */
export function readCardOpen(id, defaultOpen, storage) {
  if (!id) return defaultOpen
  try {
    const v = (storage ?? globalThis.localStorage)?.getItem(PREFIX + id)
    if (v === '1') return true
    if (v === '0') return false
    return defaultOpen
  } catch { return defaultOpen }
}

/** Record the open/closed choice. A throwing or missing store just means the
 * choice will not survive this page view — never an error the card shows. */
export function writeCardOpen(id, open, storage) {
  if (!id) return
  try {
    ;(storage ?? globalThis.localStorage)?.setItem(PREFIX + id, open ? '1' : '0')
  } catch { /* private mode, or no storage at all */ }
}
