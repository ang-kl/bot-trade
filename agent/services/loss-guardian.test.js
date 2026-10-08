// node --test agent/services/loss-guardian.test.js
//
// Loss Guardian: conservative loss-side safety net. Protects NAKED positions
// and enforces an optional time cap; never touches a valid mean-reversion stop.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { decideLossGuardian, loadLossGuardianConfig, DEFAULT_LOSS_GUARDIAN, runLossGuardian } from './loss-guardian.js'

const CFG = { ...DEFAULT_LOSS_GUARDIAN }

// Codex · №12,130 · 2026-10-08; codex-footprint: loss-guardian-ratchet.
// Real pass/database; only the broker boundary is controlled. A tighter stop
// arrives AFTER reconcile, before amend, as in the native ratchet transaction.
async function nakedPass({ side = 'BUY', ledgerSide = side, symbolId = 73,
  tradeSide = side === 'BUY' ? 1 : 2, accountId = '1', snapshotAccount,
  competingStop = null, unchanged = false, failure = null, brokerTp = 110,
  localTp = 111, duringAmendSl = null, policyStampOnly = false,
  amendSymbolId = symbolId, amendSide = side } = {}) {
  const db = initDB(':memory:')
  const sent = [], notices = [], brokerWrites = [], quoteIds = [], metadataIds = []
  let brokerStop = null
  const price = side === 'BUY' ? 99 : 101
  db.prepare(`INSERT INTO trades (symbol,side,ctrader_position_id,status,account_id)
    VALUES ('OWN_SYMBOL',?,'9103','open',?)`).run(ledgerSide, accountId)
  const tradeId = db.prepare(`SELECT id FROM trades WHERE ctrader_position_id='9103'`).get().id
  db.prepare(`INSERT INTO monitored_positions
    (symbol,side,entry_price,current_sl,current_tp,status,source,trade_id,account_id,last_check_action)
    VALUES ('OWN_SYMBOL',?,100,NULL,?,'active','autopilot',?,?,'prior_check')`)
    .run(ledgerSide, localTp, tradeId, accountId)
  const bp = { positionId: 9103, price: 100, takeProfit: brokerTp,
    tradeData: { symbolId, tradeSide, volume: 10000 } }
  if (snapshotAccount !== undefined) bp.ctidTraderAccountId = snapshotAccount
  const creds = { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId }
  const out = await runLossGuardian(db, creds, {
    exec: {
      reconcile: async () => ({ position: [bp] }),
      amendPosition: async (_creds, args) => {
        sent.push(args)
        if (duringAmendSl != null) db.prepare('UPDATE monitored_positions SET current_sl=? WHERE trade_id=?').run(duringAmendSl, tradeId)
        brokerStop = competingStop
        if (failure) throw new Error(failure)
        if (args.ratchetOnly === true) {
          const brokerDir = amendSide === 'BUY' ? 1 : -1
          if (args.expectedSymbolId !== Number(amendSymbolId) || args.expectedDirection !== brokerDir) throw new Error('guard_ratchet_identity')
          if (policyStampOnly) return { unchanged: false, protection: { stopLoss: brokerStop, takeProfit: brokerTp,
            movement: { beforeStopLoss: brokerStop, afterStopLoss: brokerStop, stopMoved: false } } }
          const tight = brokerStop != null && (side === 'BUY' ? brokerStop >= args.stopLoss : brokerStop <= args.stopLoss)
          if (tight || unchanged) return { unchanged: true, protection: { stopLoss: brokerStop, takeProfit: brokerTp } }
        } else if (unchanged) return { unchanged: true, protection: { stopLoss: brokerStop, takeProfit: brokerTp } }
        brokerWrites.push(args.stopLoss)
        brokerStop = args.stopLoss
        // Codex · №12,140 · 2026-10-08; codex-footprint: loss-guardian-ratchet.
        // confirmedMovementProof requires a positive before-stop for tightening;
        // genuine native first installations therefore also have stopMoved:false.
        return { unchanged: false, protection: { stopLoss: brokerStop, takeProfit: brokerTp,
          movement: { beforeStopLoss: null, afterStopLoss: brokerStop, stopMoved: false } } }
      },
    },
    ws: {
      wsGetLastCloses: async (_h,_c,_s,_t,_a,ids) => { quoteIds.push(...ids); return { [symbolId]: price } },
      wsGetTrendbarsBatch: async () => ({}),
    },
    sizing: { getVolumeMeta: async (_h,_c,_s,_t,_a,id) => { metadataIds.push(id); return { lotSize: 10000, digits: 2 } } },
    notify: msg => notices.push(msg),
  })
  const row = db.prepare('SELECT current_sl,current_tp,last_check_action,last_check_at FROM monitored_positions WHERE trade_id=?').get(tradeId)
  const events = db.prepare("SELECT * FROM position_events WHERE source='loss_guardian'").all()
  const actions = db.prepare("SELECT * FROM action_log WHERE path='/loss-guardian'").all()
  db.close()
  return { out, sent, notices, brokerWrites, brokerStop, row, events, actions, quoteIds, metadataIds }
}

for (const [side, competingStop] of [['BUY',99.5], ['SELL',100.5]]) {
  test(`real guardian ${side}: intervening tighter broker stop cannot be widened or counted`, async () => {
    const r = await nakedPass({ side, competingStop })
    assert.equal(r.brokerStop, competingStop, 'ratchet must preserve the competing broker stop')
    assert.deepEqual(r.brokerWrites, [])
    assert.equal(r.out.stops, 0)
    assert.equal(r.row.current_sl, null, 'no stale stop-value overwrite on unchanged')
    assert.equal(r.row.last_check_action, 'prior_check')
    assert.equal(r.row.last_check_at, null)
    assert.deepEqual(r.events, [])
    assert.deepEqual(r.notices, [])
    assert.deepEqual(r.actions, [])
  })
  test(`real guardian ${side}: genuine naked stop is installed with own snapshot identity and TP retained`, async () => {
    const r = await nakedPass({ side })
    const sl = side === 'BUY' ? 98 : 102
    assert.equal(r.out.stops, 1, JSON.stringify(r.out))
    assert.equal(r.sent.length, 1)
    assert.equal(r.sent[0].ratchetOnly, true)
    assert.equal(r.sent[0].expectedDirection, side === 'BUY' ? 1 : -1)
    assert.equal(r.sent[0].expectedSymbolId, 73)
    assert.equal(r.sent[0].ctidTraderAccountId, '1')
    assert.equal(r.sent[0].takeProfit, 110)
    assert.deepEqual(r.quoteIds, [73])
    assert.deepEqual(r.metadataIds, [73])
    assert.equal(r.row.current_sl, sl)
    assert.equal(r.row.current_tp, 111)
    assert.equal(r.events.length, 1)
    assert.equal(r.events[0].kind, 'sl_moved')
    assert.equal(r.events[0].from_value, null)
    assert.equal(r.events[0].to_value, sl)
    assert.equal(r.notices.length, 1)
  })
}

test('real guardian: unchanged response cannot overwrite a concurrently retained stop or create movement evidence', async () => {
  const r = await nakedPass({ unchanged: true, competingStop: 99.5, duringAmendSl: 99.5 })
  assert.equal(r.out.stops, 0)
  assert.equal(r.row.current_sl, 99.5)
  assert.equal(r.row.last_check_action, 'prior_check')
  assert.deepEqual(r.events, [])
  assert.deepEqual(r.notices, [])
  assert.deepEqual(r.actions, [])
})

test('real guardian: accepted policy-only stamp on a competing stop is not a stop installation', async () => {
  const r = await nakedPass({ competingStop: 99.5, policyStampOnly: true })
  assert.equal(r.out.stops, 0)
  assert.equal(r.row.current_sl, null)
  assert.deepEqual(r.brokerWrites, [])
  assert.deepEqual(r.events, [])
  assert.deepEqual(r.notices, [])
})

for (const [label, opts] of [
  ['missing symbol',{symbolId:null}], ['malformed symbol',{symbolId:true}],
  ['fractional symbol',{symbolId:1.5}], ['coerced symbol',{symbolId:'0x49'}],
  ['missing direction',{tradeSide:null}], ['malformed direction',{tradeSide:true}],
  ['conflicting direction',{tradeSide:2}], ['missing ledger direction',{ledgerSide:''}],
  ['conflicting account',{snapshotAccount:'2'}], ['missing account',{accountId:null}],
]) {
  test(`real guardian: ${label} refuses the naked amend without movement evidence`, async () => {
    const r = await nakedPass(opts)
    assert.equal(r.out.refused, 1, JSON.stringify(r.out))
    assert.equal(r.out.stops, 0)
    assert.deepEqual(r.sent, [])
    assert.equal(r.row.current_sl, null)
    assert.deepEqual(r.events, [])
    assert.deepEqual(r.notices, [])
  })
}

for (const failure of ['guard_ratchet_identity','broker_amend_rejected','transport_timeout']) {
  test(`real guardian: ${failure} does not persist or count an unconfirmed stop`, async () => {
    const r = await nakedPass({ failure })
    assert.equal(r.out.stops, 0)
    assert.match(r.out.errors.join(' '), new RegExp(failure))
    assert.equal(r.row.current_sl, null)
    assert.equal(r.row.last_check_action, 'prior_check')
    assert.deepEqual(r.events, [])
    assert.deepEqual(r.notices, [])
  })
}

for (const [label, opts] of [['symbol',{amendSymbolId:74}],['direction',{amendSide:'SELL'}]]) {
  test(`real guardian: broker ${label} changes after reconcile refuse the ratchet before a write`, async () => {
    const r = await nakedPass(opts)
    assert.equal(r.sent.length, 1)
    assert.equal(r.out.stops, 0)
    assert.match(r.out.errors.join(' '), /guard_ratchet_identity/)
    assert.deepEqual(r.brokerWrites, [])
    assert.equal(r.row.current_sl, null)
    assert.deepEqual(r.events, [])
  })
}

test('real guardian: existing ledger TP fallback remains when broker TP is absent', async () => {
  const r = await nakedPass({ brokerTp: null })
  assert.equal(r.out.stops, 1, JSON.stringify(r.out))
  assert.equal(r.sent[0].takeProfit, 111)
})

for (const [side, ledgerSide, tradeSide] of [['BUY','long','BUY'],['SELL','short','SELL'],['BUY','BUY','1'],['SELL','SELL','2']]) {
  test(`real guardian: ${ledgerSide}/${tradeSide} valid broker direction retains naked-stop protection`, async () => {
    const r = await nakedPass({ side, ledgerSide, tradeSide })
    assert.equal(r.out.stops, 1, JSON.stringify(r.out))
    assert.equal(r.sent[0].expectedDirection, side === 'BUY' ? 1 : -1)
    assert.equal(r.row.current_sl, side === 'BUY' ? 98 : 102)
  })
}

test('defaults: on, scope all; saved values merge; explicit off wins', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadLossGuardianConfig(db), DEFAULT_LOSS_GUARDIAN)
  assert.equal(DEFAULT_LOSS_GUARDIAN.on, true)
  setState(db, 'loss_guardian_json', JSON.stringify({ on: false }))
  assert.equal(loadLossGuardianConfig(db).on, false)
  setState(db, 'loss_guardian_json', JSON.stringify({ maxHoldHours: 12 }))
  assert.equal(loadLossGuardianConfig(db).maxHoldHours, 12)
  assert.equal(loadLossGuardianConfig(db).on, true) // default preserved
})

test('a position that already HAS a stop is never touched (respect the plan)', () => {
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 96, currentSl: 94, atr: 1, digits: 2, ageHours: 20 })
  assert.equal(d.action, null)
})

test('naked long, still inside the cap → protective stop at maxAtrMult×ATR from entry', () => {
  // dist = 3 × 1 = 3 → SL at 97; price 98.5 is above it → set the stop
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 98.5, currentSl: null, atr: 1, digits: 2, ageHours: 5 })
  assert.equal(d.action.sl, 97)
  assert.match(d.reason, /protective stop/)
})

test('naked short, still inside → protective stop above entry', () => {
  const d = decideLossGuardian(CFG, { side: 'SELL', entry: 100, price: 101.5, currentSl: null, atr: 1, digits: 2, ageHours: 5 })
  assert.equal(d.action.sl, 103) // 100 + 3×1
})

test('naked position already beyond max loss → close, do not set an unreachable stop', () => {
  // dist 3 → level 97; price 95 is BELOW it (long already blown through) → close
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 95, currentSl: null, atr: 1, digits: 2, ageHours: 5 })
  assert.equal(d.action.close, true)
  assert.match(d.reason, /beyond max loss/)
})

test('ATR unavailable → falls back to fallbackAdversePct of entry', () => {
  // 2% of 100 = 2 → SL at 98; price 99 above → set
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 99, currentSl: null, atr: null, digits: 2, ageHours: 1 })
  assert.equal(d.action.sl, 98)
})

test('time cap breached → close even if a stop exists', () => {
  const cfg = { ...CFG, maxHoldHours: 10 }
  const d = decideLossGuardian(cfg, { side: 'BUY', entry: 100, price: 99, currentSl: 95, atr: 1, digits: 2, ageHours: 12 })
  assert.equal(d.action.close, true)
  assert.match(d.reason, /time_cap/)
})

test('time cap off by default → a stopped position inside the cap holds', () => {
  const d = decideLossGuardian(CFG, { side: 'BUY', entry: 100, price: 90, currentSl: 88, atr: 1, digits: 2, ageHours: 200 })
  assert.equal(d.action, null) // maxHoldHours null → never time-cap; has a stop → untouched
})

test('position with its OWN time_cap_at → guardian time cap defers (hardening 6d)', () => {
  const cfg = { ...CFG, maxHoldHours: 10 }
  // Same breach as the close case above, but the position-manager owns this
  // position's clock — the guardian must not close it early.
  const d = decideLossGuardian(cfg, { side: 'BUY', entry: 100, price: 99, currentSl: 95, atr: 1, digits: 2, ageHours: 12, hasOwnTimeCap: true })
  assert.equal(d.action, null)
})

test('own time cap defers ONLY the time cap — naked-position protection still applies', () => {
  const cfg = { ...CFG, maxHoldHours: 10 }
  const d = decideLossGuardian(cfg, { side: 'BUY', entry: 100, price: 98.5, currentSl: null, atr: 1, digits: 2, ageHours: 12, hasOwnTimeCap: true })
  assert.equal(d.action.sl, 97) // protective stop still placed
})

test('Wave 2 (§K·6): the loss guardian skips a momentum-book row (no time_cap_at → its maxHoldHours backstop would otherwise reach a weeks-horizon runner) and counts it', async () => {
  const { runLossGuardian } = await import('./loss-guardian.js')
  const db = initDB(':memory:')
  setState(db, 'loss_guardian_json', JSON.stringify({ on: true, scope: 'all', maxHoldHours: 1 }))
  db.prepare(`INSERT INTO trades (symbol, side, ctrader_position_id, status, account_id, opened_at) VALUES ('NATGAS', 'BUY', '9101', 'open', '1', datetime('now', '-3 days'))`).run()
  const tradeId = db.prepare(`SELECT id FROM trades WHERE ctrader_position_id = '9101'`).get().id
  db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, status, source, trade_id, account_id, created_at) VALUES ('NATGAS', 'long', 2.9, 2.7, 'active', 'autopilot', ?, '1', datetime('now', '-3 days'))`).run(tradeId)
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, status, note, entered_at) VALUES (?, '1', 'NATGAS', '9101', 'open', 'test', datetime('now', '-3 days'))`).run(tradeId)
  const closes = []
  const out = await runLossGuardian(db, { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }, {
    exec: { reconcile: async () => ({ position: [{ positionId: 9101, price: 2.9, stopLoss: 2.7, tradeData: { symbolId: 1, volume: 10000, tradeSide: 1 } }] }), closePosition: async (...a) => { closes.push(a); return { ok: true } } },
    ws: { wsGetLastCloses: async () => ({ 1: 2.85 }), wsGetTrendbarsBatch: async () => ({}) },
    sizing: { getVolumeMeta: async () => ({ lotSize: 10000, digits: 3 }) },
    notify: () => {},
  })
  assert.equal(out.bookSkipped, 1, 'the book row is named as skipped')
  assert.equal(out.checked, 0)
  assert.deepEqual(closes, [], 'nothing was closed')
})

test('V3 M5: the stop the guardian puts on a naked position is timed in the amend-latency ring', async () => {
  const { runLossGuardian } = await import('./loss-guardian.js')
  const { _resetAmendLatencyForTests, _amendLatencyStateForTests } = await import('./protection-latency.js')
  _resetAmendLatencyForTests()
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (symbol, side, ctrader_position_id, status, account_id, opened_at) VALUES ('NATGAS', 'BUY', '9102', 'open', '1', datetime('now'))`).run()
  const tradeId = db.prepare(`SELECT id FROM trades WHERE ctrader_position_id = '9102'`).get().id
  db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, status, source, trade_id, account_id) VALUES ('NATGAS', 'BUY', 2.9, NULL, 'active', 'autopilot', ?, '1')`).run(tradeId)
  const sent = []
  const out = await runLossGuardian(db, { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }, {
    exec: {
      reconcile: async () => ({ position: [{ positionId: 9102, price: 2.9, takeProfit: 3.1, tradeData: { symbolId: 1, volume: 10000, tradeSide: 1 } }] }),
      amendPosition: async (_c, args) => { sent.push(args); return { executionType: 'ORDER_REPLACED' } },
    },
    ws: { wsGetLastCloses: async () => ({ 1: 2.85 }), wsGetTrendbarsBatch: async () => ({}) },
    sizing: { getVolumeMeta: async () => ({ lotSize: 10000, digits: 3 }) },
    notify: () => {},
  })
  assert.equal(out.stops, 1, JSON.stringify(out))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].takeProfit, 3.1, 'the payload is what it always was')
  const { amends } = _amendLatencyStateForTests()
  assert.equal(amends.length, 1, 'one amend sent, one amend timed')
  assert.deepEqual([amends[0].path, amends[0].source, amends[0].positionId, amends[0].account, amends[0].outcome],
    ['loss_guardian', 'loss_guardian', '9102', '…1', 'ok'])
})
