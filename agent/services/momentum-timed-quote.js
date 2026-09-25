import { wsStreamSpots } from '../lib/ctrader-ws.js'
import { marketIdentity } from '../lib/market-identity.js'
import { freshBrokerStamp } from './momentum-broker-evidence.js'

// One timestamped event carrying both sides. The initial subscription event
// may be stale (an old market-close quote); it is skipped, not returned, and
// listening continues until the deadline. Freshness is the evidence decoder's
// own rule (partialQuoteEvidence), judged on the broker timestamp against the
// caller's clock; local receipt never refreshes an event's age. Returning the
// first stale event made a quiet symbol refuse fresh_quote_required on every
// pass although a fresh event would have arrived inside the same budget.
export async function readMomentumTimedQuote(creds, symbolId, { stream = wsStreamSpots, timeoutMs = 4000, now = Date.now, maxAgeMs = 5000 } = {}) {
  const identity = marketIdentity({ host: creds?.host, accountId: creds?.accountId, symbolId })
  if (!identity || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000
    || typeof now !== 'function' || !(maxAgeMs > 0) || maxAgeMs > 10000) return null
  return new Promise(resolve => {
    let connection, pendingResult, finished = false, timer
    const close = handle => { try { handle?.close() } catch { /* already closed */ } }
    const done = result => {
      if (finished) return
      if (result != null && !connection) { pendingResult = result; return }
      finished = true; clearTimeout(timer); close(connection); resolve(result)
    }
    timer = setTimeout(() => done(null), timeoutMs)
    Promise.resolve().then(() => stream(creds.host, creds.clientId, creds.clientSecret, creds.accessToken,
      identity.accountId, [identity.symbolId], tick => {
        if (String(tick.accountId) !== identity.accountId || String(tick.symbolId) !== identity.symbolId
          || !Number.isSafeInteger(tick.brokerAtMs) || tick.brokerAtMs <= 0
          || !Number.isFinite(tick.bid) || tick.bid <= 0 || !Number.isFinite(tick.ask) || tick.ask < tick.bid) return
        if (!freshBrokerStamp(tick.brokerAtMs, { nowMs: now(), maxAgeMs })) return
        done({ ctidTraderAccountId: identity.accountId, symbolId: identity.symbolId,
          bid: Math.round(tick.bid * 100000), ask: Math.round(tick.ask * 100000), timestamp: tick.brokerAtMs })
      }, () => done(null), { timestamped: true, connectTimeoutMs: timeoutMs }))
      .then(handle => { connection = handle; if (finished) close(handle); else if (pendingResult) done(pendingResult) }, () => done(null))
  })
}
