// History reports share two bounded server workers. A page and its chart must
// not launch independent bursts into both slots. Cheap current readings and
// every trading operation remain outside this read-only queue.
export function createReportQueue(read, { canRead = () => true, maxPending = 16 } = {}) {
  const pending = new Map()
  let tail = Promise.resolve()
  return (key, ...args) => {
    if (pending.has(key)) return pending.get(key)
    if (pending.size >= maxPending) return Promise.reject(Error('Report refresh already pending'))
    const job = tail.then(() => {
      if (!canRead()) throw Error('Report refresh paused')
      return read(key, ...args)
    })
    const result = job.finally(() => pending.delete(key))
    pending.set(key, result)
    tail = result.catch(() => {})
    return result
  }
}
