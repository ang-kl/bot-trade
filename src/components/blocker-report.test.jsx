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

test('V3 WEB-1: roster-wide stops are shown under an account, labelled roster-wide, outside its totals; a server that does not report them is never a zero', () => {
  const summary = Object.fromEntries(['upstream_stop', 'risk_refusal', 'post_approval_failure', 'tick_refusal', 'approved', 'placement_receipt', 'other_stop'].map(k => [k, { records: 0 }]))
  const base = { totalRecords: 1, offset: 0, unattributedRecordsInWindow: 0, summary,
    records: [{ recordId: 'decision_log:9', kind: 'upstream_stop', stage: 'stage_matrix', accountId: '22', attribution: 'account', unsplitHistory: true,
      symbol: 'EURUSD', at: '2026-09-22 11:30:00', firstBlocker: { reason: 'off', status: 'recorded' }, recordedEvaluations: 1, diagnostics: [] }],
    unsplitRecordsInWindow: 1, unsplitNote: 'Records written before the attribution fix cannot be split.' }
  const report = { ...base, rosterWide: { records: 9970, includedInTotals: false, note: 'They apply to every account and are charged to none.',
    byStage: [{ kind: 'upstream_stop', stage: 'armed_scope_prefilter', records: 5970, recordedAgainstAnAccount: 5970, lastReason: 'no armed timeframe' }] } }
  const html = renderToStaticMarkup(<BlockerReading report={report} />)
  expect(html).toContain('Roster-wide stops (every account, charged to none): 9970 records')
  expect(html).toContain('Not included in this account&#x27;s totals above.')
  expect(html).toContain('armed_scope_prefilter (Upstream stops) ×5970 — 5970 stored by an older build against the then-selected account')
  expect(html).toContain('1 of these records cannot be split.')
  expect(html).toContain('22 (recorded before the attribution fix; may not be this account&#x27;s)')
  const all = renderToStaticMarkup(<BlockerReading report={{ ...report, rosterWide: { ...report.rosterWide, includedInTotals: true },
    records: [{ ...base.records[0], accountId: null, attribution: 'roster', unsplitHistory: false }] }} />)
  expect(all).toContain('Included in the totals above.')
  expect(all).toContain('Roster-wide (every account) / EURUSD')
  const older = renderToStaticMarkup(<BlockerReading report={base} />)
  expect(older).toContain('Roster-wide stops: not reported by this agent version.')
  expect(older).not.toContain('Roster-wide stops (every account, charged to none): 0')
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

// ---------------------------------------------------------------------------
// V3 UI-3 (26-09 plan §8 item 3): server-grouped days on the shared DataTable.
// Every test above hands BlockerReading a report with no `.days`, and the
// old flat table still renders for it (asserted above); these hand it a
// server-shaped `days` array instead.
// ---------------------------------------------------------------------------
const summaryOf = (overrides = {}) => Object.fromEntries(['upstream_stop', 'risk_refusal', 'post_approval_failure', 'tick_refusal', 'approved', 'placement_receipt', 'other_stop'].map(k => [k, { records: overrides[k] ?? 0 }]))
const dayReport = (days, overrides = {}) => ({
  totalRecords: days.reduce((n, d) => n + d.totalRecords, 0), offset: 0, unattributedRecordsInWindow: 0,
  summary: summaryOf(), records: [], timeZone: 'Asia/Singapore', days, ...overrides,
})

test('UI-3: a folded day group renders its label, its day count, and each folded row once (not once per repeat)', () => {
  const days = [{ key: '2026-09-26', label: 'Sat 26 Sep 2026', ms: 1, totalRecords: 42, standing: [], folded: [
    { count: 42, firstAt: '2026-09-26T06:05:00.000Z', lastAt: '2026-09-26T06:45:00.000Z', preFixLabel: null,
      sample: { recordId: 'decision_log:1', kind: 'upstream_stop', stage: 'stage_matrix', accountId: '11', attribution: 'account',
        symbol: 'BTCUSD', at: '2026-09-26T06:45:00.000Z', firstBlocker: { reason: 'off', status: 'recorded' }, recordedEvaluations: 1, diagnostics: [] } },
  ] }]
  const html = renderToStaticMarkup(<BlockerReading report={dayReport(days)} />)
  expect(html).toContain('Sat 26 Sep 2026')
  expect(html).toContain('42 records this day')
  expect(html).toContain('×42')
  expect((html.match(/BTCUSD/g) || []).length).toBe(1)
})

test('UI-3 fix round (blocker 1): a single-occurrence row reads its time from the fold\'s own lastAt, never the raw stored sample.at; a UTC line accompanies it', () => {
  const days = [{ key: '2026-09-25', label: 'Fri 25 Sep 2026', ms: 1, totalRecords: 1, standing: [], folded: [
    { count: 1, firstAt: '2026-09-25T06:45:24.000Z', lastAt: '2026-09-25T06:45:24.000Z', preFixLabel: null,
      // sample.at is the raw, zone-less SQLite string a real row carries —
      // deliberately a DIFFERENT clock reading (22:45) than lastAt (06:45),
      // so a render that still reaches for sample.at is caught regardless of
      // the test process's own time zone (date-zones.js's own caveat: a
      // bare `new Date('...')` on this shape depends on the host TZ).
      sample: { recordId: 'decision_log:1', kind: 'upstream_stop', stage: 'stage_matrix', accountId: '11', attribution: 'account',
        symbol: 'EURUSD', at: '2026-09-25 22:45:24', firstBlocker: { reason: 'off', status: 'recorded' }, recordedEvaluations: 1, diagnostics: [] } },
  ] }]
  const html = renderToStaticMarkup(<BlockerReading report={dayReport(days)} />)
  expect(html).toContain('14:45') // 2026-09-25T06:45:24Z in Asia/Singapore (UTC+8)
  expect(html).not.toContain('22:45')
  expect(html).toContain('06:45 UTC')
})

test('UI-3: a pre-fix badge shows for a flagged fold entry and never for a clean one', () => {
  const foldedWithBadge = { count: 1, firstAt: 'x', lastAt: 'x', preFixLabel: 'cannot be split (before #1115)',
    sample: { recordId: 'decision_log:1', kind: 'upstream_stop', stage: 'stage_matrix', accountId: '11', attribution: 'account',
      symbol: 'EURUSD', at: '2026-09-20T02:00:00.000Z', firstBlocker: { reason: 'off', status: 'recorded' }, recordedEvaluations: 1, diagnostics: [] } }
  const clean = { ...foldedWithBadge, preFixLabel: null, sample: { ...foldedWithBadge.sample, recordId: 'decision_log:2' } }
  const days = [{ key: '2026-09-20', label: 'Sun 20 Sep 2026', ms: 1, totalRecords: 2, standing: [], folded: [foldedWithBadge, clean] }]
  const html = renderToStaticMarkup(<BlockerReading report={dayReport(days)} />)
  expect(html).toContain('cannot be split (before #1115)')
  // W1.3 checker nit: the assertion above only checked presence, so it could
  // not tell "shown once, for the flagged row" from "shown for both rows" —
  // exactly the failure this test's own name claims to rule out.
  expect((html.match(/cannot be split \(before #1115\)/g) || []).length).toBe(1)
})

test('UI-3: a roster-only day (no folded rows) still renders its standing lines, never "No retained decision records"', () => {
  const days = [{ key: '2026-09-26', label: 'Sat 26 Sep 2026', ms: 1, totalRecords: 0, folded: [],
    standing: [{ count: 5, firstAt: 'x', lastAt: 'y', sample: { kind: 'upstream_stop', stage: 'armed_scope_prefilter', reason: 'no armed timeframe', firstBlocker: null } }] }]
  const html = renderToStaticMarkup(<BlockerReading report={dayReport(days)} />)
  expect(html).toContain('Sat 26 Sep 2026')
  expect(html).toContain('Applies to every account')
  expect(html).toContain('armed_scope_prefilter')
  expect(html).not.toContain('No retained decision records in this window')
})

test('UI-3 fix round (nit, §3 "an expandable count"): a fast_monitor fold renders its count AND stays expandable', () => {
  const days = [{ key: '2026-09-26', label: 'Sat 26 Sep 2026', ms: 1, totalRecords: 1, standing: [], folded: [
    { count: 12, evaluations: 12, firstAt: 'x', lastAt: 'y', preFixLabel: null,
      sample: { recordId: 'decision_log:9', kind: 'other_stop', stage: 'fast_monitor', accountId: '11', attribution: 'account',
        symbol: 'EURUSD', at: 'x', firstBlocker: null, recordedEvaluations: 1, diagnostics: [] } },
  ] }]
  const html = renderToStaticMarkup(<BlockerReading report={dayReport(days)} />)
  expect(html).toContain('managed, ×12')
  expect(html).toContain('Show details')
})

test('V3 C4: tick sidecar refusals are counted under their own label, and an account the sidecar never checked reads "not evaluated"', () => {
  const report = {
    totalRecords: 2, offset: 0, unattributedRecordsInWindow: 0,
    summary: Object.fromEntries(['upstream_stop', 'risk_refusal', 'post_approval_failure', 'tick_refusal', 'approved', 'placement_receipt', 'other_stop'].map(k => [k, { records: k === 'tick_refusal' ? 2 : 0 }])),
    records: [{ recordId: 'cpp_decisions:1', kind: 'tick_refusal', stage: 'tick_fire:no_permit', accountId: '11', symbol: 'symbolId 41',
      at: '2026-09-22 11:30:00', firstBlocker: { stage: 'tick_fire:no_permit', reason: 'no_permit — BUY', status: 'recorded' }, recordedEvaluations: 1,
      diagnostics: [{ stage: 'node_permit', status: 'absent' }, { stage: 'sidecar_checks', status: 'not_evaluated' }, { stage: 'broker', status: 'not_evaluated' }] }],
    tick: {
      evaluationNote: 'Zero sidecar refusals on an account that is not_evaluated is not a pass.',
      accounts: [
        { accountId: '11', status: 'not_evaluated', because: 'basis_not_admitted', readiness: { blockedReasons: ['profile_pinned', 'replay_evidence'] }, sidecarRefusals: {} },
        { accountId: '22', status: 'admitted_not_pushed', because: 'no_fresh_feed_receipt', readiness: { blockedReasons: [] }, sidecarRefusals: { no_permit: 3 } },
      ],
      sides: [{ side: 'cpp_exec_demo', entry: { fills: 433, accounts: 0 }, statusAt: '2026-09-22T11:59:00Z', signalsInWindow: { shadow: 5, shadow_cost: 1, shadow_busy: 0, other: 0 } }],
    },
  }
  const html = renderToStaticMarkup(<BlockerReading report={report} />)
  expect(html).toContain('Tick sidecar refusals')
  expect(html).toContain('<dd class="font-semibold">2 records</dd>')
  expect(html).toContain('Tick entries: not evaluated — basis_not_admitted')
  expect(html).toContain('admitted but not pushed to the sidecar — no_fresh_feed_receipt')
  expect(html).toContain('no_permit ×3')
  expect(html).toContain('433 shadow fills since sidecar boot; 0 accounts placing')
  expect(html).toContain('node_permit: absent')
  expect(html).not.toContain('risk_gate')
})
