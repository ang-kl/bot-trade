// CopyPopup — the owner's copy pop-up window (2026-07-24: "every page can
// copy pop-up window"). Instead of silently writing to the clipboard, ⧉
// opens this floating window showing the section's content as selectable
// text — Text and (when structured data exists) JSON tabs, a Copy button
// with a ✓ flash, close via Esc / ✕ / backdrop. The preview IS what gets
// copied — no divergence between what you see and what lands in the
// clipboard.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export default function CopyPopup({ title, text, json = null, html = null, onClose }) {
  const [tab, setTab] = useState('text')
  const [copied, setCopied] = useState(false)
  const panelRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    panelRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const content = tab === 'json' && json != null ? json : tab === 'html' && html != null ? html : text

  // Owner (2026-07-30): "and download". The popup could show three formats and
  // copy them, but there was no way to KEEP one — and the clipboard is the
  // wrong place for a 30-day ledger you want to open in a spreadsheet later.
  // Download saves whatever tab is showing, with the matching extension and
  // MIME type, so the file opens in the right application rather than as
  // untyped text.
  const FILE = {
    text: { ext: 'txt', mime: 'text/plain' },
    json: { ext: 'json', mime: 'application/json' },
    html: { ext: 'html', mime: 'text/html' },
  }
  /** bot-trade · Cadence and coverage → bot-trade-cadence-and-coverage */
  const slug = (s) => String(s || 'section')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section'
  const doDownload = () => {
    const { ext, mime } = FILE[tab] || FILE.text
    // The timestamp comes from the browser at click time, not from render —
    // two downloads of the same card must not collide on one filename.
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }))
    const a = document.createElement('a')
    a.href = url
    a.download = `bot-trade-${slug(title)}-${stamp}.${ext}`
    // Must be in the document for the click to be honoured in Firefox.
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoke on the next tick — revoking synchronously can cancel the download
    // in Chromium before it has read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const doCopy = async () => {
    try {
      // The HTML tab writes BOTH flavours, so pasting into Excel/Word/Docs
      // lands a real table while a plain-text target still gets the markup.
      if (tab === 'html' && html != null && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([html], { type: 'text/plain' }),
        })])
      } else {
        await navigator.clipboard.writeText(content)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch { /* clipboard denied — the text stays selectable by hand */ }
  }

  const btn = {
    cursor: 'pointer', fontFamily: 'inherit', fontSize: 'var(--fs-body)', lineHeight: 1,
    color: 'var(--color-text-sub)', background: 'transparent',
    border: '1px solid var(--glass-edge)', borderRadius: 8, padding: '4px 9px',
  }
  const tabBtn = (id, label) => (
    <button type="button" style={{ ...btn, fontWeight: tab === id ? 800 : 400, color: tab === id ? 'var(--color-text)' : 'var(--color-text-sub)', borderColor: tab === id ? 'var(--color-border)' : 'var(--glass-edge)' }}
      onClick={() => setTab(id)}>{label}</button>
  )

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`Copy ${title}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(6,9,19,.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div ref={panelRef} tabIndex={-1} className="glass-panel"
        style={{ width: 'min(90vw, 760px)', height: 'min(72vh, 640px)', borderRadius: 16, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, outline: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 'var(--fs-h)', fontWeight: 800 }}>⧉ {title}</span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
            {tabBtn('text', 'Text')}
            {json != null && tabBtn('json', 'JSON')}
            {html != null && tabBtn('html', 'HTML')}
            <button type="button" style={{ ...btn, fontWeight: 700 }} onClick={doCopy}>{copied ? '✓ Copied' : 'Copy'}</button>
            <button type="button" style={{ ...btn, fontWeight: 700 }} onClick={doDownload}
              title={`Save this ${tab.toUpperCase()} view as a file`}>↓ Download</button>
            <button type="button" title="Close (Esc)" aria-label="Close" style={btn} onClick={onClose}>✕</button>
          </span>
        </div>
        <pre style={{ flex: 1, margin: 0, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 'var(--fs-body)', lineHeight: 1.5, fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, padding: '8px 10px', userSelect: 'text' }}>
          {content}
        </pre>
      </div>
    </div>,
    document.body
  )
}
