// Owner, iPhone screenshot 2026-08-03: Desk › "Your edge — backtest baseline".
// The twelve-strategy strip (FIB ICUP BRK FVG EMA RSI VP FIBC C&H VAB RSI2
// VWAP) ran off the right edge of the phone AND out of its own card.
//
// The cause was structural, not cosmetic: Segmented is an inline-flex of
// min-w-[48px] whitespace-nowrap segments, so twelve of them are ~600px wide
// before padding. With no scroll container that width becomes PAGE overflow.
//
// This guard is about the RULE, not this one strip: wide content scrolls
// inside its own container, and the page body never scrolls sideways. The
// repo has fixed a version of this per-page before; a component-level test is
// what stops the next caller inheriting it.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import Segmented from './common/Segmented.jsx'

const twelve = [
  'FIB', 'ICUP', 'BRK', 'FVG', 'EMA', 'RSI',
  'VP', 'FIBC', 'C&H', 'VAB', 'RSI2', 'VWAP',
].map(v => ({ value: v, label: v }))

describe('Segmented cannot overflow the page', () => {
  const html = renderToStaticMarkup(
    <Segmented label="Backtested strategy" value="FIB" onChange={() => {}} options={twelve} />,
  )

  it('wraps the group in a bounded, horizontally scrollable container', () => {
    expect(html).toMatch(/max-w-full/)
    expect(html).toMatch(/overflow-x-auto/)
  })

  it('the scroll wrapper is OUTSIDE the radiogroup, so the pill ends stay clipped', () => {
    // overflow-hidden on the group is what rounds the ends. If the scroll were
    // put there instead, the fix would trade one visual bug for another.
    const wrapperFirst = html.indexOf('overflow-x-auto')
    const groupFirst = html.indexOf('role="radiogroup"')
    expect(wrapperFirst).toBeGreaterThanOrEqual(0)
    expect(groupFirst).toBeGreaterThan(wrapperFirst)
    expect(html).toMatch(/role="radiogroup"[^>]*overflow-hidden/)
  })

  it('still renders every option — scrolling must not mean hiding', () => {
    // Labels are HTML-escaped on the way out (C&H -> C&amp;H), so compare
    // against the escaped form rather than the source string.
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    for (const o of twelve) expect(html).toContain(`>${esc(o.label)}<`)
  })

  it('keeps the radiogroup semantics a segmented control needs', () => {
    expect(html).toMatch(/role="radiogroup"/)
    expect((html.match(/role="radio"/g) || []).length).toBe(twelve.length)
    expect(html).toMatch(/aria-checked="true"/)
  })
})
