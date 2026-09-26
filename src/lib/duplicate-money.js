// The Desk duplicate-trade card's money line (V3 B2), from GET
// /state/duplicate-trades. One part per unit the server priced in — never one
// figure summed across currencies (owner default 25-09):
//   - each recorded currency's pool (extraByCurrency);
//   - each account with no currency, in its own units (extraByAccount rows
//     with currency null) — and WHY it has none: the evidence is not recorded,
//     or the currency read itself failed (`currencyRead: 'unavailable'`), in
//     which case "not recorded" would be false (owner principle 6);
//   - each row with no account, per broker position (extraUnattributed).

const signed = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`

/** The money parts of the duplicate audit, each in its own currency or unit. */
export function duplicateMoneyParts(dupes) {
  if (!dupes) return []
  const noCurrency = dupes.currencyRead === 'unavailable' ? 'currency not read' : 'currency not recorded'
  return [
    ...(dupes.extraByCurrency ?? []).map(c => c.pnl == null ? `${c.currency} not priced` : `${signed(c.pnl)} ${c.currency}`),
    ...(dupes.extraByAccount ?? []).filter(b => !b.currency).map(b => `${signed(b.pnl)} (account ${b.accountId} units, ${noCurrency})`),
    ...(dupes.extraUnattributed ?? []).map(u => `${signed(u.pnl)} (${u.positionId ? `position ${u.positionId}` : `row #${u.tradeIds[0]}`}, no account, currency unknown)`),
  ]
}
