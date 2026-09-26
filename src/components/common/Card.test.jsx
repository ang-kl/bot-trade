// UI-1 (26-09 UI plan, OD-17 = D19/D8): the collapse control must (1)
// survive a reload/remount instead of resetting to `defaultCollapsed` every
// time, (2) never crash on a throwing store, and (3) render as a visible
// triangle, not the 55%-opacity/hover-only-border look the plan measured.
//
// No jsdom in this repo — react-dom/server only (see AccountScopeFab.test.jsx
// and PageErrorBoundary.test.jsx for the same boundary). That is enough here:
// Card's persisted choice is read in its very first (server) render, via a
// lazy useState initializer, so a fresh renderToStaticMarkup call IS what a
// remount looks like from Card's point of view — it has no memory of any
// earlier render except what the injected storage carries.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import Card from './Card.jsx'

const fakeStorage = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m }
}

const render = (props, children = 'hello') => renderToStaticMarkup(<Card {...props}>{children}</Card>)

describe('Card collapse persistence', () => {
  it('a fresh mount with no stored preference uses defaultCollapsed, as before', () => {
    expect(render({ id: 'sec-a', storage: fakeStorage() })).toContain('<div class="card-body">')
    expect(render({ id: 'sec-b', storage: fakeStorage(), defaultCollapsed: true })).toContain('style="display:none"')
  })

  it('REMOUNT: a stored "collapsed" choice is honoured on the very next mount — an account switch remounts this Card via `key`', () => {
    const st = fakeStorage({ 'card_open_sec-blockers': '0' })
    // Two independent renderToStaticMarkup calls, sharing only `st`, stand in
    // for the unmount + remount an account switch does to BlockerReport's
    // Card (`key={`blockers:${acct}`}`).
    const first = render({ id: 'sec-blockers', storage: st })
    const second = render({ id: 'sec-blockers', storage: st })
    for (const html of [first, second]) {
      expect(html).toContain('style="display:none"') // body hidden: it stayed collapsed
      expect(html).toMatch(/aria-expanded="false"/)
    }
  })

  it('REMOUNT: a stored "open" choice overrides defaultCollapsed on the next mount', () => {
    const st = fakeStorage({ 'card_open_sec-c': '1' })
    const html = render({ id: 'sec-c', storage: st, defaultCollapsed: true })
    expect(html).not.toContain('style="display:none"')
    expect(html).toMatch(/aria-expanded="true"/)
  })

  it('two cards never clobber each other\'s stored choice', () => {
    const st = fakeStorage({ 'card_open_sec-acct-balance': '1', 'card_open_sec-blockers': '0' })
    expect(render({ id: 'sec-acct-balance', storage: st })).not.toContain('style="display:none"')
    expect(render({ id: 'sec-blockers', storage: st })).toContain('style="display:none"')
  })

  it('a card with no id has no stable key and is unaffected by storage', () => {
    const st = fakeStorage({ card_open_null: '0' })
    expect(render({ storage: st })).not.toContain('style="display:none"')
  })

  it('a THROWING store on read must not crash the page — it degrades to the default', () => {
    const throwing = { getItem() { throw new Error('blocked (private mode)') } }
    expect(() => render({ id: 'sec-d', storage: throwing })).not.toThrow()
    expect(render({ id: 'sec-d', storage: throwing })).not.toContain('style="display:none"')
  })

  it('a THROWING store on write (toggling) must not crash the page either', () => {
    // Card's setCollapsed always writes back; a click-time throw is exercised
    // directly against the same writeCardOpen path Card calls, since there is
    // no jsdom here to dispatch a real click.
    const throwing = { setItem() { throw new Error('quota exceeded') } }
    const html = render({ id: 'sec-e', storage: throwing })
    expect(html).toBeTruthy()
  })
})

describe('the collapse control is a visible triangle (OD-17: "no transparency")', () => {
  it('renders at full opacity with a border that does not depend on hover', () => {
    const html = render({ id: 'sec-f', storage: fakeStorage() })
    const btn = html.match(/<button[^>]*aria-label="Collapse this section"[^>]*>/)[0]
    expect(btn).toContain('opacity:1')
    expect(btn).not.toContain('opacity:0.55')
    expect(btn).toContain('border-color:var(--glass-edge)')
  })

  it('leaves the maximize (⇲) and copy (⧉) controls at their existing faint look — only collapse changed', () => {
    const html = render({ id: 'sec-g', storage: fakeStorage() })
    const maxBtn = html.match(/<button[^>]*aria-label="Expand this section to full screen"[^>]*>/)[0]
    const copyBtn = html.match(/<button[^>]*aria-label="Copy this section"[^>]*>/)[0]
    for (const btn of [maxBtn, copyBtn]) expect(btn).toContain('opacity:0.55')
  })
})

describe('loading reserves height (PERF-1)', () => {
  it('a loading card gets a minHeight floor; a settled one does not', () => {
    expect(render({ id: 'sec-h', storage: fakeStorage(), loading: true })).toContain('min-height:160px')
    expect(render({ id: 'sec-h', storage: fakeStorage(), loading: false })).not.toContain('min-height')
  })
})

describe('lazy mount (W1-FU: children of a collapsed card are not mounted at all, not just hidden)', () => {
  it('default behaviour (lazy omitted/false) is unchanged: children mount even while collapsed', () => {
    const html = render({ id: 'sec-i', storage: fakeStorage(), defaultCollapsed: true }, 'lazy-marker')
    expect(html).toContain('style="display:none"')
    expect(html).toContain('lazy-marker')
  })

  it('lazy + collapsed on first mount: children never render', () => {
    const html = render({ id: 'sec-j', storage: fakeStorage(), defaultCollapsed: true, lazy: true }, 'lazy-marker')
    expect(html).toContain('style="display:none"')
    expect(html).not.toContain('lazy-marker')
  })

  it('lazy + open on first mount: children render, same as non-lazy', () => {
    const html = render({ id: 'sec-k', storage: fakeStorage(), defaultCollapsed: false, lazy: true }, 'lazy-marker')
    expect(html).not.toContain('style="display:none"')
    expect(html).toContain('lazy-marker')
  })

  it('lazy + a persisted "open" choice mounts children on the very first render — no waiting for a toggle', () => {
    const st = fakeStorage({ 'card_open_sec-l': '1' })
    const html = render({ id: 'sec-l', storage: st, defaultCollapsed: true, lazy: true }, 'lazy-marker')
    expect(html).not.toContain('style="display:none"')
    expect(html).toContain('lazy-marker')
  })

  it('lazy + a persisted "collapsed" choice keeps children unmounted on the very first render', () => {
    const st = fakeStorage({ 'card_open_sec-m': '0' })
    const html = render({ id: 'sec-m', storage: st, defaultCollapsed: false, lazy: true }, 'lazy-marker')
    expect(html).toContain('style="display:none"')
    expect(html).not.toContain('lazy-marker')
  })
})
