// WEB-10 (8,989-A row 13): what the realised-P&L / decisions chart draws.
import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ReportChart from './ReportChart.jsx'
import { emptyPopulation } from '../../agent/shared/performance-populations.js'

const g = (accountId, day, net, priced = 1, unpriced = 0) => ({ accountId, day,
  stats: { ...emptyPopulation(), n: priced + unpriced, pricedN: priced, net: priced ? net : 0 } })
const report = daily => ({ status: 'complete', timeZone: 'UTC', asOfMs: Date.parse('2026-09-24T12:00:00Z'), daily })
// The equity line is the accent path drawn at 2.4 px; its `d` holds one
// subpath (one "M") per unbroken stretch.
const equityPath = html => html.match(/<path d="([^"]*)" fill="none" stroke="var\(--color-accent\)" stroke-width="2.4"/)?.[1]

test('an unpriced close is a labelled break in the line, never bridged as zero', () => {
  const html = renderToStaticMarkup(<ReportChart accountId="11" daily={[{ day: '2026-09-20', approved: 1, vetoed: 4, vetoed_distinct: 2 }]}
    populationReport={report([g('11', '2026-09-18', 100), g('11', '2026-09-19', -40), g('11', '2026-09-21', null, 0, 1), g('11', '2026-09-22', 25)])} />)
  const d = equityPath(html)
  expect(d).toBeTruthy()
  // 18–20 Sep, then the break on 21 Sep, then 21–24 Sep: two stretches.
  expect(d.match(/M/g)).toHaveLength(2)
  expect(html).toContain('data-gap-day="2026-09-21"')
  expect(html).toContain('>no price<')
  expect(html).toContain('1 close has no recorded price (1 day, marked “no price”) — not in the line; the line breaks there and later levels count priced closes only')
  expect(html).not.toContain('never drawn as zero')
  expect(html).toContain('the line breaks at each such day')
  expect(html).toContain('largest drawdown within unbroken stretches')
  expect(html).not.toContain('The money curve is unavailable')
})

test('a fully priced account draws one unbroken line with no gap label', () => {
  const html = renderToStaticMarkup(<ReportChart accountId="11" daily={[]}
    populationReport={report([g('11', '2026-09-20', 10), g('11', '2026-09-22', 5)])} />)
  expect(equityPath(html).match(/M/g)).toHaveLength(1)
  expect(html).not.toContain('data-gap-day')
  expect(html).not.toContain('no recorded price')
  expect(html).toContain('daily realised-P&amp;L drawdown in range')
})

test('the All view opens on an account it can draw, not on the first registered account', () => {
  const accounts = [{ account_id: '42993489', is_live: 0 }, { account_id: '43002148', is_live: 0 }, { account_id: '43097342', is_live: 0 }]
  const html = renderToStaticMarkup(<ReportChart accountId="all" accounts={accounts}
    populationReport={report([g('42993489', '2026-09-21', null, 0, 1), g('43097342', '2026-09-20', 12)])} />)
  expect(html).toMatch(/<option value="43097342" selected="">/)
  expect(html).not.toMatch(/<option value="42993489" selected="">/)
  expect(html).toContain('Opened on the first account whose recorded closes all have a price.')
  expect(html).not.toContain('The money curve is unavailable')
})

test('the decision bars say they count risk-engine decisions only, and old days are not zero', () => {
  const html = renderToStaticMarkup(<ReportChart accountId="11" daily={[{ day: '2026-09-20', approved: 3, vetoed: 5 }]}
    populationReport={report([g('11', '2026-05-01', 1), g('11', '2026-09-20', 2)])} />)
  expect(html).toContain('risk-engine decisions only — upstream stops are not counted here')
  expect(html).toContain('8 risk-engine decisions · 63% vetoed · upstream stops not counted')
  expect(html).toContain('Entries stopped upstream of the risk engine are not counted here')
  expect(html).toContain('>Risk decisions<')
  // The chart opens on 30D, wholly inside the 90-day decision feed, so no day
  // is claimed as unretained (the unit test covers the All range).
  expect(html).not.toContain('Decisions are retained')
})

// Checker blocker (WEB-10 fix round): the opened-on sentence is a claim about
// evidence, so it is absent whenever that evidence was not measured.
const OPENED = /Opened on the first account/
const three = [{ account_id: '42993489', is_live: 0 }, { account_id: '43002148', is_live: 0 }]

test('with no complete population report the All view says nothing about why it opened on an account', () => {
  const html = renderToStaticMarkup(<ReportChart accountId="all" accounts={three} populationReport={null} />)
  expect(html).toMatch(/<option value="42993489" selected="">/)
  expect(html).not.toMatch(OPENED)
})

test('when no account can be drawn the All view says nothing about why it opened on an account', () => {
  const html = renderToStaticMarkup(<ReportChart accountId="all" accounts={three}
    populationReport={report([g('42993489', '2026-09-21', null, 0, 1), g('43002148', '2026-09-22', null, 0, 2)])} />)
  expect(html).toMatch(/<option value="42993489" selected="">/)
  expect(html).toContain('The money curve is unavailable')
  expect(html).not.toMatch(OPENED)
  // Withheld, the headline does not claim a line that breaks.
  expect(html).toContain('— not drawn as zero; no money line is drawn')
  expect(html).not.toContain('the line breaks there')
})

test('with no priced close anywhere the All view says it opened on an account with no closes', () => {
  const html = renderToStaticMarkup(<ReportChart accountId="all" accounts={three}
    populationReport={report([g('42993489', '2026-09-21', null, 0, 1)])} />)
  expect(html).toMatch(/<option value="43002148" selected="">/)
  expect(html).toContain('Opened on the first account with no recorded closes: no account has a priced close.')
})
