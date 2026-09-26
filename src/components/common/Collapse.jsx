// Collapse — the ▸/▾ collapsible triangle EVERY table and card must carry
// (owner 02-08-2026: "every single page, in every page — the cards, table to
// have collapsible triangle"). Cards get it from Card.jsx; this is the same
// control for the remaining standalone tables. Choice persisted per id.
//
// STALE NOTE, corrected 26-09-2026 (UI-1): this used to also credit
// "Performance-style sections from SectionTools" with providing the
// triangle. SectionTools.jsx deliberately does NOT collapse anything — its
// own comment says so ("Collapse deliberately belongs to the owning Card or
// Collapse component… gives every section exactly one disclosure owner"). A
// Performance-style section without a Card wrapper gets its triangle from
// THIS component or nothing; it never came from SectionTools.
import { useState } from 'react'

export default function Collapse({ id, label, sub = null, defaultOpen = true, children }) {
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(`tbl_open_${id}`)
      return v == null ? defaultOpen : v === '1'
    } catch { return defaultOpen }
  })
  const toggle = () => setOpen(o => {
    const next = !o
    try { localStorage.setItem(`tbl_open_${id}`, next ? '1' : '0') } catch { /* private mode */ }
    return next
  })
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={toggle}
        className="flex items-center gap-1.5 text-(length:--fs-body) font-semibold text-[var(--color-text-sub)] cursor-pointer hover:text-[var(--color-text)]">
        <span aria-hidden="true" className="inline-block w-3">{open ? '▾' : '▸'}</span>
        {label}
        {sub && <span className="font-normal text-[var(--color-muted)]">{sub}</span>}
      </button>
      {open && children}
    </div>
  )
}
