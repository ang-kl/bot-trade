// Tune — every knob a trader can turn, in one place:
// pipeline toggles, autotrade timeframes, risk limits, account, watchlist.
import { useEffect, useState, useCallback } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import Input from '../components/common/Input.jsx'
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'

const ALL_TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1d']

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
  const [config, setConfig] = useState(null)          // toggles + symbols
  const [risk, setRisk] = useState(null)              // { effective, derived }
  const [riskDraft, setRiskDraft] = useState({})
  const [timeframes, setTimeframes] = useState(['4h', '1d'])
  const [rsiFilter, setRsiFilter] = useState(false)
  const [balanceDraft, setBalanceDraft] = useState({ balance: '', leverage: '' })
  const [newSymbol, setNewSymbol] = useState('')
  const [btSymbol, setBtSymbol] = useState('EURUSD')
  const [bt, setBt] = useState(null)
  const [btError, setBtError] = useState('')
  const [btRunning, setBtRunning] = useState(false)

  const runBacktest = async () => {
    setBtRunning(true)
    setBtError('')
    setBt(null)
    try {
      const r = await agentPost('/actions/backtest', {
        symbol: btSymbol.trim().toUpperCase() || 'EURUSD',
        timeframes: ['4h', '1d'],
        bars: 1000,
        rsiFilter,
      })
      setBt(r)
    } catch (e) { setBtError(e.message) } finally { setBtRunning(false) }
  }
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

  const pushSymbols = (next) =>
    run(() => agentPost('/actions/symbols', { symbols: next }), 'Watchlist saved')

  const addSymbol = () => {
    const sym = newSymbol.toUpperCase().trim()
    if (!sym) return
    if (symbols.some(s => s.symbol === sym)) { setError(`${sym} already in watchlist`); return }
    setNewSymbol('')
    pushSymbols([...symbols, { symbol: sym, enabled: true }])
  }

  return (
    <div className="space-y-8">
      {error && <Card className="border-[var(--color-down)] text-[13px]">{error}</Card>}
      {status && <div className="text-[13px] text-[var(--color-info-text)]">{status}</div>}

      {/* Pipeline toggles */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-2">Pipeline</h2>
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
          RSI filter: only take long fades when RSI(14) ≤ 45 and shorts when ≥ 55. Backtest it first: <code>--rsi-filter</code>.
        </p>
        <div className="mt-3">
          <div className="text-[12px] text-[var(--color-text-sub)] mb-1.5">Autotrade timeframes (scans always cover all):</div>
          <div className="flex flex-wrap gap-1.5">
            {ALL_TIMEFRAMES.map(tf => (
              <button
                key={tf} type="button" onClick={() => toggleTimeframe(tf)}
                className={`rounded-[20px] border px-3 py-1 text-[12px] font-semibold cursor-pointer ${
                  timeframes.includes(tf)
                    ? 'bg-[var(--color-accent)] text-white border-transparent'
                    : 'bg-[var(--color-bg)] text-[var(--color-text-sub)] border-[var(--color-border)]'
                }`}
              >{tf}</button>
            ))}
          </div>
        </div>
      </Card>

      {/* Risk limits */}
      <Card>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[13px] font-semibold">Risk limits</h2>
          {risk?.derived && (
            <span className="text-[12px] text-[var(--color-text-sub)]">
              balance {risk.derived.balance != null ? `$${risk.derived.balance}` : 'not set'} · daily cap ${risk.derived.daily_cap_usd} · per-trade ${risk.derived.per_trade_budget_usd ?? '—'}
            </span>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {RISK_FIELDS.map(([k, label, hint]) => (
            <label key={k} className="block text-[12px]">
              <span className="text-[var(--color-text-sub)]">{label}</span>
              <Input
                type="number" step="any" value={riskDraft[k] ?? ''}
                onChange={e => setRiskDraft(d => ({ ...d, [k]: e.target.value }))}
                title={hint} placeholder={hint}
              />
            </label>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={saveRisk}>Save risk config</Button>
          <Button size="sm" variant="subtle" onClick={() => run(() => agentPost('/actions/risk-config', { reset: true }), 'Risk config reset to defaults')}>Reset to defaults</Button>
        </div>
      </Card>

      {/* Account */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-2">Account</h2>
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
      </Card>

      {/* Watchlist */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-2">Watchlist ({symbols.length})</h2>
        <div className="flex gap-2 mb-3">
          <Input value={newSymbol} onChange={e => setNewSymbol(e.target.value)} placeholder="Add symbol, e.g. EURUSD" className="max-w-[220px]" onKeyDown={e => e.key === 'Enter' && addSymbol()} />
          <Button size="sm" onClick={addSymbol}>Add</Button>
        </div>
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
      </Card>

      {/* Backtest — the go/no-go gate before arming autotrade */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-2">Backtest (go/no-go before autotrade)</h2>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block text-[12px]">
            <span className="text-[var(--color-text-sub)]">Symbol</span>
            <Input value={btSymbol} onChange={e => setBtSymbol(e.target.value)} placeholder="EURUSD" className="w-28" />
          </label>
          <Button size="sm" onClick={runBacktest} disabled={btRunning}>{btRunning ? 'Fetching bars & simulating…' : 'Run backtest'}</Button>
          <span className="text-[12px] text-[var(--color-text-sub)]">1,000 real broker bars per timeframe · walk-forward · next-open fills · 0.02% cost · SL-before-TP</span>
        </div>
        {bt?.results && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[var(--color-text-sub)]">
                <tr><th className="pr-3 py-1">TF</th><th className="pr-3">Trades</th><th className="pr-3">Win rate</th><th className="pr-3">Avg P/L</th><th className="pr-3">Total</th><th className="pr-3">Profit factor</th><th className="pr-3">Max DD</th><th>Verdict</th></tr>
              </thead>
              <tbody>
                {Object.entries(bt.results).map(([tf, r]) => {
                  const go = !r.error && r.trades >= 10 && (r.profitFactor ?? 0) >= 1.1 && r.totalProfitPct > 0
                  return (
                    <tr key={tf} className="border-t border-[var(--color-border)]">
                      <td className="pr-3 py-1.5 font-semibold">{tf}</td>
                      {r.error
                        ? <td colSpan={6} className="text-[var(--color-warning-text)]">{r.error}</td>
                        : <>
                            <td className="pr-3">{r.trades}</td>
                            <td className="pr-3">{r.winRatePct != null ? `${r.winRatePct}%` : '—'}</td>
                            <td className="pr-3">{r.avgProfitPct != null ? `${r.avgProfitPct}%` : '—'}</td>
                            <td className="pr-3">{r.totalProfitPct != null ? `${r.totalProfitPct}%` : '—'}</td>
                            <td className="pr-3">{r.profitFactor ?? '—'}</td>
                            <td className="pr-3">{r.maxDrawdownPct != null ? `${r.maxDrawdownPct}%` : '—'}</td>
                          </>}
                      <td>{!r.error && <Badge tone={go ? 'up' : 'down'}>{go ? 'GO' : 'NO-GO'}</Badge>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="mt-2 text-[12px] text-[var(--color-text-sub)]">
              GO = ≥10 trades, profit factor ≥1.1, positive total. Past performance is not a promise — it only says the strategy wasn't losing on this data. RSI filter setting above is applied.
            </p>
          </div>
        )}
        {btError && <div className="mt-2 text-[13px] text-[var(--color-warning-text)]">{btError}</div>}
      </Card>

      {/* Presets — the .cbotset idea: settings as a shareable file */}
      <Card>
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
      </Card>
    </div>
  )
}
