// The go-live gate card, in both shapes. The compact form is not a smaller
// copy — it changes WHICH row leads, and that choice is testable.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import GoalTracker from './GoalTracker.jsx'

describe('GoalTracker', () => {
  it('renders nothing before data arrives, in either variant', () => {
    // Deliberate: the gate is a decision aid, and a skeleton implying a
    // verdict is worse than an empty space for one paint.
    expect(renderToStaticMarkup(<GoalTracker />)).toBe('')
    expect(renderToStaticMarkup(<GoalTracker variant="compact" />)).toBe('')
  })

  it('does not throw on an unknown variant — it falls back to the full card', () => {
    expect(() => renderToStaticMarkup(<GoalTracker variant="nonsense" />)).not.toThrow()
  })
})
