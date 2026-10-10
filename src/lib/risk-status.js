// risk-status.js — the Risk page's "Capital safety now" rows.
//
// Claude · № 12,812 10-Oct (ordered № 12,810; claude-builder).
// Every figure is the server's own reading from GET /state/account-overview
// (balance, equity, floating, and the engine's dailyStop verdict), turned into
// words by the same dailyStopView the Performance account cards use. Nothing
// is computed here except ORDER (most at risk first) and one comparison of two
// server figures that are already in the same unit: a daily stop larger than
// the balance it guards can never stop that account, which is worth saying.

import { dailyStopView } from './daily-stop-display.js'

/**
 * @param {Array<object>} overviewAccounts  accounts[] of /state/account-overview
 * @param {Array<object>} registry          accounts[] of /state/accounts
 * @returns {Array<object>} rows, most at risk first
 */
export function statusRows(overviewAccounts, registry) {
  const reg = new Map((registry || []).map(a => [String(a.account_id), a]))
  const rows = (overviewAccounts || []).map(o => {
    const id = String(o.accountId)
    const r = reg.get(id) || {}
    const v = dailyStopView(o.dailyStop)
    const bal = typeof o.balance === 'number' ? o.balance : null
    const balanceUsed = typeof o.dailyStop?.balanceUsed === 'number' ? o.dailyStop.balanceUsed : null
    // Same unit only: the stop is in the engine's currency and balanceUsed is
    // the balance the engine measured in that currency.
    const stopExceedsBalance = v.capState === 'in_force' && v.cap != null && balanceUsed != null
      && balanceUsed > 0 && v.unitsComparable !== false && v.cap > balanceUsed
    const enabled = r.enabled === 1 || r.enabled === true
    // Display badge only (owner principle 1: nothing here gates anything).
    const badge = r.is_live ? { tag: 'LIVE', tone: 'down' } : { tag: 'DEMO', tone: 'info' }
    return {
      id,
      short: `…${id.slice(-4)}`,
      ...badge,
      mode: r.mode || null,
      enabled,
      ccy: o.currency || null,
      balance: bal,
      equity: typeof o.equity === 'number' ? o.equity : null,
      floating: typeof o.openPnl === 'number' ? o.openPnl : null,
      view: v,
      balanceUsed,
      stopExceedsBalance,
      dormant: !enabled && !(bal > 0) && !(o.openPnl),
    }
  })
  const rank = (x) => (x.dormant ? 0 : 1)
  return rows.sort((a, b) =>
    rank(b) - rank(a)
    || (b.view.used ?? -1) - (a.view.used ?? -1)
    || Number(b.stopExceedsBalance) - Number(a.stopExceedsBalance)
    || (b.view.capLoss ?? 0) - (a.view.capLoss ?? 0)
    || (b.balance ?? 0) - (a.balance ?? 0))
}

/** The colour band for loss-cap used, the page's existing thresholds (33/66). */
export function usedBand(used) {
  if (used == null) return 'unknown'
  return used > 66 ? 'breach' : used > 33 ? 'warn' : 'ok'
}
