// Inline pill. `tone` follows the red/blue semantic pair — no green.
// Use 'up' for long/positive/BUY, 'down' for short/negative/SELL,
// and 'neutral' for everything else.

const TONES = {
  neutral: 'bg-[var(--color-surface)] text-[var(--color-fg)] border-[var(--color-border)]',
  up:      'bg-[var(--color-up)]/10 text-[var(--color-up)] border-[var(--color-up)]/30',
  down:    'bg-[var(--color-down)]/10 text-[var(--color-down)] border-[var(--color-down)]/30',
}

const SIZES = {
  sm: 'px-1.5 py-0 text-[10px]',
  md: 'px-2 py-0.5 text-xs',
}

export default function Badge({ children, tone = 'neutral', size = 'sm', className = '' }) {
  const cls = `inline-flex items-center gap-1 rounded-full border font-medium ${TONES[tone] || TONES.neutral} ${SIZES[size] || SIZES.sm} ${className}`
  return <span className={cls.trim()}>{children}</span>
}
