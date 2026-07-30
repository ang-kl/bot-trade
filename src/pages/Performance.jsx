// Performance — the design_claude Performance Ledger, first tab of the app
// (owner: "it will be before desk"). One closed-trade ledger sliced three
// ways — 14 time windows × 6 market categories × accounts — served whole by
// GET /state/perf-ledger so this page only renders. Carry-forward maths
// (carry in → net → carry out) reconcile by construction; the day rolls at
// 22:00 UTC (AU open) and the broker week anchors Sunday 22:00 UTC.
// Collect-forward everywhere: history the agent never captured shows an
// honest "—", never a fabricated number.
//
// Two layouts share one data model: the dense desktop ledger (lg+), and the
// design's phone screens (Now / Ledger / Markets / Trades / Accounts pill
// nav, hit targets ≥44px) below lg. Theme is the app-wide system-default
// toggle — mobile follows the system exactly as the design asks.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { agentGet, agentConfigured, pageAsleep, swrPeek } from '../lib/agent-api.js'
import { useAccountSwitch } from '../lib/use-account-switch.js'
import SwitchingNote from '../components/common/SwitchingNote.jsx'
import AccountTag from '../components/common/AccountTag.jsx'
import { orderHourlyForDisplay, totalFloating } from '../lib/hourly-order.js'
import Card from '../components/common/Card.jsx'
import SectionNavFab from '../components/common/SectionNavFab.jsx'
import Badge from '../components/common/Badge.jsx'
import ReportChart from '../components/ReportChart.jsx'
import SessionReview from '../components/SessionReview.jsx'
import { RegimeMatrix, BalanceInOut, DataFeed } from '../components/PerfMacroSections.jsx'
import SectionTools from '../components/common/SectionTools.jsx'
import Skeleton from '../components/common/Skeleton.jsx'
import NumberFlow from '@number-flow/react'
import { useAutoAnimate } from '@formkit/auto-animate/react'
import { MARKET_COLS, categorize as catOf, dayAnchorMs, isFxWeekend, closedAtMs as closedMs } from '../../agent/shared/formulas.js'
import SymbolTarget from '../cockpit/SymbolTarget.jsx'
import { fleetFrom } from '../cockpit/cockpit-fleet.js'

const REFRESH_MS = 60_000
const H = 3600_000
const D = 24 * H

// Same W3C international formatting convention as Risk: everything
// DISPLAYED goes through Intl.NumberFormat in the viewer's own locale.
const nf = (d = 2) => new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
const money = (v, d = 2) => (v == null || Number.isNaN(Number(v)) ? '—' : nf(d).format(Number(v)))
// Owner (2026-07-25): "I stress don't use bold for body text" — bold is
// reserved for section TITLES and the ONE headline figure per card. Every
// table uses only these three weights, so no data row shouts.
const W_HEAD = 600      // column-header cells (uppercase, muted)
const W_ROWLABEL = 500  // a row's identifier cell (symbol, session, window)
const W_CELL = 400      // every other data cell

const signed = (v, d = 2) => (v == null || Number.isNaN(Number(v)) ? '—' : `${v > 0 ? '+' : ''}${nf(d).format(Number(v))}`)

const UP = 'text-[var(--color-up)]'
const DOWN = 'text-[var(--color-down)]'
const SUB = 'text-[var(--color-text-sub)]'
const pnlTone = (v) => (v == null ? SUB : v >= 0 ? UP : DOWN)

// Market columns + classifier come from shared/formulas.js — the ONE copy
// both this page and the server ledger use, so lenses reconcile (owner
// 2026-07-28: Stocks/Indices disagreed between cards). 'other' is a real
// column so cells provably sum to their Net.
// (imported below with the day-anchor helpers)

// Trading sessions in UTC (design spec) — Sydney wraps midnight.
const SESSIONS = [
  { name: 'Sydney', from: 22, to: 5 },
  { name: 'Tokyo', from: 0, to: 6 },
  { name: 'Singapore', from: 1, to: 9 },
  { name: 'London', from: 8, to: 16 },
  { name: 'New York', from: 14, to: 21 },
]
const sessionActive = (s, utcHour) =>
  s.from <= s.to ? utcHour >= s.from && utcHour < s.to : utcHour >= s.from || utcHour < s.to

// Market-session buckets for the owner's today-by-market stats (SYD, SG,
// HK, JPN, EUR, NY). Fixed UTC windows from each exchange's cash hours at
// current DST offsets — documented approximations, not a tz database.
// Windows OVERLAP (Asia trades in several at once): a trade counts in every
// session whose window contains its CLOSE time, so rows don't sum to total.
// (Distinct from SESSIONS above — that's the FX session clock design spec.)
const STAT_SESSIONS = [
  { key: 'SYD (ASX)', hint: 'ASX cash equities 10:00–16:00 AEST — NOT the FX Sydney session (which the header clock shows opening 22:00 UTC)', fromMin: 0, toMin: 360 },
  { key: 'SG', hint: 'SGX 09:00–17:00 SGT', fromMin: 60, toMin: 540 },
  { key: 'HK', hint: 'HKEX 09:30–16:00 HKT', fromMin: 90, toMin: 480 },
  { key: 'JPN', hint: 'TSE 09:00–15:00 JST', fromMin: 0, toMin: 360 },
  { key: 'EUR', hint: 'London 08:00–16:30 BST', fromMin: 420, toMin: 930 },
  { key: 'NY', hint: 'NYSE 09:30–16:00 EDT', fromMin: 810, toMin: 1200 },
]

// Day/weekend anchors and closedMs come from shared/formulas.js (imported
// above) — the same DST-aware 17:00-NY FX day open the server ledger and the
// risk gate use, so every "today"/"yesterday" label on this page agrees with
// the backend's windows.

// The FX banded panel's exact band lists (prototype BANDS).
const FX_BANDS = [
  ['Majors', ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF', 'USDCAD', 'NZDUSD']],
  ['EUR crosses', ['EURJPY', 'EURGBP', 'EURCHF', 'EURAUD', 'EURNZD', 'EURCAD']],
  ['GBP crosses', ['GBPJPY', 'GBPCHF', 'GBPAUD', 'GBPNZD', 'GBPCAD']],
  ['JPY crosses', ['AUDJPY', 'NZDJPY', 'CADJPY', 'CHFJPY']],
  ['Comdoll crosses', ['AUDNZD', 'AUDCAD', 'AUDCHF', 'NZDCHF', 'NZDCAD']],
  ['Asia & exotics', ['USDSGD', 'USDHKD', 'USDCNH', 'USDZAR', 'USDTRY', 'USDMXN']],
]

const CRYPTO_SYMS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD']

// Prototype agg(): win%, PF, TP/part/SL counts, planned R:R → edge.
function aggRows(list) {
  const n = list.length
  const wins = list.filter(t2 => t2.pnl > 0)
  const gw = wins.reduce((s, t2) => s + t2.pnl, 0)
  const gl = list.filter(t2 => t2.pnl <= 0).reduce((s, t2) => s + -t2.pnl, 0)
  const rrs = list.filter(t2 => t2.rr != null)
  const rr = rrs.length ? rrs.reduce((s, t2) => s + t2.rr, 0) / rrs.length : null
  const wr = n ? Math.round((wins.length / n) * 100) : 0
  const needs = rr != null ? Math.round(100 / (1 + rr)) : null
  return {
    n, wr, pnl: list.reduce((s, t2) => s + t2.pnl, 0),
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    tp: list.filter(t2 => t2.tpHit).length, part: list.filter(t2 => t2.part).length, sl: list.filter(t2 => t2.slHit).length,
    edge: needs != null && n ? wr - needs : null,
  }
}

// Prototype token → app CSS-var map (same convention as WorkflowAudit.jsx).
const P_ACC = 'var(--color-accent)', P_UP = 'var(--color-up)', P_DN = 'var(--color-down)'
const P_TX = 'var(--color-text)', P_SB = 'var(--color-text-sub)', P_MU = 'var(--color-muted)'
const P_WRN = 'var(--color-warning-text)', P_EDG = 'var(--glass-edge)'
const P_GL = 'var(--color-surface)', P_GBD = 'var(--color-border)', P_ACS = 'var(--color-accent-soft)'

// Header strip — exact port of the prototype header: session pills (10.5px/
// 600, 3px 9px, accent border+tint while OPEN) + the tabular UTC clock.
function SessionClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const hour = now.getUTCHours()
  const p = (n) => String(n).padStart(2, '0')
  return (
    <>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {SESSIONS.map(s => {
          const on = sessionActive(s, hour)
          return (
            <span key={s.name}
              title={`${p(s.from)}:00–${p(s.to)}:00 UTC${on ? ' · OPEN' : ''}`}
              style={{ fontSize: 9, fontWeight: 600, padding: '3px 9px', borderRadius: 999, border: `1px solid ${on ? P_ACC : P_EDG}`, color: on ? P_ACC : P_MU, background: on ? P_ACS : 'transparent' }}>
              {s.name}
            </span>
          )
        })}
      </div>
      <span style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, fontSize: 9, fontWeight: 600, color: P_SB, fontVariantNumeric: 'tabular-nums' }}>
        <span>{p(now.getUTCHours())}:{p(now.getUTCMinutes())}:{p(now.getUTCSeconds())} UTC</span>
        {/* Device-local clock — owner (2026-07-27): "have a user's timezone below the UTC". */}
        <span>🇸🇬 {p(now.getHours())}:{p(now.getMinutes())}:{p(now.getSeconds())}</span>
      </span>
    </>
  )
}

// One market sub-cell in the ledger grid: net on top, win%·PF subline —
// or a quiet "—" when the window has no trades in that market.
function MarketCell({ st }) {
  if (!st || !st.trades) return <td className={`py-1 px-2 text-right text-[9px] ${SUB}`}>—</td>
  return (
    <td className="py-1 px-2 text-right tabular-nums">
      {/* No explicit size on the net line: it inherits the ledger's 9.5px cell
          size; the subline below keeps its own tiny 9px (owner: "except those
          tiny information like '5t · 40% · PF 0.76'"). */}
      <div className={`font-bold ${pnlTone(st.net)}`}>{signed(st.net)}</div>
      <div className={`text-[9px] ${SUB}`}>{st.trades}t · {st.winPct != null ? `${nf(0).format(st.winPct)}%` : '—'} · PF {st.pf != null ? nf(2).format(st.pf) : '—'}</div>
    </td>
  )
}

// Auto-insight line for a window: which market led, which dragged, the edge.
function insight(w) {
  const cells = MARKET_COLS
    .map(m => ({ label: m.label, ...w.markets?.[m.key] }))
    .filter(c => c.trades > 0)
  if (!cells.length) return null
  const led = [...cells].sort((a, b) => b.net - a.net)[0]
  const drag = [...cells].sort((a, b) => a.net - b.net)[0]
  const bits = []
  if (led.net > 0) bits.push(`${led.label} led ${signed(led.net)}`)
  if (drag !== led && drag.net < 0) bits.push(`${drag.label} dragged ${signed(drag.net)}`)
  if (w.edge != null) bits.push(`edge ${signed(w.edge, 1)}%`)
  return bits.join(' · ') || null
}

const dRange = (fromIso, toIso) => {
  const f = new Date(fromIso), t = new Date(toIso)
  const one = (d) => d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', timeZone: 'UTC' })
  return `${one(f)} → ${one(t)}`
}

// Owner (2026-07-24): "1H ledger row should show last time it filled in" —
// an empty rolling window still names the scope's most recent close instead
// of reading as a stalled/broken table.
function agoLabel(iso, nowMs) {
  if (!iso) return null
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  const mins = Math.max(0, Math.round((nowMs - ms) / 60_000))
  if (mins < 60) return `${mins}m ago`
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / (24 * 60))}d ago`
}

// Shared expanded-window detail: TP/SL plan vs actual + per-market lines.
function WindowDetail({ w }) {
  const note = insight(w)
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-[9px]">
      <div>
        <div className={`text-[9px] uppercase font-bold ${SUB}`}>TP/SL plan vs actual</div>
        <div className="tabular-nums">
          planned R:R {w.avgRr != null ? nf(2).format(w.avgRr) : '—'} → required win {w.requiredWinPct != null ? `${nf(1).format(w.requiredWinPct)}%` : '—'} · actual {w.winPct != null ? `${nf(1).format(w.winPct)}%` : '—'} · <span className={`font-bold ${w.edge == null ? SUB : w.edge >= 0 ? UP : DOWN}`}>edge {w.edge != null ? `${signed(w.edge, 1)}%` : '—'}</span>
        </div>
      </div>
      {MARKET_COLS.filter(m => w.markets?.[m.key]?.trades > 0).map(m => {
        const st = w.markets[m.key]
        return (
          <div key={m.key}>
            <div className={`text-[9px] uppercase font-bold ${SUB}`}>{m.label}</div>
            <div className="tabular-nums">
              <span className={`font-bold ${pnlTone(st.net)}`}>{signed(st.net)}</span> · {st.trades}t · win {st.winPct != null ? `${nf(0).format(st.winPct)}%` : '—'} · PF {st.pf != null ? nf(2).format(st.pf) : '—'} · <span className={UP}>{st.tp} TP</span>/<span className={DOWN}>{st.sl} SL</span>
            </div>
          </div>
        )
      })}
      {note && <div className={`w-full text-[9px] ${SUB}`}>{note}</div>}
    </div>
  )
}

// --- shared section bodies (card + expanded modal render the SAME
// component — the owner's no-fork rule for the ⤢ expand feature) ----------
// Gradient table. ONE css grid for the whole thing — group band, column
// heads, banded body rows, subtotal row — because two of the owner's asks
// (2026-07-25) need cells that span rows, which per-row grids cannot do:
// a vertical merged "No data" cell down an empty column, and hollow band
// separators that run the full width.
//
// Owner's asks, in order:
//  · header font 2px smaller than the app default (10px → 8px), Title Case
//  · a subtotal on every column
//  · timeframe rows banded, hollow rule between, ≤2px of space around it
//  · a column with no data at all shows one merged vertical "No data" cell
//  · money cells 1px smaller and never bold
//  · rows and columns collapsible, per card, independently of the other card

// Bands are matched by LABEL against the server's real window list
// (perf-ledger.js). The owner's sketch named 5D, 3W and 9M, which the server
// does not produce, and omitted WTD and 30D, which it does — so this maps what
// exists and drops what doesn't rather than inventing windows. Anything the
// server adds later falls into 'other' and still renders, unbanded.
const TF_BANDS = [
  ['intraday', ['1H', '4H', '12H']],
  ['days', ['Yesterday', '3D', 'WTD', '1W', '2W', '30D']],
  ['months', ['MTD', 'Last month']],
  ['long', ['3M', '6M', '12M']],
]
const bandOf = (label) => {
  const base = String(label).split(' · ')[0]
  for (const [name, labels] of TF_BANDS) if (labels.includes(base)) return name
  return 'other'
}

// "fib 618 fade" → "Fib 618 Fade". Acronym-ish tokens (2-4 chars, no vowel
// outside y) stay upper — WTD, MTD, 3D, TP — because title-casing those makes
// them harder to read, not easier.
function toTitle(label) {
  return String(label).split(' ').map(w => {
    if (!w) return w
    if (w.length <= 4 && !/[aeiou]/i.test(w.replace(/[^a-z]/gi, ''))) return w.toUpperCase()
    return w[0].toUpperCase() + w.slice(1)
  }).join(' ')
}

// Body type for these two cards is 9px (owner 2026-07-25): row labels AND
// cell data. Only the two gradient cards use GradientBody, so this does not
// leak into any other table.
const GRAD_FONT = 9

function GradientBody({
  grid, label, cols, rows, foot, groups = null, colW = 'minmax(52px,84px)',
  subtotals = null, banded = false, smallHead = false,
}) {
  // Hiding is per row / per column only (owner 2026-07-25: "remove the rows
  // and columns pills ... since I can hide and unhide rows and columns"):
  // click a row label or a column head to hide it, restore from the chip bar.
  const [hiddenRows, setHiddenRows] = useState(() => new Set())
  const [hiddenCols, setHiddenCols] = useState(() => new Set())
  const rowsOpen = true, colsOpen = true

  const toggleIn = (setter) => (key) => setter(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const toggleRow = toggleIn(setHiddenRows)
  const toggleCol = toggleIn(setHiddenCols)

  // Keep the ORIGINAL column index alongside, so subtotals (indexed on the
  // unfiltered set) stay attached to their own column after hiding.
  const colIdx = cols.map((c, i) => ({ ...c, i }))
  const visCols = colsOpen ? colIdx.filter(c => !hiddenCols.has(c.name)) : []
  const visRows = rowsOpen ? rows.filter(r => !hiddenRows.has(r.label)) : []

  const template = `${grid} repeat(${visCols.length},${colW})`
  const pillS = {
    cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, fontWeight: W_CELL,
    color: P_MU, background: 'transparent', border: `1px solid ${P_EDG}`,
    borderRadius: 6, padding: '0 5px',
  }
  const chipS = { ...pillS, color: P_ACC, borderColor: P_ACC }
  // Empty means empty across the rows you can SEE — hide the only row with a
  // number in it and the column is honestly empty for what is displayed.
  const emptyCol = visCols.map(c => visRows.length > 0 && visRows.every(r => r.cells[c.i]?.zero))

  // Explicit placement for every child. Auto-placement cannot coexist with the
  // row-spanning "No data" cell: it packs siblings into free slots and shifts
  // whole rows sideways (owner: "the data are totally misplaced").
  const rowNo = []
  const seps = []
  let gr = 1
  if (groups && colsOpen) gr++
  const headRow = gr++
  const firstDataRow = gr
  visRows.forEach((row, ri) => {
    const band = banded ? bandOf(row.label) : null
    const prev = banded && ri > 0 ? bandOf(visRows[ri - 1].label) : band
    if (band !== prev) seps.push(gr++)
    rowNo[ri] = gr++
  })
  const lastDataRow = gr - 1
  const subSep = subtotals && colsOpen && visRows.length ? gr++ : null
  const subRow = subtotals && colsOpen && visRows.length ? gr++ : null

  const headStyle = smallHead ? { fontSize: 8 } : undefined
  // Right-aligned, square-cornered, ledger-style — the number is the signal,
  // not the shape around it.
  const cellStyle = { fontSize: GRAD_FONT, fontWeight: W_CELL, textAlign: 'right', paddingRight: 6, fontVariantNumeric: 'tabular-nums' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minHeight: 0 }}>
      {(hiddenRows.size > 0 || hiddenCols.size > 0) && (
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Restore bar — the only way a hidden row/column comes back, so
            hiding one can never lose it. Rendered only when something is
            hidden; no standing chrome above the table otherwise. */}
        {[...hiddenRows].map(k => (
          <button key={`hr-${k}`} type="button" style={chipS} title="Show this row again"
            onClick={() => toggleRow(k)}>+ {k}</button>
        ))}
        {[...hiddenCols].map(k => (
          <button key={`hc-${k}`} type="button" style={chipS} title="Show this column again"
            onClick={() => toggleCol(k)}>+ {k}</button>
        ))}
        <button type="button" style={pillS} title="Show everything again"
          onClick={() => { setHiddenRows(new Set()); setHiddenCols(new Set()) }}>Show all</button>
      </div>
      )}
      <div style={{ overflowX: 'auto', minWidth: 0, maxWidth: '100%' }}>
        <div style={{ minWidth: groups && colsOpen ? 760 : undefined, display: 'grid', gridTemplateColumns: template, gap: 2, alignItems: 'center' }}>
          {groups && colsOpen && (() => {
            // Group spans must count only the columns still visible, or the
            // band drifts off its own columns.
            let at = 0
            return groups.map(g => {
              const mine = colIdx.slice(at, at + g.span)
              at += g.span
              const shown = mine.filter(c => !hiddenCols.has(c.name)).length
              if (!shown) return null
              const from = visCols.findIndex(c => c.i === mine.find(m => !hiddenCols.has(m.name)).i)
              return (
                <span key={`g-${g.name}`} className="t-gridhead"
                  style={{ gridRow: 1, gridColumn: `${from + 2} / span ${shown}`, textAlign: 'center', borderBottom: `1px solid ${P_EDG}`, ...headStyle }}>{g.name}</span>
              )
            })
          })()}

          <span className="t-gridhead" style={{ gridRow: headRow, gridColumn: 1, ...headStyle }}>{toTitle(label)}</span>
          {visCols.map((c, ci) => (
            <button key={`h-${c.name}`} type="button" className="t-gridhead" title={`${c.name} — click to hide this column`}
              onClick={() => toggleCol(c.name)}
              style={{ gridRow: headRow, gridColumn: ci + 2, textAlign: 'center', cursor: 'pointer', fontFamily: 'inherit', border: 0, ...headStyle }}>{toTitle(c.name)}</button>
          ))}

          {seps.map(sr => (
            <span key={`s-${sr}`} style={{ gridRow: sr, gridColumn: '1 / -1', height: 0, margin: '1px 0', borderTop: `1px solid ${P_GBD}` }} />
          ))}

          {visRows.map((row, ri) => (
            <button key={`l-${row.label}`} type="button" title={`${row.label} — click to hide this row`}
              onClick={() => toggleRow(row.label)}
              style={{ gridRow: rowNo[ri], gridColumn: 1, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', background: 'transparent', border: 0, padding: 0, color: 'inherit', fontSize: GRAD_FONT, fontWeight: W_ROWLABEL, borderBottom: `1px solid ${P_EDG}`, alignSelf: 'stretch' }}>{row.label}</button>
          ))}

          {visCols.map((c, ci) => (
            emptyCol[ci]
              ? (
                <span key={`nd-${c.name}`} title={`${c.name} — no closed trades in any shown window`}
                  style={{ gridColumn: ci + 2, gridRow: `${firstDataRow} / ${lastDataRow + 1}`, display: 'flex', alignItems: 'center', justifyContent: 'center', writingMode: 'vertical-rl', fontSize: GRAD_FONT, color: P_MU, background: 'var(--table-head-bg)', borderRadius: 0 }}>
                  No data
                </span>
              )
              : visRows.map((row, ri) => (
                <span key={`c-${c.name}-${ri}`}
                  style={{ ...cellStyle, gridRow: rowNo[ri], gridColumn: ci + 2, background: row.cells[c.i].bg, color: row.cells[c.i].col, borderBottom: `1px solid ${P_EDG}` }}>{row.cells[c.i].v}</span>
              ))
          ))}

          {subRow != null && (
            <>
              <span style={{ gridRow: subSep, gridColumn: '1 / -1', height: 0, margin: '1px 0', borderTop: `1px solid ${P_GBD}` }} />
              <span className="t-gridhead" style={{ gridRow: subRow, gridColumn: 1, ...headStyle }}>Subtotal</span>
              {visCols.map((c, ci) => (
                <span key={`sub-${c.name}`} style={{ ...cellStyle, gridRow: subRow, gridColumn: ci + 2, color: subtotals[c.i]?.col }}>{subtotals[c.i]?.v}</span>
              ))}
            </>
          )}
        </div>
      </div>
      <span style={{ fontSize: 9, color: P_MU }}>{foot}</span>
    </div>
  )
}

function FxBandsBody({ fxBands }) {
  // Owner (2026-07-25): "all rows capable of expand for details". The per-pair
  // TP/SL detail was hover-only via a title attribute, which I flagged last
  // round as genuinely unreachable on an iPad — a tap never fires it. Tapping
  // a pair chip now shows the same detail inline, so it works on both.
  const [openPair, setOpenPair] = useState(null)
  // Owner (2026-07-25): "missing column-head (follow standards in this css)" —
  // this card was the one grid-table without a head row. Same .t-gridhead
  // treatment as every other grid table; hidden when the row stacks on
  // tablets (perf-band-head, index.css). "row font size 9px": data text is
  // 9px, the band label keeps the app-wide 10px first-column-head size.
  return (
    <>
      <div className="t-gridhead perf-band-row perf-band-head" style={{ padding: '2px 0 2px 4px' }}>
        <span>Band</span>
        <span>Net</span>
        <span>Pairs</span>
      </div>
      {fxBands.map(b => (
        <div key={b.band} className="perf-band-row" style={{ borderTop: `1px solid ${P_EDG}`, paddingTop: 5 }}>
          <span style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 10, fontWeight: W_ROWLABEL }}>{b.band}</span>
            <span style={{ fontSize: 9, color: P_MU }}>{b.meta}</span>
          </span>
          <span style={{ fontSize: 9, fontWeight: W_CELL, fontVariantNumeric: 'tabular-nums', color: b.col }}>{b.net}</span>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {b.pairs.map(p2 => (
              <button key={p2.sym} type="button" title={p2.tip}
                aria-expanded={openPair === `${b.band}|${p2.sym}`}
                onClick={() => setOpenPair(o => (o === `${b.band}|${p2.sym}` ? null : `${b.band}|${p2.sym}`))}
                style={{ cursor: 'pointer', fontFamily: 'inherit', background: 'transparent', fontSize: 9, fontWeight: 600, padding: '0 5px', borderRadius: 5, border: `1px solid ${openPair === `${b.band}|${p2.sym}` ? P_ACC : P_EDG}`, fontVariantNumeric: 'tabular-nums' }}>
                {p2.sym} <span style={{ fontWeight: W_CELL, color: p2.col }}>{p2.v}</span>
              </button>
            ))}
          </div>
          {b.pairs.filter(p2 => openPair === `${b.band}|${p2.sym}`).map(p2 => (
            <span key={p2.sym} style={{ gridColumn: '1 / -1', fontSize: 9, color: P_MU, paddingLeft: 4 }}>{p2.tip || 'no TP/SL detail recorded for this pair'}</span>
          ))}
        </div>
      ))}
    </>
  )
}

function StratMxBody({ stratMx }) {
  return (
    <>
      <div className="t-gridhead" style={{ display: 'grid', gridTemplateColumns: '132px repeat(6,1fr) 76px 52px', gap: 6, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 3 }}>
        <span>Strategy</span>
        {MARKET_COLS.map(m => <span key={m.key}>{m.label}</span>)}
        <span>Net</span><span>Edge</span>
      </div>
      {stratMx.length === 0 && <span style={{ fontSize: 9, color: P_MU, padding: '4px 0' }}>No closed trades with a strategy label in the last 30 days.</span>}
      {stratMx.map(s => (
        <div key={s.name} style={{ display: 'grid', gridTemplateColumns: '132px repeat(6,1fr) 76px 52px', gap: 6, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '3px 0', fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ fontSize: 9, fontWeight: W_ROWLABEL, textTransform: 'capitalize' }}>{s.name}</span>
          {s.cells.map((c, ci) => <span key={ci} title={c.tip} style={{ fontSize: 9, fontWeight: W_CELL, color: c.col }}>{c.v}</span>)}
          <span style={{ fontSize: 9, fontWeight: W_CELL, color: s.col }}>{s.net}</span>
          <span style={{ fontSize: 9, fontWeight: W_CELL, color: s.edgeCol }}>{s.edge}</span>
        </div>
      ))}
    </>
  )
}

function CryptoBody({ crypto }) {
  return (
    <>
      <div className="t-gridhead" style={{ display: 'grid', gridTemplateColumns: '76px 96px 66px 84px 1fr', gap: 8, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 1 }}>
        <span>Symbol</span><span>Live price</span><span>Δ now</span><span>7D P&amp;L</span><span style={{ textAlign: 'right' }}>Tr · Win · PF</span>
      </div>
      {crypto.rows.map(c2 => (
        <div key={c2.sym} style={{ display: 'grid', gridTemplateColumns: '76px 96px 66px 84px 1fr', gap: 8, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '1px 0', fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ fontSize: 9, fontWeight: W_ROWLABEL }}>{c2.sym}</span>
          <span style={{ fontSize: 9, fontWeight: W_CELL, color: P_MU }}>—</span>
          <span style={{ fontSize: 9, fontWeight: W_CELL, textAlign: 'center', padding: '1px 0', borderRadius: 6, color: P_MU }}>—</span>
          <span style={{ fontSize: 9, fontWeight: W_CELL, color: c2.col }}>{c2.pnl}</span>
          <span style={{ fontSize: 9, color: P_MU, textAlign: 'right' }}>{c2.meta}</span>
        </div>
      ))}
    </>
  )
}

// Price / volume formatters for the open-trade tables. Prices arrive
// already descaled; trim float noise without inventing precision. Volume is
// the daily bar's broker tick volume, compacted (12.3k) to fit the column.
const fmtPx = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : String(Number(Number(v).toFixed(5))))
const fmtVol = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}

// Owner (2026-07-24): "AUDIT all the pages to ensure there are entry price
// and current OHLC and current price columns" — Entry was previously
// tooltip-only here; it's now its own visible column alongside current
// Price and OHLC (1d).
// Owner (2026-07-25): "fill up the page. make it dense". The OHLC cell was
// two stacked lines, so every row was double height and the card showed 4 of
// 24 positions over 6 pages with a page of blank space beneath it. OHLC moves
// into the row's expansion (same treatment as the weekend 24H table), rows go
// single-line, and the freed track goes to SL/TP so its header stops wrapping.
const OPEN_COLS = '78px 82px 84px 68px 68px 56px 16px minmax(96px,1fr)'
// symbol-click-spec §1 — an open-trade row hands the Trade Cockpit the broker
// facts it already holds (live price, live P&L, entry/SL/TP, market state) so
// the cockpit opens on the real instrument instead of the reference demo one.
// Panels with no agent source yet stay demo and the cockpit says which.
const cockpitPos = (p2) => ({
  sym: p2.sym, side: p2.side, lots: p2.lots, strategy: p2.strat,
  entry: p2.entryRaw, sl: p2.slRaw, tp: p2.tpRaw,
  price: p2.price, pnl: p2.pnl, marketOpen: p2.marketOpen,
  mfeR: p2.mfeR, maeR: p2.maeR,
  // FLEET is computed from the account's real other open positions, not a
  // hardcoded list (owner 2026-07-26).
  fleet: fleetFrom(p2.roster, p2.id),
})

function OpenTableBody({ rows }) {
  // AutoAnimate (owner polish audit) — page flips and row add/remove ease
  // instead of popping; the hook animates this div's direct children.
  const [animRef] = useAutoAnimate({ duration: 160 })
  // Owner (2026-07-25): "all rows capable of expand for details". The detail
  // shown here was previously ONLY in a title tooltip — which never fires on
  // a tap, so on the iPad it was unreachable. Tapping a row now reveals it.
  const [openId, setOpenId] = useState(null)
  return (
    <div style={{ overflowX: 'auto', minWidth: 0, maxWidth: '100%' }}>
      <div ref={animRef} style={{ minWidth: 560 }}>
      <div className="t-gridhead" style={{ display: 'grid', gridTemplateColumns: OPEN_COLS, gap: 6, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 1 }}>
        <span>Symbol</span><span>Side · lots</span><span>Latest P&amp;L</span><span>Entry</span><span>Price</span><span>Vol</span><span></span><span>SL / TP away</span>
      </div>
      {rows.map(p2 => (
        <div key={p2.id}>
        <div role="button" tabIndex={0} aria-expanded={openId === p2.id}
          onClick={() => setOpenId(o => (o === p2.id ? null : p2.id))}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(o => (o === p2.id ? null : p2.id)) } }}
          style={{ display: 'grid', gridTemplateColumns: OPEN_COLS, gap: 6, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '1px 0', fontVariantNumeric: 'tabular-nums', cursor: 'pointer' }}>
          <span style={{ fontSize: 9, fontWeight: W_ROWLABEL }}>
            <span aria-hidden="true" style={{ color: P_MU }}>{openId === p2.id ? '▾' : '▸'}</span>{' '}
            <SymbolTarget symbol={p2.sym} positionId={p2.id} position={cockpitPos(p2)} source="perf-open-floating">
              {p2.sym}
            </SymbolTarget>
          </span>
          <span style={{ fontSize: 9, fontWeight: W_CELL, color: p2.sideCol }}>{p2.side} {p2.lots}</span>
          <span style={{ fontSize: 9, fontWeight: W_CELL, color: p2.pnl == null ? P_MU : p2.pnl >= 0 ? P_UP : P_DN }}>{p2.pnl != null ? signed(p2.pnl) : '—'}</span>
          <span style={{ fontSize: 9, color: P_MU }}>{p2.entry}</span>
          <span style={{ fontSize: 9, fontWeight: W_CELL }}>{fmtPx(p2.price)}</span>
          <span style={{ fontSize: 9, color: P_MU }}>{fmtVol(p2.day?.v)}</span>
          {/* Owner (2026-07-24 evening): "OPEN NOW — FLOATING to show
              current open trade but market is closed so show the locked
              sign" — same 🔒 convention as the weekend 24H table, replacing
              the old OPEN/CLOSED/? text label. */}
          <span style={{ fontSize: 10, textAlign: 'center' }} title={p2.marketOpen === false ? 'currently untradable — market closed' : undefined}>{p2.marketOpen === false ? '🔒' : ''}</span>
          <span style={{ fontSize: 9, color: P_MU }}>{p2.sld} / {p2.tpd}</span>
        </div>
        {openId === p2.id && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '1px 0 2px 14px', borderBottom: `1px solid ${P_EDG}`, fontSize: 9, color: P_MU, fontVariantNumeric: 'tabular-nums' }}>
            <span>entry {p2.entry}</span>
            <span>O {fmtPx(p2.day?.o)} H {fmtPx(p2.day?.h)} L {fmtPx(p2.day?.l)} C {fmtPx(p2.day?.c)}</span>
            <span>{p2.strat}</span>
            <span>SL {p2.sld} / TP {p2.tpd} from entry</span>
            <span>market {p2.marketOpen === false ? 'closed' : p2.marketOpen ? 'open' : 'unknown'} · {p2.marketSource || 'no source'}</span>
            {p2.day?.t && <span>daily bar {new Date(p2.day.t).toISOString().slice(0, 10)}</span>}
            {p2.pnlAt && <span>P&L at {String(p2.pnlAt).slice(11, 19)} UTC</span>}
          </div>
        )}
        </div>
      ))}
      </div>
    </div>
  )
}

// Owner (2026-07-24 evening): "TODAY", "OPEN NOW — FLOATING", "OPEN TRADE
// BUT MARKET CLOSED" tables had uncontrolled length — cap the on-page card
// view to 4 visible rows with BOTH pagination and a scrollbar (vertical for
// a partial last page, horizontal inherited from the wrapped table). The
// ⤢ expand pop-up still renders the FULL, unpaginated table — pagination is
// a card-view space constraint, not a data limit.
function PagedRows({ rows, pageSize = 4, maxHeight = 150, initialIndex = null, children }) {
  // initialIndex: open on the page CONTAINING this row index instead of page
  // 0 — the Today hourly table uses it to land on the current hour, because
  // "page 1 = 21:00-04:00 UTC" made every daytime close look missing (owner:
  // "why every hour isn't show the closed trades in this table").
  const [page, setPage] = useState(() =>
    initialIndex != null && initialIndex >= 0 ? Math.floor(initialIndex / pageSize) : 0)
  // Rows load async: on first render the list is empty, so the lazy
  // initialiser above ran against nothing and stuck on page 0. Adjust-during-
  // render (the React-endorsed derived-state shape) once the target row
  // actually exists (owner: table kept opening on 21:00).
  const [seededIndex, setSeededIndex] = useState(null)
  if (initialIndex != null && initialIndex >= 0 && rows.length > initialIndex && seededIndex !== initialIndex) {
    setSeededIndex(initialIndex)
    setPage(Math.floor(initialIndex / pageSize))
  }
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const p = Math.min(page, pages - 1)
  const pageRows = rows.slice(p * pageSize, p * pageSize + pageSize)
  const btn = { cursor: 'pointer', fontFamily: 'inherit', fontSize: 9, fontWeight: W_CELL, color: P_MU, background: 'transparent', border: `1px solid ${P_EDG}`, borderRadius: 6, padding: '1px 6px' }
  return (
    <div>
      <div style={{ maxHeight, overflowY: 'auto', overflowX: 'auto', minWidth: 0, maxWidth: '100%' }}>
        {children(pageRows)}
      </div>
      {rows.length > pageSize && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
          <button type="button" disabled={p === 0} onClick={() => setPage(p - 1)} style={{ ...btn, opacity: p === 0 ? 0.4 : 1 }}>‹</button>
          <span style={{ fontSize: 9, color: P_MU }}>Page {p + 1} / {pages}</span>
          <button type="button" disabled={p >= pages - 1} onClick={() => setPage(p + 1)} style={{ ...btn, opacity: p >= pages - 1 ? 0.4 : 1 }}>›</button>
        </div>
      )}
    </div>
  )
}

// Weekend 24H-symbols table (owner: "two columns, remove MKT column since is
// 24 HR, a lock if it cannot be traded") — a 2-column card grid instead of
// the wide single-column table; the Mkt text column is replaced by a small
// 🔒 that only appears in the rare case the broker reports this "24h" symbol
// as currently untradable (otherwise the slot is blank, not a redundant
// "OPEN" label).
// Owner (2026-07-25): "OHLC and other details make these rows look weird —
// have a small collapse for this row and expand to see the trade information
// in a single one." The OHLC/vol/SL/TP blob was inline in a ~1fr cell inside a
// two-column grid, so it wrapped to six lines per row. The row is now ONE
// line (symbol · side/lots · P&L · lock) and everything else lives in the
// expansion, printed as one line of trade information.
const WEEKEND_ROW_COLS = '14px 62px 74px 1fr 16px'
function Weekend24Body({ rows }) {
  const [animRef] = useAutoAnimate({ duration: 160 })
  const [openId, setOpenId] = useState(null)
  return (
    <div style={{ overflowX: 'auto', minWidth: 0, maxWidth: '100%' }}>
      <div ref={animRef} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(240px, 1fr))', gap: '0 16px', minWidth: 520 }}>
        {rows.map(p2 => (
          <div key={p2.id}>
            <div role="button" tabIndex={0} aria-expanded={openId === p2.id}
              onClick={() => setOpenId(o => (o === p2.id ? null : p2.id))}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(o => (o === p2.id ? null : p2.id)) } }}
              style={{ display: 'grid', gridTemplateColumns: WEEKEND_ROW_COLS, gap: 6, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '1px 0', fontVariantNumeric: 'tabular-nums', cursor: 'pointer' }}>
              <span aria-hidden="true" style={{ fontSize: 9, color: P_MU }}>{openId === p2.id ? '▾' : '▸'}</span>
              <span style={{ fontSize: 9, fontWeight: W_ROWLABEL }}>{p2.sym}</span>
              <span style={{ fontSize: 9, fontWeight: W_CELL, color: p2.sideCol }}>{p2.side} {p2.lots}</span>
              <span style={{ fontSize: 9, fontWeight: W_CELL, textAlign: 'right', color: p2.pnl == null ? P_MU : p2.pnl >= 0 ? P_UP : P_DN }}>{p2.pnl != null ? signed(p2.pnl) : '—'}</span>
              <span style={{ fontSize: 10, textAlign: 'center' }} title={p2.marketOpen === false ? 'currently untradable' : undefined}>{p2.marketOpen === false ? '\u{1F512}' : ''}</span>
            </div>
            {openId === p2.id && (
              <div style={{ padding: '1px 0 2px 20px', borderBottom: `1px solid ${P_EDG}`, fontSize: 9, color: P_MU, fontVariantNumeric: 'tabular-nums' }}>
                entry {p2.entry} · now {fmtPx(p2.price)} · O {fmtPx(p2.day?.o)} H {fmtPx(p2.day?.h)} L {fmtPx(p2.day?.l)} C {fmtPx(p2.day?.c)} · vol {fmtVol(p2.day?.v)} · SL {p2.sld} / TP {p2.tpd} · {p2.strat}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// Today's hourly breakdown (owner: "the today card cannot be empty... show
// across a 24 hours (1hr timeframe) the Open balance, P/L, Close balance,
// trades, close trades") — one row per elapsed hour since FX day open, so
// the card always has structure even before the first close of the day.
const TODAY_HOURLY_COLS = '54px minmax(74px,1fr) 72px minmax(74px,1fr) 48px 56px'
function TodayHourlyBody({ rows, floatingNow = null }) {
  const [animRef] = useAutoAnimate({ duration: 160 })
  return (
    <div style={{ overflowX: 'auto', minWidth: 0, maxWidth: '100%' }}>
      <div ref={animRef} style={{ minWidth: 420 }}>
        <div className="t-gridhead" style={{ display: 'grid', gridTemplateColumns: TODAY_HOURLY_COLS, gap: 6, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 1 }}>
          <span>Hour</span><span>Open bal</span><span>P&amp;L</span><span>Close bal</span><span>Trades</span><span>Closed</span>
        </div>
        {rows.map(r => (
          <div key={r.from} style={{ display: 'grid', gridTemplateColumns: TODAY_HOURLY_COLS, gap: 6, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '1px 0', fontVariantNumeric: 'tabular-nums', opacity: r.pending ? 0.45 : 1 }}>
            {/* Hour in the VIEWER'S local timezone; the FX-day UTC hour rides
                beside it 2pt smaller (owner 2026-07-28: "use user's tz with
                bracket (FX UTC timezone) in tiny font size"). */}
            <span style={{ fontSize: 9, color: r.isLive ? P_TX : P_MU, fontWeight: r.isLive ? 700 : undefined }}>
              {new Date(r.from).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
              <span style={{ fontSize: 7, marginLeft: 3 }}>({new Date(r.from).toISOString().slice(11, 16)} UTC)</span>
              {r.isLive && <span style={{ fontSize: 6, marginLeft: 3, fontWeight: 800, letterSpacing: '.03em', border: `1px solid ${P_EDG}`, borderRadius: 3, padding: '0 2px' }}>NOW</span>}
            </span>
            <span style={{ fontSize: 9, color: P_MU }}>{r.pending ? '—' : r.openBal != null ? money(r.openBal) : '—'}</span>
            {/* Realized P&L from closes in this hour. On the LIVE hour the
                floating figure rides alongside in brackets — it is unrealized
                and belongs to no single hour, so it is never summed into
                `net` and never touches the balance columns. */}
            <span style={{ fontSize: 9, fontWeight: W_CELL, color: r.net > 0 ? P_UP : r.net < 0 ? P_DN : P_MU }}>
              {!r.pending && r.closedN ? signed(r.net) : '—'}
              {r.isLive && floatingNow != null && (
                <span title="Floating (unrealized) P&L on the positions open right now. Not part of this hour's realized figure and not in the balance columns — balance is realized-only; equity is balance + floating."
                  style={{ fontSize: 7, marginLeft: 3, color: floatingNow > 0 ? P_UP : floatingNow < 0 ? P_DN : P_MU }}>
                  ({signed(floatingNow)} float)
                </span>
              )}
            </span>
            <span style={{ fontSize: 9, color: P_MU }}>{r.pending ? '—' : r.closeBal != null ? money(r.closeBal) : '—'}</span>
            <span style={{ fontSize: 9, fontWeight: W_CELL }}>{(!r.pending && r.openedN) || '—'}</span>
            <span style={{ fontSize: 9, fontWeight: W_CELL }}>{(!r.pending && r.closedN) || '—'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Owner (2026-07-25): "itemised today's closed trades list back". The hourly
// aggregate answers "how did the balance move"; it can't answer "which trade
// lost that". One dense line per trade — time · symbol · side/lots · P&L —
// and tapping it prints the rest (outcome, prices, hold, plan) on one line.
const TODAY_TRADE_COLS = '14px 42px 66px 74px 1fr'
function TodayTradesBody({ rows }) {
  const [animRef] = useAutoAnimate({ duration: 160 })
  const [openId, setOpenId] = useState(null)
  if (!rows.length) return <span style={{ fontSize: 9, color: P_MU }}>no closed trades in this window</span>
  return (
    <div ref={animRef}>
      {rows.map(t2 => {
        const on = openId === t2.id
        return (
          <div key={t2.id}>
            <div role="button" tabIndex={0} aria-expanded={on}
              onClick={() => setOpenId(o => (o === t2.id ? null : t2.id))}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(o => (o === t2.id ? null : t2.id)) } }}
              style={{ display: 'grid', gridTemplateColumns: TODAY_TRADE_COLS, gap: 6, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '1px 0', fontVariantNumeric: 'tabular-nums', cursor: 'pointer' }}>
              <span aria-hidden="true" style={{ fontSize: 9, color: P_MU }}>{on ? '▾' : '▸'}</span>
              <span style={{ fontSize: 9, color: P_MU }}>{t2.hm}</span>
              <span style={{ fontSize: 9, fontWeight: W_ROWLABEL }}>{t2.sym}</span>
              <span style={{ fontSize: 9, fontWeight: W_CELL, color: P_SB }}>{t2.side} {t2.lots}</span>
              <span style={{ fontSize: 9, fontWeight: W_CELL, textAlign: 'right', color: t2.pnl >= 0 ? P_UP : P_DN }}>{signed(t2.pnl)}</span>
            </div>
            {on && (
              <div style={{ padding: '1px 0 2px 20px', borderBottom: `1px solid ${P_EDG}`, fontSize: 9, color: P_MU, fontVariantNumeric: 'tabular-nums' }}>
                {t2.detail}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Today-by-market-session stats table (owner's column list: Trades #, +$,
// −$, highest, lowest, average, sum — plus median for the second central
// figure, since "average" and "mean" name the same number).
const SESS_COLS = '58px 52px repeat(7, minmax(64px, 1fr))'
function SessionStatsBody({ stats }) {
  // Owner (2026-07-27): SYD and JPN show identical figures — genuinely
  // correct, not a bug. ASX cash hours (10:00–16:00 AEST, UTC+10) and TSE
  // cash hours (09:00–15:00 JST, UTC+9) land on the exact same UTC window
  // this time of year — the 1h session-start gap cancels the 1h offset gap.
  // Flag any such coincidence generically (not hardcoded to SYD/JPN) so it
  // stays correct if the underlying windows ever change.
  const twins = {}
  for (const a of stats.buckets) {
    for (const b of stats.buckets) {
      if (a.key !== b.key && a.fromMin === b.fromMin && a.toMin === b.toMin) twins[a.key] = b.key
    }
  }
  const rows = [
    ...stats.buckets,
    { key: 'OFF', hint: 'today’s closes outside all six windows', ...stats.off },
    { key: 'ALL', hint: 'every closed trade today', ...stats.total },
  ]
  const cell = (v, col) => (v == null
    ? <span style={{ fontSize: 9, color: P_MU, textAlign: 'right' }}>—</span>
    : <span style={{ fontSize: 9, fontWeight: W_CELL, textAlign: 'right', color: col ?? (v > 0 ? P_UP : v < 0 ? P_DN : P_SB) }}>{signed(v)}</span>)
  return (
    <div style={{ overflowX: 'auto', minWidth: 0, maxWidth: '100%' }}>
      <div style={{ minWidth: 700 }}>
        <div className="t-gridhead" style={{ display: 'grid', gridTemplateColumns: SESS_COLS, gap: 6, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 1 }}>
          <span>Session</span><span style={{ textAlign: 'right' }}>Trades</span><span style={{ textAlign: 'right' }}>+$</span><span style={{ textAlign: 'right' }}>−$</span><span style={{ textAlign: 'right' }}>Highest</span><span style={{ textAlign: 'right' }}>Lowest</span><span style={{ textAlign: 'right' }}>Average</span><span style={{ textAlign: 'right' }}>Sum</span><span style={{ textAlign: 'right' }}>Median</span>
        </div>
        {rows.map(s => (
          <div key={s.key} title={s.hint} style={{ display: 'grid', gridTemplateColumns: SESS_COLS, gap: 6, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '1px 0', fontVariantNumeric: 'tabular-nums', fontWeight: s.key === 'ALL' ? 800 : undefined }}>
            <span>
              <span style={{ fontSize: 9, fontWeight: W_ROWLABEL }}>{s.key}</span>
              {s.open === false && (
                <span title="market closed right now — figures are the last computed value" style={{ marginLeft: 3, fontSize: 6, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.02em', color: P_WRN, border: `1px solid ${P_WRN}`, borderRadius: 3, padding: '0 2px', verticalAlign: 'middle' }}>closed</span>
              )}
              {twins[s.key] && (
                <span title={`Same UTC cash-hours window as ${twins[s.key]} this time of year — identical figures are expected, not a bug.`} style={{ marginLeft: 3, fontSize: 6, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.02em', color: P_SB, border: `1px solid ${P_EDG}`, borderRadius: 3, padding: '0 2px', verticalAlign: 'middle' }}>={twins[s.key]}</span>
              )}
            </span>
            <span style={{ fontSize: 9, fontWeight: W_CELL, textAlign: 'right', color: s.n ? P_TX : P_MU }}>{s.n || '—'}</span>
            {s.n
              ? <>{cell(s.pos, P_UP)}{cell(s.neg, P_DN)}{cell(s.high)}{cell(s.low)}{cell(s.avg)}{cell(s.sum)}{cell(s.median)}</>
              : <>{cell(null)}{cell(null)}{cell(null)}{cell(null)}{cell(null)}{cell(null)}{cell(null)}</>}
          </div>
        ))}
      </div>
    </div>
  )
}

// Owner (2026-07-25, iPad mini audit): this was a 5-column grid whose last
// column held a prose paragraph — at tablet width the header alone wrapped to
// four lines ("OUTCOME · PLAN · RVOL / VWAP / OBV") and every row ran ~150px
// tall, so five trades filled the screen. It is now one block per trade:
// an identity line that always fits (symbol · side · P&L), the window, then
// the anatomy as short POINTS, one per line. Same markup at every width, so
// there is no narrow-viewport variant to keep in sync.
function WlBody({ rows }) {
  return (
    <>
      {rows.length === 0 && <span style={{ fontSize: 9, color: P_MU, padding: '4px 0' }}>No closed trades in the last 30 days.</span>}
      {/* Owner (2026-07-25): "each symbol only two rows. dense the row" —
          this was four lines per trade (identity, window, then one line per
          anatomy point). Now exactly two: the identity line, and everything
          else joined on one line beneath it. Same facts, half the height. */}
      {rows.map((t2, ti) => (
        <div key={ti} style={{ borderTop: `1px solid ${P_EDG}`, padding: '1px 0', fontVariantNumeric: 'tabular-nums' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 9, fontWeight: W_ROWLABEL }}>{t2.sym}</span>
            <span style={{ fontSize: 9, color: P_SB }}>{t2.sd}</span>
            <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: W_CELL, color: t2.col }}>{t2.pnl}</span>
          </div>
          <div style={{ fontSize: 9, color: P_MU }}>{[t2.when, ...t2.points].join(' · ')}</div>
        </div>
      ))}
    </>
  )
}


// Accounts detail cards grid — shared by the card view and the ⤢ modal.
function AcctCardsGrid({ acctCards }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
            {acctCards.map(a => (
              <div key={a.id} style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 12, padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU }}>{a.name} · {a.ccy}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: W_CELL, fontVariantNumeric: 'tabular-nums', color: a.hasToday ? (a.day >= 0 ? P_UP : P_DN) : P_MU }}>day {a.hasToday ? signed(a.day) : '—'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 9, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{a.bal != null ? money(a.bal) : '—'}</span>
                  <span style={{ fontSize: 9, color: P_SB }}>equity {a.equity != null ? money(a.equity) : '—'}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 9, color: P_SB }}>live <span style={{ fontWeight: W_CELL, color: a.live == null ? P_MU : a.live >= 0 ? P_UP : P_DN }}>{a.live != null ? signed(a.live) : '—'}</span> = <span style={{ fontWeight: W_CELL, color: a.live == null ? P_MU : a.live >= 0 ? P_UP : P_DN }}>{a.live != null && a.bal ? `${a.live >= 0 ? '+' : ''}${(a.live / a.bal * 100).toFixed(2)}%` : '—'}</span> of balance</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, borderTop: `1px solid ${P_EDG}`, paddingTop: 4 }}>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 9, fontWeight: W_HEAD, textTransform: 'uppercase', color: P_MU }}>TP nett today</span><span style={{ fontSize: 9, fontWeight: W_CELL, fontVariantNumeric: 'tabular-nums', color: P_UP }}>{a.hasToday ? signed(a.gw) : '—'}</span></span>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 9, fontWeight: W_HEAD, textTransform: 'uppercase', color: P_MU }}>SL nett today</span><span style={{ fontSize: 9, fontWeight: W_CELL, fontVariantNumeric: 'tabular-nums', color: P_DN }}>{a.hasToday ? signed(-a.gl) : '—'}</span></span>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 9, fontWeight: W_HEAD, textTransform: 'uppercase', color: P_MU }}>Forecast · 30D pace</span><span style={{ fontSize: 9, fontWeight: W_CELL, fontVariantNumeric: 'tabular-nums', color: a.n30 == null ? P_MU : a.n30 >= 0 ? P_UP : P_DN }}>{a.n30 != null ? `${signed(a.n30 / 30)}/day` : '—'}</span></span>
                </div>
                <span style={{ fontSize: 9, color: P_MU }}>loss-cap used <span style={{ fontWeight: W_CELL, color: a.usedCol }}>{a.used != null ? `${a.used}%` : '—'}</span> of −{a.cap != null ? money(a.cap, 0) : '—'} daily stop</span>
              </div>
            ))}
    </div>
  )
}

// Copy-as-text for the ledger (owner spec: paste-friendly aligned lines).
function ledgerToText(windows) {
  const lines = (windows || []).map(w =>
    `${w.label} · carry ${money(w.carryIn)} → ${money(w.carryOut)} · net ${w.trades ? signed(w.net) : '—'} · ${w.trades} tr · ${w.winPct != null ? `${w.winPct}%` : '—'} · PF ${w.pf ?? '—'} · TP/SL ${(w.tp ?? 0) + (w.part ?? 0)}/${w.sl ?? 0}${w.manual > 0 ? ` · ${w.manual} manual` : ''} · edge ${w.edge != null ? `${w.edge >= 0 ? '+' : ''}${w.edge}%` : '—'}${!w.trades && w.lastTradeAt ? ` · last fill ${w.lastTradeAt}` : ''}`)
  return ['Timeframe ledger', ...lines].join('\n')
}

// The ledger table body — one component for both the card and the expanded
// modal (variant prop, never forked markup). The modal adds the owner's
// "expand all / collapse all" toggle driving every row's detail.
function LedgerBody({ variant, windows, ledger, error, nowMs }) {
  const [expandAll, setExpandAll] = useState(false)
  const modal = variant === 'modal'
  return (
    <>
      {modal && (
        <button type="button" onClick={() => setExpandAll(e => !e)}
          style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: 9, fontWeight: W_CELL, color: P_TX, background: P_ACS, border: `1px solid ${P_GBD}`, borderRadius: 8, padding: '3px 9px', alignSelf: 'flex-start', marginBottom: 6 }}>
          {expandAll ? 'Collapse all' : 'Expand all'}
        </button>
      )}
      {!ledger && !error && <Skeleton lines={6} className="mt-2" />}
      {ledger && (
        <div className="overflow-x-auto mt-1.5">
          {/* t-ledger: owner's 9.5px cell size for this table (index.css). */}
          <table className="t-ledger t-sticky-col w-full text-left tabular-nums min-w-[820px]">
            <thead>
              <tr className="border-b border-[var(--color-border)]">
                <th className="py-1 pr-2">Window</th>
                <th className="py-1 px-2 text-right">Carry in</th>
                <th className="py-1 px-2 text-right">Net</th>
                <th className="py-1 px-2 text-right">Carry out</th>
                <th className="py-1 px-2 text-right">Trades · win</th>
                <th className="py-1 px-2 text-right">TP/SL · edge</th>
                {MARKET_COLS.map(m => <th key={m.key} className="py-1 px-2 text-right">{m.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {windows.map(w => <LedgerRow key={w.key} w={w} nowMs={nowMs} forceOpen={modal ? (expandAll || null) : null} />)}
            </tbody>
          </table>
        </div>
      )}
      <p className={`mt-1.5 text-[9px] ${SUB}`}>
        Rolling windows (1H…12M) end now; Yesterday/3D/WTD/MTD use the 22:00-UTC trading-day anchor. Carry-forward reconstructs balances backwards from the current stamped balance — windows older than the recorded history show the maths honestly rather than guessing. Unknown symbols count in totals but not the six market columns.
      </p>
    </>
  )
}

// One desktop ledger row, expandable into the market breakdown.
// `forceOpen` (boolean) overrides the internal state — the expanded modal's
// "expand all / collapse all" toggle drives it.
function LedgerRow({ w, forceOpen = null, nowMs }) {
  const [openState, setOpen] = useState(false)
  const open = forceOpen ?? openState
  const empty = !w.trades
  const last = empty ? agoLabel(w.lastTradeAt, nowMs) : null
  return (
    <>
      <tr onClick={() => setOpen(o => !o)}
        className={`border-b border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-accent-soft)] ${empty ? 'opacity-60' : ''}`}>
        <td className="py-1.5 pr-2 whitespace-nowrap">
          <span aria-hidden="true" className={`inline-block w-3 text-[9px] ${SUB}`}>{open ? '▾' : '▸'}</span>
          {/* 10px: the app-wide first-column-head size, not the 9.5px cell size —
              the window label is the row's head. */}
          <span className="text-[10px] font-extrabold">{w.label}</span>
          <div className={`ml-3 text-[9px] ${SUB}`}>{dRange(w.from, w.to)}</div>
        </td>
        <td className={`py-1.5 px-2 text-right tabular-nums text-[9px] ${SUB}`}>{money(w.carryIn)}</td>
        <td className={`py-1.5 px-2 text-right tabular-nums text-[9px] ${pnlTone(empty ? null : w.net)}`}>
          {empty ? <span title={w.lastTradeAt ? `last fill ${new Date(w.lastTradeAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : undefined}>{last ? `last ${last}` : '—'}</span> : signed(w.net)}
        </td>
        <td className={`py-1.5 px-2 text-right tabular-nums text-[9px] ${SUB}`}>{money(w.carryOut)}</td>
        <td className="py-1.5 px-2 text-right tabular-nums text-[9px]">
          {empty ? <span className={SUB}>—</span> : (
            <>
              <div className="font-semibold">{w.trades}t · {w.winPct != null ? `${nf(0).format(w.winPct)}%` : '—'}</div>
              <div className={`text-[9px] ${SUB}`}>PF {w.pf != null ? nf(2).format(w.pf) : '—'}</div>
            </>
          )}
        </td>
        <td className="py-1.5 px-2 text-right tabular-nums text-[9px]">
          {empty ? <span className={SUB}>—</span> : (
            <>
              <div><span className={UP}>{w.tp} TP</span>{w.part > 0 && <span className={SUB} title="partial / scale-out closes"> +{w.part}p</span>} / <span className={DOWN}>{w.sl} SL</span>{w.manual > 0 && <span className={SUB} title="manual / unclassified closes (neither TP nor SL)"> · {w.manual} man</span>}</div>
              <div className={`text-[9px] font-semibold ${w.edge == null ? SUB : w.edge >= 0 ? UP : DOWN}`}>edge {w.edge != null ? `${signed(w.edge, 1)}%` : '—'}</div>
            </>
          )}
        </td>
        {MARKET_COLS.map(m => <MarketCell key={m.key} st={w.markets?.[m.key]} />)}
      </tr>
      {open && (
        <tr className="border-b border-[var(--color-border)] bg-[var(--color-accent-soft)]/40">
          <td colSpan={6 + MARKET_COLS.length} className="py-2 px-3">
            {empty
              ? <p className={`text-[9px] ${SUB}`}>No closed trades in this window{w.carryIn == null ? ' — carry appears once a balance is stamped for this scope' : ''}{last ? ` · last fill ${last} (${new Date(w.lastTradeAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : ''}.</p>
              : <WindowDetail w={w} />}
          </td>
        </tr>
      )}
    </>
  )
}

// Mobile ledger card — exact port of the Ledger phone screen's row:
// 76px 1fr 82px grid, carry in → carry out line, expand → 3-col market
// mini-cells on the accent tint + the insight line.
function MobileWindowCard({ w }) {
  const [open, setOpen] = useState(false)
  const empty = !w.trades
  return (
    <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 12, overflow: 'hidden', opacity: empty ? 0.65 : 1 }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        style={{ cursor: 'pointer', fontFamily: 'inherit', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: P_TX, display: 'grid', gridTemplateColumns: '76px 1fr 82px', gap: 6, alignItems: 'center', padding: '7px 11px', fontVariantNumeric: 'tabular-nums', minHeight: 44 }}>
        <span style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 9, fontWeight: W_ROWLABEL }}>{w.label}</span>
          <span style={{ fontSize: 9, color: P_ACC }}>{dRange(w.from, w.to)}</span>
        </span>
        <span style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 9, color: P_SB }}>{money(w.carryIn)} → <span style={{ fontWeight: W_CELL, color: P_TX }}>{money(w.carryOut)}</span></span>
          <span style={{ fontSize: 9, color: P_MU }}>{empty ? 'no closed trades' : `${w.trades} · ${w.winPct != null ? `${nf(0).format(w.winPct)}%` : '—'} · PF ${w.pf != null ? nf(2).format(w.pf) : '—'} · TP/SL ${w.tp + w.part}/${w.sl} · edge `}<span style={{ fontWeight: W_CELL, color: w.edge == null ? P_MU : w.edge >= 0 ? P_UP : P_DN }}>{empty ? '' : (w.edge != null ? `${signed(w.edge, 1)}%` : '—')}</span></span>
        </span>
        <span style={{ fontSize: 9, fontWeight: W_CELL, textAlign: 'right', color: empty ? P_MU : w.net >= 0 ? P_UP : P_DN }}>{empty ? '—' : signed(w.net)}</span>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${P_EDG}`, background: P_ACS, padding: '6px 11px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {empty
            ? <span style={{ fontSize: 9, color: P_SB }}>No closed trades in this window.</span>
            : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4 }}>
                  {MARKET_COLS.map(m => {
                    const st = w.markets?.[m.key]
                    return (
                      <span key={m.key} style={{ display: 'flex', flexDirection: 'column', border: `1px solid ${P_EDG}`, borderRadius: 8, padding: '4px 7px' }}>
                        <span style={{ fontSize: 9, fontWeight: W_HEAD, textTransform: 'uppercase', color: P_MU }}>{m.label}</span>
                        <span style={{ fontSize: 9, fontWeight: W_CELL, fontVariantNumeric: 'tabular-nums', color: st?.trades ? (st.net >= 0 ? P_UP : P_DN) : P_MU }}>{st?.trades ? signed(st.net) : '—'}</span>
                        <span style={{ fontSize: 9, color: P_MU }}>{st?.trades ? `PF ${st.pf != null ? nf(1).format(st.pf) : '—'} · ${st.winPct != null ? `${nf(0).format(st.winPct)}%` : '—'}` : ''}</span>
                      </span>
                    )
                  })}
                </div>
                {insight(w) && <span style={{ fontSize: 9, lineHeight: 1.4, color: P_SB }}>{insight(w)}</span>}
              </>
            )}
        </div>
      )}
    </div>
  )
}

const MOBILE_SCREENS = [
  { key: 'now', label: 'Now' },
  { key: 'ledger', label: 'Ledger' },
  { key: 'markets', label: 'Markets' },
  { key: 'trades', label: 'Trades' },
  { key: 'accounts', label: 'Accounts' },
]

// Owner (2026-07-24): "this page is pack with information but I need
// sub-navigation for the page FAB on the side bar" — desktop-only floating
// jump-to-section button; the ledger's own DOM ids (added to each section's
// wrapper above, distinct from SectionTools' `id` prop which is deep-link
// state only, not a real DOM id) are the scroll targets.
const PERF_SECTIONS = [
  { id: 'sec-accounts', label: 'Accounts' },
  { id: 'sec-today-open', label: 'Today & open' },
  { id: 'sec-weekend24', label: 'Weekend 24H' },
  { id: 'sec-sessions', label: 'Market sessions' },
  { id: 'sec-ledger', label: 'Timeframe ledger' },
  { id: 'sec-gradients', label: 'Gradients' },
  { id: 'sec-fx-bands', label: 'FX bands' },
  { id: 'sec-strategy-matrix', label: 'Strategy × market' },
  { id: 'sec-crypto', label: 'Crypto' },
  { id: 'sec-winlag', label: 'Winners & laggards' },
  { id: 'sec-regime', label: 'Regime' },
  { id: 'sec-balance', label: 'Balance in/out' },
  { id: 'sec-datafeed', label: 'Data feed' },
  { id: 'sec-tiles', label: 'Tiles & equity' },
]

export default function Performance() {
  const [ledger, setLedger] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [selectedAccountId, setSelectedAccountId] = useState(null)
  const [acct, setAcct] = useState('all') // filter: 'all' | account_id
  const [allTrades, setAllTrades] = useState([])
  const [events, setEvents] = useState([])
  // Written post-mortems, for the debrief card. Best-effort: an agent without
  // the route, or a DB with none written, leaves this empty and the card says
  // "no post-mortem written" per trade rather than implying one exists.
  const [postmortems, setPostmortems] = useState([])
  const [positions, setPositions] = useState([])
  const [ledgers, setLedgers] = useState({}) // per-account ledgers (balance + windows)
  const [riskFull, setRiskFull] = useState(null)
  const [screen, setScreen] = useState('now') // mobile pill nav
  const [error, setError] = useState('')
  // "Now" for the derived windows below — stamped at each data load so the
  // memos stay pure (react-hooks/purity forbids Date.now() inside useMemo);
  // the 60s refresh keeps it current enough for day-window maths.
  const [loadedAt, setLoadedAt] = useState(() => Date.now())
  // Whose positions the route says these are (owner: state the account beside
  // the Open positions table).
  const [posScope, setPosScope] = useState({ accountId: null, legacyRows: 0 })

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — set it up on Connect.'); return }
    try {
      // ONE account for the whole page. The ledger already honoured `acct`;
      // trades, risk events and positions did not, so the page mixed one
      // account's ledger with every account's positions (owner: "All the live
      // positions in performance, trade, monitor, desk are the same when i
      // switch account"). `?account=` is now threaded through all four —
      // 'all' means the portfolio view, explicitly.
      const q = acct === 'all' ? '?account=all' : `?account=${encodeURIComponent(acct)}`
      const [led, ac, t, r, p, pm] = await Promise.all([
        agentGet(`/state/perf-ledger${acct === 'all' ? '' : `?account=${encodeURIComponent(acct)}`}`),
        agentGet('/state/accounts').catch(() => null),
        agentGet(`/state/trades${q}`).catch(() => null),
        agentGet(`/state/risk-events?limit=200&account=${encodeURIComponent(acct)}`).catch(() => null),
        agentGet(`/state/positions${q}`).catch(() => null),
        agentGet('/state/postmortems?limit=200').catch(() => null),
      ])
      setLedger(led)
      setAccounts(ac?.accounts || [])
      setSelectedAccountId(ac?.selectedAccountId || null)
      setAllTrades(t?.rows || t?.trades || [])
      setEvents(r?.rows || [])
      setPositions(p?.rows || p?.positions || [])
      setPosScope({ accountId: p?.accountId ?? null, legacyRows: p?.legacyRows ?? 0 })
      setPostmortems(pm?.rows || pm?.postmortems || [])
      // Per-account ledgers feed the accounts detail row (balance, day P&L
      // scope, 30D forecast pace) — small server-side aggregations, one per
      // registry row. risk-full supplies the real daily-loss config + the
      // selected account's broker equity.
      const accRows = ac?.accounts || []
      const [perAcct, rf] = await Promise.all([
        Promise.all(accRows.map(a =>
          agentGet(`/state/perf-ledger?account=${encodeURIComponent(a.account_id)}`)
            .then(l => [a.account_id, l]).catch(() => null))),
        agentGet('/state/risk-full').catch(() => null),
      ])
      setLedgers(Object.fromEntries(perAcct.filter(Boolean)))
      setRiskFull(rf)
      setLoadedAt(Date.now())
      setError('')
    } catch (e) { setError(e.message) }
  }, [acct])

  // Instant paint (owner 2026-07-28: "not able to see the information now
  // is frustrating") — hydrate every section synchronously from the last
  // cached responses BEFORE the first network round-trip; the fresh data
  // then updates in place. A revisit or slow agent shows numbers
  // immediately instead of a blank page.
  useEffect(() => {
    const led = swrPeek(`/state/perf-ledger${acct !== 'all' ? `?account=${encodeURIComponent(acct)}` : ''}`)
    if (led) setLedger(led)
    const ac = swrPeek('/state/accounts')
    if (ac) { setAccounts(ac.accounts || []); setSelectedAccountId(ac.selectedAccountId || null) }
    // These keys MUST match the URLs `load` fetches, or the instant-paint layer
    // misses — and worse, an old unscoped key would repaint every account's
    // rows over the scoped ones.
    const q = acct === 'all' ? '?account=all' : `?account=${encodeURIComponent(acct)}`
    const t2 = swrPeek(`/state/trades${q}`)
    if (t2) setAllTrades(t2.rows || t2.trades || [])
    const r2 = swrPeek(`/state/risk-events?limit=200&account=${encodeURIComponent(acct)}`)
    if (r2) setEvents(r2.rows || [])
    const p2 = swrPeek(`/state/positions${q}`)
    if (p2) { setPositions(p2.rows || p2.positions || []); setPosScope({ accountId: p2?.accountId ?? null, legacyRows: p2?.legacyRows ?? 0 }) }
    const pm2 = swrPeek('/state/postmortems?limit=200')
    if (pm2) setPostmortems(pm2.rows || pm2.postmortems || [])
    const rf2 = swrPeek('/state/risk-full')
    if (rf2) setRiskFull(rf2)
    if (led || t2) setLoadedAt(Date.now())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const kick = setTimeout(load, 0)
    const t = setInterval(() => { if (!pageAsleep()) load() }, REFRESH_MS)
    return () => { clearTimeout(kick); clearInterval(t) }
  }, [load])

  // An account switch must not wait out this page's poll interval (see
  // src/lib/selected-account.js — it was up to 70s with the server cache).
  const switchingTo = useAccountSwitch(load)

  // Closed trades scoped to the account filter (M1 NULL-tolerant convention:
  // unstamped legacy rows belong to every scope).
  const scopedClosed = useMemo(() => {
    const closed = allTrades.filter(t2 => t2.status === 'closed' && t2.net_pnl != null)
    if (acct === 'all') return closed
    return closed.filter(t2 => t2.account_id == null || String(t2.account_id) === acct)
  }, [allTrades, acct])

  // The "Today" window. Owner (2026-07-25, Saturday): "under today should
  // show Friday past 24h closure trades — don't leave it blank as today is
  // SAT" — during the FX weekend the current FX day is an empty gap (market
  // closed since Fri 17:00 NY), so the card falls back to the last
  // COMPLETED FX day: Thu 17:00 NY → Fri 17:00 NY, Friday's full 24 hours.
  const todayWin = useMemo(() => {
    const anchor = dayAnchorMs(loadedAt)
    if (isFxWeekend(loadedAt)) {
      return { from: anchor - 24 * 3600_000, to: anchor, weekend: true, label: "market closed — showing Friday's full FX day" }
    }
    return { from: anchor, to: loadedAt, weekend: false, label: null }
  }, [loadedAt])

  // Today since the FX day roll — the design's "Today" number, plus the
  // TP/SL split the prototype's meta line shows (evidence: close_reason).
  const today = useMemo(() => {
    const rows = scopedClosed.filter(t2 => { const ms = closedMs(t2); return ms != null && ms >= todayWin.from && ms < todayWin.to })
    const wins = rows.filter(t2 => Number(t2.net_pnl) > 0)
    const isTp = (r) => /\btp\b|take.?profit|target|bank|partial|scale/.test(String(r || '').toLowerCase())
    const isSl = (r) => /\bsl\b|stop.?loss|stopped|stop hit/.test(String(r || '').toLowerCase())
    return {
      net: rows.reduce((s, t2) => s + Number(t2.net_pnl), 0), n: rows.length,
      wr: rows.length ? Math.round((wins.length / rows.length) * 100) : null,
      tp: rows.filter(t2 => isTp(t2.close_reason) && !isSl(t2.close_reason)).length,
      sl: rows.filter(t2 => isSl(t2.close_reason) && !isTp(t2.close_reason)).length,
    }
  }, [scopedClosed, todayWin])

  // Owner (2026-07-24 evening): "the today card cannot be empty... it
  // should show across a 24 hours (1hr timeframe) the Open balance, P/L,
  // Close balance, trades, close trades" — a zero-trade day still has 24
  // hourly slots since the FX day open; each carries the account's balance
  // forward/backward from the current stamped balance the same way the
  // Timeframe ledger's carry-in/carry-out does, so an hour with no closes
  // still shows a real (flat) balance line instead of nothing at all.
  const todayHourly = useMemo(() => {
    const curBal = ledger?.balance ?? null
    const H = 60 * 60 * 1000
    // Owner (2026-07-28): "where are the 24 hours... even market close you
    // have bitcoin" — the loop used to stop at `now`, so an hour into the FX
    // day the table held 2 rows and looked broken. Always emit the full 24
    // slots of the FX day; hours still in the future are marked `pending`
    // and render dashed instead of being silently absent.
    const slots = []
    for (let from = todayWin.from; from < todayWin.from + 24 * H; from += H) {
      slots.push({ from, to: from + H, pending: !todayWin.weekend && from >= todayWin.to })
    }
    const withStats = slots.map(s => {
      const closedIn = scopedClosed.filter(t2 => { const ms = closedMs(t2); return ms != null && ms >= s.from && ms < s.to })
      const openedIn = scopedClosed.filter(t2 => { const ms = closedMs({ closed_at: t2.opened_at }); return ms != null && ms >= s.from && ms < s.to })
      return { ...s, net: closedIn.reduce((n, t2) => n + Number(t2.net_pnl), 0), closedN: closedIn.length, openedN: openedIn.length }
    })
    // Carry back from the CURRENT stamped balance — anything closed after
    // the window's end (weekend crypto closes when the window is Friday)
    // is subtracted first so Friday's close balance stays honest.
    const netAfter = scopedClosed.reduce((n, t2) => { const ms = closedMs(t2); return ms != null && ms >= todayWin.to ? n + Number(t2.net_pnl) : n }, 0)
    let closeBal = curBal != null ? Number((curBal - netAfter).toFixed(2)) : null
    const withBal = []
    for (let i = withStats.length - 1; i >= 0; i--) {
      const s = withStats[i]
      const cb = closeBal
      const ob = cb != null ? Number((cb - s.net).toFixed(2)) : null
      withBal.unshift({ ...s, openBal: ob, closeBal: cb })
      closeBal = ob
    }

    // UI-2 — newest hour first, live hour marked. The reverse happens AFTER
    // the carry above, which must run oldest-to-newest; see hourly-order.js
    // for why reversing before it would invert every balance on the page.
    return orderHourlyForDisplay(withBal, loadedAt)
  }, [scopedClosed, todayWin, ledger, loadedAt])

  // UI-2 — floating P&L for the LIVE hour. Summed across every open position
  // regardless of which sub-table it renders in (market-open, market-closed,
  // weekend-24h), because the question the row answers is "what is live right
  // now", not "what is tradeable right now".
  //
  // Deliberately NOT folded into the hour's `net` or the balance carry. `net`
  // is REALIZED P&L from closes, and the balance column is realized-only;
  // adding unrealized money to either would make the close-balance line
  // disagree with the broker's balance. Equity = balance + floating, and this
  // column is the floating half shown next to it, not mixed into it.

  // Today's closed-trade stats per market session (owner: "all the
  // statistics for today: different markets (SYD, SG, HK, JPN, EUR, NY
  // time frame)"). Same day anchor + trade scope as the Today block so the
  // numbers reconcile; each trade is bucketed by its CLOSE time (when the
  // P&L was realized).
  const sessionStats = useMemo(() => {
    // Same window as the Today card (weekend → Friday's completed FX day)
    // so the two blocks always reconcile.
    const rows = scopedClosed
      .map(t2 => ({ ms: closedMs(t2), pnl: Number(t2.net_pnl) }))
      .filter(r => r.ms != null && r.ms >= todayWin.from && r.ms < todayWin.to && Number.isFinite(r.pnl))
    const minOfDay = (ms) => { const d = new Date(ms); return d.getUTCHours() * 60 + d.getUTCMinutes() }
    const stat = (list) => {
      if (!list.length) return { n: 0 }
      const pnls = list.map(r => r.pnl).sort((a, b) => a - b)
      const sum = pnls.reduce((s, v) => s + v, 0)
      const mid = pnls.length >> 1
      return {
        n: pnls.length,
        pos: pnls.filter(v => v > 0).reduce((s, v) => s + v, 0),
        neg: pnls.filter(v => v < 0).reduce((s, v) => s + v, 0),
        high: pnls[pnls.length - 1],
        low: pnls[0],
        avg: sum / pnls.length,
        sum,
        median: pnls.length % 2 ? pnls[mid] : (pnls[mid - 1] + pnls[mid]) / 2,
      }
    }
    const inWin = (m, s) => m >= s.fromMin && m < s.toMin
    const nowMin = minOfDay(loadedAt)
    // Owner (2026-07-24): "put in the last computation... and a tiny closed
    // sign like SYD closed" — the stats themselves are already the last
    // computed value (historical closes, frozen once the session ends); what
    // was missing was a live open/closed flag per session, evaluated at the
    // current minute, so a closed market can be labeled instead of looking
    // like a stalled table.
    const buckets = STAT_SESSIONS.map(s => ({ ...s, open: !todayWin.weekend && inWin(nowMin, s), ...stat(rows.filter(r => inWin(minOfDay(r.ms), s))) }))
    const off = stat(rows.filter(r => !STAT_SESSIONS.some(s => inWin(minOfDay(r.ms), s))))
    return { buckets, off, total: stat(rows) }
  }, [scopedClosed, loadedAt, todayWin])

  // Per-account cards for the accounts detail row (prototype ACC block).
  // Real sources only: registry row + that account's ledger balance/30D +
  // today's strictly-stamped trades + risk config dailyLossPct; equity and
  // floating exist only for the broker-selected account (risk-full margin).
  const acctCards = useMemo(() => {
    const anchor = dayAnchorMs(loadedAt)
    const closed = allTrades.filter(t2 => t2.status === 'closed' && t2.net_pnl != null)
    const dailyLossPct = riskFull?.risk?.effective?.dailyLossPct ?? null
    return accounts.map(a => {
      const led = ledgers[a.account_id]
      const bal = led?.balance ?? null
      const rows = closed.filter(t2 => String(t2.account_id ?? '') === a.account_id && (() => { const ms = closedMs(t2); return ms != null && ms >= anchor })())
      const day = rows.reduce((s, t2) => s + Number(t2.net_pnl), 0)
      const gw = rows.filter(t2 => Number(t2.net_pnl) > 0).reduce((s, t2) => s + Number(t2.net_pnl), 0)
      const gl = rows.filter(t2 => Number(t2.net_pnl) <= 0).reduce((s, t2) => s + -Number(t2.net_pnl), 0)
      const n30 = led?.windows?.find(w => w.key === '30d')?.net ?? null
      const cap = bal != null && dailyLossPct != null ? bal * dailyLossPct : null
      const used = cap ? Math.min(100, Math.round(Math.max(0, -day) / cap * 100)) : null
      const isSel = a.account_id === selectedAccountId
      const equity = isSel ? riskFull?.margin?.equity ?? null : null
      const live = isSel && equity != null && bal != null ? equity - bal : null
      return {
        id: a.account_id,
        name: `${a.is_live ? 'Live' : 'Demo'} · ${a.trader_login || a.account_id}`,
        ccy: a.base_currency || '—',
        bal, day, gw, gl, n30, cap, used, equity, live,
        hasToday: rows.length > 0,
        usedCol: used == null ? P_MU : used > 66 ? P_DN : used > 33 ? P_WRN : P_ACC,
      }
    })
  }, [accounts, ledgers, riskFull, allTrades, loadedAt, selectedAccountId])

  // Open positions split by MARKET STATE (owner 2026-07-24: open trades sat
  // stuck through a Friday close the UI never surfaced). /state/positions
  // now stamps market_open (broker-truth symbol_hours schedule) and the
  // latest computed P&L from the ~30s broker snapshot; unknown market state
  // rides in the floating table marked '?'. SL/TP distances stay
  // entry-based (tooltip says so).
  const openSplit = useMemo(() => {
    const rows = positions.map(p2 => {
      const e = Number(p2.entry_price), sl = Number(p2.current_sl), tp = Number(p2.current_tp)
      const pct = (v) => (Number.isFinite(e) && e !== 0 && Number.isFinite(v) ? (Math.abs(e - v) / e * 100).toFixed(1) + '%' : '—')
      return {
        id: p2.id, sym: p2.symbol,
        side: String(p2.side || '').toUpperCase() === 'BUY' ? 'LONG' : 'SHORT',
        sideCol: String(p2.side || '').toUpperCase() === 'BUY' ? P_UP : P_DN,
        lots: p2.volume != null ? String(p2.volume) : '—',
        entry: Number.isFinite(e) ? String(e) : '—', strat: p2.strategy || '—',
        sld: pct(sl), tpd: pct(tp),
        // Raw levels for the Trade Cockpit (symbol click) — it needs numbers,
        // not the entry-relative percentages shown in the table.
        entryRaw: Number.isFinite(e) ? e : null,
        slRaw: Number.isFinite(sl) ? sl : null,
        tpRaw: Number.isFinite(tp) ? tp : null,
        marketOpen: p2.market_open, marketSource: p2.market_source || null,
        mfeR: p2.mfe_r ?? null, maeR: p2.mae_r ?? null,
        pnl: p2.live_pnl != null ? Number(p2.live_pnl) : null,
        pnlAt: p2.live_pnl_at || null,
        // Owner: current price + daily OHLCV per open trade. For a closed
        // market these are the last computed values before/at close.
        price: p2.live_price ?? null,
        day: p2.day || null,
      }
    })
    // One roster shared by every row — the cockpit's FLEET strip is computed
    // from the account's real other open positions (cockpit-fleet.js).
    const roster = rows.map(r => ({ id: r.id, sym: r.sym, side: r.side, entry: r.entryRaw, sl: r.slRaw, price: r.price }))
    rows.forEach(r => { r.roster = roster })

    let floating = rows.filter(r => r.marketOpen !== false)
    // Owner (2026-07-24): "give market open trades as priority in the
    // table" — confirmed-open-market rows first, unknown-market rows
    // (marketOpen == null) after; a stable sort keeps everything else in
    // its existing order.
    const priority = (r) => (r.marketOpen === true ? 0 : 1)
    floating = [...floating].sort((a, b) => priority(a) - priority(b))
    const closed = rows.filter(r => r.marketOpen === false)
    // Owner (2026-07-24): during the FX weekend (Fri 17:00 NY → Sun 17:00
    // NY) the symbols still trading are the 24h ones — they get their own
    // collapsible table instead of mixing into the floating list. Broker
    // truth decides: market_open === true on a weekend IS the 24h test.
    let weekend24 = []
    if (isFxWeekend(loadedAt)) {
      weekend24 = floating.filter(r => r.marketOpen === true)
      floating = floating.filter(r => r.marketOpen !== true)
    }
    const tot = (l) => (l.some(r => r.pnl != null) ? l.reduce((s, r) => s + (r.pnl ?? 0), 0) : null)
    return { floating, closed, weekend24, floatTot: tot(floating), closedTot: tot(closed), weekendTot: tot(weekend24) }
  }, [positions, loadedAt])

  // MUST stay BELOW openSplit. It was declared ~80 lines above it and read
  // openSplit inside the useMemo factory, which React runs during render —
  // so it hit the temporal dead zone and threw "Cannot access 'openSplit'
  // before initialization". Performance is the landing route AND is in the
  // main bundle, so the throw took out the whole app: every page rendered
  // blank. Shipped in #482 and live until 2026-07-29.
  const liveFloating = useMemo(
    () => totalFloating(openSplit.floatTot, openSplit.closedTot, openSplit.weekendTot),
    [openSplit])


  // Stat tiles migrated verbatim from Desk's old Performance section —
  // they work from trade #1 with no warm-up.
  const tiles = useMemo(() => {
    const closed = allTrades.filter(t2 => t2.status === 'closed' && t2.net_pnl != null)
    if (closed.length === 0) return null
    const pnls = closed.map(t2 => Number(t2.net_pnl))
    const wins = pnls.filter(v => v > 0)
    const losses = pnls.filter(v => v <= 0)
    const total = pnls.reduce((s2, v) => s2 + v, 0)
    const grossWin = wins.reduce((s2, v) => s2 + v, 0)
    const grossLoss = Math.abs(losses.reduce((s2, v) => s2 + v, 0))
    const pf = grossLoss > 0 ? grossWin / grossLoss : null
    let peak = 0; let equity = 0; let mdd = 0
    for (const v of pnls) { equity += v; peak = Math.max(peak, equity); mdd = Math.max(mdd, peak - equity) }
    // Owner (2026-07-25): "redo the All-time tiles & equity table from the
    // ground up." Streaks, payoff, hold time and the per-day split all come
    // from this same closed set, so every figure in the table reconciles with
    // every other one and with the ledger.
    const chron = [...closed]
      .map(t2 => ({ ms: closedMs(t2), pnl: Number(t2.net_pnl), hold: t2.hold_duration_ms != null ? Number(t2.hold_duration_ms) : null }))
      .filter(t2 => t2.ms != null)
      .sort((a, b) => a.ms - b.ms)
    let winStreak = 0, lossStreak = 0, curW = 0, curL = 0
    for (const t2 of chron) {
      if (t2.pnl > 0) { curW++; curL = 0 } else { curL++; curW = 0 }
      winStreak = Math.max(winStreak, curW); lossStreak = Math.max(lossStreak, curL)
    }
    const byDay = new Map()
    for (const t2 of chron) {
      const k = new Date(t2.ms).toISOString().slice(0, 10)
      byDay.set(k, (byDay.get(k) || 0) + t2.pnl)
    }
    const dayNets = [...byDay.values()]
    const holds = chron.map(t2 => t2.hold).filter(v => Number.isFinite(v) && v > 0)
    const avgWin = wins.length ? grossWin / wins.length : null
    const avgLoss = losses.length ? grossLoss / losses.length : null
    return {
      closed, pnls, wins, losses, total, grossWin, grossLoss, pf, mdd,
      avgWin, avgLoss,
      payoff: avgWin != null && avgLoss ? avgWin / avgLoss : null,
      winStreak, lossStreak,
      firstMs: chron.length ? chron[0].ms : null,
      lastMs: chron.length ? chron[chron.length - 1].ms : null,
      tradingDays: byDay.size,
      greenDays: dayNets.filter(v => v > 0).length,
      bestDay: dayNets.length ? Math.max(...dayNets) : null,
      worstDay: dayNets.length ? Math.min(...dayNets) : null,
      medHoldMin: holds.length ? Math.round(holds.sort((a, b) => a - b)[Math.floor(holds.length / 2)] / 60_000) : null,
    }
  }, [allTrades])

  const windows = useMemo(() => ledger?.windows || [], [ledger])

  // Shared client-side aggregation for the FX bands / strategy matrix —
  // mirrors the server ledger's stats (win%, PF, planned R:R → required
  // win% → edge) so every lens reconciles. Evidence-only classification.
  const shapedTrades = useMemo(() => {
    const isTp = (r) => /\btp\b|take.?profit|target|bank/.test(String(r || '').toLowerCase())
    const isSl = (r) => /\bsl\b|stop.?loss|stopped|stop hit/.test(String(r || '').toLowerCase())
    const num = (v) => (v == null ? NaN : Number(v))
    return scopedClosed.map(t2 => {
      const e = num(t2.entry_price), s = num(t2.sl_price), tp = num(t2.tp_price)
      const rr = [e, s, tp].every(Number.isFinite) && Math.abs(e - s) !== 0 ? Math.abs(tp - e) / Math.abs(e - s) : null
      const tpHit = isTp(t2.close_reason) && !isSl(t2.close_reason)
      const slHit = isSl(t2.close_reason) && !isTp(t2.close_reason)
      const openedAt = closedMs({ closed_at: t2.opened_at })
      const tEnd = closedMs(t2)
      return {
        t: tEnd, pnl: Number(t2.net_pnl), sym: String(t2.symbol || '').toUpperCase(),
        strat: t2.label_strategy || t2.strategy || null, rr, tpHit, slHit,
        part: /partial|scale/.test(String(t2.close_reason || '').toLowerCase()),
        side: String(t2.side || '').toUpperCase() === 'BUY' ? 'LONG' : 'SHORT',
        lots: t2.volume != null ? String(t2.volume) : '—',
        openedAt, durMin: t2.hold_duration_ms != null ? Math.round(t2.hold_duration_ms / 60000) : (openedAt != null && tEnd != null ? Math.round((tEnd - openedAt) / 60000) : null),
        rvO: t2.rvol_open ?? null, vwO: t2.vwap_side_open ?? null, obv: t2.obv_open ?? null,
      }
    }).filter(t2 => t2.t != null)
  }, [scopedClosed])

  // The itemised list behind the Today card's hourly aggregate — same window
  // and same trade scope, so the count here always equals `today.n` and the
  // sum of the P&L column always equals `today.net`. Newest close first,
  // because the thing you just felt is the thing you look for.
  const todayTrades = useMemo(() => shapedTrades
    .filter(t2 => t2.t >= todayWin.from && t2.t < todayWin.to)
    .sort((a, b) => b.t - a.t)
    .map(t2 => {
      const out = t2.part ? 'TP partial' : t2.tpHit ? 'TP full' : t2.slHit ? 'SL hit' : 'manual close'
      const held = t2.durMin == null ? null : (t2.durMin >= 60 ? `${Math.floor(t2.durMin / 60)}h ` : '') + `${t2.durMin % 60}m`
      return {
        id: `${t2.sym}-${t2.t}-${t2.lots}`,
        hm: new Date(t2.t).toISOString().slice(11, 16),
        sym: t2.sym, side: t2.side, lots: t2.lots, pnl: t2.pnl,
        detail: [
          out,
          t2.strat || 'no strategy label',
          t2.openedAt != null ? `opened ${new Date(t2.openedAt).toISOString().slice(11, 16)} UTC` : null,
          held ? `held ${held}` : null,
          t2.rr != null ? `plan ${nf(1).format(t2.rr)}:1` : null,
        ].filter(Boolean).join(' · '),
      }
    }), [shapedTrades, todayWin])

  const fxBands = useMemo(() => {
    const wk = shapedTrades.filter(t2 => t2.t >= loadedAt - 7 * D)
    return FX_BANDS.map(([band, syms]) => {
      const l = wk.filter(t2 => syms.includes(t2.sym))
      const a = aggRows(l)
      return {
        band,
        net: l.length ? signed(a.pnl) : '—', col: l.length ? (a.pnl >= 0 ? P_UP : P_DN) : P_MU,
        meta: `${a.n} tr · ${a.wr}% · PF ${Number.isFinite(a.pf) ? a.pf.toFixed(1) : '∞'} · edge ${a.edge != null ? `${a.edge >= 0 ? '+' : ''}${a.edge}%` : '—'}`,
        pairs: syms.map(sym => {
          const pl = l.filter(t2 => t2.sym === sym)
          const pa = aggRows(pl)
          return {
            sym: sym.slice(0, 3) + '/' + sym.slice(3),
            v: pa.n ? signed(pa.pnl) : '·', col: pa.n ? (pa.pnl >= 0 ? P_UP : P_DN) : P_MU,
            tip: `${sym} · ${pa.n} trades · ${pa.wr}% win · ${pa.tp + pa.part} TP / ${pa.sl} SL`,
          }
        }),
      }
    })
  }, [shapedTrades, loadedAt])

  // Strategy × market matrix — the prototype's 30D re-slice, but over the
  // strategies actually present in the data (never a hardcoded list).
  const stratMx = useMemo(() => {
    const m30 = shapedTrades.filter(t2 => t2.t >= loadedAt - 30 * D)
    const names = [...new Set(m30.map(t2 => t2.strat).filter(Boolean))]
    return names.map(name => {
      const sl = m30.filter(t2 => t2.strat === name)
      const a = aggRows(sl)
      return {
        name, net: signed(a.pnl), col: a.pnl >= 0 ? P_UP : P_DN,
        edge: a.edge != null ? `${a.edge >= 0 ? '+' : ''}${a.edge}%` : '—', edgeCol: a.edge == null ? P_MU : a.edge >= 0 ? P_UP : P_DN,
        cells: MARKET_COLS.map(m => {
          const l = sl.filter(t2 => catOf(t2.sym) === m.key)
          const p = l.reduce((s, t2) => s + t2.pnl, 0)
          return { v: l.length ? signed(p) : '·', col: l.length ? (p >= 0 ? P_UP : P_DN) : P_MU, tip: `${l.length} trades` }
        }),
      }
    })
  }, [shapedTrades, loadedAt])

  // Crypto 24/7 panel — prototype cryptoK chips + rows. Live price/Δ are
  // simulated ticks in the prototype; this page has no price stream, so
  // those cells show — (never simulated). P&L and win stats are real.
  const crypto = useMemo(() => {
    const k = [[24, '24H'], [168, '7D'], [720, '30D']].map(([h, kk]) => {
      const l = shapedTrades.filter(t2 => catOf(t2.sym) === 'crypto' && t2.t >= loadedAt - h * 36e5)
      const p = l.reduce((s, t2) => s + t2.pnl, 0)
      return { k: kk, v: l.length ? signed(p) : '—', col: l.length ? (p >= 0 ? P_UP : P_DN) : P_MU }
    })
    const rows = CRYPTO_SYMS.map(sym => {
      const a = aggRows(shapedTrades.filter(t2 => t2.sym === sym && t2.t >= loadedAt - 7 * D))
      return {
        sym,
        pnl: a.n ? signed(a.pnl) : '—', col: a.n ? (a.pnl >= 0 ? P_UP : P_DN) : P_MU,
        meta: a.n ? `${a.n} tr · ${a.wr}% win · PF ${Number.isFinite(a.pf) ? a.pf.toFixed(2) : '∞'}` : 'no closed trades 7D',
      }
    })
    return { k, rows }
  }, [shapedTrades, loadedAt])

  // Winners & Laggards explained — the prototype's anat() over the REAL
  // best/worst closed trades (30D): outcome · planned R:R · risked · held,
  // plus the forensics line (RVOL/VWAP at open; out-side not collected yet).
  const winLag = useMemo(() => {
    const MO2 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const ft = (ms) => { const d2 = new Date(ms); return String(d2.getUTCHours()).padStart(2, '0') + ':' + String(d2.getUTCMinutes()).padStart(2, '0') }
    const anat = (t2) => {
      const d2 = new Date(t2.t)
      const out = t2.part ? 'TP partial' : t2.tpHit ? 'TP full' : t2.slHit ? 'SL hit' : 'manual close'
      const risked = t2.slHit ? Math.abs(t2.pnl) : (t2.rr ? Math.abs(t2.pnl / t2.rr) : null)
      const held = t2.durMin == null ? '—' : (t2.durMin >= 60 ? `${Math.floor(t2.durMin / 60)}h ` : '') + `${t2.durMin % 60}m`
      const inSide = t2.rvO != null || t2.vwO ? `RVOL ${t2.rvO != null ? `${nf(1).format(t2.rvO)}×` : '—'} · ${t2.vwO ? `${t2.vwO} VWAP` : '—'} · OBV ${t2.obv || '—'}` : null
      // Owner (2026-07-25, iPad mini): "cell data with so many wording must
      // be considered to user, can you use point texting" — the anatomy used
      // to be ONE '·'-joined sentence that wrapped to six lines inside a
      // ~130px cell. It is now a list of SHORT points, rendered one per line.
      // A point with no data is omitted entirely rather than printing "—":
      // the out-side volume context is never recorded yet, so the old
      // "in: … → out: —" tail was pure noise on every single row.
      const points = [
        `${out} · ${t2.strat || 'no strategy label'}`,
        [t2.rr != null ? `plan ${nf(1).format(t2.rr)}:1` : null,
         risked != null ? `risked ${money(risked, 0)}` : null,
         t2.durMin != null ? `held ${held}` : null].filter(Boolean).join(' · '),
        inSide ? `in ${inSide}` : null,
      ].filter(Boolean)
      return {
        when: `${d2.getUTCDate()} ${MO2[d2.getUTCMonth()]} · ${t2.openedAt != null ? ft(t2.openedAt) : '—'} → ${ft(t2.t)} UTC`,
        sym: t2.sym, sd: `${t2.side} ${t2.lots} lots`, strat: t2.strat || '—',
        points,
        // Kept for the ⧉/⤢ copy payloads, which are plain-text by contract.
        why: `${out} · planned ${t2.rr != null ? `${nf(1).format(t2.rr)}:1` : '—'} · risked ${risked != null ? money(risked, 0) : '—'} · held ${held}`,
        ind: inSide ? `in: ${inSide}` : 'no volume context recorded',
        pnl: signed(t2.pnl), col: t2.pnl >= 0 ? P_UP : P_DN,
      }
    }
    const sorted30 = [...shapedTrades.filter(t2 => t2.t >= loadedAt - 30 * D)].sort((a, b) => a.pnl - b.pnl)
    return { lag: sorted30.slice(0, 6).map(anat), win: sorted30.slice(-6).reverse().map(anat) }
  }, [shapedTrades, loadedAt])

  // Performance gradients — exact prototype maths (cell alpha pow(|v|/max,.6),
  // rgba(79,140,255,…)/rgba(255,77,109,…) fills, per-column peak scaling,
  // k-notation values). Columns = registry accounts + Overall; rows use the
  // ledger's own window bounds. Trades without an account stamp count only
  // in Overall (never guessed onto an account).
  const gradients = useMemo(() => {
    // Classifier: shared/formulas.js `categorize` (imported as catOf). This
    // card used to carry its own stock-aware copy while the rest of the page
    // filed equities under Indices — the "Stocks −$953 here, Indices −$404
    // there" contradiction. One classifier now serves every lens.
    const rows = allTrades
      .filter(t2 => t2.status === 'closed' && t2.net_pnl != null)
      .map(t2 => ({
        t: closedMs(t2), pnl: Number(t2.net_pnl), cat: catOf(t2.symbol),
        acc: t2.account_id != null ? String(t2.account_id) : null,
        strat: t2.label_strategy || t2.strategy || null,
      }))
      .filter(t2 => t2.t != null)
    const AC3 = [...accounts.map(a => ({ name: `${a.is_live ? 'Live' : 'Demo'} ·${String(a.trader_login || a.account_id).slice(-3)}`, id: a.account_id })), { name: 'Overall', id: null }]
    // Owner (2026-07-25): "add strategy column, asset columns" to the
    // timeframe gradient. Column axis becomes three GROUPS sharing the window
    // rows: account, strategy, asset class. Strategies come from the data
    // rather than a hardcoded list — whatever actually traded, ranked by
    // absolute contribution, capped at 6 so the table stays readable, with
    // anything past that folded into "other" instead of vanishing.
    const stratTotals = new Map()
    for (const r of rows) {
      const k = r.strat || 'unlabelled'
      stratTotals.set(k, (stratTotals.get(k) || 0) + Math.abs(r.pnl))
    }
    const stratNames = [...stratTotals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    const topStrats = stratNames.slice(0, 6)
    const restStrats = new Set(stratNames.slice(6))
    const SC = [
      ...topStrats.map(n => ({ name: n.replace(/_/g, ' '), pick: (t2) => (t2.strat || 'unlabelled') === n })),
      ...(restStrats.size ? [{ name: 'other', pick: (t2) => restStrats.has(t2.strat || 'unlabelled') }] : []),
    ]
    const KC = MARKET_COLS.map(m => ({ name: m.label, pick: (t2) => t2.cat === m.key }))
    const kf = (v) => (v < 0 ? '−' : '+') + '$' + (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + 'k' : String(Math.round(Math.abs(v))))
    // Owner (2026-07-25): "the red or blue pill like data and the gradient
    // colours look unprofessional for presentation". The old cell was a
    // saturated filled pill, up to 0.85 alpha with white-on-colour text —
    // dashboard-toy styling. Professional heat tables (terminals, annual
    // reports) do the opposite: the NUMBER carries the signal in the
    // semantic colour, the fill is a whisper capped low enough that text
    // contrast never changes, and zeros recede to a dot instead of shouting
    // "+$0" in a coloured chip.
    const cell = (v, max) => {
      const zero = Math.round(v * 100) === 0
      const a2 = Math.pow(Math.abs(v) / (max || 1), 0.6)
      return {
        v: zero ? '·' : kf(v),
        bg: zero ? 'transparent' : (v > 0 ? 'rgba(79,140,255,' : 'rgba(255,77,109,') + (0.04 + 0.14 * a2).toFixed(2) + ')',
        col: zero ? P_MU : v > 0 ? P_UP : P_DN,
        zero,
      }
    }
    // colDefs: [{ name, pick(trade) }] — one shaded column each, scaled
    // against its OWN peak window so a quiet account/strategy still shows
    // structure instead of washing out next to a loud one.
    const build = (rowDefs, colDefs) => {
      const raw = rowDefs.map(r => colDefs.map(c => r.list.reduce((s2, t2) => s2 + (c.pick(t2) ? t2.pnl : 0), 0)))
      const colMax = colDefs.map((x, ci) => Math.max(1, ...raw.map(rw => Math.abs(rw[ci]))))
      return rowDefs.map((r, ri) => ({ label: r.label, cells: raw[ri].map((v, ci) => cell(v, colMax[ci])) }))
    }
    // Owner: "sub-total on each column". Summed from the DISPLAYED rows, and
    // labelled a subtotal rather than a total because the windows overlap —
    // 1W is inside 2W is inside 30D, so this column sum deliberately
    // double-counts the same trade and is a column footing, not a P&L figure.
    const subtotal = (built) => {
      if (!built.length) return null
      const n = built[0].cells.length
      return Array.from({ length: n }, (_, ci) => {
        const v = built.reduce((s2, r) => {
          const raw = String(r.cells[ci].v).replace(/[+$,]/g, '').replace('−', '-')
          const mult = raw.endsWith('k') ? 1000 : 1
          const num = parseFloat(raw.replace('k', ''))
          return s2 + (Number.isFinite(num) ? num * mult : 0)
        }, 0)
        return { v: Math.round(v * 100) === 0 ? '·' : kf(v), col: v > 0 ? P_UP : v < 0 ? P_DN : P_MU }
      })
    }
    const acctCols = AC3.map(c => ({ name: c.name, pick: (t2) => c.id == null || t2.acc === c.id }))
    // Owner (2026-07-25): "why last month is zero". Because no trade CLOSED
    // inside that calendar month — the server's window is prevMonthStart →
    // monthStart (perf-ledger.js), and the account's whole closed history
    // starts later than that. A zero here is a true zero, not a gap: the row
    // label now carries "no closes" so an empty window reads as answered
    // rather than broken.
    const firstClose = rows.length ? Math.min(...rows.map(t2 => t2.t)) : null
    const wDefs = windows.map(w => {
      const from = Date.parse(w.from), to = Date.parse(w.to)
      const list = rows.filter(t2 => t2.t >= from && t2.t < to)
      const beforeHistory = firstClose != null && Number.isFinite(to) && to <= firstClose
      return {
        label: w.label + (list.length ? '' : beforeHistory ? ' · pre-history' : ' · no closes'),
        list,
      }
    })
    const cut30 = loadedAt - 30 * D
    const aDefs = MARKET_COLS.map(m => ({ label: m.label, list: rows.filter(t2 => t2.cat === m.key && t2.t >= cut30) }))
    const wideCols = [...acctCols, ...SC, ...KC]
    // Owner (2026-07-25): "remove the overall if there isn't two active
    // account trading" — with one account carrying every trade, Overall is a
    // verbatim copy of that account's column and the table asserts a
    // portfolio view it does not have. Counted on accounts that actually have
    // a closed trade, not on how many are enabled.
    const tradingAccts = new Set(rows.map(t2 => t2.acc).filter(Boolean))
    const assetCols = tradingAccts.size >= 2
      ? acctCols
      : acctCols.filter(c => c.name !== 'Overall')
    return {
      cols: AC3.map(x => ({ name: x.name })),
      // Column groups for the wide timeframe table's header band.
      groups: [
        { name: 'Account', span: acctCols.length },
        ...(SC.length ? [{ name: 'Strategy', span: SC.length }] : []),
        { name: 'Asset class', span: KC.length },
      ],
      wideCols: wideCols.map(c => ({ name: c.name })),
      // t = accounts only, for the phone screens where 15 columns cannot fit.
      // tWide = the grouped account + strategy + asset table for the section.
      t: build(wDefs, acctCols),
      tWide: build(wDefs, wideCols),
      a: build(aDefs, assetCols),
      assetCols: assetCols.map(c => ({ name: c.name })),
      overallDropped: assetCols.length !== acctCols.length,
      tWideSub: subtotal(build(wDefs, wideCols)),
      aSub: subtotal(build(aDefs, assetCols)),
    }
  }, [allTrades, accounts, windows, loadedAt])

  // Owner (2026-07-25): "redo the All-time tiles & equity table from the
  // ground up." It was nine loose boxes in a wrapping row — no grouping, no
  // units, no way to tell which number answers which question, and a JSON
  // copy that carried four of the nine. It is now a real <table> in three
  // named groups (Outcome / Edge / Risk & shape), every row carrying the
  // figure AND what it means, so the card explains itself and Card's
  // tableToJson emits all of it automatically.
  const tileGroups = tiles && (() => {
    const n = tiles.closed.length
    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—')
    const m2 = (v) => (v == null ? '—' : nf(2).format(v))
    const span = tiles.firstMs && tiles.lastMs
      ? `${new Date(tiles.firstMs).toISOString().slice(0, 10)} → ${new Date(tiles.lastMs).toISOString().slice(0, 10)}`
      : '—'
    return [
      ['Outcome', [
        ['Net P&L', signed(tiles.total), pnlTone(tiles.total), 'every closed trade, after swap and commission'],
        ['Closed trades', String(n), '', `over ${tiles.tradingDays} day${tiles.tradingDays === 1 ? '' : 's'} with a close · ${span}`],
        ['Win rate', pct(tiles.wins.length, n), '', `${tiles.wins.length} up · ${tiles.losses.length} down (a scratch counts as down)`],
        ['Expectancy', `${m2(tiles.total / n)} / trade`, pnlTone(tiles.total), 'net divided by trade count — what one more trade is worth on this record'],
      ]],
      ['Edge', [
        ['Profit factor', tiles.pf != null ? nf(2).format(tiles.pf) : tiles.wins.length ? '∞' : '—', tiles.pf == null || tiles.pf >= 1 ? UP : DOWN, `gross win ${m2(tiles.grossWin)} ÷ gross loss ${m2(tiles.grossLoss)} · above 1.0 is profitable`],
        ['Payoff ratio', tiles.payoff != null ? `${nf(2).format(tiles.payoff)} : 1` : '—', '', 'average win against average loss — the size edge, independent of win rate'],
        ['Avg win', tiles.avgWin != null ? `+${m2(tiles.avgWin)}` : '—', UP, `across ${tiles.wins.length} winner${tiles.wins.length === 1 ? '' : 's'}`],
        ['Avg loss', tiles.avgLoss != null ? `−${m2(tiles.avgLoss)}` : '—', DOWN, `across ${tiles.losses.length} loser${tiles.losses.length === 1 ? '' : 's'}`],
      ]],
      ['Risk & shape', [
        ['Max drawdown', tiles.mdd > 0 ? `−${m2(tiles.mdd)}` : '—', DOWN, 'deepest fall from an equity peak, trade by trade in close order'],
        ['Best / worst trade', `${m2(Math.max(...tiles.pnls))} / ${m2(Math.min(...tiles.pnls))}`, '', 'single largest gain and loss'],
        ['Best / worst day', `${m2(tiles.bestDay)} / ${m2(tiles.worstDay)}`, '', `${tiles.greenDays} of ${tiles.tradingDays} days closed green`],
        ['Longest streak', `${tiles.winStreak}W / ${tiles.lossStreak}L`, '', 'consecutive wins and losses in close order'],
        ['Median hold', tiles.medHoldMin != null ? (tiles.medHoldMin >= 60 ? `${Math.floor(tiles.medHoldMin / 60)}h ${tiles.medHoldMin % 60}m` : `${tiles.medHoldMin}m`) : '—', '', tiles.medHoldMin != null ? 'half the trades were held less than this' : 'hold duration not recorded on these trades'],
      ]],
    ]
  })()

  const tilesRow = tiles && (
    <table className="w-full text-left tabular-nums mb-2">
      <thead>
        <tr><th className="w-[150px]">Metric</th><th className="w-[128px]">All time</th><th>What it measures</th></tr>
      </thead>
      <tbody>
        {tileGroups.map(([group, items]) => (
          <Fragment key={group}>
            <tr>
              <td colSpan={3} className="py-0 text-[9px] font-semibold uppercase tracking-wide text-[var(--color-muted)] border-t border-[var(--glass-edge)]">{group}</td>
            </tr>
            {items.map(([label, value, tone, note]) => (
              <tr key={label} className="border-t border-[var(--glass-edge)]">
                <td className="py-0.5 px-2 text-[9px] font-medium">{label}</td>
                <td className={`py-0.5 px-2 text-[9px] ${tone}`}>{value}</td>
                <td className={`py-0.5 px-2 text-[9px] ${SUB}`}>{note}</td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  )

  return (
    <div className="space-y-2">
      <SwitchingNote to={switchingTo} />
      <SectionNavFab sections={PERF_SECTIONS} />
      {/* Header — exact prototype markup (title 16px/800, LIVE pulse badge,
          session pills, UTC clock). */}
      <style>{'@keyframes perf-pulse{0%,100%{opacity:1}50%{opacity:.3}}'}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '-.02em', color: P_TX }}>bot-trade · Performance ledger</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 9, fontWeight: 700, color: P_ACC, border: `1px solid ${P_ACC}`, borderRadius: 999, padding: '2px 8px' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: P_ACC, animation: 'perf-pulse 1.6s infinite' }} />LIVE
        </span>
        <SessionClock />
      </div>

      {error && <Card><p className="text-[9px] font-semibold text-[var(--color-down)]">{error}</p></Card>}

      {/* ================= MOBILE (below lg): the design's phone screens ====
          Exact ports of Performance Mobile.dc.html. Pill nav uses the
          prototype's chip styles with the README's ≥44px tap minimum. */}
      <div className="min-[700px]:hidden space-y-2">
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {MOBILE_SCREENS.map(s => (
            <button key={s.key} type="button" onClick={() => setScreen(s.key)}
              aria-current={screen === s.key ? 'page' : undefined}
              style={screen === s.key
                ? { fontSize: 9, fontWeight: W_CELL, color: '#fff', background: P_ACC, borderRadius: 999, padding: '3px 10px', border: 'none', minHeight: 44, cursor: 'pointer', fontFamily: 'inherit' }
                : { fontSize: 9, fontWeight: 600, color: P_SB, border: `1px solid ${P_EDG}`, background: 'transparent', borderRadius: 999, padding: '3px 10px', minHeight: 44, cursor: 'pointer', fontFamily: 'inherit' }}>
              {s.label}
            </button>
          ))}
        </div>

        {screen === 'now' && (
          <>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              <SessionClock />
            </div>
            {acctCards.map(a => (
              <div key={a.id} style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 14, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU }}>{a.name} · {a.ccy}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: W_CELL, fontVariantNumeric: 'tabular-nums', color: a.hasToday ? (a.day >= 0 ? P_UP : P_DN) : P_MU }}>day {a.hasToday ? signed(a.day) : '—'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 9, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{a.bal != null ? money(a.bal) : '—'}</span>
                  <span style={{ fontSize: 9, color: P_SB }}>eq {a.equity != null ? money(a.equity) : '—'}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 9, color: P_SB }}>live <span style={{ fontWeight: W_CELL, color: a.live == null ? P_MU : a.live >= 0 ? P_UP : P_DN }}>{a.live != null ? signed(a.live) : '—'}</span> · {a.live != null && a.bal ? `${a.live >= 0 ? '+' : ''}${(a.live / a.bal * 100).toFixed(2)}%` : '—'}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, borderTop: `1px solid ${P_EDG}`, paddingTop: 4 }}>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 9, fontWeight: W_HEAD, textTransform: 'uppercase', color: P_MU }}>TP nett</span><span style={{ fontSize: 9, fontWeight: W_CELL, fontVariantNumeric: 'tabular-nums', color: P_UP }}>{a.hasToday ? signed(a.gw) : '—'}</span></span>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 9, fontWeight: W_HEAD, textTransform: 'uppercase', color: P_MU }}>SL nett</span><span style={{ fontSize: 9, fontWeight: W_CELL, fontVariantNumeric: 'tabular-nums', color: P_DN }}>{a.hasToday ? signed(-a.gl) : '—'}</span></span>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 9, fontWeight: W_HEAD, textTransform: 'uppercase', color: P_MU }}>30D pace</span><span style={{ fontSize: 9, fontWeight: W_CELL, fontVariantNumeric: 'tabular-nums', color: a.n30 == null ? P_MU : a.n30 >= 0 ? P_UP : P_DN }}>{a.n30 != null ? `${signed(a.n30 / 30)}/day` : '—'}</span></span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ height: 4, borderRadius: 999, background: P_EDG }}>
                    <div style={{ height: 4, borderRadius: 999, width: `${Math.max(a.used ?? 0, a.used != null ? 1 : 0)}%`, background: a.usedCol }} />
                  </div>
                  <span style={{ fontSize: 9, color: P_MU }}>loss-cap used <span style={{ fontWeight: W_CELL, color: a.usedCol }}>{a.used != null ? `${a.used}%` : '—'}</span> of −{a.cap != null ? money(a.cap, 0) : '—'} · at 100% bot closes all &amp; disarms</span>
                </div>
              </div>
            ))}
            <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 14, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU }}>24 hours · FX day open (5pm NY)</span>
                <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: today.n ? (today.net >= 0 ? P_UP : P_DN) : P_MU }}>{today.n ? signed(today.net) : '—'}</span>
              </div>
              <span style={{ fontSize: 9, color: P_MU }}>{today.n ? `${today.n} closed · ${today.wr}% win · ${today.tp} TP / ${today.sl} SL` : 'no closed trades yet today'}</span>
            </div>
            {[{ key: 'float', title: 'Open positions — floating', rows: openSplit.floating, tot: openSplit.floatTot, border: P_GBD, titleCol: P_MU },
              { key: 'closed', title: 'Open trade but market closed', rows: openSplit.closed, tot: openSplit.closedTot, border: 'var(--color-warning-border)', titleCol: P_WRN }]
              .filter(t2 => t2.key === 'float' || t2.rows.length > 0).map(t2 => (
              <div key={t2.key} style={{ background: P_GL, border: `1px solid ${t2.border}`, borderRadius: 14, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: t2.titleCol }}>{t2.title}</span>
                  <AccountTag accountId={posScope.accountId} legacyRows={t2.key === 'float' ? posScope.legacyRows : 0} />
                  <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: t2.tot == null ? P_MU : t2.tot >= 0 ? P_UP : P_DN }}>{t2.rows.length ? `${t2.rows.length} open · ${t2.tot != null ? signed(t2.tot) : '—'}` : 'flat'}</span>
                </div>
                {t2.key === 'closed' && <span style={{ fontSize: 9, color: P_WRN }}>market closed — cannot exit until reopen · latest computed P&amp;L shown</span>}
                {t2.rows.map(p2 => (
                  <div key={p2.id} style={{ display: 'grid', gridTemplateColumns: '74px 66px 1fr 96px', gap: 8, alignItems: 'center', borderTop: `1px solid ${P_EDG}`, paddingTop: 5, fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: 9, fontWeight: W_ROWLABEL }}>
                        <SymbolTarget symbol={p2.sym} positionId={p2.id} position={cockpitPos(p2)} source="perf-mobile-floating">{p2.sym}</SymbolTarget>
                      </span>
                      <span style={{ fontSize: 9, color: P_MU }}>{p2.strat}</span>
                    </span>
                    <span style={{ fontSize: 9, fontWeight: W_CELL, color: p2.sideCol }}>{p2.side} {p2.lots}</span>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 9, fontWeight: W_CELL, color: p2.pnl == null ? P_MU : p2.pnl >= 0 ? P_UP : P_DN }}>{p2.pnl != null ? signed(p2.pnl) : '—'}</span>
                      <span title="SL→TP progress needs a live price — not streamed to this page" style={{ position: 'relative', height: 4, borderRadius: 999, background: P_EDG, display: 'block' }} />
                    </span>
                    <span style={{ fontSize: 9, color: P_MU, textAlign: 'right' }}>SL {p2.sld} · TP {p2.tpd}</span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}

        {screen === 'ledger' && (
          <>
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 9, fontWeight: W_HEAD, textTransform: 'uppercase', color: P_MU }}>Acct</span>
              {[{ id: 'all', label: 'All' }, ...accounts.map(a => ({ id: a.account_id, label: `${a.is_live ? 'Live' : 'Demo'} ·${String(a.trader_login || a.account_id).slice(-3)}` }))].map(f => {
                const on = acct === f.id
                return (
                  <button key={f.id} type="button" onClick={() => setAcct(f.id)}
                    style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: 9, fontWeight: W_CELL, color: on ? '#fff' : P_TX, background: on ? P_ACC : 'transparent', border: `1px solid ${on ? P_ACC : P_EDG}`, borderRadius: 999, padding: '3px 9px', minHeight: 44 }}>
                    {f.label}
                  </button>
                )
              })}
            </div>
            {windows.map(w => <MobileWindowCard key={w.key} w={w} />)}
          </>
        )}

        {(screen === 'markets' || screen === 'trades') && (
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 9, fontWeight: W_HEAD, textTransform: 'uppercase', color: P_MU }}>Acct</span>
            {[{ id: 'all', label: 'All' }, ...accounts.map(a => ({ id: a.account_id, label: `${a.is_live ? 'Live' : 'Demo'} ·${String(a.trader_login || a.account_id).slice(-3)}` }))].map(f => {
              const on = acct === f.id
              return (
                <button key={f.id} type="button" onClick={() => setAcct(f.id)}
                  style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: 9, fontWeight: W_CELL, color: on ? '#fff' : P_TX, background: on ? P_ACC : 'transparent', border: `1px solid ${on ? P_ACC : P_EDG}`, borderRadius: 999, padding: '3px 9px', minHeight: 44 }}>
                  {f.label}
                </button>
              )
            })}
          </div>
        )}

        {screen === 'markets' && (
          <>
            {/* Crypto — exact mobile panel (price/Δ not streamed → —). */}
            <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 14, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: P_ACC, flexShrink: 0 }}>Crypto — runs 24/7</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  {crypto.k.map(k2 => (
                    <span key={k2.k} style={{ fontSize: 9, fontWeight: W_CELL, padding: '2px 7px', borderRadius: 999, border: `1px solid ${P_GBD}`, background: P_ACS }}>
                      <span style={{ color: P_MU }}>{k2.k} </span><span style={{ fontVariantNumeric: 'tabular-nums', color: k2.col }}>{k2.v}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div className="t-gridhead" style={{ display: 'grid', gridTemplateColumns: '64px 78px 56px 66px 1fr', gap: 6, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 1 }}>
                <span>Symbol</span><span>Price</span><span>Δ now</span><span>7D P&amp;L</span><span style={{ textAlign: 'right' }}>Tr · Win · PF</span>
              </div>
              {crypto.rows.map(c2 => (
                <div key={c2.sym} style={{ display: 'grid', gridTemplateColumns: '64px 78px 56px 66px 1fr', gap: 6, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '1px 0', fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ fontSize: 9, fontWeight: W_ROWLABEL }}>{c2.sym}</span>
                  <span style={{ fontSize: 9, fontWeight: W_CELL, color: P_MU }}>—</span>
                  <span style={{ fontSize: 9, fontWeight: W_CELL, textAlign: 'center', padding: '1px 0', borderRadius: 5, color: P_MU }}>—</span>
                  <span style={{ fontSize: 9, fontWeight: W_CELL, color: c2.col }}>{c2.pnl}</span>
                  <span style={{ fontSize: 9, color: P_MU, textAlign: 'right' }}>{c2.meta}</span>
                </div>
              ))}
            </div>
            {/* Forex bands — exact mobile panel. */}
            <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 14, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: P_ACC, flexShrink: 0 }}>Forex — banded, all pairs</span>
              {fxBands.map(b => (
                <div key={b.band} style={{ borderTop: `1px solid ${P_EDG}`, paddingTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontSize: 9, fontWeight: W_ROWLABEL }}>{b.band}</span>
                    <span style={{ fontSize: 9, color: P_MU }}>{b.meta}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: W_CELL, fontVariantNumeric: 'tabular-nums', color: b.col }}>{b.net}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {b.pairs.map(p2 => (
                      <span key={p2.sym} title={p2.tip} style={{ fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 5, border: `1px solid ${P_EDG}`, fontVariantNumeric: 'tabular-nums' }}>
                        {p2.sym} <span style={{ fontWeight: W_CELL, color: p2.col }}>{p2.v}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {screen === 'trades' && (
          <>
            {[{ title: 'Winners — best closed', tcol: P_UP, rows: winLag.win },
              { title: 'Laggards — worst closed', tcol: P_DN, rows: winLag.lag }].map(panel => (
              <div key={panel.title} style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 14, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ fontSize: 9, fontWeight: W_CELL, color: panel.tcol }}>{panel.title}</span>
                {panel.rows.length === 0 && <span style={{ fontSize: 9, color: P_MU }}>No closed trades in the last 30 days.</span>}
                {panel.rows.map((t2, ti) => (
                  <div key={ti} style={{ borderTop: `1px solid ${P_EDG}`, paddingTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span style={{ fontSize: 9, fontWeight: W_ROWLABEL }}>{t2.sym}</span>
                      <span style={{ fontSize: 9, color: P_SB }}>{t2.sd}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: W_CELL, fontVariantNumeric: 'tabular-nums', color: t2.col }}>{t2.pnl}</span>
                    </div>
                    <span style={{ fontSize: 9, color: P_SB, fontVariantNumeric: 'tabular-nums' }}>{t2.when}</span>
                    <span style={{ fontSize: 9, color: P_MU }}>{t2.why} · {t2.strat}</span>
                    <span style={{ fontSize: 9, color: P_ACC, fontVariantNumeric: 'tabular-nums' }}>{t2.ind}</span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}

        {screen === 'accounts' && (
          <>
            {/* Gradients — exact mobile panels (52px label col, 7px headers). */}
            <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 14, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: P_ACC, flexShrink: 0 }}>Gradient — timeframe × account</span>
              <div className="t-gridhead" style={{ display: 'grid', gridTemplateColumns: `52px repeat(${gradients.cols.length},1fr)`, gap: 3, color: P_MU }}>
                <span>Window</span>
                {gradients.cols.map(c2 => <span key={c2.name} style={{ textAlign: 'center' }}>{c2.name}</span>)}
              </div>
              {gradients.t.map(r => (
                <div key={r.label} style={{ display: 'grid', gridTemplateColumns: `52px repeat(${gradients.cols.length},1fr)`, gap: 3, alignItems: 'center' }}>
                  <span style={{ fontSize: 9, fontWeight: W_ROWLABEL }}>{r.label}</span>
                  {r.cells.map((c2, ci) => <span key={ci} style={{ fontSize: 9, fontWeight: W_CELL, textAlign: 'center', padding: '2px 0', borderRadius: 4, background: c2.bg, color: c2.col, fontVariantNumeric: 'tabular-nums' }}>{c2.v}</span>)}
                </div>
              ))}
              <span style={{ fontSize: 9, color: P_MU }}>blue = net gain · red = net loss · shaded per column</span>
            </div>
            <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 14, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: P_ACC, flexShrink: 0 }}>Gradient — asset × account · 30D</span>
              {gradients.a.map(r => (
                <div key={r.label} style={{ display: 'grid', gridTemplateColumns: `52px repeat(${gradients.cols.length},1fr)`, gap: 3, alignItems: 'center' }}>
                  <span style={{ fontSize: 9, fontWeight: W_ROWLABEL }}>{r.label}</span>
                  {r.cells.map((c2, ci) => <span key={ci} style={{ fontSize: 9, fontWeight: W_CELL, textAlign: 'center', padding: '3px 0', borderRadius: 4, background: c2.bg, color: c2.col, fontVariantNumeric: 'tabular-nums' }}>{c2.v}</span>)}
                </div>
              ))}
            </div>
            {/* Regime + balance + data feed — the desktop exact-port
                components render responsively here (the mobile prototype's
                variants share their data model; the desktop components carry
                the same honest-— rules). */}
            <RegimeMatrix
              trades30={shapedTrades.filter(t2 => t2.t >= loadedAt - 30 * D).map(t2 => ({ sym: t2.sym, cat: catOf(t2.sym), pnl: t2.pnl }))}
              positions={positions}
              accounts={accounts}
            />
            <BalanceInOut />
            <DataFeed
              balance={riskFull?.account?.balance ?? null}
              freeMargin={riskFull?.margin?.freeMargin ?? null}
              equity={riskFull?.margin?.equity ?? null}
              openCount={positions.length}
              dailyLossPct={riskFull?.risk?.effective?.dailyLossPct ?? null}
              equityStopArmed={riskFull?.risk?.effective?.equityStopPct != null}
              slSet={positions.filter(p2 => p2.current_sl != null).length}
              tpSet={positions.filter(p2 => p2.current_tp != null).length}
              clock={`last refresh ${new Date(loadedAt).toUTCString().slice(17, 25)} UTC`}
            />
            <Card>
              <h3 className="t-h3 mb-1.5">All-time tiles &amp; equity</h3>
              {!tiles && <p className={`text-[9px] mb-2 ${SUB}`}>No closed trades yet.</p>}
              {tilesRow}
              <div className="overflow-x-auto"><ReportChart allTrades={allTrades} events={events} /></div>
            </Card>
          </>
        )}
      </div>

      {/* ================= DESKTOP (lg+): the dense ledger ================== */}
      <div className="hidden min-[700px]:block space-y-2">
        {/* Accounts detail row — exact prototype cards: day P&L, balance +
            equity + live floating, TP/SL nett today, 30D forecast pace, and
            the loss-cap line (real dailyLossPct config × stamped balance). */}
        {acctCards.length > 0 && (
          <div id="sec-accounts">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: P_ACC, flexShrink: 0 }}>Accounts — capital safety</span>
            <SectionTools id="accounts" title="Accounts — capital safety"
              data={acctCards.map(a => ({ account: a.name, ccy: a.ccy, balance: a.bal, dayPnl: a.hasToday ? a.day : null, tpNettToday: a.hasToday ? a.gw : null, slNettToday: a.hasToday ? -a.gl : null, pace30d: a.n30 != null ? a.n30 / 30 : null, lossCapUsedPct: a.used, dailyStop: a.cap }))}
              toText={() => ['Accounts — capital safety', ...acctCards.map(a => `${a.name} · ${a.ccy} · bal ${a.bal != null ? money(a.bal) : '—'} · day ${a.hasToday ? signed(a.day) : '—'} · loss-cap used ${a.used != null ? `${a.used}%` : '—'} of −${a.cap != null ? money(a.cap, 0) : '—'}`)].join('\n')}
              render={() => <AcctCardsGrid acctCards={acctCards} />} />
          </div>
          <AcctCardsGrid acctCards={acctCards} />
          </div>
        )}

        {/* Today + Open now — exact prototype row. */}
        <div id="sec-today-open" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'stretch' }}>
          {/* Owner (2026-07-25): "how am I going to read today card" — the
              earlier squeeze to 280px clipped this card's own 6-column
              hourly table (Close bal truncated, Trades/Closed invisible).
              Reverted to an even flex share with a flex-basis that clears
              the table's 420px min-width, so nothing is ever cut off. */}
          <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 12, padding: '5px 9px', display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 440px', minWidth: 300 }}>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU }}>24 hours · FX day open (5pm NY)</span>
              <SectionTools id="today" title="24 hours · FX day open (5pm NY)" data={{ hourly: todayHourly, closedTrades: todayTrades }}
                toText={() => ['24 hours · FX day open (5pm NY)', `net ${today.n ? signed(today.net) : '—'} · ${today.n} closed${today.n ? ` · ${today.wr}% win · ${today.tp} TP / ${today.sl} SL` : ''}`,
                  ...todayHourly.map(r => `${new Date(r.from).toISOString().slice(11, 16)} · open ${r.openBal != null ? money(r.openBal) : '—'} · P/L ${r.closedN ? signed(r.net) : '—'} · close ${r.closeBal != null ? money(r.closeBal) : '—'} · ${r.openedN || 0} opened / ${r.closedN || 0} closed`),
                  '', `Closed trades (${todayTrades.length})`,
                  ...todayTrades.map(t2 => `${t2.hm} UTC · ${t2.sym} ${t2.side} ${t2.lots} · ${signed(t2.pnl)} · ${t2.detail}`)].join('\n')}
                render={() => <><TodayHourlyBody rows={todayHourly} floatingNow={liveFloating} /><TodayTradesBody rows={todayTrades} /></>} />
            </span>
            <span style={{ fontSize: 9, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: today.n ? (today.net >= 0 ? P_UP : P_DN) : P_MU }}>
              {today.n ? <NumberFlow value={today.net} format={{ signDisplay: 'exceptZero', minimumFractionDigits: 2, maximumFractionDigits: 2 }} /> : '—'}
            </span>
            <span style={{ fontSize: 9, color: P_MU }}>{today.n ? `${today.n} closed · ${today.wr}% win · ${today.tp} TP / ${today.sl} SL` : 'no closed trades yet today'}</span>
            {todayWin.label && <span style={{ fontSize: 9, color: P_WRN }}>{todayWin.label}</span>}
            {/* Owner (2026-07-25): "Today table must be longer in length" —
                8 rows per page (3 pages over a full day) instead of 4. */}
            <PagedRows rows={todayHourly} pageSize={8} maxHeight={300}
              initialIndex={0}>
              {(pageRows) => <TodayHourlyBody rows={pageRows} floatingNow={liveFloating} />}</PagedRows>
            {/* Owner (2026-07-25): "itemised today's closed trades list back"
                — alongside the hourly aggregate, not replacing it. */}
            <span style={{ fontSize: 9, fontWeight: W_HEAD, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU, borderTop: `1px solid ${P_EDG}`, paddingTop: 2 }}>
              Closed trades ({todayTrades.length}) · tap a row
            </span>
            <PagedRows rows={todayTrades} pageSize={8} maxHeight={300}>{(pageRows) => <TodayTradesBody rows={pageRows} />}</PagedRows>
          </div>
          {(() => {
            const defs = [{
              key: 'float', title: 'Open now — floating', rows: openSplit.floating, tot: openSplit.floatTot,
              border: P_GBD, titleCol: P_MU,
              note: null,
            }, {
              key: 'closed', title: 'Open trade but market closed', rows: openSplit.closed, tot: openSplit.closedTot,
              border: 'var(--color-warning-border)', titleCol: P_WRN,
              note: 'market closed — the bot cannot exit these until their market reopens; P&L is the latest computed value before/at close',
            }]
            const card = (t2, extraStyle = {}) => (
              <div key={t2.key} style={{ background: P_GL, border: `1px solid ${t2.border}`, borderRadius: 12, padding: '7px 11px', display: 'flex', flexDirection: 'column', gap: 3, flex: '2 1 320px', minWidth: 320, ...extraStyle }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: t2.titleCol }}>{t2.title}</span>
                  <span style={{ fontSize: 9, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: t2.tot == null ? P_MU : t2.tot >= 0 ? P_UP : P_DN }}>
                    {t2.rows.length
                      ? <>{t2.rows.length} open · {t2.tot != null ? <NumberFlow value={t2.tot} format={{ signDisplay: 'exceptZero', minimumFractionDigits: 2, maximumFractionDigits: 2 }} /> : 'P&L —'}</>
                      : 'none'}
                  </span>
                  {positions[0]?.live_pnl_at && <span style={{ fontSize: 9, color: P_MU }}>as of {String(positions[0].live_pnl_at).slice(11, 19)} UTC</span>}
                </div>
                {t2.note && <span style={{ fontSize: 9, color: P_WRN }}>{t2.note}</span>}
                <SectionTools id={`open-${t2.key}`} title={t2.title} data={t2.rows.map(p2 => ({ sym: p2.sym, side: p2.side, lots: p2.lots, latestPnl: p2.pnl, price: p2.price, dayOhlcv: p2.day, market: p2.marketOpen === false ? 'CLOSED' : p2.marketOpen ? 'OPEN' : 'unknown', slAway: p2.sld, tpAway: p2.tpd }))}
                  toText={() => [t2.title, ...t2.rows.map(p2 => `${p2.sym} · ${p2.side} ${p2.lots} · P&L ${p2.pnl != null ? signed(p2.pnl) : '—'} · px ${fmtPx(p2.price)} · O ${fmtPx(p2.day?.o)} H ${fmtPx(p2.day?.h)} L ${fmtPx(p2.day?.l)} C ${fmtPx(p2.day?.c)} · vol ${fmtVol(p2.day?.v)} · mkt ${p2.marketOpen === false ? 'CLOSED' : p2.marketOpen ? 'OPEN' : '?'} · SL ${p2.sld} / TP ${p2.tpd}`)].join('\n')}
                  render={() => <OpenTableBody rows={t2.rows} />} />
                {t2.rows.length > 0 && (
                  <PagedRows rows={t2.rows} pageSize={14} maxHeight={332}>{(pageRows) => <OpenTableBody rows={pageRows} />}</PagedRows>
                )}
              </div>
            )
            // Owner (2026-07-25): "If Open now has nothing, collapse and
            // tuck away above the open-but-market-closed like a filing
            // cabinet card effect" — an empty floating card no longer
            // claims a full panel; it shrinks to a slim tab peeking above
            // the closed-market card (expandable via native <details>).
            if (openSplit.floating.length === 0) {
              return (
                <div style={{ flex: '2 1 320px', minWidth: 320, display: 'flex', flexDirection: 'column' }}>
                  {/* The tab is inset and sits FLUSH on the card below (no
                      gap, shared edge, square bottom corners on the tab and
                      square TOP corners on the card) — that shared seam is
                      what reads as a file tucked behind a folder. */}
                  <details style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderBottom: 'none', borderRadius: '10px 10px 0 0', padding: '2px 10px 3px', margin: '0 14px -1px', opacity: .8 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 9, fontWeight: W_HEAD, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU, listStyle: 'revert' }}>
                      Open now — floating · none
                    </summary>
                    <span style={{ fontSize: 9, color: P_MU }}>no floating positions in an open market right now — this card expands automatically when one opens</span>
                  </details>
                  {openSplit.closed.length > 0
                    ? card(defs[1], { flex: '1 1 auto', borderRadius: '0 12px 12px 12px' })
                    : <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: '0 12px 12px 12px', padding: '7px 11px', fontSize: 9, color: P_MU }}>no open positions at all</div>}
                </div>
              )
            }
            return defs.filter(t2 => t2.key === 'float' || t2.rows.length > 0).map(t2 => card(t2))
          })()}
        </div>

        {/* Weekend-only: 24h-trading symbols in their own collapsible table
            (owner: "weekend has a separate table (with triangle collapse/
            expand) for 24 hours trading symbols"). Native <details> gives
            the triangle marker. Only rendered during the FX weekend. */}
        {openSplit.weekend24.length > 0 && (
          <details id="sec-weekend24" open style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 12, padding: '7px 11px' }}>
            <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 8, listStyle: 'revert' }}>
              <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_ACC }}>24H symbols — weekend trading</span>
              <span style={{ fontSize: 9, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: openSplit.weekendTot == null ? P_MU : openSplit.weekendTot >= 0 ? P_UP : P_DN }}>
                {openSplit.weekend24.length} open · {openSplit.weekendTot != null ? signed(openSplit.weekendTot) : 'P&L —'}
              </span>
              <span style={{ fontSize: 9, color: P_MU }}>these markets trade through the weekend — the bot can still exit them</span>
            </summary>
            <div style={{ marginTop: 5 }}>
              <SectionTools id="open-weekend24" title="24H symbols — weekend trading"
                data={openSplit.weekend24.map(p2 => ({ sym: p2.sym, side: p2.side, lots: p2.lots, latestPnl: p2.pnl, price: p2.price, dayOhlcv: p2.day, slAway: p2.sld, tpAway: p2.tpd }))}
                toText={() => ['24H symbols — weekend trading', ...openSplit.weekend24.map(p2 => `${p2.sym} · ${p2.side} ${p2.lots} · P&L ${p2.pnl != null ? signed(p2.pnl) : '—'} · px ${fmtPx(p2.price)} · SL ${p2.sld} / TP ${p2.tpd}`)].join('\n')}
                render={() => <Weekend24Body rows={openSplit.weekend24} />} />
              <Weekend24Body rows={openSplit.weekend24} />
            </div>
          </details>
        )}

        {/* Today by market session — owner's stats spec (Trades #, +$, −$,
            highest, lowest, average, sum, median) across SYD / SG / HK /
            JPN / EUR / NY exchange windows. Windows overlap, so session
            rows exceed the ALL row by design; OFF catches everything else. */}
        <Card id="sec-sessions">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="t-h3">Today by market session</h3>
            <span style={{ fontSize: 9, color: P_MU }}>closed trades since FX day open (5pm NY) · bucketed by close time · fixed UTC windows (current DST) · sessions overlap{todayWin.weekend ? ' · ' : ''}{todayWin.weekend && <span style={{ color: P_WRN }}>{todayWin.label}</span>}</span>
            <SectionTools id="sessions" title="Today by market session" window="today"
              data={[...sessionStats.buckets, { key: 'OFF', ...sessionStats.off }, { key: 'ALL', ...sessionStats.total }]}
              toText={() => ['Today by market session',
                ...[...sessionStats.buckets, { key: 'OFF', ...sessionStats.off }, { key: 'ALL', ...sessionStats.total }]
                  .map(s => s.n
                    ? `${s.key} · ${s.n} trades · +${(s.pos ?? 0).toFixed(2)} / ${(s.neg ?? 0).toFixed(2)} · high ${s.high.toFixed(2)} · low ${s.low.toFixed(2)} · avg ${s.avg.toFixed(2)} · sum ${s.sum.toFixed(2)} · median ${s.median.toFixed(2)}`
                    : `${s.key} · no closed trades`)].join('\n')}
              render={() => <SessionStatsBody stats={sessionStats} />} />
          </div>
          <div className="mt-2"><SessionStatsBody stats={sessionStats} /></div>
        </Card>

        {/* Account filter chips — exact prototype two-line buttons. */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: P_MU }}>Account</span>
          {[{ id: 'all', label: 'All Accounts', sub: 'combined ledger' },
            ...acctCards.map(a => ({ id: a.id, label: a.name, sub: `${a.bal != null ? money(a.bal, 0) : '—'} · fc ${a.n30 != null ? `${signed(a.n30 / 30, 0)}/day` : '—'}` }))].map(f => {
            const on = acct === f.id
            return (
              <button key={f.id} type="button" onClick={() => setAcct(f.id)} aria-pressed={on}
                style={{ cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', fontSize: 9, fontWeight: W_CELL, color: on ? '#fff' : P_TX, background: on ? P_ACC : P_GL, border: `1px solid ${on ? P_ACC : P_GBD}`, borderRadius: 12, padding: '4px 12px', display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
                <span>{f.label}</span>
                <span style={{ fontSize: 9, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: on ? 'rgba(255,255,255,.75)' : P_MU }}>{f.sub}</span>
              </button>
            )
          })}
          <span style={{ fontSize: 9, color: P_MU }}>filters every table below · fc = 30D forecast pace</span>
        </div>

        {/* The core: timeframe ledger. Three-lens model — time rows here,
            market columns across, per-window detail on expand; totals
            reconcile, nothing is double-counted. */}
        <Card id="sec-ledger">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="t-h3">Timeframe ledger</h3>
            <span className={`text-[9px] ${SUB}`}>
              carry in → net → carry out · day rolls at FX open (5pm NY) here · server ledger windows still anchor 22:00 UTC{ledger ? ` · balance ${money(ledger.balance)}` : ''}
            </span>
            <SectionTools id="ledger" title="Timeframe ledger" data={windows} toText={ledgerToText}
              render={({ variant }) => <LedgerBody variant={variant} windows={windows} ledger={ledger} error={error} nowMs={loadedAt} />} />
          </div>
          <LedgerBody variant="card" windows={windows} ledger={ledger} error={error} nowMs={loadedAt} />
        </Card>

        {/* Performance gradients — exact prototype panels (timeframe ×
            account, asset class × account heat tables; column count follows
            the real registry). */}
        {/* Owner (2026-07-25, latest): "two cards 50% each side" and "both
            Performance gradient cards must be symmetric in height" — an even
            split with stretch alignment, so the shorter card matches the
            taller one instead of leaving a ragged bottom edge. The wide left
            table scrolls inside its own panel (minmax(0,…) + overflowX), which
            is what keeps it from stealing the right card's track. */}
        <div id="sec-gradients" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8, alignItems: 'stretch' }}>
          <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2, height: '100%', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: P_ACC, flexShrink: 0 }}>Performance gradient — timeframe × account</span>
              <span style={{ fontSize: 9, color: P_SB }}>always shows all accounts + overall · intensity scaled per column</span>
              <SectionTools id="grad-timeframe" title="Performance gradient — timeframe × account"
                data={gradients.tWide.map(r => ({ window: r.label, ...Object.fromEntries(r.cells.map((c, ci) => [gradients.wideCols[ci]?.name || ci, c.v])) }))}
                render={() => <GradientBody grid="86px" label="Window" cols={gradients.wideCols} groups={gradients.groups} rows={gradients.tWide} subtotals={gradients.tWideSub} banded smallHead colW="minmax(46px,72px)" foot="blue = net gain · red = net loss · each column shaded against its own peak window · windows overlap, so a column subtotal double-counts and is a footing, not a P&L" />} />
            </div>
            <GradientBody grid="86px" label="Window" cols={gradients.wideCols} groups={gradients.groups} rows={gradients.tWide} subtotals={gradients.tWideSub} banded smallHead colW="minmax(46px,72px)" foot="blue = net gain · red = net loss · each column shaded against its own peak window · windows overlap, so a column subtotal double-counts and is a footing, not a P&L" />
          </div>
          <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2, height: '100%', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: P_ACC, flexShrink: 0 }}>Performance gradient — asset class × account</span>
              <span style={{ fontSize: 9, color: P_SB }}>rolling 30 days</span>
              <SectionTools id="grad-asset" title="Performance gradient — asset class × account" window="30D"
                data={gradients.a.map(r => ({ asset: r.label, ...Object.fromEntries(r.cells.map((c, ci) => [gradients.assetCols[ci]?.name || ci, c.v])) }))}
                render={() => <GradientBody grid="74px" label="Asset" cols={gradients.assetCols} rows={gradients.a} subtotals={gradients.aSub} foot={gradients.overallDropped
                  ? 'same closed-trade ledger, account dimension — Overall is hidden while only one account has closed trades, since it would just repeat that column'
                  : 'same closed-trade ledger, account dimension — totals reconcile with the Overall column'} />} />
            </div>
            <GradientBody grid="74px" label="Asset" cols={gradients.assetCols} rows={gradients.a} subtotals={gradients.aSub} foot={gradients.overallDropped
                  ? 'same closed-trade ledger, account dimension — Overall is hidden while only one account has closed trades, since it would just repeat that column'
                  : 'same closed-trade ledger, account dimension — totals reconcile with the Overall column'} />
          </div>
        </div>

        {/* FX banded panel + Strategy × market — exact prototype grid (the
            right column also hosts the crypto panel in a later slice). */}
        {/* Owner (2026-07-25): "Forex-day card is so small, have a width
            wide" — the FX card now takes the WHOLE row (its band rows carry
            every pair, so width is what makes it readable) and the strategy
            matrix + crypto panels sit side by side beneath it. */}
        <div id="sec-fx-bands" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ minWidth: 0, background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: P_ACC, flexShrink: 0 }}>Forex — banded, all pairs</span>
              <span style={{ fontSize: 9, color: P_SB }}>same trades as the ledger's Forex column, pair-level lens · rolling 7 days = the 1W row · tap a pair for TP/SL detail</span>
              <SectionTools id="fx-bands" title="Forex — banded, all pairs" window="1W" data={fxBands}
                toText={(rows) => ['Forex — banded, all pairs (1W)', ...(rows || []).map(b => `${b.band} · ${b.net} · ${b.meta} · ${b.pairs.filter(p2 => p2.v !== '·').map(p2 => `${p2.sym} ${p2.v}`).join(' · ') || 'no trades'}`)].join('\n')}
                render={() => <FxBandsBody fxBands={fxBands} />} />
            </div>
            <FxBandsBody fxBands={fxBands} />
          </div>
          <div className="perf-2col-even">
            <div id="sec-strategy-matrix" style={{ minWidth: 0, overflowX: 'auto', background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: P_ACC, flexShrink: 0 }}>Strategy × market — 30D</span>
                <span style={{ fontSize: 9, color: P_SB }}>the ledger's 30D row re-sliced by strategy — each market column here sums to the 30D market cell above</span>
                <SectionTools id="strategy-matrix" title="Strategy × market — 30D" window="30D" data={stratMx}
                  toText={(rows) => ['Strategy × market — 30D', ...(rows || []).map(s => `${s.name} · net ${s.net} · edge ${s.edge} · ${s.cells.map((c, ci) => `${MARKET_COLS[ci].label} ${c.v}`).join(' · ')}`)].join('\n')}
                  render={() => <StratMxBody stratMx={stratMx} />} />
              </div>
              <StratMxBody stratMx={stratMx} />
            </div>
            {/* Crypto 24/7 — exact prototype panel; live price/Δ not
                streamed to this page → honest —. */}
            <div id="sec-crypto" style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: P_ACC, flexShrink: 0 }}>Crypto — runs 24/7</span>
                <span style={{ fontSize: 9, color: P_SB }}>tracked separately · never session-gated · = the ledger's Crypto column</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
                  {crypto.k.map(k2 => (
                    <span key={k2.k} style={{ fontSize: 9, fontWeight: W_CELL, padding: '2px 8px', borderRadius: 999, border: `1px solid ${P_GBD}`, background: P_ACS }}>
                      <span style={{ color: P_MU }}>{k2.k} </span><span style={{ fontVariantNumeric: 'tabular-nums', color: k2.col }}>{k2.v}</span>
                    </span>
                  ))}
                </div>
                <SectionTools id="crypto" title="Crypto — runs 24/7" window="7D" data={crypto.rows}
                  toText={(rows) => ['Crypto — runs 24/7', ...crypto.k.map(k2 => `${k2.k} ${k2.v}`), ...(rows || []).map(c2 => `${c2.sym} · 7D ${c2.pnl} · ${c2.meta}`)].join('\n')}
                  render={() => <CryptoBody crypto={crypto} />} />
              </div>
              <CryptoBody crypto={crypto} />
            </div>
          </div>
        </div>

        {/* Winners & Laggards explained — exact prototype pair, real
            best/worst 30D closed trades with the collect-forward forensics
            line (out-side context not recorded yet → —). */}
        <div id="sec-winlag" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'start' }}>
          {[{ title: 'Winners explained — best closed trades, 30D', tcol: P_UP, sub: 'full anatomy: time in → out, side, lots, plan, volume context at open/close', rows: winLag.win },
            { title: 'Laggards explained — worst closed trades, 30D', tcol: P_DN, sub: 'same anatomy — what went wrong and under what volume conditions', rows: winLag.lag }].map(panel => (
            <div key={panel.title} style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 9, fontWeight: W_CELL, color: panel.tcol }}>{panel.title}</span>
                <span style={{ fontSize: 9, color: P_MU }}>{panel.sub}</span>
                <SectionTools id={panel.title.startsWith('Winners') ? 'winners' : 'laggards'} title={panel.title} window="30D" data={panel.rows}
                  toText={(rows) => [panel.title, ...(rows || []).map(t2 => `${t2.when} · ${t2.sym} · ${t2.sd} · ${t2.why} · ${t2.strat} · ${t2.pnl}`)].join('\n')}
                  render={() => <WlBody rows={panel.rows} />} />
              </div>
              <WlBody rows={panel.rows} />
            </div>
          ))}
        </div>

        {/* Macro regime matrix + quadrant cards, Balance in/out, Data feed —
            the final Page-1 sections (exact ports, see PerfMacroSections). */}
        <div id="sec-regime">
          <RegimeMatrix
            trades30={shapedTrades.filter(t2 => t2.t >= loadedAt - 30 * D).map(t2 => ({ sym: t2.sym, cat: catOf(t2.sym), pnl: t2.pnl }))}
            positions={positions}
            accounts={accounts}
          />
        </div>
        <div id="sec-balance"><BalanceInOut /></div>
        <div id="sec-datafeed">
          <DataFeed
            balance={riskFull?.account?.balance ?? null}
            freeMargin={riskFull?.margin?.freeMargin ?? null}
            equity={riskFull?.margin?.equity ?? null}
            openCount={positions.length}
            dailyLossPct={riskFull?.risk?.effective?.dailyLossPct ?? null}
            equityStopArmed={riskFull?.risk?.effective?.equityStopPct != null}
            slSet={positions.filter(p2 => p2.current_sl != null).length}
            tpSet={positions.filter(p2 => p2.current_tp != null).length}
            clock={`last refresh ${new Date(loadedAt).toUTCString().slice(17, 25)} UTC`}
          />
        </div>

        {/* Migrated from Desk: the original stat tiles + decisions/equity
            chart (owner: "move the performance in the desk to a page by its
            own"). */}
        <Card id="sec-tiles">
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <h3 className="t-h3">All-time tiles &amp; equity</h3>
            {tiles && <span className={`text-[9px] ${SUB}`}>{tiles.closed.length} closed · {signed(tiles.total)}</span>}
            <SectionTools id="tiles" title="All-time tiles &amp; equity"
              data={tileGroups ? tileGroups.flatMap(([group, items]) => items.map(([metric, value, , note]) => ({ group, metric, value, measures: note }))) : []}
              toText={() => (tileGroups
                ? ['All-time', ...tileGroups.flatMap(([group, items]) => [group.toUpperCase(), ...items.map(([metric, value, , note]) => `  ${metric} ${value} — ${note}`)])].join('\n')
                : 'All-time — no closed trades yet')}
              render={() => (
                <div>
                  {tilesRow}
                  <ReportChart allTrades={allTrades} events={events} />
                </div>
              )} />
          </div>
          {!tiles && <p className={`text-[9px] mb-2 ${SUB}`}>No closed trades yet — tiles and chart fill from the first completed round-trip.</p>}
          {tilesRow}
          {/* Owner (2026-07-25): end-of-day / end-of-week debrief — who opened
              it, why it won or lost, what was written down. */}
          <div className="mb-2">
            <SessionReview allTrades={allTrades} postmortems={postmortems} nowMs={loadedAt} />
          </div>
          <ReportChart allTrades={allTrades} events={events} />
        </Card>
      </div>
    </div>
  )
}
