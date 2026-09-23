// Observation only: no credentials, requests or changes to a caller's result.
// Drain a bounded batch after the broker callback has returned to its owner.
const observers = new Set(), queue = []
let scheduled = false, dropped = 0, failed = 0, delivered = 0
const drain = () => {
  scheduled = false
  for (let i = 0; i < 8 && queue.length; i++) {
    const event = queue.shift()
    for (const observer of observers) {
      try { observer(event); delivered++ } catch { failed++ }
    }
  }
  if (queue.length) { scheduled = true; setImmediate(drain) }
}
export function observeBrokerReads(observer) {
  observers.add(observer)
  return () => { observers.delete(observer); if (!observers.size) queue.length = 0 }
}
export function emitBrokerRead(event) {
  if (!observers.size) return false
  if (queue.length >= 64) { dropped++; return false }
  try {
    const json = JSON.stringify(event)
    if (json.length > 64000) { dropped++; return false }
    queue.push(JSON.parse(json))
    if (!scheduled) { scheduled = true; setImmediate(drain) }
    return true
  } catch { dropped++; return false }
}
export const brokerReadObservationStatus = () => ({ active: observers.size > 0, pending: queue.length, capacity: 64, dropped, failed, delivered })
