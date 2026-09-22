import { test, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BlockerReading } from './BlockerReport.jsx'

test('unavailable and empty reports never claim there were no signals', () => {
  expect(renderToStaticMarkup(<BlockerReading error="Agent not connected" />)).toContain('unavailable: Agent not connected')
  const report = { totalRecords: 0, records: [], offset: 0, unattributedRecordsInWindow: 3,
    summary: Object.fromEntries(['upstream_stop', 'risk_refusal', 'post_approval_failure', 'approved', 'other_stop'].map(k => [k, { records: 0 }])) }
  const html = renderToStaticMarkup(<BlockerReading report={report} />)
  expect(html).toContain('does not prove that scanning ran or found no signals')
  expect(html).toContain('Unassigned records in the window: 3')
})

test('placement receipts are labelled as placements and never as new risk approvals or fills', () => {
  const report = {
    totalRecords: 1, offset: 0, unattributedRecordsInWindow: 0,
    summary: Object.fromEntries(['upstream_stop', 'risk_refusal', 'post_approval_failure', 'approved', 'placement_receipt', 'other_stop'].map(k => [k, { records: k === 'placement_receipt' ? 1 : 0 }])),
    records: [{ recordId: 'risk_events:1', kind: 'placement_receipt', stage: 'submission_receipt',
      accountId: '11', symbol: 'EURUSD', at: '2026-09-22T11:30:00Z', firstBlocker: null,
      disposition: 'placed', recordedEvaluations: 1, diagnostics: [{ stage: 'submission', status: 'placed' }],
      recordedChecks: { pending_order_placed: true } }],
  }
  const html = renderToStaticMarkup(<BlockerReading report={report} />)
  expect(html).toContain('Placement receipts')
  expect(html).toContain('placement does not prove a fill')
  expect(html).toContain('submission: placed')
  expect(html).not.toContain('No terminal disposition recorded')
  expect(html).not.toContain('risk_gate: approved')
})
