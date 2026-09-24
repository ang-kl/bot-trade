import { marketIdentity, marketIdentityKey } from '../lib/market-identity.js'
import { credsForRegisteredAccount } from '../lib/ctrader-creds.js'
import { wsReconcile } from '../lib/ctrader-ws.js'
import { closePosition } from '../lib/exec-engine.js'
import { readPartialPlan } from './momentum-partial-manager.js'
import { partialPositionEvidence, partialQuoteEvidence, partialClosingEvidence } from './momentum-broker-evidence.js'
import { readMomentumTimedQuote } from './momentum-timed-quote.js'

export function makeMomentumPartialBroker(db, { identity, tradeId }, transports = {}) {
  const bound = marketIdentity(identity)
  const row = bound && readPartialPlan(db, bound.accountId, tradeId)
  if (!row || marketIdentityKey(row.identity) !== marketIdentityKey(bound)) throw Error('partial broker identity mismatch')
  const plan = row.plan, positionId = row.position_id
  const now = transports.now || Date.now
  const current = supplied => {
    const actual = transports.readCredentials ? transports.readCredentials(bound.accountId) : credsForRegisteredAccount(db, bound.accountId)
    if (!actual?.ready || actual.host !== bound.host || String(actual.accountId) !== bound.accountId
      || ['host', 'clientId', 'clientSecret', 'accessToken'].some(k => actual[k] !== supplied?.[k])
      || String(supplied?.accountId) !== bound.accountId) throw Error('partial broker identity changed')
    return actual
  }
  const context = () => ({ identity: bound, positionId, side: plan.side, entry: plan.entry,
    closeVolume: plan.closeVolume, nowMs: now(), maxAgeMs: 5000 })
  return {
    now, maxAgeMs: 5000, timeoutMs: 5000,
    async readPosition(supplied, requested) {
      if (requested !== positionId) throw Error('partial broker identity mismatch')
      const c = current(supplied)
      const raw = await (transports.reconcile || wsReconcile)(c.host, c.clientId, c.clientSecret,
        c.accessToken, c.accountId, 4000, 0)
      return partialPositionEvidence(raw, context())
    },
    async quote(supplied, requested) {
      if (requested !== positionId) throw Error('partial broker identity mismatch')
      const c = current(supplied)
      const raw = await (transports.quote || readMomentumTimedQuote)(c, bound.symbolId)
      return partialQuoteEvidence(raw, context())
    },
    async close(supplied, order, { attemptedAtMs } = {}) {
      const c = current(supplied)
      const attempt = readPartialPlan(db, bound.accountId, tradeId)
      if (order.positionId !== positionId || order.volume !== plan.closeVolume
        || attempt.state !== 'SENDING' || attempt.attempted_at !== attemptedAtMs)
        throw Error('partial durable attempt mismatch')
      // The existing gateway owns transport routing and permits fallback only
      // when non-submission is proved. No extra retry exists in this adapter.
      const raw = await (transports.close || closePosition)(c, order)
      return partialClosingEvidence(raw, { ...context(), attemptedAtMs })
    },
  }
}
