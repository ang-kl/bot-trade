// Status badge / pill - playbook 6.3.
// Pills (20px radius) for nav/level indicators.
// Flat labels (4px radius) for inline status.
// 9-11px font, nowrap, flex-shrink 0. No green.

const TONES = {
  neutral:  'bg-[var(--color-bg)] text-[var(--color-text)] border-[var(--color-border)]',
  up:       'bg-[var(--color-success-bg)] text-[var(--color-up)] border-[var(--color-success-border)]',
  down:     'bg-[var(--color-error-bg)] text-[var(--color-down)] border-[var(--color-error-border)]',
  info:     'bg-[var(--color-info-bg)] text-[var(--color-info-text)] border-[var(--color-info-border)]',
  warning:  'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border-[var(--color-warning-border)]',
  special:  'bg-[var(--color-special-bg)] text-[var(--color-special-text)] border-[var(--color-special-border)]',
}

export default function Badge({ children, tone = 'neutral', pill = false, className = '' }) {
  const radius = pill ? 'rounded-full' : 'rounded-[4px]'
  const pad = pill ? 'px-2.5 py-0.5' : 'px-1.5 py-0.5'
  const cls = [
    'inline-flex items-center gap-1 border font-semibold',
    'text-[10px] leading-none whitespace-nowrap shrink-0',
    radius, pad,
    TONES[tone] || TONES.neutral,
    className,
  ].filter(Boolean).join(' ')
  return <span className={cls}>{children}</span>
}
