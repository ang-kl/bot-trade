import { describe, it, expect } from 'vitest'
import { classicPivots } from './pivot-points.js'

describe('classicPivots', () => {
  it('hand-computed example: H=127.75 L=125.34 C=127.00', () => {
    const { p, r1, r2, r3, s1, s2, s3 } = classicPivots({ high: 127.75, low: 125.34, close: 127.0 })
    expect(p).toBeCloseTo(126.696667, 6)
    expect(r1).toBeCloseTo(128.053333, 6)
    expect(r2).toBeCloseTo(129.106667, 6)
    expect(r3).toBeCloseTo(130.463333, 6)
    expect(s1).toBeCloseTo(125.643333, 6)
    expect(s2).toBeCloseTo(124.286667, 6)
    expect(s3).toBeCloseTo(123.233333, 6)
  })

  it('ordering: S3 < S2 < S1 < P < R1 < R2 < R3', () => {
    const { p, r1, r2, r3, s1, s2, s3 } = classicPivots({ high: 100, low: 90, close: 95 })
    expect(s3).toBeLessThan(s2)
    expect(s2).toBeLessThan(s1)
    expect(s1).toBeLessThan(p)
    expect(p).toBeLessThan(r1)
    expect(r1).toBeLessThan(r2)
    expect(r2).toBeLessThan(r3)
  })
})
