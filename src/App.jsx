/* global __APP_VERSION__, __GIT_COMMIT__ */
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { boundPosition } from './cockpit/cockpit-nav.js'

// Trade Cockpit (design_handoff_trading_dashboard) — lazy so the heavy modal
// and GSAP never load until a ?trade=<positionId> deep link or symbol click.
const TradeCockpit = lazy(() => import('./cockpit/TradeCockpit.jsx'))


function CockpitHost() {
  const [params, setParams] = useState(() => new URLSearchParams(window.location.search))
  useEffect(() => {
    const f = () => setParams(new URLSearchParams(window.location.search))
    window.addEventListener('popstate', f)
    return () => window.removeEventListener('popstate', f)
  }, [])
  const trade = params.get('trade')
  if (!trade) return null
  // Broker facts handed over by the surface that was clicked (see
  // cockpit-nav.bindPosition). Absent on a cold deep link — the cockpit then
  // states that its values are demo rather than implying they are live.
  const bound = boundPosition(trade)
  const close = () => {
    const url = new URL(window.location.href)
    url.searchParams.delete('trade')
    window.history.pushState({}, '', url)
    setParams(new URLSearchParams(window.location.search))
  }
  return (
    <Suspense fallback={null}>
      <TradeCockpit
        onClose={close}
        tradeId={trade}
        position={bound}
        positionState={params.get('state') === 'closed' ? 'closed' : 'open'}
        sessionState={params.get('session') || 'open'}
        variant={params.get('variant') || undefined}
        feedBlocked={params.get('feed') === 'blocked'}
      />
    </Suspense>
  )
}
import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom'
import { getAgentConn, agentConfigured, sendClientPing } from './lib/agent-api.js'
// Owner (2026-07-28): "can you not load the other pages first except the
// performance" — Performance is the landing page and stays in the main
// bundle; every other page is code-split and only downloads (and only
// starts its data polling) when the user actually navigates to it. This
// cuts both the initial JS payload and the first-load agent query burst.
import Performance from './pages/Performance.jsx'
const Desk = lazy(() => import('./pages/Desk.jsx'))
const Trade = lazy(() => import('./pages/Trade.jsx'))
const Accounts = lazy(() => import('./pages/Accounts.jsx'))
const AccountsAudit = lazy(() => import('./pages/AccountsAudit.jsx'))
const Tune = lazy(() => import('./pages/Tune.jsx'))
const Risk = lazy(() => import('./pages/Risk.jsx'))
const Connect = lazy(() => import('./pages/Connect.jsx'))
import AccountSwitcher from './components/AccountSwitcher.jsx'
import LlmMonitorStatus from './components/LlmMonitorStatus.jsx'
import TabsPanel from './components/common/TabsPanel.jsx'
import { useTheme } from './lib/theme.js'
import { Toaster } from 'sonner'

const THEME_CYCLE = { system: 'light', light: 'dark', dark: 'system' }
const THEME_ICON = { system: '◐', light: '☀', dark: '☾' }

// Grouped left navigation (desktop) — compliance-dashboard style.
const NAV_GROUPS = [
  // Performance leads (owner: "it will be before desk") — the ledger is
  // the first thing seen. Desk absorbed Monitor — one screen for charts,
  // live broker state, closed history and risk decisions. /monitor
  // redirects there.
  {
    title: 'Overview',
    items: [
      { to: '/performance', label: 'Performance', icon: '📊' },
      { to: '/desk', label: 'Desk', icon: '🖥️' },
    ],
  },
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
      { to: '/risk', label: 'Risk', icon: '🛡️' },
      { to: '/connect', label: 'Connect', icon: '🔗' },
    ],
  },
]
const ALL_TABS = NAV_GROUPS.flatMap(g => g.items)

// Global agent watchdog — the connection is saved once per device
// (localStorage); this banner is the loud signal when the agent stops
// answering. Polls the public /health every 30s, shows on every page.
function AgentDownBanner() {
  // Owner (2026-07-26): "Keep saying agent not reachable. Is something wrong?"
  // It used to flip on ONE failed poll. On mobile data a single dropped request
  // is routine, and the agent's own loop can be busy for a minute at a time, so
  // one strike produced false alarms that claimed the bot had stopped trading.
  // Now it takes three consecutive failures (~90s) before the banner shows, one
  // success clears it, and the copy no longer asserts what the bot is doing —
  // this browser cannot reach it, which is not the same thing.
  const FAILS_BEFORE_ALARM = 3
  const [fails, setFails] = useState(0)
  const [staleMins, setStaleMins] = useState(null)
  const location = useLocation()
  const okAt = useRef(null)
  useEffect(() => {
    if (!agentConfigured()) return undefined
    let dead = false
    const check = async () => {
      try {
        const c = getAgentConn()
        const res = await fetch(`${c.base}/health`, { signal: AbortSignal.timeout(8000) })
        if (dead) return
        if (res.ok) { setFails(0); okAt.current = Date.now(); setStaleMins(null) }
        else setFails(n => n + 1)
        // Presence heartbeat (owner 2026-07-28: "monitor the number of
        // website open ... and timezone") — one tiny GET per 30s per tab,
        // sent even when hidden so the agent's roster distinguishes
        // visible tabs (full polling) from background ones (polls paused).
        sendClientPing(window.location.pathname).catch(() => {})
      } catch {
        if (dead) return
        setFails(n => n + 1)
        setStaleMins(okAt.current ? Math.round((Date.now() - okAt.current) / 60000) : null)
      }
    }
    check()
    const t = setInterval(check, 30_000)
    return () => { dead = true; clearInterval(t) }
  }, [])
  const down = fails >= FAILS_BEFORE_ALARM
  if (!down || location.pathname === '/connect' || location.pathname === '/link-up') return null

  return (
    <div role="alert" className="px-4 pt-3">
      <div className="rounded-[12px] border-2 border-[var(--color-down)] bg-[var(--color-down)]/10 px-4 py-2 text-[9px] font-semibold">
        ⚠ Can&apos;t reach the agent from this device — {fails} checks in a row failed
        {staleMins != null ? ` (last answered ~${staleMins}m ago)` : ''}. On a phone this is often the
        connection, not the bot; if other devices can reach it, the bot is still running.
        Otherwise check the Railway service, then <NavLink to="/connect" className="underline">test the connection</NavLink>.
      </div>
    </div>
  )
}

function navLinkClasses(isActive) {
  return `rounded-[10px] px-3 py-2 text-[9px] font-semibold inline-flex items-center gap-2 transition-all w-full ${
    isActive
      ? 'text-[var(--color-on-accent)] bg-[var(--color-accent)]'
      : 'text-[var(--color-text-sub)] hover:text-[var(--color-text)] hover:bg-[var(--color-accent-soft)]'
  }`
}

export default function App() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="min-h-screen text-[var(--color-text)] lg:flex">
      {/* Global toasts (owner polish audit) — action failures surface here
          via agent-api's agentPost hook; richColors matches the app's
          up/down semantics, position clears the fixed glass footer. */}
      <Toaster richColors closeButton position="top-right"
        theme={theme === 'system' ? undefined : theme}
        toastOptions={{ style: { fontSize: 9 } }} />
      {/* Left sidebar — desktop */}
      <aside className="hidden lg:flex lg:flex-col lg:w-56 lg:shrink-0 lg:h-screen lg:sticky lg:top-0 p-4">
        <div className="glass-panel rounded-[16px] p-4 flex flex-col h-full min-h-0 overflow-y-auto">
          <div className="flex items-baseline gap-2 mb-4">
            <span className="text-[15px] font-extrabold tracking-tight text-[var(--color-accent)]">bot-trade</span>
            <span className="text-[11px] text-[var(--color-text-sub)]" title={`App version · build ${__GIT_COMMIT__}`}>v{__APP_VERSION__} · {__GIT_COMMIT__}</span>
            <LlmMonitorStatus />
          </div>
          <nav className="flex flex-col gap-4" id="main-content">
            {NAV_GROUPS.map(g => (
              <div key={g.title}>
                <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-sub)]">{g.title}</div>
                <div className="flex flex-col gap-0.5">
                  {g.items.map(t => (
                    <NavLink key={t.to} to={t.to} viewTransition className={({ isActive }) => navLinkClasses(isActive)}>
                      <span aria-hidden="true" className="text-[14px] leading-none">{t.icon}</span>{t.label}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
            <AccountSwitcher />
          </nav>
          {/* Owner 2026-07-28: "I still cannot see the active web setting,
              can you make the setting card 10% spacing gap from the bottom."
              mt-auto parked this block flush against the panel's bottom edge,
              which sits at the viewport bottom — so the sleep-after row and
              the theme button below it disappeared behind the OS taskbar and
              browser chrome. 10vh (10% of the VIEWPORT height) is the gap;
              a percentage padding would have resolved against the sidebar's
              224px WIDTH, giving ~22px, which is not what was asked for. */}
          <div className="mt-auto pb-[10vh]">
            <TabsPanel />
            <button
              type="button"
              onClick={() => setTheme(THEME_CYCLE[theme] || 'system')}
              title={`Theme: ${theme}`}
              className="w-full glass-inset rounded-[10px] px-3 py-2 text-[9px] cursor-pointer hover:shadow-[var(--glow-accent)] text-left"
            >{THEME_ICON[theme] || '◐'} Theme: {theme}</button>
          </div>
        </div>
      </aside>

      <div className="flex-1 min-w-0">
        {/* Top bar — mobile/tablet only */}
        <header className="sticky top-3 z-50 px-3 lg:hidden">
          <div className="glass-bar flex items-center gap-3 rounded-[1px] px-4 py-2 overflow-x-auto scrollbar-none">
            <span className="text-[14px] font-extrabold tracking-tight text-[var(--color-accent)] shrink-0">
              bot-trade
            </span>
            <span className="text-[11px] text-[var(--color-text-sub)] shrink-0" title={`App version · build ${__GIT_COMMIT__}`}>v{__APP_VERSION__} · {__GIT_COMMIT__}</span>
            <LlmMonitorStatus />
            <nav className="flex gap-1">
              {ALL_TABS.map(t => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  viewTransition
                  className={({ isActive }) =>
                    `rounded-[12px] px-3 py-1.5 text-[9px] font-semibold min-h-[36px] inline-flex items-center gap-1.5 transition-all shrink-0 ${
                      isActive
                        ? 'text-[var(--color-on-accent)] bg-[var(--color-accent)]'
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
              className="ml-auto glass-inset rounded-[1px] px-2.5 py-1 text-[14px] cursor-pointer shrink-0"
            >{THEME_ICON[theme] || '◐'}</button>
          </div>
        </header>

        <AgentDownBanner />
        <CockpitHost />

        <main className="px-4 py-4 pb-20 lg:pr-6 lg:pb-16 max-w-[1720px]">
          {/* Lazy routes need a Suspense boundary — a light skeleton line,
              not a spinner wall, while a page chunk downloads. */}
          <Suspense fallback={<div className="p-6 text-[9px] text-[var(--color-text-sub)]">loading page…</div>}>
          <Routes>
            <Route path="/" element={<Navigate to="/performance" replace />} />
            <Route path="/performance" element={<Performance />} />
            <Route path="/desk" element={<Desk />} />
            {/* Monitor merged into Desk — old links keep working */}
            <Route path="/monitor" element={<Navigate to="/desk" replace />} />
            <Route path="/trade" element={<Trade />} />
            <Route path="/accounts" element={<Accounts />} />
            {/* Sub-page of Accounts (owner: "Trade audit will be a sub
                page in accounts") — shares the Accounts nav tab. */}
            <Route path="/accounts/audit" element={<AccountsAudit />} />
            <Route path="/tune" element={<Tune />} />
            <Route path="/risk" element={<Risk />} />
            <Route path="/connect" element={<Connect />} />
            {/* Spotware OAuth redirect URI (registered on the cTrader app) */}
            <Route path="/link-up" element={<Connect />} />
            <Route path="*" element={<Navigate to="/desk" replace />} />
          </Routes>
          </Suspense>
        </main>
        {/* Owner (2026-07-24): "I cannot see the footer in this HD notebook,
            dynamically adjust up the footer... allow there for both the
            side bar and footer and ensure scrolling is behind it like
            Liquid Glass" — fixed to the viewport bottom (not page-flow end)
            so it's always visible on short screens; lg:left-56 clears the
            sticky sidebar; page content scrolls underneath the translucent
            glass-bar material. main's bottom padding above keeps real
            content from ending up permanently hidden under it. */}
        <footer className="glass-fixed fixed bottom-0 inset-x-0 lg:left-56 z-40 px-4 py-2.5 text-[9px] text-[var(--color-text-sub)] flex flex-wrap gap-x-4 gap-y-1">
          <span title="Version · git commit this build was made from — compare with the latest commit on main to confirm the deploy is current">bot-trade v{__APP_VERSION__} · build {__GIT_COMMIT__}</span>
          {/* Keep this line TRUE: 5 registry strategies armed per-stage in
              Tune; entries/risk gate are deterministic, but the position
              monitor has an LLM fallback — never claim "no LLM" outright. */}
          <span>5 strategies (fib 61.8% fade default) · armed per stage in Tune · entries &amp; risk gate deterministic — LLM only as position-monitor fallback</span>
          <span>trading involves risk — demo first, never money you can't lose</span>
        </footer>
      </div>
    </div>
  )
}
