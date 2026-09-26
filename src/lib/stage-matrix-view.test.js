// S-1 (26-09-2026): the words a Tune matrix cell carries beside its ✓/✗.
import { describe, it, expect } from 'vitest'
import { cellNote, followerLabel, isAccountScopedCell, unappliedFor } from './stage-matrix-view.js'

const mx = {
  followers: { vwap_trend: { following: 0, of: 7 }, tsmom_long: { following: 1, of: 7 } },
  unapplied: [{ cell: 'strategy:vp_value:scan', kind: 'strategy', key: 'vp_value', stage: 'scan', stored: false, applied: true, reason: 'Scan is one shared pass across every account' }],
}

describe('stage-matrix-view', () => {
  it('a shared Auto Trade & Open cell says how many accounts follow it', () => {
    expect(followerLabel(mx.followers, 'vwap_trend')).toBe('followed by 0 of 7')
    expect(cellNote(mx, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', acct: 'all' })).toEqual({ sub: 'followed by 0 of 7', editable: true, reason: null })
    expect(cellNote(mx, { kind: 'strategy', key: 'vwap_trend', stage: 'scan', acct: 'all' }).sub).toBeNull()
    expect(followerLabel(mx.followers, 'unknown_key')).toBeNull()
  })

  it('in an account scope only the strategy trade cell is editable; the rest say "shared"', () => {
    expect(isAccountScopedCell('strategy', 'trade')).toBe(true)
    expect(isAccountScopedCell('filter', 'trade')).toBe(false)
    expect(cellNote(mx, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', acct: '46130058' })).toEqual({ sub: null, editable: true, reason: null })
    const shared = cellNote(mx, { kind: 'strategy', key: 'vwap_trend', stage: 'manage', acct: '46130058' })
    expect(shared.sub).toBe('shared')
    expect(shared.editable).toBe(false)
  })

  it('a stored-but-unapplied cell is named with its stored value, never hidden', () => {
    expect(unappliedFor(mx, 'strategy', 'vp_value', 'scan')?.stored).toBe(false)
    const n = cellNote(mx, { kind: 'strategy', key: 'vp_value', stage: 'scan', acct: '46130058' })
    expect(n.sub).toBe('stored OFF here — not applied')
    expect(n.editable).toBe(false)
    expect(n.reason).toMatch(/shared pass/)
  })
})
