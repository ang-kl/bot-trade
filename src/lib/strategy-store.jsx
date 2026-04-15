// Minimal Context store. Phase 4+ expands shape (watchlist, risk caps,
// per-symbol sub-agent toggles, news config). This stub just locks the
// provider/hook surface so pages can import without breaking imports.
import { createContext, useContext, useReducer } from 'react'

const initialState = {
  watchlist: [],
  risk: { perTradePct: 1, dailyMaxLossPct: 3, armed: false },
}

function reducer(state, action) {
  switch (action.type) {
    default:
      return state
  }
}

const StrategyContext = createContext({ state: initialState, dispatch: () => {} })

export function StrategyProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  return (
    <StrategyContext.Provider value={{ state, dispatch }}>
      {children}
    </StrategyContext.Provider>
  )
}

export function useStrategy() {
  return useContext(StrategyContext)
}
