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
// Owner (2026-08-01): every card also carries a MAXIMIZE toggle — ⇲ (U+21F2,
// south-east corner) expands the card into a full-screen overlay, ⇱ (U+21F1)
// restores it. The children are NOT remounted — the same content div gets a
// fixed-overlay wrapper — so table sort/page/scroll state survives the trip,
// exactly like the collapse's display:none trick.
//
// UI-1 (26-09 UI plan, OD-17 = D19/D8): the collapse choice used to be a
// plain useState, so it forgot itself on reload and, for a Card remounted by
// a changing `key` (the account switch remounts "Recorded entry blockers"),
// on every switch too. It now reads/writes lib/card-open.js, keyed by this
// Card's own `id` — the same `sec-*` anchor nav-tree.js already uses to find
// this Card's content kind, so no call site needs new wiring. A Card with no
// id has no stable key and keeps the old per-mount default.
//
// The collapse triangle was also "a visible triangle control, no
// transparency" (owner, 26-09): it used to sit at 55% opacity with a border
// that only appeared on hover — invisible on a phone, which never hovers.
// ⇲ and ⧉ keep their existing faint/hover-only treatment; only the collapse
// control is always fully visible now.
import { useEffect, useRef, useState } from 'react'
import CopyPopup from './CopyPopup.jsx'
import { tableToJson as scrapeJson, tableToHtml, dataToHtml, textToJson, textToHtml } from '../../lib/copy-serialize.js'
import { sectionKind, NAV_KIND_LEGEND } from '../../lib/nav-tree.js'
import ScopeChip from './ScopeChip.jsx'
import { CardChromeContext } from './CardChromeContext.js'
import { readCardOpen, writeCardOpen } from '../../lib/card-open.js'

// PERF-1: a conservative floor so a card whose content is still loading does
// not sit near-zero height and then jump once data arrives — one of the
// CLSCulprits insight's two named causes (the other is the font preload,
// index.html). Not a measurement of any one card's settled height, only a
// floor against the worst jump.
const LOADING_MIN_HEIGHT = 160

export default function Card({
  children, className = '', copyable = true, copyTitle = null,
  data = null, toText = null, collapsible = true, defaultCollapsed = false,
  kind: kindProp = null,
  // PERF-1: true while this Card's own content is still being fetched, so
  // the body reserves LOADING_MIN_HEIGHT instead of growing from whatever a
  // loading placeholder measures to the settled content's real height.
  loading = false,
  // W1-FU (26-09 UI plan §5): opt-in — while this Card is COLLAPSED and has
  // never been opened, its `children` are not mounted at all (not just
  // hidden with display:none). The default (false) is the existing
  // behaviour: children always mount, collapse only toggles display:none —
  // every existing caller and test keeps its old DOM. Once opened for the
  // first time, children stay mounted from then on, same as a non-lazy Card,
  // so sort/scroll/page state still survives a later re-collapse.
  lazy = false,
  // Tests inject a fake store here; production leaves it undefined and
  // card-open.js falls back to window.localStorage.
  storage = undefined,
  // Test-only seam, same shape as `storage` above: this repo has no jsdom /
  // interaction harness (see Card.test.jsx), so the "maximize a lazy,
  // never-opened, still-collapsed card, then restore it" regression cannot
  // be reached by clicking through a fresh renderToStaticMarkup mount — that
  // state (collapsed:true, everOpened:true) only exists mid-session, after a
  // real maximize click. `initialEverOpened` lets a test seed it directly;
  // production never passes it, so `everOpened` keeps deriving from
  // `!collapsed` as before.
  initialEverOpened = undefined,
  // WHOSE numbers is this card showing (owner 05-08-2026). 'all', 'global',
  // or an account id. Undefined means the card has not declared a scope yet
  // and renders no chip — deliberately NOT defaulted to 'global', because
  // that would relabel every unlabelled card as an intentional decision.
  scope = undefined,
  pageScope = undefined,
  // UI-3 (26-09 plan §8 item 3, "refresh only while expanded"): a card whose
  // content polls (the blockers card) needs to know its OWN collapsed state
  // to gate that poll — Card.jsx hides the body with display:none rather
  // than unmounting it, so a child's own effect keeps running while hidden
  // unless told to stop. Called once on mount with the initial value and
  // again on every toggle; omitted, this changes nothing about Card's own
  // behaviour.
  onCollapsedChange = undefined,
  ...rest
}) {
  const ref = useRef(null)
  const [popup, setPopup] = useState(null)
  const cardId = rest.id || null
  const [collapsed, setCollapsedRaw] = useState(() => !readCardOpen(cardId, !defaultCollapsed, storage))
  // W1-FU: whether this Card's content has EVER been shown — the gate `lazy`
  // reads. Seeded from the same first-render `collapsed` value (a card that
  // starts open has, by definition, already "opened"), so a fresh mount that
  // opens straight from a persisted choice (card-open.js) never has to wait
  // for the toggle to mount its children.
  const [everOpened, setEverOpened] = useState(() => initialEverOpened ?? !collapsed)
  // Fix round nit: `onCollapsedChange` used to also fire from INSIDE the
  // state updater below — a side effect during what React treats as a pure
  // state calculation, which can run twice (or, in concurrent rendering, be
  // discarded and retried) without the caller ever finding out. One effect
  // keyed on `collapsed` covers both the initial read (mount) and every
  // later toggle, so callers see exactly one call per real transition.
  useEffect(() => { onCollapsedChange?.(collapsed) }, [collapsed]) // eslint-disable-line react-hooks/exhaustive-deps -- only real collapsed transitions matter, not onCollapsedChange's identity
  // Every setCollapsed call also writes the choice back, under this Card's
  // own id — a no-op when there is no id (card-open.js's own guard).
  const setCollapsed = (updater) => setCollapsedRaw(prev => {
    const next = typeof updater === 'function' ? updater(prev) : updater
    writeCardOpen(cardId, !next, storage)
    // W1-FU: mark "opened" the moment collapsed goes false — here, not in an
    // effect, so a real toggle mounts a lazy Card's children on the SAME
    // update as the collapse state changes, never a render behind it.
    if (!next) setEverOpened(true)
    return next
  })
  const [maximized, setMaximized] = useState(false)
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
    const CHROME_GLYPHS = /^(?:[▾▸⧉↓✕⇲⇱]|T|F|C|T\+F)$/
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
    cursor: 'pointer', fontFamily: 'inherit',
    fontSize: 'var(--fs-body)', lineHeight: 1, color: 'var(--color-text-sub)', background: 'transparent',
    border: '1px solid transparent', borderRadius: 8, padding: '3px 6px', opacity: .55,
  }
  const hoverOn = (e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.borderColor = 'var(--glass-edge)' }
  const hoverOff = (e) => { e.currentTarget.style.opacity = '.55'; e.currentTarget.style.borderColor = 'transparent' }

  // OD-17 (D19): the collapse control, and only the collapse control, is a
  // VISIBLE triangle — full opacity and a border that does not depend on
  // hover. ⇲ and ⧉ above keep the faint/hover-only `btn` look.
  const collapseBtn = { ...btn, opacity: 1, borderColor: 'var(--glass-edge)' }
  const collapseHoverOn = (e) => { e.currentTarget.style.color = 'var(--color-text)' }
  const collapseHoverOff = (e) => { e.currentTarget.style.color = 'var(--color-text-sub)' }

  // Card controls used to be absolutely positioned over the top-right corner.
  // That made them cover the header summary and, on dense Performance/Desk
  // cards, real table columns. A floated toolbar remains at the right edge,
  // but now participates in layout: the first content line wraps around it
  // and content that does not fit starts below it. There is therefore no
  // overlay target to obscure.
  // W1-FU: maximizing forces content to show regardless of collapse state
  // (see the `body` style below), so it must count as "opened" too — a lazy
  // Card someone maximizes before ever expanding must not render an empty
  // overlay.
  const mountChildren = !lazy || everOpened || maximized
  const body = <div className="card-body" style={{
    ...(collapsed && !maximized ? { display: 'none' } : undefined),
    ...(loading ? { minHeight: LOADING_MIN_HEIGHT } : undefined),
  }}>{mountChildren ? children : null}</div>

  return (
    <CardChromeContext.Provider value={true}>
    <div ref={attachRef} className={cls} {...rest}>
      <span role="toolbar" aria-label="Section controls" style={{
        float: 'right', display: 'inline-flex', alignItems: 'center', gap: 2,
        marginLeft: 8, position: 'relative', zIndex: 5,
      }}>
        {scope !== undefined && <ScopeChip scope={scope} pageScope={pageScope} style={{ opacity: .85 }} />}
        {kind && (
          <span title={NAV_KIND_LEGEND} style={{
            fontSize: 'var(--fs-body)', fontWeight: 600, lineHeight: 1.5,
            color: 'var(--color-text-sub)', border: '1px solid var(--glass-edge)',
            borderRadius: 'var(--radius-control)', padding: '0 3px', opacity: .7,
            whiteSpace: 'nowrap',
          }}>{kind}</span>
        )}
        {/* ⇲ maximize (owner 2026-08-01: U+21F2 to expand, U+21F1 to restore) */}
        <button type="button"
          title="Expand this section to full screen (⇱ restores)"
          aria-label="Expand this section to full screen"
          aria-expanded={maximized}
          onClick={() => {
            // Captured at click time — refs must not be read during render.
            setLabel(copyTitle || headingOf(ref.current) || 'Section')
            setMaximized(true)
            // BLOCKER fix (W1-FU checker): maximizing a lazy+collapsed card
            // that was NEVER opened via the collapse toggle used to mount an
            // empty overlay — `mountChildren` only checked `everOpened`, and
            // this click never set it. Mark "opened" here too, same as the
            // collapse toggle does, so the overlay always has real content
            // and restore (⇱) keeps children mounted afterwards.
            setEverOpened(true)
          }}
          style={btn}
          onMouseEnter={hoverOn} onMouseLeave={hoverOff}>
          ⇲
        </button>
        {collapsible && (
          <button type="button" aria-expanded={!collapsed}
            title={collapsed ? 'Expand this section' : 'Collapse this section'}
            aria-label={collapsed ? 'Expand this section' : 'Collapse this section'}
            onClick={() => {
              if (!collapsed) setLabel(copyTitle || headingOf(ref.current) || 'Section')
              setCollapsed(c => !c)
            }}
            style={collapseBtn}
            onMouseEnter={collapseHoverOn} onMouseLeave={collapseHoverOff}>
            {collapsed ? '▸' : '▾'}
          </button>
        )}
        {copyable && (
          <button type="button" title="Copy this section" aria-label="Copy this section"
            onClick={openCopy} style={btn}
            onMouseEnter={hoverOn} onMouseLeave={hoverOff}>
            ⧉
          </button>
        )}
      </span>
      {/* Collapsed: show just the heading text so the bar is still
          identifiable, and hide (not unmount) the body so sort/page state
          survives and the card collapses to a single line. */}
      {collapsed && !maximized && (
        <span className="text-(length:--fs-body) font-semibold text-[var(--color-text-sub)]">
          {label || copyTitle || 'Section'}
        </span>
      )}
      {/* Maximized: the SAME body node renders inside a fixed overlay — no
          remount, so table/scroll/sort state survives; ⇱ or Esc restores. */}
      {maximized
        ? (
          <MaxOverlay title={copyTitle || label || 'Section'} onRestore={() => setMaximized(false)}>
            {body}
          </MaxOverlay>
        )
        : body}
      {popup && <CopyPopup title={popup.title} text={popup.text} json={popup.json} html={popup.html} onClose={() => setPopup(null)} />}
    </div>
    </CardChromeContext.Provider>
  )
}

// Full-screen host for a maximized card. Kept outside Card's return for
// clarity; Esc and the backdrop both restore.
function MaxOverlay({ title, onRestore, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onRestore() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onRestore])
  return (
    <div role="dialog" aria-modal="true" aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onRestore() }}
      style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(6,9,19,.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="glass-panel" style={{ width: 'min(96vw, 1720px)', maxHeight: '92vh', borderRadius: 16, padding: '12px 16px', overflow: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 'var(--fs-h)', fontWeight: 800 }}>{title}</span>
          <button type="button" title="Restore this section to its place in the page (Esc)" aria-label="Restore this section"
            onClick={onRestore}
            style={{ marginLeft: 'auto', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'var(--fs-body)', lineHeight: 1, color: 'var(--color-text-sub)', background: 'transparent', border: '1px solid var(--glass-edge)', borderRadius: 8, padding: '3px 7px' }}>
            ⇱
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
