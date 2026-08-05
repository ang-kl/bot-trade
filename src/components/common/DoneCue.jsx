// DoneCue — one confirmation, used everywhere, so "did that work?" is never a
// question the owner has to answer by hunting for a changed number.
//
// Owner (2026-07-30): "Apply 13 selected > if done, show 'done' visual cue and
// reset the checkboxes. Same effect for watchlist checkbox. Audit your visual
// cue."
//
// The audit found three different habits across the app: a `saving x…` badge
// (Risk), a persistent "last saved" line (Tune), and — for the bulk
// select-and-act flows — NOTHING: the ticks cleared and the row vanished, which
// is indistinguishable from a misclick. This component is the single answer for
// the third case.
//
// COLOUR. Blue on a blue tint, from --color-state-on-*. NOT green: the owner's
// rule reserves green ("use green or system accent colors sparingly"), and
// `npm run check:no-green` fails the build on green tokens, so a green success
// cue could not ship even if it were wanted. Not the clay accent either — that
// marks navigation and section titles, so a cue in accent reads as "you are
// here" rather than "that worked".
//
// role="status" announces it to a screen reader without stealing focus, which
// matters because the cue appears after a click that has already moved on.
export default function DoneCue({ message, className = '' }) {
  if (!message) return null
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-[1px]
                  text-(length:--fs-body) font-semibold whitespace-nowrap
                  border-[var(--color-state-on-border)]
                  bg-[var(--color-state-on-bg)]
                  text-[var(--color-state-on-text)] ${className}`}
    >
      <span aria-hidden="true">✓</span>{message}
    </span>
  )
}
