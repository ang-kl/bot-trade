// Classification › Group › Symbol — the shared shape for every watchlist tree.
//
// Owner 02-08-2026: "TUNE PAGE > the watchlist sub-page, some of the forex are
// in the single stock, can you have a logic to ensure they are classified
// correctly" and "in CONNECT PAGE > the copy watchlist, the group should be a
// tree structure, you Classification > Group > Symbol".
//
// WHY CLASSIFICATION IS THE TOP LEVEL. `group` is a free-text tag the preset
// picker writes and a manual add does not, so it cannot be the root — an
// untagged EURJPY would have nowhere to sit but a bucket labelled "Singles",
// which is exactly how FX ended up reading as single stocks. Classification is
// DERIVED from the symbol, so every symbol has one and only the middle level is
// ever "Ungrouped".
//
// categoriseSymbol comes from agent/lib/sessions.js — the same function the
// trading path uses to decide market hours — imported rather than mirrored. A
// tree that disagreed with the engine about what an instrument is would be
// worse than no tree.
import { categoriseSymbol } from '../../agent/lib/sessions.js'
import { subGroupOf } from '../../agent/lib/symbol-taxonomy.js'

export const UNGROUPED = '__ungrouped__'

export const CLASS_LABEL = {
  fx: 'Forex', crypto: 'Crypto', index: 'Indices', metal: 'Metals',
  commodity: 'Commodities', soft: 'Softs', grain: 'Grains', stock: 'Stocks',
}

// Display order — the instruments this desk actually trades, most-used first.
export const CLASS_ORDER = ['fx', 'crypto', 'index', 'metal', 'commodity', 'soft', 'grain', 'stock']

export const classLabel = (cls) => CLASS_LABEL[cls] || cls
export const groupLabel = (g) => (g === UNGROUPED ? 'Ungrouped' : g)

/**
 * Group watchlist items into Classification › Group › items.
 *
 * @param {Array<{symbol: string, group?: string}>} items
 * @returns {Array<[string, Map<string, object[]>]>} classification bands in
 *   CLASS_ORDER, each holding its groups. EMPTY CLASSIFICATIONS ARE DROPPED —
 *   eight headings over four symbols is worse than the flat list this replaces.
 */
export function buildClassTree(items) {
  const tree = new Map()
  for (const cls of CLASS_ORDER) tree.set(cls, new Map())
  for (const it of items || []) {
    if (!it?.symbol) continue
    const cls = categoriseSymbol(it.symbol)
    if (!tree.has(cls)) tree.set(cls, new Map())
    const byGroup = tree.get(cls)
    // THE MIDDLE LEVEL NO LONGER HAS AN "UNGROUPED" DRAWER (owner 04-08-2026:
    // "properly classify them into groupings, sub-groups"). A free-text
    // `group` tag — written by the preset picker, absent on a manual add — is
    // still honoured when it exists, because it is the owner's own label for a
    // set they chose. Everything else now falls to a DERIVED sub-group
    // (Japan indices, FX exotics, Crypto 24/7) instead of a bucket whose name
    // was the complaint. The header comment above explains why classification
    // could not be the tag; the same reasoning applies one level down.
    const g = it.group || subGroupOf(it.symbol)
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g).push(it)
  }
  return [...tree.entries()].filter(([, byGroup]) => byGroup.size > 0)
}

/** Every symbol under a classification band, for select-all. */
export const symbolsOfBand = (byGroup) =>
  [...byGroup.values()].flat().map(i => i.symbol)
