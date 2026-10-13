// Claude · № 14,050 13-Oct (owner: "build the partial close lots field"; claude-builder).
// Source of the expected outcomes: POST /actions/position-close already takes
// `lots` and closes min(lots, held) (actions.js); the sheet sent none, so its
// Close was always the whole position. An empty field keeps that behaviour.
import { describe, it, expect } from 'vitest'
import { closeRequest } from './position-close-form.js'

describe('closeRequest — the sheet\'s Close with an optional lots field', () => {
  it('empty field: the whole position, no lots sent', () => {
    expect(closeRequest('', 4.7)).toEqual({ lots: null, partial: false, error: null })
    expect(closeRequest('   ', 4.7).partial).toBe(false)
  })
  it('a lots figure below the held lots is a partial close of that many lots', () => {
    expect(closeRequest('2', 4.7)).toEqual({ lots: 2, partial: true, error: null })
    expect(closeRequest('0.35', 4.7).lots).toBe(0.35)
  })
  it('a figure at or above the held lots is the whole position', () => {
    expect(closeRequest('4.7', 4.7)).toEqual({ lots: null, partial: false, error: null })
    expect(closeRequest('9', 4.7).partial).toBe(false)
  })
  it('zero, negative or non-numeric input is refused with a reason, never sent', () => {
    for (const v of ['0', '-1', 'abc', '1e', 'NaN']) {
      const r = closeRequest(v, 4.7)
      expect(r.error).toMatch(/lots/)
      expect(r.lots).toBeNull()
    }
  })
  it('held lots unknown: a typed figure is sent as is (the route caps it at the broker volume)', () => {
    expect(closeRequest('1', null)).toEqual({ lots: 1, partial: true, error: null })
  })
})
