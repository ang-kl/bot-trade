// Disclosure — the canonical ▸/▾ expand control (contract §1/7.5, ui-spec §6).
//
// The inventory found four incompatible row-disclosure idioms, two of them
// keyboard-dead (`<tr onClick>`, `<div onClick>`). This is the one shape:
// a real <button> (native Enter/Space), aria-expanded, ▸ collapsed / ▾
// expanded, one line, no border — visually the pattern the app already
// uses, structurally always operable. `as`/`className` let it render as a
// full row, a heading or an inline caret without forking the semantics.
export default function Disclosure({ open, onToggle, children, label, className = '', ...rest }) {
  return (
    <button type="button" aria-expanded={!!open}
      aria-label={label}
      onClick={onToggle}
      className={[
        'cursor-pointer text-left bg-transparent border-0 p-0 font-inherit text-inherit',
        'focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-1',
        className,
      ].join(' ')}
      {...rest}>
      <span aria-hidden="true" className="inline-block w-[14px] shrink-0">{open ? '▾' : '▸'}</span>
      {children}
    </button>
  )
}
