// The Performance scope cards print each account's OWN balance and say
// "not read" when it was never stamped (react-dom/server: first render).
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PerfAccountScope from './PerfAccountScope.jsx'

const palette = { P_GL: '#fff', P_GBD: '#ccc', P_MU: '#888', P_SB: '#666', P_UP: '#06c', P_DN: '#c00', P_ACC: '#c60', P_EDG: '#eee', P_WRN: '#e90' }
const money = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const signed = (n) => (n >= 0 ? '+' : '') + money(n)
const cards = [
  { id: '47790949', name: 'Demo · 5306502', ccy: 'USD', isLive: false, bal: 45837.59, day: -17.25, gw: 0, gl: 17.25, n30: 1, cap: 1375.13, used: 1, equity: 44860.79, live: null, hasToday: true, usedCol: '#c60' },
  { id: '43002148', name: 'Live · 1251442', ccy: 'USD', isLive: true, bal: null, day: 0, gw: 0, gl: 0, n30: null, cap: null, used: null, equity: null, live: null, hasToday: false, usedCol: '#888' },
]

describe('PerfAccountScope', () => {
  it('prints the stamped balance on one card and "not read" with no daily stop on the unstamped one — never the same number twice', () => {
    const html = renderToStaticMarkup(<PerfAccountScope acctCards={cards} palette={palette} money={money} signed={signed} scope="47790949" onScopeChange={() => {}} />)
    expect(html).toMatch(/45,837\.59/)
    const start = html.indexOf('Live · 1251442')
    const liveCard = html.slice(start, html.indexOf('daily stop', start) + 'daily stop'.length)
    expect(liveCard).toMatch(/not read/)
    expect(liveCard).not.toMatch(/45,837\.59/) // the live card never shows the demo account's number
    expect(html).toMatch(/not read/)
    expect(html).toMatch(/of −— daily stop/)
    expect(html).toMatch(/nothing is borrowed from another account/)
  })
})
