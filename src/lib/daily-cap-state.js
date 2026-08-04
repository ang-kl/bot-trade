// ---------------------------------------------------------------------------
// src/lib/daily-cap-state.js — which daily brake is holding the line, and what
// to warn about when one (or neither) is.
//
// Owner, 04-08-2026: *"all Daily cap fallback be (null) mean not used to check.
// if % is (null) means not used to check. then warn that daily cap fallback
// isn't use it will be uncapped."*
//
// Two independent checks — `dailyLossPct` (% of balance) and `dailyLossLimit`
// (flat USD) — each of which the owner can switch off by clearing its field.
// Both on means the tighter one binds. Neither on means the day has NO loss
// brake at all, and the whole point of this module is that the page has to say
// so out loud rather than render two empty boxes.
//
// It is a pure function over the config so the Risk page and any other surface
// can ask the same question and get the same answer. The agent computes the
// authoritative number (agent/services/daily-loss-pacing.js) — this decides
// what the operator is TOLD, which is a different job and must not drift into
// being a second implementation of the arithmetic.
// ---------------------------------------------------------------------------

/** A field counts as ON when it holds a positive number. Empty, null and 0 are OFF. */
const on = (v) => Number.isFinite(Number(v)) && Number(v) > 0

/**
 * @param {{dailyLossPct?: number|null, dailyLossLimit?: number|null}} cfg
 * @param {number|null} balance  account balance USD, null when unknown
 * @returns {{
 *   pctOn: boolean, flatOn: boolean,
 *   pctCapUsd: number|null, flatCapUsd: number|null,
 *   capUsd: number|null, binding: 'pct'|'flat'|'both'|null,
 *   uncapped: boolean, severity: 'none'|'warn'|'danger', message: string|null,
 * }}
 */
export function dailyCapState(cfg, balance) {
  const pctOn = on(cfg?.dailyLossPct)
  const flatOn = on(cfg?.dailyLossLimit)
  // A percentage of an unknown balance is not a limit. The field is still ON —
  // the owner set it and it will bind the moment a balance is read — but it
  // cannot produce a number now, and pretending otherwise is how a cap that
  // enforces nothing ends up displayed as if it did.
  const pctCapUsd = pctOn && balance > 0 ? balance * Number(cfg.dailyLossPct) : null
  const flatCapUsd = flatOn ? Math.abs(Number(cfg.dailyLossLimit)) : null

  const live = [pctCapUsd, flatCapUsd].filter(v => v != null)
  const capUsd = live.length ? Math.min(...live) : null
  const binding = capUsd == null ? null
    : pctCapUsd != null && flatCapUsd != null
      ? (pctCapUsd === flatCapUsd ? 'both' : (pctCapUsd < flatCapUsd ? 'pct' : 'flat'))
      : (pctCapUsd != null ? 'pct' : 'flat')

  let severity = 'none'
  let message = null
  if (!pctOn && !flatOn) {
    severity = 'danger'
    message = 'No daily loss cap. Both the % cap and the flat $ cap are empty, so nothing stops the day\'s realised losses — the account can keep opening trades however far down it goes. Per-trade risk, margin and the equity stop still apply; the DAY does not.'
  } else if (capUsd == null) {
    // Every configured check is inapplicable right now — in practice: % is set,
    // flat is empty, and the balance is unknown. The config looks protected and
    // is not, which is the most misleading of the three states.
    severity = 'danger'
    message = 'Uncapped right now. The % cap needs a balance and this account has none, and the flat $ cap is empty — so no daily limit is being enforced this session. Set the flat $ cap to keep a brake while the balance is unknown.'
  } else if (!flatOn) {
    severity = 'warn'
    message = 'The flat $ cap is off. While the balance is readable the % cap holds; if the balance ever goes unknown there is nothing left to cap the day.'
  } else if (!pctOn) {
    severity = 'warn'
    message = 'The % cap is off. The flat $ cap holds at every balance, so the limit no longer scales with the account.'
  }

  return { pctOn, flatOn, pctCapUsd, flatCapUsd, capUsd, binding, uncapped: capUsd == null, severity, message }
}

/** One line naming which check binds, for the field group's footer. */
export function describeBinding(s) {
  if (!s || s.capUsd == null) return null
  const m = (v) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (s.binding === 'both') return `Both caps agree at ${m(s.capUsd)}.`
  if (s.binding === 'pct') {
    return s.flatCapUsd != null
      ? `The % cap binds at ${m(s.pctCapUsd)} — tighter than the ${m(s.flatCapUsd)} flat cap.`
      : `The % cap binds at ${m(s.pctCapUsd)}.`
  }
  return s.pctCapUsd != null
    ? `The flat $ cap binds at ${m(s.flatCapUsd)} — tighter than the ${m(s.pctCapUsd)} the % cap would allow.`
    : `The flat $ cap binds at ${m(s.flatCapUsd)}.`
}
