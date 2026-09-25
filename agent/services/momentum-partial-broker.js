import { marketIdentity, marketIdentityKey } from '../lib/market-identity.js'
import { credsForRegisteredAccount } from '../lib/ctrader-creds.js'
import { wsReconcile, wsGetPositionDeals } from '../lib/ctrader-ws.js'
import { closePosition } from '../lib/exec-engine.js'
import { readPartialPlan } from './momentum-partial-manager.js'
import { partialPositionEvidence, partialPositionPresence, partialQuoteEvidence, partialClosingEvidence,
  partialAcceptedEvidence, partialDealHistoryEvidence, MAX_CLOCK_SKEW_MS } from './momentum-broker-evidence.js'
import { readMomentumTimedQuote } from './momentum-timed-quote.js'

// A refusal raised before any byte of the close left this process. The
// manager may revert such an attempt to ARMED: nothing can have executed.
const notSent = error => Object.assign(error instanceof Error ? error : Error(String(error)), { notSent: true })

export function makeMomentumPartialBroker(db, { identity, tradeId }, transports = {}) {
  const bound = marketIdentity(identity)
  const row = bound && readPartialPlan(db, bound.accountId, tradeId)
  if (!row || marketIdentityKey(row.identity) !== marketIdentityKey(bound)) throw Error('partial broker identity mismatch')
  const plan = row.plan, positionId = row.position_id
  const now = transports.now || Date.now, maxAgeMs = 5000
  const current = supplied => {
    const actual = transports.readCredentials ? transports.readCredentials(bound.accountId) : credsForRegisteredAccount(db, bound.accountId)
    if (!actual?.ready || actual.host !== bound.host || String(actual.accountId) !== bound.accountId
      || ['host', 'clientId', 'clientSecret', 'accessToken'].some(k => actual[k] !== supplied?.[k])
      || String(supplied?.accountId) !== bound.accountId) throw Error('partial broker identity changed')
    return actual
  }
  const context = () => ({ identity: bound, positionId, side: plan.side, entry: plan.entry, digits: plan.digits,
    closeVolume: plan.closeVolume, nowMs: now(), maxAgeMs })
  return {
    now, maxAgeMs, timeoutMs: 5000,
    // The credentials and the durable attempt row are read before the claim
    // (as the rank exit does), so a changed token refuses without using the
    // attempt. close() reads them again after the claim.
    preflight(supplied) { current(supplied); return true },
    async readPosition(supplied, requested) {
      if (requested !== positionId) throw Error('partial broker identity mismatch')
      const c = current(supplied)
      const raw = await (transports.reconcile || wsReconcile)(c.host, c.clientId, c.clientSecret,
        c.accessToken, c.accountId, 4000, 0)
      const ctx = context()
      // The protected position when the read shows one; otherwise what the
      // read proves on its own: absent, or present without the plan's shape.
      return partialPositionEvidence(raw, ctx) ?? partialPositionPresence(raw, ctx)
    },
    async quote(supplied, requested) {
      if (requested !== positionId) throw Error('partial broker identity mismatch')
      const c = current(supplied)
      // The listener skips stale events by the decoder's clock and bound, so
      // the event it returns is one the decoder below can accept.
      const raw = await (transports.quote || readMomentumTimedQuote)(c, bound.symbolId,
        { now, maxAgeMs, stream: transports.stream })
      return partialQuoteEvidence(raw, context())
    },
    // The position's own deal history, account-scoped and complete, or null.
    async readClosingDeals(supplied, requested) {
      if (requested !== positionId) throw Error('partial broker identity mismatch')
      const c = current(supplied)
      const raw = await (transports.deals || wsGetPositionDeals)(c.host, c.clientId, c.clientSecret,
        c.accessToken, c.accountId, positionId, now() + MAX_CLOCK_SKEW_MS, 4000)
      return partialDealHistoryEvidence(raw, context())
    },
    async close(supplied, order, { attemptedAtMs } = {}) {
      let c
      try {
        c = current(supplied)
        const attempt = readPartialPlan(db, bound.accountId, tradeId)
        if (order.positionId !== positionId || order.volume !== plan.closeVolume
          || attempt.state !== 'SENDING' || attempt.attempted_at !== attemptedAtMs)
          throw Error('partial durable attempt mismatch')
      } catch (error) { throw notSent(error) }
      // The existing gateway owns transport routing and permits fallback only
      // when non-submission is proved. No extra retry exists in this adapter.
      const raw = await (transports.close || closePosition)(c, order)
      const ctx = { ...context(), attemptedAtMs }
      // A fill proves the receipt; an acceptance proves only the order id;
      // "position not found" proves this close did not execute.
      if (raw?.alreadyClosed === true) return { alreadyClosed: true, accountId: bound.accountId, positionId }
      return partialClosingEvidence(raw, ctx) ?? partialAcceptedEvidence(raw, ctx)
    },
  }
}
