// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// Whether a CSS media query matches, as React state that follows resize and
// orientation changes. Built for one job: NOT MOUNTING what CSS hides.
//
// Measured 10-10 at 390x844: the desktop sidebar is `hidden lg:flex` — display
// none on a phone, but still mounted, so its pollers (agent health, LLM
// monitor, session list, account chrome, the account header and the view
// picker's roster beat) kept running on every page, unseen. A component that
// CSS hides costs exactly what a visible one costs; only not mounting it saves
// the requests.
//
// The breakpoint is Tailwind v4's `lg` — `--breakpoint-lg: 64rem`, compiled to
// `@media (width>=64rem)` (verified in the built CSS). `min-width: 64rem` is
// the same boundary: rem in a media query is the browser's initial font size,
// not the html font-size or zoom index.css sets, exactly as in the CSS rule.
import { useCallback, useSyncExternalStore } from 'react'

/** The query CSS uses for the desktop layout (sidebar shown, tab bar hidden). */
export const DESKTOP_QUERY = '(min-width: 64rem)'

/**
 * Does `query` match right now? `fallback` when the environment cannot say
 * (no window, no matchMedia, or it throws) — callers choose the answer that
 * keeps their old behaviour.
 */
export function mediaMatches(query, fallback = false, win = globalThis.window) {
  try {
    const mql = win?.matchMedia?.(query)
    return mql ? Boolean(mql.matches) : fallback
  } catch { return fallback }
}

/**
 * `matches` for `query`, re-read on the media query's own change event and on
 * resize / orientationchange (an iPad rotating across 1024 px). The snapshot
 * is read during render — the server render too — so a phone never mounts the
 * desktop-only tree for even one frame, and a test can stub matchMedia.
 */
export function useMediaQuery(query, fallback = false) {
  const subscribe = useCallback((onChange) => {
    const win = globalThis.window
    if (!win) return () => {}
    let mql = null
    try { mql = win.matchMedia?.(query) ?? null } catch { mql = null }
    mql?.addEventListener?.('change', onChange)
    win.addEventListener?.('resize', onChange)
    win.addEventListener?.('orientationchange', onChange)
    return () => {
      mql?.removeEventListener?.('change', onChange)
      win.removeEventListener?.('resize', onChange)
      win.removeEventListener?.('orientationchange', onChange)
    }
  }, [query])
  const read = () => mediaMatches(query, fallback)
  return useSyncExternalStore(subscribe, read, read)
}

/** True at the desktop layout. Unknown environment → true, i.e. mount as
 * before: a missing matchMedia must never hide a control. */
export function useIsDesktop() {
  return useMediaQuery(DESKTOP_QUERY, true)
}
