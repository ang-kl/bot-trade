// ScopeChip — every card says WHOSE numbers it is showing.
//
// Owner, 05-08-2026: "Doesn't show the user which account it is looking at or
// looking at the summary. We keep having the problem of understanding the
// page: whether we are looking at a specific account or the summary."
//
// The chip sits in the card's top-right chrome, beside ⧉ / ▾ / ⇲, so it is in
// the same place on every card. Three states (see lib/scope-label.js) and the
// third is what makes the other two trustworthy: a card with no chip used to
// mean either "applies to every account" or "nobody labelled this", and a
// reader who cannot tell those apart cannot trust the labels that ARE there.
//
// PINNED. A card may legitimately show a different account from the rest of
// the page — comparing two accounts on Tune is a real thing to do. When that
// happens the chip says so rather than letting the difference be silent,
// because a silent difference is exactly the screenshot the owner sent: two
// adjacent cards on 8549 and 7353 with nothing to say which was which.
import { useEffect, useState } from 'react'
import { accountRoster } from '../../lib/account-roster.js'
import { scopeLabel, scopeDiffers } from '../../lib/scope-label.js'

// The roster fetch is shared with the account FAB (lib/account-roster.js) —
// one request per page, and one cache, so the chip on a card and the FAB that
// set that card's scope can never be naming accounts from different rosters.

const TONE = {
  account: { fg: 'var(--color-state-on-text)', bd: 'var(--color-state-on-border)', bg: 'var(--color-state-on-bg)' },
  all: { fg: 'var(--color-text-sub)', bd: 'var(--glass-edge)', bg: 'transparent' },
  global: { fg: 'var(--color-text-sub)', bd: 'var(--glass-edge)', bg: 'transparent' },
  unknown: { fg: 'var(--color-warning-text)', bd: 'var(--color-warning-border)', bg: 'var(--color-warning-bg)' },
}

/**
 * @param {'all'|'global'|string|null} scope
 * @param {'all'|string|null} pageScope  when given, a differing scope is marked PINNED
 */
export default function ScopeChip({ scope, pageScope = undefined, style = null }) {
  const [accounts, setAccounts] = useState([])

  useEffect(() => {
    let alive = true
    // 'all' and 'global' need no roster to render their word — skip the fetch.
    if (scope === 'all' || scope === 'global' || scope == null || scope === '') return undefined
    accountRoster().then(a => { if (alive) setAccounts(a) })
    return () => { alive = false }
  }, [scope])

  const s = scopeLabel(scope, accounts)
  const pinned = pageScope !== undefined && scopeDiffers(scope, pageScope)
  const tone = TONE[s.kind] || TONE.all

  return (
    <span
      title={pinned ? `${s.title} PINNED — the rest of this page is on a different account.` : s.title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        fontSize: 'var(--fs-body)', fontWeight: 600, lineHeight: 1.5,
        color: tone.fg, border: `1px solid ${tone.bd}`, background: tone.bg,
        borderRadius: 'var(--radius-control)', padding: '0 4px',
        whiteSpace: 'nowrap', ...(style || {}),
      }}>
      {/* A word, never colour alone — the owner reads red/green as one thing. */}
      {pinned && <span style={{ fontWeight: 800 }}>PIN</span>}
      {s.text}
    </span>
  )
}
