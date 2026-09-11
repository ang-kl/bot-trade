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
    // PR-F: the DEMO DATA row belongs to the demo route only — a bound
    // position never carries it, and nothing under it is flagged demo.
    expect(v.alerts.find(a => a.k === 'DEMO DATA')).toBeUndefined()
    expect(v.demoPanels).toEqual([])
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
    expect(v.alerts.find(a => a.k === 'DEMO DATA')).toBeUndefined()
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

  // PR-F (owner principle 6): the previous contract here let a real position
  // without a snapshot wear the demo waypoints, flagged "demo". A bound
  // position now says NOT LOADED and renders nothing invented.
  it('a bound position WITHOUT a snapshot shows NOT LOADED, never the demo waypoints, traffic, rates, legs or WX', () => {
    const v = cockpitFrame({}, 0, { real: { ...realBase } })
    expect(v.demoPanels).toEqual([])
    expect(v.autopilot).toHaveLength(1)
    expect(v.autopilot[0].k).toBe('NOT LOADED')
    expect(v.autopilot.some(a => a.k === 'SCALE-OUT 50%')).toBe(false)
    expect(v.traffic).toEqual([])
    expect(v.nSame).toBe('—'); expect(v.nDiv).toBe('—')
    expect(v.goaround).toEqual([])
    expect(v.gaNote).toMatch(/not loaded/)
    expect(v.mktRead).toMatch(/Not loaded/)
    expect(v.legs).toBeNull()
    expect(v.wx).toBeNull()
    expect(v.engines.every(e => e.v === '—')).toBe(true)
    expect(v.alerts.find(a => a.k === 'DEMO DATA')).toBeUndefined()
    expect(v.alerts.find(a => a.k === 'NOT LOADED')).toBeTruthy()
    expect(v.alerts.some(a => a.d.includes('HK CPI'))).toBe(false)
  })

  it('the demo route carries the DEMO DATA pill; a bound position never does', () => {
    expect(cockpitFrame({}, 0, {}).alerts.some(a => a.k === 'DEMO DATA')).toBe(true)
    expect(frame().alerts.some(a => a.k === 'DEMO DATA')).toBe(false)
  })
})

// PR-F (owner principle 6): the chart, PRICE·tf candles and the volume
// profile were synthetic under a REAL position — the reference wave in the
// bound symbol's price units. They now come from the snapshot's served bars
// and indicators (agent/services/cockpit-bars.js) or render an honest empty
// state. The demo route is unchanged.
describe('chart honesty for a bound position', () => {
  const HOUR = 3_600_000
  const t0 = Date.UTC(2026, 8, 10, 8)
  const rows = Array.from({ length: 40 }, (_, i) => {
    const c = 1.1 + Math.sin(i / 5) * 0.004
    return { t: t0 + i * 15 * 60_000, o: c - 0.0005, h: c + 0.001, l: c - 0.001, c, v: 100 + i }
  })
  const bars = { timeframe: '15m', rows, status: 'live', source: 'broker-trendbars', asOf: '2026-09-10T18:00:00.000Z' }
  const indicators = {
    ema9: rows.map((r, i) => (i < 8 ? null : r.c - 0.0002)), ema20: rows.map(() => null), ema50: rows.map(() => null),
    vwap: rows.map(r => r.c + 0.0001), rvol: 1.2,
    volumeProfile: { buckets: [{ price: 1.097, volume: 10, pct: 10 }, { price: 1.100, volume: 60, pct: 60 }, { price: 1.103, volume: 30, pct: 30 }], pocPrice: 1.100, valueAreaLow: 1.100, valueAreaHigh: 1.103, status: 'derived' },
    status: 'derived',
  }
  const withBars = (over = {}) => cockpitFrame({}, 0, { real: { ...realBase, snapshot: { ...snapshot, bars, indicators, ...over } } })

  it('renders the served bars: 30 real candles, one resolution band naming the timeframe, real x labels, a POC from the served profile', () => {
    const v = withBars()
    expect(v.chart.status).toBe('live')
    expect(v.chart.timeframe).toBe('15m')
    expect(v.chart.bars).toBe(40)
    expect(v.candles).toHaveLength(30)
    expect(v.candles[0].tip).toMatch(/^(up|down) bar \d\d:\d\d · O 1\.\d{4} H/)
    expect(v.resBands).toHaveLength(1)
    expect(v.resBands[0].lb).toMatch(/^15m · 40 bars · live/)
    expect(v.xLabels[v.xLabels.length - 1].v).toMatch(/^LAST \d\d:\d\d$/)
    expect(v.flownPath).toMatch(/^M30\.0,/)
    expect(v.volBars).toHaveLength(40)
    expect(v.vpBars).toHaveLength(3)
    expect(v.vpBars.filter(b => b.tip.startsWith('POC'))).toHaveLength(1)
    expect(v.vpBars.find(b => b.tip.startsWith('POC')).tip).toContain('1.1000')
    // No fabricated flight plan, no demo tweak marks, EMA20 (all null) draws nothing.
    expect(v.planPath).toBeNull()
    expect(v.tweaks).toEqual([])
    expect(v.ema20Path).toBe('')
    expect(v.ema9Path).toMatch(/^M/)
    // The aircraft sits on the last real bar, not the demo NOW seam.
    expect(v.anim.acX).toBe(258)
    // Every demo-only generator output is gone from the frame.
    expect(v.xLabels.some(x => x.v.startsWith('NOW '))).toBe(false)
    expect(v.resBands.some(b => /to TP|next 4h/.test(b.lb))).toBe(false)
  })

  it('a snapshot whose bars are unavailable renders the empty state with the server reason — never the demo candle', () => {
    const v = withBars({ bars: { timeframe: '15m', rows: [], status: 'unavailable', detail: 'cTrader not connected' }, indicators: { status: 'unavailable' } })
    expect(v.chart.status).toBe('empty')
    expect(v.chart.reason).toBe('no chart data for this position — bars unavailable: cTrader not connected')
    expect(v.candles).toEqual([]); expect(v.vpBars).toEqual([]); expect(v.volBars).toEqual([])
    expect(v.flownPath).toBe(''); expect(v.ema9Path).toBe(''); expect(v.vwapPath).toBe('')
    expect(v.alerts.find(a => a.k === 'NO CHART').d).toMatch(/cTrader not connected/)
  })

  it('a bound position with no snapshot is empty too, and the demo route still generates', () => {
    const v = cockpitFrame({}, 0, { real: { ...realBase } })
    expect(v.chart.status).toBe('empty')
    expect(v.chart.reason).toMatch(/snapshot has not been fetched/)
    expect(v.candles).toEqual([])
    const demo = cockpitFrame({}, 0, {})
    expect(demo.chart.status).toBe('synthetic')
    expect(demo.candles).toHaveLength(30)
    expect(demo.vpBars).toHaveLength(16)
  })

  it('a served profile with no volume is an unknown VP, not a drawn one', () => {
    const v = withBars({ indicators: { ...indicators, volumeProfile: { buckets: [], pocPrice: null, valueAreaLow: null, valueAreaHigh: null, status: 'unknown' } } })
    expect(v.chart.vp).toBe('unknown')
    expect(v.vpBars).toEqual([])
    expect(v.candles).toHaveLength(30)
  })
})

describe('fleet, MFE/MAE and the risk budget under a bound position', () => {
  it('no roster handed over → empty fleet labelled not loaded, never the demo roster', () => {
    const v = frame()
    expect(v.fleet).toEqual([])
    expect(v.fleetIsReal).toBe(false)
    expect(v.fleetLabel).toMatch(/not loaded/)
    expect(cockpitFrame({}, 0, {}).fleet.map(f => f.sym)).toContain('0002.HK')
  })
  it('a handed-over roster is rendered as before', () => {
    const v = cockpitFrame({}, 0, { real: { ...realBase, fleet: { list: [{ sym: 'GBPUSD', r: 0.5 }], total: 1 } } })
    expect(v.fleet.map(f => f.sym)).toEqual(['GBPUSD'])
    expect(v.fleetIsReal).toBe(true)
  })
  it('extrema not served → "—" and no tape ticks; served → shown', () => {
    const v = frame()
    expect(v.mfeR).toBe('—'); expect(v.maeR).toBe('—'); expect(v.giveback).toBe('—')
    expect(v.altMfe).toBeNull(); expect(v.altMae).toBeNull()
    const w = cockpitFrame({}, 0, { real: { ...realBase, snapshot, mfeR: 0.8, maeR: -0.2 } })
    expect(w.mfeR).toBe('+0.80R'); expect(w.altMfe).not.toBeNull()
  })
  it('the risk budget reads the snapshot account block, "—" when absent — never the demo $184,920', () => {
    const v = frame()
    expect(v.acctBal).toBe('—'); expect(v.capAbs).toBe('—'); expect(v.fuel).toBe('loss-cap not loaded'); expect(v.fuelUnknown).toBe(true)
    const w = cockpitFrame({}, 0, { real: { ...realBase, snapshot: { ...snapshot, account: { balance: 25000, equity: 25050, dailyLossCap: 500, dailyLossUsed: 125 } } } })
    expect(w.acctBal).toBe('$25,000'); expect(w.acctEq).toBe('$25,050'); expect(w.capAbs).toBe('$500'); expect(w.capUsed).toBe('−$125'); expect(w.capLeft).toBe('$375'); expect(w.fuel).toBe('75%')
    expect(w.anim.fuelW).toBe(75)
    expect(cockpitFrame({}, 0, {}).acctBal).toBe('$184,920')
  })
  it('legs come from the snapshot (opened-at, first armed action, TP rail) — the dated demo legs are demo-only', () => {
    const v = cockpitFrame({}, 0, { real: { ...realBase, snapshot: { ...snapshot, position: { openedAt: '2026-09-10T08:07:00Z' } } } })
    expect(v.legs[0].s).toBe('10/09 08:07 UTC')
    expect(v.legs[1].v).toBe('scale out')
    expect(v.legs[2].v).toBe('Target 1.1200')
    expect(cockpitFrame({}, 0, {}).legs[0].s).toBe('23/07 10:07 · 0.4bp slip')
  })
})

// Owner (2026-08-01): "the tweak journal is fake" — a REAL position must never
// wear the six demo journal rows, snapshot or not. Demo rows are only for the
// pure reference cockpit with nothing bound.
describe('journal honesty for a bound position', () => {
  it('real position WITHOUT a snapshot: empty journal, journalUnloaded, no demo chart marks', () => {
    const v = cockpitFrame({}, 0, { real: { ...realBase } })
    expect(v.journal).toEqual([])
    expect(v.journalUnloaded).toBe(true)
    expect(v.tweaks).toEqual([])
    // and the demo-panel list stops claiming the journal is demo
    expect(v.demoPanels).not.toContain('tweak journal')
  })

  it('real position WITH a snapshot: served events verbatim, not unloaded', () => {
    const v = frame() // realBase + snapshot (snapshot.journal absent → [])
    expect(v.journal).toEqual([])
    expect(v.journalUnloaded).toBe(false)
  })

  it('pure demo route keeps the six reference rows and their chart marks', () => {
    const v = cockpitFrame({}, 0, {})
    expect(v.journal).toHaveLength(6)
    expect(v.journalUnloaded).toBe(false)
    expect(v.tweaks).toHaveLength(6)
  })
})

// PR-F checker B1: the PFD's SPD / VSI / HDG were sine-wave generators
// (tick-driven) painted under a real position — "+1.90 pips/min", "TP 4.0h",
// "BULL 46" that changed every 2.2 s with no served input behind them.
describe('PFD instruments under a bound position are served or withheld — never the wave', () => {
  const noInputs = { ...snapshot, bars: { rows: [], status: 'unavailable' }, indicators: { status: 'unavailable' }, position: {} }
  const at = (tick, real) => cockpitFrame({}, tick, { real })
  const digitFree = s => !/\d/.test(s)

  it('no served inputs (with a snapshot, and without): identical at ticks 0/7/13, "—", no ETA, no BULL/BEAR/CHOP', () => {
    for (const real of [{ ...realBase, snapshot: noInputs }, { ...realBase }]) {
      const frames = [0, 7, 13].map(t => at(t, real))
      for (const v of frames) {
        expect(v.spd).toBe('—'); expect(v.vsi).toBe('—'); expect(v.hdg).toBe('—')
        expect(v.vsiEta).toBeNull(); expect(v.spdTicks).toEqual([])
        expect(digitFree(v.spd) && digitFree(v.vsi) && digitFree(v.hdg)).toBe(true)
        expect(v.hdg).not.toMatch(/BULL|BEAR|CHOP/)
        expect(v.anim.vsiA).toBe(0); expect(v.anim.hdgX).toBe(0)
        expect(v.spdSource).toMatch(/unknown/); expect(v.vsiSource).toMatch(/unknown/); expect(v.hdgSource).toMatch(/unknown/)
      }
      const pick = v => [v.spd, v.vsi, v.hdg, v.vsiEta, v.spdTicks, v.anim.vsiA, v.anim.hdgX]
      expect(pick(frames[1])).toEqual(pick(frames[0])); expect(pick(frames[2])).toEqual(pick(frames[0]))
    }
  })

  it('served inputs: SPD from the last two served bars, VSI from opened-at, HDG from served EMA9/EMA50 — and still tick-invariant', () => {
    const t0 = Date.UTC(2026, 8, 10, 8)
    const rows = [{ t: t0, o: 1.1, h: 1.1, l: 1.1, c: 1.1000, v: 1 }, { t: t0 + 9e5, o: 1.1, h: 1.1, l: 1.1, c: 1.1030, v: 1 }]
    const served = { ...snapshot, bars: { timeframe: '15m', rows, status: 'live' }, indicators: { ema9: [null, 1.1100], ema50: [null, 1.1000], ema20: [], vwap: [] },
      position: { openedAt: new Date(Date.now() - 2 * 36e5).toISOString() } }
    const frames = [0, 7, 13].map(t => at(t, { ...realBase, snapshot: served }))
    const v = frames[0]
    // 30 pips over a 15-minute bar = +2.00 pips/min
    expect(v.spd).toBe('+2.00'); expect(v.spdTicks.map(x => x.v)).toEqual(['+4', '+3', '+2', '1', '0'])
    // rNow = (1.105−1.1)/0.01 = +0.5R over ~2 h = +0.25 R/h
    expect(v.vsi).toBe('+0.25'); expect(v.vsiEta).toMatch(/^TP /)
    // EMA9 − EMA50 = +0.01 = +1 R unit → +50 → BULL 50
    expect(v.hdg).toBe('BULL 50')
    expect(v.spdSource).toMatch(/served/); expect(v.hdgSource).toMatch(/EMA9/)
    for (const w of frames.slice(1)) expect([w.spd, w.vsi, w.hdg]).toEqual([v.spd, v.vsi, v.hdg])
    // the demo route still runs its generator
    expect(cockpitFrame({}, 0, {}).hdg).toMatch(/BULL|BEAR|CHOP/)
  })
})
