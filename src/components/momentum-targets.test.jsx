import { test, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MomentumTargetsReading } from './MomentumTargets.jsx'

const plan = { side: 'BUY', entry: 100, trigger: 130.4, runnerTarget: 140.4, closeVolume: 2600, volume: 10000, closePercentage: 26, digits: 2 }
const status = pass => ({
  accountId: '11', executionAuthorized: false, runtimeIntegration: 'INCOMPLETE', recordedPlans: 1, truncated: false, pass,
  wiring: { market: { wired: false, status: 'not wired' }, limit: { wired: false, status: 'not wired' } },
  rows: [{ accountId: '11', tradeId: 7, symbol: 'ETHUSD', state: 'ENROLLED', target: plan,
    partial: { state: 'ARMED', reason: null, lastCheckAtMs: Date.parse('2026-09-25T13:00:00Z') } }],
})

test('V3 T3: the partial trigger is shown next to the runner TP while the manager runs', () => {
  const html = renderToStaticMarkup(<MomentumTargetsReading status={status({ at: '2026-09-25T13:00:00Z', fresh: true, ok: true })} />)
  expect(html).toContain('Partial manager: running — last pass 2026-09-25T13:00:00Z.')
  expect(html).toContain('Close 2600 of 10000 units (26%) when the bid reaches 130.4')
  expect(html).toContain('<td class="pr-3">140.4</td>')
  expect(html).not.toContain('unavailable')
  expect(html).toContain('market entries not wired · resting limits not wired')
  expect(html).toContain('Runtime integration: INCOMPLETE. Execution authorised: no.')
  expect(html).toContain('2026-09-25 13:00 UTC')
})

test('V3 T3: a stale pass keeps the trigger visible and labels it unavailable, never armed', () => {
  const html = renderToStaticMarkup(<MomentumTargetsReading status={status({ at: '2026-09-25T12:00:00Z', fresh: false,
    unavailable: 'the partial manager pass is stale: last pass 2026-09-25T12:00:00Z, 60 min ago (limit 15 min)' })} />)
  expect(html).toContain('Partial manager: unavailable — the partial manager pass is stale')
  expect(html).toContain('when the bid reaches 130.4 — unavailable: the partial manager is not running')
  expect(renderToStaticMarkup(<MomentumTargetsReading status={status(null)} />)).toContain('Partial manager: unavailable — its pass has never run on this agent.')
})

test('V3 T3: no status, and no plans, are said plainly', () => {
  expect(renderToStaticMarkup(<MomentumTargetsReading error="Agent not connected" />)).toContain('Momentum partial targets unavailable: Agent not connected')
  const empty = { ...status({ at: null, fresh: false }), rows: [], recordedPlans: 0 }
  const html = renderToStaticMarkup(<MomentumTargetsReading status={empty} />)
  expect(html).toContain('No momentum partial plan is recorded (0 recorded)')
  expect(html).toContain('never run')
})
