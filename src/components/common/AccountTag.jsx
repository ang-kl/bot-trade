// AccountTag — "these numbers belong to THIS account", said next to the table.
//
// Owner (2026-07-30): "the pages are not link to the side bar, I still cannot
// know which account I am trading in the page — can you state on the beside of
// the 'Open positions' table."
//
// The sidebar states the account once, at the top; a table halfway down a long
// page is far from it, and on a phone the sidebar is not even on screen. So the
// tag goes beside the heading that owns the rows.
//
// It prefers the accountId the ROUTE reported over the client's own idea of
// which account is selected. Those can disagree for a second or two after a
// switch, and during exactly those seconds the honest label is the one that
// describes the rows actually being drawn.
import { accountLabel, selectedAccountId } from '../../lib/selected-account.js'

/**
 * @param {{accountId?: string|number|null, legacyRows?: number, className?: string}} props
 *   accountId — from the route payload (`'all'` for a portfolio read). Falls
 *   back to the client's selected account when the route did not say.
 *   legacyRows — rows INCLUDED here that carry no account_id, so they count for
 *   every account rather than any one of them. Shown because a number that
 *   includes unattributable rows should say so.
 */
export default function AccountTag({ accountId, legacyRows = 0, className = '' }) {
  const id = accountId ?? selectedAccountId()
  if (id == null) return null
  const all = String(id) === 'all'
  const label = all ? 'All accounts' : accountLabel(String(id))
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-[1px]
                  text-(length:--fs-body) font-semibold tabular-nums whitespace-nowrap
                  border-[var(--color-border)] text-[var(--color-text-sub)] ${className}`}
      title={all
        ? 'Every enabled account — not one account'
        : 'Every row in this table belongs to this account'}
    >
      {label}
      {legacyRows > 0 && (
        <span
          className="text-[var(--color-warning-text)]"
          title={`Includes ${legacyRows} row(s) that carry no account — they predate account stamping, so they count for every account rather than any one of them.`}
        >
          +{legacyRows}?
        </span>
      )}
    </span>
  )
}
