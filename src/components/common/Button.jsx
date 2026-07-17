// Button — Ultra Neo Glass interactive states.
// Neon blue = primary/BUY, neon red = danger/SELL, glass = neutral.
// Min 36px touch target height. Always visible, never hover-only.

const VARIANTS = {
  primary: [
    'text-white border-transparent',
    'bg-[linear-gradient(135deg,var(--color-accent),color-mix(in_srgb,var(--color-accent)_65%,#a855f7))]',
    'shadow-[var(--glow-accent)] hover:brightness-110',
  ].join(' '),
  danger: [
    'text-white border-transparent',
    'bg-[linear-gradient(135deg,var(--color-down),color-mix(in_srgb,var(--color-down)_70%,#f472b6))]',
    'shadow-[var(--glow-down)] hover:brightness-110',
  ].join(' '),
  ghost: [
    'glass-inset text-[var(--color-text)]',
    'hover:border-[var(--color-accent)] hover:shadow-[var(--glow-accent)]',
  ].join(' '),
  subtle: [
    'glass-inset text-[var(--color-text-sub)]',
    'hover:text-[var(--color-text)] hover:border-[var(--color-accent)]',
  ].join(' '),
}

const SIZES = {
  sm: 'px-2.5 py-1 text-[12px] min-h-[36px]',
  md: 'px-3.5 py-1.5 text-[13px] min-h-[36px]',
  lg: 'px-5 py-2 text-[14px] min-h-[40px]',
}

export default function Button({ children, variant = 'primary', size = 'md', className = '', ...rest }) {
  const cls = [
    'inline-flex items-center justify-center gap-1',
    'rounded-full border font-semibold',
    // transform-gpu isolate: own compositing layer — iOS Safari ghost-paints
    // gradient/glow elements at stale positions on reflow (owner saw a blue
    // smear behind the "Saved" state; same family as the Badge/slider fixes).
    'transition-all cursor-pointer transform-gpu isolate',
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none',
    'focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/50',
    'active:scale-[0.98]',
    VARIANTS[variant] || VARIANTS.primary,
    SIZES[size] || SIZES.md,
    className,
  ].filter(Boolean).join(' ')
  return <button type="button" {...rest} className={cls}>{children}</button>
}
