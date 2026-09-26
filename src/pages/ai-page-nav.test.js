// UI-7: the AI page's nav wiring — App.jsx (route + sidebar group),
// nav-tabs.js (mobile "More" tab) and nav-tree.js (the FAB table of
// contents) must all name '/ai', or the page exists with no way in from
// three of the app's four navigation surfaces (the same shape of defect as
// a shadow nobody can switch on — CLAUDE.md failure mode #4).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { NAV_TREE, NAV_PAGES } from '../lib/nav-tree.js'
import { MORE_TABS } from '../lib/nav-tabs.js'

const appSrc = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8')

describe('the AI page is reachable from every nav surface', () => {
  it('has a route and a lazy import in App.jsx', () => {
    expect(appSrc).toMatch(/const Ai = lazy\(\(\) => import\('\.\/pages\/Ai\.jsx'\)\)/)
    expect(appSrc).toMatch(/<Route path="\/ai" element=\{<Ai \/>\}\s*\/>/)
  })

  it('is in the desktop sidebar\'s NAV_GROUPS', () => {
    expect(appSrc).toMatch(/\{\s*to:\s*'\/ai',\s*label:\s*'AI'/)
  })

  it('is in the mobile "More" tabs', () => {
    expect(MORE_TABS.some(t => t.to === '/ai')).toBe(true)
  })

  it('is in the FAB table of contents, with the moved LLM Spend section', () => {
    const page = NAV_PAGES.find(p => p.path === '/ai')
    expect(page).toBeTruthy()
    expect(page.sections.some(s => s.id === 'sec-llmspend')).toBe(true)
  })

  it('the LLM Spend section no longer appears under Desk (moved, not duplicated)', () => {
    const desk = NAV_TREE.flatMap(g => g.pages).find(p => p.path === '/desk')
    expect(desk.sections.some(s => s.id === 'sec-llmspend')).toBe(false)
  })
})
