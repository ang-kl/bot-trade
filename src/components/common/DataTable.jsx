// common/DataTable.jsx — UI-2 (26-09 UI plan §8 item 2): the one shared
// data-table shell for the tables the plan lists in order (blockers first,
// then Reasons, workspace history, decision feed, Desk/Browser/Account
// history, risk grids, POST-backed tables, optionally the trade table).
//
// Reuses what already exists rather than forking a new idiom:
//   - `sortRows`/`useSort` (lib/use-sort.jsx) for the tap-to-sort columns;
//   - the StdTradeTable frozen-column idiom (`sticky left-0`) for the first
//     column, generalised here as `.dt-sticky-col`;
//   - a Collapse-style toggle (▾/▸, remembered, row count) for each date
//     group's header row — the same control the plan's own header example
//     implies ("Sat 26 Sep 2026 · Asia/Singapore — 2,913 records this day").
//     Fix round (blocker 5): this used to BE Collapse.jsx, wrapping each
//     group's rows in their own nested <table>; it is now inlined as a
//     `<tr><th colSpan scope="rowgroup">` sibling of the group's own row
//     <tr>s, in the ONE outer table — see the note on GroupRows below for why;
//   - `Disclosure` for a row's own expandable detail line.
//
// GROUPING is always supplied by the caller as `groups` — either computed
// server-side (UI-3's blockers card, so the day totals reflect the FULL
// window, not just the loaded page) or client-side with
// `lib/data-table-groups.js`'s `groupRowsByDate` (every other table on the
// plan's list, until it too gets server grouping). DataTable itself does not
// choose how a caller grouped its rows — it only renders the shape.
//
// VIEWPORT: `.data-table-viewport` (index.css) caps the table at ~15 rows and
// scrolls both ways instead of the columns squashing — the plan's own
// measured failure at 390px. Vitest here renders static markup with no
// jsdom (vite.config.js), so the actual scroll-vs-squash behaviour is
// asserted by scripts/responsive-audit.mjs against a real browser, not by a
// component test; these tests cover structure and content only.
import { useState } from 'react'
import { sortRows } from '../../lib/use-sort.jsx'
import Disclosure from './Disclosure.jsx'

export default function DataTable({
  id,
  columns,
  groups,
  getRowKey = (row, i) => row.id ?? i,
  renderDetails = null,
  defaultSort = null,
  onLoadOlder = null,
  hasMore = false,
  newerCount = 0,
  onShowNewer = null,
  emptyMessage = 'No rows in this window.',
  minWidthPx = 720,
  renderStanding = null,
}) {
  const [sort, setSort] = useState(defaultSort || { key: columns[0]?.key, dir: 'desc' })
  const [openRows, setOpenRows] = useState(() => new Set())
  const toggleRow = (key) => setOpenRows(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const accessors = Object.fromEntries(columns.filter(c => c.sortAccessor).map(c => [c.key, c.sortAccessor]))
  const sortBtn = (key, label) => (
    <button type="button" className="cursor-pointer hover:underline font-semibold whitespace-nowrap"
      onClick={() => setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
      {label}{sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
    </button>
  )
  const ariaSort = (key) => (sort.key === key ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none')

  const visibleGroups = (groups || []).filter(g => (g.rows?.length || 0) > 0 || (g.standing?.length || 0) > 0)
  const totalRows = visibleGroups.reduce((n, g) => n + (g.rows?.length || 0), 0)

  return (
    <div>
      {(onLoadOlder || newerCount > 0) && (
        <div className="flex gap-3 mb-1.5 items-center">
          {newerCount > 0 && onShowNewer && (
            <button type="button" className="cursor-pointer underline-offset-2 hover:underline font-semibold" onClick={onShowNewer}>
              {newerCount} newer — show
            </button>
          )}
          <span className="ml-auto" />
          {onLoadOlder && <button type="button" disabled={!hasMore} className="cursor-pointer underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-default" onClick={onLoadOlder}>Load older</button>}
        </div>
      )}
      {visibleGroups.length === 0
        ? <p role="status">{emptyMessage}</p>
        : (
          <div className="data-table-viewport overflow-x-auto" data-dt-viewport={id || undefined}>
            <table className="w-full text-left text-(length:--fs-body) tabular-nums" style={{ minWidth: minWidthPx }}>
              <thead className="dt-sticky-head">
                <tr className="border-b border-[var(--color-border)]">
                  {columns.map((c, i) => (
                    <th key={c.key} aria-sort={c.sortAccessor || c.sortable !== false ? ariaSort(c.key) : undefined}
                      className={`py-1 pr-3 whitespace-nowrap ${i === 0 ? 'dt-sticky-col' : ''}`}>
                      {c.sortable === false ? c.label : sortBtn(c.key, c.label)}
                    </th>
                  ))}
                  {renderDetails && <th className="py-1 dt-icon-col" aria-label="Details" />}
                </tr>
              </thead>
              <tbody>
                {visibleGroups.map(group => {
                  const sorted = sortRows(group.rows || [], sort, accessors)
                  return (
                    <GroupRows key={group.key} id={id} group={group} sorted={sorted} columns={columns}
                      renderDetails={renderDetails} renderStanding={renderStanding}
                      openRows={openRows} toggleRow={toggleRow} getRowKey={getRowKey} />
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      <p className="mt-1 text-[var(--color-text-sub)]">{totalRows} row{totalRows === 1 ? '' : 's'} shown.</p>
    </div>
  )
}

// Fix round (blocker 5): every group used to render as ONE cell hosting its
// OWN nested <table> — a second, independent auto-layout table whose column
// widths have nothing to do with the outer <thead>'s. Measured in Chromium at
// 390px: header column lefts (31/189/385/536px) drifted 30-50px from the row
// cells' own lefts (31/139/342/505px), and `.dt-sticky-date` sat on a <div>
// wrapping that inner table — inside a <td> that itself never moves, so it
// could not stick to anything.
//
// Now every group's header AND its rows are siblings in the ONE outer
// <tbody>, so the browser's table layout algorithm sizes every column from
// every row at once — header and data cells share the same lefts by
// construction, not by coincidence. The group header is its own
// `<tr><th colSpan scope="rowgroup">` (a standard row-group header row), and
// `.dt-sticky-date` on that real table cell can actually stick as the table
// scrolls past it, the way `.dt-sticky-head`/`.dt-sticky-col` already do on
// other real cells. Open/closed state keeps Collapse's own per-id storage key
// (`tbl_open_dt_<id>_<group.key>`) so no operator's remembered choice is
// lost by this change; only WHICH rows render moves with it, per the plan's
// own accepted fix.
function GroupRows({ id, group, sorted, columns, renderDetails, renderStanding, openRows, toggleRow, getRowKey }) {
  const groupKey = `dt_${id || 'table'}_${group.key}`
  const storageKey = `tbl_open_${groupKey}`
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(storageKey)
      return v == null ? true : v === '1'
    } catch { return true }
  })
  const toggleOpen = () => setOpen(o => {
    const next = !o
    try { localStorage.setItem(storageKey, next ? '1' : '0') } catch { /* private mode */ }
    return next
  })
  const totalCols = columns.length + (renderDetails ? 1 : 0)
  const count = group.count ?? group.rows?.length ?? 0
  return (
    <>
      <tr>
        <th colSpan={totalCols} scope="rowgroup" className="dt-sticky-date py-1 pr-3 text-left font-normal">
          <button type="button" aria-expanded={open} onClick={toggleOpen}
            className="flex items-center gap-1.5 text-(length:--fs-body) font-semibold text-[var(--color-text-sub)] cursor-pointer hover:text-[var(--color-text)]">
            <span aria-hidden="true" className="inline-block w-3">{open ? '▾' : '▸'}</span>
            {group.label}
            <span className="font-normal text-[var(--color-muted)]">{group.sub ?? ` — ${count} record${count === 1 ? '' : 's'} this day`}</span>
          </button>
        </th>
      </tr>
      {open && renderStanding && group.standing?.length > 0 && (
        <tr>
          <td colSpan={totalCols} className="p-0">{renderStanding(group)}</td>
        </tr>
      )}
      {open && sorted.map((row, i) => {
        const key = getRowKey(row, i)
        const detail = renderDetails ? renderDetails(row) : null
        const rowOpen = openRows.has(key)
        return (
          <RowLine key={key} row={row} columns={columns} detail={detail} open={rowOpen}
            onToggle={() => toggleRow(key)} />
        )
      })}
    </>
  )
}

function RowLine({ row, columns, detail, open, onToggle }) {
  return (
    <>
      <tr className="border-b border-[var(--color-border)] align-top">
        {columns.map((c, i) => (
          <td key={c.key} className={`py-1 pr-3 whitespace-nowrap ${i === 0 ? 'dt-sticky-col' : ''}`}>
            {c.render ? c.render(row) : row[c.key]}
          </td>
        ))}
        {detail != null && (
          <td className="py-1 dt-icon-col">
            <Disclosure open={open} onToggle={onToggle} label={open ? 'Hide details' : 'Show details'} />
          </td>
        )}
      </tr>
      {detail != null && open && (
        <tr className="border-b border-[var(--color-border)]">
          <td colSpan={columns.length + 1}>{detail}</td>
        </tr>
      )}
    </>
  )
}
