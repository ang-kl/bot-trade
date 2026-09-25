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
