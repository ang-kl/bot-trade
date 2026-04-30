import { useEffect } from 'react'
import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom'
import useTokenRefresh from './lib/use-token-refresh.js'
import Feed from './pages/Feed.jsx'
import Alert from './pages/Alert.jsx'
import Settings from './pages/Settings.jsx'
import LinkUp from './pages/LinkUp.jsx'
import Admin from './pages/Admin.jsx'
import Watchlist from './pages/Watchlist.jsx'
import MarketSessionBar from './components/MarketSessionBar.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { useTheme } from './lib/theme.js'

const navLinks = [
  { to: '/watchlist', label: 'Watchlist' },
  { to: '/advisory', label: 'Advisory' },
  { to: '/alert', label: 'Alert' },
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

const THEME_CYCLE = { system: 'light', light: 'dark', dark: 'sepia', sepia: 'system' }
const THEME_ICON = { system: '◐', light: '☀', dark: '☾', sepia: '☕' }

export default function App() {
  useTokenRefresh()
  const { theme, setTheme } = useTheme()
  const { pathname } = useLocation()
  return (
    <div className="h-[100svh] flex flex-col bg-[var(--color-bg)] text-[var(--color-text)]" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <ScrollToTop />
      {/* Sticky top chrome — header + session bar never scroll */}
      <div className="shrink-0 z-30 bg-[var(--color-surface)]">
        <header className="border-b-2 border-[var(--color-accent)]">
          <div style={{ maxWidth: 'var(--content-max)', padding: '0 var(--content-pad)' }} className="mx-auto h-14 flex items-center gap-2">
            <span className="t-body font-bold mr-2 sm:mr-4 shrink-0">bot-trade</span>
            <button
              type="button"
              onClick={() => setTheme(THEME_CYCLE[theme] || 'system')}
              className="w-7 h-7 rounded-[5px] text-[14px] text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-accent-soft)] shrink-0"
              title={`Theme: ${theme}`}
            >{THEME_ICON[theme] || '◐'}</button>
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
          <ErrorBoundary key={pathname}>
            <Routes>
              <Route path="/" element={<Navigate to="/watchlist" replace />} />
              <Route path="/watchlist" element={<Watchlist />} />
              <Route path="/advisory" element={<Feed />} />
              <Route path="/feed" element={<Navigate to="/advisory" replace />} />
              <Route path="/alert" element={<Alert />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="/link-up" element={<LinkUp />} />
              <Route path="*" element={<Navigate to="/watchlist" replace />} />
            </Routes>
          </ErrorBoundary>
        </div>
      </main>

    </div>
  )
}
