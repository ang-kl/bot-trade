import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ControllerGroups from './ControllerGroups.jsx'
import ControllerRuntime from './ControllerRuntime.jsx'

describe('controller evidence presentation', () => {
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
