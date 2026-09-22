import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ControllerGroups from './ControllerGroups.jsx'

describe('controller evidence presentation', () => {
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
