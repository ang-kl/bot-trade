// Vocabulary for the account traffic lights (A4). Split out of the component
// so the component file exports only components, and so the label/colour map
// has one home shared by the row and any future surface that shows the same
// four lights.
export const LIGHT_LABEL = { link: 'Link', scan: 'Scan', enter: 'Enter', manage: 'Manage' }
export const LIGHT_ORDER = ['link', 'scan', 'enter', 'manage']

// UNKNOWN is muted AND drawn hollow by the component. Two channels, because a
// green-vs-grey difference alone is exactly the distinction someone reading a
// screenshot or with low colour vision would miss.
export const LIGHT_COLOR = {
  red: 'var(--color-down)',
  amber: 'var(--color-warning-text)',
  green: 'var(--color-state-on-text)',
  unknown: 'var(--color-muted)',
}
