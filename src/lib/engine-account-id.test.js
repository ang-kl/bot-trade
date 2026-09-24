import { describe, it, expect } from 'vitest'
import { engineAccountId } from './engine-status-view.js'

describe('engine account identity', () => {
  it('requires an exact match for a complete ID, never a suffix match', () => {
    expect(engineAccountId(['11119908'], '22229908')).toBe(null)
    expect(engineAccountId(['11119908', '22229908'], '22229908')).toBe('22229908')
  })
  it('resolves only a unique valid masked identity', () => {
    expect(engineAccountId(['11119908'], '…9908')).toBe('11119908')
    expect(engineAccountId(['11119908', '22229908'], '…9908')).toBe(null)
    expect(engineAccountId(['11119908', '11119908'], '…9908')).toBe('11119908')
    for (const invalid of [null, '', '9908', '…', '...9908', 'x9908', '…908']) {
      expect(engineAccountId(['11119908'], invalid)).toBe(null)
    }
    expect(engineAccountId(['…9908', null, 'x9908'], '…9908')).toBe(null)
  })
})
