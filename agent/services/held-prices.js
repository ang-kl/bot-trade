// ---------------------------------------------------------------------------
// agent/services/held-prices.js — cheap current-price refresh for OPEN
// positions, decoupled from the heavy new-setup scan.
//
// The main-loop monitor evaluates each open position's deterministic rules
// (break-even, trailing, partials) against a current price. That price used to
// come "for free" from the full fib scan — which is why held symbols were
// force-scanned every loop, crowding out coverage of new candidates once the
// book filled. This module supplies those prices the cheap way: a single spot
// quote per held symbol (one lightweight subscribe/read, NOT a 150-bar ×
// multi-timeframe fetch + signal compute), so monitoring never competes with
// hunting for the scan budget.
//
// Best-effort per symbol: a failed quote leaves that symbol out of the map and
// the monitor holds it that cycle (the broker-resident SL/TP is the real
// backstop between loops). getSpot is injectable for tests.
// ---------------------------------------------------------------------------

/**
 * @param {{host,clientId,clientSecret,accessToken,accountId}} creds
 * @param {Record<string, number|string>} symbolMap  UPPER symbol → symbolId
 * @param {string[]} symbols  held-position symbols
 * @param {{ getSpot?: (symbolId)=>Promise<{bid:number,ask:number}|null>, concurrency?: number }} [opts]
 * @returns {Promise<Record<string, number>>}  UPPER symbol → mid price
 */
export async function refreshHeldPrices(creds, symbolMap, symbols, opts = {}) {
  const uniq = [...new Set((symbols || []).map(s => String(s).toUpperCase()))]
  if (uniq.length === 0) return {}

  let getSpot = opts.getSpot
  if (!getSpot) {
    const { wsGetSpotOnce } = await import('../lib/ctrader-ws.js')
    getSpot = (symbolId) => wsGetSpotOnce(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)
  }
  const concurrency = Math.max(1, Number(opts.concurrency) || 4)

  const out = {}
  for (let i = 0; i < uniq.length; i += concurrency) {
    const chunk = uniq.slice(i, i + concurrency)
    await Promise.all(chunk.map(async (sym) => {
      const id = symbolMap[sym]
      if (id == null) return
      try {
        const q = await getSpot(id)
        const mid = midPrice(q)
        if (mid != null) out[sym] = mid
      } catch { /* best-effort — a failed quote just holds the position */ }
    }))
  }
  return out
}

/** Mid of a {bid,ask} quote; tolerates one side missing. null when unusable. */
export function midPrice(q) {
  if (!q) return null
  const bid = Number(q.bid)
  const ask = Number(q.ask)
  const okBid = Number.isFinite(bid)
  const okAsk = Number.isFinite(ask)
  if (okBid && okAsk) return (bid + ask) / 2
  if (okBid) return bid
  if (okAsk) return ask
  return null
}
