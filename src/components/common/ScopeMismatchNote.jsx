// "You are trading X but editing Y" — the note that closes the last gap in the
// owner's report (02-08-2026): "each sub-page doesn't tie to the account
// selected and flash which account I am looking or capabie of edit".
//
// WHY THIS IS A NOTE AND NOT AN AUTOMATIC RE-SCOPE.
//
// Tune's Watchlist tab and the Risk page each edit one of two things: the
// SHARED/GLOBAL config, or ONE account's own. Both are real editing targets —
// "Shared" is not a filter meaning "no account", it is the list every
// inheriting account actually trades. So moving the scope pill for the owner
// when the selected account changes would silently redirect an edit: they
// would open the page to change the shared watchlist, switch account in the
// sidebar for an unrelated reason, and the next save would fork an account
// off the shared list instead.
//
// Reloading the DATA on a switch is uncontroversial and those pages now do it.
// Moving what a save will WRITE TO is not, so it takes a click, and the click
// says exactly what it will do.
import { useEffect, useState } from 'react'
import { selectedAccountId, accountLabel, onAccountSwitch } from '../../lib/selected-account.js'

/**
 * @param {string} scope        the page's current editing scope ('all' | accountId)
 * @param {(id: string) => void} onUse   switch the page's scope to the traded account
 * @param {string} sharedLabel  what 'all' means HERE — "the shared watchlist",
 *   "the global risk config". Never just "All": the word has to name the thing
 *   that gets written.
 */
export default function ScopeMismatchNote({ scope, onUse, sharedLabel }) {
  const [selected, setSelected] = useState(() => selectedAccountId())

  // Follow the global switch live, so the note appears the moment the owner
  // changes account elsewhere rather than on the next page load.
  useEffect(() => {
    const off = onAccountSwitch((ev) => setSelected(ev?.to ?? selectedAccountId()))
    return off
  }, [])

  if (selected == null || selected === '') return null
  const sel = String(selected)
  if (String(scope) === sel) return null

  const editing = scope === 'all' || !scope ? sharedLabel : `account ${scope}`
  return (
    <div className="text-(length:--fs-body) rounded-[6px] border border-[var(--md-outline-variant)] px-2 py-1 flex flex-wrap items-center gap-2">
      <span>
        The bot is trading <strong>{accountLabel(sel) || sel}</strong>, but you are editing{' '}
        <strong>{editing}</strong>.
      </span>
      <button
        type="button"
        onClick={() => onUse(sel)}
        className="rounded-full border border-[var(--md-outline-variant)] px-2 py-0.5 cursor-pointer"
      >
        Edit {accountLabel(sel) || sel} instead
      </button>
    </div>
  )
}
