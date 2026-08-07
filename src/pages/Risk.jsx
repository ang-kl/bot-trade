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
import AccountSettingsScope from '../components/AccountSettingsScope.jsx'
import RiskMatrix from '../components/RiskMatrix.jsx'
import ConfigProposals from '../components/ConfigProposals.jsx'
import { useEffect, useState, useCallback, useRef } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import Input from '../components/common/Input.jsx'
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'
import WorkedExample from '../components/common/WorkedExample.jsx'
import Field, { Unit, FIELD_W, DEFAULT_MARK } from '../components/common/Field.jsx'
import { ratchetExample, guardianExample } from '../lib/worked-examples.js'
import { useLensAccount } from '../lib/use-lens-account.js'
import RiskReassess from '../components/RiskReassess.jsx'
import AccountScopePills from '../components/common/AccountScopePills.jsx'
import { useAccountSwitch } from '../lib/use-account-switch.js'
import { markDirty, clearDirty, anyDirty, sectionsToApply } from '../lib/form-dirty.js'
import { ESSENTIALS, EVERYTHING, loadRiskMode, saveRiskMode, cardVisible } from '../lib/risk-view.js'
import Advanced from '../components/common/Advanced.jsx'
import GlobalScopeNote from '../components/common/GlobalScopeNote.jsx'
import { dailyCapState, describeBinding } from '../lib/daily-cap-state.js'
import ScopeMismatchNote from '../components/common/ScopeMismatchNote.jsx'

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
// Phase E5 additions, both behaviour-preserving:
// - `commit` labels the pill's COMMIT MODEL — most pills here edit local
//   state until a Save button posts it, but three (Weekend bank, Weekend
//   loss flag, VPO feeder) POST the moment they are tapped. Two identical
//   pills with different blast timing carried nothing to tell them apart
//   (inventory finding 23); the title now says which one you are touching.
// - `radio` renders the either/or segmented pairs as real radios inside a
//   radiogroup instead of independent aria-pressed toggles (finding: single
//   choice presented as toggles). Boolean pills keep aria-pressed.
// ON wears the state-on tint, not the navigation accent (finding 20).
/**
 * A labelled on/off row that carries a deep-link ANCHOR, so the summary table's
 * ▸ can land on it (owner 04-08-2026). Field does this for numeric settings;
 * every boolean on this page was hand-rolled without one, which is why a third
 * of the table's triangles pointed at nothing.
 */
function Toggle({ id, label, on, onClick, title }) {
  return (
    <div id={id} className="flex items-center justify-between text-(length:--fs-body)">
      <span className="text-[var(--color-text-sub)]" title={title}>{label}</span>
      <Pill on={on} label="On" offLabel="Off" onClick={onClick} />
    </div>
  )
}

function Pill({ on, label, offLabel = null, onClick, commit = 'save', radio = false }) {
  const off = offLabel != null
    ? 'border-[var(--color-down)] text-[var(--color-down)] font-bold bg-[color-mix(in_srgb,var(--color-down)_10%,transparent)]'
    : 'border-[var(--glass-edge)] text-[var(--color-text-sub)] font-bold uppercase'
  const aria = radio ? { role: 'radio', 'aria-checked': !!on } : { 'aria-pressed': !!on }
  return (
    <button type="button" onClick={onClick} {...aria}
      title={commit === 'now' ? 'Applies IMMEDIATELY when tapped' : 'Takes effect when you press this section’s Save'}
      className={`rounded-[var(--radius-control)] border px-[4px] py-[3px] text-(length:--fs-body) cursor-pointer ${on
        ? 'border-[var(--color-state-on-border)] text-[var(--color-state-on-text)] bg-[var(--color-state-on-bg)] font-normal'
        : off}`}>
      {on ? label : (offLabel ?? label.toUpperCase())}
    </button>
  )
}

// Save buttons: "Overall save button can be 1 point increase font size."
const SAVE_BTN = '!text-(length:--fs-body)'

// Every independently-saved form on this page, and the three that make up the
// Position Protection card. Module scope so load() can name them without
// taking a dependency that changes every render.
const SECTIONS = ['risk', 'guard', 'loss-cap', 'ratchet', 'loss-guardian']
const PROTECTION_SECTIONS = ['loss-cap', 'ratchet', 'loss-guardian']

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


export default function Risk() {
  const [data, setData] = useState(null)
  // Config keys the last Re-Risk apply wrote — drives the APPLIED highlight
  // on the matching Fields below (owner 2026-08-01). Set-compared so the
  // child's report of an unchanged list cannot re-render in a loop.
  const [appliedKeys, setAppliedKeys] = useState(() => new Set())
  const onReRiskApplied = useCallback((keys) => {
    setAppliedKeys(prev => {
      const next = new Set(keys || [])
      if (prev.size === next.size && [...prev].every(k => next.has(k))) return prev
      return next
    })
  }, [])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState('')
  // PERSISTENT save proof (owner, twice: "I ALREADY applied, why doesn't it
  // …", "i feel not saved but actually is"). The only feedback this page had
  // was a 0.24-second scale pulse on the button — gone before you look up, and
  // indistinguishable from nothing happening. Tune has carried a stamped
  // "✓ Saved at HH:MM:SS" line for exactly this reason; Risk now does too.
  const [savedAt, setSavedAt] = useState(null) // { section, at }
  // Local editable copies — saved per section.
  const [risk, setRiskRaw] = useState({})
  // WHOSE limits are on screen. 'all' = the global config, which is what this
  // page has always edited — so that stays the default and nothing re-scopes
  // itself silently. Picking an account edits that account's OVERLAY: a
  // partial config merged over the global one, affecting only that account.
  // The sidebar lens decides where this page starts and where it lands when
  // you switch; the dropdown below still overrides for a one-off comparison.
  const [riskAcct, setRiskAcct] = useLensAccount('all')
  const [acct, setAcct] = useState({ balance: null, leverage: null })
  const [guard, setGuardRaw] = useState({})
  const [guardianPct, setGuardianPct] = useState(0.05)
  const [weekendBank, setWeekendBank] = useState(true)
  const [weekendLossFlag, setWeekendLossFlag] = useState(true)
  const [vpoEnabled, setVpoEnabled] = useState(false)
  const [closeAllResult, setCloseAllResult] = useState(null)
  const [closingAll, setClosingAll] = useState(false)
  // A2 protection layers (owner 2026-07-28: the GOOGL −$900 sat unprotected
  // because nothing enforced an absolute floor). Local editable copies of the
  // three layers' configs; each saves to its own /actions route.
  const [lossCap, setLossCapRaw] = useState(null)
  const [ratchet, setRatchetRaw] = useState(null)
  const [ratchetState, setRatchetState] = useState(null)
  const [ratchetAcct, setRatchetAcct] = useState(null)
  const [guardian2, setGuardian2Raw] = useState(null)

  // UNSAVED-EDIT TRACKING (owner 04-08-2026: "i try to change but it reset").
  // Each form on this page saves to its own route, but every save — and every
  // account switch — re-read the whole config and pushed it into ALL of them,
  // wiping edits the operator had not saved yet. A reload may now refresh only
  // the forms nobody has touched. Rationale and the scope-change exception:
  // src/lib/form-dirty.js.
  const [dirty, setDirty] = useState({})
  // A ref as well as state: load() must read the CURRENT set without taking a
  // dependency on it, or every keystroke would rebuild load and re-fetch.
  const dirtyRef = useRef({})
  const touch = useCallback((section) => {
    dirtyRef.current = markDirty(dirtyRef.current, section)
    setDirty(dirtyRef.current)
  }, [])
  const untouch = useCallback((section) => {
    dirtyRef.current = clearDirty(dirtyRef.current, section)
    setDirty(dirtyRef.current)
  }, [])
  // The setters the forms call. Same names and signatures as before, so no
  // field changed — they just record that the form is now unsaved.
  const setRisk = useCallback((v) => { setRiskRaw(v); touch('risk') }, [touch])
  const setGuard = useCallback((v) => { setGuardRaw(v); touch('guard') }, [touch])
  const setLossCap = useCallback((v) => { setLossCapRaw(v); touch('loss-cap') }, [touch])
  const setRatchet = useCallback((v) => { setRatchetRaw(v); touch('ratchet') }, [touch])
  const setGuardian2 = useCallback((v) => { setGuardian2Raw(v); touch('loss-guardian') }, [touch])
  const loadedScope = useRef(null)

  // HOW MUCH IS ON SCREEN (owner 04-08-2026: "i find the RISK page becomes
  // complicated"). Essentials is the default and shows the knobs that actually
  // get changed plus everything that can stop a loss; Everything is this page
  // exactly as it was. Nothing is removed in either — see src/lib/risk-view.js.
  const [viewMode, setViewMode] = useState(() => loadRiskMode())
  const chooseMode = useCallback((m) => { setViewMode(m); saveRiskMode(m) }, [])

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — configure it on the Connect tab.'); return }
    try {
      // Scoped read: the config an ACCOUNT actually trades under is the global
      // one with its overlay merged on top. 'all' = the global config itself,
      // which is what this page has always shown.
      const r = await agentGet(`/state/risk-full${riskAcct && riskAcct !== 'all' ? `?account=${encodeURIComponent(riskAcct)}` : ''}`)
      // A scope change REPLACES everything: the incoming numbers belong to a
      // different account, and carrying edits across would write one
      // account's limits onto another. Same scope = keep unsaved work.
      const scope = riskAcct || 'all'
      const scopeChanged = loadedScope.current !== scope
      loadedScope.current = scope
      if (scopeChanged) { dirtyRef.current = {}; setDirty({}) }
      const apply = new Set(sectionsToApply(SECTIONS, dirtyRef.current, { scopeChanged }))
      setData(r)
      if (apply.has('risk')) setRiskRaw(r.risk.effective)
      setAcct({ balance: r.account.balance, leverage: r.account.leverage })
      if (apply.has('guard')) setGuardRaw({ requireBracket: true, requireTarget: true, halt: false, maxOrderVolume: 0, ...r.execGuard })
      setGuardianPct(r.guardian.movePct)
      setWeekendBank(r.weekendBank)
      setWeekendLossFlag(r.weekendLossFlag)
      setVpoEnabled(r.vpo.enabled)
      if (r.lossCap && apply.has('loss-cap')) setLossCapRaw(r.lossCap.effective)
      if (r.profitRatchet) {
        if (apply.has('ratchet')) setRatchetRaw(r.profitRatchet.effective)
        // Live staircase state is READ-ONLY — always refreshed, never an edit.
        setRatchetState(r.profitRatchet.state)
        setRatchetAcct(r.profitRatchet.accountId ?? null)
      }
      if (r.lossGuardian && apply.has('loss-guardian')) setGuardian2Raw(r.lossGuardian.effective)
      setError('')
    } catch (e) { setError(e.message) }
  }, [riskAcct])
  useEffect(() => { load() }, [load])

  // FOLLOW THE GLOBAL ACCOUNT SWITCH. Risk was the other page that never
  // subscribed — so the limits on screen could belong to an account the bot
  // had stopped trading minutes ago. Data only; the editing scope moves by
  // click, via ScopeMismatchNote.
  const switchingTo = useAccountSwitch(load)

  const save = async (section, fn) => {
    setSaving(section)
    try {
      await fn()
      // Saved = no longer unsaved, so the reload below is free to refresh it
      // with what the agent actually stored.
      dirtyRef.current = clearDirty(dirtyRef.current, section)
      setDirty(dirtyRef.current)
      await load()
      // Stamped only after the reload, so the line means "the agent has it and
      // this page has re-read it", not "the request left the browser".
      setSavedAt({ section, at: new Date() })
      setError('')
    } catch (e) { setError(e.message) } finally { setSaving('') }
  }
  const riskScoped = riskAcct && riskAcct !== 'all'
  const saveRisk = (keys) => save('risk', () => {
    const body = {}
    for (const k of keys) body[k] = risk[k]
    // With an account, this writes that account's OVERLAY — only the keys
    // being saved enter it, so an untouched knob keeps following the global
    // config rather than being frozen at whatever it read today.
    if (riskScoped) body.accountId = riskAcct
    return agentPost('/actions/risk-config', body)
  })
  const clearOverlay = () => save('risk', () =>
    agentPost('/actions/risk-config', { accountId: riskAcct, reset: true }))

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

  // The two daily brakes and what to say about them, computed from the DRAFT
  // config rather than the saved one — so clearing a field warns immediately,
  // while it is still the operator's decision to make, instead of after a save
  // has already left the account uncapped.
  const capState = dailyCapState(risk, Number(acct.balance) || null)
  const capBinding = describeBinding(capState)
  // A campaign is armed only with ALL of percentage, starting equity and start
  // time — the same all-or-nothing rule the engine applies in
  // campaign-stop.js. Showing "armed" on a partial config would be the exact
  // false comfort the read-only row exists to prevent.
  const campaignArmed = !!(risk?.campaign
    && Number(risk.campaign.maxDrawdownPct) > 0 && Number(risk.campaign.maxDrawdownPct) < 1
    && Number(risk.campaign.startEquity) > 0
    && typeof risk.campaign.startAt === 'string' && risk.campaign.startAt.length >= 10)

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
      <SectionNavFab />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-bold t-heading">Risk</h1>
        <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">every layer's limits in one place — changes apply to the live gate on save</span>
        {/* HOW MUCH TO SHOW (owner 04-08-2026: "the RISK page becomes
            complicated"). Essentials is the default; Everything is this page
            unchanged. Nothing is removed by Essentials — advanced groups
            collapse and reference cards defer, and anything holding a
            non-default value says so on its collapsed header. */}
        <span role="radiogroup" aria-label="How much to show" className="flex gap-1">
          <Pill radio on={viewMode === ESSENTIALS} label="Essentials" onClick={() => chooseMode(ESSENTIALS)} />
          <Pill radio on={viewMode === EVERYTHING} label="Everything" onClick={() => chooseMode(EVERYTHING)} />
        </span>
        {viewMode === ESSENTIALS && (
          <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">
            showing the settings that get changed and every layer that can stop a loss — nothing is disabled or hidden from the bot
          </span>
        )}
        {saving && <Badge tone="info">saving {saving}…</Badge>}
      </div>
      {savedAt && !saving && (
        <div className="text-(length:--fs-body) text-[var(--color-text-sub)]" aria-live="polite">
          ✓ Saved {savedAt.section} at {savedAt.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} — the fields below were re-read from the agent after saving, so what you see is what it holds.
        </div>
      )}
      {error && <Card className="border-[var(--color-down)] text-(length:--fs-body)">{error}</Card>}

      {/* ---- WHOSE LIMITS ARE THESE ---------------------------------------
          Owner 02-08-2026: "each sub-page doesn't tie to the account selected
          and flash which account I am looking or capabie of edit". This page
          read the GLOBAL config and wrote the GLOBAL config, while sitting
          under a header naming one account — so the limits on screen were not
          necessarily the limits that account trades under, and there was no
          way to tell. Per-account overlays already existed server-side and
          nothing here could reach them. */}
      <Card className="text-(length:--fs-body)">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <AccountScopePills
            value={riskAcct}
            onChange={setRiskAcct}
            allLabel="Global"
            note={riskScoped
              ? 'Editing this ACCOUNT\'s overlay — a partial config merged over the global one. Only the fields you save enter it; everything else keeps following the global config.'
              : 'Editing the GLOBAL config. Every account without an overlay of its own trades under exactly this.'}
          />
          <Badge tone={riskScoped && (data?.risk?.overlayKeys?.length ?? 0) > 0 ? 'on' : 'off'}>
            {!riskScoped ? 'GLOBAL' : (data?.risk?.overlayKeys?.length ?? 0) > 0 ? `${data.risk.overlayKeys.length} ACCOUNT OVERRIDE${data.risk.overlayKeys.length === 1 ? '' : 'S'}` : 'FOLLOWS GLOBAL'}
          </Badge>
          {riskScoped && (data?.risk?.overlayKeys?.length ?? 0) > 0 && (
            <Button size="sm" variant="subtle" className="!px-2 !py-0.5 !min-h-0 text-(length:--fs-body)" onClick={clearOverlay}>
              Clear overrides — follow global again
            </Button>
          )}
          {switchingTo && <span className="text-[var(--color-text-sub)]">Loading {switchingTo}…</span>}
        </div>
        <div className="mt-1.5">
          <ScopeMismatchNote scope={riskAcct} onUse={setRiskAcct} sharedLabel="the global risk config" />
        </div>
        {riskScoped && (data?.risk?.overlayKeys?.length ?? 0) > 0 && (
          <div className="mt-1.5 text-[var(--color-text-sub)]">
            {/* Name them, with the global value they are standing on. "This
                account differs" and "this differs from the DEFAULT" are two
                different facts with two different fixes, and the page must not
                blur them. */}
            Overridden for this account:{' '}
            {data.risk.overlayKeys.map((k, i) => (
              <span key={k}>
                {i > 0 && ' · '}
                <span className="font-semibold text-[var(--color-text)]">{k}</span>
                {' '}{String(data.risk.effective?.[k])} <span className="opacity-70">(global {String(data.risk.global?.[k])})</span>
              </span>
            ))}
          </div>
        )}
      </Card>

      {/* ---- Reset / Re-Risk / Re-Risk + Watchlist (owner 2026-07-30) ------
          At the very top, above every field, because these three act on ALL
          of them. `load` is handed over so a reset or an applied proposal
          repaints the fields below from the agent rather than leaving the form
          showing the values that were just replaced. */}
      <RiskReassess onChanged={load} onApplied={onReRiskApplied} />

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
          // THE CAP THAT ACTUALLY BINDS, not the % field. Two brakes are live
          // now and either can be off, so reading the % here would print a
          // limit the gate is not enforcing — the exact defect the owner found
          // in the reassessment summary.
          ['Daily stop-out', capState.capUsd != null ? money(capState.capUsd) : 'UNCAPPED'],
          ['Worst case open', worst != null ? money(worst) : '—'],
        ]
        return (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {tiles.map(([label, value]) => (
              <div key={label} className="glass-inset rounded-[10px] px-3 py-2">
                <div className="text-(length:--fs-body) text-[var(--color-text-sub)]">{label}</div>
                <div className="text-(length:--fs-body) font-bold tabular-nums">{value}</div>
              </div>
            ))}
          </div>
        )
      })()}

      {/* The whole grid, global + per account, before the single-account
          editors below. Owner 2026-08-04: the Account card became a summary
          table because one account's numbers at a time could not answer
          "which account runs tighter, and where". */}
      <RiskMatrix />
      {/* C-1 sits directly under the matrix: the matrix says what the settings
          ARE, this says what the record thinks they should be. Reading them
          apart was the whole reason minRR 1.5 survived a 34% win rate. */}
      <ConfigProposals />

      {/* ---- Global Account aka cTrader Risk Configuration ---- */}
      {/* /actions/balance takes no accountId — one stored balance and leverage
          for the whole bot, which is why an account switch never changes it. */}
      <Card id="sec-account" data-risk-card className="w3-hover-shadow">
        <SectionTitle badge={data?.account?.isLive ? <Badge tone="down">LIVE</Badge> : <Badge tone="info">DEMO</Badge>}>
          Global Account — cTrader risk configuration
        </SectionTitle>
        <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
          <div>
            <Field label="Account balance (USD)" value={acct.balance} onChange={v => setAcct(a => ({ ...a, balance: v }))}
              hint="The balance every % figure below is computed from." />
            <div className="text-(length:--fs-body) text-[var(--color-text-sub)] mt-0.5">
              {data?.account?.balanceSource === 'broker'
                ? `live from the broker (snapshot ${data?.account?.balanceFetchedAt ? new Date(data.account.balanceFetchedAt).toLocaleTimeString() : ''}) — edits here override until the next sync`
                : 'stored value — connect/refresh the broker for live truth'}
            </div>
          </div>
          <Field label="Leverage (1:N)" anchor="leverage" value={acct.leverage} onChange={v => setAcct(a => ({ ...a, leverage: v }))}
            hint="Used for margin-headroom checks before approving a position." recommend="1:100 — match whatever your broker account actually offers." />
          <div className="text-(length:--fs-body)">
            <span className="text-[var(--color-text-sub)]">Broker stop-out level </span>
            <span className="font-semibold">{data?.account?.brokerStopOutPct ?? 50}%</span>
            <span className="text-(length:--fs-body) text-[var(--color-text-sub)]"> margin level — broker-enforced liquidation, not editable</span>
          </div>
          <div className="text-(length:--fs-body)">
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
        <SectionTitle badge={<Badge tone="down">Protection</Badge>}>Position Protection — Loss Floors &amp; Profit Lock-In</SectionTitle>
        {/* THREE FORMS, THREE SAVES — and until now no way to know that.
            Owner, 04-08-2026: "where is the save button for Position
            Protection". Each layer posts to its own route on purpose (a typo
            in one cannot wipe another), but the heading read as ONE form, so
            three Save buttons at the bottom of three columns were easy to miss
            on a phone. This bar says so, and offers the single button the
            heading implies. */}
        {/* The loss cap now has a real per-account overlay; the other two do
            not YET, and saying so is the whole point of this bar. */}
        {riskScoped
          ? <div className="glass-inset mb-2 rounded-[2px] px-2 py-1 text-(length:--fs-body) text-[var(--color-text-sub)]" style={{ borderLeft: '2px solid var(--color-accent)' }}>
              <b className="text-[var(--color-text)]">Editing this account&apos;s overlay — all three layers.</b>{' '}
              {data?.lossCap?.overlayKeys?.length > 0
                ? `${data.lossCap.overlayKeys.length} field${data.lossCap.overlayKeys.length === 1 ? '' : 's'} pinned here; the rest follow the shared settings.`
                : 'This account follows the shared settings — saving pins only the fields you changed.'}
              {' '}The profit ratchet and Loss Guardian are scoped the same way — each shows what it has pinned on its own card.
            </div>
          : <GlobalScopeNote className="mb-2" what="The per-position loss cap, the profit ratchet and the Loss Guardian" />}
        <div className="mb-2 flex flex-wrap items-center gap-2 text-(length:--fs-body)">
          <span className="text-[var(--color-text-sub)]">
            Three independent layers. Each has its own <b className="text-[var(--color-text)]">Save</b> at the foot of its card — including the On/Off switch, which only takes effect once saved. Or save all three:
          </span>
          <Button
            size="sm" className={SAVE_BTN} disabled={!anyDirty(dirty, PROTECTION_SECTIONS)}
            onClick={() => save('protection-all', async () => {
              // Sequential, not parallel: each route re-reads and rewrites its
              // own state key, and a failure part-way must leave what it has
              // already written intact rather than half-applied.
              if (dirtyRef.current['loss-cap'] && lossCap) { await agentPost('/actions/loss-cap', riskScoped ? { ...lossCap, accountId: riskAcct } : lossCap); untouch('loss-cap') }
              if (dirtyRef.current['ratchet'] && ratchet) { await agentPost('/actions/profit-ratchet', riskScoped ? { ...ratchet, accountId: riskAcct } : ratchet); untouch('ratchet') }
              if (dirtyRef.current['loss-guardian'] && guardian2) { await agentPost('/actions/loss-guardian', riskScoped ? { ...guardian2, accountId: riskAcct } : guardian2); untouch('loss-guardian') }
            })}
          >
            {saving === 'protection-all' ? 'Saving…' : 'Save all three layers'}
          </Button>
          {anyDirty(dirty, PROTECTION_SECTIONS) && (
            <span className="font-semibold" style={{ color: 'var(--color-down)' }}>
              Unsaved changes — nothing takes effect until you save.
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-start">

          {/* Layer 1 — per-position loss cap (A1) */}
          <div className="glass-inset rounded-[1px] p-2 space-y-2">
            <div className="flex items-center justify-between text-(length:--fs-body)">
              <span className="font-semibold" title="Checks every open position's floating P&L each minute against the tighter of the $ and % caps below. On breach it closes the position (or alerts, per Action).">Per-position loss cap</span>
              {riskScoped && data?.lossCap?.overlayKeys?.length > 0 && <span className="ml-1 text-[var(--color-accent)]">{data.lossCap.overlayKeys.length} pinned</span>}
              {dirty['loss-cap'] && <span className="ml-1 font-semibold" style={{ color: 'var(--color-down)' }}>• unsaved</span>}
              <Pill on={!!lossCap?.on} label="On" offLabel="Off" onClick={() => setLossCap(c => ({ ...c, on: !c?.on }))} />
            </div>
            <Field label="Max loss per position" unit="$" value={lossCap?.maxLossUsd} onChange={v => setLossCap(c => ({ ...c, maxLossUsd: v }))}
              placeholder="% only"
              hint="Absolute dollar floor for ONE position's floating loss. The $900 GOOGL slide would have been cut at this number. Empty leaves only the % cap below." recommend="$500 — or whatever one trade is allowed to cost you." />
            <Field label="Max loss, % of balance" unit="%" value={lossCap?.maxLossPctOfBalance} onChange={v => setLossCap(c => ({ ...c, maxLossPctOfBalance: v }))}
              placeholder="$ only"
              hint="Same floor as % of current balance; the TIGHTER of the two caps applies. 2% of $48,000 ≈ $960." recommend="2% of balance." />
            <Advanced mode={viewMode} label="Loss-cap details" total={3}
              changed={[lossCap?.scope === 'bot', lossCap?.action === 'alert', lossCap?.retryMinutes !== 10].filter(Boolean).length}
              dirty={!!dirty['loss-cap']}>
            <div className="flex items-center justify-between text-(length:--fs-body)">
              <span className="text-[var(--color-text-sub)]" title="'all' watches every broker position including manual ones; 'bot' only the bot's own ledger positions.">Scope</span>
              <span role="radiogroup" aria-label="Scope" className="flex gap-1">
                <Pill radio on={lossCap?.scope !== 'bot'} label="All positions" onClick={() => setLossCap(c => ({ ...c, scope: 'all' }))} />
                <Pill radio on={lossCap?.scope === 'bot'} label="Bot only" onClick={() => setLossCap(c => ({ ...c, scope: 'bot' }))} />
              </span>
            </div>
            <div className="flex items-center justify-between text-(length:--fs-body)">
              <span className="text-[var(--color-text-sub)]" title="'Close' flattens the breaching position at market; 'Alert' only sends Telegram and leaves it open.">Action on breach</span>
              <span role="radiogroup" aria-label="Action on breach" className="flex gap-1">
                <Pill radio on={lossCap?.action !== 'alert'} label="Close" onClick={() => setLossCap(c => ({ ...c, action: 'close' }))} />
                <Pill radio on={lossCap?.action === 'alert'} label="Alert only" onClick={() => setLossCap(c => ({ ...c, action: 'alert' }))} />
              </span>
            </div>
            <Field label="Retry after failed close" unit="min" value={lossCap?.retryMinutes} onChange={v => setLossCap(c => ({ ...c, retryMinutes: v }))}
              hint="If a breach close fails (market closed, broker error), re-attempt after this long instead of hammering." recommend="10 minutes." />
            </Advanced>
            {(() => {
              const balNow = Number(acct.balance) || null
              const pctCap = lossCap?.maxLossPctOfBalance != null && balNow ? balNow * lossCap.maxLossPctOfBalance / 100 : null
              const eff = [lossCap?.maxLossUsd, pctCap].filter(v => v != null && v > 0)
              return (
                <div className="text-(length:--fs-body) text-[var(--color-text-sub)]">
                  Effective cap right now: <b className="text-[var(--color-text)]">{eff.length ? `$${fmt$(Math.min(...eff))}` : 'none — both caps empty'}</b>
                </div>
              )
            })()}
            <span data-save-pulse="loss-cap"><Button size="sm" className={SAVE_BTN} onClick={() => save('loss-cap', () => agentPost('/actions/loss-cap', riskScoped ? { ...lossCap, accountId: riskAcct } : lossCap))}>Save loss cap</Button></span>
          </div>

          {/* Layer 2 — profit ratchet staircase (A4) */}
          <div className="glass-inset rounded-[1px] p-2 space-y-2">
            <div className="flex items-center justify-between text-(length:--fs-body)">
              <span className="font-semibold" title="Locks in gains on the way to the $100k goal: every full step of equity growth raises a protected floor one step behind the high-water mark. Falling back to the floor flattens bot positions and disarms autotrade — banked profit stays banked.">Profit ratchet (staircase)</span>
              {riskScoped && data?.profitRatchet?.overlayKeys?.length > 0 && <span className="ml-1 text-[var(--color-accent)]">{data.profitRatchet.overlayKeys.length} pinned</span>}
              {dirty['ratchet'] && <span className="ml-1 font-semibold" style={{ color: 'var(--color-down)' }}>• unsaved</span>}
              <Pill on={!!ratchet?.on} label="On" offLabel="Off" onClick={() => setRatchet(c => ({ ...c, on: !c?.on }))} />
            </div>
            <Field label="Step size" unit="$" value={ratchet?.stepUsd} onChange={v => setRatchet(c => ({ ...c, stepUsd: v }))}
              placeholder="auto"
              hint="Equity growth per banked step. Empty = automatic: 1% of balance, clamped $25–$500 — scales itself as the account grows." recommend="auto (owner's '$500 min. / 1% min.' rule)." />
            <div className="flex items-center justify-between text-(length:--fs-body)">
              <span className="text-[var(--color-text-sub)]" title="'Flatten' closes the bot's positions AND disarms autotrade at the floor; 'Halt' only disarms, leaving positions to their own SL/TP.">At the floor</span>
              <span role="radiogroup" aria-label="At the floor" className="flex gap-1">
                <Pill radio on={ratchet?.floorAction !== 'halt'} label="Flatten" onClick={() => setRatchet(c => ({ ...c, floorAction: 'flatten' }))} />
                <Pill radio on={ratchet?.floorAction === 'halt'} label="Halt only" onClick={() => setRatchet(c => ({ ...c, floorAction: 'halt' }))} />
              </span>
            </div>
            {/* HALTED — the state the owner had no way to see or lift.
                On 02-08 22:24 UTC account 46130058 halted, and the only paths
                out were a Telegram button on a message that had scrolled away
                and "Reset staircase", which wipes EVERY account's banked
                floor. A halt has to be visible where the ladder is, and
                liftable for the one account it belongs to. */}
            {ratchetState?.halt && (
              <div className="glass-inset rounded-[1px] border border-[var(--color-down)] p-2 text-(length:--fs-body) space-y-1.5">
                <div className="font-semibold" style={{ color: 'var(--color-down)' }}>
                  ⛔ Ratchet halt — new entries blocked on this account
                </div>
                <div className="text-[var(--color-text-sub)]">
                  Tripped {ratchetState.haltAt ? new Date(ratchetState.haltAt).toLocaleString() : 'earlier'}
                  {ratchetState.haltFloor != null && <> at the protected floor ${fmt$(ratchetState.haltFloor)}</>}.
                  {ratchetState.keepOff
                    ? ' You chose "keep off", so it will not re-arm on its own.'
                    : ' It re-arms on its own once equity holds above the recovery line — until then, nothing enters.'}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" className={SAVE_BTN} onClick={() => {
                    save('ratchethold', () => agentPost('/actions/ratchet-account', { accountId: ratchetAcct, action: 'rearm' }).then(load))
                  }}>Clear hold</Button>
                  {/* Separate button, not a flag on the first: keeping the old
                      ladder and starting a new one have different consequences,
                      and a checkbox would hide that. */}
                  <Button size="sm" variant="danger" onClick={() => {
                    if (!window.confirm('Restart THIS account\'s staircase from its current equity? Its banked floor is forgotten; other accounts are untouched.')) return
                    save('ratchethold', () => agentPost('/actions/ratchet-account', { accountId: ratchetAcct, action: 'rebaseline' }).then(load))
                  }}>Clear + restart ladder</Button>
                </div>
              </div>
            )}
            {(() => {
              const st = ratchetState
              const balNow = Number(acct.balance) || null
              const step = ratchet?.stepUsd > 0 ? ratchet.stepUsd : (balNow ? Math.min(500, Math.max(25, balNow * 0.01)) : null)
              const steps = st && step > 0 ? Math.max(0, Math.floor((st.hwm - st.baseline) / step)) : 0
              const floor = st && step > 0 && steps >= 1 ? st.baseline + (steps - 1) * step : null
              return st ? (
                <div className="glass-inset rounded-[1px] p-2 text-(length:--fs-body) space-y-0.5">
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
                <div className="text-(length:--fs-body) text-[var(--color-text-sub)] space-y-1">
                  <div>No staircase state yet — it baselines at current equity on the ratchet's first pass after enabling.</div>
                  <WorkedExample label="What that will look like"
                    lines={ratchetExample({ balance: balNow, stepUsd: ratchet?.stepUsd })} />
                </div>
              )
            })()}
            <div className="flex items-center gap-2">
              <span data-save-pulse="ratchet"><Button size="sm" className={SAVE_BTN} onClick={() => save('ratchet', () => agentPost('/actions/profit-ratchet', riskScoped ? { ...ratchet, accountId: riskAcct } : ratchet))}>Save ratchet</Button></span>
              {/* Destructive (wipes banked floors) — danger, not ghost. */}
              <Button size="sm" variant="danger" onClick={() => {
                if (!window.confirm('Re-baseline the staircase at CURRENT equity? Banked floors are forgotten (use after a deposit/withdrawal).')) return
                save('ratchet', () => agentPost('/actions/profit-ratchet', { ...ratchet, resetState: true }))
              }}>Reset staircase</Button>
            </div>
          </div>

          {/* Layer 3 — Loss Guardian: the safety net for naked positions */}
          <div className="glass-inset rounded-[1px] p-2 space-y-2">
            <div className="flex items-center justify-between text-(length:--fs-body)">
              <span className="font-semibold" title="Safety net for positions with NO stop loss (usually manual/external ones): places a protective stop at the ATR distance below, or closes outright if price is already past it. Never touches a position that has its own stop.">Loss Guardian</span>
              {riskScoped && data?.lossGuardian?.overlayKeys?.length > 0 && <span className="ml-1 text-[var(--color-accent)]">{data.lossGuardian.overlayKeys.length} pinned</span>}
              {dirty['loss-guardian'] && <span className="ml-1 font-semibold" style={{ color: 'var(--color-down)' }}>• unsaved</span>}
              <Pill on={!!guardian2?.on} label="On" offLabel="Off" onClick={() => setGuardian2(c => ({ ...c, on: !c?.on }))} />
            </div>
            <Advanced mode={viewMode} label="Guardian details" total={3}
              changed={[guardian2?.scope === 'external', guardian2?.fallbackAdversePct !== 0.02, guardian2?.maxHoldHours != null].filter(Boolean).length}
              dirty={!!dirty['loss-guardian']}>
            <div className="flex items-center justify-between text-(length:--fs-body)">
              <span className="text-[var(--color-text-sub)]" title="'all' = any naked position, bot or manual; 'external' = only manual/external ones.">Scope</span>
              <span role="radiogroup" aria-label="Scope" className="flex gap-1">
                <Pill radio on={guardian2?.scope !== 'external'} label="All naked" onClick={() => setGuardian2(c => ({ ...c, scope: 'all' }))} />
                <Pill radio on={guardian2?.scope === 'external'} label="External only" onClick={() => setGuardian2(c => ({ ...c, scope: 'external' }))} />
              </span>
            </div>
            <Field label="Protective stop distance" unit="×ATR" value={guardian2?.maxAtrMult} onChange={v => setGuardian2(c => ({ ...c, maxAtrMult: v }))}
              hint="Stop placed this many ATRs (1h, period 14) from entry — wide on purpose so mean-reversion room survives, but a runaway loser is still capped." recommend="3 × ATR." />
            <Field label="Fallback cap (no ATR)" pct value={guardian2?.fallbackAdversePct} onChange={v => setGuardian2(c => ({ ...c, fallbackAdversePct: v }))}
              hint="When ATR data is unavailable, cap the adverse move at this % of entry price instead." recommend="2% of entry price." />
            <Field label="Max hold time" unit="h" value={guardian2?.maxHoldHours} onChange={v => setGuardian2(c => ({ ...c, maxHoldHours: v }))}
              placeholder="off"
              hint="Optional hard time cap: a position without its own time cap is closed after this many hours regardless of P&L." recommend="unset — let price levels decide, unless positions keep rotting for days." />
            </Advanced>
            {viewMode === EVERYTHING && <WorkedExample lines={guardianExample(guardian2 || {})} label="Worked example" />}
            <span data-save-pulse="loss-guardian"><Button size="sm" className={SAVE_BTN} onClick={() => save('loss-guardian', () => agentPost('/actions/loss-guardian', riskScoped ? { ...guardian2, accountId: riskAcct } : guardian2))}>Save guardian</Button></span>
          </div>
        </div>
      </Card>

      {/* A6: which settings this account PINS versus inherits, above the
          per-account forms it is about. Full width and outside the grid —
          inside it, it would take a column slot and read as a fourth form. */}
      {cardVisible('sec-scope', viewMode) && <Card id="sec-scope"><AccountSettingsScope /></Card>}

      <div className="grid grid-cols-1 lg:grid-cols-[270px_1fr_270px] gap-3 items-start">
        {/* ---- Account Risk Configuration (left) ---- */}
        <Card id="sec-acct-risk" data-risk-card className="w3-hover-shadow">
          <SectionTitle>Account Risk Configuration form</SectionTitle>
          <div className="space-y-2">
            <Field label={`Daily loss cap${mark('dailyLossPct')}`} anchor="dailyLossPct" applied={appliedKeys.has('dailyLossPct')} pct value={risk.dailyLossPct} onChange={v => setRisk(r => ({ ...r, dailyLossPct: v }))}
              placeholder="off"
              hint="New entries stop for the day once closed P&L is down this % of balance. Empty = this check is off. Checked alongside the flat $ cap under Drawdown response — whichever is tighter binds. When a day ceiling is set below, this is what the day OPENS with." recommend="3% of balance." />
            {/* THE WARNING THE OWNER ASKED FOR. It sits directly under the two
                fields that produce it rather than in a page-level banner: the
                state is a property of this pair, and a banner elsewhere is
                something you read once and stop seeing. */}
            {capState.message && (
              <div className={`glass-inset rounded-[1px] p-1.5 text-(length:--fs-body) leading-snug ${capState.severity === 'danger' ? 'text-[var(--color-warning-text)] border border-[var(--color-down)]' : 'text-[var(--color-text-sub)]'}`}
                role={capState.severity === 'danger' ? 'alert' : undefined}>
                <span className="font-semibold">{capState.severity === 'danger' ? 'Daily loss is UNCAPPED. ' : 'Heads up. '}</span>
                {capState.message}
              </div>
            )}
            {capBinding && (
              <div className="text-(length:--fs-body) text-[var(--color-text-sub)]">{capBinding}</div>
            )}
            {/* Owner 03-08-2026: "raise to 8.8% and dynamic-intelligent
                adjusted down from 18.8% … for longevity to trade". Empty =
                the flat cap above, unchanged — the ramp is opt-in. */}
            {/* CAMPAIGN STOP — read-only here ON PURPOSE. It is four fields
                (percentage, starting equity, start time, label), and a
                campaign armed with three of the four is worse than none: a
                drawdown measured from a guessed anchor either halts a healthy
                account or fails to halt a bleeding one. So it is set as one
                object and REPORTED here, with the live numbers on
                GET /state/campaign. Owner 07-08: this is the limit that spans
                DAYS — the daily cap below resets every FX day, and ten days at
                it would end a small account. */}
            <div id="risk-campaign" className="text-(length:--fs-body)">
              <span className="font-semibold">Campaign stop</span>{' '}
              {campaignArmed ? (
                <span>
                  armed — {(risk.campaign.maxDrawdownPct * 100).toFixed(1)}% of{' '}
                  {Number(risk.campaign.startEquity).toLocaleString()} from {risk.campaign.startAt}
                  {risk.campaign.label ? ` · ${risk.campaign.label}` : ''}
                </span>
              ) : (
                <span className="text-[var(--color-text-sub)]">
                  not armed — nothing limits a WEEK. The daily cap resets every FX day, so a run of
                  ordinary days compounds with nothing counting. Set
                  {' '}<code>campaign</code>{' '}
                  to {'{maxDrawdownPct, startEquity, startAt, label}'} to arm it; live numbers at
                  {' '}<code>GET /state/campaign</code>.
                </span>
              )}
            </div>
            {/* ⚠️ OWNER DECISION 07-08-2026, a RISK LIMIT INCREASE:
                "$200 min. or 3% for accounts < $10000. 4% for account >
                $10000." The floor is what stops a shrunken balance turning
                the daily cap into a shutdown — 43097342 had fallen to $16.16.
                While the tier rule is on it REPLACES the % above and the flat
                fallback stops clamping; clear any tier field to restore the
                previous arithmetic exactly. */}
            <Field label={`Daily floor $${mark('dailyLossFloorUsd')}`} anchor="dailyLossFloorUsd" applied={appliedKeys.has('dailyLossFloorUsd')} value={risk.dailyLossFloorUsd} onChange={v => setRisk(r => ({ ...r, dailyLossFloorUsd: v }))}
              placeholder="off"
              hint="The day's allowance is never LESS than this, whatever the percentage works out to. A percentage of a small balance is a shutdown, not a limit: one ordinary loss ends the day and the account can never trade its way back. Empty = no floor."
              recommend="200 — the owner's figure, 07-08-2026." />
            <Field label={`Tier boundary $${mark('dailyLossTierAtUsd')}`} anchor="dailyLossTierAtUsd" applied={appliedKeys.has('dailyLossTierAtUsd')} value={risk.dailyLossTierAtUsd} onChange={v => setRisk(r => ({ ...r, dailyLossTierAtUsd: v }))}
              placeholder="off"
              hint="Balances BELOW this use the small-account percentage; at or above it, the large-account one. Empty turns the whole tier rule off and the single % above applies again."
              recommend="10000." />
            <Field label={`Tier % under boundary${mark('dailyLossTierSmallPct')}`} anchor="dailyLossTierSmallPct" applied={appliedKeys.has('dailyLossTierSmallPct')} pct value={risk.dailyLossTierSmallPct} onChange={v => setRisk(r => ({ ...r, dailyLossTierSmallPct: v }))}
              placeholder="off"
              hint="Applies when the balance is under the tier boundary. The floor still wins whenever it is the larger number."
              recommend="3%." />
            <Field label={`Tier % at or over boundary${mark('dailyLossTierLargePct')}`} anchor="dailyLossTierLargePct" applied={appliedKeys.has('dailyLossTierLargePct')} pct value={risk.dailyLossTierLargePct} onChange={v => setRisk(r => ({ ...r, dailyLossTierLargePct: v }))}
              placeholder="off"
              hint="Applies at or above the tier boundary. NOTE: while the tier rule is on, the flat daily cap fallback no longer clamps — otherwise a large account would sit at that fallback and never reach this percentage."
              recommend="4%." />
            <Field label={`Day ceiling (paced)${mark('dailyLossPctMax')}`} anchor="dailyLossPctMax" applied={appliedKeys.has('dailyLossPctMax')} pct value={risk.dailyLossPctMax} onChange={v => setRisk(r => ({ ...r, dailyLossPctMax: v }))}
              placeholder="off"
              hint="The MOST a day may ever cost. Set it above the cap and the allowance ramps from the cap at the FX day open to this by the day's end — so a bad first hour stops early instead of spending the whole day's budget. Empty = flat cap."
              recommend="empty (flat), or ~2× the daily cap when pacing." />
            {/* Where the paced allowance stands RIGHT NOW — served by the
                agent (data.dailyPacing), from the same function the risk gate
                calls. Recomputing it in the browser would mean a second
                DST-aware FX-day anchor that drifts from the veto line twice a
                year. */}
            {data?.dailyPacing?.paced && (
              <div className="glass-inset rounded-[1px] p-1.5 text-(length:--fs-body) text-[var(--color-text-sub)]">
                Now, {(data.dailyPacing.elapsed * 100).toFixed(0)}% through the FX day:
                <span className="font-semibold tabular-nums text-[var(--color-text)]">
                  {' '}{(data.dailyPacing.pct * 100).toFixed(2)}% = ${fmt$(data.dailyPacing.capUsd)}
                </span>
                {' '}· ceiling ${fmt$(data.dailyPacing.ceilingUsd)}
                {' '}· spent ${fmt$(data.dailyPacing.spentUsd)}
                {' '}· <span className="font-semibold text-[var(--color-text)]">${fmt$(data.dailyPacing.remainingUsd)} left</span>
                {data.dailyPacing.tradesLeft != null && <> (~{data.dailyPacing.tradesLeft} more trades)</>}
              </div>
            )}
            <Advanced mode={viewMode} label="Drawdown response and fallbacks" total={6}
              changed={['dailyLossLimit', 'deriskOnDrawdown', 'deriskWindowHours', 'deriskTriggerPct', 'deriskMult', 'blockedSymbols'].filter(k => overridden.has(k)).length}
              dirty={!!dirty['risk']}>
            {/* Owner 04-08-2026: "all Daily cap fallback be (null) mean not
                used to check. if % is (null) means not used to check. then
                warn that daily cap fallback isn't use it will be uncapped."
                It is no longer a fallback — it is a live check that binds
                whenever it is tighter than the %. */}
            <Field label={`Daily cap, flat $${mark('dailyLossLimit')}`} anchor="dailyLossLimit" applied={appliedKeys.has('dailyLossLimit')} unit="$" value={risk.dailyLossLimit} onChange={v => setRisk(r => ({ ...r, dailyLossLimit: v }))}
              placeholder="off"
              hint="A flat dollar cap on the day, checked alongside the % cap above — whichever is tighter binds. Empty = this check is off, and with the % cap also empty the day is uncapped."
              recommend="$300, or empty on a large account where the % cap should lead." />
            <Field label={`Equity stop${mark('equityStopPct')}`} anchor="equityStopPct" applied={appliedKeys.has('equityStopPct')} pct value={risk.equityStopPct} onChange={v => setRisk(r => ({ ...r, equityStopPct: v }))}
              hint="Daily drawdown at which the loop CLOSES all bot positions and disarms (empty = same as daily loss cap)." recommend="unset — falls back to the daily loss cap above." />
            <Field label={`Max margin usage${mark('maxMarginUsagePct')}`} anchor="maxMarginUsagePct" applied={appliedKeys.has('maxMarginUsagePct')} pct value={risk.maxMarginUsagePct} onChange={v => setRisk(r => ({ ...r, maxMarginUsagePct: v }))}
              hint="Bot's own cap on margin locked as a % of balance — separate from the broker's 50% stop-out." recommend="50% of balance." />
            {/* MISSING UNTIL 2026-08-04. The reassessment can propose this and
                the owner can apply it — the 31 Jul run moved it 150 → 200 —
                but the page had no field for it anywhere, so the value it now
                enforces could be neither seen nor changed. Found by the test
                that checks every proposable key has a field. */}
            <Field label={`Margin level floor${mark('marginLevelFloorPct')}`} anchor="marginLevelFloorPct" applied={appliedKeys.has('marginLevelFloorPct')} unit="%" value={risk.marginLevelFloorPct} onChange={v => setRisk(r => ({ ...r, marginLevelFloorPct: v }))}
              hint="Equity ÷ used margin, as a %. New entries are refused below this line — it fires EARLIER than the broker's stop-out, which is the point." recommend="150% or higher; the broker stops out at 50%." />
            <div className="border-t border-[var(--glass-edge)] pt-2 space-y-2">
              <div id="risk-deriskOnDrawdown" className="flex items-center justify-between text-(length:--fs-body)">
                <span className="text-[var(--color-text-sub)]" title="A losing run sizes DOWN automatically instead of compounding.">Drawdown de-risk{mark('deriskOnDrawdown')}</span>
                <Pill on={!!risk.deriskOnDrawdown} label="On" offLabel="Off" onClick={() => setRisk(r => ({ ...r, deriskOnDrawdown: !r.deriskOnDrawdown }))} />
              </div>
              <Field label={`window${mark('deriskWindowHours')}`} anchor="deriskWindowHours" unit="h" value={risk.deriskWindowHours} onChange={v => setRisk(r => ({ ...r, deriskWindowHours: v }))}
                recommend="24 hours." />
              <Field label={`trigger${mark('deriskTriggerPct')}`} anchor="deriskTriggerPct" pct value={risk.deriskTriggerPct} onChange={v => setRisk(r => ({ ...r, deriskTriggerPct: v }))}
                hint="Down more than this % of balance in the window → de-risk." recommend="5% down in the window." />
              <Field label={`size multiplier${mark('deriskMult')}`} anchor="deriskMult" unit="×" value={risk.deriskMult} onChange={v => setRisk(r => ({ ...r, deriskMult: v }))}
                hint="Budget × this while de-risked (0.5 = half size)." recommend="0.5 (half size)." />
            </div>
            <label id="risk-blockedSymbols" className="block text-(length:--fs-body)">
              <span className="text-[var(--color-text-sub)]" title="Symbols vetoed outright, comma-separated.">Blocked symbols{mark('blockedSymbols')}</span>
              <Input type="text" value={(risk.blockedSymbols || []).join(', ')}
                onChange={e => setRisk(r => ({ ...r, blockedSymbols: e.target.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) }))}
                placeholder="e.g. BTCUSD, USDIDR" className="!min-h-[26px] !py-0.5 !px-2 !text-(length:--fs-body)" />
            </label>
            </Advanced>
            {/* ENFORCED, AND UNTIL NOW UNREACHABLE (owner 04-08-2026: "Risk
                Setup Summary isnt wired … and coherent to the setups?").
                The summary table's values were correct — measured against
                /state/risk-config, zero disagreements. What was not wired was
                the NAVIGATION: 29 of its 45 triangles pointed at an anchor
                that did not exist, and for 17 of those the reason was that the
                setting had no control ANYWHERE in the UI. Every one is applied
                to real entries: the entry-stop trigger method, the four cost
                and news gates, and the whole unknown-P&L family that was 69%
                of last week's vetoes. Same class as marginLevelFloorPct, found
                the same way. */}
            <Advanced mode={viewMode} label="Entry gates, cost gates and P&L trust" total={18}
              changed={['nullExitMinR', 'stopTriggerMethod', 'blockOnUnknownPnl', 'unknownPnlGraceMin', 'unknownPnlMaxAgeMin', 'unknownPnlMinAttempts',
                'newsGateEnabled', 'newsGateMinBefore', 'newsGateMinAfter', 'newsGateImpacts',
                'carryGateEnabled', 'carryMaxNegativeSwapPoints',
                'commissionGateEnabled', 'commissionMaxFracOfWin', 'commissionGateMinTrades',
                'slippageGateEnabled', 'slippageMaxAdversePct', 'slippageGateMinTrades'].filter(k => overridden.has(k)).length}
              dirty={!!dirty['risk']}>
            <div className="grid grid-cols-1 @sm:grid-cols-2 @xl:grid-cols-3 gap-x-5 gap-y-1">
              <Field label={`Stop trigger method${mark('stopTriggerMethod')}`} anchor="stopTriggerMethod" value={risk.stopTriggerMethod} onChange={v => setRisk(r => ({ ...r, stopTriggerMethod: v }))}
                hint="How the broker decides a stop is hit: TRADE (last traded price) or TRADE_SIDE (the side that closes you). TRADE_SIDE fires earlier on a widening spread." recommend="TRADE unless spikes are stopping you out early." />
              <Toggle id="risk-blockOnUnknownPnl" label={`Block on unknown P&L${mark('blockOnUnknownPnl')}`}
                on={!!risk.blockOnUnknownPnl} onClick={() => setRisk(r => ({ ...r, blockOnUnknownPnl: !r.blockOnUnknownPnl }))}
                title="A closed trade with no realised P&L makes the day's loss total untrustworthy. On = refuse new entries until it fills in." />
              <Field label={`Unknown P&L grace${mark('unknownPnlGraceMin')}`} anchor="unknownPnlGraceMin" unit="min" value={risk.unknownPnlGraceMin} onChange={v => setRisk(r => ({ ...r, unknownPnlGraceMin: v }))}
                hint="A freshly closed trade is EXPECTED to sit without P&L for a cycle or two. Nothing blocks inside this window." recommend="15 minutes." />
              <Field label={`Unknown P&L age-out${mark('unknownPnlMaxAgeMin')}`} anchor="unknownPnlMaxAgeMin" unit="min" value={risk.unknownPnlMaxAgeMin} onChange={v => setRisk(r => ({ ...r, unknownPnlMaxAgeMin: v }))}
                placeholder="off"
                hint="Past this age a row stops blocking on TIME alone. Empty = block until it fills, which is a halt with no release." recommend="360 minutes (6h) — inside the FX day." />
              <Field label={`Unknown P&L give-up${mark('unknownPnlMinAttempts')}`} anchor="unknownPnlMinAttempts" unit="tries" value={risk.unknownPnlMinAttempts} onChange={v => setRisk(r => ({ ...r, unknownPnlMinAttempts: v }))}
                placeholder="off"
                hint="A row the backfill has asked the broker for this many times, and never filled, stops blocking immediately — evidence rather than a clock. Empty = time only." recommend="6 attempts." />
              <Field label={`Null-exit floor${mark('nullExitMinR')}`} anchor="nullExitMinR" unit="R" value={risk.nullExitMinR} onChange={v => setRisk(r => ({ ...r, nullExitMinR: v }))}
                placeholder="off"
                hint="A discretionary close this close to the entry banks nothing and pays the spread, so it is refused. Protection writers — equity stop, loss cap, loss guardian, weekend bank, ratchet — are never blocked, and neither is a close whose reason names one (invalidation, time cap, margin). 0 or empty = off."
                recommend="0.1R. Measured on 47790949: 26 of 31 discretionary closes landed inside 0.1R and cost -$3,348 between them, while 15 managed stops made +$1,510." />
              <Toggle id="risk-newsGateEnabled" label={`News gate${mark('newsGateEnabled')}`}
                on={!!risk.newsGateEnabled} onClick={() => setRisk(r => ({ ...r, newsGateEnabled: !r.newsGateEnabled }))}
                title="Refuse entries in the window around a high-impact release." />
              <Field label={`News: before${mark('newsGateMinBefore')}`} anchor="newsGateMinBefore" unit="min" value={risk.newsGateMinBefore} onChange={v => setRisk(r => ({ ...r, newsGateMinBefore: v }))}
                hint="Minutes ahead of the release that entries stop." recommend="30 minutes." />
              <Field label={`News: after${mark('newsGateMinAfter')}`} anchor="newsGateMinAfter" unit="min" value={risk.newsGateMinAfter} onChange={v => setRisk(r => ({ ...r, newsGateMinAfter: v }))}
                hint="Minutes after it that entries resume." recommend="15 minutes." />
              <Field label={`News: impacts${mark('newsGateImpacts')}`} anchor="newsGateImpacts" value={(risk.newsGateImpacts || []).join(', ')} onChange={v => setRisk(r => ({ ...r, newsGateImpacts: String(v ?? '').split(',').map(x => x.trim()).filter(Boolean) }))}
                hint="Which impact levels count, comma-separated (e.g. HIGH)." recommend="HIGH only." />
              <Toggle id="risk-carryGateEnabled" label={`Carry gate${mark('carryGateEnabled')}`}
                on={!!risk.carryGateEnabled} onClick={() => setRisk(r => ({ ...r, carryGateEnabled: !r.carryGateEnabled }))}
                title="Refuse entries whose overnight swap cost is worse than the limit below." />
              <Field label={`Max negative swap${mark('carryMaxNegativeSwapPoints')}`} anchor="carryMaxNegativeSwapPoints" unit="pts" value={risk.carryMaxNegativeSwapPoints} onChange={v => setRisk(r => ({ ...r, carryMaxNegativeSwapPoints: v }))}
                hint="Swap points per night, as a negative bound. A held position pays this every night it is open." />
              <Toggle id="risk-commissionGateEnabled" label={`Commission gate${mark('commissionGateEnabled')}`}
                on={!!risk.commissionGateEnabled} onClick={() => setRisk(r => ({ ...r, commissionGateEnabled: !r.commissionGateEnabled }))}
                title="Refuse entries where commission eats too much of a typical win." />
              <Field label={`Commission max of win${mark('commissionMaxFracOfWin')}`} anchor="commissionMaxFracOfWin" pct value={risk.commissionMaxFracOfWin} onChange={v => setRisk(r => ({ ...r, commissionMaxFracOfWin: v }))}
                hint="Round-trip commission as a share of the average win. Above this the edge is the broker's." />
              <Field label={`Commission min trades${mark('commissionGateMinTrades')}`} anchor="commissionGateMinTrades" unit="trades" value={risk.commissionGateMinTrades} onChange={v => setRisk(r => ({ ...r, commissionGateMinTrades: v }))}
                hint="Below this count there is no average win to measure against, so the gate stands down." />
              <Toggle id="risk-slippageGateEnabled" label={`Slippage gate${mark('slippageGateEnabled')}`}
                on={!!risk.slippageGateEnabled} onClick={() => setRisk(r => ({ ...r, slippageGateEnabled: !r.slippageGateEnabled }))}
                title="Refuse entries on symbols whose recent fills came in adversely." />
              <Field label={`Max adverse slippage${mark('slippageMaxAdversePct')}`} anchor="slippageMaxAdversePct" pct value={risk.slippageMaxAdversePct} onChange={v => setRisk(r => ({ ...r, slippageMaxAdversePct: v }))}
                hint="Average adverse fill, as a % away from the requested price." />
              <Field label={`Slippage min trades${mark('slippageGateMinTrades')}`} anchor="slippageGateMinTrades" unit="trades" value={risk.slippageGateMinTrades} onChange={v => setRisk(r => ({ ...r, slippageGateMinTrades: v }))}
                hint="Below this count the measurement is noise and the gate stands down." />
            </div>
            <div className="flex items-center gap-2 mt-2">
              <span data-save-pulse="risk"><Button size="sm" className={SAVE_BTN} onClick={() => saveRisk([
                'stopTriggerMethod', 'blockOnUnknownPnl', 'unknownPnlGraceMin', 'unknownPnlMaxAgeMin', 'unknownPnlMinAttempts',
                'newsGateEnabled', 'newsGateMinBefore', 'newsGateMinAfter', 'newsGateImpacts',
                'carryGateEnabled', 'carryMaxNegativeSwapPoints',
                'commissionGateEnabled', 'commissionMaxFracOfWin', 'commissionGateMinTrades',
                'slippageGateEnabled', 'slippageMaxAdversePct', 'slippageGateMinTrades',
                'nullExitMinR',
              ])}>Save gates</Button></span>
            </div>
            </Advanced>
            <div className="flex items-center gap-2">
              <span data-save-pulse="risk"><Button size="sm" className={SAVE_BTN} onClick={() => saveRisk(['dailyLossPct', 'dailyLossPctMax', 'dailyLossLimit', 'dailyLossFloorUsd', 'dailyLossTierAtUsd', 'dailyLossTierSmallPct', 'dailyLossTierLargePct', 'equityStopPct', 'maxMarginUsagePct', 'marginLevelFloorPct', 'deriskOnDrawdown', 'deriskWindowHours', 'deriskTriggerPct', 'deriskMult', 'blockedSymbols'])}>Save account risk</Button></span>
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
            <SectionTitle>Bot Trade Risk Configuration form</SectionTitle>
            {/* Grouped (owner 2026-07-28: "SL is all over the place" — every
                SL/TP knob now lives under ONE header, sizing under another,
                and each number carries its unit chip). */}
            <div className="space-y-3">
              <div>
                <div className="text-(length:--fs-body) font-semibold uppercase tracking-wide text-[var(--color-text-sub)] border-b border-[var(--glass-edge)] pb-0.5 mb-1">Entry sizing</div>
                <div className="grid grid-cols-1 @sm:grid-cols-2 @xl:grid-cols-3 gap-x-5 gap-y-1">
                  <Field label={`Per-trade risk${mark('perTradeRiskPct')}`} anchor="perTradeRiskPct" applied={appliedKeys.has('perTradeRiskPct')} pct value={risk.perTradeRiskPct} onChange={v => setRisk(r => ({ ...r, perTradeRiskPct: v }))}
                    hint="% of balance one trade may lose at its SL." recommend="5% (aggressive default, sized against the proven combos)." />
                  <Field label={`Risk hard cap${mark('maxRiskCapPct')}`} anchor="maxRiskCapPct" applied={appliedKeys.has('maxRiskCapPct')} pct value={risk.maxRiskCapPct} onChange={v => setRisk(r => ({ ...r, maxRiskCapPct: v }))}
                    hint="Never risk more than this % of balance regardless of other settings." recommend="5% — matches the per-trade % above, so it's a true ceiling, not extra headroom." />
                </div>
                {/* The two knobs above are the ones that get changed. These
                    five are real and reachable — they are simply not what
                    anyone opens this page to adjust. */}
                <Advanced mode={viewMode} label="Sizing details" total={5}
                  changed={['perTradeRiskUsd', 'maxRiskUsd', 'minLotSize', 'minTradesForKelly', 'allowNegativeExpectancyOverride'].filter(k => overridden.has(k)).length}
                  dirty={!!dirty['risk']}>
                <div className="grid grid-cols-1 @sm:grid-cols-2 @xl:grid-cols-3 gap-x-5 gap-y-1">
                  <Field label={`Risk $ override${mark('perTradeRiskUsd')}`} anchor="perTradeRiskUsd" unit="$" value={risk.perTradeRiskUsd} onChange={v => setRisk(r => ({ ...r, perTradeRiskUsd: v }))}
                    hint="Absolute $ risk per trade; when set, overrides the %." placeholder="% only" recommend="unset — leave the % in charge unless you specifically want a fixed $ risk." />
                  <Field label={`Risk hard cap $${mark('maxRiskUsd')}`} anchor="maxRiskUsd" unit="$" value={risk.maxRiskUsd} onChange={v => setRisk(r => ({ ...r, maxRiskUsd: v }))}
                    hint="Optional absolute $ ceiling per trade." placeholder="no cap" recommend="unset — no $ ceiling by default." />
                  <Field label={`Min lot size${mark('minLotSize')}`} anchor="minLotSize" unit="lots" value={risk.minLotSize} onChange={v => setRisk(r => ({ ...r, minLotSize: v }))}
                    recommend="0.01 — the broker's own minimum." />
                  <Field label={`Kelly min trades${mark('minTradesForKelly')}`} anchor="minTradesForKelly" unit="trades" value={risk.minTradesForKelly} onChange={v => setRisk(r => ({ ...r, minTradesForKelly: v }))}
                    hint="Below this trade count, Kelly sizing is skipped." recommend="30 closed trades before Kelly sizing kicks in." />
                  <div id="risk-allowNegativeExpectancyOverride" className="flex items-center justify-between text-(length:--fs-body)">
                    <span className="text-[var(--color-text-sub)]" title="If off, negative-expectancy combos are vetoed.">Allow −expectancy{mark('allowNegativeExpectancyOverride')}</span>
                    <Pill on={!!risk.allowNegativeExpectancyOverride} label="On" offLabel="Off" onClick={() => setRisk(r => ({ ...r, allowNegativeExpectancyOverride: !r.allowNegativeExpectancyOverride }))} />
                  </div>
                </div>
                </Advanced>
              </div>
              <div>
                <div className="text-(length:--fs-body) font-semibold uppercase tracking-wide text-[var(--color-text-sub)] border-b border-[var(--glass-edge)] pb-0.5 mb-1">Stop Loss &amp; Take Profit</div>
                <div className="grid grid-cols-1 @sm:grid-cols-2 @xl:grid-cols-3 gap-x-5 gap-y-1">
                  <Field label={`Min SL distance${mark('minSLDistancePct')}`} anchor="minSLDistancePct" applied={appliedKeys.has('minSLDistancePct')} unit="% px" value={risk.minSLDistancePct} onChange={v => setRisk(r => ({ ...r, minSLDistancePct: v }))}
                    hint="% of price — stops tighter than this get swept by noise. (Entered as a plain percent: 0.15 = 0.15% of price.)" recommend="0.15% of price." />
                  <Field label={`Min R:R${mark('minRR')}`} anchor="minRR" applied={appliedKeys.has('minRR')} unit="×SL" value={risk.minRR} onChange={v => setRisk(r => ({ ...r, minRR: v }))}
                    hint="TP must sit at least this multiple of the SL distance from entry — the take-profit rule." recommend="1.5 — TP at least 1.5× the SL distance." />
                  <Field label={`Max spread / SL${mark('maxSpreadFracOfSL')}`} anchor="maxSpreadFracOfSL" pct value={risk.maxSpreadFracOfSL} onChange={v => setRisk(r => ({ ...r, maxSpreadFracOfSL: v }))}
                    hint="Veto when the live spread exceeds this fraction of the SL distance." recommend="25% of the SL distance." />
                </div>
                <div className="text-(length:--fs-body) text-[var(--color-text-sub)] mt-1">
                  Dollar loss floors per position (the GOOGL case) live in <a href="#sec-protection" className="underline">Position protection</a> above — this group only shapes where SL/TP are PLACED at entry.
                </div>
              </div>
              <div>
                <div className="text-(length:--fs-body) font-semibold uppercase tracking-wide text-[var(--color-text-sub)] border-b border-[var(--glass-edge)] pb-0.5 mb-1">Exposure limits</div>
                <div className="grid grid-cols-1 @sm:grid-cols-2 @xl:grid-cols-3 gap-x-5 gap-y-1">
                  <Field label={`Max open positions${mark('maxOpenPositions')}`} anchor="maxOpenPositions" applied={appliedKeys.has('maxOpenPositions')} unit="pos" value={risk.maxOpenPositions} onChange={v => setRisk(r => ({ ...r, maxOpenPositions: v }))}
                    recommend="5 concurrent positions." />
                  <Field label={`Max per symbol${mark('maxPositionsPerSymbol')}`} anchor="maxPositionsPerSymbol" applied={appliedKeys.has('maxPositionsPerSymbol')} unit="pos" value={risk.maxPositionsPerSymbol} onChange={v => setRisk(r => ({ ...r, maxPositionsPerSymbol: v }))}
                    hint="HARD CEILING on SIMULTANEOUS exposure to one symbol on one account — open positions, orders submitted but not yet reconciled, and limit orders resting at the broker, yours included. Concurrent, never cumulative: a symbol traded and closed all week counts zero today. Not a permission — the one-per-symbol gate still refuses the second on the normal path. This is the backstop every OTHER submitter must obey."
                    recommend="3. On 04-08-2026 one DOW.US signal left thirteen limit orders resting at 29.84 over 82 minutes; they filled together in 89 milliseconds and cost $1,615." />
                  <Field label={`Cluster exposure${mark('maxClusterExposure')}`} anchor="maxClusterExposure" applied={appliedKeys.has('maxClusterExposure')} unit="bets" value={risk.maxClusterExposure} onChange={v => setRisk(r => ({ ...r, maxClusterExposure: v }))}
                    hint="Net directional bets allowed per correlation cluster. 0 = off." recommend="2 net directional bets per cluster." />
                  <Field label={`Currency exposure${mark('maxCurrencyExposure')}`} anchor="maxCurrencyExposure" applied={appliedKeys.has('maxCurrencyExposure')} unit="bets" value={risk.maxCurrencyExposure} onChange={v => setRisk(r => ({ ...r, maxCurrencyExposure: v }))}
                    recommend="2 net bets per currency." />
                </div>
              </div>
              <Advanced mode={viewMode} label="Cooldowns, streaks, monitoring and weekends" total={6}
                changed={['symbolCooldownMinutes', 'maxConsecutiveLosses', 'cooldownMinutes'].filter(k => overridden.has(k)).length}
                dirty={!!dirty['risk']}>
              <div>
                <div className="text-(length:--fs-body) font-semibold uppercase tracking-wide text-[var(--color-text-sub)] border-b border-[var(--glass-edge)] pb-0.5 mb-1">Cooldowns &amp; streaks</div>
                <div className="grid grid-cols-1 @sm:grid-cols-2 @xl:grid-cols-3 gap-x-5 gap-y-1">
                  <Field label={`Symbol cooldown${mark('symbolCooldownMinutes')}`} anchor="symbolCooldownMinutes" applied={appliedKeys.has('symbolCooldownMinutes')} unit="min" duration value={risk.symbolCooldownMinutes} onChange={v => setRisk(r => ({ ...r, symbolCooldownMinutes: v }))}
                    hint="Lock a symbol after any closed trade on it." recommend="240 minutes (4h) after any closed trade on that symbol." />
                  <Field label={`Loss streak${mark('maxConsecutiveLosses')}`} anchor="maxConsecutiveLosses" applied={appliedKeys.has('maxConsecutiveLosses')} unit="losses" value={risk.maxConsecutiveLosses} onChange={v => setRisk(r => ({ ...r, maxConsecutiveLosses: v }))}
                    hint="After N losses in a row, pause. 0 = off." recommend="3 losses in a row." />
                  <Field label={`Streak cooldown${mark('cooldownMinutes')}`} anchor="cooldownMinutes" applied={appliedKeys.has('cooldownMinutes')} unit="min" duration value={risk.cooldownMinutes} onChange={v => setRisk(r => ({ ...r, cooldownMinutes: v }))}
                    recommend="60 minutes." />
                </div>
              </div>
              <div>
                <div className="text-(length:--fs-body) font-semibold uppercase tracking-wide text-[var(--color-text-sub)] border-b border-[var(--glass-edge)] pb-0.5 mb-1">Monitoring &amp; weekends</div>
                <GlobalScopeNote className="mb-1.5" what="The guardian move %, weekend profit bank and weekend loss flag" />
                <div className="grid grid-cols-1 @sm:grid-cols-2 @xl:grid-cols-3 gap-x-5 gap-y-1">
                  <Field label="Guardian move" pct value={guardianPct} onChange={v => setGuardianPct(v ?? 0)}
                    hint="Tick move that wakes the guardian between sweeps." recommend="5%." />
                  <div className="flex items-center justify-between text-(length:--fs-body)">
                    <span className="text-[var(--color-text-sub)]" title="Bank profitable positions before long market closures.">Weekend profit bank</span>
                    <Pill commit="now" on={weekendBank} label="On" offLabel="Off" onClick={() => {
                      const next = !weekendBank
                      setWeekendBank(next)
                      save('weekend-bank', () => agentPost('/actions/weekend-bank', { on: next }))
                    }} />
                  </div>
                  <div className="flex items-center justify-between text-(length:--fs-body)">
                    <span className="text-[var(--color-text-sub)]" title="Flag (action_log + Telegram) losing positions before long market closures. Never closes them — same reasoning as leaving losers alone in the profit bank above.">Weekend loss flag</span>
                    <Pill commit="now" on={weekendLossFlag} label="On" offLabel="Off" onClick={() => {
                      const next = !weekendLossFlag
                      setWeekendLossFlag(next)
                      save('weekend-loss-flag', () => agentPost('/actions/weekend-loss-flag', { on: next }))
                    }} />
                  </div>
                </div>
              </div>
              </Advanced>
            </div>
            <div className="mt-3">
              <span data-save-pulse="risk"><Button size="sm" onClick={() => {
                saveRisk(['perTradeRiskPct', 'perTradeRiskUsd', 'maxRiskCapPct', 'maxRiskUsd', 'minLotSize', 'minRR', 'minSLDistancePct', 'maxSpreadFracOfSL', 'maxOpenPositions', 'maxPositionsPerSymbol', 'symbolCooldownMinutes', 'maxConsecutiveLosses', 'cooldownMinutes', 'maxClusterExposure', 'maxCurrencyExposure', 'minTradesForKelly', 'allowNegativeExpectancyOverride'])
                save('guardian', () => agentPost('/actions/guardian-move-pct', { pct: guardianPct }))
              }}>Save bot risk</Button></span>
            </div>
          </Card>

          {cardVisible('sec-sizing', viewMode) && (
          <Card id="sec-sizing" data-risk-card data-risk-reveal className="w3-hover-shadow">
            <SectionTitle badge={<Badge tone="info">Sizing</Badge>}>Lot Calculation form</SectionTitle>
            {(() => {
              const mode = Number(risk.perTradeRiskUsd) > 0 ? 'absolute' : 'percent'
              const bal = Number(acct.balance) || 0
              const budget = mode === 'absolute' ? Number(risk.perTradeRiskUsd) : bal * (Number(risk.perTradeRiskPct) || 0)
              const m = data?.margin
              const cap = bal * (Number(risk.maxMarginUsagePct) || 0)
              const headroom = m?.usedMargin != null ? cap - m.usedMargin : null
              return (
                <div className="text-(length:--fs-body) space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--color-text-sub)]" title="Percentage: risk budget = balance × per-trade %. Absolute: a fixed $ amount (3-decimal precision) overrides the %.">Sizing mode</span>
                    <span role="radiogroup" aria-label="Sizing mode" className="flex gap-1">
                      <Pill radio on={mode === 'percent'} label="Percentage" onClick={() => setRisk(r => ({ ...r, perTradeRiskUsd: null }))} />
                      <Pill radio on={mode === 'absolute'} label="Absolute $" onClick={() => setRisk(r => ({ ...r, perTradeRiskUsd: r.perTradeRiskUsd > 0 ? r.perTradeRiskUsd : Number((bal * (r.perTradeRiskPct || 0.05)).toFixed(3)) }))} />
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

          )}
          {cardVisible('sec-cpp', viewMode) && (
          <Card id="sec-cpp" data-risk-card data-risk-reveal className="w3-hover-shadow">
            <SectionTitle badge={<Badge tone="special">C++ sidecar</Badge>}>C++ Risk Configuration form</SectionTitle>
            <GlobalScopeNote className="mb-2" what="The sidecar's halt, bracket and volume guards" />
            <div className="grid grid-cols-1 @sm:grid-cols-2 gap-x-5 gap-y-1">
              <div className="flex items-center justify-between text-(length:--fs-body)">
                <span className="text-[var(--color-text-sub)]" title="Kill switch: the C++ engine refuses EVERY order while halted.">Halt (kill switch)</span>
                <Pill on={!!guard.halt} label={guard.halt ? 'Halted — no orders' : 'Off'} onClick={() => setGuard(g => ({ ...g, halt: !g.halt }))} />
              </div>
              <div className="flex items-center justify-between text-(length:--fs-body)">
                <span className="text-[var(--color-text-sub)]" title="A market order with no stop loss is refused — last line of defence.">Require Stop Loss</span>
                <Pill on={guard.requireBracket !== false} label="On" offLabel="Off" onClick={() => setGuard(g => ({ ...g, requireBracket: !(g.requireBracket !== false) }))} />
              </div>
              <div className="flex items-center justify-between text-(length:--fs-body)">
                <span className="text-[var(--color-text-sub)]" title="A market order with no take profit is refused.">Require Take Profit</span>
                <Pill on={guard.requireTarget !== false} label="On" offLabel="Off" onClick={() => setGuard(g => ({ ...g, requireTarget: !(g.requireTarget !== false) }))} />
              </div>
              <Field label="Max order volume" unit="×100" value={guard.maxOrderVolume} onChange={v => setGuard(g => ({ ...g, maxOrderVolume: v }))}
                hint="Hard cap on a single order's cTrader volume. 0 = no cap." recommend="0 — no cap." />
              <div className="flex items-center justify-between text-(length:--fs-body)">
                <span className="text-[var(--color-text-sub)]" title="Virtual Pending Order engine — feeder side. The sidecar's own VPO_ENABLED/VPO_SYMBOLS env must also be set.">VPO feeder</span>
                <Pill commit="now" on={vpoEnabled} label="On" offLabel="Off" onClick={() => {
                  const next = !vpoEnabled
                  setVpoEnabled(next)
                  save('vpo', () => agentPost('/actions/vpo-settings', { enabled: next }))
                }} />
              </div>
              <div className="text-(length:--fs-body) text-[var(--color-text-sub)]">
                VPO pairs: {data?.vpo?.config?.length ? data.vpo.config.map(c => `${c.symbol}·${c.key}`).join(', ') : 'none configured'} — set via /actions/vpo-settings; the sidecar's VPO_SYMBOLS env must match.
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span data-save-pulse="exec-guard"><Button size="sm" className={SAVE_BTN} onClick={() => save('exec-guard', () => agentPost('/actions/exec-guard', guard))}>Save cpp guard</Button></span>
            </div>
          </Card>

          )}
          {/* NOT deferred, at any view size: a page that hides the panic
              button to look tidier has optimised the wrong thing. */}
          <Card id="sec-emergency" data-risk-card data-risk-reveal className="w3-hover-shadow">
            {/* Section label = classification, not a P&L number (finding: down tone misuse). */}
            <SectionTitle badge={<Badge tone="warning">Emergency</Badge>}>Close All Positions form</SectionTitle>
            <p className="text-(length:--fs-body) text-[var(--color-text-sub)] mb-2">
              Closes every open position at the broker right now — bot-placed and manual alike. Halt (above) only blocks NEW orders; this ends existing ones. Irreversible.
            </p>
            <Button size="sm" variant="danger" disabled={closingAll} onClick={closeAll}>
              {closingAll ? 'Closing…' : 'Close ALL positions'}
            </Button>
            {closeAllResult && (
              <div className="mt-2 text-(length:--fs-body) text-[var(--color-text-sub)]">
                Closed {closeAllResult.closed?.length || 0}
                {closeAllResult.failures?.length ? `, ${closeAllResult.failures.length} failed: ${closeAllResult.failures.map(f => `${f.symbol || f.positionId} (${f.error})`).join('; ')}` : ''}
              </div>
            )}
          </Card>
        </div>

        {/* ---- Right column: worked examples ---- */}
        <div className="space-y-2">
          {cardVisible('sec-example-live', viewMode) && (
          <Card id="sec-example-live" data-risk-card className="w3-hover-shadow">
            <SectionTitle>Example Trade — Bot-Trade Live card</SectionTitle>
            <MiniChart entry={entry} sl={sl} tp={tp} />
            <div className="text-(length:--fs-body) space-y-1 mt-2">
              <div>Sample: EURUSD long at {entry.toFixed(4)}, balance {fmt$(bal, 0)} USD.</div>
              <div>SL {sl.toFixed(4)} (min distance {Number(risk.minSLDistancePct) || 0.15}%) · TP {tp.toFixed(4)} ({Number(risk.minRR) || 1.5}R).</div>
              <div>Risk budget: <AnimatedNumber value={budget} className="font-semibold" />{budget < budgetBase ? ` (capped from ${fmt$(budgetBase)})` : ''} → <AnimatedNumber value={lots} className="font-semibold" /> lots at ~<AnimatedNumber value={usdPerLot} />/lot.</div>
              <div className="text-[var(--color-text-sub)]">
                Then the gate still checks: daily cap, loss streak, max {risk.maxOpenPositions ?? 5} open, one-per-symbol, spread ≤ {((Number(risk.maxSpreadFracOfSL) || 0.25) * 100).toFixed(0)}% of SL, cluster/currency exposure, margin headroom at 1:{acct.leverage || 100} — ANY failure vetoes with a logged reason.
              </div>
            </div>
          </Card>
          )}
          {cardVisible('sec-example-cpp', viewMode) && (
          <Card id="sec-example-cpp" data-risk-card data-risk-reveal className="w3-hover-shadow">
            <SectionTitle>Example Trade — C++ Configuration card</SectionTitle>
            <MiniChart entry={entry} sl={sl} tp={tp} trigger={entry - slDist * 0.4} />
            <div className="text-(length:--fs-body) space-y-1 mt-2">
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
          )}
        </div>
      </div>
    </div>
  )
}
