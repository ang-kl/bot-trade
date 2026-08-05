// Status badge / pill — Ultra Neo Glass: frosted micro-pills with a soft
// neon tint. 9-11px font, nowrap, flex-shrink 0. No green.
//
// Tone vocabulary: up/down = PROFIT and LOSS. on/off = STATE (armed,
// enabled, open). info/warning/special = classification. Reaching for
// up/down to mean "enabled" is the mistake this split exists to stop.

const TONES = {
  neutral:  'bg-[var(--glass-bg)] text-[var(--color-text)] border-[var(--glass-edge)]',
  up:       'bg-[var(--color-success-bg)] text-[var(--color-up)] border-[var(--color-success-border)] shadow-[0_0_10px_var(--color-success-bg)]',
  down:     'bg-[var(--color-error-bg)] text-[var(--color-down)] border-[var(--color-error-border)] shadow-[0_0_10px_var(--color-error-bg)]',
  info:     'bg-[var(--color-info-bg)] text-[var(--color-info-text)] border-[var(--color-info-border)]',
  warning:  'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border-[var(--color-warning-border)]',
  special:  'bg-[var(--color-special-bg)] text-[var(--color-special-text)] border-[var(--color-special-border)]',
  // ON / OFF STATE (owner 2026-07-29): "positive / ON ... blue with the
  // blueish-tint background ... negative or OFF ... red with redish-tint
  // background." Separate from up/down on purpose — up/down mean profit and
  // loss, and an armed toggle is not a profit. OFF is deliberately RED, not
  // neutral grey: several tables used to render a disarmed strategy in the
  // same muted grey as "no data", so "off" and "unknown" looked identical.
  on:       'bg-[var(--color-state-on-bg)] text-[var(--color-state-on-text)] border-[var(--color-state-on-border)]',
  off:      'bg-[var(--color-state-off-bg)] text-[var(--color-state-off-text)] border-[var(--color-state-off-border)]',
}

export default function Badge({ children, tone = 'neutral', pill = false, className = '' }) {
  const radius = pill ? 'rounded-[1px]' : 'rounded-[6px]' // owner 2026-07-28: pills are 1px-corner rectangles, not ovals
  const pad = pill ? 'px-2.5 py-0.5' : 'px-1.5 py-0.5'
  const cls = [
    'inline-flex items-center gap-1 border font-semibold',
    // transform-gpu + isolate force the pill onto its own compositing
    // layer: iOS Safari ghost-paints backdrop-filter elements at stale
    // positions on reflow (the pill was seen painted OVER neighbouring
    // text in a wrapped flex row) — an own layer pins it in place.
    'backdrop-blur-sm transform-gpu isolate',
    'text-(length:--fs-body) leading-none whitespace-nowrap shrink-0',
    radius, pad,
    TONES[tone] || TONES.neutral,
    className,
  ].filter(Boolean).join(' ')
  return <span className={cls}>{children}</span>
}
