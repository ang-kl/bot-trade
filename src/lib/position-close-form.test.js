// Claude · № 14,050 13-Oct (owner: "build the partial close lots field"; claude-builder).
// Source of the expected outcomes: POST /actions/position-close already takes
// `lots` and closes min(lots, held) (actions.js); the sheet sent none, so its
// Close was always the whole position. An empty field keeps that behaviour.
import { describe, it, expect } from 'vitest'
import { closeRequest, closeFlow } from './position-close-form.js'

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

// Codex P1 on #1354 (owner: "Both"): the confirm shows the figure that closes.
describe('closeFlow', () => {
  const base = { heldLots: 4.7, heldText: '4.70', symbol: 'EURUSD', side: 'BUY', positionId: '55' }
  const recorder = (reply) => { const calls = []; return { calls, preview: async (body) => { calls.push(body); return reply } } }
  it('a partial previews first, confirms the STEPPED figure, says it differs from the typed one, and sends the stepped figure', async () => {
    const { calls, preview } = recorder({ ok: true, preview: true, lots: 2.34, partial: true })
    const texts = []
    const r = await closeFlow({ ...base, input: '2.345', preview, confirm: t => { texts.push(t); return true } })
    expect(calls).toEqual([{ positionId: '55', lots: 2.345 }])
    expect(texts[0]).toMatch(/Close EURUSD BUY 2\.34 of 4\.70 lots/)
    expect(texts[0]).toMatch(/2\.345 is not on the symbol's volume step: 2\.34 will close/)
    expect(r).toEqual({ body: { positionId: '55', lots: 2.34 } })
  })
  it('an on-step figure confirms without the step note', async () => {
    const { preview } = recorder({ ok: true, preview: true, lots: 2.34, partial: true })
    const texts = []
    await closeFlow({ ...base, input: '2.34', preview, confirm: t => { texts.push(t); return true } })
    expect(texts[0]).not.toMatch(/not on the symbol's volume step/)
  })
  it('a refused preview (below the minimum) is an error and nothing is confirmed', async () => {
    const preview = async () => { throw new Error("lots to close are below the symbol's minimum (0.01 lots)") }
    let asked = false
    const r = await closeFlow({ ...base, input: '0.004', preview, confirm: () => { asked = true; return true } })
    expect(r.error).toMatch(/minimum/); expect(asked).toBe(false)
  })
  it('cancelling the confirm sends nothing; empty input closes the whole position with no preview', async () => {
    const { calls, preview } = recorder({ ok: true, preview: true, lots: 1, partial: true })
    expect(await closeFlow({ ...base, input: '1', preview, confirm: () => false })).toEqual({ cancelled: true })
    const whole = recorder({})
    expect(await closeFlow({ ...base, input: '', preview: whole.preview, confirm: () => true })).toEqual({ body: { positionId: '55' } })
    expect(whole.calls).toEqual([])
    expect(calls.length).toBe(1)
  })
})
