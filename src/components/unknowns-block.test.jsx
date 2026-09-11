// npx vitest run src/components/unknowns-block.test.jsx
//
// PR-E (owner principle 4): the Unknowns block renders the UNKNOWN intents
// of GET /state/entry-intents from a fixture (react-dom/server: first render,
// no effects — there is no jsdom in this repo), and the resolve poster sends
// { state, reason } to POST /actions/entry-intents/:id/resolve — refusing
// locally, before any post, on the route's own reason rule.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UnknownsList } from './EngineStatusPanel.jsx'
import { unknownRows, resolveUnknownIntent, runOriginBackfill, backfillSummary, validateResolve, ageLabel, inScope } from '../lib/unknown-intents.js'

const NOW = Date.parse('2026-09-11T08:00:00Z')
const view = {
  at: '2026-09-11T08:00:00.000Z',
  countsByAccount: { '…0058': { UNKNOWN: 2, RESERVED: 1 } },
  open: [
    { id: 'iabc123456789', accountId: '…0058', environment: 'demo', symbol: 'EURUSD', symbolId: 1, side: 'BUY', producerId: 'scan_dispatch', state: 'UNKNOWN', createdAt: '2026-09-11T02:30:00.000Z', updatedAt: '2026-09-11T02:31:01.000Z', errorCode: 'TIMEOUT' },
    { id: 'ires000000001', accountId: '…0058', environment: 'demo', symbol: 'GBPUSD', symbolId: 2, side: 'SELL', producerId: 'vpo_cpp_direct', state: 'RESERVED', createdAt: '2026-09-11T07:59:00.000Z', updatedAt: '2026-09-11T07:59:00.000Z', errorCode: null },
    { id: 'idef000000002', accountId: '…3489', environment: 'live', symbol: null, symbolId: 41, side: 'SELL', producerId: 'route_manual_order', state: 'UNKNOWN', createdAt: '2026-09-11T07:50:00.000Z', updatedAt: '2026-09-11T07:51:01.000Z', errorCode: 'no verdict within the send timeout' },
  ],
  recent: [],
}

describe('unknownRows', () => {
  it('keeps only the UNKNOWN intents, oldest first, with last-4 account, symbol, side, age and error', () => {
    const rows = unknownRows(view, NOW)
    expect(rows.map(r => r.id)).toEqual(['iabc123456789', 'idef000000002'])
    expect(rows[0]).toMatchObject({ account: '0058', symbol: 'EURUSD', side: 'BUY', age: '5 h 30 min', errorCode: 'TIMEOUT' })
    expect(rows[1]).toMatchObject({ account: '3489', symbol: '#41', side: 'SELL', age: '10 min', errorCode: 'no verdict within the send timeout' })
    expect(unknownRows(null, NOW)).toEqual([])
    expect(ageLabel('nonsense', NOW)).toBe('age unknown')
  })
  it('m5: filters to the panel\'s account scope by the redacted last four; "all" keeps every account', () => {
    expect(unknownRows(view, NOW, { scope: 'all' }).map(r => r.id)).toEqual(['iabc123456789', 'idef000000002'])
    expect(unknownRows(view, NOW, { scope: '46130058' }).map(r => r.id)).toEqual(['iabc123456789'])
    expect(unknownRows(view, NOW, { scope: '42993489' }).map(r => r.id)).toEqual(['idef000000002'])
    expect(unknownRows(view, NOW, { scope: '11110000' })).toEqual([])
    expect(inScope('…0058', undefined)).toBe(true); expect(inScope('…0058', '46130058')).toBe(true); expect(inScope('…0058', '42993489')).toBe(false)
  })
})

describe('UnknownsList', () => {
  it('renders one row per UNKNOWN intent with a state select, a reason field and a Resolve button; nothing for the RESERVED row', () => {
    const html = renderToStaticMarkup(<UnknownsList rows={unknownRows(view, NOW)} />)
    expect(html).toContain('data-testid="unknown-iabc123456789"')
    expect(html).toContain('data-testid="unknown-idef000000002"')
    expect(html).not.toContain('ires000000001')
    expect(html).toMatch(/…0058[\s\S]*EURUSD[\s\S]*BUY[\s\S]*UNKNOWN for 5 h 30 min[\s\S]*TIMEOUT/)
    expect(html).toMatch(/…3489[\s\S]*#41[\s\S]*SELL[\s\S]*UNKNOWN for 10 min/)
    expect(html).toContain('aria-label="Resolution for intent iabc123456789"')
    expect(html).toContain('<option value="FILLED"')
    expect(html).toContain('<option value="REJECTED"')
    expect(html).toContain('aria-label="Reason for intent iabc123456789"')
    // an empty reason disables Resolve with the rule as its title
    expect(html).toContain('<button type="button" disabled="" title="a reason of at least 3 characters is required"')
    expect(html).not.toContain('…46130058')
  })
  it('with a draft reason of three characters the Resolve button is live and names the route; a note is shown as the server answered it', () => {
    const rows = unknownRows(view, NOW)
    const html = renderToStaticMarkup(<UnknownsList rows={rows} drafts={{ iabc123456789: { state: 'REJECTED', reason: 'deal history shows nothing' } }} notes={{ idef000000002: { ok: true, text: 'UNKNOWN → FILLED (server)' } }} />)
    expect(html).toContain('<button type="button" title="POST /actions/entry-intents/iabc123456789/resolve — the ledger is re-read afterwards"')
    expect(html).not.toContain('disabled="" title="POST /actions/entry-intents/iabc123456789/resolve')
    expect(html).toContain('UNKNOWN → FILLED (server)')
    expect(html).toContain('value="deal history shows nothing"')
  })
  it('says so when there is no UNKNOWN', () => {
    expect(renderToStaticMarkup(<UnknownsList rows={[]} />)).toContain('no UNKNOWN intent')
  })
})

describe('resolveUnknownIntent', () => {
  it('posts { state, reason } to /actions/entry-intents/:id/resolve and returns the server\'s answer', async () => {
    const calls = []
    const post = async (path, body) => { calls.push([path, body]); return { ok: true, from: 'UNKNOWN', to: 'REJECTED' } }
    const r = await resolveUnknownIntent(post, 'iabc123456789', { state: 'REJECTED', reason: '  broker history: no deal in the window ' })
    expect(calls).toEqual([['/actions/entry-intents/iabc123456789/resolve', { state: 'REJECTED', reason: 'broker history: no deal in the window' }]])
    expect(r).toEqual({ ok: true, from: 'UNKNOWN', to: 'REJECTED', posted: true })
  })
  it('refuses locally — no post — without a reason of three characters or with a state the route does not accept', async () => {
    const calls = []
    const post = async (path, body) => { calls.push([path, body]); return { ok: true } }
    expect((await resolveUnknownIntent(post, 'i1', { state: 'FILLED', reason: 'ok' })).posted).toBe(false)
    expect((await resolveUnknownIntent(post, 'i1', { state: 'RELEASED', reason: 'long enough' })).posted).toBe(false)
    expect((await resolveUnknownIntent(post, '', { state: 'FILLED', reason: 'long enough' })).posted).toBe(false)
    expect(calls).toEqual([])
    expect(validateResolve({ state: 'FILLED', reason: 'abc' }).ok).toBe(true)
  })
  it('passes the server\'s refusal through', async () => {
    const r = await resolveUnknownIntent(async () => ({ ok: false, reason: 'not_open: FILLED' }), 'i1', { state: 'FILLED', reason: 'seen at the broker' })
    expect(r).toEqual({ ok: false, reason: 'not_open: FILLED', posted: true })
  })
})

describe('origin backfill', () => {
  it('dry-runs by default and applies only with apply: true; the summary carries the counts', async () => {
    const calls = []
    const post = async (path, body) => { calls.push([path, body]); return body.apply ? { ok: true, mode: 'apply', dryRun: false, rows: 3, counts: { bot_market_dispatch: 2, legacy_unattributed: 1 }, written: 3 } : { ok: true, mode: 'plan', dryRun: true, rows: 3, counts: { bot_market_dispatch: 2, legacy_unattributed: 1 }, written: 0 } }
    const plan = await runOriginBackfill(post)
    const applied = await runOriginBackfill(post, { apply: true })
    expect(calls).toEqual([['/actions/backfill-trade-origin', {}], ['/actions/backfill-trade-origin', { apply: true }]])
    expect(backfillSummary(plan)).toBe('plan: 3 row(s) would be written — bot_market_dispatch 2, legacy_unattributed 1')
    expect(backfillSummary(applied)).toBe('applied: 3 of 3 row(s) written — bot_market_dispatch 2, legacy_unattributed 1')
    expect(backfillSummary({ error: '500' })).toBe('backfill failed: 500')
  })
})
