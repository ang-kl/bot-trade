// SwitchingNote — "the numbers you are looking at are not this account's yet".
//
// Owner (2026-07-30): "when I switch the account the pages doesn't change in
// real time." useAccountSwitch now forces an immediate reload, but the broker
// round-trip is still seconds, and during those seconds the page is still
// painting the PREVIOUS account's figures. Saying so is the point: an unnamed
// wait reads as a hang, and unlabelled stale numbers read as truth.
export default function SwitchingNote({ to }) {
  if (!to) return null
  return (
    <div
      role="status"
      className="rounded-[6px] border px-2 py-1 text-(length:--fs-body) font-semibold
                 border-[var(--color-warning-border)]
                 bg-[var(--color-warning-bg)]
                 text-[var(--color-warning-text)]"
    >
      Switched to {to} — reloading. Figures below are still the previous account&apos;s.
    </div>
  )
}
