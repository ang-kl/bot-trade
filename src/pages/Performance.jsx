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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { agentGet, agentConfigured } from '../lib/agent-api.js'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import ReportChart from '../components/ReportChart.jsx'
import { RegimeMatrix, BalanceInOut, DataFeed } from '../components/PerfMacroSections.jsx'
import SectionTools from '../components/common/SectionTools.jsx'

const REFRESH_MS = 60_000
const H = 3600_000
const D = 24 * H

// Same W3C international formatting convention as Risk: everything
// DISPLAYED goes through Intl.NumberFormat in the viewer's own locale.
const nf = (d = 2) => new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
const money = (v, d = 2) => (v == null || Number.isNaN(Number(v)) ? '—' : nf(d).format(Number(v)))
const signed = (v, d = 2) => (v == null || Number.isNaN(Number(v)) ? '—' : `${v > 0 ? '+' : ''}${nf(d).format(Number(v))}`)

const UP = 'text-[var(--color-up)]'
const DOWN = 'text-[var(--color-down)]'
const SUB = 'text-[var(--color-text-sub)]'
const pnlTone = (v) => (v == null ? SUB : v >= 0 ? UP : DOWN)

// The six design market columns, in display order (stocks ride Indices).
const MARKET_COLS = [
  { key: 'crypto', label: 'Crypto' },
  { key: 'fx', label: 'Forex' },
  { key: 'index', label: 'Indices' },
  { key: 'metal', label: 'Metals' },
  { key: 'energy', label: 'Energy' },
  { key: 'grain', label: 'Grains' },
]

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

// Most recent 22:00 UTC — the trading-day anchor, same maths as the agent.
const dayAnchorMs = (nowMs) => {
  const d = new Date(nowMs)
  const today22 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 22)
  return nowMs >= today22 ? today22 : today22 - D
}
const closedMs = (row) => {
  const raw = String(row.closed_at || '').replace(' ', 'T')
  if (!raw) return null
  const t = Date.parse(raw.endsWith('Z') || raw.includes('+') ? raw : raw + 'Z')
  return Number.isFinite(t) ? t : null
}

// Symbol → market category, mirroring agent/services/perf-ledger.js so the
// client-side lenses reconcile with the server ledger.
const catOf = (symRaw) => {
  const sym = String(symRaw || '').toUpperCase()
  if (/^(BTC|ETH|SOL|XRP|ADA|DOGE|LTC|BNB|DOT|LINK|AVAX|TRX)[A-Z]{3,4}$/.test(sym)) return 'crypto'
  if (/^X(AU|AG|PT|PD)[A-Z]{3}$|^COPPER/.test(sym)) return 'metal'
  if (/^(NATGAS|SPOTCRUDE|BRENT|UKOIL|USOIL|OIL|WTI)/.test(sym)) return 'energy'
  if (/^(WHEAT|CORN|SOYBEAN|SUGAR|COFFEE|COCOA|COTTON|OATS|RICE)/.test(sym)) return 'grain'
  if (/^(US30|US500|NAS100|USTEC|US2000|GER40|UK100|FRA40|JPN225|AUS200|EUSTX|VIX|DOW|HK50|CHINA50|SPAIN35|ITALY40|SWISS20|NETH25)/.test(sym) || /\.(US|UK|DE|AU)$/.test(sym)) return 'index'
  if (/^[A-Z]{6}$/.test(sym)) return 'fx'
  return 'other'
}

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
              style={{ fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 999, border: `1px solid ${on ? P_ACC : P_EDG}`, color: on ? P_ACC : P_MU, background: on ? P_ACS : 'transparent' }}>
              {s.name}
            </span>
          )
        })}
      </div>
      <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: P_SB, fontVariantNumeric: 'tabular-nums' }}>
        {p(now.getUTCHours())}:{p(now.getUTCMinutes())}:{p(now.getUTCSeconds())} UTC
      </span>
    </>
  )
}

// One market sub-cell in the ledger grid: net on top, win%·PF subline —
// or a quiet "—" when the window has no trades in that market.
function MarketCell({ st }) {
  if (!st || !st.trades) return <td className={`py-1 px-2 text-right text-[11px] ${SUB}`}>—</td>
  return (
    <td className="py-1 px-2 text-right tabular-nums">
      <div className={`text-[11px] font-bold ${pnlTone(st.net)}`}>{signed(st.net)}</div>
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

// Shared expanded-window detail: TP/SL plan vs actual + per-market lines.
function WindowDetail({ w }) {
  const note = insight(w)
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-[11px]">
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
      {note && <div className={`w-full text-[10px] ${SUB}`}>{note}</div>}
    </div>
  )
}

// --- shared section bodies (card + expanded modal render the SAME
// component — the owner's no-fork rule for the ⤢ expand feature) ----------
function GradientBody({ grid, label, cols, rows, pad, foot }) {
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: `${grid} repeat(${cols.length},1fr)`, gap: 3, fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU, paddingBottom: 2 }}>
        <span>{label}</span>
        {cols.map(c => <span key={c.name} style={{ textAlign: 'center' }}>{c.name}</span>)}
      </div>
      {rows.map(r => (
        <div key={r.label} style={{ display: 'grid', gridTemplateColumns: `${grid} repeat(${cols.length},1fr)`, gap: 3, alignItems: 'center' }}>
          <span style={{ fontSize: 9.5, fontWeight: 700 }}>{r.label}</span>
          {r.cells.map((c, ci) => <span key={ci} style={{ fontSize: 9.5, fontWeight: 700, textAlign: 'center', padding: pad, borderRadius: 6, background: c.bg, color: c.col, fontVariantNumeric: 'tabular-nums' }}>{c.v}</span>)}
        </div>
      ))}
      <span style={{ fontSize: 9.5, color: P_MU }}>{foot}</span>
    </>
  )
}

function FxBandsBody({ fxBands }) {
  return (
    <>
      {fxBands.map(b => (
        <div key={b.band} style={{ display: 'grid', gridTemplateColumns: '118px 84px 1fr', gap: 8, alignItems: 'start', borderTop: `1px solid ${P_EDG}`, paddingTop: 5 }}>
          <span style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 10, fontWeight: 800 }}>{b.band}</span>
            <span style={{ fontSize: 9.5, color: P_MU }}>{b.meta}</span>
          </span>
          <span style={{ fontSize: 11.5, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: b.col }}>{b.net}</span>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {b.pairs.map(p2 => (
              <span key={p2.sym} title={p2.tip} style={{ fontSize: 9.5, fontWeight: 600, padding: '1px 6px', borderRadius: 6, border: `1px solid ${P_EDG}`, fontVariantNumeric: 'tabular-nums' }}>
                {p2.sym} <span style={{ fontWeight: 800, color: p2.col }}>{p2.v}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

function StratMxBody({ stratMx }) {
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '132px repeat(6,1fr) 76px 52px', gap: 6, fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 3 }}>
        <span>Strategy</span>
        {MARKET_COLS.map(m => <span key={m.key}>{m.label}</span>)}
        <span>Net</span><span>Edge</span>
      </div>
      {stratMx.length === 0 && <span style={{ fontSize: 9.5, color: P_MU, padding: '4px 0' }}>No closed trades with a strategy label in the last 30 days.</span>}
      {stratMx.map(s => (
        <div key={s.name} style={{ display: 'grid', gridTemplateColumns: '132px repeat(6,1fr) 76px 52px', gap: 6, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '3px 0', fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'capitalize' }}>{s.name}</span>
          {s.cells.map((c, ci) => <span key={ci} title={c.tip} style={{ fontSize: 9.5, fontWeight: 700, color: c.col }}>{c.v}</span>)}
          <span style={{ fontSize: 10, fontWeight: 800, color: s.col }}>{s.net}</span>
          <span style={{ fontSize: 9.5, fontWeight: 800, color: s.edgeCol }}>{s.edge}</span>
        </div>
      ))}
    </>
  )
}

function CryptoBody({ crypto }) {
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '76px 96px 66px 84px 1fr', gap: 8, fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 2 }}>
        <span>Symbol</span><span>Live price</span><span>Δ now</span><span>7D P&amp;L</span><span style={{ textAlign: 'right' }}>Tr · Win · PF</span>
      </div>
      {crypto.rows.map(c2 => (
        <div key={c2.sym} style={{ display: 'grid', gridTemplateColumns: '76px 96px 66px 84px 1fr', gap: 8, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '2px 0', fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ fontSize: 10, fontWeight: 800 }}>{c2.sym}</span>
          <span style={{ fontSize: 10, fontWeight: 800, color: P_MU }}>—</span>
          <span style={{ fontSize: 9.5, fontWeight: 700, textAlign: 'center', padding: '1px 0', borderRadius: 6, color: P_MU }}>—</span>
          <span style={{ fontSize: 10, fontWeight: 800, color: c2.col }}>{c2.pnl}</span>
          <span style={{ fontSize: 9.5, color: P_MU, textAlign: 'right' }}>{c2.meta}</span>
        </div>
      ))}
    </>
  )
}

function OpenTableBody({ rows }) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '70px 84px 1fr 64px 100px', gap: 6, fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 2 }}>
        <span>Symbol</span><span>Side · lots</span><span>Latest P&amp;L</span><span>Mkt</span><span>SL / TP away</span>
      </div>
      {rows.map(p2 => (
        <div key={p2.id} title={`entry ${p2.entry} · ${p2.strat} · SL/TP distances from entry · market state: ${p2.marketSource || 'unknown'}`}
          style={{ display: 'grid', gridTemplateColumns: '70px 84px 1fr 64px 100px', gap: 6, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '2px 0', fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ fontSize: 11, fontWeight: 800 }}>{p2.sym}</span>
          <span style={{ fontSize: 9.5, fontWeight: 700, color: p2.sideCol }}>{p2.side} {p2.lots}</span>
          <span style={{ fontSize: 11, fontWeight: 800, color: p2.pnl == null ? P_MU : p2.pnl >= 0 ? P_UP : P_DN }}>{p2.pnl != null ? signed(p2.pnl) : '—'}</span>
          <span style={{ fontSize: 9.5, fontWeight: 700, color: p2.marketOpen === false ? P_WRN : p2.marketOpen ? P_ACC : P_MU }}>{p2.marketOpen === false ? 'CLOSED' : p2.marketOpen ? 'OPEN' : '?'}</span>
          <span style={{ fontSize: 9.5, color: P_MU }}>{p2.sld} / {p2.tpd}</span>
        </div>
      ))}
    </div>
  )
}

function WlBody({ rows }) {
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '170px 74px 96px 1fr 76px', gap: 8, fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 2 }}>
        <span>Date · in → out (UTC)</span><span>Symbol</span><span>Side · lots</span><span>Outcome · plan · RVOL / VWAP / OBV</span><span style={{ textAlign: 'right' }}>P&amp;L</span>
      </div>
      {rows.length === 0 && <span style={{ fontSize: 9.5, color: P_MU, padding: '4px 0' }}>No closed trades in the last 30 days.</span>}
      {rows.map((t2, ti) => (
        <div key={ti} style={{ display: 'grid', gridTemplateColumns: '170px 74px 96px 1fr 76px', gap: 8, alignItems: 'center', borderTop: `1px solid ${P_EDG}`, paddingTop: 4, fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ fontSize: 9.5, color: P_SB }}>{t2.when}</span>
          <span style={{ fontSize: 10, fontWeight: 800 }}>{t2.sym}</span>
          <span style={{ fontSize: 9.5, color: P_SB }}>{t2.sd}</span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={{ fontSize: 9.5, color: P_MU }}>{t2.why} · {t2.strat}</span>
            <span style={{ fontSize: 9.5, color: P_ACC, fontVariantNumeric: 'tabular-nums' }}>{t2.ind}</span>
          </span>
          <span style={{ fontSize: 11, fontWeight: 800, textAlign: 'right', color: t2.col }}>{t2.pnl}</span>
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
                  <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU }}>{a.name} · {a.ccy}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: a.hasToday ? (a.day >= 0 ? P_UP : P_DN) : P_MU }}>day {a.hasToday ? signed(a.day) : '—'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 16, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{a.bal != null ? money(a.bal) : '—'}</span>
                  <span style={{ fontSize: 9.5, color: P_SB }}>equity {a.equity != null ? money(a.equity) : '—'}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 9.5, color: P_SB }}>live <span style={{ fontWeight: 800, color: a.live == null ? P_MU : a.live >= 0 ? P_UP : P_DN }}>{a.live != null ? signed(a.live) : '—'}</span> = <span style={{ fontWeight: 800, color: a.live == null ? P_MU : a.live >= 0 ? P_UP : P_DN }}>{a.live != null && a.bal ? `${a.live >= 0 ? '+' : ''}${(a.live / a.bal * 100).toFixed(2)}%` : '—'}</span> of balance</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, borderTop: `1px solid ${P_EDG}`, paddingTop: 4 }}>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: P_MU }}>TP nett today</span><span style={{ fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: P_UP }}>{a.hasToday ? signed(a.gw) : '—'}</span></span>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: P_MU }}>SL nett today</span><span style={{ fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: P_DN }}>{a.hasToday ? signed(-a.gl) : '—'}</span></span>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: P_MU }}>Forecast · 30D pace</span><span style={{ fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: a.n30 == null ? P_MU : a.n30 >= 0 ? P_UP : P_DN }}>{a.n30 != null ? `${signed(a.n30 / 30)}/day` : '—'}</span></span>
                </div>
                <span style={{ fontSize: 9.5, color: P_MU }}>loss-cap used <span style={{ fontWeight: 800, color: a.usedCol }}>{a.used != null ? `${a.used}%` : '—'}</span> of −{a.cap != null ? money(a.cap, 0) : '—'} daily stop</span>
              </div>
            ))}
    </div>
  )
}

// Copy-as-text for the ledger (owner spec: paste-friendly aligned lines).
function ledgerToText(windows) {
  const lines = (windows || []).map(w =>
    `${w.label} · carry ${money(w.carryIn)} → ${money(w.carryOut)} · net ${w.trades ? signed(w.net) : '—'} · ${w.trades} tr · ${w.winPct != null ? `${w.winPct}%` : '—'} · PF ${w.pf ?? '—'} · TP/SL ${(w.tp ?? 0) + (w.part ?? 0)}/${w.sl ?? 0} · edge ${w.edge != null ? `${w.edge >= 0 ? '+' : ''}${w.edge}%` : '—'}`)
  return ['Timeframe ledger', ...lines].join('\n')
}

// The ledger table body — one component for both the card and the expanded
// modal (variant prop, never forked markup). The modal adds the owner's
// "expand all / collapse all" toggle driving every row's detail.
function LedgerBody({ variant, windows, ledger, error }) {
  const [expandAll, setExpandAll] = useState(false)
  const modal = variant === 'modal'
  return (
    <>
      {modal && (
        <button type="button" onClick={() => setExpandAll(e => !e)}
          style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700, color: P_TX, background: P_ACS, border: `1px solid ${P_GBD}`, borderRadius: 8, padding: '3px 9px', alignSelf: 'flex-start', marginBottom: 6 }}>
          {expandAll ? 'Collapse all' : 'Expand all'}
        </button>
      )}
      {!ledger && !error && <p className={`text-[12px] mt-2 ${SUB}`}>Loading ledger…</p>}
      {ledger && (
        <div className="overflow-x-auto mt-1.5">
          <table className="w-full text-left tabular-nums min-w-[980px]">
            <thead>
              <tr className={`border-b border-[var(--color-border)] text-[10px] uppercase tracking-wide ${SUB}`}>
                <th className="py-1 pr-2 font-bold">Window</th>
                <th className="py-1 px-2 font-bold text-right">Carry in</th>
                <th className="py-1 px-2 font-bold text-right">Net</th>
                <th className="py-1 px-2 font-bold text-right">Carry out</th>
                <th className="py-1 px-2 font-bold text-right">Trades · win</th>
                <th className="py-1 px-2 font-bold text-right">TP/SL · edge</th>
                {MARKET_COLS.map(m => <th key={m.key} className="py-1 px-2 font-bold text-right">{m.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {windows.map(w => <LedgerRow key={w.key} w={w} forceOpen={modal ? (expandAll || null) : null} />)}
            </tbody>
          </table>
        </div>
      )}
      <p className={`mt-1.5 text-[10px] ${SUB}`}>
        Rolling windows (1H…12M) end now; Yesterday/3D/WTD/MTD use the 22:00-UTC trading-day anchor. Carry-forward reconstructs balances backwards from the current stamped balance — windows older than the recorded history show the maths honestly rather than guessing. Unknown symbols count in totals but not the six market columns.
      </p>
    </>
  )
}

// One desktop ledger row, expandable into the market breakdown.
// `forceOpen` (boolean) overrides the internal state — the expanded modal's
// "expand all / collapse all" toggle drives it.
function LedgerRow({ w, forceOpen = null }) {
  const [openState, setOpen] = useState(false)
  const open = forceOpen ?? openState
  const empty = !w.trades
  return (
    <>
      <tr onClick={() => setOpen(o => !o)}
        className={`border-b border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-accent-soft)] ${empty ? 'opacity-60' : ''}`}>
        <td className="py-1.5 pr-2 whitespace-nowrap">
          <span aria-hidden="true" className={`inline-block w-3 text-[9px] ${SUB}`}>{open ? '▾' : '▸'}</span>
          <span className="text-[12px] font-extrabold">{w.label}</span>
          <div className={`ml-3 text-[9px] ${SUB}`}>{dRange(w.from, w.to)}</div>
        </td>
        <td className={`py-1.5 px-2 text-right tabular-nums text-[11px] ${SUB}`}>{money(w.carryIn)}</td>
        <td className={`py-1.5 px-2 text-right tabular-nums text-[12px] font-extrabold ${pnlTone(empty ? null : w.net)}`}>{empty ? '—' : signed(w.net)}</td>
        <td className={`py-1.5 px-2 text-right tabular-nums text-[11px] ${SUB}`}>{money(w.carryOut)}</td>
        <td className="py-1.5 px-2 text-right tabular-nums text-[11px]">
          {empty ? <span className={SUB}>—</span> : (
            <>
              <div className="font-semibold">{w.trades}t · {w.winPct != null ? `${nf(0).format(w.winPct)}%` : '—'}</div>
              <div className={`text-[9px] ${SUB}`}>PF {w.pf != null ? nf(2).format(w.pf) : '—'}</div>
            </>
          )}
        </td>
        <td className="py-1.5 px-2 text-right tabular-nums text-[11px]">
          {empty ? <span className={SUB}>—</span> : (
            <>
              <div><span className={UP}>{w.tp} TP</span>{w.part > 0 && <span className={SUB}> +{w.part}p</span>} / <span className={DOWN}>{w.sl} SL</span>{w.manual > 0 && <span className={SUB}> · {w.manual}m</span>}</div>
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
              ? <p className={`text-[11px] ${SUB}`}>No closed trades in this window{w.carryIn == null ? ' — carry appears once a balance is stamped for this scope' : ''}.</p>
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
          <span style={{ fontSize: 11.5, fontWeight: 800 }}>{w.label}</span>
          <span style={{ fontSize: 9.5, color: P_ACC }}>{dRange(w.from, w.to)}</span>
        </span>
        <span style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 9.5, color: P_SB }}>{money(w.carryIn)} → <span style={{ fontWeight: 800, color: P_TX }}>{money(w.carryOut)}</span></span>
          <span style={{ fontSize: 9.5, color: P_MU }}>{empty ? 'no closed trades' : `${w.trades} · ${w.winPct != null ? `${nf(0).format(w.winPct)}%` : '—'} · PF ${w.pf != null ? nf(2).format(w.pf) : '—'} · TP/SL ${w.tp + w.part}/${w.sl} · edge `}<span style={{ fontWeight: 800, color: w.edge == null ? P_MU : w.edge >= 0 ? P_UP : P_DN }}>{empty ? '' : (w.edge != null ? `${signed(w.edge, 1)}%` : '—')}</span></span>
        </span>
        <span style={{ fontSize: 13, fontWeight: 800, textAlign: 'right', color: empty ? P_MU : w.net >= 0 ? P_UP : P_DN }}>{empty ? '—' : signed(w.net)}</span>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${P_EDG}`, background: P_ACS, padding: '6px 11px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {empty
            ? <span style={{ fontSize: 9.5, color: P_SB }}>No closed trades in this window.</span>
            : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4 }}>
                  {MARKET_COLS.map(m => {
                    const st = w.markets?.[m.key]
                    return (
                      <span key={m.key} style={{ display: 'flex', flexDirection: 'column', border: `1px solid ${P_EDG}`, borderRadius: 8, padding: '4px 7px' }}>
                        <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: P_MU }}>{m.label}</span>
                        <span style={{ fontSize: 10, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: st?.trades ? (st.net >= 0 ? P_UP : P_DN) : P_MU }}>{st?.trades ? signed(st.net) : '—'}</span>
                        <span style={{ fontSize: 9.5, color: P_MU }}>{st?.trades ? `PF ${st.pf != null ? nf(1).format(st.pf) : '—'} · ${st.winPct != null ? `${nf(0).format(st.winPct)}%` : '—'}` : ''}</span>
                      </span>
                    )
                  })}
                </div>
                {insight(w) && <span style={{ fontSize: 9.5, lineHeight: 1.4, color: P_SB }}>{insight(w)}</span>}
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

export default function Performance() {
  const [ledger, setLedger] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [selectedAccountId, setSelectedAccountId] = useState(null)
  const [acct, setAcct] = useState('all') // filter: 'all' | account_id
  const [allTrades, setAllTrades] = useState([])
  const [events, setEvents] = useState([])
  const [positions, setPositions] = useState([])
  const [ledgers, setLedgers] = useState({}) // per-account ledgers (balance + windows)
  const [riskFull, setRiskFull] = useState(null)
  const [screen, setScreen] = useState('now') // mobile pill nav
  const [error, setError] = useState('')
  // "Now" for the derived windows below — stamped at each data load so the
  // memos stay pure (react-hooks/purity forbids Date.now() inside useMemo);
  // the 60s refresh keeps it current enough for day-window maths.
  const [loadedAt, setLoadedAt] = useState(() => Date.now())

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — set it up on Connect.'); return }
    try {
      const [led, ac, t, r, p] = await Promise.all([
        agentGet(`/state/perf-ledger${acct === 'all' ? '' : `?account=${encodeURIComponent(acct)}`}`),
        agentGet('/state/accounts').catch(() => null),
        agentGet('/state/trades').catch(() => null),
        agentGet('/state/risk-events?limit=200').catch(() => null),
        agentGet('/state/positions').catch(() => null),
      ])
      setLedger(led)
      setAccounts(ac?.accounts || [])
      setSelectedAccountId(ac?.selectedAccountId || null)
      setAllTrades(t?.rows || t?.trades || [])
      setEvents(r?.rows || [])
      setPositions(p?.rows || p?.positions || [])
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

  useEffect(() => {
    const kick = setTimeout(load, 0)
    const t = setInterval(load, REFRESH_MS)
    return () => { clearTimeout(kick); clearInterval(t) }
  }, [load])

  // Closed trades scoped to the account filter (M1 NULL-tolerant convention:
  // unstamped legacy rows belong to every scope).
  const scopedClosed = useMemo(() => {
    const closed = allTrades.filter(t2 => t2.status === 'closed' && t2.net_pnl != null)
    if (acct === 'all') return closed
    return closed.filter(t2 => t2.account_id == null || String(t2.account_id) === acct)
  }, [allTrades, acct])

  // Today since the 22:00-UTC roll — the design's "Today" number, plus the
  // TP/SL split the prototype's meta line shows (evidence: close_reason).
  const today = useMemo(() => {
    const anchor = dayAnchorMs(loadedAt)
    const rows = scopedClosed.filter(t2 => { const ms = closedMs(t2); return ms != null && ms >= anchor })
    const wins = rows.filter(t2 => Number(t2.net_pnl) > 0)
    const isTp = (r) => /\btp\b|take.?profit|target|bank|partial|scale/.test(String(r || '').toLowerCase())
    const isSl = (r) => /\bsl\b|stop.?loss|stopped|stop hit/.test(String(r || '').toLowerCase())
    return {
      net: rows.reduce((s, t2) => s + Number(t2.net_pnl), 0), n: rows.length,
      wr: rows.length ? Math.round((wins.length / rows.length) * 100) : null,
      tp: rows.filter(t2 => isTp(t2.close_reason) && !isSl(t2.close_reason)).length,
      sl: rows.filter(t2 => isSl(t2.close_reason) && !isTp(t2.close_reason)).length,
    }
  }, [scopedClosed, loadedAt])

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
        marketOpen: p2.market_open, marketSource: p2.market_source || null,
        pnl: p2.live_pnl != null ? Number(p2.live_pnl) : null,
        pnlAt: p2.live_pnl_at || null,
      }
    })
    const floating = rows.filter(r => r.marketOpen !== false)
    const closed = rows.filter(r => r.marketOpen === false)
    const tot = (l) => (l.some(r => r.pnl != null) ? l.reduce((s, r) => s + (r.pnl ?? 0), 0) : null)
    return { floating, closed, floatTot: tot(floating), closedTot: tot(closed) }
  }, [positions])


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
    return { closed, pnls, wins, losses, total, grossWin, grossLoss, pf, mdd }
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
      const inSide = t2.rvO != null || t2.vwO ? `RVOL ${t2.rvO != null ? `${nf(1).format(t2.rvO)}×` : '—'} · ${t2.vwO ? `${t2.vwO} VWAP` : '—'} · OBV ${t2.obv || '—'}` : '—'
      return {
        when: `${d2.getUTCDate()} ${MO2[d2.getUTCMonth()]} · ${t2.openedAt != null ? ft(t2.openedAt) : '—'} → ${ft(t2.t)} UTC`,
        sym: t2.sym, sd: `${t2.side} ${t2.lots} lots`, strat: t2.strat || '—',
        why: `${out} · planned ${t2.rr != null ? `${nf(1).format(t2.rr)}:1` : '—'} · risked ${risked != null ? money(risked, 0) : '—'} · held ${held}`,
        ind: `in: ${inSide}  →  out: —`,
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
    const CATP = {
      crypto: /^(BTC|ETH|SOL|XRP|ADA|DOGE|LTC|BNB|DOT|LINK|AVAX|TRX)[A-Z]{3,4}$/,
      metal: /^X(AU|AG|PT|PD)[A-Z]{3}$|^COPPER/,
      energy: /^(NATGAS|SPOTCRUDE|BRENT|UKOIL|USOIL|OIL|WTI)/,
      grain: /^(WHEAT|CORN|SOYBEAN|SUGAR|COFFEE|COCOA|COTTON|OATS|RICE)/,
      index: /^(US30|US500|NAS100|USTEC|US2000|GER40|UK100|FRA40|JPN225|AUS200|EUSTX|VIX|DOW|HK50|CHINA50|SPAIN35|ITALY40|SWISS20|NETH25)/,
    }
    const catOf = (sym) => {
      const s = String(sym || '').toUpperCase()
      if (CATP.crypto.test(s)) return 'crypto'
      if (CATP.metal.test(s)) return 'metal'
      if (CATP.energy.test(s)) return 'energy'
      if (CATP.grain.test(s)) return 'grain'
      if (CATP.index.test(s) || /\.(US|UK|DE|AU)$/.test(s)) return 'index'
      if (/^[A-Z]{6}$/.test(s)) return 'fx'
      return 'other'
    }
    const rows = allTrades
      .filter(t2 => t2.status === 'closed' && t2.net_pnl != null)
      .map(t2 => ({ t: closedMs(t2), pnl: Number(t2.net_pnl), cat: catOf(t2.symbol), acc: t2.account_id != null ? String(t2.account_id) : null }))
      .filter(t2 => t2.t != null)
    const AC3 = [...accounts.map(a => ({ name: `${a.is_live ? 'Live' : 'Demo'} ·${String(a.trader_login || a.account_id).slice(-3)}`, id: a.account_id })), { name: 'Overall', id: null }]
    const kf = (v) => (v < 0 ? '−' : '+') + '$' + (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + 'k' : String(Math.round(Math.abs(v))))
    const cell = (v, max) => {
      const a2 = Math.pow(Math.abs(v) / (max || 1), 0.6)
      return { v: kf(v), bg: (v >= 0 ? 'rgba(79,140,255,' : 'rgba(255,77,109,') + (0.07 + 0.78 * a2).toFixed(2) + ')', col: a2 > 0.45 ? '#fff' : P_TX }
    }
    const build = (rowDefs) => {
      const raw = rowDefs.map(r => AC3.map(c => r.list.reduce((s2, t2) => s2 + (c.id == null || t2.acc === c.id ? t2.pnl : 0), 0)))
      const colMax = AC3.map((x, ci) => Math.max(1, ...raw.map(rw => Math.abs(rw[ci]))))
      return rowDefs.map((r, ri) => ({ label: r.label, cells: raw[ri].map((v, ci) => cell(v, colMax[ci])) }))
    }
    const wDefs = windows.map(w => {
      const from = Date.parse(w.from), to = Date.parse(w.to)
      return { label: w.label, list: rows.filter(t2 => t2.t >= from && t2.t < to) }
    })
    const cut30 = loadedAt - 30 * D
    const aDefs = MARKET_COLS.map(m => ({ label: m.label, list: rows.filter(t2 => t2.cat === m.key && t2.t >= cut30) }))
    return { cols: AC3.map(x => ({ name: x.name })), t: build(wDefs), a: build(aDefs) }
  }, [allTrades, accounts, windows, loadedAt])

  const tilesRow = tiles && (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {[
        ['Net P&L', signed(tiles.total), pnlTone(tiles.total)],
        ['Trades', String(tiles.closed.length), ''],
        ['Win rate', `${((tiles.wins.length / tiles.closed.length) * 100).toFixed(0)}%`, ''],
        ['Profit factor', tiles.pf != null ? tiles.pf.toFixed(2) : tiles.wins.length ? '∞' : '—', tiles.pf == null || tiles.pf >= 1 ? UP : DOWN],
        ['Expectancy', `${(tiles.total / tiles.closed.length).toFixed(2)}/trade`, pnlTone(tiles.total)],
        ['Avg win', tiles.wins.length ? `+${(tiles.grossWin / tiles.wins.length).toFixed(2)}` : '—', UP],
        ['Avg loss', tiles.losses.length ? `−${(tiles.grossLoss / tiles.losses.length).toFixed(2)}` : '—', DOWN],
        ['Max drawdown', tiles.mdd > 0 ? `−${tiles.mdd.toFixed(2)}` : '—', DOWN],
        ['Best / worst', `${Math.max(...tiles.pnls).toFixed(2)} / ${Math.min(...tiles.pnls).toFixed(2)}`, ''],
      ].map(([label, value, tone]) => (
        <div key={label} className="glass-inset rounded-[9px] px-2.5 py-1.5 min-w-[92px]">
          <div className={`text-[10px] ${SUB}`}>{label}</div>
          <div className={`text-[13px] font-bold tabular-nums ${tone}`}>{value}</div>
        </div>
      ))}
    </div>
  )

  return (
    <div className="space-y-3">
      {/* Header — exact prototype markup (title 16px/800, LIVE pulse badge,
          session pills, UTC clock). */}
      <style>{'@keyframes perf-pulse{0%,100%{opacity:1}50%{opacity:.3}}'}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-.02em', color: P_TX }}>bot-trade · Performance ledger</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 9.5, fontWeight: 700, color: P_ACC, border: `1px solid ${P_ACC}`, borderRadius: 999, padding: '2px 8px' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: P_ACC, animation: 'perf-pulse 1.6s infinite' }} />LIVE
        </span>
        <SessionClock />
      </div>

      {error && <Card><p className="text-[12px] font-semibold text-[var(--color-down)]">{error}</p></Card>}

      {/* ================= MOBILE (below lg): the design's phone screens ====
          Exact ports of Performance Mobile.dc.html. Pill nav uses the
          prototype's chip styles with the README's ≥44px tap minimum. */}
      <div className="lg:hidden space-y-3">
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {MOBILE_SCREENS.map(s => (
            <button key={s.key} type="button" onClick={() => setScreen(s.key)}
              aria-current={screen === s.key ? 'page' : undefined}
              style={screen === s.key
                ? { fontSize: 9.5, fontWeight: 800, color: '#fff', background: P_ACC, borderRadius: 999, padding: '3px 10px', border: 'none', minHeight: 44, cursor: 'pointer', fontFamily: 'inherit' }
                : { fontSize: 9.5, fontWeight: 600, color: P_SB, border: `1px solid ${P_EDG}`, background: 'transparent', borderRadius: 999, padding: '3px 10px', minHeight: 44, cursor: 'pointer', fontFamily: 'inherit' }}>
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
                  <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU }}>{a.name} · {a.ccy}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: a.hasToday ? (a.day >= 0 ? P_UP : P_DN) : P_MU }}>day {a.hasToday ? signed(a.day) : '—'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 17, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{a.bal != null ? money(a.bal) : '—'}</span>
                  <span style={{ fontSize: 9.5, color: P_SB }}>eq {a.equity != null ? money(a.equity) : '—'}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 9.5, color: P_SB }}>live <span style={{ fontWeight: 800, color: a.live == null ? P_MU : a.live >= 0 ? P_UP : P_DN }}>{a.live != null ? signed(a.live) : '—'}</span> · {a.live != null && a.bal ? `${a.live >= 0 ? '+' : ''}${(a.live / a.bal * 100).toFixed(2)}%` : '—'}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, borderTop: `1px solid ${P_EDG}`, paddingTop: 4 }}>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: P_MU }}>TP nett</span><span style={{ fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: P_UP }}>{a.hasToday ? signed(a.gw) : '—'}</span></span>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: P_MU }}>SL nett</span><span style={{ fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: P_DN }}>{a.hasToday ? signed(-a.gl) : '—'}</span></span>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: P_MU }}>30D pace</span><span style={{ fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: a.n30 == null ? P_MU : a.n30 >= 0 ? P_UP : P_DN }}>{a.n30 != null ? `${signed(a.n30 / 30)}/day` : '—'}</span></span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ height: 4, borderRadius: 999, background: P_EDG }}>
                    <div style={{ height: 4, borderRadius: 999, width: `${Math.max(a.used ?? 0, a.used != null ? 1 : 0)}%`, background: a.usedCol }} />
                  </div>
                  <span style={{ fontSize: 9.5, color: P_MU }}>loss-cap used <span style={{ fontWeight: 800, color: a.usedCol }}>{a.used != null ? `${a.used}%` : '—'}</span> of −{a.cap != null ? money(a.cap, 0) : '—'} · at 100% bot closes all &amp; disarms</span>
                </div>
              </div>
            ))}
            <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 14, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU }}>Today · since 22:00 UTC</span>
                <span style={{ marginLeft: 'auto', fontSize: 15, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: today.n ? (today.net >= 0 ? P_UP : P_DN) : P_MU }}>{today.n ? signed(today.net) : '—'}</span>
              </div>
              <span style={{ fontSize: 9.5, color: P_MU }}>{today.n ? `${today.n} closed · ${today.wr}% win · ${today.tp} TP / ${today.sl} SL` : 'no closed trades yet today'}</span>
            </div>
            {[{ key: 'float', title: 'Open positions — floating', rows: openSplit.floating, tot: openSplit.floatTot, border: P_GBD, titleCol: P_MU },
              { key: 'closed', title: 'Open trade but market closed', rows: openSplit.closed, tot: openSplit.closedTot, border: 'var(--color-warning-border)', titleCol: P_WRN }]
              .filter(t2 => t2.key === 'float' || t2.rows.length > 0).map(t2 => (
              <div key={t2.key} style={{ background: P_GL, border: `1px solid ${t2.border}`, borderRadius: 14, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: t2.titleCol }}>{t2.title}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 14, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: t2.tot == null ? P_MU : t2.tot >= 0 ? P_UP : P_DN }}>{t2.rows.length ? `${t2.rows.length} open · ${t2.tot != null ? signed(t2.tot) : '—'}` : 'flat'}</span>
                </div>
                {t2.key === 'closed' && <span style={{ fontSize: 9.5, color: P_WRN }}>market closed — cannot exit until reopen · latest computed P&amp;L shown</span>}
                {t2.rows.map(p2 => (
                  <div key={p2.id} style={{ display: 'grid', gridTemplateColumns: '74px 66px 1fr 96px', gap: 8, alignItems: 'center', borderTop: `1px solid ${P_EDG}`, paddingTop: 5, fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 11, fontWeight: 800 }}>{p2.sym}</span><span style={{ fontSize: 9.5, color: P_MU }}>{p2.strat}</span></span>
                    <span style={{ fontSize: 9.5, fontWeight: 700, color: p2.sideCol }}>{p2.side} {p2.lots}</span>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 11, fontWeight: 800, color: p2.pnl == null ? P_MU : p2.pnl >= 0 ? P_UP : P_DN }}>{p2.pnl != null ? signed(p2.pnl) : '—'}</span>
                      <span title="SL→TP progress needs a live price — not streamed to this page" style={{ position: 'relative', height: 4, borderRadius: 999, background: P_EDG, display: 'block' }} />
                    </span>
                    <span style={{ fontSize: 9.5, color: P_MU, textAlign: 'right' }}>SL {p2.sld} · TP {p2.tpd}</span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}

        {screen === 'ledger' && (
          <>
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: P_MU }}>Acct</span>
              {[{ id: 'all', label: 'All' }, ...accounts.map(a => ({ id: a.account_id, label: `${a.is_live ? 'Live' : 'Demo'} ·${String(a.trader_login || a.account_id).slice(-3)}` }))].map(f => {
                const on = acct === f.id
                return (
                  <button key={f.id} type="button" onClick={() => setAcct(f.id)}
                    style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: 9.5, fontWeight: 700, color: on ? '#fff' : P_TX, background: on ? P_ACC : 'transparent', border: `1px solid ${on ? P_ACC : P_EDG}`, borderRadius: 999, padding: '3px 9px', minHeight: 44 }}>
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
            <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: P_MU }}>Acct</span>
            {[{ id: 'all', label: 'All' }, ...accounts.map(a => ({ id: a.account_id, label: `${a.is_live ? 'Live' : 'Demo'} ·${String(a.trader_login || a.account_id).slice(-3)}` }))].map(f => {
              const on = acct === f.id
              return (
                <button key={f.id} type="button" onClick={() => setAcct(f.id)}
                  style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: 9.5, fontWeight: 700, color: on ? '#fff' : P_TX, background: on ? P_ACC : 'transparent', border: `1px solid ${on ? P_ACC : P_EDG}`, borderRadius: 999, padding: '3px 9px', minHeight: 44 }}>
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
                <span style={{ fontSize: 11, fontWeight: 800, color: P_ACC }}>Crypto — runs 24/7</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  {crypto.k.map(k2 => (
                    <span key={k2.k} style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999, border: `1px solid ${P_GBD}`, background: P_ACS }}>
                      <span style={{ color: P_MU }}>{k2.k} </span><span style={{ fontVariantNumeric: 'tabular-nums', color: k2.col }}>{k2.v}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '64px 78px 56px 66px 1fr', gap: 6, fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 2 }}>
                <span>Symbol</span><span>Price</span><span>Δ now</span><span>7D P&amp;L</span><span style={{ textAlign: 'right' }}>Tr · Win · PF</span>
              </div>
              {crypto.rows.map(c2 => (
                <div key={c2.sym} style={{ display: 'grid', gridTemplateColumns: '64px 78px 56px 66px 1fr', gap: 6, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '2px 0', fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ fontSize: 9.5, fontWeight: 800 }}>{c2.sym}</span>
                  <span style={{ fontSize: 9.5, fontWeight: 800, color: P_MU }}>—</span>
                  <span style={{ fontSize: 9.5, fontWeight: 700, textAlign: 'center', padding: '1px 0', borderRadius: 5, color: P_MU }}>—</span>
                  <span style={{ fontSize: 9.5, fontWeight: 800, color: c2.col }}>{c2.pnl}</span>
                  <span style={{ fontSize: 9.5, color: P_MU, textAlign: 'right' }}>{c2.meta}</span>
                </div>
              ))}
            </div>
            {/* Forex bands — exact mobile panel. */}
            <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 14, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: P_ACC }}>Forex — banded, all pairs</span>
              {fxBands.map(b => (
                <div key={b.band} style={{ borderTop: `1px solid ${P_EDG}`, paddingTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontSize: 9.5, fontWeight: 800 }}>{b.band}</span>
                    <span style={{ fontSize: 9.5, color: P_MU }}>{b.meta}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: b.col }}>{b.net}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {b.pairs.map(p2 => (
                      <span key={p2.sym} title={p2.tip} style={{ fontSize: 9.5, fontWeight: 600, padding: '1px 5px', borderRadius: 5, border: `1px solid ${P_EDG}`, fontVariantNumeric: 'tabular-nums' }}>
                        {p2.sym} <span style={{ fontWeight: 800, color: p2.col }}>{p2.v}</span>
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
                <span style={{ fontSize: 11, fontWeight: 800, color: panel.tcol }}>{panel.title}</span>
                {panel.rows.length === 0 && <span style={{ fontSize: 9.5, color: P_MU }}>No closed trades in the last 30 days.</span>}
                {panel.rows.map((t2, ti) => (
                  <div key={ti} style={{ borderTop: `1px solid ${P_EDG}`, paddingTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 800 }}>{t2.sym}</span>
                      <span style={{ fontSize: 9.5, color: P_SB }}>{t2.sd}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: t2.col }}>{t2.pnl}</span>
                    </div>
                    <span style={{ fontSize: 9.5, color: P_SB, fontVariantNumeric: 'tabular-nums' }}>{t2.when}</span>
                    <span style={{ fontSize: 9.5, color: P_MU }}>{t2.why} · {t2.strat}</span>
                    <span style={{ fontSize: 9.5, color: P_ACC, fontVariantNumeric: 'tabular-nums' }}>{t2.ind}</span>
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
              <span style={{ fontSize: 11, fontWeight: 800, color: P_ACC }}>Gradient — timeframe × account</span>
              <div style={{ display: 'grid', gridTemplateColumns: `52px repeat(${gradients.cols.length},1fr)`, gap: 3, fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: P_MU }}>
                <span>Window</span>
                {gradients.cols.map(c2 => <span key={c2.name} style={{ textAlign: 'center' }}>{c2.name}</span>)}
              </div>
              {gradients.t.map(r => (
                <div key={r.label} style={{ display: 'grid', gridTemplateColumns: `52px repeat(${gradients.cols.length},1fr)`, gap: 3, alignItems: 'center' }}>
                  <span style={{ fontSize: 9.5, fontWeight: 700 }}>{r.label}</span>
                  {r.cells.map((c2, ci) => <span key={ci} style={{ fontSize: 9.5, fontWeight: 700, textAlign: 'center', padding: '2px 0', borderRadius: 4, background: c2.bg, color: c2.col, fontVariantNumeric: 'tabular-nums' }}>{c2.v}</span>)}
                </div>
              ))}
              <span style={{ fontSize: 9.5, color: P_MU }}>blue = net gain · red = net loss · shaded per column</span>
            </div>
            <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 14, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: P_ACC }}>Gradient — asset × account · 30D</span>
              {gradients.a.map(r => (
                <div key={r.label} style={{ display: 'grid', gridTemplateColumns: `52px repeat(${gradients.cols.length},1fr)`, gap: 3, alignItems: 'center' }}>
                  <span style={{ fontSize: 9.5, fontWeight: 700 }}>{r.label}</span>
                  {r.cells.map((c2, ci) => <span key={ci} style={{ fontSize: 9.5, fontWeight: 700, textAlign: 'center', padding: '3px 0', borderRadius: 4, background: c2.bg, color: c2.col, fontVariantNumeric: 'tabular-nums' }}>{c2.v}</span>)}
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
              {!tiles && <p className={`text-[12px] mb-2 ${SUB}`}>No closed trades yet.</p>}
              {tilesRow}
              <div className="overflow-x-auto"><ReportChart allTrades={allTrades} events={events} /></div>
            </Card>
          </>
        )}
      </div>

      {/* ================= DESKTOP (lg+): the dense ledger ================== */}
      <div className="hidden lg:block space-y-3">
        {/* Accounts detail row — exact prototype cards: day P&L, balance +
            equity + live floating, TP/SL nett today, 30D forecast pace, and
            the loss-cap line (real dailyLossPct config × stamped balance). */}
        {acctCards.length > 0 && (
          <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: P_ACC }}>Accounts — capital safety</span>
            <SectionTools id="accounts" title="Accounts — capital safety"
              data={acctCards.map(a => ({ account: a.name, ccy: a.ccy, balance: a.bal, dayPnl: a.hasToday ? a.day : null, tpNettToday: a.hasToday ? a.gw : null, slNettToday: a.hasToday ? -a.gl : null, pace30d: a.n30 != null ? a.n30 / 30 : null, lossCapUsedPct: a.used, dailyStop: a.cap }))}
              toText={() => ['Accounts — capital safety', ...acctCards.map(a => `${a.name} · ${a.ccy} · bal ${a.bal != null ? money(a.bal) : '—'} · day ${a.hasToday ? signed(a.day) : '—'} · loss-cap used ${a.used != null ? `${a.used}%` : '—'} of −${a.cap != null ? money(a.cap, 0) : '—'}`)].join('\n')}
              render={() => <AcctCardsGrid acctCards={acctCards} />} />
          </div>
          <AcctCardsGrid acctCards={acctCards} />
          </>
        )}

        {/* Today + Open now — exact prototype row. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'stretch' }}>
          <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 12, padding: '5px 9px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 148 }}>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU }}>Today · since 22:00 UTC</span>
              <SectionTools id="today" title="Today · since 22:00 UTC" data={[today]}
                toText={() => `Today · since 22:00 UTC · net ${today.n ? signed(today.net) : '—'} · ${today.n} closed${today.n ? ` · ${today.wr}% win · ${today.tp} TP / ${today.sl} SL` : ''}`}
                render={() => (
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: today.n ? (today.net >= 0 ? P_UP : P_DN) : P_MU }}>{today.n ? signed(today.net) : '—'}</div>
                    <div style={{ fontSize: 11, color: P_MU }}>{today.n ? `${today.n} closed · ${today.wr}% win · ${today.tp} TP / ${today.sl} SL` : 'no closed trades yet today'}</div>
                  </div>
                )} />
            </span>
            <span style={{ fontSize: 14, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: today.n ? (today.net >= 0 ? P_UP : P_DN) : P_MU }}>{today.n ? signed(today.net) : '—'}</span>
            <span style={{ fontSize: 9.5, color: P_MU }}>{today.n ? `${today.n} closed · ${today.wr}% win · ${today.tp} TP / ${today.sl} SL` : 'no closed trades yet today'}</span>
          </div>
          {[{
            key: 'float', title: 'Open now — floating', rows: openSplit.floating, tot: openSplit.floatTot,
            border: P_GBD, titleCol: P_MU,
            note: null,
          }, {
            key: 'closed', title: 'Open trade but market closed', rows: openSplit.closed, tot: openSplit.closedTot,
            border: 'var(--color-warning-border)', titleCol: P_WRN,
            note: 'market closed — the bot cannot exit these until their market reopens; P&L is the latest computed value before/at close',
          }].filter(t2 => t2.key === 'float' || t2.rows.length > 0).map(t2 => (
            <div key={t2.key} style={{ background: P_GL, border: `1px solid ${t2.border}`, borderRadius: 12, padding: '7px 11px', display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 320 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: t2.titleCol }}>{t2.title}</span>
                <span style={{ fontSize: 14, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: t2.tot == null ? P_MU : t2.tot >= 0 ? P_UP : P_DN }}>
                  {t2.rows.length ? `${t2.rows.length} open · ${t2.tot != null ? signed(t2.tot) : 'P&L —'}` : 'none'}
                </span>
                {positions[0]?.live_pnl_at && <span style={{ fontSize: 9.5, color: P_MU }}>as of {String(positions[0].live_pnl_at).slice(11, 19)} UTC</span>}
              </div>
              {t2.note && <span style={{ fontSize: 9.5, color: P_WRN }}>{t2.note}</span>}
              <SectionTools id={`open-${t2.key}`} title={t2.title} data={t2.rows.map(p2 => ({ sym: p2.sym, side: p2.side, lots: p2.lots, latestPnl: p2.pnl, market: p2.marketOpen === false ? 'CLOSED' : p2.marketOpen ? 'OPEN' : 'unknown', slAway: p2.sld, tpAway: p2.tpd }))}
                toText={() => [t2.title, ...t2.rows.map(p2 => `${p2.sym} · ${p2.side} ${p2.lots} · P&L ${p2.pnl != null ? signed(p2.pnl) : '—'} · mkt ${p2.marketOpen === false ? 'CLOSED' : p2.marketOpen ? 'OPEN' : '?'} · SL ${p2.sld} / TP ${p2.tpd}`)].join('\n')}
                render={() => <OpenTableBody rows={t2.rows} />} />
              {t2.rows.length > 0 && <OpenTableBody rows={t2.rows} />}
            </div>
          ))}
        </div>

        {/* Account filter chips — exact prototype two-line buttons. */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: P_MU }}>Account</span>
          {[{ id: 'all', label: 'All Accounts', sub: 'combined ledger' },
            ...acctCards.map(a => ({ id: a.id, label: a.name, sub: `${a.bal != null ? money(a.bal, 0) : '—'} · fc ${a.n30 != null ? `${signed(a.n30 / 30, 0)}/day` : '—'}` }))].map(f => {
            const on = acct === f.id
            return (
              <button key={f.id} type="button" onClick={() => setAcct(f.id)} aria-pressed={on}
                style={{ cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', fontSize: 10, fontWeight: 700, color: on ? '#fff' : P_TX, background: on ? P_ACC : P_GL, border: `1px solid ${on ? P_ACC : P_GBD}`, borderRadius: 12, padding: '4px 12px', display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
                <span>{f.label}</span>
                <span style={{ fontSize: 9.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: on ? 'rgba(255,255,255,.75)' : P_MU }}>{f.sub}</span>
              </button>
            )
          })}
          <span style={{ fontSize: 9.5, color: P_MU }}>filters every table below · fc = 30D forecast pace</span>
        </div>

        {/* The core: timeframe ledger. Three-lens model — time rows here,
            market columns across, per-window detail on expand; totals
            reconcile, nothing is double-counted. */}
        <Card>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="t-h3">Timeframe ledger</h3>
            <span className={`text-[11px] ${SUB}`}>
              carry in → net → carry out · day rolls 22:00 UTC · week anchors Sun 22:00 UTC{ledger ? ` · balance ${money(ledger.balance)}` : ''}
            </span>
            <SectionTools id="ledger" title="Timeframe ledger" data={windows} toText={ledgerToText}
              render={({ variant }) => <LedgerBody variant={variant} windows={windows} ledger={ledger} error={error} />} />
          </div>
          <LedgerBody variant="card" windows={windows} ledger={ledger} error={error} />
        </Card>

        {/* Performance gradients — exact prototype panels (timeframe ×
            account, asset class × account heat tables; column count follows
            the real registry). */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 8, alignItems: 'start' }}>
          <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: P_ACC }}>Performance gradient — timeframe × account</span>
              <span style={{ fontSize: 9.5, color: P_SB }}>always shows all accounts + overall · intensity scaled per column</span>
              <SectionTools id="grad-timeframe" title="Performance gradient — timeframe × account"
                data={gradients.t.map(r => ({ window: r.label, ...Object.fromEntries(r.cells.map((c, ci) => [gradients.cols[ci]?.name || ci, c.v])) }))}
                render={() => <GradientBody grid="86px" label="Window" cols={gradients.cols} rows={gradients.t} pad="3px 0" foot="blue = net gain · red = net loss · each account column shaded against its own peak window" />} />
            </div>
            <GradientBody grid="86px" label="Window" cols={gradients.cols} rows={gradients.t} pad="3px 0" foot="blue = net gain · red = net loss · each account column shaded against its own peak window" />
          </div>
          <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: P_ACC }}>Performance gradient — asset class × account</span>
              <span style={{ fontSize: 9.5, color: P_SB }}>rolling 30 days</span>
              <SectionTools id="grad-asset" title="Performance gradient — asset class × account" window="30D"
                data={gradients.a.map(r => ({ asset: r.label, ...Object.fromEntries(r.cells.map((c, ci) => [gradients.cols[ci]?.name || ci, c.v])) }))}
                render={() => <GradientBody grid="74px" label="Asset" cols={gradients.cols} rows={gradients.a} pad="5px 0" foot="same closed-trade ledger, account dimension — totals reconcile with the Overall column" />} />
            </div>
            <GradientBody grid="74px" label="Asset" cols={gradients.cols} rows={gradients.a} pad="5px 0" foot="same closed-trade ledger, account dimension — totals reconcile with the Overall column" />
          </div>
        </div>

        {/* FX banded panel + Strategy × market — exact prototype grid (the
            right column also hosts the crypto panel in a later slice). */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 8, alignItems: 'start' }}>
          <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: P_ACC }}>Forex — banded, all pairs</span>
              <span style={{ fontSize: 9.5, color: P_SB }}>same trades as the ledger's Forex column, pair-level lens · rolling 7 days = the 1W row · hover a pair for TP/SL detail</span>
              <SectionTools id="fx-bands" title="Forex — banded, all pairs" window="1W" data={fxBands}
                toText={(rows) => ['Forex — banded, all pairs (1W)', ...(rows || []).map(b => `${b.band} · ${b.net} · ${b.meta} · ${b.pairs.filter(p2 => p2.v !== '·').map(p2 => `${p2.sym} ${p2.v}`).join(' · ') || 'no trades'}`)].join('\n')}
                render={() => <FxBandsBody fxBands={fxBands} />} />
            </div>
            <FxBandsBody fxBands={fxBands} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: P_ACC }}>Strategy × market — 30D</span>
                <span style={{ fontSize: 9.5, color: P_SB }}>the ledger's 30D row re-sliced by strategy — each market column here sums to the 30D market cell above</span>
                <SectionTools id="strategy-matrix" title="Strategy × market — 30D" window="30D" data={stratMx}
                  toText={(rows) => ['Strategy × market — 30D', ...(rows || []).map(s => `${s.name} · net ${s.net} · edge ${s.edge} · ${s.cells.map((c, ci) => `${MARKET_COLS[ci].label} ${c.v}`).join(' · ')}`)].join('\n')}
                  render={() => <StratMxBody stratMx={stratMx} />} />
              </div>
              <StratMxBody stratMx={stratMx} />
            </div>
            {/* Crypto 24/7 — exact prototype panel; live price/Δ not
                streamed to this page → honest —. */}
            <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: P_ACC }}>Crypto — runs 24/7</span>
                <span style={{ fontSize: 9.5, color: P_SB }}>tracked separately · never session-gated · = the ledger's Crypto column</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
                  {crypto.k.map(k2 => (
                    <span key={k2.k} style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, border: `1px solid ${P_GBD}`, background: P_ACS }}>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'start' }}>
          {[{ title: 'Winners explained — best closed trades, 30D', tcol: P_UP, sub: 'full anatomy: time in → out, side, lots, plan, volume context at open/close', rows: winLag.win },
            { title: 'Laggards explained — worst closed trades, 30D', tcol: P_DN, sub: 'same anatomy — what went wrong and under what volume conditions', rows: winLag.lag }].map(panel => (
            <div key={panel.title} style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: panel.tcol }}>{panel.title}</span>
                <span style={{ fontSize: 9.5, color: P_MU }}>{panel.sub}</span>
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

        {/* Migrated from Desk: the original stat tiles + decisions/equity
            chart (owner: "move the performance in the desk to a page by its
            own"). */}
        <Card>
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <h3 className="t-h3">All-time tiles &amp; equity</h3>
            {tiles && <span className={`text-[12px] ${SUB}`}>{tiles.closed.length} closed · {signed(tiles.total)}</span>}
            <SectionTools id="tiles" title="All-time tiles &amp; equity"
              data={tiles ? [{ net: tiles.total, trades: tiles.closed.length, winRatePct: Math.round((tiles.wins.length / tiles.closed.length) * 100), profitFactor: tiles.pf, maxDrawdown: tiles.mdd }] : []}
              toText={() => (tiles ? `All-time · net ${signed(tiles.total)} · ${tiles.closed.length} trades · win ${Math.round((tiles.wins.length / tiles.closed.length) * 100)}% · PF ${tiles.pf != null ? tiles.pf.toFixed(2) : '—'} · maxDD −${tiles.mdd.toFixed(2)}` : 'All-time — no closed trades yet')}
              render={() => (
                <div>
                  {tilesRow}
                  <ReportChart allTrades={allTrades} events={events} />
                </div>
              )} />
          </div>
          {!tiles && <p className={`text-[12px] mb-2 ${SUB}`}>No closed trades yet — tiles and chart fill from the first completed round-trip.</p>}
          {tilesRow}
          <ReportChart allTrades={allTrades} events={events} />
        </Card>
      </div>
    </div>
  )
}
