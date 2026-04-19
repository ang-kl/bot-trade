// Horizontal lifecycle chips. LOST short-circuits to the LIVE index so
// "opened and got stopped" still visually reaches the trading phase.

const SEQ = ['WATCHING', 'PENDING', 'LIVE', 'WON']

function indexFor(state) {
  if (state === 'LOST' || state === 'CANCELLED') return SEQ.indexOf('LIVE')
  return SEQ.indexOf(state)
}

export default function TimelineStrip({ state }) {
  const idx = indexFor(state)
  return (
    <ol className="flex gap-1 mb-1 overflow-x-auto" aria-label="Story lifecycle">
      {SEQ.map((s, i) => {
        const active = i <= idx
        const cls = active
          ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-soft)]'
          : 'border-[var(--color-border)] text-[var(--color-muted)]'
        return (
          <li key={s} className={`px-2 py-0.5 text-[10px] font-semibold rounded-[4px] border whitespace-nowrap shrink-0 ${cls}`}>
            {s}
          </li>
        )
      })}
    </ol>
  )
}
