// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
// The Trade page's pre-order check: where the pad sends, what it asks, and
// that a check is one request per tap — never a poll.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  scanCheckPath, manualCheckPath, manualOrderBody, padDestination, padInputs, checkKey, checkSummary,
  createCheckRunner, verdictLine, preorderLines,
} from './preorder-check.js'

const order = { symbol: ' eurusd ', side: 'BUY', lots: '0.2', sl: '1.09', tp: '1.135' }
const broker = { accountId: '46970949', traderLogin: '5123456' }

describe('padDestination — the account the page shows, else the primary', () => {
  it('routes to the viewed account when the page shows ONE account', () => {
    expect(padDestination({ viewedAccountId: 46130058, broker })).toEqual({ routed: true, accountId: '46130058', traderLogin: null })
    expect(padDestination({ viewedAccountId: '46970949', broker })).toEqual({ routed: true, accountId: '46970949', traderLogin: '5123456' })
  })
  it('keeps the primary (no account sent) in the portfolio view or with nothing selected', () => {
    for (const v of ['all', null, '']) {
      expect(padDestination({ viewedAccountId: v, broker })).toEqual({ routed: false, accountId: '46970949', traderLogin: '5123456' })
    }
    expect(padDestination({ viewedAccountId: 'all', broker: null })).toEqual({ routed: false, accountId: null, traderLogin: null })
  })
})

describe('manualOrderBody — the pad SENDS the account it shows', () => {
  it('carries `account` when routed', () => {
    const body = manualOrderBody({ order, destination: padDestination({ viewedAccountId: 46130058, broker }) })
    expect(body).toEqual({ symbol: 'EURUSD', side: 'BUY', lots: 0.2, sl: 1.09, tp: 1.135, account: '46130058' })
  })
  it('sends no `account` in the portfolio view — the route\'s primary, as before', () => {
    const body = manualOrderBody({ order: { ...order, lots: '', tp: '' }, destination: padDestination({ viewedAccountId: 'all', broker }) })
    expect(body).toEqual({ symbol: 'EURUSD', side: 'BUY', lots: undefined, sl: 1.09, tp: undefined })
    expect('account' in body).toBe(false)
  })
})

describe('the check asks exactly what the order would send', () => {
  it('manual: same fields, same account', () => {
    const dest = padDestination({ viewedAccountId: 46130058, broker })
    expect(manualCheckPath({ order, destination: dest })).toBe('/state/preorder?account=46130058&symbol=EURUSD&side=BUY&lots=0.2&sl=1.09&tp=1.135')
    expect(manualCheckPath({ order: { ...order, lots: '', tp: '' }, destination: padDestination({ viewedAccountId: 'all', broker }) }))
      .toBe('/state/preorder?symbol=EURUSD&side=BUY&sl=1.09')
  })
  it('scan: the row\'s scan id and its own account', () => {
    expect(scanCheckPath({ scanId: 77, accountId: '101' })).toBe('/state/preorder?scanId=77&account=101')
    expect(scanCheckPath({ scanId: 77, accountId: 'all' })).toBe('/state/preorder?scanId=77')
  })
  it('a check speaks for its inputs only: any changed field changes the key', () => {
    const dest = padDestination({ viewedAccountId: 46130058, broker })
    const k = checkKey({ order, destination: dest })
    for (const change of [{ sl: '1.08' }, { tp: '1.14' }, { lots: '0.3' }, { side: 'SELL' }, { symbol: 'GBPUSD' }]) {
      expect(checkKey({ order: { ...order, ...change }, destination: dest })).not.toBe(k)
    }
    expect(checkKey({ order, destination: padDestination({ viewedAccountId: 'all', broker }) })).not.toBe(k)
    expect(padInputs(order).symbol).toBe('EURUSD')
  })
})

describe('createCheckRunner — one request per tap, never polled', () => {
  it('issues exactly one GET per run, and none while one is in flight', async () => {
    const calls = []
    let release
    const get = (p) => { calls.push(p); return new Promise(r => { release = r }) }
    const runner = createCheckRunner(get)
    const a = runner.run('/state/preorder?scanId=1')
    const b = runner.run('/state/preorder?scanId=1') // a double tap
    await Promise.resolve()
    expect(calls).toEqual(['/state/preorder?scanId=1'])
    expect(runner.busy()).toBe(true)
    release({ ok: true })
    expect(await a).toEqual({ ok: true })
    expect(b).toBe(a)
    expect(runner.busy()).toBe(false)
    const c = runner.run('/state/preorder?scanId=1') // a second, later tap
    await Promise.resolve()
    expect(calls.length).toBe(2)
    release({ ok: true }); await c
  })
  it('a failed request is an answer, not a silent nothing', async () => {
    const runner = createCheckRunner(async () => { throw new Error('agent offline') })
    expect(await runner.run('/x')).toEqual({ ok: false, error: 'agent offline' })
  })
  it('creating a runner sends nothing: no request until it is run', () => {
    let n = 0
    createCheckRunner(() => { n++; return Promise.resolve({}) })
    expect(n).toBe(0)
  })
  it('the page wires Check to a tap only — no interval, timer or effect runs a check (comment-stripped scan, last resort: the page has no DOM test harness)', () => {
    const strip = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const src = strip(readFileSync(new URL('../pages/Trade.jsx', import.meta.url), 'utf8'))
    // Every call site of the two check runners is a click handler.
    expect(src).toMatch(/onClick=\{\(\) => runCheck\(sc\)\}/)
    expect(src).toMatch(/onClick=\{runPadCheck\}/)
    expect((src.match(/runCheck\(/g) || []).length).toBe(1)
    expect((src.match(/runPadCheck\b/g) || []).length).toBe(2) // its definition and the button
    for (const m of src.matchAll(/(setInterval|setTimeout|useEffect)\(([\s\S]{0,400})/g)) {
      expect(m[2]).not.toMatch(/runCheck|runPadCheck|preorder|\.run\(/)
    }
  })
})

const RESULT = {
  ok: true, approved: false,
  firstBlock: { stage: 'risk_gate', reason: 'bad_rr 1.00<3', label: 'Reward:risk 1.00 below the 3 floor' },
  gate: { approved: false, vetoReason: 'bad_rr 1.00<3' },
  numbers: {
    volume: 0.14, volumeBasis: 'risk_budget_before_veto', moneyAtRisk: 140, currency: 'USD', dailyStopLeft: 400, dailyStopUncapped: false,
    shareOfStopLeft: 35, marginShare: { requiredUsd: 154, headroomUsd: 5000, pctOfHeadroom: 3.1, maxPctOfHeadroom: 33.3 },
    openPositions: 2, maxPositions: 5, rr: 1, rrFloor: 3,
  },
  strategy: { key: 'ema_pullback', last20: { n: 20, winRatePct: 75, profitFactor: 6 }, allowedBy: 'record' },
  expectedR: { value: null, reason: 'not computed' },
  notChecked: ['market hours'],
}

describe('reading a check back', () => {
  it('names the first block in words, or Ready', () => {
    expect(verdictLine(RESULT)).toBe('Blocked — Reward:risk 1.00 below the 3 floor')
    expect(verdictLine({ ...RESULT, approved: true, firstBlock: null })).toBe('Ready — the risk gate would approve this order now')
    expect(verdictLine({ ok: false, cannotCheck: 'cannot check: cTrader credentials not configured' })).toBe('Cannot check: cTrader credentials not configured')
    expect(verdictLine({ ok: false, error: 'agent offline' })).toBe('Check failed — agent offline')
  })
  it('lists size, money at risk with currency, stop share, margin share, open/cap, the last 20 and allowedBy', () => {
    const lines = Object.fromEntries(preorderLines(RESULT))
    expect(lines.Size).toBe('0.14 lots (sized before the veto)')
    expect(lines['Money at risk']).toBe('USD 140')
    expect(lines["Share of today's stop left"]).toBe('35% of USD 400 left')
    expect(lines['Margin share']).toBe('3.1% of USD 5,000 headroom (max 33.3%)')
    expect(lines['Open / cap']).toBe('2 / 5')
    expect(lines['Last 20 (ema_pullback)']).toBe('20 closes · win 75% · PF 6')
    expect(lines['Allowed by']).toBe('evidence (its record)')
  })
  it('checkSummary feeds the confirm only from a real check', () => {
    expect(checkSummary(RESULT)).toEqual({ volume: 0.14, moneyAtRisk: 140, currency: 'USD', approved: false })
    expect(checkSummary({ ok: false, cannotCheck: 'x' })).toBe(null)
    expect(checkSummary(null)).toBe(null)
  })
})
