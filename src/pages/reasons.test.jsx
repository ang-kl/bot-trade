// PR-F: the Reasons page renders each attribution endpoint with the
// endpoint's OWN fields and an honest per-block "not read" state.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { ReasonsBlock } from './Reasons.jsx'
import { REASON_ENDPOINTS, shapeBody, blockState, reasonScope } from '../lib/reasons-view.js'

const def = k => REASON_ENDPOINTS.find(d => d.key === k)

describe('ReasonsBlock', () => {
  it('keeps older unresolved history visible beside a clear current daily report', () => {
    const body = { summary: { blocking: 0 }, rows: [],
      history: { ok: true, total: 2, truncated: false, scope: 'all retained closed trades with unknown P&L; all accounts' },
      historyRows: [{ id: 9, reason: 'position_ledger_ambiguous', ledgerRows: ['9:closed', '10:open'] }],
    }
    const html = renderToStaticMarkup(<ReasonsBlock def={def('unknown-pnl')} result={{ ok: true, body }} />)
    expect(html).toContain('All accounts')
    expect(html).toContain('all retained closed trades with unknown P&amp;L; all accounts')
    expect(html).toContain('position_ledger_ambiguous')
    expect(html).toContain('9:closed, 10:open')
    expect(html).toMatch(/<dt[^>]*>total<\/dt><dd[^>]*>2<\/dd>/)
  })
  it('shows the returned account and never labels its selected-account data as all accounts', () => {
    const result = { ok: true, body: { accountId: '46130058', scope: 'account', rows: [] } }
    const html = renderToStaticMarkup(<ReasonsBlock def={def('trade-consistency')} result={result} />)
    expect(html).toContain('Account 46130058')
    expect(html).not.toContain('All accounts')
    expect(reasonScope(def('attribution'), { ok: true, body: { scope: { account: '77' } } })).toBe('77')
    expect(reasonScope(def('phase-audit'), { ok: true, body: { scope: 'account 77 (the trading account)' } })).toBe('77')
  })
  it('distinguishes explicit portfolio and global-ledger reads from missing or failed scope evidence', () => {
    for (const key of ['entry-intents', 'trade-plans', 'unknown-pnl', 'unresolvable-plan', 'refusal-cost']) {
      expect(reasonScope(def(key), { ok: true, body: { rows: [] } })).toBe('all')
    }
    for (const key of ['exit-counterfactual', 'exit-price-suspects', 'go-live-readiness']) {
      expect(reasonScope(def(key), { ok: true, body: { accountId: null } })).toBe('all')
      expect(reasonScope(def(key), { ok: true, body: {} })).toBeUndefined()
    }
    expect(reasonScope(def('open-duplicates'), { ok: true, body: { scope: { account: 'all' } } })).toBe('all')
    for (const result of [undefined, { ok: false, error: 'HTTP 500' }, { ok: true, body: { accountId: null, scope: 'account' } }]) {
      const html = renderToStaticMarkup(<ReasonsBlock def={def('trade-consistency')} result={result} />)
      expect(html).toContain('Scope unavailable for this read')
      expect(html).not.toContain('All accounts')
    }
  })
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

describe('the thirteen endpoints', () => {
  it('are the twelve the plan names plus V3 L1 order-lifecycle, and each is served by agent/routes/state.js', () => {
    expect(REASON_ENDPOINTS.map(d => d.key)).toEqual(['entry-intents', 'trade-plans', 'unknown-pnl', 'unresolvable-plan', 'trade-consistency', 'attribution', 'refusal-cost', 'exit-counterfactual', 'exit-price-suspects', 'open-duplicates', 'go-live-readiness', 'phase-audit', 'order-lifecycle'])
    const routes = readFileSync(new URL('../../agent/routes/state.js', import.meta.url), 'utf8').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    // The query string is the read's scope (?account=all), not part of the route.
    for (const d of REASON_ENDPOINTS) expect(routes, d.path).toContain(`router.get('${d.path.replace('/state', '').split('?')[0]}'`)
  })
  it('order-lifecycle: rules[] and accounts[] render as tables, scope reads all, and a 503 is an error, not zeros', () => {
    const body = { schemaVersion: 1, scope: { account: 'all', explicit: true }, summary: { stuck: { new: 2 } },
      rules: [{ id: 'STK-01', key: 'resting_record_orphaned', violations: 6, newViolations: 6 }], accounts: [{ account: '46130058', stage: 'stuck', new: 2 }] }
    expect(reasonScope(def('order-lifecycle'), { ok: true, body })).toBe('all')
    const html = renderToStaticMarkup(<ReasonsBlock def={def('order-lifecycle')} result={{ ok: true, body }} />)
    for (const c of ['id', 'key', 'violations', 'newViolations', 'account', 'stage']) expect(html).toMatch(new RegExp(`<th[^>]*>${c}</th>`))
    expect(html).toContain('resting_record_orphaned')
    const failed = renderToStaticMarkup(<ReasonsBlock def={def('order-lifecycle')} result={{ ok: false, error: 'HTTP 503 order_lifecycle_unavailable' }} />)
    expect(failed).toMatch(/data-status="error"/)
    expect(failed).toContain('not read — HTTP 503 order_lifecycle_unavailable')
    expect(failed).not.toMatch(/<table/)
  })
  it('order-lifecycle: all 35 rules reach the page (the default 25-row cut hid STK-02..STK-11) and the stage summary is a table', () => {
    const ids = [...Array.from({ length: 5 }, (_, i) => `PRE-0${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `ORD-${String(i + 1).padStart(2, '0')}`),
      ...Array.from({ length: 9 }, (_, i) => `CLS-0${i + 1}`), ...Array.from({ length: 11 }, (_, i) => `STK-${String(i + 1).padStart(2, '0')}`)]
    expect(ids).toHaveLength(35)
    const body = { scope: { account: 'all', explicit: true },
      summary: { pre_order: { new: 0, legacy: 3, measurable: true, note: 'not a pass — 0 new defective record(s) over the readable rules' }, stuck: { new: 2, legacy: 0, measurable: true, note: '2 stuck record(s)' } },
      rules: ids.map(id => ({ id, violations: id === 'STK-11' ? 1 : 0 })),
      accounts: Array.from({ length: 32 }, (_, i) => ({ account: String(46130000 + i), stage: 'stuck', new: 1 })) }
    const html = renderToStaticMarkup(<ReasonsBlock def={def('order-lifecycle')} result={{ ok: true, body }} />)
    expect(html).toContain('STK-11')
    expect(html).toMatch(/rules <span[^>]*>— 35 rows<\/span>/)
    expect(html).toMatch(/accounts <span[^>]*>— 32 rows<\/span>/)
    expect(html).not.toMatch(/first 25 of/)
    // The summary: one row per stage with its own fields, not "2 fields".
    expect(html).toMatch(/summary <span[^>]*>— 2 rows<\/span>/)
    expect(html).toMatch(/<th[^>]*>key<\/th>/)
    expect(html).toContain('not a pass — 0 new defective record(s) over the readable rules')
    expect(html).not.toMatch(/2 fields/)
    // Another block keeps the default cut: the option is per endpoint.
    expect(shapeBody({ rows: ids.map(id => ({ id })) }).tables[0].rows).toHaveLength(25)
  })
  it('the page is routed and in the navigation', () => {
    const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8')
    expect(app).toMatch(/<Route path="\/reasons" element=\{<Reasons \/>\} \/>/)
    expect(app).toMatch(/\{ to: '\/reasons', label: 'Reasons'/)
    const tabs = readFileSync(new URL('../lib/nav-tabs.js', import.meta.url), 'utf8')
    expect(tabs).toMatch(/\{ to: '\/reasons', label: 'Reasons'/)
  })
})
