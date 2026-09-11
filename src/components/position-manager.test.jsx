// PR-F (owner principle 6): the position / order sheets carried a
// permanently-disabled "Modify" as their dominant button, and the trailing /
// break-even pip fields started at 10 / 15 / 3 — shown as the position's
// settings whether or not a guard existed. These pin the replacements: a
// first render (react-dom/server, effects never run) shows EMPTY fields
// labelled "not set" and a "reading" note; the guard-get mapping fills only
// what the agent stored; an apply with an ON rule and no pips is refused.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import PositionManager from './PositionManager.jsx'
import OrderManager from './OrderManager.jsx'
import { guardFormState, guardApplyBlocker, EMPTY_GUARD_FORM } from '../lib/position-guard-form.js'

const p = { positionId: '55', symbol: 'EURUSD', side: 'BUY', lots: 0.5, entry: 1.1, sl: 1.09, tp: 1.12, currentPrice: 1.105, pipSize: 0.0001, digits: 5 }

describe('PositionManager sheet', () => {
  it('has no disabled Modify button on the Size tab — Double / Reverse / Close are the real actions', () => {
    const html = renderToStaticMarkup(<PositionManager p={p} onDone={() => {}} />)
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Modify<\/button>/)
    expect(html).not.toMatch(/Leave size intact/)
    expect(html).toMatch(/>Double</); expect(html).toMatch(/>Reverse</); expect(html).toMatch(/Close \(1\.1050\)/)
  })
  it('Stop & Target tab starts with the guard unread: trailing / break-even labelled "(not set)", empty fields, a reading note', () => {
    const html = renderToStaticMarkup(<PositionManager p={p} onDone={() => {}} initialTab="Protect" />)
    expect(html).toMatch(/Trailing Stop Loss \(not set\)/)
    expect(html).toMatch(/Break-even \(not set\)/)
    expect(html).toMatch(/data-guard-read="reading"/)
    expect(html).toMatch(/reading the stored guard/)
    // No default pips anywhere in the first render.
    expect(html).not.toMatch(/value="10"|value="15"|value="3"/)
  })
})

describe('OrderManager sheet', () => {
  it('has no disabled Modify button; Cancel order is the action', () => {
    const html = renderToStaticMarkup(<OrderManager o={{ orderId: '9', symbol: 'GBPUSD', side: 'SELL', lots: 0.1, limitPrice: 1.3, sl: 1.31, tp: 1.28 }} onDone={() => {}} />)
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Modify<\/button>/)
    expect(html).toMatch(/Cancel order/)
    expect(html).toMatch(/no route yet/)
  })
})

describe('guardFormState — fields fill only from what the agent stored', () => {
  it('no guard → every field empty, status not_set', () => {
    expect(guardFormState({ ok: true, guard: null, monitored: true })).toEqual({ status: 'not_set', form: EMPTY_GUARD_FORM() })
    expect(guardFormState(null).form.trailPips).toBe('')
  })
  it('not monitored → status says so, fields empty', () => {
    expect(guardFormState({ ok: true, guard: null, monitored: false }).status).toBe('not_monitored')
  })
  it('a stored guard → the stored values as strings, missing sub-fields stay empty', () => {
    const { status, form } = guardFormState({ ok: true, monitored: true, guard: { trailing: { on: true, distancePips: 12 }, breakEven: { on: true, triggerPips: 20 }, takeProfits: [{ price: 1.115, lots: 0.2, done: false }] } })
    expect(status).toBe('stored')
    expect(form.trailOn).toBe(true); expect(form.trailPips).toBe('12')
    expect(form.beOn).toBe(true); expect(form.beTrigger).toBe('20'); expect(form.beOffset).toBe('')
    expect(form.extraTps[0]).toEqual({ on: true, price: '1.115', lots: '0.2' })
    expect(form.extraTps[1]).toEqual({ on: false, price: '', lots: '' })
  })
})

describe('guardApplyBlocker — an ON rule with empty pips is refused, never written as 0', () => {
  it('refuses trailing ON without a distance, break-even ON without a trigger or offset', () => {
    expect(guardApplyBlocker({ trailOn: true, trailPips: '', beOn: false })).toMatch(/trailing stop is ON but its distance is not set/)
    expect(guardApplyBlocker({ trailOn: false, beOn: true, beTrigger: '', beOffset: '2' })).toMatch(/trigger is not set/)
    expect(guardApplyBlocker({ trailOn: false, beOn: true, beTrigger: '15', beOffset: '' })).toMatch(/offset is not set/)
  })
  it('admits complete rules and rules that are OFF', () => {
    expect(guardApplyBlocker({ trailOn: true, trailPips: '10', beOn: true, beTrigger: '15', beOffset: '0' })).toBeNull()
    expect(guardApplyBlocker({ trailOn: false, trailPips: '', beOn: false, beTrigger: '', beOffset: '' })).toBeNull()
  })
})

describe('source pins (comment-stripped): the 10 / 15 / 3 defaults and the disabled Modify cannot return', () => {
  const strip = f => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
  it('PositionManager', () => {
    const src = strip('./PositionManager.jsx')
    expect(src).not.toMatch(/useState\('10'\)|useState\('15'\)|useState\('3'\)/)
    expect(src).not.toMatch(/<button type="button" disabled[^>]*>Modify<\/button>/)
    expect(src).toMatch(/guardFormState\(r\)/)
    expect(src).toMatch(/guardApplyBlocker\(/)
  })
  it('OrderManager', () => {
    expect(strip('./OrderManager.jsx')).not.toMatch(/<button type="button" disabled[^>]*>Modify<\/button>/)
  })
})
