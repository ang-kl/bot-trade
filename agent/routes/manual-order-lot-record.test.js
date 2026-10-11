// node --test agent/routes/manual-order-lot-record.test.js
//
// Claude · № 13,172 11-Oct (ordered № 13,171 "resend the orders";
// claude-builder). POST /actions/manual-order records the broker's lot size
// and minimum BEFORE its gate, so the gate sizes in broker units and floors
// at the broker's own minimum.
//
// THE MEASUREMENT THIS EXISTS FOR (demo 47790949, 11-10-2026 08:10Z, the
// crypto live test's resend): DOTUSD, AVAXUSD, UNIUSD and XLMUSD were
// approved at 0.01 lots and refused by the route at the broker's 0.1-lot
// minimum; BCHUSD was refused `insufficient_equity` with one lot priced at
// $4,049,170 — the contract table's 100,000-unit FX default on a symbol the
// registry had never seen. XRPUSD went through in the first round only
// because its record already existed. The route had the broker's answer the
// whole time: it fetched it AFTER the gate, to send the order.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { evaluateTrade } from '../services/risk.js'
import { rememberVolumeMeta } from '../lib/lot-size-registry.js'

const ACCT = '47790949'

function fresh() {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, '1', 0, 1, 'active')`).run(ACCT)
  setState(db, `acct:${ACCT}:account_balance_usd`, '42854.57')
  return db
}

// The pad's proposal with no lots given: the route caps at 0.01 and the gate
// lifts that to the broker minimum it has on record (risk.js floorLots).
const pad = (symbol, entry, sl, tp1) => ({
  symbol, side: 'BUY', entry, sl, tp1, requestedVolume: 0.01, requestedVolumeDefault: true, // nothing typed: the route's default (№ 13,175)
  strategy: 'manual_order', direction_reason: 'manual:operator_chose_long', conviction: null, source: 'manual', accountId: ACCT,
})

test('DOTUSD: with no broker record the gate approves 0.01 lots (the route then refuses at the broker 0.1 minimum); with the record it floors at 0.1', () => {
  const db = fresh()
  const before = evaluateTrade(db, pad('DOTUSD', 1.2, 1.05, 1.65))
  assert.equal(before.approved, true, `veto: ${before.veto_reason}`)
  assert.equal(before.checks.units_per_lot.source, 'table')
  assert.equal(before.adjusted_volume, 0.01, 'the global assumed minimum — below what the broker accepts')
  // the broker's record: 1 lot = 100 DOT (lotSize 10,000 cents), smallest order 0.1 lot
  rememberVolumeMeta(db, 'DOTUSD', { lotSize: 10_000, minVolume: 1_000, stepVolume: 1_000 })
  const after = evaluateTrade(db, pad('DOTUSD', 1.2, 1.05, 1.65))
  assert.equal(after.approved, true, `veto: ${after.veto_reason}`)
  assert.equal(after.checks.units_per_lot.source, 'broker')
  assert.equal(after.checks.broker_min_lots, 0.1)
  assert.equal(after.adjusted_volume, 0.1, 'floored at the broker minimum, as XRPUSD was in the first round')
})

test('BCHUSD: with no broker record one lot is priced as 100,000 units and the budget buys nothing; with the record the order sizes', () => {
  const db = fresh()
  const before = evaluateTrade(db, pad('BCHUSD', 405, 364.5, 526.5))
  assert.equal(before.approved, false)
  assert.match(before.veto_reason, /^insufficient_equity min_lot=0\.01 computed=0 /)
  assert.match(before.veto_reason, /usd_per_lot=\$4050000\.00/, 'the contract table priced one lot at 100,000 × the $40.50 stop')
  rememberVolumeMeta(db, 'BCHUSD', { lotSize: 100, minVolume: 1, stepVolume: 1 }) // 1 lot = 1 BCH, min 0.01 lot
  const after = evaluateTrade(db, pad('BCHUSD', 405, 364.5, 526.5))
  assert.equal(after.approved, true, `veto: ${after.veto_reason}`)
  assert.equal(after.checks.units_per_lot.source, 'broker')
  assert.equal(after.adjusted_volume, 0.01)
})

// The route's ORDER of operations is what the fix is; the behaviour above
// already held once the record existed. Pin the sequence on the
// comment-stripped source (failure mode #2 of CLAUDE.md: a test can pass by
// matching its own comment).
test('the manual-order route fetches and records the broker lot record before the gate runs', () => {
  const src = readFileSync(new URL('./actions.js', import.meta.url), 'utf8')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
  const start = src.indexOf("router.post('/manual-order'")
  assert.ok(start > 0)
  const handler = src.slice(start, src.indexOf('router.post(', start + 10))
  const fetched = handler.indexOf('await getVolumeMeta(')
  const recorded = handler.indexOf('rememberVolumeMeta(db, symbol, { ...volMeta, accountId: creds.accountId }, { shared: false })')
  const gated = handler.indexOf('evaluateTrade(db, proposal')
  assert.ok(fetched > 0 && recorded > 0 && gated > 0, { fetched, recorded, gated })
  assert.ok(fetched < recorded && recorded < gated, `fetch ${fetched} → record ${recorded} → gate ${gated}`)
  // Codex P2 on #1318: the record is stamped with the account whose broker answer it is

  assert.equal(handler.split('await getVolumeMeta(').length - 1, 1, 'one fetch, reused for the order below')
  // Codex P1 on #1318: a TYPED lots below the broker minimum is refused
  // between the record and the gate, so the gate's floor never lifts it
  const refused = handler.indexOf('explicitLots < brokerMinLotsLive')
  assert.ok(recorded < refused && refused < gated, `record ${recorded} → explicit-lots refusal ${refused} → gate ${gated}`)
})

// Codex P1 on #1318 (Claude · № 13,175, ordered № 13,174): the gate for one
// account never sizes on another account's lot record.
test('the gate sizes each account on its own lot record, not on the last account that wrote the symbol', () => {
  const db = fresh()
  const OTHER = '43097342'
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, '2', 0, 1, 'active')`).run(OTHER)
  setState(db, `acct:${OTHER}:account_balance_usd`, '42854.57')
  rememberVolumeMeta(db, 'DOTUSD', { lotSize: 10_000, minVolume: 1_000, stepVolume: 1_000, accountId: ACCT })   // 100 DOT a lot
  rememberVolumeMeta(db, 'DOTUSD', { lotSize: 100, minVolume: 1, stepVolume: 1, accountId: OTHER })            // 1 DOT a lot, written last
  const mine = evaluateTrade(db, pad('DOTUSD', 1.2, 1.05, 1.65))
  assert.equal(mine.checks.units_per_lot.value, 100, 'this account\'s own 100 units a lot, not the 1 the other account wrote last')
  assert.equal(mine.checks.broker_min_lots, 0.1)
  const theirs = evaluateTrade(db, { ...pad('DOTUSD', 1.2, 1.05, 1.65), accountId: OTHER })
  assert.equal(theirs.checks.units_per_lot.value, 1)
  assert.equal(theirs.checks.broker_min_lots, 0.01)
})

// Codex P2 on #1318, round 7: the gate for an account with no record of its
// own never sizes against another account's higher minimum.
test('the gate does not refuse an account on another account\'s higher minimum', () => {
  const db = fresh()
  // B (written last, the only record): 100 DOT a lot, min 1 lot
  rememberVolumeMeta(db, 'DOTUSD', { lotSize: 10_000, minVolume: 10_000, stepVolume: 1_000, accountId: '43097342' })
  const r = evaluateTrade(db, pad('DOTUSD', 1.2, 1.05, 1.65))
  // round 14: with only another account's record on file this account's lot
  // is unknown — refused by name, never on that account's minimum or the table
  assert.equal(r.approved, false)
  assert.match(r.veto_reason, /^lot_record_unknown: DOTUSD — only another account's broker lot is on record for account 47790949/)
  assert.equal(r.checks.broker_min_lots, undefined, 'no minimum claimed for this account')
  // once this account's own record is on file (the pre-gate fetch), it sizes
  rememberVolumeMeta(db, 'DOTUSD', { lotSize: 10_000, minVolume: 1_000, stepVolume: 1_000, accountId: ACCT }, { shared: false })
  const own = evaluateTrade(db, pad('DOTUSD', 1.2, 1.05, 1.65))
  assert.equal(own.approved, true, `veto: ${own.veto_reason}`)
  assert.equal(own.checks.broker_min_lots, 0.1, 'its own minimum, not the other account\'s 1 lot')
})

// The post-gate reconciliation must stay wired where the broker's answer is
// fetched after the gate (CLAUDE.md failure mode #4: a repair nothing calls).
test('every path that fetches the lot record after the gate reconciles it and refuses on a mismatch', () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  const read = (rel) => strip(readFileSync(new URL(rel, import.meta.url), 'utf8'))
  const loop = read('../loop.js')
  assert.match(loop, /lotMismatch = reconcileLotRecord\(db, symbol, accountId, meta, riskResult\.checks\)/)
  assert.match(loop, /if \(lotMismatch\) \{\s*persistPostApprovalVeto\(db, proposal, lotMismatch\)[\s\S]{0,80}return null/)
  const pending = read('../services/pending-orders.js')
  assert.match(pending, /const lotMismatch = reconcileLotRecord\(db, symbol, creds\.accountId, meta, riskResult\.checks, \{ shared: false \}\)\s*if \(lotMismatch\) \{\s*risk\.persistPostApprovalVeto\(db, proposal, lotMismatch\)/)
  const closed = read('../services/closed-market-limits.js')
  assert.match(closed, /const lotMismatch = reconcileLotRecord\(db, symbol, creds\.accountId, meta, riskResult\.checks, \{ shared: false \}\)\s*if \(lotMismatch\) \{\s*risk\.persistPostApprovalVeto\(db, proposal, lotMismatch\)/)
  // round 8: the three paths fetch the account's own record before the gate
  assert.match(loop, /await ensureOwnLotRecord\(db, symbol, accountId, async \(\) => \{[\s\S]{0,600}\}\)\s*\} catch \{\s*\}\s*const riskCfg = loadRiskConfig\(db, accountId\)\s*const riskResult = evaluateTrade\(db, proposal, riskCfg\)/)
  assert.match(pending, /await ensureOwnLotRecord\(db, symbol, creds\.accountId, \(\) => sizing\.getVolumeMeta\([^)]*\)\)\s*const riskResult = risk\.evaluateTrade\(db, proposal, riskCfg\)/)
  assert.match(closed, /await ensureOwnLotRecord\(db, symbol, creds\.accountId, \(\) => sizing\.getVolumeMeta\([^)]*\)\)\s*const riskResult = risk\.evaluateTrade\(db, proposal, riskCfg\)/)
  // round 9: /actions/execute-trade fetches and records before its gate; the
  // momentum limit entry records the lot its evidence read before its gate;
  // the reconciler converts with the position account's own record
  const actions = read('./actions.js')
  assert.match(actions, /const volMeta = await getVolumeMeta\(metaHost, clientId, clientSecret, accessToken, accountId, symbolId\)\s*rememberVolumeMeta\(db, analysis\.symbol\.toUpperCase\(\), \{ \.\.\.volMeta, accountId \}, \{ shared: false \}\)\s*const riskResult = evaluateTrade\(db, proposal, loadRiskConfig\(db, accountId\)\)/)
  const momentum = read('../services/momentum-limit-entry.js')
  assert.match(momentum, /rememberVolumeMeta\(db, symbol, \{ \.\.\.ev0\.symbolMeta, accountId \}, \{ shared: false \}\)[\s\S]{0,1000}const preliminary = risk\.evaluateTrade\(db, proposal, config\)/)
  const reconciler = read('../services/reconciler.js')
  assert.match(reconciler, /brokerVolumeToLots\(bp, row\.symbol, db, acct\)/)
  assert.match(reconciler, /brokerVolumeToLots\(bp, symbolName, db, acct\)/)
  // and the gate reads the proposal account's own record
  const riskSrc = read('../services/risk.js')
  assert.match(riskSrc, /unitsPerLotFromRegistry\(db, proposal\.symbol, acct\)/)
  assert.match(riskSrc, /brokerMinLots\(db, proposal\.symbol, acct\)/)
})

// Codex P1 on #1318, round 14 (Claude · № 13,175): a resting order whose lot
// is unknown for its account (only another account's record on file) is
// counted UNPRICED by the margin pool, never priced on the contract table.
test('margin: a resting order with only another account\'s lot on record is unpriced, not priced on the table', async () => {
  const { portfolioMarginStatus, DEFAULT_RISK_CONFIG } = await import('../services/risk.js')
  const db = fresh()
  db.prepare(`INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, placed_at, expires_at, status, note, account_id)
              VALUES ('BCHUSD', '1h', '9001', 1, 405, 364.5, 526.5, 0.01, '2026-10-11T00:00:00Z', '2026-10-12T00:00:00Z', 'working', 'test', ?)`).run(ACCT)
  rememberVolumeMeta(db, 'BCHUSD', { lotSize: 100, accountId: '43097342' }) // another account's 1 BCH a lot, shared slot
  const unknown = portfolioMarginStatus(db, DEFAULT_RISK_CONFIG, { accountId: ACCT, balance: 42854.57, leverage: 25 })
  assert.deepEqual(unknown.restingUnpriced, ['9001'], 'unpriced, so it is not free capacity and not a 100,000-unit guess')
  assert.equal(unknown.headroom, 0)
  // with this account's own record the order is priced
  rememberVolumeMeta(db, 'BCHUSD', { lotSize: 100, accountId: ACCT }, { shared: false })
  const own = portfolioMarginStatus(db, DEFAULT_RISK_CONFIG, { accountId: ACCT, balance: 42854.57, leverage: 25 })
  assert.deepEqual(own.restingUnpriced, [])
  assert.ok(own.restingMargin > 0 && own.restingMargin < 10, `0.01 BCH at 405 / 25 ≈ $0.16, got ${own.restingMargin}`)
})
