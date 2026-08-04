// Desk — THE one-screen workspace: a live chart wall on top (up to 30
// charts: 3 columns × 10 rows — open positions first, then whatever the
// scan currently finds active; the full watchlist only fills the wall when
// nothing is), and every detail of what is live below it in collapsible sections
// (expand/collapse triangles, state remembered per section). Nothing from
// the old Monitor was dropped — it lives here behind the triangles.
// Everything reuses the endpoints/components the dedicated pages already
// trust — this page assembles, it does not invent.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { agentGet, agentPost, agentConfigured, pageAsleep } from '../lib/agent-api.js'
import { useAccountSwitch } from '../lib/use-account-switch.js'
import SwitchingNote from '../components/common/SwitchingNote.jsx'
import AccountTag from '../components/common/AccountTag.jsx'
import ScopeDot from '../components/common/ScopeDot.jsx'
import { useAccountScope, MODES } from '../lib/use-account-scope.js'
import PositionChart from '../components/PositionChart.jsx'
import TradeGaugeWall from '../components/TradeGaugeWall.jsx'
import PositionManager from '../components/PositionManager.jsx'
import AccountEngineering from '../components/AccountEngineering.jsx'
import OrderManager from '../components/OrderManager.jsx'
import Card from '../components/common/Card.jsx'
import SectionNavFab from '../components/common/SectionNavFab.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import Input from '../components/common/Input.jsx'
import StdTradeTable from '../components/StdTradeTable.jsx'
import OrderLedger from '../components/OrderLedger.jsx'
import LossReview from '../components/LossReview.jsx'
import SplitFlapClock from '../components/common/SplitFlapClock.jsx'
import Segmented from '../components/common/Segmented.jsx'
import { brokerPositionRows, brokerOrderRows, brokerDealRows, priceDp } from '../lib/std-trade-rows.js'
import { humanVeto } from '../lib/veto-words.js'
import { describeRiskCriteria } from '../lib/risk-criteria.js'
import { useSort } from '../lib/use-sort.jsx'
// Short strategy tags — shared so Desk and the Std trade table never drift.
import { STRAT_SHORT, strategyLabel } from '../lib/strategy-labels.js'
import Skeleton from '../components/common/Skeleton.jsx'
import Collapse from '../components/common/Collapse.jsx'

const REFRESH_MS = 20_000
const ACTIVE_REFRESH_MS = 5_000 // faster poll while a position/order is live — owner: "run in every 1/2 second and not in 5 minutes" (½s risks broker rate limits for no real edge on a 5m+ strategy; 5s keeps the page feeling live)
// No-digits calls are PRICES (scale-aware canonical dp); explicit digits
// are money/counts and keep exactly what the caller asked for.
const fmt = (v, d) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d ?? priceDp(v) }))

function ago(iso) {
  if (!iso) return ''
  const t = Date.parse(String(iso).includes('T') ? iso : String(iso).replace(' ', 'T') + 'Z')
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000))
  // Seconds under a minute (owner: a risk decision made "less than 1m" ago
  // read as a useless "0m" — sub-minute events need sub-minute resolution).
  if (secs < 60) return `${secs}s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  if (mins < 1440) return `${Math.round(mins / 60)}h`
  return `${Math.round(mins / 1440)}d`
}

// Exact wall-clock HH:MM:SS of an event — second-level precision the relative
// "ago" can't give when events are minutes apart (owner: "I ask for seconds").
function clockSecs(iso) {
  if (!iso) return ''
  const t = Date.parse(String(iso).includes('T') ? iso : String(iso).replace(' ', 'T') + 'Z')
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// Collapsible desk section — triangle + title + right-aligned summary that
// stays informative while collapsed. Open/closed persists per section.


function Section({ id, title, summary, tag = null, defaultOpen = true, children }) {
  const KEY = `desk_open_${id}`
  const [open, setOpen] = useState(() => {
    try { const v = localStorage.getItem(KEY); return v == null ? defaultOpen : v === '1' } catch { return defaultOpen }
  })
  const toggle = () => setOpen(o => {
    const n = !o
    try { localStorage.setItem(KEY, n ? '1' : '0') } catch { /* private mode */ }
    return n
  })
  return (
    <Card id={`sec-${id}`}>
      <button type="button" onClick={toggle} aria-expanded={open} className="w-full flex items-center gap-1.5 text-left cursor-pointer">
        <span aria-hidden="true" className="w-3 text-[9px] shrink-0">{open ? '▾' : '▸'}</span>
        <h2 className="t-h3">{title}</h2>
        {/* Owner: state the account beside the table, not only in the sidebar. */}
        {tag}
        {summary && <span className="ml-auto text-[9px] text-[var(--color-text-sub)] truncate">{summary}</span>}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </Card>
  )
}

// One risk-decision row, expandable to the FULL criteria breakdown captured in
// checks_json (owner: "Risk Decision is so superficial ... more than one
// criteria"). The gate evaluates many criteria in order; a late veto still
// passed everything before it — this shows all of them and flags the failure.
function RiskDecisionRow({ ev }) {
  const [open, setOpen] = useState(false)
  let p = {}, checks = {}
  try { p = JSON.parse(ev.proposal_json || '{}') } catch { /* pre-migration rows */ }
  try { checks = JSON.parse(ev.checks_json || '{}') } catch { /* pre-migration rows */ }
  const criteria = describeRiskCriteria(checks, ev.approved ? null : ev.veto_reason)
  return (
    <li className="border-b border-[var(--color-border)] last:border-0 py-px">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full flex items-baseline gap-1.5 min-w-0 text-left cursor-pointer hover:bg-[var(--glass-bg)]" title={ev.veto_reason || 'approved'}>
        <span aria-hidden="true" className="w-2.5 text-[9px] shrink-0 text-[var(--color-text-sub)]">{criteria.length ? (open ? '▾' : '▸') : ''}</span>
        {/* Approval is a STATE, not navigation — state-on blue, not accent. */}
        <span className={`w-9 shrink-0 text-[9px] font-bold tracking-wide ${ev.approved ? 'text-[var(--color-state-on-text)]' : 'text-[var(--color-warning-text)]'}`}>
          {ev.approved ? 'OK' : 'VETO'}
        </span>
        <span className="font-semibold shrink-0">{ev.symbol}</span>
        {ev.side && <span className="text-[var(--color-text-sub)] shrink-0">{ev.side}</span>}
        {p.strategy && <span className="text-[var(--color-text-sub)] shrink-0">{STRAT_SHORT[p.strategy] || p.strategy}</span>}
        {p.timeframe && <span className="text-[var(--color-text-sub)] shrink-0">{p.timeframe}</span>}
        <span className="text-[var(--color-text-sub)] truncate">
          {ev.approved ? `risk-approved${p.entry != null ? ` @ ${fmt(p.entry)}` : ''}` : humanVeto(ev.veto_reason)}
        </span>
        <span className="ml-auto text-[var(--color-text-sub)] shrink-0 tabular-nums" title={`${ev.created_at} · raw: ${ev.veto_reason || 'approved'}`}>
          {clockSecs(ev.created_at)} <span className="opacity-60">({ago(ev.created_at)})</span>
        </span>
      </button>
      {open && criteria.length > 0 && (
        <div className="ml-[52px] mt-0.5 mb-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[9px]">
          {criteria.map(row => (
            <div key={row.key} className="contents">
              <span className={`${row.failed ? 'text-[var(--color-warning-text)] font-semibold' : 'text-[var(--color-text-sub)]'}`}>
                {row.label}{row.failed ? ' ✗' : ''}
              </span>
              <span className={`tabular-nums ${row.failed ? 'text-[var(--color-warning-text)] font-semibold' : ''}`}>{row.value}</span>
            </div>
          ))}
          <span className="col-span-2 mt-0.5 text-[9px] text-[var(--color-text-sub)] opacity-70">
            All criteria evaluated for this signal{ev.approved ? ' — approved' : ' — ✗ marks the one that vetoed'}.
          </span>
        </div>
      )}
    </li>
  )
}

export default function Desk() {
  const [health, setHealth] = useState(null)
  const [scans, setScans] = useState([])
  // Newest close per symbol across ALL cycles — the currency-conversion base.
  const [latestPrices, setLatestPrices] = useState({})
  const [positions, setPositions] = useState([])   // bot-tracked rows (chart lines)
  // Whose positions the route says these are, + rows it hid for having no
  // account_id. /state/positions is account-scoped server-side now, so Desk
  // needs no query param — it gets the selected account by default.
  const [posScope, setPosScope] = useState({ accountId: null, legacyRows: 0, scope: null })
  const [events, setEvents] = useState([])
  const [armed, setArmed] = useState(null)
  const [config, setConfig] = useState(null)
  const [broker, setBroker] = useState(null)             // selected account at the BROKER
  const [brokerHistory, setBrokerHistory] = useState(null) // broker's closed deals, 7d
  const [heartbeats, setHeartbeats] = useState(null)       // controller reliability
  const [llmSpend, setLlmSpend] = useState(null)           // token usage + est cost
  const [alphaDecay, setAlphaDecay] = useState(null)       // edge-erosion read
  const [capDraft, setCapDraft] = useState('')             // LLM daily cap editor
  const [capNote, setCapNote] = useState('')
  const [marketHours, setMarketHours] = useState(null)  // { SYM: { open, next_open_at } }
  const [orders, setOrders] = useState(null)            // durable set-order ledger (/state/orders)
  const [postmortems, setPostmortems] = useState(null)  // post-loss playback (/state/postmortems)
  const [dupeTrades, setDupeTrades] = useState(null)    // duplicate-trade audit (/state/duplicate-trades)
  const [weekendFlags, setWeekendFlags] = useState([])  // pre-closure losing positions (/state/weekend-loss-flags)
  const [correlation, setCorrelation] = useState(null)  // cluster exposure (/state/correlation)
  const [pulse, setPulse] = useState(null)              // market pulse (/state/market-pulse)
  const [sweepBusy, setSweepBusy] = useState(false)     // on-demand lessons sweep
  const [sweepNote, setSweepNote] = useState('')
  const [labelBackfillBusy, setLabelBackfillBusy] = useState(false) // recover label_strategy from thesis fingerprints
  const [labelBackfillNote, setLabelBackfillNote] = useState('')
  const [brokerErr, setBrokerErr] = useState('')        // live snapshot fetch failure — shown, not swallowed
  const [error, setError] = useState('')
  const [manualSymbol, setManualSymbol] = useState('') // set ONLY by pickSymbol — a deliberate trader pick
  const [historyDays, setHistoryDays] = useState(7)     // "Closed at the broker" window — 7/30/90/180 (owner spec)
  const [symbolTouched, setSymbolTouched] = useState(false) // true once the trader manually picks a chart
  const [gridN, setGridN] = useState(() => {
    // Clamp a leftover value from before the 1/4/9/30 → 1/4/8/16 rework —
    // an old "30" would otherwise render a wall no picker button matches.
    try {
      const n = Number(localStorage.getItem('desk_grid_n'))
      return [1, 4, 8, 16].includes(n) ? n : 1
    } catch { return 1 }
  })   // 1 | 4 | 8 | 16 charts on the per-symbol wall

  const pickGrid = (n) => {
    setGridN(n)
    try { localStorage.setItem('desk_grid_n', String(n)) } catch { /* private mode */ }
  }

  const [pnlGridN, setPnlGridN] = useState(() => {
    try {
      const n = Number(localStorage.getItem('desk_pnl_grid_n'))
      return [1, 4, 8, 16].includes(n) ? n : 4
    } catch { return 4 }
  })   // 1 | 4 | 8 | 16 gauge tiles per row on the floating P&L wall

  const pickPnlGrid = (n) => {
    setPnlGridN(n)
    try { localStorage.setItem('desk_pnl_grid_n', String(n)) } catch { /* private mode */ }
  }

  // Column sorting for the Edge-health tables (same interaction as the
  // standard table). Streak sorts losses negative so worst floats on desc asc.
  const edgeSort = useSort(alphaDecay?.strategies || [], { key: 'net', dir: 'asc' }, {
    strategy: s2 => s2.strategy,
    trend: s2 => s2.trend,
    streak: s2 => (s2.streak?.n ?? 0) * (s2.streak?.kind === 'loss' ? -1 : 1),
    trades: s2 => s2.total?.n,
    net: s2 => s2.netPnl,
    win: s2 => s2.winRate,
    recent: s2 => s2.recent?.expectancy,
    prior: s2 => s2.prior?.expectancy,
    delta: s2 => s2.delta,
  })
  // Per-strategy baselines (owner: "why didn't you update the rest"). Show one
  // strategy at a time via a chip picker; default to the most-recently tested.
  const [baselineStrat, setBaselineStrat] = useState(null)
  const backtestsList = alphaDecay?.backtests?.length
    ? alphaDecay.backtests
    : (alphaDecay?.backtest ? [alphaDecay.backtest] : [])
  const curBaseline = backtestsList.find(b => b.strategy === baselineStrat) || backtestsList[0] || null
  const baseSort = useSort(curBaseline?.combos || [], { key: 'pf', dir: 'desc' }, {
    combo: c2 => `${c2.symbol} ${c2.tf}`,
    trades: c2 => c2.trades,
    pf: c2 => c2.profitFactor,
    win: c2 => c2.winRatePct,
    total: c2 => c2.totalProfitPct,
  })

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — log in on the Connect tab.'); return }
    // TWO-TIER LOAD (owner: "30s to load — make it 3"). The broker snapshot
    // and deal history are live cTrader WebSocket round-trips (slow, tens of
    // seconds on a cold link); everything else is a SQLite read (<100ms).
    // Paint from the fast tier immediately; the broker sections say
    // "fetching…" and fill in whenever the WS answers.
    agentPost('/actions/broker-positions', { selectedOnly: true })
      .then(b => {
        // Refreshes update the snapshot IN PLACE — never blank it. Setting
        // broker to null on a transient empty refresh collapsed the whole
        // "At the broker" table to "Fetching…" then repopulated it next tick,
        // so the page jumped up/down every few seconds (owner). Keep the last
        // good snapshot; React then diffs only the changed cells (price/P&L),
        // no reflow. A real fetch failure is surfaced via brokerErr below.
        const next = b?.accounts?.[0]
        if (next) { setBroker(next); setBrokerErr('') }
      })
      // A failed LIVE refresh must be loud — silently keeping the cached
      // snapshot made the Desk look current while showing Friday's data
      // (owner hit this Monday morning). The interval retries every cycle.
      .catch(e => setBrokerErr(`live broker refresh failed: ${e.message} — retrying`))
    agentPost('/actions/broker-history', { days: historyDays })
      .then(bh => { if (bh?.ok) setBrokerHistory(bh) }) // keep prev on a bad refresh — no collapse
      .catch(() => {})
    // Instant paint: the agent's cached snapshot (refreshed ~every 30s by
    // the monitor) fills the broker sections in milliseconds; the live
    // fetches above overwrite it the moment the WS answers. `prev ??` makes
    // sure cache never clobbers live data that already landed.
    agentGet('/state/broker-cache')
      .then(bc => {
        if (bc?.snapshot?.account) {
          setBroker(prev => prev ?? { ...bc.snapshot.account, _cachedAt: bc.snapshot.fetchedAt })
        }
        if (bc?.history?.ok) setBrokerHistory(prev => prev ?? { ...bc.history, _cachedAt: bc.history.fetchedAt })
      })
      .catch(() => {})
    try {
      const [h, s, p, r, atf, c, hb, ls, ad, mh, ord, pms, corr, mp, dupe, wlf, px] = await Promise.all([
        agentGet('/state/health'),
        agentGet('/state/scans'),
        agentGet('/state/positions'),
        agentGet('/state/risk-events?limit=200'),
        agentGet('/state/autotrade-timeframes').catch(() => null),
        agentGet('/state/config').catch(() => null),
        agentGet('/state/heartbeats').catch(() => null),
        agentGet('/state/llm-spend').catch(() => null),
        agentGet('/state/alpha-decay').catch(() => null),
        agentGet('/state/market-hours').catch(() => null),
        agentGet('/state/orders').catch(() => null),
        agentGet('/state/postmortems').catch(() => null),
        agentGet('/state/correlation').catch(() => null),
        agentGet('/state/market-pulse').catch(() => null),
        agentGet('/state/duplicate-trades').catch(() => null),
        agentGet('/state/weekend-loss-flags').catch(() => null),
        agentGet('/state/prices').catch(() => null),
      ])
      setHealth(h)
      setLatestPrices(px?.prices || {})
      // lastResults.scans is the CURRENT scan cycle's snapshot — recentScans
      // is the last 50 DB rows across cycles, which can carry a stale
      // non-skip row past a later skip for the same symbol, and duplicate
      // `key={symbol}` rows in lists keyed by symbol (Codex review).
      const rows = s.lastResults?.scans || []
      setScans(rows)
      setPositions(p.rows || p.positions || [])
      setPosScope({ accountId: p?.accountId ?? null, legacyRows: p?.legacyRows ?? 0, scope: p?.scope ?? null })
      setEvents(r.rows || [])
      setArmed(atf)
      setConfig(c)
      setHeartbeats(hb?.controllers ?? null)
      setLlmSpend(ls)
      setAlphaDecay(ad)
      setMarketHours(mh?.hours || null)
      setOrders(ord || null)
      setPostmortems(pms || null)
      setCorrelation(corr || null)
      setPulse(mp || null)
      setDupeTrades(dupe || null)
      setWeekendFlags(wlf?.flags || [])
      setError('')
    } catch (e) { setError(e.message) }
  }, [historyDays])

  const hasActivity = positions.length > 0 || (broker?.orders?.length || 0) > 0
  useEffect(() => {
    const kick = setTimeout(load, 0) // async kick keeps the effect render-clean
    const t = setInterval(() => { if (!pageAsleep()) load() }, hasActivity ? ACTIVE_REFRESH_MS : REFRESH_MS)
    return () => { clearTimeout(kick); clearInterval(t) }
  }, [load, hasActivity])

  // An account switch must not wait out this page's poll interval (see
  // src/lib/selected-account.js — it was up to 70s with the server cache).
  const switchingTo = useAccountSwitch(load)

  const watch = (config?.symbols || []).filter(w => w.enabled !== false).map(w => w.symbol)
  // Chart wall order: live broker positions first, then bot-tracked, then
  // whatever the scan currently finds ACTIVE (a live bias — hot before
  // warm), never the raw 50+ symbol watchlist (owner: "should based on
  // active list and not all symbols"). The full watchlist is only a
  // last-resort fallback for the empty state — before the first scan runs,
  // or once in a great while when nothing anywhere has a setup — so the
  // wall/dropdown is never blank.
  const activeScans = [...scans]
    .filter(sc => sc.bias && sc.bias !== 'skip')
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .map(sc => sc.symbol)
  const chartSymbols = [...new Set([
    ...(broker?.positions || []).map(p => p.symbol),
    ...positions.map(p => p.symbol),
    // Resting orders are just as "active" as an open position — chart them
    // too (owner: "also allow pending trade chart").
    ...(broker?.orders || []).map(o => o.symbol),
    ...activeScans,
    ...(activeScans.length === 0 ? watch : []),
  ])]
  // The DISPLAYED symbol follows the top of chartSymbols (a held position,
  // or the hottest active signal) until the trader manually picks a chart —
  // derived on every render rather than a "set once and never touch again"
  // effect, which previously raced three separate defaults on load and
  // could permanently lock onto a placeholder ('EURUSD') or a stale symbol
  // before real positions/signals had even arrived (owner: "still doesn't
  // show active trade for charting"). pickSymbol() is the ONLY thing that
  // stops the auto-follow.
  const symbol = symbolTouched ? manualSymbol : (chartSymbols[0] || '')
  const pickSymbol = (sym) => { setManualSymbol(sym); setSymbolTouched(true) }
  const linesFor = (sym) => {
    const bp = (broker?.positions || []).find(px => px.symbol === sym)
    if (bp) return { entry: bp.entry, sl: bp.sl, tp: bp.tp }
    const p2 = positions.find(px => px.symbol === sym)
    return p2 ? { entry: p2.entry_price, sl: p2.current_sl, tp: p2.current_tp } : {}
  }
  const scan = scans.find(sc => sc.symbol === symbol)
  const matrix = armed?.matrix && Object.keys(armed.matrix).length > 0 ? armed.matrix : null
  // Armed combos as CHIPS — one per symbol×timeframes pair, never a mashed sentence.
  const armedChips = matrix
    ? Object.entries(matrix).map(([sym2, tfs]) => `${sym2} · ${tfs.join(' ')}`)
    : (armed?.timeframes || []).map(tf => `all symbols · ${tf}`)
  const brokerFlat = (broker?.positions?.length ?? 0) === 0 && (broker?.orders?.length ?? 0) === 0
  const equityStopToday = (health?.equityStopTrippedAt || '').slice(0, 10) === new Date().toISOString().slice(0, 10)
  const floating = (broker?.positions || []).reduce((s2, p2) => s2 + (Number(p2.netPnl ?? p2.estNetPnl ?? p2.estPnlQuote) || 0), 0)
  // Memoise the broker tables on a content signature so an unchanged tick keeps
  // the SAME row array — the price/P&L cells update in place, and the table
  // never churns just because another Desk section polled (owner: "refresh that
  // cell, not the whole table"). Combined with the no-blank refresh above, the
  // section no longer collapses/repopulates, so the page stops jumping.
  const posSig = (broker?.positions || []).map(x => `${x.positionId}:${x.currentPrice ?? ''}:${x.netPnl ?? x.estNetPnl ?? ''}:${x.sl ?? ''}:${x.tp ?? ''}:${x.lots ?? ''}`).join('|')
  const ordSig = (broker?.orders || []).map(x => `${x.orderId}:${x.limitPrice ?? x.stopPrice ?? ''}:${x.sl ?? ''}:${x.tp ?? ''}:${x.lots ?? ''}`).join('|')

  // Merge the monitor's per-position review record (last_check_*, thesis_status,
  // current_sl from /state/positions) onto the live broker positions, matched by
  // ctrader_position_id, so each gauge card can PROVE it's being reviewed
  // (owner: "how do I know you are reviewing each one ... watch stop-loss").
  // Same map doubles as the DB↔broker cross-check for brokerPosRows below
  // (owner: "check individually the 18 positions" after the LLM-monitor
  // broker-close bug — each broker row gets an Integrity column from this).
  const monitorByPid = useMemo(() => {
    const m = new Map()
    for (const r of positions) if (r.ctrader_position_id != null) m.set(String(r.ctrader_position_id), r)
    return m
  }, [positions])

  // Scan closes double as the FX rate map bracketMoney needs to convert a
  // cross's quote-currency risk into USD (GBPJPY risk lands in JPY). Without
  // it crosses report blank rather than a wrong number.
  // TWO TIERS, not one. The base is /state/prices — the newest close per
  // symbol across ALL cycles — with the current cycle's snapshot layered on
  // top as the fresher value.
  //
  // Scanning rotates ~15 of 221 symbols per cycle, so a map built from one
  // cycle almost never holds the conversion leg a cross needs. The agent hit
  // this and fixed it with a persistent table (services/fx-rates.js); this
  // page was still reading one batch, which is why a Hong Kong row's
  // stop-loss had no USDHKD to convert through.
  const openPnlScope = useAccountScope({
    id: 'desk.open-pnl', mode: MODES.ACCOUNT, payload: { scope: posScope.scope },
  })

  const rateMap = useMemo(() => {
    const m = {}
    for (const [sym, v] of Object.entries(latestPrices || {})) {
      const px2 = Number(v?.price ?? v)
      if (Number.isFinite(px2) && px2 > 0) m[String(sym).toUpperCase()] = px2
    }
    for (const sc of scans) {
      if (Number.isFinite(Number(sc.price))) m[String(sc.symbol).toUpperCase()] = sc.price
    }
    return m
  }, [scans, latestPrices])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const brokerPosRows = useMemo(() => brokerPositionRows(broker?.positions || [], { manageable: true, dbByPid: monitorByPid, rates: rateMap }), [posSig, monitorByPid, rateMap])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const brokerOrderRowsM = useMemo(() => brokerOrderRows(broker?.orders || [], { manageable: true }), [ordSig])

  // The reverse gap: a DB row still marked 'active' whose position the
  // broker snapshot doesn't have at all. The reconciler closes these on its
  // own next pass (closedDetected) — surfaced here so a stale one is VISIBLE
  // instead of only inferred from an empty broker table.
  const dbOnlyPositions = useMemo(() => {
    if (!broker?.positions) return [] // snapshot not loaded yet — don't false-flag
    const liveIds = new Set(broker.positions.map(p => String(p.positionId)))
    return positions.filter(r => r.ctrader_position_id != null && !liveIds.has(String(r.ctrader_position_id)))
  }, [positions, broker?.positions])
  const gaugePositions = useMemo(() => (broker?.positions || []).map(bp => {
    const mp = monitorByPid.get(String(bp.positionId))
    return mp
      ? { ...bp, lastCheckAt: mp.last_check_at, lastCheckAction: mp.last_check_action, thesisStatus: mp.thesis_status, monitorSl: mp.current_sl,
          // PHASE 1 (cockpit live-wiring): the DURABLE identity rides with the
          // row so a cockpit deep link can survive a reload — the broker id
          // alone cannot answer "which account, which db row".
          dbPositionId: mp.id, tradeId: mp.trade_id, accountId: mp.account_id }
      : bp
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [posSig, monitorByPid])

  return (
    <div className="space-y-2">
      <SectionNavFab />
      <SwitchingNote to={switchingTo} />
      {error && <Card className="text-[9px]">{error}</Card>}

      {/* ---- Status strip — desk-style: dots + text, no pill clutter.
           Pills are for controls; status is DATA, so it reads as a line. ---- */}
      <Card>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px]">
          {/* Tri-state, honestly: "no data yet" must never read as OFF — a
              loading page and a disarmed bot are different facts. */}
          <span className="font-semibold whitespace-nowrap">
            {/* OFF is the red state tint, UNKNOWN stays muted — a disarmed bot
                and a loading page must not share one grey (inventory D2), and
                ON is the blue STATE colour, not the navigation accent. */}
            <span aria-hidden="true" style={{ color: !health ? 'var(--color-text-sub)' : health.autotradeEnabled ? 'var(--color-state-on-text)' : 'var(--color-state-off-text)' }}>● </span>
            {!health ? 'Autotrade: no data yet' : health.autotradeEnabled ? 'Autotrade ON' : 'Autotrade OFF'}
          </span>
          {health?.pendingModeEnabled && (
            <span
              className="whitespace-nowrap text-[var(--color-warning-text)] font-semibold"
              title="GLOBAL setting, not this account's: resting-limit-order mode is ON, so new signals place a resting limit order instead of a market order on EVERY account. Turn it off in Tune › Pipeline. (Until 05-08-2026 the strategy autopilot could silently re-arm this after you turned it off — it now mirrors its own matrix in both directions.)"
            >⏳ pending armed <span className="font-normal text-[var(--color-text-sub)]">(all accounts)</span></span>
          )}
          <span className={`font-semibold whitespace-nowrap ${health?.broker?.isLive ? 'text-[var(--color-down)]' : 'text-[var(--color-text-sub)]'}`}>
            {health?.broker?.isLive ? '⚠ LIVE' : 'DEMO'}
          </span>
          <span className="font-semibold whitespace-nowrap">${fmt(health?.broker?.balance, 2)}</span>
          <span className="text-[var(--color-text-sub)] whitespace-nowrap">
            micro-tuned: {armedChips.length || 0} combos ·{' '}
            <Link to="/tune" className="text-[var(--color-accent)] underline underline-offset-2">Tune ›</Link>
          </span>
          {equityStopToday && <span className="text-[var(--color-down)] font-semibold">EQUITY STOP TRIPPED — auto-disarmed today</span>}
          {health && !health.broker?.linked && (
            <span className="text-[var(--color-warning-text)]">No account linked — re-link on Connect (keep DB_PATH on a Railway Volume)</span>
          )}
        </div>
        {/* The bot's GOAL, one line, derived live from config. The armed
            combo list lives behind a disclosure — useful on demand, not as
            a 17-chip wall. */}
        <p className="mt-1 text-[9px] text-[var(--color-text-sub)]">
          <span className="font-semibold text-[var(--color-text)]">Goal:</span>{' '}
          {(config?.autotrade_scope ?? 'all') === 'all'
            ? <>full watchlist — {watch.length || '…'} symbols × armed strategies × any scanned TF</>
            : <>the {armedChips.length} backtest-armed combos only (widen in Tune)</>}
          {' '}· sizing {(config?.burn_in?.sizeMode ?? 'auto') === 'fixed' && config?.burn_in?.on ? `fixed ${config?.burn_in?.lots ?? 0.01} lots (burn-in)` : 'risk-based'}
          {config?.burn_in?.on ? <> · pacing {config?.burn_in?.targetTrades ?? 200} trades/{config?.burn_in?.windowDays ?? 2}d</> : null}
          {' '}· guardrails: risk gate · stage matrix · market hours · equity stop
        </p>
        {armedChips.length > 0 && (
          <details className="mt-0.5 text-[9px]">
            <summary className="cursor-pointer text-[var(--color-text-sub)] select-none">armed combos ({armedChips.length})</summary>
            <p className="mt-0.5 text-[var(--color-text-sub)] leading-relaxed">{armedChips.join(' · ')}</p>
          </details>
        )}
      </Card>

      {/* ---- P&L overview — the FIRST chart (owner: "first chart should be
          oscillator chart of all active trade... line chart of all trades
          (active) whether profit or loss"), ahead of the per-symbol grid
          wall below. Collapsible like every other Desk section (owner:
          "chart collapse unless i want to see then expand") — the summary
          line stays live while collapsed so it still reads as active. ---- */}
      <Section
        id="openpnl"
        title="Open trades — floating P&L"
        tag={<>
          <AccountTag accountId={posScope.accountId} legacyRows={posScope.legacyRows} />
          {/* S4 — the DB-tracked positions declare 'account'. The "At the
              broker" table below is a different question and declares
              separately: it is BROKER truth for one connection, so pooling it
              under this dot would be the same conflation the plan is about. */}
          <ScopeDot scope={openPnlScope} />
        </>}
        summary={(() => {
          const openPositions = broker?.positions || []
          if (openPositions.length === 0) return 'flat'
          const total = openPositions.reduce((s2, p) => {
            const v = Number(p.netPnl ?? p.estNetPnl ?? p.estPnlQuote)
            return s2 + (Number.isFinite(v) ? v : 0)
          }, 0)
          return `${openPositions.length} open · ${total >= 0 ? '+' : '−'}${Math.abs(total).toFixed(2)}`
        })()}
        defaultOpen={false}
      >
        <details className="mb-1.5 text-[9px] text-[var(--color-text-sub)]">
          <summary className="cursor-pointer select-none font-semibold">what do these gauges mean?</summary>
          <p className="mt-1 leading-relaxed">
            <strong>Attitude</strong> — the horizon tilts with this trade's P&amp;L (blue rises on profit, orange on loss); the fixed wings across the middle don't tilt — their length is the position's size (lots), and the tip shows an arrow when P&amp;L has moved consistently one way for the last minute or so, or a dot when it's choppy/flat.<br />
            <strong>Activity</strong> — the needle reads how fast this trade's P&amp;L is moving right now: flat left (9 o'clock) = dormant, up toward 12 = profit accelerating, down toward 6 = loss accelerating. The number underneath is that rate in account currency per minute.
          </p>
        </details>
        <div className="mb-1.5">
          <Segmented label="Gauge wall grid size" value={pnlGridN} onChange={pickPnlGrid}
            options={[1, 4, 8, 16].map(n => ({ value: n, label: String(n) }))} />
        </div>
        <TradeGaugeWall positions={gaugePositions} gridN={pnlGridN} marketHours={marketHours} />
      </Section>

      {/* ---- Chart wall — full width; per-symbol candlestick charts.
          Collapsible like every other Desk section (owner: "the charting
          in desk page should be able to expand/collapse") — open by default
          since it's the page's main content, with a live summary line so
          it still says something useful collapsed. ---- */}
      <Section
        id="chartwall"
        title="Chart wall"
        summary={gridN === 1 ? (symbol || '—') : `${gridN}-chart wall`}
      >
        <div className="flex items-center gap-1 mb-1.5 flex-wrap">
          <Segmented label="Chart grid size" value={gridN} onChange={pickGrid}
            options={[1, 4, 8, 16].map(n => ({ value: n, label: n === 1 ? '1 chart' : `${n} wall`, title: n === 1 ? '1 chart on screen' : `${n} charts — a wall of ${n} on screen` }))} />
          {/* Symbol picker: a dropdown, not 52 chips — one control, no row
              of pills to swipe through (owner: "so many UI controls"). */}
          {gridN === 1 && chartSymbols.length > 0 && (
            <select
              aria-label="Chart symbol"
              value={symbol || ''}
              onChange={e => pickSymbol(e.target.value)}
              className="glass-inset rounded-[var(--radius-control)] px-2 min-h-[28px] text-[9px] font-semibold bg-transparent cursor-pointer max-w-[140px]"
            >
              {chartSymbols.map(sym => <option key={sym} value={sym}>{sym}</option>)}
            </select>
          )}
          <span className="text-[9px] text-[var(--color-text-sub)]">
            positions first{gridN > 1 ? ' · 60s refresh — tap a symbol to focus' : ''}
          </span>
        </div>
        {gridN === 1 && (
          <>
            {symbol && (
              <PositionChart
                symbol={symbol}
                timeframe={scan?.timeframe || '1h'}
                lines={linesFor(symbol)}
              />
            )}
          </>
        )}
        {gridN > 1 && (
          <div className={`grid gap-2 ${gridN === 4 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-4'}`}>
            {chartSymbols.slice(0, gridN).map(sym => {
              const held = (broker?.positions || []).some(px => px.symbol === sym) || positions.some(px => px.symbol === sym)
              return (
                <div key={sym} className="min-w-0">
                  <button type="button" className="text-[9px] font-bold cursor-pointer hover:underline" onClick={() => { pickSymbol(sym); pickGrid(1) }}>
                    {sym}{held ? <span title="position held" aria-label="position held"> ●</span> : ''}
                  </button>
                  <PositionChart
                    grid
                    symbol={sym}
                    timeframe={scans.find(sc => sc.symbol === sym)?.timeframe || '1h'}
                    lines={linesFor(sym)}
                  />
                </div>
              )
            })}
          </div>
        )}
        {/* Scan strip — one line per symbol, words not colours */}
        <div className="mt-2 border-t border-[var(--color-border)] pt-1.5 grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3 text-[9px]">
          {scans.map(sc => (
            <button
              key={sc.symbol} type="button" onClick={() => { pickSymbol(sc.symbol); if (gridN !== 1) pickGrid(1) }}
              className="flex items-center gap-1.5 py-0.5 text-left cursor-pointer min-w-0 rounded-[var(--radius-control)] hover:bg-[var(--glass-bg)]"
              title={sc.thesis || ''}
            >
              <span className="font-semibold w-16 shrink-0">{sc.symbol}</span>
              <span className={`truncate ${sc.bias && sc.bias !== 'skip' ? 'font-semibold' : 'text-[var(--color-text-sub)]'}`}>
                {sc.bias && sc.bias !== 'skip'
                  ? `${STRAT_SHORT[sc.strategy] || 'FIB'} ${sc.bias.toUpperCase()} ${sc.timeframe || ''} ${sc.confidence ?? '?'}/10`
                  : 'no setup (any strategy)'}
              </span>
            </button>
          ))}
          {scans.length === 0 && <span className="text-[var(--color-text-sub)] py-1">No scan yet — the loop runs every {config?.loop_interval_min ?? 5} min.</span>}
        </div>
      </Section>

      {/* ---- Detail sections — everything live, behind triangles ---- */}
      <Section
        id="broker"
        title={`At the broker — positions (${broker?.positions?.length ?? '…'}) & set orders (${broker?.orders?.length ?? '…'})`}
        summary={broker?.positions?.length ? `floating ${floating >= 0 ? '+' : ''}${fmt(floating, 2)}` : null}
      >
        {!broker && <p className="text-[9px] text-[var(--color-text-sub)]">Fetching the account snapshot…</p>}
        {broker?._cachedAt && (
          <p className="text-[9px] text-[var(--color-text-sub)]">snapshot {ago(broker._cachedAt)} — refreshing live…</p>
        )}
        {brokerErr && <p className="text-[9px] text-[var(--color-warning-text)]">{brokerErr}</p>}
        {dbOnlyPositions.length > 0 && (
          <p className="text-[9px] text-[var(--color-warning-text)] mb-1">
            ⚠ {dbOnlyPositions.length} position(s) marked active in the DB but not found at the broker: {' '}
            {dbOnlyPositions.map(r => r.symbol).join(', ')} — the reconciler closes these automatically on its next pass.
          </p>
        )}
        {(broker?.positions?.length ?? 0) > 0 && (
          <StdTradeTable
            rows={brokerPosRows}
            countLabel="open positions"
            marketHours={marketHours}
            onSymbolClick={(sym3) => { pickSymbol(sym3); pickGrid(1) }}
            panel={{ label: 'Manage', render: (row, close) => <PositionManager p={row.raw} onDone={() => { close(); load() }} /> }}
          />
        )}
        {(broker?.orders?.length ?? 0) > 0 && (
          <div className="mt-2">
            <div className="text-[9px] text-[var(--color-text-sub)] mb-1">Pending (set) orders</div>
            <StdTradeTable
              rows={brokerOrderRowsM}
              countLabel="pending orders"
              marketHours={marketHours}
              onSymbolClick={(sym3) => { pickSymbol(sym3); pickGrid(1) }}
              panel={{ label: 'Manage', render: (row, close) => <OrderManager o={row.raw} onDone={() => { close(); load() }} /> }}
            />
          </div>
        )}
        {broker && brokerFlat && (
          <p className="text-[9px] text-[var(--color-text-sub)]">Flat at the broker — no live positions or pending orders.</p>
        )}
      </Section>

      {/* TP-less open positions — owner: "a few of the open trades didn't set
          T/P that is dangerous." New market orders now require a Take Profit
          (guard_no_target), but positions opened before that guard, or
          adopted verbatim from a manual/foreign broker order, can still be
          SL-only. Read-only warning — nothing is closed or amended automatically. */}
      {(() => {
        const naked = brokerPosRows.filter(r => r.tp == null && !(r.tps?.length))
        if (naked.length === 0) return null
        return (
          <Card className="text-[9px] border-[var(--color-warning-text)]">
            <p className="font-semibold text-[var(--color-warning-text)]">
              ⚠ {naked.length} open position(s) have no Take Profit set — risk is capped by the stop, but nothing is locking in a target
            </p>
            <ul className="mt-1 space-y-0.5">
              {naked.slice(0, 8).map(r => (
                <li key={r.id} className="text-[var(--color-text-sub)]">
                  {r.symbol} {r.side === 'BUY' ? 'Long' : 'Short'} · entry {r.entry} · SL {r.sl ?? '—'}{r.source?.text === 'MANUAL' ? ' (manual/foreign position)' : ''}
                </li>
              ))}
            </ul>
            {naked.length > 8 && <p className="text-[9px] text-[var(--color-text-sub)] mt-0.5">+{naked.length - 8} more.</p>}
          </Card>
        )
      })()}

      {/* Weekend loss flags — losing positions the pre-closure sweep flagged
          (weekend-loss-flag.js) and deliberately left open: selling a loser
          into a thin pre-close market locks the worst price. The flags come
          from the sweep's own self-expiring markers, so this banner clears
          itself once the closure passes — read-only, nothing auto-closes. */}
      {weekendFlags.length > 0 && (
        <Card className="text-[9px] border-[var(--color-warning-text)]">
          <p className="font-semibold text-[var(--color-warning-text)]">
            ⚠ {weekendFlags.length} losing position(s) flagged ahead of a long market closure — left open per policy, review before the close
          </p>
          <ul className="mt-1 space-y-0.5">
            {weekendFlags.slice(0, 8).map(f => {
              const stillOpen = brokerPosRows.some(r => r.id === `bp-${f.positionId}`)
              return (
                <li key={f.positionId} className="text-[var(--color-text-sub)]">
                  {f.symbol} {f.side === 'SELL' ? 'Short' : 'Long'} · {f.movePct}% · entry {f.entry}{f.closureHrs ? ` · ${f.closureHrs}h closure` : ''}{stillOpen ? '' : ' (since closed)'}
                </li>
              )
            })}
          </ul>
          {weekendFlags.length > 8 && <p className="text-[9px] text-[var(--color-text-sub)] mt-0.5">+{weekendFlags.length - 8} more.</p>}
        </Card>
      )}

      {/* Durable SET-ORDER LEDGER — resting orders keep a lifecycle record even
          after they fill/cancel (and even while switches are OFF), so there's
          always a record of what was set and what became of it. */}
      {/* Duplicate-trade audit — owner spotted 7 identical AUDUSD rows at
          the same timestamp in the lessons panel (same symbol/side/entry/
          exit/net_pnl to the cent, essentially impossible for independent
          real fills). Read-only warning; nothing is deleted automatically. */}
      {(dupeTrades?.groups?.length ?? 0) > 0 && (
        <Card className="text-[9px] border-[var(--color-warning-text)]">
          <p className="font-semibold text-[var(--color-warning-text)]">
            ⚠ {dupeTrades.totalExtraRows} likely-duplicate closed trade record(s) found — inflating P&amp;L/win-rate stats by ~{dupeTrades.totalExtraPnl >= 0 ? '+' : '−'}${Math.abs(dupeTrades.totalExtraPnl).toFixed(2)}
          </p>
          <ul className="mt-1 space-y-0.5">
            {dupeTrades.groups.slice(0, 5).map((g, i) => (
              <li key={i} className="text-[var(--color-text-sub)]">
                {g.symbol} {g.side} entry {g.entry_price} → exit {g.exit_price} · net {g.net_pnl} · ×{g.count}{g.samePositionId ? ' (same broker position id — confirmed duplicate)' : ''}
              </li>
            ))}
          </ul>
          {dupeTrades.groups.length > 5 && <p className="text-[9px] text-[var(--color-text-sub)] mt-0.5">+{dupeTrades.groups.length - 5} more group(s).</p>}
        </Card>
      )}

      {/* Post-loss playback — the bot's homework after every losing trade:
          what did the market DO next, and what does that teach per strategy. */}
      <Section
        id="loss-review"
        title={`Trade lessons — losses & wins (${postmortems?.rows?.length ?? '…'})`}
        summary={(() => {
          const st = postmortems?.stats || []
          if (!st.length) return null
          const hunts = st.filter(s2 => s2.classification === 'stop_hunt').reduce((a, b) => a + b.n, 0)
          const wrong = st.filter(s2 => s2.classification === 'thesis_wrong').reduce((a, b) => a + b.n, 0)
          return `30d: ${hunts} stop-hunt · ${wrong} thesis-wrong`
        })()}
        defaultOpen={false}
      >
        {/* On-demand back-fill: sweep a big batch of unclassified closed
            trades now instead of waiting for the loop's 6-per-cycle pace. */}
        <div className="mb-2">
          <Button size="sm" variant="ghost" disabled={sweepBusy} onClick={async () => {
            setSweepBusy(true)
            try {
              const r = await agentPost('/actions/postmortem-sweep', { batch: 30 })
              setSweepNote(`swept: ${r.classified ?? 0} classified, ${r.waiting ?? 0} waiting${(r.tunerActive || []).length ? ` · tuner active: ${r.tunerActive.join(', ')}` : ''}`)
              load()
            } catch (e) { setSweepNote(`sweep failed: ${e.message}`) }
            setSweepBusy(false)
          }}>{sweepBusy ? 'Sweeping…' : 'Sweep lessons now'}</Button>
          {sweepNote && <span className="ml-2 text-[9px] text-[var(--color-text-sub)]">{sweepNote}</span>}
        </div>
        <LossReview postmortems={postmortems} />
      </Section>

      {/* MARKET PULSE — trending / herding / defended, per symbol.
          Owner 05-08-2026: "Create an algo to understand movements and big
          moves that give more awareness to the symbol trading and pending to
          trade." ADVISORY: it vetoes nothing, it tells you what the market is
          doing to the symbols you hold and the ones about to be entered. */}
      <Section
        id="pulse"
        title="Market pulse — trend, herd, or a level being held"
        summary={pulse?.builtAt
          ? `${Object.keys(pulse.readings || {}).length} symbols · ${(pulse.sharp || []).length} sharp · ${(pulse.defended || []).length} held · ${(pulse.divergences || []).length} divergence(s)`
          : null}
        defaultOpen={false}
      >
        {!pulse && <Skeleton lines={3} />}
        {pulse && !pulse.builtAt && (
          <p className="text-[9px] text-[var(--color-text-sub)]">
            Not computed yet — the pulse is written by the quant phase alongside the correlation matrix, from the same bars.
          </p>
        )}
        {pulse?.builtAt && (
          <div className="space-y-1.5 text-[9px]">
            <p className="text-[var(--color-text-sub)]">
              Read {ago(pulse.builtAt)} ago. Three independent measures per symbol: how DIRECTIONAL the move is, how big it is for
              this symbol over this span, and how much range it spent going nowhere. Advisory — nothing here refuses a trade.
            </p>

            {(pulse.divergences || []).length > 0 && (
              // The owner's own case, first: one leg of a correlated pair
              // held while the other runs.
              <div className="glass-inset rounded-lg p-2">
                <div className="font-semibold text-[var(--color-warning-text)]">Correlated pairs under stress</div>
                {pulse.divergences.slice(0, 6).map(d => (
                  <div key={`${d.held}|${d.running}`} className="mt-0.5">
                    <span className="font-semibold">{d.held}</span> held · <span className="font-semibold">{d.running}</span> running
                    <span className="text-[var(--color-text-sub)]"> (r {d.r > 0 ? '+' : ''}{d.r})</span>
                    <div className="text-[var(--color-text-sub)]">{d.note}</div>
                  </div>
                ))}
              </div>
            )}

            {(pulse.sharp || []).length > 0 && (
              <div>
                <span className="font-semibold">Sharp movers</span>
                <span className="text-[var(--color-text-sub)]"> — the span where the RATE changed, not merely a steep one: </span>
                {pulse.sharp.slice(0, 10).map(m => (
                  <span key={m.symbol} className="mr-2 tabular-nums">
                    {m.symbol} <span className={`font-semibold ${m.netPct >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>{m.netPct > 0 ? '+' : ''}{m.netPct}%</span>
                    <span className="text-[var(--color-text-sub)]"> {m.sigma > 0 ? '+' : ''}{m.sigma}σ</span>
                  </span>
                ))}
              </div>
            )}

            {(pulse.defended || []).length > 0 && (
              <div>
                <span className="font-semibold">Levels being held</span>
                <span className="text-[var(--color-text-sub)]"> — a lot of range bought no distance; a net-change column reads these as calm: </span>
                {pulse.defended.slice(0, 10).map(m => (
                  <span key={m.symbol} className="mr-2 tabular-nums">{m.symbol} <span className="text-[var(--color-text-sub)]">{m.netPct > 0 ? '+' : ''}{m.netPct}%</span></span>
                ))}
              </div>
            )}

            {(pulse.herds || []).filter(h => h.moving).length > 0 && (
              <div>
                <span className="font-semibold">Herds on the move</span>
                <span className="text-[var(--color-text-sub)]"> — a position in any member is a position in all of them: </span>
                {pulse.herds.filter(h => h.moving).slice(0, 5).map((h, i) => (
                  <div key={i} className="text-[var(--color-text-sub)]">
                    {h.dir > 0 ? '↑' : '↓'} {h.n} symbols, {Math.round(h.agreement * 100)}% agreeing: {(h.members || []).join(' · ')}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      {/* Correlation-symbols controller — the cluster exposure the risk gate
          vetoes on, made visible (owner: "when are you going to use all the
          correlation-symbols controller"). */}
      <Section
        id="correlation"
        title="Correlation clusters — shared-bet exposure"
        summary={correlation ? `cap ±${correlation.maxClusterExposure} per cluster · ccy cap ±${correlation.maxCurrencyExposure}` : null}
        defaultOpen={false}
      >
        {!correlation && <Skeleton lines={3} />}
        {correlation && (
          <div className="space-y-1.5">
            <p className="text-[9px] text-[var(--color-text-sub)]">
              Positions in the same cluster are the SAME macro bet. The risk gate vetoes any entry pushing a cluster's net beyond ±{correlation.maxClusterExposure}. Net is signed: +2 long-USD means two full USD-strength bets stacked.
            </p>
            {(correlation.clusters || []).map(c => (
              <div key={c.key} className="glass-inset rounded-lg p-2 text-[9px]">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{c.label}</span>
                  <span className={`font-bold ${Math.abs(c.net) >= correlation.maxClusterExposure ? 'text-[var(--color-down)]' : ''}`}>
                    net {c.net > 0 ? '+' : ''}{c.net}
                  </span>
                  {Math.abs(c.net) >= correlation.maxClusterExposure && <span className="text-[9px] font-semibold text-[var(--color-down)]">AT CAP — new entries in this cluster veto</span>}
                </div>
                <div className="text-[9px] text-[var(--color-text-sub)]">
                  {c.held.length ? `holding: ${c.held.join(' · ')}` : 'no open positions in this cluster'}
                </div>
                <div className="text-[9px] text-[var(--color-text-sub)] mt-0.5">
                  members: {Object.entries(c.members).map(([s2, b]) => `${s2}${b > 0 ? '+' : '−'}`).join(' ')}
                </div>
              </div>
            ))}
            {/* THE LIVE MATRIX, not just its timestamp. Owner 05-08-2026:
                "The correlation card doesn't update when market shifted." The
                clusters above are HAND-WRITTEN and by construction never
                change; the rolling matrix is the part that reacts, and until
                now the only thing that reached this card from it was a
                timestamp and a symbol count. */}
            <div className="glass-inset rounded-lg p-2 text-[9px] space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">Rolling live matrix</span>
                {correlation.liveMatrix?.builtAt
                  ? <span className="text-[var(--color-text-sub)]">{ago(correlation.liveMatrix.builtAt)} ago · {correlation.liveMatrix.symbols} symbols · |r| ≥ {correlation.liveMatrix.config?.threshold} counts as stacked</span>
                  : <span className="text-[var(--color-text-sub)]">not computed yet</span>}
                {correlation.liveMatrix?.stale && (
                  // Not cosmetic: liveCorrelationVeto FAILS OPEN past
                  // maxAgeMin, so a stale matrix means the live correlation
                  // cap is not being enforced at all right now.
                  <span className="font-bold text-[var(--color-down)]"
                    title={`Older than maxAgeMin (${correlation.liveMatrix.config?.maxAgeMin}m) — the live correlation cap fails OPEN while it is stale, so stacked-bet entries are not being blocked by it`}>
                    STALE — live correlation cap not enforcing
                  </span>
                )}
              </div>

              {(correlation.liveMatrix?.shifts?.length ?? 0) > 0 && (
                <div>
                  <div className="font-semibold text-[var(--color-warning-text)]">
                    Shifted since {correlation.liveMatrix.previousBuiltAt ? `${ago(correlation.liveMatrix.previousBuiltAt)} ago` : 'the previous matrix'}
                  </div>
                  {correlation.liveMatrix.shifts.slice(0, 8).map(sh => (
                    <div key={`${sh.a}|${sh.b}`} className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold">{sh.a}/{sh.b}</span>
                      <span className="tabular-nums text-[var(--color-text-sub)]">{sh.was} → {sh.r}</span>
                      <span className={`tabular-nums font-semibold ${sh.delta > 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                        {sh.delta > 0 ? '+' : ''}{sh.delta}
                      </span>
                      {sh.flipped && <span className="font-bold text-[var(--color-down)]" title="The sign inverted while both readings were above threshold — every stacked position in this pair now means the opposite of what it did">FLIPPED</span>}
                      {sh.became && <span className="font-semibold text-[var(--color-down)]" title="Was diversified, now stacks — two positions here are one bet that were not before">NOW STACKS</span>}
                      {sh.broke && <span className="font-semibold" title="Was a hedge, no longer moves together — the offset you were relying on has gone">HEDGE BROKE</span>}
                    </div>
                  ))}
                  {correlation.liveMatrix.shifts.length > 8 && (
                    <div className="text-[var(--color-text-sub)]">+{correlation.liveMatrix.shifts.length - 8} more moved by ≥0.25</div>
                  )}
                </div>
              )}
              {correlation.liveMatrix?.builtAt && (correlation.liveMatrix.shifts?.length ?? 0) === 0 && (
                <div className="text-[var(--color-text-sub)]">
                  {correlation.liveMatrix.previousBuiltAt
                    ? 'Nothing moved by 0.25 or more since the previous matrix — the relationships below are holding.'
                    : 'No previous matrix to compare against yet — shifts appear after the next rebuild.'}
                </div>
              )}

              {(correlation.liveMatrix?.pairs?.length ?? 0) > 0 && (
                <div>
                  <div className="font-semibold">Strongest pairs now</div>
                  <div className="flex flex-wrap gap-x-3">
                    {correlation.liveMatrix.pairs.slice(0, 12).map(p2 => (
                      <span key={`${p2.a}|${p2.b}`} className="tabular-nums">
                        {p2.a}/{p2.b}{' '}
                        <span className={`font-semibold ${Math.abs(p2.r) >= (correlation.liveMatrix.config?.threshold ?? 0.7) ? 'text-[var(--color-down)]' : 'text-[var(--color-text-sub)]'}`}>
                          {p2.r > 0 ? '+' : ''}{p2.r}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-[var(--color-text-sub)]">Caps tunable in Tune → Risk (cluster / currency exposure).</p>
            </div>
          </div>
        )}
      </Section>

      <Section
        id="order-ledger"
        title={`Set-order ledger — records (${orders ? `${orders.working?.length ?? 0} at broker · ${orders.queued?.length ?? 0} queued` : '…'})`}
        summary={orders?.recentlyGone?.length ? `${orders.recentlyGone.length} filled/cancelled in 24h` : null}
        defaultOpen={false}
      >
        <OrderLedger orders={orders} onChanged={load} />
      </Section>

      <Section
        id="closed7d"
        title="Closed at the broker"
        summary={(() => {
          if (brokerHistory?.realized == null) return null
          let s2 = `realised ${brokerHistory.realized >= 0 ? '+' : ''}${fmt(brokerHistory.realized, 2)} · ${brokerHistory.rows?.length ?? 0} deals`
          // Best/worst contributor — the read a CTO wants before the rows.
          const rows2 = (brokerHistory.rows || []).filter(d => d.netPnl != null)
          if (rows2.length >= 2) {
            const best = rows2.reduce((a, b) => (b.netPnl > a.netPnl ? b : a))
            const worst = rows2.reduce((a, b) => (b.netPnl < a.netPnl ? b : a))
            s2 += ` · best ${best.symbol} +${fmt(Math.abs(best.netPnl), 2)} · worst ${worst.symbol} −${fmt(Math.abs(worst.netPnl), 2)}`
          }
          return s2
        })()}
        defaultOpen={false}
      >
        {/* Window picker (owner: "should also include 30 days and 3+6
            months") — switching re-fetches broker-history at that window. */}
        <div className="mb-1.5">
          <Segmented label="History window" value={historyDays} onChange={setHistoryDays}
            options={[{ value: 7, label: '7d' }, { value: 30, label: '30d' }, { value: 90, label: '3mo' }, { value: 182, label: '6mo' }]} />
        </div>
        {!brokerHistory && <p className="text-[9px] text-[var(--color-text-sub)]">Fetching deal history…</p>}
        {brokerHistory?._cachedAt && (
          <p className="text-[9px] text-[var(--color-text-sub)]">history {ago(brokerHistory._cachedAt)} — refreshing live…</p>
        )}
        {(brokerHistory?.rows?.length ?? 0) > 0 && (
          <StdTradeTable rows={brokerDealRows(brokerHistory.rows, { rates: rateMap })} countLabel="closed deals" marketHours={marketHours} onSymbolClick={(sym3) => { pickSymbol(sym3); pickGrid(1) }} />
        )}
        {brokerHistory && brokerHistory.rows?.length === 0 && (
          <p className="text-[9px] text-[var(--color-text-sub)]">Nothing closed in the last {historyDays === 7 ? '7 days' : historyDays === 30 ? '30 days' : historyDays === 90 ? '3 months' : '6 months'}.</p>
        )}
        <p className="mt-1 text-[9px] text-[var(--color-text-sub)]">Net includes swap + commission — same figures as cTrader's History tab, manual trades included.</p>
      </Section>

      <Section
        id="risk"
        title="Risk decisions"
        summary={events.length ? `${events.filter(e => !e.approved).length} vetoes in last ${events.length}` : null}
        defaultOpen={false}
      >
        <p className="text-[9px] text-[var(--color-text-sub)] mb-1">
          Every signal the scanner considers trading passes through here.{' '}
          <span className="font-semibold text-[var(--color-accent)]">OK</span> = the risk gate approved it (it still
          has to clear broker sizing/spread checks after — OK is not the same as placed);{' '}
          <span className="font-semibold text-[var(--color-warning-text)]">VETO</span> = risk math said no, with why.
        </p>
        {events.length === 0 && <p className="text-[9px] text-[var(--color-text-sub)]">None yet.</p>}
        {/* Plain rows, trader words — status is text with colour, not a pill;
            the raw machine code stays in the tooltip. Side/strategy/entry
            from proposal_json so a row reads as a decision, not just a
            symbol + cryptic code (owner: "meaningless to me"). */}
        {/* Each row expands to the full criteria breakdown from checks_json —
            side/strategy/entry from proposal_json (owner: "meaningless to me"),
            and the complete multi-criteria evaluation on click (owner: "Risk
            Decision is so superficial ... more than one criteria"). */}
        <ul className="text-[9px]">
          {events.slice(0, 10).map(ev => (
            <RiskDecisionRow key={ev.id} ev={ev} />
          ))}
        </ul>
        <p className="mt-1 text-[9px] text-[var(--color-text-sub)]">
          Full history on the <Link to="/trade" className="text-[var(--color-accent)] underline">Trade</Link> tab.
        </p>
      </Section>

      {/* Per-account engineering status (owner: "The desk page should display
          the underlying engineering status for each account you are trading or
          not trading"). Sits beside Controllers on purpose: that panel is
          health per CONTROLLER, this one is health per ACCOUNT. */}
      <AccountEngineering />

      {/* Controllers — heartbeat reliability: every background controller's
          last beat, plus the C++ exec engine's probed liveness. A stalled
          controller is a positions-unmanaged incident, so it also alerts on
          Telegram; this panel is the always-on visual. */}
      <Section
        id="controllers"
        title="Controllers — heartbeats"
        summary={(() => {
          if (!heartbeats) return null
          const bad = heartbeats.filter(c => c.status === 'stalled' || c.status === 'error').length
          const live = heartbeats.filter(c => c.status === 'ok' || c.status === 'warn').length
          return bad ? `${bad} STALLED/FAILING` : `${live} beating`
        })()}
        defaultOpen={false}
      >
        {/* Live wall clock — ticks every second so the panel itself proves the
            page is live, independent of any controller's own beat. */}
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[9px] text-[var(--color-text-sub)]">Now</span>
          <SplitFlapClock tickLive className="text-[9px]" />
        </div>
        {!heartbeats && <p className="text-[9px] text-[var(--color-text-sub)]">No data yet.</p>}
        {heartbeats && (
          // Two-column dot grid — half the height of the old pill list; a
          // healthy controller earns a dot, only trouble earns words.
          <ul className="text-[9px] grid gap-x-6 sm:grid-cols-2">
            {heartbeats.map(c => {
              const dot = c.status === 'ok' ? 'var(--color-accent)' : c.status === 'warn' ? '#c2410c' : c.status === 'idle' ? '#94a3b8' : 'var(--color-down)'
              return (
                <li key={c.name} className="flex items-baseline gap-1.5 min-w-0 py-px" title={c.status === 'idle' ? 'never ran (not armed / not applicable)' : `${c.status} · last beat ${c.last_run_at ?? '—'} · ${c.age_sec ?? '?'}s ago`}>
                  <span aria-hidden="true" style={{ color: dot }}>●</span>
                  <span className="font-semibold shrink-0">{c.label}</span>
                  {(c.status === 'stalled' || c.status === 'error' || c.consecutive_failures > 0) && (
                    <span className="text-[var(--color-down)] truncate">
                      {c.status.toUpperCase()}{c.consecutive_failures > 0 ? ` · ${c.consecutive_failures} failing` : ''}{c.last_error ? ` · ${c.last_error}` : ''}
                    </span>
                  )}
                  {/* Owner: "I need to know you are active ... not a feature or
                      blinking, show that network interaction" — a relative
                      timestamp alone can look static between polls; the run
                      COUNT only ever climbs, so it's undeniable proof this
                      controller keeps firing, not a hardcoded dot. Last-beat
                      time now renders as a split-flap HH:MM:SS (airport-board
                      flip on change) instead of a plain "ago" string. */}
                  <span className="ml-auto flex items-center gap-1.5 text-[var(--color-text-sub)] shrink-0">
                    {c.status === 'idle'
                      ? 'idle'
                      : <>
                          <SplitFlapClock iso={c.last_run_at} title={`last beat ${c.last_run_at ?? '—'} (${ago(c.last_run_at)} ago)`} />
                          <span>· {(c.runs ?? 0).toLocaleString()} runs</span>
                        </>}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        <p className="mt-1 text-[9px] text-[var(--color-text-sub)]">
          A beat means the controller's code ran (even if it chose to do nothing). Stalls alert on Telegram once, and once again on recovery.
        </p>
      </Section>

      {/* LLM spend — the no-bill-shock dashboard: real token usage priced
          in USD (today/7d/30d + projection), with an owner-set daily cap
          that alerts on Telegram once per day when crossed. */}
      <Section
        id="llmspend"
        title="LLM spend"
        summary={llmSpend ? `today $${(llmSpend.today?.cost_usd ?? 0).toFixed(2)} · ~$${(llmSpend.projected_month_usd ?? 0).toFixed(2)}/mo` : null}
        defaultOpen={false}
      >
        {!llmSpend && <p className="text-[9px] text-[var(--color-text-sub)]">No data yet.</p>}
        {llmSpend && (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[9px] tabular-nums mb-2">
              <span>Today <span className="font-semibold">${(llmSpend.today?.cost_usd ?? 0).toFixed(2)}</span> · {llmSpend.today?.calls ?? 0} calls</span>
              <span>7 days <span className="font-semibold">${(llmSpend.last7d?.cost_usd ?? 0).toFixed(2)}</span></span>
              <span>30 days <span className="font-semibold">${(llmSpend.last30d?.cost_usd ?? 0).toFixed(2)}</span></span>
              <span>Projected month <span className="font-semibold">${(llmSpend.projected_month_usd ?? 0).toFixed(2)}</span></span>
            </div>
            {(llmSpend.by_purpose?.length ?? 0) > 0 && (
              <div className="overflow-x-auto">
                <Collapse id="Desk_957" label="Spend by Purpose Rows">
                <table className="std-cols w-full text-[9px] tabular-nums">
                  <thead>
                    <tr className="border-b border-[var(--color-border)]">
                      <th className="py-1 pr-3">Purpose</th>
                      <th className="py-1 pr-3">Model</th>
                      <th className="py-1 pr-3 text-right">Calls</th>
                      <th className="py-1 pr-3 text-right">In</th>
                      <th className="py-1 pr-3 text-right">Out</th>
                      <th className="py-1 text-right">Est. cost (30d)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {llmSpend.by_purpose.map(p2 => (
                      <tr key={`${p2.purpose}|${p2.model}`} className="border-b border-[var(--color-border)]">
                        <td className="py-1 pr-3">{p2.purpose}</td>
                        <td className="py-1 pr-3 text-[var(--color-text-sub)]">{p2.model}</td>
                        <td className="py-1 pr-3 text-right">{p2.calls.toLocaleString()}</td>
                        <td className="py-1 pr-3 text-right">{p2.input_tokens.toLocaleString()}</td>
                        <td className="py-1 pr-3 text-right">{p2.output_tokens.toLocaleString()}</td>
                        <td className="py-1 text-right">${p2.cost_usd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </Collapse>
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="block text-[9px]">
                <span className="text-[var(--color-text-sub)]">Daily cost alert (USD, 0 = off) — currently {llmSpend.daily_cap_usd ? `$${llmSpend.daily_cap_usd}` : 'off'}</span>
                <Input type="number" step="0.1" min="0" value={capDraft} onChange={e => setCapDraft(e.target.value)} placeholder={llmSpend.daily_cap_usd ? String(llmSpend.daily_cap_usd) : 'e.g. 1.00'} className="w-28" />
              </label>
              <Button
                size="sm" variant="subtle"
                onClick={async () => {
                  try {
                    const r = await agentPost('/actions/llm-budget', { dailyCapUsd: capDraft === '' ? 0 : Number(capDraft) })
                    setCapNote(r.dailyCapUsd ? `Alert armed at $${r.dailyCapUsd}/day.` : 'Alert disarmed.')
                    await load()
                  } catch (e) { setCapNote(e.message) }
                }}
              >Save cap</Button>
              {capNote && <span className="text-[9px] text-[var(--color-text-sub)]">{capNote}</span>}
            </div>
            <p className="mt-1 text-[9px] text-[var(--color-text-sub)]">
              Scanning, backtests, and all trading decisions are deterministic — zero tokens. The only LLM consumers are the position monitor and the weekend watch, priced at published per-model rates (estimates, not the invoice).
            </p>
          </>
        )}
      </Section>

      {/* Edge health — banded perspectives: the auto-bot's live edge,
          signal decay, the owner's backtest baseline, and the advisory/
          committed response list — every verdict evidential, every action
          one link from its setting. No "unknown": unlabelled trades are
          explained by source. */}
      <Section
        id="alphadecay"
        title="Edge health"
        summary={(() => {
          if (!alphaDecay) return null
          const bad = (alphaDecay.strategies || []).filter(s2 => s2.trend === 'decaying').length
          const adv = (alphaDecay.advisories || []).length
          return bad ? `${bad} DECAYING · ${adv} advisories` : `${alphaDecay.total_closed ?? 0} trades · ${adv} advisories`
        })()}
        defaultOpen={false}
      >
        {!alphaDecay && <p className="text-[9px] text-[var(--color-text-sub)]">No data yet.</p>}
        {alphaDecay && (
          <>
            {/* Band 1 — the auto-bot's LIVE edge */}
            <div className="flex items-center gap-2 mb-1">
              <div className="text-[9px] font-semibold">Live edge — auto-bot</div>
              {/* Owner: "every trade must have a purpose for the edge" — the
                  unlabelled/autopilot bucket is mostly trades whose broker
                  label lost attribution before a strategy's key existed
                  (permanent, broker-side). This recovers what it can from
                  each trade's own thesis text — a real fingerprint, not a
                  guess — and leaves anything unmatched alone. */}
              <Button size="sm" variant="ghost" disabled={labelBackfillBusy} onClick={async () => {
                setLabelBackfillBusy(true)
                try {
                  const r = await agentPost('/actions/backfill-label-strategy', {})
                  const by = Object.entries(r.byStrategy || {}).map(([k, v]) => `${k}: ${v}`).join(', ')
                  setLabelBackfillNote(`recovered ${r.updated ?? 0} of ${r.scanned ?? 0} unlabelled autopilot trade(s)${by ? ` (${by})` : ''}`)
                  load()
                } catch (e) { setLabelBackfillNote(`failed: ${e.message}`) }
                setLabelBackfillBusy(false)
              }}>{labelBackfillBusy ? 'Recovering…' : 'Recover strategy labels'}</Button>
              {labelBackfillNote && <span className="text-[9px] text-[var(--color-text-sub)]">{labelBackfillNote}</span>}
            </div>
            {(alphaDecay.strategies?.length ?? 0) === 0 && (
              <p className="text-[9px] text-[var(--color-text-sub)]">No closed trades yet — decay is measured from live results; <Link to="/tune" className="text-[var(--color-accent)] underline">arm burn-in in Tune</Link> to build the sample fastest.</p>
            )}
            {(alphaDecay.strategies?.length ?? 0) > 0 && (
              <div className="overflow-x-auto">
                <Collapse id="Desk_1052" label="Strategy Decay Rows">
                <table className="std-cols w-full text-[9px] tabular-nums">
                  <thead>
                    <tr className="border-b border-[var(--color-border)]">
                      <th aria-sort={edgeSort.ariaSort('strategy')} className="py-1 pr-3">{edgeSort.sortBtn('strategy', 'Strategy')}</th>
                      <th className="py-1 pr-3">Status</th>
                      <th aria-sort={edgeSort.ariaSort('net')} className="py-1 pr-3 text-right">{edgeSort.sortBtn('net', 'Net P&L')}</th>
                      <th aria-sort={edgeSort.ariaSort('win')} className="py-1 pr-3 text-right">{edgeSort.sortBtn('win', 'Win %')}</th>
                      <th aria-sort={edgeSort.ariaSort('trades')} className="py-1 pr-3 text-right">{edgeSort.sortBtn('trades', 'Trades')}</th>
                      <th aria-sort={edgeSort.ariaSort('streak')} className="py-1 pr-3">{edgeSort.sortBtn('streak', 'Streak')}</th>
                      <th aria-sort={edgeSort.ariaSort('trend')} className="py-1 pr-3">{edgeSort.sortBtn('trend', 'Trend')}</th>
                      <th aria-sort={edgeSort.ariaSort('recent')} className="py-1 pr-3 text-right">{edgeSort.sortBtn('recent', 'Recent exp.')}</th>
                      <th aria-sort={edgeSort.ariaSort('delta')} className="py-1 text-right">{edgeSort.sortBtn('delta', 'Δ')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {edgeSort.sorted.map(s2 => {
                      const un = s2.strategy === 'unlabelled'
                      const srcNote = un && alphaDecay.unlabelled
                        ? Object.entries(alphaDecay.unlabelled.sources).map(([k, v]) => `${k}: ${v}`).join(' · ')
                        : null
                      const traded = (s2.total?.n ?? 0) > 0
                      return (
                        <tr key={s2.strategy} className="border-b border-[var(--color-border)]">
                          <td className="py-1 pr-3">
                            {un
                              ? <span title={`Trades without a strategy label — ${srcNote}. These are YOUR manual trades, test fills and adopted broker fills, scored separately so bot strategies stay clean.`}>{s2.name || 'unlabelled'} <span className="font-normal text-[var(--color-text-sub)]">({srcNote})</span></span>
                              : <Link to={`/tune?tab=pipeline&arm=${encodeURIComponent(s2.strategy)}`} className="underline underline-offset-2" title="Open the Pipeline matrix and jump straight to this strategy's Auto Trade cell — tap to arm/disarm">{STRAT_SHORT[s2.strategy] || s2.strategy}{!s2.armed && <span className="ml-1 text-[var(--color-accent)]">→ arm</span>}</Link>}
                          </td>
                          {/* Status justifies WHY a row reads as it does (owner: "include
                              all strategy and justify") — armed vs off, and whether it's
                              even traded yet, so a losing armed strategy and an idle
                              unarmed one never look the same. */}
                          <td className="py-1 pr-3">
                            {un
                              ? <span className="text-[var(--color-text-sub)]">manual</span>
                              : <Badge tone={s2.armed ? 'on' : 'off'}>{s2.armed ? 'ARMED' : 'OFF'}</Badge>}
                          </td>
                          <td className={`py-1 pr-3 text-right ${!traded ? 'text-[var(--color-text-sub)]' : s2.netPnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                            {traded ? `${s2.netPnl >= 0 ? '+' : '−'}$${Math.abs(s2.netPnl).toFixed(2)}` : '—'}
                          </td>
                          <td className="py-1 pr-3 text-right">{traded && s2.winRate != null ? `${Math.round(s2.winRate * 100)}%` : '—'}</td>
                          <td className="py-1 pr-3 text-right">{s2.total?.n ?? 0}</td>
                          <td className={`py-1 pr-3 ${s2.streak?.kind === 'win' ? 'text-[var(--color-up)]' : s2.streak?.kind === 'loss' ? 'text-[var(--color-down)]' : 'text-[var(--color-text-sub)]'}`}>
                            {s2.streak?.n ? `${s2.streak.n} ${s2.streak.n > 1 ? (s2.streak.kind === 'loss' ? 'losses' : 'wins') : s2.streak.kind}` : '—'}
                          </td>
                          <td className="py-1 pr-3">
                            {!traded
                              ? <span className="text-[var(--color-text-sub)]">{s2.armed ? 'no trades yet' : 'idle'}</span>
                              : <Badge tone={s2.trend === 'improving' ? 'up' : s2.trend === 'decaying' ? 'down' : 'neutral'}>
                                  {s2.trend === 'insufficient' ? `NEED ${alphaDecay.window}+` : s2.trend.toUpperCase()}
                                </Badge>}
                          </td>
                          <td className="py-1 pr-3 text-right">{s2.recent?.expectancy != null ? `$${s2.recent.expectancy.toFixed(2)}` : '—'}</td>
                          <td className={`py-1 text-right ${s2.delta == null ? '' : s2.delta >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                            {s2.delta != null ? `${s2.delta >= 0 ? '+' : ''}${s2.delta.toFixed(2)}` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </Collapse>
              </div>
            )}

            {/* Band 2 — signal decay */}
            <div className="text-[9px] font-semibold mt-3 mb-1">Signal decay — fills vs their signals</div>
            {(alphaDecay.lag_sampled ?? 0) > 0
              ? (
                <p className="text-[9px] tabular-nums">
                  {alphaDecay.entry_lag.map(b2 => (
                    <span key={b2.key} className="mr-3">{b2.label}: <span className="font-semibold">{b2.expectancy != null ? `$${b2.expectancy.toFixed(2)}` : '—'}</span> ({b2.n})</span>
                  ))}
                  <span className="text-[var(--color-text-sub)]"> — if slow fills earn less, tighten the <Link to="/tune" className="text-[var(--color-accent)] underline">monitor cadence in Tune</Link>.</span>
                </p>
              )
              : <p className="text-[9px] text-[var(--color-text-sub)]">Needs trades that carry their signal timestamp — fills from scanned signals populate this automatically.</p>}

            {/* Band 3 — the OWNER's edge as backtested (per strategy) */}
            <div className="text-[9px] font-semibold mt-3 mb-1">Your edge — backtest baseline</div>
            {curBaseline
              ? (
                <>
                  {backtestsList.length > 1 && (
                    <div className="mb-1.5">
                      <Segmented label="Backtested strategy" value={curBaseline.strategy} onChange={setBaselineStrat}
                        options={backtestsList.map(b => ({ value: b.strategy, label: STRAT_SHORT[b.strategy] || b.strategy }))} />
                    </div>
                  )}
                  <div className="overflow-x-auto">
                    <Collapse id="Desk_1146" label="Backtest Rows">
                    <table className="std-cols w-full text-[9px] tabular-nums">
                      <thead>
                        <tr className="border-b border-[var(--color-border)]">
                          <th aria-sort={baseSort.ariaSort('combo')} className="py-1 pr-3">{baseSort.sortBtn('combo', 'Combo')}</th>
                          <th aria-sort={baseSort.ariaSort('trades')} className="py-1 pr-3 text-right">{baseSort.sortBtn('trades', 'Trades')}</th>
                          <th aria-sort={baseSort.ariaSort('pf')} className="py-1 pr-3 text-right">{baseSort.sortBtn('pf', 'PF')}</th>
                          <th aria-sort={baseSort.ariaSort('win')} className="py-1 pr-3 text-right">{baseSort.sortBtn('win', 'Win %')}</th>
                          <th aria-sort={baseSort.ariaSort('total')} className="py-1 text-right">{baseSort.sortBtn('total', 'Total %')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {baseSort.sorted.slice(0, 10).map(c2 => (
                          <tr key={`${c2.symbol}|${c2.tf}`} className="border-b border-[var(--color-border)]">
                            <td className="py-1 pr-3">{c2.symbol} · {c2.tf}</td>
                            <td className="py-1 pr-3 text-right">{c2.trades}</td>
                            <td className={`py-1 pr-3 text-right ${(c2.profitFactor ?? 0) > 1 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>{c2.profitFactor != null ? c2.profitFactor.toFixed(2) : '∞'}</td>
                            <td className="py-1 pr-3 text-right">{c2.winRatePct != null ? `${c2.winRatePct.toFixed(0)}%` : '—'}</td>
                            <td className={`py-1 text-right ${(c2.totalProfitPct ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>{c2.totalProfitPct != null ? `${c2.totalProfitPct.toFixed(1)}%` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </Collapse>
                  </div>
                  <p className="mt-1 text-[9px] text-[var(--color-text-sub)]">
                    {strategyLabel(curBaseline.strategy)} · tested {ago(curBaseline.ranAt)} ago{curBaseline.combos.length > 10 ? ` · showing 10 of ${curBaseline.combos.length} combos` : ''}{backtestsList.length > 1 ? ` · ${backtestsList.length} strategies tested` : ''} — <Link to="/tune" className="text-[var(--color-accent)] underline">re-run in Tune</Link> after strategy or filter changes.
                  </p>
                </>
              )
              : <p className="text-[9px] text-[var(--color-text-sub)]">No baseline stored yet — <Link to="/tune" className="text-[var(--color-accent)] underline">run a backtest in Tune</Link> and your tested edge will appear here for live-vs-tested comparison.</p>}

            {/* Band 4 — advisory vs committed: what YOU should look at, and
                what the machine will do on its own. AI trading = evidential
                response to streaks, not hope. */}
            <div className="text-[9px] font-semibold mt-3 mb-1">
              Advisories &amp; committed automation
              <span className="ml-2 font-normal text-[var(--color-text-sub)]">breaker {alphaDecay.breaker?.on ? `ARMED at ${alphaDecay.breaker.streak} straight losses` : 'OFF'} · <Link to="/tune" className="text-[var(--color-accent)] underline">change</Link></span>
            </div>
            {(alphaDecay.advisories?.length ?? 0) === 0 && <p className="text-[9px] text-[var(--color-text-sub)]">Nothing needs attention — edges holding, automation armed.</p>}
            <ul className="text-[9px] space-y-1">
              {(alphaDecay.advisories || []).map((a, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <Badge tone={a.level === 'committed' ? 'info' : 'warning'}>{a.level === 'committed' ? 'COMMITTED' : 'ADVISORY'}</Badge>
                  <span className="min-w-0">{a.text} {a.link && <Link to={a.link} className="text-[var(--color-accent)] underline whitespace-nowrap">open {a.link === '/trade' ? 'Trade' : 'Tune'} →</Link>}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[9px] text-[var(--color-text-sub)]">
              Expectancy = average net PnL per trade; "recent vs prior" compares the last {alphaDecay.window} trades against the {alphaDecay.window} before them, per strategy. ADVISORY = your call, with the evidence. COMMITTED = the adaptive breaker acts on its own at the stated threshold.
            </p>
          </>
        )}
      </Section>

      {/* Why no trades — only when genuinely flat; the product explains
          itself instead of looking dead. */}
      {health && brokerFlat && positions.length === 0 && (
        <Section id="whynotrades" title="Why No Trades Right Now? card">
          <ul className="text-[9px] space-y-1 list-disc pl-5">
            {equityStopToday && <li className="font-semibold text-[var(--color-down)]">The daily equity stop tripped today — autotrade disarmed itself after the daily loss cap was hit. It stays off until you re-arm it on <Link to="/tune" className="underline">Tune</Link>.</li>}
            {!health.autotradeEnabled && !equityStopToday && <li className="font-semibold text-[var(--color-down)]">Autotrade is OFF — the bot never places orders. <Link to="/tune" className="underline">Activate on Tune</Link>.</li>}
            {health.autotradeEnabled && health.scanEnabled === false && <li className="font-semibold text-[var(--color-down)]">Scan is OFF — the bot cannot see the market. <Link to="/tune" className="underline">Turn it on in Tune</Link>.</li>}
            {health.autotradeEnabled && health.scanEnabled !== false && (() => {
              const found = scans.filter(r => r.bias && r.bias !== 'skip')
              const noZone = scans.length - found.length
              return (
                <>
                  {noZone > 0 && <li>{noZone} of {scans.length} watchlist symbols have no setup on ANY scanned strategy right now (fib zone, cup &amp; handle, EMA pullback, breakout, RSI stretch) — nothing exists to trade.</li>}
                  {found.map(r => <li key={r.symbol}>{r.symbol}: {STRAT_SHORT[r.strategy] || 'FIB'} {String(r.bias).toUpperCase()} signal on {r.timeframe || '?'} at {r.confidence ?? '?'}/10 — waiting on the armed-timeframe and risk gates.</li>)}
                  <li className="text-[var(--color-text-sub)]">
                    Expected pace on {(armed?.timeframes || []).join('/') || 'the armed timeframes'}: roughly 1–2 qualifying trades per month per symbol — a quiet screen for days is the strategy working, not failing. Telegram announces the moment anything changes.
                  </li>
                </>
              )
            })()}
          </ul>
        </Section>
      )}

      {/* Performance moved to its own page (owner: "move the performance
          in the desk to a page by its own") — /performance now leads the
          nav with the full timeframe × market × account ledger. */}
    </div>
  )
}
