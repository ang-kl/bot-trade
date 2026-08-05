// Segmented — the canonical single-choice group (contract §1/7.3), now a
// REAL M3 segmented button (owner, 02-08-2026: "why does the buttons look so
// horrible and not standards"). What M3 actually specifies — and what the
// first tonal pass missed — is the SHAPE: one connected container, equal
// 40px-tall segments sharing 1px dividers, fully rounded only at the group
// ends, ✓ on the selected segment, tonal secondary-container fill. The prior
// look (independent oval capsules, tiny text lost inside a 48px blob) came
// from recolouring the legacy pills instead of rebuilding them; this file is
// the rebuild, and every call site inherits it.
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
  const seg = (selected, i) => [
    // Connected group: dividers between segments, rounding on the ends only.
    'inline-flex items-center justify-center gap-1 whitespace-nowrap font-semibold',
    size === 'lg' ? 'px-3 text-[9px] h-[40px]' : 'px-2.5 text-[9px] h-[32px]',
    'min-w-[48px] transition-colors duration-150 cursor-pointer',
    i > 0 ? 'border-l border-[var(--md-outline-variant)]' : '',
    i === 0 ? 'rounded-l-full' : '',
    i === options.length - 1 ? 'rounded-r-full' : '',
    'focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:-outline-offset-2',
    selected
      ? 'bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)]'
      : 'bg-transparent text-[var(--md-on-surface)] hover:bg-[var(--color-accent-soft)]',
  ].join(' ')
  // OVERFLOW IS THE COMPONENT'S PROBLEM, NOT THE CALLER'S (owner, iPhone
  // screenshot 2026-08-03: Desk › "Your edge — backtest baseline" — the
  // twelve-strategy strip ran off the right edge of the phone and out of its
  // own card).
  //
  // The group is an inline-flex of min-w-[48px] whitespace-nowrap segments, so
  // twelve of them are ~600px wide before padding — wider than any phone. With
  // nothing to scroll in, that width became PAGE overflow: the strip escaped
  // the card and the body scrolled sideways.
  //
  // Fixed here rather than at the call site. A caller cannot know how many
  // options it will have next month, and the last three times this shape
  // appeared it was fixed once per page — which is how the fourth page ships
  // broken. The wrapper is max-w-full + overflow-x-auto, so the strip scrolls
  // INSIDE its own bounds and the page never does.
  //
  // overflow-hidden stays on the GROUP: it is what clips the segment fills to
  // the rounded ends. The scroll lives on the wrapper outside it.
  return (
    <div className="max-w-full overflow-x-auto overscroll-x-contain">
    <div role="radiogroup" aria-label={label}
      className={`inline-flex items-stretch overflow-hidden rounded-full border border-[var(--md-outline-variant)] ${className}`}>
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
          className={seg(o.value === value, i)}>
          {o.value === value && <span aria-hidden="true">✓</span>}
          {o.label}
        </button>
      ))}
    </div>
    </div>
  )
}
