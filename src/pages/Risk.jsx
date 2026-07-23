// Risk — every risk setting that was previously hardcoded or scattered,
// in the owner's layout: Global cTrader config across the top; Account
// Risk (left); Bot Trade Risk + Cpp Risk (middle); a worked example trade
// per engine (right), recomputed live from whatever is on screen so the
// numbers always show what the CURRENT settings would actually do.
// Writes go through the same routes the agent already enforces:
// /actions/risk-config, /actions/balance, /actions/guardian-move-pct,
// /actions/weekend-bank, /actions/weekend-loss-flag, /actions/exec-guard,
// /actions/vpo-settings, /actions/close-all.
import { useEffect, useState, useCallback, useRef } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import Input from '../components/common/Input.jsx'
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'

// W3C-style international number formatting (owner: "use w3 international
// setup") — everything DISPLAYED goes through Intl.NumberFormat in the
// viewer's own locale (thousands separators, decimal marks); inputs stay
// plain machine numbers.
const nf = (d = 2) => new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
const fmt$ = (n, d = 2) => (n == null || Number.isNaN(Number(n)) ? '—' : nf(d).format(Number(n)))

// GSAP is loaded from the CDN in index.html; everything animation-related
// guards on window.gsap so a blocked CDN degrades to a static page.
const gsap = () => (typeof window !== 'undefined' ? window.gsap : null)

// Number that TWEENS to its new value (GSAP) instead of snapping — the
// example panels recompute as fields are edited, and the motion makes the
// cause→effect link visible.
function AnimatedNumber({ value, decimals = 2, className = '' }) {
  const ref = useRef(null)
  const prev = useRef(value)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const g = gsap()
    const from = Number(prev.current) || 0
    const to = Number(value) || 0
    prev.current = value
    if (!g || from === to) { el.textContent = fmt$(to, decimals); return }
    const obj = { v: from }
    g.to(obj, { v: to, duration: 0.6, ease: 'power2.out', onUpdate: () => { el.textContent = fmt$(obj.v, decimals) } })
  }, [value, decimals])
  return <span ref={ref} className={className}>{fmt$(value, decimals)}</span>
}

// Tiny bordered pill toggle (same convention as Tune's genuine toggles).
function Pill({ on, label, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-[2px] border px-[4px] py-[3px] text-[10px] cursor-pointer ${on
        ? 'border-[var(--color-accent)] text-[var(--color-accent)] font-normal'
        : 'border-[var(--glass-edge)] text-[var(--color-text-sub)] font-bold uppercase'}`}>
      {on ? label : label.toUpperCase()}
    </button>
  )
}

// Compact labelled field. `pct` fields edit in % but store fractions.
function Field({ label, value, onChange, pct = false, hint, width = 'w-[110px]' }) {
  const display = value == null ? '' : pct ? Number((value * 100).toFixed(4)) : value
  return (
    <label className="flex items-center justify-between gap-2 text-[12px]" title={hint}>
      <span className="text-[var(--color-text-sub)]">{label}</span>
      <span className="flex items-center gap-1">
        <Input type="number" step="any" value={display} className={`${width} !min-h-[26px] !py-0.5 !px-2 !text-[12px] text-right`}
          onChange={e => {
            const raw = e.target.value
            if (raw === '') { onChange(null); return }
            const n = Number(raw)
            if (!Number.isFinite(n)) return
            onChange(pct ? n / 100 : n)
          }} />
        {pct && <span className="text-[11px] text-[var(--color-text-sub)]">%</span>}
      </span>
    </label>
  )
}

// Mini SVG "sample chart" — a wandering price line with entry/SL/TP levels
// drawn from the example's real computed prices.
function MiniChart({ entry, sl, tp, side = 'long', trigger = null }) {
  const w = 260, h = 110, pad = 6
  const levels = [entry, sl, tp, trigger].filter(v => v != null)
  const lo = Math.min(...levels), hi = Math.max(...levels)
  const span = (hi - lo) || 1
  const y = (p) => pad + (1 - (p - lo + span * 0.15) / (span * 1.3)) * (h - 2 * pad)
  // Deterministic wiggle that dips to the entry then runs toward TP.
  const pts = []
  for (let i = 0; i <= 20; i++) {
    const x = pad + (i / 20) * (w - 2 * pad)
    const drift = i < 10 ? entry + (hi - entry) * (1 - i / 10) * 0.35 : entry + (tp - entry) * ((i - 10) / 10) * 0.8
    const wiggle = Math.sin(i * 2.1) * span * 0.05
    pts.push(`${x.toFixed(1)},${y(drift + wiggle).toFixed(1)}`)
  }
  const line = (p, cls, label) => p != null && (
    <g>
      <line x1={pad} x2={w - pad} y1={y(p)} y2={y(p)} className={cls} strokeDasharray="4 3" strokeWidth="1" />
      <text x={w - pad} y={y(p) - 2} textAnchor="end" className="fill-[var(--color-text-sub)]" fontSize="8">{label} {p.toFixed(4)}</text>
    </g>
  )
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full glass-inset rounded-[8px]">
      {line(tp, 'stroke-[var(--color-up)]', side === 'long' ? 'TP' : 'SL')}
      {line(entry, 'stroke-[var(--color-accent)]', 'ENTRY')}
      {trigger != null && line(trigger, 'stroke-[var(--color-special-text)]', 'VPO TRIGGER')}
      {line(sl, 'stroke-[var(--color-down)]', side === 'long' ? 'SL' : 'TP')}
      <polyline points={pts.join(' ')} fill="none" className="stroke-[var(--color-text)]" strokeWidth="1.2" />
    </svg>
  )
}

function SectionTitle({ children, badge }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <div className="text-[12px] font-semibold">{children}</div>
      {badge}
    </div>
  )
}

export default function Risk() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState('')
  // Local editable copies — saved per section.
  const [risk, setRisk] = useState({})
  const [acct, setAcct] = useState({ balance: null, leverage: null })
  const [guard, setGuard] = useState({})
  const [guardianPct, setGuardianPct] = useState(0.05)
  const [weekendBank, setWeekendBank] = useState(true)
  const [weekendLossFlag, setWeekendLossFlag] = useState(true)
  const [vpoEnabled, setVpoEnabled] = useState(false)
  const [closeAllResult, setCloseAllResult] = useState(null)
  const [closingAll, setClosingAll] = useState(false)

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — configure it on the Connect tab.'); return }
    try {
      const r = await agentGet('/state/risk-full')
      setData(r)
      setRisk(r.risk.effective)
      setAcct({ balance: r.account.balance, leverage: r.account.leverage })
      setGuard({ requireBracket: true, requireTarget: true, halt: false, maxOrderVolume: 0, ...r.execGuard })
      setGuardianPct(r.guardian.movePct)
      setWeekendBank(r.weekendBank)
      setWeekendLossFlag(r.weekendLossFlag)
      setVpoEnabled(r.vpo.enabled)
      setError('')
    } catch (e) { setError(e.message) }
  }, [])
  useEffect(() => { load() }, [load])

  const save = async (section, fn) => {
    setSaving(section)
    try { await fn(); await load() } catch (e) { setError(e.message) } finally { setSaving('') }
  }
  const saveRisk = (keys) => save('risk', () => {
    const body = {}
    for (const k of keys) body[k] = risk[k]
    return agentPost('/actions/risk-config', body)
  })

  const closeAll = async () => {
    if (!window.confirm('Close EVERY open position at the broker — bot and manual trades alike. This cannot be undone. Continue?')) return
    setClosingAll(true)
    setCloseAllResult(null)
    try {
      const r = await agentPost('/actions/close-all', { confirm: true })
      setCloseAllResult(r)
      await load()
    } catch (e) { setError(e.message) } finally { setClosingAll(false) }
  }

  const overridden = new Set(data?.risk?.overridden || [])
  const mark = (k) => overridden.has(k) ? '' : ' (default)'

  // GSAP entrance + scroll reveals (guarded — static page if the CDN is
  // blocked). Runs once after the first successful data load.
  const animated = useRef(false)
  useEffect(() => {
    const g = gsap()
    if (!g || animated.current || !data) return
    animated.current = true
    const cards = document.querySelectorAll('[data-risk-card]')
    g.fromTo(cards, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.08, ease: 'power2.out' })
    if (window.ScrollTrigger) {
      g.registerPlugin(window.ScrollTrigger)
      document.querySelectorAll('[data-risk-reveal]').forEach(el => {
        g.fromTo(el, { opacity: 0.3, scale: 0.985 }, {
          opacity: 1, scale: 1, duration: 0.4, ease: 'power1.out',
          scrollTrigger: { trigger: el, start: 'top 92%' },
        })
      })
    }
  }, [data])

  // Save-button pulse: little success beat on whichever section just saved.
  const lastSaved = useRef('')
  useEffect(() => {
    const g = gsap()
    if (!g) return
    if (saving) { lastSaved.current = saving; return }
    if (!lastSaved.current) return
    const el = document.querySelector(`[data-save-pulse="${lastSaved.current}"]`)
    lastSaved.current = ''
    if (el) g.fromTo(el, { scale: 1 }, { scale: 1.06, duration: 0.12, yoyo: true, repeat: 1, ease: 'power1.inOut' })
  }, [saving])

  // ---- Worked examples, recomputed from what's ON SCREEN -----------------
  const bal = Number(acct.balance) || 10000
  const entry = 1.1
  const slDist = entry * ((Number(risk.minSLDistancePct) || 0.15) / 100)
  const sl = entry - slDist
  const tp = entry + slDist * (Number(risk.minRR) || 1.5)
  const budgetBase = Number(risk.perTradeRiskUsd) > 0 ? Number(risk.perTradeRiskUsd) : bal * (Number(risk.perTradeRiskPct) || 0)
  const ceiling = Math.min(bal * (Number(risk.maxRiskCapPct) || Infinity), Number(risk.maxRiskUsd) > 0 ? Number(risk.maxRiskUsd) : Infinity)
  const budget = Math.min(budgetBase, ceiling)
  const usdPerLot = slDist * 100000 // EURUSD: $ loss per 1.0 lot over the SL distance
  const lots = Math.max(0, Math.floor((budget / usdPerLot) * 100) / 100)
  const cppVolumeUnits = Math.round(lots * 10000000) // cTrader volume = lots × 100k units × 100
  const volCapped = guard.maxOrderVolume > 0 && cppVolumeUnits > guard.maxOrderVolume

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[14px] font-bold t-heading">Risk</h1>
        <span className="text-[12px] text-[var(--color-text-sub)]">every layer's limits in one place — changes apply to the live gate on save</span>
        {saving && <Badge tone="info">saving {saving}…</Badge>}
      </div>
      {error && <Card className="border-[var(--color-down)] text-[13px]">{error}</Card>}

      {/* ---- Global Account aka cTrader Risk Configuration ---- */}
      <Card data-risk-card className="w3-hover-shadow">
        <SectionTitle badge={data?.account?.isLive ? <Badge tone="down">LIVE</Badge> : <Badge tone="info">DEMO</Badge>}>
          Global Account — cTrader risk configuration
        </SectionTitle>
        <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
          <div>
            <Field label="Account balance (USD)" value={acct.balance} onChange={v => setAcct(a => ({ ...a, balance: v }))}
              hint="The balance every % figure below is computed from." />
            <div className="text-[10px] text-[var(--color-text-sub)] mt-0.5">
              {data?.account?.balanceSource === 'broker'
                ? `live from the broker (snapshot ${data?.account?.balanceFetchedAt ? new Date(data.account.balanceFetchedAt).toLocaleTimeString() : ''}) — edits here override until the next sync`
                : 'stored value — connect/refresh the broker for live truth'}
            </div>
          </div>
          <Field label="Leverage (1:N)" value={acct.leverage} onChange={v => setAcct(a => ({ ...a, leverage: v }))}
            hint="Used for margin-headroom checks before approving a position." />
          <div className="text-[12px]">
            <span className="text-[var(--color-text-sub)]">Broker stop-out level </span>
            <span className="font-semibold">{data?.account?.brokerStopOutPct ?? 50}%</span>
            <span className="text-[11px] text-[var(--color-text-sub)]"> margin level — broker-enforced liquidation, not editable</span>
          </div>
          <div className="text-[12px]">
            <span className="text-[var(--color-text-sub)]">Account </span>
            <span className="font-semibold">{data?.account?.accountId || '—'}</span>
          </div>
          <span data-save-pulse="account">
            <Button size="sm" onClick={() => save('account', () => agentPost('/actions/balance', { balance: acct.balance, leverage: acct.leverage }))}>Save account</Button>
          </span>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr_280px] gap-4 items-start">
        {/* ---- Account Risk Configuration (left) ---- */}
        <Card data-risk-card className="w3-hover-shadow">
          <SectionTitle>Account risk configuration</SectionTitle>
          <div className="space-y-2">
            <Field label={`Daily loss cap${mark('dailyLossPct')}`} pct value={risk.dailyLossPct} onChange={v => setRisk(r => ({ ...r, dailyLossPct: v }))}
              hint="New entries stop for the day once closed P&L is down this % of balance." />
            <Field label={`Daily cap fallback $${mark('dailyLossLimit')}`} value={risk.dailyLossLimit} onChange={v => setRisk(r => ({ ...r, dailyLossLimit: v }))}
              hint="Absolute USD cap used only when balance is unknown." />
            <Field label={`Equity stop${mark('equityStopPct')}`} pct value={risk.equityStopPct} onChange={v => setRisk(r => ({ ...r, equityStopPct: v }))}
              hint="Daily drawdown at which the loop CLOSES all bot positions and disarms (empty = same as daily loss cap)." />
            <Field label={`Max margin usage${mark('maxMarginUsagePct')}`} pct value={risk.maxMarginUsagePct} onChange={v => setRisk(r => ({ ...r, maxMarginUsagePct: v }))}
              hint="Bot's own cap on margin locked as a % of balance — separate from the broker's 50% stop-out." />
            <div className="border-t border-[var(--glass-edge)] pt-2 space-y-2">
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-[var(--color-text-sub)]" title="A losing run sizes DOWN automatically instead of compounding.">Drawdown de-risk{mark('deriskOnDrawdown')}</span>
                <Pill on={!!risk.deriskOnDrawdown} label="On" onClick={() => setRisk(r => ({ ...r, deriskOnDrawdown: !r.deriskOnDrawdown }))} />
              </div>
              <Field label={`window (hours)${mark('deriskWindowHours')}`} value={risk.deriskWindowHours} onChange={v => setRisk(r => ({ ...r, deriskWindowHours: v }))} />
              <Field label={`trigger${mark('deriskTriggerPct')}`} pct value={risk.deriskTriggerPct} onChange={v => setRisk(r => ({ ...r, deriskTriggerPct: v }))}
                hint="Down more than this % of balance in the window → de-risk." />
              <Field label={`size multiplier${mark('deriskMult')}`} value={risk.deriskMult} onChange={v => setRisk(r => ({ ...r, deriskMult: v }))}
                hint="Budget × this while de-risked (0.5 = half size)." />
            </div>
            <label className="block text-[12px]">
              <span className="text-[var(--color-text-sub)]" title="Symbols vetoed outright, comma-separated.">Blocked symbols{mark('blockedSymbols')}</span>
              <Input type="text" value={(risk.blockedSymbols || []).join(', ')}
                onChange={e => setRisk(r => ({ ...r, blockedSymbols: e.target.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) }))}
                placeholder="e.g. BTCUSD, USDIDR" className="!min-h-[26px] !py-0.5 !px-2 !text-[12px]" />
            </label>
            <span data-save-pulse="risk"><Button size="sm" onClick={() => saveRisk(['dailyLossPct', 'dailyLossLimit', 'equityStopPct', 'maxMarginUsagePct', 'deriskOnDrawdown', 'deriskWindowHours', 'deriskTriggerPct', 'deriskMult', 'blockedSymbols'])}>Save account risk</Button></span>
          </div>
        </Card>

        {/* ---- Middle column: Bot Trade + Cpp ---- */}
        <div className="space-y-4">
          <Card data-risk-card className="w3-hover-shadow">
            <SectionTitle>Bot Trade risk configuration</SectionTitle>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-2">
              <Field label={`Per-trade risk${mark('perTradeRiskPct')}`} pct value={risk.perTradeRiskPct} onChange={v => setRisk(r => ({ ...r, perTradeRiskPct: v }))}
                hint="% of balance one trade may lose at its SL." />
              <Field label={`Per-trade risk $ override${mark('perTradeRiskUsd')}`} value={risk.perTradeRiskUsd} onChange={v => setRisk(r => ({ ...r, perTradeRiskUsd: v }))}
                hint="Absolute $ risk per trade; when set, overrides the %." />
              <Field label={`Risk hard cap${mark('maxRiskCapPct')}`} pct value={risk.maxRiskCapPct} onChange={v => setRisk(r => ({ ...r, maxRiskCapPct: v }))}
                hint="Never risk more than this % of balance regardless of other settings." />
              <Field label={`Risk hard cap $${mark('maxRiskUsd')}`} value={risk.maxRiskUsd} onChange={v => setRisk(r => ({ ...r, maxRiskUsd: v }))}
                hint="Optional absolute $ ceiling per trade." />
              <Field label={`Min lot size${mark('minLotSize')}`} value={risk.minLotSize} onChange={v => setRisk(r => ({ ...r, minLotSize: v }))} />
              <Field label={`Min R:R${mark('minRR')}`} value={risk.minRR} onChange={v => setRisk(r => ({ ...r, minRR: v }))}
                hint="TP must be at least this multiple of the SL distance." />
              <Field label={`Min SL distance${mark('minSLDistancePct')}`} value={risk.minSLDistancePct} onChange={v => setRisk(r => ({ ...r, minSLDistancePct: v }))}
                hint="% of price — stops tighter than this get swept by noise." />
              <Field label={`Max spread / SL${mark('maxSpreadFracOfSL')}`} pct value={risk.maxSpreadFracOfSL} onChange={v => setRisk(r => ({ ...r, maxSpreadFracOfSL: v }))}
                hint="Veto when the live spread exceeds this fraction of the SL distance." />
              <Field label={`Max open positions${mark('maxOpenPositions')}`} value={risk.maxOpenPositions} onChange={v => setRisk(r => ({ ...r, maxOpenPositions: v }))} />
              <Field label={`Symbol cooldown (min)${mark('symbolCooldownMinutes')}`} value={risk.symbolCooldownMinutes} onChange={v => setRisk(r => ({ ...r, symbolCooldownMinutes: v }))}
                hint="Lock a symbol after any closed trade on it." />
              <Field label={`Loss streak breaker${mark('maxConsecutiveLosses')}`} value={risk.maxConsecutiveLosses} onChange={v => setRisk(r => ({ ...r, maxConsecutiveLosses: v }))}
                hint="After N losses in a row, pause. 0 = off." />
              <Field label={`Streak cooldown (min)${mark('cooldownMinutes')}`} value={risk.cooldownMinutes} onChange={v => setRisk(r => ({ ...r, cooldownMinutes: v }))} />
              <Field label={`Cluster exposure${mark('maxClusterExposure')}`} value={risk.maxClusterExposure} onChange={v => setRisk(r => ({ ...r, maxClusterExposure: v }))}
                hint="Net directional bets allowed per correlation cluster. 0 = off." />
              <Field label={`Currency exposure${mark('maxCurrencyExposure')}`} value={risk.maxCurrencyExposure} onChange={v => setRisk(r => ({ ...r, maxCurrencyExposure: v }))} />
              <Field label={`Min trades for Kelly${mark('minTradesForKelly')}`} value={risk.minTradesForKelly} onChange={v => setRisk(r => ({ ...r, minTradesForKelly: v }))}
                hint="Below this trade count, Kelly sizing is skipped." />
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-[var(--color-text-sub)]" title="If off, negative-expectancy combos are vetoed.">Allow −expectancy{mark('allowNegativeExpectancyOverride')}</span>
                <Pill on={!!risk.allowNegativeExpectancyOverride} label="On" onClick={() => setRisk(r => ({ ...r, allowNegativeExpectancyOverride: !r.allowNegativeExpectancyOverride }))} />
              </div>
              <label className="flex items-center justify-between gap-2 text-[12px]" title="Tick move that wakes the guardian between sweeps.">
                <span className="text-[var(--color-text-sub)]">Guardian move %</span>
                <Input type="number" step="any" value={guardianPct} className="w-[110px] !min-h-[26px] !py-0.5 !px-2 !text-[12px] text-right"
                  onChange={e => setGuardianPct(Number(e.target.value))} />
              </label>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-[var(--color-text-sub)]" title="Bank profitable positions before long market closures.">Weekend profit bank</span>
                <Pill on={weekendBank} label="On" onClick={() => {
                  const next = !weekendBank
                  setWeekendBank(next)
                  save('weekend-bank', () => agentPost('/actions/weekend-bank', { on: next }))
                }} />
              </div>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-[var(--color-text-sub)]" title="Flag (action_log + Telegram) losing positions before long market closures. Never closes them — same reasoning as leaving losers alone in the profit bank above.">Weekend loss flag</span>
                <Pill on={weekendLossFlag} label="On" onClick={() => {
                  const next = !weekendLossFlag
                  setWeekendLossFlag(next)
                  save('weekend-loss-flag', () => agentPost('/actions/weekend-loss-flag', { on: next }))
                }} />
              </div>
            </div>
            <div className="mt-3">
              <span data-save-pulse="risk"><Button size="sm" onClick={() => {
                saveRisk(['perTradeRiskPct', 'perTradeRiskUsd', 'maxRiskCapPct', 'maxRiskUsd', 'minLotSize', 'minRR', 'minSLDistancePct', 'maxSpreadFracOfSL', 'maxOpenPositions', 'symbolCooldownMinutes', 'maxConsecutiveLosses', 'cooldownMinutes', 'maxClusterExposure', 'maxCurrencyExposure', 'minTradesForKelly', 'allowNegativeExpectancyOverride'])
                save('guardian', () => agentPost('/actions/guardian-move-pct', { pct: guardianPct }))
              }}>Save bot risk</Button></span>
            </div>
          </Card>

          <Card data-risk-card data-risk-reveal className="w3-hover-shadow">
            <SectionTitle badge={<Badge tone="special">C++ sidecar</Badge>}>Cpp risk configuration</SectionTitle>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-[var(--color-text-sub)]" title="Kill switch: the C++ engine refuses EVERY order while halted.">Halt (kill switch)</span>
                <Pill on={!!guard.halt} label={guard.halt ? 'Halted — no orders' : 'Off'} onClick={() => setGuard(g => ({ ...g, halt: !g.halt }))} />
              </div>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-[var(--color-text-sub)]" title="A market order with no stop loss is refused — last line of defence.">Require stop loss</span>
                <Pill on={guard.requireBracket !== false} label="On" onClick={() => setGuard(g => ({ ...g, requireBracket: !(g.requireBracket !== false) }))} />
              </div>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-[var(--color-text-sub)]" title="A market order with no take profit is refused.">Require take profit</span>
                <Pill on={guard.requireTarget !== false} label="On" onClick={() => setGuard(g => ({ ...g, requireTarget: !(g.requireTarget !== false) }))} />
              </div>
              <Field label="Max order volume (units×100)" value={guard.maxOrderVolume} onChange={v => setGuard(g => ({ ...g, maxOrderVolume: v }))}
                hint="Hard cap on a single order's cTrader volume. 0 = no cap." width="w-[130px]" />
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-[var(--color-text-sub)]" title="Virtual Pending Order engine — feeder side. The sidecar's own VPO_ENABLED/VPO_SYMBOLS env must also be set.">VPO feeder</span>
                <Pill on={vpoEnabled} label="On" onClick={() => {
                  const next = !vpoEnabled
                  setVpoEnabled(next)
                  save('vpo', () => agentPost('/actions/vpo-settings', { enabled: next }))
                }} />
              </div>
              <div className="text-[11px] text-[var(--color-text-sub)]">
                VPO pairs: {data?.vpo?.config?.length ? data.vpo.config.map(c => `${c.symbol}·${c.key}`).join(', ') : 'none configured'} — set via /actions/vpo-settings; the sidecar's VPO_SYMBOLS env must match.
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span data-save-pulse="exec-guard"><Button size="sm" onClick={() => save('exec-guard', () => agentPost('/actions/exec-guard', guard))}>Save cpp guard</Button></span>
            </div>
          </Card>

          <Card data-risk-card data-risk-reveal className="w3-hover-shadow">
            <SectionTitle badge={<Badge tone="down">Emergency</Badge>}>Close all positions</SectionTitle>
            <p className="text-[12px] text-[var(--color-text-sub)] mb-2">
              Closes every open position at the broker right now — bot-placed and manual alike. Halt (above) only blocks NEW orders; this ends existing ones. Irreversible.
            </p>
            <Button size="sm" variant="danger" disabled={closingAll} onClick={closeAll}>
              {closingAll ? 'Closing…' : 'Close ALL positions'}
            </Button>
            {closeAllResult && (
              <div className="mt-2 text-[12px] text-[var(--color-text-sub)]">
                Closed {closeAllResult.closed?.length || 0}
                {closeAllResult.failures?.length ? `, ${closeAllResult.failures.length} failed: ${closeAllResult.failures.map(f => `${f.symbol || f.positionId} (${f.error})`).join('; ')}` : ''}
              </div>
            )}
          </Card>
        </div>

        {/* ---- Right column: worked examples ---- */}
        <div className="space-y-4">
          <Card data-risk-card className="w3-hover-shadow">
            <SectionTitle>Example trade — bot-trade live</SectionTitle>
            <MiniChart entry={entry} sl={sl} tp={tp} />
            <div className="text-[11px] space-y-1 mt-2">
              <div>Sample: EURUSD long at {entry.toFixed(4)}, balance {fmt$(bal, 0)} USD.</div>
              <div>SL {sl.toFixed(4)} (min distance {Number(risk.minSLDistancePct) || 0.15}%) · TP {tp.toFixed(4)} ({Number(risk.minRR) || 1.5}R).</div>
              <div>Risk budget: <AnimatedNumber value={budget} className="font-semibold" />{budget < budgetBase ? ` (capped from ${fmt$(budgetBase)})` : ''} → <AnimatedNumber value={lots} className="font-semibold" /> lots at ~<AnimatedNumber value={usdPerLot} />/lot.</div>
              <div className="text-[var(--color-text-sub)]">
                Then the gate still checks: daily cap, loss streak, max {risk.maxOpenPositions ?? 5} open, one-per-symbol, spread ≤ {((Number(risk.maxSpreadFracOfSL) || 0.25) * 100).toFixed(0)}% of SL, cluster/currency exposure, margin headroom at 1:{acct.leverage || 100} — ANY failure vetoes with a logged reason.
              </div>
            </div>
          </Card>
          <Card data-risk-card data-risk-reveal className="w3-hover-shadow">
            <SectionTitle>Example trade — cpp configuration</SectionTitle>
            <MiniChart entry={entry} sl={sl} tp={tp} trigger={entry - slDist * 0.4} />
            <div className="text-[11px] space-y-1 mt-2">
              <div>Same order arrives at the C++ engine as volume {cppVolumeUnits.toLocaleString()}:</div>
              <div>{guard.halt ? '✗ REJECTED — engine halted (kill switch on)' : '✓ not halted'}</div>
              <div>{guard.requireBracket !== false ? '✓ stop loss attached — passes bracket guard' : '⚠ bracket guard OFF — naked orders allowed'}</div>
              <div>{guard.requireTarget !== false ? '✓ take profit attached — passes target guard' : '⚠ target guard OFF'}</div>
              <div>{guard.maxOrderVolume > 0 ? (volCapped ? `✗ REJECTED — volume ${cppVolumeUnits.toLocaleString()} exceeds cap ${Number(guard.maxOrderVolume).toLocaleString()}` : `✓ under the ${Number(guard.maxOrderVolume).toLocaleString()} volume cap`) : '— no volume cap set'}</div>
              <div className="text-[var(--color-text-sub)]">
                VPO path: {vpoEnabled ? 'the dispatcher arms at the strategy level (violet line) and fires a market order the instant price touches it — sizing comes from the Node feeder; stale (>5 min) bars or sizing refuse to fire.' : 'VPO feeder is OFF — no virtual pending orders arm.'}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
