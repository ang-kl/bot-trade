// Tune — every knob a trader can turn, in one place:
// pipeline toggles, autotrade timeframes, risk limits + account, watchlist,
// backtest, presets. Folio tabs (one panel at a time) — no long scroll.
import { useEffect, useState, useCallback } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import Input from '../components/common/Input.jsx'
import FolioTabs from '../components/common/FolioTabs.jsx'
import { SliderInput, PresetSelect } from '../components/common/FormControls.jsx'
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'
import { NATIVE_TF_MS, parseTimeframe, tfMs } from '../lib/timeframes.js'

// Native broker timeframes power the quick-pick menu; free-text (90m, 1.5h,
// 2d, 1M) is parsed by src/lib/timeframes.js and synthesised agent-side.
const TF_MS = NATIVE_TF_MS
const ALL_TIMEFRAMES = [...Object.keys(TF_MS)].sort((a, b) => tfMs(b) - tfMs(a))
const byTfDesc = (a, b) => tfMs(b) - tfMs(a)

const TABS = [
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'risk', label: 'Risk' },
  { id: 'watchlist', label: 'Watchlist' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'presets', label: 'Presets' },
]

// Risk fields exposed for editing: [key, label, hint]
const RISK_FIELDS = [
  ['perTradeRiskPct', 'Risk per trade', 'fraction of balance, e.g. 0.01 = 1%'],
  ['dailyLossPct', 'Daily loss cap', 'fraction of balance, e.g. 0.03 = 3%'],
  ['minRR', 'Min risk:reward', 'trades below this R:R are vetoed'],
  ['maxOpenPositions', 'Max open positions', 'hard cap on concurrent positions'],
  ['symbolCooldownMinutes', 'Symbol cooldown', 'lock a symbol after any closed trade'],
  ['maxConsecutiveLosses', 'Loss streak limit', 'losses in a row before cooldown'],
  ['cooldownMinutes', 'Streak cooldown', 'pause after hitting the streak'],
  ['minSLDistancePct', 'Min SL distance', 'stops tighter than this % are vetoed'],
  ['maxSpreadFracOfSL', 'Max spread (of SL)', 'veto entry if the live spread exceeds this share of the SL distance — blocks off-hours/rollover fills'],
  ['maxMarginUsagePct', 'Max margin usage', 'fraction of balance lockable in margin'],
  ['kellyFraction', 'Kelly fraction', '0.25 = quarter-Kelly sizing'],
]

// Grouped by what the trader is deciding — sizing, when to stop, what
// counts as a good trade, and how much runs at once.
const RISK_GROUPS = [
  { title: 'Position sizing', blurb: 'How much one trade can lose.', keys: ['perTradeRiskPct', 'kellyFraction', 'maxMarginUsagePct'] },
  { title: 'Circuit breakers', blurb: 'When the bot must stand down.', keys: ['dailyLossPct', 'maxConsecutiveLosses', 'cooldownMinutes'] },
  { title: 'Trade quality', blurb: 'Signals below this bar are vetoed.', keys: ['minRR', 'minSLDistancePct', 'maxSpreadFracOfSL'] },
  { title: 'Exposure & pacing', blurb: 'How many trades, how often.', keys: ['maxOpenPositions', 'symbolCooldownMinutes'] },
]

// Rich controls for the Risk tab — sliders for continuous fractions
// (displayed as %), dropdowns for enumerable choices. Values are stored in
// the same units the agent expects; only the display is humanised.
const RISK_CONTROLS = {
  perTradeRiskPct: { type: 'slider', min: 0.0025, max: 0.03, step: 0.0025, fraction: true, fmt: v => `${(v * 100).toFixed(2)}%` },
  dailyLossPct: { type: 'slider', min: 0.01, max: 0.1, step: 0.005, fraction: true, fmt: v => `${(v * 100).toFixed(1)}%` },
  minRR: { type: 'select', options: [[1, '1.0 — every signal'], [1.2, '1.2'], [1.5, '1.5 — default'], [2, '2.0'], [3, '3.0 — very picky']] },
  maxOpenPositions: { type: 'select', options: [1, 2, 3, 5, 8, 10].map(n => [n, String(n)]) },
  symbolCooldownMinutes: { type: 'select', options: [[0, 'off'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours — default'], [480, '8 hours'], [1440, '1 day']] },
  maxConsecutiveLosses: { type: 'select', options: [2, 3, 4, 5, 6].map(n => [n, String(n)]) },
  cooldownMinutes: { type: 'select', options: [[30, '30 min'], [60, '1 hour — default'], [120, '2 hours'], [240, '4 hours']] },
  minSLDistancePct: { type: 'slider', min: 0.05, max: 0.5, step: 0.05, fmt: v => `${Number(v).toFixed(2)}%` },
  maxSpreadFracOfSL: { type: 'slider', min: 0.05, max: 1, step: 0.05, fraction: true, fmt: v => `${(v * 100).toFixed(0)}%` },
  maxMarginUsagePct: { type: 'slider', min: 0.1, max: 1, step: 0.05, fraction: true, fmt: v => `${(v * 100).toFixed(0)}%` },
  kellyFraction: { type: 'select', options: [[0.1, '0.10 — very conservative'], [0.25, '0.25 — quarter-Kelly (default)'], [0.5, '0.50 — aggressive'], [1, '1.00 — full Kelly (not advised)']] },
}

function RiskControl({ k, label, hint, value, onChange }) {
  const ctl = RISK_CONTROLS[k]
  if (ctl?.type === 'slider') {
    // Percent-style fields edit in % but the model stays a fraction where
    // flagged (perTradeRiskPct/dailyLossPct/maxMarginUsagePct are fractions;
    // minSLDistancePct is already percent-native).
    const isFraction = !!ctl.fraction
    return (
      <div title={hint}>
        <SliderInput
          label={label} value={value} onChange={onChange}
          min={ctl.min} max={ctl.max} step={ctl.step}
          display={ctl.fmt}
          unit="%"
          toInput={v => isFraction ? Number((v * 100).toFixed(3)) : v}
          parse={v => isFraction ? v / 100 : v}
        />
      </div>
    )
  }
  if (ctl?.type === 'select') {
    return (
      <div title={hint}>
        <PresetSelect
          label={label} value={value} onChange={onChange}
          options={ctl.options} display={v => String(v)}
        />
      </div>
    )
  }
  return (
    <label className="block text-[12px]" title={hint}>
      <span className="text-[var(--color-text-sub)]">{label}</span>
      <Input type="number" step="any" value={value ?? ''} onChange={e => onChange(e.target.value)} placeholder={hint} />
    </label>
  )
}

// ---------------------------------------------------------------------------
// Backtest verdict — evidence-based, three states:
//   go        every criterion passed
//   thin      the EDGE criteria pass but there aren't enough trades to trust
//             them (1,000 bars is ~5.5 months of 4h but only ~10 days of 15m
//             — high TFs can't physically reach 10 trades in the window, so
//             "not enough evidence" must not read as "proven bad")
//   no-go     an edge criterion actually failed
// Profit factor is null when there are zero losing trades — that's an
// INFINITE profit factor and must pass, not fail, the PF bar.
// ---------------------------------------------------------------------------
const GO_MIN_TRADES = 10
function verdictFor(r) {
  if (!r || r.error) return null
  if (!r.trades) return { state: 'no-go', label: 'NO-GO', checks: [{ ok: false, text: 'no trades taken in this window' }] }
  const pfVal = r.profitFactor ?? (r.losses === 0 ? Infinity : 0)
  const checks = [
    {
      ok: r.trades >= GO_MIN_TRADES, gate: 'evidence',
      text: `${r.trades} trade${r.trades === 1 ? '' : 's'} — need ≥${GO_MIN_TRADES} to trust the numbers`,
    },
    {
      ok: pfVal >= 1.1, gate: 'edge',
      text: `profit factor ${pfVal === Infinity ? '∞ (no losing trades)' : pfVal} — need ≥1.1`,
    },
    {
      ok: r.totalProfitPct > 0, gate: 'edge',
      text: `total ${r.totalProfitPct}% after costs — need >0`,
    },
  ]
  const edgeOk = checks.filter(c => c.gate === 'edge').every(c => c.ok)
  const evidenceOk = checks.filter(c => c.gate === 'evidence').every(c => c.ok)
  if (edgeOk && evidenceOk) return { state: 'go', label: 'GO', checks }
  // Conservative go: the edge criteria pass, only the sample size is short.
  if (edgeOk) return { state: 'thin', label: 'GO (thin)', checks }
  return { state: 'no-go', label: 'NO-GO', checks }
}

// Tap (or hover) the verdict to see exactly which criteria passed/failed.
function VerdictBadge({ r }) {
  const [open, setOpen] = useState(false)
  const v = verdictFor(r)
  if (!v) return null
  const tone = v.state === 'go' ? 'up' : v.state === 'thin' ? 'info' : 'down'
  return (
    <span className="relative inline-block">
      <button
        type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        title={v.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.text}`).join('\n')}
        className="cursor-pointer"
      >
        <Badge tone={tone}>{v.label}</Badge>
      </button>
      {open && (
        <span className="glass-panel absolute right-0 top-full z-30 mt-1 w-72 rounded-[12px] p-3 shadow-xl block text-left">
          <span className="block text-[12px] font-semibold mb-1">Why {v.label}?</span>
          {v.checks.map((c, i) => (
            <span key={i} className={`block text-[12px] py-0.5 ${c.ok ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
              {c.ok ? '✓' : '✗'} {c.text}
            </span>
          ))}
          {v.state === 'thin' && (
            <span className="block text-[11px] text-[var(--color-text-sub)] mt-1">
              The edge looks positive but the sample is too small to prove it. Not armed by Activate unless you tick "arm anyway" on the row.
            </span>
          )}
        </span>
      )}
    </span>
  )
}

// Colour clearly-good cells blue and clearly-bad cells red; leave the
// ambiguous middle neutral. lowerBetter flips the sense for drawdown columns.
function metricClass(v, { good, bad, lowerBetter = false } = {}) {
  const n = Number(v)
  if (v == null || Number.isNaN(n)) return ''
  const isGood = lowerBetter ? n <= good : n >= good
  const isBad = lowerBetter ? n >= bad : n <= bad
  if (isGood) return 'text-[var(--color-up)] font-semibold'
  if (isBad) return 'text-[var(--color-down)]'
  return ''
}

// Backtest table columns — key is the result field ('tf' sorts by duration).
const BT_COLS = [
  { key: 'tf', label: 'TF' },
  { key: 'trades', label: 'Trades' },
  { key: 'winRatePct', label: 'Win rate' },
  { key: 'arrPct', label: 'ARR' },
  { key: 'totalProfitPct', label: 'Total' },
  { key: 'profitFactor', label: 'Profit factor' },
  { key: 'sharpeAnnualized', label: 'Sharpe' },
  { key: 'sortinoAnnualized', label: 'Sortino' },
  { key: 'calmarRatio', label: 'Calmar' },
  { key: 'maxDrawdownPct', label: 'Max DD' },
  { key: 'mddP95Pct', label: 'DD p95', title: '95th-percentile max drawdown across 1,000 reshuffles of the same trades — the single backtest path may be a lucky ordering' },
  { key: 'cvar95Pct', label: 'CVaR', title: 'Average of the worst 5% of trades (tail-loss expectancy)' },
]

function sortBtRows(entries, { col, dir }) {
  const sign = dir === 'desc' ? -1 : 1
  const val = ([tf, r]) => {
    if (col === 'tf') return tfMs(tf)
    if (col === 'profitFactor') return r.profitFactor ?? (r.trades > 0 && r.losses === 0 ? Infinity : null)
    const v = Number(r[col])
    return Number.isFinite(v) ? v : null
  }
  return [...entries].sort((a, b) => {
    const va = val(a)
    const vb = val(b)
    if (va == null && vb == null) return byTfDesc(a[0], b[0])
    if (va == null) return 1   // rows without the metric sink to the bottom
    if (vb == null) return -1
    return sign * (va - vb) || byTfDesc(a[0], b[0])
  })
}

// Rough instrument classifier for the catalogue browser — display-only.
function instrumentCategory(sym) {
  const s = sym.toUpperCase()
  if (s.endsWith('.US') || s.endsWith('.UK') || s.endsWith('.DE') || s.endsWith('.AU') || s.includes('.')) return 'Stocks'
  if (/^X(AU|AG|PT|PD)/.test(s)) return 'Metals'
  if (/(BTC|ETH|XRP|SOL|ADA|DOG|LTC|BNB|DOT|LINK)/.test(s)) return 'Crypto'
  if (/^(US30|US500|NAS100|USTEC|UK100|GER40|FRA40|EUSTX|JPN225|AUS200|HK50|CN50|US2000|VIX)/.test(s)) return 'Indices'
  if (/(OIL|CRUDE|BRENT|NATGAS|GASOLINE|COCOA|COFFEE|SUGAR|COTTON|WHEAT|CORN|SOYBEAN|COPPER|ALUMIN)/.test(s)) return 'Energy & Commodities'
  if (/^[A-Z]{6}$/.test(s)) return 'FX'
  return 'Other'
}
const BROWSE_CATS = ['All', 'FX', 'Metals', 'Indices', 'Energy & Commodities', 'Crypto', 'Stocks', 'Other']

function Toggle({ on, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-[7px] border px-3 py-1.5 text-[13px] font-semibold min-h-[36px] cursor-pointer transition-colors ${
        on
          ? 'bg-[var(--color-accent)] text-white border-transparent'
          : 'bg-[var(--color-bg)] text-[var(--color-text-sub)] border-[var(--color-border)]'
      }`}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${on ? 'bg-white' : 'bg-[var(--color-muted)]'}`} />
      {label}: {on ? 'ON' : 'OFF'}
    </button>
  )
}

export default function Tune() {
  const [tab, setTab] = useState(() => {
    try { return sessionStorage.getItem('tune_tab') || 'pipeline' } catch { return 'pipeline' }
  })
  const pickTab = (id) => { setTab(id); try { sessionStorage.setItem('tune_tab', id) } catch { /* quota — skip */ } }

  const [config, setConfig] = useState(null)          // toggles + symbols
  const [risk, setRisk] = useState(null)              // { effective, derived }
  const [riskDraft, setRiskDraft] = useState({})
  const [timeframes, setTimeframes] = useState(['4h', '1d'])
  const [armedMatrix, setArmedMatrix] = useState(null)   // {SYM:[tfs]} currently armed on the agent
  const [tfMenu, setTfMenu] = useState(false)
  const [tfDraft, setTfDraft] = useState('')   // free-text timeframe, e.g. "1.5h"
  // Backtest table sorting — TF slow→fast by default; click a header to re-sort.
  const [btSort, setBtSort] = useState({ col: 'tf', dir: 'desc' })
  const [rsiFilter, setRsiFilter] = useState(false)
  const [vwapFilter, setVwapFilter] = useState(false)
  const [fvgFilter, setFvgFilter] = useState(false)
  const [balanceDraft, setBalanceDraft] = useState({ balance: '', leverage: '' })
  const [newSymbol, setNewSymbol] = useState('')
  const [allSymbols, setAllSymbols] = useState([])   // broker's full instrument list for autocomplete
  const [browse, setBrowse] = useState(false)        // full-catalogue browser open?
  const [browseQ, setBrowseQ] = useState('')
  const [browseCat, setBrowseCat] = useState('All')
  const [scanInfo, setScanInfo] = useState(null)     // latest scan per symbol — price + signal for the watchlist
  // Backtest covers the ENABLED watchlist symbols — the instruments set on
  // this page — never a typed-in default. Tap a chip to skip one this run.
  const [btSkip, setBtSkip] = useState(() => new Set())
  // Backtest results survive tab switches (sessionStorage) — losing them on
  // navigation hid the Activate button and read as "nothing happened".
  const [bt, setBt] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('backtest_cache_v2')) || null } catch { return null }
  })
  const [btError, setBtError] = useState('')
  const [btRunning, setBtRunning] = useState(false)
  // Per-row "arm anyway" overrides (sym|tf) — the trader may knowingly arm a
  // NO-GO / GO (thin) timeframe; the verdict stays honest, the choice is theirs.
  const [btForce, setBtForce] = useState(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem('bt_force_v1')) || []) } catch { return new Set() }
  })
  const toggleForce = (sym, tf) => setBtForce(prev => {
    const k = `${sym}|${tf}`
    const next = new Set(prev)
    if (next.has(k)) next.delete(k); else next.add(k)
    try { sessionStorage.setItem('bt_force_v1', JSON.stringify([...next])) } catch { /* quota — skip */ }
    return next
  })
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — configure it on the Connect tab.'); return }
    try {
      const [c, r, tf, rf, vf, ff] = await Promise.all([
        agentGet('/state/config'),
        agentGet('/state/risk-config'),
        agentGet('/state/autotrade-timeframes').catch(() => null),
        agentGet('/state/fib-rsi-filter').catch(() => null),
        agentGet('/state/fib-vwap-filter').catch(() => null),
        agentGet('/state/fib-fvg-filter').catch(() => null),
      ])
      setConfig(c)
      setRisk(r)
      setRiskDraft(Object.fromEntries(RISK_FIELDS.map(([k]) => [k, r.effective?.[k] ?? ''])))
      if (tf?.timeframes) setTimeframes(tf.timeframes)
      setArmedMatrix(tf?.matrix && typeof tf.matrix === 'object' ? tf.matrix : null)
      if (rf) setRsiFilter(!!rf.on)
      if (vf) setVwapFilter(!!vf.on)
      if (ff) setFvgFilter(!!ff.on)
      setBalanceDraft({
        balance: r.derived?.balance ?? '',
        leverage: r.derived?.leverage ?? '',
      })
      setError('')
    } catch (e) { setError(e.message) }
  }, [])

  useEffect(() => { load() }, [load])

  // Latest scan snapshot — live price + signal per watchlist symbol.
  useEffect(() => {
    if (tab !== 'watchlist' || !agentConfigured()) return
    agentGet('/state/scans').then(r => {
      const by = {}
      for (const s of r?.lastResults?.scans || []) by[s.symbol] = s
      setScanInfo({ at: r?.lastScanAt || null, by })
    }).catch(() => {})
  }, [tab])

  // Broker instrument list (once) — powers the add-symbol autocomplete.
  useEffect(() => {
    if (!agentConfigured()) return
    agentGet('/state/symbol-map')
      .then(r => setAllSymbols(Object.keys(r?.map || {}).sort()))
      .catch(() => {})
  }, [])

  // Top matches for the typed prefix (name contains, prefix first)
  const q = newSymbol.trim().toUpperCase()
  const suggestions = q.length >= 1
    ? allSymbols.filter(s => s.includes(q)).sort((a, b) => (a.startsWith(q) === b.startsWith(q) ? a.localeCompare(b) : a.startsWith(q) ? -1 : 1)).slice(0, 25)
    : []

  const flash = (msg) => { setStatus(msg); setTimeout(() => setStatus(''), 2500) }
  const run = async (fn, okMsg) => {
    try { await fn(); await load(); flash(okMsg) } catch (e) { setError(e.message) }
  }

  const toggle = (path, key, current) =>
    run(() => agentPost(path, { on: !current }), `${key} ${!current ? 'enabled' : 'disabled'}`)

  const toggleTimeframe = (tf) => {
    const next = timeframes.includes(tf) ? timeframes.filter(t => t !== tf) : [...timeframes, tf]
    if (next.length === 0) { setError('At least one timeframe must stay enabled'); return }
    setTimeframes(next)
    run(() => agentPost('/actions/autotrade-timeframes', { timeframes: next }), 'Autotrade timeframes saved')
  }

  // Free-text timeframe: "90m", "1.5h", "0.25d", "2d", "1w", "1M" — parsed
  // locally, synthesised agent-side by aggregating the closest native bars.
  const addCustomTimeframe = () => {
    const parsed = parseTimeframe(tfDraft)
    if (!parsed) {
      setError(`Cannot read "${tfDraft}" — try forms like 90m, 1.5h, 2d, 1w, 1M (decimals from hours up)`)
      return
    }
    const clash = timeframes.find(t => tfMs(t) === parsed.ms)
    if (clash) { setError(`${parsed.label} is the same timeframe as ${clash} — already on the list`); return }
    setTfDraft('')
    setTfMenu(false)
    toggleTimeframe(parsed.label)
  }

  const saveRisk = () => {
    const body = {}
    for (const [k] of RISK_FIELDS) {
      const v = Number(riskDraft[k])
      if (Number.isFinite(v)) body[k] = v
    }
    run(() => agentPost('/actions/risk-config', body), 'Risk config saved')
  }

  const saveBalance = () => {
    const body = {}
    if (balanceDraft.balance !== '') body.balance = Number(balanceDraft.balance)
    if (balanceDraft.leverage !== '') body.leverage = Number(balanceDraft.leverage)
    run(() => agentPost('/actions/balance', body), 'Account saved')
  }

  const symbols = config?.symbols || []
  const enabledSymbols = symbols.filter(s => s.enabled !== false).map(s => s.symbol)
  const btSymbols = enabledSymbols.filter(s => !btSkip.has(s))

  const pushSymbols = (next) =>
    run(() => agentPost('/actions/symbols', { symbols: next }), 'Watchlist saved')

  const addSymbol = () => {
    const sym = newSymbol.toUpperCase().trim()
    if (!sym) return
    if (symbols.some(s => s.symbol === sym)) { setError(`${sym} already in watchlist`); return }
    setNewSymbol('')
    pushSymbols([...symbols, { symbol: sym, enabled: true }])
  }

  const runBacktest = async () => {
    if (btSymbols.length === 0) { setBtError('No symbols selected — enable some on the Watchlist tab.'); return }
    setBtRunning(true)
    setBtError('')
    setBt(null)
    try {
      const r = await agentPost('/actions/backtest', {
        symbols: btSymbols,
        // Test exactly what Pipeline arms — one source of truth for timeframes.
        timeframes,
        bars: 1000,
        rsiFilter,
        vwapFilter,
        fvgFilter,
      })
      setBt(r)
      try { sessionStorage.setItem('backtest_cache_v2', JSON.stringify(r)) } catch { /* quota — skip */ }
    } catch (e) { setBtError(e.message) } finally { setBtRunning(false) }
  }

  // Trades per symbol in the last backtest (all timeframes summed) — surfaced
  // on the Watchlist so each instrument shows how much it actually traded.
  const btTradeCount = (sym) => {
    const results = bt?.symbols?.[sym]?.results
    if (!results) return null
    return Object.values(results).reduce((n, r) => n + (r.trades || 0), 0)
  }

  // GO timeframes across every tested symbol (union) — the Activate flow arms
  // timeframes, not symbols, so a GO on any symbol lights that timeframe up.
  const goVerdict = (r) => verdictFor(r)?.state === 'go'
  const goTfs = bt?.symbols
    ? [...new Set(
        Object.values(bt.symbols).flatMap(s => s.results
          ? Object.entries(s.results).filter(([, r]) => goVerdict(r)).map(([tf]) => tf)
          : []),
      )]
    : []
  // Timeframes armed only because the trader ticked "arm anyway" on a
  // NO-GO / GO (thin) row of the CURRENT result set (stale overrides ignored).
  const forcedTfs = bt?.symbols
    ? [...new Set(
        Object.entries(bt.symbols).flatMap(([sym, s]) => s.results
          ? Object.entries(s.results)
              .filter(([tf, r]) => !r.error && btForce.has(`${sym}|${tf}`) && verdictFor(r)?.state !== 'go')
              .map(([tf]) => tf)
          : []),
      )].filter(tf => !goTfs.includes(tf))
    : []
  const armTfs = [...goTfs, ...forcedTfs]
  // Per-instrument arm matrix: {SYMBOL: [tfs]} — a GO row arms that
  // symbol×timeframe pair; "arm anyway" arms exactly its own pair, never the
  // whole watchlist. This is what the agent's matrix gate enforces.
  const armMatrix = bt?.symbols
    ? Object.fromEntries(
        Object.entries(bt.symbols)
          .map(([sym, s]) => [sym, s.results
            ? Object.entries(s.results)
                .filter(([tf, r]) => !r.error && (verdictFor(r)?.state === 'go' || btForce.has(`${sym}|${tf}`)))
                .map(([tf]) => tf)
            : []])
          .filter(([, tfs]) => tfs.length > 0),
      )
    : {}
  const matrixSummary = Object.entries(armMatrix).map(([s, tfs]) => `${s} (${tfs.join(', ')})`).join(' · ')
  const matrixEq = (a, b) => {
    const norm = (m) => JSON.stringify(Object.fromEntries(Object.entries(m || {}).filter(([, v]) => v?.length).map(([k, v]) => [k, [...v].sort()]).sort()))
    return norm(a) === norm(b)
  }

  return (
    <div className="space-y-4">
      {error && <Card className="border-[var(--color-down)] text-[13px]">{error}</Card>}
      {status && <div className="text-[13px] text-[var(--color-info-text)]" role="status">{status}</div>}

      <FolioTabs tabs={TABS} active={tab} onChange={pickTab}>
        {tab === 'pipeline' && (
          <div>
            <div className="flex flex-wrap gap-2">
              <Toggle on={config?.scan_enabled} label="Scan" onClick={() => toggle('/actions/scan-toggle', 'Scan', config?.scan_enabled)} />
              <Toggle on={config?.analyze_enabled} label="Analyze" onClick={() => toggle('/actions/analyze-toggle', 'Analyze', config?.analyze_enabled)} />
              <Toggle on={config?.autotrade_enabled} label="Autotrade" onClick={() => {
                if (!config?.autotrade_enabled && !window.confirm('Arm autotrade? The agent will place REAL orders when a signal passes the risk gate.')) return
                toggle('/actions/autotrade-toggle', 'Autotrade', config?.autotrade_enabled)
              }} />
              <Toggle on={rsiFilter} label="RSI filter" onClick={() => {
                const next = !rsiFilter
                setRsiFilter(next)
                run(() => agentPost('/actions/fib-rsi-filter', { on: next }), `RSI confluence filter ${next ? 'enabled' : 'disabled'}`)
              }} />
              <Toggle on={vwapFilter} label="VWAP filter" onClick={() => {
                const next = !vwapFilter
                setVwapFilter(next)
                run(() => agentPost('/actions/fib-vwap-filter', { on: next }), `VWAP confluence filter ${next ? 'enabled' : 'disabled'}`)
              }} />
              <Toggle on={fvgFilter} label="FVG filter" onClick={() => {
                const next = !fvgFilter
                setFvgFilter(next)
                run(() => agentPost('/actions/fib-fvg-filter', { on: next }), `FVG confluence filter ${next ? 'enabled' : 'disabled'}`)
              }} />
            </div>
            <p className="mt-1.5 text-[12px] text-[var(--color-text-sub)]">
              Confluence filters (each A/B-testable on the Backtest tab — turn one on only after it proves itself there): RSI = long fades only when RSI(14) ≤ 45, shorts ≥ 55. VWAP = longs only below the leg-anchored volume-weighted average price, shorts only above. FVG = the 61.8% zone must overlap an unfilled 3-bar fair value gap in the trade's direction.
            </p>
            <div className="mt-3">
              <div className="text-[12px] text-[var(--color-text-sub)] mb-1.5">
                Autotrade timeframes — add or remove any the broker supports (1m → 1 month). Scans and backtests follow this list:
              </div>
              <div className="flex flex-wrap gap-1.5 items-center">
                {[...timeframes].sort(byTfDesc).map(tf => (
                  <span
                    key={tf}
                    className="inline-flex items-center gap-1.5 rounded-[20px] bg-[var(--color-accent)] text-white px-3 py-1 text-[12px] font-semibold min-h-[36px]"
                  >
                    {tf}
                    <button
                      type="button" aria-label={`Remove ${tf}`}
                      onClick={() => toggleTimeframe(tf)}
                      className="cursor-pointer rounded-full hover:bg-white/25 w-5 h-5 leading-none"
                    >×</button>
                  </span>
                ))}
                <span className="relative">
                  <button
                    type="button" onClick={() => setTfMenu(o => !o)} aria-expanded={tfMenu}
                    className="rounded-[20px] border border-dashed border-[var(--color-border)] px-3 py-1 text-[12px] font-semibold min-h-[36px] cursor-pointer text-[var(--color-text-sub)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
                  >+ Add timeframe</button>
                  {tfMenu && (
                    <span className="glass-panel absolute left-0 top-full z-30 mt-1 w-56 rounded-[12px] p-1.5 shadow-xl block max-h-80 overflow-y-auto">
                      <span className="flex gap-1 p-1">
                        <Input
                          value={tfDraft} onChange={e => setTfDraft(e.target.value)}
                          placeholder="e.g. 90m · 1.5h · 2d · 1M"
                          className="!py-1 text-[13px]"
                          onKeyDown={e => e.key === 'Enter' && addCustomTimeframe()}
                        />
                        <Button size="sm" onClick={addCustomTimeframe}>Add</Button>
                      </span>
                      <span className="block px-2 pb-1 text-[11px] text-[var(--color-text-sub)]">
                        min/h/d/w · M = month · decimals from hours up
                      </span>
                      {ALL_TIMEFRAMES.filter(tf => !timeframes.includes(tf)).map(tf => (
                        <button
                          key={tf} type="button"
                          onClick={() => { setTfMenu(false); toggleTimeframe(tf) }}
                          className="w-full text-left rounded-[8px] px-3 py-1.5 text-[13px] cursor-pointer hover:bg-[var(--color-accent-soft)] block"
                        >{tf}</button>
                      ))}
                    </span>
                  )}
                </span>
              </div>
            </div>
          </div>
        )}

        {tab === 'risk' && (() => {
          const labels = Object.fromEntries(RISK_FIELDS.map(([k, label, hint]) => [k, { label, hint }]))
          const bal = Number(balanceDraft.balance) || Number(risk?.derived?.balance) || null
          const usd = (frac) => {
            const f = Number(frac)
            return bal && Number.isFinite(f) ? `$${(bal * f).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'
          }
          const dirty = risk?.effective && RISK_FIELDS.some(([k]) => Number(riskDraft[k]) !== Number(risk.effective[k]))
          return (
          <div>
            {/* Live impact strip — recomputes from the DRAFT values as you drag,
                so the money consequence is visible before saving. */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
              {[
                ['Balance', bal ? `$${bal.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : 'not set'],
                ['Risk per trade', usd(riskDraft.perTradeRiskPct)],
                ['Daily stop-out', usd(riskDraft.dailyLossPct)],
                ['Worst case open', bal && Number.isFinite(Number(riskDraft.perTradeRiskPct)) && Number.isFinite(Number(riskDraft.maxOpenPositions))
                  ? `$${(bal * riskDraft.perTradeRiskPct * riskDraft.maxOpenPositions).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                  : '—'],
              ].map(([label, value]) => (
                <div key={label} className="glass-inset rounded-[10px] px-3 py-2">
                  <div className="text-[11px] text-[var(--color-text-sub)]">{label}</div>
                  <div className="text-[15px] font-bold tabular-nums">{value}</div>
                </div>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              {RISK_GROUPS.map(g => (
                <div key={g.title} className="glass-inset rounded-[12px] p-3.5">
                  <div className="flex items-baseline justify-between mb-2.5">
                    <h3 className="text-[13px] font-semibold">{g.title}</h3>
                    <span className="text-[11px] text-[var(--color-text-sub)]">{g.blurb}</span>
                  </div>
                  <div className="space-y-4">
                    {g.keys.map(k => (
                      <RiskControl
                        key={k} k={k} label={labels[k].label} hint={labels[k].hint}
                        value={riskDraft[k]}
                        onChange={v => setRiskDraft(d => ({ ...d, [k]: v }))}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={saveRisk} disabled={!dirty}>{dirty ? 'Save risk config' : 'Saved'}</Button>
              {dirty && <span className="text-[12px] font-semibold text-[var(--color-warning-text)]">Unsaved changes — the bot still uses the old values.</span>}
              <span className="ml-auto">
                <Button size="sm" variant="subtle" onClick={() => run(() => agentPost('/actions/risk-config', { reset: true }), 'Risk config reset to defaults')}>Reset to defaults</Button>
              </span>
            </div>

            <h2 className="text-[13px] font-semibold mt-5 mb-1 pt-4 border-t border-[var(--color-border)]">Account</h2>
            <p className="text-[12px] text-[var(--color-text-sub)] mb-2">These feed every $ figure above. Balance auto-syncs from the broker when linked; set it manually only if you want a smaller working budget.</p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="block text-[12px]">
                <span className="text-[var(--color-text-sub)]">Balance (USD)</span>
                <Input type="number" step="any" value={balanceDraft.balance} onChange={e => setBalanceDraft(d => ({ ...d, balance: e.target.value }))} />
              </label>
              <label className="block text-[12px]">
                <span className="text-[var(--color-text-sub)]">Leverage (e.g. 200 = 1:200)</span>
                <Input type="number" value={balanceDraft.leverage} onChange={e => setBalanceDraft(d => ({ ...d, leverage: e.target.value }))} />
              </label>
              <Button size="sm" onClick={saveBalance}>Save account</Button>
            </div>
          </div>
          )
        })()}

        {tab === 'watchlist' && (
          <div>
            <h2 className="text-[13px] font-semibold mb-2">Watchlist ({symbols.length})</h2>
            <div className="flex gap-2 mb-3">
              <Input
                value={newSymbol} onChange={e => setNewSymbol(e.target.value)}
                placeholder={allSymbols.length ? `Search ${allSymbols.length.toLocaleString()} instruments…` : 'Add symbol, e.g. EURUSD'}
                className="max-w-[260px]" list="broker-symbols"
                onKeyDown={e => e.key === 'Enter' && addSymbol()}
              />
              <datalist id="broker-symbols">
                {suggestions.map(s => <option key={s} value={s} />)}
              </datalist>
              <Button size="sm" onClick={addSymbol}>Add</Button>
            </div>
            {q.length >= 2 && allSymbols.length > 0 && !allSymbols.includes(q) && suggestions.length === 0 && (
              <p className="text-[12px] text-[var(--color-warning-text)] mb-2">No instrument matching “{q}” on this broker account.</p>
            )}

            {/* Full catalogue browser — every instrument the broker offers,
                searchable + category-filtered, one tap to add. */}
            {allSymbols.length > 0 && (
              <div className="mb-3">
                <button
                  type="button" onClick={() => setBrowse(b => !b)} aria-expanded={browse}
                  className="text-[12px] font-semibold text-[var(--color-accent)] cursor-pointer hover:underline"
                >
                  {browse ? '▾' : '▸'} Browse all {allSymbols.length.toLocaleString()} instruments on this account
                </button>
                {browse && (() => {
                  const bq = browseQ.trim().toUpperCase()
                  const filtered = allSymbols.filter(s =>
                    (browseCat === 'All' || instrumentCategory(s) === browseCat) &&
                    (!bq || s.toUpperCase().includes(bq)))
                  const shown = filtered.slice(0, 200)
                  const inList = new Set(symbols.map(s => s.symbol))
                  return (
                    <div className="glass-inset rounded-[12px] p-3 mt-2">
                      <div className="flex flex-wrap items-center gap-1.5 mb-2">
                        <Input value={browseQ} onChange={e => setBrowseQ(e.target.value)} placeholder="Filter…" className="max-w-[180px] !py-1 !min-h-0" />
                        {BROWSE_CATS.map(c => (
                          <button key={c} type="button" onClick={() => setBrowseCat(c)}
                            className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold cursor-pointer min-h-[28px] ${browseCat === c ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-sub)]'}`}
                          >{c}</button>
                        ))}
                        <span className="ml-auto text-[11px] text-[var(--color-text-sub)]">{filtered.length.toLocaleString()} match{filtered.length === 1 ? '' : 'es'}{filtered.length > 200 ? ' — showing first 200, refine the filter' : ''}</span>
                      </div>
                      <div className="max-h-72 overflow-y-auto grid gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
                        {shown.map(s => (
                          <div key={s} className="flex items-center gap-2 border-b border-[var(--color-border)] py-1 text-[12px]">
                            <span className="font-semibold">{s}</span>
                            <span className="text-[var(--color-text-sub)] text-[10px]">{instrumentCategory(s)}</span>
                            <span className="ml-auto">
                              {inList.has(s)
                                ? <span className="text-[11px] text-[var(--color-text-sub)]">in watchlist</span>
                                : <Button size="sm" variant="subtle" onClick={() => pushSymbols([...symbols, { symbol: s, enabled: true }])}>Add</Button>}
                            </span>
                          </div>
                        ))}
                        {shown.length === 0 && <span className="text-[12px] text-[var(--color-text-sub)] py-2">Nothing matches.</span>}
                      </div>
                    </div>
                  )
                })()}
              </div>
            )}
            {symbols.length === 0 && <div className="text-[13px] text-[var(--color-text-sub)]">No symbols yet — add one above.</div>}
            {/* Two-column grid — 8 symbols fit a 2048×1280 notebook screen
                without scrolling. Each cell carries its own hairline. */}
            <div className="grid gap-x-8 gap-y-0 lg:grid-cols-2">
              {symbols.map((s, i) => {
                const tested = btTradeCount(s.symbol)
                return (
                  <div key={s.symbol} className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] py-1.5 text-[13px]">
                    <span className="font-semibold w-20">{s.symbol}</span>
                    <Badge tone={s.enabled !== false ? 'up' : 'neutral'}>{s.enabled !== false ? 'ON' : 'OFF'}</Badge>
                    {(() => {
                      const scan = scanInfo?.by?.[s.symbol]
                      if (!scan) return null
                      return (
                        <span className="text-[12px] tabular-nums">
                          {scan.price != null && <span className="font-semibold">{Number(scan.price).toLocaleString(undefined, { maximumFractionDigits: 5 })}</span>}
                          {' '}
                          {scan.bias && scan.bias !== 'skip'
                            ? <span className={scan.bias === 'long' ? 'text-[var(--color-up)] font-semibold' : 'text-[var(--color-down)] font-semibold'}>
                                {scan.bias.toUpperCase()} {scan.timeframe || ''}{scan.confidence != null ? ` ${scan.confidence}/10` : ''}
                              </span>
                            : <span className="text-[var(--color-text-sub)]">no setup</span>}
                        </span>
                      )
                    })()}
                    <label className="flex items-center gap-1 text-[12px] text-[var(--color-text-sub)]">
                      max lots
                      <Input
                        type="number" step="0.01" className="w-20 !py-1 !min-h-0" value={s.maxVolume ?? ''}
                        placeholder="0.01"
                        onChange={e => {
                          const next = [...symbols]
                          next[i] = { ...s, maxVolume: e.target.value === '' ? undefined : Number(e.target.value) }
                          setConfig(c => ({ ...c, symbols: next }))
                        }}
                        onBlur={() => pushSymbols(symbols)}
                      />
                    </label>
                    {tested != null && (
                      <span
                        className="rounded-[20px] border border-[var(--color-info-border)] bg-[var(--color-info-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-info-text)]"
                        title="Trades this symbol produced in the last backtest (all timeframes)"
                      >
                        {tested} trade{tested === 1 ? '' : 's'} in backtest
                      </span>
                    )}
                    <span className="ml-auto flex gap-1.5">
                      <Button size="sm" variant="subtle" onClick={() => pushSymbols(symbols.map((x, j) => j === i ? { ...x, enabled: x.enabled === false } : x))}>
                        {s.enabled !== false ? 'Disable' : 'Enable'}
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => pushSymbols(symbols.filter((_, j) => j !== i))}>Remove</Button>
                    </span>
                  </div>
                )
              })}
            </div>
            <p className="mt-2 text-[12px] text-[var(--color-text-sub)]">
              Symbol names must match your broker's cTrader names (e.g. EURUSD, XAUUSD) — IDs are mapped automatically when you link the account on the Connect tab.
            </p>
          </div>
        )}

        {tab === 'backtest' && (
          <div>
            <h2 className="text-[13px] font-semibold mb-2">Backtest (go/no-go before autotrade)</h2>
            {enabledSymbols.length === 0 ? (
              <p className="text-[13px] text-[var(--color-text-sub)]">No enabled symbols — add instruments on the Watchlist tab first.</p>
            ) : (
              <>
                <div className="text-[12px] text-[var(--color-text-sub)] mb-1.5">Tests your enabled watchlist — tap a symbol to skip it this run:</div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {enabledSymbols.map(sym => {
                    const on = !btSkip.has(sym)
                    return (
                      <button
                        key={sym} type="button" aria-pressed={on}
                        onClick={() => setBtSkip(prev => {
                          const next = new Set(prev)
                          if (next.has(sym)) next.delete(sym); else next.add(sym)
                          return next
                        })}
                        className={`rounded-[20px] border px-3 py-1 text-[12px] font-semibold cursor-pointer min-h-[36px] ${
                          on
                            ? 'bg-[var(--color-accent)] text-white border-transparent'
                            : 'bg-[var(--color-bg)] text-[var(--color-text-sub)] border-[var(--color-border)] line-through'
                        }`}
                      >{sym}</button>
                    )
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={runBacktest} disabled={btRunning}>
                    {btRunning ? `Testing ${btSymbols.length} symbol${btSymbols.length > 1 ? 's' : ''}…` : `Run backtest (${btSymbols.length})`}
                  </Button>
                  <span className="text-[12px] text-[var(--color-text-sub)]">on {[...timeframes].sort((a, b) => tfMs(a) - tfMs(b)).join(' + ')} (set on Pipeline) · 1,000 real broker bars per timeframe · walk-forward · next-open fills · 0.02% cost · SL-before-TP</span>
                </div>
              </>
            )}

            {bt?.symbols && (
              <div className="mt-3 space-y-4">
                {Object.entries(bt.symbols).map(([sym, sr]) => (
                  <div key={sym}>
                    <h3 className="text-[13px] font-bold mb-1">{sym}</h3>
                    {sr.error
                      ? <p className="text-[13px] text-[var(--color-warning-text)]">{sr.error}</p>
                      : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-[13px]">
                            <thead className="text-left text-[var(--color-text-sub)]">
                              <tr>
                                {BT_COLS.map(c => (
                                  <th
                                    key={c.key} className="pr-3 py-1 cursor-pointer select-none whitespace-nowrap"
                                    title={c.title || `Sort by ${c.label}`}
                                    onClick={() => setBtSort(s => ({ col: c.key, dir: s.col === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}
                                  >
                                    {c.label}{btSort.col === c.key ? (btSort.dir === 'desc' ? ' ▾' : ' ▴') : ''}
                                  </th>
                                ))}
                                <th>Verdict</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sortBtRows(Object.entries(sr.results), btSort).map(([tf, r]) => {
                                // PF is null when no trade lost — display ∞, and let
                                // the highlight treat it as excellent, not missing.
                                const pfShown = r.profitFactor ?? (r.trades > 0 && r.losses === 0 ? '∞' : '—')
                                const pfNum = r.profitFactor ?? (r.trades > 0 && r.losses === 0 ? 999 : null)
                                return (
                                  <tr key={tf} className="border-t border-[var(--color-border)]">
                                    <td className="pr-3 py-1.5 font-semibold">{tf}</td>
                                    {r.error
                                      ? <td colSpan={11} className="text-[var(--color-warning-text)]">{r.error}</td>
                                      : <>
                                          <td className={`pr-3 ${metricClass(r.trades, { good: GO_MIN_TRADES, bad: -1 })}`}>{r.trades}</td>
                                          <td className={`pr-3 ${metricClass(r.winRatePct, { good: 50, bad: 30 })}`}>{r.winRatePct != null ? `${r.winRatePct}%` : '—'}</td>
                                          <td className={`pr-3 ${metricClass(r.arrPct, { good: 0.0001, bad: -0.0001 })}`}>{r.arrPct != null ? `${r.arrPct}%` : '—'}</td>
                                          <td className={`pr-3 ${metricClass(r.totalProfitPct, { good: 0.0001, bad: -0.0001 })}`}>{r.totalProfitPct != null ? `${r.totalProfitPct}%` : '—'}</td>
                                          <td className={`pr-3 ${metricClass(pfNum, { good: 1.1, bad: 1 })}`}>{pfShown}</td>
                                          <td className={`pr-3 ${metricClass(r.sharpeAnnualized, { good: 1, bad: 0 })}`}>{r.sharpeAnnualized ?? '—'}</td>
                                          <td className={`pr-3 ${metricClass(r.sortinoAnnualized, { good: 1.5, bad: 0 })}`}>{r.sortinoAnnualized ?? '—'}</td>
                                          <td className={`pr-3 ${metricClass(r.calmarRatio, { good: 1, bad: 0 })}`}>{r.calmarRatio ?? '—'}</td>
                                          <td className={`pr-3 ${metricClass(r.maxDrawdownPct, { good: 1, bad: 3, lowerBetter: true })}`}>{r.maxDrawdownPct != null ? `${r.maxDrawdownPct}%` : '—'}</td>
                                          <td className={`pr-3 ${metricClass(r.mddP95Pct, { good: 2, bad: 5, lowerBetter: true })}`}>{r.mddP95Pct != null ? `${r.mddP95Pct}%` : '—'}</td>
                                          <td className={`pr-3 ${metricClass(r.cvar95Pct, { good: -0.25, bad: -1 })}`}>{r.cvar95Pct != null ? `${r.cvar95Pct}%` : '—'}</td>
                                        </>}
                                    <td>
                                      {!r.error && (
                                        <span className="flex items-center gap-2 whitespace-nowrap">
                                          <VerdictBadge r={r} />
                                          {verdictFor(r)?.state !== 'go' && (
                                            <label
                                              className="flex items-center gap-1 text-[11px] text-[var(--color-text-sub)] cursor-pointer"
                                              title="Include this timeframe in Activate even though it did not fully pass — you accept the unproven risk"
                                            >
                                              <input
                                                type="checkbox"
                                                checked={btForce.has(`${sym}|${tf}`)}
                                                onChange={() => toggleForce(sym, tf)}
                                              />
                                              arm anyway
                                            </label>
                                          )}
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                  </div>
                ))}
                <p className="text-[12px] text-[var(--color-text-sub)]">
                  Tap any verdict for the evidence behind it. GO = ≥10 trades, profit factor ≥1.1, positive total. GO (thin) = the edge is positive but there aren't enough trades to trust it — 1,000 bars is ~5.5 months of 4h but only ~10 days of 15m, so slow timeframes often can't reach 10 trades in the window; that's "unproven", not "bad". Tick "arm anyway" on any row to include it in Activate at your own risk. DD p95 = worst-case drawdown across 1,000 reshuffles of the same trades; CVaR = average of the worst 5% of trades. RSI filter setting (Pipeline tab) is applied.
                </p>
                {armTfs.length === 0 && (() => {
                  const anyThin = Object.values(bt.symbols).some(s => s.results && Object.values(s.results).some(r => verdictFor(r)?.state === 'thin'))
                  return (
                    <p className="text-[13px] font-semibold text-[var(--color-warning-text)]">
                      {anyThin
                        ? 'No timeframe fully passed — but some show a positive edge on too few trades (GO thin). Keep the bot in demo to accumulate evidence, re-run later as more bars build up — or tick "arm anyway" on a row to proceed at your own risk.'
                        : 'No timeframe passed on any symbol — do NOT arm autotrade. Adjust the watchlist, wait for more data, or tick "arm anyway" on a row to proceed at your own risk.'}
                    </p>
                  )
                })()}
                {armTfs.length > 0 && config?.autotrade_enabled && (() => {
                  // Already armed — but if the checked selection differs from
                  // what's currently armed, offer to push the new set. The old
                  // static "already ACTIVE" text left ticked checkboxes with
                  // no button to act on them.
                  const same = matrixEq(armMatrix, armedMatrix)
                  if (same) {
                    return <p className="text-[13px] font-semibold">Quant trading is ACTIVE, armed per instrument: {matrixSummary}. Your current selection matches — nothing to apply.</p>
                  }
                  return (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button onClick={async () => {
                        const forcedNote = forcedTfs.length
                          ? ` NOTE: some rows did NOT fully pass — you are overriding those verdicts.`
                          : ''
                        if (!window.confirm(`Apply per-instrument arming: ${matrixSummary}?${forcedNote} Autotrade stays ON — each symbol will only trade its own armed timeframes.`)) return
                        try {
                          await agentPost('/actions/autotrade-timeframes', { timeframes: armTfs, matrix: armMatrix })
                          setTimeframes(armTfs)
                          await load()
                          flash(`Armed per instrument: ${matrixSummary} — autotrade stays ON.`)
                        } catch (err) { setError(err.message) }
                      }}>Apply selection: {Object.keys(armMatrix).length} instrument{Object.keys(armMatrix).length === 1 ? '' : 's'}</Button>
                      <span className="text-[12px] text-[var(--color-text-sub)]">
                        will arm {matrixSummary || 'nothing'} — currently armed: {armedMatrix ? Object.entries(armedMatrix).map(([s2, t2]) => `${s2} (${t2.join(', ')})`).join(' · ') : `${[...timeframes].sort(byTfDesc).join(' + ')} (all watchlist symbols)`}
                      </span>
                    </div>
                  )
                })()}
                {armTfs.length > 0 && !config?.autotrade_enabled && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={async () => {
                      const forcedNote = forcedTfs.length
                        ? ` NOTE: ${forcedTfs.join(' + ')} did NOT fully pass — you are overriding the verdict.`
                        : ''
                      if (!window.confirm(`Arm the bot on ${armTfs.join(' + ')}?${forcedNote} This turns ON Scan, Analyze and Autotrade in one go — the bot will place REAL orders on the linked account whenever a fib signal on these timeframes passes the risk gate. Turn it off any time with the Autotrade toggle on Pipeline or Kill-all on Trade.`)) return
                      try {
                        // One tap arms the WHOLE pipeline — an armed-but-blind
                        // bot (autotrade on, scan off) was a real support case.
                        await agentPost('/actions/autotrade-timeframes', { timeframes: armTfs, matrix: armMatrix })
                        if (!config?.scan_enabled) await agentPost('/actions/scan-toggle', { on: true })
                        if (!config?.analyze_enabled) await agentPost('/actions/analyze-toggle', { on: true })
                        await agentPost('/actions/autotrade-toggle', { on: true })
                        setTimeframes(armTfs)
                        await load()
                        flash(`Bot fully ARMED on ${armTfs.join(' + ')} — Scan + Analyze + Autotrade all ON. Telegram will ping on every trade.`)
                      } catch (err) { setError(err.message) }
                    }}>Arm the bot: {matrixSummary || armTfs.join(' + ')} (everything in one tap)</Button>
                    <span className="text-[12px] text-[var(--color-text-sub)]">
                      {forcedTfs.length
                        ? `turns on Scan + Analyze + Autotrade — GO timeframes + your overrides (${forcedTfs.join(', ')})`
                        : 'turns on Scan + Analyze + Autotrade and arms the GO timeframes'}
                    </span>
                  </div>
                )}
              </div>
            )}
            {btError && <div className="mt-2 text-[13px] text-[var(--color-warning-text)]">{btError}</div>}
          </div>
        )}

        {tab === 'presets' && (
          <div>
            <h2 className="text-[13px] font-semibold mb-2">Presets</h2>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="subtle" onClick={() => {
                const preset = {
                  version: 1,
                  riskConfig: risk?.effective || {},
                  autotradeTimeframes: timeframes,
                  rsiFilter,
                  vwapFilter,
                  fvgFilter,
                  symbols,
                }
                const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' })
                const a = document.createElement('a')
                a.href = URL.createObjectURL(blob)
                a.download = 'bot-trade-preset.json'
                a.click()
                URL.revokeObjectURL(a.href)
              }}>Export settings</Button>
              <label className="inline-flex">
                <span className="sr-only">Import settings</span>
                <input type="file" accept="application/json" className="hidden" id="preset-import" onChange={async (e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (!file) return
                  try {
                    const preset = JSON.parse(await file.text())
                    if (preset.riskConfig) await agentPost('/actions/risk-config', preset.riskConfig)
                    if (Array.isArray(preset.autotradeTimeframes) && preset.autotradeTimeframes.length > 0) await agentPost('/actions/autotrade-timeframes', { timeframes: preset.autotradeTimeframes })
                    if (typeof preset.rsiFilter === 'boolean') await agentPost('/actions/fib-rsi-filter', { on: preset.rsiFilter })
                    if (typeof preset.vwapFilter === 'boolean') await agentPost('/actions/fib-vwap-filter', { on: preset.vwapFilter })
                    if (typeof preset.fvgFilter === 'boolean') await agentPost('/actions/fib-fvg-filter', { on: preset.fvgFilter })
                    if (Array.isArray(preset.symbols) && preset.symbols.length > 0) await agentPost('/actions/symbols', { symbols: preset.symbols })
                    await load()
                    flash('Preset imported')
                  } catch (err) { setError(`Preset import failed: ${err.message}`) }
                }} />
                <Button size="sm" variant="subtle" onClick={() => document.getElementById('preset-import').click()}>Import settings</Button>
              </label>
            </div>
            <p className="mt-2 text-[12px] text-[var(--color-text-sub)]">
              Everything on this page (risk limits, timeframes, RSI filter, watchlist) as one shareable JSON file. Autotrade arming is deliberately NOT included.
            </p>
          </div>
        )}
      </FolioTabs>
    </div>
  )
}
