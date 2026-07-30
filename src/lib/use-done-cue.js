// useDoneCue — a confirmation message that clears itself.
//
// Paired with components/common/DoneCue.jsx. The timer lives here so every
// caller gets the same dwell time and the same cleanup, and so no caller is
// tempted to drive it from an effect (an effect keyed on the message would
// restart the clock on unrelated renders, and React's set-state-in-effect rule
// rightly objects).
import { useCallback, useEffect, useRef, useState } from 'react'

// Long enough to read after your eyes travel back to the button; short enough
// that a stale "done" never sits next to a later failure.
const DWELL_MS = 6000

/**
 * @returns {[string, (msg: string) => void]} the current message, and a setter
 *   that shows it and clears it after the dwell. Call with '' to clear now.
 */
export function useDoneCue(dwellMs = DWELL_MS) {
  const [message, setMessage] = useState('')
  const timer = useRef(null)

  const show = useCallback((msg) => {
    if (timer.current) clearTimeout(timer.current)
    setMessage(msg || '')
    if (msg) timer.current = setTimeout(() => setMessage(''), dwellMs)
  }, [dwellMs])

  // A component unmounted mid-dwell must not have its timer fire into nothing.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return [message, show]
}
