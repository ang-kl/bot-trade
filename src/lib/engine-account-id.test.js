import { describe, it, expect } from 'vitest'
import { engineAccountId, engineAccountBindings, engineReadinessFor } from './engine-status-view.js'

const row = id => ({ accountId: `…${id.slice(-4)}`, routingAccountId: id })
describe('engine account identity', () => {
  it('requires the full identity from the same record; a suffix cannot authorize an action', () => {
    expect(engineAccountId(row('11119908'))).toBe('11119908')
    expect(engineAccountId({ accountId: '11119908', routingAccountId: '11119908' })).toBe('11119908')
    expect(engineAccountId({ accountId: '11119908', routingAccountId: '22229908' })).toBe(null)
    expect(engineAccountId({ accountId: '…9908' })).toBe(null)
    expect(engineAccountId({ accountId: '…1234', routingAccountId: '11119908' })).toBe(null)
    for (const invalid of [null, '', '…9908', 'x9908', 11119908]) {
      expect(engineAccountId({ accountId: '…9908', routingAccountId: invalid })).toBe(null)
    }
  })
  it('keeps same-suffix accounts distinct and refuses duplicate routing records', () => {
    expect(engineAccountBindings([row('11119908'), row('22229908')])).toEqual(['11119908', '22229908'])
    expect(engineAccountBindings([row('11119908'), row('11119908')])).toEqual([null, null])
  })
  it('matches readiness by exact identity, including same-suffix and mixed-version responses', () => {
    const rows = [{ ...row('11119908'), ready: false }, { ...row('22229908'), ready: true }]
    expect(engineReadinessFor(rows, '11119908').ready).toBe(false)
    expect(engineReadinessFor(rows, '22229908').ready).toBe(true)
    expect(engineReadinessFor([{ accountId: '…9908', ready: true }], '11119908')).toBe(null)
    expect(engineReadinessFor([rows[0], rows[0]], '11119908')).toBe(null)
  })
})
