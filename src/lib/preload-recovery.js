// ---------------------------------------------------------------------------
// src/lib/preload-recovery.js — a deploy must not strand every open tab.
//
// Owner, 24-08-2026, on /connect: "TypeError: Importing a module script
// failed." Measured cause: the report arrived while /health showed uptime
// 92s — the tab asked for a lazy route chunk in the exact window Railway was
// swapping containers for the #755 deploy. The same error also fires the
// OTHER way on every deploy: a tab whose shell predates the deploy asks for
// a chunk hash that no longer exists. This repo merges several times a day,
// so every deploy is a chance to strand every open tab on a dead Suspense
// boundary with a stack trace where a page should be.
//
// Vite emits `vite:preloadError` for exactly this. The remedy is a reload —
// the fresh shell references the fresh chunks — guarded so a genuinely
// broken asset (still failing after reload) cannot become an infinite
// reload loop: one automatic attempt per WINDOW_MS, then stop and let the
// error surface for a human.
// ---------------------------------------------------------------------------

const KEY = 'preload_reload_at'
export const WINDOW_MS = 30_000

/**
 * Pure: should this preload failure trigger an automatic reload?
 * `last` is the epoch-ms of the previous automatic reload, or null.
 */
export function shouldReload(nowMs, last) {
  const prev = Number(last)
  if (!Number.isFinite(prev) || prev <= 0) return true
  return nowMs - prev >= WINDOW_MS
}

/** Wire the listener. Storage failures degrade to reloading (the useful arm). */
export function installPreloadRecovery(win = window) {
  win.addEventListener('vite:preloadError', (event) => {
    let last = null
    try { last = win.sessionStorage.getItem(KEY) } catch { /* private mode */ }
    if (!shouldReload(Date.now(), last)) return // second failure in the window — let it surface
    try { win.sessionStorage.setItem(KEY, String(Date.now())) } catch { /* still reload */ }
    event.preventDefault() // we are handling it — don't also throw into React
    win.location.reload()
  })
}
