// Self-contained preview of the panel-layout redesign + theme system.
// Not wired into any backend — all data here is static so the page renders
// consistently for visual review. Access via /mockup.
//
// Panels can be reordered (drag by header), resized by width (S/M/L), and
// collapsed to the title bar. Layout + theme persist to localStorage under
// keys 'mockup:layout' and 'bot-trade:theme'.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from '../lib/theme.js'

// --- Static panel definitions --------------------------------------------

const PANELS = [
  { id: 'market',    title: 'Market Status' },
  { id: 'team',      title: 'Team Roster' },
  { id: 'positions', title: 'Trading Account' },
  { id: 'scan',      title: 'Scan Feed' },
  { id: 'order',     title: 'Order Entry' },
  { id: 'activity',  title: 'Activity Log' },
  { id: 'alerts',    title: 'Price Alerts' },
  { id: 'history',   title: 'History' },
]

const DEFAULT_LAYOUT = [
  { id: 'market',    size: 'M', collapsed: false },
  { id: 'team',      size: 'M', collapsed: false },
  { id: 'positions', size: 'L', collapsed: false },
  { id: 'scan',      size: 'M', collapsed: false },
  { id: 'order',     size: 'M', collapsed: false },
  { id: 'alerts',    size: 'S', collapsed: false },
  { id: 'history',   size: 'S', collapsed: false },
  { id: 'activity',  size: 'L', collapsed: true  },
]

const SIZE_SPAN = { S: 'col-span-12 md:col-span-3', M: 'col-span-12 md:col-span-6', L: 'col-span-12' }
const LAYOUT_KEY = 'mockup:layout'

// --- Theme sandbox (scoped to page via data-mockup-theme) ----------------

const THEME_STYLES = {
  light: {
    '--m-bg': '#f5f7fa', '--m-surface': '#ffffff', '--m-surface-2': '#fafbfc',
    '--m-border': '#dde3ec', '--m-border-strong': '#9aa5b4',
    '--m-text': '#1a202c', '--m-muted': '#6b7a8d',
    '--m-accent': '#1a56db', '--m-accent-soft': '#e8f0fe',
    '--m-up': '#1a56db', '--m-down': '#dc2626', '--m-warn': '#b45309',
  },
  dark: {
    '--m-bg': '#0b0f17', '--m-surface': '#111826', '--m-surface-2': '#0e1420',
    '--m-border': '#1f2a3c', '--m-border-strong': '#2e3a4e',
    '--m-text': '#e5eaf2', '--m-muted': '#8a95a5',
    '--m-accent': '#5b8cff', '--m-accent-soft': '#18243d',
    '--m-up': '#5b8cff', '--m-down': '#f07070', '--m-warn': '#e0a858',
  },
  sepia: {
    '--m-bg': '#f4ecd8', '--m-surface': '#fbf5e5', '--m-surface-2': '#f1e6c9',
    '--m-border': '#d9c89a', '--m-border-strong': '#b89a5a',
    '--m-text': '#3a2f1b', '--m-muted': '#8a7548',
    '--m-accent': '#8c5a1c', '--m-accent-soft': '#ecdbb6',
    '--m-up': '#8c5a1c', '--m-down': '#a33a1e', '--m-warn': '#a77318',
  },
}

function useMockupTheme() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  // Sepia is a real theme value; for 'system', follow the resolved light/dark.
  const active = theme === 'sepia' ? 'sepia' : resolvedTheme
  return { theme, active, setTheme }
}

// --- localStorage helpers ------------------------------------------------

function readLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_LAYOUT
    const ids = new Set(PANELS.map(p => p.id))
    const cleaned = parsed.filter(p => ids.has(p.id))
    const missing = PANELS.filter(p => !cleaned.some(c => c.id === p.id))
      .map(p => ({ id: p.id, size: 'M', collapsed: false }))
    return [...cleaned, ...missing]
  } catch {
    return DEFAULT_LAYOUT
  }
}

function writeLayout(layout) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)) } catch {}
}

// --- Tiny UI primitives (all mockup-scoped colours) ----------------------

function Chip({ children, tone = 'neutral' }) {
  const map = {
    neutral: 'bg-[var(--m-surface-2)] text-[var(--m-muted)] border-[var(--m-border)]',
    up:      'bg-[var(--m-accent-soft)] text-[var(--m-up)] border-[var(--m-border)]',
    down:    'border-[var(--m-border)] text-[var(--m-down)] bg-[var(--m-surface-2)]',
    warn:    'border-[var(--m-border)] text-[var(--m-warn)] bg-[var(--m-surface-2)]',
  }
  return (
    <span className={`inline-flex items-center h-5 px-1.5 rounded text-[11px] font-medium border ${map[tone]}`}>
      {children}
    </span>
  )
}

function KV({ k, v, mono = false }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[12px]">
      <span className="text-[var(--m-muted)]">{k}</span>
      <span className={`text-[var(--m-text)] ${mono ? 'font-mono tabular-nums' : ''}`}>{v}</span>
    </div>
  )
}

// --- Panel frame (drag + size + collapse) --------------------------------

function PanelFrame({ entry, index, title, children, onDragStart, onDragOver, onDrop, onResize, onToggle }) {
  const span = SIZE_SPAN[entry.size] || SIZE_SPAN.M
  return (
    <section
      className={`${span} flex flex-col rounded-lg bg-[var(--m-surface)] border border-[var(--m-border)] overflow-hidden`}
      draggable
      onDragStart={(e) => onDragStart(e, index)}
      onDragOver={(e) => { e.preventDefault() }}
      onDrop={(e) => onDrop(e, index)}
    >
      <header
        className="shrink-0 h-8 px-2 flex items-center gap-2 border-b border-[var(--m-border)] bg-[var(--m-surface-2)] cursor-move select-none"
        onDragOver={onDragOver}
      >
        <span className="text-[var(--m-muted)] text-[10px] tracking-wider">⋮⋮</span>
        <span className="text-[12px] font-semibold text-[var(--m-text)] flex-1 truncate">{title}</span>
        <div className="flex items-center gap-0.5 text-[11px]">
          {['S','M','L'].map(s => (
            <button
              key={s}
              onClick={() => onResize(index, s)}
              className={`w-5 h-5 rounded ${entry.size === s
                ? 'bg-[var(--m-accent)] text-white'
                : 'text-[var(--m-muted)] hover:bg-[var(--m-accent-soft)] hover:text-[var(--m-accent)]'}`}
              title={`Size ${s}`}
            >{s}</button>
          ))}
          <button
            onClick={() => onToggle(index)}
            className="w-5 h-5 rounded text-[var(--m-muted)] hover:bg-[var(--m-accent-soft)] hover:text-[var(--m-accent)]"
            title={entry.collapsed ? 'Expand' : 'Collapse'}
          >{entry.collapsed ? '▸' : '▾'}</button>
        </div>
      </header>
      {!entry.collapsed && (
        <div className="p-2.5 flex-1 min-h-0">{children}</div>
      )}
    </section>
  )
}

// --- Panel bodies --------------------------------------------------------

function MarketBody() {
  return (
    <div className="space-y-2 text-[12px]">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-[var(--m-muted)] mb-1">Analyse + Trade · crypto OTC 24/7</div>
        <div className="flex flex-wrap gap-1">
          <Chip tone="up">BTCUSD</Chip><Chip tone="up">ETHUSD</Chip><Chip tone="up">SOLUSD</Chip>
        </div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-[var(--m-muted)] mb-1">Analyse only · next open</div>
        <div className="flex flex-wrap gap-1">
          <Chip>XAUUSD · 14h</Chip><Chip>EURUSD · 14h</Chip><Chip>US500 · 1d 14h</Chip>
        </div>
      </div>
    </div>
  )
}

function TeamBody() {
  const team = [
    { sym: 'BTCUSD',  roles: [['T','up'],['J','info'],['R','accent'],['E','warn']] },
    { sym: 'ETHUSD',  roles: [['T','up'],['R','accent'],['E','warn']] },
    { sym: 'XAUUSD',  roles: [['T','up'],['J','info'],['P','down'],['E','warn']] },
  ]
  return (
    <div className="space-y-1.5">
      {team.map(t => (
        <div key={t.sym} className="flex items-center gap-2 text-[12px]">
          <span className="font-mono text-[var(--m-text)] w-16">{t.sym}</span>
          <div className="flex gap-0.5">
            {t.roles.map(([r], i) => (
              <span key={i} className="w-5 h-5 rounded-full grid place-items-center text-[10px] font-bold border border-[var(--m-border)] bg-[var(--m-surface-2)] text-[var(--m-text)]">
                {r}
              </span>
            ))}
          </div>
          <span className="ml-auto text-[10px] text-[var(--m-muted)]">{t.roles.length} agents</span>
        </div>
      ))}
    </div>
  )
}

function PositionsBody() {
  const rows = [
    { side: '▲', sym: 'BTCUSD', vol: '0.02', entry: '64,120.50', sl: '63,500', tp: '66,000', margin: '$128', age: '2h 14m', pnl: '+$142.30' },
    { side: '▼', sym: 'XAUUSD', vol: '0.01 (1.0 oz)', entry: '2,385.40', sl: '2,400.0', tp: '2,360.0', margin: '$24', age: '45m', pnl: '-$18.50' },
  ]
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="rounded border border-[var(--m-border)] bg-[var(--m-surface-2)] p-2 space-y-1">
          <div className="flex items-center gap-2 text-[13px]">
            <span className={r.side === '▲' ? 'text-[var(--m-up)]' : 'text-[var(--m-down)]'}>{r.side}</span>
            <span className="font-semibold text-[var(--m-text)]">{r.sym}</span>
            <span className="text-[var(--m-muted)] font-mono text-[11px]">{r.vol}</span>
            <span className="text-[var(--m-muted)] font-mono text-[11px]">@ {r.entry}</span>
            <span className={`ml-auto font-mono text-[12px] font-semibold ${r.pnl.startsWith('+') ? 'text-[var(--m-up)]' : 'text-[var(--m-down)]'}`}>{r.pnl}</span>
          </div>
          <div className="grid grid-cols-4 gap-1 text-[10px] text-[var(--m-muted)] font-mono">
            <span>SL {r.sl}</span><span>TP {r.tp}</span><span>Mgn {r.margin}</span><span>{r.age}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function ScanBody() {
  const rows = [
    { sym: 'BTCUSD', grade: 'A', note: 'Potential long @ 64,100 · RSI rebound' },
    { sym: 'ETHUSD', grade: 'B', note: 'Consolidation · wait for breakout' },
    { sym: 'SOLUSD', grade: 'C', note: 'Choppy · skip' },
  ]
  return (
    <div className="space-y-1">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2 text-[12px] py-1 border-b border-[var(--m-border)] last:border-0">
          <span className={`w-5 h-5 grid place-items-center rounded text-[10px] font-bold ${r.grade === 'A' ? 'bg-[var(--m-accent)] text-white' : 'bg-[var(--m-surface-2)] text-[var(--m-muted)] border border-[var(--m-border)]'}`}>{r.grade}</span>
          <span className="font-mono text-[var(--m-text)] w-16">{r.sym}</span>
          <span className="text-[var(--m-muted)] truncate">{r.note}</span>
        </div>
      ))}
    </div>
  )
}

function OrderBody() {
  return (
    <div className="space-y-2 text-[12px]">
      <div className="grid grid-cols-2 gap-1">
        <button className="h-8 rounded bg-[var(--m-up)] text-white font-semibold text-[12px]">BUY</button>
        <button className="h-8 rounded bg-[var(--m-down)] text-white font-semibold text-[12px]">SELL</button>
      </div>
      <KV k="Symbol" v="BTCUSD" mono />
      <KV k="Volume" v="0.01 lot" mono />
      <KV k="Stop-loss" v="-200 pip" mono />
      <KV k="Take-profit" v="+400 pip" mono />
      <KV k="Risk" v="$25 / 0.5%" mono />
    </div>
  )
}

function AlertsBody() {
  return (
    <div className="space-y-1 text-[12px]">
      <div className="flex justify-between"><span>BTCUSD ≥</span><span className="font-mono">65,000</span></div>
      <div className="flex justify-between"><span>XAUUSD ≤</span><span className="font-mono">2,360</span></div>
      <div className="flex justify-between"><span>EURUSD ≥</span><span className="font-mono">1.0850</span></div>
    </div>
  )
}

function HistoryBody() {
  return (
    <div className="space-y-1 text-[11px]">
      <div className="flex justify-between"><span className="text-[var(--m-muted)]">14:22 open</span><span className="font-mono">BTC 0.02</span></div>
      <div className="flex justify-between"><span className="text-[var(--m-muted)]">13:40 close</span><span className="font-mono text-[var(--m-up)]">+$32</span></div>
      <div className="flex justify-between"><span className="text-[var(--m-muted)]">12:05 SL</span><span className="font-mono text-[var(--m-down)]">-$18</span></div>
    </div>
  )
}

function ActivityBody() {
  const rows = [
    ['14:22:08', 'scan', 'BTCUSD grade A · dispatch 4 agents'],
    ['14:22:01', 'trade', 'BUY BTCUSD 0.02 @ 64,120.50'],
    ['14:21:55', 'analyse', 'XAUUSD · mean-reversion setup'],
    ['14:21:40', 'loop', 'cycle start · 8 symbols in queue'],
  ]
  return (
    <div className="space-y-0.5 text-[11px] font-mono">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <span className="text-[var(--m-muted)]">{r[0]}</span>
          <span className="text-[var(--m-accent)] w-14">{r[1]}</span>
          <span className="text-[var(--m-text)]">{r[2]}</span>
        </div>
      ))}
    </div>
  )
}

const BODIES = {
  market: MarketBody, team: TeamBody, positions: PositionsBody, scan: ScanBody,
  order: OrderBody, alerts: AlertsBody, history: HistoryBody, activity: ActivityBody,
}

// --- Theme toggle --------------------------------------------------------

const THEME_OPTS = [
  { id: 'system', icon: '◐', label: 'System' },
  { id: 'light',  icon: '☀', label: 'Light'  },
  { id: 'dark',   icon: '☾', label: 'Dark'   },
  { id: 'sepia',  icon: '☕', label: 'Sepia'  },
]

function ThemeToggle({ theme, setTheme }) {
  return (
    <div className="inline-flex items-center rounded-md border border-[var(--m-border)] bg-[var(--m-surface)] p-0.5">
      {THEME_OPTS.map(opt => (
        <button
          key={opt.id}
          onClick={() => setTheme(opt.id)}
          className={`h-7 px-2 rounded text-[12px] flex items-center gap-1 ${theme === opt.id
            ? 'bg-[var(--m-accent)] text-white'
            : 'text-[var(--m-muted)] hover:text-[var(--m-text)]'}`}
          title={opt.label}
        >
          <span className="text-[14px] leading-none">{opt.icon}</span>
          <span className="hidden sm:inline">{opt.label}</span>
        </button>
      ))}
    </div>
  )
}

// --- Page ----------------------------------------------------------------

export default function Mockup() {
  const [layout, setLayout] = useState(readLayout)
  const dragIdx = useRef(null)
  const { theme, active, setTheme } = useMockupTheme()

  useEffect(() => { writeLayout(layout) }, [layout])

  const themeVars = useMemo(() => THEME_STYLES[active] || THEME_STYLES.light, [active])

  const onDragStart = (_e, i) => { dragIdx.current = i }
  const onDragOver = (e) => { e.preventDefault() }
  const onDrop = (_e, i) => {
    const from = dragIdx.current
    if (from == null || from === i) return
    setLayout(prev => {
      const next = prev.slice()
      const [moved] = next.splice(from, 1)
      next.splice(i, 0, moved)
      return next
    })
    dragIdx.current = null
  }
  const onResize = (i, size) => setLayout(prev => prev.map((p, idx) => idx === i ? { ...p, size } : p))
  const onToggle = (i) => setLayout(prev => prev.map((p, idx) => idx === i ? { ...p, collapsed: !p.collapsed } : p))
  const onReset  = () => setLayout(DEFAULT_LAYOUT)

  return (
    <div style={themeVars} className="min-h-[80vh] -mx-[var(--content-pad)] -my-6 px-4 py-4 bg-[var(--m-bg)] text-[var(--m-text)]">
      <div className="flex items-center gap-3 mb-3">
        <div>
          <div className="text-[16px] font-semibold text-[var(--m-text)]">Panel Layout Preview</div>
          <div className="text-[11px] text-[var(--m-muted)]">Drag headers to reorder · S/M/L sets width · ▾ collapses · layout persists</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={onReset} className="h-7 px-2 rounded border border-[var(--m-border)] text-[12px] text-[var(--m-muted)] hover:text-[var(--m-text)]">Reset layout</button>
          <ThemeToggle theme={theme} setTheme={setTheme} />
        </div>
      </div>
      <div className="grid grid-cols-12 gap-2 auto-rows-min">
        {layout.map((entry, i) => {
          const def = PANELS.find(p => p.id === entry.id)
          if (!def) return null
          const Body = BODIES[entry.id]
          return (
            <PanelFrame
              key={entry.id}
              entry={entry}
              index={i}
              title={def.title}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onResize={onResize}
              onToggle={onToggle}
            >
              <Body />
            </PanelFrame>
          )
        })}
      </div>
    </div>
  )
}
