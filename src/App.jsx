import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import Feed from './pages/Feed.jsx'
import Settings from './pages/Settings.jsx'
import Vault from './pages/Vault.jsx'
import Backtest from './pages/Backtest.jsx'

// Top-level shell. Minimal nav; real design system arrives in Phase 3.
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
    ? `${base} bg-[#2563eb] text-white`
    : `${base} text-neutral-700 hover:bg-neutral-100`
}

export default function App() {
  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="border-b border-neutral-200">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center gap-2">
          <span className="font-semibold text-base mr-4">bot-trade</span>
          <nav className="flex gap-1">
            {navLinks.map(l => (
              <NavLink key={l.to} to={l.to} className={linkClass}>
                {l.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/feed" replace />} />
          <Route path="/feed" element={<Feed />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/vault" element={<Vault />} />
          <Route path="/backtest" element={<Backtest />} />
          <Route path="*" element={<Navigate to="/feed" replace />} />
        </Routes>
      </main>
    </div>
  )
}
