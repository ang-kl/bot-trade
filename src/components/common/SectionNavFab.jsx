// SectionNavFab — the floating table-of-contents navigator (owner 2026-08-01:
// "make a table of content professional style for the Navigation FAB contains
// both the different pages (sub-pages, table/form/card) … when user in that
// page (that page table of content expanded to see the web-tree while the
// other pages are collapse").
//
// Structure comes from src/lib/nav-tree.js — the single source for every
// page, sub-page and section, each section tagged with its content kind
// (T table · F form · C card · T+F table with controls). Behaviour:
//
//   · The current page's branch starts EXPANDED (▾); every other page is
//     collapsed (▸). Any branch can be toggled without leaving the page.
//   · Tapping a section of the CURRENT page scrolls its anchor into view —
//     or, on Tune, switches the tab via the caller's `onSelect`.
//   · Tapping a section of ANOTHER page navigates there first and then
//     scrolls once the section has rendered (retry loop — data-driven pages
//     mount their anchors asynchronously).
//   · Tapping a page NAME navigates to that page.
//
// The FAB itself is pinned to the BOTTOM-RIGHT and stays there when the
// panel opens (alignItems flex-end — the panel pulls out leftward/upward
// from the pinned button); the panel is the app's liquid-glass surface
// (glass-panel: backdrop blur + specular top streak).
//
// PHONES SEE IT TOO, since 05-08-2026. This stack used to carry
// `hidden min-[700px]:flex`, so on an iPhone SE (375px) the FAB had never once
// been painted — which made "add the account to the nav FAB" a change that
// would have done nothing on the device the owner was asking about. The
// positioning now lives in `.fab-stack` (index.css), which lifts the stack
// clear of the 49px MobileTabBar and the home indicator below 700px.
//
// TWO BUTTONS, ONE PANEL AT A TIME. The account FAB sits above the ☰. Their
// panels are mutually exclusive — both open at once runs off the top of a
// 375px screen.
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { NAV_TREE, NAV_KIND_LEGEND, pageForPath } from '../../lib/nav-tree.js'
import AccountScopeFab from './AccountScopeFab.jsx'

// Collapsed = right-pointing ▸, expanded = down-pointing ▾ (owner-specified
// Unicode triangles, the same pair every disclosure in the app uses).
const CARET = { closed: '▸', open: '▾' }

// After a cross-page jump the target section does not exist until the page
// renders (often after a fetch) — retry briefly instead of scrolling nowhere.
function scrollToWhenReady(id, tries = 25) {
  const el = document.getElementById(id)
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return }
  if (tries > 0) setTimeout(() => scrollToWhenReady(id, tries - 1), 120)
}

const rowBase = {
  display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
  cursor: 'pointer', fontFamily: 'inherit', color: 'var(--color-text)',
  background: 'transparent', border: 'none', borderRadius: 6,
}

function KindTag({ kind }) {
  return (
    <span title={NAV_KIND_LEGEND} style={{
      marginLeft: 'auto', flexShrink: 0, fontSize: 'var(--fs-body)', fontWeight: 600,
      color: 'var(--color-text-sub)', border: '1px solid var(--glass-edge)',
      borderRadius: 'var(--radius-control)', padding: '0 3px', lineHeight: 1.5,
      fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
    }}>{kind}</span>
  )
}

export default function SectionNavFab({ onSelect }) {
  // 'nav' | 'acct' | null — one panel at a time.
  const [panel, setPanel] = useState(null)
  const open = panel === 'nav'
  const setOpen = (next) => setPanel((typeof next === 'function' ? next(open) : next) ? 'nav' : null)
  const location = useLocation()
  const navigate = useNavigate()
  const current = pageForPath(location.pathname)
  // Which page branches are expanded — keyed by path. Re-seeds to "current
  // page only" whenever the route changes or the panel reopens, so the tree
  // always greets you with your own page unfolded. Reset uses the
  // adjust-state-during-render pattern (not an effect) — same as
  // DurationField in Field.jsx.
  const seedKey = `${current?.path || ''}|${open ? 1 : 0}`
  const [expanded, setExpanded] = useState(() => new Set(current ? [current.path] : []))
  const [prevSeedKey, setPrevSeedKey] = useState(seedKey)
  if (prevSeedKey !== seedKey) {
    setPrevSeedKey(seedKey)
    setExpanded(new Set(current ? [current.path] : []))
  }

  const hover = {
    onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--glass-bg)' },
    onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
  }

  const jumpSection = (page, s) => {
    setOpen(false)
    if (current && page.path === current.path) {
      if (onSelect) onSelect(s.id)
      else document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    navigate(page.path)
    // Tab-driven pages (Tune) have no anchors to scroll to from outside —
    // landing on the page is the jump. Anchor pages get the retry scroll.
    if (String(s.id).startsWith('sec-')) scrollToWhenReady(s.id)
  }

  const goPage = (page) => {
    if (current && page.path === current.path) {
      setExpanded(x => { const n = new Set(x); n.has(page.path) ? n.delete(page.path) : n.add(page.path); return n })
      return
    }
    setOpen(false)
    navigate(page.path)
  }

  const pageBranch = (page, depth = 0) => {
    const isCurrent = current && page.path === current.path
    const isOpen = expanded.has(page.path)
    return (
      <div key={page.path}>
        <div style={{ display: 'flex', alignItems: 'center', paddingLeft: depth * 10 }}>
          {/* The caret toggles the branch; the name navigates. Two targets so
              you can peek at another page's contents without leaving. */}
          <button type="button" aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${page.label} sections`}
            onClick={() => setExpanded(x => { const n = new Set(x); n.has(page.path) ? n.delete(page.path) : n.add(page.path); return n })}
            style={{ ...rowBase, width: 20, flexShrink: 0, justifyContent: 'center', fontSize: 'var(--fs-body)', color: 'var(--color-text-sub)', padding: '4px 0' }}>
            <span aria-hidden="true">{isOpen ? CARET.open : CARET.closed}</span>
          </button>
          <button type="button" onClick={() => goPage(page)} {...hover}
            aria-current={isCurrent ? 'page' : undefined}
            style={{ ...rowBase, fontSize: 'var(--fs-body)', fontWeight: 600, padding: '4px 8px 4px 2px', color: isCurrent ? 'var(--color-accent)' : 'var(--color-text)' }}>
            {page.icon && <span aria-hidden="true" style={{ fontSize: 'var(--fs-body)' }}>{page.icon}</span>}
            {page.label}
          </button>
        </div>
        {isOpen && (page.sections || []).map(s => (
          <button key={s.id} type="button" onClick={() => jumpSection(page, s)} {...hover}
            style={{ ...rowBase, fontSize: 'var(--fs-body)', fontWeight: 400, padding: '3px 8px', marginLeft: 20 + depth * 10, width: `calc(100% - ${20 + depth * 10}px)` }}>
            {s.label}
            <KindTag kind={s.kind} />
          </button>
        ))}
        {isOpen && (page.children || []).map(c => pageBranch(c, depth + 1))}
      </div>
    )
  }

  return (
    <div className="fab-stack" data-once="fab-stack">
      {open && (
        <nav aria-label="Table of contents" className="glass-panel"
          style={{ marginBottom: 8, borderRadius: 12, padding: '6px 6px 4px', maxHeight: '72vh', overflowY: 'auto', minWidth: 232 }}>
          {NAV_TREE.map(g => (
            <div key={g.group} style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 'var(--fs-body)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--color-text-sub)', padding: '3px 8px 1px' }}>{g.group}</div>
              {g.pages.map(p => pageBranch(p))}
            </div>
          ))}
          <div style={{ fontSize: 'var(--fs-body)', color: 'var(--color-text-sub)', padding: '3px 8px 2px', borderTop: '1px solid var(--glass-edge)' }}>
            {NAV_KIND_LEGEND}
          </div>
        </nav>
      )}
      {/* "Whose numbers is this?" answered without opening anything, in the
          same corner as "where am I?". */}
      <AccountScopeFab open={panel === 'acct'} onToggle={(v) => setPanel(v ? 'acct' : null)} />
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label="Table of contents" title="Table of contents"
        className="glass-fixed"
        style={{ cursor: 'pointer', fontFamily: 'inherit', width: 44, height: 44, borderRadius: '50%', border: '1px solid var(--glass-border)', color: 'var(--color-accent)', fontSize: 'var(--fs-glyph-lg)', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {open ? '×' : '☰'}
      </button>
    </div>
  )
}
