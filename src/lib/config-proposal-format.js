// ---------------------------------------------------------------------------
// src/lib/config-proposal-format.js — the pure parts of C-1's card.
//
// Split out of ConfigProposals.jsx because a component file that also exports
// helpers breaks fast refresh (react-refresh/only-export-components), and
// because these are the pieces worth testing without a renderer: a formatter
// that turns an unknown into a zero, or a command builder that quotes a
// boolean, would each be a quiet correctness bug in something an operator is
// about to paste into a shell.
// ---------------------------------------------------------------------------

/** A rate, or a dash. Never 0% for "we could not measure it". */
export function pct(n) {
  return n == null || !Number.isFinite(Number(n)) ? '—' : `${(Number(n) * 100).toFixed(1)}%`
}

/** A ratio, or a dash. */
export function num(n, dp = 2) {
  return n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(dp)
}

/**
 * The command an operator would run. Shown, never executed.
 *
 * JSON.stringify on the value rather than string interpolation: a boolean
 * written as "false" arrives at the route as a truthy string, which would set
 * exactly the opposite of what the card recommends.
 */
export function commandFor(accountId, setting, value) {
  return `POST /actions/risk-config  {"accountId":"${accountId}","${setting}":${JSON.stringify(value)}}`
}
