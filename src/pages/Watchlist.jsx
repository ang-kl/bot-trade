// Watchlist page — full symbol management with economic calendar sidebar.

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
  economic: '\u{1F4CA}',
  holiday: '\u{1F3D6}',
  earnings: '\u{1F4B0}',
  political: '\u{1F3DB}',
  'central-bank': '\u{1F3E6}',
  sector: '\u{1F3ED}',
}

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function MiniCalendar({ year, month, selectedDate, eventDates, onSelectDate }) {
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const today = new Date().toISOString().slice(0, 10)
  const cells = []

  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  return (
    <div>
      <p className="text-center font-bold text-[12px] text-[var(--color-text)] mb-1">
        {MONTHS[month]} {year}
      </p>
      <div className="grid grid-cols-7 gap-0">
        {DAYS.map(d => (
          <div key={d} className="text-center text-[9px] font-bold text-[var(--color-muted)] py-0.5">{d}</div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`e-${i}`} />
          const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const isToday = dateStr === today
          const isSelected = dateStr === selectedDate
          const hasEvents = eventDates.has(dateStr)
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
                    : 'text-[var(--color-text)] hover:bg-[var(--color-bg)]'
              }`}
            >
              {day}
              {hasEvents && !isSelected && (
                <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[var(--color-down)]" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function CalendarDetail({ events, date }) {
  if (!events || events.length === 0) return null

  const dayEvents = events.filter(e => e.date === date)
  if (dayEvents.length === 0) return null

  const fmtDate = (d) => {
    const dt = new Date(d + 'T00:00:00')
    const today = new Date().toISOString().slice(0, 10)
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    if (d === today) return 'Today'
    if (d === tomorrow) return 'Tomorrow'
    return dt.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short' })
  }

  return (
    <Card className="mb-3">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="t-label">{fmtDate(date)}</h3>
        <Badge tone="info" pill>{dayEvents.length} events</Badge>
      </div>
      <div className="space-y-1 max-h-[300px] overflow-y-auto">
        {dayEvents.map((e, i) => (
          <div key={i} className="flex items-start gap-1.5 text-[11px]">
            <span className="shrink-0 w-[38px] font-mono text-[var(--color-muted)]">
              {e.time === 'all-day' ? 'all' : e.time || '--:--'}
            </span>
            <span className="shrink-0">{CATEGORY_ICON[e.category] || '\u25CF'}</span>
            <Badge
              tone={IMPACT_TONE[e.impact] || 'neutral'}
              className="shrink-0 text-[8px] px-1"
            >
              {(e.impact || 'low').toUpperCase()}
            </Badge>
            {e.currency && (
              <span className="shrink-0 text-[9px] font-bold text-[var(--color-accent)] min-w-[28px]">{e.currency}</span>
            )}
            <span className="text-[var(--color-text)] flex-1">
              <span className="font-semibold">{e.event}</span>
              {e.details && (
                <span className="text-[var(--color-muted)] ml-1">{e.details}</span>
              )}
            </span>
            {e.source && (
              <span className="text-[8px] text-[var(--color-muted)] shrink-0">{e.source === 'forexfactory' ? 'FF' : 'PG'}</span>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

export default function Watchlist() {
  const { state } = useStrategy()
  const [calendarEvents, setCalendarEvents] = useState([])
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10))

  const now = new Date()
  const thisMonth = now.getMonth()
  const thisYear = now.getFullYear()
  const nextMonth = thisMonth === 11 ? 0 : thisMonth + 1
  const nextYear = thisMonth === 11 ? thisYear + 1 : thisYear

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

  useEffect(() => {
    fetchCalendar()
  }, [fetchCalendar])

  return (
    <div className="flex gap-3 items-start">
      {/* Main content */}
      <div className="flex-1 min-w-0">
        {/* Calendar detail for selected date — above the matrix */}
        <CalendarDetail events={calendarEvents} date={selectedDate} />

        {/* Watchlist content (the existing WatchlistTab) */}
        <WatchlistTab />
      </div>

      {/* Calendar sidebar */}
      <div className="hidden lg:block w-[200px] shrink-0 sticky top-4">
        <Card className="!p-2">
          <div className="flex items-center justify-between mb-2">
            <span className="t-meta font-bold text-[var(--color-text)]">Calendar</span>
            <Button size="sm" variant="ghost" onClick={fetchCalendar} disabled={calendarLoading} className="!px-1 !py-0">
              {calendarLoading ? '...' : '\u21BB'}
            </Button>
          </div>
          <div className="space-y-3">
            <MiniCalendar
              year={thisYear}
              month={thisMonth}
              selectedDate={selectedDate}
              eventDates={eventDates}
              onSelectDate={setSelectedDate}
            />
            <MiniCalendar
              year={nextYear}
              month={nextMonth}
              selectedDate={selectedDate}
              eventDates={eventDates}
              onSelectDate={setSelectedDate}
            />
          </div>
          {!state.massive.apiKey && (
            <p className="text-[9px] text-[var(--color-down)] mt-2">Set Massive API key in Admin for calendar events.</p>
          )}
        </Card>
      </div>
    </div>
  )
}
