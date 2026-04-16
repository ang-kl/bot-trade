// 24-hour trading hours matrix — columns = hours (0-23), rows = symbols.
// Grouped by category with expandable headers. Red column = current UTC hour.

import { useState, useMemo } from 'react'
import Badge from '../common/Badge.jsx'
import { getHoursForSymbol, isTradingNow } from '../../lib/trading-hours.js'

const HOURS = Array.from({ length: 24 }, (_, i) => i)

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

const CATEGORY_ORDER = ['Currencies', 'Crypto', 'Indices', 'Metals', 'Futures', 'Stocks']

export default function TradingHoursMatrix({ watchlist, groupMode = 'category', onToggle }) {
  const [collapsed, setCollapsed] = useState({})
  const nowUTC = new Date().getUTCHours()

  const toggleGroup = (key) => {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))
  }

  // Group symbols
  const groups = useMemo(() => {
    if (groupMode === 'status') {
      return groupBy(watchlist, w => isTradingNow(w.symbol) ? 'Open Now' : 'Closed')
    }
    if (groupMode === 'ticker') {
      // Sort alphabetically, no grouping — single group
      const sorted = [...watchlist].sort((a, b) => a.symbol.localeCompare(b.symbol))
      return { 'All Symbols': sorted }
    }
    // Default: category
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
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-[var(--color-surface)] px-2 py-1.5 text-left t-meta text-[var(--color-text-sub)] font-medium w-[100px] min-w-[100px] border-b border-r border-[var(--color-border)]">
              Symbol
            </th>
            {HOURS.map(h => (
              <th
                key={h}
                className={`px-0 py-1.5 text-center font-mono font-medium w-[28px] min-w-[28px] border-b border-[var(--color-border)] ${
                  h === nowUTC
                    ? 'bg-[var(--color-down)]/15 text-[var(--color-down)]'
                    : 'text-[var(--color-muted)]'
                }`}
              >
                {String(h).padStart(2, '0')}
              </th>
            ))}
            <th className="px-2 py-1.5 text-center t-meta text-[var(--color-text-sub)] font-medium w-[52px] min-w-[52px] border-b border-l border-[var(--color-border)]">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {groupKeys.map(groupKey => {
            const items = groups[groupKey] || []
            const isCollapsed = collapsed[groupKey]
            const openCount = items.filter(w => isTradingNow(w.symbol)).length

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
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-[var(--color-muted)]">
                      {isCollapsed ? '\u25B6' : '\u25BC'}
                    </span>
                    <span className="font-bold text-[var(--color-text)] text-[12px]">{groupKey}</span>
                    <span className="text-[var(--color-muted)]">({items.length})</span>
                    {openCount > 0 && (
                      <Badge tone="up" pill>{openCount} open</Badge>
                    )}
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
                    <td className="sticky left-0 z-10 bg-[var(--color-surface)] px-2 py-1 border-r border-[var(--color-border)]">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={w.enabled}
                          onChange={() => onToggle?.(w.symbol)}
                          className="shrink-0"
                        />
                        <span className={`font-bold ${trading ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-sub)]'}`}>
                          {w.symbol}
                        </span>
                      </div>
                    </td>

                    {/* Hour cells */}
                    {HOURS.map(h => {
                      const active = isActiveAt(w.symbol, h)
                      const isNow = h === nowUTC
                      return (
                        <td
                          key={h}
                          className={`px-0 py-1 border-[var(--color-border)] ${
                            isNow ? 'border-l border-r border-[var(--color-down)]/40' : ''
                          }`}
                        >
                          <div
                            className={`mx-auto w-[20px] h-[10px] rounded-[2px] ${
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
                    <td className="px-2 py-1 text-center border-l border-[var(--color-border)]">
                      <span className={`text-[9px] font-bold ${
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
