// Pausing polling alone cannot stop a fetch body that is already streaming.
// Network loss retries with a bounded delay; sleeping never reconnects.
export function sleepingStream(open, asleep) {
  let stream = null, closed = false, generation = 0, retryAt = 0, failures = 0
  const sync = () => {
    if (closed) return
    if (asleep()) {
      generation++; stream?.close(); stream = null; retryAt = 0; failures = 0
    } else if (!stream && Date.now() >= retryAt) {
      const mine = ++generation
      const next = open(() => {
        if (closed || mine !== generation) return
        generation++; stream?.close(); stream = null
        retryAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(failures++, 4))
      })
      if (mine === generation) stream = next
      else next?.close()
    }
  }
  sync()
  const timer = setInterval(sync, 1000)
  return { close() { closed = true; generation++; clearInterval(timer); stream?.close(); stream = null } }
}
