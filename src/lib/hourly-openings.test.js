import { describe, it, expect } from 'vitest'
import { openingEvidence, openingCountLabel, OPENINGS_MAX_AGE_MS } from './hourly-openings.js'

const H = 3600_000, TO = Date.parse('2026-09-22T06:20:00.123Z')
const FROM = TO - 24 * H
const fixture = () => ({ accountId: '11', source: 'local_trade_ledger', generatedAt: new Date(TO).toISOString(),
  from: FROM, to: TO, openedN: 1, legacyN: 0, adoptedN: 0, unknownTimeN: 0,
  rows: Array.from({ length: 24 }, (_, i) => ({ from: FROM + i * H, to: FROM + (i + 1) * H, openedN: i === 23 ? 1 : 0, legacyN: 0, adoptedN: 0 })),
})
const view = (r, extra = {}) => openingEvidence(r, { accountId: '11', to: TO, nowMs: TO, ...extra })

describe('hourly opening evidence', () => {
  it('keeps sparse activity and recorded zero visible, while unavailable is a dash', () => {
    const r = view(fixture())
    expect(openingCountLabel(r.rows.at(-1).openedN)).toBe('1')
    expect(openingCountLabel(r.rows[0].openedN)).toBe('0')
    expect(openingCountLabel(null)).toBe('—')
    expect(view(null)).toBeNull()
  })
  it('rejects an old account response and a different rolling window immediately', () => {
    expect(view(fixture(), { accountId: '22' })).toBeNull()
    expect(view(fixture(), { to: TO + 600_000 })).toBeNull()
  })
  it('cached evidence expires; future and malformed stamps never look current', () => {
    expect(view(fixture(), { nowMs: TO + OPENINGS_MAX_AGE_MS - 1 })).not.toBeNull()
    expect(view(fixture(), { nowMs: TO + OPENINGS_MAX_AGE_MS })).toBeNull()
    expect(view(fixture(), { nowMs: TO - 1 })).toBeNull()
    expect(view({ ...fixture(), generatedAt: 'bad' })).toBeNull()
  })
  it('missing timestamps preserve observed activity but forbid claiming a verified zero', () => {
    const r = view({ ...fixture(), unknownTimeN: 2 })
    expect(openingCountLabel(r.rows[23].openedN, r.unknownTimeN)).toBe('≥1')
    expect(openingCountLabel(r.rows[0].openedN, r.unknownTimeN)).toBe('unknown')
  })
  it('rejects truncated, inconsistent, negative and shifted payloads', () => {
    const truncated = fixture(); truncated.rows.pop()
    const shifted = fixture(); shifted.rows[0].from++
    const negative = fixture(); negative.rows[0].openedN = -1
    const mismatch = { ...fixture(), openedN: 99 }
    for (const r of [truncated, shifted, negative, mismatch]) expect(view(r)).toBeNull()
  })
})
