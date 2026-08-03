// node --test agent/services/loss-cap.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { DEFAULT_LOSS_CAP, loadLossCapConfig, effectiveCapUsd, runLossCap, runLossCapAllAccounts, migrateLossCapConfig } from './loss-cap.js'

function freshDB() {
  const db = initDB(':memory:')
  setState(db, 'account_balance_usd', '10000')
  setState(db, 'symbol_id_map', JSON.stringify({ 'GOOGL.US': 7, EURUSD: 1 }))
  return db
}

const CREDS = { ready: true, host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '42' }

function fakeDeps({ positions, pnl }) {
  const closed = []
  const notes = []
  return {
    closed, notes,
    exec: {
      reconcile: async () => ({ position: positions }),
      closePosition: async (creds, args) => { closed.push(args) },
    },
    ws: { wsGetUnrealizedPnl: async () => pnl },
    notify: async (text) => { notes.push(text) },
  }
}

const GOOGL = { positionId: 11, tradeData: { symbolId: 7, tradeSide: 'BUY', volume: 100 } }

test('defaults: on, both cap shapes present, % cap 1 with a $50 floor, action close', () => {
  const db = freshDB()
  assert.deepEqual(loadLossCapConfig(db), DEFAULT_LOSS_CAP)
  assert.equal(DEFAULT_LOSS_CAP.on, true)
  // Owner 2026-08-03: 1% with a $50 floor. Was 2% and no floor.
  assert.equal(DEFAULT_LOSS_CAP.maxLossPctOfBalance, 1)
  assert.equal(DEFAULT_LOSS_CAP.minCapUsd, 50)
  assert.equal(DEFAULT_LOSS_CAP.maxLossUsd, null)
  assert.equal(DEFAULT_LOSS_CAP.action, 'close')
})

test('effectiveCapUsd: tighter of $ and % applies; null when both off', () => {
  assert.equal(effectiveCapUsd({ maxLossUsd: 500, maxLossPctOfBalance: 2 }, 10000), 200)
  assert.equal(effectiveCapUsd({ maxLossUsd: 150, maxLossPctOfBalance: 2 }, 10000), 150)
  assert.equal(effectiveCapUsd({ maxLossUsd: 500, maxLossPctOfBalance: null }, 10000), 500)
  assert.equal(effectiveCapUsd({ maxLossUsd: null, maxLossPctOfBalance: 2 }, null), null) // % cap never guesses without a balance
  assert.equal(effectiveCapUsd({ maxLossUsd: null, maxLossPctOfBalance: null }, 10000), null)
})

test('breach closes the position, records the event, and notifies', async () => {
  const db = freshDB() // 2% of 10000 → $200 cap
  const deps = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  const r = await runLossCap(db, CREDS, deps)
  assert.equal(r.breaches, 1)
  assert.equal(r.closes, 1)
  assert.deepEqual(deps.closed[0], { positionId: 11, volume: 100 })
  assert.match(deps.notes[0], /CLOSED GOOGL\.US BUY/)
  const ev = db.prepare(`SELECT * FROM position_events WHERE kind = 'loss_cap_close'`).get()
  assert.ok(ev)
  assert.match(ev.reason, /breached/)
})

test('inside the cap → no action', async () => {
  const db = freshDB()
  // Balance $10,000. Under the OLD 2% default the cap was $200 and −150 sat
  // inside it; under the owner's 1% (floored at $50) the cap is $100 and −150
  // now BREACHES. The test used a literal that encoded the old policy, so it
  // is re-expressed against the new one rather than pinned to a number.
  const deps = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -50 } } })
  const r = await runLossCap(db, CREDS, deps)
  assert.equal(r.checked, 1)
  assert.equal(r.breaches, 0)
  assert.equal(deps.closed.length, 0)
})

test('alert-only mode notifies without closing', async () => {
  const db = freshDB()
  setState(db, 'loss_cap_json', JSON.stringify({ action: 'alert' }))
  const deps = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  const r = await runLossCap(db, CREDS, deps)
  assert.equal(r.breaches, 1)
  assert.equal(r.closes, 0)
  assert.equal(deps.closed.length, 0)
  assert.match(deps.notes[0], /alert-only/)
})

test('retry guard: a breach does not re-fire inside retryMinutes', async () => {
  const db = freshDB()
  const t0 = Date.now()
  const deps1 = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  await runLossCap(db, CREDS, { ...deps1, now: t0 })
  const deps2 = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  const r2 = await runLossCap(db, CREDS, { ...deps2, now: t0 + 5 * 60_000 })
  assert.equal(r2.breaches, 1)
  assert.equal(deps2.closed.length, 0) // suppressed — inside the 10-min retry window
  const deps3 = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  const r3 = await runLossCap(db, CREDS, { ...deps3, now: t0 + 11 * 60_000 })
  assert.equal(r3.closes, 1) // past the window → retried
})

test("scope 'bot' skips positions not in the ledger", async () => {
  const db = freshDB()
  setState(db, 'loss_cap_json', JSON.stringify({ scope: 'bot' }))
  const deps = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  const r = await runLossCap(db, CREDS, deps)
  assert.equal(r.checked, 0) // pid 11 has no monitored_positions/trades row
  assert.equal(deps.closed.length, 0)
})

test('off switch and missing creds are no-ops', async () => {
  const db = freshDB()
  setState(db, 'loss_cap_json', JSON.stringify({ on: false }))
  const deps = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  assert.deepEqual(await runLossCap(db, CREDS, deps), { checked: 0, breaches: 0, closes: 0, errors: [] })
  const db2 = freshDB()
  assert.deepEqual(await runLossCap(db2, { ready: false }, deps), { checked: 0, breaches: 0, closes: 0, errors: [] })
})

test('close failure lands in errors and notifies for manual action', async () => {
  const db = freshDB()
  const deps = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  deps.exec.closePosition = async () => { throw new Error('MARKET_CLOSED') }
  const r = await runLossCap(db, CREDS, deps)
  assert.equal(r.closes, 0)
  assert.equal(r.errors.length, 1)
  assert.match(deps.notes[0], /FAILED to close/)
})

// ---------------------------------------------------------------------------
// 2026-08-03 — the cap was ON, configured, action:'close', and a USDZAR
// position still reached −$2,186.29 against an $800 cap.
//
// It was not off and not misconfigured. It ran for ONE account: runLossCap
// takes `creds`, creds carry a single accountId from `ctrader_account_id`, and
// wsGetUnrealizedPnl is asked about that one account. `scope:'all'` means
// every position ON THAT ACCOUNT. Every other enabled account had no
// per-position loss cap at all.
// ---------------------------------------------------------------------------

test('the $50 floor lifts a cap that a small balance would make useless', () => {
  const cfg = { maxLossUsd: null, maxLossPctOfBalance: 1, minCapUsd: 50 }
  // 1% of $1,440 is $14.40 — tight enough that ordinary noise closes
  // everything, which is an off switch with extra steps, not a risk control.
  assert.equal(effectiveCapUsd(cfg, 1440), 50)
  // On a large account the percentage governs and the floor is irrelevant.
  assert.equal(effectiveCapUsd(cfg, 50000), 500)
})

test('the floor never TIGHTENS a cap — it is a floor, not a second limit', () => {
  const cfg = { maxLossUsd: 20, maxLossPctOfBalance: 1, minCapUsd: 50 }
  // The absolute cap is $20 and the floor is $50: the floor lifts it to $50.
  // A floor that could lower a cap would be a silent extra limit.
  assert.equal(effectiveCapUsd(cfg, 50000), 50)
})

test('no floor configured behaves exactly as before', () => {
  assert.equal(effectiveCapUsd({ maxLossPctOfBalance: 1, minCapUsd: null }, 1440), 14.4)
  assert.equal(effectiveCapUsd({ maxLossPctOfBalance: 1 }, 1440), 14.4)
})

test('the config migration is one-time, and never drags a later change back', () => {
  const store = new Map()
  const gs = (_db, k) => (store.has(k) ? store.get(k) : null)
  const ss = (_db, k, v) => store.set(k, v)
  store.set('loss_cap_json', JSON.stringify({ on: true, maxLossUsd: 800, maxLossPctOfBalance: 2, retryMinutes: 3 }))

  const first = migrateLossCapConfig({}, { getState: gs, setState: ss })
  assert.equal(first.applied, true)
  const applied = JSON.parse(store.get('loss_cap_json'))
  assert.equal(applied.maxLossPctOfBalance, 1)
  assert.equal(applied.minCapUsd, 50)
  // Fields the owner did not name are preserved exactly.
  assert.equal(applied.maxLossUsd, 800)
  assert.equal(applied.retryMinutes, 3)
  assert.equal(applied.action, 'close')

  // The operator later moves the cap from the Risk page.
  store.set('loss_cap_json', JSON.stringify({ ...applied, maxLossPctOfBalance: 3 }))
  const second = migrateLossCapConfig({}, { getState: gs, setState: ss })
  assert.equal(second.applied, false, 'a migration that re-applies is a setting the operator cannot change')
  assert.equal(JSON.parse(store.get('loss_cap_json')).maxLossPctOfBalance, 3)
})

test('THE GAP: the sweep now covers every enabled account, not just the selected one', async () => {
  const db = initDB(':memory:')
  setState(db, 'account_balance_usd', '50000')
  db.prepare(`INSERT INTO accounts (account_id, enabled, is_live, mode) VALUES (?,1,0,'active')`).run('AAA')
  db.prepare(`INSERT INTO accounts (account_id, enabled, is_live, mode) VALUES (?,1,0,'active')`).run('BBB')
  db.prepare(`INSERT INTO accounts (account_id, enabled, is_live, mode) VALUES (?,0,0,'active')`).run('CCC')
  db.prepare(`INSERT INTO accounts (account_id, enabled, is_live, mode) VALUES (?,1,1,'active')`).run('LIVE1')
  setState(db, 'ctrader_account_id', 'AAA')

  const seen = []
  const deps = {
    exec: { reconcile: async (c) => { seen.push(String(c.accountId)); return { position: [] } }, closePosition: async () => ({}) },
    ws: { wsGetUnrealizedPnl: async () => ({}) },
    notify: async () => {},
  }
  const base = { ready: true, accountId: 'AAA', isLive: false, host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't' }
  const out = await runLossCapAllAccounts(db, base, deps)

  assert.ok(seen.includes('AAA'), 'the selected account is still swept')
  assert.ok(seen.includes('BBB'), 'THE BUG: a second enabled account was never checked before this change')
  assert.ok(!seen.includes('CCC'), 'a disabled account is not swept')
  assert.ok(!seen.includes('LIVE1'), 'a LIVE account is never swept with demo credentials — one token reaches one host')
  assert.equal(out.accounts, seen.length)
})

test('one failing account does not stop the sweep of the others', async () => {
  const db = initDB(':memory:')
  // The balance MUST be set: with no balance and no absolute cap the sweep
  // correctly returns before touching the broker, and the test would pass for
  // the wrong reason.
  setState(db, 'account_balance_usd', '50000')
  db.prepare(`INSERT INTO accounts (account_id, enabled, is_live, mode) VALUES (?,1,0,'active')`).run('AAA')
  db.prepare(`INSERT INTO accounts (account_id, enabled, is_live, mode) VALUES (?,1,0,'active')`).run('BBB')
  setState(db, 'ctrader_account_id', 'AAA')
  const seen = []
  const deps = {
    exec: {
      reconcile: async (c) => {
        seen.push(String(c.accountId))
        if (String(c.accountId) === 'AAA') throw new Error('broker timeout')
        return { position: [] }
      },
      closePosition: async () => ({}),
    },
    ws: { wsGetUnrealizedPnl: async () => ({}) },
    notify: async () => {},
  }
  const base = { ready: true, accountId: 'AAA', isLive: false, host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't' }
  const out = await runLossCapAllAccounts(db, base, deps)
  // A sweep that dies on the first account and silently skips the rest would
  // recreate the original bug in a new shape.
  assert.ok(seen.includes('BBB'), 'the second account must still be swept after the first threw')
  assert.equal(out.errors.length, 1)
  assert.match(out.errors[0], /AAA/)
})
