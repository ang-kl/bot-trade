// Build the instrument classification tree from the three cTrader lists:
//   asset classes (Forex, Metals, …) → symbol categories → light symbols.
// Pure function so the shape is testable without a broker connection.

/**
 * @param {Array<{id, name}>} assetClasses
 * @param {Array<{id, assetClassId, name}>} categories
 * @param {Array<{symbolId, symbolName, symbolCategoryId, enabled?, description?}>} symbols
 * @returns {{classes: Array<{name, count, categories: Array<{name, count, symbols: string[]}>}>, total: number}}
 */
export function buildInstrumentTree(assetClasses, categories, symbols) {
  const catById = new Map()
  for (const c of categories || []) {
    catById.set(String(c.id), { name: c.name || `category ${c.id}`, assetClassId: String(c.assetClassId), symbols: [] })
  }
  const uncategorised = { name: 'Uncategorised', assetClassId: null, symbols: [] }

  let total = 0
  for (const s of symbols || []) {
    if (s.enabled === false) continue
    const name = s.symbolName
    if (!name) continue
    total += 1
    const cat = catById.get(String(s.symbolCategoryId)) || uncategorised
    cat.symbols.push(name)
  }

  const classes = []
  for (const ac of assetClasses || []) {
    const cats = [...catById.values()]
      .filter(c => c.assetClassId === String(ac.id) && c.symbols.length > 0)
      .map(c => ({ name: c.name, count: c.symbols.length, symbols: c.symbols.sort() }))
      .sort((a, b) => a.name.localeCompare(b.name))
    if (cats.length === 0) continue
    classes.push({
      name: ac.name || `class ${ac.id}`,
      count: cats.reduce((n, c) => n + c.count, 0),
      categories: cats,
    })
  }
  if (uncategorised.symbols.length) {
    classes.push({
      name: 'Other',
      count: uncategorised.symbols.length,
      categories: [{ name: 'Uncategorised', count: uncategorised.symbols.length, symbols: uncategorised.symbols.sort() }],
    })
  }
  classes.sort((a, b) => b.count - a.count)
  return { classes, total }
}
