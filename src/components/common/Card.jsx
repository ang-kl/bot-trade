// Primary card — Ultra Neo Glass: liquid glass panel with specular sheen.
// Material lives in .glass-panel (index.css); this stays a thin wrapper.
//
// Owner (2026-07-24): "every page can copy pop-up window" — every Card
// carries a ⧉ button that opens the copy pop-up with the card's RENDERED
// text (innerText — exactly what's on screen, nothing recomputed). Cards
// whose sections provide their own structured tools (SectionTools) or that
// are pure chrome can opt out with copyable={false}.
//
// Owner (2026-07-25): "why other pages only have text copy and missing
// json" — because the JSON tab only ever appeared when a caller hand-passed
// a `data` prop, and only Performance's SectionTools did that. Wiring 31
// call sites by hand would have left the same gap open for the next card
// someone adds, so instead the popup now DERIVES its JSON from the card's
// own rendered <table> (see tableToJson). Any card containing a real table
// gets a JSON tab automatically, on every page, with no per-page work — and
// what it emits is exactly what is on screen, so it can't drift from the UI.
// An explicit `data` prop still wins when a caller wants richer structure.
//
// Owner (2026-07-25): "introducing triangle collapse/expand for all cards" —
// the ▾/▸ button. Collapsing sets display:none on the body rather than
// unmounting it, so the card keeps its scroll/sort/page state and everything
// below genuinely moves UP (the panel shrinks to its header bar).
import { useRef, useState } from 'react'
import CopyPopup from './CopyPopup.jsx'

// Serialize the first rendered <table> into row objects, using <thead> cells
// as keys. Reads the DOM, so it captures exactly what the user sees —
// including the current sort and page — and needs no cooperation from the
// page. Returns null when there is no table (or no header) to describe.
function tableToJson(root) {
  const table = root?.querySelector('table')
  if (!table) return null
  const heads = [...table.querySelectorAll('thead th')].map((th, i) => {
    const t = (th.innerText || '').trim().replace(/\s*[↓↑]\s*$/, '')
    return t || `col${i + 1}`
  })
  if (!heads.length) return null
  const rows = [...table.querySelectorAll('tbody tr')].map(tr => {
    const cells = [...tr.children]
    // Expanded detail rows (a single colSpan cell) aren't records — skip.
    if (cells.length < 2) return null
    return Object.fromEntries(cells.map((td, i) => [heads[i] || `col${i + 1}`, (td.innerText || '').trim()]))
  }).filter(Boolean)
  return rows.length ? rows : null
}

export default function Card({
  children, className = '', copyable = true, copyTitle = null,
  data = null, toText = null, collapsible = true, defaultCollapsed = false,
  ...rest
}) {
  const ref = useRef(null)
  const [popup, setPopup] = useState(null)
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  // Captured at collapse time (never read from the ref during render, which
  // would be impure) so the collapsed bar can still name itself.
  const [label, setLabel] = useState(null)
  const cls = [
    'glass-panel',
    'px-3.5 py-2.5',
    'text-[var(--color-text)]',
    'relative',
    className,
  ].filter(Boolean).join(' ')

  // The card's own heading, used for the popup title and the collapsed label.
  const headingOf = (el) => el?.querySelector('h1,h2,h3,h4,[class*="t-h"]')?.innerText?.split('\n')[0]?.trim() || null

  const openCopy = () => {
    const el = ref.current
    if (!el) return
    const domText = (el.innerText || '').replace(/\n{3,}/g, '\n\n').trim()
    const title = copyTitle || headingOf(el) || 'Section'
    const text = toText ? toText(data) : domText
    const scraped = data == null ? tableToJson(el) : null
    const payload = data != null ? data : scraped
    setPopup({ title, text, json: payload != null ? JSON.stringify(payload, null, 2) : null })
  }

  const btn = {
    position: 'absolute', top: 6, zIndex: 5, cursor: 'pointer', fontFamily: 'inherit',
    fontSize: 12, lineHeight: 1, color: 'var(--color-text-sub)', background: 'transparent',
    border: '1px solid transparent', borderRadius: 8, padding: '3px 6px', opacity: .55,
  }
  const hoverOn = (e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.borderColor = 'var(--glass-edge)' }
  const hoverOff = (e) => { e.currentTarget.style.opacity = '.55'; e.currentTarget.style.borderColor = 'transparent' }

  return (
    <div ref={ref} className={cls} {...rest}>
      {collapsible && (
        <button type="button" aria-expanded={!collapsed}
          title={collapsed ? 'Expand this section' : 'Collapse this section'}
          aria-label={collapsed ? 'Expand this section' : 'Collapse this section'}
          onClick={() => {
            if (!collapsed) setLabel(copyTitle || headingOf(ref.current) || 'Section')
            setCollapsed(c => !c)
          }}
          style={{ ...btn, right: copyable ? 34 : 8 }}
          onMouseEnter={hoverOn} onMouseLeave={hoverOff}>
          {collapsed ? '▸' : '▾'}
        </button>
      )}
      {copyable && (
        <button type="button" title="Copy this section" aria-label="Copy this section"
          onClick={openCopy} style={{ ...btn, right: 8 }}
          onMouseEnter={hoverOn} onMouseLeave={hoverOff}>
          ⧉
        </button>
      )}
      {/* Collapsed: show just the heading text so the bar is still
          identifiable, and hide (not unmount) the body so sort/page state
          survives and the card collapses to a single line. */}
      {collapsed && (
        <span className="text-[12px] font-semibold text-[var(--color-text-sub)]">
          {label || copyTitle || 'Section'}
        </span>
      )}
      <div style={collapsed ? { display: 'none' } : undefined}>{children}</div>
      {popup && <CopyPopup title={popup.title} text={popup.text} json={popup.json} onClose={() => setPopup(null)} />}
    </div>
  )
}
