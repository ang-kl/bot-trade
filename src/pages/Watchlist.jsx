// Watchlist page — symbol management with scrollable economic calendar sidebar.

import { useState, useEffect, useCallback, useMemo } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import WatchlistTab from '../components/Settings/WatchlistTab.jsx'
import { useStrategy } from '../lib/strategy-store.js'

const SCAN_CACHE_KEY = 'bot-trade:scan-cache'

function readPriceCache() {
  try {
    const raw = localStorage.getItem(SCAN_CACHE_KEY)
    if (!raw) return { metrics: {}, scanResults: {}, age: Infinity }
    const cache = JSON.parse(raw)
    return {
      metrics: cache.massiveMetrics || {},
      scanResults: cache.scanResults || {},
      age: Date.now() - (cache.massiveCachedAt || 0),
    }
  } catch { return { metrics: {}, scanResults: {}, age: Infinity } }
}

function fmtPrice(v) {
  if (v == null || v === 0) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 })
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `${res.status}`)
  return data
}

const IMPACT_TONE = { high: 'down', medium: 'warning', low: 'neutral' }
const CATEGORY_ICON = {
  economic: '📊',
  holiday: '🏖',
  earnings: '💰',
  political: '🏛',
  'central-bank': '🏦',
  sector: '🏭',
}

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Compute { year, month } for an offset relative to today's month
function monthFromOffset(offset) {
  const now = new Date()
  let m = now.getMonth() + offset
  let y = now.getFullYear()
  while (m < 0) { m += 12; y-- }
  while (m > 11) { m -= 12; y++ }
  return { year: y, month: m }
}

// ── Single month grid ──
function MiniCalendar({ year, month, selectedDate, eventDates, onSelectDate }) {
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const today = new Date().toISOString().slice(0, 10)

  const cells = []
  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  return (
    <div>
      <p className="text-center font-bold text-[11px] text-[var(--color-text)] mb-1">
        {MONTHS_SHORT[month]} {year}
      </p>
      <div className="grid grid-cols-7 gap-0">
        {DAYS.map(d => (
          <div key={d} className="text-center text-[8px] font-bold text-[var(--color-muted)] py-0.5">{d}</div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`e-${i}`} />
          const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const isToday = dateStr === today
          const isSelected = dateStr === selectedDate
          const hasEvents = eventDates.has(dateStr)
          const isPast = dateStr < today
          return (
            <button
              key={dateStr}
              type="button"
              onClick={() => onSelectDate(dateStr)}
              className={`text-[10px] py-1 rounded-[3px] cursor-pointer transition-colors relative ${
                isSelected
                  ? 'bg-[var(--color-accent)] text-white font-bold'
                  : isToday
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-bold'
                    : isPast
                      ? 'text-[var(--color-muted)] hover:bg-[var(--color-bg)]'
                      : 'text-[var(--color-text)] hover:bg-[var(--color-bg)]'
              }`}
            >
              {day}
              {hasEvents && (
                <span className={`absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full ${
                  isSelected ? 'bg-white' : 'bg-[var(--color-down)]'
                }`} />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Day event panel ──
function CalendarDetail({ events, date }) {
  const fmtDate = (d) => {
    const dt = new Date(d + 'T00:00:00')
    const today = new Date().toISOString().slice(0, 10)
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    if (d === today) return 'Today'
    if (d === tomorrow) return 'Tomorrow'
    return dt.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short' })
  }

  const dayEvents = (events || []).filter(e => e.date === date)

  return (
    <Card className="mb-3">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="t-label">{fmtDate(date)}</h3>
        {dayEvents.length > 0
          ? <Badge tone="info" pill>{dayEvents.length} events</Badge>
          : <span className="t-meta text-[var(--color-muted)]">No events</span>
        }
      </div>
      {dayEvents.length > 0 && (
        <div className="space-y-1 max-h-[300px] overflow-y-auto">
          {dayEvents.map((e, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[11px]">
              <span className="shrink-0 w-[38px] font-mono text-[var(--color-muted)]">
                {e.time === 'all-day' ? 'all' : e.time || '--:--'}
              </span>
              <span className="shrink-0">{CATEGORY_ICON[e.category] || '●'}</span>
              <Badge tone={IMPACT_TONE[e.impact] || 'neutral'} className="shrink-0 text-[8px] px-1">
                {(e.impact || 'low').toUpperCase()}
              </Badge>
              {e.currency && (
                <span className="shrink-0 text-[9px] font-bold text-[var(--color-accent)] min-w-[28px]">{e.currency}</span>
              )}
              <span className="text-[var(--color-text)] flex-1">
                <span className="font-semibold">{e.event}</span>
                {e.details && <span className="text-[var(--color-muted)] ml-1">{e.details}</span>}
              </span>
              {e.source && (
                <span className="text-[8px] text-[var(--color-muted)] shrink-0">
                  {e.source === 'forexfactory' ? 'FF' : e.source === 'polygon' ? 'PG' : '📌'}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ── Main page ──
export default function Watchlist() {
  const { state } = useStrategy()
  const [calendarEvents, setCalendarEvents] = useState([])
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10))
  // monthOffset: 0 = current month is first, negative = go back, positive = start in future
  const [monthOffset, setMonthOffset] = useState(0)
  // numMonths: how many months to show (2–6)
  const [numMonths, setNumMonths] = useState(3)

  const eventDates = new Set(calendarEvents.map(e => e.date))

  const fetchCalendar = useCallback(async () => {
    if (!state.massive.apiKey) return
    setCalendarLoading(true)
    try {
      const syms = state.watchlist.filter(w => w.enabled).map(w => w.symbol)
      const data = await apiPost('/api/calendar', {
        action: 'generate',
        symbols: syms,
        apiKey: state.massive.apiKey,
      })
      setCalendarEvents(data.events || [])
    } catch {}
    finally { setCalendarLoading(false) }
  }, [state.massive.apiKey, state.watchlist])

  useEffect(() => { fetchCalendar() }, [fetchCalendar])

  // Generate the month list to display
  const months = Array.from({ length: numMonths }, (_, i) => monthFromOffset(monthOffset + i))

  const handleSelectDate = (dateStr) => {
    setSelectedDate(dateStr)
  }

  // Build pill list: unique dates with events, today onward, next 14 days
  const today = new Date().toISOString().slice(0, 10)
  const pillDates = useMemo(() => {
    const cutoff = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
    const dateMap = {}
    for (const e of calendarEvents) {
      if (e.date >= today && e.date <= cutoff) {
        if (!dateMap[e.date]) dateMap[e.date] = { total: 0, high: 0 }
        dateMap[e.date].total++
        if (e.impact === 'high') dateMap[e.date].high++
      }
    }
    return Object.entries(dateMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, counts]) => ({ date, ...counts }))
  }, [calendarEvents, today])

  const fmtPillDate = (d) => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    if (d === today) return 'Today'
    if (d === tomorrow) return 'Tomorrow'
    const dt = new Date(d + 'T00:00:00')
    return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  }

  // ── Price ticker from MASSIVE cache ──
  const [priceCache, setPriceCache] = useState(readPriceCache)
  useEffect(() => {
    const iv = setInterval(() => setPriceCache(readPriceCache()), 10_000)
    return () => clearInterval(iv)
  }, [])

  const enabledSymbols = state.watchlist.filter(w => w.enabled)
  const cacheAgeMin = Math.floor(priceCache.age / 60_000)

  return (
    <div className="flex gap-3 items-start">
      {/* Main content */}
      <div className="flex-1 min-w-0">

        {/* Live price ticker strip */}
        {enabledSymbols.length > 0 && (
          <Card className="mb-3 !py-2">
            <div className="flex items-center gap-1 mb-1.5">
              <p className="t-meta font-bold text-[var(--color-text)] text-[10px]">Prices</p>
              <span className="text-[8px] text-[var(--color-muted)]">
                MASSIVE {cacheAgeMin < 1 ? 'just now' : `${cacheAgeMin}m ago`}
              </span>
            </div>
            <div className="flex gap-2 flex-wrap">
              {enabledSymbols.map(w => {
                const mm = priceCache.metrics[w.symbol] || {}
                const scan = priceCache.scanResults[w.symbol] || {}
                const price = mm.price || scan?.price || null
                const changePct = mm.change_pct
                const ema = mm.ema_stack?.stack
                const isUp = changePct > 0
                const isDown = changePct < 0
                return (
                  <div
                    key={w.symbol}
                    className="flex items-center gap-1 px-2 py-1 rounded-[5px] bg-[var(--color-bg)] text-[10px] min-w-[100px]"
                  >
                    <span className="font-bold text-[var(--color-text)] text-[9px]">{w.symbol}</span>
                    <span className="font-mono font-semibold text-[var(--color-text)]">{fmtPrice(price)}</span>
                    {changePct != null && (
                      <span className={`text-[8px] font-bold ${isUp ? 'text-[var(--color-up)]' : isDown ? 'text-[var(--color-down)]' : 'text-[var(--color-muted)]'}`}>
                        {isUp ? '+' : ''}{changePct.toFixed(2)}%
                      </span>
                    )}
                    {ema && (
                      <span className={`text-[7px] ${ema.startsWith('Bull') ? 'text-[var(--color-up)]' : ema.startsWith('Bear') ? 'text-[var(--color-down)]' : 'text-[var(--color-muted)]'}`}>
                        {ema.startsWith('Bull') ? '▲' : ema.startsWith('Bear') ? '▼' : '—'}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>
        )}

        {/* Event day pill strip */}
        {pillDates.length > 0 && (
          <div className="flex gap-1.5 flex-wrap mb-3">
            {pillDates.map(({ date, total, high }) => (
              <button
                key={date}
                type="button"
                onClick={() => handleSelectDate(date)}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold cursor-pointer transition-colors border ${
                  selectedDate === date
                    ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
                    : high > 0
                      ? 'bg-[var(--color-down)]/10 text-[var(--color-down)] border-[var(--color-down)]/30 hover:bg-[var(--color-down)]/20'
                      : 'bg-[var(--color-bg)] text-[var(--color-text-sub)] border-[var(--color-border)] hover:bg-[var(--color-accent-soft)]'
                }`}
              >
                {fmtPillDate(date)}
                <span className={`text-[9px] ${selectedDate === date ? 'text-white/70' : 'text-[var(--color-muted)]'}`}>
                  {total}
                </span>
                {high > 0 && selectedDate !== date && (
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-down)]" />
                )}
              </button>
            ))}
          </div>
        )}
        <CalendarDetail events={calendarEvents} date={selectedDate} />
        <WatchlistTab />
      </div>

      {/* Calendar sidebar */}
      <div className="hidden lg:block w-[210px] shrink-0 sticky top-4 max-h-screen overflow-y-auto">
        <Card className="!p-2">
          {/* Header row */}
          <div className="flex items-center justify-between mb-2">
            <span className="t-meta font-bold text-[var(--color-text)]">Calendar</span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={fetchCalendar} disabled={calendarLoading} className="!px-1 !py-0 text-[10px]">
                {calendarLoading ? '…' : '↻'}
              </Button>
            </div>
          </div>

          {/* Month count control */}
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => setMonthOffset(p => p - 1)}
              className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-bg)] text-[var(--color-muted)] hover:text-[var(--color-text)] cursor-pointer"
              title="Previous month"
            >◀</button>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setNumMonths(p => Math.max(2, p - 1))}
                className="text-[10px] w-4 h-4 rounded bg-[var(--color-bg)] text-[var(--color-muted)] hover:text-[var(--color-text)] cursor-pointer leading-none"
                title="Show fewer months"
              >−</button>
              <span className="text-[9px] text-[var(--color-muted)]">{numMonths}mo</span>
              <button
                type="button"
                onClick={() => setNumMonths(p => Math.min(6, p + 1))}
                className="text-[10px] w-4 h-4 rounded bg-[var(--color-bg)] text-[var(--color-muted)] hover:text-[var(--color-text)] cursor-pointer leading-none"
                title="Show more months"
              >+</button>
            </div>
            <button
              type="button"
              onClick={() => setMonthOffset(p => p + 1)}
              className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-bg)] text-[var(--color-muted)] hover:text-[var(--color-text)] cursor-pointer"
              title="Next month"
            >▶</button>
          </div>

          {/* Jump to today */}
          {monthOffset !== 0 && (
            <button
              type="button"
              onClick={() => setMonthOffset(0)}
              className="w-full text-[9px] text-[var(--color-accent)] hover:underline mb-2 cursor-pointer"
            >
              ↩ back to today
            </button>
          )}

          {/* Month grids */}
          <div className="space-y-3">
            {months.map(({ year, month }) => (
              <MiniCalendar
                key={`${year}-${month}`}
                year={year}
                month={month}
                selectedDate={selectedDate}
                eventDates={eventDates}
                onSelectDate={handleSelectDate}
              />
            ))}
          </div>

          {!state.massive.apiKey && (
            <p className="text-[9px] text-[var(--color-down)] mt-2">Set Massive API key in Admin for calendar events.</p>
          )}

          {/* Event count summary */}
          {calendarEvents.length > 0 && (
            <p className="text-[9px] text-[var(--color-muted)] mt-2 text-center">
              {calendarEvents.length} events loaded
            </p>
          )}
        </Card>
      </div>
    </div>
  )
}
