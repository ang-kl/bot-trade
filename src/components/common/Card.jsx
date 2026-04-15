// Surface container. Keep it plain — YAGNI: if a caller needs <section>
// or <article> they can wrap the Card themselves.

export default function Card({ children, padded = true, className = '' }) {
  const base = 'rounded border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-fg)]'
  const pad = padded ? 'p-4' : ''
  return <div className={`${base} ${pad} ${className}`.trim()}>{children}</div>
}
