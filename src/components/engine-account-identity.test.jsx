import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import EngineStatusPanel from './EngineStatusPanel.jsx'

const fixture = vi.hoisted(() => ({ engines: null }))
vi.mock('../lib/use-engine-status.js', () => ({
  useEngineStatus: () => fixture.engines, refreshEngineStatus: vi.fn(),
}))

const ids = ['43097342', '46130058', '46979908', '47790949', '42993489', '43002148', '43069009']
function setup(accountIds = ids) {
  const accounts = accountIds.map(id => ({ accountId: `…${id.slice(-4)}`, routingAccountId: id, environment: 'demo',
    requestedEntryMode: 'TIME_BASED', effectiveEntryMode: 'TIME_BASED', transitionState: 'STABLE',
    configRevision: 2, modeEpoch: 0, tickObservation: 'SHADOW', validationStage: 'UNVALIDATED' }))
  fixture.engines = { at: Date.now(), engines: { accounts }, readiness: { accounts: accounts.map(a => ({
    accountId: a.accountId, routingAccountId: a.routingAccountId, ready: false, blockedReasons: ['validation_stage'], readiness: [],
  })) } }
}
function buttons(html, label) {
  return [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].filter(m => m[2] === label).map(m => m[1])
}

describe('entry controls use registered account identities', () => {
  it('keeps all seven Stop controls available with only the selected broker snapshot loaded', () => {
    setup()
    const html = renderToStaticMarkup(<EngineStatusPanel accounts={[{ accountId: ids[1] }]} />)
    expect(buttons(html, 'Stop entries')).toHaveLength(7)
    expect(buttons(html, 'Stop entries').filter(attrs => /(?:^|\s)disabled(?:=|\s|$)/.test(attrs))).toHaveLength(0)
    expect(buttons(html, 'Tick momentum').filter(attrs => /(?:^|\s)disabled(?:=|\s|$)/.test(attrs))).toHaveLength(7)
  })

  it('refuses two registered accounts sharing a masked suffix, even if one snapshot is loaded', () => {
    setup(['11119908', '22229908'])
    fixture.engines.engines.accounts.forEach(a => { delete a.routingAccountId })
    const html = renderToStaticMarkup(<EngineStatusPanel accounts={[{ accountId: '11119908' }]} />)
    expect(buttons(html, 'Stop entries')).toHaveLength(2)
    expect(buttons(html, 'Stop entries').every(attrs => /(?:^|\s)disabled(?:=|\s|$)/.test(attrs))).toBe(true)
    expect(buttons(html, 'Stop all').every(attrs => /(?:^|\s)disabled(?:=|\s|$)/.test(attrs))).toBe(true)
  })

  it('keeps per-account and bulk controls unavailable until the engine returns an explicit identity', () => {
    setup()
    fixture.engines.engines.accounts.forEach(a => { delete a.routingAccountId })
    const html = renderToStaticMarkup(<EngineStatusPanel accounts={[{ accountId: ids[1] }]} />)
    expect(buttons(html, 'Stop entries').filter(attrs => /(?:^|\s)disabled(?:=|\s|$)/.test(attrs))).toHaveLength(7)
    expect(buttons(html, 'Stop all')).toHaveLength(1)
    expect(buttons(html, 'Stop all')[0]).toMatch(/\sdisabled=/)
  })
})
