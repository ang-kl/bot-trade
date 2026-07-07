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

const ALL_TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1d']

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
  ['symbolCooldownMinutes', 'Symbol cooldown (min)', 'lock a symbol after any closed trade'],
  ['maxConsecutiveLosses', 'Loss streak limit', 'losses in a row before cooldown'],
  ['cooldownMinutes', 'Streak cooldown (min)', 'pause after hitting the streak'],
  ['minSLDistancePct', 'Min SL distance %', 'stops tighter than this are vetoed'],
  ['maxMarginUsagePct', 'Max margin usage', 'fraction of balance lockable in margin'],
  ['kellyFraction', 'Kelly fraction', '0.25 = quarter-Kelly sizing'],
]

// Rich controls for the Risk tab — sliders for continuous fractions
// (displayed as %), dropdowns for enumerable choices. Values are stored in
// the same units the agent expects; only the display is humanised.
const RISK_CONTROLS = {
  perTradeRiskPct: { type: 'slider', min: 0.0025, max: 0.03, step: 0.0025, fmt: v => `${(v * 100).toFixed(2)}%` },
  dailyLossPct: { type: 'slider', min: 0.01, max: 0.1, step: 0.005, fmt: v => `${(v * 100).toFixed(1)}%` },
  minRR: { type: 'select', options: [[1, '1.0 — every signal'], [1.2, '1.2'], [1.5, '1.5 — default'], [2, '2.0'], [3, '3.0 — very picky']] },
  maxOpenPositions: { type: 'select', options: [1, 2, 3, 5, 8, 10].map(n => [n, String(n)]) },
  symbolCooldownMinutes: { type: 'select', options: [[0, 'off'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours — default'], [480, '8 hours'], [1440, '1 day']] },
  maxConsecutiveLosses: { type: 'select', options: [2, 3, 4, 5, 6].map(n => [n, String(n)]) },
  cooldownMinutes: { type: 'select', options: [[30, '30 min'], [60, '1 hour — default'], [120, '2 hours'], [240, '4 hours']] },
  minSLDistancePct: { type: 'slider', min: 0.05, max: 0.5, step: 0.05, fmt: v => `${Number(v).toFixed(2)}%` },
  maxMarginUsagePct: { type: 'slider', min: 0.1, max: 1, step: 0.05, fmt: v => `${(v * 100).toFixed(0)}%` },
  kellyFraction: { type: 'select', options: [[0.1, '0.10 — very conservative'], [0.25, '0.25 — quarter-Kelly (default)'], [0.5, '0.50 — aggressive'], [1, '1.00 — full Kelly (not advised)']] },
}

function RiskControl({ k, label, hint, value, onChange }) {
  const ctl = RISK_CONTROLS[k]
  if (ctl?.type === 'slider') {
    // Percent-style fields edit in % but the model stays a fraction where
    // needed (perTradeRiskPct/dailyLossPct/maxMarginUsagePct are fractions;
    // minSLDistancePct is already in %).
    const isFraction = ctl.max <= 1
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
  const [rsiFilter, setRsiFilter] = useState(false)
  const [balanceDraft, setBalanceDraft] = useState({ balance: '', leverage: '' })
  const [newSymbol, setNewSymbol] = useState('')
  const [allSymbols, setAllSymbols] = useState([])   // broker's full instrument list for autocomplete
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
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — configure it on the Connect tab.'); return }
    try {
      const [c, r, tf, rf] = await Promise.all([
        agentGet('/state/config'),
        agentGet('/state/risk-config'),
        agentGet('/state/autotrade-timeframes').catch(() => null),
        agentGet('/state/fib-rsi-filter').catch(() => null),
      ])
      setConfig(c)
      setRisk(r)
      setRiskDraft(Object.fromEntries(RISK_FIELDS.map(([k]) => [k, r.effective?.[k] ?? ''])))
      if (tf?.timeframes) setTimeframes(tf.timeframes)
      if (rf) setRsiFilter(!!rf.on)
      setBalanceDraft({
        balance: r.derived?.balance ?? '',
        leverage: r.derived?.leverage ?? '',
      })
      setError('')
    } catch (e) { setError(e.message) }
  }, [])

  useEffect(() => { load() }, [load])

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
      })
      setBt(r)
      try { sessionStorage.setItem('backtest_cache_v2', JSON.stringify(r)) } catch { /* quota — skip */ }
    } catch (e) { setBtError(e.message) } finally { setBtRunning(false) }
  }

  // GO timeframes across every tested symbol (union) — the Activate flow arms
  // timeframes, not symbols, so a GO on any symbol lights that timeframe up.
  const goVerdict = (r) => !r.error && r.trades >= 10 && (r.profitFactor ?? 0) >= 1.1 && r.totalProfitPct > 0
  const goTfs = bt?.symbols
    ? [...new Set(
        Object.values(bt.symbols).flatMap(s => s.results
          ? Object.entries(s.results).filter(([, r]) => goVerdict(r)).map(([tf]) => tf)
          : []),
      )]
    : []

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
            </div>
            <p className="mt-1.5 text-[12px] text-[var(--color-text-sub)]">
              RSI filter: only take long fades when RSI(14) ≤ 45 and shorts when ≥ 55. Backtest it first on the Backtest tab.
            </p>
            <div className="mt-3">
              <div className="text-[12px] text-[var(--color-text-sub)] mb-1.5">Autotrade timeframes (scans always cover all):</div>
              <div className="flex flex-wrap gap-1.5">
                {ALL_TIMEFRAMES.map(tf => (
                  <button
                    key={tf} type="button" onClick={() => toggleTimeframe(tf)}
                    className={`rounded-[20px] border px-3 py-1 text-[12px] font-semibold cursor-pointer min-h-[36px] ${
                      timeframes.includes(tf)
                        ? 'bg-[var(--color-accent)] text-white border-transparent'
                        : 'bg-[var(--color-bg)] text-[var(--color-text-sub)] border-[var(--color-border)]'
                    }`}
                  >{tf}</button>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'risk' && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[13px] font-semibold">Risk limits</h2>
              {risk?.derived && (
                <span className="text-[12px] text-[var(--color-text-sub)]">
                  balance {risk.derived.balance != null ? `$${risk.derived.balance}` : 'not set'} · daily cap ${risk.derived.daily_cap_usd} · per-trade ${risk.derived.per_trade_budget_usd ?? '—'}
                </span>
              )}
            </div>
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              {RISK_FIELDS.map(([k, label, hint]) => (
                <RiskControl
                  key={k} k={k} label={label} hint={hint}
                  value={riskDraft[k]}
                  onChange={v => setRiskDraft(d => ({ ...d, [k]: v }))}
                />
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={saveRisk}>Save risk config</Button>
              <Button size="sm" variant="subtle" onClick={() => run(() => agentPost('/actions/risk-config', { reset: true }), 'Risk config reset to defaults')}>Reset to defaults</Button>
            </div>

            <h2 className="text-[13px] font-semibold mt-5 mb-2 pt-4 border-t border-[var(--color-border)]">Account</h2>
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
        )}

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
            {symbols.length === 0 && <div className="text-[13px] text-[var(--color-text-sub)]">No symbols yet — add one above.</div>}
            <div className="space-y-1.5">
              {symbols.map((s, i) => (
                <div key={s.symbol} className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-1.5 first:border-t-0 first:pt-0 text-[13px]">
                  <span className="font-semibold w-20">{s.symbol}</span>
                  <Badge tone={s.enabled !== false ? 'up' : 'neutral'}>{s.enabled !== false ? 'ON' : 'OFF'}</Badge>
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
                  <span className="ml-auto flex gap-1.5">
                    <Button size="sm" variant="subtle" onClick={() => pushSymbols(symbols.map((x, j) => j === i ? { ...x, enabled: x.enabled === false } : x))}>
                      {s.enabled !== false ? 'Disable' : 'Enable'}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => pushSymbols(symbols.filter((_, j) => j !== i))}>Remove</Button>
                  </span>
                </div>
              ))}
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
                  <span className="text-[12px] text-[var(--color-text-sub)]">on {timeframes.join(' + ')} (set on Pipeline) · 1,000 real broker bars per timeframe · walk-forward · next-open fills · 0.02% cost · SL-before-TP</span>
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
                              <tr><th className="pr-3 py-1">TF</th><th className="pr-3">Trades</th><th className="pr-3">Win rate</th><th className="pr-3">ARR</th><th className="pr-3">Total</th><th className="pr-3">Profit factor</th><th className="pr-3">Sharpe</th><th className="pr-3">Sortino</th><th className="pr-3">Calmar</th><th className="pr-3">Max DD</th><th>Verdict</th></tr>
                            </thead>
                            <tbody>
                              {Object.entries(sr.results).map(([tf, r]) => {
                                const go = goVerdict(r)
                                return (
                                  <tr key={tf} className="border-t border-[var(--color-border)]">
                                    <td className="pr-3 py-1.5 font-semibold">{tf}</td>
                                    {r.error
                                      ? <td colSpan={9} className="text-[var(--color-warning-text)]">{r.error}</td>
                                      : <>
                                          <td className="pr-3">{r.trades}</td>
                                          <td className="pr-3">{r.winRatePct != null ? `${r.winRatePct}%` : '—'}</td>
                                          <td className="pr-3">{r.arrPct != null ? `${r.arrPct}%` : '—'}</td>
                                          <td className="pr-3">{r.totalProfitPct != null ? `${r.totalProfitPct}%` : '—'}</td>
                                          <td className="pr-3">{r.profitFactor ?? '—'}</td>
                                          <td className="pr-3">{r.sharpeAnnualized ?? '—'}</td>
                                          <td className="pr-3">{r.sortinoAnnualized ?? '—'}</td>
                                          <td className="pr-3">{r.calmarRatio ?? '—'}</td>
                                          <td className="pr-3">{r.maxDrawdownPct != null ? `${r.maxDrawdownPct}%` : '—'}</td>
                                        </>}
                                    <td>{!r.error && <Badge tone={go ? 'up' : 'down'}>{go ? 'GO' : 'NO-GO'}</Badge>}</td>
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
                  GO = ≥10 trades, profit factor ≥1.1, positive total. Past performance is not a promise — it only says the strategy wasn't losing on this data. RSI filter setting (Pipeline tab) is applied.
                </p>
                {goTfs.length === 0 && (
                  <p className="text-[13px] font-semibold text-[var(--color-warning-text)]">No timeframe passed on any symbol — do NOT arm autotrade. Adjust the watchlist, or wait for more data.</p>
                )}
                {goTfs.length > 0 && config?.autotrade_enabled && (
                  <p className="text-[13px] font-semibold">Quant trading is already ACTIVE.</p>
                )}
                {goTfs.length > 0 && !config?.autotrade_enabled && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={async () => {
                      if (!window.confirm(`Activate quant trading on ${goTfs.join(' + ')}? The bot will place REAL orders on the linked account whenever a fib signal on these timeframes passes the risk gate. You can turn it off any time with the Autotrade toggle on Pipeline or Kill-all on Trade.`)) return
                      try {
                        await agentPost('/actions/autotrade-timeframes', { timeframes: goTfs })
                        await agentPost('/actions/autotrade-toggle', { on: true })
                        setTimeframes(goTfs)
                        await load()
                        flash(`Quant trading ACTIVE on ${goTfs.join(' + ')} — the bot now trades on your behalf, window closed included`)
                      } catch (err) { setError(err.message) }
                    }}>Activate quant trading on {goTfs.join(' + ')}</Button>
                    <span className="text-[12px] text-[var(--color-text-sub)]">arms autotrade on the GO timeframes only</span>
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
