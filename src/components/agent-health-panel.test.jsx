// The agent health panel. The readings are prose and the prose IS the feature,
// so they are tested directly; the component is rendered with react-dom/server
// to catch first-render faults (no jsdom in this repo, so effects do not run).
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AgentHealthPanel, { Line, ControllerRows } from './AgentHealthPanel.jsx'
import {
  deployReading, controllerReading, loopReading, overdue, dur, worst, toText,
} from '../lib/agent-health-view.js'
import { placeAnchored } from '../lib/use-anchored-popover.js'

describe('deployReading', () => {
  it('confirms a match', () => {
    const r = deployReading({ uiCommit: 'abc1234', agentCommit: 'abc1234' })
    expect(r.state).toBe('ok')
    expect(r.text).toMatch(/same build/)
  })

  it('flags a mismatch and names BOTH causes, since the UI cannot tell them apart', () => {
    const r = deployReading({ uiCommit: 'abc1234', agentCommit: 'def5678', uiVersion: '1.2', agentVersion: '1.1' })
    expect(r.state).toBe('warn')
    expect(r.text).toMatch(/stale bundle/)
    expect(r.text).toMatch(/redeploying/)
  })

  it('compares the short forms, so a full sha and its prefix are the same build', () => {
    expect(deployReading({ uiCommit: 'abc1234', agentCommit: 'abc1234def890' }).state).toBe('ok')
  })

  it('says unknown rather than claiming a match when the agent reports no commit', () => {
    const r = deployReading({ uiCommit: 'abc1234', agentCommit: null })
    expect(r.state).toBe('unknown')
    expect(r.text).toMatch(/cannot be compared/)
  })

  it('says unknown when the UI build carries no commit', () => {
    expect(deployReading({ uiCommit: '', agentCommit: 'abc1234' }).state).toBe('unknown')
  })
})

describe('loopReading', () => {
  const now = Date.parse('2026-08-02T12:00:00Z')

  it('does not call a long-but-legal cycle a problem', () => {
    const r = loopReading({ status: 'ok', loopCount: 42, loopPhase: 'scan', loopStartedAt: '2026-08-02T11:56:00Z', watchdogMinutes: 12 }, now)
    expect(r.state).toBe('ok')
    expect(r.text).toMatch(/scan/)
    expect(r.text).toMatch(/4m into this cycle/)
  })

  it('flags a cycle past the watchdog deadline and names the stuck phase', () => {
    const r = loopReading({ status: 'ok', loopPhase: 'pending', loopStartedAt: '2026-08-02T11:30:00Z', watchdogMinutes: 12 }, now)
    expect(r.state).toBe('error')
    expect(r.text).toMatch(/pending/)
    expect(r.text).toMatch(/watchdog/)
  })

  it('surfaces a tripped circuit breaker above everything else', () => {
    const r = loopReading({ status: 'circuit_breaker_tripped', loopPhase: 'idle' }, now)
    expect(r.state).toBe('error')
    expect(r.text).toMatch(/circuit_breaker_tripped/)
  })

  it('reads a SQLite space-form start stamp as UTC', () => {
    const spaced = loopReading({ status: 'ok', loopPhase: 'scan', loopStartedAt: '2026-08-02 11:56:00Z', watchdogMinutes: 12 }, now)
    const iso = loopReading({ status: 'ok', loopPhase: 'scan', loopStartedAt: '2026-08-02T11:56:00Z', watchdogMinutes: 12 }, now)
    expect(spaced.text).toBe(iso.text)
  })

  it('says unknown with no answer at all, rather than ok', () => {
    expect(loopReading(null).state).toBe('unknown')
  })
})

describe('controllerReading', () => {
  const c = (over) => ({ name: 'x', label: 'X', status: 'ok', age_sec: 10, expected_sec: 60, ...over })

  it('is ok when everything is ok, and counts them', () => {
    const r = controllerReading([c({ name: 'a' }), c({ name: 'b' })])
    expect(r.state).toBe('ok')
    expect(r.counts.ok).toBe(2)
    expect(r.bad).toEqual([])
  })

  it('treats stalled as an error and names the row', () => {
    const r = controllerReading([c({ name: 'a' }), c({ name: 'b', status: 'stalled', age_sec: 900 })])
    expect(r.state).toBe('error')
    expect(r.bad.map(x => x.name)).toEqual(['b'])
  })

  it('ranks stalled above warn, then by how overdue', () => {
    const r = controllerReading([
      c({ name: 'w', status: 'warn', age_sec: 70 }),
      c({ name: 's1', status: 'stalled', age_sec: 120 }),
      c({ name: 's2', status: 'stalled', age_sec: 600 }),
    ])
    expect(r.bad.map(x => x.name)).toEqual(['s2', 's1', 'w'])
  })

  it('does not flag an idle controller — never having run is not a failure', () => {
    const r = controllerReading([c({ name: 'i', status: 'idle', age_sec: null, runs: 0 })])
    expect(r.state).toBe('ok')
    expect(r.bad).toEqual([])
  })

  it('says unknown, not ok, when there are no heartbeats at all', () => {
    expect(controllerReading([]).state).toBe('unknown')
    expect(controllerReading(undefined).state).toBe('unknown')
  })
})

describe('overdue', () => {
  it('is zero inside the expected cadence', () => {
    expect(overdue({ age_sec: 30, expected_sec: 60 })).toBe(0)
  })
  it('is the excess past it', () => {
    expect(overdue({ age_sec: 200, expected_sec: 60 })).toBe(140)
  })
  it('is zero rather than NaN when either side is missing', () => {
    expect(overdue({ age_sec: null, expected_sec: 60 })).toBe(0)
    expect(overdue({})).toBe(0)
  })
})

describe('dur', () => {
  it('scales through seconds, minutes, hours and days', () => {
    expect(dur(45)).toBe('45s')
    expect(dur(600)).toBe('10m')
    expect(dur(7200)).toBe('2h')
    expect(dur(86_400 * 3)).toBe('3d')
  })
  it('degrades to a dash rather than NaN', () => {
    expect(dur(null)).toBe('—')
    expect(dur('x')).toBe('—')
  })
})

describe('worst', () => {
  it('lets error win over everything', () => {
    expect(worst('ok', 'error')).toBe('error')
    expect(worst('error', 'warn')).toBe('error')
  })
  it('prefers a real reading over unknown', () => {
    expect(worst('ok', 'unknown')).toBe('ok')
  })
})

describe('toText', () => {
  it('carries the readings and each unhappy controller with its error', () => {
    const t = toText({
      health: { uptime: 3600, lastLoopMs: 210_000, errorsToday: 2, lastError: 'boom' },
      controllers: [{ name: 'atr', label: 'ATR sweep', status: 'stalled', age_sec: 9000, expected_sec: 3600, last_error: 'no bars' }],
      deploy: { state: 'warn', text: 'mismatch' },
      loop: { state: 'ok', text: 'cycle 5' },
      atr: null,
    })
    expect(t).toMatch(/deploy: warn/)
    expect(t).toMatch(/ATR sweep/)
    expect(t).toMatch(/no bars/)
    expect(t).toMatch(/errors today: 2/)
    expect(t).toMatch(/no record/)
  })
})

describe('placeAnchored', () => {
  // Pure DOM arithmetic over injected rects — no jsdom needed.
  const fake = (rect) => ({ style: {}, getBoundingClientRect: () => rect })
  const anchor = (rect) => ({ getBoundingClientRect: () => rect })

  it('opens upward from the anchor when there is room', () => {
    const el = fake({ width: 200, height: 100 })
    placeAnchored(el, anchor({ top: 500, bottom: 520, left: 20 }), { viewportW: 1000, viewportH: 800 })
    expect(el.style.top).toBe('392px') // 500 - 100 - 8
  })

  it('falls back downward when the box would leave the top edge', () => {
    const el = fake({ width: 200, height: 400 })
    placeAnchored(el, anchor({ top: 30, bottom: 50, left: 20 }), { viewportW: 1000, viewportH: 800 })
    expect(el.style.top).toBe('58px') // anchor.bottom + margin
  })

  it('clamps the RIGHT edge, not just the left — a wide box near the edge', () => {
    const el = fake({ width: 400, height: 100 })
    placeAnchored(el, anchor({ top: 500, bottom: 520, left: 900 }), { viewportW: 1000, viewportH: 800 })
    expect(el.style.left).toBe('592px') // 1000 - 400 - 8
  })

  it('clamps the BOTTOM edge when neither direction fits outright', () => {
    // 750-tall box against an 800 viewport with the anchor low: upward would
    // go off the top, downward would go off the bottom, so it lands on the
    // bottom clamp. The first draft of this test picked a box that fit going
    // upward and therefore proved nothing.
    const el = fake({ width: 200, height: 750 })
    placeAnchored(el, anchor({ top: 700, bottom: 720, left: 20 }), { viewportW: 1000, viewportH: 800 })
    expect(el.style.top).toBe('42px') // 800 - 750 - 8
  })

  it('converts to LAYOUT pixels under zoom, which is what style.top resolves in', () => {
    const el = fake({ width: 200, height: 100 })
    placeAnchored(el, anchor({ top: 500, bottom: 520, left: 110 }), { viewportW: 1000, viewportH: 800, zoom: 1.1 })
    // 392 visual / 1.1, 110 visual / 1.1 — writing the visual number back is
    // the bug this conversion exists for.
    expect(parseFloat(el.style.top)).toBeCloseTo(392 / 1.1, 3)
    expect(parseFloat(el.style.left)).toBeCloseTo(100, 3)
  })
})

describe('components', () => {
  it('renders the tag without throwing before any data has arrived', () => {
    const html = renderToStaticMarkup(<AgentHealthPanel appVersion="1.2.3" buildSha="abc1234" />)
    expect(html).toContain('abc1234')
  })

  it('renders nothing for an empty controller list', () => {
    expect(renderToStaticMarkup(<ControllerRows bad={[]} />)).toBe('')
  })

  it('shows a stalled controller with its overdue amount and error', () => {
    const html = renderToStaticMarkup(
      <ControllerRows bad={[{ name: 'atr', label: 'ATR sweep', status: 'stalled', age_sec: 9000, expected_sec: 3600, last_error: 'no bars' }]} />,
    )
    expect(html).toContain('ATR sweep')
    expect(html).toContain('overdue')
    expect(html).toContain('no bars')
  })

  it('says "never" rather than a blank for a controller that has not run', () => {
    const html = renderToStaticMarkup(
      <ControllerRows bad={[{ name: 'x', label: 'X', status: 'warn', age_sec: null, expected_sec: 60 }]} />,
    )
    expect(html).toContain('never')
  })

  it('Line renders its state dot and content', () => {
    expect(renderToStaticMarkup(<Line state="error">boom</Line>)).toContain('boom')
  })
})
