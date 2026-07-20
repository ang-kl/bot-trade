// Shared column-sort hook for the bespoke (non-standard) tables — same
// interaction as StdTradeTable: tap a header to sort, tap again to flip,
// ↓/↑ marker, null cells always last. Accessors map column key → value.
import { useState } from 'react'

export function useSort(rows, initial, accessors = {}) {
  const [sort, setSort] = useState(initial)
  const val = (r) => {
    const a = accessors[sort.key]
    const v = a ? a(r) : r[sort.key]
    return v ?? null
  }
  const sorted = [...(rows || [])].sort((x, y) => {
    const vx = val(x)
    const vy = val(y)
    if (vx == null && vy == null) return 0
    if (vx == null) return 1
    if (vy == null) return -1
    const c = typeof vx === 'string' || typeof vy === 'string'
      ? String(vx).localeCompare(String(vy))
      : vx - vy
    return sort.dir === 'desc' ? -c : c
  })
  const sortBtn = (k, label) => (
    <button
      type="button"
      className="cursor-pointer hover:underline font-semibold whitespace-nowrap"
      onClick={() => setSort(s => ({ key: k, dir: s.key === k && s.dir === 'desc' ? 'asc' : 'desc' }))}
    >
      {label}{sort.key === k ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
    </button>
  )
  // Pass to a header's aria-sort — audit found this attribute missing
  // entirely on every bespoke (non-StdTradeTable) sortable table.
  const ariaSort = (k) => (sort.key === k ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none')
  return { sorted, sortBtn, sort, ariaSort }
}
