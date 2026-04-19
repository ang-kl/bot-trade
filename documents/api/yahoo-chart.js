// Vercel serverless proxy for Yahoo Finance chart data.
// Avoids browser CORS restrictions on query1.finance.yahoo.com.
//
// Usage: GET /api/yahoo-chart?symbol=BTC-USD&range=1mo&interval=1h
// Returns: { symbol, currency, meta, candles: [{t,o,h,l,c,v}, ...] }

const ALLOWED_RANGES = new Set([
  '1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max',
])
const ALLOWED_INTERVALS = new Set([
  '1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo',
])

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  let symbol = (req.query.symbol || 'BTC-USD').toString()
  const range = ALLOWED_RANGES.has(req.query.range) ? req.query.range : '1mo'
  const interval = ALLOWED_INTERVALS.has(req.query.interval) ? req.query.interval : '1h'

  // Basic symbol validation to prevent open-proxy abuse.
  if (!/^[A-Z0-9.\-=^]{1,20}$/i.test(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol' })
  }

  // Auto-add =X suffix for 6-char forex pairs (EURUSD → EURUSD=X)
  if (/^[A-Z]{6}$/i.test(symbol) && !symbol.includes('=') && !symbol.includes('-')) {
    symbol = symbol.toUpperCase() + '=X'
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`

  try {
    const upstream = await fetch(url, {
      headers: {
        // Yahoo rejects requests without a UA.
        'User-Agent': 'Mozilla/5.0 (compatible; abot/1.0)',
        Accept: 'application/json',
      },
    })

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `Yahoo upstream returned ${upstream.status}`,
      })
    }

    const data = await upstream.json()
    const result = data?.chart?.result?.[0]
    if (!result) {
      return res.status(502).json({ error: 'Malformed upstream response' })
    }

    const timestamps = result.timestamp || []
    const quote = result.indicators?.quote?.[0] || {}
    const opens = quote.open || []
    const highs = quote.high || []
    const lows = quote.low || []
    const closes = quote.close || []
    const volumes = quote.volume || []

    const candles = []
    for (let i = 0; i < timestamps.length; i++) {
      // Skip rows with any null OHLC (Yahoo returns nulls on gaps).
      if (
        opens[i] == null || highs[i] == null ||
        lows[i] == null || closes[i] == null
      ) continue
      candles.push({
        t: timestamps[i] * 1000,
        o: opens[i],
        h: highs[i],
        l: lows[i],
        c: closes[i],
        v: volumes[i] ?? 0,
      })
    }

    // Cache at the edge for 60 seconds (live enough, friendly to Yahoo).
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')
    res.status(200).json({
      symbol: result.meta?.symbol || symbol,
      currency: result.meta?.currency || null,
      meta: {
        regularMarketPrice: result.meta?.regularMarketPrice ?? null,
        previousClose: result.meta?.chartPreviousClose ?? null,
        exchangeName: result.meta?.exchangeName ?? null,
        timezone: result.meta?.timezone ?? null,
      },
      candles,
    })
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Proxy error' })
  }
}
