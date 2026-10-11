// W3 — Claude · № 13,368 12-Oct (ordered after № 13,350; claude-builder).
// The capped hybrid card: one line per open position, the verdict in plain
// words, and "not available" (never an empty healthy list) without a record.
import { test, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CappedHybridReading } from './CappedHybridCard.jsx'
import { verdictLine, reasonWords } from '../lib/hybrid-verdict-words.js'

const pos = (tradeId, verdict, extra = {}) => ({ tradeId, accountId: '47790949', positionId: String(500 + tradeId), symbol: `S${tradeId}`, side: 'BUY', strategy: 'x', book: false, verdict, reason: null, ...extra })
const status = (positions, over = {}) => ({
  accountId: '47790949', available: true, unavailableReason: null,
  pass: { at: '2026-10-12T05:00:00.000Z', ageMs: 45_000, ok: true, activePlans: 1, examined: 2 },
  counts: {}, positions, positionsTruncated: false, ...over,
})

test('W3 card: one line per open position, enrolled first, the verdict in plain words', () => {
  const html = renderToStaticMarkup(<CappedHybridReading status={status([
    pos(3, 'excluded', { reason: 'strategy_not_momentum', symbol: 'NVDA.US' }),
    pos(1, 'enrolled', { trigger: 104.5, closeVolume: 50, runnerVolume: 50, brokerTarget: 110, symbol: 'US500' }),
    pos(4, 'excluded', { reason: 'monitor_paused', book: true, symbol: 'XOM.US' }),
    pos(5, 'excluded', { reason: 'manual_account_not_authorised', symbol: 'BTCUSD' }),
  ])} />)
  expect((html.match(/<tr /g) || []).length).toBe(4)
  expect(html.indexOf('US500')).toBeLessThan(html.indexOf('NVDA.US'))
  expect(html).toContain('Enrolled: closes 50 units (half) when price reaches 104.5; the runner keeps the broker stop and take-profit 110')
  expect(html).toContain('Not eligible: not a trend, breakout or momentum strategy (mean reversion keeps its own +1R half)')
  expect(html).toContain('Not eligible: a momentum book position, paused here because the book&#x27;s own rules manage its exit')
  expect(html).toContain('Not eligible: a manual position on an account outside the manual hybrid scope')
  expect(html).toContain('Capped hybrid: last pass 2026-10-12T05:00:00.000Z (45 s ago); 1 active plan(s).')
})

test('W3 card: a missing record reads "not available" on every line, never an empty healthy list', () => {
  const html = renderToStaticMarkup(<CappedHybridReading status={status(
    [pos(1, 'not_available', { reason: 'missing' }), pos(2, 'not_available', { reason: 'missing' })],
    { available: false, unavailableReason: 'missing', pass: null })} />)
  expect(html).toContain('Capped hybrid: not available (the hybrid has not stored a pass on this agent).')
  expect((html.match(/Not available: the hybrid has not stored a pass on this agent/g) || []).length).toBe(2)
  expect(html).not.toContain('Enrolled')
  expect(renderToStaticMarkup(<CappedHybridReading error="Agent not connected" />)).toContain('Capped hybrid status unavailable: Agent not connected')
})

test('W3 card: a failed pass is said, and an empty view is not called healthy', () => {
  const html = renderToStaticMarkup(<CappedHybridReading status={status([], { pass: { at: 'x', ageMs: 600_000, ok: false, activePlans: 0 } })} />)
  expect(html).toContain('(10 min ago), which reported a failure')
  expect(html).toContain('No open position in this view.')
})

test('W3 words: each verdict kind, and an unknown code shown as itself, never another reason', () => {
  expect(verdictLine(pos(1, 'delegated', { planState: 'ARMED' }))).toBe('Left to its own partial plan (ARMED)')
  expect(verdictLine(pos(1, 'deferred', { reason: 'enrolment_budget' }))).toBe('Waiting: the pass reached its time budget first; checked again on a later pass')
  expect(verdictLine(pos(1, 'error', { reason: 'unclassified_error_redacted' }))).toBe('The last check failed: an error (details withheld); retried on the next pass')
  expect(verdictLine(pos(1, 'not_in_last_pass'))).toBe('Not in the last pass\'s record yet')
  expect(verdictLine(pos(1, 'not_in_last_pass', { reason: 'record_truncated' }))).toBe('Not in the readable record: the stored record was cut at its size limit')
  expect(verdictLine(pos(1, 'excluded', { reason: 'monitor_paused', book: false }))).toBe('Not eligible: its management is paused')
  expect(reasonWords('some_new_code')).toBe('some new code')
  expect(reasonWords(null)).toBe(null)
  expect(verdictLine(pos(1, 'weird'))).toBe('Unknown verdict: weird')
})
