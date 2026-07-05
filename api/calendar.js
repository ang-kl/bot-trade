// Market Calendar API — multi-source: ForexFactory, Polygon, international holidays
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

// ---------------------------------------------------------------------------
// International market holidays (static, 2025–2026)
// ---------------------------------------------------------------------------

const INTL_HOLIDAYS = {
  US: [
    { date: '2025-01-01', name: "New Year's Day" },
    { date: '2025-01-20', name: 'Martin Luther King Jr. Day' },
    { date: '2025-02-17', name: "Presidents' Day" },
    { date: '2025-04-18', name: 'Good Friday (US)' },
    { date: '2025-05-26', name: 'Memorial Day' },
    { date: '2025-06-19', name: 'Juneteenth' },
    { date: '2025-07-04', name: 'Independence Day' },
    { date: '2025-09-01', name: 'Labor Day' },
    { date: '2025-11-27', name: 'Thanksgiving Day' },
    { date: '2025-12-25', name: 'Christmas Day (US)' },
    { date: '2026-01-01', name: "New Year's Day" },
    { date: '2026-01-19', name: 'Martin Luther King Jr. Day' },
    { date: '2026-02-16', name: "Presidents' Day" },
    { date: '2026-04-03', name: 'Good Friday (US)' },
    { date: '2026-05-25', name: 'Memorial Day' },
    { date: '2026-06-19', name: 'Juneteenth' },
    { date: '2026-07-03', name: 'Independence Day (observed)' },
    { date: '2026-09-07', name: 'Labor Day' },
    { date: '2026-11-26', name: 'Thanksgiving Day' },
    { date: '2026-12-25', name: 'Christmas Day (US)' },
  ],
  JP: [
    { date: '2025-01-01', name: "New Year's Day (Japan)" },
    { date: '2025-01-02', name: 'New Year Holiday (Japan)' },
    { date: '2025-01-03', name: 'New Year Holiday (Japan)' },
    { date: '2025-01-13', name: 'Coming of Age Day' },
    { date: '2025-02-11', name: 'National Foundation Day' },
    { date: '2025-02-23', name: "Emperor's Birthday" },
    { date: '2025-03-20', name: 'Vernal Equinox Day' },
    { date: '2025-04-29', name: 'Showa Day' },
    { date: '2025-05-03', name: 'Constitution Day' },
    { date: '2025-05-04', name: 'Greenery Day' },
    { date: '2025-05-05', name: "Children's Day" },
    { date: '2025-07-21', name: 'Marine Day' },
    { date: '2025-08-11', name: 'Mountain Day' },
    { date: '2025-09-15', name: 'Respect for the Aged Day' },
    { date: '2025-09-23', name: 'Autumnal Equinox Day' },
    { date: '2025-10-13', name: 'Sports Day' },
    { date: '2025-11-03', name: 'Culture Day' },
    { date: '2025-11-23', name: 'Labour Thanksgiving Day' },
    { date: '2026-01-01', name: "New Year's Day (Japan)" },
    { date: '2026-01-02', name: 'New Year Holiday (Japan)' },
    { date: '2026-01-12', name: 'Coming of Age Day' },
    { date: '2026-02-11', name: 'National Foundation Day' },
    { date: '2026-02-23', name: "Emperor's Birthday" },
    { date: '2026-03-20', name: 'Vernal Equinox Day' },
    { date: '2026-04-29', name: 'Showa Day' },
    { date: '2026-05-03', name: 'Constitution Day' },
    { date: '2026-05-04', name: 'Greenery Day' },
    { date: '2026-05-05', name: "Children's Day" },
    { date: '2026-07-20', name: 'Marine Day' },
    { date: '2026-08-11', name: 'Mountain Day' },
    { date: '2026-09-21', name: 'Respect for the Aged Day' },
    { date: '2026-09-23', name: 'Autumnal Equinox Day' },
    { date: '2026-10-12', name: 'Sports Day' },
    { date: '2026-11-03', name: 'Culture Day' },
    { date: '2026-11-23', name: 'Labour Thanksgiving Day' },
  ],
  DE: [
    { date: '2025-01-01', name: "New Year's Day (Germany)" },
    { date: '2025-04-18', name: 'Good Friday (Germany)' },
    { date: '2025-04-21', name: 'Easter Monday (Germany)' },
    { date: '2025-05-01', name: 'Labour Day (Germany)' },
    { date: '2025-10-03', name: 'German Unity Day' },
    { date: '2025-12-25', name: 'Christmas Day (Germany)' },
    { date: '2025-12-26', name: 'Boxing Day (Germany)' },
    { date: '2026-01-01', name: "New Year's Day (Germany)" },
    { date: '2026-04-03', name: 'Good Friday (Germany)' },
    { date: '2026-04-06', name: 'Easter Monday (Germany)' },
    { date: '2026-05-01', name: 'Labour Day (Germany)' },
    { date: '2026-10-03', name: 'German Unity Day' },
    { date: '2026-12-25', name: 'Christmas Day (Germany)' },
    { date: '2026-12-26', name: 'Boxing Day (Germany)' },
  ],
  AU: [
    { date: '2025-01-01', name: "New Year's Day (Australia)" },
    { date: '2025-01-27', name: 'Australia Day' },
    { date: '2025-04-18', name: 'Good Friday (Australia)' },
    { date: '2025-04-21', name: 'Easter Monday (Australia)' },
    { date: '2025-04-25', name: 'Anzac Day' },
    { date: '2025-06-09', name: "Queen's Birthday (Australia)" },
    { date: '2025-12-25', name: 'Christmas Day (Australia)' },
    { date: '2025-12-26', name: 'Boxing Day (Australia)' },
    { date: '2026-01-01', name: "New Year's Day (Australia)" },
    { date: '2026-01-26', name: 'Australia Day' },
    { date: '2026-04-03', name: 'Good Friday (Australia)' },
    { date: '2026-04-06', name: 'Easter Monday (Australia)' },
    { date: '2026-04-25', name: 'Anzac Day' },
    { date: '2026-12-25', name: 'Christmas Day (Australia)' },
    { date: '2026-12-26', name: 'Boxing Day (Australia)' },
  ],
}

// Map watchlist symbols to their relevant market(s)
function getMarketsForSymbol(sym) {
  const s = sym.toUpperCase()
  if (s === 'JPN225' || s === 'NIKKEI') return ['JP', 'US']
  if (s === 'GER40' || s === 'DAX') return ['DE', 'US']
  if (s === 'NAS100' || s === 'SPX500' || s === 'US30') return ['US']
  if (/^(NATGAS|COPPER|COCOA|COFFEE|SUGAR|WHEAT|CORN|SOYBEAN|WTI|BRENT|PLATINUM|SILVER)/.test(s)) return ['US']
  if (/^AUD/.test(s)) return ['AU', 'US']
  if (/^JPY$|JPY$/.test(s)) return ['JP', 'US']
  if (/^EUR|^GBP|^CHF/.test(s)) return ['DE', 'US']
  if (/^XAU|^XAG/.test(s)) return ['US']
  if (/^(BTC|ETH|SOL|XRP|DOGE|ADA)/.test(s)) return [] // 24/7
  // Default US stocks/assets
  return ['US']
}

async function fetchFF(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

function mapFFImpact(impact) {
  if (!impact) return 'low'
  const l = impact.toLowerCase()
  if (l === 'high' || l === 'holiday') return 'high'
  if (l === 'medium') return 'medium'
  return 'low'
}

// ---------------------------------------------------------------------------
// Recurring commodity/futures report schedule
// EIA Natural Gas Storage: every Thursday 10:30 ET (15:30 UTC)
// EIA Petroleum Status:    every Wednesday 10:30 ET (15:30 UTC)
// USDA WASDE:              monthly ~10th at 12:00 ET (17:00 UTC)
// ---------------------------------------------------------------------------

function generateRecurringEvents(fromDate, toDate, symbols) {
  const events = []
  const from = new Date(fromDate)
  const to = new Date(toDate)

  const hasFutures = symbols.some(s =>
    /^(NATGAS|NGAS|OIL|BRENT|WTI|USOIL|UKOIL)$/i.test(s)
  )
  const hasCocoa = symbols.some(s => /COCOA/i.test(s))
  const hasCopper = symbols.some(s => /COPPER/i.test(s))
  const hasAgri = symbols.some(s => /^(WHEAT|CORN|SOYBEAN|COFFEE|SUGAR|COTTON)$/i.test(s))

  // EIA Natural Gas Storage (Thursday 15:30 UTC) — relevant for NATGAS
  if (hasFutures) {
    const d = new Date(from)
    d.setUTCHours(15, 30, 0, 0)
    // Advance to first Thursday
    while (d.getDay() !== 4) d.setDate(d.getDate() + 1)
    while (d <= to) {
      const dateStr = d.toISOString().slice(0, 10)
      events.push({
        date: dateStr, time: '15:30',
        event: 'EIA Natural Gas Storage',
        category: 'economic', impact: 'high',
        currency: 'USD', symbols: ['NATGAS'],
        details: 'Weekly storage change vs forecast',
        source: 'static',
      })
      d.setDate(d.getDate() + 7)
    }
  }

  // EIA Petroleum Status (Wednesday 15:30 UTC) — relevant for OIL/WTI
  if (hasFutures) {
    const d = new Date(from)
    d.setUTCHours(15, 30, 0, 0)
    while (d.getDay() !== 3) d.setDate(d.getDate() + 1)
    while (d <= to) {
      const dateStr = d.toISOString().slice(0, 10)
      events.push({
        date: dateStr, time: '15:30',
        event: 'EIA Weekly Petroleum Report',
        category: 'economic', impact: 'medium',
        currency: 'USD', symbols: ['OIL', 'NATGAS'],
        details: 'Crude oil & product inventories',
        source: 'static',
      })
      d.setDate(d.getDate() + 7)
    }
  }

  // USDA WASDE (monthly, approx 10th at 17:00 UTC) — relevant for COCOA, agricultural
  if (hasCocoa || hasAgri) {
    const d = new Date(from)
    d.setUTCDate(10)
    d.setUTCHours(17, 0, 0, 0)
    if (d < from) d.setUTCMonth(d.getUTCMonth() + 1)
    while (d <= to) {
      // Skip weekends — move to Friday if on weekend
      if (d.getDay() === 0) d.setDate(d.getDate() - 2)
      if (d.getDay() === 6) d.setDate(d.getDate() - 1)
      const dateStr = d.toISOString().slice(0, 10)
      events.push({
        date: dateStr, time: '17:00',
        event: 'USDA WASDE Report',
        category: 'economic', impact: 'high',
        currency: 'USD', symbols: ['COCOA', 'WHEAT', 'CORN'],
        details: 'World Agricultural Supply & Demand Estimates',
        source: 'static',
      })
      d.setUTCMonth(d.getUTCMonth() + 1)
      d.setUTCDate(10)
    }
  }

  // LME Copper warehouse stocks report (every weekday — but only show Mondays as weekly summary)
  if (hasCopper) {
    const d = new Date(from)
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1) // first Monday
    while (d <= to) {
      const dateStr = d.toISOString().slice(0, 10)
      events.push({
        date: dateStr, time: '08:00',
        event: 'LME Copper Stocks Report',
        category: 'economic', impact: 'medium',
        currency: 'USD', symbols: ['COPPER'],
        details: 'Weekly LME warehouse inventory levels',
        source: 'static',
      })
      d.setDate(d.getDate() + 7)
    }
  }

  return events
}

function parseFFEvents(ffData, fromDate, toDate) {
  const events = []
  for (const item of ffData) {
    if (!item.date || !item.title) continue
    const d = new Date(item.date)
    if (isNaN(d.getTime())) continue
    const dateStr = d.toISOString().slice(0, 10)
    if (dateStr < fromDate || dateStr > toDate) continue
    const hours = String(d.getUTCHours()).padStart(2, '0')
    const mins = String(d.getUTCMinutes()).padStart(2, '0')
    const time = hours === '00' && mins === '00' ? 'all-day' : `${hours}:${mins}`
    events.push({
      date: dateStr,
      time,
      event: item.title,
      category: item.impact === 'holiday' ? 'holiday' : 'economic',
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

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method not allowed' })
  }

  const body = readBody(req)
  const apiKey = body.apiKey // MASSIVE_API_KEY env fallback disabled — no longer in use
  if (!apiKey) return res.status(400).json({ error: 'Massive API key required' })

  const { action } = body
  if (!action) return res.status(400).json({ error: 'action required' })

  try {
    if (action === 'generate') {
      const { symbols = [] } = body
      const today = formatDate(new Date())
      const sixMonthsOut = formatDate(new Date(Date.now() + 183 * 86_400_000))
      const events = []

      // 1. US market holidays from Polygon (live, authoritative)
      try {
        const holidays = await polygonGet('/v1/marketstatus/upcoming', apiKey)
        if (Array.isArray(holidays)) {
          for (const h of holidays) {
            if (h.date && h.date >= today && h.date <= sixMonthsOut) {
              events.push({
                date: h.date,
                time: 'all-day',
                event: h.name || 'Market Holiday',
                category: 'holiday',
                impact: h.status === 'closed' ? 'high' : 'medium',
                currency: 'USD',
                symbols: [],
                details: h.exchange ? `${h.exchange}: ${h.status || 'closed'}` : (h.status || 'closed'),
                source: 'polygon',
              })
            }
          }
        }
      } catch {}

      // 2. International holidays based on watchlist symbols
      const seenHolidays = new Set(events.map(e => e.date + '|' + e.event))
      const relevantMarkets = new Set()
      for (const sym of symbols) {
        for (const mkt of getMarketsForSymbol(sym)) relevantMarkets.add(mkt)
      }
      for (const market of relevantMarkets) {
        const marketLabel = { US: 'USD', JP: 'JPY', DE: 'EUR', AU: 'AUD' }[market] || market
        for (const h of (INTL_HOLIDAYS[market] || [])) {
          if (h.date < today || h.date > sixMonthsOut) continue
          const key = h.date + '|' + h.name
          if (seenHolidays.has(key)) continue
          seenHolidays.add(key)
          events.push({
            date: h.date,
            time: 'all-day',
            event: h.name,
            category: 'holiday',
            impact: 'high',
            currency: marketLabel,
            symbols: [],
            details: `${market} market closed`,
            source: 'static',
          })
        }
      }

      // 3. Dividends for watchlist stocks
      const stockTickers = symbols.filter(s => /^[A-Z]{1,5}$/.test(s))
      if (stockTickers.length > 0) {
        try {
          const divData = await polygonGet('/v3/reference/dividends', apiKey, {
            'ticker.in': stockTickers.join(','),
            'ex_dividend_date.gte': today,
            'ex_dividend_date.lte': sixMonthsOut,
            order: 'asc',
            limit: 100,
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

      // 4. Stock splits
      if (stockTickers.length > 0) {
        try {
          const splitData = await polygonGet('/v3/reference/stock-splits', apiKey, {
            'ticker.in': stockTickers.join(','),
            'execution_date.gte': today,
            'execution_date.lte': sixMonthsOut,
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

      // 5. ForexFactory this week + next week
      const [ffThis, ffNext] = await Promise.all([
        fetchFF('https://nfs.faireconomy.media/ff_calendar_thisweek.json'),
        fetchFF('https://nfs.faireconomy.media/ff_calendar_nextweek.json'),
      ])
      const ffAll = [...ffThis, ...ffNext]
      const ffParsed = parseFFEvents(ffAll, today, sixMonthsOut)
      events.push(...ffParsed)

      // 6. Commodity/futures recurring reports (EIA, USDA, LME)
      const recurringEvents = generateRecurringEvents(today, sixMonthsOut, symbols)
      events.push(...recurringEvents)

      // Sort: date asc, then impact high → low
      const impactOrder = { high: 0, medium: 1, low: 2 }
      events.sort((a, b) => {
        const dc = a.date.localeCompare(b.date)
        if (dc !== 0) return dc
        return (impactOrder[a.impact] ?? 2) - (impactOrder[b.impact] ?? 2)
      })

      return res.status(200).json({ events, generatedAt: new Date().toISOString() })
    }

    return res.status(400).json({ error: `unknown action: ${action}` })
  } catch (e) {
    return res.status(500).json({ error: e.message || 'calendar failed' })
  }
}
