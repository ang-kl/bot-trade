// PhaseDots — three traffic lights, one per pipeline phase: blue on, red off.
//
// Owner (2026-07-30): "if I off any of these [Scan, Analyze, Autotrade] for
// that account, the side bar for that account should shows red, red, red dots
// (2px) beside the balance in the side bar."
//
// Extracted from ActiveAccountHeader so the sidebar's ACCOUNT LIST can draw the
// same lights per row. It could not before: the three flags were global, so a
// dot beside account B would have been showing account A's state. Since the
// per-account switches shipped (services/account-phases.js) every row has its
// own answer and the lights are truthful wherever they appear.
//
// SIZE OVERRIDES THE 2px SPEC, and the owner is the reason. They asked for 2px
// dots, then reported "I cannot see the traffic lights of the 3 independent
// Scan/Analyze/Autotrade." A 2px dot is about one device pixel after this app's
// 1.1 zoom — smaller than the anti-aliasing around it, so it renders as a
// smudge or as nothing at all. These are 6px with a ring: still a status light
// rather than a badge, but actually visible. The initial (S / A / T) rides
// alongside so the three are distinguishable without a hover, which a bare dot
// can never be on a touch screen.
import { PHASES } from '../../lib/account-phases.js'

export default function PhaseDots({ phases, className = '', letters = true, who = '' }) {
  if (!phases) return null
  const suffix = who ? ` on ${who}` : ''
  return (
    <span className={`inline-flex items-center gap-[3px] ${className}`}>
      {PHASES.map(p => {
        const on = phases[p.key] === true
        const colour = on ? 'var(--color-state-on-text)' : 'var(--color-state-off-text)'
        return (
          <span
            key={p.key}
            aria-label={`${p.label} ${on ? 'on' : 'off'}${suffix}`}
            title={`${p.label} is ${on ? 'ON' : 'OFF'}${suffix}`}
            className="inline-flex items-center gap-[1px] text-(length:--fs-body) font-bold leading-none"
            style={{ color: colour }}
          >
            <span
              aria-hidden="true"
              className="inline-block h-[6px] w-[6px] shrink-0 rounded-full"
              style={{ background: colour, boxShadow: `0 0 0 1px ${colour}` }}
            />
            {letters && p.initial}
          </span>
        )
      })}
    </span>
  )
}
