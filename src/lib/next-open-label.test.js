import { describe, it, expect } from 'vitest'
import { nextOpenLabel } from './std-trade-rows.js'

describe('nextOpenLabel', () => {
  it('same month → (dd hh:mm) in device local time', () => {
    const now = new Date(2026, 6, 17, 10, 0)
    const open = new Date(2026, 6, 20, 9, 5)
    expect(nextOpenLabel(open.toISOString(), now)).toBe('(20 09:05)')
  })
  it('different month → (dd-m hh:mm)', () => {
    const now = new Date(2026, 6, 30, 10, 0)
    const open = new Date(2026, 7, 2, 22, 30)
    expect(nextOpenLabel(open.toISOString(), now)).toBe('(02-8 22:30)')
  })
  it('null/garbage → null', () => {
    expect(nextOpenLabel(null)).toBeNull()
    expect(nextOpenLabel('nope')).toBeNull()
  })
})
