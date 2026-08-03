// The bug these tests pin, in the owner's words (04-08-2026):
// "why i cannot unprotect ... i try to change but it reset."
//
// The Risk page re-reads the whole config after ANY save and after any account
// switch, and used to push that response into every form. So flipping
// Protection OFF, or editing the loss cap and then saving a different card,
// silently reverted the edit — which reads as a broken switch.
import { describe, it, expect } from 'vitest'
import { markDirty, clearDirty, anyDirty, sectionsToApply } from './form-dirty.js'

const ALL = ['risk', 'loss-cap', 'ratchet', 'loss-guardian']

describe('form-dirty', () => {
  it('a reload refreshes untouched forms and leaves an edited one alone', () => {
    const dirty = markDirty({}, 'loss-cap')
    expect(sectionsToApply(ALL, dirty)).toEqual(['risk', 'ratchet', 'loss-guardian'])
  })

  it('SAVING ONE CARD NO LONGER WIPES ANOTHER — the reported reset', () => {
    // Edit the loss cap, then press Save on the guardian card.
    let dirty = markDirty(markDirty({}, 'loss-cap'), 'loss-guardian')
    dirty = clearDirty(dirty, 'loss-guardian')          // guardian just saved
    const applied = sectionsToApply(ALL, dirty)
    expect(applied).toContain('loss-guardian')          // saved → take the server's copy
    expect(applied).not.toContain('loss-cap')           // unsaved → keep the operator's edit
  })

  it('a SCOPE CHANGE replaces everything, edits included', () => {
    // Not a regression — the opposite. These numbers belong to a different
    // account now; keeping the edits would write account A's limits to B.
    const dirty = markDirty(markDirty({}, 'loss-cap'), 'ratchet')
    expect(sectionsToApply(ALL, dirty, { scopeChanged: true })).toEqual(ALL)
  })

  it('markDirty and clearDirty never mutate the object they are given', () => {
    const before = { 'loss-cap': true }
    const added = markDirty(before, 'ratchet')
    const removed = clearDirty(before, 'loss-cap')
    expect(before).toEqual({ 'loss-cap': true })
    expect(added).toEqual({ 'loss-cap': true, ratchet: true })
    expect(removed).toEqual({})
  })

  it('marking the same section twice returns the same object (no render churn)', () => {
    const d = markDirty({}, 'ratchet')
    expect(markDirty(d, 'ratchet')).toBe(d)
    expect(clearDirty(d, 'loss-cap')).toBe(d)
  })

  it('anyDirty answers for the whole page or a named subset', () => {
    const d = markDirty({}, 'risk')
    expect(anyDirty(d)).toBe(true)
    expect(anyDirty(d, ['loss-cap', 'ratchet', 'loss-guardian'])).toBe(false)
    expect(anyDirty({})).toBe(false)
    expect(anyDirty(null)).toBe(false)
  })

  it('survives junk input rather than throwing mid-render', () => {
    expect(sectionsToApply(null, null)).toEqual([])
    expect(sectionsToApply(ALL, null)).toEqual(ALL)
  })
})
