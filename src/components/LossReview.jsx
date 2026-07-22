// ---------------------------------------------------------------------------
// LossReview — post-loss playback (owner: "playback after each loss to
// understand what the market is happening").
//
// Each losing trade gets a verdict of what the market DID next, computed by
// the agent's postmortem sweep:
//   stop_hunt    — right idea, stop too tight (price came back to entry)
//   thesis_wrong — wrong idea, stop saved money (price kept going)
//   chop         — noise; the entry filter let it through
//   time_cap     — the clock closed it, not the market
// plus a bar-replay sparkline (entry → stop → aftermath).
//
// Accessibility (owner has red-green colour vision): verdicts are NEVER
// colour-only — each carries its text label; the sparkline uses the accent
// colour for price and TEXT markers (E / SL / X), not red/green coding.
// ---------------------------------------------------------------------------

import { useState } from 'react'

// Verdict → label + tone. Tones map to the app's blue/neutral palette (no
// red-vs-green distinction is required to read them; text always present).
const VERDICTS = {
  stop_hunt: { label: 'STOP HUNT', hint: 'right idea, stop too tight' },
  thesis_wrong: { label: 'THESIS WRONG', hint: 'stop saved money' },
  chop: { label: 'CHOP', hint: 'noise entry' },
  time_cap: { label: 'TIME CAP', hint: 'clock, not market' },
  inconclusive: { label: 'INCONCLUSIVE', hint: 'not enough data' },
  // Wins carry lessons too (owner: "lesson learnt for both lost and wins")
  clean_win: { label: 'CLEAN WIN', hint: 'exit captured the move' },
  gave_back: { label: 'GAVE BACK', hint: 'left ≥1R on the table' },
  escaped: { label: 'ESCAPED', hint: 'won after near-stop — luck, not edge' },
}
const WIN_CLASSES = new Set(['clean_win', 'gave_back', 'escaped'])

function Spark({ bars, entry, sl, exit }) {
  if (!Array.isArray(bars) || bars.length < 2) return null
  const W = 220, H = 56, PAD = 4
  const closes = bars.map(b => b[4])
  const lows = bars.map(b => b[3])
  const highs = bars.map(b => b[2])
  const lo = Math.min(...lows, sl ?? Infinity)
  const hi = Math.max(...highs, entry ?? -Infinity)
  if (!(hi > lo)) return null
  const x = (i) => PAD + (i / (bars.length - 1)) * (W - 2 * PAD)
  const y = (p) => PAD + (1 - (p - lo) / (hi - lo)) * (H - 2 * PAD)
  const path = closes.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(' ')
  const line = (p, label) => (p == null ? null : (
    <g>
      <line x1={PAD} x2={W - PAD} y1={y(p)} y2={y(p)} stroke="currentColor" strokeDasharray="3 3" strokeWidth="0.75" opacity="0.55" />
      <text x={W - PAD} y={y(p) - 2} textAnchor="end" fontSize="8" fill="currentColor" opacity="0.85">{label}</text>
    </g>
  ))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-[220px] h-[56px] text-[var(--color-text-sub)]" role="img" aria-label="price replay around the loss">
      {line(entry, 'E')}
      {line(sl, 'SL')}
      {line(exit, 'X')}
      <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" />
    </svg>
  )
}

function Group({ title, rows }) {
  if (rows.length === 0) return null
  return (
    <div>
      <div className="text-[12px] font-semibold text-[var(--color-text-sub)] mb-1">{title} ({rows.length})</div>
      <div className="space-y-2">
        {rows.map((r) => <Verdict key={r.id} r={r} />)}
      </div>
    </div>
  )
}

export default function LossReview({ postmortems }) {
  const rows = postmortems?.rows || []
  const stats = postmortems?.stats || []
  if (rows.length === 0) {
    return (
      <p className="text-[13px] text-[var(--color-text-sub)]">
        No classified trades yet — the sweep reviews every closed trade (wins AND losses) a few bars after it closes, working back through 90 days of history.
      </p>
    )
  }
  // Per-strategy learning line: "FIB: 5 stop_hunt · 2 thesis_wrong …"
  const byStrat = {}
  for (const s of stats) {
    (byStrat[s.strategy] ||= []).push(`${s.n} ${VERDICTS[s.classification]?.label?.toLowerCase() || s.classification}`)
  }
  const losses = rows.filter(r => !WIN_CLASSES.has(r.classification))
  const wins = rows.filter(r => WIN_CLASSES.has(r.classification))
  return (
    <div className="space-y-3">
      {Object.keys(byStrat).length > 0 && (
        <div className="text-[12px] text-[var(--color-text-sub)]">
          <span className="font-semibold text-[var(--color-text)]">Pattern (30d): </span>
          {Object.entries(byStrat).map(([k, v]) => `${k}: ${v.join(' · ')}`).join('  |  ')}
        </div>
      )}
      <Group title="Losses — what the market did" rows={losses} />
      <Group title="Wins — what the exit engine did" rows={wins} />
    </div>
  )
}

// Collapsed by default, same accordion pattern as the Risk-Decision veto
// rows (owner: "create collapse/expand like veto triangle") — with 30
// postmortems on one symbol/timeframe the old always-expanded cards made
// the panel unreadably tall; a one-line summary row now expands on demand.
function Verdict({ r }) {
  const [open, setOpen] = useState(false)
  const v = VERDICTS[r.classification] || { label: r.classification, hint: '' }
  const pnlText = r.net_pnl != null ? `${r.net_pnl < 0 ? '−' : ''}$${Math.abs(r.net_pnl).toFixed(2)}` : '—'
  return (
    <div className="glass-inset rounded-lg p-2">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full flex items-center gap-1.5 min-w-0 text-left cursor-pointer">
        <span aria-hidden="true" className="w-2.5 text-[9px] shrink-0 text-[var(--color-text-sub)]">{open ? '▾' : '▸'}</span>
        <span className="font-semibold shrink-0">{r.symbol}</span>
        <span className="text-[11px] text-[var(--color-text-sub)] shrink-0">{r.side} · {r.timeframe || '—'}{r.strategy ? ` · ${r.strategy}` : ''}</span>
        <span className="text-[11px] font-bold tracking-wide shrink-0">{v.label}</span>
        <span className="text-[11px] text-[var(--color-text-sub)] truncate">{r.lesson || v.hint}</span>
        <span className={`ml-auto text-[12px] shrink-0 ${r.net_pnl != null && r.net_pnl < 0 ? 'text-[var(--color-down)]' : r.net_pnl != null ? 'text-[var(--color-up)]' : ''}`}>
          {pnlText}{r.r_multiple != null ? ` · ${r.r_multiple.toFixed(2)}R` : ''}
        </span>
      </button>
      {open && (
        <div className="mt-1.5 flex flex-wrap items-start gap-3">
          <Spark bars={r.bars} entry={r.entry_price} sl={r.sl_price} exit={r.exit_price} />
          <div className="flex-1 min-w-[200px]">
            {r.lesson && <p className="text-[12px] font-semibold leading-snug">Lesson: {r.lesson}</p>}
            <p className="text-[12px] leading-snug text-[var(--color-text)]">{r.detail}</p>
            <FieldGrid r={r} />
          </div>
        </div>
      )}
    </div>
  )
}

const dash = (v) => (v == null || v === '' ? '—' : v)
const untracked = 'not tracked yet'
const px2 = (v) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) >= 100 ? 2 : 5 }))

// Full Trade-Lesson Extraction field breakdown (owner spec) — every field
// the spec names, laid out explicitly. Fields this codebase doesn't capture
// yet (Fundamental tag, structured Confluence indicators/Fib/VWAP, TP3, a
// SMART-goal text) are labelled "not tracked yet" rather than omitted or
// invented — the spec's shape is honoured, the data gap is honest.
function FieldGrid({ r }) {
  const goal = r.tp1_price != null
    ? `reach TP1 (${px2(r.tp1_price)})`
    : 'no TP1 on record'
  const rows = [
    ['Symbol', r.symbol],
    ['Strategy', dash(r.strategy)],
    ['Timeframe', dash(r.timeframe)],
    ['Direction', r.side === 'BUY' || r.side === 'long' ? 'Long' : r.side === 'SELL' || r.side === 'short' ? 'Short' : '—'],
    ['Fundamental', untracked],
    ['Confluence — Indicators', untracked],
    ['Confluence — Fib', untracked],
    ['Confluence — VWAP', untracked],
    ['Confluence-count', r.confluence_count != null ? String(r.confluence_count) : 'not recorded'],
    ['Entry', px2(r.entry_price)],
    ['Lot', r.lot != null ? Number(r.lot).toFixed(2) : '—'],
    ['SL', px2(r.sl_price)],
    ['TP1', px2(r.tp1_price)],
    ['TP2', px2(r.tp2_price)],
    ['TP3', untracked],
    ['Exit', px2(r.exit_price)],
    ['Goal (SMART)', goal],
    ['Result', dash(r.result)],
    ['R-multiple', r.r_multiple != null ? `${r.r_multiple.toFixed(2)}R` : '—'],
    ['Alpha-decay', r.alpha_decay ? `${r.alpha_decay === 'decay' ? 'DECAY' : r.alpha_decay} (keyed Symbol+Strategy+Timeframe)` : '—'],
    ['Entry-quality', dash(r.entry_quality)],
  ]
  return (
    <div className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <span className="text-[var(--color-text-sub)]">{label}</span>
          <span className={value === untracked || value === 'not recorded' ? 'text-[var(--color-text-sub)] italic' : ''}>{value}</span>
        </div>
      ))}
      {r.setup_thesis && (
        <span className="col-span-2 mt-0.5 text-[10px] text-[var(--color-text-sub)] opacity-80">
          Setup thesis (free text, not the structured Confluence breakdown above): {r.setup_thesis}
        </span>
      )}
    </div>
  )
}
