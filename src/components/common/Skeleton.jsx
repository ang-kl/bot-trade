// Skeleton loading placeholder (owner polish audit, 2026-07-25: "skeleton
// states instead of spinners") — shimmer lines shaped roughly like the
// content they stand in for, replacing the bare "Loading…" text scattered
// across the pages. Static tint under prefers-reduced-motion (index.css).
export default function Skeleton({ lines = 3, height = 12, className = '', style = {} }) {
  return (
    <div className={className} style={style} role="status" aria-label="loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton"
          style={{ height, marginTop: i ? 7 : 0, width: `${100 - (i % 3) * 14}%` }} />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  )
}
