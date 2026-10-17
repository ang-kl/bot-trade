// node --test agent/services/naked-guard-all-accounts.test.js
//
// Claude · № 15,282 17-Oct (owner: "F-NEW-2 naked stop, all accounts";
// claude-builder). A naked position on a NON-selected account gets the Loss
// Guardian's protective stop through the all-accounts protection audit.
//
// Expected outcome sourced from production, not from this design: live
// 42993489 ADAUSD #1944 (pos 628184260) held no broker stop from 16-10
// 21:19:50Z to 17-10 04:15Z while the audit printed "1 naked" every minute and
// the guardian, run with the selected account's credentials (46130058), never
// reached it. The stop value itself (entry ± maxAtrMult×ATR, rounded) is the
// guardian's existing rule — self-derived here, not re-tested.
//
// Real audit + real Loss Guardian + in-memory database; only the broker
// boundary (reconcile, quotes, bars, metadata, amend) is controlled.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { runProtectionAuditAllAccounts } from './naked-position-guard.js'
import { __resetInFlight, singleFlight } from './acting-layer.js'

const SELECTED = '46130058'
const OTHER = '47790949'
let db

beforeEach(() => {
  __resetInFlight()
  db = initDB(':memory:')
  for (const id of [SELECTED, OTHER]) {
    db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,0,1,'active')").run(id)
  }
})

function seed(acct, posId, { side = 'short', sl = null, tp = 0.215, source = 'autopilot' } = {}) {
  const t = db.prepare(
    "INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id,entry_price) VALUES ('ADAUSD',?,'open',?,?,0.223)"
  ).run(side, acct, posId)
  db.prepare(
    "INSERT INTO monitored_positions (trade_id,symbol,side,status,account_id,entry_price,current_sl,current_tp,source) VALUES (?,'ADAUSD',?,'active',?,0.223,?,?,?)"
  ).run(t.lastInsertRowid, side, acct, sl, tp, source)
}

const inertTp = {
  makeTargetSuggester: () => async () => null,
  makeTargetApplier: () => async () => ({ ok: false, error: 'inert in test' }),
}

// The broker: per account, its own positions only.
function broker(book) {
  const amends = []
  const snapshot = (accountId) => (book[accountId] || []).map(p => ({
    positionId: p.positionId, price: 0.223, stopLoss: p.stopLoss ?? null, takeProfit: 0.215,
    tradeData: { symbolId: 10, tradeSide: 2, volume: 14 },
  }))
  const exec = {
    reconcile: async (c) => ({ position: snapshot(String(c.accountId)) }),
    amendPosition: async (c, args) => {
      amends.push({ account: String(c.accountId), ...args })
      return { unchanged: false, protection: { stopLoss: args.stopLoss, takeProfit: args.takeProfit,
        movement: { beforeStopLoss: null, afterStopLoss: args.stopLoss, stopMoved: false } } }
    },
    closePosition: async () => { throw new Error('no close expected') },
  }
  const lossGuardianDeps = {
    exec,
    ws: {
      wsGetLastCloses: async () => ({ 10: 0.2245 }),
      // 14+ one-hour bars of range 0.001 → ATR 0.001; 3×ATR = 0.003 → short stop 0.226.
      wsGetTrendbarsBatch: async () => ({ '1h': Array.from({ length: 50 }, () => ({ h: 0.2245, l: 0.2235, c: 0.224 })) }),
    },
    sizing: { getVolumeMeta: async () => ({ lotSize: 100, digits: 4 }) },
  }
  return { exec, amends, lossGuardianDeps }
}

const creds = { ready: true, isLive: false, accountId: SELECTED, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't' }

test('a naked position on a NON-selected account gets the guardian stop, on that account only', async () => {
  seed(SELECTED, '111', { sl: 0.23 })
  seed(OTHER, '628184260')
  const b = broker({ [SELECTED]: [{ positionId: '111', stopLoss: 0.23 }], [OTHER]: [{ positionId: '628184260' }] })
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec: b.exec, lossGuardianDeps: b.lossGuardianDeps })
  assert.equal(out.naked, 1)
  assert.equal(out.nakedStops, 1, 'the naked position on the other account got a stop')
  assert.equal(b.amends.length, 1)
  const a = b.amends[0]
  assert.equal(a.account, OTHER, 'amended with THAT account\'s credentials')
  assert.equal(String(a.ctidTraderAccountId), OTHER)
  assert.equal(a.positionId, 628184260)
  assert.equal(a.ratchetOnly, true, 'never widens a stop that appeared meanwhile')
  assert.equal(a.expectedDirection, -1)
  assert.ok(a.stopLoss > 0.2245, 'a short\'s stop sits above the price')
  assert.equal(a.takeProfit, 0.215, 'the target is kept')
  const row = db.prepare("SELECT current_sl FROM monitored_positions WHERE account_id = ?").get(OTHER)
  assert.equal(row.current_sl, a.stopLoss, 'the book records the stop the broker accepted')
})

test('no naked position: the guardian is not run by the audit', async () => {
  seed(OTHER, '628184260', { sl: 0.2264 })
  const b = broker({ [OTHER]: [{ positionId: '628184260', stopLoss: 0.2264 }] })
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec: b.exec, lossGuardianDeps: b.lossGuardianDeps })
  assert.equal(out.naked, 0)
  assert.equal(out.nakedStops, 0)
  assert.equal(b.amends.length, 0)
})

test('the guardian already in flight: the naked finding is deferred and said, never reported as guarded', async () => {
  seed(OTHER, '628184260')
  const b = broker({ [OTHER]: [{ positionId: '628184260' }] })
  let release
  const held = singleFlight('loss_guardian', () => new Promise(r => { release = r }))
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec: b.exec, lossGuardianDeps: b.lossGuardianDeps })
  release({}); await held
  assert.equal(out.naked, 1)
  assert.equal(out.nakedStops, 0)
  assert.equal(out.nakedDeferred, 1, 'deferred to the next sweep, counted')
  assert.equal(b.amends.length, 0)
})

test('a naked broker position whose ledger side contradicts the broker is refused, not amended', async () => {
  seed(OTHER, '628184260', { side: 'long' }) // broker says SELL (tradeSide 2)
  const b = broker({ [OTHER]: [{ positionId: '628184260' }] })
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec: b.exec, lossGuardianDeps: b.lossGuardianDeps })
  assert.equal(out.naked, 1)
  assert.equal(out.nakedStops, 0)
  assert.equal(b.amends.length, 0)
  assert.ok(out.errors.some(e => /naked guard — .*identity/.test(e)), 'the refusal is named')
})
