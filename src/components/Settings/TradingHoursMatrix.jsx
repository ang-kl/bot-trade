// 24-hour trading hours matrix — columns = hours (0-23), rows = symbols.
// Grouped by category with expandable headers. Red column = current UTC hour.

import { useState, useMemo, useEffect } from 'react'
import Badge from '../common/Badge.jsx'
import { getHoursForSymbol, isTradingNow, PEPPERSTONE_CATALOG } from '../../lib/trading-hours.js'

const HOURS = Array.from({ length: 24 }, (_, i) => i)

// Get NY offset from UTC (handles DST)
function getNYOffset() {
  const now = new Date()
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' })
  const nyStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' })
  return Math.round((new Date(nyStr) - new Date(utcStr)) / 3_600_000)
}

// Get user locale offset from UTC
function getLocaleOffset() {
  return -(new Date().getTimezoneOffset() / 60)
}

// Convert UTC hour to another timezone hour
function utcToTz(utcHour, offsetHours) {
  return ((utcHour + offsetHours) % 24 + 24) % 24
}

// Format hh:mm for a given UTC hour in a timezone
function fmtHHMM(utcHour, offsetHours) {
  const h = utcToTz(utcHour, offsetHours)
  return String(h).padStart(2, '0') + ':00'
}

// Compute dd/mm for midnight (00:00) in a timezone.
// Returns the date string only for the column where that tz hits midnight,
// otherwise returns null.
function midnightDateLabel(utcHour, offsetHours, baseDate) {
  const tzHour = utcToTz(utcHour, offsetHours)
  if (tzHour !== 0) return null // only show on midnight column
  // Build a Date for this UTC hour, then shift to the timezone
  const d = new Date(baseDate)
  d.setUTCHours(utcHour, 0, 0, 0)
  // Handle column wrap: if UTC hour < current UTC hour by a lot, it's tomorrow
  const nowUtcH = baseDate.getUTCHours()
  if (utcHour - nowUtcH < -12) d.setUTCDate(d.getUTCDate() + 1)
  const shifted = new Date(d.getTime() + offsetHours * 3_600_000)
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  return day + '/' + month
}

// Build exchange lookup from catalog
const EXCHANGE_MAP = Object.fromEntries(PEPPERSTONE_CATALOG.map(c => [c.symbol, c.exchange || '']))

// Check if a symbol trades during a specific hour
function isActiveAt(symbol, hour) {
  const hours = getHoursForSymbol(symbol)
  return hours.some(h => {
    if (h.open < h.close) return hour >= h.open && hour < h.close
    return hour >= h.open || hour < h.close
  })
}

// Group array by key function
function groupBy(arr, fn) {
  const groups = {}
  for (const item of arr) {
    const key = fn(item)
    if (!groups[key]) groups[key] = []
    groups[key].push(item)
  }
  return groups
}

// Compute category stats from Massive risk metrics
function computeCategoryStats(items, massiveMetrics = {}) {
  const metrics = { count: items.length, open: 0, hasData: 0, avgSharpe: null, avgMaxDD: null, avgBeta: null, avgVaR: null }
  let sharpeSum = 0, ddSum = 0, betaSum = 0, varSum = 0, n = 0
  for (const w of items) {
    if (isTradingNow(w.symbol)) metrics.open++
    const mm = massiveMetrics[w.symbol]
    if (!mm?.risk_metrics) continue
    metrics.hasData++
    const rm = mm.risk_metrics
    if (rm.sharpe != null) { sharpeSum += rm.sharpe; n++ }
    if (rm.max_drawdown != null) ddSum += rm.max_drawdown
    if (rm.beta != null) betaSum += rm.beta
    if (rm.var_95 != null) varSum += rm.var_95
  }
  if (n > 0) {
    metrics.avgSharpe = (sharpeSum / n).toFixed(2)
    metrics.avgMaxDD = (ddSum / n).toFixed(1)
    metrics.avgBeta = (betaSum / n).toFixed(2)
    metrics.avgVaR = (varSum / n).toFixed(1)
  }
  return metrics
}

const CATEGORY_ORDER = ['Currencies', 'Crypto', 'Indices', 'Metals', 'Futures', 'Stocks']

// Shared font class for all three header rows
const HEADER_FONT = 'text-[8px] sm:text-[9px]'

export default function TradingHoursMatrix({ watchlist, groupMode = 'category', onToggle, massiveMetrics = {} }) {
  const [collapsed, setCollapsed] = useState({})
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])
  const nowUTC = now.getUTCHours()
  const nyOffset = getNYOffset()
  const localeOffset = getLocaleOffset()
  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const userTzShort = userTz.split('/').pop().replace(/_/g, ' ')

  const toggleGroup = (key) => {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))
  }

  // Group symbols
  const groups = useMemo(() => {
    if (groupMode === 'status') {
      return groupBy(watchlist, w => isTradingNow(w.symbol) ? 'Open Now' : 'Closed')
    }
    if (groupMode === 'ticker') {
      const sorted = [...watchlist].sort((a, b) => a.symbol.localeCompare(b.symbol))
      return { 'All Symbols': sorted }
    }
    return groupBy(watchlist, w => w.category || 'Other')
  }, [watchlist, groupMode])

  const groupKeys = useMemo(() => {
    if (groupMode === 'category') {
      return CATEGORY_ORDER.filter(k => groups[k]?.length > 0)
        .concat(Object.keys(groups).filter(k => !CATEGORY_ORDER.includes(k)))
    }
    if (groupMode === 'status') return ['Open Now', 'Closed'].filter(k => groups[k]?.length)
    return Object.keys(groups)
  }, [groups, groupMode])

  if (watchlist.length === 0) return null

  return (
    <div className="overflow-x-auto -mx-2 px-0">
      <table className="border-collapse text-[11px] sm:text-[11px] text-[9px]">
        <thead>
          {/* NY time row */}
          <tr className={HEADER_FONT}>
            <th className="sticky left-0 z-10 bg-[var(--color-surface)] px-1 sm:px-2 py-0.5 text-left text-[var(--color-muted)] font-normal border-r border-[var(--color-border)]">
              NY
            </th>
            {HOURS.map(h => {
              const dateLabel = midnightDateLabel(h, nyOffset, now)
              return (
                <th key={h} className="px-0 py-0.5 text-center font-mono font-normal text-[var(--color-muted)] w-[30px] sm:w-[40px] min-w-[30px] sm:min-w-[40px] leading-tight">
                  <span className="block">{fmtHHMM(h, nyOffset)}</span>
                  {dateLabel && (
                    <span className="block text-[7px] sm:text-[8px] text-[var(--color-accent)] font-semibold">{dateLabel}</span>
                  )}
                </th>
              )
            })}
            <th className="px-1 sm:px-2 py-0.5 border-l border-[var(--color-border)]" />
          </tr>
          {/* UTC row — same font size as NY */}
          <tr className={HEADER_FONT}>
            <th className="sticky left-0 z-10 bg-[var(--color-surface)] px-1 sm:px-2 py-0.5 text-left text-[var(--color-text-sub)] font-medium w-[72px] sm:w-[100px] min-w-[72px] sm:min-w-[100px] border-r border-[var(--color-border)]">
              UTC
            </th>
            {HOURS.map(h => (
              <th
                key={h}
                className={`px-0 py-0.5 text-center font-mono font-medium w-[30px] sm:w-[40px] min-w-[30px] sm:min-w-[40px] ${
                  h === nowUTC
                    ? 'bg-[var(--color-down)]/15 text-[var(--color-down)]'
                    : 'text-[var(--color-text-sub)]'
                }`}
              >
                {fmtHHMM(h, 0)}
              </th>
            ))}
            <th className="px-1 sm:px-2 py-0.5 text-center text-[var(--color-text-sub)] font-medium w-[40px] sm:w-[52px] min-w-[40px] sm:min-w-[52px] border-l border-[var(--color-border)]">
              Status
            </th>
          </tr>
          {/* User locale row — same font size as UTC */}
          <tr className={`${HEADER_FONT} border-b border-[var(--color-border)]`}>
            <th className="sticky left-0 z-10 bg-[var(--color-surface)] px-1 sm:px-2 py-0.5 text-left text-[var(--color-accent)] font-normal border-r border-[var(--color-border)]">
              {userTzShort}
            </th>
            {HOURS.map(h => {
              const isNow = h === nowUTC
              const dateLabel = midnightDateLabel(h, localeOffset, now)
              return (
                <th key={h} className={`px-0 py-0.5 text-center font-mono font-normal leading-tight ${isNow ? 'text-[var(--color-down)] font-bold' : 'text-[var(--color-accent)]'}`}>
                  <span className="block">{fmtHHMM(h, localeOffset)}</span>
                  {dateLabel && (
                    <span className="block text-[7px] sm:text-[8px] font-semibold">{dateLabel}</span>
                  )}
                </th>
              )
            })}
            <th className="px-1 sm:px-2 py-0.5 border-l border-[var(--color-border)]" />
          </tr>
        </thead>
        <tbody>
          {groupKeys.map(groupKey => {
            const items = groups[groupKey] || []
            const isCollapsed = collapsed[groupKey]
            const stats = computeCategoryStats(items, massiveMetrics)

            return [
              // Group header
              <tr
                key={`hdr-${groupKey}`}
                className="bg-[var(--color-bg)] cursor-pointer hover:bg-[var(--color-accent-soft)]/30"
                onClick={() => toggleGroup(groupKey)}
              >
                <td
                  colSpan={26}
                  className="px-2 py-1.5 border-b border-[var(--color-border)]"
                >
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] text-[var(--color-muted)]">
                      {isCollapsed ? '\u25B6' : '\u25BC'}
                    </span>
                    <span className="font-bold text-[var(--color-text)] text-[12px]">{groupKey}</span>
                    <span className="text-[var(--color-muted)]">({items.length})</span>
                    <span className="text-[9px] sm:text-[10px] text-[var(--color-muted)] font-mono flex items-center gap-1.5 flex-wrap">
                      <span className={stats.open > 0 ? 'text-[var(--color-up)] font-bold' : ''}>{stats.open} open</span>
                      {stats.avgSharpe != null && (
                        <>
                          <span className="text-[var(--color-border)]">|</span>
                          <span>Sharpe <span className={Number(stats.avgSharpe) >= 1 ? 'text-[var(--color-up)] font-bold' : Number(stats.avgSharpe) >= 0.5 ? 'text-[var(--color-text)]' : 'text-[var(--color-down)]'}>{stats.avgSharpe}</span></span>
                          <span>DD <span className="text-[var(--color-down)]">{stats.avgMaxDD}%</span></span>
                          <span>Beta <span className={Math.abs(Number(stats.avgBeta) - 1) < 0.3 ? 'text-[var(--color-text)]' : 'text-[var(--color-accent)]'}>{stats.avgBeta}</span></span>
                          <span>VaR <span className="text-[var(--color-down)]">{stats.avgVaR}%</span></span>
                        </>
                      )}
                      {stats.hasData === 0 && stats.count > 0 && (
                        <span className="text-[var(--color-muted)] italic">no metrics</span>
                      )}
                    </span>
                  </div>
                </td>
              </tr>,

              // Symbol rows
              ...(!isCollapsed ? items.map(w => {
                const trading = isTradingNow(w.symbol)
                return (
                  <tr
                    key={w.symbol}
                    className={`border-b border-[var(--color-border)] hover:bg-[var(--color-bg)]/50 ${
                      !w.enabled ? 'opacity-40' : ''
                    }`}
                  >
                    {/* Symbol cell */}
                    <td className="sticky left-0 z-10 bg-[var(--color-surface)] px-1 sm:px-2 py-1 border-r border-[var(--color-border)]">
                      <div className="flex items-center gap-1 sm:gap-1.5">
                        <input
                          type="checkbox"
                          checked={w.enabled}
                          onChange={() => onToggle?.(w.symbol)}
                          className="shrink-0 w-3 h-3 sm:w-4 sm:h-4"
                        />
                        <div className="min-w-0">
                          <span className={`font-bold text-[10px] sm:text-[11px] ${trading ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-sub)]'}`}>
                            {w.symbol}
                          </span>
                          {EXCHANGE_MAP[w.symbol] && (
                            <span className="hidden sm:block text-[8px] text-[var(--color-muted)] leading-tight">
                              {EXCHANGE_MAP[w.symbol]}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Hour cells */}
                    {HOURS.map(h => {
                      const active = isActiveAt(w.symbol, h)
                      const isNow = h === nowUTC
                      return (
                        <td
                          key={h}
                          className={`px-0 py-0.5 sm:py-1 border-[var(--color-border)] ${
                            isNow ? 'border-l border-r border-[var(--color-down)]/40' : ''
                          }`}
                        >
                          <div
                            className={`mx-auto w-[12px] sm:w-[20px] h-[8px] sm:h-[10px] rounded-[2px] ${
                              active
                                ? isNow && trading
                                  ? 'bg-[var(--color-up)]'
                                  : 'bg-[var(--color-accent)]/50'
                                : isNow
                                  ? 'bg-[var(--color-down)]/10'
                                  : 'bg-[var(--color-border)]/30'
                            }`}
                          />
                        </td>
                      )
                    })}

                    {/* Status cell */}
                    <td className="px-1 sm:px-2 py-1 text-center border-l border-[var(--color-border)]">
                      <span className={`text-[8px] sm:text-[9px] font-bold ${
                        trading ? 'text-[var(--color-up)]' : 'text-[var(--color-muted)]'
                      }`}>
                        {trading ? '\u25CF OPEN' : '\u25CB'}
                      </span>
                    </td>
                  </tr>
                )
              }) : []),
            ]
          })}
        </tbody>
      </table>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-2 px-2 text-[10px] text-[var(--color-muted)]">
        <div className="flex items-center gap-1">
          <div className="w-3 h-2 rounded-[1px] bg-[var(--color-accent)]/50" />
          <span>Trading</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-2 rounded-[1px] bg-[var(--color-border)]/30" />
          <span>Closed</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-2 rounded-[1px] bg-[var(--color-up)]" />
          <span>Open now</span>
        </div>
        <span className="text-[var(--color-down)] font-bold">|</span>
        <span>Current UTC hour ({String(nowUTC).padStart(2, '0')}:00)</span>
      </div>
    </div>
  )
}
