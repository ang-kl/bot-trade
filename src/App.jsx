import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import Feed from './pages/Feed.jsx'
import Alert from './pages/Alert.jsx'
import Settings from './pages/Settings.jsx'
import Vault from './pages/Vault.jsx'
import Backtest from './pages/Backtest.jsx'
import LinkUp from './pages/LinkUp.jsx'
import MarketSessionBar from './components/MarketSessionBar.jsx'

// Top-level shell. Single-theme, playbook-canonical palette.
// No green anywhere - blue = up/long/positive, red = down/short/negative.

const navLinks = [
  { to: '/feed', label: 'Feed' },
  { to: '/alert', label: 'Alert' },
  { to: '/settings', label: 'Settings' },
  { to: '/vault', label: 'Vault' },
  { to: '/backtest', label: 'Backtest' },
]

function linkClass({ isActive }) {
  const base = 'px-2 sm:px-3 py-2 text-[12px] sm:text-[13px] font-bold rounded-[7px] whitespace-nowrap'
  return isActive
    ? `${base} border-b-[3px] border-[var(--color-accent)] text-[var(--color-accent)]`
    : `${base} text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-accent-soft)]`
}

export default function App() {
  return (
    <div className="min-h-[100svh] bg-[var(--color-bg)] text-[var(--color-text)]" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <header className="border-b-2 border-[var(--color-accent)]">
        <div style={{ maxWidth: 'var(--content-max)', padding: '0 var(--content-pad)' }} className="mx-auto h-14 flex items-center gap-2">
          <span className="t-body font-bold mr-2 sm:mr-4 shrink-0">bot-trade</span>
          <nav aria-label="Main navigation" className="flex gap-0.5 sm:gap-1 overflow-x-auto scrollbar-none">
            {navLinks.map(l => (
              <NavLink key={l.to} to={l.to} className={linkClass}>
                {l.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <MarketSessionBar />
      <main id="main-content" style={{ maxWidth: 'var(--content-max)', padding: '24px var(--content-pad)' }} className="mx-auto">
        <Routes>
          <Route path="/" element={<Navigate to="/feed" replace />} />
          <Route path="/feed" element={<Feed />} />
          <Route path="/alert" element={<Alert />} />
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
