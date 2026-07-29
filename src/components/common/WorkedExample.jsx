// UI-5 — the renderer for src/lib/worked-examples.js.
//
// Collapsed by default: the worked example is for the reading you do ONCE,
// when deciding what a setting should be. Leaving five sentences open under
// every control would push the controls themselves off the screen, which is
// the problem UI-4 just finished fixing.
//
// Renders nothing at all when the builder returned null — an absent example
// is the honest output when a number the example needs is missing.
import { useState } from 'react'

export default function WorkedExample({ lines, label = 'Example' }) {
  const [open, setOpen] = useState(false)
  if (!Array.isArray(lines) || !lines.length) return null
  return (
    <div className="w-full text-[9px]">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="cursor-pointer text-[var(--color-accent)] hover:underline font-semibold">
        {open ? '▾' : '▸'} {label}
      </button>
      {open && (
        <ol className="mt-1 ml-3 list-decimal space-y-0.5 text-[var(--color-text-sub)] tabular-nums">
          {lines.map((l, i) => <li key={i}>{l}</li>)}
        </ol>
      )}
    </div>
  )
}
