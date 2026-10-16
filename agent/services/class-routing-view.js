// Claude · № 15,144 16-Oct (owner: "B priorities class … C·2 build class-aware
// routing" after § 15,128; claude-builder).
//
// The read-only view behind GET /state/class-routing: the policy the scan
// reads, the scan universe's classes with their sources, the rotation tiers
// and the latest batch's routed-out rows. A readout of what IS, never a
// writer: it reads the same loader and the same class map the scan uses, so
// what it shows is what the next run will do.
import { getState } from '../db.js'
import { loadClassRouting, classPriority } from '../lib/class-routing.js'
import { classOfSymbol, assetClassStatus } from '../lib/asset-class.js'
import { STRATEGY_KEYS } from './strategies.js'

const DEFAULT_BATCH = 15 // runFibScan's default batchSize; loop.js passes none

/** The shared scan universe exactly as loop.js reads it (autopilot_symbols_json || watchlist_json). */
export function scanUniverse(db) {
  let parsed = []
  try { parsed = JSON.parse(getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json') || '[]') } catch { parsed = [] }
  return (Array.isArray(parsed) ? parsed : [])
    .map(w => (typeof w === 'string' ? { symbol: w, enabled: true } : w))
    .filter(w => w && w.symbol && w.enabled !== false && !w.force_skip)
}

export function classRoutingView(db, { batchSize = DEFAULT_BATCH, maxRoutedRows = 50 } = {}) {
  const policy = loadClassRouting({ knownStrategies: STRATEGY_KEYS })
  const seen = new Set()
  const symbols = []
  for (const w of scanUniverse(db)) {
    const name = String(w.symbol).toUpperCase().trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const c = classOfSymbol(name)
    const priority = classPriority(policy, c.cls)
    const blocked = [
      ...(policy.symbols?.[name]?.block || []).map(t => ({ token: t.token, source: `symbol ${name}` })),
      ...(policy.classes?.[c.cls]?.block || []).map(t => ({ token: t.token, source: `class ${c.cls}` })),
    ]
    const tier = policy.enabled !== false && policy.scanShare ? (priority <= policy.scanShare.priorityMaxRank ? 'A' : 'B') : null
    symbols.push({ symbol: name, cls: c.cls, source: c.source, treeClass: c.treeClass ?? null, priority, tier, blocked })
  }
  const classes = {}
  for (const [name, spec] of Object.entries(policy.classes || {})) {
    classes[name] = { priority: spec.priority, block: spec.block.map(t => t.token), enabledSymbols: symbols.filter(s => s.cls === name).length }
  }
  for (const s of symbols) if (!classes[s.cls]) classes[s.cls] = { priority: classPriority(policy, s.cls), block: [], enabledSymbols: symbols.filter(x => x.cls === s.cls).length }
  const classSources = {}
  for (const s of symbols) classSources[s.source] = (classSources[s.source] || 0) + 1
  let tiers = null
  if (policy.enabled !== false && policy.scanShare) {
    const a = symbols.filter(s => s.tier === 'A').length, b = symbols.length - a
    const aSlots = Math.min(policy.scanShare.prioritySlots, batchSize), bSlots = batchSize - aSlots
    tiers = { batchSize, prioritySlots: aSlots, priorityMaxRank: policy.scanShare.priorityMaxRank, tierA: a, tierB: b,
      runsPerPassA: a && aSlots ? Math.ceil(a / aSlots) : null, runsPerPassB: b && bSlots ? Math.ceil(b / bSlots) : null,
      note: 'held symbols leave the rotation while held; a spike run leaves the tail of its windows to the next pass' }
  }
  let lastScan = { scannedAt: null, routedOut: 0, byToken: {}, rows: [] }
  try {
    const last = db.prepare('SELECT MAX(scanned_at) AS at FROM scans').get()
    if (last?.at) {
      const rows = db.prepare("SELECT symbol, strategy, bias, timeframe, confidence, thesis FROM scans WHERE scanned_at = ? AND trade_grade = 'routed' ORDER BY id").all(last.at)
      const byToken = {}
      for (const r of rows) { const m = /token "([^"]+)"/.exec(r.thesis || ''); const k = m ? m[1] : 'unknown'; byToken[k] = (byToken[k] || 0) + 1 }
      lastScan = { scannedAt: last.at, routedOut: rows.length, byToken, rows: rows.slice(0, maxRoutedRows) }
    }
  } catch { /* no scans table yet → the empty readout */ }
  return {
    enabled: policy.enabled !== false,
    reason: policy.reason ?? null,
    source: policy.source,
    file: policy.file ?? null,
    warnings: policy.warnings || [],
    scanShare: policy.scanShare,
    tiers,
    classes,
    classSources,
    tree: assetClassStatus(),
    symbols,
    lastScan,
    note: 'Read-only. Blocks apply at the scan (scanSymbolFib) to the bot\'s own candidates; manual orders and the momentum book do not read this policy. A class with source "heuristic" or "unknown" was not found in the cached broker catalogue (GET /actions/instrument-tree?refresh=1 rebuilds it).',
  }
}
