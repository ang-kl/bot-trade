import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import Trade from './pages/Trade.jsx'
import Tune from './pages/Tune.jsx'
import Connect from './pages/Connect.jsx'
import { useTheme } from './lib/theme.js'

const THEME_CYCLE = { system: 'light', light: 'dark', dark: 'system' }
const THEME_ICON = { system: '◐', light: '☀', dark: '☾' }

const TABS = [
  { to: '/trade', label: 'Trade' },
  { to: '/tune', label: 'Tune' },
  { to: '/connect', label: 'Connect' },
]

export default function App() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-2.5">
          <span className="text-[14px] font-bold tracking-tight">bot-trade</span>
          <nav className="flex gap-1" id="main-content">
            {TABS.map(t => (
              <NavLink
                key={t.to}
                to={t.to}
                className={({ isActive }) =>
                  `rounded-[7px] px-3 py-1.5 text-[13px] font-semibold min-h-[36px] inline-flex items-center ${
                    isActive
                      ? 'bg-[var(--color-accent)] text-white'
                      : 'text-[var(--color-text-sub)] hover:bg-[var(--color-accent-soft)]'
                  }`
                }
              >{t.label}</NavLink>
            ))}
          </nav>
          <button
            type="button"
            onClick={() => setTheme(THEME_CYCLE[theme] || 'system')}
            title={`Theme: ${theme}`}
            className="ml-auto rounded-[7px] border border-[var(--color-border)] px-2.5 py-1 text-[14px] cursor-pointer hover:bg-[var(--color-accent-soft)]"
          >{THEME_ICON[theme] || '◐'}</button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-4">
        <Routes>
          <Route path="/" element={<Navigate to="/trade" replace />} />
          <Route path="/trade" element={<Trade />} />
          <Route path="/tune" element={<Tune />} />
          <Route path="/connect" element={<Connect />} />
          <Route path="*" element={<Navigate to="/trade" replace />} />
        </Routes>
      </main>
    </div>
  )
}
