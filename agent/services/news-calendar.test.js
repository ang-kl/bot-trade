// node --test agent/services/news-calendar.test.js — pure parts only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { symbolCurrencies, relevantEvents, formatNewsLines } from './news-calendar.js'

test('symbolCurrencies maps symbols to the currencies that move them', () => {
  assert.deepEqual(symbolCurrencies('EURUSD'), ['EUR', 'USD'])
  assert.deepEqual(symbolCurrencies('JPN225'), ['JPY'])
  assert.deepEqual(symbolCurrencies('NAS100'), ['USD'])
  assert.deepEqual(symbolCurrencies('XAUUSD'), ['USD'])
  assert.deepEqual(symbolCurrencies('MSFT.US'), ['USD'])
})

const now = Date.UTC(2026, 6, 10, 12, 0)
const ev = (country, impact, hoursFromNow, title = 'CPI') =>
  ({ country, impact, title, date: new Date(now + hoursFromNow * 3600_000).toISOString() })

test('relevantEvents: currency match, impact filter, time window, sorted, capped', () => {
  const events = [
    ev('USD', 'High', 3), ev('USD', 'Low', 1), ev('EUR', 'High', 5),
    ev('JPY', 'High', 2), ev('USD', 'Medium', -1), ev('USD', 'High', 40),
    ev('USD', 'High', 6), ev('USD', 'High', 8), ev('USD', 'Medium', 10), ev('USD', 'High', 12),
  ]
  const rel = relevantEvents(events, 'EURUSD', now)
  assert.ok(rel.every(e => ['USD', 'EUR'].includes(e.country)))
  assert.ok(rel.every(e => e.impact !== 'Low'))
  assert.ok(!rel.some(e => e.t > now + 24 * 3600_000), '40h event excluded')
  assert.equal(rel.length, 4, 'capped at 4')
  assert.ok(rel[0].t <= rel[1].t)
})

test('formatNewsLines: words + impact marker, past and future phrasing', () => {
  const lines = formatNewsLines(relevantEvents([ev('USD', 'High', 3), ev('USD', 'Medium', -1)], 'EURUSD', now), now)
  assert.match(lines.find(l => l.includes('HIGH')), /in 3h/)
  assert.match(lines.find(l => l.includes('med')), /60m ago/)
})

// ---------------------------------------------------------------------------
// News-window entry gate (owner-approved 2026-07-24)
// ---------------------------------------------------------------------------

test('newsWindowEvent: blocks inside the window, only matching currency+impact', async () => {
  const { newsWindowEvent } = await import('./news-calendar.js')
  const mins = (m) => new Date(now + m * 60_000).toISOString()
  const events = [
    { title: 'CPI', country: 'USD', impact: 'High', date: mins(10) },     // 10m ahead
    { title: 'PMI', country: 'EUR', impact: 'Medium', date: mins(5) },
    { title: 'Rate', country: 'JPY', impact: 'High', date: mins(2) },
  ]
  // EURUSD blocked by the USD High print 10m out (default 15m window)…
  const hit = newsWindowEvent(events, 'EURUSD', now)
  assert.equal(hit?.title, 'CPI')
  // …Medium impact ignored by default, honoured when configured…
  assert.equal(newsWindowEvent([events[1]], 'EURUSD', now), null)
  assert.equal(newsWindowEvent([events[1]], 'EURUSD', now, { impacts: ['High', 'Medium'] })?.title, 'PMI')
  // …unrelated currency never blocks, and outside the window never blocks.
  assert.equal(newsWindowEvent(events, 'AUS200', now), null)
  assert.equal(newsWindowEvent([{ title: 'CPI', country: 'USD', impact: 'High', date: mins(40) }], 'EURUSD', now), null)
  // Just-passed print still blocks within minAfter.
  assert.equal(newsWindowEvent([{ title: 'NFP', country: 'USD', impact: 'High', date: mins(-10) }], 'XAUUSD', now)?.title, 'NFP')
})

test('risk gate: newsGateEnabled vetoes news_window from the CACHED calendar; off by default', async () => {
  const { initDB, setState } = await import('../db.js')
  const { evaluateTrade, DEFAULT_RISK_CONFIG } = await import('./risk.js')
  const db = initDB(':memory:')
  setState(db, 'account_balance_usd', '10000')
  setState(db, 'ctrader_account_id', 'A')
  setState(db, 'news_calendar_json', JSON.stringify([
    { title: 'FOMC', country: 'USD', impact: 'High', date: new Date(Date.now() + 5 * 60_000).toISOString() },
  ]))
  setState(db, 'news_calendar_fetched_ms', String(Date.now()))
  const proposal = { symbol: 'EURUSD', side: 'BUY', entry: 1.1, sl: 1.095, tp1: 1.11, requestedVolume: 0.01, accountId: 'A' }
  // Default config: gate OFF → no news veto.
  const off = evaluateTrade(db, proposal, { ...DEFAULT_RISK_CONFIG })
  assert.ok(!/news_window/.test(off.veto_reason || ''), 'gate must be off by default')
  // Enabled: vetoed with the event named.
  const on = evaluateTrade(db, proposal, { ...DEFAULT_RISK_CONFIG, newsGateEnabled: true })
  assert.equal(on.approved, false)
  assert.match(on.veto_reason, /news_window: High USD FOMC/)
  // Unaffected symbol still trades with the gate on.
  const jpy = evaluateTrade(db, { ...proposal, symbol: 'AUS200' }, { ...DEFAULT_RISK_CONFIG, newsGateEnabled: true })
  assert.ok(!/news_window/.test(jpy.veto_reason || ''))
})

test('signalButtons + tvSymbol: rows, callback data, TV mapping', async () => {
  const { signalButtons, tvSymbol } = await import('./alert-format.js')
  assert.equal(tvSymbol('US30'), 'DJI')
  assert.equal(tvSymbol('MCHP.US'), 'MCHP')
  assert.equal(tvSymbol('EURUSD'), 'EURUSD')
  const rows = signalButtons({ sym: 'MCHP.US', tf: '1d', strategy: 'fib_618_fade' })
  assert.equal(rows.length, 1)
  const [chart, arm, tv] = rows[0]
  assert.equal(chart.callback_data, 'chart|MCHP.US|1d')
  assert.equal(arm.callback_data, 'arm|fib_618_fade|MCHP.US|1d')
  assert.match(tv.url, /tradingview\.com\/chart\/\?symbol=MCHP$/)
  assert.ok(rows[0].every(b => (b.callback_data || '').length <= 64))
})
