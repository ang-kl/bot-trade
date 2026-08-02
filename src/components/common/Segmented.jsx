// Segmented — the canonical single-choice group (contract §1/7.3).
//
// The Phase A inventory counted seven segmented-control variants at four
// aria-conformance levels. This is the one shape they converge on: a real
// radiogroup with roving tabindex and arrow keys (the pattern FolioTabs
// already implements for tabs), compact 1px-radius chips, selection in the
// accent — which ui-spec §3 sanctions for "active pills" — never in
// up/down, and `--color-on-accent` (not a hard-coded #fff) on the fill.
//
// options: [{ value, label, title? }] · value: current · onChange(value)
import { useRef } from 'react'

export default function Segmented({ options, value, onChange, label, size = 'md', className = '' }) {
  const refs = useRef([])
  const idx = Math.max(0, options.findIndex(o => o.value === value))
  const move = (d) => {
    const next = (idx + d + options.length) % options.length
    onChange?.(options[next].value)
    refs.current[next]?.focus()
  }
  const chip = (selected) => [
    'border font-semibold rounded-[var(--radius-control)] whitespace-nowrap',
    size === 'lg' ? 'px-2.5 py-1 text-[11px]' : 'px-1.5 py-0.5 text-[9px]',
    'transition-colors cursor-pointer',
    'focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-1',
    // M3 conformance (owner task, 02-08-2026): selection is the TONAL
    // secondary-container + ✓, never the saturated accent fill — that stays
    // reserved for real actions.
    selected
      ? 'bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)] border-transparent'
      : 'bg-transparent text-[var(--md-on-surface)] border-[var(--md-outline-variant)] hover:border-[var(--color-accent)]',
  ].join(' ')
  return (
    <div role="radiogroup" aria-label={label} className={`inline-flex items-center gap-1 ${className}`}>
      {options.map((o, i) => (
        <button key={String(o.value)} type="button" role="radio"
          ref={el => { refs.current[i] = el }}
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          title={o.title}
          onClick={() => onChange?.(o.value)}
          onKeyDown={e => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1) }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
          }}
          className={chip(o.value === value)}>
          {o.value === value ? '✓ ' : ''}{o.label}
        </button>
      ))}
    </div>
  )
}
