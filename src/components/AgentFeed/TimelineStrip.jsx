// Horizontal lifecycle chips. LOST short-circuits to the LIVE index so
// "we opened and got stopped" still visually reaches the trading phase.

const SEQ = ['WATCHING', 'PENDING', 'LIVE', 'WON']

function indexFor(state) {
  if (state === 'LOST' || state === 'CANCELLED') return SEQ.indexOf('LIVE')
  return SEQ.indexOf(state)
}

export default function TimelineStrip({ state }) {
  const idx = indexFor(state)
  return (
    <ol className="flex gap-1 mb-1" aria-label="Story lifecycle">
      {SEQ.map((s, i) => {
        const active = i <= idx
        const cls = active
          ? 'border-[var(--color-up)] text-[var(--color-up)]'
          : 'border-[var(--color-border)] text-[var(--color-fg-subtle)]'
        return (
          <li key={s} className={`px-2 py-0.5 text-[10px] rounded border ${cls}`}>
            {s}
          </li>
        )
      })}
    </ol>
  )
}
