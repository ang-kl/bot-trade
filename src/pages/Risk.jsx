// Risk — every risk setting that was previously hardcoded or scattered,
// in the owner's layout: Global cTrader config across the top; Account
// Risk (left); Bot Trade Risk + Cpp Risk (middle); a worked example trade
// per engine (right), recomputed live from whatever is on screen so the
// numbers always show what the CURRENT settings would actually do.
// Writes go through the same routes the agent already enforces:
// /actions/risk-config, /actions/balance, /actions/guardian-move-pct,
// /actions/weekend-bank, /actions/weekend-loss-flag, /actions/exec-guard,
// /actions/vpo-settings, /actions/close-all.
import SectionNavFab from '../components/common/SectionNavFab.jsx'
import { useEffect, useState, useCallback, useRef } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import Input from '../components/common/Input.jsx'
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'
import WorkedExample from '../components/common/WorkedExample.jsx'
import Field, { Unit, FIELD_W, DEFAULT_MARK } from '../components/common/Field.jsx'
import { ratchetExample, guardianExample } from '../lib/worked-examples.js'

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

// Tiny bordered pill toggle.
//
// Owner 2026-07-28: "if current state is OFF, state 'Off' in red bold text
// with red border button."
//
// That request exposed a genuine defect, not just a styling gap. Eleven
// pills on this page are boolean toggles whose label is the word "On", and
// the off branch rendered label.toUpperCase() — so a DISABLED per-position
// loss cap displayed the word "ON" in grey. On a safety control that is the
// worst possible failure of a label: you read "ON" and believe your loss
// floor is armed when it is not.
//
// Boolean toggles now pass offLabel and get an unmistakable off state — red
// bold text, red border, faint red wash. Segmented either/or choices (Scope,
// Action on breach, At the floor) pass no offLabel and keep the neutral
// treatment, because their unselected side is an alternative, not a danger.
function Pill({ on, label, offLabel = null, onClick }) {
  const off = offLabel != null
    ? 'border-[var(--color-down)] text-[var(--color-down)] font-bold bg-[color-mix(in_srgb,var(--color-down)_10%,transparent)]'
    : 'border-[var(--glass-edge)] text-[var(--color-text-sub)] font-bold uppercase'
  return (
    <button type="button" onClick={onClick} aria-pressed={!!on}
      className={`rounded-[var(--radius-control)] border px-[4px] py-[3px] text-[9px] cursor-pointer ${on
        ? 'border-[var(--color-accent)] text-[var(--color-accent)] font-normal'
        : off}`}>
      {on ? label : (offLabel ?? label.toUpperCase())}
    </button>
  )
}

// Save buttons: "Overall save button can be 1 point increase font size."
const SAVE_BTN = '!text-[10px]'

// Compact labelled field. `pct` fields edit in % but store fractions.
// EVERY entry field is the SAME fixed width (owner 2026-07-24: "the size of
// field-entry must be uniform as I am OCD"). The !important prefix is
// load-bearing: the Input component's own base class is `w-full`, which was
// silently winning over a plain w-[120px] — that is exactly why the fields
// rendered full-width and "Guardian move %" wrapped onto two lines in the
// owner's screenshot.
// UI-6: Field / Unit / DEFAULT_MARK / the duration input now live in
// components/common/Field.jsx so the Tune page renders identical rows. The
// markup moved verbatim — this page's rendering is unchanged.

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
    <div className="flex items-center gap-2 mb-1">
      <h3 className="t-h3">{children}</h3>
      {badge}
    </div>
  )
}

const RISK_SECTIONS = [
  { id: 'sec-account', label: 'Account snapshot' },
  { id: 'sec-protection', label: 'Position protection' },
  { id: 'sec-acct-risk', label: 'Account risk config' },
  { id: 'sec-bot-risk', label: 'Bot Trade risk config' },
  { id: 'sec-sizing', label: 'Sizing' },
  { id: 'sec-cpp', label: 'C++ sidecar' },
  { id: 'sec-emergency', label: 'Emergency' },
  { id: 'sec-example-live', label: 'Example — live' },
  { id: 'sec-example-cpp', label: 'Example — cpp' },
]

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
  // A2 protection layers (owner 2026-07-28: the GOOGL −$900 sat unprotected
  // because nothing enforced an absolute floor). Local editable copies of the
  // three layers' configs; each saves to its own /actions route.
  const [lossCap, setLossCap] = useState(null)
  const [ratchet, setRatchet] = useState(null)
  const [ratchetState, setRatchetState] = useState(null)
  const [guardian2, setGuardian2] = useState(null)

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
      if (r.lossCap) setLossCap(r.lossCap.effective)
      if (r.profitRatchet) { setRatchet(r.profitRatchet.effective); setRatchetState(r.profitRatchet.state) }
      if (r.lossGuardian) setGuardian2(r.lossGuardian.effective)
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
  const mark = (k) => overridden.has(k) ? '' : DEFAULT_MARK

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
    <div className="space-y-2" data-risk-dense>
      <SectionNavFab sections={RISK_SECTIONS} />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-bold t-heading">Risk</h1>
        <span className="text-[9px] text-[var(--color-text-sub)]">every layer's limits in one place — changes apply to the live gate on save</span>
        {saving && <Badge tone="info">saving {saving}…</Badge>}
      </div>
      {error && <Card className="border-[var(--color-down)] text-[9px]">{error}</Card>}

      {/* ---- Live impact strip (migrated from Tune > Risk, UI-6) ----------
          Percentages are the units the gate uses, but they are not the units
          a decision is made in. This turns the three that matter into money,
          recomputed from the values ON SCREEN — so the consequence is visible
          BEFORE saving, not after the first trade sized off a typo.
          Every tile shows a dash when its inputs are missing; none of them
          fall back to a plausible number. */}
      {(() => {
        const b = Number(acct.balance)
        const money = (v) => `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
        const usd = (frac) => {
          const f = Number(frac)
          return b > 0 && Number.isFinite(f) && frac !== '' && frac != null ? money(b * f) : '—'
        }
        const perTrade = Number(risk.perTradeRiskUsd) > 0 ? Number(risk.perTradeRiskUsd) : null
        const maxOpen = Number(risk.maxOpenPositions)
        // Worst case = every slot open and every one stopped out. The honest
        // ceiling, and the number the daily cap has to survive.
        const worst = b > 0 && Number.isFinite(maxOpen) && maxOpen > 0
          ? (perTrade != null ? perTrade * maxOpen
            : (Number.isFinite(Number(risk.perTradeRiskPct)) ? b * Number(risk.perTradeRiskPct) * maxOpen : null))
          : null
        const tiles = [
          ['Balance', b > 0 ? money(b) : 'not set'],
          ['Risk per trade', perTrade != null ? `${money(perTrade)} (fixed $)` : usd(risk.perTradeRiskPct)],
          ['Daily stop-out', usd(risk.dailyLossPct)],
          ['Worst case open', worst != null ? money(worst) : '—'],
        ]
        return (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {tiles.map(([label, value]) => (
              <div key={label} className="glass-inset rounded-[10px] px-3 py-2">
                <div className="text-[9px] text-[var(--color-text-sub)]">{label}</div>
                <div className="text-[9px] font-bold tabular-nums">{value}</div>
              </div>
            ))}
          </div>
        )
      })()}

      {/* ---- Global Account aka cTrader Risk Configuration ---- */}
      <Card id="sec-account" data-risk-card className="w3-hover-shadow">
        <SectionTitle badge={data?.account?.isLive ? <Badge tone="down">LIVE</Badge> : <Badge tone="info">DEMO</Badge>}>
          Global Account — cTrader risk configuration
        </SectionTitle>
        <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
          <div>
            <Field label="Account balance (USD)" value={acct.balance} onChange={v => setAcct(a => ({ ...a, balance: v }))}
              hint="The balance every % figure below is computed from." />
            <div className="text-[9px] text-[var(--color-text-sub)] mt-0.5">
              {data?.account?.balanceSource === 'broker'
                ? `live from the broker (snapshot ${data?.account?.balanceFetchedAt ? new Date(data.account.balanceFetchedAt).toLocaleTimeString() : ''}) — edits here override until the next sync`
                : 'stored value — connect/refresh the broker for live truth'}
            </div>
          </div>
          <Field label="Leverage (1:N)" value={acct.leverage} onChange={v => setAcct(a => ({ ...a, leverage: v }))}
            hint="Used for margin-headroom checks before approving a position." recommend="1:100 — match whatever your broker account actually offers." />
          <div className="text-[9px]">
            <span className="text-[var(--color-text-sub)]">Broker stop-out level </span>
            <span className="font-semibold">{data?.account?.brokerStopOutPct ?? 50}%</span>
            <span className="text-[9px] text-[var(--color-text-sub)]"> margin level — broker-enforced liquidation, not editable</span>
          </div>
          <div className="text-[9px]">
            <span className="text-[var(--color-text-sub)]">Account </span>
            <span className="font-semibold">{data?.account?.accountId || '—'}</span>
          </div>
          <span data-save-pulse="account">
            <Button size="sm" className={SAVE_BTN} onClick={() => save('account', () => agentPost('/actions/balance', { balance: acct.balance, leverage: acct.leverage }))}>Save account</Button>
          </span>
        </div>
      </Card>

      {/* ---- Position protection: the three layers that answer "you didn't
           do anything to prevent the loss earlier" (GOOGL −$900). Ordered by
           when they act: per-position floor → account staircase → naked-
           position safety net. Each saves to its own route so a typo in one
           card can't wipe another layer's config. ---- */}
      <Card id="sec-protection" data-risk-card className="w3-hover-shadow">
        <SectionTitle badge={<Badge tone="down">Protection</Badge>}>Position protection — loss floors &amp; profit lock-in</SectionTitle>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-start">

          {/* Layer 1 — per-position loss cap (A1) */}
          <div className="glass-inset rounded-[1px] p-2 space-y-2">
            <div className="flex items-center justify-between text-[9px]">
              <span className="font-semibold" title="Checks every open position's floating P&L each minute against the tighter of the $ and % caps below. On breach it closes the position (or alerts, per Action).">Per-position loss cap</span>
              <Pill on={!!lossCap?.on} label="On" offLabel="Off" onClick={() => setLossCap(c => ({ ...c, on: !c?.on }))} />
            </div>
            <Field label="Max loss per position" unit="$" value={lossCap?.maxLossUsd} onChange={v => setLossCap(c => ({ ...c, maxLossUsd: v }))}
              placeholder="% only"
              hint="Absolute dollar floor for ONE position's floating loss. The $900 GOOGL slide would have been cut at this number. Empty leaves only the % cap below." recommend="$500 — or whatever one trade is allowed to cost you." />
            <Field label="Max loss, % of balance" unit="%" value={lossCap?.maxLossPctOfBalance} onChange={v => setLossCap(c => ({ ...c, maxLossPctOfBalance: v }))}
              placeholder="$ only"
              hint="Same floor as % of current balance; the TIGHTER of the two caps applies. 2% of $48,000 ≈ $960." recommend="2% of balance." />
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-[var(--color-text-sub)]" title="'all' watches every broker position including manual ones; 'bot' only the bot's own ledger positions.">Scope</span>
              <span className="flex gap-1">
                <Pill on={lossCap?.scope !== 'bot'} label="All positions" onClick={() => setLossCap(c => ({ ...c, scope: 'all' }))} />
                <Pill on={lossCap?.scope === 'bot'} label="Bot only" onClick={() => setLossCap(c => ({ ...c, scope: 'bot' }))} />
              </span>
            </div>
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-[var(--color-text-sub)]" title="'Close' flattens the breaching position at market; 'Alert' only sends Telegram and leaves it open.">Action on breach</span>
              <span className="flex gap-1">
                <Pill on={lossCap?.action !== 'alert'} label="Close" onClick={() => setLossCap(c => ({ ...c, action: 'close' }))} />
                <Pill on={lossCap?.action === 'alert'} label="Alert only" onClick={() => setLossCap(c => ({ ...c, action: 'alert' }))} />
              </span>
            </div>
            <Field label="Retry after failed close" unit="min" value={lossCap?.retryMinutes} onChange={v => setLossCap(c => ({ ...c, retryMinutes: v }))}
              hint="If a breach close fails (market closed, broker error), re-attempt after this long instead of hammering." recommend="10 minutes." />
            {(() => {
              const balNow = Number(acct.balance) || null
              const pctCap = lossCap?.maxLossPctOfBalance != null && balNow ? balNow * lossCap.maxLossPctOfBalance / 100 : null
              const eff = [lossCap?.maxLossUsd, pctCap].filter(v => v != null && v > 0)
              return (
                <div className="text-[9px] text-[var(--color-text-sub)]">
                  Effective cap right now: <b className="text-[var(--color-text)]">{eff.length ? `$${fmt$(Math.min(...eff))}` : 'none — both caps empty'}</b>
                </div>
              )
            })()}
            <span data-save-pulse="loss-cap"><Button size="sm" className={SAVE_BTN} onClick={() => save('loss-cap', () => agentPost('/actions/loss-cap', lossCap))}>Save loss cap</Button></span>
          </div>

          {/* Layer 2 — profit ratchet staircase (A4) */}
          <div className="glass-inset rounded-[1px] p-2 space-y-2">
            <div className="flex items-center justify-between text-[9px]">
              <span className="font-semibold" title="Locks in gains on the way to the $100k goal: every full step of equity growth raises a protected floor one step behind the high-water mark. Falling back to the floor flattens bot positions and disarms autotrade — banked profit stays banked.">Profit ratchet (staircase)</span>
              <Pill on={!!ratchet?.on} label="On" offLabel="Off" onClick={() => setRatchet(c => ({ ...c, on: !c?.on }))} />
            </div>
            <Field label="Step size" unit="$" value={ratchet?.stepUsd} onChange={v => setRatchet(c => ({ ...c, stepUsd: v }))}
              placeholder="auto"
              hint="Equity growth per banked step. Empty = automatic: 1% of balance, clamped $25–$500 — scales itself as the account grows." recommend="auto (owner's '$500 min. / 1% min.' rule)." />
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-[var(--color-text-sub)]" title="'Flatten' closes the bot's positions AND disarms autotrade at the floor; 'Halt' only disarms, leaving positions to their own SL/TP.">At the floor</span>
              <span className="flex gap-1">
                <Pill on={ratchet?.floorAction !== 'halt'} label="Flatten" onClick={() => setRatchet(c => ({ ...c, floorAction: 'flatten' }))} />
                <Pill on={ratchet?.floorAction === 'halt'} label="Halt only" onClick={() => setRatchet(c => ({ ...c, floorAction: 'halt' }))} />
              </span>
            </div>
            {(() => {
              const st = ratchetState
              const balNow = Number(acct.balance) || null
              const step = ratchet?.stepUsd > 0 ? ratchet.stepUsd : (balNow ? Math.min(500, Math.max(25, balNow * 0.01)) : null)
              const steps = st && step > 0 ? Math.max(0, Math.floor((st.hwm - st.baseline) / step)) : 0
              const floor = st && step > 0 && steps >= 1 ? st.baseline + (steps - 1) * step : null
              return st ? (
                <div className="glass-inset rounded-[1px] p-2 text-[9px] space-y-0.5">
                  <div className="font-semibold">Live staircase</div>
                  <div className="grid grid-cols-2 gap-x-3">
                    <span className="text-[var(--color-text-sub)]">Baseline</span><span className="text-right tabular-nums">${fmt$(st.baseline)}</span>
                    <span className="text-[var(--color-text-sub)]">High-water mark</span><span className="text-right tabular-nums">${fmt$(st.hwm)}</span>
                    <span className="text-[var(--color-text-sub)]">Steps banked</span><span className="text-right tabular-nums">{steps}</span>
                    <span className="text-[var(--color-text-sub)]">Protected floor</span>
                    <span className="text-right tabular-nums font-semibold">{floor != null ? `$${fmt$(floor)}` : 'not yet — needs 1 full step'}</span>
                    {step > 0 && <>
                      <span className="text-[var(--color-text-sub)]">Next step banks at</span>
                      <span className="text-right tabular-nums">${fmt$(st.baseline + (steps + 1) * step)}</span>
                    </>}
                  </div>
                </div>
              ) : (
                // No live staircase to show. THIS is where a worked example
                // earns its place: once the ratchet has run, the real
                // baseline/HWM/floor above beats any hypothetical.
                <div className="text-[9px] text-[var(--color-text-sub)] space-y-1">
                  <div>No staircase state yet — it baselines at current equity on the ratchet's first pass after enabling.</div>
                  <WorkedExample label="What that will look like"
                    lines={ratchetExample({ balance: balNow, stepUsd: ratchet?.stepUsd })} />
                </div>
              )
            })()}
            <div className="flex items-center gap-2">
              <span data-save-pulse="ratchet"><Button size="sm" className={SAVE_BTN} onClick={() => save('ratchet', () => agentPost('/actions/profit-ratchet', ratchet))}>Save ratchet</Button></span>
              <Button size="sm" variant="ghost" onClick={() => {
                if (!window.confirm('Re-baseline the staircase at CURRENT equity? Banked floors are forgotten (use after a deposit/withdrawal).')) return
                save('ratchet', () => agentPost('/actions/profit-ratchet', { ...ratchet, resetState: true }))
              }}>Reset staircase</Button>
            </div>
          </div>

          {/* Layer 3 — Loss Guardian: the safety net for naked positions */}
          <div className="glass-inset rounded-[1px] p-2 space-y-2">
            <div className="flex items-center justify-between text-[9px]">
              <span className="font-semibold" title="Safety net for positions with NO stop loss (usually manual/external ones): places a protective stop at the ATR distance below, or closes outright if price is already past it. Never touches a position that has its own stop.">Loss Guardian</span>
              <Pill on={!!guardian2?.on} label="On" offLabel="Off" onClick={() => setGuardian2(c => ({ ...c, on: !c?.on }))} />
            </div>
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-[var(--color-text-sub)]" title="'all' = any naked position, bot or manual; 'external' = only manual/external ones.">Scope</span>
              <span className="flex gap-1">
                <Pill on={guardian2?.scope !== 'external'} label="All naked" onClick={() => setGuardian2(c => ({ ...c, scope: 'all' }))} />
                <Pill on={guardian2?.scope === 'external'} label="External only" onClick={() => setGuardian2(c => ({ ...c, scope: 'external' }))} />
              </span>
            </div>
            <Field label="Protective stop distance" unit="×ATR" value={guardian2?.maxAtrMult} onChange={v => setGuardian2(c => ({ ...c, maxAtrMult: v }))}
              hint="Stop placed this many ATRs (1h, period 14) from entry — wide on purpose so mean-reversion room survives, but a runaway loser is still capped." recommend="3 × ATR." />
            <Field label="Fallback cap (no ATR)" pct value={guardian2?.fallbackAdversePct} onChange={v => setGuardian2(c => ({ ...c, fallbackAdversePct: v }))}
              hint="When ATR data is unavailable, cap the adverse move at this % of entry price instead." recommend="2% of entry price." />
            <Field label="Max hold time" unit="h" value={guardian2?.maxHoldHours} onChange={v => setGuardian2(c => ({ ...c, maxHoldHours: v }))}
              placeholder="off"
              hint="Optional hard time cap: a position without its own time cap is closed after this many hours regardless of P&L." recommend="unset — let price levels decide, unless positions keep rotting for days." />
            <WorkedExample lines={guardianExample(guardian2 || {})} label="Worked example" />
            <span data-save-pulse="loss-guardian"><Button size="sm" className={SAVE_BTN} onClick={() => save('loss-guardian', () => agentPost('/actions/loss-guardian', guardian2))}>Save guardian</Button></span>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-[270px_1fr_270px] gap-3 items-start">
        {/* ---- Account Risk Configuration (left) ---- */}
        <Card id="sec-acct-risk" data-risk-card className="w3-hover-shadow">
          <SectionTitle>Account risk configuration</SectionTitle>
          <div className="space-y-2">
            <Field label={`Daily loss cap${mark('dailyLossPct')}`} pct value={risk.dailyLossPct} onChange={v => setRisk(r => ({ ...r, dailyLossPct: v }))}
              hint="New entries stop for the day once closed P&L is down this % of balance." recommend="3% of balance." />
            <Field label={`Daily cap fallback $${mark('dailyLossLimit')}`} unit="$" value={risk.dailyLossLimit} onChange={v => setRisk(r => ({ ...r, dailyLossLimit: v }))}
              hint="Absolute USD cap used only when balance is unknown." recommend="$300." />
            <Field label={`Equity stop${mark('equityStopPct')}`} pct value={risk.equityStopPct} onChange={v => setRisk(r => ({ ...r, equityStopPct: v }))}
              hint="Daily drawdown at which the loop CLOSES all bot positions and disarms (empty = same as daily loss cap)." recommend="unset — falls back to the daily loss cap above." />
            <Field label={`Max margin usage${mark('maxMarginUsagePct')}`} pct value={risk.maxMarginUsagePct} onChange={v => setRisk(r => ({ ...r, maxMarginUsagePct: v }))}
              hint="Bot's own cap on margin locked as a % of balance — separate from the broker's 50% stop-out." recommend="50% of balance." />
            <div className="border-t border-[var(--glass-edge)] pt-2 space-y-2">
              <div className="flex items-center justify-between text-[9px]">
                <span className="text-[var(--color-text-sub)]" title="A losing run sizes DOWN automatically instead of compounding.">Drawdown de-risk{mark('deriskOnDrawdown')}</span>
                <Pill on={!!risk.deriskOnDrawdown} label="On" offLabel="Off" onClick={() => setRisk(r => ({ ...r, deriskOnDrawdown: !r.deriskOnDrawdown }))} />
              </div>
              <Field label={`window${mark('deriskWindowHours')}`} unit="h" value={risk.deriskWindowHours} onChange={v => setRisk(r => ({ ...r, deriskWindowHours: v }))}
                recommend="24 hours." />
              <Field label={`trigger${mark('deriskTriggerPct')}`} pct value={risk.deriskTriggerPct} onChange={v => setRisk(r => ({ ...r, deriskTriggerPct: v }))}
                hint="Down more than this % of balance in the window → de-risk." recommend="5% down in the window." />
              <Field label={`size multiplier${mark('deriskMult')}`} unit="×" value={risk.deriskMult} onChange={v => setRisk(r => ({ ...r, deriskMult: v }))}
                hint="Budget × this while de-risked (0.5 = half size)." recommend="0.5 (half size)." />
            </div>
            <label className="block text-[9px]">
              <span className="text-[var(--color-text-sub)]" title="Symbols vetoed outright, comma-separated.">Blocked symbols{mark('blockedSymbols')}</span>
              <Input type="text" value={(risk.blockedSymbols || []).join(', ')}
                onChange={e => setRisk(r => ({ ...r, blockedSymbols: e.target.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) }))}
                placeholder="e.g. BTCUSD, USDIDR" className="!min-h-[26px] !py-0.5 !px-2 !text-[9px]" />
            </label>
            <div className="flex items-center gap-2">
              <span data-save-pulse="risk"><Button size="sm" className={SAVE_BTN} onClick={() => saveRisk(['dailyLossPct', 'dailyLossLimit', 'equityStopPct', 'maxMarginUsagePct', 'deriskOnDrawdown', 'deriskWindowHours', 'deriskTriggerPct', 'deriskMult', 'blockedSymbols'])}>Save account risk</Button></span>
              {/* Migrated from Tune > Risk (UI-6). This resets EVERY key in
                  risk_config_json, not just this card's — it is the only
                  control on the page with that reach, so it confirms first. */}
              <Button size="sm" variant="ghost" onClick={() => {
                if (!window.confirm('Reset the ENTIRE risk config to defaults? Every field on this page returns to its shipped value — sizing, caps, cooldowns, exposure limits. Your account balance and leverage are not touched.')) return
                save('risk', () => agentPost('/actions/risk-config', { reset: true }))
              }}>Reset to defaults</Button>
            </div>
          </div>
        </Card>

        {/* ---- Middle column: Bot Trade + Cpp ---- */}
        {/* @container: the two field grids below key their column count off
            THIS column's own rendered width (md:/xl: would key off the whole
            page's viewport instead, which is fixed 270px narrower on each
            side here — at some zoom levels that mismatch made a "3-column"
            viewport width map to a middle column too narrow to actually fit
            3 fields, squeezing/wrapping them). @sm:/@xl: below track this
            container, so the field grid degrades gracefully regardless of
            browser zoom. */}
        <div className="space-y-2 @container">
          <Card id="sec-bot-risk" data-risk-card className="w3-hover-shadow">
            <SectionTitle>Bot Trade risk configuration</SectionTitle>
            {/* Grouped (owner 2026-07-28: "SL is all over the place" — every
                SL/TP knob now lives under ONE header, sizing under another,
                and each number carries its unit chip). */}
            <div className="space-y-3">
              <div>
                <div className="text-[8px] font-semibold uppercase tracking-wide text-[var(--color-text-sub)] border-b border-[var(--glass-edge)] pb-0.5 mb-1">Entry sizing</div>
                <div className="grid grid-cols-1 @sm:grid-cols-2 @xl:grid-cols-3 gap-x-5 gap-y-1">
                  <Field label={`Per-trade risk${mark('perTradeRiskPct')}`} pct value={risk.perTradeRiskPct} onChange={v => setRisk(r => ({ ...r, perTradeRiskPct: v }))}
                    hint="% of balance one trade may lose at its SL." recommend="5% (aggressive default, sized against the proven combos)." />
                  <Field label={`Risk $ override${mark('perTradeRiskUsd')}`} unit="$" value={risk.perTradeRiskUsd} onChange={v => setRisk(r => ({ ...r, perTradeRiskUsd: v }))}
                    hint="Absolute $ risk per trade; when set, overrides the %." placeholder="% only" recommend="unset — leave the % in charge unless you specifically want a fixed $ risk." />
                  <Field label={`Risk hard cap${mark('maxRiskCapPct')}`} pct value={risk.maxRiskCapPct} onChange={v => setRisk(r => ({ ...r, maxRiskCapPct: v }))}
                    hint="Never risk more than this % of balance regardless of other settings." recommend="5% — matches the per-trade % above, so it's a true ceiling, not extra headroom." />
                  <Field label={`Risk hard cap $${mark('maxRiskUsd')}`} unit="$" value={risk.maxRiskUsd} onChange={v => setRisk(r => ({ ...r, maxRiskUsd: v }))}
                    hint="Optional absolute $ ceiling per trade." placeholder="no cap" recommend="unset — no $ ceiling by default." />
                  <Field label={`Min lot size${mark('minLotSize')}`} unit="lots" value={risk.minLotSize} onChange={v => setRisk(r => ({ ...r, minLotSize: v }))}
                    recommend="0.01 — the broker's own minimum." />
                  <Field label={`Kelly min trades${mark('minTradesForKelly')}`} unit="trades" value={risk.minTradesForKelly} onChange={v => setRisk(r => ({ ...r, minTradesForKelly: v }))}
                    hint="Below this trade count, Kelly sizing is skipped." recommend="30 closed trades before Kelly sizing kicks in." />
                  <div className="flex items-center justify-between text-[9px]">
                    <span className="text-[var(--color-text-sub)]" title="If off, negative-expectancy combos are vetoed.">Allow −expectancy{mark('allowNegativeExpectancyOverride')}</span>
                    <Pill on={!!risk.allowNegativeExpectancyOverride} label="On" offLabel="Off" onClick={() => setRisk(r => ({ ...r, allowNegativeExpectancyOverride: !r.allowNegativeExpectancyOverride }))} />
                  </div>
                </div>
              </div>
              <div>
                <div className="text-[8px] font-semibold uppercase tracking-wide text-[var(--color-text-sub)] border-b border-[var(--glass-edge)] pb-0.5 mb-1">Stop Loss &amp; Take Profit</div>
                <div className="grid grid-cols-1 @sm:grid-cols-2 @xl:grid-cols-3 gap-x-5 gap-y-1">
                  <Field label={`Min SL distance${mark('minSLDistancePct')}`} unit="% px" value={risk.minSLDistancePct} onChange={v => setRisk(r => ({ ...r, minSLDistancePct: v }))}
                    hint="% of price — stops tighter than this get swept by noise. (Entered as a plain percent: 0.15 = 0.15% of price.)" recommend="0.15% of price." />
                  <Field label={`Min R:R${mark('minRR')}`} unit="×SL" value={risk.minRR} onChange={v => setRisk(r => ({ ...r, minRR: v }))}
                    hint="TP must sit at least this multiple of the SL distance from entry — the take-profit rule." recommend="1.5 — TP at least 1.5× the SL distance." />
                  <Field label={`Max spread / SL${mark('maxSpreadFracOfSL')}`} pct value={risk.maxSpreadFracOfSL} onChange={v => setRisk(r => ({ ...r, maxSpreadFracOfSL: v }))}
                    hint="Veto when the live spread exceeds this fraction of the SL distance." recommend="25% of the SL distance." />
                </div>
                <div className="text-[8px] text-[var(--color-text-sub)] mt-1">
                  Dollar loss floors per position (the GOOGL case) live in <a href="#sec-protection" className="underline">Position protection</a> above — this group only shapes where SL/TP are PLACED at entry.
                </div>
              </div>
              <div>
                <div className="text-[8px] font-semibold uppercase tracking-wide text-[var(--color-text-sub)] border-b border-[var(--glass-edge)] pb-0.5 mb-1">Exposure limits</div>
                <div className="grid grid-cols-1 @sm:grid-cols-2 @xl:grid-cols-3 gap-x-5 gap-y-1">
                  <Field label={`Max open positions${mark('maxOpenPositions')}`} unit="pos" value={risk.maxOpenPositions} onChange={v => setRisk(r => ({ ...r, maxOpenPositions: v }))}
                    recommend="5 concurrent positions." />
                  <Field label={`Cluster exposure${mark('maxClusterExposure')}`} unit="bets" value={risk.maxClusterExposure} onChange={v => setRisk(r => ({ ...r, maxClusterExposure: v }))}
                    hint="Net directional bets allowed per correlation cluster. 0 = off." recommend="2 net directional bets per cluster." />
                  <Field label={`Currency exposure${mark('maxCurrencyExposure')}`} unit="bets" value={risk.maxCurrencyExposure} onChange={v => setRisk(r => ({ ...r, maxCurrencyExposure: v }))}
                    recommend="2 net bets per currency." />
                </div>
              </div>
              <div>
                <div className="text-[8px] font-semibold uppercase tracking-wide text-[var(--color-text-sub)] border-b border-[var(--glass-edge)] pb-0.5 mb-1">Cooldowns &amp; streaks</div>
                <div className="grid grid-cols-1 @sm:grid-cols-2 @xl:grid-cols-3 gap-x-5 gap-y-1">
                  <Field label={`Symbol cooldown${mark('symbolCooldownMinutes')}`} unit="min" duration value={risk.symbolCooldownMinutes} onChange={v => setRisk(r => ({ ...r, symbolCooldownMinutes: v }))}
                    hint="Lock a symbol after any closed trade on it." recommend="240 minutes (4h) after any closed trade on that symbol." />
                  <Field label={`Loss streak${mark('maxConsecutiveLosses')}`} unit="losses" value={risk.maxConsecutiveLosses} onChange={v => setRisk(r => ({ ...r, maxConsecutiveLosses: v }))}
                    hint="After N losses in a row, pause. 0 = off." recommend="3 losses in a row." />
                  <Field label={`Streak cooldown${mark('cooldownMinutes')}`} unit="min" duration value={risk.cooldownMinutes} onChange={v => setRisk(r => ({ ...r, cooldownMinutes: v }))}
                    recommend="60 minutes." />
                </div>
              </div>
              <div>
                <div className="text-[8px] font-semibold uppercase tracking-wide text-[var(--color-text-sub)] border-b border-[var(--glass-edge)] pb-0.5 mb-1">Monitoring &amp; weekends</div>
                <div className="grid grid-cols-1 @sm:grid-cols-2 @xl:grid-cols-3 gap-x-5 gap-y-1">
                  <Field label="Guardian move" pct value={guardianPct} onChange={v => setGuardianPct(v ?? 0)}
                    hint="Tick move that wakes the guardian between sweeps." recommend="5%." />
                  <div className="flex items-center justify-between text-[9px]">
                    <span className="text-[var(--color-text-sub)]" title="Bank profitable positions before long market closures.">Weekend profit bank</span>
                    <Pill on={weekendBank} label="On" offLabel="Off" onClick={() => {
                      const next = !weekendBank
                      setWeekendBank(next)
                      save('weekend-bank', () => agentPost('/actions/weekend-bank', { on: next }))
                    }} />
                  </div>
                  <div className="flex items-center justify-between text-[9px]">
                    <span className="text-[var(--color-text-sub)]" title="Flag (action_log + Telegram) losing positions before long market closures. Never closes them — same reasoning as leaving losers alone in the profit bank above.">Weekend loss flag</span>
                    <Pill on={weekendLossFlag} label="On" offLabel="Off" onClick={() => {
                      const next = !weekendLossFlag
                      setWeekendLossFlag(next)
                      save('weekend-loss-flag', () => agentPost('/actions/weekend-loss-flag', { on: next }))
                    }} />
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-3">
              <span data-save-pulse="risk"><Button size="sm" onClick={() => {
                saveRisk(['perTradeRiskPct', 'perTradeRiskUsd', 'maxRiskCapPct', 'maxRiskUsd', 'minLotSize', 'minRR', 'minSLDistancePct', 'maxSpreadFracOfSL', 'maxOpenPositions', 'symbolCooldownMinutes', 'maxConsecutiveLosses', 'cooldownMinutes', 'maxClusterExposure', 'maxCurrencyExposure', 'minTradesForKelly', 'allowNegativeExpectancyOverride'])
                save('guardian', () => agentPost('/actions/guardian-move-pct', { pct: guardianPct }))
              }}>Save bot risk</Button></span>
            </div>
          </Card>

          <Card id="sec-sizing" data-risk-card data-risk-reveal className="w3-hover-shadow">
            <SectionTitle badge={<Badge tone="info">Sizing</Badge>}>Lot calculation</SectionTitle>
            {(() => {
              const mode = Number(risk.perTradeRiskUsd) > 0 ? 'absolute' : 'percent'
              const bal = Number(acct.balance) || 0
              const budget = mode === 'absolute' ? Number(risk.perTradeRiskUsd) : bal * (Number(risk.perTradeRiskPct) || 0)
              const m = data?.margin
              const cap = bal * (Number(risk.maxMarginUsagePct) || 0)
              const headroom = m?.usedMargin != null ? cap - m.usedMargin : null
              return (
                <div className="text-[9px] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--color-text-sub)]" title="Percentage: risk budget = balance × per-trade %. Absolute: a fixed $ amount (3-decimal precision) overrides the %.">Sizing mode</span>
                    <span className="flex gap-1">
                      <Pill on={mode === 'percent'} label="Percentage" onClick={() => setRisk(r => ({ ...r, perTradeRiskUsd: null }))} />
                      <Pill on={mode === 'absolute'} label="Absolute $" onClick={() => setRisk(r => ({ ...r, perTradeRiskUsd: r.perTradeRiskUsd > 0 ? r.perTradeRiskUsd : Number((bal * (r.perTradeRiskPct || 0.05)).toFixed(3)) }))} />
                    </span>
                  </div>
                  {mode === 'absolute' && (
                    <Field label="Absolute risk per trade $" value={risk.perTradeRiskUsd}
                      onChange={v => setRisk(r => ({ ...r, perTradeRiskUsd: v == null ? null : Number(Number(v).toFixed(3)) }))}
                      hint="Fixed $ risked at the SL per trade, 3-decimal precision. Overrides the percentage while set." />
                  )}
                  <div className="glass-inset rounded-[8px] p-2 leading-relaxed text-[var(--color-text-sub)]">
                    <span className="font-semibold text-[var(--color-text)]">How a lot size is calculated</span><br />
                    1. Risk budget = {mode === 'absolute'
                      ? <>fixed <b>${fmt$(budget, 3)}</b> (absolute mode)</>
                      : <>balance ${fmt$(bal)} × {fmt$((risk.perTradeRiskPct || 0) * 100, 3)}% = <b>${fmt$(budget, 3)}</b></>}, capped by the hard caps and the drawdown de-risk factor.<br />
                    2. Lots = budget ÷ $-loss-per-lot at the forecast SL distance, floored to broker 0.01-lot granularity.<br />
                    3. Margin fit: the new position's margin must fit the <b>real-time headroom</b> = (balance × max-margin {fmt$((risk.maxMarginUsagePct || 0) * 100, 1)}% = ${fmt$(cap, 3)}) − broker-reported used margin. It shrinks to fit; if even the minimum lot doesn't fit, the trade is skipped before any sizing work.
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <span className="text-[var(--color-text-sub)]">Used margin (broker, live)</span>
                    <span className="text-right tabular-nums">{m?.usedMargin != null ? `$${fmt$(m.usedMargin, 3)}` : 'no snapshot yet'}</span>
                    <span className="text-[var(--color-text-sub)]">Margin cap</span>
                    <span className="text-right tabular-nums">${fmt$(cap, 3)}</span>
                    <span className="text-[var(--color-text-sub)]">Headroom left for new lots</span>
                    <span className={`text-right tabular-nums font-semibold ${headroom != null && headroom <= 0 ? 'text-[var(--color-down)]' : ''}`}>
                      {headroom != null ? `$${fmt$(headroom, 3)}` : '—'}{headroom != null && headroom <= 0 ? ' — no new entries' : ''}
                    </span>
                    <span className="text-[var(--color-text-sub)]">Free margin (broker equity −used)</span>
                    <span className="text-right tabular-nums">{m?.freeMargin != null ? `$${fmt$(m.freeMargin, 3)}` : '—'}</span>
                  </div>
                  <div className="mt-1">
                    <span data-save-pulse="risk"><Button size="sm" className={SAVE_BTN} onClick={() => saveRisk(['perTradeRiskPct', 'perTradeRiskUsd'])}>Save sizing mode</Button></span>
                  </div>
                </div>
              )
            })()}
          </Card>

          <Card id="sec-cpp" data-risk-card data-risk-reveal className="w3-hover-shadow">
            <SectionTitle badge={<Badge tone="special">C++ sidecar</Badge>}>Cpp risk configuration</SectionTitle>
            <div className="grid grid-cols-1 @sm:grid-cols-2 gap-x-5 gap-y-1">
              <div className="flex items-center justify-between text-[9px]">
                <span className="text-[var(--color-text-sub)]" title="Kill switch: the C++ engine refuses EVERY order while halted.">Halt (kill switch)</span>
                <Pill on={!!guard.halt} label={guard.halt ? 'Halted — no orders' : 'Off'} onClick={() => setGuard(g => ({ ...g, halt: !g.halt }))} />
              </div>
              <div className="flex items-center justify-between text-[9px]">
                <span className="text-[var(--color-text-sub)]" title="A market order with no stop loss is refused — last line of defence.">Require Stop Loss</span>
                <Pill on={guard.requireBracket !== false} label="On" offLabel="Off" onClick={() => setGuard(g => ({ ...g, requireBracket: !(g.requireBracket !== false) }))} />
              </div>
              <div className="flex items-center justify-between text-[9px]">
                <span className="text-[var(--color-text-sub)]" title="A market order with no take profit is refused.">Require Take Profit</span>
                <Pill on={guard.requireTarget !== false} label="On" offLabel="Off" onClick={() => setGuard(g => ({ ...g, requireTarget: !(g.requireTarget !== false) }))} />
              </div>
              <Field label="Max order volume" unit="×100" value={guard.maxOrderVolume} onChange={v => setGuard(g => ({ ...g, maxOrderVolume: v }))}
                hint="Hard cap on a single order's cTrader volume. 0 = no cap." recommend="0 — no cap." />
              <div className="flex items-center justify-between text-[9px]">
                <span className="text-[var(--color-text-sub)]" title="Virtual Pending Order engine — feeder side. The sidecar's own VPO_ENABLED/VPO_SYMBOLS env must also be set.">VPO feeder</span>
                <Pill on={vpoEnabled} label="On" offLabel="Off" onClick={() => {
                  const next = !vpoEnabled
                  setVpoEnabled(next)
                  save('vpo', () => agentPost('/actions/vpo-settings', { enabled: next }))
                }} />
              </div>
              <div className="text-[9px] text-[var(--color-text-sub)]">
                VPO pairs: {data?.vpo?.config?.length ? data.vpo.config.map(c => `${c.symbol}·${c.key}`).join(', ') : 'none configured'} — set via /actions/vpo-settings; the sidecar's VPO_SYMBOLS env must match.
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span data-save-pulse="exec-guard"><Button size="sm" className={SAVE_BTN} onClick={() => save('exec-guard', () => agentPost('/actions/exec-guard', guard))}>Save cpp guard</Button></span>
            </div>
          </Card>

          <Card id="sec-emergency" data-risk-card data-risk-reveal className="w3-hover-shadow">
            <SectionTitle badge={<Badge tone="down">Emergency</Badge>}>Close all positions</SectionTitle>
            <p className="text-[9px] text-[var(--color-text-sub)] mb-2">
              Closes every open position at the broker right now — bot-placed and manual alike. Halt (above) only blocks NEW orders; this ends existing ones. Irreversible.
            </p>
            <Button size="sm" variant="danger" disabled={closingAll} onClick={closeAll}>
              {closingAll ? 'Closing…' : 'Close ALL positions'}
            </Button>
            {closeAllResult && (
              <div className="mt-2 text-[9px] text-[var(--color-text-sub)]">
                Closed {closeAllResult.closed?.length || 0}
                {closeAllResult.failures?.length ? `, ${closeAllResult.failures.length} failed: ${closeAllResult.failures.map(f => `${f.symbol || f.positionId} (${f.error})`).join('; ')}` : ''}
              </div>
            )}
          </Card>
        </div>

        {/* ---- Right column: worked examples ---- */}
        <div className="space-y-2">
          <Card id="sec-example-live" data-risk-card className="w3-hover-shadow">
            <SectionTitle>Example trade — bot-trade live</SectionTitle>
            <MiniChart entry={entry} sl={sl} tp={tp} />
            <div className="text-[9px] space-y-1 mt-2">
              <div>Sample: EURUSD long at {entry.toFixed(4)}, balance {fmt$(bal, 0)} USD.</div>
              <div>SL {sl.toFixed(4)} (min distance {Number(risk.minSLDistancePct) || 0.15}%) · TP {tp.toFixed(4)} ({Number(risk.minRR) || 1.5}R).</div>
              <div>Risk budget: <AnimatedNumber value={budget} className="font-semibold" />{budget < budgetBase ? ` (capped from ${fmt$(budgetBase)})` : ''} → <AnimatedNumber value={lots} className="font-semibold" /> lots at ~<AnimatedNumber value={usdPerLot} />/lot.</div>
              <div className="text-[var(--color-text-sub)]">
                Then the gate still checks: daily cap, loss streak, max {risk.maxOpenPositions ?? 5} open, one-per-symbol, spread ≤ {((Number(risk.maxSpreadFracOfSL) || 0.25) * 100).toFixed(0)}% of SL, cluster/currency exposure, margin headroom at 1:{acct.leverage || 100} — ANY failure vetoes with a logged reason.
              </div>
            </div>
          </Card>
          <Card id="sec-example-cpp" data-risk-card data-risk-reveal className="w3-hover-shadow">
            <SectionTitle>Example trade — cpp configuration</SectionTitle>
            <MiniChart entry={entry} sl={sl} tp={tp} trigger={entry - slDist * 0.4} />
            <div className="text-[9px] space-y-1 mt-2">
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
