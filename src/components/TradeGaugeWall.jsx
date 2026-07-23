// TradeGaugeWall — per-open-position COCKPIT cluster (owner 2026-07-23:
// "change the Open Trades present dials to be cockpit layout", Gulfstream
// G700 PFD / McLaren F1 dash reference). Each tile is a CockpitPFD:
// attitude = the trade (horizon level at ENTRY, profit sky above, loss
// ground below; bank RIGHT = converging on the TP, LEFT = diverging),
// P&L-in-R tape left, price tape with TP/entry/SL bugs right, and a
// track-to-target strip along the bottom. The full-size version opens in
// the TradeChronograph pop-up. Previous twin-gauge design below replaced:
// Grid selector semantics (owner: "one chart means one overview combination
// of all open trade symbols, four means four trade symbol"): 1 = a single
// COMBINED portfolio tile (lots-weighted average R across every open
// position); 4/8/16 = that many INDIVIDUAL trade tiles, capped (an overflow
// note shows if there are more open positions than the grid size).
//
// The dollar P&L printed under each tile is still the broker-truth polled
// figure (unchanged) — R and its rate are a live, instrument-agnostic
// PROXY for "how is this trade doing right now," not a replacement for the
// exact money number.
import { useEffect, useState } from 'react'
import { useLiveTicks, liveMid } from '../lib/useLiveTicks.js'
import { STRAT_SHORT } from '../lib/strategy-labels.js'
import TradeChronograph from './TradeChronograph.jsx'
import CockpitPFD from './CockpitPFD.jsx'

const MAX_SAMPLES = 40 // ~2 min of tick-driven samples — enough for a rate-of-change
const SIZE = 116 // owner: "make it bigger for me to understand"

const money = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const isLong = (side) => side === 'BUY' || side === 'Long' || side === 'long'

/** R-multiple: how far price has travelled from entry, in units of this trade's own stop distance. */
function rMultiple(entry, sl, side, price) {
  if (entry == null || sl == null || price == null) return null
  const risk = Math.abs(entry - sl)
  if (!(risk > 0)) return null
  const dir = isLong(side) ? 1 : -1
  return ((price - entry) * dir) / risk
}

/**
 * History-tracked R samples → current rate-of-change + trending flag. Each
 * GaugeTile instance owns its own ref (React keys the tile by position id),
 * so this is a plain array, not an id-keyed map. Samples are appended in an
 * EFFECT, not during render — mutating a ref straight in the render body
 * would double-sample under StrictMode's dev double-render.
 */
function useTileSeries(r) {
  // History itself is the state (appended on the external signal — a fresh
  // R arriving); rate/trending are PURE derivations from it at render time,
  // not a second round-trip through an effect+setState.
  const [hist, setHist] = useState([])
  useEffect(() => {
    if (r == null) return
    // Genuinely syncing an external signal (a fresh live-tick-derived R) into
    // an accumulated rolling buffer — there's no source of truth to derive
    // this from at render time, unlike the mirrored-prop case this lint rule
    // targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHist(prev => {
      const t = Date.now()
      const next = prev.length && t - prev[prev.length - 1].t < 500
        ? [...prev.slice(0, -1), { t, r }]
        : [...prev, { t, r }]
      return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next
    })
  }, [r])
  const first = hist[0]
  const last = hist[hist.length - 1]
  const elapsedMin = first && last && last.t > first.t ? (last.t - first.t) / 60000 : 0
  const ratePerMin = elapsedMin > 0 ? (last.r - first.r) / elapsedMin : null
  return {
    rate: ratePerMin == null ? 0 : Math.tanh(ratePerMin / 0.5),
    ratePerMin,
    trending: ratePerMin != null && Math.abs(ratePerMin) > 0.15,
  }
}

// Minutes since an ISO timestamp, or null. Framework-free so the monitor-review
// line reads the same everywhere.
function minsSince(iso) {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.round((Date.now() - t) / 60000))
}

function GaugeTile({ label, side, r, entry, sl, tp, price, noReason, marketClosed, volume, pnl, strategy, source, lastCheckAt, lastCheckAction, thesisStatus, monitorSl, onOpen }) {
  const { ratePerMin } = useTileSeries(r)
  const pnlOk = Number.isFinite(pnl)
  // Proof the monitor is actually reviewing THIS position (owner: "how do I know
  // you are reviewing each one ... watch stop-loss"). Green when reviewed
  // recently, amber when the review is stale (>15m), red when never reviewed —
  // so a silent/stalled monitor is visible, not hidden behind a promise.
  const reviewAge = minsSince(lastCheckAt)
  const reviewColor = reviewAge == null ? 'var(--color-down)' : reviewAge > 15 ? 'var(--color-warning-text)' : 'var(--color-up)'
  const reviewText = reviewAge == null
    ? 'not yet reviewed'
    : `reviewed ${reviewAge === 0 ? 'just now' : `${reviewAge}m ago`}${lastCheckAction ? ` · ${String(lastCheckAction).toUpperCase()}` : ''}${thesisStatus ? ` · thesis ${thesisStatus}` : ''}`
  // Attribution: bot positions carry a strategy; adopted/manual broker fills
  // don't (owner: "why missing Strategies in the open trade"). Show the short
  // strategy code when known, else flag it as an external/manual position so a
  // blank isn't mistaken for a bug.
  const stratTag = strategy
    ? (STRAT_SHORT[strategy] || strategy)
    : (source && source !== 'autopilot' ? 'manual' : null)
  return (
    <div
      className={`rounded-[10px] p-2 glass-inset ${onOpen ? 'cursor-pointer hover:ring-1 hover:ring-[var(--color-accent)]' : ''} ${pnlOk ? (pnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]') : 'text-[var(--color-text-sub)]'}`}
      onClick={onOpen}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={onOpen ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }) : undefined}
      title={onOpen ? 'Open the full chronograph for this trade' : undefined}
    >
      <div className="flex items-center justify-between text-[11px] mb-0.5">
        <span className="flex items-center gap-1 min-w-0">
          {marketClosed && (
            <span aria-hidden="true" title="market closed — dial reads off the last known price, not a live tick">🔒</span>
          )}
          <span className="font-semibold text-[var(--color-text)]">{label}</span>
          {stratTag && (
            <span
              className="text-[9px] uppercase tracking-wide px-1 rounded bg-[var(--color-surface-2,rgba(120,120,120,0.15))] text-[var(--color-text-sub)] truncate"
              title={strategy ? `Opened by strategy: ${strategy}` : 'Manual / external position — no bot strategy attached'}
            >
              {stratTag}
            </span>
          )}
        </span>
        {side != null && <span className={isLong(side) ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}>{isLong(side) ? 'Long' : 'Short'}</span>}
      </div>
      <div className="flex items-center justify-center">
        <CockpitPFD entry={entry} sl={sl} tp={tp} side={side} price={price}
          pnl={pnlOk ? pnl : null} lots={volume} noReason={noReason} width={SIZE * 2 + 16} />
      </div>
      <div className="text-center text-[13px] font-bold mt-1">
        {pnlOk ? money(pnl) : '—'}
        <span className="text-[9px] font-normal text-[var(--color-text-sub)] ml-1">{ratePerMin == null ? '' : `${ratePerMin >= 0 ? '+' : ''}${ratePerMin.toFixed(2)}R/min`}</span>
      </div>
      {/* Monitor review record — the verifiable proof each position is watched. */}
      <div className="mt-1 pt-1 border-t border-[var(--color-border)] text-[9px] leading-tight flex items-center justify-between gap-1">
        <span style={{ color: reviewColor }} className="truncate" title={lastCheckAt ? `Last monitor review at ${lastCheckAt}` : 'The monitor has not reviewed this position yet'}>
          ● {reviewText}
        </span>
        <span className={`shrink-0 tabular-nums ${monitorSl != null ? 'text-[var(--color-text-sub)]' : 'text-[var(--color-down)]'}`} title={monitorSl != null ? 'Stop-loss the monitor is managing' : 'NO stop-loss tracked by the monitor'}>
          {monitorSl != null ? `SL ${Number(monitorSl).toLocaleString(undefined, { maximumFractionDigits: 5 })}` : 'no SL'}
        </span>
      </div>
    </div>
  )
}

export default function TradeGaugeWall({ positions = [], gridN = 4, marketHours = null }) {
  const symbols = [...new Set(positions.map(p => p.symbol).filter(Boolean))]
  const ticks = useLiveTicks(symbols)
  const [selected, setSelected] = useState(null)

  if (positions.length === 0) {
    return <p className="text-[13px] text-[var(--color-text-sub)] py-1">Flat — no open positions.</p>
  }

  // Group the same symbol's trades together (owner: "group the same trades
  // together") — stable sort by symbol so the two ADAUSD / ETHUSD cards cluster.
  const grouped = [...positions].sort((a, b) => String(a.symbol || '').localeCompare(String(b.symbol || '')))
  const withR = grouped.map(p => {
    const price = liveMid(ticks, p.symbol) ?? p.currentPrice ?? null
    const r = rMultiple(p.entry, p.sl, p.side, price)
    const pnl = Number(p.netPnl ?? p.estNetPnl ?? p.estPnlQuote)
    const marketClosed = marketHours?.[String(p.symbol || '').toUpperCase()]?.open === false
    // Owner: "dial to also show in market-closed symbols" + the dial used to
    // mislabel EVERY no-reading case as "no SL set", even when the real
    // reason was simply no price (market closed, no live tick) — a dial with
    // a real SL just went silently blank with a wrong excuse. Distinguish
    // the two honestly; the dial still renders either way, using the last
    // known price (broker snapshot) when the market's shut.
    const noReason = r != null ? null
      : p.sl == null ? 'no SL set'
      : price == null ? (marketClosed ? 'market closed — no live price' : 'no live price yet')
      : null
    return { p, r, pnl: Number.isFinite(pnl) ? pnl : null, marketClosed, noReason }
  })

  if (gridN === 1) {
    // Combined portfolio view (owner: "one chart means one overview
    // combination of all open trade symbols") — lots-weighted average R
    // across every position that has a stop set to compute R from.
    const withValidR = withR.filter(x => x.r != null)
    const totalLots = withR.reduce((s, x) => s + (Number(x.p.lots) || 0), 0)
    const weightedR = withValidR.length
      ? withValidR.reduce((s, x) => s + x.r * (Number(x.p.lots) || 1), 0) / withValidR.reduce((s, x) => s + (Number(x.p.lots) || 1), 0)
      : null
    const totalPnl = withR.reduce((s, x) => s + (x.pnl || 0), 0)
    const longs = positions.filter(p => isLong(p.side)).length
    return (
      <div className="grid grid-cols-1 max-w-xs gap-2">
        <GaugeTile
          label={`Portfolio · ${positions.length} open (${longs}L/${positions.length - longs}S)`}
          side={null}
          r={weightedR}
          entry={0} sl={-1} tp={null} price={weightedR ?? null}
          volume={totalLots}
          pnl={totalPnl}
        />
      </div>
    )
  }

  // gridN picks column DENSITY, not a hard cap — with 30 open positions and
  // gridN=16 the old code sliced to 16 tiles and printed "+14 more ... not
  // shown", with no way to actually SEE the rest (owner: "i have 30 trades
  // open, how to see the dials"). Every open position now renders; the wrap
  // scrolls vertically past a sane height instead of hiding the tail.
  const cols = gridN === 4 ? 'grid-cols-1 sm:grid-cols-2'
    : gridN === 8 ? 'grid-cols-2 sm:grid-cols-4'
    : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-8'

  return (
    <div>
      <div className={`grid ${cols} gap-2 max-h-[70vh] overflow-y-auto overscroll-contain pr-1`}>
        {withR.map(({ p, r, pnl, marketClosed, noReason }) => (
          <GaugeTile key={p.positionId} label={p.symbol} side={p.side} r={r}
            entry={p.entry ?? null} sl={p.monitorSl ?? p.sl ?? null} tp={p.tp1 ?? p.tp ?? null}
            price={liveMid(ticks, p.symbol) ?? p.currentPrice ?? null}
            noReason={noReason} marketClosed={marketClosed} volume={p.lots ?? p.volume ?? 0} pnl={pnl} strategy={p.strategy} source={p.source} lastCheckAt={p.lastCheckAt} lastCheckAction={p.lastCheckAction} thesisStatus={p.thesisStatus} monitorSl={p.monitorSl ?? p.sl} onOpen={() => setSelected(p)} />
        ))}
      </div>
      {withR.length > gridN && (
        <p className="text-[11px] text-[var(--color-text-sub)] mt-1">{withR.length} open — scroll for the rest, or pick a bigger grid size to see more per screen.</p>
      )}
      {selected && <TradeChronograph pos={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
