/* global __APP_VERSION__ */
import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom'
import { getAgentConn, agentConfigured } from './lib/agent-api.js'
import Monitor from './pages/Monitor.jsx'
import Desk from './pages/Desk.jsx'
import Trade from './pages/Trade.jsx'
import Accounts from './pages/Accounts.jsx'
import Tune from './pages/Tune.jsx'
import Connect from './pages/Connect.jsx'
import AccountSwitcher from './components/AccountSwitcher.jsx'
import { useTheme } from './lib/theme.js'

const THEME_CYCLE = { system: 'light', light: 'dark', dark: 'system' }
const THEME_ICON = { system: '◐', light: '☀', dark: '☾' }

// Grouped left navigation (desktop) — compliance-dashboard style.
const NAV_GROUPS = [
  { title: 'Overview', items: [{ to: '/desk', label: 'Desk', icon: '🖥️' }, { to: '/monitor', label: 'Monitor', icon: '👁️' }] },
  {
    title: 'Trading',
    items: [
      { to: '/trade', label: 'Trade', icon: '📈' },
      { to: '/accounts', label: 'Accounts', icon: '💼' },
    ],
  },
  {
    title: 'Setup',
    items: [
      { to: '/tune', label: 'Tune', icon: '⚙️' },
      { to: '/connect', label: 'Connect', icon: '🔗' },
    ],
  },
]
const ALL_TABS = NAV_GROUPS.flatMap(g => g.items)

// Global agent watchdog — the connection is saved once per device
// (localStorage); this banner is the loud signal when the agent stops
// answering. Polls the public /health every 30s, shows on every page.
function AgentDownBanner() {
  const [down, setDown] = useState(false)
  const location = useLocation()
  useEffect(() => {
    if (!agentConfigured()) return undefined
    let dead = false
    const check = async () => {
      try {
        const c = getAgentConn()
        const res = await fetch(`${c.base}/health`, { signal: AbortSignal.timeout(8000) })
        if (!dead) setDown(!res.ok)
      } catch {
        if (!dead) setDown(true)
      }
    }
    check()
    const t = setInterval(check, 30_000)
    return () => { dead = true; clearInterval(t) }
  }, [])
  if (!down || location.pathname === '/connect' || location.pathname === '/link-up') return null
  return (
    <div role="alert" className="px-4 pt-3">
      <div className="rounded-[12px] border-2 border-[var(--color-down)] bg-[var(--color-down)]/10 px-4 py-2 text-[13px] font-semibold">
        ⚠ Agent unreachable — the bot is NOT scanning, trading, or protecting positions right now.
        Check that the Railway service is up, then <NavLink to="/connect" className="underline">test the connection</NavLink>.
      </div>
    </div>
  )
}

function navLinkClasses(isActive) {
  return `rounded-[10px] px-3 py-2 text-[13px] font-semibold inline-flex items-center gap-2 transition-all w-full ${
    isActive
      ? 'text-white bg-[linear-gradient(135deg,var(--color-accent),color-mix(in_srgb,var(--color-accent)_60%,#a855f7))] shadow-[var(--glow-accent)]'
      : 'text-[var(--color-text-sub)] hover:text-[var(--color-text)] hover:bg-[var(--color-accent-soft)]'
  }`
}

export default function App() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="min-h-screen text-[var(--color-text)] lg:flex">
      {/* Left sidebar — desktop */}
      <aside className="hidden lg:flex lg:flex-col lg:w-56 lg:shrink-0 lg:h-screen lg:sticky lg:top-0 p-4">
        <div className="glass-panel rounded-[16px] p-4 flex flex-col h-full">
          <div className="flex items-baseline gap-2 mb-4">
            <span className="text-[15px] font-extrabold tracking-tight bg-[linear-gradient(90deg,var(--color-accent),#a855f7,var(--color-accent))] bg-clip-text text-transparent">bot-trade</span>
            <span className="text-[11px] text-[var(--color-text-sub)]" title="App version">v{__APP_VERSION__}</span>
          </div>
          <nav className="flex flex-col gap-4" id="main-content">
            {NAV_GROUPS.map(g => (
              <div key={g.title}>
                <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-sub)]">{g.title}</div>
                <div className="flex flex-col gap-0.5">
                  {g.items.map(t => (
                    <NavLink key={t.to} to={t.to} className={({ isActive }) => navLinkClasses(isActive)}>
                      <span aria-hidden="true" className="text-[14px] leading-none">{t.icon}</span>{t.label}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
            <AccountSwitcher />
          </nav>
          <button
            type="button"
            onClick={() => setTheme(THEME_CYCLE[theme] || 'system')}
            title={`Theme: ${theme}`}
            className="mt-auto glass-inset rounded-[10px] px-3 py-2 text-[13px] cursor-pointer hover:shadow-[var(--glow-accent)] text-left"
          >{THEME_ICON[theme] || '◐'} Theme: {theme}</button>
        </div>
      </aside>

      <div className="flex-1 min-w-0">
        {/* Top bar — mobile/tablet only */}
        <header className="sticky top-3 z-50 px-3 lg:hidden">
          <div className="glass-bar flex items-center gap-3 rounded-full px-4 py-2 overflow-x-auto scrollbar-none">
            <span className="text-[14px] font-extrabold tracking-tight bg-[linear-gradient(90deg,var(--color-accent),#a855f7,var(--color-accent))] bg-clip-text text-transparent shrink-0">
              bot-trade
            </span>
            <span className="text-[11px] text-[var(--color-text-sub)] shrink-0" title="App version">v{__APP_VERSION__}</span>
            <nav className="flex gap-1">
              {ALL_TABS.map(t => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  className={({ isActive }) =>
                    `rounded-[12px] px-3 py-1.5 text-[13px] font-semibold min-h-[36px] inline-flex items-center gap-1.5 transition-all shrink-0 ${
                      isActive
                        ? 'text-white bg-[linear-gradient(135deg,var(--color-accent),color-mix(in_srgb,var(--color-accent)_60%,#a855f7))] shadow-[var(--glow-accent)]'
                        : 'glass-inset text-[var(--color-text-sub)]'
                    }`
                  }
                ><span aria-hidden="true" className="text-[14px] leading-none">{t.icon}</span>{t.label}</NavLink>
              ))}
            </nav>
            <button
              type="button"
              onClick={() => setTheme(THEME_CYCLE[theme] || 'system')}
              title={`Theme: ${theme}`}
              className="ml-auto glass-inset rounded-full px-2.5 py-1 text-[14px] cursor-pointer shrink-0"
            >{THEME_ICON[theme] || '◐'}</button>
          </div>
        </header>

        <AgentDownBanner />

        <main className="px-4 py-5 lg:pr-6 max-w-[1720px]">
          <Routes>
            <Route path="/" element={<Navigate to="/monitor" replace />} />
            <Route path="/desk" element={<Desk />} />
            <Route path="/monitor" element={<Monitor />} />
            <Route path="/trade" element={<Trade />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/tune" element={<Tune />} />
            <Route path="/connect" element={<Connect />} />
            {/* Spotware OAuth redirect URI (registered on the cTrader app) */}
            <Route path="/link-up" element={<Connect />} />
            <Route path="*" element={<Navigate to="/monitor" replace />} />
          </Routes>
          <footer className="mt-8 pt-4 border-t border-[var(--color-border)] text-[12px] text-[var(--color-text-sub)] flex flex-wrap gap-x-4 gap-y-1">
            <span>bot-trade v{__APP_VERSION__}</span>
            <span>fib 61.8% strategy · deterministic, no LLM in trade decisions</span>
            <span>trading involves risk — demo first, never money you can't lose</span>
          </footer>
        </main>
      </div>
    </div>
  )
}
