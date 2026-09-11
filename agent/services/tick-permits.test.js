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
import { upsertAccount } from './account-registry.js'
import { engineStatusFor, requestEntryMode, acknowledgeEntryEpochs, writeEngineStatus } from './entry-mode.js'
import { reconcileIntents, TICK_PRODUCER, reserveEntry, STANDING_PRODUCERS } from './entry-ledger.js'
import { profileHashFull, DEFAULT_PARAMS } from '../lib/tick-strategy.js'
import { permitSizing, tickEntryAccountsFor, runTickPermitFeeder, loadTickEntryConfig, PAUSE_CHECKS, WIRE_UNIT, PAUSED_KEY, openPositionsFor } from './tick-permits.js'
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
  assert.deepEqual(d.pushes[0], { tickEntryAccounts: [Number(DEMO)], tickPermits: [] })
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
  assert.deepEqual(d.pushes.at(-1), { tickEntryAccounts: [], tickPermits: [] }, 'the sidecar stops placing for the paused account')
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
  assert.deepEqual(d.pushes.at(-1), { tickEntryAccounts: [], tickPermits: [] })
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
  assert.ok(hb.includes('await feedTickPermits(db, exec, side, nowMs)'), 'the probe calls the feeder')
  assert.ok(hb.includes('runTickPermitFeeder(db, side, { creds, now: nowMs })'), 'the feeder runs with the side\'s own credentials')
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
