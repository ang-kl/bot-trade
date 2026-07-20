// useLiveTicks — bid/ask ticks for a bounded symbol set, backed by the
// agent's existing SSE spot stream (GET /actions/stream-prices), the SAME
// live cTrader feed PositionChart.jsx already uses to move its forming
// candle. Owner: "should run every 1/2 second... why aren't you listening"
// — the honest fix isn't a faster poll, it's this: prices update the
// instant a tick arrives instead of waiting for the next fetch.
//
// Capped at 10 symbols, matching the backend route's own cap (one cTrader
// spot subscription per connected browser tab).
import { useEffect, useState } from 'react'
import { agentStreamPrices } from './agent-api.js'

const MAX_SYMBOLS = 10

/** @returns {Record<string, {symbol,bid,ask,t}>} keyed by uppercased symbol */
export function useLiveTicks(symbols) {
  const key = [...new Set((symbols || []).filter(Boolean).map(s => String(s).toUpperCase()))]
    .sort().slice(0, MAX_SYMBOLS).join(',')
  const [ticks, setTicks] = useState({})

  useEffect(() => {
    // No reset-to-{} on key change: a symbol no longer in `key` just stops
    // getting fresh ticks (nothing reads it by name anymore), and resetting
    // synchronously in the effect body is exactly the cascading-render
    // pattern React discourages — the stream's own first tick per symbol
    // replaces stale data soon enough.
    if (!key) return undefined
    const stream = agentStreamPrices(
      key.split(','),
      (t) => setTicks(prev => (t.symbol ? { ...prev, [t.symbol]: t } : prev)),
      () => {}, // stream ended/dropped — components just keep their last tick
    )
    return () => stream.close()
  }, [key])

  return ticks
}

/** Mid price for a symbol from a useLiveTicks() map, or null if not live. */
export function liveMid(ticks, symbol) {
  const t = ticks?.[String(symbol || '').toUpperCase()]
  if (!t) return null
  if (t.bid != null && t.ask != null) return (t.bid + t.ask) / 2
  return t.bid ?? t.ask ?? null
}
