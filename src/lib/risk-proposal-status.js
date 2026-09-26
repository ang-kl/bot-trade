// Applied, still holding, or applied-and-since-changed?
//
// Mirrors agent/services/risk-config-history.js's proposalStatus so the table
// and the API agree on the word. Its own file because both the component and
// its test need it, and a helper exported from a component file breaks fast
// refresh.
//
// THE MIDDLE STATE IS THE POINT. The Risk page's proposal table had only two:
// applied or not. So a row that WAS applied and had since been changed showed
// as "applied", and its own footer said "the settings below hold these values
// now" — a claim it had never verified. The owner found it by searching for
// the daily loss limit and getting a different number than the row asserted.
export function proposalStatus({ applied, proposed, live }) {
  if (!applied) return 'not_applied'
  return JSON.stringify(live ?? null) === JSON.stringify(proposed ?? null) ? 'holds' : 'superseded'
}


// SAFE-0b (owner OD-14, 26-09-2026): the Apply confirm NAMES THE KEYS it will
// change. Apply writes the GLOBAL risk settings, and before this it was one
// click with no confirm at all. Each ticked row is listed as label, config key
// and the from→to values, followed by the account and time the proposal was
// made for — so an apply of the wrong run reads wrong before it is sent. The
// server still refuses a proposal older than 7 days or made for another
// account (agent/services/risk-reassess.js reassessApplyRefusal); this text is
// the owner's check, not the guard.
//
// `tradedAccountLabel` (nits round, 26-09-2026): the proposal names the
// account it was MADE for; it says nothing about which account is currently
// TRADED — the settings this confirm is about to change are global, so they
// apply to whatever account the operator switches to next, not only the one
// the proposal was assessed against. Named alongside the proposal's account,
// never in its place, so a stale or other-account mismatch still reads.
// Omitted (the default) leaves the text exactly as before.
export function reassessApplyConfirmText({ keys = [], last = null, live = {}, format = (_k, v) => String(v ?? '—'), tradedAccountLabel = null } = {}) {
  const byKey = new Map((last?.proposals || []).map(p => [p.key, p]))
  const lines = keys.map(k => {
    const p = byKey.get(k)
    return `• ${p?.label || k} (${k}): ${format(k, live?.[k])} → ${format(k, p?.proposed)}`
  })
  const made = `proposal made ${last?.at || 'at an unknown time'} for account ${last?.accountId ?? 'unknown'}`
    + (tradedAccountLabel ? ` — account currently traded: ${tradedAccountLabel}` : '')
  return [`Apply ${keys.length} setting${keys.length === 1 ? '' : 's'} to the GLOBAL risk settings?`, ...lines, made].join('\n')
}
