// node --test agent/lib/fill-anchor.test.js
//
// The bracket a trade actually has (owner "do both", 03-09-2026). The two
// production trades that exposed the defect are the fixtures: NATGAS rsi2
// (proposal 2.893, fill 2.907) and AUDUSD rsi2 (0.71275 → 0.71332). What is
// pinned: the re-anchored bracket keeps the planned distances from the fill
// so the trade is the R:R the gate admitted; the drift gate refuses a fill
// that would not be; and loop.js stores the anchored bracket, not the
// proposal's, and runs the gate before the order goes out.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { anchorBracketToFill, entryDrift, entryDriftVeto, fillFromReconcile, confirmFill } from './fill-anchor.js'
import { DEFAULT_RISK_CONFIG } from '../services/risk.js'

const r = (x, d = 6) => Math.round(x * 10 ** d) / 10 ** d

test('NATGAS rsi2 (02-09-2026): the planned 1.2R bracket is kept from the fill, not from the proposal', () => {
  // Proposal 2.893, sl 2.87125 (0.02175), tp1 2.9191 (0.0261 = 1.2R); filled 2.907.
  const a = anchorBracketToFill({ side: 'BUY', proposalEntry: 2.893, fill: 2.907, sl: 2.87125, tp1: 2.9191, tp2: 2.94085 })
  assert.equal(a.anchored, true)
  assert.equal(r(a.slDistance), 0.02175)
  assert.equal(r(a.tpDistance), 0.0261)
  assert.equal(r(a.sl), r(2.907 - 0.02175))     // 2.88525 — the broker held 2.885 (snapped)
  assert.equal(r(a.tp1), r(2.907 + 0.0261))     // 2.9331, not the proposal's 2.9191
  assert.equal(r(a.tp2), r(2.907 + 0.04785))
  assert.equal(r(a.shift, 3), 0.014, 'adverse-positive: the fill was 0.014 above the plan')
  // The trade that exists is 1.2R again.
  assert.equal(r((a.tp1 - 2.907) / (2.907 - a.sl), 3), 1.2)
})

test('AUDUSD rsi2 and a short: direction is honoured, favourable fills shift the other way', () => {
  const a = anchorBracketToFill({ side: 'BUY', proposalEntry: 0.71275, fill: 0.71332, sl: 0.7105846428571428, tp1: 0.7153484285714286 })
  assert.equal(r((a.tp1 - 0.71332) / (0.71332 - a.sl), 2), 1.2)
  const s = anchorBracketToFill({ side: 'SELL', proposalEntry: 100, fill: 99.5, sl: 101, tp1: 98.8 })
  assert.equal(s.sl, 100.5)
  assert.equal(r(s.tp1), 98.3)
  assert.equal(s.shift, 0.5, 'a SELL filled lower is an adverse fill')
  const good = anchorBracketToFill({ side: 'long', proposalEntry: 100, fill: 99.8, sl: 99, tp1: 101.2 })
  assert.equal(r(good.shift), -0.2)
  assert.equal(r(good.tp1), 101)
})

test('no confirmed fill, or no entry to measure from → the proposal bracket stands, unanchored', () => {
  const a = anchorBracketToFill({ side: 'BUY', proposalEntry: 100, fill: null, sl: 99, tp1: 101.2 })
  assert.deepEqual([a.anchored, a.sl, a.tp1, a.shift], [false, 99, 101.2, null])
  const b = anchorBracketToFill({ side: 'BUY', proposalEntry: null, fill: 100.1, sl: 99, tp1: 101.2 })
  assert.equal(b.anchored, false)
  const c = anchorBracketToFill({ side: 'BUY', proposalEntry: 100, fill: 100.1, sl: null, tp1: null })
  assert.deepEqual([c.sl, c.tp1, c.anchored], [null, null, true])
})

test('entry drift: a BUY measures against the ask, a SELL against the bid, adverse-positive, as a fraction of the stop', () => {
  const buy = entryDrift({ side: 'BUY', proposalEntry: 2.893, quote: { bid: 2.906, ask: 2.907 }, slDistance: 0.02175 })
  assert.equal(r(buy.drift, 3), 0.014)
  assert.equal(r(buy.fracOfSL, 2), 0.64)
  assert.equal(buy.price, 2.907)
  const sell = entryDrift({ side: 'SELL', proposalEntry: 100, quote: { bid: 99.7, ask: 99.72 }, slDistance: 1 })
  assert.equal(r(sell.drift, 2), 0.3)
  const fav = entryDrift({ side: 'BUY', proposalEntry: 100, quote: { bid: 99.5, ask: 99.52 }, slDistance: 1 })
  assert.ok(fav.drift < 0)
  assert.deepEqual(entryDrift({ side: 'BUY', proposalEntry: 100, quote: null, slDistance: 1 }), { drift: null, fracOfSL: null, price: null })
})

test('the drift veto fires past maxEntryDriftFracOfSL, never on favourable drift, and 0 disables it', () => {
  const cfg = { maxEntryDriftFracOfSL: 0.25 }
  assert.equal(DEFAULT_RISK_CONFIG.maxEntryDriftFracOfSL, 0.25, 'the default is the fraction the owner approved')
  const natgas = entryDrift({ side: 'BUY', proposalEntry: 2.893, quote: { bid: 2.906, ask: 2.907 }, slDistance: 0.02175 })
  const reason = entryDriftVeto(cfg, natgas, { symbolDigits: 3 })
  assert.match(reason, /^entry_drift: live 2\.907 is 0\.014 \(64% of SL distance\) past the proposal entry — limit 25%$/)
  // AUDUSD's 0.26R would also have been refused; 0.20R passes.
  assert.ok(entryDriftVeto(cfg, entryDrift({ side: 'BUY', proposalEntry: 0.71275, quote: { bid: 0.7133, ask: 0.71332 }, slDistance: 0.0021653571428571494 })))
  assert.equal(entryDriftVeto(cfg, { drift: 0.2, fracOfSL: 0.2, price: 100.2 }), null)
  assert.equal(entryDriftVeto(cfg, { drift: 0.25, fracOfSL: 0.25, price: 100.25 }), null, 'at the limit passes; past it vetoes')
  assert.equal(entryDriftVeto(cfg, { drift: -0.5, fracOfSL: -0.5, price: 99.5 }), null, 'favourable drift never vetoes')
  assert.equal(entryDriftVeto(cfg, { drift: null, fracOfSL: null, price: null }), null, 'nothing measured → fail open')
  assert.equal(entryDriftVeto({ maxEntryDriftFracOfSL: 0 }, natgas), null, '0 disables')
  assert.equal(entryDriftVeto({}, natgas), null)
})

test('wiring pins: loop.js stores the anchored bracket and runs the drift gate before the order (comments stripped)', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  // The ledger writes read the anchored bracket, not the proposal's.
  assert.ok(src.includes("anchorBracketToFill({ side, proposalEntry: synth.entry, fill: executionPrice, sl: synth.sl, tp1: synth.tp1, tp2: synth.tp2 })"))
  assert.ok(src.includes('const slP = anchored.sl ?? null'))
  assert.ok(src.includes('const tpP = anchored.tp1 ?? null'))
  assert.ok(src.includes('entryP, slP, tpP, volLots,'), 'trades row takes the anchored stop and target')
  assert.ok(/entryP,\s*slP,\s*tpP,\s*synth\.synthesis \|\| '',/.test(src), 'monitored_positions takes the anchored stop and target')
  assert.ok(!/slP, synth\.tp1 \?\? null, volLots/.test(src), 'the proposal target is no longer written to the trade row')
  // The drift gate: quote fetched when either gate is on, veto persisted as a post-approval refusal, order never placed.
  assert.ok(src.includes("const driftGateOn = slDistance && Number(riskCfg.maxEntryDriftFracOfSL) > 0"))
  assert.ok(src.includes('if (slDistance && (riskCfg.maxSpreadFracOfSL > 0 || driftGateOn))'))
  const gate = src.slice(src.indexOf('if (driftGateOn) {'), src.indexOf('Spread/drift gate skipped'))
  assert.ok(gate.includes("entryDrift({ side, proposalEntry: synth.entry, quote: q, slDistance })"))
  assert.ok(gate.includes('persistPostApprovalVeto(db, proposal, reason)'))
  assert.ok(gate.includes('return null'))
  // The drift gate sits BEFORE the order is placed.
  assert.ok(src.indexOf('if (driftGateOn) {') < src.indexOf('execPlaceOrder('), 'gate precedes the broker call')
  // 04-09-2026: with no price in the order answer, the fill is confirmed from
  // the position read BEFORE the anchoring and the ledger writes.
  assert.ok(src.includes('let executionPrice = exec?.deal?.executionPrice || exec?.position?.price || null'))
  const confirm = src.indexOf('if (executionPrice == null && positionId) {')
  assert.ok(confirm > 0, 'a missing price triggers the position read')
  const block = src.slice(confirm, confirm + 700)
  // LIVE broker read (wsReconcile), never the sidecar's cached snapshot: the
  // cached read missed a one-second-old position three times out of three
  // (JPM.US, 04-09-2026 18:56 UTC) and the ledger kept the proposal entry.
  assert.ok(block.includes('confirmFill(() => wsReconcile(host, clientId, clientSecret, accessToken, accountId), positionId)'))
  assert.ok(!block.includes('confirmFill(() => execReconcile('), 'the sidecar snapshot is not a fill confirmation')
  assert.ok(block.includes('executionPrice = confirmed'))
  assert.ok(confirm < src.indexOf('const entryP = executionPrice ?? synth.entry ?? null'), 'the confirmed fill is what entryP reads')
  assert.ok(confirm < src.indexOf('anchorBracketToFill({ side, proposalEntry: synth.entry, fill: executionPrice'), 'the confirmed fill is what the anchor reads')
})

// ---------------------------------------------------------------------------
// 04-09-2026: the sidecar answers a market order with ORDER_ACCEPTED (no
// deal), so executionPrice was null on every cpp-path fill and the anchoring
// never fired. 2020.HK: proposal 75.79, fill 76.21, manager "breakeven" at
// 76.03 — under the real fill.
// ---------------------------------------------------------------------------

test('fillFromReconcile: the open price of THIS position, ids matched by integer spelling, openPrice as the fallback field', () => {
  const rec = { position: [
    { positionId: 240235374, price: 76.21, tradeData: { positionId: 240235374, openPrice: 76.21 } },
    { positionId: '240088269.0', tradeData: { openPrice: 77710.4 } },
  ] }
  assert.equal(fillFromReconcile(rec, '240235374'), 76.21)
  assert.equal(fillFromReconcile(rec, 240235374.0), 76.21)
  assert.equal(fillFromReconcile(rec, 240088269), 77710.4, 'a float-formatted id and the tradeData.openPrice fallback')
  assert.equal(fillFromReconcile(rec, 1), null, 'a position the broker does not hold is null, never a guess')
  assert.equal(fillFromReconcile(rec, null), null)
  assert.equal(fillFromReconcile(null, 240235374), null)
  assert.equal(fillFromReconcile({ position: [{ positionId: 5, price: 0 }] }, 5), null, 'a zero price is not a fill')
})

test('confirmFill: retries the read until the position lands, then returns its price; a read that keeps failing or never finds it returns null', async () => {
  const reads = []
  let n = 0
  const read = async () => { n++; reads.push(n); if (n < 3) return { position: [] }; return { position: [{ positionId: 9, price: 1.2345 }] } }
  const slept = []
  const px = await confirmFill(read, 9, { attempts: 3, delayMs: 50, sleep: async (ms) => { slept.push(ms) } })
  assert.equal(px, 1.2345)
  assert.deepEqual(reads, [1, 2, 3])
  assert.deepEqual(slept, [50, 50], 'sleeps only between attempts')
  const none = await confirmFill(async () => { throw new Error('502') }, 9, { attempts: 2, delayMs: 1, sleep: async () => {} })
  assert.equal(none, null, 'a failing read is a null, never a throw')
  const absent = await confirmFill(async () => ({ position: [{ positionId: 8, price: 3 }] }), 9, { attempts: 2, delayMs: 1, sleep: async () => {} })
  assert.equal(absent, null)
  assert.equal(await confirmFill(async () => ({ position: [] }), null, { attempts: 1 }), null, 'no position id → nothing to confirm')
})
