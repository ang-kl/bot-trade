// ThemeProvider — wires the pure helpers in ./theme.js into the browser
// (document.documentElement, localStorage, window.matchMedia). Keeping this
// file component-only satisfies the react-refresh/only-export-components
// lint rule; hooks and constants live in theme.js.

import { useEffect, useMemo, useState } from 'react'
import {
  ThemeContext,
  THEMES,
  readStoredTheme,
  writeStoredTheme,
  resolveTheme,
  applyTheme,
} from './theme.js'

function detectPrefersDark() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export default function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() =>
    readStoredTheme(typeof window !== 'undefined' ? window.localStorage : null)
  )
  const [prefersDark, setPrefersDark] = useState(detectPrefersDark)

  // Track OS preference so the 'system' option reacts live to theme
  // changes made outside the app.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (e) => setPrefersDark(e.matches)
    mql.addEventListener('change', listener)
    return () => mql.removeEventListener('change', listener)
  }, [])

  const resolvedTheme = resolveTheme(theme, prefersDark)

  useEffect(() => {
    if (typeof document === 'undefined') return
    applyTheme(document.documentElement, resolvedTheme)
  }, [resolvedTheme])

  const value = useMemo(() => ({
    theme,
    resolvedTheme,
    setTheme: (next) => {
      if (!THEMES.includes(next)) return
      writeStoredTheme(typeof window !== 'undefined' ? window.localStorage : null, next)
      setThemeState(next)
    },
  }), [theme, resolvedTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
