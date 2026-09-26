// agent/services/tick-combined-risk.test.js — C9 (SEQUENCE PR-9, the Node
// half of WP-D's combined-risk gaps; owner OD-6, 26-09-2026: the V3 defaults).
//
// What is pinned here, each on the real schema (initDB):
//   gap 1  — unsettled tick fires: every fired state counted, deduped against
//            adoption and against the pending intents the feeder already
//            counts; the bar gate's step 3 and the pre-filter share ONE
//            count (countedPositionsWithTickFires); the push carries tickSlots
//            with the boot's firesSeen.
//   gap 4  — the book-wide cap on tick: at most `cap` accounts per symbol and
//            side, R / n each (sharedSignalRiskSplit), least-recently-served
//            first, one generation per cycle that a later side's pass may only
//            narrow.
//   gap 5  — REVALIDATE_CHECKS re-read every pass; the permit carries the
//            pinned profile hash and the boot.
//   gap 6  — no permit crosses a gateway boot: the restart quarantine holds
//            old-boot rows RESERVED until a reconcile of the account, bounded
//            by RESTART_RECONCILE_WAIT_MS; every reconcile path stamps the
//            account's own last_reconcile_at.
// Gap 4c (drawdown de-risk on tick) is NOT built: an owner question.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { initDB, setState, getState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { engineStatusFor, requestEntryMode, acknowledgeEntryEpochs, writeEngineStatus } from './entry-mode.js'
import { unsettledTickFires, reserveEntry, resolveIntent, TICK_PRODUCER, TICK_FIRE_UNSETTLED_WINDOW_MS } from './entry-ledger.js'
import { profileHashFull, DEFAULT_PARAMS } from '../lib/tick-strategy.js'
import {
  runTickPermitFeeder, computeTickGrants, heldWithPending, PAUSE_CHECKS, REVALIDATE_CHECKS,
  TICK_GRANTS_KEY, TICK_BOOT_SEEN_KEY, RESTART_RECONCILE_WAIT_MS,
} from './tick-permits.js'
import { countedPositionsWithTickFires } from './risk.js'
import { accountRiskPerTrade } from './tick-shadow.js'
import { accountPregateVerdict } from './account-pregate.js'
import { reconcilePositions } from './reconciler.js'
import { lastReconcileAt } from './account-engineering.js'

// Three demo accounts and one live one. Ids are chosen so that the account-id
// tie-break and the least-recently-served order disagree where a test needs it.
const A = '41000001', B = '41000002', C = '41000003', L = '41000009'
const demo = { isLive: false, name: 'cpp_exec_demo' }
const live = { isLive: true, name: 'cpp_exec' }
const creds = { ready: true, host: 'demo.ctraderapi.com', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: A }
const META = { lotSize: 10_000_000, minVolume: 100_000, maxVolume: 10_000_000_000, stepVolume: 100_000, digits: 5 }
const ids = { EURUSD: 1 }
const resolveSymbolId = async (_db, _c, name) => ({ id: ids[name] ?? null, source: 'test' })
const readyAll = () => ({ ready: true, profileHash: '967c1defd6e78d09', readiness: REVALIDATE_CHECKS.map(check => ({ check, ok: true })) })

function fresh(accounts = [A, B, C], { liveAccounts = [] } = {}) {
  const db = initDB(':memory:')
  for (const id of accounts) upsertAccount(db, { accountId: id, isLive: false })
  for (const id of liveAccounts) upsertAccount(db, { accountId: id, isLive: true })
  db.prepare('UPDATE accounts SET enabled = 1').run()
  setState(db, 'tick_symbols_json', JSON.stringify(['EURUSD']))
  for (const id of [...accounts, ...liveAccounts]) { switchOn(db, id); setState(db, `acct:${id}:account_balance_usd`, '10000') }
  return db
}
function switchOn(db, id) {
  writeEngineStatus(db, { ...engineStatusFor(db, id), profileHash: profileHashFull(DEFAULT_PARAMS), profileId: 'tick_momentum_breakout@v1', validationStage: 'SHADOW_PASSED', configRevision: engineStatusFor(db, id).configRevision + 1, updatedAt: new Date().toISOString() })
  const r = requestEntryMode(db, id, 'TICK_MOMENTUM', { readiness: () => ({ ready: true, blockedReasons: [] }) })
  assert.equal(r.ok, true, r.reason)
  acknowledgeEntryEpochs(db, { [id]: r.status.modeEpoch })
}
const opts = (over = {}) => {
  const pushes = []
  return {
    pushes,
    o: { creds, resolveSymbolId, readiness: readyAll, volumeMeta: async () => META, push: async (_c, body) => { pushes.push(body); return { ok: true } }, log: () => {}, ...over },
  }
}
const ring = (db, { kind = 'fire', code = 'BUY', detail, account = A, boot = 'B1', side = 'cpp_exec_demo', seq }) =>
  db.prepare(`INSERT INTO cpp_decisions (side, boot_id, seq, ts_ms, component, kind, account_id, symbol_id, code, detail) VALUES (?, ?, ?, 1, 'tick', ?, ?, 1, ?, ?)`)
    .run(side, boot, seq ?? Math.floor(Math.random() * 1e9), kind, account, code, detail)
// The full R of one $10,000 account on EURUSD under the default risk config.
const fullROf = () => { const db = initDB(':memory:'); setState(db, 'acct:1:account_balance_usd', '10000'); return accountRiskPerTrade(db, '1').usdPerR }
const standingId = (db, acct, side = 'BUY') => db.prepare(`SELECT id FROM entry_intents WHERE producer_id = ? AND account_id = ? AND symbol_id = 1 AND side = ? AND state = 'RESERVED'`).get(TICK_PRODUCER, acct, side)?.id
// A position as the reconciler adopts one: a trades row carrying the broker
// position id, and the monitored row linked to it (monitored_positions has no
// position id column of its own — agent/db.js).
const pos = (db, acct, sym, side, positionId = null) => {
  const t = db.prepare(`INSERT INTO trades (account_id, status, symbol, side, ctrader_position_id) VALUES (?, 'open', ?, ?, ?)`).run(acct, sym, side, positionId)
  db.prepare(`INSERT INTO monitored_positions (account_id, status, symbol, side, trade_id) VALUES (?, 'active', ?, ?, ?)`).run(acct, sym, side, t.lastInsertRowid)
}
// A monitored row whose trades row is gone or never written (a legacy
// adoption): only openPositionsFor's monitored read can count it.
const bareMonitored = (db, acct, sym, side) =>
  db.prepare(`INSERT INTO monitored_positions (account_id, status, symbol, side) VALUES (?, 'active', ?, ?)`).run(acct, sym, side)

// ---------------------------------------------------------------- gap 1 ----

test('gap 1: unsettledTickFires counts a fired intent in every fired state, stops at adoption, and drops a stale or refused fire; a TIMEOUT reject still counts', async () => {
  const db = fresh([A])
  const d = opts()
  await runTickPermitFeeder(db, demo, d.o)
  const buy = standingId(db, A, 'BUY')
  const sell = standingId(db, A, 'SELL')
  assert.ok(buy && sell)
  assert.deepEqual(unsettledTickFires(db, A), [], 'a standing permit nobody fired is capacity, not exposure')
  ring(db, { detail: `vol=100000 stop=50 entry=1.1 seq=1 intent=${buy} profile=967c1defd6e78d09` })
  assert.deepEqual(unsettledTickFires(db, A).map(f => [f.id, f.state]), [[buy, 'RESERVED']], 'fired while still RESERVED (ring pulled before reconcileIntents)')
  // FILLED with a broker position, not adopted yet → counts; adopted → gone
  db.prepare(`UPDATE entry_intents SET state = 'FILLED', broker_position_id = '77' WHERE id = ?`).run(buy)
  assert.equal(unsettledTickFires(db, A).length, 1, 'FILLED but not adopted still counts')
  pos(db, A, 'EURUSD', 'BUY', '77')
  assert.equal(unsettledTickFires(db, A).length, 0, 'the adopted position is counted by the position read, not twice')
  // UNKNOWN after a TIMEOUT reject: the order may have filled → counts
  ring(db, { detail: `intent=${sell} seq=2` })
  db.prepare(`UPDATE entry_intents SET state = 'UNKNOWN' WHERE id = ?`).run(sell)
  ring(db, { kind: 'fire_reject', code: 'TIMEOUT', detail: `intent=${sell} no answer` })
  assert.deepEqual(unsettledTickFires(db, A).map(f => f.id), [sell], 'a timeout is not a refusal')
  // a real reject (NOT_ENOUGH_MONEY) → no order → no longer counts
  ring(db, { kind: 'fire_reject', code: 'NOT_ENOUGH_MONEY', detail: `intent=${sell} margin` })
  assert.deepEqual(unsettledTickFires(db, A), [])
  // a fire_stale refusal names the intent → nothing was sent
  const other = reserveEntry(db, { accountId: A, producerId: TICK_PRODUCER, basis: 'tick', symbolId: 7, symbol: 'GBPUSD', side: 'BUY' })
  assert.equal(other.ok, true, other.reason)
  ring(db, { detail: `intent=${other.intentId} seq=4` })
  assert.equal(unsettledTickFires(db, A).length, 1)
  ring(db, { kind: 'fire_refused', code: 'fire_stale', detail: `queued 9000 ms > 5000 intent=${other.intentId}` })
  assert.equal(unsettledTickFires(db, A).length, 0)
  // the window: a fire older than the window no longer counts
  const late = reserveEntry(db, { accountId: A, producerId: TICK_PRODUCER, basis: 'tick', symbolId: 8, symbol: 'AUDUSD', side: 'BUY' })
  ring(db, { detail: `intent=${late.intentId} seq=6` })
  assert.equal(unsettledTickFires(db, A).length, 1)
  assert.equal(unsettledTickFires(db, A, { now: Date.now() + TICK_FIRE_UNSETTLED_WINDOW_MS + 60_000 }).length, 0, 'bounded by the window')
  assert.equal(unsettledTickFires(db, null).length, 1, 'null = every account')
})

test('gap 1 (review blocker, dedupe): heldWithPending adds a fired RESERVED row once and does not add a SENT one pendingExposure already counts', async () => {
  const db = fresh([A])
  await runTickPermitFeeder(db, demo, opts().o)
  const buy = standingId(db, A, 'BUY')
  ring(db, { detail: `intent=${buy}` })
  let h = heldWithPending(db, A)
  assert.equal(h.total, 1); assert.equal(h.unsettled, 1); assert.equal(h.pending, 0)
  assert.ok(h.symbols.has('EURUSD'), 'the fired symbol is held: no new permit on it')
  db.prepare(`UPDATE entry_intents SET state = 'SENT' WHERE id = ?`).run(buy)
  h = heldWithPending(db, A)
  assert.equal(h.total, 1, 'counted once, as pending'); assert.equal(h.pending, 1); assert.equal(h.unsettled, 0)
})

test('gap 1d: the pre-filter and the gate count unadopted tick fires under the unchanged cap — 4 positions + 1 fired intent is 5/5; without the fire it is 4/5', async () => {
  const db = fresh([A])
  await runTickPermitFeeder(db, demo, opts().o)
  for (const s of ['A.US', 'B.US', 'C.US', 'D.US']) pos(db, A, s, 'BUY')
  assert.equal(accountPregateVerdict(db, A).ok, true, '4/5 passes')
  assert.equal(countedPositionsWithTickFires(db, A).fires, 0)
  const buy = standingId(db, A, 'BUY')
  ring(db, { detail: `intent=${buy}` })
  const c = countedPositionsWithTickFires(db, A)
  assert.equal(c.counted.length, 5); assert.equal(c.fires, 1)
  const v = accountPregateVerdict(db, A)
  assert.equal(v.ok, false); assert.equal(v.guard, 'max_positions'); assert.match(v.reason, /^max_positions=5\/5/)
  assert.equal(countedPositionsWithTickFires(db, null).fires, 0, 'an unscoped evaluation counts no per-account fire')
})

test('gap 1d wiring: risk.js step 3 and account-pregate.js both count through countedPositionsWithTickFires (comments stripped)', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const risk = strip(readFileSync(new URL('./risk.js', import.meta.url), 'utf8'))
  assert.match(risk, /const withFires = countedPositionsWithTickFires\(db, acct,/)
  assert.match(risk, /const countedPositions = withFires\.counted\s+checks\.open_positions = countedPositions\.length/)
  assert.match(risk, /const maxPos = maxPositionsVerdict\(countedPositions, config\)/)
  const pre = strip(readFileSync(new URL('./account-pregate.js', import.meta.url), 'utf8'))
  assert.match(pre, /const counted = countedPositionsWithTickFires\(db, acct, \{ now: nowMs \}\)\.counted\s+const cap = maxPositionsVerdict\(counted, cfg\)/)
})

test('gap 1: the push carries tickSlots per placing account — the slots left under its own cap and the boot\'s firesSeen; a fired intent spends a slot and its symbol', async () => {
  const db = fresh([A])
  for (const s of ['A.US', 'B.US', 'C.US']) pos(db, A, s, 'BUY')
  const d = opts()
  await runTickPermitFeeder(db, demo, { ...d.o, bootId: 'B1' })
  assert.deepEqual(d.pushes.at(-1).tickSlots, [{ accountId: Number(A), slots: 2, firesSeen: 0, bootId: 'B1' }])
  const buy = standingId(db, A, 'BUY')
  ring(db, { detail: `intent=${buy}`, boot: 'B1', side: 'cpp_exec_demo' })
  ring(db, { detail: 'intent=ixxxxxxxxxxxx', boot: 'B0', side: 'cpp_exec_demo' }) // another boot: not this boot's
  const r = await runTickPermitFeeder(db, demo, { ...d.o, bootId: 'B1' })
  assert.deepEqual(d.pushes.at(-1).tickSlots, [{ accountId: Number(A), slots: 1, firesSeen: 1, bootId: 'B1' }])
  assert.ok(!d.pushes.at(-1).tickPermits.some(p => p.symbolId === 1), 'no permit on the fired symbol')
  assert.ok(r.refused.some(x => x.symbol === 'EURUSD' && /^position_open/.test(x.reason)))
})

// ---------------------------------------------------------------- gap 4 ----

test('gap 4: three tick accounts, cap 2 — exactly two hold the EURUSD BUY permit at R / 2 each, the third is refused book_symbol_cap', async () => {
  const db = fresh([A, B, C])
  const d = opts()
  const r = await runTickPermitFeeder(db, demo, d.o)
  const buys = d.pushes.at(-1).tickPermits.filter(p => p.symbolId === 1 && p.side === 'BUY')
  assert.deepEqual(buys.map(p => String(p.accountId)).sort(), [A, B], 'never served: by account id')
  const so = opts()
  const solo = await runTickPermitFeeder(fresh([A]), demo, so.o)
  assert.equal(solo.permits, 2)
  const fullR = so.pushes.at(-1).tickPermits[0].permit.usdRisk // the account's own R, alone on the symbol
  assert.ok(fullR > 0)
  for (const p of buys) assert.equal(p.permit.usdRisk, +(fullR / 2).toFixed(2), 'E·2 on tick: R / n')
  const ref = r.refused.find(x => x.accountId === `…${C.slice(-4)}` && x.side === 'BUY')
  assert.ok(ref, JSON.stringify(r.refused)); assert.match(ref.reason, /^book_symbol_cap: 0 hold, 2 granted in generation \d+, cap 2/)
  assert.equal(JSON.parse(getState(db, TICK_GRANTS_KEY)).grants['EURUSD|BUY'].n, 2, 'the generation is persisted')
})

test('gap 4 (rotation): a holder takes a place, and the free one goes to the never-served account before a recently served one — not to the lower id', async () => {
  const db = fresh([A, B, C])
  pos(db, A, 'EURUSD', 'BUY') // A holds EURUSD BUY: one place of two is taken
  // B was served on EURUSD BUY before (a FILLED tick intent, since closed): C, never served, goes first
  db.prepare(`INSERT INTO entry_intents (id, account_id, environment, symbol, symbol_id, side, order_type, producer_id, basis, mode_epoch, config_revision, permit_id, permit_expires_at, state, created_at, updated_at)
    VALUES ('iserved000001', ?, 'demo', 'EURUSD', 1, 'BUY', 'MARKET', ?, 'tick', 1, 1, 'pserved000001', ?, 'FILLED', ?, ?)`)
    .run(B, TICK_PRODUCER, new Date().toISOString(), new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() - 3_600_000).toISOString())
  const d = opts()
  const r = await runTickPermitFeeder(db, demo, d.o)
  const buys = d.pushes.at(-1).tickPermits.filter(p => p.symbolId === 1 && p.side === 'BUY')
  assert.deepEqual(buys.map(p => String(p.accountId)), [C], 'least-recently-served first')
  assert.equal(buys[0].permit.usdRisk, fullROf(), 'n = 1: full R')
  assert.match(r.refused.find(x => x.accountId === `…${B.slice(-4)}` && x.side === 'BUY').reason, /^book_symbol_cap: 1 hold, 1 granted/)
})

test('gap 4 (switch): sharedSignalRiskSplit off on an account keeps its full R when granted with another', async () => {
  const db = fresh([A, B])
  setState(db, `acct:${A}:risk_config_json`, JSON.stringify({ sharedSignalRiskSplit: 'off' }))
  const d = opts()
  await runTickPermitFeeder(db, demo, d.o)
  const buys = d.pushes.at(-1).tickPermits.filter(p => p.symbolId === 1 && p.side === 'BUY')
  const R = fullROf()
  assert.equal(buys.find(p => String(p.accountId) === A).permit.usdRisk, R, 'off: full R')
  assert.equal(buys.find(p => String(p.accountId) === B).permit.usdRisk, +(R / 2).toFixed(2), 'equal (default): R / 2')
})

test('gap 4 (review blocker, two sides): the live pass reads the SAME generation as the demo pass and, when a holder appeared in between, issues no new permit — a recomputed generation would have granted one and put three accounts on the symbol', async () => {
  // A (demo) and L (live) are tick accounts; X is a bar-only account.
  const X = '41000005'
  const db = fresh([A], { liveAccounts: [L] })
  upsertAccount(db, { accountId: X, isLive: false }); db.prepare('UPDATE accounts SET enabled = 1').run()
  // L sorts after A, so cap 2 with no holders grants both
  const gen = await computeTickGrants(db, { readiness: readyAll })
  assert.deepEqual(gen.grants['EURUSD|BUY'].granted, [A, L])
  const d = opts()
  await runTickPermitFeeder(db, demo, { ...d.o, grants: gen })
  assert.ok(d.pushes.at(-1).tickPermits.some(p => String(p.accountId) === A && p.side === 'BUY'), 'the demo pass pushed A')
  pos(db, X, 'EURUSD', 'BUY') // a bar fill between the two passes
  const r = await runTickPermitFeeder(db, live, { ...d.o, grants: gen })
  assert.ok(!d.pushes.at(-1).tickPermits.some(p => String(p.accountId) === L && p.side === 'BUY'), 'X + A already make 2: L gets nothing')
  assert.match(r.refused.find(x => x.side === 'BUY').reason, /^book_symbol_cap: 1 holder\(s\) appeared since generation/)
  // a fresh generation next cycle sees X and grants one place, to A (A's own standing row is not a holder)
  const next = await computeTickGrants(db, { readiness: readyAll })
  assert.equal(next.generation, gen.generation + 1)
  assert.deepEqual(next.grants['EURUSD|BUY'], { granted: [A], holders: [X], n: 1 })
})

test('gap 4 wiring: the heartbeat computes ONE generation per cycle before the sides and hands it to each side\'s feeder with its boot (comments stripped)', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const hb = strip(readFileSync(new URL('./heartbeat.js', import.meta.url), 'utf8'))
  const cycle = hb.indexOf('tickGrants = await (deps.computeTickGrants ?? tp.computeTickGrants)(db, { now: nowMs })')
  const loop = hb.indexOf('const out = await probeOneSidecar(db, exec, side, { ...deps, tickGrants })')
  assert.ok(cycle > 0 && loop > cycle, 'computed once, before the side loop, and passed into it')
  assert.ok(hb.includes('await feedTickPermits(db, exec, side, nowMs, { bootId: r.bootId ?? null, grants: deps.tickGrants ?? null })'))
  assert.ok(hb.includes('runTickPermitFeeder(db, side, { creds, now: nowMs, bootId, grants })'))
})

// ---------------------------------------------------------------- gap 5 ----

test('gap 5: profile_matches_sidecar or recorder_status_fresh going false pauses the account and releases its rows; every permit carries the pinned profile hash and the boot', async () => {
  const db = fresh([A])
  const d = opts()
  await runTickPermitFeeder(db, demo, { ...d.o, bootId: 'B1' })
  const ps = d.pushes.at(-1).tickPermits
  assert.equal(ps.length, 2)
  for (const p of ps) { assert.equal(p.permit.profileHash, '967c1defd6e78d09'); assert.equal(p.permit.bootId, 'B1') }
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED' AND sidecar_boot_id = 'B1'`).get(TICK_PRODUCER).n, 2, 'the rows carry the boot')
  for (const check of ['profile_matches_sidecar', 'recorder_status_fresh']) {
    const failing = () => ({ ready: false, readiness: REVALIDATE_CHECKS.map(c => ({ check: c, ok: c !== check })) })
    const r = await runTickPermitFeeder(db, demo, { ...d.o, bootId: 'B1', readiness: failing })
    assert.equal(r.paused[0]?.reason, `entry_mode_readiness: ${check}`)
    assert.deepEqual(d.pushes.at(-1).tickEntryAccounts, [])
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED'`).get(TICK_PRODUCER).n, 0)
    await runTickPermitFeeder(db, demo, { ...d.o, bootId: 'B1' })
  }
  assert.deepEqual([...PAUSE_CHECKS], ['recorder_recording', 'disk_reserve_clear', 'feed_continuity'], 'PAUSE_CHECKS unchanged')
})

// ---------------------------------------------------------------- gap 6 ----

test('gap 6: after a gateway restart the old boot\'s rows stay RESERVED and the account pauses until a reconcile of THAT account; then they go and fresh ids are pushed, bound to the new boot', async () => {
  const db = fresh([A])
  const d = opts()
  const t0 = Date.now()
  await runTickPermitFeeder(db, demo, { ...d.o, bootId: 'BA', now: t0 })
  const oldIds = d.pushes.at(-1).tickPermits.map(p => p.permit.id).sort()
  assert.equal(oldIds.length, 2)
  // the gateway restarts: boot BB
  let r = await runTickPermitFeeder(db, demo, { ...d.o, bootId: 'BB', now: t0 + 60_000 })
  assert.match(r.paused[0].reason, /^tick_sidecar_restart: waiting for a reconcile/)
  assert.deepEqual(d.pushes.at(-1).tickPermits, [], 'none of the old permits is re-pushed')
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED' AND sidecar_boot_id = 'BA'`).get(TICK_PRODUCER).n, 2, 'held RESERVED, not released')
  assert.equal(JSON.parse(getState(db, TICK_BOOT_SEEN_KEY)).cpp_exec_demo.bootId, 'BB')
  // a fill from boot BA arrives by its label during the quarantine: FILLED by tag, not a fence breach
  const spent = db.prepare(`SELECT id FROM entry_intents WHERE producer_id = ? AND side = 'BUY' AND state = 'RESERVED'`).get(TICK_PRODUCER).id
  assert.equal(resolveIntent(db, spent, { state: 'FILLED', positionId: '501', source: 'reconcile' }).ok, true)
  // a reconcile of the account after the new boot was seen lifts it (the scoped stamp)
  setState(db, `acct:${A}:last_reconcile_at`, new Date(t0 + 120_000).toISOString())
  r = await runTickPermitFeeder(db, demo, { ...d.o, bootId: 'BB', now: t0 + 180_000 })
  assert.deepEqual(r.paused, [])
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RELEASED' AND error_code = 'tick_sidecar_restart'`).get(TICK_PRODUCER).n, 1)
  const fresh2 = d.pushes.at(-1).tickPermits
  assert.ok(fresh2.length >= 1)
  for (const p of fresh2) { assert.ok(!oldIds.includes(p.permit.id), 'a new id, never the old boot\'s'); assert.equal(p.permit.bootId, 'BB') }
})

test('gap 6 (bounded): no reconcile within RESTART_RECONCILE_WAIT_MS turns the wait into the urgent refusal tick_sidecar_restart_unreconciled; the rows are still not released', async () => {
  const db = fresh([A])
  const d = opts()
  const t0 = Date.now()
  await runTickPermitFeeder(db, demo, { ...d.o, bootId: 'BA', now: t0 })
  await runTickPermitFeeder(db, demo, { ...d.o, bootId: 'BB', now: t0 + 1000 })
  const errs = []
  const orig = console.error
  console.error = (m) => errs.push(String(m))
  try {
    const r = await runTickPermitFeeder(db, demo, { ...d.o, bootId: 'BB', now: t0 + 1000 + RESTART_RECONCILE_WAIT_MS + 1 })
    assert.match(r.paused[0].reason, /^tick_sidecar_restart_unreconciled:/)
  } finally { console.error = orig }
  assert.ok(errs.some(e => /URGENT/.test(e)))
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED' AND sidecar_boot_id = 'BA'`).get(TICK_PRODUCER).n, 2)
})

test('gap 6: with the boot known, a standing row is reused only on its own boot; bootId null keeps the pre-C9 reuse', async () => {
  const db = fresh([A])
  const d = opts()
  await runTickPermitFeeder(db, demo, d.o)
  const first = d.pushes.at(-1).tickPermits.map(p => p.permit.id).sort()
  await runTickPermitFeeder(db, demo, d.o)
  assert.deepEqual(d.pushes.at(-1).tickPermits.map(p => p.permit.id).sort(), first, 'no boot: reused as before')
  assert.equal(d.pushes.at(-1).tickPermits[0].permit.bootId, null)
})

test('gap 6: every reconcile path stamps the account\'s own last_reconcile_at — the SELECTED account too, which used to write only the global key', () => {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', A)
  assert.equal(lastReconcileAt(db, A, null).at, null)
  reconcilePositions(db, [], [], (k, v) => setState(db, k, v)) // the selected pass: a plain setState
  assert.ok(getState(db, 'last_reconcile_at'), 'the global key as before')
  assert.ok(getState(db, `acct:${A}:last_reconcile_at`), 'and the account\'s own key')
  assert.equal(lastReconcileAt(db, A, B).source, 'account', 'readable even when another account is selected')
  reconcilePositions(db, [], [], (k, v) => setState(db, `acct:${B}:${k}`, v), { accountId: B })
  assert.ok(getState(db, `acct:${B}:last_reconcile_at`))
})

test('C9 (found while building): the tick budget counts a monitored position again — openPositionsFor selected a column monitored_positions does not have, so the read threw into its catch and counted none', () => {
  const db = fresh([A])
  bareMonitored(db, A, 'NZDUSD', 'SELL')
  const h = heldWithPending(db, A)
  assert.equal(h.positions, 1, 'RED on origin/main: 0')
  assert.ok(h.symbols.has('NZDUSD'))
  pos(db, A, 'AUDUSD', 'BUY', '900') // linked trades row open: counted once, not twice
  assert.equal(heldWithPending(db, A).positions, 2)
})

test('gap 6 (ledger): reserveStandingPermits with a boot reuses a standing row only on that boot — a row from another boot is superseded and a new permit id issued, stamped with the new boot', async () => {
  const { reserveStandingPermits } = await import('./entry-ledger.js')
  const db = fresh([A])
  const entries = [{ key: 'tick:1', symbol: 'EURUSD', symbolId: 1, volume: null, sides: ['BUY'] }]
  const a = reserveStandingPermits(db, { accountId: A, producerId: TICK_PRODUCER, basis: 'tick', entries, sizeRequired: false, bootId: 'BA' })
  assert.equal(a.issued, 1)
  const again = reserveStandingPermits(db, { accountId: A, producerId: TICK_PRODUCER, basis: 'tick', entries, sizeRequired: false, bootId: 'BA' })
  assert.equal(again.reused, 1, 'same boot: reused')
  assert.equal(again.permits[0].permit.id, a.permits[0].permit.id)
  const b = reserveStandingPermits(db, { accountId: A, producerId: TICK_PRODUCER, basis: 'tick', entries, sizeRequired: false, bootId: 'BB' })
  assert.equal(b.reused, 0); assert.equal(b.issued, 1); assert.equal(b.released, 1)
  assert.notEqual(b.permits[0].permit.id, a.permits[0].permit.id, 'one permit id never crosses a boot')
  assert.equal(db.prepare('SELECT sidecar_boot_id FROM entry_intents WHERE id = ?').get(b.permits[0].permit.intentId).sidecar_boot_id, 'BB')
  const legacy = reserveStandingPermits(db, { accountId: A, producerId: TICK_PRODUCER, basis: 'tick', entries, sizeRequired: false })
  assert.equal(legacy.reused, 1, 'no boot named: the pre-C9 reuse')
})
