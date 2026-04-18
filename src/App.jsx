import { useEffect } from 'react'
import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom'
import useTokenRefresh from './lib/use-token-refresh.js'
import Feed from './pages/Feed.jsx'
import Alert from './pages/Alert.jsx'
import Settings from './pages/Settings.jsx'
import Vault from './pages/Vault.jsx'
import Backtest from './pages/Backtest.jsx'
import LinkUp from './pages/LinkUp.jsx'
import Admin from './pages/Admin.jsx'
import Watchlist from './pages/Watchlist.jsx'
import AgentPage from './pages/Agent.jsx'
import Workshop from './pages/Workshop.jsx'
import MarketSessionBar from './components/MarketSessionBar.jsx'
import StatusRibbon from './components/StatusRibbon.jsx'

// Top-level shell. Single-theme, playbook-canonical palette.
// No green anywhere - blue = up/long/positive, red = down/short/negative.

const navLinks = [
  { to: '/agent', label: 'Agent' },
  { to: '/workshop', label: 'Workshop' },
  { to: '/feed', label: 'Feed' },
  { to: '/watchlist', label: 'Watchlist' },
  { to: '/alert', label: 'Alert' },
  { to: '/settings', label: 'Settings' },
  { to: '/vault', label: 'Vault' },
  { to: '/backtest', label: 'Backtest' },
  { to: '/admin', label: 'Admin' },
]

// Scroll to top on route change
function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return null
}

function linkClass({ isActive }) {
  const base = 'px-2 sm:px-3 py-2 text-[12px] sm:text-[13px] font-bold rounded-[7px] whitespace-nowrap'
  return isActive
    ? `${base} border-b-[3px] border-[var(--color-accent)] text-[var(--color-accent)]`
    : `${base} text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-accent-soft)]`
}

export default function App() {
  useTokenRefresh()
  return (
    <div className="h-[100svh] flex flex-col bg-[var(--color-bg)] text-[var(--color-text)]" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <ScrollToTop />
      {/* Sticky top chrome — header + session bar never scroll */}
      <div className="shrink-0 z-30 bg-[var(--color-surface)]">
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
      </div>

      {/* Scrollable content — only this area scrolls. `min-h-0` lets the
          flex child honour its overflow on browsers that otherwise compute
          min-height: auto and push the whole page to scroll. */}
      <main
        id="main-content"
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ overflowAnchor: 'none' }}
      >
        <div style={{ maxWidth: 'var(--content-max)', padding: '24px var(--content-pad)' }} className="mx-auto">
          <Routes>
            <Route path="/" element={<Navigate to="/agent" replace />} />
            <Route path="/agent" element={<AgentPage />} />
            <Route path="/workshop" element={<Workshop />} />
            <Route path="/feed" element={<Feed />} />
            <Route path="/watchlist" element={<Watchlist />} />
            <Route path="/alert" element={<Alert />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/vault" element={<Vault />} />
            <Route path="/backtest" element={<Backtest />} />
            <Route path="/admin" element={<Admin />} />
            <Route path="/link-up" element={<LinkUp />} />
            <Route path="*" element={<Navigate to="/agent" replace />} />
          </Routes>
        </div>
      </main>

      {/* Persistent status ribbon — autopilot + positions + last scan */}
      <StatusRibbon />
    </div>
  )
}
