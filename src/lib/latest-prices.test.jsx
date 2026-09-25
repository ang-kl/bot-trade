// npx vitest run src/lib/latest-prices.test.jsx
//
// P1/P4 M2: GET /state/prices failing must read "unavailable" on the Desk and
// Trade pages, not an empty price map that looks like a quiet market (owner
// principle 6). Rendered with react-dom/server — there is no jsdom here.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadLatestPrices, latestPricesNote } from './latest-prices.js'
import LatestPricesNote from '../components/LatestPricesNote.jsx'

// agentGet throws the 503 body's `error` as its message (agent-api.js).
const failing503 = async () => { throw new Error('Latest prices are temporarily unavailable. Please retry.') }

describe('loadLatestPrices', () => {
  it('a 503 from the route is "unavailable" with the route\'s reason, and no prices', async () => {
    const read = await loadLatestPrices(failing503)
    expect(read).toEqual({ prices: {}, status: 'unavailable', reason: 'Latest prices are temporarily unavailable. Please retry.' })
  })
  it('an older agent\'s 200 {prices:{}, error} is still "unavailable", not an empty market', async () => {
    const read = await loadLatestPrices(async () => ({ prices: {}, error: 'performance_report_deadline' }))
    expect(read.status).toBe('unavailable')
    expect(read.reason).toBe('performance_report_deadline')
  })
  it('a reply with no price map is "unavailable"', async () => {
    expect((await loadLatestPrices(async () => ({}))).status).toBe('unavailable')
    expect((await loadLatestPrices(async () => null)).status).toBe('unavailable')
  })
  it('a good read passes the map through and asks the route it names', async () => {
    const asked = []
    const read = await loadLatestPrices(async path => { asked.push(path); return { prices: { USDJPY: { price: 150.25 } } } })
    expect(asked).toEqual(['/state/prices'])
    expect(read).toEqual({ prices: { USDJPY: { price: 150.25 } }, status: 'ok', reason: null })
  })
})

describe('LatestPricesNote', () => {
  it('says "unavailable" when the price read failed', async () => {
    const html = renderToStaticMarkup(<LatestPricesNote read={await loadLatestPrices(failing503)} />)
    expect(html).toContain('data-testid="latest-prices-unavailable"')
    expect(html).toContain('role="status"')
    expect(html).toMatch(/Latest prices unavailable \(Latest prices are temporarily unavailable\. Please retry\.\)/)
  })
  it('renders nothing for a good read or before the first read', async () => {
    const ok = await loadLatestPrices(async () => ({ prices: { EURUSD: { price: 1.1 } } }))
    expect(renderToStaticMarkup(<LatestPricesNote read={ok} />)).toBe('')
    expect(renderToStaticMarkup(<LatestPricesNote read={null} />)).toBe('')
    expect(latestPricesNote(ok)).toBeNull()
  })
})

// Wiring pin (CLAUDE.md failure mode #4): the pages have no injection point
// here, so their source is read — with comments stripped first (failure mode
// #2), so a comment naming the call cannot satisfy the assertion.
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
describe('Desk and Trade read prices through loadLatestPrices and show the note', () => {
  for (const page of ['Desk', 'Trade']) {
    it(page, () => {
      const src = stripComments(readFileSync(new URL(`../pages/${page}.jsx`, import.meta.url), 'utf8'))
      expect(src).toContain('loadLatestPrices(agentGet)')
      expect(src).not.toMatch(/agentGet\(\s*['"`]\/state\/prices/)
      expect(src).toContain('setPricesRead(px)')
      expect(src).toContain('<LatestPricesNote read={pricesRead} />')
    })
  }
})
