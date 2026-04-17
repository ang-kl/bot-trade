// Market Calendar API — fetches real market events from Polygon.io (Massive).
// Dividends, stock splits, and market holidays for watchlist symbols.

const BASE = 'https://api.polygon.io'

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return {} }
  }
  return {}
}

async function polygonGet(path, apiKey, params = {}) {
  const url = new URL(path, BASE)
  url.searchParams.set('apiKey', apiKey)
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v))
  }
  const res = await fetch(url.toString())
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || data.message || `Polygon ${res.status}`)
  return data
}

function formatDate(d) {
  return d.toISOString().slice(0, 10)
}

async function fetchForexFactory() {
  try {
    const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json')
    if (!res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data)) return []
    return data
  } catch {
    return []
  }
}

function mapFFImpact(impact) {
  if (!impact) return 'low'
  const l = impact.toLowerCase()
  if (l === 'high' || l === 'holiday') return 'high'
  if (l === 'medium') return 'medium'
  return 'low'
}

function parseFFEvents(ffData) {
  const events = []
  for (const item of ffData) {
    if (!item.date || !item.title) continue
    const d = new Date(item.date)
    if (isNaN(d.getTime())) continue
    const dateStr = d.toISOString().slice(0, 10)
    const hours = String(d.getUTCHours()).padStart(2, '0')
    const mins = String(d.getUTCMinutes()).padStart(2, '0')
    const time = hours === '00' && mins === '00' ? 'all-day' : `${hours}:${mins}`

    events.push({
      date: dateStr,
      time,
      event: item.title,
      category: 'economic',
      impact: mapFFImpact(item.impact),
      currency: item.country || null,
      symbols: [],
      details: [
        item.forecast ? `Forecast: ${item.forecast}` : null,
        item.previous ? `Previous: ${item.previous}` : null,
      ].filter(Boolean).join(' | ') || null,
      source: 'forexfactory',
    })
  }
  return events
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method not allowed' })
  }

  const body = readBody(req)
  const apiKey = body.apiKey || process.env.MASSIVE_API_KEY
  if (!apiKey) return res.status(400).json({ error: 'Massive API key required' })

  const { action } = body
  if (!action) return res.status(400).json({ error: 'action required' })

  try {
    if (action === 'generate') {
      const { symbols = [] } = body
      const today = formatDate(new Date())
      const monthOut = formatDate(new Date(Date.now() + 30 * 86_400_000))
      const events = []

      // 1. Market holidays
      try {
        const holidays = await polygonGet('/v1/marketstatus/upcoming', apiKey)
        if (Array.isArray(holidays)) {
          for (const h of holidays) {
            if (h.date && h.date >= today && h.date <= monthOut) {
              events.push({
                date: h.date,
                time: 'all-day',
                event: h.name || 'Market Holiday',
                category: 'holiday',
                impact: h.status === 'closed' ? 'high' : 'medium',
                currency: null,
                symbols: [],
                details: h.exchange ? `${h.exchange}: ${h.status || 'closed'}` : (h.status || 'closed'),
                source: 'polygon',
              })
            }
          }
        }
      } catch {}

      // 2. Dividends for watchlist stocks
      const stockTickers = symbols.filter(s => /^[A-Z]{1,5}$/.test(s))
      if (stockTickers.length > 0) {
        try {
          const divData = await polygonGet('/v3/reference/dividends', apiKey, {
            'ticker.in': stockTickers.join(','),
            'ex_dividend_date.gte': today,
            'ex_dividend_date.lte': monthOut,
            order: 'asc',
            limit: 50,
          })
          for (const d of (divData.results || [])) {
            events.push({
              date: d.ex_dividend_date,
              time: 'all-day',
              event: `${d.ticker} Ex-Dividend`,
              category: 'earnings',
              impact: 'medium',
              currency: d.currency || 'USD',
              symbols: [d.ticker],
              details: d.cash_amount ? `$${d.cash_amount} ${d.frequency === 4 ? 'quarterly' : d.frequency === 12 ? 'monthly' : ''} dividend` : 'Dividend date',
              source: 'polygon',
            })
          }
        } catch {}
      }

      // 3. Stock splits
      if (stockTickers.length > 0) {
        try {
          const splitData = await polygonGet('/v3/reference/stock-splits', apiKey, {
            'ticker.in': stockTickers.join(','),
            'execution_date.gte': today,
            'execution_date.lte': monthOut,
            order: 'asc',
            limit: 50,
          })
          for (const s of (splitData.results || [])) {
            events.push({
              date: s.execution_date,
              time: 'all-day',
              event: `${s.ticker} Stock Split`,
              category: 'sector',
              impact: 'high',
              currency: 'USD',
              symbols: [s.ticker],
              details: `${s.split_from}:${s.split_to} split`,
              source: 'polygon',
            })
          }
        } catch {}
      }

      // 4. ForexFactory economic calendar
      try {
        const ffData = await fetchForexFactory()
        const ffEvents = parseFFEvents(ffData)
        for (const e of ffEvents) {
          if (e.date >= today && e.date <= monthOut) {
            events.push(e)
          }
        }
      } catch {}

      // Sort by date, then impact
      const impactOrder = { high: 0, medium: 1, low: 2 }
      events.sort((a, b) => {
        const dc = a.date.localeCompare(b.date)
        if (dc !== 0) return dc
        return (impactOrder[a.impact] ?? 2) - (impactOrder[b.impact] ?? 2)
      })

      return res.status(200).json({
        events,
        generatedAt: new Date().toISOString(),
      })
    }

    return res.status(400).json({ error: `unknown action: ${action}` })
  } catch (e) {
    return res.status(500).json({ error: e.message || 'calendar failed' })
  }
}
