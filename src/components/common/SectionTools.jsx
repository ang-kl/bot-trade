// SectionTools — the owner's structural requirement (Performance handoff,
// 2026-07-24, revised same day): EVERY section header carries ⧉ copy and
// ⤢ expand.
//
//   <SectionTools id="ledger" title="Timeframe ledger" data={rows}
//     toText={(rows) => '…'} render={({ variant }) => <LedgerBody …/>} />
//
// - ⧉ Copy opens the copy POP-UP WINDOW (CopyPopup): the section's content
//   as selectable text with Text/JSON tabs and a Copy button — the owner's
//   "copy pop-up window", replacing the old silent clipboard write.
// - ⤢ Expand opens the section in a REAL browser pop-up window (the owner:
//   the in-page expand modal "is wrong"): window.open + a portal rendering
//   the SAME `render({ variant: 'modal' })` component, with the app's
//   stylesheets cloned across. If the browser blocks the popup (or on a
//   ?expand=<id> deep link, where no user gesture exists), it falls back to
//   the in-page modal so the content is never unreachable.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import CopyPopup from './CopyPopup.jsx'

function genericText(title, data) {
  const rows = Array.isArray(data) ? data : data != null ? [data] : []
  const line = (r) => (r && typeof r === 'object'
    ? Object.entries(r).filter(([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v))
      .map(([k, v]) => `${k} ${v ?? '—'}`).join(' · ')
    : String(r))
  return [title, ...rows.map(line)].join('\n')
}

export default function SectionTools({ id, title, window: windowLabel = null, data = null, toText = null, render }) {
  const [open, setOpen] = useState(false) // in-page fallback modal
  const [copyOpen, setCopyOpen] = useState(false)
  const [popupHost, setPopupHost] = useState(null) // portal target inside the popup window
  const panelRef = useRef(null)
  const winRef = useRef(null)

  // Deep-link nicety: ?expand=<id> opens this section on load — as the
  // in-page modal, since browsers block window.open without a user gesture.
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get('expand') === id) setOpen(true)
    } catch { /* no-op */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    panelRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // Close the popup window when this section unmounts (page navigation).
  useEffect(() => () => { try { winRef.current?.close() } catch { /* gone */ } }, [])

  const openExpand = () => {
    let win = null
    try { win = window.open('', '', 'popup=yes,width=1280,height=860') } catch { win = null }
    if (!win) { setOpen(true); return } // blocked → in-page modal
    winRef.current = win
    const doc = win.document
    doc.title = title
    const base = doc.createElement('base')
    base.href = document.baseURI
    doc.head.appendChild(base)
    // Clone the app's styles so the same component renders identically.
    document.querySelectorAll('style, link[rel="stylesheet"]').forEach(n => doc.head.appendChild(n.cloneNode(true)))
    doc.documentElement.className = document.documentElement.className
    doc.body.className = document.body.className
    doc.body.style.margin = '0'
    doc.body.style.background = 'var(--color-bg, #0b0f19)'
    const host = doc.createElement('div')
    host.style.padding = '14px 16px'
    doc.body.appendChild(host)
    win.addEventListener('beforeunload', () => { setPopupHost(null); winRef.current = null })
    setPopupHost(host)
  }

  const textPayload = () => (toText ? toText(data) : genericText(title, data))
  const jsonPayload = () => JSON.stringify({ section: id, generatedAt: new Date().toISOString(), window: windowLabel, rows: data }, null, 2)

  const btn = {
    cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, lineHeight: 1,
    color: 'var(--color-text-sub)', background: 'transparent',
    border: '1px solid var(--glass-edge)', borderRadius: 8, padding: '3px 7px',
  }

  return (
    <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, position: 'relative', flexShrink: 0 }}>
      <button type="button" title="Copy — opens the copy pop-up (text / JSON)" aria-label={`Copy ${title}`} style={btn}
        onClick={() => setCopyOpen(true)}>⧉</button>
      <button type="button" title={`Open ${title} in a pop-up window`} aria-label={`Expand ${title}`} style={btn}
        onClick={openExpand}>⤢</button>
      {copyOpen && (
        <CopyPopup title={title} text={textPayload()} json={jsonPayload()} onClose={() => setCopyOpen(false)} />
      )}
      {popupHost && createPortal(
        <div className="glass-panel" style={{ borderRadius: 16, padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 800 }}>{title}</span>
          </div>
          {render ? render({ variant: 'modal' }) : null}
        </div>,
        popupHost
      )}
      {open && createPortal(
        <div role="dialog" aria-modal="true" aria-label={title}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
          style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(6,9,19,.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div ref={panelRef} tabIndex={-1} className="glass-panel"
            style={{ width: 'min(96vw, 1720px)', height: 'min(92vh, 1100px)', borderRadius: 16, padding: '14px 16px', overflow: 'auto', outline: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 800 }}>{title}</span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
                <button type="button" title="Copy section" style={btn} onClick={() => setCopyOpen(true)}>⧉ Copy</button>
                <button type="button" title="Close (Esc)" aria-label="Close" style={btn} onClick={() => setOpen(false)}>✕</button>
              </span>
            </div>
            {render ? render({ variant: 'modal' }) : null}
          </div>
        </div>,
        document.body
      )}
    </span>
  )
}
