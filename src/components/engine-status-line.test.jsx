// EngineStatusLine — the sidebar's "ENTRIES · <mode> · <readiness>" line.
// S1: the line is built entirely from the server's own record (mode,
// tickObservation, and now the readiness join) — nothing here is a fixed
// string. S1a: GET /state/tick-readiness answers either the roster shape
// `{ accounts: [...] }` or, when the viewed-account wiring (S3) narrows the
// request with `?account=`, ONE bare record with no `accounts` field at all
// — and the line must still join readiness for the matching account and read
// "no record" (never crash, never silently drop the whole reading) for any
// other one.
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import EngineStatusLine from './EngineStatusLine.jsx'

const fixture = vi.hoisted(() => ({ snap: null }))
vi.mock('../lib/use-engine-status.js', async () => {
  const actual = await vi.importActual('../lib/use-engine-status.js')
  return { ...actual, useEngineStatus: () => fixture.snap }
})

function engineRow(o = {}) {
  return {
    accountId: '…9908', routingAccountId: '46979908', environment: 'demo',
    requestedEntryMode: 'TIME_BASED', effectiveEntryMode: 'TIME_BASED', transitionState: 'STABLE',
    configRevision: 2, modeEpoch: 0, tickObservation: 'OFF', entryCounts: { resting: 0, unknown: 0 },
    ...o,
  }
}

describe('EngineStatusLine', () => {
  it('shows tick-ready readiness from the server record (the roster shape), prefixed by the entry-mode policy, never a hardcoded word', () => {
    fixture.snap = {
      at: Date.now(), engines: { accounts: [engineRow()] },
      readiness: { accounts: [{ accountId: '…9908', routingAccountId: '46979908', ready: true, blockedReasons: [] }] },
    }
    const html = renderToStaticMarkup(<EngineStatusLine accountId="46979908" />)
    expect(html).toMatch(/Time-based entries · manual · tick-ready/)
  })

  it('shows the blocker count when not ready', () => {
    fixture.snap = {
      at: Date.now(), engines: { accounts: [engineRow()] },
      readiness: { accounts: [{ accountId: '…9908', routingAccountId: '46979908', ready: false, blockedReasons: ['validation_stage', 'recorder_status_fresh'] }] },
    }
    const html = renderToStaticMarkup(<EngineStatusLine accountId="46979908" />)
    expect(html).toMatch(/Time-based entries · manual · 2 blockers/)
  })

  it('joins readiness for the matching account from the narrowed single-record shape (S1a)', () => {
    fixture.snap = {
      at: Date.now(), engines: { accounts: [engineRow()] },
      // no `accounts` field: exactly what GET /state/tick-readiness?account=
      // answers (agent/services/tick-readiness.js tickReadinessFor).
      readiness: { accountId: '…9908', routingAccountId: '46979908', ready: false, blockedReasons: ['validation_stage'] },
    }
    const html = renderToStaticMarkup(<EngineStatusLine accountId="46979908" />)
    expect(html).toMatch(/Time-based entries · manual · 1 blocker\b/)
  })

  it('shows "no record", unprefixed, when the narrowed answer is for a DIFFERENT account, instead of silently dropping the reading', () => {
    fixture.snap = {
      at: Date.now(), engines: { accounts: [engineRow()] },
      readiness: { accountId: '…3489', routingAccountId: '42993489', ready: true, blockedReasons: [] },
    }
    const html = renderToStaticMarkup(<EngineStatusLine accountId="46979908" />)
    expect(html).toMatch(/Time-based entries · no record/)
    expect(html).not.toMatch(/manual · no record/)
  })

  it('shows an auto-policy account prefixed "auto", not the default "manual"', () => {
    fixture.snap = {
      at: Date.now(), engines: { accounts: [engineRow({ entryModePolicy: 'auto' })] },
      readiness: { accounts: [{ accountId: '…9908', routingAccountId: '46979908', ready: true, blockedReasons: [] }] },
    }
    const html = renderToStaticMarkup(<EngineStatusLine accountId="46979908" />)
    expect(html).toMatch(/Time-based entries · auto · tick-ready/)
  })

  // Checker BLOCKER 3 (W1.4 fix round; OD-30 "fix the label now"): the owner
  // flagged "· shadow" printing from the STORED tickObservation setting
  // regardless of whether the shadow strategy was actually observed running.
  // These three replace it with readiness.shadowReady / shadowBlockers.
  it('shows "shadow running" when the account declares SHADOW and the join says it is actually observed running', () => {
    fixture.snap = {
      at: Date.now(), engines: { accounts: [engineRow({ tickObservation: 'SHADOW' })] },
      readiness: { accounts: [{ accountId: '…9908', routingAccountId: '46979908', ready: false, blockedReasons: ['validation_stage'], shadowReady: true, shadowBlockers: [] }] },
    }
    const html = renderToStaticMarkup(<EngineStatusLine accountId="46979908" />)
    expect(html).toMatch(/Time-based entries · manual · shadow running/)
  })

  it('shows "shadow declared, not running: ‹first blocker›" when SHADOW is set but nothing is actually observed', () => {
    fixture.snap = {
      at: Date.now(), engines: { accounts: [engineRow({ tickObservation: 'SHADOW' })] },
      readiness: { accounts: [{ accountId: '…9908', routingAccountId: '46979908', ready: false, blockedReasons: ['validation_stage'], shadowReady: false, shadowBlockers: ['recorder_recording', 'disk_reserve_clear'] }] },
    }
    const html = renderToStaticMarkup(<EngineStatusLine accountId="46979908" />)
    expect(html).toMatch(/Time-based entries · manual · shadow declared, not running: recorder_recording/)
    // ONLY the first blocker — a full list belongs to the detail popover, not this line.
    expect(html).not.toMatch(/disk_reserve_clear/)
  })

  it('shows "no record" for a SHADOW account with no readiness join at all, same honesty as the non-SHADOW case', () => {
    fixture.snap = {
      at: Date.now(), engines: { accounts: [engineRow({ tickObservation: 'SHADOW' })] },
      readiness: { accountId: '…3489', routingAccountId: '42993489', ready: true, blockedReasons: [] },
    }
    const html = renderToStaticMarkup(<EngineStatusLine accountId="46979908" />)
    expect(html).toMatch(/Time-based entries · no record/)
  })

  it('shows bare "no record" for an account that has never had an engine record written (row.stored === false), never inventing a policy for it', () => {
    fixture.snap = {
      at: Date.now(), engines: { accounts: [engineRow({ stored: false })] },
      readiness: { accounts: [{ accountId: '…9908', routingAccountId: '46979908', ready: true, blockedReasons: [] }] },
    }
    const html = renderToStaticMarkup(<EngineStatusLine accountId="46979908" />)
    expect(html).toMatch(/Time-based entries · no record/)
    expect(html).not.toMatch(/manual · no record/)
    expect(html).not.toMatch(/tick-ready/)
  })

  it('renders nothing extra when the engine record itself is unanswered (no row at all)', () => {
    fixture.snap = { at: null, engines: null, readiness: null }
    const html = renderToStaticMarkup(<EngineStatusLine accountId="46979908" />)
    expect(html).toMatch(/engine status unknown/)
    expect(html).not.toMatch(/no record/)
  })
})
