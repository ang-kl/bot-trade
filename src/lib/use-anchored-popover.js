// useAnchoredPopover — the popover contract, in one place.
//
// Extracted from SessionFooter, which had to learn each of these the hard way
// on a real 1440x900 screen. A second popover written from scratch would have
// had to relearn them, so it is a hook rather than a copied block.
//
// WHAT IT GUARANTEES, and why each clause exists:
//
//   · Escape closes and returns focus to the activating control.
//   · A click outside closes; a click inside the popover OR on the trigger
//     does not (the trigger has its own toggle, and letting the outside
//     handler also fire would close-then-reopen on every open).
//   · The box is clamped against BOTH ends of BOTH axes. An earlier version
//     clamped only `top` against the top edge and took `left` straight from
//     the anchor; measured in Chromium, a tall box near the bottom still
//     overflowed downward and a wide box overflowed to the right.
//   · It prefers to open UPWARD from the anchor and falls back to downward
//     when there is no room above — sidebar-anchored controls sit low.
//   · ZOOM CONVERSION, which is not optional in this app. index.css sets
//     `zoom: 1.1` on html above 1153px. getBoundingClientRect and
//     window.innerWidth/Height report VISUAL pixels, but a CSS length assigned
//     to style.top resolves in LAYOUT pixels — writing the visual number back
//     produced a box 10% too far down and, with the sidebar offset involved, a
//     NEGATIVE left edge (measured: -151px, i.e. off-screen, while every
//     clamp above said it was inside).
//
// The caller still has to PORTAL the popover to document.body. That is a
// correctness requirement, not tidiness: `glass-panel` uses backdrop-filter,
// and a filtered ancestor becomes the containing block for `position: fixed`
// descendants, so a popover left inside the sidebar is positioned against the
// panel rather than the viewport — and the panel's `overflow: hidden` would
// clip it regardless. The hook cannot do this for the caller, so it is stated
// here and in each caller.
import { useEffect, useLayoutEffect, useRef } from 'react'

export const POPOVER_MARGIN = 8

/**
 * Place `el` next to `anchor`, inside the viewport, in layout pixels.
 * Exported for tests — it is pure DOM arithmetic over injected rects.
 */
export function placeAnchored(el, anchor, {
  margin = POPOVER_MARGIN, viewportW, viewportH, zoom = 1,
} = {}) {
  el.style.top = ''
  el.style.bottom = ''
  el.style.left = ''
  const a = anchor.getBoundingClientRect()
  const { width: w, height: h } = el.getBoundingClientRect()
  const vw = viewportW ?? window.innerWidth
  const vh = viewportH ?? window.innerHeight
  const maxTop = Math.max(margin, vh - h - margin)
  const maxLeft = Math.max(margin, vw - w - margin)

  let top = a.top - h - margin
  if (top < margin) top = a.bottom + margin
  top = Math.min(Math.max(margin, top), maxTop)
  const left = Math.min(Math.max(margin, a.left), maxLeft)

  el.style.top = `${top / zoom}px`
  el.style.left = `${left / zoom}px`
  return { top, left }
}

/**
 * @param {{open: boolean, onClose: () => void, deps?: any[]}} opts
 *   deps: values whose change resizes the popover's CONTENT, so the box is
 *   re-measured. Position depends on the rendered size, not just on `open`.
 * @returns {{buttonRef, popoverRef}} refs to attach to the trigger and the box
 */
export function useAnchoredPopover({ open, onClose, deps = [] }) {
  const buttonRef = useRef(null)
  const popoverRef = useRef(null)
  // Held in a ref so a caller passing an inline arrow does not re-subscribe
  // the document listeners on every render.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current?.()
        buttonRef.current?.focus()
      }
    }
    const onDown = (e) => {
      if (popoverRef.current?.contains(e.target)) return
      if (buttonRef.current?.contains(e.target)) return
      closeRef.current?.()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const el = popoverRef.current
    const anchor = buttonRef.current
    if (!el || !anchor) return
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1
    placeAnchored(el, anchor, { zoom })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ...deps])

  return { buttonRef, popoverRef }
}
