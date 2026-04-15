import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import Feed from './pages/Feed.jsx'
import Settings from './pages/Settings.jsx'
import Vault from './pages/Vault.jsx'
import Backtest from './pages/Backtest.jsx'
import LinkUp from './pages/LinkUp.jsx'
import Button from './components/common/Button.jsx'
import { useTheme, THEMES } from './lib/theme.js'

// Top-level shell. Minimal nav + theme switcher.
// Accessibility: blue = up/long/positive, red = down/short/negative, NO GREEN.

const navLinks = [
  { to: '/feed', label: 'Feed' },
  { to: '/settings', label: 'Settings' },
  { to: '/vault', label: 'Vault' },
  { to: '/backtest', label: 'Backtest' },
]

function linkClass({ isActive }) {
  const base = 'px-3 py-2 text-sm font-medium rounded'
  return isActive
    ? `${base} bg-[var(--color-up)] text-white`
    : `${base} text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface)]`
}

function ThemeSwitcher() {
  const { theme, setTheme } = useTheme()
  return (
    <div className="ml-auto flex gap-1" role="group" aria-label="Theme">
      {THEMES.map(t => (
        <Button
          key={t}
          variant={theme === t ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => setTheme(t)}
          aria-pressed={theme === t}
        >
          {t}
        </Button>
      ))}
    </div>
  )
}

export default function App() {
  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-fg)]">
      <header className="border-b border-[var(--color-border)]">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-2">
          <span className="font-semibold text-base mr-4">bot-trade</span>
          <nav className="flex gap-1">
            {navLinks.map(l => (
              <NavLink key={l.to} to={l.to} className={linkClass}>
                {l.label}
              </NavLink>
            ))}
          </nav>
          <ThemeSwitcher />
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/feed" replace />} />
          <Route path="/feed" element={<Feed />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/vault" element={<Vault />} />
          <Route path="/backtest" element={<Backtest />} />
          <Route path="/link-up" element={<LinkUp />} />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Routes>
      </main>
    </div>
  )
}
