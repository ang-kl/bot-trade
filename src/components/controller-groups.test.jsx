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
  it('prints the no_orders blocker and labels the relayed entry records as Node records, never broker-verified (V3 CV-1)', () => {
    const now = Date.now()
    const watchdog = status => ({ readAt: new Date(now).toISOString(), status: { enabled: true, durable: true, policy: { serviceGraceMs: 60000 }, services: {}, ...status } })
    const noOrders = detail => ({ 'node:no_orders:11:s1': { active: true, severity: 'info', openedAtMs: now, lastObservedAtMs: now, detail: { service: 'node', accountId: '11', ...detail } } })
    const relay = { evidence: 'node_records_relayed', brokerVerified: false, available: true, complete: true, stale: false, nodeObservedAtMs: now,
      note: "Pre-broker refusals are Node's own records relayed; cpp-verify did not observe them and cannot confirm them at the broker.",
      accounts: [
        { accountId: '11', environment: 'demo', entryMode: { effective: 'TIME_BASED' }, bases: ['bar'],
          tick: { status: 'not_evaluated', because: 'basis_not_admitted', blockedReasons: ['profile_pinned', 'replay_evidence'] },
          dominantRefusal: { stage: 'stage_matrix', records: 3, lastReason: 'strategy OFF' }, entryStopsInWindow: 3,
          independent: { available: true, openCount: 2, checkedAtMs: now } },
        { accountId: '22', environment: 'live', entryMode: { effective: 'TIME_BASED' }, bases: ['bar'], tick: { status: 'not_evaluated' },
          dominantRefusal: null, entryStopsInWindow: 0, independent: { available: false, reason: 'broker_reconcile_stale' } },
      ] }
    const html = renderToStaticMarkup(<ControllerRuntime runtime={{ accounts: [], sides: [], watchdog: watchdog({
      incidents: noOrders({ blocker: 'stage_matrix ×3 of 3 entry stops since session open; latest stage_matrix: strategy OFF' }), entryDiagnostics: relay }) }} />)
    expect(html).toContain('blocker: stage_matrix ×3 of 3 entry stops')
    expect(html).toContain('Node records relayed by cpp-verify (not broker-verified)')
    expect(html).toContain('not evaluated — basis_not_admitted')
    expect(html).toContain('Blocked: profile_pinned, replay_evidence')
    expect(html).toContain('stage_matrix ×3; latest: strategy OFF')
    expect(html).toContain('2 open, read')
    expect(html).toContain('UNVERIFIED: broker_reconcile_stale')
    expect(html).not.toContain('· STALE')
    const stale = renderToStaticMarkup(<ControllerRuntime runtime={{ accounts: [], sides: [], watchdog: watchdog({
      incidents: noOrders({}), entryDiagnostics: { ...relay, stale: true, complete: false, reason: 'accounts_dropped_by_relay_bound_or_shape' } }) }} />)
    expect(stale).toContain('blocker: not recorded')
    expect(stale).toContain('· STALE')
    expect(stale).toContain('INCOMPLETE: accounts_dropped_by_relay_bound_or_shape')
    // Absent or unavailable is said, never an empty clean table.
    const busy = renderToStaticMarkup(<ControllerRuntime runtime={{ accounts: [], sides: [], watchdog: watchdog({ error: 'watchdog_status_busy' }) }} />)
    expect(busy).toContain('unavailable: watchdog_status_busy')
    expect(busy).not.toContain('<table class="w-full text-left"><caption class="text-left font-semibold">Entry refusals')
    const none = renderToStaticMarkup(<ControllerRuntime runtime={{ accounts: [], sides: [], watchdog: watchdog({
      entryDiagnostics: { available: false, reason: 'no_node_contract_since_start', accounts: [] } }) }} />)
    expect(none).toContain('unavailable: no_node_contract_since_start')
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
