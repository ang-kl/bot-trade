// PR-G (owner principle 2): the Tick momentum button follows the LIVE
// readiness predicate with the server's blockers in its title, and the
// policy switch renders the server's value and posts the policy with the
// revision (react-dom/server: first render; the post is exercised through
// the pure submit the component calls).
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EngineRow } from './EngineStatusPanel.jsx'
import EntryModePolicySwitch from './EntryModePolicySwitch.jsx'
import { submitEntryModePolicy } from '../lib/entry-mode-policy.js'

const row = (o = {}) => ({ accountId: '…9908', environment: 'demo', requestedEntryMode: 'TIME_BASED', effectiveEntryMode: 'TIME_BASED', transitionState: 'STABLE', configRevision: 4, modeEpoch: 3, tickObservation: 'SHADOW', entryModePolicy: 'manual', validationStage: 'SHADOW_PASSED', entryCounts: { resting: 0, inFlight: 0, unknown: 0 }, ...o })
const notReady = { ready: false, blockedReasons: ['validation_stage', 'recorder_status_fresh'], readiness: [
  { check: 'validation_stage', ok: false, blockClass: 'missing_evidence', observed: 'REPLAY_PASSED', source: 'engine_status_json.validationStage', remedy: 'reach SHADOW_PASSED', at: null },
  { check: 'recorder_status_fresh', ok: false, blockClass: 'infrastructure', observed: 'never pulled', source: 'cpp_exec_demo_tick_json.at', remedy: 'check the sidecar', at: null },
] }
const ready = { ready: true, blockedReasons: [], readiness: [] }

// the Tick button's markup, whichever attribute order the renderer chooses
function tickButton(html) {
  const m = html.match(/<button[^>]*>Tick momentum<\/button>/)
  if (!m) throw new Error('no Tick momentum button rendered')
  return m[0]
}

describe('Tick momentum button (PR-G)', () => {
  it('is disabled with the live blockers in its title when readiness is not ready', () => {
    const html = renderToStaticMarkup(<EngineRow row={row()} readiness={notReady} fullId="46979908" busy={false} onMode={() => {}} at={Date.now()} />)
    const btn = tickButton(html)
    expect(btn).toMatch(/disabled=""/)
    expect(btn).toMatch(/Tick momentum is refused: 2 blockers: validation_stage, recorder_status_fresh/)
  })
  it('is enabled when readiness says ready and the mode is not already tick; disabled again once tick is requested or readiness is unanswered', () => {
    const on = tickButton(renderToStaticMarkup(<EngineRow row={row()} readiness={ready} fullId="46979908" busy={false} onMode={() => {}} at={Date.now()} />))
    expect(on).not.toMatch(/disabled=""/)
    expect(on).toMatch(/every readiness check holds/)
    const already = tickButton(renderToStaticMarkup(<EngineRow row={row({ requestedEntryMode: 'TICK_MOMENTUM', effectiveEntryMode: 'TICK_MOMENTUM' })} readiness={ready} fullId="46979908" busy={false} onMode={() => {}} at={Date.now()} />))
    expect(already).toMatch(/disabled=""/)
    const unanswered = tickButton(renderToStaticMarkup(<EngineRow row={row()} readiness={null} fullId="46979908" busy={false} onMode={() => {}} at={null} />))
    expect(unanswered).toMatch(/disabled=""/)
    expect(unanswered).toMatch(/readiness not answered yet/)
  })
})

describe('EntryModePolicySwitch (PR-G)', () => {
  it('renders the server\'s policy as the selected option, both choices, and is disabled without the full id', () => {
    const html = renderToStaticMarkup(<EntryModePolicySwitch row={row({ entryModePolicy: 'auto' })} fullId="46979908" />)
    expect(html).toMatch(/<option value="manual">Manual \(human only\)<\/option>/)
    expect(html).toMatch(/<option value="auto" selected="">Auto \(bot may switch\)<\/option>/)
    expect(html).toMatch(/data-testid="entry-mode-policy-…9908"/)
    const manual = renderToStaticMarkup(<EntryModePolicySwitch row={row()} fullId="46979908" />)
    expect(manual).toMatch(/<option value="manual" selected="">/)
    const noId = renderToStaticMarkup(<EntryModePolicySwitch row={row()} fullId={null} />)
    expect(noId).toMatch(/<select[^>]*disabled=""/)
    // an unknown stored value falls back to manual on screen, never auto
    expect(renderToStaticMarkup(<EntryModePolicySwitch row={row({ entryModePolicy: 'sometimes' })} fullId="46979908" />)).toMatch(/<option value="manual" selected="">/)
    // the panel row carries the switch
    expect(renderToStaticMarkup(<EngineRow row={row()} readiness={ready} fullId="46979908" busy={false} onMode={() => {}} at={null} />)).toMatch(/switch policy/)
  })
  it('posts { accountId, policy, expectedRevision } to /actions/entry-mode-policy and reports a 409 as a revision conflict', async () => {
    const calls = []
    const post = async (path, body) => { calls.push({ path, body }); return { ok: true, changed: true, status: { entryModePolicy: body.policy, configRevision: body.expectedRevision + 1 } } }
    const r = await submitEntryModePolicy({ post, accountId: '46979908', policy: 'auto', expectedRevision: 4 })
    expect(calls).toEqual([{ path: '/actions/entry-mode-policy', body: { accountId: '46979908', policy: 'auto', expectedRevision: 4 } }])
    expect(r.ok).toBe(true); expect(r.status.entryModePolicy).toBe('auto'); expect(r.status.configRevision).toBe(5)
    const stale = await submitEntryModePolicy({ post: async () => { throw new Error('HTTP 409 revision_conflict') }, accountId: '46979908', policy: 'manual', expectedRevision: 4 })
    expect(stale.ok).toBe(false); expect(stale.error).toMatch(/revision_conflict/)
    expect((await submitEntryModePolicy({ post, accountId: null, policy: 'auto', expectedRevision: 1 })).ok).toBe(false)
    expect((await submitEntryModePolicy({ post, accountId: '46979908', policy: 'sometimes', expectedRevision: 1 })).ok).toBe(false)
    expect(calls.length).toBe(1, 'a refused submit never reaches the server')
  })
})

describe('refreshEngineStatusAfterAction (PR-G, checker minor 10)', () => {
  it('is exported by the store and is what the switch calls after a post, not the plain refresh', async () => {
    const store = await import('../lib/use-engine-status.js')
    expect(typeof store.refreshEngineStatusAfterAction).toBe('function')
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./EntryModePolicySwitch.jsx', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(src).toMatch(/refreshEngineStatusAfterAction\(\)/)
    expect(src).not.toMatch(/\brefreshEngineStatus\(\)/)
    const panel = readFileSync(new URL('./EngineStatusPanel.jsx', import.meta.url), 'utf8')
    expect(panel).not.toMatch(/tick entry path \(P6\) exists/)
  })
})
