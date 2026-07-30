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
import ActiveAccountHeader, { ActiveAccountHeaderCompact } from './components/ActiveAccountHeader.jsx'
import MobileTabBar from './components/MobileTabBar.jsx'
import PageAccountLine from './components/PageAccountLine.jsx'
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
  // The desktop footer wraps to two lines on narrow desktops (measured: ~39px
  // at 1440x900, ~58px at 1280x800), so its height cannot be hardcoded — and
  // the sidebar has to stop exactly above it or the two overlap, which is the
  // bug the owner reported. Measure it and publish --footer-h.
  const footerRef = useRef(null)
  useEffect(() => {
    const el = footerRef.current
    if (!el) return undefined
    // Two measurements, both necessary.
    //
    // The footer WRAPS on narrow desktops (~39px at 1440x900, ~58px at
    // 1280x800), so its height cannot be hardcoded — that is why this is a
    // ResizeObserver and not a constant.
    //
    // And index.css applies `zoom: 1.1` to html above 1153px. Under zoom,
    // getBoundingClientRect reports VISUAL pixels while CSS lengths resolve
    // in LAYOUT pixels, so `100dvh` inside the zoomed document is 10% taller
    // than the window. That is precisely what ran the sidebar panel under the
    // fixed footer — measured at 1440x900: panel bottom 930px, footer top
    // 861px. Deriving the factor and publishing an already-converted height
    // sidesteps the whole trap; doing this in a Tailwind calc() does not,
    // because a var() FALLBACK contains a comma and silently fails to
    // compile the utility (verified against the built CSS).
    const apply = () => {
      const root = document.documentElement
      // Read the factor off the element itself. Deriving it from
      // innerWidth / clientWidth does NOT work: Chromium reports
      // clientWidth already in visual pixels, so the ratio comes back 1 and
      // the correction silently does nothing (measured).
      const zoom = parseFloat(getComputedStyle(root).zoom) || 1
      const footerVisual = el.getBoundingClientRect().height
      root.style.setProperty('--footer-h', `${Math.ceil(footerVisual)}px`)
      root.style.setProperty('--sidebar-h', `${Math.floor(Math.max(0, window.innerHeight - footerVisual) / zoom)}px`)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    window.addEventListener('resize', apply)
    return () => { ro.disconnect(); window.removeEventListener('resize', apply) }
  }, [])

  return (
    <div className="min-h-screen text-[var(--color-text)] lg:flex">
      {/* Global toasts (owner polish audit) — action failures surface here
          via agent-api's agentPost hook; richColors matches the app's
          up/down semantics, position clears the fixed glass footer. */}
      <Toaster richColors closeButton position="top-right"
        theme={theme === 'system' ? undefined : theme}
        toastOptions={{ style: { fontSize: 9 } }} />
      {/* Left sidebar — desktop */}
      {/* Owner (2026-07-29): "UI top header and footer not link to the side
          bar on desktop aspect ratio." Measured at 1440x900: the sidebar
          panel's bottom edge was at 972px in a 900px viewport — it ran 111px
          UNDER the fixed footer and 72px past the screen. lg:h-screen made
          the aside a full viewport tall while the footer covers the bottom
          ~40-60px of that same viewport, so the two chrome pieces overlapped
          instead of meeting. --footer-h is measured live below (the footer
          wraps to two lines on narrow desktops, so a hardcoded number would
          be wrong on exactly the screens the owner uses). */}
      <aside className="hidden lg:flex lg:flex-col lg:w-56 lg:shrink-0 lg:h-[var(--sidebar-h)] lg:sticky lg:top-0 p-4">
        <div className="glass-panel rounded-[16px] p-4 flex flex-col h-full min-h-0 overflow-hidden">
          <div className="shrink-0 flex items-baseline flex-wrap gap-x-2 gap-y-0.5 mb-3">
            <span className="text-[15px] font-extrabold tracking-tight text-[var(--color-accent)]">bot-trade</span>
            <span className="text-[11px] text-[var(--color-text-sub)]" title={`App version · build ${__GIT_COMMIT__}`}>v{__APP_VERSION__} · {__GIT_COMMIT__}</span>
            <LlmMonitorStatus />
          </div>
          {/* Which account am I looking at? (owner 2026-07-29: "above the
              OVERVIEW state the Account · {DEMO 5203012} I am viewing now").
              It sits ABOVE the first nav group because every number on every
              page below belongs to this account — reading Performance without
              knowing whose Performance it is has bitten before. */}
          <div className="shrink-0"><ActiveAccountHeader /></div>
          <nav className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col gap-4" id="main-content">
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
          {/* The web-app settings are NOT here. Owner (2026-07-30): "move the
              setting which now on the left navigation bar to the footer."
              They live in the page footer below, so the sidebar spends all of
              its width and height on navigation — which is what the cramped
              screenshot was about. */}
        </div>
      </aside>

      <div className="flex-1 min-w-0">
        {/* Top bar — mobile/tablet only */}
        {/* UI-7: the bar is now SCROLLING REGION + PINNED CONTROL, not one
            scrolling row.
            Measured 2026-07-29 at 390px on all seven pages: the theme button
            carried `ml-auto` INSIDE the `overflow-x-auto` row, and ml-auto
            resolves against the scroll width rather than the viewport — so
            the toggle sat off the right edge on every page, reachable only by
            scrolling a bar with no scroll affordance. The nav ran past the
            edge for the same reason. Splitting them fixes both: the tabs
            scroll, the theme button stays put and is always reachable.
            min-h-[44px] on the tabs is the HIG touch minimum; they were 36. */}
        {/* Touch header — IDENTITY ONLY. Navigation moved to the bottom
            tab bar (HIG: tab bars switch top-level sections, and stay
            visible). The old header carried a horizontally-scrolling
            SEVEN-tab strip, which at 744x1133 (iPad mini portrait) pushed
            22px of horizontal overflow onto the body — the whole page
            scrolled sideways. One row, no scroll, no nav. */}
        <header className="sticky top-2 z-40 px-3 lg:hidden">
          <div className="glass-bar flex items-center gap-2 rounded-[1px] px-3 py-1.5">
            <span className="text-[13px] font-extrabold tracking-tight text-[var(--color-accent)] shrink-0">bot-trade</span>
            <span className="text-[9px] text-[var(--color-text-sub)] shrink-0 truncate" title={`App version · build ${__GIT_COMMIT__}`}>v{__APP_VERSION__}</span>
            <LlmMonitorStatus />
            <span className="ml-auto shrink-0"><ActiveAccountHeaderCompact /></span>
          </div>
        </header>

        <AgentDownBanner />
        <CockpitHost />

        <main className="px-4 py-3 pb-[calc(env(safe-area-inset-bottom,0px)+68px)] lg:pr-6 lg:pb-[calc(var(--footer-h)+12px)] max-w-[1720px]">
          {/* WHICH account is this page about, and what is its balance — on
              every page, mounted once here rather than per page. Owner
              (2026-07-30): "i needed an account number in every webpage below
              the page title text to know which account I am using and what is
              the balance in 1 font size smaller than the page title." Only
              three pages render an <h1> at all, so a per-page insertion would
              have missed most of them; see PageAccountLine.jsx. */}
          <PageAccountLine />

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
          {/* Small screens have no sidebar, so the tab roster above is
              lg-only — which made the click-to-expand detail unreachable on
              exactly the touch devices it was built for (Codex review).
              Mounted here at the end of the page content for < lg, where it
              scrolls into reach instead of fighting the fixed footer. */}
          <div className="lg:hidden mt-4">
            <TabsPanel />
          </div>
        </main>
        {/* Owner (2026-07-24): "I cannot see the footer in this HD notebook,
            dynamically adjust up the footer... allow there for both the
            side bar and footer and ensure scrolling is behind it like
            Liquid Glass" — fixed to the viewport bottom (not page-flow end)
            so it's always visible on short screens; lg:left-56 clears the
            sticky sidebar; page content scrolls underneath the translucent
            glass-bar material. main's bottom padding above keeps real
            content from ending up permanently hidden under it. */}
        <footer ref={footerRef} className="glass-fixed hidden lg:flex fixed bottom-0 inset-x-0 lg:left-52 z-40 px-4 py-2 text-[var(--fs-caption)] text-[var(--color-text-sub)] flex-wrap items-center gap-x-3 gap-y-1">
          {/* THE WEB-APP SETTINGS LIVE HERE (owner 2026-07-30: "move the setting
              which now on the left navigation bar to the footer"). The footer is
              already fixed and already spans the content width, so the controls
              are permanently reachable without spending any sidebar width — and
              the sidebar gets its full height back for navigation.

              The build stamp stays: it is the only thing that can prove WHICH
              code is deployed. The risk disclaimer and the strategy blurb are
              gone at the owner's instruction ("remove all the precautious
              text") — this is their own private desk, and a warning they wrote
              to themselves was costing a line of permanent chrome. */}
          <span title="Version · git commit this build was made from — compare with the latest commit on main to confirm the deploy is current">bot-trade v{__APP_VERSION__} · build {__GIT_COMMIT__}</span>
          <span className="h-3 w-px bg-[var(--glass-edge)]" aria-hidden="true" />
          <TabsPanel />
          <button
            type="button"
            onClick={() => setTheme(THEME_CYCLE[theme] || 'system')}
            title={`Theme: ${theme} — click to cycle system / light / dark`}
            className="glass-inset rounded-[8px] px-2 py-1 text-[var(--fs-caption)] cursor-pointer hover:shadow-[var(--glow-accent)]"
          >{THEME_ICON[theme] || '◐'} {theme}</button>
        </footer>

        {/* Bottom tab bar — touch only. Always mounted, never conditionally
            hidden on navigation (HIG). Carries the footer copy and the theme
            control inside its More sheet so neither costs vertical space on
            a phone. */}
        {/* Same trim as the desktop footer (owner: "remove all the precautious
            text"). The build stamp is kept because it is the only proof of
            WHICH code is running. */}
        <MobileTabBar
          footerNote={<>bot-trade v{__APP_VERSION__} · build {__GIT_COMMIT__}</>}
          themeButton={
            <button
              type="button"
              onClick={() => setTheme(THEME_CYCLE[theme] || 'system')}
              className="glass-inset rounded-[10px] px-3 min-h-[44px] inline-flex items-center gap-2 text-[9px] font-semibold text-[var(--color-text-sub)] cursor-pointer"
            >{THEME_ICON[theme] || '◐'} Theme: {theme}</button>
          }
        />
      </div>
    </div>
  )
}
