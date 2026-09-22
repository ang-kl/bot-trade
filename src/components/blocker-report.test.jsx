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
