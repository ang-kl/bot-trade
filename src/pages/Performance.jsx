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
