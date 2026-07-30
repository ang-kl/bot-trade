// account-phases.js — the three pipeline phases and the sidebar's off-summary.
//
// Owner (2026-07-30): "if I off any of these [Scan, Analyze, Autotrade] for
// that account, the side bar for that account should shows red, red, red dots
// (2px) beside the balance … the heading text of the side bar will be
// 'All off' / 'Scan off' / 'Analyze & Autotrade off' etc."
//
// Lives in lib/ rather than beside the component because a component module
// may only export components (react-refresh/only-export-components), and
// because the summary text is the one piece of real logic worth a test.

/**
 * The three phases in PIPELINE order — scan finds candidates, analyze judges
 * them, autotrade sends the order. Order matters in the summary text: it reads
 * as the pipeline, so "Scan off" tells you nothing downstream is even fed.
 */
// `initial` is NOT label[0]: Analyze and Autotrade both start with A, so
// deriving it from the label printed two identical letters next to each other
// and the dots became unreadable — the exact problem the letters were added to
// solve. T is for Trade.
export const PHASES = [
  { key: 'scan', label: 'Scan', initial: 'S' },
  { key: 'analyze', label: 'Analyze', initial: 'A' },
  { key: 'autotrade', label: 'Autotrade', initial: 'T' },
]

/**
 * "All off" when none of the three run, otherwise the off ones joined
 * ("Analyze & Autotrade off"), and null when everything is running — nothing
 * to warn about, so the heading stays "Account".
 *
 * A phase is only reported off when it is explicitly `false`. `undefined`
 * means "not known yet" (health has not answered), and claiming a phase is
 * off before knowing is worse than saying nothing.
 *
 * @param {{scan?: boolean, analyze?: boolean, autotrade?: boolean}|null|undefined} phases
 * @returns {string|null}
 */
export function offSummary(phases) {
  if (!phases) return null
  const off = PHASES.filter(p => phases[p.key] === false)
  if (off.length === 0) return null
  if (off.length === PHASES.length) return 'All off'
  return `${off.map(p => p.label).join(' & ')} off`
}
