// Advanced — a disclosure for settings that are real but rarely touched.
//
// Owner, 04-08-2026: "i find the RISK page becomes complicated."
//
// The honesty rules live in src/lib/risk-view.js and are enforced here:
//   · the header always says how many settings are inside,
//   · it says how many differ from the shipped default, so nothing surprising
//     can hide behind a collapsed panel,
//   · an UNSAVED edit forces the group open — you can never be one collapsed
//     header away from losing work you thought you had made.
import { useState } from 'react'
import { groupOpen, groupSummary } from '../../lib/risk-view.js'

export default function Advanced({ label = 'Advanced', total = 0, changed = 0, dirty = false, mode, children }) {
  const [userOpen, setUserOpen] = useState(false)
  const open = groupOpen({ mode, userOpen, dirty })
  // Forced open (by mode or by a dirty edit) means the toggle would lie, so it
  // renders as a plain header instead of a button that appears not to work.
  const forced = open && !userOpen
  const summary = groupSummary({ total, changed, dirty })

  return (
    <div className="mt-1.5 border-t border-[var(--color-border)] pt-1.5">
      <button
        type="button"
        onClick={() => setUserOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-(length:--fs-body) text-[var(--color-text-sub)] cursor-pointer hover:text-[var(--color-text)]"
      >
        <span aria-hidden="true" className="inline-block w-3">{open ? '▾' : '▸'}</span>
        <span className="font-semibold">{label}</span>
        <span className={changed > 0 || dirty ? 'font-semibold text-[var(--color-text)]' : ''}>{summary}</span>
        {forced && <span className="ml-auto">{dirty ? 'open — unsaved' : 'shown in Everything'}</span>}
      </button>
      {open && <div className="mt-1.5 space-y-2">{children}</div>}
    </div>
  )
}
