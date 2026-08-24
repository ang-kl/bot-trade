// npx vitest run src/lib/preload-recovery.test.js
//
// The owner hit "Importing a module script failed" on /connect in the exact
// window a deploy was swapping containers (/health uptime: 92s). With no
// handler, that error strands the tab on a dead Suspense boundary; with a
// naive handler, a genuinely broken asset reloads the page forever. The
// design is one automatic reload per window, then stand aside.

import { describe, it, expect, vi } from 'vitest'
import { shouldReload, installPreloadRecovery, WINDOW_MS } from './preload-recovery.js'

describe('shouldReload', () => {
  it('first failure reloads; junk history reloads (the useful arm wins)', () => {
    for (const last of [null, undefined, '', 'NaN', 0, -5]) {
      expect(shouldReload(1_000_000, last)).toBe(true)
    }
  })
  it('a second failure inside the window does NOT reload — no loops on a truly broken asset', () => {
    expect(shouldReload(1_000_000, 1_000_000 - WINDOW_MS + 1)).toBe(false)
    expect(shouldReload(1_000_000, 1_000_000 - WINDOW_MS)).toBe(true)
  })
})

describe('installPreloadRecovery', () => {
  function fakeWindow(lastStored) {
    const store = new Map(lastStored != null ? [['preload_reload_at', String(lastStored)]] : [])
    const listeners = {}
    return {
      addEventListener: (ev, fn) => { listeners[ev] = fn },
      sessionStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
      },
      location: { reload: vi.fn() },
      fire: (event) => listeners['vite:preloadError'](event),
    }
  }

  it('reloads once on the vite:preloadError event and marks the event handled', () => {
    const win = fakeWindow(null)
    installPreloadRecovery(win)
    const event = { preventDefault: vi.fn() }
    win.fire(event)
    expect(win.location.reload).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('a repeat failure right after a reload surfaces instead of looping', () => {
    const win = fakeWindow(Date.now())
    installPreloadRecovery(win)
    const event = { preventDefault: vi.fn() }
    win.fire(event)
    expect(win.location.reload).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('sessionStorage throwing (private mode) still reloads — degrade toward recovery', () => {
    const win = fakeWindow(null)
    win.sessionStorage.getItem = () => { throw new Error('denied') }
    win.sessionStorage.setItem = () => { throw new Error('denied') }
    installPreloadRecovery(win)
    win.fire({ preventDefault: () => {} })
    expect(win.location.reload).toHaveBeenCalledTimes(1)
  })
})
