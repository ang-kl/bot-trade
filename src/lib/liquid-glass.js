// Liquid Glass — real-time WebGL refraction on the floating header bar,
// powered by the vendored liquidGL library (src/vendor/liquidGL.js, MIT).
//
// Progressive enhancement only: on mobile, with prefers-reduced-motion, or
// without WebGL we never initialise and the existing CSS glass (backdrop
// blur in index.css) stays as-is. liquidGL itself zeroes the target's
// background/backdrop-filter when it takes over, so the two never stack.
//
// The effect refracts a html2canvas snapshot of the page, so the snapshot
// must be re-captured whenever the content behind the bar changes (route
// change, theme toggle, data load). refreshLiquidGlass() does that.

let started = false

export function liquidGlassEligible() {
  if (typeof window === 'undefined') return false
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  if (window.matchMedia('(max-width: 768px)').matches) return false
  return true
}

export async function initLiquidGlass(target = '.glass-bar') {
  if (started || !liquidGlassEligible()) return
  started = true
  try {
    // html2canvas-pro: maintained fork with modern CSS color support
    // (color-mix / oklch, which Tailwind 4 emits — the original html2canvas
    // throws "unsupported color function" on this codebase's styles).
    const { default: html2canvas } = await import('html2canvas-pro')
    window.html2canvas = html2canvas
    await import('../vendor/liquidGL.js')
    // Watchdog: liquidGL hides the target (opacity 0) until its first render.
    // If the page snapshot fails (e.g. an unsupported CSS feature), the bar
    // would stay invisible — so if on.init hasn't fired within 6s, undo
    // everything and let the CSS glass fallback show again.
    let rendered = false
    setTimeout(() => {
      if (rendered) return
      document.querySelectorAll(target).forEach(el => {
        el.style.opacity = ''
        el.style.background = ''
        el.style.backgroundColor = ''
        el.style.backgroundImage = ''
        el.style.backdropFilter = ''
        el.style.webkitBackdropFilter = ''
        el.style.pointerEvents = ''
      })
      const canvas = window.__liquidGLRenderer__?.canvas
      if (canvas) canvas.style.display = 'none'
      started = false
      console.warn('liquidGL: snapshot never rendered — reverted to CSS glass')
    }, 6000)
    window.liquidGL({
      on: { init: () => { rendered = true } },
      target,
      snapshot: 'body',
      resolution: 1.5,     // 2.0 default is heavy; 1.5 is visually identical on the thin bar
      refraction: 0.012,
      bevelDepth: 0.08,
      bevelWidth: 0.15,
      frost: 2,            // slight blur so nav text stays readable over busy content
      shadow: false,       // the bar keeps its own CSS shadow
      specular: true,
      reveal: 'fade',
      tilt: false,
      magnify: 1,
    })
  } catch (err) {
    // Non-fatal: CSS glass remains. Log for debugging only.
    console.warn('liquidGL init skipped:', err?.message || err)
  }
}

// Re-capture the page snapshot (debounced) so the refraction shows current
// content. Call after route changes, theme toggles, and data loads.
let refreshTimer = null
export function refreshLiquidGlass(delayMs = 350) {
  if (!started) return
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    const renderer = window.__liquidGLRenderer__
    if (renderer?.captureSnapshot) renderer.captureSnapshot()
  }, delayMs)
}
