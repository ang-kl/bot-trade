import { test, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import DataTable from './DataTable.jsx'

const columns = [
  { key: 'at', label: 'Time' },
  { key: 'symbol', label: 'Symbol' },
]

test('an empty group set reads the caller\'s empty message, never a blank table', () => {
  const html = renderToStaticMarkup(<DataTable id="t" columns={columns} groups={[]} emptyMessage="No rows in this window." />)
  expect(html).toContain('No rows in this window.')
  expect(html).not.toContain('<table')
})

test('a day group with rows renders its label, its day count and every row', () => {
  const groups = [{ key: '2026-09-26', label: 'Sat 26 Sep 2026', count: 3, rows: [
    { id: 1, at: '2026-09-26 06:05:00', symbol: 'BTCUSD' },
    { id: 2, at: '2026-09-26 06:10:00', symbol: 'ETHUSD' },
  ] }]
  const html = renderToStaticMarkup(<DataTable id="t" columns={columns} groups={groups} />)
  expect(html).toContain('Sat 26 Sep 2026')
  expect(html).toContain('3 records this day')
  expect(html).toContain('BTCUSD')
  expect(html).toContain('ETHUSD')
  expect(html).toContain('2 rows shown.')
})

test('a group with zero folded rows but standing lines still renders (a roster-only day is not silently dropped)', () => {
  const groups = [{ key: '2026-09-26', label: 'Sat 26 Sep 2026', count: 0, rows: [], standing: [{ id: 's1' }] }]
  const html = renderToStaticMarkup(<DataTable id="t" columns={columns} groups={groups}
    renderStanding={(group) => <p>{group.standing.length} standing line(s)</p>} />)
  expect(html).toContain('Sat 26 Sep 2026')
  expect(html).toContain('1 standing line(s)')
})

test('"load older" is disabled without more pages; "N newer" only renders with a handler', () => {
  const groups = [{ key: 'd', label: 'D', count: 1, rows: [{ id: 1, at: 'x', symbol: 'A' }] }]
  const html1 = renderToStaticMarkup(<DataTable id="t" columns={columns} groups={groups} onLoadOlder={() => {}} hasMore={false} />)
  expect(html1).toMatch(/Load older[^<]*<\/button>/)
  expect(html1).toContain('disabled=""')
  const html2 = renderToStaticMarkup(<DataTable id="t" columns={columns} groups={groups} newerCount={5} onShowNewer={() => {}} />)
  expect(html2).toContain('5 newer — show')
})

test('renderDetails adds a Disclosure toggle per row, collapsed by default', () => {
  const groups = [{ key: 'd', label: 'D', count: 1, rows: [{ id: 1, at: 'x', symbol: 'A' }] }]
  const html = renderToStaticMarkup(<DataTable id="t" columns={columns} groups={groups}
    renderDetails={row => <p>detail for {row.symbol}</p>} />)
  expect(html).toContain('Show details')
  expect(html).not.toContain('detail for A')
})

test('every sortable column carries an aria-sort attribute', () => {
  const groups = [{ key: 'd', label: 'D', count: 1, rows: [{ id: 1, at: 'x', symbol: 'A' }] }]
  const html = renderToStaticMarkup(<DataTable id="t" columns={columns} groups={groups} defaultSort={{ key: 'at', dir: 'desc' }} />)
  expect(html).toContain('aria-sort="descending"')
  expect(html).toContain('aria-sort="none"')
})
