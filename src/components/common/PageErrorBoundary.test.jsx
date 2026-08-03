// Owner, 03-08-2026: "I am trying to change the pipeline but the page keeps
// crashing." The Railway logs attached to that message show every request
// returning 200 — the server was fine, a React render was throwing, and there
// was NO error boundary anywhere in src/, so the whole app unmounted with no
// message and no stack.
//
// WHAT THIS TEST CAN AND CANNOT DO. There is no jsdom and no
// @testing-library/react in this repo — only react-dom/server. React error
// boundaries do not catch during server rendering, so a "mount a throwing
// child and watch it be caught" test is not available without adding a test
// dependency. Rather than skip the file, this tests the two pieces that ARE
// reachable and that carry the behaviour:
//
//   1. getDerivedStateFromError puts the error into state (the contract React
//      calls on a render throw), and
//   2. the render path with that state produces the visible, copyable report
//      instead of a blank page.
//
// The bit NOT covered here — React actually invoking the boundary on a live
// render throw — is framework behaviour, exercised by the browser.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PageErrorBoundary from './PageErrorBoundary.jsx'

const renderWith = (state) => {
  const b = new PageErrorBoundary({ children: 'the page' })
  b.state = { error: null, info: null, ...state }
  return renderToStaticMarkup(<>{b.render()}</>)
}

describe('PageErrorBoundary', () => {
  it('passes children straight through when nothing has thrown', () => {
    expect(renderWith({})).toBe('the page')
  })

  it('captures the thrown error into state', () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'stages')")
    expect(PageErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err })
  })

  it('SHOWS the message — a blank page is the failure being fixed', () => {
    const html = renderWith({
      error: new TypeError("Cannot read properties of undefined (reading 'stages')"),
    })
    expect(html).toContain('stopped rendering')
    // The actual cause must be on screen, not only in a console the owner is
    // not looking at on a phone.
    expect(html).toContain('TypeError')
    expect(html).toContain("reading &#x27;stages&#x27;")
    expect(html).toContain('Copy error detail')
  })

  it('includes the component stack, truncated so the panel stays readable', () => {
    const stack = Array.from({ length: 20 }, (_, i) => `    at Component${i}`).join('\n')
    const html = renderWith({ error: new Error('boom'), info: { componentStack: stack } })
    expect(html).toContain('Component0')
    expect(html).toContain('Component7')
    // Line 9 onward is dropped from the panel — the full stack still goes to
    // the console and to the clipboard copy.
    expect(html).not.toContain('Component9')
  })

  it('marks itself as an alert so it is announced, not just drawn', () => {
    const html = renderWith({ error: new Error('boom') })
    expect(html).toContain('role="alert"')
  })
})
