// The engine status surfaces render the server's record (react-dom/server:
// first render only, no effects — the readings themselves are tested in
// src/lib/engine-status-view.test.js).
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EngineRow, BlockerList } from './EngineStatusPanel.jsx'
import { blockerGroups } from '../lib/engine-status-view.js'

const row = (o = {}) => ({ accountId: '…9908', environment: 'demo', requestedEntryMode: 'TIME_BASED', effectiveEntryMode: 'STOPPED', transitionState: 'WARMING', configRevision: 4, modeEpoch: 3, tickObservation: 'SHADOW', validationStage: 'REPLAY_PASSED', entryCounts: { resting: 1, inFlight: 0, unknown: 0 }, ...o })
const readiness = { ready: false, blockedReasons: ['validation_stage', 'recorder_status_fresh'], readiness: [
  { check: 'validation_stage', ok: false, blockClass: 'missing_evidence', observed: 'REPLAY_PASSED', source: 'engine_status_json.validationStage', remedy: 'reach SHADOW_PASSED', at: null },
  { check: 'recorder_status_fresh', ok: false, blockClass: 'infrastructure', observed: 'never pulled', source: 'cpp_exec_demo_tick_json.at', remedy: 'check the sidecar', at: null },
  { check: 'account_enabled', ok: true, blockClass: null, observed: 'true', source: 'accounts.enabled', remedy: null, at: null },
] }

describe('EngineRow', () => {
  it('shows requested and effective side by side, the transition, revision and epoch, and the Tick button disabled with the server\'s blockers', () => {
    const html = renderToStaticMarkup(<EngineRow row={row()} readiness={readiness} fullId="46979908" busy={false} onMode={() => {}} at={Date.now()} />)
    expect(html).toMatch(/requested <b>Time-based<\/b> · effective <b>Stopped<\/b> · WARMING/)
    expect(html).toMatch(/rev 4 · epoch 3/)
    expect(html).toMatch(/2 blockers/)
    expect(html).toMatch(/Tick momentum is refused: 2 blockers: validation_stage, recorder_status_fresh/)
    expect(html).toMatch(/Why not tick-ready \(2\)/)
    const list = renderToStaticMarkup(<BlockerList groups={blockerGroups(readiness)} />)
    expect(list).toMatch(/Missing evidence/); expect(list).toMatch(/Infrastructure/)
    expect(list).toMatch(/remedy: check the sidecar/)
    expect(list).not.toMatch(/account_enabled/)
  })
  it('disables Stop when STOPPED is already requested and both actions when the full id is unknown', () => {
    const stopped = renderToStaticMarkup(<EngineRow row={row({ requestedEntryMode: 'STOPPED', effectiveEntryMode: 'STOPPED', transitionState: 'STABLE' })} readiness={null} fullId="46979908" busy={false} onMode={() => {}} at={null} />)
    expect(stopped).toMatch(/Entries stopped/)
    const noId = renderToStaticMarkup(<EngineRow row={row()} readiness={null} fullId={null} busy={false} onMode={() => {}} at={null} />)
    expect(noId).toMatch(/full account id is not on this page yet/)
  })
})
