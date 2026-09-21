import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PositionMonitorStatus from './PositionMonitorStatus.jsx'

test('failed monitor reads cannot claim no review, no SL, or monitor ownership of a broker stop', () => {
  const html = renderToStaticMarkup(<PositionMonitorStatus readStatus="unverified" monitorSl={90} lastCheckAt="2026-09-22T00:00:00Z" />)
  expect(html).toContain('monitor read unverified')
  expect(html).toContain('monitor SL unverified')
  expect(html).not.toContain('not yet reviewed')
  expect(html).not.toContain('no tracked SL')
  expect(html).not.toContain('SL 90')
})

test('verified empty and reviewed monitor records remain distinct', () => {
  expect(renderToStaticMarkup(<PositionMonitorStatus readStatus="verified" />)).toContain('not yet reviewed')
  const html = renderToStaticMarkup(<PositionMonitorStatus readStatus="verified" monitorSl={90} lastCheckAt="2026-09-22T00:00:00Z" nowMs={Date.parse('2026-09-22T00:01:00Z')} />)
  expect(html).toContain('reviewed 1m ago')
  expect(html).toContain('SL 90')
})
