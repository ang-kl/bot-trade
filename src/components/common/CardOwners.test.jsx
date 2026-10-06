// Codex · №11,642·R (ui-followup-2026-10-07) — exercise actual delegated card owners.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AccountHealth from '../AccountHealth.jsx'
import AccountPivot from '../AccountPivot.jsx'
import StrategyInsights from '../StrategyInsights.jsx'
import WatchlistScreener from '../WatchlistScreener.jsx'
import Card from './Card.jsx'

afterEach(() => vi.unstubAllGlobals())
const acct = id => ({ accountId: id, currency: 'USD', health: { balance: 100 }, positions: [{ strategy: 'ema_pullback', netPnl: 1 }] })
function store(values) {
  vi.stubGlobal('localStorage', { getItem: key => values[key] ?? null, setItem() {} })
}

describe('actual card owners retain a reload choice and one leading control', () => {
  for (const [Component, props, id, title] of [
    [AccountHealth, { acct: acct(101) }, 'sec-account-health-101', 'Account health'],
    [AccountPivot, { acct: acct(101) }, 'sec-account-pivot-101', 'By trading type'],
    [StrategyInsights, { account: '101' }, 'sec-strategy-insights', 'Strategy Forecast'],
  ]) {
    it(`${Component.name} reads its actual persisted card state on fresh mounts`, () => {
      store({ [`card_open_${id}`]: '0' })
      for (let i = 0; i < 2; i++) {
        const html = renderToStaticMarkup(<Component {...props} />)
        expect(html).toContain('style="display:none"')
        expect(html.match(/aria-label="Expand this section"/g)).toHaveLength(1)
        expect(html).toMatch(new RegExp(`aria-label="Expand this section"[\\s\\S]*?</button>${title}`))
      }
      store({ [`card_open_${id}`]: '1' })
      const html = renderToStaticMarkup(<Component {...props} />)
      expect(html).not.toContain('style="display:none"')
      expect(html.match(/aria-label="Collapse this section"/g)).toHaveLength(1)
      expect(html).toMatch(new RegExp(`<h3[^>]*><button[\\s\\S]*?</button>${title}`))
    })
  }
  it('two rendered account cards keep independent account-owned choices', () => {
    store({ 'card_open_sec-account-health-101': '0', 'card_open_sec-account-health-202': '1', 'card_open_sec-account-pivot-101': '0', 'card_open_sec-account-pivot-202': '1' })
    for (const Component of [AccountHealth, AccountPivot]) {
      expect(renderToStaticMarkup(<Component acct={acct(101)} />)).toContain('style="display:none"')
      expect(renderToStaticMarkup(<Component acct={acct(202)} />)).not.toContain('style="display:none"')
    }
  })
  it('the actual screener keeps its independent table preference within a larger card', () => {
    store({ tbl_open_WatchlistScreener_152: '0' })
    const html = renderToStaticMarkup(<Card id="watchlist"><h3>Watchlist</h3><p>Other watchlist content</p><WatchlistScreener curated={['EURUSD']} allSymbols={['EURUSD']} symbols={[]} /></Card>)
    expect(html).toContain('Screener Rows')
    expect(html).toContain('Other watchlist content')
    expect(html).not.toContain('EURUSD')
  })
})
