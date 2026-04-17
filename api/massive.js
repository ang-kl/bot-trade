// Massive (formerly Polygon.io) data proxy.
// Proxies calls to Massive REST API so the API key stays server-side.
// Actions: test, aggs, snapshot, tickers

const BASE = 'https://api.polygon.io' // Massive kept the polygon.io domain

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return {}
}

async function massiveGet(path, apiKey, params = {}) {
  const url = new URL(path, BASE)
  url.searchParams.set('apiKey', apiKey)
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString())
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || data.message || `Massive API ${res.status}`)
  return data
}

export default async function handler(req, res) {
  if (req.method === 'GET' && req.query?.action === 'test') {
    const apiKey = req.query.apiKey || process.env.MASSIVE_API_KEY
    if (!apiKey) return res.status(400).json({ error: 'API key required' })
    try {
      const data = await massiveGet('/v3/reference/tickers', apiKey, {
        ticker: 'AAPL', limit: 1,
      })
      return res.status(200).json({
        ok: true,
        message: 'Massive API connected',
        count: data.count ?? data.results?.length ?? 0,
      })
    } catch (e) {
      return res.status(200).json({ ok: false, error: e.message })
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'method not allowed' })
  }

  const body = readBody(req)
  const apiKey = body.apiKey || process.env.MASSIVE_API_KEY
  if (!apiKey) return res.status(400).json({ error: 'Massive API key required' })

  const action = body.action
  if (!action) return res.status(400).json({ error: 'action required' })

  try {
    // ── Aggregates (OHLCV bars) ──
    if (action === 'aggs') {
      const { ticker, multiplier = 1, timespan = 'day', from, to, limit = 500, sort = 'asc' } = body
      if (!ticker) return res.status(400).json({ error: 'ticker required' })
      const path = `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${multiplier}/${timespan}/${from || '2024-01-01'}/${to || new Date().toISOString().slice(0, 10)}`
      const data = await massiveGet(path, apiKey, { adjusted: true, sort, limit })
      return res.status(200).json({
        ticker,
        count: data.resultsCount || 0,
        bars: (data.results || []).map(b => ({
          t: b.t,
          o: b.o,
          h: b.h,
          l: b.l,
          c: b.c,
          v: b.v,
          vw: b.vw,
          n: b.n,
        })),
      })
    }

    // ── Snapshot (latest quote/trade/day) ──
    if (action === 'snapshot') {
      const { ticker, market = 'stocks' } = body
      if (!ticker) return res.status(400).json({ error: 'ticker required' })
      const marketPaths = {
        stocks: `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(ticker)}`,
        forex: `/v2/snapshot/locale/global/markets/forex/tickers/${encodeURIComponent(ticker)}`,
        crypto: `/v2/snapshot/locale/global/markets/crypto/tickers/${encodeURIComponent(ticker)}`,
      }
      const path = marketPaths[market] || marketPaths.stocks
      const data = await massiveGet(path, apiKey)
      return res.status(200).json({ ticker, snapshot: data.ticker || data })
    }

    // ── Ticker search ──
    if (action === 'tickers') {
      const { search, market, limit = 20 } = body
      const params = { limit, active: true }
      if (search) params.search = search
      if (market) params.market = market
      const data = await massiveGet('/v3/reference/tickers', apiKey, params)
      return res.status(200).json({
        count: data.count || 0,
        tickers: (data.results || []).map(t => ({
          ticker: t.ticker,
          name: t.name,
          market: t.market,
          locale: t.locale,
          type: t.type,
          active: t.active,
          currency: t.currency_name,
        })),
      })
    }

    // ── Previous close ──
    if (action === 'prev-close') {
      const { ticker } = body
      if (!ticker) return res.status(400).json({ error: 'ticker required' })
      const data = await massiveGet(`/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev`, apiKey)
      const r = data.results?.[0]
      return res.status(200).json({
        ticker,
        close: r?.c ?? null,
        open: r?.o ?? null,
        high: r?.h ?? null,
        low: r?.l ?? null,
        volume: r?.v ?? null,
        vwap: r?.vw ?? null,
      })
    }

    // ── Ticker news ──
    if (action === 'news') {
      const { ticker, limit = 10 } = body
      const params = { limit, order: 'desc', sort: 'published_utc' }
      if (ticker) params.ticker = ticker
      const data = await massiveGet('/v2/reference/news', apiKey, params)
      return res.status(200).json({
        count: data.count || 0,
        articles: (data.results || []).map(a => ({
          title: a.title,
          author: a.author,
          publishedUtc: a.published_utc,
          articleUrl: a.article_url,
          tickers: a.tickers,
          description: a.description,
        })),
      })
    }

    // ── Financials (fundamentals) ──
    if (action === 'financials') {
      const { ticker, limit = 4 } = body
      if (!ticker) return res.status(400).json({ error: 'ticker required' })
      const data = await massiveGet('/vX/reference/financials', apiKey, {
        ticker, limit, sort: 'period_of_report_date', order: 'desc',
      })
      return res.status(200).json({
        count: data.count || 0,
        results: data.results || [],
      })
    }

    return res.status(400).json({ error: `unknown action: ${action}` })
  } catch (e) {
    return res.status(500).json({ error: e.message || 'massive API call failed' })
  }
}
