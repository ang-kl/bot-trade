// Every account pass recovers money through its own deal history, whether
// it belongs to the selected environment or the opposite-side reconciler.
// No broker writes, account selection, unknown-row attribution or risk changes.
import { getCtraderCreds } from '../lib/ctrader-creds.js'
import { wsGetDeals, wsGetPositionDeals } from '../lib/ctrader-ws.js'
import { tokenRefusedAccounts } from '../lib/token-refused.js'
import { getEnabledAccounts } from './account-registry.js'
import { backfillClosedPnl, dueForBackfill, noteBackfillAttempt, shouldRunPnlBackfill } from './pnl-backfill.js'
import { recoverOldPositionPnl } from './old-position-pnl.js'

const pendingReads = new WeakMap()

export async function backfillAccountPnl(db, creds, deps = {}) {
  const accountId = String(creds?.accountId), clock = deps.clock ?? Date.now
  const read = deps.getDeals ?? wsGetDeals, readPosition = deps.getPositionDeals ?? wsGetPositionDeals
  if (!pendingReads.has(db)) pendingReads.set(db, new Map())
  const pending = pendingReads.get(db)
  if (pending.has(accountId)) return { accountId, skipped: 'read_still_in_flight' }
  if (tokenRefusedAccounts(db).has(accountId)) return { accountId, skipped: 'token_refused' }
  if (!deps.closeSeen && !dueForBackfill(accountId, clock())) return { accountId, skipped: 'paced' }
  try {
    const host = creds?.host
    if (!creds?.ready || !['live.ctraderapi.com', 'demo.ctraderapi.com'].includes(host) || !/^[1-9]\d*$/.test(accountId)) throw new Error('account credentials unavailable or mismatched')
    const started = clock(), deadline = started + Math.min(10_000, deps.budgetMs ?? 10_000)
    const isCurrent = () => clock() < deadline
    const boundedRead = async operation => {
      const remaining = deadline - clock()
      if (remaining <= 0) throw new Error('backfill deadline elapsed')
      const timeout = Math.min(5000, remaining)
      const task = Promise.resolve().then(() => operation(timeout))
      pending.set(accountId, task)
      task.finally(() => { if (pending.get(accountId) === task) pending.delete(accountId) }).catch(() => {})
      let timer, response
      try {
        // Broker queue/token waits are outside the helper's socket timer.
        // Release the loop at the real deadline; late reads cannot write.
        response = await Promise.race([task, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('backfill deadline elapsed')), timeout)
        })])
      } finally { clearTimeout(timer) }
      return response
    }
    const result = await backfillClosedPnl(db, creds, { accountId, strictAccount: true, now: started,
      isCurrent,
      getDeals: async (from, to) => {
        const response = await boundedRead(timeout => read(host, creds.clientId, creds.clientSecret, creds.accessToken,
          accountId, from, to, timeout, 0))
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
    // V3 B1: positions the window pass could not settle by construction — a
    // lifecycle it cannot see whole, or a ledger identity it will not guess —
    // are handed to the per-position reader in the same pass.
    const handoff = [...(result.deferredPositions ?? []), ...(result.ambiguousPositions ?? []).map(a => a.positionId)]
    const oldHistory = await recoverOldPositionPnl(db, creds, { now: started, isCurrent, handoff,
      getPositionDeals: positionId => boundedRead(timeout => readPosition(host, creds.clientId, creds.clientSecret,
        creds.accessToken, accountId, positionId, started, timeout)),
    })
    if (oldHistory.state !== 'no_old_gap') result.positionHistory = oldHistory
    if (oldHistory.result?.backfilled) {
      for (const field of ['backfilled', 'scanned', 'closingDeals', 'dealsPersisted', 'exitsRepaired', 'exitsFilled']) {
        result[field] = (result[field] || 0) + (oldHistory.result[field] || 0)
      }
      // Same account, same currency: the fee the reader's fill excluded joins the window's.
      result.conversionFeeExcluded = Math.round(((result.conversionFeeExcluded || 0) + (oldHistory.result.conversionFeeExcluded || 0)) * 100) / 100
    }
    noteBackfillAttempt(accountId, result, clock())
    return { accountId, result }
  } catch (error) {
    // A failed read is not evidence that a trade was searched or exhausted.
    return { accountId, error: error?.message || String(error) }
  }
}

export async function backfillCrossSidePnl(db, baseCreds, reconciled = [], deps = {}) {
  if (!baseCreds?.ready) return []
  const accounts = getEnabledAccounts(db).filter(a => (a.is_live === 1) !== !!baseCreds.isLive)
  const credentials = deps.getCreds ?? getCtraderCreds, results = []
  // Both same-side and opposite-side callers use the same deadline, pacing,
  // strict account proof and unresolved-transport lock for each account.
  for (const account of accounts) {
    const accountId = String(account.account_id)
    try {
      const creds = credentials(db, { accountId, isLive: account.is_live === 1 })
      const host = account.is_live === 1 ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
      if (!creds?.ready || String(creds.accountId) !== accountId || creds.host !== host) throw new Error('account credentials unavailable or mismatched')
      results.push(await backfillAccountPnl(db, creds, { ...deps,
        closeSeen: shouldRunPnlBackfill(reconciled.find(r => r.accountId === accountId)?.result) }))
    } catch (error) { results.push({ accountId, error: error?.message || String(error) }) }
  }
  return results
}
