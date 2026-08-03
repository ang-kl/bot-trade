// Owner, 04-08-2026: "i find the RISK page becomes complicated."
//
// These tests pin the two rules the layout pass rests on: Essentials defers
// rather than removes, and nothing non-default or unsaved is allowed to hide.
import { describe, it, expect } from 'vitest'
import {
  ESSENTIALS, EVERYTHING, loadRiskMode, saveRiskMode,
  groupOpen, groupSummary, cardVisible, DEFERRED_CARDS,
} from './risk-view.js'

const fakeStorage = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m }
}

describe('risk-view mode', () => {
  it('defaults to essentials, including on junk or missing storage', () => {
    expect(loadRiskMode(fakeStorage())).toBe(ESSENTIALS)
    expect(loadRiskMode(fakeStorage({ risk_view_mode: 'wat' }))).toBe(ESSENTIALS)
    expect(loadRiskMode({ getItem() { throw new Error('blocked') } })).toBe(ESSENTIALS)
  })

  it('round-trips the choice', () => {
    const st = fakeStorage()
    saveRiskMode(EVERYTHING, st)
    expect(loadRiskMode(st)).toBe(EVERYTHING)
    saveRiskMode(ESSENTIALS, st)
    expect(loadRiskMode(st)).toBe(ESSENTIALS)
  })
})

describe('advanced groups', () => {
  it('an UNSAVED edit forces the group open — it can never hide behind a header', () => {
    expect(groupOpen({ mode: ESSENTIALS, userOpen: false, dirty: true })).toBe(true)
  })

  it('Everything opens every group; Essentials respects the operator', () => {
    expect(groupOpen({ mode: EVERYTHING, userOpen: false })).toBe(true)
    expect(groupOpen({ mode: ESSENTIALS, userOpen: false })).toBe(false)
    expect(groupOpen({ mode: ESSENTIALS, userOpen: true })).toBe(true)
  })

  it('a collapsed group SAYS when it holds a non-default value', () => {
    expect(groupSummary({ total: 5 })).toBe('5 settings')
    expect(groupSummary({ total: 5, changed: 2 })).toBe('5 settings · 2 changed from default')
    expect(groupSummary({ total: 1, changed: 1, dirty: true })).toBe('1 setting · 1 changed from default · unsaved')
  })
})

describe('deferred cards', () => {
  it('Everything shows every card', () => {
    for (const id of [...DEFERRED_CARDS, 'sec-protection', 'sec-emergency']) {
      expect(cardVisible(id, EVERYTHING)).toBe(true)
    }
  })

  it('Essentials keeps protection AND the panic button', () => {
    // A page that hides the emergency close to look tidier has optimised the
    // wrong thing — this is the assertion that stops that happening later.
    expect(cardVisible('sec-emergency', ESSENTIALS)).toBe(true)
    expect(cardVisible('sec-protection', ESSENTIALS)).toBe(true)
    expect(cardVisible('sec-acct-risk', ESSENTIALS)).toBe(true)
    expect(cardVisible('sec-bot-risk', ESSENTIALS)).toBe(true)
  })

  it('Essentials defers only reference and expert cards', () => {
    expect(DEFERRED_CARDS).not.toContain('sec-emergency')
    expect(DEFERRED_CARDS).not.toContain('sec-protection')
    for (const id of DEFERRED_CARDS) expect(cardVisible(id, ESSENTIALS)).toBe(false)
  })
})
