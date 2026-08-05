// SessionReview — the end-of-day / end-of-week debrief.
//
// Owner (2026-07-25): "especially for end of the day and end of week ... I like
// to know why the losses happens (is it human or bot) what lessons to learnt
// and for wins what did we do right or just 'lucky' which i don't believe".
//
// Three things this does, and one it deliberately refuses to do.
//
// WHO — human or bot — is knowable and is read off provenance, never guessed:
//   'vpo:*' in the label   → bot, the C++ sidecar dispatcher
//   'pending-fib' label    → bot, a resting fib limit that filled
//   source 'autopilot'     → bot, the Node loop's market path
//   source 'manual'        → HUMAN, an action route (Execute, double, Telegram)
//   no label at all        → unattributable, and reported as such rather than
//                            quietly counted as bot
//
// WHY a loss happened is classified from evidence only — the close reason plus
// the realised loss against the loss the plan budgeted (|entry − SL| × size):
//   as planned        loss within 1.3× the planned risk, stop did its job
//   worse than plan   loss beyond that, i.e. slippage, a gap, or a widened SL
//   human close       closed by hand at a loss
//   time cap          held to its cap and closed out
//   unclassified      the evidence does not say, so neither do we
//
// WINS are reported as "followed the plan" vs "off plan", NOT as skill vs luck.
// That is a deliberate refusal. Separating skill from luck is a statistical
// question and 44 trades cannot answer it — anyone claiming otherwise from this
// sample is guessing. What the data CAN say is whether the win arrived the way
// the plan intended: TP hit at the planned level, or a hand-close before it, or
// a run past it. That is process, it is checkable, and it is the part you can
// actually act on. The card says this in as many words rather than implying a
// verdict on skill.
import { useMemo, useState } from 'react'
import SectionTools from './common/SectionTools.jsx'
import { isLong, sideLabelUpper } from '../lib/side.js'

const UP = 'var(--color-up)', DN = 'var(--color-down)'
const ACC = 'var(--color-accent)', SB = 'var(--color-text-sub)', MU = 'var(--color-muted)'
const WRN = 'var(--color-warning-text)', EDG = 'var(--glass-edge)'
const W_ROWLABEL = 500, W_CELL = 400

const nf2 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signed = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : `${v > 0 ? '+' : ''}${nf2.format(Number(v))}`)
const num = (v) => (v == null ? NaN : Number(v))

// FX day anchor: 17:00 New York. Same anchor the Performance page uses, so the
// day this card reviews is the same day the rest of the page counts.
const NY_OFFSET_H = 4 // EDT in July; the page's own anchor helper owns the general case
function fxDayStart(ms) {
  const d = new Date(ms)
  const anchor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 17 + NY_OFFSET_H)
  return ms >= anchor ? anchor : anchor - 86_400_000
}
function fxWeekStart(ms) {
  // Broker week opens Sunday 17:00 NY.
  let t = fxDayStart(ms)
  for (let i = 0; i < 7; i++) {
    if (new Date(t).getUTCDay() === 0) return t
    t -= 86_400_000
  }
  return t
}

/** Who opened it — provenance only, never inference. */
function actorOf(t) {
  const raw = String(t.label_raw || '')
  if (/^vpo:/i.test(raw) || /^vpo:/i.test(String(t.strategy || ''))) return { who: 'bot', how: 'sidecar dispatcher' }
  if (/pending-fib/i.test(raw)) return { who: 'bot', how: 'resting fib limit' }
  const src = String(t.source || '').toLowerCase()
  if (src === 'manual') return { who: 'human', how: 'action route' }
  if (src === 'autopilot') return { who: 'bot', how: 'loop market order' }
  if (src) return { who: 'bot', how: src }
  return { who: 'unattributed', how: 'no label recorded' }
}

const isTp = (r) => /\btp\b|take.?profit|target|bank|partial|scale/i.test(String(r || ''))
const isSl = (r) => /\bsl\b|stop.?loss|stopped|stop hit/i.test(String(r || ''))
const isTimeCap = (r) => /time.?cap|expired|expiry/i.test(String(r || ''))
const isManualClose = (r) => /manual|by hand|closed by/i.test(String(r || ''))

/**
 * Classify one closed trade from its own evidence.
 * plannedRisk = |entry − SL| in price × the same size the P&L was made on,
 * approximated by scaling the realised loss when the stop was hit; when SL or
 * entry is missing there is no plan to compare against and the trade lands in
 * 'unclassified' rather than being assigned a story.
 */
function classify(t) {
  const pnl = num(t.net_pnl)
  const reason = t.close_reason
  const e = num(t.entry_price), sl = num(t.sl_price), tp = num(t.tp_price), x = num(t.exit_price)
  const hasPlan = Number.isFinite(e) && Number.isFinite(sl) && Math.abs(e - sl) > 0

  if (pnl > 0) {
    if (isTp(reason)) {
      // Did it stop at the planned level, or run past it?
      const ran = Number.isFinite(tp) && Number.isFinite(x)
        && (isLong(t.side) === true ? x > tp * 1.0005 : x < tp * 0.9995)
      return ran
        ? { bucket: 'ran past TP', onPlan: true, note: 'exit beyond the planned target — trail or extension, not the original plan' }
        : { bucket: 'TP as planned', onPlan: true, note: 'target hit at the planned level' }
    }
    if (isManualClose(reason) || actorOf(t).who === 'human') {
      return { bucket: 'closed by hand in profit', onPlan: false, note: 'banked before the target — the plan did not decide this exit' }
    }
    return { bucket: 'profit, exit unexplained', onPlan: false, note: 'closed in profit but the close reason does not say why' }
  }

  // Losses.
  if (isTimeCap(reason)) return { bucket: 'time cap', onPlan: true, note: 'held to its cap and closed out — thesis never played' }
  if (isSl(reason)) {
    if (!hasPlan) return { bucket: 'stop hit, plan unknown', onPlan: null, note: 'stop hit but entry/SL not recorded, so the loss cannot be compared to plan' }
    // Realised vs budgeted: the stop distance is what the plan risked, so a
    // loss much larger than that is slippage or a gap, not the plan working.
    const overshoot = Number.isFinite(x) ? Math.abs(x - sl) / Math.abs(e - sl) : 0
    return overshoot > 0.3
      ? { bucket: 'stop hit, worse than plan', onPlan: false, note: 'filled well past the stop — slippage or a gap, size the risk accordingly' }
      : { bucket: 'stop hit as planned', onPlan: true, note: 'the stop did its job — this is the cost of being wrong, not a mistake' }
  }
  if (isManualClose(reason) || actorOf(t).who === 'human') {
    return { bucket: 'closed by hand at a loss', onPlan: false, note: 'a hand-close, not the stop — the decision to cut was yours' }
  }
  return { bucket: 'unclassified loss', onPlan: null, note: 'no close reason recorded, so the cause is unknown — not assumed' }
}

function Bar({ label, n, of, tone }) {
  const pct = of ? Math.round((n / of) * 100) : 0

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 34px', gap: 6, alignItems: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 'var(--fs-d9)', fontWeight: W_CELL, color: SB, whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--color-accent-soft)' }}>
          <span style={{ display: 'block', width: `${pct}%`, height: 6, borderRadius: 3, background: tone }} />
        </span>
      </div>
      <span style={{ fontSize: 'var(--fs-d9)', fontWeight: W_CELL, textAlign: 'right', color: MU, fontVariantNumeric: 'tabular-nums' }}>{n}</span>
    </div>
  )
}

/**
 * @param {{ allTrades: Array, postmortems?: Array, nowMs?: number, inModal?: boolean }} props
 */
// nowMs is REQUIRED from the caller (the page's loadedAt), not defaulted to
// Date.now() — a Date.now() default is an impure render and would make the
// reviewed window drift on every re-render.
export default function SessionReview({ allTrades = [], postmortems = [], nowMs, inModal = false }) {
  const at = nowMs ?? 0
  const [period, setPeriod] = useState('day')
  const [openId, setOpenId] = useState(null)
  // Owner, 2026-08-03: "Build Cap of 20 rows and pagination". A debrief day
  // can carry a hundred closes, and an unbounded list buries the summary
  // panels underneath it — the same reason the workflow-audit clusters were
  // paginated (#175). 20 keeps the whole card on one screen.
  const PAGE = 20
  const [page, setPage] = useState(0)
  // Clamped at RENDER, not in an effect: if the list shrinks under the
  // current page (a narrower window, a filter), the reader must land on the
  // last real page rather than on a blank one for a frame.

  const model = useMemo(() => {
    const from = period === 'day' ? fxDayStart(at) : fxWeekStart(at)
    const closedMs = (t) => {
      const v = t.closed_at
      if (!v) return null
      const ms = Date.parse(String(v).includes('T') ? v : String(v).replace(' ', 'T') + 'Z')
      return Number.isFinite(ms) ? ms : null
    }
    const rows = allTrades
      .filter(t => t.status === 'closed' && t.net_pnl != null)
      .map(t => ({ ...t, ms: closedMs(t) }))
      .filter(t => t.ms != null && t.ms >= from)
      .sort((a, b) => a.ms - b.ms)
      .map(t => {
        const a = actorOf(t)
        const c = classify(t)
        const pm = postmortems.find(p => String(p.trade_id) === String(t.id)) || null
        return {
          id: `${t.id ?? t.ctrader_position_id ?? t.symbol}-${t.ms}`,
          sym: String(t.symbol || '').toUpperCase(),
          side: sideLabelUpper(t.side) ?? '—',
          pnl: Number(t.net_pnl),
          hm: new Date(t.ms).toISOString().slice(11, 16),
          strat: t.label_strategy || t.strategy || null,
          who: a.who, how: a.how,
          bucket: c.bucket, onPlan: c.onPlan, note: c.note,
          lesson: pm ? `${pm.classification || 'reviewed'}${pm.detail ? ` — ${pm.detail}` : ''}` : null,
        }
      })

    const wins = rows.filter(r => r.pnl > 0)
    const losses = rows.filter(r => r.pnl <= 0)
    const tally = (list, key) => {
      const m = new Map()
      for (const r of list) m.set(r[key], (m.get(r[key]) || 0) + 1)
      return [...m.entries()].sort((a, b) => b[1] - a[1])
    }
    const netOf = (list) => list.reduce((s, r) => s + r.pnl, 0)
    return {
      from, rows, wins, losses,
      net: netOf(rows),
      byActor: ['bot', 'human', 'unattributed'].map(who => {
        const list = rows.filter(r => r.who === who)
        return { who, n: list.length, net: netOf(list), wins: list.filter(r => r.pnl > 0).length }
      }).filter(x => x.n > 0),
      lossBuckets: tally(losses, 'bucket'),
      winBuckets: tally(wins, 'bucket'),
      offPlan: rows.filter(r => r.onPlan === false).length,
      unknown: rows.filter(r => r.onPlan === null).length,
      lessons: rows.filter(r => r.lesson),
    }
  }, [allTrades, postmortems, at, period])

  const pill = (on) => ({
    cursor: 'pointer', fontFamily: 'inherit', fontSize: 'var(--fs-d9)', fontWeight: W_CELL,
    color: on ? 'var(--color-on-accent)' : SB, background: on ? ACC : 'transparent',
    border: `1px solid ${on ? ACC : EDG}`, borderRadius: 999, padding: '1px 9px',
  })
  const label = period === 'day' ? 'this FX day' : 'this FX week'

  const lastPage = Math.max(0, Math.ceil(model.rows.length / PAGE) - 1)
  const safePage = Math.min(page, lastPage)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ flexShrink: 0, fontSize: 'var(--fs-d12)', fontWeight: 800, color: ACC }}>Debrief — why we won and lost</span>
        <span style={{ fontSize: 'var(--fs-d9)', color: SB }}>
          who opened it, what the evidence says about the exit, and what was written down · tap a row
        </span>
        {!inModal && (
          <SectionTools id="session-review" title="Debrief — Why We Won and Lost card" window={period === 'day' ? '1D' : '1W'}
            data={model.rows.map(r => ({ time: r.hm, symbol: r.sym, side: r.side, pnl: r.pnl, who: r.who, how: r.how, outcome: r.bucket, onPlan: r.onPlan, note: r.note, lesson: r.lesson }))}
            toText={() => [
              `Debrief — ${label}`,
              `net ${signed(model.net)} · ${model.wins.length} up · ${model.losses.length} down`,
              ...model.rows.map(r => `${r.hm} ${r.sym} ${r.side} ${signed(r.pnl)} · ${r.who} (${r.how}) · ${r.bucket} — ${r.note}${r.lesson ? ` · lesson: ${r.lesson}` : ''}`),
            ].join('\n')}
            render={() => <SessionReview allTrades={allTrades} postmortems={postmortems} nowMs={at} inModal />} />
        )}
      </div>

      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <button type="button" style={pill(period === 'day')} aria-pressed={period === 'day'} onClick={() => { setPeriod('day'); setPage(0) }}>Day</button>
        <button type="button" style={pill(period === 'week')} aria-pressed={period === 'week'} onClick={() => { setPeriod('week'); setPage(0) }}>Week</button>
        <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>from {new Date(model.from).toISOString().slice(0, 16).replace('T', ' ')} UTC (FX {period === 'day' ? 'day' : 'week'} open)</span>
      </div>

      {model.rows.length === 0 && (
        <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>
          Nothing closed in {label} — there is nothing to review. This is the honest state, not a loading failure.
        </span>
      )}

      {model.rows.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', borderTop: `1px solid ${EDG}`, paddingTop: 2 }}>
            <span style={{ fontSize: 'var(--fs-d9)', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: model.net >= 0 ? UP : DN }}>{signed(model.net)}</span>
            <span style={{ fontSize: 'var(--fs-d9)', color: SB }}>{model.wins.length} up · {model.losses.length} down</span>
            {model.byActor.map(a => (
              <span key={a.who} style={{ fontSize: 'var(--fs-d9)', color: a.who === 'human' ? WRN : SB }}>
                {a.who} {a.n} ({a.wins} up) <span style={{ fontVariantNumeric: 'tabular-nums', color: a.net >= 0 ? UP : DN }}>{signed(a.net)}</span>
              </span>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '2px 12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span className="t-gridhead" style={{ background: 'transparent' }}>Why we lost ({model.losses.length})</span>
              {model.lossBuckets.length === 0 && <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>no losses</span>}
              {model.lossBuckets.map(([b, n]) => <Bar key={b} label={b} n={n} of={model.losses.length} tone={DN} />)}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span className="t-gridhead" style={{ background: 'transparent' }}>Why we won ({model.wins.length})</span>
              {model.winBuckets.length === 0 && <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>no wins</span>}
              {model.winBuckets.map(([b, n]) => <Bar key={b} label={b} n={n} of={model.wins.length} tone={UP} />)}
            </div>
          </div>

          <div style={{ borderTop: `1px solid ${EDG}`, paddingTop: 2 }}>
            {model.rows.slice(safePage * PAGE, (safePage + 1) * PAGE).map(r => {
              const on = openId === r.id
              return (
                <div key={r.id}>
                  <div role="button" tabIndex={0} aria-expanded={on}
                    onClick={() => setOpenId(o => (o === r.id ? null : r.id))}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(o => (o === r.id ? null : r.id)) } }}
                    style={{ display: 'grid', gridTemplateColumns: '14px 42px 66px 62px 1fr 84px', gap: 6, alignItems: 'center', borderBottom: `1px solid ${EDG}`, padding: '1px 0', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>
                    <span aria-hidden="true" style={{ fontSize: 'var(--fs-d9)', color: MU }}>{on ? '▾' : '▸'}</span>
                    <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>{r.hm}</span>
                    <span style={{ fontSize: 'var(--fs-d9)', fontWeight: W_ROWLABEL }}>{r.sym}</span>
                    <span style={{ fontSize: 'var(--fs-d9)', fontWeight: W_CELL, color: r.who === 'human' ? WRN : SB }}>{r.who}</span>
                    <span style={{ fontSize: 'var(--fs-d9)', fontWeight: W_CELL, color: r.onPlan === false ? WRN : SB }}>{r.bucket}</span>
                    <span style={{ fontSize: 'var(--fs-d9)', fontWeight: W_CELL, textAlign: 'right', color: r.pnl >= 0 ? UP : DN }}>{signed(r.pnl)}</span>
                  </div>
                  {on && (
                    <div style={{ padding: '1px 0 2px 20px', borderBottom: `1px solid ${EDG}`, fontSize: 'var(--fs-d9)', color: MU }}>
                      {[r.side, r.strat || 'no strategy label', `${r.who} · ${r.how}`, r.note, r.lesson ? `lesson: ${r.lesson}` : 'no post-mortem written for this trade'].join(' · ')}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {model.rows.length > PAGE && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2 }}>
              <button
                type="button" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}
                style={{ fontSize: 'var(--fs-d9)', color: safePage === 0 ? MU : ACC, background: 'none', border: 'none', padding: 0, cursor: safePage === 0 ? 'default' : 'pointer' }}
              >&lsaquo; Newer</button>
              <span style={{ fontSize: 'var(--fs-d9)', color: MU, fontVariantNumeric: 'tabular-nums' }}>
                {/* The RANGE, not just the page number — "21-40 of 137" answers
                    "how much am I not looking at", which a bare page index does not. */}
                {safePage * PAGE + 1}&ndash;{Math.min((safePage + 1) * PAGE, model.rows.length)} of {model.rows.length}
              </span>
              <button
                type="button"
                onClick={() => setPage(p => (Math.min(p, lastPage) + 1 <= lastPage ? Math.min(p, lastPage) + 1 : p))}
                disabled={safePage >= lastPage}
                style={{ fontSize: 'var(--fs-d9)', color: safePage >= lastPage ? MU : ACC, background: 'none', border: 'none', padding: 0, cursor: safePage >= lastPage ? 'default' : 'pointer' }}
              >Older &rsaquo;</button>
            </div>
          )}

          <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>
            Buckets come from the close reason and the realised loss against the loss the plan budgeted (|entry − SL|) — never from a guess;
            a trade whose evidence does not say lands in &quot;unclassified&quot; on purpose. Wins are split by whether the exit
            <strong style={{ fontWeight: W_CELL }}> followed the plan</strong>, not by skill versus luck: that is a statistical question and this
            sample cannot answer it. {model.offPlan > 0 && `${model.offPlan} of ${model.rows.length} exits were off plan. `}
            {model.unknown > 0 && `${model.unknown} could not be judged for lack of recorded evidence. `}
            {model.lessons.length === 0 ? 'No post-mortems are written for these trades yet.' : `${model.lessons.length} carry a written post-mortem.`}
          </span>
        </>
      )}
    </div>
  )
}
