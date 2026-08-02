// SymbolClusters — the reader for GET /state/symbol-clusters.
//
// Owner (2026-07-25): "investigate double or triple trading symbols for past
// EU and NY market sessions. I suspect it is our coding/algo." The detector
// shipped in agent/services/trade-integrity.js answers that from the account's
// own history; this is how it gets read on the iPad instead of by curling a
// route.
//
// What a cluster IS: 2+ trades on the SAME account and symbol whose opens fall
// inside one window, with DISTINCT broker position ids — genuinely separate
// fills, not one fill recorded twice (that class is /state/duplicate-trades).
// A legitimate hedge or scale-in looks identical from outside, so this panel
// reports the evidence and never judges: the path behind each leg, whether the
// cluster mixes paths, whether it is hedged, how long it spans.
//
// Built to docs/ui-spec.md: 12px throughout, W_* weights, one-line rows that
// expand to one line of detail, right-aligned money, no bold body text.
import { useMemo, useState } from 'react'
import Skeleton from './common/Skeleton.jsx'
import SectionTools from './common/SectionTools.jsx'

const ACC = 'var(--color-accent)', UP = 'var(--color-up)', DN = 'var(--color-down)'
const SB = 'var(--color-text-sub)', MU = 'var(--color-muted)'
const WRN = 'var(--color-warning-text)', EDG = 'var(--glass-edge)'
const W_HEAD = 600, W_ROWLABEL = 500, W_CELL = 400

const nf2 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signed = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : `${v > 0 ? '+' : ''}${nf2.format(Number(v))}`)

// Windows the owner reads in. Each is a separate request — the server caps
// days at 365 and windowMinutes at 1440.
const CLUSTER_WINDOWS = [
  { label: '15m', windowMinutes: 15 },
  { label: '1h', windowMinutes: 60 },
  { label: '4h', windowMinutes: 240 },
]
const CLUSTER_RANGES = [7, 14, 30, 90]

// What each path means, in one line, so the report explains itself.
const PATH_NOTE = {
  'vpo-sidecar': 'C++ sidecar dispatcher — one order per ARMED strategy, no per-symbol cap',
  'pending-fib': 'a resting fib limit order that filled',
  autopilot: "the Node loop's market-order path — risk gate + 3-minute ledger dedupe",
  manual: 'a human action route (Execute, position-double, Telegram)',
  unknown: 'no label recorded — provenance unknown, not attributable',
}

const COLS = '14px 62px 92px 34px 1fr 84px'

function ClusterRow({ c, open, onToggle }) {
  const id = `${c.accountId}|${c.symbol}|${c.firstOpenedAt}`
  const toggle = () => onToggle(open ? null : id)
  return (
    <div>
      <div role="button" tabIndex={0} aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
        style={{ display: 'grid', gridTemplateColumns: COLS, gap: 6, alignItems: 'center', borderBottom: `1px solid ${EDG}`, padding: '1px 0', fontVariantNumeric: 'tabular-nums', cursor: 'pointer' }}>
        <span aria-hidden="true" style={{ fontSize: 'var(--fs-d9)', color: MU }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontSize: 'var(--fs-d9)', fontWeight: W_ROWLABEL }}>{c.symbol}</span>
        <span style={{ fontSize: 'var(--fs-d9)', fontWeight: W_CELL, color: SB }}>
          {String(c.firstOpenedAt || '').slice(5, 16)}
        </span>
        <span style={{ fontSize: 'var(--fs-d9)', fontWeight: W_CELL, color: c.count > 2 ? WRN : SB }}>×{c.count}</span>
        <span style={{ fontSize: 'var(--fs-d9)', fontWeight: W_CELL, color: c.crossPath ? WRN : SB }}>
          {c.paths.join(' + ')}{c.crossPath ? ' · cross-path' : ''}{c.hedged ? ' · hedged' : ''}
        </span>
        <span style={{ fontSize: 'var(--fs-d9)', fontWeight: W_CELL, textAlign: 'right', color: c.netPnl == null ? MU : c.netPnl >= 0 ? UP : DN }}>
          {signed(c.netPnl)}
        </span>
      </div>
      {open && (
        <div style={{ padding: '1px 0 2px 20px', borderBottom: `1px solid ${EDG}`, fontSize: 'var(--fs-d9)', color: MU, fontVariantNumeric: 'tabular-nums' }}>
          {[
            `acct ${c.accountId}`,
            `${c.sides.join('/')} · ${c.count} legs over ${c.spanMinutes}m`,
            c.openLegs ? `${c.openLegs} still open` : null,
            `${c.distinctPositionIds} distinct broker position id${c.distinctPositionIds === 1 ? '' : 's'}`,
            c.totalVolume ? `${nf2.format(c.totalVolume)} lots total` : null,
            c.sessions.length ? `session ${c.sessions.join('/')}` : null,
            c.strategies.length ? c.strategies.join(', ') : null,
            `trades #${c.tradeIds.join(' #')}`,
            c.paths.map(p => PATH_NOTE[p]).filter(Boolean).join(' · ') || null,
          ].filter(Boolean).join(' · ')}
        </div>
      )}
    </div>
  )
}

/**
 * @param {{ data: object|null, loading: boolean, error: string,
 *           days: number, windowMinutes: number,
 *           onDays: Function, onWindow: Function, inModal?: boolean }} props
 */
export default function SymbolClusters({
  data, loading, error, days, windowMinutes, onDays, onWindow, inModal = false,
}) {
  const [openId, setOpenId] = useState(null)

  const clusters = data?.clusters || []
  // Ranked "which code path is doing this" — the whole point of the report.
  const ranked = useMemo(
    () => Object.entries(data?.byPath || {}).sort((a, b) => b[1] - a[1]),
    [data],
  )
  const worstCount = clusters[0]?.count ?? 0

  const pill = (on) => ({
    cursor: 'pointer', fontFamily: 'inherit', fontSize: 'var(--fs-d9)', fontWeight: W_CELL,
    color: on ? '#fff' : SB, background: on ? ACC : 'transparent',
    border: `1px solid ${on ? ACC : EDG}`, borderRadius: 999, padding: '1px 8px',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ flexShrink: 0, fontSize: 'var(--fs-d11)', fontWeight: 800, color: ACC }}>Same-symbol clusters</span>
        <span style={{ fontSize: 'var(--fs-d9)', color: SB }}>
          2+ separate fills on one account &amp; symbol inside the window · distinct broker position ids, so these are real
          separate trades, not one fill recorded twice · tap a row for the legs
        </span>
        {!inModal && (
          <SectionTools id="symbol-clusters" title="Same-Symbol Clusters table" window={`${days}D`} data={clusters}
            toText={() => [
              `Same-symbol clusters — last ${days}d, ${windowMinutes}m window`,
              ranked.length ? `extra legs by path: ${ranked.map(([p, n]) => `${p} ${n}`).join(' · ')}` : 'no clusters',
              ...clusters.map(c => `${c.symbol} acct ${c.accountId} ${c.firstOpenedAt} ×${c.count} ${c.sides.join('/')} · ${c.paths.join('+')}${c.crossPath ? ' cross-path' : ''}${c.hedged ? ' hedged' : ''} · span ${c.spanMinutes}m · net ${signed(c.netPnl)} · trades #${c.tradeIds.join(' #')}`),
            ].join('\n')}
            render={() => (
              <SymbolClusters data={data} loading={loading} error={error} days={days}
                windowMinutes={windowMinutes} onDays={onDays} onWindow={onWindow} inModal />
            )} />
        )}
      </div>

      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--fs-d9)', fontWeight: W_HEAD, textTransform: 'uppercase', letterSpacing: '.04em', color: MU }}>Range</span>
        {CLUSTER_RANGES.map(d => (
          <button key={d} type="button" aria-pressed={d === days} style={pill(d === days)} onClick={() => onDays(d)}>{d}D</button>
        ))}
        <span style={{ marginLeft: 6, fontSize: 'var(--fs-d9)', fontWeight: W_HEAD, textTransform: 'uppercase', letterSpacing: '.04em', color: MU }}>Window</span>
        {CLUSTER_WINDOWS.map(w => (
          <button key={w.label} type="button" aria-pressed={w.windowMinutes === windowMinutes} style={pill(w.windowMinutes === windowMinutes)} onClick={() => onWindow(w.windowMinutes)}>{w.label}</button>
        ))}
      </div>

      {error && <span style={{ fontSize: 'var(--fs-d9)', color: DN }}>{error}</span>}
      {loading && !data && <Skeleton lines={4} />}

      {!loading && !error && data && clusters.length === 0 && (
        <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>
          No clusters in the last {days} days at a {windowMinutes}-minute window — no account opened the same symbol twice
          that close together. If the tables still look doubled, check whether the account filter is on All: one signal
          opens the same symbol once per enabled account, which is by design and is not counted here.
        </span>
      )}

      {clusters.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', borderBottom: `1px solid ${EDG}`, paddingBottom: 2 }}>
            <span style={{ fontSize: 'var(--fs-d9)', fontWeight: 800, color: worstCount > 2 ? WRN : SB, fontVariantNumeric: 'tabular-nums' }}>
              {clusters.length} cluster{clusters.length === 1 ? '' : 's'} · worst ×{worstCount}
            </span>
            <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>
              extra legs by path — {ranked.length ? ranked.map(([p, n]) => `${p} ${n}`).join(' · ') : '—'}
            </span>
          </div>
          <div className="t-gridhead" style={{ display: 'grid', gridTemplateColumns: COLS, gap: 6, borderBottom: `1px solid ${EDG}`, paddingBottom: 1 }}>
            <span /><span>Symbol</span><span>First open</span><span>Legs</span><span>Path</span><span style={{ textAlign: 'right' }}>Net</span>
          </div>
          {/* Owner (2026-07-25): "Halt the animation for the Trade-Audit
              page" — the AutoAnimate list reflow re-fired on every 60s data
              refresh; the list is static now. */}
          <div>
            {clusters.map(c => {
              const id = `${c.accountId}|${c.symbol}|${c.firstOpenedAt}`
              return <ClusterRow key={id} c={c} open={openId === id} onToggle={setOpenId} />
            })}
          </div>
        </>
      )}
    </div>
  )
}
