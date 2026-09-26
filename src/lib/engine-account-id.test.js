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

  // S1a: GET /state/tick-readiness answers `{ accounts: [...] }` (the
  // roster form, tickReadinessView) OR one bare record with no `accounts`
  // field at all (the `?account=` narrowed form, tickReadinessFor) — the
  // exact shape agent-api.js's viewed-account wiring (S3) produces the
  // moment an operator views any account other than the traded one. A
  // reader that only ever looked for `.accounts` read every row as having
  // no readiness in that case, not just the ones genuinely absent.
  it('reads the roster shape { accounts }, the narrowed single-record shape, and null honestly', () => {
    const one = { ...row('11119908'), ready: false, blockedReasons: ['validation_stage'] }
    const other = { ...row('22229908'), ready: true, blockedReasons: [] }
    expect(engineReadinessFor({ accounts: [one, other] }, '11119908').ready).toBe(false)
    expect(engineReadinessFor({ accounts: [one, other] }, '22229908').ready).toBe(true)
    // the narrowed form: one bare record, matching this account
    expect(engineReadinessFor(one, '11119908').ready).toBe(false)
    // the narrowed form for a DIFFERENT account: genuinely no data here —
    // "no record", not a crash and not another account's answer
    expect(engineReadinessFor(one, '22229908')).toBe(null)
    expect(engineReadinessFor(null, '11119908')).toBe(null)
    expect(engineReadinessFor(undefined, '11119908')).toBe(null)
  })
})
