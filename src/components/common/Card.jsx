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
// Owner (2026-08-01): every section states its CONTENT KIND next to the
// collapse caret — T data table · F form/controls · C card of stats/prose ·
// T+F table with embedded controls — matching the FAB table of contents.
// The tag derives from src/lib/nav-tree.js by the section's anchor id
// (on the card itself, on a child heading, or on a wrapper parent), so no
// call site needs wiring and the tag cannot drift from the nav map; an
// explicit `kind` prop still wins for cards outside the tree.
import { useRef, useState } from 'react'
import CopyPopup from './CopyPopup.jsx'
import { tableToJson as scrapeJson, tableToHtml, dataToHtml, textToJson, textToHtml } from '../../lib/copy-serialize.js'
import { sectionKind, NAV_KIND_LEGEND } from '../../lib/nav-tree.js'

export default function Card({
  children, className = '', copyable = true, copyTitle = null,
  data = null, toText = null, collapsible = true, defaultCollapsed = false,
  kind: kindProp = null,
  ...rest
}) {
  const ref = useRef(null)
  const [popup, setPopup] = useState(null)
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  // Derived once from the DOM after mount (callback ref, not an effect —
  // the anchor ids are static). kindProp bypasses the lookup entirely.
  const [kindFound, setKindFound] = useState(null)
  const kindLooked = useRef(false)
  const attachRef = (node) => {
    ref.current = node
    if (!node || kindProp || kindLooked.current) return
    kindLooked.current = true
    const id = node.id || node.querySelector('[id^="sec-"]')?.id || node.closest('[id^="sec-"]')?.id
    const k = sectionKind(id)
    if (k) setKindFound(k)
  }
  const kind = kindProp || kindFound
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
    // innerText picks up the card's OWN chrome glyphs — the ▾/▸ collapse caret
    // and the ⧉ copy button both sit inside the card, so every export used to
    // open with two lines of meaningless symbols. That was tolerable in a
    // clipboard paste and is not in a saved .txt/.json file, so the control
    // glyphs are dropped here. Only the glyphs: no text is removed.
    // Also drops the lone-line content-kind tag (T / F / C / T+F).
    const CHROME_GLYPHS = /^(?:[▾▸⧉↓✕]|T|F|C|T\+F)$/
    const domText = (el.innerText || '')
      .split('\n')
      .filter(l => !CHROME_GLYPHS.test(l.trim()))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const title = copyTitle || headingOf(el) || 'Section'
    const text = toText ? toText(data) : domText
    // Owner (2026-07-25): every copy feature offers Text, JSON AND HTML, and
    // table payloads carry the column heads + first-column head, not just
    // data. Priority: explicit data prop, else the rendered table (whose
    // scrape keys rows BY the heads), else an honest prose fallback — lines
    // for JSON, escaped <pre> for HTML. Nothing is invented.
    const scraped = data == null ? scrapeJson(el) : null
    const payload = data != null ? data : scraped
    const json = JSON.stringify(payload != null ? payload : textToJson(title, text), null, 2)
    const html = (data != null ? dataToHtml(data, title) : tableToHtml(el, title)) || textToHtml(title, text)
    setPopup({ title, text, json, html })
  }

  const btn = {
    position: 'absolute', top: 6, zIndex: 5, cursor: 'pointer', fontFamily: 'inherit',
    fontSize: 'var(--fs-d9)', lineHeight: 1, color: 'var(--color-text-sub)', background: 'transparent',
    border: '1px solid transparent', borderRadius: 8, padding: '3px 6px', opacity: .55,
  }
  const hoverOn = (e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.borderColor = 'var(--glass-edge)' }
  const hoverOff = (e) => { e.currentTarget.style.opacity = '.55'; e.currentTarget.style.borderColor = 'transparent' }

  return (
    <div ref={attachRef} className={cls} {...rest}>
      {kind && (
        <span title={NAV_KIND_LEGEND} style={{
          position: 'absolute', top: 8, right: (collapsible ? 26 : 0) + (copyable ? 26 : 0) + 10,
          zIndex: 5, fontSize: '8px', fontWeight: 600, lineHeight: 1.5,
          color: 'var(--color-text-sub)', border: '1px solid var(--glass-edge)',
          borderRadius: 'var(--radius-control)', padding: '0 3px', opacity: .7,
          whiteSpace: 'nowrap',
        }}>{kind}</span>
      )}
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
        <span className="text-[9px] font-semibold text-[var(--color-text-sub)]">
          {label || copyTitle || 'Section'}
        </span>
      )}
      <div style={collapsed ? { display: 'none' } : undefined}>{children}</div>
      {popup && <CopyPopup title={popup.title} text={popup.text} json={popup.json} html={popup.html} onClose={() => setPopup(null)} />}
    </div>
  )
}
