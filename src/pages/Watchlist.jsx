// Watchlist page — symbol management with scrollable economic calendar sidebar.

import { useState, useEffect, useCallback } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import WatchlistTab from '../components/Settings/WatchlistTab.jsx'
import { useStrategy } from '../lib/strategy-store.js'

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

  return (
    <div className="flex gap-3 items-start">
      {/* Main content */}
      <div className="flex-1 min-w-0">
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
