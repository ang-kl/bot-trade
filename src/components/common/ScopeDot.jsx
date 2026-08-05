// ScopeDot — the small coloured circle the owner asked for, beside every
// card and table that renders account-dependent data.
//
// Owner, 2026-08-03: "there is a colour-code small circle that tied to
// side-bar to each page and each components in the page".
//
// FOUR STATES, decided by the owner the same day:
//
//   blue   scoped, and the data matches the claim
//   grey   global or portfolio — account-independent BY DECLARATION
//   amber  renders account data with no scope, or scoped below 100%
//   red    declared a scope and the fetch failed
//
// Blue rather than green is not a style choice: the owner is red/green
// colour-blind, and `npm run check:no-green` fails the build on green tokens.
//
// AMBER AND RED ALWAYS CARRY A REASON. A dot without a reason is a mood. The
// reason is in the tooltip and, when `showReason` is set, printed beside the
// dot — because the sentence that would actually have caught the Go-Live card
// was "87% of 253 rows attributable", not a colour.
//
// Colour is never the ONLY channel. Each state also has a distinct glyph, so
// the dot survives greyscale, colour-blindness and a bad monitor.

const TONE = {
  blue: {
    dot: 'var(--color-info-text)',
    ring: 'var(--color-info-border)',
    glyph: '●',
    label: 'Scoped to this account',
  },
  grey: {
    dot: 'var(--color-text-sub)',
    ring: 'var(--color-border)',
    glyph: '◍',
    label: 'Account-independent by declaration',
  },
  amber: {
    dot: 'var(--color-warning-text)',
    ring: 'var(--color-warning-border)',
    glyph: '◐',
    label: 'Partly or not attributable',
  },
  red: {
    // --color-down is the repo's ONE red token (#e11d48 light / #ff4d6d dark).
    // Inventing a --color-danger-* here with a hardcoded fallback would be a
    // second source of truth for the same colour, which is the defect class
    // this whole workstream exists to remove.
    dot: 'var(--color-down)',
    ring: 'var(--color-down)',
    glyph: '◌',
    label: 'Declared a scope and could not load',
  },
}

/**
 * @param {{ scope: object, showReason?: boolean, className?: string }} props
 *   scope — whatever useAccountScope / deriveScopeState returned.
 */
export default function ScopeDot({ scope, showReason = false, className = '' }) {
  if (!scope) return null
  const t = TONE[scope.tone] || TONE.amber
  // The tooltip always names the component id. When the register (S5) reports
  // "perf.strategy-matrix rendered unscoped", the operator has to be able to
  // find it on the screen without grepping.
  const title = [
    t.label,
    scope.reason ? `— ${scope.reason}` : null,
    scope.accountId ? `\nAccount: ${scope.accountId}` : null,
    `\n(${scope.id} · mode: ${scope.mode})`,
  ].filter(Boolean).join(' ')

  return (
    <span className={`inline-flex items-center gap-1 align-middle ${className}`} title={title}>
      {/* THE GLYPH IS THE DOT. Colour is never the only channel: filled,
          ringed, half and hollow are four distinguishable SHAPES, so the state
          survives greyscale, a bad monitor, and the colour-blindness the
          repo's no-green gate already exists for. */}
      <span
        aria-hidden="true"
        style={{ color: t.dot, fontSize: 10, lineHeight: 1 }}
      >{t.glyph}</span>
      {/* The screen reader gets the whole sentence, not a decorative circle. */}
      <span className="sr-only">{title}</span>
      {showReason && scope.reason && (
        <span className="text-(length:--fs-body) text-[var(--color-text-sub)] whitespace-nowrap">
          {scope.reason}
        </span>
      )}
    </span>
  )
}

export { TONE as SCOPE_DOT_TONES }
