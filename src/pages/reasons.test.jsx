// PR-F: the Reasons page renders each attribution endpoint with the
// endpoint's OWN fields and an honest per-block "not read" state.
//
// UI-6 (26-09 UI plan §2 RS-1b/RS-2, "Reasons restructure and tables"):
// go-live-readiness is removed (D4/OD-19); phase-audit and exit-counterfactual
// move onto Desk/Tune (PhaseAuditSection/ExitCounterfactualSection, tested
// here since they still live in this file); several endpoints fold under one
// shared heading (ReasonsGroup); tables move onto the shared DataTable (RS-2).
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { ReasonsBlock, ReasonsGroup, PhaseAuditSection, ExitCounterfactualSection } from './Reasons.jsx'
import { REASON_ENDPOINTS, REASONS_PAGE_KEYS, REASONS_PAGE_LAYOUT, shapeBody, blockState, reasonScope } from '../lib/reasons-view.js'

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
    for (const key of ['exit-counterfactual', 'exit-price-suspects']) {
      expect(reasonScope(def(key), { ok: true, body: { accountId: null } })).toBe('all')
      expect(reasonScope(def(key), { ok: true, body: {} })).toBeUndefined()
    }
    expect(reasonScope(def('open-duplicates'), { ok: true, body: { scope: { account: 'all' } } })).toBe('all')
    // UI-6: veto-breakdown declares its scope as a bare `account` field.
    expect(reasonScope(def('veto-breakdown'), { ok: true, body: { account: null } })).toBe('all')
    expect(reasonScope(def('veto-breakdown'), { ok: true, body: { account: '46130058' } })).toBe('46130058')
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
    for (const c of ['id', 'symbol', 'state', 'producer', 'reason']) expect(html).toMatch(new RegExp(`<button[^>]*>${c}\\b`))
    expect(html).toMatch(/>FILLED</); expect(html).toMatch(/>UNKNOWN</)
    expect(html).toMatch(/2 rows shown/)
    // The null reason renders as a dash — never a computed placeholder.
    expect(html).toMatch(/title="—"/)
  })
  it('a nested flat count map an endpoint opts into expanding renders as its own KV list, never "N fields"', () => {
    // attribution/"Trade origin" (RS-1: "make the origin breakdown the
    // headline") — originCoverage.byOrigin was hidden as "3 fields" before.
    const body = { groupBy: 'strategy', rows: [], originCoverage: { n: 567, byOrigin: { unknown: 225, bot_market_dispatch: 300, legacy_unattributed: 42 }, known: 342, knownPct: 60.3 } }
    const html = renderToStaticMarkup(<ReasonsBlock def={def('attribution')} result={{ ok: true, body }} />)
    expect(html).toMatch(/<dt[^>]*>unknown<\/dt><dd[^>]*>225<\/dd>/)
    expect(html).toMatch(/<dt[^>]*>bot_market_dispatch<\/dt><dd[^>]*>300<\/dd>/)
    expect(html).not.toContain('3 fields')
    expect(html).toContain('Trade origin')
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

describe('ReasonsGroup — several endpoints folded under one heading (RS-1)', () => {
  it('names the shared heading once and keeps each endpoint\'s own block state independent', () => {
    const blocks = [
      { def: def('exit-price-suspects'), result: { ok: true, body: { accountId: null, rows: [] } }, at: '10:00:00' },
      { def: def('open-duplicates'), result: { ok: false, error: 'HTTP 500' }, at: null },
    ]
    const html = renderToStaticMarkup(<ReasonsGroup heading="Ledger integrity" blocks={blocks} />)
    expect(html).toContain('Ledger integrity')
    expect(html).toMatch(/data-reasons-block="exit-price-suspects"[^>]*data-status="ok"|data-status="ok"[^>]*data-reasons-block="exit-price-suspects"/)
    expect(html).toContain('data-status="error"')
    expect(html).toContain('not read — HTTP 500')
  })
})

describe('PhaseAuditSection / ExitCounterfactualSection — moved onto Desk / Tune (RS-1)', () => {
  it('render as an ordinary ReasonsBlock for their own endpoint, before any read completes', () => {
    const html = renderToStaticMarkup(<PhaseAuditSection />)
    expect(html).toMatch(/data-reasons-block="phase-audit"/)
    expect(html).toContain('Phase audit')
    const html2 = renderToStaticMarkup(<ExitCounterfactualSection />)
    expect(html2).toMatch(/data-reasons-block="exit-counterfactual"/)
    expect(html2).toContain('Exit counterfactual')
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
  it('an opted-in nested flat map (`expand`) surfaces as its own KV pairs, off by default', () => {
    const body = { originCoverage: { n: 567, byOrigin: { unknown: 225, bot_market_dispatch: 300 }, known: 342 } }
    const expanded = shapeBody(body, { expand: ['originCoverage.byOrigin'] })
    expect(expanded.objects[0].nested).toEqual([])
    expect(expanded.objects[0].expanded).toEqual([{ key: 'byOrigin', pairs: [['unknown', '225'], ['bot_market_dispatch', '300']] }])
    // Without the option, the same body keeps the old "N fields" summary and
    // carries no `expanded` key at all — the default shape is unchanged.
    const plain = shapeBody(body)
    expect(plain.objects[0].nested).toEqual([['byOrigin', '2 fields']])
    expect(plain.objects[0].expanded).toBeUndefined()
    // A nested value that is NOT a flat scalar map is never expanded, even
    // when named — expanding it would hide structure, not reveal it.
    const deep = shapeBody({ o: { m: { a: { z: 1 } } } }, { expand: ['o.m'] })
    expect(deep.objects[0].nested).toEqual([['m', '1 field']])
    expect(deep.objects[0].expanded).toBeUndefined()
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

describe('the thirteen endpoints (UI-6: minus go-live-readiness, plus veto-breakdown)', () => {
  it('are all served by agent/routes/state.js, and REASONS_PAGE_KEYS excludes only the two moved onto Desk/Tune', () => {
    expect(REASON_ENDPOINTS.map(d => d.key)).toEqual([
      'order-lifecycle', 'entry-intents', 'trade-plans', 'unknown-pnl', 'unresolvable-plan', 'trade-consistency',
      'attribution', 'exit-price-suspects', 'open-duplicates', 'refusal-cost', 'veto-breakdown', 'phase-audit', 'exit-counterfactual',
    ])
    const routes = readFileSync(new URL('../../agent/routes/state.js', import.meta.url), 'utf8').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    // The query string is the read's scope (?account=all), not part of the route.
    for (const d of REASON_ENDPOINTS) expect(routes, d.path).toContain(`router.get('${d.path.replace('/state', '').split('?')[0]}'`)
    expect(REASONS_PAGE_KEYS).toEqual(REASON_ENDPOINTS.map(d => d.key).filter(k => k !== 'phase-audit' && k !== 'exit-counterfactual'))
    // Every layout key is a real, on-page endpoint; nothing on the page is
    // left out of the layout, and the two moved endpoints are not in it.
    const laidOut = REASONS_PAGE_LAYOUT.flatMap(g => g.keys)
    expect(laidOut.sort()).toEqual([...REASONS_PAGE_KEYS].sort())
    expect(laidOut).not.toContain('phase-audit')
    expect(laidOut).not.toContain('exit-counterfactual')
    expect(laidOut).not.toContain('go-live-readiness')
  })
  it('order-lifecycle: rules[] and accounts[] render as tables, scope reads all, and a 503 is an error, not zeros', () => {
    const body = { schemaVersion: 1, scope: { account: 'all', explicit: true }, summary: { stuck: { new: 2 } },
      rules: [{ id: 'STK-01', key: 'resting_record_orphaned', violations: 6, newViolations: 6 }], accounts: [{ account: '46130058', stage: 'stuck', new: 2 }] }
    expect(reasonScope(def('order-lifecycle'), { ok: true, body })).toBe('all')
    const html = renderToStaticMarkup(<ReasonsBlock def={def('order-lifecycle')} result={{ ok: true, body }} />)
    for (const c of ['id', 'key', 'violations', 'newViolations', 'account', 'stage']) expect(html).toMatch(new RegExp(`<button[^>]*>${c}\\b`))
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
    // RS-2: the DataTable group header, not the old inline "{key} <span>"
    // heading — the row count comes straight from the endpoint's own total.
    expect(html).toMatch(/rules<span[^>]*> — 35 rows<\/span>/)
    expect(html).toMatch(/accounts<span[^>]*> — 32 rows<\/span>/)
    expect(html).not.toMatch(/first 25 of/)
    // The summary: one row per stage with its own fields, not "2 fields".
    expect(html).toMatch(/summary<span[^>]*> — 2 rows<\/span>/)
    expect(html).toMatch(/<th[^>]*><button[^>]*>key\b/)
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
  it('the moved endpoints are wired into Desk and Tune, not just defined', () => {
    const desk = readFileSync(new URL('./Desk.jsx', import.meta.url), 'utf8')
    expect(desk).toMatch(/PhaseAuditSection/)
    const tune = readFileSync(new URL('./Tune.jsx', import.meta.url), 'utf8')
    expect(tune).toMatch(/ExitCounterfactualSection/)
  })
})
