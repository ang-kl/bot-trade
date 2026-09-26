// npx vitest run src/components/risk-reassess-apply.test.jsx
//
// SAFE-0b fix round (checker blocker 2, 26-09-2026): Re-Risk's Apply writes the
// GLOBAL risk settings, and its confirm is the owner's last look at what it
// will change. The source pin in src/lib/risk-proposal-status.test.js could not
// fail on the cancel claim: `)))) return` → `)))) void 0` let Cancel fall
// through to POST /actions/risk-reassess-apply with every test green.
//
// This renders the REAL component and invokes the REAL Apply handler. There is
// no DOM in this suite (vitest environment: node), so: the component is given
// a loaded assessment and ticked rows through its test seams (initialData /
// initialPicked — effects do not run under react-dom/server), the Button
// module is wrapped to hand back each rendered button's props, agentPost is a
// recording mock and window.confirm a stub installed after the render. A state
// update after a server render is a no-op, so the handler runs to completion
// without a renderer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import RiskReassess from './RiskReassess.jsx'

const h = vi.hoisted(() => ({ posts: [], buttons: [] }))

vi.mock('../lib/agent-api.js', () => ({
  agentConfigured: () => false,
  agentGet: () => new Promise(() => {}),
  agentPost: async (path, body) => { h.posts.push([path, body]); return { ok: true } },
}))
vi.mock('./common/Button.jsx', async importOriginal => {
  const [real, react] = await Promise.all([importOriginal(), import('react')])
  return { default: props => { h.buttons.push(props); return react.createElement(real.default, props) } }
})

const LAST = {
  at: '2026-09-25T10:00:00.000Z', accountId: '46979908', provider: 'openai', model: 'm',
  includeWatchlist: false, watchlistCount: 0, applied: false,
  proposals: [
    { key: 'maxOpenPositions', label: 'Max open positions', current: 5, proposed: 4, reason: 'r' },
    { key: 'dailyLossLimit', label: 'Daily loss limit ($)', current: 300, proposed: 200, reason: 'r' },
  ],
}
const DATA = { last: LAST, live: { maxOpenPositions: 5, dailyLossLimit: 300 }, proposable: { dailyLossLimit: { kind: 'usd' } } }

/** Render with these rows ticked; return the markup and the Apply button's live props. */
function renderApply(picked) {
  h.buttons.length = 0
  const html = renderToStaticMarkup(createElement(MemoryRouter, null,
    createElement(RiskReassess, { initialLlmOff: { disabled: false }, initialData: DATA, initialPicked: picked })))
  const button = h.buttons.find(b => /^Apply \d* ?selected$/.test(String(b.children)))
  return { html, button }
}

let confirm
/** Click the rendered Apply: the confirm stub is installed only now, after the render. */
async function click(button) {
  vi.stubGlobal('window', { confirm })
  await button.onClick()
}

beforeEach(() => {
  h.posts.length = 0
  confirm = vi.fn(() => false)
  vi.useFakeTimers() // the done cue's 6 s dwell timer, on the OK path
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('RiskReassess Apply — rendered, the real handler invoked (SAFE-0b)', () => {
  it('renders the ticked proposal rows and a live Apply button naming the count', () => {
    const { html, button } = renderApply(['maxOpenPositions'])
    expect(html).toContain('Max open positions')
    expect(button.children).toBe('Apply 1 selected')
    expect(button.disabled).toBe(false)
    expect(typeof button.onClick).toBe('function')
  })

  it('Cancel on the confirm POSTS NOTHING — the global risk settings are not written', async () => {
    const { button } = renderApply(['maxOpenPositions', 'dailyLossLimit'])
    await click(button)
    expect(confirm).toHaveBeenCalledTimes(1)
    const text = confirm.mock.calls[0][0]
    expect(text).toContain('Apply 2 settings to the GLOBAL risk settings?')
    expect(text).toContain('• Max open positions (maxOpenPositions): 5 → 4')
    expect(text).toContain('• Daily loss limit ($) (dailyLossLimit): $300 → $200')
    expect(text).toContain('proposal made 2026-09-25T10:00:00.000Z for account 46979908')
    expect(h.posts).toEqual([])
  })

  it('OK on the confirm posts exactly the ticked keys, bound to the assessment on screen — the harness does see a POST when one is made', async () => {
    confirm.mockReturnValue(true)
    const { button } = renderApply(['dailyLossLimit'])
    await click(button)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(h.posts).toEqual([['/actions/risk-reassess-apply', { keys: ['dailyLossLimit'], at: LAST.at }]])
  })

  it('names the account currently traded beside the proposal\'s own account, and Cancel still posts nothing', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => JSON.stringify({ selectedAccountId: '47790949', accounts: [{ accountId: '47790949', isLive: true, traderLogin: '9001' }] }) })
    const { button } = renderApply(['maxOpenPositions'])
    await click(button)
    expect(confirm.mock.calls[0][0]).toContain('proposal made 2026-09-25T10:00:00.000Z for account 46979908 — account currently traded: LIVE 9001 · 47790949')
    expect(h.posts).toEqual([])
  })

  it('with nothing ticked the button is disabled, and the handler asks nothing and posts nothing', async () => {
    const { button } = renderApply([])
    expect(button.disabled).toBe(true)
    await click(button)
    expect(confirm).not.toHaveBeenCalled()
    expect(h.posts).toEqual([])
  })
})
