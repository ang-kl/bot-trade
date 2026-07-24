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
              style={{ fontSize: 10.5, fontWeight: 600, padding: '3px 9px', borderRadius: 999, border: `1px solid ${on ? P_ACC : P_EDG}`, color: on ? P_ACC : P_MU, background: on ? P_ACS : 'transparent' }}>
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

// One desktop ledger row, expandable into the market breakdown.
function LedgerRow({ w }) {
  const [open, setOpen] = useState(false)
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

// Accounts registry cards — shared by both layouts. Balance is only known
// for the scope the ledger was built for (collect-forward: no per-account
// balance history yet → "—").
function AccountsPanel({ accounts, selectedAccountId, acct, ledger }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {accounts.map(a => {
        const isScope = acct === a.account_id || (acct === 'all' && a.account_id === selectedAccountId)
        return (
          <div key={a.account_id} className="glass-inset rounded-[10px] px-2.5 py-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Badge tone={a.is_live ? 'down' : 'info'}>{a.is_live ? 'LIVE' : 'DEMO'}</Badge>
              <span className="text-[12px] font-extrabold tabular-nums">{a.trader_login || a.account_id}</span>
              {a.account_id === selectedAccountId && <Badge tone="special">selected</Badge>}
              {a.enabled === 1
                ? <Badge tone="up">{a.mode === 'active' ? 'active' : a.mode}</Badge>
                : <Badge>off</Badge>}
            </div>
            <div className={`mt-1 text-[10px] tabular-nums ${SUB}`}>
              {a.base_currency || '—'} · 1:{a.leverage ?? '—'} · balance {isScope && ledger?.balance != null ? money(ledger.balance) : '—'}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Account filter chips — refilter the ledger; carry-forward switches to
// that account's stamped balance. ≥44px targets on mobile.
function FilterChips({ accounts, acct, setAcct, tall = false }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Account filter">
      {[{ id: 'all', label: 'All accounts' }, ...accounts.map(a => ({ id: a.account_id, label: `${a.is_live ? 'Live' : 'Demo'} ${a.trader_login || a.account_id}` }))].map(c => (
        <button key={c.id} type="button" role="radio" aria-checked={acct === c.id}
          onClick={() => setAcct(c.id)}
          className={`rounded-full px-3 py-1 ${tall ? 'min-h-[44px]' : 'min-h-[28px]'} text-[11px] font-semibold cursor-pointer ${acct === c.id
            ? 'bg-[var(--color-accent)] text-white shadow-[var(--glow-accent)]'
            : `glass-inset ${SUB}`}`}>
          {c.label}
        </button>
      ))}
    </div>
  )
}

// Mobile ledger card — a tappable timeframe row that expands to the six
// market mini-cells + insight (design: Ledger phone screen).
function MobileWindowCard({ w }) {
  const [open, setOpen] = useState(false)
  const empty = !w.trades
  return (
    <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
      className={`w-full text-left glass-inset rounded-[12px] px-3 py-2.5 min-h-[44px] cursor-pointer ${empty ? 'opacity-60' : ''}`}>
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-extrabold">{w.label}</span>
        <span className={`text-[9px] ${SUB}`}>{dRange(w.from, w.to)}</span>
        <span className={`ml-auto text-[13px] font-extrabold tabular-nums ${pnlTone(empty ? null : w.net)}`}>{empty ? '—' : signed(w.net)}</span>
      </div>
      <div className={`text-[10px] tabular-nums ${SUB}`}>
        {money(w.carryIn)} → {money(w.carryOut)}{empty ? '' : ` · ${w.trades}t · ${w.winPct != null ? `${nf(0).format(w.winPct)}%` : '—'} · PF ${w.pf != null ? nf(2).format(w.pf) : '—'} · edge ${w.edge != null ? `${signed(w.edge, 1)}%` : '—'}`}
      </div>
      {open && (
        <div className="mt-2">
          {empty
            ? <p className={`text-[11px] ${SUB}`}>No closed trades in this window.</p>
            : (
              <div className="grid grid-cols-3 gap-1.5">
                {MARKET_COLS.map(m => {
                  const st = w.markets?.[m.key]
                  return (
                    <div key={m.key} className="rounded-[8px] border border-[var(--glass-edge)] px-1.5 py-1">
                      <div className={`text-[8.5px] uppercase font-bold ${SUB}`}>{m.label}</div>
                      {st?.trades
                        ? (
                          <>
                            <div className={`text-[11px] font-bold tabular-nums ${pnlTone(st.net)}`}>{signed(st.net)}</div>
                            <div className={`text-[8.5px] tabular-nums ${SUB}`}>{st.trades}t · {st.winPct != null ? `${nf(0).format(st.winPct)}%` : '—'}</div>
                          </>
                        )
                        : <div className={`text-[11px] ${SUB}`}>—</div>}
                    </div>
                  )
                })}
                {insight(w) && <div className={`col-span-3 text-[10px] ${SUB}`}>{insight(w)}</div>}
              </div>
            )}
        </div>
      )}
    </button>
  )
}

// One closed trade's anatomy for the mobile Trades screen — forensics
// fields render "—" until collect-forward fills them.
function TradeAnatomy({ t }) {
  const ms = closedMs(t)
  const when = ms ? new Date(ms).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
  const held = (() => {
    const o = closedMs({ closed_at: t.opened_at })
    if (!ms || !o) return '—'
    const min = Math.max(0, Math.round((ms - o) / 60000))
    return min < 60 ? `${min}m` : min < 1440 ? `${Math.round(min / 60)}h` : `${Math.round(min / 1440)}d`
  })()
  const pnl = t.net_pnl == null ? null : Number(t.net_pnl)
  return (
    <div className="glass-inset rounded-[12px] px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-extrabold">{t.symbol}</span>
        <span className={`text-[10px] font-semibold ${SUB}`}>{t.side}</span>
        <span className={`ml-auto text-[13px] font-extrabold tabular-nums ${pnlTone(pnl)}`}>{signed(pnl)}</span>
      </div>
      <div className={`text-[10px] tabular-nums ${SUB}`}>
        {when} · held {held} · {t.label_strategy || t.strategy || '—'}
      </div>
      <div className={`text-[9px] tabular-nums ${SUB}`}>
        spread {t.spread_at_entry != null ? nf(5).format(t.spread_at_entry) : '—'} · slip {t.slippage_price != null ? nf(5).format(t.slippage_price) : '—'} · RVOL {t.rvol_open != null ? nf(1).format(t.rvol_open) : '—'} · VWAP {t.vwap_side_open || '—'}
      </div>
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

  // Open-now columns (prototype openCols): monitored positions in 3 columns.
  // Live P&L / live distance need a broker price stream this page doesn't
  // hold — those cells show — until collected; SL/TP distances are computed
  // from entry (stated in the tooltip), never simulated.
  const openCols = useMemo(() => {
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
      }
    })
    return [rows.slice(0, 3), rows.slice(3, 6), rows.slice(6, 9)].map(r => ({ rows: r }))
  }, [positions])

  // Winners & laggards (30D) for the mobile Trades screen.
  const wl = useMemo(() => {
    const cut = loadedAt - 30 * D
    const rows = scopedClosed.filter(t2 => { const ms = closedMs(t2); return ms != null && ms >= cut })
    const sorted = [...rows].sort((a, b) => Number(b.net_pnl) - Number(a.net_pnl))
    return { winners: sorted.filter(t2 => Number(t2.net_pnl) > 0).slice(0, 4), laggards: sorted.filter(t2 => Number(t2.net_pnl) < 0).reverse().slice(0, 4) }
  }, [scopedClosed, loadedAt])

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
  const byKey = useMemo(() => Object.fromEntries(windows.map(w => [w.key, w])), [windows])

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
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: P_ACC, border: `1px solid ${P_ACC}`, borderRadius: 999, padding: '2px 8px' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: P_ACC, animation: 'perf-pulse 1.6s infinite' }} />LIVE
        </span>
        <SessionClock />
      </div>

      {error && <Card><p className="text-[12px] font-semibold text-[var(--color-down)]">{error}</p></Card>}

      {/* ================= MOBILE (below lg): the design's phone screens ==== */}
      <div className="lg:hidden space-y-3">
        <nav className="flex gap-1.5 overflow-x-auto scrollbar-none" aria-label="Performance sections">
          {MOBILE_SCREENS.map(s => (
            <button key={s.key} type="button" onClick={() => setScreen(s.key)}
              aria-current={screen === s.key ? 'page' : undefined}
              className={`rounded-full px-4 min-h-[44px] text-[12px] font-bold shrink-0 cursor-pointer ${screen === s.key
                ? 'bg-[var(--color-accent)] text-white shadow-[var(--glow-accent)]'
                : `glass-inset ${SUB}`}`}>
              {s.label}
            </button>
          ))}
        </nav>

        {screen === 'now' && (
          <>
            <Card>
              <h3 className="t-h3 mb-1">Today</h3>
              <div className={`text-[22px] font-black tabular-nums ${pnlTone(today.n ? today.net : null)}`}>{today.n ? signed(today.net) : '—'}</div>
              <p className={`text-[10px] ${SUB}`}>closed P&L since 22:00 UTC · {today.n} trade{today.n === 1 ? '' : 's'}{ledger?.balance != null ? ` · balance ${money(ledger.balance)}` : ''}</p>
            </Card>
            <Card>
              <h3 className="t-h3 mb-1.5">Open now</h3>
              {positions.length === 0 && <p className={`text-[12px] ${SUB}`}>No open positions.</p>}
              <div className="space-y-1.5">
                {positions.map(p2 => (
                  <div key={p2.id} className="glass-inset rounded-[12px] px-3 py-2">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[12px] font-extrabold">{p2.symbol}</span>
                      <span className={`text-[10px] font-semibold ${String(p2.side).toUpperCase() === 'BUY' ? UP : DOWN}`}>{p2.side}{p2.volume != null ? ` · ${p2.volume}` : ''}</span>
                      <span className={`ml-auto text-[10px] ${SUB}`}>{p2.strategy || '—'}</span>
                    </div>
                    <div className={`text-[10px] tabular-nums ${SUB}`}>
                      entry {money(p2.entry_price, 5)} · SL {money(p2.current_sl, 5)} · TP {money(p2.current_tp, 5)}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}

        {screen === 'ledger' && (
          <>
            <FilterChips accounts={accounts} acct={acct} setAcct={setAcct} tall />
            <div className="space-y-1.5">
              {windows.map(w => <MobileWindowCard key={w.key} w={w} />)}
            </div>
          </>
        )}

        {screen === 'markets' && (
          <>
            <FilterChips accounts={accounts} acct={acct} setAcct={setAcct} tall />
            <div className="space-y-1.5">
              {MARKET_COLS.map(m => {
                const w30 = byKey['30d']?.markets?.[m.key]
                return (
                  <Card key={m.key}>
                    <div className="flex items-baseline gap-2">
                      <h3 className="t-h3">{m.label}</h3>
                      <span className={`ml-auto text-[14px] font-extrabold tabular-nums ${pnlTone(w30?.trades ? w30.net : null)}`}>{w30?.trades ? signed(w30.net) : '—'}</span>
                    </div>
                    <div className="flex gap-1.5 mt-1">
                      {[['12H', '12h'], ['1W', '1w'], ['30D', '30d']].map(([lab, key]) => {
                        const st = byKey[key]?.markets?.[m.key]
                        return (
                          <span key={key} className={`rounded-full border border-[var(--glass-edge)] px-2 py-0.5 text-[10px] tabular-nums ${st?.trades ? pnlTone(st.net) : SUB}`}>
                            {lab} {st?.trades ? signed(st.net) : '—'}
                          </span>
                        )
                      })}
                    </div>
                    <p className={`mt-1 text-[10px] tabular-nums ${SUB}`}>
                      30D: {w30?.trades ? `${w30.trades}t · win ${w30.winPct != null ? `${nf(0).format(w30.winPct)}%` : '—'} · PF ${w30.pf != null ? nf(2).format(w30.pf) : '—'}` : 'no closed trades'}
                    </p>
                  </Card>
                )
              })}
            </div>
          </>
        )}

        {screen === 'trades' && (
          <>
            <FilterChips accounts={accounts} acct={acct} setAcct={setAcct} tall />
            <Card>
              <h3 className="t-h3 mb-1.5">Winners (30D)</h3>
              {wl.winners.length === 0 && <p className={`text-[12px] ${SUB}`}>None in the last 30 days.</p>}
              <div className="space-y-1.5">{wl.winners.map(t2 => <TradeAnatomy key={t2.id} t={t2} />)}</div>
            </Card>
            <Card>
              <h3 className="t-h3 mb-1.5">Laggards (30D)</h3>
              {wl.laggards.length === 0 && <p className={`text-[12px] ${SUB}`}>None in the last 30 days.</p>}
              <div className="space-y-1.5">{wl.laggards.map(t2 => <TradeAnatomy key={t2.id} t={t2} />)}</div>
            </Card>
          </>
        )}

        {screen === 'accounts' && (
          <>
            {accounts.length
              ? <Card><h3 className="t-h3 mb-1.5">Accounts</h3><AccountsPanel accounts={accounts} selectedAccountId={selectedAccountId} acct={acct} ledger={ledger} /></Card>
              : <Card><p className={`text-[12px] ${SUB}`}>No accounts in the registry yet.</p></Card>}
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
            {acctCards.map(a => (
              <div key={a.id} style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 12, padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU }}>{a.name} · {a.ccy}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: a.hasToday ? (a.day >= 0 ? P_UP : P_DN) : P_MU }}>day {a.hasToday ? signed(a.day) : '—'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 16, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{a.bal != null ? money(a.bal) : '—'}</span>
                  <span style={{ fontSize: 10, color: P_SB }}>equity {a.equity != null ? money(a.equity) : '—'}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: P_SB }}>live <span style={{ fontWeight: 800, color: a.live == null ? P_MU : a.live >= 0 ? P_UP : P_DN }}>{a.live != null ? signed(a.live) : '—'}</span> = <span style={{ fontWeight: 800, color: a.live == null ? P_MU : a.live >= 0 ? P_UP : P_DN }}>{a.live != null && a.bal ? `${a.live >= 0 ? '+' : ''}${(a.live / a.bal * 100).toFixed(2)}%` : '—'}</span> of balance</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, borderTop: `1px solid ${P_EDG}`, paddingTop: 4 }}>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', color: P_MU }}>TP nett today</span><span style={{ fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: P_UP }}>{a.hasToday ? signed(a.gw) : '—'}</span></span>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', color: P_MU }}>SL nett today</span><span style={{ fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: P_DN }}>{a.hasToday ? signed(-a.gl) : '—'}</span></span>
                  <span style={{ display: 'flex', flexDirection: 'column' }}><span style={{ fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', color: P_MU }}>Forecast · 30D pace</span><span style={{ fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: a.n30 == null ? P_MU : a.n30 >= 0 ? P_UP : P_DN }}>{a.n30 != null ? `${signed(a.n30 / 30)}/day` : '—'}</span></span>
                </div>
                <span style={{ fontSize: 9, color: P_MU }}>loss-cap used <span style={{ fontWeight: 800, color: a.usedCol }}>{a.used != null ? `${a.used}%` : '—'}</span> of −{a.cap != null ? money(a.cap, 0) : '—'} daily stop</span>
              </div>
            ))}
          </div>
        )}

        {/* Today + Open now — exact prototype row. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'stretch' }}>
          <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 12, padding: '5px 9px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 148 }}>
            <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU }}>Today · since 22:00 UTC</span>
            <span style={{ fontSize: 14, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: today.n ? (today.net >= 0 ? P_UP : P_DN) : P_MU }}>{today.n ? signed(today.net) : '—'}</span>
            <span style={{ fontSize: 9, color: P_MU }}>{today.n ? `${today.n} closed · ${today.wr}% win · ${today.tp} TP / ${today.sl} SL` : 'no closed trades yet today'}</span>
          </div>
          <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 12, padding: '7px 11px', display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 320 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU }}>Open now — floating</span>
              <span style={{ fontSize: 14, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: P_MU }}>{positions.length ? `${positions.length} open · live P&L —` : 'flat'}</span>
            </div>
            {positions.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '0 18px' }}>
                {openCols.map((g, gi) => (
                  <div key={gi} style={{ display: 'flex', flexDirection: 'column' }}>
                    {g.rows.length > 0 && (
                      <div style={{ display: 'grid', gridTemplateColumns: '62px 74px 1fr 92px', gap: 6, fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 2 }}>
                        <span>Symbol</span><span>Side · lots</span><span>Live P&amp;L</span><span>SL / TP away</span>
                      </div>
                    )}
                    {g.rows.map(p2 => (
                      <div key={p2.id} title={`entry ${p2.entry} · ${p2.strat} · distances from entry (live price not streamed to this page)`}
                        style={{ display: 'grid', gridTemplateColumns: '62px 74px 1fr 92px', gap: 6, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '2px 0', fontVariantNumeric: 'tabular-nums' }}>
                        <span style={{ fontSize: 10, fontWeight: 800 }}>{p2.sym}</span>
                        <span style={{ fontSize: 9, fontWeight: 700, color: p2.sideCol }}>{p2.side} {p2.lots}</span>
                        <span style={{ fontSize: 10, fontWeight: 800, color: P_MU }}>—</span>
                        <span style={{ fontSize: 9, color: P_MU }}>{p2.sld} / {p2.tpd}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Account filter chips — exact prototype two-line buttons. */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: P_MU }}>Account</span>
          {[{ id: 'all', label: 'All Accounts', sub: 'combined ledger' },
            ...acctCards.map(a => ({ id: a.id, label: a.name, sub: `${a.bal != null ? money(a.bal, 0) : '—'} · fc ${a.n30 != null ? `${signed(a.n30 / 30, 0)}/day` : '—'}` }))].map(f => {
            const on = acct === f.id
            return (
              <button key={f.id} type="button" onClick={() => setAcct(f.id)} aria-pressed={on}
                style={{ cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', fontSize: 10.5, fontWeight: 700, color: on ? '#fff' : P_TX, background: on ? P_ACC : P_GL, border: `1px solid ${on ? P_ACC : P_GBD}`, borderRadius: 12, padding: '4px 12px', display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
                <span>{f.label}</span>
                <span style={{ fontSize: 8.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: on ? 'rgba(255,255,255,.75)' : P_MU }}>{f.sub}</span>
              </button>
            )
          })}
          <span style={{ fontSize: 9, color: P_MU }}>filters every table below · fc = 30D forecast pace</span>
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
          </div>
          {!ledger && !error && <p className={`text-[12px] mt-2 ${SUB}`}>Loading ledger…</p>}
          {ledger && (
            <div className="overflow-x-auto mt-1.5">
              <table className="w-full text-left tabular-nums min-w-[980px]">
                <thead>
                  <tr className={`border-b border-[var(--color-border)] text-[9px] uppercase tracking-wide ${SUB}`}>
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
                  {windows.map(w => <LedgerRow key={w.key} w={w} />)}
                </tbody>
              </table>
            </div>
          )}
          <p className={`mt-1.5 text-[10px] ${SUB}`}>
            Rolling windows (1H…12M) end now; Yesterday/3D/WTD/MTD use the 22:00-UTC trading-day anchor. Carry-forward reconstructs balances backwards from the current stamped balance — windows older than the recorded history show the maths honestly rather than guessing. Unknown symbols count in totals but not the six market columns.
          </p>
        </Card>

        {/* Performance gradients — exact prototype panels (timeframe ×
            account, asset class × account heat tables; column count follows
            the real registry). */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 8, alignItems: 'start' }}>
          <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: P_ACC }}>Performance gradient — timeframe × account</span>
              <span style={{ fontSize: 9.5, color: P_SB }}>always shows all accounts + overall · intensity scaled per column</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `86px repeat(${gradients.cols.length},1fr)`, gap: 3, fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU, paddingBottom: 2 }}>
              <span>Window</span>
              {gradients.cols.map(c => <span key={c.name} style={{ textAlign: 'center' }}>{c.name}</span>)}
            </div>
            {gradients.t.map(r => (
              <div key={r.label} style={{ display: 'grid', gridTemplateColumns: `86px repeat(${gradients.cols.length},1fr)`, gap: 3, alignItems: 'center' }}>
                <span style={{ fontSize: 10, fontWeight: 700 }}>{r.label}</span>
                {r.cells.map((c, ci) => <span key={ci} style={{ fontSize: 9.5, fontWeight: 700, textAlign: 'center', padding: '3px 0', borderRadius: 6, background: c.bg, color: c.col, fontVariantNumeric: 'tabular-nums' }}>{c.v}</span>)}
              </div>
            ))}
            <span style={{ fontSize: 8.5, color: P_MU }}>blue = net gain · red = net loss · each account column shaded against its own peak window</span>
          </div>
          <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: P_ACC }}>Performance gradient — asset class × account</span>
              <span style={{ fontSize: 9.5, color: P_SB }}>rolling 30 days</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `74px repeat(${gradients.cols.length},1fr)`, gap: 3, fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU, paddingBottom: 2 }}>
              <span>Asset</span>
              {gradients.cols.map(c => <span key={c.name} style={{ textAlign: 'center' }}>{c.name}</span>)}
            </div>
            {gradients.a.map(r => (
              <div key={r.label} style={{ display: 'grid', gridTemplateColumns: `74px repeat(${gradients.cols.length},1fr)`, gap: 3, alignItems: 'center' }}>
                <span style={{ fontSize: 10, fontWeight: 700 }}>{r.label}</span>
                {r.cells.map((c, ci) => <span key={ci} style={{ fontSize: 9.5, fontWeight: 700, textAlign: 'center', padding: '5px 0', borderRadius: 6, background: c.bg, color: c.col, fontVariantNumeric: 'tabular-nums' }}>{c.v}</span>)}
              </div>
            ))}
            <span style={{ fontSize: 8.5, color: P_MU }}>same closed-trade ledger, account dimension — totals reconcile with the Overall column</span>
          </div>
        </div>

        {/* FX banded panel + Strategy × market — exact prototype grid (the
            right column also hosts the crypto panel in a later slice). */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 8, alignItems: 'start' }}>
          <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: P_ACC }}>Forex — banded, all pairs</span>
              <span style={{ fontSize: 10, color: P_SB }}>same trades as the ledger's Forex column, pair-level lens · rolling 7 days = the 1W row · hover a pair for TP/SL detail</span>
            </div>
            {fxBands.map(b => (
              <div key={b.band} style={{ display: 'grid', gridTemplateColumns: '118px 84px 1fr', gap: 8, alignItems: 'start', borderTop: `1px solid ${P_EDG}`, paddingTop: 5 }}>
                <span style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: 10.5, fontWeight: 800 }}>{b.band}</span>
                  <span style={{ fontSize: 8.5, color: P_MU }}>{b.meta}</span>
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
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: P_ACC }}>Strategy × market — 30D</span>
                <span style={{ fontSize: 10, color: P_SB }}>the ledger's 30D row re-sliced by strategy — each market column here sums to the 30D market cell above</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '132px repeat(6,1fr) 76px 52px', gap: 6, fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 3 }}>
                <span>Strategy</span>
                {MARKET_COLS.map(m => <span key={m.key}>{m.label}</span>)}
                <span>Net</span><span>Edge</span>
              </div>
              {stratMx.length === 0 && <span style={{ fontSize: 9.5, color: P_MU, padding: '4px 0' }}>No closed trades with a strategy label in the last 30 days.</span>}
              {stratMx.map(s => (
                <div key={s.name} style={{ display: 'grid', gridTemplateColumns: '132px repeat(6,1fr) 76px 52px', gap: 6, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '3px 0', fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'capitalize' }}>{s.name}</span>
                  {s.cells.map((c, ci) => <span key={ci} title={c.tip} style={{ fontSize: 10, fontWeight: 700, color: c.col }}>{c.v}</span>)}
                  <span style={{ fontSize: 10.5, fontWeight: 800, color: s.col }}>{s.net}</span>
                  <span style={{ fontSize: 10, fontWeight: 800, color: s.edgeCol }}>{s.edge}</span>
                </div>
              ))}
            </div>
            {/* Crypto 24/7 — exact prototype panel; live price/Δ not
                streamed to this page → honest —. */}
            <div style={{ background: P_GL, border: `1px solid ${P_GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)', backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: P_ACC }}>Crypto — runs 24/7</span>
                <span style={{ fontSize: 9.5, color: P_SB }}>tracked separately · never session-gated · = the ledger's Crypto column</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
                  {crypto.k.map(k2 => (
                    <span key={k2.k} style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, border: `1px solid ${P_GBD}`, background: P_ACS }}>
                      <span style={{ color: P_MU }}>{k2.k} </span><span style={{ fontVariantNumeric: 'tabular-nums', color: k2.col }}>{k2.v}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '76px 96px 66px 84px 1fr', gap: 8, fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 2 }}>
                <span>Symbol</span><span>Live price</span><span>Δ now</span><span>7D P&amp;L</span><span style={{ textAlign: 'right' }}>Tr · Win · PF</span>
              </div>
              {crypto.rows.map(c2 => (
                <div key={c2.sym} style={{ display: 'grid', gridTemplateColumns: '76px 96px 66px 84px 1fr', gap: 8, alignItems: 'center', borderBottom: `1px solid ${P_EDG}`, padding: '2px 0', fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ fontSize: 10.5, fontWeight: 800 }}>{c2.sym}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 800, color: P_MU }}>—</span>
                  <span style={{ fontSize: 9.5, fontWeight: 700, textAlign: 'center', padding: '1px 0', borderRadius: 6, color: P_MU }}>—</span>
                  <span style={{ fontSize: 10.5, fontWeight: 800, color: c2.col }}>{c2.pnl}</span>
                  <span style={{ fontSize: 9.5, color: P_MU, textAlign: 'right' }}>{c2.meta}</span>
                </div>
              ))}
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
                <span style={{ fontSize: 9, color: P_MU }}>{panel.sub}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '170px 74px 96px 1fr 76px', gap: 8, fontSize: 8.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: P_MU, borderBottom: `1px solid ${P_EDG}`, paddingBottom: 2 }}>
                <span>Date · in → out (UTC)</span><span>Symbol</span><span>Side · lots</span><span>Outcome · plan · RVOL / VWAP / OBV</span><span style={{ textAlign: 'right' }}>P&amp;L</span>
              </div>
              {panel.rows.length === 0 && <span style={{ fontSize: 9.5, color: P_MU, padding: '4px 0' }}>No closed trades in the last 30 days.</span>}
              {panel.rows.map((t2, ti) => (
                <div key={ti} style={{ display: 'grid', gridTemplateColumns: '170px 74px 96px 1fr 76px', gap: 8, alignItems: 'center', borderTop: `1px solid ${P_EDG}`, paddingTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ fontSize: 9.5, color: P_SB }}>{t2.when}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 800 }}>{t2.sym}</span>
                  <span style={{ fontSize: 9.5, color: P_SB }}>{t2.sd}</span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span style={{ fontSize: 9.5, color: P_MU }}>{t2.why} · {t2.strat}</span>
                    <span style={{ fontSize: 9, color: P_ACC, fontVariantNumeric: 'tabular-nums' }}>{t2.ind}</span>
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 800, textAlign: 'right', color: t2.col }}>{t2.pnl}</span>
                </div>
              ))}
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
          </div>
          {!tiles && <p className={`text-[12px] mb-2 ${SUB}`}>No closed trades yet — tiles and chart fill from the first completed round-trip.</p>}
          {tilesRow}
          <ReportChart allTrades={allTrades} events={events} />
        </Card>
      </div>
    </div>
  )
}
