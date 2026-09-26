/**
 * SAFE-0a (integrated plan 26-09-2026): the manual-order confirm names the
 * DESTINATION account.
 *
 * The order pad posts /actions/manual-order without an `account`, so the
 * route sends it to the bot's primary broker account — `ctrader_account_id`,
 * the same state /health reports as `broker.accountId`
 * (agent/routes/actions.js credsForAccountId → getCtraderCreds). That is not
 * necessarily the account this page is showing. The confirm therefore names
 * the account the order will ACTUALLY reach, in the form the rest of the UI
 * uses for a confirm (…last four digits, src/lib/account-confirm.js), with the
 * broker login when the page has it, and says so plainly when the page is
 * showing a different account. It never names the environment (owner
 * principle 1) and never guesses an id it does not have (principle 6).
 *
 * Routing orders to the viewed account instead is the owner's call (plan D2);
 * this changes the words of the confirm only, not where the order goes.
 */
const last4 = (id) => `…${String(id).slice(-4)}`

/**
 * @param {object} p
 * @param {string} p.side          BUY | SELL
 * @param {string} p.symbol
 * @param {string|number} p.sl
 * @param {string|number} [p.tp]
 * @param {{accountId?: string|number|null, traderLogin?: string|number|null}|null} p.destination
 *   the primary broker account (/health broker.accountId / traderLogin)
 * @param {string|number|null} [p.viewedAccountId]  the account this page shows
 * @returns {string}
 */
export function manualOrderConfirmText({ side, symbol, sl, tp, destination, viewedAccountId = null }) {
  const destId = destination?.accountId != null && String(destination.accountId) !== '' ? String(destination.accountId) : null
  const login = destination?.traderLogin != null && String(destination.traderLogin) !== '' ? String(destination.traderLogin) : null
  const where = destId
    ? `account ${last4(destId)}${login ? ` (login ${login})` : ''}`
    : 'the primary broker account (its id has not loaded on this page yet)'
  const viewed = viewedAccountId != null && String(viewedAccountId) !== '' && String(viewedAccountId) !== 'all' ? String(viewedAccountId) : null
  const mismatch = destId && viewed && viewed !== destId
    ? ` NOTE: this is NOT the account this page is showing (${last4(viewed)}).`
    : ''
  return `Place a REAL ${side} market order on ${symbol} (SL ${sl}${tp ? `, TP ${tp}` : ''}) on ${where}?${mismatch}`
}
