// Unit tests for the theme helpers in theme.js.
// Pure functions — no DOM required — so these run under the default
// node env alongside every other test.

import { describe, it, expect } from 'vitest'
import {
  STORAGE_KEY, THEMES,
  isTheme, readStoredTheme, writeStoredTheme, resolveTheme, applyTheme,
} from './theme.js'

// Minimal in-memory storage double.
function makeStorage(initial = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v) },
  }
}

// Minimal root double with a spy on setAttribute.
function makeRoot() {
  const attrs = {}
  return {
    attrs,
    setAttribute: (k, v) => { attrs[k] = v },
  }
}

describe('THEMES registry', () => {
  it('exposes exactly light / dark / sepia / system', () => {
    expect(THEMES).toEqual(['light', 'dark', 'sepia', 'system'])
  })

  it('STORAGE_KEY is namespaced to bot-trade', () => {
    expect(STORAGE_KEY).toBe('bot-trade:theme')
  })
})

describe('isTheme', () => {
  it.each(['light', 'dark', 'sepia', 'system'])('accepts %s', (t) => {
    expect(isTheme(t)).toBe(true)
  })

  it.each([null, undefined, '', 'green', 42, {}])('rejects %p', (v) => {
    expect(isTheme(v)).toBe(false)
  })
})

describe('readStoredTheme', () => {
  it('returns the stored value when valid', () => {
    const s = makeStorage({ [STORAGE_KEY]: 'dark' })
    expect(readStoredTheme(s)).toBe('dark')
  })

  it('falls back when no value is present', () => {
    const s = makeStorage()
    expect(readStoredTheme(s)).toBe('system')
    expect(readStoredTheme(s, 'light')).toBe('light')
  })

  it('falls back when the stored value is not a known theme', () => {
    const s = makeStorage({ [STORAGE_KEY]: 'hotpink' })
    expect(readStoredTheme(s)).toBe('system')
  })

  it('falls back when storage itself throws', () => {
    const s = { getItem: () => { throw new Error('quota') } }
    expect(readStoredTheme(s, 'light')).toBe('light')
  })

  it('returns the fallback when storage is null (SSR)', () => {
    expect(readStoredTheme(null, 'dark')).toBe('dark')
  })
})

describe('writeStoredTheme', () => {
  it('persists a valid theme and reports success', () => {
    const s = makeStorage()
    expect(writeStoredTheme(s, 'sepia')).toBe(true)
    expect(s.data[STORAGE_KEY]).toBe('sepia')
  })

  it('refuses to persist an unknown value', () => {
    const s = makeStorage()
    expect(writeStoredTheme(s, 'neon')).toBe(false)
    expect(s.data[STORAGE_KEY]).toBeUndefined()
  })

  it('reports failure when storage throws', () => {
    const s = { setItem: () => { throw new Error('quota') } }
    expect(writeStoredTheme(s, 'dark')).toBe(false)
  })
})

describe('resolveTheme', () => {
  it('passes through explicit themes', () => {
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('sepia', true)).toBe('sepia')
  })

  it('maps system → dark when the OS prefers dark', () => {
    expect(resolveTheme('system', true)).toBe('dark')
  })

  it('maps system → light when the OS does not prefer dark', () => {
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('coerces unknown values to light', () => {
    expect(resolveTheme('carnation', false)).toBe('light')
  })
})

describe('applyTheme', () => {
  it('writes the resolved theme onto the root element', () => {
    const root = makeRoot()
    expect(applyTheme(root, 'dark')).toBe(true)
    expect(root.attrs['data-theme']).toBe('dark')
  })

  it('is a safe no-op when the root is missing or malformed', () => {
    expect(applyTheme(null, 'dark')).toBe(false)
    expect(applyTheme({}, 'dark')).toBe(false)
  })
})
