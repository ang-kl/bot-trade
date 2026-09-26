// agent/services/tick-permits.test.js — P6b: the tick producer's permits
// through the reservation authority. The feeder lists ONLY acknowledged
// TICK_MOMENTUM demo accounts, issues one standing permit per carried
// symbol and side through the ledger (the P1b fence + one open intent per
// account/symbol/side), attaches the account's OWN risk figures, releases
// on a mode change or a readiness failure (TM-40), and the sidecar's ring
// settles a standing tick permit like a VPO one. Nothing here reads a
// balance that was not stamped for the account.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { initDB, setState, getState } from '../db.js'
import { upsertAccount, setAccountState } from './account-registry.js'
import { validateEngineStatus } from '../lib/entry-contracts.js'
import { engineStatusFor, requestEntryMode, requestAdmittedBases, acknowledgeEntryEpochs, writeEngineStatus, admitEntry, _resetRefusalDedupe, ENGINE_STATUS_KEY } from './entry-mode.js'
import { reconcileIntents, TICK_PRODUCER, reserveEntry, resolveIntent, redeemPermit, STANDING_PRODUCERS } from './entry-ledger.js'
import { profileHashFull, DEFAULT_PARAMS } from '../lib/tick-strategy.js'
import { permitSizing, tickEntryAccountsFor, runTickPermitFeeder, loadTickEntryConfig, PAUSE_CHECKS, WIRE_UNIT, PAUSED_KEY, openPositionsFor, heldWithPending, markTickRepush, takeTickRepush, peekTickRepush, tickRepushPending, _resetTickRepushForTests } from './tick-permits.js'
import { labelIntentId } from '../lib/trade-labels.js'
import { desiredGuardFor } from './exec-guard-sync.js'

const DEMO = '46979908', DEMO2 = '46130058', LIVE = '42993489'
const side = { isLive: false, name: 'cpp_exec_demo' }
const creds = { ready: true, host: 'demo.ctraderapi.com', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: DEMO }
const META = { lotSize: 10_000_000, minVolume: 100_000, maxVolume: 10_000_000_000, stepVolume: 100_000, digits: 5 }

function fresh() {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: DEMO, isLive: false })
  upsertAccount(db, { accountId: DEMO2, isLive: false })
  upsertAccount(db, { accountId: LIVE, isLive: true })
  db.prepare('UPDATE accounts SET enabled = 1').run()
  setState(db, 'tick_symbols_json', JSON.stringify(['EURUSD', 'XAUUSD']))
  return db
}
function switchOn(db, id) {
  writeEngineStatus(db, { ...engineStatusFor(db, id), profileHash: profileHashFull(DEFAULT_PARAMS), profileId: 'tick_momentum_breakout@v1', validationStage: 'SHADOW_PASSED', configRevision: engineStatusFor(db, id).configRevision + 1, updatedAt: new Date().toISOString() })
  const r = requestEntryMode(db, id, 'TICK_MOMENTUM', { readiness: () => ({ ready: true, blockedReasons: [] }) })
  assert.equal(r.ok, true)
  acknowledgeEntryEpochs(db, { [id]: r.status.modeEpoch })
  assert.equal(engineStatusFor(db, id).effectiveEntryMode, 'TICK_MOMENTUM')
  return engineStatusFor(db, id)
}
const ids = { EURUSD: 1, XAUUSD: 41 }
const resolveSymbolId = async (_db, _c, name) => ({ id: ids[name] ?? null, source: 'test' })
const readyAll = () => ({ ready: true, readiness: PAUSE_CHECKS.map(check => ({ check, ok: true })) })
const deps = (over = {}) => {
  const pushes = []
  return {
    pushes,
    opts: {
      creds, resolveSymbolId, readiness: readyAll, volumeMeta: async () => META,
      push: async (_c, body) => { pushes.push(body); return { ok: true } }, log: () => {}, ...over,
    },
  }
}

test('permitSizing: the permit carries the account\'s own R, the symbol\'s USD per lot per wire unit and the broker\'s lot geometry; every missing figure refuses with its reason', () => {
  const risk = { usdPerR: 123.456, source: 'own_balance_and_risk_config' }
  const cfg = { overshootFraction: 0.25, maxLots: null }
  const s = permitSizing({ risk, symbol: 'EURUSD', meta: META, cfg, perLot: 100_000 })
  assert.equal(s.ok, true)
  assert.equal(s.fields.usdRisk, 123.46)
  assert.equal(s.fields.usdPerLotPerUnit, WIRE_UNIT * 100_000) // $1 per lot per wire unit on a USD-quoted lot of 100k
  assert.equal(s.fields.volumePerLot, 10_000_000)
  assert.equal(s.fields.lotStep, 0.01); assert.equal(s.fields.minLots, 0.01); assert.equal(s.fields.maxLots, 1000)
  assert.equal(s.fields.overshootFraction, 0.25)
  assert.equal(s.fields.minStopFraction, 0.0015); assert.equal(s.fields.maxFireDelayMs, 5000)
  assert.equal(permitSizing({ risk, symbol: 'EURUSD', meta: META, cfg: { overshootFraction: 0.1, maxLots: 2 }, perLot: 100_000 }).fields.maxLots, 2, 'the owner\'s cap binds below the broker\'s')
  assert.match(permitSizing({ risk: { usdPerR: null, source: 'balance_not_read' }, symbol: 'EURUSD', meta: META, cfg }).reason, /^balance_not_read/)
  assert.match(permitSizing({ risk, symbol: 'EURUSD', meta: { lotSize: 0 }, cfg }).reason, /^no_lot_size/)
  assert.match(permitSizing({ risk, symbol: 'USDJPY', meta: META, cfg, perLot: 100_000 }).reason, /^no_usd_conversion/, 'a USD-base pair needs a price the caller did not give')
  const f = loadTickEntryConfig()
  assert.equal(f.overshootFraction, 0.25); assert.equal(f.maxLots, null); assert.equal(f.minStopFraction, 0.0015); assert.equal(f.maxFireDelayMs, 5000)
})

test('tickEntryAccountsFor: only enabled demo accounts whose EFFECTIVE mode is TICK_MOMENTUM and STABLE', () => {
  const db = fresh()
  assert.deepEqual(tickEntryAccountsFor(db, side), [])
  switchOn(db, DEMO)
  assert.deepEqual(tickEntryAccountsFor(db, side), [DEMO])
  assert.deepEqual(tickEntryAccountsFor(db, { isLive: true, name: 'cpp_exec' }), [])
  db.prepare('UPDATE accounts SET enabled = 0 WHERE account_id = ?').run(DEMO)
  assert.deepEqual(tickEntryAccountsFor(db, side), [])
})

test('the feeder issues one standing permit per symbol and side with the sizing figures, reuses them on the next pass, and never lists an account whose balance was not read', async () => {
  const db = fresh()
  switchOn(db, DEMO)
  const d = deps()
  // balance not stamped → refused per symbol, the account still listed as placing but holds no permit
  let r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r.pushed, true); assert.equal(r.permits, 0)
  assert.equal(r.refused.length, 2); assert.match(r.refused[0].reason, /^balance_not_read/)
  assert.deepEqual(d.pushes[0], { tickEntryAccounts: [Number(DEMO)], tickPermits: [], tickSlots: [{ accountId: Number(DEMO), slots: 5, firesSeen: 0, bootId: null }] }, 'C9: the push carries the slots left under the cap')
  setState(db, `acct:${DEMO}:account_balance_usd`, '10000')
  r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r.pushed, true); assert.equal(r.permits, 4, '2 symbols × BUY/SELL'); assert.deepEqual(r.refused, [])
  const body = d.pushes[1]
  assert.deepEqual(body.tickEntryAccounts, [Number(DEMO)])
  const p = body.tickPermits.find(x => x.symbolId === 41 && x.side === 'SELL')
  assert.ok(p, 'XAUUSD SELL permit present')
  assert.equal(p.accountId, Number(DEMO))
  assert.equal(p.permit.volume, null, 'sized on the sidecar at the signal\'s stop distance')
  assert.equal(p.permit.epoch, engineStatusFor(db, DEMO).modeEpoch)
  assert.equal(p.permit.accountId, Number(DEMO), 'numeric on the wire — the sidecar\'s asNumber does not coerce a string'); assert.equal(typeof p.permit.accountId, 'number')
  assert.equal(p.permit.side, 'SELL'); assert.equal(p.permit.symbolId, 41)
  assert.ok(p.permit.usdRisk > 0 && p.permit.usdPerLotPerUnit > 0 && p.permit.volumePerLot === 10_000_000 && p.permit.minLots === 0.01 && p.permit.overshootFraction === 0.25)
  assert.equal(p.permit.minStopFraction, 0.0015); assert.equal(p.permit.maxFireDelayMs, 5000)
  assert.ok(p.permit.expiresAtMs > Date.now() + 4 * 60_000, 'five-minute permits')
  const rows = db.prepare(`SELECT * FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED'`).all(TICK_PRODUCER)
  assert.equal(rows.length, 4)
  assert.ok(rows.every(x => x.basis === 'tick' && x.account_id === DEMO && x.volume == null && x.signal_ref.startsWith('tick:')))
  // second pass: reused, not re-issued
  r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ?`).get(TICK_PRODUCER).n, 4, 'the same four rows')
  assert.equal(d.pushes[2].tickPermits.length, 4)
  // a standing tick permit never blocks another producer on the same symbol/side, but blocks its own
  assert.equal(reserveEntry(db, { accountId: DEMO, producerId: 'route_manual_order', symbolId: 1, symbol: 'EURUSD', side: 'BUY', volume: 100_000 }).ok, true)
  assert.match(reserveEntry(db, { accountId: DEMO, producerId: TICK_PRODUCER, basis: 'tick', symbolId: 41, symbol: 'XAUUSD', side: 'BUY' }).reason, /^intent_open/)
  assert.deepEqual([...STANDING_PRODUCERS], ['vpo_cpp_direct', 'tick_momentum'])
})

test('PR-D (owner principle 8): under a fresh up-trend reading the feeder withholds the SELL permit (direction_against_trend), a down-trend withholds BUY, no or stale reading leaves both; a withheld side\'s standing row is released', async () => {
  const db = fresh()
  switchOn(db, DEMO)
  setState(db, `acct:${DEMO}:account_balance_usd`, '10000')
  const d = deps()
  let r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r.permits, 4, 'no reading: 2 symbols × BUY/SELL')
  // XAUUSD trending up → its SELL permit is withheld and its standing SELL row released with the reason
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('XAUUSD', 'trending', 'long', datetime('now'))`).run()
  r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r.permits, 3)
  const body = d.pushes.at(-1)
  assert.ok(body.tickPermits.some(p => p.symbolId === 41 && p.side === 'BUY'), 'XAUUSD BUY still permitted')
  assert.ok(!body.tickPermits.some(p => p.symbolId === 41 && p.side === 'SELL'), 'XAUUSD SELL permit absent')
  assert.ok(body.tickPermits.some(p => p.symbolId === 1 && p.side === 'SELL'), 'EURUSD (no reading) keeps both')
  const ref = r.refused.find(x => x.symbol === 'XAUUSD' && x.side === 'SELL')
  assert.ok(ref, JSON.stringify(r.refused)); assert.match(ref.reason, /^direction_against_trend: SELL withheld under a up-trend reading/)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RELEASED' AND error_code = 'tick_direction_against_trend'`).get(TICK_PRODUCER).n, 1, 'the standing SELL row went, with the reason')
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED' AND symbol = 'XAUUSD'`).get(TICK_PRODUCER).n, 1)
  // a newer down-trend flips it: BUY withheld, SELL back
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('XAUUSD', 'trending', 'short', datetime('now', '+1 second'))`).run()
  r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r.permits, 3)
  assert.ok(!d.pushes.at(-1).tickPermits.some(p => p.symbolId === 41 && p.side === 'BUY'))
  assert.ok(d.pushes.at(-1).tickPermits.some(p => p.symbolId === 41 && p.side === 'SELL'))
  // a stale reading is no reading: both sides again
  db.prepare(`DELETE FROM regimes`).run()
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('XAUUSD', 'trending', 'long', datetime('now', '-2 days'))`).run()
  r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r.permits, 4, 'a fossil reading withholds nothing')
})

test('TM-40: a failing recorder / reserve / continuity check pauses the account — permits released, the account left out of tickEntryAccounts — and a mode change releases them too', async () => {
  const db = fresh()
  switchOn(db, DEMO)
  setState(db, `acct:${DEMO}:account_balance_usd`, '10000')
  const d = deps()
  await runTickPermitFeeder(db, side, d.opts)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED'`).get(TICK_PRODUCER).n, 4)
  const logs = []
  const paused = { ...d.opts, log: (m) => logs.push(m), readiness: () => ({ ready: false, readiness: [{ check: 'recorder_recording', ok: true }, { check: 'feed_continuity', ok: false }, { check: 'disk_reserve_clear', ok: true }, { check: 'validation_stage', ok: false }] }) }
  const r = await runTickPermitFeeder(db, side, paused)
  assert.equal(r.paused.length, 1); assert.equal(r.paused[0].reason, 'entry_mode_readiness: feed_continuity')
  assert.equal(r.released, 4); assert.equal(r.permits, 0)
  assert.deepEqual(d.pushes.at(-1), { tickEntryAccounts: [], tickPermits: [], tickSlots: [] }, 'the sidecar stops placing for the paused account')
  assert.deepEqual(JSON.parse(getState(db, PAUSED_KEY)), { [DEMO]: 'entry_mode_readiness: feed_continuity' })
  assert.deepEqual(desiredGuardFor(db, side).tickEntryAccounts, [], 'the guard sync leaves the paused account out too — no oscillation between the two pushes')
  assert.deepEqual(tickEntryAccountsFor(db, side, { excludePaused: true }), [])
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RELEASED' AND error_code LIKE 'entry_mode_readiness%'`).get(TICK_PRODUCER).n, 4)
  assert.equal(logs.length, 1); assert.match(logs[0], /PAUSED — entry_mode_readiness: feed_continuity/)
  await runTickPermitFeeder(db, side, paused)
  assert.equal(logs.length, 1, 'logged once per reason, not per pass')
  // readiness clears → permits again; then STOPPED → released with the mode reason
  await runTickPermitFeeder(db, side, d.opts)
  assert.deepEqual(JSON.parse(getState(db, PAUSED_KEY)), {})
  assert.deepEqual(desiredGuardFor(db, side).tickEntryAccounts, [Number(DEMO)])
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED'`).get(TICK_PRODUCER).n, 4)
  // STOPPED: the mode change itself releases the old epoch's RESERVED rows
  // (plan §3 step 1); the feeder then lists nobody and the push clears the sidecar
  requestEntryMode(db, DEMO, 'STOPPED')
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED'`).get(TICK_PRODUCER).n, 0, 'released on the switch, not left to expire')
  const r2 = await runTickPermitFeeder(db, side, d.opts)
  assert.deepEqual(r2.accounts, []); assert.equal(r2.permits, 0)
  assert.deepEqual(d.pushes.at(-1), { tickEntryAccounts: [], tickPermits: [], tickSlots: [] })
  // a standing row that survived (a corrupt epoch write) is released by the feeder itself
  db.prepare(`UPDATE entry_intents SET state = 'RESERVED', error_code = NULL WHERE producer_id = ? AND symbol_id = 41`).run(TICK_PRODUCER)
  const revived = db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED'`).get(TICK_PRODUCER).n
  assert.ok(revived >= 2)
  const r3 = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r3.released, revived)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RELEASED' AND error_code = 'tick_mode_left'`).get(TICK_PRODUCER).n, revived)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED'`).get(TICK_PRODUCER).n, 0)
})

test('PR-B: a live account in effective TICK_MOMENTUM is listed on its OWN side (routing), on the same evidence bar as demo; no credentials → nothing pushed', async () => {
  const db = fresh()
  writeEngineStatus(db, { ...engineStatusFor(db, LIVE), profileHash: profileHashFull(DEFAULT_PARAMS), profileId: 'tick_momentum_breakout@v1', validationStage: 'SHADOW_PASSED', requestedEntryMode: 'TICK_MOMENTUM', effectiveEntryMode: 'TICK_MOMENTUM', transitionState: 'STABLE', configRevision: 1, modeEpoch: 1, fenceAckEpoch: 1, updatedAt: new Date().toISOString() })
  // RED if the old `is_live === 1 || environment === 'live'` strike returns.
  assert.deepEqual(tickEntryAccountsFor(db, { isLive: true, name: 'cpp_exec' }), [LIVE], 'the live side lists its own tick account')
  assert.deepEqual(tickEntryAccountsFor(db, { isLive: false, name: 'cpp_exec_demo' }), [], 'the demo side does not carry it (routing, not policy)')
  assert.deepEqual(tickEntryAccountsFor(db, { isLive: null }), [LIVE])
  const d = deps({ creds: { ready: false } })
  const r = await runTickPermitFeeder(db, { isLive: true, name: 'cpp_exec' }, d.opts)
  assert.equal(r.pushed, false); assert.equal(r.reason, 'no_creds'); assert.equal(d.pushes.length, 0)
})

test('settlement: the sidecar\'s ring names the intent on order_submit / order_result, and reconcileIntents settles the standing tick permit like a VPO one', async () => {
  const db = fresh()
  switchOn(db, DEMO)
  setState(db, `acct:${DEMO}:account_balance_usd`, '10000')
  const d = deps()
  await runTickPermitFeeder(db, side, d.opts)
  const intent = db.prepare(`SELECT id FROM entry_intents WHERE producer_id = ? AND symbol_id = 41 AND side = 'BUY'`).get(TICK_PRODUCER).id
  const ins = db.prepare(`INSERT INTO cpp_decisions (side, boot_id, seq, ts_ms, component, kind, account_id, symbol_id, code, detail) VALUES ('cpp_exec_demo', 'b1', ?, 1, 'engine', ?, ?, ?, ?, ?)`)
  ins.run(1, 'order_submit', DEMO, 41, '', `intent=${intent} label=tick:abc`)
  let r = reconcileIntents(db, { accountId: DEMO })
  assert.equal(db.prepare('SELECT state FROM entry_intents WHERE id = ?').get(intent).state, 'SENT')
  ins.run(2, 'order_result', DEMO, 41, 'ok', `intent=${intent} order=55 pos=77`)
  r = reconcileIntents(db, { accountId: DEMO })
  assert.ok(r.resolved.length >= 1)
  const row = db.prepare('SELECT state, broker_position_id, resolution_source FROM entry_intents WHERE id = ?').get(intent)
  assert.equal(row.state, 'FILLED'); assert.equal(String(row.broker_position_id), '77'); assert.equal(row.resolution_source, 'ring')
  // the next pass re-issues a fresh standing permit for that symbol/side (the filled one is no longer open)
  await runTickPermitFeeder(db, side, d.opts)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED' AND symbol_id = 41 AND side = 'BUY'`).get(TICK_PRODUCER).n, 1)
})

test('wiring pins: the heartbeat probe feeds tick permits after the shadow pull, and the route judges TICK_MOMENTUM on tickReadinessFor', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const hb = strip(readFileSync(new URL('./heartbeat.js', import.meta.url), 'utf8'))
  // C9: the call now also carries the probe's boot and the cycle's grants.
  assert.ok(hb.includes('await feedTickPermits(db, exec, side, nowMs, { bootId: r.bootId ?? null, grants: deps.tickGrants ?? null, requireBoot: true })'), 'the probe calls the feeder')
  assert.ok(hb.includes('runTickPermitFeeder(db, side, { creds, now: nowMs, bootId, grants })'), 'the feeder runs with the side\'s own credentials')
  const route = strip(readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8'))
  assert.ok(route.includes("readiness: tickReadinessFor"), 'POST /actions/entry-mode passes the readiness check')
})

test('RACE CHECKER: a TIMEOUT rung as order_reject settles UNKNOWN, keeps the key blocked, and the feeder issues no new permit for it; a RELEASED standing row the ring names is reopened', async () => {
  const db = fresh()
  switchOn(db, DEMO)
  setState(db, `acct:${DEMO}:account_balance_usd`, '10000')
  const d = deps()
  await runTickPermitFeeder(db, side, d.opts)
  const intent = db.prepare(`SELECT id FROM entry_intents WHERE producer_id = ? AND symbol_id = 1 AND side = 'SELL'`).get(TICK_PRODUCER).id
  const ins = db.prepare(`INSERT INTO cpp_decisions (side, boot_id, seq, ts_ms, component, kind, account_id, symbol_id, code, detail) VALUES ('cpp_exec_demo', 'b1', ?, 1, 'engine', ?, ?, ?, ?, ?)`)
  ins.run(1, 'order_submit', DEMO, 1, '', `intent=${intent}`)
  ins.run(2, 'order_reject', DEMO, 1, 'TIMEOUT', `intent=${intent}`)
  reconcileIntents(db, { accountId: DEMO })
  const row = db.prepare('SELECT state, error_code FROM entry_intents WHERE id = ?').get(intent)
  assert.equal(row.state, 'UNKNOWN', 'a timeout is not a refusal'); assert.equal(row.error_code, 'TIMEOUT')
  const r = await runTickPermitFeeder(db, side, d.opts)
  const refused = r.refused.find(x => x.symbol === 'EURUSD')
  assert.ok(refused && /^intent_open: UNKNOWN/.test(refused.reason), `no second permit on an unknown outcome: ${JSON.stringify(r.refused)}`)
  assert.equal(d.pushes.at(-1).tickPermits.filter(p => p.symbolId === 1 && p.side === 'SELL').length, 0)
  // a standing permit spent as the mode switched: RELEASED row + ring order_result → FILLED, not lost
  const other = db.prepare(`SELECT id FROM entry_intents WHERE producer_id = ? AND symbol_id = 41 AND side = 'BUY' AND state = 'RESERVED'`).get(TICK_PRODUCER).id
  requestEntryMode(db, DEMO, 'STOPPED')
  assert.equal(db.prepare('SELECT state FROM entry_intents WHERE id = ?').get(other).state, 'RELEASED')
  ins.run(3, 'order_result', DEMO, 41, 'ok', `intent=${other} order=5 pos=9`)
  reconcileIntents(db, { accountId: DEMO })
  const reopened = db.prepare('SELECT state, broker_position_id FROM entry_intents WHERE id = ?').get(other)
  assert.equal(reopened.state, 'FILLED'); assert.equal(String(reopened.broker_position_id), '9')
})

test('RACE CHECKER: no permit for a symbol the account already holds, none at the position cap, and the withdrawn standing rows are released', async () => {
  const db = fresh()
  switchOn(db, DEMO)
  setState(db, `acct:${DEMO}:account_balance_usd`, '10000')
  const d = deps()
  await runTickPermitFeeder(db, side, d.opts)
  assert.equal(d.pushes.at(-1).tickPermits.length, 4)
  db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id) VALUES ('XAUUSD', 'BUY', 'open', ?, '4242')`).run(DEMO)
  assert.deepEqual([...openPositionsFor(db, DEMO).symbols.keys()], ['XAUUSD'])
  let r = await runTickPermitFeeder(db, side, d.opts)
  assert.ok(r.refused.some(x => x.symbol === 'XAUUSD' && x.reason.startsWith('position_open')))
  assert.equal(d.pushes.at(-1).tickPermits.length, 2, 'EURUSD only')
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RELEASED' AND error_code = 'tick_permit_withdrawn'`).get(TICK_PRODUCER).n, 2)
  for (const s of ['A.US', 'B.US', 'C.US', 'D.US']) db.prepare(`INSERT INTO trades (symbol, side, status, account_id) VALUES (?, 'BUY', 'open', ?)`).run(s, DEMO)
  r = await runTickPermitFeeder(db, side, d.opts)
  assert.ok(r.refused.every(x => /^max_positions: 5\/5/.test(x.reason) || x.reason.startsWith('position_open')), JSON.stringify(r.refused))
  assert.equal(d.pushes.at(-1).tickPermits.length, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED'`).get(TICK_PRODUCER).n, 0)
})

test('the sidecar\'s tick label carries the intent in the 8th field, so a position the ring never settled is reconciled by its label', () => {
  assert.equal(labelIntentId('tick:abcdef0123456789|||||||i0123456789ab'), 'i0123456789ab')
  assert.equal(labelIntentId('tick:abcdef0123456789'), null)
})

// ---------------------------------------------------------------------------
// PR-3 (dual-basis arbitration, 21-09-2026): admittedBases with ONE budget.
// ---------------------------------------------------------------------------
// PR-3: the overlay carries the same evidence bar as the mode (a pinned
// profile + SHADOW_PASSED — entry-contracts.js), so this pins it first,
// exactly as switchOn does above for TICK_MOMENTUM itself.
const dual = (db, id) => {
  const cur = engineStatusFor(db, id)
  writeEngineStatus(db, { ...cur, profileHash: profileHashFull(DEFAULT_PARAMS), profileId: 'tick_momentum_breakout@v1', validationStage: 'SHADOW_PASSED', configRevision: cur.configRevision + 1, updatedAt: new Date().toISOString() })
  const r = requestAdmittedBases(db, id, ['bar', 'tick'], { expectedRevision: engineStatusFor(db, id).configRevision, readiness: () => ({ ready: true, blockedReasons: [] }) })
  assert.equal(r.ok, true, r.reason)
  return engineStatusFor(db, id)
}
const gbp = { EURUSD: 1, GBPUSD: 2 }
const resolveGbp = async (_db, _c, name) => ({ id: gbp[name] ?? null, source: 'test' })

test('PR-3: a TIME_BASED account admitting [bar, tick] is a tick account for the feeder AND the guard sync (the two pushes agree), stays a bar account for the fence, and is neither when the overlay is cleared', async () => {
  const db = fresh()
  _resetRefusalDedupe()
  assert.deepEqual(tickEntryAccountsFor(db, side), [], 'TIME_BASED with no overlay: not a tick account')
  dual(db, DEMO)
  assert.equal(engineStatusFor(db, DEMO).effectiveEntryMode, 'TIME_BASED', 'the mode did not move')
  assert.deepEqual(tickEntryAccountsFor(db, side), [DEMO], 'the feeder lists it')
  assert.deepEqual(desiredGuardFor(db, side).tickEntryAccounts, [Number(DEMO)], 'the guard sync lists it — the same predicate, or the two pushes oscillate')
  assert.equal(admitEntry(db, { accountId: DEMO, producerId: 'daily_momentum_account', basis: 'bar' }).ok, true)
  assert.equal(admitEntry(db, { accountId: DEMO, producerId: TICK_PRODUCER, basis: 'tick' }).ok, true)
  setState(db, `acct:${DEMO}:account_balance_usd`, '10000')
  const d = deps()
  const r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r.permits, 4); assert.deepEqual(d.pushes.at(-1).tickEntryAccounts, [Number(DEMO)])
  assert.ok(d.pushes.at(-1).tickPermits.every(p => p.permit.epoch === engineStatusFor(db, DEMO).modeEpoch))
  // the overlay cleared → not a tick account on either push; standing rows released by the feeder
  assert.equal(requestAdmittedBases(db, DEMO, null, { expectedRevision: engineStatusFor(db, DEMO).configRevision }).ok, true)
  assert.deepEqual(tickEntryAccountsFor(db, side), []); assert.deepEqual(desiredGuardFor(db, side).tickEntryAccounts, [])
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RELEASED' AND error_code = 'basis_withdrawn'`).get(TICK_PRODUCER).n, 4, 'the setter released them as basis_withdrawn')
  const r2 = await runTickPermitFeeder(db, side, d.opts)
  assert.deepEqual(d.pushes.at(-1), { tickEntryAccounts: [], tickPermits: [], tickSlots: [] }); assert.equal(r2.permits, 0)
})

test('PR-3 (one budget): a bar EURUSD intent and a tick GBPUSD permit are both admitted on [bar, tick]; the pending bar intent counts against the position cap, a standing tick row does not; after the bar fill held.total is 1, not 2', async () => {
  const db = fresh()
  setState(db, 'tick_symbols_json', JSON.stringify(['GBPUSD']))
  dual(db, DEMO)
  setState(db, `acct:${DEMO}:account_balance_usd`, '10000')
  const d = deps({ resolveSymbolId: resolveGbp })
  // the bar side reserves EURUSD BUY (RESERVED — pending, unfilled)
  const bar = reserveEntry(db, { accountId: DEMO, producerId: 'daily_momentum_account', basis: 'bar', symbolId: 1, symbol: 'EURUSD', side: 'BUY', volume: 100_000 })
  assert.equal(bar.ok, true, bar.reason)
  let r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r.permits, 2, 'GBPUSD BUY/SELL permitted beside the bar intent'); assert.deepEqual(r.refused, [])
  assert.deepEqual(r.budget[`…${DEMO.slice(-4)}`], { positions: 0, pending: 1, total: 1, cap: 5 }, 'the pending bar intent is spent capacity; the two standing tick rows are not')
  let h = heldWithPending(db, DEMO)
  assert.equal(h.total, 1); assert.equal(h.pending, 1); assert.equal(h.positions, 0)
  // the bar side fills: the intent settles and the position appears in trades — counted ONCE
  assert.equal(redeemPermit(db, bar.permit.id).ok, true)
  assert.equal(resolveIntent(db, bar.intentId, { state: 'FILLED', positionId: '9001', source: 'event' }).ok, true)
  db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id) VALUES ('EURUSD', 'BUY', 'open', ?, '9001')`).run(DEMO)
  h = heldWithPending(db, DEMO)
  assert.equal(h.total, 1, 'the filled intent is no longer pending: 1, not 2'); assert.equal(h.pending, 0); assert.equal(h.positions, 1)
  r = await runTickPermitFeeder(db, side, d.opts)
  assert.deepEqual(r.budget[`…${DEMO.slice(-4)}`], { positions: 1, pending: 0, total: 1, cap: 5 })
  assert.equal(r.permits, 2, 'GBPUSD still permitted — EURUSD is the one held')
  // the cap is ONE cap: four more pending bar intents fill it and the tick side gets nothing
  for (const [sid, sym] of [[3, 'USDJPY'], [4, 'AUDUSD'], [5, 'NZDUSD'], [6, 'USDCAD']]) assert.equal(reserveEntry(db, { accountId: DEMO, producerId: 'daily_momentum_account', basis: 'bar', symbolId: sid, symbol: sym, side: 'BUY', volume: 100_000 }).ok, true)
  r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r.permits, 0); assert.ok(r.refused.every(x => /^max_positions: 5\/5/.test(x.reason)), JSON.stringify(r.refused))
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED'`).get(TICK_PRODUCER).n, 0, 'the standing rows are withdrawn at the cap')
})

test('PR-3: a tick standing permit, then a bar signal on the same symbol and side — the bar is admitted (the permit never vetoes it), the tick permit is withdrawn on the next feeder pass and the sidecar\'s push no longer carries it; the account is marked for a re-push on the fill', async () => {
  const db = fresh()
  dual(db, DEMO)
  setState(db, `acct:${DEMO}:account_balance_usd`, '10000')
  const d = deps()
  await runTickPermitFeeder(db, side, d.opts)
  assert.ok(d.pushes.at(-1).tickPermits.some(p => p.symbolId === 1 && p.side === 'BUY'), 'EURUSD BUY standing permit pushed')
  const standing = db.prepare(`SELECT id FROM entry_intents WHERE producer_id = ? AND symbol_id = 1 AND side = 'BUY' AND state = 'RESERVED'`).get(TICK_PRODUCER).id
  const bar = reserveEntry(db, { accountId: DEMO, producerId: 'daily_momentum_account', basis: 'bar', symbolId: 1, symbol: 'EURUSD', side: 'BUY', volume: 100_000 })
  assert.equal(bar.ok, true, `a standing permit is capacity, not a veto: ${bar.reason}`)
  const r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(db.prepare('SELECT state, error_code FROM entry_intents WHERE id = ?').get(standing).state, 'RELEASED')
  assert.equal(db.prepare('SELECT error_code FROM entry_intents WHERE id = ?').get(standing).error_code, 'tick_permit_withdrawn')
  assert.ok(!d.pushes.at(-1).tickPermits.some(p => p.symbolId === 1 && p.side === 'BUY'), 'the push no longer carries EURUSD BUY')
  assert.ok(d.pushes.at(-1).tickPermits.some(p => p.symbolId === 1 && p.side === 'SELL'), 'EURUSD SELL is another key')
  assert.equal(r.permits, 3)
  assert.match(r.refused.find(x => x.symbol === 'EURUSD').reason, /^intent_open: RESERVED/)
  // the re-push mark: the loop marks the account on a fill; the heartbeat takes it once, by side roster
  _resetTickRepushForTests()
  assert.equal(tickRepushPending(), false)
  // BOUNDED (checker): only an account that currently admits tick is marked,
  // so the loop marking EVERY bar fill cannot leave a pure-bar account's id
  // in the set for ever (takeTickRepush only ever clears tick-roster ids).
  assert.equal(markTickRepush(db, DEMO), true, 'DEMO admits [bar, tick]')
  assert.equal(markTickRepush(db, DEMO2), false, 'a pure-bar account is never marked')
  assert.equal(markTickRepush(db, LIVE), false)
  assert.equal(markTickRepush(db, null), false)
  assert.deepEqual(peekTickRepush(null), [DEMO], 'one mark, and peeking clears nothing')
  assert.deepEqual(peekTickRepush(null), [DEMO])
  assert.equal(tickRepushPending(), true)
  assert.deepEqual(takeTickRepush([DEMO2]), [], 'another side\'s roster takes nothing')
  assert.deepEqual(takeTickRepush([DEMO]), [DEMO], 'taken for this side\'s roster')
  assert.equal(tickRepushPending(), false, 'nothing is left behind to leak')
  assert.deepEqual(takeTickRepush([DEMO]), [], 'a mark is taken once')
  // a bar fill on an account that has since dropped tick leaves no residue
  assert.equal(requestAdmittedBases(db, DEMO, null, { expectedRevision: engineStatusFor(db, DEMO).configRevision }).ok, true)
  assert.equal(markTickRepush(db, DEMO), false); assert.equal(tickRepushPending(), false)
})

test('PR-3: the bar side\'s account pre-gate refusing (balance_not_account_scoped — the pure read, no decision row) gives the tick side zero permits, releases its standing rows and names the guard in out.paused; the guard sync agrees; an exhausted margin pool pauses the same way; both clear when the state does', async () => {
  const db = fresh()
  dual(db, DEMO)
  setState(db, `acct:${DEMO}:account_balance_usd`, '10000')
  const d = deps()
  await runTickPermitFeeder(db, side, d.opts)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED'`).get(TICK_PRODUCER).n, 4)
  // the account's stamp goes and only the shared legacy key is left: the pre-gate refuses the account
  db.prepare(`DELETE FROM agent_state WHERE key = ?`).run(`acct:${DEMO}:account_balance_usd`)
  setState(db, 'account_balance_usd', '25000')
  const before = db.prepare(`SELECT COUNT(*) AS n FROM decision_log`).get().n
  let r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r.permits, 0); assert.equal(r.released, 4)
  assert.equal(r.paused.length, 1); assert.equal(r.paused[0].reason, 'account_pregate:balance_not_account_scoped'); assert.match(r.paused[0].detail, /balance_not_account_scoped/)
  assert.deepEqual(d.pushes.at(-1), { tickEntryAccounts: [], tickPermits: [], tickSlots: [] })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RELEASED' AND error_code = 'account_pregate:balance_not_account_scoped'`).get(TICK_PRODUCER).n, 4)
  assert.deepEqual(desiredGuardFor(db, side).tickEntryAccounts, [], 'the guard sync leaves the paused account out too')
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM decision_log`).get().n, before, 'the PURE verdict wrote no decision row (the loop\'s memoising pre-gate does that)')
  // the stamp returns: permits again
  setState(db, `acct:${DEMO}:account_balance_usd`, '10000')
  r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r.permits, 4); assert.deepEqual(r.paused, [])
  // The permit account's own snapshot binds even when another account is selected.
  setState(db, 'ctrader_account_id', DEMO2)
  setState(db, 'broker_snapshot_cache_json', JSON.stringify({ fetchedAt: new Date().toISOString(), account: { accountId: DEMO2, currency: 'USD', health: { usedMargin: 0 } } }))
  setState(db, `acct:${DEMO}:broker_snapshot_cache_json`, JSON.stringify({ fetchedAt: new Date().toISOString(), account: { accountId: DEMO, currency: 'USD', health: { usedMargin: 9_000 } } }))
  r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r.permits, 0); assert.equal(r.released, 4)
  assert.equal(r.paused[0].reason, 'account_pregate:portfolio_margin_exhausted'); assert.match(r.paused[0].detail, /^headroom \$-4000\.00/)
  assert.deepEqual(d.pushes.at(-1), { tickEntryAccounts: [], tickPermits: [], tickSlots: [] })
  setState(db, `acct:${DEMO}:broker_snapshot_cache_json`, JSON.stringify({ fetchedAt: new Date().toISOString(), account: { accountId: DEMO, currency: 'USD', health: { usedMargin: 100 } } }))
  r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r.permits, 4); assert.deepEqual(r.paused, [])
})

test('PR-3 (checker blocker): an UNEVIDENCED record admitting tick does not validate, so engineStatusFor falls back to the OFF default and the feeder roster, the guard sync push, admitEntry(tick) and the permits all drop the account on the NEXT READ — the self-healing the overlay must not lose', async () => {
  const db = fresh()
  _resetRefusalDedupe()
  dual(db, DEMO)
  setState(db, `acct:${DEMO}:account_balance_usd`, '10000')
  const d = deps()
  // armed: on both rosters, the fence says yes, four standing permits pushed
  assert.deepEqual(tickEntryAccountsFor(db, side), [DEMO])
  assert.deepEqual(desiredGuardFor(db, side).tickEntryAccounts, [Number(DEMO)])
  assert.equal(admitEntry(db, { accountId: DEMO, producerId: TICK_PRODUCER, basis: 'tick' }).ok, true)
  assert.equal((await runTickPermitFeeder(db, side, d.opts)).permits, 4)
  // THE BACKSTOP. A record admitting tick WITHOUT the evidence reaches the
  // store — a pre-PR-3 build, a restored backup, a hand edit — and is read
  // back. It must not validate: the evidence rules follow the admitted
  // basis, not the mode string.
  const armed = engineStatusFor(db, DEMO)
  const unevidenced = { ...armed, stored: undefined, invalid: undefined, validationStage: 'UNVALIDATED', profileHash: null }
  delete unevidenced.stored; delete unevidenced.invalid
  assert.equal(validateEngineStatus(unevidenced).ok, false, 'TIME_BASED + UNVALIDATED + no profile + [bar, tick] must NOT validate')
  setAccountState(db, DEMO, ENGINE_STATUS_KEY, JSON.stringify(unevidenced))
  const st = engineStatusFor(db, DEMO)
  assert.equal(st.stored, false, 'the stored record no longer satisfies the contract')
  assert.ok(Array.isArray(st.invalid) && st.invalid.some(e => /validationStage: admitting tick needs at least SHADOW_PASSED/.test(e)), JSON.stringify(st.invalid))
  assert.ok(st.invalid.some(e => /profileHash: required while tick entries are admitted/.test(e)))
  assert.equal(st.effectiveEntryMode, 'TIME_BASED'); assert.equal(st.admittedBases, null, 'the fallback is the OFF default — no overlay survives it')
  // every reader drops it on the next read
  _resetRefusalDedupe()
  assert.deepEqual(tickEntryAccountsFor(db, side), [], 'off the feeder roster')
  assert.deepEqual(desiredGuardFor(db, side).tickEntryAccounts, [], 'off the guard sync push')
  const a = admitEntry(db, { accountId: DEMO, producerId: TICK_PRODUCER, basis: 'tick' })
  assert.equal(a.ok, false); assert.match(a.reason, /^entry_mode_basis: TIME_BASED admits bar producers/)
  const r = await runTickPermitFeeder(db, side, d.opts)
  assert.equal(r.permits, 0)
  assert.deepEqual(d.pushes.at(-1), { tickEntryAccounts: [], tickPermits: [], tickSlots: [] })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED'`).get(TICK_PRODUCER).n, 0, 'the standing permits went with it')
  // and the overlay cannot be set again while the evidence is gone
  const again = requestAdmittedBases(db, DEMO, ['bar', 'tick'], { expectedRevision: engineStatusFor(db, DEMO).configRevision, readiness: () => ({ ready: true, blockedReasons: [] }) })
  assert.equal(again.ok, false); assert.equal(again.reason, 'engine_record_invalid', 'the setter refuses on an invalid record before anything else')
  // and once the corrupt record is replaced by the OFF default, the evidence
  // rule itself is what refuses the set
  writeEngineStatus(db, { ...engineStatusFor(db, DEMO), stored: undefined, invalid: undefined, updatedAt: new Date().toISOString() })
  const bare = requestAdmittedBases(db, DEMO, ['bar', 'tick'], { expectedRevision: engineStatusFor(db, DEMO).configRevision, readiness: () => ({ ready: true, blockedReasons: [] }) })
  assert.equal(bare.ok, false); assert.match(bare.reason, /^admitted_bases_refused:/)
  assert.match(bare.reason, /validationStage: admitting tick needs at least SHADOW_PASSED/)
})

test('PR-3 (checker blocker, parity): importTickValidation REVOKING the stage under an admitted tick is refused and changes nothing — exactly what it already does under an effective TICK_MOMENTUM, measured; the evidence and the admitted set can never disagree on a stored record', async () => {
  const { importTickValidation } = await import('./tick-validation.js')
  // (a) the overlay
  const db = fresh()
  dual(db, DEMO)
  // WP-A: refused with a NAMED reason (tick_admitted) before anything is
  // written — it used to throw out of writeEngineStatus as a 500.
  const refusedA = importTickValidation(db, { accountId: DEMO, stage: 'UNVALIDATED', evidence: { reason: 'the shadow evidence was withdrawn' } })
  assert.equal(refusedA.ok, false); assert.match(refusedA.reason, /^tick_admitted: the account admits bar\+tick/)
  let st = engineStatusFor(db, DEMO)
  assert.equal(st.validationStage, 'SHADOW_PASSED', 'nothing was written'); assert.deepEqual(st.admittedBases, ['bar', 'tick'])
  assert.deepEqual(tickEntryAccountsFor(db, side), [DEMO], 'still armed, because the revocation did not land')
  // (b) the mode, on the same database — the pre-existing behaviour the
  // overlay is now at parity with (this is what main does today)
  const db2 = fresh()
  switchOn(db2, DEMO)
  const refusedB = importTickValidation(db2, { accountId: DEMO, stage: 'UNVALIDATED', evidence: { reason: 'x' } })
  assert.equal(refusedB.ok, false); assert.match(refusedB.reason, /^tick_admitted: the account admits tick /, 'ONE rule, one reason, for the mode and the overlay alike')
  st = engineStatusFor(db2, DEMO)
  assert.equal(st.validationStage, 'SHADOW_PASSED'); assert.equal(st.effectiveEntryMode, 'TICK_MOMENTUM')
  assert.deepEqual(tickEntryAccountsFor(db2, side), [DEMO])
  // The operator's route to disarm either one is the entry-mode route, not
  // the importer: clearing the overlay (or STOPPED) first, then revoking.
  assert.equal(requestAdmittedBases(db, DEMO, null, { expectedRevision: engineStatusFor(db, DEMO).configRevision }).ok, true)
  assert.equal(importTickValidation(db, { accountId: DEMO, stage: 'UNVALIDATED', evidence: { reason: 'the shadow evidence was withdrawn' } }).ok, true)
  assert.equal(engineStatusFor(db, DEMO).validationStage, 'UNVALIDATED')
  assert.deepEqual(tickEntryAccountsFor(db, side), [])
})
