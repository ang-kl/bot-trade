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
})
