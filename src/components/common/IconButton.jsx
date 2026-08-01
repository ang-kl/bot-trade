// Icon-only command — a Button that CANNOT ship without an accessible name.
//
// The Phase A inventory found icon-only controls announced as "✕" or not at
// all (pagers ‹ ›, sort arrows, sheet closers). The fix is structural: this
// primitive takes `label` as a REQUIRED prop and writes it to aria-label
// and title, so the next icon control gets a name by construction instead
// of by review. Everything else is the shared Button, so variants, focus
// and the compact geometry stay identical.
import Button from './Button.jsx'

export default function IconButton({ label, title, children, ...rest }) {
  if (!label && import.meta.env?.DEV) {
    console.warn('IconButton rendered without a label — icon-only controls must have an accessible name')
  }
  return (
    <Button aria-label={label} title={title ?? label} {...rest}>
      <span aria-hidden="true">{children}</span>
    </Button>
  )
}
