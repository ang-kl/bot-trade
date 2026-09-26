// NIT (W1-FU checker): agent/services/blocker-report.js's `day.omitted`
// (folded lines past FOLDED_LINES_PER_DAY_MAX, 90/day) never reached the
// UI — a day at the cap looked complete, with no sign anything was left
// out. This pins the honest "N more lines not shown" line the fix adds to
// GroupedBlockerTable's per-day group header, and that it is silent when
// nothing was omitted. Static render only (react-dom/server, no jsdom —
// see common/DataTable.jsx's own header comment).
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BlockerReading } from './BlockerReport.jsx'

const LABELS_KEYS = ['upstream_stop', 'risk_refusal', 'post_approval_failure', 'tick_refusal', 'approved', 'placement_receipt', 'other_stop']

const foldedRow = (recordId, overrides = {}) => ({
  count: 1, evaluations: 1,
  firstAt: '2026-09-26T10:00:00.000Z', lastAt: '2026-09-26T10:00:00.000Z',
  sample: {
    recordId, accountId: 'ACCT-DEMO-1', symbol: 'EURUSD', stage: 'risk_gate',
    kind: 'risk_refusal', reason: 'test reason',
    recordedChecks: null, detail: null, recordedChecksStatus: null,
    diagnostics: [], diagnosticNote: '',
  },
  ...overrides,
})

const baseReport = (days) => ({
  timeZone: 'UTC',
  totalRecords: days.reduce((n, d) => n + d.totalRecords, 0),
  countBasis: 'test basis',
  scopeNote: 'test scope',
  unattributedRecordsInWindow: 0,
  unsplitRecordsInWindow: 0,
  summary: Object.fromEntries(LABELS_KEYS.map(k => [k, { records: 0 }])),
  rosterWide: null,
  tick: null,
  days,
})

describe('GroupedBlockerTable (via BlockerReading) — omitted-lines honesty', () => {
  it('a day at the fold cap (omitted > 0) shows an honest "N more lines not shown"', () => {
    const report = baseReport([
      { key: '2026-09-26', label: 'Sat 26 Sep 2026', ms: 1, totalRecords: 95, omitted: 5, folded: [foldedRow('r1')], standing: [] },
    ])
    const html = renderToStaticMarkup(<BlockerReading report={report} />)
    expect(html).toContain('5 more lines not shown')
  })

  it('omitted === 0: no "not shown" line at all — nothing was folded away', () => {
    const report = baseReport([
      { key: '2026-09-26', label: 'Sat 26 Sep 2026', ms: 1, totalRecords: 1, omitted: 0, folded: [foldedRow('r2')], standing: [] },
    ])
    const html = renderToStaticMarkup(<BlockerReading report={report} />)
    expect(html).not.toContain('not shown')
  })

  it('singular: omitted === 1 says "1 more line not shown", not "lines"', () => {
    const report = baseReport([
      { key: '2026-09-26', label: 'Sat 26 Sep 2026', ms: 1, totalRecords: 91, omitted: 1, folded: [foldedRow('r3')], standing: [] },
    ])
    const html = renderToStaticMarkup(<BlockerReading report={report} />)
    expect(html).toContain('1 more line not shown')
    expect(html).not.toContain('1 more lines not shown')
  })

  it('two days: omitted is per-day, not a report-wide total', () => {
    const report = baseReport([
      { key: '2026-09-26', label: 'Sat 26 Sep 2026', ms: 2, totalRecords: 95, omitted: 5, folded: [foldedRow('r4')], standing: [] },
      { key: '2026-09-25', label: 'Fri 25 Sep 2026', ms: 1, totalRecords: 3, omitted: 0, folded: [foldedRow('r5')], standing: [] },
    ])
    const html = renderToStaticMarkup(<BlockerReading report={report} />)
    expect(html).toContain('5 more lines not shown')
    expect((html.match(/more lines? not shown/g) || []).length).toBe(1)
  })
})
