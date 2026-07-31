// PHASE 8 (cockpit live-wiring prompt) — the frontend adapter: when a full
// contract snapshot rides on real.snapshot, the frame's MARKET SAYS, traffic,
// ARMED ACTIONS, INVALIDATION WATCH, advisories, engine bullets and WX come
// from the served body — and when it is absent (the demo route) the reference
// generator still renders unchanged. These tests pin both directions plus the
// honesty rule in between: a bound snapshot with a missing section shows
// '—'/unknown, never the demo number.

import { describe, it, expect } from 'vitest'
import { cockpitFrame } from './cockpit-data.js'

const realBase = {
  sym: 'EURUSD', side: 'LONG', lots: 1, strategy: 'test',
  entry: 1.1, sl: 1.09, tp: 1.12, price: 1.105, pnl: 50, marketOpen: true,
}

const snapshot = {
  meta: { schemaVersion: 1, dataMode: 'live' },
  position: {},
  account: {},
  indicators: { rvol: 1.3 },
  execution: { spreadNow: 0.0001, spreadRatio: null, latencyMs: null },
  intention: {
    currentDecision: { state: 'holding' },
    armedActions: [
      { kind: 'scale_out', trigger: 'close 50% at +1R', triggerPrice: 1.11, distance: 0.005, eta: null, armed: true, ruleSource: 'position_manager' },
      { kind: 'time_cap_exit', trigger: 'full exit when now ≥ 2026-08-01T00:00Z', triggerPrice: null, distance: null, eta: '2026-08-01T00:00Z', armed: false, ruleSource: 'position_manager' },
    ],
    invalidation: [
      { kind: 'stored_trigger', condition: 'price < 1.0900', state: 'watching' },
      { kind: 'thesis', condition: 'monitor marks the thesis broken', state: 'met' },
      { kind: 'stop_loss', condition: 'broker SL at 1.09', state: 'armed' },
    ],
  },
  correlation: {
    status: 'live',
    related: [
      { symbol: 'GBPUSD', side: 'LONG', relation: 'stacked', coefficient: 0.8, effective: 0.8 },
      { symbol: 'USDJPY', side: 'LONG', relation: 'hedged', coefficient: -0.7, effective: -0.7 },
      { symbol: 'XAUUSD', side: 'SHORT', relation: 'independent', coefficient: 0.1, effective: 0.1 },
    ],
    summary: { held: 3, stacked: 1, hedged: 1 },
  },
  environment: {
    regime: { label: 'trending', direction: 'up', status: 'live' },
    macroNews: { events: [], gate: { enabled: true, activeEvent: null } },
  },
  advisories: [{ kind: 'staleness', detail: 'no broker snapshot row for this position — price/P&L unknown' }],
}

const frame = (over = {}) => cockpitFrame({}, 0, { real: { ...realBase, snapshot }, ...over })

describe('cockpitFrame with a bound snapshot', () => {
  it('mirrors intention.armedActions — no hardcoded SCALE-OUT 50% row', () => {
    const v = frame()
    expect(v.autopilot).toHaveLength(2)
    expect(v.autopilot.map(a => a.k)).toEqual(['SCALE OUT', 'TIME CAP EXIT'])
    expect(v.autopilot[0].v).toBe('close 50% at +1R')
    expect(v.autopilot[0].d).toMatch(/away$/)
    expect(v.autopilot[1].d).toBe('due 2026-08-01T00:00Z')
    expect(v.autopilot.some(a => a.k === 'SCALE-OUT 50%')).toBe(false)
  })

  it('mirrors intention.invalidation with met/watching/armed marks and a currentDecision gaNote', () => {
    const v = frame()
    expect(v.goaround.map(g => [g.k, g.mark])).toEqual([
      ['stored trigger', '✓'],
      ['thesis', '✗'],
      ['stop loss', '△'],
    ])
    expect(v.gaNote).toContain('holding')
  })

  it('builds traffic from correlation.related and counts from summary.stacked/hedged', () => {
    const v = frame()
    expect(v.traffic.map(t => t.sym)).toEqual(['GBPUSD', 'USDJPY', 'XAUUSD'])
    expect(v.nSame).toBe('1')
    expect(v.nDiv).toBe('1')
    // Deterministic: two frames with the same snapshot place aircraft identically.
    const v2 = frame()
    expect(v2.traffic.map(t => [t.x, t.y])).toEqual(v.traffic.map(t => [t.x, t.y]))
    expect(v.mktRead).not.toContain('HK utilities')
    expect(v.mktRead).toContain('Regime: trending')
  })

  it('shows unknown, not demo numbers, for null execution facts — and serves rvol', () => {
    const v = frame()
    const by = Object.fromEntries(v.engines.map(e => [e.k, e]))
    expect(by.RVOL.v).toBe('1.3')
    expect(by.Spread.v).toBe('—')
    expect(by.Latency.v).toBe('—')
  })

  it('has no WX cell without a gate event, and one when the gate is active', () => {
    expect(frame().wx).toBe(null)
    const withEvent = {
      ...snapshot,
      environment: {
        ...snapshot.environment,
        macroNews: { events: [], gate: { enabled: true, activeEvent: { title: 'US CPI', currency: 'USD', impact: 'High', scheduledAt: '2026-07-31T14:30:00.000Z' } } },
      },
    }
    const v = cockpitFrame({}, 0, { real: { ...realBase, snapshot: withEvent } })
    expect(v.wx.label).toBe('WX · US CPI 14:30')
    expect(v.alerts.some(a => a.k === 'NEWS GATE')).toBe(true)
  })

  it('appends body.advisories and drops the reference demo advisories', () => {
    const v = frame()
    expect(v.alerts.some(a => a.k === 'STALENESS' && a.d.includes('no broker snapshot row'))).toBe(true)
    expect(v.alerts.some(a => a.d.includes('HK CPI'))).toBe(false)
    // The DEMO DATA row no longer claims traffic/armed actions are demo.
    const dd = v.alerts.find(a => a.k === 'DEMO DATA')
    expect(dd.d).not.toMatch(/demo:.*traffic/)
    expect(v.demoPanels).not.toContain('armed actions')
    expect(v.demoPanels).not.toContain('correlated traffic')
  })

  it('an unknown correlation block means dash counts and no traffic — never zero agreement', () => {
    const v = cockpitFrame({}, 0, { real: { ...realBase, snapshot: { ...snapshot, correlation: { status: 'unknown' } } } })
    expect(v.traffic).toEqual([])
    expect(v.nSame).toBe('—')
    expect(v.nDiv).toBe('—')
    expect(v.mktRead).toContain('Correlation unknown')
  })
})

describe('PHASE 9 — the intention explanation rides in ADVISORIES', () => {
  it('shows the deterministic sentence with its evidence ids, marked rules', () => {
    const v = cockpitFrame({}, 0, { real: { ...realBase, snapshot: { ...snapshot,
      intention: { ...snapshot.intention, explanation: { text: 'Holding LONG EURUSD. [mp:7:sl]', mode: 'deterministic' } } } } })
    const why = v.alerts.find(a => a.k === 'WHY')
    expect(why.d).toBe('Holding LONG EURUSD. [mp:7:sl]')
    expect(why.t).toBe('rules')
  })

  it('marks a served model explanation as such, and shows none when there is none', () => {
    const v = cockpitFrame({}, 0, { real: { ...realBase, snapshot: { ...snapshot,
      intention: { ...snapshot.intention, explanation: { text: 'The bot is holding.', mode: 'model' } } } } })
    expect(v.alerts.find(a => a.k === 'WHY').t).toBe('model')
    expect(frame().alerts.some(a => a.k === 'WHY')).toBe(false)
  })
})

describe('PHASE 8b — the tweak journal is position_events, not the demo list', () => {
  const withJournal = journal => cockpitFrame({}, 0, { real: { ...realBase, snapshot: { ...snapshot, journal } } })

  it('maps real events verbatim and never invents a bar or an R', () => {
    const v = withJournal([
      { id: 4, at: '2026-07-30T09:12:44Z', kind: 'sl_moved', from: '1.0900', to: '1.1000', rAt: 0.82, reason: 'breakeven after +0.8R', source: 'profit_keeper' },
      { id: 9, at: '2026-07-31T02:05:00Z', kind: 'trail_tightened', from: null, to: '1.1030', rAt: null, reason: null, source: 'cpp_trail_engine' },
    ])
    expect(v.journal).toHaveLength(2)
    expect(v.journal[0].k).toBe('SL moved')
    expect(v.journal[0].day).toBe('30/07')
    expect(v.journal[0].hm).toBe('09:12')
    expect(v.journal[0].d).toBe('1.0900 → 1.1000 · breakeven after +0.8R · by profit_keeper')
    expect(v.journal[0].rAt).toBe('+0.82R at event')
    // No bar is resolved at the event's time → empty, not a generated candle.
    expect([v.journal[0].o, v.journal[0].h, v.journal[0].l, v.journal[0].c]).toEqual(['—', '—', '—', '—'])
    // A sparse event says less rather than filling in.
    expect(v.journal[1].d).toBe('→ 1.1030 · by cpp_trail_engine')
    expect(v.journal[1].rAt).toBe('R at event not recorded')
    // None of the reference rows survive.
    expect(v.journal.some(j => j.k === 'Scale-out 50%')).toBe(false)
  })

  it('an empty journal is empty — the demo six never reappear', () => {
    const v = withJournal([])
    expect(v.journal).toEqual([])
    expect(v.tweaks).toEqual([])
    expect(v.demoPanels).not.toContain('tweak journal')
    expect(v.alerts.find(a => a.k === 'DEMO DATA').d).not.toMatch(/demo:.*journal/)
  })

  it('an unknown event kind is shown verbatim, not dropped', () => {
    const v = withJournal([{ id: 1, at: '2026-07-31T02:05:00Z', kind: 'hedge_opened', to: '0.5', source: 'manual' }])
    expect(v.journal[0].k).toBe('hedge_opened')
  })
})

describe('cockpitFrame without a snapshot (demo route)', () => {
  it('keeps the reference demo panels byte-for-byte in spirit', () => {
    const v = cockpitFrame({}, 0, {})
    expect(v.autopilot[0].k).toBe('SCALE-OUT 50%')
    expect(v.traffic.map(t => t.sym)).toContain('HSI')
    expect(v.traffic).toHaveLength(6)
    expect(v.nSame).toBe('4')
    expect(v.nDiv).toBe('2')
    expect(v.wx.label).toBe('WX · HK CPI 14:30')
    expect(v.goaround.some(g => g.k === 'Quadrant flip')).toBe(true)
    expect(v.alerts.some(a => a.d.includes('HK CPI'))).toBe(true)
  })

  it('a bound position WITHOUT a snapshot still flags those panels demo', () => {
    const v = cockpitFrame({}, 0, { real: { ...realBase } })
    expect(v.demoPanels).toContain('armed actions')
    expect(v.autopilot[0].k).toBe('SCALE-OUT 50%')
  })
})
