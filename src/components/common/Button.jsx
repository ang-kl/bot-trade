// Button — 3 visual variants, 3 sizes. Blue = primary/BUY, red = danger/SELL.
// Extra DOM props (disabled, type, aria-*, onClick, ...) flow through ...rest.

const VARIANTS = {
  primary: 'bg-[var(--color-up)] text-white border-transparent hover:opacity-90',
  ghost:   'bg-transparent text-[var(--color-fg)] border-[var(--color-border)] hover:bg-[var(--color-surface)]',
  danger:  'bg-[var(--color-down)] text-white border-transparent hover:opacity-90',
}

const SIZES = {
  sm: 'px-2 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
  lg: 'px-4 py-2 text-base',
}

export default function Button({ children, variant = 'primary', size = 'md', className = '', ...rest }) {
  const cls =
    `inline-flex items-center justify-center gap-1 rounded border font-medium transition-opacity ` +
    `disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[var(--color-up)]/40 ` +
    `${VARIANTS[variant] || VARIANTS.primary} ${SIZES[size] || SIZES.md} ${className}`
  return <button type="button" {...rest} className={cls.trim()}>{children}</button>
}
