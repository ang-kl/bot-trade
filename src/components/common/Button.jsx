// Button - playbook 6.1 interactive states.
// Blue = primary/BUY, red = danger/SELL, ghost = neutral.
// Min 36px touch target height. Always visible, never hover-only.

const VARIANTS = {
  primary: 'bg-[var(--color-accent)] text-white border-transparent hover:opacity-90',
  ghost:   'bg-transparent text-[var(--color-text)] border-[var(--color-border)] hover:bg-[var(--color-accent-soft)] hover:border-[var(--color-accent)]',
  danger:  'bg-[var(--color-down)] text-white border-transparent hover:opacity-90',
  subtle:  'bg-[var(--color-bg)] text-[var(--color-text-sub)] border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]',
}

const SIZES = {
  sm: 'px-2 py-1 text-[12px] min-h-[36px]',
  md: 'px-3 py-1.5 text-[13px] min-h-[36px]',
  lg: 'px-4 py-2 text-[14px] min-h-[40px]',
}

export default function Button({ children, variant = 'primary', size = 'md', className = '', ...rest }) {
  const cls = [
    'inline-flex items-center justify-center gap-1',
    'rounded-[7px] border font-semibold',
    'transition-colors cursor-pointer',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    'focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40',
    VARIANTS[variant] || VARIANTS.primary,
    SIZES[size] || SIZES.md,
    className,
  ].filter(Boolean).join(' ')
  return <button type="button" {...rest} className={cls}>{children}</button>
}
