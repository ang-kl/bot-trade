/**
 * ONE confirm for every account (PR-B, owner principle 1, 11-09-2026).
 *
 * Three places used to ask "Type LIVE" on a live row and a plain confirm (or
 * nothing) on a demo one — the environment decided the ceremony. An account
 * is only how much is inside it, so the ceremony is the same on every row:
 * one window.confirm naming the account's last four digits and, when the row
 * carries a balance, that balance. No environment branch here, by design.
 *
 * @param {object|null} account  registry row ({accountId|account_id, balance?, baseCurrency?})
 * @param {string} action        what the click does, in one sentence
 * @returns {string}             the confirm text
 */
export function accountConfirmText(account, action) {
  const id = String(account?.accountId ?? account?.account_id ?? '')
  const last4 = id ? `…${id.slice(-4)}` : 'this account'
  const bal = Number(account?.balance)
  const money = Number.isFinite(bal)
    ? ` (balance ${account?.baseCurrency || 'USD'} ${bal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`
    : ''
  return `Account ${last4}${money}: ${action} Continue?`
}

/** window.confirm with the neutral text; true when there is no window (tests, SSR). */
export function confirmAccountAction(account, action) {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true
  return window.confirm(accountConfirmText(account, action))
}
