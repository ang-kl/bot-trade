// MobileTabBar — the phone/tablet navigation, built to Apple's HIG rules the
// owner quoted (2026-07-29):
//
//   "Make sure the tab bar is visible when people navigate to different
//    sections of your app."          → fixed, always mounted, never hidden
//   "Use tab bars strictly to switch between top-level sections or views,
//    never to trigger direct actions or verbs."  → every tab is a route
//   "Limit tabs to five or fewer on mobile."     → 4 sections + More
//   "Keep the tab bar visible during navigation" → position: fixed
//
// It replaces a horizontally-scrolling SEVEN-tab strip in the top bar. That
// strip was also measurably broken: at 744×1133 (iPad mini portrait) the page
// carried 22px of horizontal overflow, so the whole body scrolled sideways.
//
// The three Setup routes live behind More, in a sheet — a modal is the one
// case the HIG allows to cover the tab bar, because it is temporary and
// self-contained. More is a section switcher, not a verb: it opens a list of
// destinations and nothing else.
import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { PRIMARY_TABS, MORE_TABS } from '../lib/nav-tabs.js'

const tabClass = (active) =>
  `flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 min-h-[49px] px-1 ` +
  `text-(length:--fs-body) font-semibold transition-colors ${
    active ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-sub)]'
  }`

export default function MobileTabBar({ footerNote = null, themeButton = null }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const location = useLocation()
  // Navigating dismisses the sheet (closed on the tap itself, not in an
  // effect — a post-render setState here would cascade a second render on
  // every route change). Escape closes it too; the sheet is the only thing that ever covers the bar.
  useEffect(() => {
    if (!moreOpen) return undefined
    const f = (e) => { if (e.key === 'Escape') setMoreOpen(false) }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [moreOpen])

  const moreActive = MORE_TABS.some(t => location.pathname.startsWith(t.to))

  return (
    <>
      {/* The sheet. Covers the bar deliberately — HIG's stated exception. */}
      {moreOpen && (
        <div
          className="fixed inset-0 z-[60] bg-black/50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="More sections"
          onClick={() => setMoreOpen(false)}
        >
          <div
            className="absolute inset-x-0 bottom-0 glass-bar px-4 pt-3"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="mb-2 text-(length:--fs-body) font-semibold uppercase tracking-wide text-[var(--color-text-sub)]">More</div>
            <div className="flex flex-col gap-1">
              {MORE_TABS.map(t => (
                <NavLink
                  key={t.to} to={t.to} viewTransition
                  onClick={() => setMoreOpen(false)}
                  className={({ isActive }) =>
                    `rounded-[10px] px-3 min-h-[44px] inline-flex items-center gap-2 text-(length:--fs-body) font-semibold ${
                      isActive ? 'text-[var(--md-on-secondary-container)] bg-[var(--md-secondary-container)]' : 'glass-inset text-[var(--color-text-sub)]'
                    }`}
                >
                  <span aria-hidden="true" className="text-[14px] leading-none">{t.icon}</span>{t.label}
                </NavLink>
              ))}
              {themeButton}
            </div>
            {/* The footer copy lives here on touch instead of eating three
                lines at the bottom of every single screen (owner: "dense and
                less screen scrolling"). */}
            {footerNote && (
              <div className="mt-3 border-t border-[var(--color-border)] pt-2 text-(length:--fs-body) leading-tight text-[var(--color-text-sub)]">
                {footerNote}
              </div>
            )}
            <button
              type="button"
              onClick={() => setMoreOpen(false)}
              className="mt-3 w-full glass-inset rounded-[10px] min-h-[44px] text-(length:--fs-body) font-semibold cursor-pointer"
            >Close</button>
          </div>
        </div>
      )}

      <nav
        aria-label="Main sections"
        className="glass-fixed fixed bottom-0 inset-x-0 z-50 flex items-stretch lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {PRIMARY_TABS.map(t => (
          <NavLink key={t.to} to={t.to} viewTransition className={({ isActive }) => tabClass(isActive)}>
            <span aria-hidden="true" className="text-[16px] leading-none">{t.icon}</span>
            <span className="truncate max-w-full">{t.label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen(v => !v)}
          aria-expanded={moreOpen}
          className={`${tabClass(moreActive || moreOpen)} cursor-pointer`}
        >
          <span aria-hidden="true" className="text-[16px] leading-none">⋯</span>
          <span>More</span>
        </button>
      </nav>
    </>
  )
}
