// useAccountSwitch — the React half of selected-account.js.
//
// A page passes its own loader; on an account switch the loader fires
// immediately instead of waiting out that page's poll interval (20-60s, plus
// up to 10s of server cache). While the reload is in flight the hook returns
// the label of the account being switched TO, so the page can say whose data
// is arriving rather than showing the previous account's figures under the new
// account's name.
//
// Usage:
//   const switchingTo = useAccountSwitch(load)
//   ...
//   {switchingTo && <Note>Loading {switchingTo}…</Note>}
import { useEffect, useState } from 'react'
import { onAccountSwitch } from './selected-account.js'

/**
 * @param {() => (void | Promise<void>)} reload — the page's own loader.
 * @returns {string|null} label of the account being switched to, while loading.
 */
export function useAccountSwitch(reload) {
  const [switchingTo, setSwitchingTo] = useState(null)

  useEffect(() => {
    let alive = true
    const off = onAccountSwitch(({ label }) => {
      if (!alive) return
      setSwitchingTo(label)
      // Promise.resolve() so a synchronous loader works too — several pages
      // have one, and calling .finally on undefined would throw inside the
      // notifier and (before selected-account.js caught it) have stopped every
      // later subscriber from being told.
      Promise.resolve(reload())
        .catch(() => { /* the page's own error path already reports this */ })
        .finally(() => { if (alive) setSwitchingTo(null) })
    })
    // Unsubscribe AND stop the in-flight reload from setting state on an
    // unmounted page — a switch made just before navigating away would
    // otherwise resolve into a dead component.
    return () => { alive = false; off() }
  }, [reload])

  return switchingTo
}
