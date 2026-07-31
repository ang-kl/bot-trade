/* Trade Cockpit — deterministic transcription of the design handoff.
   Sources, in conflict order: BUILD-ORDER.md > Canvas*.dc.html references >
   symbol-click-spec.md / trade-cockpit-spec.md / canvas-variants-spec.md.
   Markup and every inline value below are ported from the reference files;
   nothing here is a design decision. Variant deltas are exactly BUILD-ORDER §6.
   All conflicts met during the port are listed in the PR body, none resolved
   silently. */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import gsap from 'gsap'
import { cockpitFrame } from './cockpit-data.js'
import { pageAsleep } from '../lib/agent-api.js'
import { makeFs } from './typeScale.js'
import './cockpit-tokens.css'

// BUILD-ORDER §6 — the variant table, verbatim. (Conflict, reported: iPhone
// PFD columns are `50·1fr·22·84·36` in §6 but `50px minmax(90px,1fr) 22px 84px
// 36px` is what the reference file carries at its line 70 — §6 wins on the
// numbers it states; the minmax(90px,…) centre form is reference-verbatim.)
const CFG = {
  desktop: { shellPad: '16px 12px 6px 24px', grid: '1fr 1.25fr', tabs: null,
    pfdCols: '54px minmax(96px,1fr) 32px 94px 36px', pfdGap: 5, pfdH: 340,
    jr: '3fr 1fr', bullets: 'repeat(2,1fr)', inv: 'repeat(5,1fr)', headerWraps: false, touch: false },
  ipad: { shellW: 1024, shellPad: '16px 10px 8px 24px', grid: '1fr', tabs: ['PFD', 'MFD'],
    pfdCols: '86px 1fr 54px 108px 54px', pfdGap: 7, pfdH: 300,
    jr: '3fr 1fr', bullets: 'repeat(2,1fr)', inv: 'repeat(3,1fr)', headerWraps: false, touch: true },
  iphone: { shellW: 390, shellPad: '14px 8px 10px 20px', grid: '1fr', tabs: ['PFD', 'MFD', 'LOG'],
    pfdCols: '50px minmax(90px,1fr) 22px 84px 36px', pfdGap: 4, pfdH: 268,
    jr: '1fr', bullets: '1fr', inv: 'repeat(2,1fr)', headerWraps: true, touch: true },
}

const chipTint = { wrn: 'rgba(255,196,102,.16)', acc: 'rgba(79,140,255,.18)', vio: 'rgba(168,85,247,.18)', mu: 'rgba(154,168,204,.16)' }

function Chip({ fs, hue, children }) {
  return <span style={{ fontSize: fs(10.5), fontWeight: 600, letterSpacing: '.05em', color: `var(--${hue})`, background: chipTint[hue], border: `1px solid var(--${hue})`, borderRadius: 5, padding: '0 7px', whiteSpace: 'nowrap' }}>{children}</span>
}
function Info({ fs, tip, big }) {
  return big
    ? <span title={tip} style={{ cursor: 'help', fontSize: fs(11.5), fontWeight: 600, color: 'var(--mu)', border: '1px solid var(--edg)', borderRadius: '50%', width: 15, height: 15, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>ⓘ</span>
    : <span title={tip} style={{ cursor: 'help', fontSize: fs(9.5), color: 'var(--mu)' }}>ⓘ</span>
}

const card = { background: 'var(--gls)', border: '1px solid var(--gbd)', boxShadow: 'var(--gsh)', backdropFilter: 'blur(22px)' }
const pane = { position: 'relative', borderRadius: 10, border: '1px solid var(--edg)', background: 'var(--acs)', overflow: 'hidden' }

export default function TradeCockpit({ variant: forced, positionState = 'open', sessionState = 'open', onClose, feedBlocked = false, position = null, tradeId = null }) {
  const [vw, setVw] = useState(() => window.innerWidth)
  useEffect(() => { const f = () => setVw(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [])
  const variant = forced || (vw >= 1100 ? 'desktop' : vw >= 768 ? 'ipad' : 'iphone')
  const cfg = CFG[variant]
  const fs = useMemo(() => makeFs(variant), [variant])
  const review = positionState === 'closed'
  // A bound position carries the broker's own market state (market_open from
  // the symbol_hours schedule), so it — not the URL — decides the session axis.
  const sess = position && position.marketOpen === false ? 'closed' : sessionState
  const marketClosed = sess !== 'open' && !review

  // Owner (2026-07-26): "The theme should follow the system." System is the
  // default and tracks live changes; the header button is an explicit override
  // for this cockpit only (null = follow system).
  const [sysDark, setSysDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const f = e => setSysDark(e.matches)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [])
  const [themeOverride, setThemeOverride] = useState(null)
  const theme = themeOverride ?? (sysDark ? 'dark' : 'light')
  const [tick, setTick] = useState(0)
  const [pane2, setPane] = useState('PFD')
  const [openKeys, setOpenKeys] = useState([])
  const [minuteTick, setMinute] = useState(0)
  const [staleFor, setStaleFor] = useState(0)
  const [retries, setRetries] = useState(0)
  const [loaded, setLoaded] = useState(!feedBlocked)
  const storeRef = useRef({})
  const rootRef = useRef(null)
  const rm = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  // Owner (2026-07-26): "For phone, it should reduce the size by 20% for
  // portrait mode." Uniform 0.8 scale on the shell — footprint AND contents,
  // which is what "20% smaller" reads as on a handset.
  const [portrait, setPortrait] = useState(() => matchMedia('(orientation: portrait)').matches)
  useEffect(() => {
    const mq = matchMedia('(orientation: portrait)')
    const f = e => setPortrait(e.matches)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [])
  const phoneShrink = variant === 'iphone' && portrait

  // Live tick ≥1Hz-equivalent cadence from the reference (2200ms mock tick).
  // Closed market (§8): no subscription — ONLY the countdown updates, once a minute.
  useEffect(() => {
    if (marketClosed) { const t = setInterval(() => setMinute(m => m + 1), 60000); return () => clearInterval(t) }
    if (feedBlocked) {
      // Load failure: cockpit stays open; amber advisory + backoff retries; recover silently.
      let n = 0; let t
      const retry = () => { n += 1; setRetries(n); if (n >= 4) { setLoaded(true); setTick(k => k + 1); return } t = setTimeout(retry, 800 * Math.pow(2, n)) }
      t = setTimeout(retry, 800)
      return () => clearTimeout(t)
    }
    // Sleep guard (owner 2026-07-28, "is the cockpit popup a culprit"): this
    // component makes no network calls, but it re-renders a large SVG panel
    // every 2.2s forever — in a hidden or idle tab that is pure CPU and
    // battery burn. Every other poller got this guard in the tab-presence
    // work; this one was missed because it has no fetch to guard.
    const t = setInterval(() => { if (!pageAsleep()) setTick(k => k + 1) }, 2200)
    return () => clearInterval(t)
  }, [marketClosed, feedBlocked])

  // Stale detection — DISABLED on a closed market ("closed is not broken").
  useEffect(() => {
    if (marketClosed || feedBlocked) { const id = setTimeout(() => setStaleFor(0), 0); return () => clearTimeout(id) }
    const t = setInterval(() => { if (!pageAsleep()) setStaleFor(s => (window.__tcSimStale ? s + 1 : 0)) }, 1000)
    return () => clearInterval(t)
  }, [marketClosed, feedBlocked])
  const stale = staleFor > 5

  // The countdown is reference demo timing. A real position has no next-open
  // source on this route, so it shows CLOSED with no invented time-to-open.
  const opensInMins = marketClosed && !position ? Math.max(1, 4 * 60 + 23 - minuteTick) : null
  const [v, setV] = useState(null)
  useEffect(() => {
    // async apply (mirrors the reference's deferred animate() pass) — also
    // keeps this effect purely synchronising with the mock feed
    const id = setTimeout(() => setV(loaded ? cockpitFrame(storeRef.current, tick, {
      positionState, session: { state: sess, exchange: position?.exchange || 'HKEX', opensInMins },
      real: position,
    }) : null), 0)
    return () => clearTimeout(id)
  }, [loaded, tick, positionState, sess, opensInMins, position])

  // GSAP wiring — port of the reference animate(); reduced-motion applies values instantly.
  const pnlObj = useRef(null)
  useEffect(() => {
    if (!v || !rootRef.current) return
    if (rm) gsap.globalTimeline.timeScale(1000)
    const q = sel => rootRef.current.querySelector(sel)
    const a = v.anim
    const pnlEl = q('#hdr-pnl')
    if (pnlEl && typeof a.pnlNum === 'number') {
      if (!pnlObj.current) pnlObj.current = { v: a.pnlNum }
      gsap.to(pnlObj.current, { v: a.pnlNum, duration: .9, ease: 'power1.out', snap: { v: 1 }, overwrite: true,
        onUpdate: () => { pnlEl.textContent = (pnlObj.current.v >= 0 ? '+' : '−') + '$' + Math.abs(pnlObj.current.v).toFixed(0) } })
    }
    if (q('#pfd-vsi')) gsap.to(q('#pfd-vsi'), { rotation: a.vsiA, duration: 1, ease: 'back.out(1.5)' })
    if (q('#pfd-hdg')) gsap.to(q('#pfd-hdg'), { xPercent: a.hdgX, duration: 1.1, ease: 'power2.out' })
    if (q('#ei-fuel')) gsap.to(q('#ei-fuel'), { width: a.fuelW + '%', duration: 1, ease: 'power2.out' })
    ;['#alt-tp', '#alt-en', '#alt-sl'].forEach((id, i) => { const el = q(id); if (el) gsap.set(el, { top: [a.tpT, a.enT, a.slT][i] + '%' }) })
    if (q('#mfd-ac')) gsap.to(q('#mfd-ac'), { x: a.acX, y: a.acY, duration: 1.1, ease: 'power2.out' })
    if (!storeRef.current._wx && q('#wx1') && !marketClosed) { storeRef.current._wx = 1
      gsap.to(q('#wx1'), { scale: 1.12, transformOrigin: 'center', duration: 2.2, repeat: -1, yoyo: true, ease: 'sine.inOut' })
      gsap.to(q('#wx2'), { scale: 1.25, transformOrigin: 'center', duration: 1.6, repeat: -1, yoyo: true, ease: 'sine.inOut' }) }
    rootRef.current.querySelectorAll('.bul-bar').forEach(el => storeRef.current._bulDone
      ? gsap.set(el, { width: el.dataset.w + '%' }) : gsap.to(el, { width: el.dataset.w + '%', duration: .8, ease: 'power2.out' }))
    storeRef.current._bulDone = true
    rootRef.current.querySelectorAll('.vp-bar').forEach(el => storeRef.current._vpDone
      ? gsap.set(el, { width: el.dataset.w + '%' }) : gsap.to(el, { width: el.dataset.w + '%', duration: .9, ease: 'power2.out' }))
    storeRef.current._vpDone = true
    return () => { }
  }, [v, rm, marketClosed])
  useEffect(() => () => { gsap.killTweensOf('#pfd-vsi,#pfd-hdg,#ei-fuel,#alt-tp,#alt-sl,#alt-en,#mfd-ac,#wx1,#wx2') }, [])

  // Owner (2026-07-26): "Close after 8 minutes if i don't close it." The timer
  // restarts on any interaction inside the cockpit, so it only fires when the
  // window has genuinely been left open and untouched.
  useEffect(() => {
    const el = rootRef.current
    let t
    const arm = () => { clearTimeout(t); t = setTimeout(() => onClose?.(), 8 * 60 * 1000) }
    arm()
    const evts = ['pointerdown', 'keydown', 'wheel', 'touchstart']
    evts.forEach(e => el?.addEventListener(e, arm, { passive: true }))
    return () => { clearTimeout(t); evts.forEach(e => el?.removeEventListener(e, arm)) }
  }, [onClose])

  // Esc closes; focus moves in on mount.
  useEffect(() => {
    const el = rootRef.current; if (el) el.focus()
    const onKey = e => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Journal ⟷ chart marker bi-directional highlight (port of setHi).
  const setHi = useCallback((k, on) => {
    const root = rootRef.current; if (!root) return
    root.querySelectorAll('.tw-mark').forEach(el => {
      const hit = el.dataset.key === k
      el.style.filter = on && hit ? 'url(#glo)' : 'none'
      el.style.transform = on && hit ? 'scale(1.9)' : 'scale(1)'
      el.style.transformBox = 'fill-box'; el.style.transformOrigin = 'center'
      el.style.transition = 'transform .18s ease'
      if (!hit) el.style.opacity = on ? .35 : 1
    })
    root.querySelectorAll('.tw-row').forEach(el => { el.style.background = on && el.dataset.key === k ? 'var(--acs)' : 'transparent' })
  }, [])

  // ruler cursor
  useEffect(() => {
    const root = rootRef.current; if (!root) return
    const onMove = e => {
      const r = root.getBoundingClientRect()
      const x = e.clientX - r.left, y = e.clientY - r.top
      const set = (id, prop, val) => { const el = root.querySelector('#' + id); if (el) { el.style[prop] = val + 'px'; el.style.opacity = 1 } }
      set('rul-x', 'left', x); set('rul-y', 'top', y)
      const xv = root.querySelector('#rul-xv'), yv = root.querySelector('#rul-yv')
      if (xv) { xv.textContent = Math.round(x); xv.style.left = (x + 3) + 'px'; xv.style.opacity = 1 }
      if (yv) { yv.textContent = Math.round(y); yv.style.top = (y + 3) + 'px'; yv.style.opacity = 1 }
    }
    root.addEventListener('pointermove', onMove)
    return () => root.removeEventListener('pointermove', onMove)
  }, [])

  const dim = stale ? 'var(--sb)' : null
  const touchPad = cfg.touch ? { minHeight: 44 } : {}

  // ————— sections (all reference-verbatim values, fs() = §3 pass) —————
  const skeleton = h => <div style={{ height: h ?? 2, background: 'var(--edg)', borderRadius: 1, margin: '4px 6px' }} />

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: fs(19), fontWeight: 700, letterSpacing: '-.02em' }}>{v?.sym ?? '0002.HK'}</span>
      <span style={{ fontSize: fs(11.5), fontWeight: 600, padding: '2px 9px', borderRadius: 999, color: v?.side === 'SHORT' ? 'var(--dn)' : 'var(--up)', background: v?.side === 'SHORT' ? 'var(--dns)' : 'var(--acs)', border: `1px solid ${v?.side === 'SHORT' ? 'var(--dn)' : 'var(--up)'}` }}>{v?.side ?? 'LONG'} · {v?.lots ?? '—'} lots</span>
      <span style={{ fontSize: fs(10.5), fontWeight: 600, color: 'var(--sb)', padding: '2px 8px', borderRadius: 6, background: 'var(--acs)' }}>{v?.strategy ?? 'fib 61.8% fade v2.3'}</span>
      {review
        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: fs(11.5), fontWeight: 600, color: 'var(--mu)', border: '1px solid var(--mu)', borderRadius: 999, padding: '2px 8px' }}>CLOSED {v?.timeIn ?? ''}</span>
        : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: fs(11.5), fontWeight: 600, color: stale ? 'var(--wrn)' : 'var(--acc)', border: `1px solid ${stale ? 'var(--wrn)' : 'var(--acc)'}`, borderRadius: 999, padding: '2px 8px' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: stale ? 'var(--wrn)' : 'var(--acc)', animation: stale || marketClosed ? 'none' : 'tc-pulse 1.6s infinite' }} />OPEN {v?.timeIn ?? ''}{stale ? ` · STALE ${staleFor}s` : ''}</span>}
      {marketClosed && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: fs(11.5), fontWeight: 600, color: 'var(--mu)', border: '1px solid var(--mu)', borderRadius: 999, padding: '2px 8px', fontVariantNumeric: 'tabular-nums' }}>
          {position?.exchange || 'HKEX'} {sess.toUpperCase()}{sess === 'closed' && opensInMins != null ? ` · opens in ${Math.floor(opensInMins / 60)}h ${opensInMins % 60}m` : ''}</span>)}
      <span style={{ fontSize: fs(15), fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: dim || v?.rCol }}><span id="hdr-pnl">{v?.pnl ?? '—'}</span> · {v?.rNow ?? '—'}</span>
      <span style={{ marginLeft: 'auto', fontSize: fs(10.5), fontWeight: 600, color: 'var(--sb)', fontVariantNumeric: 'tabular-nums' }}>{v?.clock ?? ''}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none', whiteSpace: 'nowrap', ...(cfg.headerWraps ? { flexBasis: '100%' } : {}) }}>
        <button disabled={marketClosed} title={marketClosed ? `market closed — opens in ${Math.floor(opensInMins / 60)}h ${opensInMins % 60}m` : undefined}
          style={{ cursor: marketClosed ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: fs(11.5), fontWeight: 600, color: marketClosed ? 'var(--mu)' : 'var(--tx)', background: 'var(--acs)', border: `1px solid ${marketClosed ? 'var(--mu)' : 'var(--acc)'}`, borderRadius: 10, padding: cfg.headerWraps ? '11px 14px' : '4px 12px', ...(cfg.headerWraps ? { flex: 1 } : {}) }}>Manage</button>
        <button title={marketClosed ? 'queues for next open' : undefined}
          style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: fs(11.5), fontWeight: 600, color: 'var(--dn)', background: 'var(--dns)', border: '1px solid var(--dn)', borderRadius: 10, padding: cfg.headerWraps ? '11px 14px' : '4px 12px', ...(cfg.headerWraps ? { flex: 1 } : {}) }}>Close</button>
        <button title={themeOverride == null ? 'Following the system theme — tap to override' : 'Overriding the system theme — tap to cycle'}
          onClick={() => setThemeOverride(o => (o == null ? (sysDark ? 'light' : 'dark') : null))}
          style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: fs(11.5), fontWeight: 600, color: 'var(--tx)', background: 'var(--acs)', border: '1px solid var(--gbd)', borderRadius: 10, padding: '4px 10px' }}>{theme === 'dark' ? '☾ Dark' : '☀ Light'}{themeOverride == null ? '' : ' ·'}</button>
        <button aria-label="Close cockpit" onClick={onClose}
          style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: fs(11.5), fontWeight: 600, color: 'var(--sb)', background: 'transparent', border: '1px solid var(--gbd)', borderRadius: 10, padding: '4px 10px' }}>✕</button>
      </div>
    </div>)

  const pfdCard = (
    <div style={{ ...card, borderRadius: cfg.tabs ? '0 18px 18px 18px' : 18, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: fs(12.5), fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--acc)' }}>PFD — primary flight display</span>
        <Info fs={fs} big tip="speed = momentum · attitude = P&L · altitude = price · VSI = R/hour · heading = trend" />
      </div>
      <div className="tc-pfd-grid" style={{ display: 'grid', gridTemplateColumns: cfg.pfdCols, gap: cfg.pfdGap, overflow: 'hidden', alignItems: 'stretch', height: cfg.pfdH }}>
        <div style={pane}>
          <div style={{ position: 'absolute', top: 2, left: 0, right: 0, textAlign: 'center', background: 'var(--gls)', zIndex: 1 }}><span style={{ fontSize: fs(8.5), fontWeight: 600, color: 'var(--mu)' }}>SPD pips/min</span></div>
          {v ? v.spdTicks.map((s, i) => (
            <div key={i} style={{ position: 'absolute', left: 0, right: 0, top: s.top + '%', display: 'flex', alignItems: 'center', gap: 4, padding: '0 5px', transform: 'translateY(-50%)' }}><span style={{ width: 8, height: 1, background: 'var(--mu)' }} /><span style={{ fontSize: fs(10.5), fontWeight: 600, color: dim || 'var(--sb)', fontVariantNumeric: 'tabular-nums' }}>{s.v}</span></div>
          )) : skeleton(120)}
          <div id="pfd-spd" style={{ position: 'absolute', left: 2, right: 2, top: '50%', transform: 'translateY(-50%)', background: 'var(--gls)', border: `1.5px solid ${v?.spdCol ?? 'var(--edg)'}`, borderRadius: 6, textAlign: 'center', fontSize: fs(10.5), fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: dim || v?.spdCol, padding: '3px 0' }}>{v?.spd ?? ''}</div>
        </div>
        <div style={{ position: 'relative', minWidth: 0 }}>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', borderRadius: 12, border: '1px solid var(--edg)', background: 'var(--acs)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 7px 1px' }}><Chip fs={fs} hue="vio">PRICE · 15m</Chip><Info fs={fs} tip="Last 30 bars with session VWAP (amber) and the TP/SL/entry rails — the direct read, no metaphor." /></div>
            <svg viewBox="0 0 200 150" preserveAspectRatio="none" style={{ flex: 1, width: '100%' }}>
              {v && <>
                <line x1="0" y1={v.mcTp} x2="200" y2={v.mcTp} stroke="var(--up)" strokeWidth=".7" />
                <line x1="0" y1={v.mcEn} x2="200" y2={v.mcEn} stroke="var(--wrn)" strokeWidth=".7" strokeDasharray="3 2" />
                <line x1="0" y1={v.mcSl} x2="200" y2={v.mcSl} stroke="var(--dn)" strokeWidth=".7" />
                <path d={v.mcVwap} fill="none" stroke="var(--wrn)" strokeWidth="1" strokeDasharray="4 2" />
                {v.candles.map((c, i) => (
                  <g key={i}><title>{c.tip}</title>
                    <line x1={c.x} y1={c.hi} x2={c.x} y2={c.lo} stroke={c.col} strokeWidth=".8" />
                    <rect x={c.bx} y={c.by} width="3.4" height={c.bh} fill={c.col} /></g>))}
              </>}
              {!v && <line x1="0" y1="75" x2="200" y2="75" stroke="var(--edg)" strokeWidth="2" />}
            </svg>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 8px 5px', fontSize: fs(10.5), fontVariantNumeric: 'tabular-nums' }}><span style={{ color: 'var(--up)' }}>TP {v?.tpPx ?? '—'}</span><span style={{ color: 'var(--wrn)' }}>ENT {v?.enPx ?? '—'}</span><span style={{ color: 'var(--dn)' }}>SL {v?.slPx ?? '—'}</span><span style={{ marginLeft: 'auto', color: 'var(--wrn)' }}>VWAP {v?.vwapPrice ?? '—'}</span></div>
          </div>
        </div>
        <div style={{ ...pane, display: 'flex', flexDirection: 'column' }}>
          <span title="Volume Profile: how much trading happened at each price. Amber = POC (most-traded price, widest bar). Violet band = Value Area (70% of volume). Grey = low-volume price (LVN) — price tends to move fast through these." style={{ cursor: 'help', fontSize: fs(8.5), fontWeight: 600, color: 'var(--mu)', textAlign: 'center', paddingTop: 2, borderBottom: '1px solid var(--edg)', paddingBottom: 2 }}>VOL ⓘ</span>
          <div style={{ flex: 1, position: 'relative' }}>
            {v && <>
              <div style={{ position: 'absolute', left: 0, right: 0, top: v.vaTop + '%', height: v.vaH + '%', background: 'linear-gradient(90deg,rgba(168,85,247,.16),transparent)' }} />
              {v.vpBars.map((b, i) => (
                <div key={i} className="vp-bar" title={b.tip} data-w={b.w} style={{ position: 'absolute', left: 0, top: b.top + '%', height: b.h + '%', minWidth: 2, background: `linear-gradient(90deg,${b.col},transparent)`, boxShadow: b.gl }} />))}
              <div style={{ position: 'absolute', right: 1, top: v.pocTop + '%', transform: 'translateY(-50%)', fontSize: 7, fontWeight: 600, color: 'var(--wrn)', letterSpacing: '.06em' }}>POC</div>
            </>}
            {!v && skeleton(100)}
          </div>
          <span style={{ fontSize: 7, fontWeight: 600, color: 'var(--mu)', textAlign: 'center', paddingBottom: 2 }}>volume →</span>
        </div>
        <div style={pane}>
          <div style={{ position: 'absolute', top: 2, left: 0, right: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, background: 'var(--gls)', zIndex: 2 }}><span style={{ fontSize: fs(8.5), fontWeight: 600, color: 'var(--acc)' }}>PRICE · R</span><span title="One column, both scales: price on the left, the same level in R (risk units) on the right. Blue/red ticks are the best (MFE) and worst (MAE) excursion this trade has reached." style={{ cursor: 'help', fontSize: fs(8.5), color: 'var(--mu)' }}>ⓘ</span></div>
          {v && <>
            <div title="best excursion so far (MFE)" style={{ position: 'absolute', right: 0, width: 9, top: v.altMfe + '%', height: 2, background: 'var(--up)', zIndex: 2 }} />
            <div title="worst excursion so far (MAE)" style={{ position: 'absolute', right: 0, width: 9, top: v.altMae + '%', height: 2, background: 'var(--dn)', zIndex: 2 }} />
            <div title={`best ${v.mfeR} · worst ${v.maeR} · handed back ▼${v.giveback} from the peak`} style={{ position: 'absolute', left: 2, right: 2, bottom: 2, display: 'flex', gap: 3, justifyContent: 'space-between', fontSize: fs(8.5), fontVariantNumeric: 'tabular-nums', zIndex: 2, background: 'var(--gls)', cursor: 'help' }}><span style={{ color: 'var(--up)' }}>{v.mfeR}</span><span style={{ color: 'var(--dn)' }}>{v.maeR}</span></div>
            {v.altTicks.map((s, i) => (
              <div key={i} style={{ position: 'absolute', left: 0, right: 0, top: s.top + '%', display: 'flex', alignItems: 'center', gap: 3, padding: '0 4px', transform: 'translateY(-50%)' }}><span style={{ width: 6, height: 1, background: 'var(--mu)' }} /><span style={{ fontSize: fs(10.5), color: dim || 'var(--sb)', fontVariantNumeric: 'tabular-nums' }}>{s.v}</span><span style={{ marginLeft: 'auto', fontSize: fs(8.5), color: 'var(--mu)', fontVariantNumeric: 'tabular-nums' }}>{s.r}</span></div>))}
            <div id="alt-tp" style={{ position: 'absolute', right: 0, left: 4, top: '0%', transform: 'translateY(-50%)', fontSize: fs(10.5), fontWeight: 600, color: 'var(--up)', borderTop: v.tpBrd, textAlign: 'right', whiteSpace: 'nowrap', zIndex: 2 }}><span style={{ background: 'var(--gls)', borderRadius: 4, padding: '1px 4px' }}>{v.tpLb}</span></div>
            <div id="alt-en" style={{ position: 'absolute', right: 0, left: 4, top: '0%', transform: 'translateY(-50%)', fontSize: fs(10.5), fontWeight: 600, color: 'var(--wrn)', borderTop: v.enBrd, textAlign: 'right', whiteSpace: 'nowrap', zIndex: 2 }}><span style={{ background: 'var(--gls)', borderRadius: 4, padding: '1px 4px' }}>{v.enLb}</span></div>
            <div id="alt-sl" style={{ position: 'absolute', right: 0, left: 4, top: '0%', transform: 'translateY(-50%)', fontSize: fs(10.5), fontWeight: 600, color: 'var(--dn)', borderTop: v.slBrd, textAlign: 'right', whiteSpace: 'nowrap', zIndex: 2 }}><span style={{ background: 'var(--gls)', borderRadius: 4, padding: '1px 4px' }}>{v.slLb}</span></div>
            <div style={{ position: 'absolute', left: 2, right: 2, top: '50%', transform: 'translateY(-50%)', background: 'var(--gls)', border: '1.5px solid var(--tx)', borderRadius: 6, textAlign: 'center', fontSize: fs(10.5), fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: dim || undefined, padding: '3px 0' }}>{v.price}</div>
          </>}
          {!v && skeleton(150)}
        </div>
        <div style={{ ...pane, background: undefined, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 2px' }}>
          <span style={{ fontSize: fs(10.5), fontWeight: 600, color: 'var(--mu)', paddingTop: 4 }}>VSI</span>
          <div style={{ flex: 1, position: 'relative', width: '100%' }}>
            <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 1, background: 'var(--edg)' }} />
            <span style={{ position: 'absolute', top: '6%', left: 0, right: 0, textAlign: 'center', fontSize: fs(10.5), color: 'var(--sb)' }}>+2</span>
            <span style={{ position: 'absolute', bottom: '6%', left: 0, right: 0, textAlign: 'center', fontSize: fs(10.5), color: 'var(--sb)' }}>−2</span>
            <div id="pfd-vsi" style={{ position: 'absolute', left: 4, right: 4, top: '50%', height: 3, borderRadius: 2, background: v?.vsiCol ?? 'var(--edg)', transformOrigin: 'left center' }} />
          </div>
          <span style={{ fontSize: fs(10.5), fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: dim || v?.vsiCol, paddingBottom: 2, whiteSpace: 'nowrap' }}>{v?.vsi ?? ''}</span>
          <span style={{ fontSize: fs(8.5), color: 'var(--mu)', paddingBottom: 4, whiteSpace: 'nowrap' }}>R/hr</span>
        </div>
      </div>
      <div style={{ position: 'relative', height: 44, borderRadius: 10, border: '1px solid var(--edg)', background: 'var(--acs)', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 6, top: 3, fontSize: fs(10.5), fontWeight: 600, color: 'var(--mu)' }}>HDG · trend bearing (multi-TF consensus)</div>
        <div id="pfd-hdg" style={{ position: 'absolute', left: 0, right: 0, top: 16, height: 26 }}>
          {v?.hdgTicks.map((h, i) => (
            <div key={i} style={{ position: 'absolute', top: 0, left: h.left + '%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}><span style={{ width: 1, height: 7, background: 'var(--mu)' }} /><span style={{ fontSize: fs(10.5), fontWeight: 600, color: h.col }}>{h.v}</span></div>))}
        </div>
        <div style={{ position: 'absolute', left: '50%', top: 12, transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: '8px solid var(--tx)' }} />
        <div id="pfd-hdg-ro" style={{ position: 'absolute', right: 6, top: 3, fontSize: fs(10.5), fontWeight: 600, color: v?.hdgCol }}>{v?.hdg ?? ''}</div>
      </div>
    </div>)

  const mfdCard = (
    <div style={{ ...card, borderRadius: cfg.tabs ? '0 18px 18px 18px' : 18, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: fs(12.5), fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--vio)', whiteSpace: 'nowrap' }}>MFD — nav</span>
        <Info fs={fs} big tip="Moving map (nav): your flown price path, planned path to TP, and support/resistance as terrain. TCAS traffic: nearby aircraft = correlated symbols — heading shows if they're trending with or against you." />
        <span title="EMA 9 (teal solid) · EMA 20 (violet dashed) · EMA 50 (grey dotted) · VWAP (amber dash)" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7, fontSize: fs(10.5), fontWeight: 600, whiteSpace: 'nowrap', cursor: 'help' }}><span style={{ color: '#14b8a6' }}>━9</span><span style={{ color: '#a855f7' }}>┅20</span><span style={{ color: '#8b8578' }}>┈50</span><span style={{ color: 'var(--wrn)' }}>╌VWAP</span></span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 5 }}>
        {(v?.legs ?? [1, 2, 3].map(() => null)).map((l, i) => l ? (
          <div key={i} style={{ border: `1px solid ${l.bd}`, borderRadius: 6, padding: '2px 7px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: fs(9.5), color: l.col, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.k} · {l.v}</span>
            <span title={l.s} style={{ fontSize: fs(9.5), color: 'var(--mu)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.s}</span>
          </div>) : <div key={i} style={{ border: '1px solid var(--edg)', borderRadius: 6, padding: '2px 7px', height: 26 }}>{skeleton()}</div>)}
      </div>
      <div className="tc-mfd-wrap" style={{ position: 'relative', paddingTop: 34, paddingBottom: 4 }}>
        <svg viewBox="0 0 460 208" style={{ width: '100%', overflow: 'visible', display: 'block' }}>
          <defs><filter id="glo" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
          <line x1="28" y1="16" x2="28" y2="210" stroke="var(--sb)" strokeWidth="1" />
          <line x1="28" y1="210" x2="452" y2="210" stroke="var(--sb)" strokeWidth="1" />
          <line x1="28" y1="178" x2="452" y2="178" stroke="var(--sb)" strokeWidth="1" opacity=".45" />
          {v && <>
            {v.volBars.map((b, i) => <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={b.col} opacity=".8"><title>{b.tip}</title></rect>)}
            {v.yMinor.map((y, i) => <line key={i} x1="28" y1={y.y} x2="452" y2={y.y} stroke="var(--mu)" strokeWidth=".5" opacity=".3" />)}
            {v.xMinor.map((x, i) => <line key={i} x1={x.x} y1="16" x2={x.x} y2="210" stroke="var(--mu)" strokeWidth=".5" opacity=".3" />)}
            {v.xLabels.map((x, i) => <line key={i} x1={x.x} y1="16" x2={x.x} y2="214" stroke="var(--sb)" strokeWidth="1" opacity=".4" />)}
            {v.yAxis.map((y, i) => <g key={i}><line x1="24" y1={y.y} x2="28" y2={y.y} stroke="var(--sb)" strokeWidth="1" /><line x1="28" y1={y.y} x2="452" y2={y.y} stroke="var(--sb)" strokeWidth="1" opacity=".45" /></g>)}
            <rect x="28" y="158" width="424" height="2" fill="var(--dn)" opacity=".55" />
            <rect x="28" y="160" width="424" height="18" fill="rgba(255,77,109,.08)" />
            <rect x="28" y="30" width="424" height="2" fill="var(--acc)" opacity=".55" />
            <rect x="28" y="16" width="424" height="14" fill="rgba(79,140,255,.07)" />
            <ellipse id="wx1" cx="336" cy="132" rx="26" ry="15" fill="rgba(255,196,102,.16)" />
            <ellipse id="wx2" cx="344" cy="132" rx="11" ry="7" fill="rgba(255,77,109,.28)" />
            <line x1="336" y1="147" x2="336" y2="152" stroke="var(--wrn)" strokeWidth=".75" opacity=".6" />
            <path d={v.ema50Path} fill="none" stroke="#8b8578" strokeWidth="1.2" strokeDasharray="1 3" />
            <path d={v.ema20Path} fill="none" stroke="#a855f7" strokeWidth="1.2" strokeDasharray="7 3" />
            <path d={v.ema9Path} fill="none" stroke="#14b8a6" strokeWidth="1.4" />
            <path id="mfd-vwap" d={v.vwapPath} fill="none" stroke="var(--wrn)" strokeWidth="1.8" strokeDasharray="5 3" filter="url(#glo)" />
            <path id="mfd-flown" d={v.flownPath} fill="none" stroke="var(--acc)" strokeWidth="2" strokeLinejoin="round" filter="url(#glo)" />
            {!review && <path id="mfd-plan" d={v.planPath} fill="none" stroke="var(--sb)" strokeWidth="2" strokeDasharray="6 5" />}
            {v.xAxis.map((x, i) => <g key={i}><line x1={x.x} y1="210" x2={x.x} y2="214" stroke="var(--sb)" strokeWidth="1" /></g>)}
            {v.tweaks.map(tw => (
              <g key={tw.key} className="tw-mark" data-key={tw.key} style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHi(tw.key, true)} onMouseLeave={() => setHi(null, false)}>
                <title>{tw.tip}</title>
                <path d={`M${tw.x},${tw.y} m0,-7 l7,7 l-7,7 l-7,-7 z`} fill={tw.col} stroke="var(--gls)" strokeWidth="1" /></g>))}
            <circle cx="30" cy="150" r="4" fill="var(--wrn)" filter="url(#glo)" />
            <circle cx="290" cy="88" r="4" fill="none" stroke="var(--sb)" strokeWidth="1.2" />
            <line x1="290" y1="92" x2="290" y2="112" stroke="var(--sb)" strokeWidth=".75" opacity=".5" />
            <circle cx="420" cy="52" r="5" fill="var(--up)" filter="url(#glo)" />
            {v.traffic.map((tr, i) => (
              <g key={i} className="mfd-tfc" style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
                <g transform={`translate(${tr.x},${tr.y})`}>
                  <path d="M0,-5 L4,4 L0,1.8 L-4,4 Z" fill={tr.col} transform={`rotate(${tr.rot})`} opacity=".9" />
                  {!review && <line x1="0" y1="0" x2={tr.vx} y2={tr.vy} stroke={tr.col} strokeWidth="1" strokeDasharray="2 2" opacity=".7" />}
                </g></g>))}
            <g id="mfd-ac" style={{ transformBox: 'fill-box', transformOrigin: 'center' }}><path d="M190,104 L196,116 L190,112.5 L184,116 Z" fill="var(--tx)" /></g>
          </>}
        </svg>
        <div style={{ position: 'absolute', top: 34, left: 0, right: 0, bottom: 4, pointerEvents: 'none' }}>
          <span style={{ position: 'absolute', left: 0, top: -25, width: 26, textAlign: 'right', fontSize: 6, fontWeight: 600, letterSpacing: '.08em', color: 'var(--mu)' }}>{v?.ccy ?? ''}</span>
          {v?.yAxis.map((y, i) => <span key={i} className="tc-ylab" style={{ position: 'absolute', left: 0, top: y.pc + '%', transform: 'translateY(-50%)', width: 26, textAlign: 'right', fontSize: fs(8.5), color: 'var(--sb)', fontVariantNumeric: 'tabular-nums' }}>{y.v}</span>)}
          {v?.xLabels.map((x, i) => <span key={i} style={{ position: 'absolute', left: x.pc + '%', top: -12, transform: 'translateX(-50%)', fontSize: fs(8), color: 'var(--sb)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{x.v}</span>)}
          <div style={{ position: 'absolute', left: 0, right: 0, top: -16, height: 4 }}>
            {v?.resBands.map((b, i) => <span key={i} title="chart resolution in this span" style={{ position: 'absolute', left: b.lpc + '%', width: b.wpc + '%', height: 3, borderLeft: `1px solid ${b.c}`, borderTop: `1px solid ${b.c}`, borderRight: `1px solid ${b.c}`, display: 'block' }} />)}
            {/* bands are contiguous — inset each label box 1px per side so adjacent
                boxes can never touch (the §8 zero-overlap check measures boxes) */}
            {v?.resBands.map((b, i) => <span key={'l' + i} style={{ position: 'absolute', left: `calc(${b.lpc}% + 1px)`, width: `calc(${b.wpc}% - 2px)`, top: -13, textAlign: 'center', fontSize: fs(8), color: b.c, whiteSpace: 'nowrap', overflow: 'hidden' }}>{b.lb}</span>)}
          </div>
          {/* Chart captions — BUILD-ORDER §3 pins these at 7.5px on every device.
              (Conflict, reported: the reference draws them at 8.5px; §3 wins.) */}
          <span style={{ position: 'absolute', right: '1.5%', top: '13.5%', transform: 'translateY(-50%)', fontSize: 7.5, fontWeight: 600, letterSpacing: '.6px', color: 'var(--acc)', whiteSpace: 'nowrap' }}>RESISTANCE · TERRAIN</span>
          <span style={{ position: 'absolute', right: '1.5%', top: '83.2%', transform: 'translateY(-50%)', fontSize: 7.5, fontWeight: 600, letterSpacing: '.6px', color: 'var(--dn)', whiteSpace: 'nowrap' }}>SUPPORT · TERRAIN</span>
          <span style={{ position: 'absolute', left: '8.7%', top: '74%', transform: 'translateY(-50%)', fontSize: 7.5, fontWeight: 600, letterSpacing: '.6px', color: 'var(--wrn)', whiteSpace: 'nowrap' }}>ENTRY</span>
          <span style={{ position: 'absolute', left: '63%', top: '58.6%', transform: 'translate(-50%,-50%)', fontSize: 7.5, fontWeight: 600, letterSpacing: '.4px', color: 'var(--sb)', whiteSpace: 'nowrap' }}>WPT · SCALE-OUT</span>
          <span style={{ position: 'absolute', left: '91.3%', top: '32%', transform: 'translate(-50%,-50%)', fontSize: 7.5, fontWeight: 600, letterSpacing: '.6px', color: 'var(--up)', whiteSpace: 'nowrap' }}>TP</span>
          <span style={{ position: 'absolute', left: '73%', top: '73.5%', transform: 'translate(-50%,-50%)', fontSize: 7.5, fontWeight: 600, letterSpacing: '.4px', color: 'var(--wrn)', whiteSpace: 'nowrap' }}>WX · HK CPI 14:30</span>
          {v?.tweaks.map(tw => <span key={tw.key} className="tw-key" data-key={tw.key} title={tw.tip} style={{ position: 'absolute', left: tw.lpc + '%', top: tw.tpc + '%', transform: 'translate(-50%,-50%)', fontSize: 5, fontWeight: 600, color: 'var(--bg)', pointerEvents: 'auto', cursor: 'pointer', lineHeight: 1 }}
            onMouseEnter={() => setHi(tw.key, true)} onMouseLeave={() => setHi(null, false)}>{tw.key}</span>)}
          {v?.traffic.map((tr, i) => <span key={i} className="tc-tfc-label" style={{ position: 'absolute', left: tr.lpc + '%', top: tr.tpc + '%', transform: `translate(${tr.dx},${tr.dy})`, fontSize: fs(8.5), color: tr.col, background: 'var(--gls)', borderRadius: 2, padding: cfg.touch ? '14px 2px' : '0 2px', whiteSpace: 'nowrap', pointerEvents: 'auto' }}>{tr.sym}</span>)}
          {v && !v.traffic.length && <span style={{ position: 'absolute', left: '40%', top: '40%', fontSize: 9, color: 'var(--mu)' }}>no traffic</span>}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid var(--edg)', borderRadius: 8, padding: '6px 9px', background: 'var(--acs)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><Chip fs={fs} hue="vio">MARKET SAYS</Chip><span style={{ marginLeft: 'auto', fontSize: fs(10), whiteSpace: 'nowrap' }}><span style={{ color: 'var(--up)' }}>▲ same heading {v?.nSame ?? '—'}</span> · <span style={{ color: 'var(--dn)' }}>▼ diverging {v?.nDiv ?? '—'}</span></span></div>
        <MarketSays fs={fs} clamp={variant !== 'desktop'} text={v?.mktRead ?? ''} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: cfg.bullets, gap: '3px 14px' }}>
        {(v?.engines ?? []).map((e, i) => (
          <div key={i} className="tc-bullet" title={e.tip} style={{ display: 'grid', gridTemplateColumns: '64px 1fr 44px', gap: 6, alignItems: 'center', fontVariantNumeric: 'tabular-nums', cursor: 'help' }}>
            <span style={{ fontSize: fs(10.5), color: 'var(--mu)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.k}</span>
            <div style={{ position: 'relative', height: 9, background: 'var(--edg)', borderRadius: 2 }}>
              <div title="typical range" style={{ position: 'absolute', top: 0, bottom: 0, left: e.normL + '%', width: e.normW + '%', background: 'rgba(154,168,204,.34)' }} />
              <div className="bul-bar" data-w={e.pct} style={{ position: 'absolute', top: 2, bottom: 2, left: 0, width: e.pct + '%', background: e.col, borderRadius: 1 }} />
              <div title={`threshold — ${e.thLb}`} style={{ position: 'absolute', top: -2, bottom: -2, left: e.thPct + '%', width: 2, background: e.thCol }} />
            </div>
            <span style={{ fontSize: fs(10.5), color: e.col, textAlign: 'right' }}>{e.v}{e.unit}</span>
          </div>))}
      </div>
    </div>)

  // Owner (2026-07-31): every info panel gets a collapse triangle so a section
  // you are not reading right now costs one header row, not its whole body —
  // "use triangle (collapse/expand) within row" — while texture/colours/fonts
  // stay exactly as they were. State is per section key; all open by default.
  const [shut, setShut] = useState({})
  const flip = k => setShut(s => ({ ...s, [k]: !s[k] }))
  const sectHead = ({ k, hue, label, tip, right }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <button type="button" aria-label={`${shut[k] ? 'Expand' : 'Collapse'} ${label}`} aria-expanded={!shut[k]} onClick={() => flip(k)}
        style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: fs(8.5), color: 'var(--mu)', background: 'transparent', border: 'none', padding: '0 1px', transform: shut[k] ? 'none' : 'rotate(90deg)', transition: 'transform .15s' }}>▸</button>
      <Chip fs={fs} hue={hue}>{label}</Chip>
      <Info fs={fs} tip={tip} />
      {right}
    </div>)

  // (2a) The Tweak Journal is its OWN card now, sized to the PFD column — it
  // used to span the full shell at 3fr with four narrow columns of content,
  // which is exactly the "takes the whole length but so little space needed"
  // the owner called out. On desktop it rides UNDER the PFD, filling the dead
  // space beside the taller MFD column.
  const journalCard = (
    <div style={{ ...card, borderRadius: 12, padding: '4px 10px 5px', display: 'flex', flexDirection: 'column', minWidth: 0, ...(variant === 'desktop' ? { flex: '1 1 auto', minHeight: 0 } : {}) }}>
      {sectHead({ k: "jr", hue: "vio", label: "TWEAK JOURNAL", tip: "Every manual or trailing-rule adjustment made to this trade since entry, in order." })}
      {!shut.jr && (
        <div style={{ flex: 1, minHeight: 0, maxHeight: variant === 'iphone' ? 210 : variant === 'desktop' ? undefined : 150, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', scrollbarWidth: 'thin' }}>
          {(v?.journal ?? []).map(j => {
            const open = openKeys.includes(j.key)
            return (
              <div key={j.key} className="tw-row" data-key={j.key} title={`${j.when} — ${j.k} · ${j.d} · click to expand`} role="button" tabIndex={0}
                onClick={() => setOpenKeys(ks => ks.includes(j.key) ? ks.filter(x => x !== j.key) : ks.concat(j.key))}
                onKeyDown={e => { if (e.key === 'Enter') setOpenKeys(ks => ks.includes(j.key) ? ks.filter(x => x !== j.key) : ks.concat(j.key)) }}
                onMouseEnter={() => setHi(j.key, true)} onMouseLeave={() => setHi(null, false)}
                style={{ display: 'grid', gridTemplateColumns: '9px 34px 12px 1fr', gap: '0 5px', alignItems: 'center', fontVariantNumeric: 'tabular-nums', lineHeight: 1.4, cursor: 'pointer', borderRadius: 3, padding: cfg.touch ? '7px 2px' : '1px 2px', minHeight: open ? 'auto' : (cfg.touch ? 44 : 24), borderBottom: '1px solid var(--edg)' }}>
                <span style={{ fontSize: fs(8.5), color: 'var(--mu)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
                <span style={{ fontSize: fs(10), color: 'var(--sb)', whiteSpace: 'nowrap' }}>{j.hm}</span>
                <span style={{ fontSize: fs(8.5), fontWeight: 600, color: j.col, textAlign: 'center', border: `1px solid ${j.col}`, borderRadius: 2, lineHeight: 1.3 }}>{j.key}</span>
                <span style={{ fontSize: fs(10.5), color: j.col, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.k}</span>
                <div style={{ gridColumn: '2/5', display: open ? 'grid' : 'none', gridTemplateColumns: 'repeat(4,max-content)', justifyContent: 'start', gap: '1px 8px', padding: '2px 0 4px' }}>
                  <span style={{ gridColumn: '1/5', fontSize: fs(9), color: 'var(--mu)', whiteSpace: 'nowrap' }}>{j.day} {j.hm}</span>
                  <span style={{ gridColumn: '1/5', fontSize: fs(10.5), color: 'var(--tx)', lineHeight: 1.35 }}>{j.d}</span>
                  <span style={{ gridColumn: '1/5', fontSize: fs(9), fontWeight: 600, letterSpacing: '.05em', color: 'var(--mu)', paddingTop: 1 }}>BAR AT TWEAK · 15m</span>
                  <span style={{ fontSize: fs(9), color: 'var(--mu)' }}>O <span style={{ color: 'var(--sb)' }}>{j.o}</span></span>
                  <span style={{ fontSize: fs(9), color: 'var(--mu)' }}>H <span style={{ color: 'var(--sb)' }}>{j.h}</span></span>
                  <span style={{ fontSize: fs(9), color: 'var(--mu)' }}>L <span style={{ color: 'var(--sb)' }}>{j.l}</span></span>
                  <span style={{ fontSize: fs(9), color: 'var(--mu)' }}>C <span style={{ color: j.ohlcCol }}>{j.c}</span></span>
                  <span style={{ gridColumn: '1/5', fontSize: fs(9), color: 'var(--mu)' }}>{j.rng} · {j.rAt}</span>
                </div>
              </div>)
          })}
          {v && !v.journal.length && <span style={{ fontSize: 9, color: 'var(--mu)' }}>no tweaks yet</span>}
        </div>)}
    </div>)

  const riskCard = (
    <div style={{ ...card, borderRadius: 12, padding: '4px 10px 5px', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      {sectHead({ k: "rb", hue: "wrn", label: `RISK BUDGET${review ? ' · at close' : ''}`, tip: "Cockpit fuel gauge: how much of today's loss-cap is left. Empty = bot closes everything and disarms for the day." })}
      {!shut.rb && <>
        <div style={{ height: 10, borderRadius: 5, background: 'var(--edg)', overflow: 'hidden' }}><div id="ei-fuel" style={{ height: 10, width: '100%', background: 'linear-gradient(90deg,var(--dn),var(--wrn),var(--acc))', borderRadius: 5 }} /></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '0 6px', fontSize: fs(10.5), fontVariantNumeric: 'tabular-nums', lineHeight: 1.45 }}>
          <span style={{ color: 'var(--mu)' }}>Lot size</span><span style={{ color: 'var(--tx)' }}>{v?.lots} · {v?.shares} sh</span>
          <span style={{ color: 'var(--mu)' }}>Notional</span><span style={{ color: 'var(--sb)' }}>{v?.notionalL} · {v?.notionalU}</span>
          <span title="initial margin posted for this position, and the resulting leverage" style={{ cursor: 'help', color: 'var(--mu)' }}>Margin used</span><span style={{ color: 'var(--wrn)' }}>{v?.marginU} · {v?.lev}</span>
          <span style={{ color: 'var(--mu)', whiteSpace: 'nowrap' }}>Margin/equity</span><span style={{ color: v?.margCol }}>{v?.margPct}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1px 5px', fontSize: fs(10.5), fontVariantNumeric: 'tabular-nums', lineHeight: 1.4, borderTop: '1px solid var(--edg)', paddingTop: 3 }}>
          <span style={{ fontSize: fs(8.5), fontWeight: 600, letterSpacing: '.05em', color: 'var(--dn)' }}>IF SL HIT</span>
          <span style={{ fontSize: fs(8.5), fontWeight: 600, letterSpacing: '.05em', color: 'var(--sb)', textAlign: 'center' }}>NOW</span>
          <span style={{ fontSize: fs(8.5), fontWeight: 600, letterSpacing: '.05em', color: 'var(--up)', textAlign: 'right' }}>IF TP HIT</span>
          <span style={{ color: 'var(--dn)' }}>{v?.slUsd}</span><span style={{ color: dim || v?.rCol, textAlign: 'center' }}>{v?.pnl}</span><span style={{ color: 'var(--up)', textAlign: 'right' }}>{v?.tpUsd}</span>
          <span style={{ color: 'var(--mu)' }}>−1.00R</span><span style={{ color: 'var(--mu)', textAlign: 'center' }}>{v?.rNow}</span><span style={{ color: 'var(--mu)', textAlign: 'right' }}>{v?.tpR}</span>
          <span title="share of account balance" style={{ cursor: 'help', color: 'var(--mu)' }}>{v?.slPctBal}</span><span style={{ color: 'var(--mu)', textAlign: 'center' }}>of balance</span><span style={{ color: 'var(--mu)', textAlign: 'right' }}>{v?.tpPctBal}</span>
        </div>
        <span style={{ fontSize: fs(8.5), color: 'var(--mu)', lineHeight: 1.3 }}>{v?.rrNote}</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '0 6px', fontSize: fs(10.5), fontVariantNumeric: 'tabular-nums', lineHeight: 1.45 }}>
          <span style={{ color: 'var(--mu)' }}>Balance</span><span style={{ color: 'var(--tx)' }}>{v?.acctBal}</span>
          <span style={{ color: 'var(--mu)' }}>Equity (open P&L)</span><span style={{ color: dim || v?.rCol }}>{v?.acctEq}</span>
          <span style={{ color: 'var(--mu)' }}>Daily loss-cap</span><span style={{ color: 'var(--sb)' }}>{v?.capAbs}</span>
          <span style={{ color: 'var(--mu)' }}>Used today</span><span style={{ color: 'var(--dn)' }}>{v?.capUsed}</span>
          <span style={{ color: 'var(--mu)' }}>Remaining</span><span style={{ color: 'var(--acc)' }}>{v?.capLeft} · {v?.fuel}</span>
        </div>
      </>}
    </div>)

  // (2b) Each panel is its own collapsible card; advisory row text scrolls
  // sideways inside its own cell instead of forcing the panel wide.
  const advisoriesCard = (
    <div style={{ ...card, borderRadius: 12, padding: '4px 10px 5px', display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      {sectHead({ k: "adv", hue: "wrn", label: "ADVISORIES", tip: "Live bot notices: cautions, warnings, and fills — newest first." })}
      {!shut.adv && (
        <div style={{ maxHeight: variant === 'iphone' ? 150 : 96, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', scrollbarWidth: 'thin' }}>
            {tradeId != null && !position && <div style={{ display: 'grid', gridTemplateColumns: '40px 72px 1fr', gap: 6, alignItems: 'baseline', fontVariantNumeric: 'tabular-nums', lineHeight: 1.45 }}>
              <span style={{ fontSize: fs(10.5), color: 'var(--mu)' }}>now</span>
              <span style={{ fontSize: fs(10.5), color: 'var(--wrn)' }}>DEMO DATA</span>
              <span title={`no live position is bound to trade ${tradeId} in this tab — every number below is reference demo data. Open the cockpit from a trade row to see real values.`} style={{ fontSize: fs(10.5), color: 'var(--sb)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'help' }}>no live position bound — all values are demo</span></div>}
            {feedBlocked && !loaded && <div style={{ display: 'grid', gridTemplateColumns: '40px 72px 1fr', gap: 6, alignItems: 'baseline', fontVariantNumeric: 'tabular-nums', lineHeight: 1.45 }}>
              <span style={{ fontSize: fs(10.5), color: 'var(--mu)' }}>now</span>
              <span style={{ fontSize: fs(10.5), color: 'var(--wrn)' }}>CAUTION</span>
              <span style={{ fontSize: fs(10.5), color: 'var(--sb)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>cockpit feed unavailable — retrying ({retries})</span></div>}
            {(v?.alerts ?? []).map((a, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '40px 72px 1fr', gap: 6, alignItems: 'baseline', fontVariantNumeric: 'tabular-nums', lineHeight: 1.45 }}>
                <span style={{ fontSize: fs(10.5), color: 'var(--mu)' }}>{a.t}</span>
                <span style={{ fontSize: fs(10.5), color: a.col }}>{a.k}</span>
                {/* Long text scrolls INSIDE its own cell (owner: "scroll the
                    row text") — the panel never widens for one long line. */}
                <span title={a.d} style={{ fontSize: fs(10.5), color: 'var(--sb)', whiteSpace: 'nowrap', overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none' }}>{a.d}</span>
              </div>))}
            {v && !v.alerts.length && <span style={{ fontSize: 9, color: 'var(--mu)' }}>no advisories</span>}
        </div>)}
    </div>)

  const armedCard = (
    <div style={{ ...card, borderRadius: 12, padding: '4px 10px 5px', display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      {sectHead({ k: "aa", hue: "acc", label: review ? 'ACTIONS TAKEN' : 'ARMED ACTIONS', tip: "Autopilot: actions the bot will take on its own — no input needed unless you override in Manage." })}
      {!shut.aa && (v?.autopilot ?? []).map((a, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', minWidth: 0, lineHeight: 1.45, ...(cfg.touch ? { minHeight: 22 } : {}) }}>
          <span style={{ fontSize: fs(10.5), color: a.col, flex: 'none' }}>{a.k}</span>
          <span title={a.v} style={{ fontSize: fs(10.5), color: 'var(--tx)', flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none' }}>{a.v}</span>
          <div style={{ width: 40, height: 3, background: 'var(--edg)', borderRadius: 2, flex: 'none' }}><div style={{ width: a.prog + '%', height: 3, background: a.progCol, borderRadius: 2 }} /></div>
          <span style={{ fontSize: fs(10.5), color: marketClosed ? 'var(--mu)' : 'var(--sb)', flex: 'none' }}>{review ? 'fired · hit' : a.d}</span>
        </div>))}
    </div>)

  const invalidationCard = (
    <div style={{ ...card, borderRadius: 12, padding: '4px 10px 5px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      {sectHead({ k: "inv", hue: "vio", label: review ? 'WHAT ENDED IT' : 'INVALIDATION WATCH', tip: "Go-around: the conditions that would make the bot abort this trade's thesis and exit — like a pilot aborting a landing. All clear = the setup that got you in still holds.", right: <span style={{ marginLeft: 'auto', fontSize: fs(10.5), color: v?.gaCol, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v?.gaNote}</span> })}
      {!shut.inv && (
        <div style={{ display: 'grid', gridTemplateColumns: variant === 'desktop' ? '1fr' : cfg.inv, gap: '0 10px' }}>
          {(v?.goaround ?? []).map((g, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontVariantNumeric: 'tabular-nums', minWidth: 0, lineHeight: 1.45 }}>
              <span style={{ fontSize: fs(10.5), color: g.okCol, flex: 'none' }}>{g.mark}</span>
              <span style={{ fontSize: fs(10.5), color: 'var(--sb)', whiteSpace: 'nowrap', flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none' }}>{g.k}</span>
              <span style={{ fontSize: fs(10.5), color: g.okCol, flex: 'none' }}>{g.now}</span>
              <Info fs={fs} tip={g.f} />
            </div>))}
        </div>)}
    </div>)

  const fleetCard = (
    <div style={{ ...card, borderRadius: 16, padding: '4px 12px', display: 'flex', gap: 5, alignItems: 'center', ...(variant === 'desktop' ? { overflowX: 'auto', scrollbarWidth: 'thin' } : { flexWrap: 'wrap' }) }}>
      {sectHead({ k: "fl", hue: "mu", label: "FLEET", tip: "Your other open positions, each shown as R (profit/loss in risk units). Scale spans −2R…+2R with a tick every 0.5R; amber centre line = entry. Click to switch this cockpit to that symbol." })}
      <span style={{ fontSize: fs(9.5), color: v?.fleetIsReal ? 'var(--sb)' : 'var(--mu)', whiteSpace: 'nowrap' }}>{v?.fleetLabel ?? ''}</span>
      {!shut.fl && (v?.fleet ?? []).map((f, i) => (
          <div key={i} className="tc-fleet-chip" role="button" tabIndex={0} title={`${f.sym} · ${f.r}R — scale −2R … +2R, tick every 0.5R, amber = entry (0R). Click to switch cockpit (mock)`}
            style={{ cursor: 'pointer', flex: 'none', display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${f.bd}`, background: f.bg, borderRadius: 8, padding: cfg.touch ? '13px 9px' : '3px 9px', ...touchPad }}>
            <span style={{ fontSize: fs(10.5) }}>{f.sym}</span>
            <div style={{ position: 'relative', width: 56, height: 8, border: '1px solid var(--edg)', borderRadius: 2, background: 'repeating-linear-gradient(90deg,var(--edg) 0 1px,transparent 1px 14px)' }}>
              <div style={{ position: 'absolute', top: 1, bottom: 1, left: f.barL + '%', width: f.barW + '%', background: f.col }} />
              <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: 'var(--wrn)' }} />
            </div>
            <span style={{ fontSize: fs(10.5), fontVariantNumeric: 'tabular-nums', color: f.col }}>{f.r}R</span>
          </div>))}
    </div>)

  // (2b) Desktop: the five info panels sit in one balanced band — Risk Budget
  // (tall/narrow) | Armed Actions + Invalidation stacked | Advisories — with
  // Fleet as a slim strip below. No panel spans the shell for a handful of
  // rows any more. Touch variants keep the single-column stack their tab
  // layout expects.
  const strips = variant === 'desktop'
    ? <>
      <div style={{ display: 'grid', gridTemplateColumns: '0.95fr 1.15fr 1.1fr', gap: 5, alignItems: 'start' }}>
        {riskCard}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>{armedCard}{invalidationCard}</div>
        {advisoriesCard}
      </div>
      {fleetCard}
    </>
    : <>{riskCard}{advisoriesCard}{armedCard}{invalidationCard}{fleetCard}</>

  const tabBar = cfg.tabs && (
    <div style={{ display: 'flex', marginBottom: -1, zIndex: 2, position: 'relative' }}>
      {cfg.tabs.map(t => (
        <button key={t} onClick={() => setPane(t)}
          style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: fs(10.5), fontWeight: 600, letterSpacing: '.05em', color: pane2 === t ? 'var(--acc)' : 'var(--mu)', background: pane2 === t ? 'var(--gls)' : 'transparent', border: '1px solid var(--gbd)', borderBottom: pane2 === t ? '1px solid var(--gls)' : '1px solid var(--gbd)', borderRadius: '10px 10px 0 0', padding: '13px 0', flex: 1, textAlign: 'center', marginRight: -1, position: 'relative', zIndex: pane2 === t ? 1 : 0 }}>{t}</button>))}
    </div>)

  const rulers = (
    <>
      <div style={{ position: 'absolute', top: 0, left: 14, right: 0, height: 13, zIndex: 5, background: 'var(--gls)', borderBottom: '1px solid var(--edg)', backgroundImage: 'repeating-linear-gradient(90deg,var(--sb) 0 1px,transparent 1px 100px),repeating-linear-gradient(90deg,var(--mu) 0 1px,transparent 1px 10px)', backgroundSize: 'auto 13px,auto 5px', backgroundRepeat: 'repeat-x', backgroundPosition: '0 0,0 8px' }}>
        {Array.from({ length: 16 }, (_, i) => ({ px: (i + 1) * 100 - 14, v: (i + 1) * 100 })).map(r => (
          <span key={r.v} style={{ position: 'absolute', left: r.px, top: 0, fontSize: 8, color: 'var(--mu)', paddingLeft: 2, fontVariantNumeric: 'tabular-nums' }}>{r.v}</span>))}
        <div id="rul-x" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: 1, background: 'var(--acc)', opacity: 0 }} />
        <span id="rul-xv" style={{ position: 'absolute', top: 0, left: 0, fontSize: 8, fontWeight: 600, color: 'var(--bg)', background: 'var(--acc)', padding: '0 3px', borderRadius: '0 0 3px 0', fontVariantNumeric: 'tabular-nums', opacity: 0, whiteSpace: 'nowrap' }} />
      </div>
      <div style={{ position: 'absolute', top: 13, left: 0, bottom: 0, width: 14, zIndex: 5, background: 'var(--gls)', borderRight: '1px solid var(--edg)', backgroundImage: 'repeating-linear-gradient(180deg,var(--sb) 0 1px,transparent 1px 100px),repeating-linear-gradient(180deg,var(--mu) 0 1px,transparent 1px 10px)', backgroundSize: '14px auto,5px auto', backgroundRepeat: 'repeat-y', backgroundPosition: '0 0,9px 0' }}>
        {Array.from({ length: 10 }, (_, i) => ({ px: (i + 1) * 100 - 13, v: (i + 1) * 100 })).map(r => (
          <span key={r.v} style={{ position: 'absolute', top: r.px, left: 1, fontSize: 8, color: 'var(--mu)', fontVariantNumeric: 'tabular-nums', writingMode: 'vertical-lr' }}>{r.v}</span>))}
        <div id="rul-y" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 1, background: 'var(--acc)', opacity: 0 }} />
        <span id="rul-yv" style={{ position: 'absolute', left: 0, top: 0, fontSize: 8, fontWeight: 600, color: 'var(--bg)', background: 'var(--acc)', padding: '0 1px', borderRadius: '0 3px 3px 0', fontVariantNumeric: 'tabular-nums', writingMode: 'vertical-lr', opacity: 0 }} />
      </div>
    </>)

  // Owner (2026-07-26): "It should only expand when needed." The shell hugs its
  // content and grows to a cap instead of always claiming a fixed 80/92vh — on
  // a phone showing only the PFD tab that left most of the window empty black.
  // (This also dissolves finding F1: content can no longer overflow a fixed
  // height; the cap scrolls instead.)
  // The cap is a PERCENTAGE of the fixed-inset backdrop, not 92vh: this app
  // sets zoom:1.1 on <html>, and vh units ignore zoom, so a 92vh cap actually
  // rendered ~101% of the real viewport. Percentages resolve against the
  // backdrop's definite height and stay correct at any zoom.
  // Owner (2026-07-31): "i need window to be reduce by 15%" — 65vw → 55vw with
  // the min/max bounds shrunk to match; the panel band rework above is what
  // makes the content fit the smaller shell without squashing.
  const shellStyle = variant === 'desktop'
    ? { width: '55vw', height: 'auto', minWidth: 960, maxWidth: 1360, maxHeight: '92%' }
    : { width: cfg.shellW, maxWidth: '100vw', height: 'auto', maxHeight: '92%' }

  // Owner (2026-07-26): close buttons at the four corners plus one at the
  // centre of each side border, so the window can always be dismissed from
  // wherever the thumb happens to be. They sit ON the border, above the
  // rulers, and are touch-sized on handhelds.
  const CLOSE_SPOTS = [
    { k: 'tl', style: { top: 3, left: 3 }, label: 'top left' },
    { k: 'tr', style: { top: 3, right: 3 }, label: 'top right' },
    { k: 'bl', style: { bottom: 3, left: 3 }, label: 'bottom left' },
    { k: 'br', style: { bottom: 3, right: 3 }, label: 'bottom right' },
    { k: 'ml', style: { top: '50%', left: 3, transform: 'translateY(-50%)' }, label: 'left' },
    { k: 'mr', style: { top: '50%', right: 3, transform: 'translateY(-50%)' }, label: 'right' },
  ]
  const closeDot = cfg.touch ? 34 : 24
  const borderCloses = CLOSE_SPOTS.map(c => (
    <button key={c.k} type="button" aria-label={`Close cockpit (${c.label})`} title="Close"
      onClick={e => { e.stopPropagation(); onClose?.() }}
      style={{ position: 'absolute', ...c.style, zIndex: 9, width: closeDot, height: closeDot,
        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        fontFamily: 'inherit', fontSize: fs(11.5), lineHeight: 1, color: 'var(--sb)',
        background: 'var(--gls)', border: '1px solid var(--gbd)', borderRadius: '50%', padding: 0 }}>✕</button>
  ))

  // Touch variants keep the journal in the shared stack (the phone's LOG tab
  // is where it lives there); on desktop it moved up beside the PFD.
  const shared = <>{variant === 'desktop' ? null : journalCard}{strips}</>
  return (
    <div className="tc-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose?.() }}>
      <div ref={rootRef} tabIndex={-1} className="tc-root" data-theme={theme} role="dialog" aria-modal="true"
        style={{ ...shellStyle, ...card, borderRadius: 18, position: 'relative', overflow: 'hidden', outline: 'none', background: 'var(--bg)',
          display: 'flex', flexDirection: 'column',
          ...(phoneShrink ? { transform: 'scale(0.8)', transformOrigin: 'center center' } : {}) }}>
        {rulers}
        {borderCloses}
        <div className="tc-col" style={{ position: 'relative', zIndex: 1, boxSizing: 'border-box', flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: cfg.shellPad, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {header}
          {!cfg.tabs && (
            // (2a) The journal fills the dead space UNDER the PFD (the MFD
            // column is the taller of the two) at the PFD column's width.
            <div style={{ display: 'grid', gridTemplateColumns: cfg.grid, gap: 5, alignItems: 'stretch' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>{pfdCard}{journalCard}</div>
              {mfdCard}
            </div>)}
          {cfg.tabs && (
            <>
              {tabBar}
              {/* both panes stay mounted (display gating) so a session change or tab
                  switch never remounts — state survives, per the work order */}
              <div style={{ display: pane2 === 'PFD' ? 'flex' : 'none', flexDirection: 'column' }}>{pfdCard}</div>
              <div style={{ display: pane2 === 'MFD' ? 'flex' : 'none', flexDirection: 'column' }}>{mfdCard}</div>
            </>)}
          {(!cfg.tabs || cfg.tabs.length === 2 || pane2 === 'LOG') && shared}
        </div>
      </div>
    </div>)
}

function MarketSays({ fs, clamp: doClamp, text }) {
  const [more, setMore] = useState(false)
  return (
    <div>
      <span style={{ fontSize: fs(10), lineHeight: 1.35, color: 'var(--sb)', ...(doClamp && !more ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : {}) }}>{text}</span>
      {doClamp && <button onClick={() => setMore(m => !m)} style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: fs(10), fontWeight: 600, color: 'var(--acc)', background: 'transparent', border: 'none', padding: '13px 0 0', display: 'block' }}>{more ? '▴ LESS' : '▾ MORE'}</button>}
    </div>)
}
