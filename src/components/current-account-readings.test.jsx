// V3 WEB-4: the readings table says who refreshes the readings (the server,
// once a minute, with or without the page) and shows the server's own
// failure notice. Rendered with react-dom/server: no jsdom in this repo.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import CurrentAccountReadings from './CurrentAccountReadings.jsx'

const row = { accountId: '11', isLive: false, currency: 'USD', balance: 1000, openPnl: 5, equity: 1005, freeMargin: 995,
  snapshotAt: '2026-09-25T16:00:00.000Z', status: 'fresh', reason: null }

describe('CurrentAccountReadings', () => {
  it('states that the server reads every account once a minute whether or not the page is open', () => {
    const html = renderToStaticMarkup(<CurrentAccountReadings report={{ accounts: [row], serverReadings: { status: 'success', fresh: true, at: row.snapshotAt } }} />)
    expect(html).toContain('The server reads every account from the broker once a minute, whether or not this page is open')
    expect(html).not.toContain('role="status"')
  })
  it('shows the server\'s notice when a round could not read an account', () => {
    const html = renderToStaticMarkup(<CurrentAccountReadings report={{ accounts: [row],
      serverReadings: { status: 'partial', fresh: true, at: row.snapshotAt, failed: [{ accountId: '22', reason: 'broker_timeout' }], missing: [] } }} />)
    expect(html).toMatch(/role="status">The latest server reading did not read 1 account: 22 \(broker timeout\)/)
  })
})
