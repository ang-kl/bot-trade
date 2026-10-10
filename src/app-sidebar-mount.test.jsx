// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// The desktop sidebar is `hidden lg:flex`: display none below 1024 px, but it
// used to stay MOUNTED, so its pollers ran on every phone page (measured 10-10
// at 390x844). App now mounts it only where CSS shows it. No jsdom in this
// repo: the first (server) render is what a phone's first paint mounts, and
// useIsDesktop reads matchMedia during render, so a stubbed matchMedia drives
// it exactly as the browser would.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import App from './App.jsx'
import { DESKTOP_QUERY, mediaMatches } from './lib/use-media-query.js'

const media = (desktop) => {
  const asked = []
  const matchMedia = (q) => { asked.push(q); return { matches: q === DESKTOP_QUERY ? desktop : false, addEventListener() {}, removeEventListener() {} } }
  return { matchMedia, asked }
}
const render = (desktop) => {
  const m = media(desktop)
  vi.stubGlobal('window', { matchMedia: m.matchMedia, location: { search: '', pathname: '/risk', href: 'http://x/risk' }, addEventListener() {}, removeEventListener() {} })
  const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/risk']}><App /></MemoryRouter>)
  return { html, asked: m.asked }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the desktop sidebar mounts only at the desktop breakpoint', () => {
  it('a phone (matchMedia says below 64rem) renders no sidebar at all — not a hidden one', () => {
    const { html, asked } = render(false)
    expect(asked).toContain(DESKTOP_QUERY)
    expect(html).not.toContain('<aside')
    // The sidebar's own pieces are gone with it: the wordmark-sized brand and
    // the grouped desktop nav (its "Setup" heading exists nowhere else).
    expect(html).not.toContain('lg:w-56')
    expect(html).not.toMatch(/>Setup</)
    // What a phone needs is still there: its own header and the tab bar.
    expect(html).toContain('lg:hidden')
    expect(html).toContain('data-tabbar')
  })

  it('a desktop renders the sidebar exactly where it was', () => {
    const { html } = render(true)
    expect(html).toContain('<aside')
    expect(html).toContain('lg:w-56')
    expect(html).toMatch(/>Setup</)
  })

  it('the query is the CSS breakpoint, and an environment that cannot answer keeps the old (mounted) behaviour', () => {
    expect(DESKTOP_QUERY).toBe('(min-width: 64rem)')
    expect(mediaMatches(DESKTOP_QUERY, true, undefined)).toBe(true)
    expect(mediaMatches(DESKTOP_QUERY, true, { matchMedia: () => { throw new Error('no') } })).toBe(true)
    expect(mediaMatches(DESKTOP_QUERY, true, { matchMedia: () => ({ matches: false }) })).toBe(false)
  })
})
