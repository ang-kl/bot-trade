// Switch — the canonical persistent-binary-state control (contract §1/7.2).
//
// A switch is NOT a command button: it communicates what is controlled, the
// present state, and what the next tap does. State colours are the app's
// ON/OFF pair (owner 2026-07-29): ON = blue tint, OFF = red tint — never
// up/down (those are P&L) and never the clay accent (that is navigation).
// The word rides with the colour ("colour is never the only cue"), so the
// default rendering is `<label> <ON|OFF>` inside one chip.
//
// This primitive is ADDITIVE in Phase C: the existing Toggle (Tune),
// MiniSwitch (sidebar) and PhaseSwitch (Tune card) keep working untouched;
// call sites migrate route-by-route in Phase E, preserving every confirm /
// typed-disarm flow — the confirm logic stays in the caller's onChange,
// exactly where it is today.
//
// `pending` marks an optimistic write in flight (aria-busy + dimmed), so a
// failed POST can no longer leave a checkbox silently lying about state
// (inventory T19). `inherited` renders the override dot the S.A.T. rows
// already use.
const STATE = {
  on: 'bg-[var(--color-state-on-bg)] text-[var(--color-state-on-text)] border-[var(--color-state-on-border)]',
  off: 'bg-[var(--color-state-off-bg)] text-[var(--color-state-off-text)] border-[var(--color-state-off-border)]',
}

export default function Switch({
  checked, onChange, label, onWord = 'ON', offWord = 'OFF',
  disabled = false, pending = false, inherited = false, title, className = '',
}) {
  const cls = [
    'inline-flex items-center gap-1 border font-semibold',
    'rounded-[var(--radius-control)] px-[4px] py-[2px] text-[9px] leading-none whitespace-nowrap',
    'transition-colors cursor-pointer',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    'focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-1',
    checked ? STATE.on : STATE.off,
    pending ? 'opacity-60' : '',
    className,
  ].filter(Boolean).join(' ')
  const word = checked ? onWord : offWord
  return (
    <button type="button" role="switch" aria-checked={!!checked}
      aria-label={label ? `${label}: ${word}` : undefined}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      title={title}
      onClick={() => onChange?.(!checked)}
      className={cls}>
      {label && <span>{label}</span>}
      <span>{word}</span>
      {inherited && <span aria-hidden="true" className="opacity-50" title="overridden — differs from the inherited default">•</span>}
    </button>
  )
}
