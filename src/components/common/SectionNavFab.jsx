// SectionNavFab — the Performance page's floating jump-to-section button,
// extracted so every page carries it (owner 2026-07-25: "include nav FAB for
// all other pages"). Desktop-only (≥700px), fixed bottom-right, one tap opens
// the section list, tapping a row scrolls its anchor into view — or, when a
// page navigates by state instead of scroll (Tune's tabs), the caller passes
// `onSelect` and the FAB delegates instead of scrolling.
//
// Typography follows docs/ui-spec.md: rows are data → 9px/400; the toggle
// glyph is an icon, not text.
import { useState } from 'react'

export default function SectionNavFab({ sections, onSelect }) {
  const [open, setOpen] = useState(false)
  const jump = (id) => {
    if (onSelect) onSelect(id)
    else document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setOpen(false)
  }
  if (!sections?.length) return null
  // Owner 2026-08-01: the FAB anchors to the BOTTOM-RIGHT and must STAY there
  // when the list opens — before this fix the container grew to the list's
  // 190px width and the 44px button, being left-aligned inside it, visually
  // jumped left on open. alignItems flex-end pins the button to the right
  // edge, so the liquid-glass panel expands leftward/upward from it.
  return (
    <div className="hidden min-[700px]:flex" style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 40, flexDirection: 'column', alignItems: 'flex-end' }}>
      {open && (
        <div className="glass-panel" style={{ marginBottom: 8, borderRadius: 12, padding: '6px 4px', maxHeight: '70vh', overflowY: 'auto', minWidth: 190 }}>
          {sections.map(s => (
            <button key={s.id} type="button" onClick={() => jump(s.id)}
              style={{ display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'var(--fs-d9)', fontWeight: 400, color: 'var(--color-text)', background: 'transparent', border: 'none', borderRadius: 8, padding: '5px 10px' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--glass-bg)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
              {s.label}
            </button>
          ))}
        </div>
      )}
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label="Jump to section" title="Jump to section"
        className="glass-fixed"
        style={{ cursor: 'pointer', fontFamily: 'inherit', width: 44, height: 44, borderRadius: '50%', border: '1px solid var(--glass-border)', color: 'var(--color-accent)', fontSize: 'var(--fs-d18)', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {open ? '×' : '☰'}
      </button>
    </div>
  )
}
