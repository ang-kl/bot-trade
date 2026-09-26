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
  // S1a: a null readiness reads as an honest "no record" badge, never a
  // silently missing one — the shape that used to happen for EVERY row the
  // instant a `?account=` narrowed read replaced the roster form.
  it('shows "no record" when there is no readiness for this row, rather than omitting the badge', () => {
    const html = renderToStaticMarkup(<EngineRow row={row()} readiness={null} fullId="46979908" busy={false} onMode={() => {}} at={null} />)
    expect(html).toMatch(/>no record</)
  })
})

// WP-A (dual admission, 25-09-2026): four selections; the tick half shown as
// BLOCKED in visible text with the server's failing checks (principle 6).
function button(html, label) {
  const esc = label.replace(/[+]/g, '\\+')
  const m = html.match(new RegExp(`<button[^>]*>${esc}</button>`))
  if (!m) throw new Error(`no ${label} button rendered`)
  return m[0]
}
describe('EngineRow — WP-A selections', () => {
  it('renders Stop / Time-based / Tick momentum / Time + tick; with readiness not ready the two tick selections are disabled and the visible text says tick BLOCKED with the failing checks', () => {
    const html = renderToStaticMarkup(<EngineRow row={row({ effectiveEntryMode: 'TIME_BASED', transitionState: 'STABLE' })} readiness={readiness} fullId="46979908" busy={false} onMode={() => {}} at={Date.now()} />)
    for (const l of ['Stop entries', 'Time-based', 'Tick momentum', 'Time + tick']) button(html, l)
    expect(button(html, 'Time + tick')).toMatch(/disabled=""/)
    expect(button(html, 'Time + tick')).toMatch(/Time \+ tick is refused: 2 blockers: validation_stage, recorder_status_fresh/)
    expect(html).toMatch(/>tick BLOCKED — 2 blockers: validation_stage, recorder_status_fresh</)
  })
  it('on a STABLE Time + tick row, Time-based is NOT disabled (a human can go back to time only) and Time + tick is disabled as the current selection', () => {
    const ready = { ready: true, blockedReasons: [], readiness: [] }
    const dual = row({ effectiveEntryMode: 'TIME_BASED', transitionState: 'STABLE', admittedBases: ['bar', 'tick'], bases: ['bar', 'tick'] })
    const html = renderToStaticMarkup(<EngineRow row={dual} readiness={ready} fullId="46979908" busy={false} onMode={() => {}} at={Date.now()} />)
    expect(button(html, 'Time-based')).not.toMatch(/disabled=""/)
    expect(button(html, 'Time + tick')).toMatch(/disabled=""/)
    expect(button(html, 'Tick momentum')).not.toMatch(/disabled=""/)
    expect(html).toMatch(/Time \+ tick entries/)
    expect(html).toMatch(/admits <b>bar \+ tick<\/b>/)
    expect(html).not.toMatch(/tick BLOCKED/)
  })
  it('with readiness unanswered it claims no verdict: "tick status unknown", never BLOCKED', () => {
    const html = renderToStaticMarkup(<EngineRow row={row()} readiness={null} fullId="46979908" busy={false} onMode={() => {}} at={null} />)
    expect(html).toMatch(/tick status unknown — readiness not answered/)
    expect(html).not.toMatch(/tick BLOCKED/)
    expect(button(html, 'Time + tick')).toMatch(/disabled=""/)
  })
  it('a WARMING Time + tick request reads as the request, admits nothing yet, and can be taken back to Time-based', () => {
    const ready = { ready: true, blockedReasons: [], readiness: [] }
    const warming = row({ admittedBases: ['bar', 'tick'], bases: [] })
    const html = renderToStaticMarkup(<EngineRow row={warming} readiness={ready} fullId="46979908" busy={false} onMode={() => {}} at={Date.now()} />)
    expect(html).toMatch(/Time \+ tick · warming/)
    expect(html, 'checker nit 5: the requested text names the selection the badge names, not "Time-based"').toMatch(/requested <b>Time \+ tick<\/b> · effective <b>Stopped<\/b>/)
    expect(html).toMatch(/admits <b>nothing<\/b>/)
    expect(button(html, 'Time + tick')).toMatch(/disabled=""/)
    expect(button(html, 'Time-based')).not.toMatch(/disabled=""/)
    expect(button(html, 'Tick momentum')).not.toMatch(/disabled=""/)
  })
})
