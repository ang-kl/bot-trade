import { getState, setState } from '../db.js'

const KEY = 'scan_priority_symbols_json'
const batches = new WeakMap()
const defaultScheduler = {
  schedule: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer },
  cancel: timer => clearTimeout(timer),
}

function batchFor(db) {
  let batch = batches.get(db)
  if (!batch) {
    batch = { pending: new Map(), timer: null, scheduler: defaultScheduler }
    batches.set(db, batch)
  }
  return batch
}

/** Deterministic scheduler injection; never changes the production delay. */
export function configurePriorityScheduler(db, scheduler) {
  const batch = batchFor(db)
  if (batch.timer !== null || batch.pending.size) throw Error('priority scheduler already active')
  batch.scheduler = scheduler
}

/** Only flat-watchlist rotation hints use this queue. Protection never does. */
export function queueScanPriority(db, symbol, at = Date.now()) {
  if (!db.open || typeof symbol !== 'string' || !symbol || !Number.isFinite(at)) return
  const batch = batchFor(db)
  const name = symbol.toUpperCase()
  batch.pending.set(name, Math.max(at, batch.pending.get(name) ?? -Infinity))
  if (batch.timer === null) batch.timer = batch.scheduler.schedule(() => {
    batch.timer = null
    flushScanPriority(db)
  }, 250)
}

/** Flush before consumption/shutdown. A failed write retains the pending map. */
export function flushScanPriority(db) {
  const batch = batches.get(db)
  if (!batch) return true
  if (batch.timer !== null) batch.scheduler.cancel(batch.timer)
  batch.timer = null
  if (!batch.pending.size) return true
  if (!db.open) { batch.pending.clear(); return false }
  try {
    let stored
    try { stored = JSON.parse(getState(db, KEY) || '{}') } catch { stored = {} }
    const merged = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
    for (const [symbol, at] of batch.pending) {
      merged[symbol] = Math.max(at, Number.isFinite(merged[symbol]) ? merged[symbol] : -Infinity)
    }
    setState(db, KEY, JSON.stringify(merged))
    batch.pending.clear()
    return true
  } catch { return false }
}
