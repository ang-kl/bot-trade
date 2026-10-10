// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PreorderResult from './PreorderResult.jsx'

const ready = {
  ok: true, approved: true, firstBlock: null, gate: { approved: true },
  numbers: { volume: 0.14, volumeBasis: 'approved', moneyAtRisk: 140, currency: 'USD', dailyStopLeft: 400, shareOfStopLeft: 35, marginShare: null, openPositions: 0, maxPositions: 5, rr: 3.5, rrFloor: 3 },
  strategy: { key: 'manual', last20: { n: 0, winRatePct: null, profitFactor: 0 }, allowedBy: 'not_consulted' },
  expectedR: { value: null, reason: 'not computed' }, notChecked: ['a', 'b'],
}

describe('PreorderResult — words, not colour alone', () => {
  it('Ready, with the size and money at risk in the account of the gate', () => {
    const html = renderToStaticMarkup(<PreorderResult result={ready} />)
    expect(html).toContain('Ready — the risk gate would approve this order now')
    expect(html).toContain('0.14 lots')
    expect(html).toContain('USD 140')
    expect(html).toContain('35% of USD 400 left')
    expect(html).toContain('0 / 5')
    expect(html).toContain('no closes yet')
    expect(html).toContain('not consulted (manual order)')
    expect(html).toContain('Expected R: not computed')
    expect(html).toContain('nothing was recorded or sent')
    expect(html).toContain('role="status"')
  })

  it('a block is named in words, and an upstream stop says the gate\'s own verdict too', () => {
    const html = renderToStaticMarkup(<PreorderResult result={{ ...ready, approved: false, firstBlock: { stage: 'evidence_gate', reason: 'evidence_gate: x', label: 'evidence gate: x' } }} />)
    expect(html).toContain('Blocked — evidence gate: x')
    expect(html).toContain('Stopped before the risk gate (evidence gate)')
    expect(html).toContain('would approve')
  })

  it('cannot-check and busy states say so', () => {
    expect(renderToStaticMarkup(<PreorderResult result={{ ok: false, cannotCheck: 'cannot check: cTrader credentials not configured' }} />))
      .toContain('Cannot check: cTrader credentials not configured')
    expect(renderToStaticMarkup(<PreorderResult busy />)).toContain('Checking with the risk gate')
  })
})
