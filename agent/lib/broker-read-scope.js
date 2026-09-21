// Broker reads follow the viewing account without changing trading selection.
export function brokerReadAccount(body, selectedId, { allowAll = false } = {}) {
  const explicit = body?.accountId
  const value = explicit ?? (allowAll && !body?.selectedOnly ? 'all' : selectedId)
  if (allowAll && value === 'all') return null
  if (value == null || !/^[1-9]\d*$/.test(String(value))) {
    throw Object.assign(new Error('A valid accountId is required for this broker read'), { httpStatus: 400 })
  }
  return String(value)
}

// Keep an unfinished request shared even when it outlives the result TTL.
// Start the TTL at completion and never cache a rejected read.
export function brokerReadCache({ ttlMs = 12_000, now = Date.now } = {}) {
  const slots = new Map()
  return (key, work) => {
    const previous = slots.get(key)
    if (previous && (previous.pending || now() - previous.at < ttlMs)) return previous.promise
    const slot = { pending: true, at: 0, promise: null }
    slot.promise = Promise.resolve().then(work).then(value => {
      slot.pending = false
      slot.at = now()
      return value
    }, error => { slots.delete(key); throw error })
    slots.set(key, slot)
    for (const [k, v] of slots) if (!v.pending && now() - v.at >= ttlMs) slots.delete(k)
    return slot.promise
  }
}
