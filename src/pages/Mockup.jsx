import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from '../lib/theme.js'

// --- Static panel definitions ---
const PANELS = [
  { id: 'team',      title: 'Team Roster Desk' },
  { id: 'market',    title: 'Market Status' },
  { id: 'positions', title: 'Trading Account' },
  { id: 'scan',      title: 'Scan Feed' },
  { id: 'alerts',    title: 'Price Alerts' },
  { id: 'order',     title: 'Order Entry' },
  { id: 'history',   title: 'History' },
  { id: 'activity',  title: 'Activity Log' },
]

const DEFAULT_LAYOUT = [
  { id: 'team',      size: 'L', collapsed: false },
  { id: 'market',    size: 'M', collapsed: false },
  { id: 'positions', size: 'L', collapsed: false },
  { id: 'scan',      size: 'M', collapsed: false },
  { id: 'alerts',    size: 'M', collapsed: false },
  { id: 'order',     size: 'M', collapsed: false },
  { id: 'history',   size: 'M', collapsed: false },
  { id: 'activity',  size: 'L', collapsed: true  },
]

const SIZE_SPAN = { S: 'col-span-12 md:col-span-3', M: 'col-span-12 md:col-span-6', L: 'col-span-12' }
const LAYOUT_KEY = 'mockup:layout'

const THEME_STYLES = {
  light: {
    '--m-bg': '#f5f7fa', '--m-surface': '#ffffff', '--m-surface-2': '#fafbfc',
    '--m-border': '#dde3ec', '--m-border-strong': '#9aa5b4',
    '--m-text': '#1a202c', '--m-muted': '#6b7a8d',
    '--m-accent': '#1a56db', '--m-accent-soft': '#e8f0fe',
    '--m-up': '#1a56db', '--m-down': '#dc2626', '--m-warn': '#b45309',
    '--m-special': '#7c3aed', '--m-special-soft': '#f3e8ff',
  },
  dark: {
    '--m-bg': '#0b0f17', '--m-surface': '#111826', '--m-surface-2': '#0e1420',
    '--m-border': '#1f2a3c', '--m-border-strong': '#2e3a4e',
    '--m-text': '#e5eaf2', '--m-muted': '#8a95a5',
    '--m-accent': '#5b8cff', '--m-accent-soft': '#18243d',
    '--m-up': '#5b8cff', '--m-down': '#f07070', '--m-warn': '#e0a858',
    '--m-special': '#a78bfa', '--m-special-soft': '#1e1640',
  },
  sepia: {
    '--m-bg': '#f4ecd8', '--m-surface': '#fbf5e5', '--m-surface-2': '#f1e6c9',
    '--m-border': '#d9c89a', '--m-border-strong': '#b89a5a',
    '--m-text': '#3a2f1b', '--m-muted': '#8a7548',
    '--m-accent': '#8c5a1c', '--m-accent-soft': '#ecdbb6',
    '--m-up': '#8c5a1c', '--m-down': '#a33a1e', '--m-warn': '#a77318',
    '--m-special': '#6b4b8a', '--m-special-soft': '#e8d9f0',
  },
}

function useMockupTheme() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  const active = theme === 'sepia' ? 'sepia' : resolvedTheme
  return { theme, active, setTheme }
}

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
  } catch { return DEFAULT_LAYOUT }
}
function writeLayout(layout) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)) } catch {}
}

// --- UI primitives ---

function Chip({ children, tone = 'neutral' }) {
  const map = {
    neutral: 'bg-[var(--m-surface-2)] text-[var(--m-muted)] border-[var(--m-border)]',
    up:      'bg-[var(--m-accent-soft)] text-[var(--m-up)] border-[var(--m-border)]',
    down:    'border-[var(--m-border)] text-[var(--m-down)] bg-[var(--m-surface-2)]',
    warn:    'border-[var(--m-border)] text-[var(--m-warn)] bg-[var(--m-surface-2)]',
    special: 'border-[var(--m-border)] text-[var(--m-special)] bg-[var(--m-special-soft)]',
  }
  return (
    <span className={`inline-flex items-center h-5 px-1.5 rounded text-[11px] font-medium border ${map[tone] || map.neutral}`}>
      {children}
    </span>
  )
}

function StatusDot({ status }) {
  const cls = status === 'active' ? 'bg-[var(--m-up)]' : status === 'waiting' ? 'bg-[var(--m-warn)]' : 'bg-[var(--m-muted)]'
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} />
}

// --- TEAM ROSTER DESK ---

const MOCK_DESKS = [
  {
    symbol: 'BTCUSD', account: 'Demo #8124930', source: 'autopilot',
    agents: [
      { id: 'crypto_degen',     name: 'Crypto Desk',     icon: '\u{1F4A0}', role: 'trader',     status: 'active',  startedAt: '14:08', runningFor: '12m' },
      { id: 'momentum_hunter',  name: 'Momentum Hunter', icon: '\u{1F680}', role: 'trader',     status: 'active',  startedAt: '14:08', runningFor: '12m' },
      { id: 'nyc_desk',         name: 'NYC Desk',        icon: '\u{1F1FA}\u{1F1F8}', role: 'journalist', status: 'active',  startedAt: '14:09', runningFor: '11m' },
      { id: 'chart_scanner',    name: 'Chart Scanner',   icon: '\u{1F4C9}', role: 'researcher', status: 'waiting', waitUntil: '14:38' },
      { id: 'sentiment',        name: 'Sentiment',       icon: '\u{1F4E3}', role: 'researcher', status: 'waiting', waitUntil: '14:38' },
      { id: 'central_bank',     name: 'Central Bank',    icon: '\u{1F3DB}\uFE0F', role: 'economist',  status: 'done',    finishedAt: '14:10' },
    ],
  },
  {
    symbol: 'XAUUSD', account: 'Demo #8124930', source: 'autopilot',
    agents: [
      { id: 'commodity_trader', name: 'Commodity Trader', icon: '\u{1F6E2}\uFE0F', role: 'trader',     status: 'active',  startedAt: '14:02', runningFor: '18m' },
      { id: 'fx_scalper',      name: 'FX Scalper',       icon: '\u{1F4B1}', role: 'trader',     status: 'done',    finishedAt: '14:06' },
      { id: 'london_desk',     name: 'London Desk',      icon: '\u{1F1EC}\u{1F1E7}', role: 'journalist', status: 'active',  startedAt: '14:03', runningFor: '17m' },
      { id: 'order_flow',      name: 'Order Flow',       icon: '\u{1F4DD}', role: 'researcher', status: 'active',  startedAt: '14:04', runningFor: '16m' },
      { id: 'chart_scanner',   name: 'Chart Scanner',    icon: '\u{1F4C9}', role: 'researcher', status: 'waiting', waitUntil: '14:32' },
      { id: 'inflation',       name: 'Inflation',        icon: '\u{1F525}', role: 'economist',  status: 'done',    finishedAt: '14:05' },
    ],
  },
  {
    symbol: 'EURUSD', account: 'Demo #8124930', source: 'copilot',
    agents: [
      { id: 'fx_scalper',      name: 'FX Scalper',       icon: '\u{1F4B1}', role: 'trader',     status: 'scheduled', startsAt: 'Mon 08:00' },
      { id: 'carry_analyst',   name: 'Carry Analyst',    icon: '\u{1F3E6}', role: 'trader',     status: 'scheduled', startsAt: 'Mon 08:00' },
      { id: 'frankfurt_desk',  name: 'Frankfurt Desk',   icon: '\u{1F1E9}\u{1F1EA}', role: 'journalist', status: 'scheduled', startsAt: 'Mon 07:00' },
      { id: 'chart_scanner',   name: 'Chart Scanner',    icon: '\u{1F4C9}', role: 'researcher', status: 'scheduled', startsAt: 'Mon 08:00' },
      { id: 'central_bank',    name: 'Central Bank',     icon: '\u{1F3DB}\uFE0F', role: 'economist',  status: 'scheduled', startsAt: 'Mon 07:00' },
    ],
  },
]

const ROLE_COLORS = {
  trader:    'text-[var(--m-up)]',
  journalist:'text-[var(--m-accent)]',
  researcher:'text-[var(--m-special)]',
  economist: 'text-[var(--m-warn)]',
  political: 'text-[var(--m-down)]',
}

function TeamBody() {
  return (
    <div className="space-y-3">
      {MOCK_DESKS.map(desk => (
        <div key={desk.symbol} className="rounded border border-[var(--m-border)] bg-[var(--m-surface-2)] overflow-hidden">
          <div className="px-2.5 py-1.5 flex items-center gap-2 border-b border-[var(--m-border)]">
            <span className="font-mono font-semibold text-[13px] text-[var(--m-text)]">{desk.symbol}</span>
            <Chip tone={desk.source === 'autopilot' ? 'up' : 'special'}>{desk.source.toUpperCase()}</Chip>
            <span className="text-[10px] text-[var(--m-muted)] ml-auto">{desk.account}</span>
          </div>
          <div className="divide-y divide-[var(--m-border)]">
            {desk.agents.map(a => (
              <div key={a.id} className="px-2.5 py-1.5 flex items-center gap-2 text-[12px]">
                <StatusDot status={a.status} />
                <span className="text-[14px] leading-none">{a.icon}</span>
                <span className={`font-medium w-32 truncate ${ROLE_COLORS[a.role] || ''}`}>{a.name}</span>
                <span className="text-[10px] text-[var(--m-muted)] uppercase w-16">{a.role}</span>
                <span className="ml-auto text-[11px] font-mono text-[var(--m-muted)]">
                  {a.status === 'active' && `${a.startedAt} · ${a.runningFor}`}
                  {a.status === 'waiting' && `next ${a.waitUntil}`}
                  {a.status === 'done' && `done ${a.finishedAt}`}
                  {a.status === 'scheduled' && a.startsAt}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// --- MARKET STATUS ---

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
          <Chip>XAUUSD · 14h 20m</Chip><Chip>EURUSD · 14h 20m</Chip><Chip>US500 · 1d 14h</Chip><Chip>GER40 · 14h 20m</Chip>
        </div>
      </div>
    </div>
  )
}

// --- TRADING ACCOUNT (positions) ---

function PositionsBody() {
  const positions = [
    { side: 'BUY', sym: 'BTCUSD', vol: '0.02 lot', entry: '64,120.50', sl: '63,500.00', slPip: '-62.1p', tp: '66,000.00', tpPip: '+188.0p', margin: '$128.24', age: '2h 14m', pnl: '+$142.30', swap: '$0.00', comm: '-$1.20', source: 'autopilot', account: 'Demo #8124930' },
    { side: 'SELL', sym: 'XAUUSD', vol: '0.01 lot (1.0 oz)', entry: '2,385.40', sl: '2,400.00', slPip: '-146.0p', tp: '2,360.00', tpPip: '+254.0p', margin: '$23.85', age: '45m', pnl: '-$18.50', swap: '-$0.32', comm: '-$0.80', source: 'autopilot', account: 'Demo #8124930' },
  ]
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-[var(--m-muted)]">
        <span>Balance: <span className="font-mono text-[var(--m-text)]">$10,482.30</span></span>
        <span>Equity: <span className="font-mono text-[var(--m-text)]">$10,606.10</span></span>
        <span>Free: <span className="font-mono text-[var(--m-text)]">$10,453.01</span></span>
        <span className="ml-auto">Demo #8124930</span>
      </div>
      {positions.map((p, i) => (
        <div key={i} className="rounded border border-[var(--m-border)] bg-[var(--m-surface-2)] p-2 space-y-1.5">
          <div className="flex items-center gap-2 text-[13px]">
            <span className={p.side === 'BUY' ? 'text-[var(--m-up)]' : 'text-[var(--m-down)]'}>{p.side === 'BUY' ? '▲' : '▼'}</span>
            <span className="font-semibold text-[var(--m-text)]">{p.sym}</span>
            <span className="text-[var(--m-muted)] font-mono text-[11px]">{p.vol}</span>
            <span className="text-[var(--m-muted)] font-mono text-[11px]">@ {p.entry}</span>
            <Chip tone={p.source === 'autopilot' ? 'up' : 'special'}>{p.source.toUpperCase()}</Chip>
            <span className={`ml-auto font-mono text-[13px] font-semibold ${p.pnl.startsWith('+') ? 'text-[var(--m-up)]' : 'text-[var(--m-down)]'}`}>
              Est. {p.pnl}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-x-3 gap-y-0.5 text-[10px] text-[var(--m-muted)] font-mono">
            <span>SL {p.sl} <span className="text-[var(--m-down)]">{p.slPip}</span></span>
            <span>TP {p.tp} <span className="text-[var(--m-up)]">{p.tpPip}</span></span>
            <span>Margin {p.margin}</span>
            <span>Opened {p.age} ago</span>
            <span>Swap {p.swap} · Comm {p.comm}</span>
            <span>{p.account}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

// --- SCAN FEED ---

function ScanBody() {
  const rows = [
    { sym: 'BTCUSD', grade: 'A', bias: 'long', conviction: '8/10', desk: 'Crypto Desk + NYC Desk', account: 'Demo #8124930', source: 'autopilot', note: 'Breakout above 64k · RSI rebound · 5/6 agents bullish', time: '14:20' },
    { sym: 'XAUUSD', grade: 'B', bias: 'short', conviction: '6/10', desk: 'Commodity Trader + London Desk', account: 'Demo #8124930', source: 'autopilot', note: 'Mean reversion · overbought on 4H · dissent from Inflation', time: '14:18' },
    { sym: 'ETHUSD', grade: 'B', bias: 'long', conviction: '5/10', desk: 'Crypto Desk + Sentiment', account: 'Demo #8124930', source: 'autopilot', note: 'Consolidation range · wait for volume breakout', time: '14:15' },
    { sym: 'EURUSD', grade: 'C', bias: 'neutral', conviction: '3/10', desk: 'FX Scalper + Frankfurt Desk', account: 'Demo #8124930', source: 'copilot', note: 'Choppy · ECB speech Mon · agents split — skip', time: '14:12' },
  ]
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="rounded border border-[var(--m-border)] bg-[var(--m-surface-2)] p-2 space-y-1">
          <div className="flex items-center gap-2 text-[12px]">
            <span className={`w-5 h-5 grid place-items-center rounded text-[10px] font-bold ${r.grade === 'A' ? 'bg-[var(--m-accent)] text-white' : 'bg-[var(--m-surface)] text-[var(--m-muted)] border border-[var(--m-border)]'}`}>{r.grade}</span>
            <span className="font-mono font-semibold text-[var(--m-text)] w-16">{r.sym}</span>
            <span className={`text-[11px] font-semibold ${r.bias === 'long' ? 'text-[var(--m-up)]' : r.bias === 'short' ? 'text-[var(--m-down)]' : 'text-[var(--m-muted)]'}`}>{r.bias.toUpperCase()}</span>
            <span className="text-[10px] text-[var(--m-muted)]">{r.conviction}</span>
            <Chip tone={r.source === 'autopilot' ? 'up' : 'special'}>{r.source.toUpperCase()}</Chip>
            <span className="ml-auto text-[10px] text-[var(--m-muted)] font-mono">{r.time}</span>
          </div>
          <div className="text-[11px] text-[var(--m-muted)]">{r.note}</div>
          <div className="text-[10px] text-[var(--m-muted)]">Desk: {r.desk} · {r.account}</div>
        </div>
      ))}
    </div>
  )
}

// --- PRICE ALERTS (TradingView-style) ---

const ALERT_CONDITIONS = ['Crossing', 'Crossing Up', 'Crossing Down', 'Greater Than', 'Less Than', 'Entering Channel', 'Exiting Channel', 'Inside Channel', 'Outside Channel', 'Moving Up', 'Moving Down', 'Moving Up %', 'Moving Down %']

function AlertsBody() {
  const alerts = [
    { sym: 'BTCUSD', indicator: 'Price', condition: 'Crossing Up', value: '65,000', interval: '1h', trigger: 'Once per bar close', setBy: 'AI', note: 'Breakout confirmation — above consolidation range', active: true },
    { sym: 'XAUUSD', indicator: 'ATR (14, SMA)', condition: 'Moving Down %', value: '15% in 10 bars', interval: '4h', trigger: 'Once per bar close', setBy: 'AI', note: 'Volatility contraction — squeeze setup', active: true },
    { sym: 'EURUSD', indicator: 'RSI (14)', condition: 'Less Than', value: '30', interval: '1h', trigger: 'Once per bar', setBy: 'Human', note: 'Oversold bounce — manual override from default 25', active: true },
    { sym: 'BTCUSD', indicator: 'Price', condition: 'Less Than', value: '62,500', interval: '15m', trigger: 'Every time', setBy: 'AI', note: 'Invalidation level — close position if breached', active: true },
    { sym: 'XAUUSD', indicator: 'Bollinger Band (20,2)', condition: 'Exiting Channel', value: 'Upper', interval: '4h', trigger: 'Once per bar close', setBy: 'AI', note: 'Mean reversion trigger', active: false },
  ]
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] uppercase tracking-wider text-[var(--m-muted)]">AI sets defaults · human can override</span>
        <span className="ml-auto text-[10px] text-[var(--m-muted)]">{alerts.filter(a => a.active).length} active</span>
      </div>
      {alerts.map((a, i) => (
        <div key={i} className={`rounded border p-2 space-y-1 ${a.active ? 'border-[var(--m-border)] bg-[var(--m-surface-2)]' : 'border-dashed border-[var(--m-border)] bg-[var(--m-surface)] opacity-50'}`}>
          <div className="flex items-center gap-2 text-[12px]">
            <span className="font-mono font-semibold text-[var(--m-text)]">{a.sym}</span>
            <span className="text-[var(--m-muted)]">{a.indicator}</span>
            <span className="font-medium text-[var(--m-accent)]">{a.condition}</span>
            <span className="font-mono text-[var(--m-text)]">{a.value}</span>
            <Chip tone={a.setBy === 'AI' ? 'up' : 'special'}>{a.setBy}</Chip>
            <span className={`ml-auto w-2 h-2 rounded-full ${a.active ? 'bg-[var(--m-up)]' : 'bg-[var(--m-muted)]'}`} />
          </div>
          <div className="flex items-center gap-3 text-[10px] text-[var(--m-muted)]">
            <span>Interval: {a.interval}</span>
            <span>Trigger: {a.trigger}</span>
          </div>
          <div className="text-[10px] text-[var(--m-muted)] italic">{a.note}</div>
        </div>
      ))}
      <div className="pt-1 text-[11px] text-[var(--m-muted)]">
        Conditions: {ALERT_CONDITIONS.join(' · ')}
      </div>
    </div>
  )
}

// --- ORDER ENTRY (uses present setup pattern) ---

function OrderBody() {
  const [side, setSide] = useState('BUY')
  return (
    <div className="space-y-2 text-[12px]">
      <div className="grid grid-cols-2 gap-1">
        <button onClick={() => setSide('BUY')} className={`h-8 rounded font-semibold text-[12px] ${side === 'BUY' ? 'bg-[var(--m-up)] text-white' : 'border border-[var(--m-border)] text-[var(--m-muted)]'}`}>BUY</button>
        <button onClick={() => setSide('SELL')} className={`h-8 rounded font-semibold text-[12px] ${side === 'SELL' ? 'bg-[var(--m-down)] text-white' : 'border border-[var(--m-border)] text-[var(--m-muted)]'}`}>SELL</button>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[var(--m-muted)]">Symbol</span>
          <span className="font-mono text-[var(--m-text)]">BTCUSD</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[var(--m-muted)]">Volume</span>
          <span className="font-mono text-[var(--m-text)]">0.02 lot</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[var(--m-muted)]">Type</span>
          <span className="font-mono text-[var(--m-text)]">Market</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[var(--m-muted)]">Stop-loss</span>
          <span className="font-mono text-[var(--m-text)]">63,500 (-62.1p)</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[var(--m-muted)]">Take-profit</span>
          <span className="font-mono text-[var(--m-text)]">66,000 (+188.0p)</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[var(--m-muted)]">Risk</span>
          <span className="font-mono text-[var(--m-text)]">$25.00 / 0.24%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[var(--m-muted)]">R:R</span>
          <span className="font-mono text-[var(--m-text)]">1 : 3.03</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[var(--m-muted)]">Strategy</span>
          <span className="text-[var(--m-text)]">Momentum breakout</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[var(--m-muted)]">Account</span>
          <span className="text-[var(--m-muted)] text-[11px]">Demo #8124930</span>
        </div>
      </div>
      <div className="flex gap-1 pt-1">
        <Chip tone="up">AUTOPILOT</Chip>
        <span className="text-[10px] text-[var(--m-muted)] self-center">AI-placed · human can override before confirm</span>
      </div>
      <button className={`w-full h-9 rounded font-semibold text-[13px] text-white ${side === 'BUY' ? 'bg-[var(--m-up)]' : 'bg-[var(--m-down)]'}`}>
        Confirm {side} 0.02 BTCUSD
      </button>
    </div>
  )
}

// --- HISTORY (desk/agent/account detail) ---

function HistoryBody() {
  const rows = [
    { time: '14:22', action: 'OPEN', sym: 'BTCUSD', detail: 'BUY 0.02 @ 64,120.50', pnl: null, desk: 'Crypto Desk + NYC Desk', account: 'Demo #8124930', source: 'autopilot' },
    { time: '13:40', action: 'CLOSE', sym: 'ETHUSD', detail: 'SELL 0.05 @ 3,210.00', pnl: '+$32.40', desk: 'Crypto Desk + Sentiment', account: 'Demo #8124930', source: 'autopilot' },
    { time: '12:05', action: 'SL HIT', sym: 'GBPUSD', detail: 'SELL 0.10 @ 1.2640', pnl: '-$18.20', desk: 'FX Scalper + London Desk', account: 'Demo #8124930', source: 'copilot' },
    { time: '11:30', action: 'TP HIT', sym: 'US500', detail: 'BUY 0.01 @ 5,280.50', pnl: '+$45.00', desk: 'Index Arb + NYC Desk', account: 'Demo #8124930', source: 'autopilot' },
    { time: '10:15', action: 'CANCEL', sym: 'XAUUSD', detail: 'Limit SELL 0.01 @ 2,410.00', pnl: null, desk: 'Commodity Trader', account: 'Demo #8124930', source: 'autopilot' },
    { time: '09:45', action: 'MODIFY', sym: 'BTCUSD', detail: 'SL moved 62,800 → 63,500', pnl: null, desk: 'Crypto Desk', account: 'Demo #8124930', source: 'autopilot' },
  ]
  const actionColor = (a) => {
    if (a === 'OPEN' || a === 'TP HIT') return 'text-[var(--m-up)]'
    if (a === 'SL HIT' || a === 'CLOSE') return 'text-[var(--m-down)]'
    return 'text-[var(--m-muted)]'
  }
  return (
    <div className="space-y-1">
      {rows.map((r, i) => (
        <div key={i} className="rounded border border-[var(--m-border)] bg-[var(--m-surface-2)] px-2 py-1.5 space-y-0.5">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="font-mono text-[10px] text-[var(--m-muted)] w-10">{r.time}</span>
            <span className={`font-semibold text-[11px] w-14 ${actionColor(r.action)}`}>{r.action}</span>
            <span className="font-mono font-semibold text-[var(--m-text)]">{r.sym}</span>
            <span className="text-[var(--m-muted)] text-[11px] truncate">{r.detail}</span>
            {r.pnl && <span className={`ml-auto font-mono font-semibold text-[12px] ${r.pnl.startsWith('+') ? 'text-[var(--m-up)]' : 'text-[var(--m-down)]'}`}>{r.pnl}</span>}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-[var(--m-muted)]">
            <span>Desk: {r.desk}</span>
            <Chip tone={r.source === 'autopilot' ? 'up' : 'special'}>{r.source.toUpperCase()}</Chip>
            <span className="ml-auto">{r.account}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

// --- ACTIVITY LOG ---

function ActivityBody() {
  const rows = [
    ['14:22:08', 'scan',    'BTCUSD grade A · dispatched 6 agents · Crypto Desk lead'],
    ['14:22:01', 'trade',   'BUY BTCUSD 0.02 @ 64,120.50 · autopilot · Demo #8124930'],
    ['14:21:55', 'analyse', 'XAUUSD · mean-reversion setup · 4/6 agents bearish'],
    ['14:21:40', 'loop',    'cycle 47 start · 8 symbols · Demo #8124930'],
    ['14:20:12', 'monitor', 'BTCUSD position OK · PnL +$142 · SL intact'],
    ['14:19:30', 'alert',   'BTCUSD crossed 64,000 · AI alert triggered'],
  ]
  return (
    <div className="space-y-0.5 text-[11px] font-mono">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <span className="text-[var(--m-muted)] w-16 shrink-0">{r[0]}</span>
          <span className="text-[var(--m-accent)] w-14 shrink-0">{r[1]}</span>
          <span className="text-[var(--m-text)]">{r[2]}</span>
        </div>
      ))}
    </div>
  )
}

const BODIES = {
  team: TeamBody, market: MarketBody, positions: PositionsBody, scan: ScanBody,
  alerts: AlertsBody, order: OrderBody, history: HistoryBody, activity: ActivityBody,
}

// --- Panel frame ---

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
      <header className="shrink-0 h-8 px-2 flex items-center gap-2 border-b border-[var(--m-border)] bg-[var(--m-surface-2)] cursor-move select-none">
        <span className="text-[var(--m-muted)] text-[10px] tracking-wider">⋮⋮</span>
        <span className="text-[12px] font-semibold text-[var(--m-text)] flex-1 truncate">{title}</span>
        <div className="flex items-center gap-0.5 text-[11px]">
          {['S','M','L'].map(s => (
            <button key={s} onClick={() => onResize(index, s)}
              className={`w-5 h-5 rounded ${entry.size === s ? 'bg-[var(--m-accent)] text-white' : 'text-[var(--m-muted)] hover:bg-[var(--m-accent-soft)] hover:text-[var(--m-accent)]'}`}
              title={`Size ${s}`}>{s}</button>
          ))}
          <button onClick={() => onToggle(index)}
            className="w-5 h-5 rounded text-[var(--m-muted)] hover:bg-[var(--m-accent-soft)] hover:text-[var(--m-accent)]"
            title={entry.collapsed ? 'Expand' : 'Collapse'}>{entry.collapsed ? '▸' : '▾'}</button>
        </div>
      </header>
      {!entry.collapsed && <div className="p-2.5 flex-1 min-h-0">{children}</div>}
    </section>
  )
}

// --- Theme toggle ---

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
        <button key={opt.id} onClick={() => setTheme(opt.id)}
          className={`h-7 px-2 rounded text-[12px] flex items-center gap-1 ${theme === opt.id ? 'bg-[var(--m-accent)] text-white' : 'text-[var(--m-muted)] hover:text-[var(--m-text)]'}`}
          title={opt.label}>
          <span className="text-[14px] leading-none">{opt.icon}</span>
          <span className="hidden sm:inline">{opt.label}</span>
        </button>
      ))}
    </div>
  )
}

// --- Page export ---

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
  const onReset  = () => { localStorage.removeItem(LAYOUT_KEY); setLayout(DEFAULT_LAYOUT) }

  return (
    <div style={themeVars} className="min-h-[80vh] -mx-[var(--content-pad)] -my-6 px-4 py-4 bg-[var(--m-bg)] text-[var(--m-text)]">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div>
          <div className="text-[16px] font-semibold text-[var(--m-text)]">Panel Layout Preview</div>
          <div className="text-[11px] text-[var(--m-muted)]">Drag headers to reorder · S/M/L sets width · ▾ collapses · layout persists</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={onReset} className="h-7 px-2 rounded border border-[var(--m-border)] text-[12px] text-[var(--m-muted)] hover:text-[var(--m-text)]">Reset</button>
          <ThemeToggle theme={theme} setTheme={setTheme} />
        </div>
      </div>
      <div className="grid grid-cols-12 gap-2 auto-rows-min">
        {layout.map((entry, i) => {
          const def = PANELS.find(p => p.id === entry.id)
          if (!def) return null
          const Body = BODIES[entry.id]
          return (
            <PanelFrame key={entry.id} entry={entry} index={i} title={def.title}
              onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}
              onResize={onResize} onToggle={onToggle}>
              <Body />
            </PanelFrame>
          )
        })}
      </div>
    </div>
  )
}
