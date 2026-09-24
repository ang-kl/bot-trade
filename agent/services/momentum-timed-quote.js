import { wsStreamSpots } from '../lib/ctrader-ws.js'
import { marketIdentity } from '../lib/market-identity.js'

// One timestamped event carrying both sides. The initial subscription event
// may be stale; the evidence decoder, not local receipt, decides freshness.
export async function readMomentumTimedQuote(creds, symbolId, { stream = wsStreamSpots, timeoutMs = 4000 } = {}) {
  const identity = marketIdentity({ host: creds?.host, accountId: creds?.accountId, symbolId })
  if (!identity || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000) return null
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
        done({ ctidTraderAccountId: identity.accountId, symbolId: identity.symbolId,
          bid: Math.round(tick.bid * 100000), ask: Math.round(tick.ask * 100000), timestamp: tick.brokerAtMs })
      }, () => done(null), { timestamped: true, connectTimeoutMs: timeoutMs }))
      .then(handle => { connection = handle; if (finished) close(handle); else if (pendingResult) done(pendingResult) }, () => done(null))
  })
}
