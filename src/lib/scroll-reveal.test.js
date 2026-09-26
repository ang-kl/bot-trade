// vitest — PERF-1's fourth requirement: ScrollTrigger refreshes ONCE after
// the reveal batch settles, not once per element as it is inserted.
//
// This exercises BEHAVIOUR against mocked gsap/ScrollTrigger objects, not
// source text — CLAUDE.md failure mode #2 ("a test can pass by matching its
// own comment") applies to any test that only greps Risk.jsx for the words
// "refresh" or "immediateRender".
import { describe, it, expect, vi } from 'vitest'
import { armScrollReveal } from './scroll-reveal.js'

function fakeGsap() {
  const calls = []
  return {
    calls,
    registerPlugin: vi.fn((...args) => calls.push(['registerPlugin', ...args])),
    fromTo: vi.fn((el, from, to) => calls.push(['fromTo', el, from, to])),
  }
}

function fakeScrollTrigger() {
  const calls = []
  return { calls, refresh: vi.fn(() => calls.push(['refresh'])) }
}

describe('armScrollReveal', () => {
  it('refreshes exactly once no matter how many reveal elements are wired', () => {
    const gsap = fakeGsap()
    const ST = fakeScrollTrigger()
    const elements = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    armScrollReveal(gsap, ST, elements, { schedule: (fn) => fn() })

    expect(gsap.fromTo).toHaveBeenCalledTimes(3)
    expect(ST.refresh).toHaveBeenCalledTimes(1)
  })

  it('refreshes only AFTER every element has been wired, not interleaved', () => {
    const gsap = fakeGsap()
    const ST = fakeScrollTrigger()
    const elements = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    armScrollReveal(gsap, ST, elements, { schedule: (fn) => fn() })

    const order = [...gsap.calls, ...ST.calls]
    // Merge by original push order using a single shared log instead —
    // rebuild with a shared array so ordering is verifiable.
    const log = []
    const gsap2 = { registerPlugin: () => log.push('registerPlugin'), fromTo: (el) => log.push(`fromTo:${el.id}`) }
    const ST2 = { refresh: () => log.push('refresh') }
    armScrollReveal(gsap2, ST2, elements, { schedule: (fn) => fn() })

    expect(log).toEqual(['registerPlugin', 'fromTo:a', 'fromTo:b', 'fromTo:c', 'refresh'])
    expect(order.length).toBeGreaterThan(0) // keep the first mock's assertions meaningful
  })

  it('wires each tween with its own scrollTrigger, unchanged from the prior reveal params', () => {
    const gsap = fakeGsap()
    const ST = fakeScrollTrigger()
    armScrollReveal(gsap, ST, [{ id: 'a' }], { schedule: (fn) => fn() })

    const [, , , to] = gsap.calls.find(c => c[0] === 'fromTo')
    expect(to.scrollTrigger).toMatchObject({ trigger: { id: 'a' }, start: 'top 92%' })
  })

  it('the refresh is scheduled (e.g. via requestAnimationFrame), not called synchronously inline', () => {
    const gsap = fakeGsap()
    const ST = fakeScrollTrigger()
    const scheduled = []
    armScrollReveal(gsap, ST, [{ id: 'a' }], { schedule: (fn) => scheduled.push(fn) })

    // refresh must NOT have run yet — it was handed to `schedule`, not invoked.
    expect(ST.refresh).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    scheduled[0]()
    expect(ST.refresh).toHaveBeenCalledTimes(1)
  })

  it('does nothing when there are no reveal elements (no registerPlugin, no refresh)', () => {
    const gsap = fakeGsap()
    const ST = fakeScrollTrigger()
    armScrollReveal(gsap, ST, [], { schedule: (fn) => fn() })
    armScrollReveal(gsap, ST, null, { schedule: (fn) => fn() })

    expect(gsap.registerPlugin).not.toHaveBeenCalled()
    expect(gsap.fromTo).not.toHaveBeenCalled()
    expect(ST.refresh).not.toHaveBeenCalled()
  })

  it('does nothing when gsap or ScrollTrigger is missing (blocked CDN)', () => {
    const gsap = fakeGsap()
    const ST = fakeScrollTrigger()
    expect(() => armScrollReveal(null, ST, [{ id: 'a' }])).not.toThrow()
    expect(() => armScrollReveal(gsap, null, [{ id: 'a' }])).not.toThrow()
    expect(ST.refresh).not.toHaveBeenCalled()
    expect(gsap.fromTo).not.toHaveBeenCalled()
  })

  it('accepts a NodeList (querySelectorAll result), not just an array', () => {
    const gsap = fakeGsap()
    const ST = fakeScrollTrigger()
    // A NodeList is iterable but not an Array; Array.from must be applied
    // inside armScrollReveal rather than assumed by the caller.
    const nodeListLike = { 0: { id: 'a' }, 1: { id: 'b' }, length: 2, [Symbol.iterator]: Array.prototype[Symbol.iterator] }
    armScrollReveal(gsap, ST, nodeListLike, { schedule: (fn) => fn() })
    expect(gsap.fromTo).toHaveBeenCalledTimes(2)
    expect(ST.refresh).toHaveBeenCalledTimes(1)
  })
})
