// StrategyProvider — the React-tree wrapper for strategy-store.js.
// Kept as a .jsx file with a single default export so it passes
// react-refresh/only-export-components.

import { useEffect, useMemo, useReducer, useRef } from 'react'
import {
  STORAGE_KEY,
  StrategyContext,
  INITIAL_STATE,
  reducer,
  readStored,
  writeStored,
} from './strategy-store.js'

function lazyInit(initial) {
  if (typeof window === 'undefined') return initial
  return readStored(window.localStorage, initial)
}

export default function StrategyProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE, lazyInit)

  // Track the last JSON we wrote so we can ignore storage events that echo
  // our own write back to us, which would otherwise bounce HYDRATE → write →
  // storage event → HYDRATE in a loop between two open tabs.
  const lastWritten = useRef(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const json = JSON.stringify(state)
    if (json === lastWritten.current) return
    lastWritten.current = json
    writeStored(window.localStorage, state)
  }, [state])

  // Cross-tab sync: when another window updates the store (e.g. Settings
  // completes cTrader OAuth), re-hydrate this tab so Admin sees the tokens
  // without needing a manual reload.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (e) => {
      if (e.key !== STORAGE_KEY) return
      if (!e.newValue || e.newValue === lastWritten.current) return
      lastWritten.current = e.newValue
      const next = readStored(window.localStorage, INITIAL_STATE)
      dispatch({ type: 'HYDRATE', payload: next })
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const value = useMemo(() => ({ state, dispatch }), [state])

  return <StrategyContext.Provider value={value}>{children}</StrategyContext.Provider>
}
