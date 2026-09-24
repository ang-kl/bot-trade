import { it, expect, vi, afterEach } from 'vitest'
import { sleepingStream } from './sleeping-stream.js'
afterEach(() => vi.useRealTimers())
it('closes an existing connection on idle and opens one on wake, without duplicating it', () => {
  vi.useFakeTimers()
  let asleep = false
  const close = vi.fn(), open = vi.fn(() => ({ close }))
  const s = sleepingStream(open, () => asleep)
  expect(open).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(3000); expect(open).toHaveBeenCalledTimes(1)
  asleep = true; vi.advanceTimersByTime(1000); expect(close).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(5000); expect(open).toHaveBeenCalledTimes(1)
  asleep = false; vi.advanceTimersByTime(1000); expect(open).toHaveBeenCalledTimes(2)
  s.close(); vi.advanceTimersByTime(5000)
  expect(close).toHaveBeenCalledTimes(2); expect(open).toHaveBeenCalledTimes(2)
})
it('does not connect an initially sleeping tab', () => {
  vi.useFakeTimers()
  const open = vi.fn()
  const s = sleepingStream(open, () => true)
  vi.advanceTimersByTime(60000); expect(open).not.toHaveBeenCalled(); s.close()
})

it('reconnects a dropped stream with backoff, ignores an old end, and never reconnects asleep', () => {
  vi.useFakeTimers()
  let asleep = false
  const callbacks = [], close = vi.fn()
  const open = vi.fn(end => { callbacks.push(end); return { close } })
  const s = sleepingStream(open, () => asleep)
  callbacks[0](); vi.advanceTimersByTime(4000); expect(open).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(1000); expect(open).toHaveBeenCalledTimes(2)
  callbacks[0](); vi.advanceTimersByTime(60000); expect(open).toHaveBeenCalledTimes(2)
  callbacks[1](); vi.advanceTimersByTime(9000); expect(open).toHaveBeenCalledTimes(2)
  asleep = true; vi.advanceTimersByTime(60000); expect(open).toHaveBeenCalledTimes(2)
  asleep = false; vi.advanceTimersByTime(1000); expect(open).toHaveBeenCalledTimes(3)
  s.close(); callbacks[2](); vi.advanceTimersByTime(60000); expect(open).toHaveBeenCalledTimes(3)
})
