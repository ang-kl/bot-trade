// PR-F: the Reasons page renders each attribution endpoint with the
// endpoint's OWN fields and an honest per-block "not read" state.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { ReasonsBlock } from './Reasons.jsx'
import { REASON_ENDPOINTS, shapeBody, blockState } from '../lib/reasons-view.js'

const def = k => REASON_ENDPOINTS.find(d => d.key === k)

describe('ReasonsBlock', () => {
  it('entry-intents: scalars as a summary, the rows array as a table with the rows\' own columns', () => {
    const body = { count: 2, unknown: 1, rows: [
      { id: 7, symbol: 'EURUSD', state: 'FILLED', producer: 'tick_momentum', reason: 'breakout' },
      { id: 8, symbol: 'GBPUSD', state: 'UNKNOWN', producer: 'time_based', reason: null },
    ] }
    const html = renderToStaticMarkup(<ReasonsBlock def={def('entry-intents')} result={{ ok: true, body }} at="10:00:00" />)
    expect(html).toMatch(/data-reasons-block="entry-intents"/)
    expect(html).toMatch(/data-status="ok"/)
    expect(html).toMatch(/GET \/state\/entry-intents/)
    expect(html).toMatch(/<dt[^>]*>count<\/dt><dd[^>]*>2<\/dd>/)
    expect(html).toMatch(/<dt[^>]*>unknown<\/dt><dd[^>]*>1<\/dd>/)
    for (const c of ['id', 'symbol', 'state', 'producer', 'reason']) expect(html).toMatch(new RegExp(`<th[^>]*>${c}</th>`))
    expect(html).toMatch(/>FILLED</); expect(html).toMatch(/>UNKNOWN</)
    expect(html).toMatch(/2 rows/)
    // The null reason renders as a dash — never a computed placeholder.
    expect(html).toMatch(/title="—"/)
  })
  it('go-live-readiness: nested objects become sub-summaries, booleans read yes/no, nothing is totalled client-side', () => {
    const body = { ready: false, windowDays: 30, accountId: null, summary: { trades: 41, profitFactor: 1.18 }, checks: [{ check: 'profit_factor', ok: false, observed: '1.18', required: '≥ 1.3' }] }
    const html = renderToStaticMarkup(<ReasonsBlock def={def('go-live-readiness')} result={{ ok: true, body }} at={null} />)
    expect(html).toMatch(/<dt[^>]*>ready<\/dt><dd[^>]*>no<\/dd>/)
    expect(html).toMatch(/<dt[^>]*>accountId<\/dt><dd[^>]*>—<\/dd>/)
    expect(html).toMatch(/>summary</)
    expect(html).toMatch(/<dt[^>]*>profitFactor<\/dt><dd[^>]*>1\.18<\/dd>/)
    expect(html).toMatch(/<th[^>]*>observed<\/th>/)
    expect(html).toMatch(/1 row</)
  })
  it('an error (401) is an honest per-block "not read", not a hidden block or a zero', () => {
    const html = renderToStaticMarkup(<ReasonsBlock def={def('refusal-cost')} result={{ ok: false, error: 'HTTP 401 Unauthorized' }} at="10:00:00" />)
    expect(html).toMatch(/data-status="error"/)
    expect(html).toMatch(/data-not-read/)
    expect(html).toMatch(/not read — HTTP 401 Unauthorized \(the state routes need the bearer token\)/)
    expect(html).not.toMatch(/<table/)
    const none = renderToStaticMarkup(<ReasonsBlock def={def('refusal-cost')} result={undefined} at={null} />)
    expect(none).toMatch(/not read — not read/)
  })
})

describe('shapeBody / blockState', () => {
  it('keeps the body\'s own key order and never invents fields', () => {
    const s = shapeBody({ b: 1, a: 'x', rows: [{ k: 1 }, { j: 2 }], tags: ['p', 'q'], nested: { n: 1, deep: { z: 1 } } })
    expect(s.scalars).toEqual([['b', '1'], ['a', 'x']])
    expect(s.tables[0].columns).toEqual(['k', 'j'])
    expect(s.lists).toEqual([['tags', 'p, q']])
    expect(s.objects[0]).toEqual({ key: 'nested', scalars: [['n', '1']], nested: [['deep', '1 field']] })
    expect(shapeBody(null)).toEqual({ scalars: [], objects: [], tables: [], lists: [] })
  })
  it('caps a long table at 25 rows and says so', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ i }))
    expect(shapeBody({ rows }).tables[0]).toMatchObject({ total: 40 })
    expect(shapeBody({ rows }).tables[0].rows).toHaveLength(25)
  })
  it('blockState', () => {
    expect(blockState({ ok: true, body: {} })).toEqual({ status: 'ok', body: {} })
    expect(blockState({ ok: false, error: 'boom' })).toEqual({ status: 'error', message: 'not read — boom' })
  })
})

describe('the twelve endpoints', () => {
  it('are the twelve the plan names, and each is served by agent/routes/state.js', () => {
    expect(REASON_ENDPOINTS.map(d => d.key)).toEqual(['entry-intents', 'trade-plans', 'unknown-pnl', 'unresolvable-plan', 'trade-consistency', 'attribution', 'refusal-cost', 'exit-counterfactual', 'exit-price-suspects', 'open-duplicates', 'go-live-readiness', 'phase-audit'])
    const routes = readFileSync(new URL('../../agent/routes/state.js', import.meta.url), 'utf8').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    for (const d of REASON_ENDPOINTS) expect(routes, d.path).toContain(`router.get('${d.path.replace('/state', '')}'`)
  })
  it('the page is routed and in the navigation', () => {
    const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8')
    expect(app).toMatch(/<Route path="\/reasons" element=\{<Reasons \/>\} \/>/)
    expect(app).toMatch(/\{ to: '\/reasons', label: 'Reasons'/)
    const tabs = readFileSync(new URL('../lib/nav-tabs.js', import.meta.url), 'utf8')
    expect(tabs).toMatch(/\{ to: '\/reasons', label: 'Reasons'/)
  })
})
