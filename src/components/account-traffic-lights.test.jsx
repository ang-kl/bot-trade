// The traffic-light row. The states are the feature, so each one is rendered
// and checked; the component tree is exercised with react-dom/server (no jsdom
// in this repo, so effects do not run and the render is the pre-fetch state).
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AccountTrafficLights, { LightDot, LightRow } from './AccountTrafficLights.jsx'
import { LIGHT_ORDER, LIGHT_COLOR } from '../lib/traffic-light-view.js'

const row = (over = {}) => ({
  accountId: '5203012',
  lights: {
    link: { state: 'green', reason: 'at the broker, and the loop is reconciling' },
    scan: { state: 'green', reason: 'scanning' },
    enter: { state: 'amber', reason: 'armed, but the portfolio guard is blocking: global_halt' },
    manage: { state: 'green', reason: 'watching 2 positions' },
  },
  overall: 'amber',
  ...over,
})

describe('LightDot', () => {
  it('draws unknown HOLLOW, so absent evidence never looks like fine', () => {
    const unknown = renderToStaticMarkup(<LightDot name="link" light={{ state: 'unknown', reason: 'no roster' }} />)
    const green = renderToStaticMarkup(<LightDot name="link" light={{ state: 'green', reason: 'ok' }} />)
    expect(unknown).toContain('○')
    expect(green).toContain('●')
  })

  it('carries the reason as a title on every state', () => {
    for (const s of ['red', 'amber', 'green', 'unknown']) {
      const html = renderToStaticMarkup(<LightDot name="scan" light={{ state: s, reason: `because ${s}` }} />)
      expect(html).toContain(`because ${s}`)
      expect(html).toContain(s)
    }
  })

  it('renders a missing light as unknown rather than blank', () => {
    const html = renderToStaticMarkup(<LightDot name="enter" light={undefined} />)
    expect(html).toContain('○')
    expect(html).toContain('no reading')
  })

  it('gives red, amber, green and unknown four distinct colours', () => {
    const seen = new Set(Object.values(LIGHT_COLOR))
    expect(seen.size).toBe(4)
  })
})

describe('LightRow', () => {
  it('shows all four lights in a fixed order', () => {
    const html = renderToStaticMarkup(<LightRow row={row()} />)
    for (const k of LIGHT_ORDER) {
      expect(html.toLowerCase()).toContain(k)
    }
  })

  it('states every light in words as well as colour', () => {
    const html = renderToStaticMarkup(<LightRow row={row()} />)
    // The sr-only summary — colour is never the only carrier (WCAG 1.4.1).
    expect(html).toContain('Link green')
    expect(html).toContain('Enter amber')
  })

  it('does not throw on a row with no lights at all', () => {
    expect(() => renderToStaticMarkup(<LightRow row={{ accountId: 'x' }} />)).not.toThrow()
  })
})

describe('AccountTrafficLights', () => {
  it('hands the caller an empty map before any fetch resolves', () => {
    let seen = null
    renderToStaticMarkup(
      <AccountTrafficLights>{(v) => { seen = v; return <span>ok</span> }}</AccountTrafficLights>,
    )
    expect(seen.byId.size).toBe(0)
    expect(seen.alarms).toEqual([])
  })
})
