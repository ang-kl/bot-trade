// DivergenceCard — backtest vs live, and the earned floor's checkpoint.
//
// Two backend surfaces that existed with NO reader outside a terminal:
//
//   GET /state/divergence?days=30  (agent/services/divergence.js)
//     the evidence each combo was armed on vs what it has done live since,
//     an evidence-level breakdown of every bot close, and the aggregate
//     "backtest optimism" that calibrates the autopilot's arm bar.
//   GET /state/earned-floor        (agent/services/earned-floor.js)
//     PR-C's pre-registered checkpoint: config, the admitted cohort, and
//     the 30-close verdict against its FIXED target.
//
// The card sits next to the Strategy Autopilot control on purpose: that
// control arms combos on backtest evidence, and this is the only surface that
// says whether the evidence held. "Divergence" here is backtest→live; the
// Desk's market-pulse "pair divergence" is a different thing with a different
// name for exactly that reason.
//
// TWO RULES THE RENDERING FOLLOWS (recurring failure mode #3).
//
//   · A failed fetch is its own state — "not verifiable" — never the empty
//     state and never nothing. An unreachable route must not read as "no
//     divergence".
//   · An empty report says "no evidenced arms yet" in words. A blank table
//     is indistinguishable from a broken one.
//
// The pure bodies take {data, error} so they can be rendered with
// react-dom/server in tests; the default export does the fetching.
import { useEffect, useState } from 'react'
import { agentGet } from '../lib/agent-api.js'
import Badge from './common/Badge.jsx'
import { fmt, pct, money, signed, isNum } from '../lib/divergence-view.js'

const DAYS = 30

// Status carries a WORD on the badge; the tone is secondary. Diverging is
// the finding, so it takes the down/red token; holding is the on/blue one.
const STATUS_TONE = { diverging: 'down', holding: 'on', insufficient: 'neutral' }
const LEVEL_LABEL = {
  combo: 'combo — strategy × symbol × timeframe backtested',
  symbol_tf: 'symbol/timeframe only',
  strategy_only: 'strategy only',
  none: 'none — no backtest evidence',
}
const LEVEL_ORDER = ['combo', 'symbol_tf', 'strategy_only', 'none']


/** The failure state. Named, coloured as a warning, never blank. */
export function NotVerifiable({ what, error }) {
  return (
    <p className="text-(length:--fs-body) text-[var(--color-warning-text)] font-semibold" role="status">
      {what}: <strong>not verifiable</strong> — {String(error)}. This is a failure to read the agent,
      not a reading of the agent.
    </p>
  )
}

const th = 'py-0.5 pr-2 font-semibold text-left'
const thR = 'py-0.5 pr-2 font-semibold text-right'
const td = 'py-0.5 pr-2 whitespace-nowrap'
const tdR = 'py-0.5 pr-2 text-right tabular-nums'

export function EvidenceLevelTable({ levels }) {
  const rows = LEVEL_ORDER.filter(k => levels && levels[k])
  if (!rows.length) return <p className="text-(length:--fs-body) text-[var(--color-text-sub)]">No bot closes in the window — no evidence levels to show.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-(length:--fs-body) border-collapse">
        <thead>
          <tr className="text-[var(--color-text-sub)]">
            <th className={th}>Evidence level</th>
            <th className={thR}>Trades</th>
            <th className={thR}>WR</th>
            <th className={thR}>PF</th>
            <th className={thR}>Net</th>
            <th className={thR}>Exp. R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(k => {
            const e = levels[k]
            return (
              <tr key={k}>
                <td className={td}>{LEVEL_LABEL[k] || k}</td>
                <td className={tdR}>{e.trades ?? 0}</td>
                <td className={tdR}>{pct(e.winRatePct)}</td>
                <td className={tdR}>{fmt(e.profitFactor)}</td>
                <td className={tdR}>{money(e.netPnl)}</td>
                <td className={tdR}>{signed(e.expectancyR)}{isNum(e.rSample) && e.rSample > 0 ? <span className="text-[var(--color-text-sub)]"> (n={e.rSample})</span> : null}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function ComboTable({ combos }) {
  const top = (combos || []).slice(0, 8)
  if (!top.length) return <p className="text-(length:--fs-body) text-[var(--color-text-sub)]">no evidenced arms yet</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-(length:--fs-body) border-collapse">
        <thead>
          <tr className="text-[var(--color-text-sub)]">
            <th className={th}>Combo</th>
            <th className={thR}>BT PF</th>
            <th className={thR}>Live PF</th>
            <th className={thR}>BT WR</th>
            <th className={thR}>Live WR</th>
            <th className={thR}>Live n</th>
            <th className={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {top.map(c => (
            <tr key={`${c.strategy}|${c.symbol}|${c.timeframe}|${c.armedAt}`} className={c.status === 'diverging' ? 'bg-[var(--color-error-bg)]' : ''}>
              <td className={td}>
                <span className="font-semibold">{c.strategy}</span> · {c.symbol} · {c.timeframe}
                {c.disarmedAt ? <span className="text-[var(--color-text-sub)]"> (disarmed)</span> : null}
              </td>
              <td className={tdR}>{fmt(c.backtest?.profitFactor)}</td>
              <td className={tdR}>{fmt(c.live?.profitFactor)}</td>
              <td className={tdR}>{pct(c.backtest?.winRatePct)}</td>
              <td className={tdR}>{pct(c.live?.winRatePct)}</td>
              <td className={tdR}>{c.live?.trades ?? 0}</td>
              <td className={td}><Badge tone={STATUS_TONE[c.status] || 'neutral'}>{c.status || 'unknown'}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Backtest vs live: the pure body. */
export function DivergenceBody({ data, error }) {
  if (error) return <NotVerifiable what="Backtest vs live" error={error} />
  if (!data) return <p className="text-(length:--fs-body) text-[var(--color-text-sub)]">Loading…</p>
  const combos = data.combos || []
  const opt = data.optimism || {}
  const unev = Array.isArray(data.unevidencedArms) ? data.unevidencedArms.length : 0
  const diverging = combos.filter(c => c.status === 'diverging').length
  const win = data.window || {}
  return (
    <div className="flex flex-col gap-1.5 text-(length:--fs-body)">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span>
          <span className="font-semibold">Optimism</span>{' '}
          <span className="text-[var(--color-text-sub)]">(backtest minus live, over {opt.combos ?? 0} combo{opt.combos === 1 ? '' : 's'} with ≥ {win.minLive ?? '—'} live trades):</span>{' '}
          <span className="tabular-nums">WR {signed(opt.winRatePts, 1)} pts · PF {signed(opt.profitFactor)}</span>
          {!(opt.combos > 0) && <span className="text-[var(--color-text-sub)]"> — no combo has a measurable live sample yet</span>}
        </span>
        <span className="tabular-nums">
          <span className="font-semibold">{combos.length}</span> evidenced arm{combos.length === 1 ? '' : 's'}
          {diverging > 0 && <> · <span className="font-semibold text-[var(--color-down)]">{diverging} diverging</span></>}
          {' '}· <span className="font-semibold">{unev}</span> unevidenced arm{unev === 1 ? '' : 's'}
        </span>
      </div>

      <div>
        <div className="font-semibold mb-0.5">Every bot close in the window, by evidence level</div>
        <EvidenceLevelTable levels={data.evidenceLevels} />
      </div>

      <div>
        <div className="font-semibold mb-0.5">Armed combos — backtest vs live{combos.length > 8 ? ` (top 8 of ${combos.length}, diverging first)` : ''}</div>
        <ComboTable combos={combos} />
      </div>

      <p className="text-[var(--color-text-sub)]">
        Window {win.days ?? DAYS}d from {String(win.since || '').slice(0, 10) || '—'} · diverging = live PF &lt; 1 or live WR more than {win.wrGapPts ?? '—'} pts under backtest, on ≥ {win.minLive ?? '—'} live trades; insufficient = fewer live trades than that.
        {data.integrity && <> · {data.integrity.closes ?? 0} closes read, {data.integrity.flaggedExcluded ?? 0} excluded by the consistency audit.</>}
      </p>
    </div>
  )
}

/** Earned floor: the pure row. */
export function EarnedFloorRow({ data, error }) {
  if (error) return <NotVerifiable what="Earned floor" error={error} />
  if (!data) return <p className="text-(length:--fs-body) text-[var(--color-text-sub)]">Loading…</p>
  const cfg = data.config || {}
  const co = data.closedCohort || {}
  const target = data.target || {}
  const verdict = String(data.verdict || 'unknown')
  const tone = verdict === 'pass' ? 'on' : verdict === 'fail' ? 'down' : 'warning'
  // Server semantics: profitFactor null = no losses yet (∞), 0 = nothing won.
  const pf = co.profitFactor === null && (co.trades || 0) > 0 ? '∞ (no losses yet)' : fmt(co.profitFactor)
  return (
    <div className="flex flex-col gap-0.5 text-(length:--fs-body)">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-semibold">Earned floor</span>
        <Badge tone={tone}>{verdict}</Badge>
        <span className="text-[var(--color-text-sub)]">
          target {target.closes ?? '—'} closes at PF ≥ {target.minPf ?? '—'}
        </span>
      </div>
      <div className="tabular-nums">
        <span className="font-semibold">Config:</span>{' '}
        {cfg.on ? 'on' : 'off'} · every account · risk scale {fmt(cfg.riskScale)} · window {cfg.window ?? '—'} · min sample {cfg.minSample ?? '—'} · min E {fmt(cfg.minE)}R
      </div>
      <div className="tabular-nums">
        <span className="font-semibold">Cohort:</span>{' '}
        {co.trades ?? 0} closes · {co.wins ?? 0} wins ({pct(co.winRate)}) · PF {pf} · net {money(co.net)}
        {' '}· <span className="font-semibold">{data.admittedApprovals ?? 0}</span> admitted setups
        {' '}(<span title="Raw approval events — the scanner re-approves the same setup every cycle, so this is larger than the distinct count">{data.admitEvents ?? 0} approval events</span>)
      </div>
    </div>
  )
}

export default function DivergenceCard() {
  const [div, setDiv] = useState({ data: null, error: null })
  const [floor, setFloor] = useState({ data: null, error: null })

  useEffect(() => {
    let alive = true
    agentGet(`/state/divergence?days=${DAYS}`)
      .then(d => { if (alive) setDiv({ data: d?.error ? null : d, error: d?.error || null }) })
      .catch(e => { if (alive) setDiv({ data: null, error: e?.message || String(e) }) })
    agentGet('/state/earned-floor')
      .then(d => { if (alive) setFloor({ data: d?.error ? null : d, error: d?.error || null }) })
      .catch(e => { if (alive) setFloor({ data: null, error: e?.message || String(e) }) })
    return () => { alive = false }
  }, [])

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h3 className="t-h3">Backtest vs live</h3>
        <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">last {DAYS} days · bot-dispatched closes only</span>
      </div>
      <p className="text-(length:--fs-body) text-[var(--color-text-sub)] mb-1.5">
        The autopilot arms a combo on its backtest. This is what the same combo has done live since — the evidence
        held, or it did not. Not the Desk's market-pulse pair divergence, which is about correlated symbols.
      </p>
      <DivergenceBody data={div.data} error={div.error} />
      <div className="mt-2 pt-1.5 border-t border-[var(--color-border)]">
        <EarnedFloorRow data={floor.data} error={floor.error} />
      </div>
    </>
  )
}
