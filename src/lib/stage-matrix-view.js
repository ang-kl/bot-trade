// Tune → Strategy × Stage Matrix: the words a cell carries beside its ✓/✗.
//
// S-1 (26-09-2026, principle 6). Two things the table used to leave unsaid:
//
//  1. A SHARED Auto Trade & Open cell arms only the accounts that FOLLOW it —
//     an account with its own cell ignores it. On 26-09 all seven accounts had
//     their own cell for every strategy, so the shared list's six ✓ armed
//     nothing, while reading as armed. The server now counts the followers
//     (GET /state/stage-matrix `followers`); the cell says "followed by N of M".
//
//  2. In an ACCOUNT's scope only the strategy Auto Trade & Open cell is the
//     account's own. Scan, Back Test, Live Tweak & Close and the filters' trade
//     flag are shared — the agent refuses a per-account write to them with a
//     400 naming why — and a cell the account still has STORED from before
//     is listed by the server in `unapplied`. The cell says "shared", and a
//     stored-but-unapplied value is named, never hidden.
//
// Pure, so the wording is tested without rendering the page.

/** Only the strategy trade cell binds per account (mirrors the agent's isAccountScopedCell). */
export function isAccountScopedCell(kind, stage) {
  return kind === 'strategy' && stage === 'trade'
}

/** "followed by N of M" for a shared trade cell, or null when unknown. */
export function followerLabel(followers, key) {
  const f = followers?.[key]
  if (!f || !Number.isFinite(f.following) || !Number.isFinite(f.of)) return null
  return `followed by ${f.following} of ${f.of}`
}

/** The stored-but-unapplied entry for this cell in an account's scope, or null. */
export function unappliedFor(mx, kind, key, stage) {
  const list = Array.isArray(mx?.unapplied) ? mx.unapplied : []
  return list.find(u => u.kind === kind && u.key === key && u.stage === stage) || null
}

/**
 * What the cell says under its tick, and whether this scope may edit it.
 * @returns {{ sub: string|null, editable: boolean, reason: string|null }}
 */
export function cellNote(mx, { kind, key, stage, acct }) {
  const shared = !acct || acct === 'all'
  if (shared) {
    const sub = kind === 'strategy' && stage === 'trade' ? followerLabel(mx?.followers, key) : null
    return { sub, editable: true, reason: null }
  }
  if (isAccountScopedCell(kind, stage)) return { sub: null, editable: true, reason: null }
  const u = unappliedFor(mx, kind, key, stage)
  if (u) {
    return {
      sub: `stored ${u.stored ? 'ON' : 'OFF'} here — not applied`,
      editable: false,
      reason: u.reason || 'shared across accounts — set it in the Shared scope',
    }
  }
  return { sub: 'shared', editable: false, reason: 'shared across accounts — set it in the Shared scope' }
}
