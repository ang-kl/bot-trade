import { describe, it, expect } from 'vitest'
import { engineState, engineReading, mixedSummary, mixedCounts, basesFor, blockerGroups, tickBlockedReason, tickSelectionNote, ackLine, requestedSelection, selectionBody, basesLabel, SELECTION_LABEL, STALE_AFTER_MS } from './engine-status-view.js'

const row = (o = {}) => ({ accountId: '…9908', requestedEntryMode: 'TIME_BASED', effectiveEntryMode: 'TIME_BASED', transitionState: 'STABLE', configRevision: 3, modeEpoch: 2, entryCounts: { resting: 0, unknown: 0 }, ...o })

describe('engineState', () => {
  it('reads the server record, never a flag', () => {
    expect(engineState(row())).toBe('active')
    expect(engineState(row({ requestedEntryMode: 'STOPPED', effectiveEntryMode: 'STOPPED' }))).toBe('stopped')
    expect(engineState(row({ requestedEntryMode: 'TIME_BASED', effectiveEntryMode: 'STOPPED', transitionState: 'WARMING' }))).toBe('warming')
    expect(engineState(row({ requestedEntryMode: 'STOPPED', effectiveEntryMode: 'STOPPED', transitionState: 'QUIESCING' }))).toBe('switching')
    expect(engineState(row({ requestedEntryMode: 'TIME_BASED', effectiveEntryMode: 'STOPPED', transitionState: 'RECONCILING' }))).toBe('switching')
    expect(engineState(row({ transitionState: 'BLOCKED', effectiveEntryMode: 'STOPPED' }))).toBe('blocked')
    expect(engineState(row({ invalid: ['x'] }))).toBe('blocked')
    expect(engineState(null)).toBe('unknown')
  })
})

describe('engineReading', () => {
  it('shows requested AND effective during a transition, and says entries stay stopped while warming', () => {
    const r = engineReading(row({ requestedEntryMode: 'TIME_BASED', effectiveEntryMode: 'STOPPED', transitionState: 'WARMING' }))
    expect(r.label).toMatch(/warming/)
    expect(r.detail).toMatch(/stay stopped/)
    expect(r.tone).toBe('warning')
  })
  it('names the blocker on a failed acknowledgement', () => {
    const r = engineReading(row({ effectiveEntryMode: 'STOPPED', transitionState: 'BLOCKED', blockedReason: 'guard push failed' }))
    expect(r.state).toBe('blocked'); expect(r.detail).toMatch(/guard push failed/); expect(r.tone).toBe('down')
  })
  it('marks a stale answer and drops the state tone, so an old green is not shown as current', () => {
    const now = 1_000_000
    const r = engineReading(row(), { now, at: now - STALE_AFTER_MS - 1 })
    expect(r.stale).toBe(true); expect(r.detail).toMatch(/STALE/); expect(r.tone).toBe('neutral')
    expect(engineReading(row(), { now, at: now - 1000 }).stale).toBe(false)
  })
  it('says unknown when nothing was answered', () => {
    expect(engineReading(null).state).toBe('unknown')
  })
})

describe('mixedSummary / blockerGroups / tickBlockedReason / ackLine', () => {
  it('counts every state across accounts', () => {
    expect(mixedSummary([row(), row({ effectiveEntryMode: 'STOPPED', requestedEntryMode: 'STOPPED' }), row({ transitionState: 'BLOCKED', effectiveEntryMode: 'STOPPED' })])).toBe('1 active · 1 stopped · 1 blocked')
    expect(mixedSummary([])).toBe('no accounts')
  })
  it('groups the server\'s failed checks by class with their remedies and leaves passed checks out', () => {
    const g = blockerGroups({ readiness: [
      { check: 'a', ok: true, blockClass: null, remedy: null },
      { check: 'validation_stage', ok: false, blockClass: 'missing_evidence', remedy: 'import evidence', observed: 'UNVALIDATED', source: 's', at: null },
      { check: 'recorder_status_fresh', ok: false, blockClass: 'infrastructure', remedy: 'check the sidecar', observed: 'never pulled', source: 's', at: null },
      { check: 'profile_pinned', ok: false, blockClass: 'missing_evidence', remedy: 'import', observed: 'none', source: 's', at: null },
    ] })
    expect(g.map(x => x.key)).toEqual(['missing_evidence', 'infrastructure'])
    expect(g[0].checks.map(c => c.check)).toEqual(['validation_stage', 'profile_pinned'])
    expect(g[0].label).toBe('Missing evidence')
  })
  it('the Tick button\'s reason is the server\'s blocker list, null only when the server says ready', () => {
    expect(tickBlockedReason(null)).toMatch(/not answered/)
    expect(tickBlockedReason({ ready: true, blockedReasons: [] })).toBe(null)
    expect(tickBlockedReason({ ready: false, blockedReasons: ['a', 'b', 'c', 'd', 'e'] })).toBe('5 blockers: a, b, c, d, …')
  })
  it('one acknowledgement line per account: refused, not acknowledged, acknowledged', () => {
    expect(ackLine({ error: 'revision_conflict' })).toMatch(/refused: revision_conflict/)
    expect(ackLine({ status: { transitionState: 'BLOCKED' }, gateway: { pushed: false, error: 'no credentials' } })).toMatch(/NOT acknowledged — no credentials/)
    expect(ackLine({ status: { transitionState: 'STABLE', effectiveEntryMode: 'STOPPED' }, gateway: { side: 'cpp_exec_demo', pushed: true, acked: [1, 2] } })).toBe('cpp_exec_demo acknowledged 2 epochs → STABLE / effective Stopped')
  })
})

// WP-A (dual admission, 25-09-2026): four selections, read from the REQUESTED
// bases (order-insensitive), never the mode string first.
describe('WP-A selections', () => {
  it('requestedSelection reads the requested bases as a set; an absent admittedBases is the mode\'s own basis', () => {
    expect(requestedSelection(row({ requestedEntryMode: 'STOPPED', effectiveEntryMode: 'STOPPED' }))).toBe('stopped')
    expect(requestedSelection(row())).toBe('time')
    expect(requestedSelection(row({ admittedBases: null }))).toBe('time')
    expect(requestedSelection(row({ requestedEntryMode: 'TICK_MOMENTUM', admittedBases: null }))).toBe('tick')
    expect(requestedSelection(row({ admittedBases: ['bar', 'tick'] }))).toBe('time+tick')
    expect(requestedSelection(row({ admittedBases: ['tick', 'bar'] }))).toBe('time+tick')
    expect(requestedSelection(row({ admittedBases: ['tick'] }))).toBe('tick')
    expect(requestedSelection(row({ requestedEntryMode: 'TICK_MOMENTUM', admittedBases: ['bar', 'tick'] }))).toBe('time+tick')
    expect(requestedSelection(row({ requestedEntryMode: 'STOPPED', admittedBases: ['bar', 'tick'] }))).toBe('stopped')
  })
  it('selectionBody is the exact POST body for each selection', () => {
    expect(selectionBody('time+tick', '46979908', 4)).toEqual({ accountId: '46979908', mode: 'TIME_BASED', admittedBases: ['bar', 'tick'], expectedRevision: 4 })
    expect(selectionBody('time', '46979908', 4)).toEqual({ accountId: '46979908', mode: 'TIME_BASED', expectedRevision: 4 })
    expect(selectionBody('tick', '46979908', 4)).toEqual({ accountId: '46979908', mode: 'TICK_MOMENTUM', expectedRevision: 4 })
    expect(selectionBody('stopped', '46979908', 4)).toEqual({ accountId: '46979908', mode: 'STOPPED', expectedRevision: 4 })
    expect(() => selectionBody('bogus', '1', 0)).toThrow()
    expect(SELECTION_LABEL['time+tick']).toBe('Time + tick')
  })
  it('engineReading labels a STABLE dual row from its bases, falls back to the mode when bases are absent, and labels a warming dual request by its selection', () => {
    expect(engineReading(row({ admittedBases: ['bar', 'tick'], bases: ['bar', 'tick'] })).label).toBe('Time + tick entries')
    expect(engineReading(row()).label).toBe('Time-based entries')
    expect(engineReading(row({ bases: ['bar'] })).label).toBe('Time-based entries')
    const w = engineReading(row({ admittedBases: ['bar', 'tick'], effectiveEntryMode: 'STOPPED', transitionState: 'WARMING', bases: [] }))
    expect(w.label).toBe('Time + tick · warming')
  })
  it('ackLine names the bases the server reports; basesLabel reads a set', () => {
    expect(ackLine({ status: { transitionState: 'STABLE', effectiveEntryMode: 'TIME_BASED' }, bases: ['bar', 'tick'], gateway: { side: 'cpp_exec_demo', pushed: true, acked: [1] } })).toBe('cpp_exec_demo acknowledged 1 epoch → STABLE / effective Time-based (admits bar + tick)')
    expect(basesLabel([])).toBe('nothing'); expect(basesLabel(undefined)).toBe('unknown')
  })
  it('tickSelectionNote: BLOCKED only on the server\'s ready:false, unknown while unanswered, nothing when ready', () => {
    expect(tickSelectionNote({ ready: false, blockedReasons: ['validation_stage', 'recorder_status_fresh'] })).toBe('tick BLOCKED — 2 blockers: validation_stage, recorder_status_fresh')
    expect(tickSelectionNote(null)).toBe('tick status unknown — readiness not answered')
    expect(tickSelectionNote({ ready: true, blockedReasons: [] })).toBe(null)
  })
})

describe('WP-A: basesFor mirror and mixed counts', () => {
  it('requestedSelection goes through basesFor on the REQUESTED mode; an unknown mode is no selection', () => {
    expect(basesFor({ effectiveEntryMode: 'STOPPED', admittedBases: ['bar'] })).toEqual([])
    expect(basesFor({ effectiveEntryMode: 'TIME_BASED' })).toEqual(['bar'])
    expect(basesFor({ effectiveEntryMode: 'TIME_BASED', admittedBases: [] })).toEqual(['bar'])
    expect(requestedSelection(row({ requestedEntryMode: 'BOGUS' }))).toBe(null)
    // a WARMING dual request: effective STOPPED, requested Time + tick
    expect(requestedSelection(row({ effectiveEntryMode: 'STOPPED', transitionState: 'WARMING', admittedBases: ['bar', 'tick'] }))).toBe('time+tick')
  })
  it('mixedCounts counts ACTIVE accounts whose effective bases include tick; a warming tick request is not counted', () => {
    const dual = row({ admittedBases: ['bar', 'tick'], bases: ['bar', 'tick'] })
    const warming = row({ admittedBases: ['bar', 'tick'], effectiveEntryMode: 'STOPPED', transitionState: 'WARMING', bases: [] })
    const c = mixedCounts([dual, warming, row({ bases: ['bar'] })])
    expect(c.tick).toBe(1); expect(c.active).toBe(2); expect(c.warming).toBe(1)
    expect(mixedSummary([dual, warming])).toBe('1 active · 1 warming · 1 admitting tick')
    expect(mixedCounts([row()]).tick).toBe(0)
  })
})
