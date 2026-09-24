// Broker spot events may carry only the side that changed. Keep the last
// observed side and its receipt time; never turn a null ask into zero.
export function mergeDisplayQuote(previous, tick, receivedAt = Date.now()) {
  const same = previous?.accountId === tick.accountId && previous?.host === tick.host
  const old = same ? previous : null
  const valid = n => Number.isFinite(n) && n > 0
  const bid = valid(tick.bid) ? tick.bid : old?.bid ?? null
  const ask = valid(tick.ask) ? tick.ask : old?.ask ?? null
  const mid = bid != null && ask != null && ask >= bid ? (bid + ask) / 2 : null
  return { ...tick, bid, ask, clientReceivedAtMs: receivedAt,
    bidReceivedAt: valid(tick.bid) ? receivedAt : old?.bidReceivedAt ?? null,
    askReceivedAt: valid(tick.ask) ? receivedAt : old?.askReceivedAt ?? null,
    firstMid: old?.firstMid ?? mid }
}
export function displayQuote(tick, nowMs, maxAgeMs = 15000) {
  if (!tick) return { price: null, delta: null }
  const now = Math.max(nowMs, tick.clientReceivedAtMs || 0)
  const fresh = n => Number.isFinite(n) && n <= now && now - n <= maxAgeMs
  const valid = fresh(tick.bidReceivedAt) && fresh(tick.askReceivedAt)
    && Number.isFinite(tick.bid) && tick.bid > 0 && Number.isFinite(tick.ask) && tick.ask >= tick.bid
  const price = valid ? (tick.bid + tick.ask) / 2 : null
  return { price, delta: price != null && tick.firstMid > 0 ? (price / tick.firstMid - 1) * 100 : null }
}
