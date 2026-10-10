// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// A collapsed Desk section must not fetch the routes only it needs until it is
// opened: then at once, then on the page's cycle, and not again once closed.
// Measured 10-10: Desk fetched every section's routes on every 5-second cycle
// while a position was live, collapsed or not (~270 requests a minute from one
// phone tab). The gate and the fetch plan are exercised here with a counting
// agentGet/agentPost; the last block pins Desk.jsx's wiring to them, because a
// gate nothing consults is decoration (CLAUDE.md failure mode #4).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSectionGate, fetchOpenSections, DESK_GATED_SECTIONS } from './desk-sections.js'

const counting = () => {
  const calls = []
  return {
    calls,
    ctx: {
      get: (path) => { calls.push(`GET ${path}`); return Promise.resolve({}) },
      historyPost: (body) => { calls.push(`POST /actions/broker-history ${JSON.stringify(body)}`); return Promise.resolve({}) },
      historyDays: 7,
      view: { single: true, id: '1001' },
    },
  }
}

describe('Desk section gate', () => {
  it('a section that has never been opened fetches nothing, on any cycle', () => {
    const gate = createSectionGate()
    const { calls, ctx } = counting()
    for (const id of DESK_GATED_SECTIONS) gate.set(id, false)
    for (let cycle = 0; cycle < 3; cycle++) expect(fetchOpenSections(gate, ctx)).toEqual([])
    expect(calls).toEqual([])
  })

  it('opening fetches AT ONCE (onOpen), then joins the cycle; closing stops it; reopening fetches at once again', () => {
    const opened = []
    const gate = createSectionGate({ onOpen: id => opened.push(id) })
    const { calls, ctx } = counting()
    gate.set('controllers', false)
    expect(fetchOpenSections(gate, ctx)).toEqual([])

    gate.set('controllers', true)
    expect(opened).toEqual(['controllers'])
    // The at-once call Desk makes from onOpen: only that section.
    fetchOpenSections(gate, ctx, ['controllers'])
    expect(calls).toEqual(['GET /state/heartbeats'])
    // A repeated "still open" report is not a new opening.
    gate.set('controllers', true)
    expect(opened).toEqual(['controllers'])
    // The page's own cycle now includes it.
    calls.length = 0
    fetchOpenSections(gate, ctx)
    expect(calls).toEqual(['GET /state/heartbeats'])

    gate.set('controllers', false) // collapsed, or unmounted
    calls.length = 0
    fetchOpenSections(gate, ctx)
    expect(calls).toEqual([])

    gate.set('controllers', true)
    expect(opened).toEqual(['controllers', 'controllers'])
  })

  it('an at-once call for one section never fetches another open section', () => {
    const gate = createSectionGate()
    const { calls, ctx } = counting()
    gate.set('risk', true); gate.set('pulse', true)
    fetchOpenSections(gate, ctx, ['pulse'])
    expect(calls).toEqual(['GET /state/market-pulse'])
  })

  it('each gated section asks for exactly its own route(s)', () => {
    const gate = createSectionGate()
    const { calls, ctx } = counting()
    for (const id of DESK_GATED_SECTIONS) gate.set(id, true)
    fetchOpenSections(gate, ctx)
    expect(calls).toEqual([
      'GET /state/risk-events?limit=200',
      'GET /state/alpha-decay',
      'GET /state/orders',
      'GET /state/postmortems',
      'GET /state/correlation',
      'GET /state/market-pulse',
      'POST /actions/broker-history {"days":7,"accountId":"1001"}',
      'GET /state/heartbeats',
    ])
  })

  it('broker history is asked only for one account (the view guard\'s rule, unchanged)', () => {
    const gate = createSectionGate()
    const { calls, ctx } = counting()
    gate.set('closed7d', true)
    expect(fetchOpenSections(gate, { ...ctx, view: { single: false, id: 'all' } })).toEqual([])
    expect(calls).toEqual([])
  })
})

// Strip comments so a route named in a comment cannot satisfy (or fail) a pin
// (CLAUDE.md failure mode #2).
const desk = readFileSync(new URL('../pages/Desk.jsx', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('Desk.jsx consults the gate', () => {
  it('its load runs the open sections through fetchOpenSections, and the gated routes are not in the core batch any more', () => {
    expect(desk).toMatch(/fetchOpenSections\(sectionGate\.current,/)
    expect(desk).toMatch(/createSectionGate\(\{\s*onOpen:/)
    for (const route of ['/state/heartbeats', '/state/risk-events', '/state/alpha-decay', "'/state/orders'", '/state/postmortems', '/state/correlation', '/state/market-pulse']) {
      expect(desk.includes(route), route).toBe(false)
    }
    // The broker-history POST is named once, and only as the gate's fetcher.
    expect(desk.split('/actions/broker-history').length - 1).toBe(1)
    expect(desk).toMatch(/fetchOpenSections\(sectionGate\.current, \{ get: agentGet, historyPost: body => agentPost\('\/actions\/broker-history', body\)/)
  })

  it('every gated section reports itself to the gate', () => {
    for (const id of DESK_GATED_SECTIONS) {
      expect(desk, id).toMatch(new RegExp(`id="${id}"\\s+onShownChange=\\{onSectionShown\\}`))
    }
  })

  it('on a phone the engine sections sit inside one collapsed section that mounts them only while open', () => {
    expect(desk).toMatch(/<Card id="sec-engine-diagnostics" defaultCollapsed onShownChange=\{setDiagShown\}>/)
    expect(desk).toMatch(/\{diagShown && \(/)
    for (const v of ['chartWallSection', 'pulseSection', 'correlationSection', 'orderLedgerSection', 'engineeringCard', 'controllersSection', 'edgeSection', 'phaseAuditSection']) {
      expect(desk, v).toContain(`{isDesktop && ${v}}`)
    }
  })
})
