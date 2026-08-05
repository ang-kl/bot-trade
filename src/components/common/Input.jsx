// Text input — Ultra Neo Glass inset field with neon focus ring.
//
// DENSITY VARIANTS (contract §6). `standard` is the historical full-size
// rendering (Connect's URL/secret fields). `compact` is the Field
// treatment — the fixed 76px box, 26px tall, 9px right-aligned — that
// every dense page uses. It lives HERE now so call sites stop re-fighting
// the standard classes with five `!important` utilities each; the
// `!`-prefixes below are still load-bearing where they beat rules outside
// the Tailwind layers (the unlayered `input { font-size: … !important }`
// in index.css, and `w-full` when a caller composes extra width classes),
// but they are declared ONCE, in the primitive, instead of at ~20 sites.
// `touchCompact` behaviour rides along: compact grows to the 44px HIG
// minimum on a phone-width screen via the element-level variant — see the
// cascade note in Field.jsx (an important declaration inside a layer beats
// any unlayered rule, so it must sit on the element's own class list).

const DENSITY = {
  standard: 'w-full px-3 py-2 text-[9px] min-h-[36px]',
  compact: '!w-[76px] !min-h-[26px] max-[430px]:!min-h-[44px] !py-0.5 !px-2 !text-[9px] text-right',
}

export default function Input({ value, onChange, type = 'text', density = 'standard', className = '', ...rest }) {
  const cls = [
    // Same --radius-control token as Button: a 12px-cornered field sitting
    // next to a 1px-cornered button is what made the styling look unfinished.
    'block rounded-[var(--radius-control)]',
    'glass-inset text-[var(--color-text)]',
    DENSITY[density] || DENSITY.standard,
    'placeholder:text-[var(--color-muted)]',
    'transition-shadow',
    'focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/50',
    'focus:border-[var(--color-accent)] focus:shadow-[var(--glow-accent)]',
    className,
  ].filter(Boolean).join(' ')
  return <input type={type} value={value} onChange={onChange} className={cls} {...rest} />
}
