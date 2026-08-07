// npx vitest run src/components/common/AccountScopeFab.test.jsx
//
// No jsdom in this repo — components are rendered with react-dom/server, which
// runs hooks but not effects. That is the right boundary for this file: what
// the FAB looks like BEFORE its roster fetch lands is exactly the moment the
// scope work keeps getting undone, because an un-resolved roster that renders
// a confident-looking answer is worse than one that says it does not know.
// The resolved states are covered exhaustively in lib/scope-fab.test.js.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AccountScopeFab from './AccountScopeFab.jsx'

const html = (props = {}) => renderToStaticMarkup(<AccountScopeFab {...props} />)

describe('AccountScopeFab', () => {
  it('paints the scope on its own face — no tap required to read it', () => {
    const h = html()
    expect(h).toContain('ALL')
    expect(h).toContain('ACCTS')
    expect(h).toMatch(/aria-label="Account scope: ALL ACCTS"/)
  })

  it('keeps the 56x44 pill — narrow as the owner asked, never under the 44px tap floor', () => {
    // Owner asked for "a small tiny FAB". Small is the WIDTH; 44 is the HIG
    // minimum this app's own spec pins, and this control changes what every
    // number on the page means, so a missed tap is expensive.
    const h = html()
    expect(h).toMatch(/width:56px/)
    expect(h).toMatch(/height:44px/)
  })

  it('sizes its type from the canon, never a px literal', () => {
    const h = html()
    expect(h).toContain('var(--fs-body)')
    expect(h).toContain('var(--fs-head)')
    expect(h).not.toMatch(/font-size:\d/)
  })

  it('is closed by default and reports that to assistive tech', () => {
    expect(html()).toMatch(/aria-expanded="false"/)
    expect(html()).not.toContain('role="dialog"')
  })

  // OWNER CHANGE 07-08-2026: the FAB now moves the TRADED account, not just
  // the lens. The sheet has to say which kind of switch it is — the previous
  // wording promised view-only, and a control that quietly re-points real
  // trading while claiming otherwise is worse than either behaviour alone.
  it('opened, it says it sets the TRADED account and warns about the live confirm', () => {
    // Choosing a row here calls setViewedAccount, never
    // /actions/ctrader-select-account. A control this easy to reach must not
    // be readable as "this re-points what the bot trades".
    const h = html({ open: true })
    expect(h).toContain('role="dialog"')
    expect(h).toContain('All accounts')
    expect(h).toMatch(/TRADES/)
    expect(h).toMatch(/type LIVE/i)
  })

  it('every sheet row clears 44px', () => {
    const rows = html({ open: true }).match(/min-height:44px/g) || []
    expect(rows.length).toBeGreaterThan(0)
  })
})
