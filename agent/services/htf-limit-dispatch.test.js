// node --test agent/services/htf-limit-dispatch.test.js
//
// High-timeframe signals rest as a LIMIT at the approved entry (owner-approved
// 03-09-2026). What is pinned: the closed-market limit path accepts the
// 'htf' reason with an expiry at the bar's close and says so on the risk
// event and the row; the risk default names the threshold; and loop.js
// branches ≥4h signals into that path BEFORE the market order, with
// sub-threshold signals untouched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { placeClosedMarketLimit } from './closed-market-limits.js'
import { DEFAULT_RISK_CONFIG } from './risk.js'
import { nextBarCloseMs, tfMs } from '../lib/timeframes.js'
import { tradePrice } from './alert-format.js'

const CREDS = { host: 'demo', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '42' }
// NAS100 1w short, the case that exposed it: proposal 29455.2 / sl 30422.56 / tp1 27520.47
const SYNTH = { consensus_bias: 'short', entry: 29455.2, sl: 30422.564285714285, tp1: 27520.471428571433, strategy: 'vwap_trend', timeframe: '1w', overall_conviction: 9 }

function fakes() {
  const placed = [], events = []
  return {
    placed, events,
    risk: {
      loadRiskConfig: () => ({}),
      evaluateTrade: () => ({ approved: true, adjusted_volume: 0.5 }),
      persistRiskEvent: (_db, proposal, result) => { events.push({ proposal, result }); return 1 },
      persistPostApprovalVeto: () => {},
    },
    sizing: {
      getVolumeMeta: async () => ({ digits: 1, lotSize: 1, minVolume: 1 }),
      lotsToVolume: (lots) => ({ volume: Math.round(lots * 100), belowMin: false }),
      relativePoints: (d, dg) => Math.round(d * Math.pow(10, dg)),
    },
    exec: { placeOrder: async (_c, payload) => { placed.push(payload); return { order: { orderId: 7001 } } }, cancelOrder: async () => ({}) },
    now: Date.UTC(2026, 8, 2, 22, 19, 47),
  }
}

test('reason htf: rests at the approved entry, expires at the bar\'s close, and the record says which path placed it', async () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ NAS100: 11 }))
  const f = fakes()
  const notes = []
  const expiresAtMs = nextBarCloseMs('1w', f.now)
  const r = await placeClosedMarketLimit(db, CREDS, 'NAS100', SYNTH, { ...f, reason: 'htf', expiresAtMs, notify: (t) => notes.push(t) })
  assert.equal(r.placed, true)
  assert.equal(r.reason, 'htf')
  assert.equal(r.expiresAt, new Date(Date.UTC(2026, 8, 5)).toISOString(), 'Saturday 00:00 UTC — after the Friday session that closes the weekly bar')
  assert.equal(f.placed[0].orderType, 'LIMIT')
  assert.equal(f.placed[0].limitPrice, tradePrice(SYNTH.entry, 1), 'the approved entry, snapped the way every limit is')
  assert.equal(f.placed[0].expirationTimestamp, expiresAtMs)
  const row = db.prepare(`SELECT * FROM pending_orders WHERE symbol='NAS100'`).get()
  assert.equal(row.status, 'working')
  assert.equal(row.note, 'pending-closed', 'same row shape: the sweeps, adoption and bot-marker counts keep working')
  assert.equal(row.timeframe, '1w')
  assert.equal(row.expires_at, r.expiresAt)
  // The gate saw a proposal sourced htf_limit; the placement event carries the reason.
  assert.equal(f.events[0].proposal.source, 'htf_limit')
  const placedEv = f.events.find(e => e.result?.checks?.limit_reason)
  assert.equal(placedEv.result.checks.limit_reason, 'htf')
  assert.equal(placedEv.result.checks.htf_limit_placed, true)
  assert.equal(placedEv.result.checks.closed_market_limit_placed, undefined)
  assert.ok(notes[0].startsWith(`⏳ 1w LIMIT resting: NAS100 SELL @ ${tradePrice(SYNTH.entry, 1)}`), notes[0])
})

test('without the reason the closed-market behaviour is byte-for-byte what it was: default expiry, closed_market source and stamp', async () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ NAS100: 11 }))
  const f = fakes()
  const r = await placeClosedMarketLimit(db, CREDS, 'NAS100', SYNTH, f)
  assert.equal(r.reason, 'closed_market')
  assert.ok(Date.parse(r.expiresAt) > f.now)
  assert.equal(f.events[0].proposal.source, 'closed_market_limit')
  assert.equal(f.events.find(e => e.result?.checks?.limit_reason).result.checks.closed_market_limit_placed, true)
  // An expiry in the past is refused and the default stands — never a dead-on-arrival order.
  const g = fakes()
  const db2 = initDB(':memory:'); setState(db2, 'symbol_id_map', JSON.stringify({ NAS100: 11 }))
  const r2 = await placeClosedMarketLimit(db2, CREDS, 'NAS100', SYNTH, { ...g, reason: 'htf', expiresAtMs: g.now - 1 })
  assert.ok(Date.parse(r2.expiresAt) > g.now)
})

test('the threshold is a risk default of 4h; 1d and 1w qualify, 1h and 15m do not', () => {
  assert.equal(DEFAULT_RISK_CONFIG.limitDispatchMinTf, '4h')
  const min = tfMs(DEFAULT_RISK_CONFIG.limitDispatchMinTf)
  for (const tf of ['4h', '12h', '1d', '1w', '1mo']) assert.ok(tfMs(tf) >= min, `${tf} rests as a limit`)
  for (const tf of ['15m', '1h']) assert.ok(tfMs(tf) < min, `${tf} stays a market order`)
})

test('wiring pins: loop.js branches ≥threshold signals into the limit path before the market order, with the htf reason and the bar-close expiry (comments stripped)', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  const branch = src.indexOf("limitDispatchMinTf")
  assert.ok(branch > 0)
  const block = src.slice(branch, branch + 2500)
  assert.ok(block.includes("if (minMs > 0 && sigMs >= minMs) {"))
  assert.ok(block.includes("const expiresAtMs = nextBarCloseMs(synth.timeframe)"))
  assert.ok(block.includes("reason: 'htf', expiresAtMs,"))
  assert.ok(block.includes("placeClosedMarketLimit("))
  assert.ok(/return null\s*\}\s*\} catch/.test(block), 'a qualifying signal never falls through to the market order')
  // The branch sits after the market-hours gate and before the risk gate / market order.
  assert.ok(src.indexOf("mkt_closed_logged_${symbol}`, null)") < branch)
  assert.ok(branch < src.indexOf('const riskResult = evaluateTrade(db, proposal, riskCfg)'))
  assert.ok(branch < src.indexOf('execPlaceOrder('))
  // 'off' or '' disables: the branch reads the config, not a literal.
  assert.ok(block.includes("minTf !== 'off' ? tfMs(minTf) : 0"))
})
