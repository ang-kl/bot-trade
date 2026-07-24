// Primary card — Ultra Neo Glass: liquid glass panel with specular sheen.
// Material lives in .glass-panel (index.css); this stays a thin wrapper.
//
// Owner (2026-07-24): "every page can copy pop-up window" — every Card
// carries a ⧉ button that opens the copy pop-up with the card's RENDERED
// text (innerText — exactly what's on screen, nothing recomputed). Cards
// whose sections provide their own structured tools (SectionTools) or that
// are pure chrome can opt out with copyable={false}.
import { useRef, useState } from 'react'
import CopyPopup from './CopyPopup.jsx'

export default function Card({ children, className = '', copyable = true, copyTitle = null, ...rest }) {
  const ref = useRef(null)
  const [popup, setPopup] = useState(null)
  const cls = [
    'glass-panel',
    'px-4 py-3.5',
    'text-[var(--color-text)]',
    'relative',
    className,
  ].filter(Boolean).join(' ')
  const openCopy = () => {
    const el = ref.current
    if (!el) return
    const text = (el.innerText || '').replace(/\n{3,}/g, '\n\n').trim()
    const title = copyTitle
      || el.querySelector('h1,h2,h3,h4,[class*="t-h"]')?.innerText?.split('\n')[0]?.trim()
      || 'Section'
    setPopup({ title, text })
  }
  return (
    <div ref={ref} className={cls} {...rest}>
      {copyable && (
        <button type="button" title="Copy this section" aria-label="Copy this section"
          onClick={openCopy}
          style={{ position: 'absolute', top: 6, right: 8, zIndex: 5, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, lineHeight: 1, color: 'var(--color-text-sub)', background: 'transparent', border: '1px solid transparent', borderRadius: 8, padding: '3px 6px', opacity: .55 }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.borderColor = 'var(--glass-edge)' }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '.55'; e.currentTarget.style.borderColor = 'transparent' }}>
          ⧉
        </button>
      )}
      {children}
      {popup && <CopyPopup title={popup.title} text={popup.text} onClose={() => setPopup(null)} />}
    </div>
  )
}
