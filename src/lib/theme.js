// Theme primitives — pure helpers + context + hook.
//
// Side-effect-free functions take their deps (storage / root / prefersDark)
// as arguments so they can be unit-tested under the node env without a DOM.
// The React ThemeProvider component lives in ./theme.jsx and wires the
// real browser globals into these helpers.

import { createContext, useContext } from 'react'

export const STORAGE_KEY = 'bot-trade:theme'

// 'system' follows the OS preference and resolves to 'light' or 'dark'
// at runtime. It is never written to data-theme on the html element.
export const THEMES = ['light', 'dark', 'sepia', 'system']

export const ThemeContext = createContext({
  theme: 'system',
  resolvedTheme: 'light',
  setTheme: () => {},
})

export function useTheme() {
  return useContext(ThemeContext)
}

export function isTheme(value) {
  return typeof value === 'string' && THEMES.includes(value)
}

export function readStoredTheme(storage, fallback = 'system') {
  try {
    const v = storage?.getItem(STORAGE_KEY)
    return isTheme(v) ? v : fallback
  } catch {
    return fallback
  }
}

export function writeStoredTheme(storage, value) {
  if (!isTheme(value)) return false
  try {
    storage?.setItem(STORAGE_KEY, value)
    return true
  } catch {
    return false
  }
}

export function resolveTheme(theme, prefersDark) {
  if (theme === 'system') return prefersDark ? 'dark' : 'light'
  if (theme === 'sepia') return 'sepia'
  return theme === 'dark' ? 'dark' : 'light'
}

export function applyTheme(root, resolvedTheme) {
  if (!root || typeof root.setAttribute !== 'function') return false
  root.setAttribute('data-theme', resolvedTheme)
  return true
}
