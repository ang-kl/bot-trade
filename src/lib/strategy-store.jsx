// StrategyProvider — the React-tree wrapper for strategy-store.js.
// Kept as a .jsx file with a single default export so it passes
// react-refresh/only-export-components.

import { useEffect, useMemo, useReducer } from 'react'
import {
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

  useEffect(() => {
    if (typeof window === 'undefined') return
    writeStored(window.localStorage, state)
  }, [state])

  const value = useMemo(() => ({ state, dispatch }), [state])

  return <StrategyContext.Provider value={value}>{children}</StrategyContext.Provider>
}
