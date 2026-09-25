import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ControllerGroups from './ControllerGroups.jsx'
import ControllerRuntime from './ControllerRuntime.jsx'

describe('controller evidence presentation', () => {
  it('distinguishes stale service probes, empty work inventories and calendar faults', () => {
    const now = Date.now()
    const html = renderToStaticMarkup(<ControllerRuntime runtime={{ accounts: [], sides: [], watchdog: {
      readAt: new Date(now).toISOString(), status: {
        enabled: true, durable: true, policy: { serviceGraceMs: 60000 },
        services: {
          node: { attemptedAtMs: now - 65000, reachable: true, validContract: true, workCount: 20 },
          'cpp-scan-tick': { attemptedAtMs: now - 1000, lastContractAtMs: now - 1000, reachable: true, validContract: true, workCount: 0 },
        },
        incidents: { 'node:work:fixture:calendar': { active: true, severity: 'warning', lastObservedAtMs: now,
          detail: { service: 'node', role: 'scanner', accountId: '11', symbolId: '7', marketStatus: 'UNKNOWN' } } },
      },
    } }} />)
    expect(html).toContain('STALE')
    expect(html).toContain('UNVERIFIED')
    expect(html).toContain('ON / ON')
    expect(html).toContain('zero work items does not establish active feed coverage')
    expect(html).toContain('calendar; scanner')
    expect(html).toContain('symbol ID 7')
    expect(html).toContain('market UNKNOWN')
    expect(html).toContain('cpp-scan-timeframe')
  })
  it('keeps absent scanner evidence unknown and shows actual mismatches and worker failures', () => {
    const runtime = { accounts: [], sides: [] }
    const empty = renderToStaticMarkup(<ControllerRuntime runtime={runtime} />)
    expect(empty).toContain('Observation worker: UNVERIFIED')
    expect(empty).toContain('Comparison evidence unavailable')
    const html = renderToStaticMarkup(<ControllerRuntime runtime={{ ...runtime, scannerComparison: {
      bridge: { enabled: true, pending: 2, dropped: 3, failed: true },
      comparison: { populations: [{ source: 'cpp-scan-tick', state: 'mismatch', records: 4, lastObservedAtMs: 1 }] },
    } }} />)
    expect(html).toContain('queued: 2; dropped: 3')
    expect(html).toContain('Worker failed')
    expect(html).toContain('mismatch — 4 retained observations')
    expect(html).toContain('no order authority')
  })
  it('separates retired and busy ticks from completed business work and retains faults', () => {
    const html = renderToStaticMarkup(<ControllerGroups controllers={[
      { name: 'fast_monitor', label: 'Fast monitor', status: 'ok', detail: { busy: true }, last_ok_at: '2026-09-22T00:00:00Z' },
      { name: 'pending_orders', status: 'retired', retired: true, note: 'Producer retired' },
      { name: 'cpp_exec', status: 'error', last_error: 'Probe failed', error_is_current: true },
    ]} />)
    expect(html).toContain('BUSY: overlap skipped; no completed pass')
    expect(html).toContain('Completed work: Unobserved')
    expect(html).toContain('cpp-acct (live gateway)')
    expect(html).toContain('Probe failed')
    expect(html).toContain('Retired history')
    expect(html).toContain('Producer retired')
  })
  it('says why a dormant controller is quiet and does not call its unmoving record stale (V3 I2)', () => {
    const dormant = renderToStaticMarkup(<ControllerGroups controllers={[
      { name: 'weekend_watch', label: 'Weekend watch (LLM)', status: 'idle', verdict: 'dormant', dormant: true,
        dormant_reason: 'LLM switched off (LLM_DISABLED env var) — the weekend watch makes no model call while it is off, so it does not run' },
      { name: 'autopilot', label: 'Strategy autopilot', status: 'ok', verdict: 'dormant', dormant: true,
        dormant_reason: 'autopilot_mode is off — no evidence sweep is scheduled',
        work_product: { fresh: false, summary: 'RECORD 300m OLD — past the 33m limit' } },
    ]} />)
    expect(dormant).toContain('Dormant: LLM switched off (LLM_DISABLED env var)')
    expect(dormant).toContain('Dormant: autopilot_mode is off')
    expect(dormant).toContain('not expected while dormant')
    expect(dormant).not.toContain('STALE / UNAVAILABLE')
    // The same aged record on a controller that is NOT dormant is still stale.
    const live = renderToStaticMarkup(<ControllerGroups controllers={[
      { name: 'autopilot', label: 'Strategy autopilot', status: 'warn', verdict: 'record_stale',
        work_product: { fresh: false, summary: 'RECORD 40m OLD — past the 33m limit' } },
    ]} />)
    expect(live).toContain('STALE / UNAVAILABLE')
    expect(live).not.toContain('Dormant:')
  })
})
