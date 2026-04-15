// Theme provider (Dark / Light / Sepia / System) — Phase 3 wires this up.
// Stub exists so other modules can import the hook signature today.
import { createContext, useContext } from 'react'

const ThemeContext = createContext({ theme: 'light', setTheme: () => {} })

export function ThemeProvider({ children }) {
  const value = { theme: 'light', setTheme: () => {} }
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}
