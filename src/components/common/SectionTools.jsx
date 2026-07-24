// SectionTools — the owner's structural requirement (Performance handoff,
// 2026-07-24): EVERY section header carries an ⤢ expand button (opens the
// section in a modal window) and a ⧉ copy button (copy as text / as JSON).
// One shared component so no panel can be built without them.
//
//   <SectionTools id="ledger" title="Timeframe ledger" data={rows}
//     toText={(rows) => '…'} render={({ variant }) => <LedgerBody …/>} />
//
// - Modal: portal to document.body, overlay inset:0 with the spec backdrop,
//   .glass-panel chrome, width min(96vw,1720px) / height min(92vh), internal
//   scroll, closes on Esc / ✕ / backdrop click, focus moves into the panel.
//   `render({ variant: 'modal' })` re-renders the SAME component expanded
//   (zoom bumps the type one step — inline px styles scale with it).
// - Copy: popover with "Copy as text" (per-section toText(data)) and
//   "Copy as JSON" ({ section, generatedAt, window, rows }); the last choice
//   is remembered (localStorage) and a plain click reuses it; the button
//   flashes ✓ Copied for ~1.2s.
// - Deep link: ?expand=<id> opens the matching modal on first mount.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const LS_KEY = 'perf_copy_mode' // 'text' | 'json'

function genericText(title, data) {
  const rows = Array.isArray(data) ? data : data != null ? [data] : []
  const line = (r) => (r && typeof r === 'object'
    ? Object.entries(r).filter(([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v))
      .map(([k, v]) => `${k} ${v ?? '—'}`).join(' · ')
    : String(r))
  return [title, ...rows.map(line)].join('\n')
}

export default function SectionTools({ id, title, window: windowLabel = null, data = null, toText = null, render }) {
  const [open, setOpen] = useState(false)
  const [pop, setPop] = useState(false)
  const [copied, setCopied] = useState(false)
  const panelRef = useRef(null)

  // Deep-link nicety: ?expand=<id> opens this section's modal on load.
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

  const doCopy = useCallback(async (mode) => {
    try { localStorage.setItem(LS_KEY, mode) } catch { /* private mode */ }
    const payload = mode === 'json'
      ? JSON.stringify({ section: id, generatedAt: new Date().toISOString(), window: windowLabel, rows: data }, null, 2)
      : (toText ? toText(data) : genericText(title, data))
    try {
      await navigator.clipboard.writeText(payload)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch { /* clipboard denied — nothing to fake */ }
    setPop(false)
  }, [id, title, windowLabel, data, toText])

  const lastMode = () => { try { return localStorage.getItem(LS_KEY) || 'text' } catch { return 'text' } }

  const btn = {
    cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, lineHeight: 1,
    color: 'var(--color-text-sub)', background: 'transparent',
    border: '1px solid var(--glass-edge)', borderRadius: 8, padding: '3px 7px',
  }

  return (
    <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, position: 'relative', flexShrink: 0 }}>
      <button type="button" title="Copy section as text or JSON" aria-label={`Copy ${title}`} style={btn}
        onClick={() => doCopy(lastMode())}
        onContextMenu={(e) => { e.preventDefault(); setPop(p => !p) }}>
        {copied ? '✓ Copied' : '⧉'}
      </button>
      <button type="button" title="Choose copy format" aria-label="Copy format" style={{ ...btn, padding: '3px 4px' }}
        onClick={() => setPop(p => !p)}>▾</button>
      <button type="button" title={`Expand ${title}`} aria-label={`Expand ${title}`} style={btn}
        onClick={() => setOpen(true)}>⤢</button>
      {pop && (
        <span style={{ position: 'absolute', top: '110%', right: 0, zIndex: 60, display: 'flex', flexDirection: 'column', gap: 2, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, padding: 4, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(12px)' }}>
          <button type="button" style={{ ...btn, border: 'none', textAlign: 'left', whiteSpace: 'nowrap' }} onClick={() => doCopy('text')}>Copy as text</button>
          <button type="button" style={{ ...btn, border: 'none', textAlign: 'left', whiteSpace: 'nowrap' }} onClick={() => doCopy('json')}>Copy as JSON</button>
        </span>
      )}
      {open && createPortal(
        <div role="dialog" aria-modal="true" aria-label={title}
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
          style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(6,9,19,.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div ref={panelRef} tabIndex={-1} className="glass-panel"
            style={{ width: 'min(96vw, 1720px)', height: 'min(92vh, 1100px)', borderRadius: 16, padding: '14px 16px', overflow: 'auto', outline: 'none', zoom: 1.15 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 800 }}>{title}</span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
                <button type="button" title="Copy section" style={btn} onClick={() => doCopy(lastMode())}>{copied ? '✓ Copied' : '⧉ Copy'}</button>
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
