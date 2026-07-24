// WorkflowAudit — exact port of design_claude/"Trade Workflow Audit.dc.html"
// (owner: open the .dc.html, copy its exact inline style values and logic —
// no guessing). Markup, px values, copy, node-state palette and the GSAP
// choreography are lifted 1:1 from the prototype; only the mock generator
// is replaced by real closed trades. Prototype tokens map to the app's
// (same design system): --acc→--color-accent · --up/--dn→--color-up/down ·
// --tx/--sb/--mu→--color-text/-sub/--color-muted · --wrn→--color-warning-
// text · --edg→--glass-edge · --dns→--color-error-bg · --vio→--color-
// special-text · --gl/--gbd/--gsh→--color-surface/--color-border/--glass-
// shadow. Collect-forward: durations never recorded render "—".
import { useEffect, useMemo, useRef, useState } from 'react'

const ACC = 'var(--color-accent)', UP = 'var(--color-up)', DN = 'var(--color-down)'
const TX = 'var(--color-text)', SB = 'var(--color-text-sub)', MU = 'var(--color-muted)'
const WRN = 'var(--color-warning-text)', EDG = 'var(--glass-edge)', DNS = 'var(--color-error-bg)'
const VIO = 'var(--color-special-text)', GL = 'var(--color-surface)', GBD = 'var(--color-border)'
const GSH = 'var(--glass-shadow)'

const glass = {
  background: GL, border: `1px solid ${GBD}`, borderRadius: 14, boxShadow: GSH,
  backdropFilter: 'blur(22px)',
}
const GRID_COLS = '100px 80px 88px 30px 38px 138px 60px minmax(185px,1fr) 68px'

const parseTs = (iso) => {
  if (!iso) return null
  const raw = String(iso).replace(' ', 'T')
  const t = Date.parse(raw.endsWith('Z') || raw.includes('+') ? raw : raw + 'Z')
  return Number.isFinite(t) ? t : null
}
// Prototype fmtD works in minutes; real data adds ms-scale entry latency
// and honest '—' for the never-recorded.
const fmtD = (ms) => {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.round(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}` : `${m}m`
}
const mUsd = (n) => (n < 0 ? '−' : '+') + '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })
const cCol = (n) => (n >= 0 ? UP : DN)

function closeOf(reason) {
  const r = String(reason || '').toLowerCase()
  if (/trail|break.?even|be moved/.test(r)) return 'Trail stop'
  const tp = /\btp\b|take.?profit|target|bank|partial|scale/.test(r)
  const sl = /\bsl\b|stop.?loss|stopped|stop hit/.test(r)
  if (tp && !sl) return 'TP hit'
  if (sl && !tp) return 'SL hit'
  return 'Manual'
}
const JUSTIFIED_RE = /time.?cap|invalidat|thesis|weekend|equity|risk|drawdown|news|correlat|session close|margin|circuit/

// Real closed trades → the prototype's trade shape. kind: tp | trail | sl |
// early-ok (justified circuit breaker) | early-bad (premature, no logged
// reasoning). Evidence-only: early-bad strictly means "manual close with no
// recorded rationale".
function shape(trades, pmByTrade) {
  return trades
    .filter(t => t.status === 'closed' && t.net_pnl != null)
    .map(t => {
      const openedMs = parseTs(t.opened_at), closedMs = parseTs(t.closed_at)
      const durMs = t.hold_duration_ms ?? (openedMs != null && closedMs != null ? closedMs - openedMs : null)
      const pm = pmByTrade[t.id]
      const close = closeOf(t.close_reason)
      let kind = close === 'TP hit' ? 'tp' : close === 'Trail stop' ? 'trail' : close === 'SL hit' ? 'sl'
        : (JUSTIFIED_RE.test(String(t.close_reason || '').toLowerCase()) || pm?.classification === 'time_cap') ? 'early-ok' : 'early-bad'
      const note = [
        t.close_reason || 'PREMATURE: manual close with no logged event or reasoning — violates Phase-3 "circuit breaker only"',
        pm?.classification ? `postmortem: ${pm.classification}` : null,
      ].filter(Boolean).join(' · ')
      const ft = (ms) => { const x = new Date(ms); return String(x.getUTCHours()).padStart(2, '0') + ':' + String(x.getUTCMinutes()).padStart(2, '0') }
      const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const d = closedMs != null ? new Date(closedMs) : null
      return {
        id: t.id, kind, sym: t.symbol,
        side: String(t.side || '').toUpperCase() === 'BUY' ? 'LONG' : 'SHORT',
        sd: (String(t.side || '').toUpperCase() === 'BUY' ? 'LONG' : 'SHORT') + (t.volume != null ? ` ${t.volume} lots` : ''),
        strat: t.label_strategy || t.strategy || '—',
        when: d ? `${d.getUTCDate()} ${MO[d.getUTCMonth()]} ${openedMs != null ? ft(openedMs) : '—'}→${ft(closedMs)}` : '—',
        pnl: Number(t.net_pnl), close, note,
        lab: t.analysis_id != null || !!(t.label_strategy || t.strategy),
        bridge: t.source === 'autopilot' || t.source === 'copilot',
        managed: kind !== 'early-bad',
        p2l: t.entry_latency_ms ?? null, l2m: null, m2c: durMs, dur: durMs,
        closedMs,
      }
    })
    .sort((a, b) => (b.closedMs ?? 0) - (a.closedMs ?? 0))
    .slice(0, 30)
}

// node() — verbatim from the prototype. state: on | off | end | warn | bad
function node(k, i, state, segT, segTCol) {
  const P = {
    on: [ACC, ACC, 'transparent', 'wf-node'],
    off: [EDG, MU, 'transparent', 'wf-node'],
    end: [ACC, ACC, 'rgba(79,140,255,.6)', 'wf-end'],
    warn: [WRN, WRN, 'rgba(255,196,102,.6)', 'wf-end'],
    bad: [DN, DN, 'rgba(255,77,109,.7)', 'wf-bad'],
  }[state]
  return {
    k, grow: i === 0 ? '0' : '1', segShow: i === 0 ? 'none' : 'block',
    segBg: state === 'off' ? EDG : `linear-gradient(90deg,${EDG},${P[0]})`,
    fill: state === 'off' ? 'transparent' : P[0], bd: P[0], col: P[1], glow: P[2],
    rad: state === 'bad' ? '2px' : '50%', cls: P[3], t: segT || '', tCol: segTCol || MU,
  }
}

export default function WorkflowAudit({ allTrades, postmortems }) {
  const [flt, setFlt] = useState('all')
  const wrapRef = useRef(null)
  const retryRef = useRef(null)

  const pmByTrade = useMemo(() => {
    const map = {}
    for (const pm of postmortems || []) if (pm.trade_id != null) map[pm.trade_id] = pm
    return map
  }, [postmortems])
  const trades = useMemo(() => shape(allTrades || [], pmByTrade), [allTrades, pmByTrade])

  const isEarly = (t) => t.kind === 'early-ok' || t.kind === 'early-bad'
  const FL = [
    ['all', 'All trades', () => true],
    ['clean', 'Full pipeline', (t) => !isEarly(t)],
    ['early-ok', 'Early stop · justified', (t) => t.kind === 'early-ok'],
    ['early-bad', 'Early stop · premature', (t) => t.kind === 'early-bad'],
  ]
  const fn = FL.find(f => f[0] === flt)[2]

  const rows = trades.filter(fn).map(t => {
    const bad = t.kind === 'early-bad'
    const manual = t.kind.startsWith('early')
    const last = bad ? 'bad' : t.kind === 'early-ok' ? 'warn' : 'end'
    const lastTCol = bad ? DN : manual ? WRN : MU
    return {
      id: t.id, when: t.when, sym: t.sym, sd: t.sd + ' · total ' + fmtD(t.dur),
      sideCol: t.side === 'LONG' ? UP : DN, strat: t.strat,
      lab: t.lab ? '✓' : '✕', labCol: t.lab ? UP : DN,
      br: t.bridge ? '✓' : '✕', brCol: t.bridge ? UP : DN,
      path: [
        node('pending', 0, 'on'),
        node('live', 1, 'on', fmtD(t.p2l)),
        node('managed', 2, t.managed ? 'on' : 'off', fmtD(t.l2m), t.managed ? MU : DN),
        node(manual ? 'early' : 'closed', 3, last, fmtD(t.m2c), lastTCol),
      ],
      close: t.close, closeCol: t.close === 'Manual' ? (bad ? DN : WRN) : t.close === 'SL hit' ? DN : UP,
      note: t.note, noteCol: bad ? DN : t.kind === 'early-ok' ? WRN : SB,
      rowBg: bad ? DNS : 'transparent', pnl: mUsd(t.pnl), col: cCol(t.pnl),
    }
  })

  const nEok = trades.filter(t => t.kind === 'early-ok').length
  const nEbad = trades.filter(t => t.kind === 'early-bad').length
  const clean = trades.filter(t => !t.kind.startsWith('early'))
  const nLab = trades.filter(t => t.lab).length
  const nBridge = trades.filter(t => t.bridge).length
  const verdicts = trades.length ? [
    { title: 'Pipeline integrity', stat: Math.round(100 * clean.length / trades.length) + '%', txt: clean.length + ' of ' + trades.length + ' trades ran pending → live → managed → close untouched. The edge only exists while this number stays high.', bd: GBD, tcol: ACC, ncol: UP },
    { title: 'Early stops — justified', stat: String(nEok), txt: 'All carried a coded or documented circuit-breaker reason (news shock, regime invalidation, time cap). These protect the edge rather than corrupt it.', bd: 'rgba(255,196,102,.4)', tcol: WRN, ncol: WRN },
    { title: 'Early stops — premature', stat: String(nEbad), txt: 'Manual closes with no logged event and thesis still valid. Each one degrades the statistical sample — flagged red in the table with full reasoning.', bd: 'rgba(255,77,109,.4)', tcol: DN, ncol: DN },
  ] : []

  // anim() — verbatim GSAP choreography from the prototype, incl. the
  // bounded retry-until-gsap guard and the pulsing terminal nodes.
  useEffect(() => {
    let tries = 0
    const anim = () => {
      const g = typeof window !== 'undefined' ? window.gsap : null
      if (!g) { if (tries++ < 40) retryRef.current = setTimeout(anim, 300); return }
      g.killTweensOf('.wf-seg,.wf-node,.wf-end,.wf-bad')
      g.fromTo('.wf-seg', { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: 'power2.out', stagger: { each: 0.04, from: 'start' } })
      g.fromTo('.wf-node,.wf-end,.wf-bad', { scale: 0 }, { scale: 1, duration: 0.4, ease: 'back.out(2.5)', stagger: 0.04 })
      g.to('.wf-end', { boxShadow: '0 0 12px rgba(79,140,255,.9)', scale: 1.25, duration: 0.9, ease: 'sine.inOut', repeat: -1, yoyo: true, delay: 0.6 })
      g.to('.wf-bad', { boxShadow: '0 0 14px rgba(255,77,109,1)', scale: 1.35, rotation: 45, duration: 0.55, ease: 'sine.inOut', repeat: -1, yoyo: true, delay: 0.6 })
    }
    const kick = setTimeout(anim, 60)
    return () => {
      clearTimeout(kick); clearTimeout(retryRef.current)
      if (typeof window !== 'undefined' && window.gsap) window.gsap.killTweensOf('.wf-seg,.wf-node,.wf-end,.wf-bad')
    }
  }, [flt, rows.length])

  const filters = FL.map(([id, label, filterFn]) => {
    const on = flt === id
    return { id, label, n: trades.filter(filterFn).length, col: on ? '#fff' : TX, bg: on ? ACC : 'transparent', bd: on ? ACC : EDG }
  })
  // Mobile chip labels — verbatim from the mobile prototype's FL.
  const MOBILE_LABELS = { all: 'All', clean: 'Full pipeline', 'early-ok': 'Early · justified', 'early-bad': 'Early · premature' }
  // Mobile phase stat chips — exact copy from the mobile prototype.
  const phases = [
    { name: 'P1 · Lab', stat: trades.length ? `${nLab}/${trades.length} ✓` : '—', sub: 'backtest → coded params', col: ACC },
    { name: 'P2 · Bridge', stat: trades.length ? `${nBridge}/${trades.length} ✓` : '—', sub: 'forward-tested on demo', col: WRN },
    { name: 'P3 · Market', stat: trades.length ? `${trades.length - nEbad}/${trades.length} ✓` : '—', sub: 'autonomous management', col: VIO },
  ]
  // Mobile card rows — cardBg/cardBd + '· total' on the when line, per the
  // mobile prototype's renderVals.
  const mobileRows = trades.filter(fn).map(t => {
    const bad = t.kind === 'early-bad'
    const manual = t.kind.startsWith('early')
    const last = bad ? 'bad' : t.kind === 'early-ok' ? 'warn' : 'end'
    return {
      id: t.id, sym: t.sym, sd: t.sd, sideCol: t.side === 'LONG' ? UP : DN, strat: t.strat,
      when: t.when + ' · total ' + fmtD(t.dur),
      lab: t.lab ? '✓' : '✕', labCol: t.lab ? UP : DN,
      br: t.bridge ? '✓' : '✕', brCol: t.bridge ? UP : DN,
      close: t.close, closeCol: t.close === 'Manual' ? (bad ? DN : WRN) : t.close === 'SL hit' ? DN : UP,
      path: [
        node('pending', 0, 'on'),
        node('live', 1, 'on', fmtD(t.p2l)),
        node('managed', 2, t.managed ? 'on' : 'off', fmtD(t.l2m), t.managed ? MU : DN),
        node(manual ? 'early' : 'closed', 3, last, fmtD(t.m2c), bad ? DN : manual ? WRN : MU),
      ],
      note: t.note, noteCol: bad ? DN : t.kind === 'early-ok' ? WRN : SB,
      cardBg: bad ? DNS : GL, cardBd: bad ? 'rgba(255,77,109,.4)' : t.kind === 'early-ok' ? 'rgba(255,196,102,.35)' : GBD,
      pnl: mUsd(t.pnl), col: cCol(t.pnl),
    }
  })
  // Mobile verdicts — the prototype's shortened copy + mobile paddings.
  const mobileVerdicts = trades.length ? [
    { title: 'Pipeline integrity', stat: Math.round(100 * clean.length / trades.length) + '%', txt: clean.length + ' of ' + trades.length + ' ran pending → live → managed → close untouched — the edge only exists while this stays high.', bd: GBD, tcol: ACC, ncol: UP },
    { title: 'Early stops — justified', stat: String(nEok), txt: 'Coded/documented circuit breakers (news shock, regime invalidation) — protect the edge.', bd: 'rgba(255,196,102,.4)', tcol: WRN, ncol: WRN },
    { title: 'Early stops — premature', stat: String(nEbad), txt: 'No logged event, thesis still valid — each degrades the statistical sample. Red cards above.', bd: 'rgba(255,77,109,.4)', tcol: DN, ncol: DN },
  ] : []

  // The stepper markup is IDENTICAL in both prototypes — one renderer.
  const stepper = (path) => (
    <span className="wf" style={{ display: 'flex', alignItems: 'center', padding: '12px 2px 10px', position: 'relative' }}>
      {path.map(s => (
        <span key={s.k} style={{ display: 'flex', alignItems: 'center', flex: s.grow, minWidth: 0, position: 'relative' }}>
          <span style={{ display: s.segShow, position: 'absolute', left: 0, right: 11, top: -9, textAlign: 'center', fontSize: 9.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: s.tCol }}>{s.t}</span>
          <span className="wf-seg" style={{ display: s.segShow, flex: 1, height: 2, borderRadius: 2, background: s.segBg, transformOrigin: 'left center' }} />
          <span style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
            <span className={s.cls} style={{ width: 9, height: 9, borderRadius: s.rad, background: s.fill, border: `1.5px solid ${s.bd}`, boxShadow: `0 0 6px ${s.glow}` }} />
            <span style={{ position: 'absolute', top: 12, fontSize: 9.5, fontWeight: 700, letterSpacing: '.02em', color: s.col, whiteSpace: 'nowrap' }}>{s.k}</span>
          </span>
        </span>
      ))}
    </span>
  )

  return (
    <div ref={wrapRef} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* ============ MOBILE (below lg): the iPhone card layout ============ */}
      <div className="lg:hidden" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 5 }}>
          {phases.map(p => (
            <div key={p.name} style={{ background: GL, border: `1px solid ${GBD}`, borderRadius: 10, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{ fontSize: 9.5, fontWeight: 800, color: p.col }}>{p.name}</span>
              <span style={{ fontSize: 10, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: UP }}>{p.stat}</span>
              <span style={{ fontSize: 9.5, color: MU }}>{p.sub}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          {filters.map(f => (
            <button key={f.id} type="button" onClick={() => setFlt(f.id)} aria-pressed={flt === f.id}
              style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: 9.5, fontWeight: 700, color: f.col, background: f.bg, border: `1px solid ${f.bd}`, borderRadius: 999, padding: '3px 9px', minHeight: 44 }}>
              {MOBILE_LABELS[f.id]} <span style={{ opacity: 0.65 }}>{f.n}</span>
            </button>
          ))}
        </div>
        {mobileRows.length === 0 && <span style={{ fontSize: 9.5, color: SB }}>No closed trades in this bucket yet.</span>}
        {mobileRows.map(t => (
          <div key={t.id} style={{ background: t.cardBg, border: `1px solid ${t.cardBd}`, borderRadius: 12, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ fontSize: 11, fontWeight: 800 }}>{t.sym}</span>
              <span style={{ fontSize: 9.5, fontWeight: 700, color: t.sideCol, whiteSpace: 'nowrap' }}>{t.sd}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, color: t.col }}>{t.pnl}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 9.5, color: SB, fontVariantNumeric: 'tabular-nums' }}>{t.when}</span>
              <span style={{ fontSize: 9.5, color: MU, textTransform: 'capitalize' }}>{t.strat}</span>
              <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 700 }}>Lab <span style={{ color: t.labCol }}>{t.lab}</span> · Bridge <span style={{ color: t.brCol }}>{t.br}</span> · <span style={{ color: t.closeCol }}>{t.close}</span></span>
            </div>
            {stepper(t.path)}
            <span style={{ fontSize: 9.5, lineHeight: 1.45, color: t.noteCol }}>{t.note}</span>
          </div>
        ))}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {mobileVerdicts.map(v => (
            <div key={v.title} style={{ background: GL, border: `1px solid ${v.bd}`, borderRadius: 10, padding: '6px 9px', display: 'flex', flexDirection: 'column', gap: 1 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 9.5, fontWeight: 800, color: v.tcol }}>{v.title}</span>
                <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: v.ncol }}>{v.stat}</span>
              </div>
              <span style={{ fontSize: 9.5, lineHeight: 1.4, color: SB }}>{v.txt}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ============ DESKTOP (lg+): the full audit table ============ */}
      <div className="hidden lg:flex" style={{ flexDirection: 'column', gap: 8 }}>
      {/* Phase cards — exact copy from the prototype. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 8 }}>
        <div style={{ ...glass, padding: '8px 11px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: ACC }}>Phase 1 · The Lab</span>
            <span style={{ fontSize: 9.5, color: SB }}>research / backtest → strategy</span>
            <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 800, color: UP }}>{trades.length ? `${nLab}/${trades.length} ✓` : '—'}</span>
          </div>
          <span style={{ fontSize: 9.5, lineHeight: 1.45, color: SB }}><b style={{ color: TX }}>O</b> — historical price action, order blocks, volume profiles mined for a statistical edge; rules frozen into code. <b style={{ color: TX }}>I</b> — backtest proves the past only: it assumes perfect liquidity, zero latency, zero slippage. <b style={{ color: TX }}>A</b> — final parameters: quadrant criteria, entry triggers, risk sizing.</span>
        </div>
        <div style={{ ...glass, padding: '8px 11px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: WRN }}>Phase 2 · The Bridge</span>
            <span style={{ fontSize: 9.5, color: SB }}>forward test — the missing step</span>
            <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 800, color: UP }}>{trades.length ? `${nBridge}/${trades.length} ✓` : '—'}</span>
          </div>
          <span style={{ fontSize: 9.5, lineHeight: 1.45, color: SB }}><b style={{ color: TX }}>O</b> — history can't simulate news-event spread widening or broker delays. <b style={{ color: TX }}>I</b> — a bot overfitted to the past fails live. <b style={{ color: TX }}>A</b> — demo / micro-lot deployment must reproduce backtest behavior on live feeds before real size.</span>
        </div>
        <div style={{ ...glass, padding: '8px 11px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: VIO }}>Phase 3 · The Market</span>
            <span style={{ fontSize: 9.5, color: SB }}>pending → live → manage → close</span>
            <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 800, color: UP }}>{trades.length ? `${trades.length - nEbad}/${trades.length} ✓` : '—'}</span>
          </div>
          <span style={{ fontSize: 9.5, lineHeight: 1.45, color: SB }}><b style={{ color: TX }}>O</b> — limit/stop orders convert to live positions; risk managed until SL/TP or manual close. <b style={{ color: TX }}>I</b> — automation removes emotion; trailing stops &amp; partial scale-outs run as coded. <b style={{ color: TX }}>A</b> — manual closure is an emergency circuit breaker only, never routine.</span>
        </div>
      </div>

      {/* Filter chips — exact styles. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: MU }}>Show</span>
        {filters.map(f => (
          <button key={f.id} type="button" onClick={() => setFlt(f.id)} aria-pressed={flt === f.id}
            style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: 9.5, fontWeight: 700, color: f.col, background: f.bg, border: `1px solid ${f.bd}`, borderRadius: 999, padding: '3px 11px' }}>
            {f.label} <span style={{ opacity: 0.65 }}>{f.n}</span>
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 9.5, color: MU }}>closed trades · ✓ passed · ✕ violated · pipeline: pending → live → managed → close</span>
      </div>

      {/* Audit table — exact grid + cell styles. */}
      <div style={{ ...glass, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 1, overflowX: 'auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: GRID_COLS, gap: 6, fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: MU, borderBottom: `1px solid ${EDG}`, paddingBottom: 3 }}>
          <span>Date · in→out</span><span>Symbol · side</span><span>Strategy</span><span>Lab</span><span>Brdg</span><span>Market path</span><span>Close</span><span>Early-stop reasoning / audit note</span><span style={{ textAlign: 'right' }}>P&amp;L</span>
        </div>
        {rows.length === 0 && <span style={{ fontSize: 9.5, color: SB, padding: '6px 0' }}>No closed trades in this bucket yet — rows appear from the first completed round-trip.</span>}
        {rows.map(t => (
          <div key={t.id} style={{ display: 'grid', gridTemplateColumns: GRID_COLS, gap: 6, alignItems: 'center', borderBottom: `1px solid ${EDG}`, padding: '4px 0', fontVariantNumeric: 'tabular-nums', background: t.rowBg }}>
            <span style={{ fontSize: 9.5, lineHeight: 1.35, color: SB }}>{t.when}</span>
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 9.5, fontWeight: 800 }}>{t.sym}</span>
              <span style={{ fontSize: 9.5, color: t.sideCol }}>{t.sd}</span>
            </span>
            <span style={{ fontSize: 9.5, color: SB, textTransform: 'capitalize' }}>{t.strat}</span>
            <span style={{ fontSize: 9.5, fontWeight: 800, color: t.labCol }}>{t.lab}</span>
            <span style={{ fontSize: 9.5, fontWeight: 800, color: t.brCol }}>{t.br}</span>
            <span className="wf" style={{ display: 'flex', alignItems: 'center', padding: '12px 2px 10px', position: 'relative' }}>
              {t.path.map(s => (
                <span key={s.k} style={{ display: 'flex', alignItems: 'center', flex: s.grow, minWidth: 0, position: 'relative' }}>
                  <span style={{ display: s.segShow, position: 'absolute', left: 0, right: 11, top: -9, textAlign: 'center', fontSize: 9.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: s.tCol }}>{s.t}</span>
                  <span className="wf-seg" style={{ display: s.segShow, flex: 1, height: 2, borderRadius: 2, background: s.segBg, transformOrigin: 'left center' }} />
                  <span style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
                    <span className={s.cls} style={{ width: 9, height: 9, borderRadius: s.rad, background: s.fill, border: `1.5px solid ${s.bd}`, boxShadow: `0 0 6px ${s.glow}` }} />
                    <span style={{ position: 'absolute', top: 12, fontSize: 9.5, fontWeight: 700, letterSpacing: '.02em', color: s.col, whiteSpace: 'nowrap' }}>{s.k}</span>
                  </span>
                </span>
              ))}
            </span>
            <span style={{ fontSize: 9.5, fontWeight: 700, color: t.closeCol }}>{t.close}</span>
            <span style={{ fontSize: 9.5, lineHeight: 1.4, color: t.noteCol }}>{t.note}</span>
            <span style={{ fontSize: 10, fontWeight: 800, textAlign: 'right', color: t.col }}>{t.pnl}</span>
          </div>
        ))}
      </div>

      {/* Verdict cards — exact styles + copy. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {verdicts.map(v => (
          <div key={v.title} style={{ flex: 1, minWidth: 280, background: GL, border: `1px solid ${v.bd}`, borderRadius: 12, padding: '7px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 9.5, fontWeight: 800, color: v.tcol }}>{v.title}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: v.ncol }}>{v.stat}</span>
            </div>
            <span style={{ fontSize: 9.5, lineHeight: 1.4, color: SB }}>{v.txt}</span>
          </div>
        ))}
      </div>
      </div>

      <span style={{ fontSize: 9.5, color: MU }}>
        Lab ✓ = an analysis/strategy is attached · Bridge ✓ = placed through the bot's risk-gated pipeline · segment times: submit→fill latency (collected from the forensics build forward), managed span (not yet recorded — shows —), total hold · premature strictly means a manual close with no recorded rationale.
      </span>
    </div>
  )
}
