/* global __APP_VERSION__ */
import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom'
import { getAgentConn, agentConfigured } from './lib/agent-api.js'

// Global agent watchdog — the connection is saved once per device
// (localStorage), so the only thing the user ever needs to know is when
// the agent stops answering. Polls the public /health every 30s and shows
// a red banner on EVERY tab while it's down.
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
    <div role="alert" className="mx-auto max-w-5xl px-4 pt-3">
      <div className="rounded-[12px] border-2 border-[var(--color-down)] bg-[var(--color-down)]/10 px-4 py-2 text-[13px] font-semibold">
        ⚠ Agent unreachable — the bot is NOT scanning, trading, or protecting positions right now.
        Check that the Railway service is up, then <NavLink to="/connect" className="underline">test the connection</NavLink>.
      </div>
    </div>
  )
}
import Monitor from './pages/Monitor.jsx'
import Trade from './pages/Trade.jsx'
import Accounts from './pages/Accounts.jsx'
import Tune from './pages/Tune.jsx'
import Connect from './pages/Connect.jsx'
import { useTheme } from './lib/theme.js'

const THEME_CYCLE = { system: 'light', light: 'dark', dark: 'system' }
const THEME_ICON = { system: '◐', light: '☀', dark: '☾' }

const TABS = [
  { to: '/monitor', label: 'Monitor', icon: '👁️' },
  { to: '/trade', label: 'Trade', icon: '📈' },
  { to: '/accounts', label: 'Accounts', icon: '💼' },
  { to: '/tune', label: 'Tune', icon: '⚙️' },
  { to: '/connect', label: 'Connect', icon: '🔗' },
]

export default function App() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="min-h-screen text-[var(--color-text)]">
      <header className="sticky top-3 z-50 mx-auto max-w-5xl px-3">
        <div className="glass-bar flex items-center gap-3 rounded-full px-4 py-2 overflow-x-auto scrollbar-none">
          <span className="text-[14px] font-extrabold tracking-tight bg-[linear-gradient(90deg,var(--color-accent),#a855f7,var(--color-accent))] bg-clip-text text-transparent shrink-0">
            bot-trade
          </span>
          <span className="text-[11px] text-[var(--color-text-sub)] shrink-0" title="App version">v{__APP_VERSION__}</span>
          <nav className="flex gap-1" id="main-content">
            {TABS.map(t => (
              <NavLink
                key={t.to}
                to={t.to}
                className={({ isActive }) =>
                  `folio-tab rounded-[12px] px-3.5 py-1.5 text-[13px] font-semibold min-h-[36px] inline-flex items-center gap-1.5 transition-all ${
                    isActive
                      ? 'text-white bg-[linear-gradient(135deg,var(--color-accent),color-mix(in_srgb,var(--color-accent)_60%,#a855f7))] shadow-[var(--glow-accent)]'
                      : 'glass-inset text-[var(--color-text-sub)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)]'
                  }`
                }
              ><span aria-hidden="true" className="text-[14px] leading-none">{t.icon}</span>{t.label}</NavLink>
            ))}
          </nav>
          <button
            type="button"
            onClick={() => setTheme(THEME_CYCLE[theme] || 'system')}
            title={`Theme: ${theme}`}
            className="ml-auto glass-inset rounded-full px-2.5 py-1 text-[14px] cursor-pointer hover:shadow-[var(--glow-accent)] shrink-0"
          >{THEME_ICON[theme] || '◐'}</button>
        </div>
      </header>

      <AgentDownBanner />

      <main className="mx-auto max-w-5xl px-4 py-5">
        <Routes>
          <Route path="/" element={<Navigate to="/monitor" replace />} />
          <Route path="/monitor" element={<Monitor />} />
          <Route path="/trade" element={<Trade />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/tune" element={<Tune />} />
          <Route path="/connect" element={<Connect />} />
          {/* Spotware OAuth redirect URI (registered on the cTrader app) */}
          <Route path="/link-up" element={<Connect />} />
          <Route path="*" element={<Navigate to="/monitor" replace />} />
        </Routes>
      </main>
    </div>
  )
}
