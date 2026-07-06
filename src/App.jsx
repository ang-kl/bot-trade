/* global __APP_VERSION__ */
import { useEffect } from 'react'
import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom'
import { initLiquidGlass, refreshLiquidGlass } from './lib/liquid-glass.js'
import Trade from './pages/Trade.jsx'
import Accounts from './pages/Accounts.jsx'
import Tune from './pages/Tune.jsx'
import Connect from './pages/Connect.jsx'
import { useTheme } from './lib/theme.js'

const THEME_CYCLE = { system: 'light', light: 'dark', dark: 'system' }
const THEME_ICON = { system: '◐', light: '☀', dark: '☾' }

const TABS = [
  { to: '/trade', label: 'Trade' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/tune', label: 'Tune' },
  { to: '/connect', label: 'Connect' },
]

export default function App() {
  const { theme, setTheme } = useTheme()
  const location = useLocation()

  // WebGL liquid-glass refraction on the header bar (progressive enhancement;
  // no-op on mobile / reduced motion / no WebGL — CSS glass remains).
  useEffect(() => { initLiquidGlass('.glass-bar') }, [])
  // The effect refracts a page snapshot — refresh it when what's behind the
  // bar changes: navigation, theme switch, and shortly after data loads.
  useEffect(() => { refreshLiquidGlass(600) }, [location.pathname, theme])

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
                  `rounded-full px-3.5 py-1.5 text-[13px] font-semibold min-h-[36px] inline-flex items-center transition-all ${
                    isActive
                      ? 'text-white bg-[linear-gradient(135deg,var(--color-accent),color-mix(in_srgb,var(--color-accent)_60%,#a855f7))] shadow-[var(--glow-accent)]'
                      : 'text-[var(--color-text-sub)] hover:text-[var(--color-text)] hover:bg-[var(--color-accent-soft)]'
                  }`
                }
              >{t.label}</NavLink>
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

      <main className="mx-auto max-w-5xl px-4 py-5">
        <Routes>
          <Route path="/" element={<Navigate to="/trade" replace />} />
          <Route path="/trade" element={<Trade />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/tune" element={<Tune />} />
          <Route path="/connect" element={<Connect />} />
          {/* Spotware OAuth redirect URI (registered on the cTrader app) */}
          <Route path="/link-up" element={<Connect />} />
          <Route path="*" element={<Navigate to="/trade" replace />} />
        </Routes>
      </main>
    </div>
  )
}
