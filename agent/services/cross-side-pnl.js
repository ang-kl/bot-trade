// The opposite-side reconciler can close local rows while a different broker
// environment is selected. Recover their money through their OWN deal history.
// No broker writes, account selection, unknown-row attribution or risk changes.
import { getCtraderCreds } from '../lib/ctrader-creds.js'
import { wsGetDeals } from '../lib/ctrader-ws.js'
import { tokenRefusedAccounts } from '../lib/token-refused.js'
import { getEnabledAccounts } from './account-registry.js'
import { backfillClosedPnl, dueForBackfill, noteBackfillAttempt, shouldRunPnlBackfill } from './pnl-backfill.js'

export async function backfillCrossSidePnl(db, baseCreds, reconciled = [], deps = {}) {
  if (!baseCreds?.ready) return []
  const accounts = getEnabledAccounts(db).filter(a => (a.is_live === 1) !== !!baseCreds.isLive)
  const refused = tokenRefusedAccounts(db)
  const credentials = deps.getCreds ?? getCtraderCreds
  const read = deps.getDeals ?? wsGetDeals
  const clock = deps.clock ?? Date.now
  const results = []
  // Serial, paced reads reuse the existing WS pool. Each account has a 10 s
  // overall read budget; one account's failure does not omit later accounts.
  for (const account of accounts) {
    const accountId = String(account.account_id)
    if (refused.has(accountId)) { results.push({ accountId, skipped: 'token_refused' }); continue }
    const closeSeen = shouldRunPnlBackfill(reconciled.find(r => r.accountId === accountId)?.result)
    if (!closeSeen && !dueForBackfill(accountId, clock())) { results.push({ accountId, skipped: 'paced' }); continue }
    try {
      const creds = credentials(db, { accountId, isLive: account.is_live === 1 })
      const host = account.is_live === 1 ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
      if (!creds?.ready || String(creds.accountId) !== accountId || creds.host !== host) throw new Error('account credentials unavailable or mismatched')
      const started = clock(), deadline = started + 10_000
      const result = await backfillClosedPnl(db, creds, { accountId, strictAccount: true, now: started,
        isCurrent: () => clock() < deadline,
        getDeals: async (from, to) => {
          const remaining = deadline - clock()
          if (remaining <= 0) throw new Error('backfill deadline elapsed')
          const response = await read(host, creds.clientId, creds.clientSecret, creds.accessToken,
            accountId, from, to, Math.min(5000, remaining), 0)
          if (!response || String(response.ctidTraderAccountId) !== accountId || response.error || response.errorCode
            || (response.deal != null && !Array.isArray(response.deal))) throw new Error('deal history missing, malformed or belongs to another account')
          for (const deal of response.deal ?? []) {
            if (!deal || !/^[1-9]\d*$/.test(String(deal.dealId)) || !/^[1-9]\d*$/.test(String(deal.positionId))) throw new Error('deal identity invalid')
            const c = deal.closePositionDetail
            if (c && (!Number.isInteger(c.moneyDigits) || c.moneyDigits < 0 || c.moneyDigits > 10
              || c.grossProfit == null || ![c.grossProfit, c.swap ?? 0, c.commission ?? 0]
                .every(v => /^-?\d+$/.test(String(v)) && Number.isSafeInteger(Number(v))))) throw new Error('closing deal money invalid')
          }
          return response
        },
      })
      noteBackfillAttempt(accountId, result, clock())
      results.push({ accountId, result })
    } catch (error) {
      // A failed read is not evidence that a trade was searched or exhausted.
      results.push({ accountId, error: error?.message || String(error) })
    }
  }
  return results
}
