// UI-1 (26-09 UI plan, §3 "Expand and collapse"): a card's open/closed
// choice must survive a reload AND a remount (an account switch remounts
// BlockerReport's Card via its `key`). This pins the pure storage layer
// Card.jsx reads and writes through.
import { describe, it, expect } from 'vitest'
import { readCardOpen, writeCardOpen } from './card-open.js'

const fakeStorage = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m }
}

describe('readCardOpen', () => {
  it('defaults to the caller default on missing storage, junk values, and no id', () => {
    expect(readCardOpen('sec-x', true, fakeStorage())).toBe(true)
    expect(readCardOpen('sec-x', false, fakeStorage())).toBe(false)
    expect(readCardOpen('sec-x', true, fakeStorage({ card_open_sec_x: 'nonsense' }))).toBe(true)
    expect(readCardOpen(null, true, fakeStorage({ card_open_null: '0' }))).toBe(true)
    expect(readCardOpen(undefined, false, fakeStorage())).toBe(false)
  })

  it('a THROWING store degrades to the default instead of crashing the card', () => {
    const throwing = { getItem() { throw new Error('blocked (private mode)') } }
    expect(readCardOpen('sec-x', true, throwing)).toBe(true)
    expect(readCardOpen('sec-x', false, throwing)).toBe(false)
  })
})

describe('writeCardOpen', () => {
  it('round-trips the choice', () => {
    const st = fakeStorage()
    writeCardOpen('sec-x', false, st)
    expect(readCardOpen('sec-x', true, st)).toBe(false)
    writeCardOpen('sec-x', true, st)
    expect(readCardOpen('sec-x', false, st)).toBe(true)
  })

  it('a THROWING store on write just does not persist — it must not throw itself', () => {
    const throwing = { setItem() { throw new Error('quota exceeded') } }
    expect(() => writeCardOpen('sec-x', true, throwing)).not.toThrow()
  })

  it('no id — a card with no stable key never touches storage', () => {
    const st = fakeStorage()
    writeCardOpen(null, true, st)
    writeCardOpen(undefined, false, st)
    expect(st._m.size).toBe(0)
  })

  it('REMOUNT: a fresh read after a write, on a fresh call, still sees it — this is what a remount does', () => {
    // Performance.jsx remounts BlockerReport's Card on every account switch
    // via `key={`blockers:${acct}`}`. A remount is, from Card's point of
    // view, nothing more than a fresh `readCardOpen` call with the same
    // storage and the same id — exactly what this test drives.
    const st = fakeStorage()
    writeCardOpen('sec-blockers', false, st) // the operator collapsed it
    // "Remount" #1: a fresh initial read, as if Card had just been created.
    expect(readCardOpen('sec-blockers', true, st)).toBe(false)
    // "Remount" #2, after the operator re-opens it.
    writeCardOpen('sec-blockers', true, st)
    expect(readCardOpen('sec-blockers', true, st)).toBe(true)
  })

  it('two cards on the same page never clobber each other\'s key', () => {
    const st = fakeStorage()
    writeCardOpen('sec-acct-balance', true, st)
    writeCardOpen('sec-blockers', false, st)
    expect(readCardOpen('sec-acct-balance', false, st)).toBe(true)
    expect(readCardOpen('sec-blockers', true, st)).toBe(false)
  })
})
