// Button — restrained, professional, neutral by default.
//
// Owner 2026-07-28, with a Claude-app screenshot as the reference: "the
// button gaps between the border and the text is too much space; be only 2
// px spacing between the border of the button. It should have professional.
// I think it should not be blue."
//
// Two things changed from the old Ultra-Neo-Glass treatment:
//
// 1. PADDING is a literal 2px on every side, and the min-height is gone.
//    A min-height taller than the content is exactly the "too much space"
//    being complained about — it holds the box open and floats the label in
//    the middle, so trimming padding alone would have changed nothing.
//
// 2. COLOUR is neutral. The reference has a light glass surface, a hairline
//    border and dark text, with a single accent reserved for the one true
//    primary action. A saturated blue-to-purple gradient with a glow on
//    every ordinary button is what read as unprofessional. `primary` is now
//    that neutral surface; `accent` exists for the rare commit action; and
//    `danger` keeps colour, because destructive really does need signalling
//    — but flat, without the gradient and glow.
const VARIANTS = {
  // The default: reads as a control, not an advertisement.
  primary: [
    'glass-inset text-[var(--color-text)]',
    'hover:border-[var(--color-accent)]',
  ].join(' '),
  // Opt-in emphasis — use sparingly, ideally once per view.
  accent: [
    'border-[var(--color-accent)] text-[var(--color-accent)]',
    'bg-[var(--color-accent-soft)] hover:brightness-105',
  ].join(' '),
  danger: [
    'border-[var(--color-down)] text-[var(--color-down)]',
    'bg-transparent hover:bg-[color-mix(in_srgb,var(--color-down)_12%,transparent)]',
  ].join(' '),
  ghost: [
    'glass-inset text-[var(--color-text)]',
    'hover:border-[var(--color-accent)]',
  ].join(' '),
  subtle: [
    'glass-inset text-[var(--color-text-sub)]',
    'hover:text-[var(--color-text)] hover:border-[var(--color-accent)]',
  ].join(' '),
}

// 2px on every side, per the owner. Sizes differ only in type size now —
// the padding is the same everywhere because "2px" was not size-dependent.
const SIZES = {
  sm: 'p-[2px] text-[9px]',
  md: 'p-[2px] text-[9px]',
  lg: 'p-[2px] text-[11px]',
}

export default function Button({ children, variant = 'primary', size = 'md', className = '', ...rest }) {
  const cls = [
    'inline-flex items-center justify-center gap-1',
    // Shared 1px corner token — see --radius-control in index.css.
    'rounded-[var(--radius-control)] border font-semibold',
    // transform-gpu isolate: own compositing layer — iOS Safari ghost-paints
    // gradient/glow elements at stale positions on reflow (owner saw a blue
    // smear behind the "Saved" state; same family as the Badge/slider fixes).
    'transition-colors cursor-pointer transform-gpu isolate',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    'focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/50',
    'active:scale-[0.98]',
    VARIANTS[variant] || VARIANTS.primary,
    SIZES[size] || SIZES.md,
    className,
  ].filter(Boolean).join(' ')
  return <button type="button" {...rest} className={cls}>{children}</button>
}
