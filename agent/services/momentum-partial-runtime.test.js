// node --test agent/services/momentum-partial-runtime.test.js
//
// V3 T3 (P0-2, corrected): the partial manager's pass, run each main-loop
// cycle. Every test drives runMomentumPartialPass itself against a real
// database; broker traffic goes through an injected adapter that records
// every read, quote and close, or through test-support/fake-broker.js and the
// real adapter for the end-to-end case.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { parse } from 'acorn'
import { initDB, getState, setState } from '../db.js'
import { tempDir } from '../test-support/temp-dir.js'
import { startFakeBroker } from '../test-support/fake-broker.js'
import { invalidateSidecarSession } from '../lib/exec-engine.js'
import { registerPartialPlan, readPartialPlan } from './momentum-partial-manager.js'
import { makeMomentumPartialBroker } from './momentum-partial-broker.js'
import { planMomentumTargets } from './momentum-target-policy.js'
import { markKey } from './book-open-drawdown.js'
import { runMomentumBook, MOMENTUM_BOOK_CONFIG_KEY, MOMENTUM_BOOK_STATE_KEY, TSMOM_STRATEGY } from './momentum-book.js'
import { MOMENTUM_ACCOUNT_KEY } from './momentum-account.js'
import { MOMENTUM_SHADOW_STATE_KEY } from './momentum-shadow.js'
import { setStage } from './stage-matrix.js'
import { runMomentumPartialPass, readMomentumPartialPass, prefilterVerdict, recordPartialScaleOuts, partialPassForAccount, partialPassFreshness,
  BOOK_STATE_KEY, MOMENTUM_PARTIAL_PASS_KEY, PARTIAL_PASS_DEFAULTS } from './momentum-partial-runtime.js'

const AT = 1790264000000
const BUY = planMomentumTargets({ side: 'BUY', entry: 100, originalStop: 90, requiredRr: 3,
  costReservePrice: 0.4, digits: 2, volume: 10000, minVolume: 100, stepVolume: 100 })
const SELL = planMomentumTargets({ side: 'SELL', entry: 100, originalStop: 110, requiredRr: 3,
  costReservePrice: 0.4, digits: 2, volume: 10000, minVolume: 100, stepVolume: 100 })
const HOSTS = ['demo.ctraderapi.com', 'live.ctraderapi.com']

// The plan the tests rely on: trigger 130.4 (BUY) / 69.6 (SELL), R = 10, so
// the pre-filter margin is 2.5.
assert.equal(BUY.trigger, 130.4); assert.equal(SELL.trigger, 69.6); assert.equal(BUY.initialRisk, 10)

/**
 * One database holding one plan per account, each with an open trade row, an
 * open book row, and a scripted broker per account. Every broker call is
 * logged with the account of the credentials it was made with.
 */
function scene(t, { accounts = ['11'], host = 'demo.ctraderapi.com', plan = BUY, dbPath = null } = {}) {
  let db = dbPath ? initDB(dbPath) : initDB(':memory:')
  t.after(() => { try { db.close() } catch { /* closed by the test */ } })
  const s = { clock: AT, calls: [], adapters: 0, credsReads: 0, broker: {}, host }
  accounts.forEach((accountId, i) => {
    const tradeId = 7 + i, positionId = String(33 + i)
    db.prepare(`INSERT INTO trades(id,symbol,side,status,account_id,origin,risk_event_id,entry_price,sl_price,tp_price,volume,label_strategy,ctrader_position_id)
      VALUES(?,?,?,'open',?,'bot_market_dispatch',1,100,?,?,1,'tsmom_long',?)`).run(tradeId, `SYM${i}`, plan.side, accountId, plan.originalStop, plan.brokerTarget, positionId)
    db.prepare(`INSERT INTO momentum_book(trade_id,account_id,symbol,position_id,side,entry_price,stop,status,entered_at)
      VALUES(?,?,?,?,?,100,?,'open','2026-09-20T00:00:00Z')`).run(tradeId, accountId, `SYM${i}`, positionId, plan.side === 'BUY' ? 'long' : 'short', plan.originalStop)
    registerPartialPlan(db, { accountId, tradeId, positionId, plan, evidenceId: `fixture:${tradeId}`,
      identity: { host, accountId, symbolId: String(22 + i) } })
    s.broker[accountId] = { tradeId, positionId, volume: plan.volume, bid: 120, ask: 120.1 }
  })
  s.now = () => s.clock
  s.credsFor = accountId => { s.credsReads++; return { accountId, host, ready: true, clientId: 'c', clientSecret: 's', accessToken: 't' } }
  s.adapterFor = (_db, { identity, tradeId }) => {
    s.adapters++
    const b = s.broker[identity.accountId]
    assert.equal(tradeId, b.tradeId, 'the adapter is built for the plan of its own account')
    const log = (op, creds) => {
      assert.equal(String(creds.accountId), identity.accountId, `${op} used another account's credentials`)
      s.calls.push([op, identity.accountId])
    }
    return {
      now: s.now, maxAgeMs: 5000, timeoutMs: 1000,
      readOwnership: () => ({ accountId: identity.accountId, tradeId, positionId: b.positionId, status: 'open', owner: 'momentum_book',
        guardActive: false, entry: 100, initialRisk: 10, side: plan.side }),
      preflight: creds => { log('preflight', creds); return true },
      readPosition: async creds => {
        log('read', creds)
        return b.volume ? { accountId: identity.accountId, positionId: b.positionId, side: plan.side, entry: 100, volume: b.volume,
          stopLoss: plan.originalStop, takeProfit: plan.brokerTarget, observedAtMs: s.clock }
          : { accountId: identity.accountId, positionId: b.positionId, absent: true, observedAtMs: s.clock }
      },
      quote: async creds => { log('quote', creds); return { accountId: identity.accountId, positionId: b.positionId, bid: b.bid, ask: b.ask, observedAtMs: s.clock } },
      close: async (creds, order) => {
        log('close', creds)
        b.volume -= order.volume
        return { accountId: identity.accountId, positionId: b.positionId, dealId: '9001', orderId: '8001', closedVolume: order.volume,
          price: plan.side === 'BUY' ? b.bid : b.ask, executedAtMs: s.clock }
      },
    }
  }
  s.pass = (extra = {}) => runMomentumPartialPass(db, { credsFor: s.credsFor, now: s.now, log: () => {}, deps: { adapterFor: s.adapterFor, ...extra } })
  // A mark as the book writes it (momentum-book.js): `at` the pass clock,
  // `bt` the bar's own epoch. `bt: null` writes a mark without a bar stamp.
  s.mark = (accountId, c, bt = s.clock, at = s.clock) => {
    const st = JSON.parse(getState(db, BOOK_STATE_KEY) || '{"marks":{}}')
    st.marks[markKey(accountId, `SYM${accounts.indexOf(accountId)}`)] = bt === null ? { c, at } : { c, at, bt }
    setState(db, BOOK_STATE_KEY, JSON.stringify(st))
  }
  s.row = (accountId = accounts[0]) => readPartialPlan(db, accountId, s.broker[accountId].tradeId)
  s.ops = op => s.calls.filter(c => c[0] === op).length
  s.db = () => db
  s.reopen = () => { db.close(); db = initDB(dbPath) }
  return s
}

test('the book state key the pre-filter reads is the book\'s own', () => {
  assert.equal(BOOK_STATE_KEY, MOMENTUM_BOOK_STATE_KEY)
})

test('zero broker calls and no credential read with the plan table absent or empty; the pass still records that it ran', async t => {
  // Absent: a fresh agent database has no plan table at all.
  const db = initDB(':memory:'); t.after(() => db.close())
  let adapters = 0, creds = 0
  const deps = { adapterFor: () => { adapters++; throw Error('no broker call expected') } }
  const out = await runMomentumPartialPass(db, { credsFor: () => { creds++; return null }, now: () => AT, deps })
  assert.equal(out.ok, true); assert.equal(out.activePlans, 0)
  assert.equal(adapters, 0); assert.equal(creds, 0)
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('momentum_partial_plans','momentum_target_intents')").get().n, 0,
    'the pass never creates the plan or intent tables')
  assert.equal(readMomentumPartialPass(db).at, new Date(AT).toISOString())
  // Empty: the table exists (a plan was registered and has since reached a
  // terminal state) — still nothing to do.
  const s = scene(t)
  s.db().prepare("UPDATE momentum_partial_plans SET state='CONFIRMED'").run()
  const empty = await s.pass()
  assert.equal(empty.activePlans, 0); assert.equal(s.adapters, 0); assert.equal(s.credsReads, 0); assert.equal(s.calls.length, 0)
})

test('the pre-filter: a fresh mark far from the trigger makes zero broker calls; beyond it, one read-quote-send path to CONFIRMED', async t => {
  for (const host of HOSTS) {
    const s = scene(t, { host })
    s.mark('11', 120)                                  // 10.4 short of 130.4, margin 2.5
    const far = await s.pass()
    assert.equal(s.adapters, 0, `${host}: no adapter, no broker call`)
    assert.equal(s.calls.length, 0)
    assert.equal(far.accounts['11'].prefiltered, 1)
    assert.equal(s.row().state, 'ARMED')
    s.clock += 61_000
    s.mark('11', 131); s.broker['11'].bid = 130.5; s.broker['11'].ask = 130.6
    const beyond = await s.pass()
    assert.equal(s.row().state, 'CONFIRMED', `${host}: ${JSON.stringify(beyond.accounts)}`)
    assert.deepEqual([s.ops('read'), s.ops('quote'), s.ops('close')], [2, 1, 1], `${host}: preflight read, quote, one close, readback`)
    assert.equal(s.broker['11'].volume, BUY.runnerVolume)
  }
})

test('a SELL plan is filtered on its own side: a mark far above the trigger skips, a near one reads', async t => {
  const s = scene(t, { plan: SELL })
  s.broker['11'].bid = 80; s.broker['11'].ask = 80.1
  s.mark('11', 80)
  await s.pass()
  assert.equal(s.calls.length, 0)
  s.clock += 61_000
  s.mark('11', 71)                                     // 1.4 above 69.6, inside the 2.5 margin
  await s.pass()
  assert.equal(s.ops('read'), 1, 'near the trigger: the authoritative read runs')
  assert.equal(s.ops('close'), 0, 'the ask (80.1) has not reached 69.6')
})

test('a stale mark, a missing mark or a closed ledger row forces an authoritative read', async t => {
  const stale = scene(t)
  stale.mark('11', 120, AT - PARTIAL_PASS_DEFAULTS.markMaxAgeMs - 1)
  await stale.pass()
  assert.equal(stale.ops('read'), 1, 'a far mark older than the maximum age is not a price')
  const none = scene(t)
  await none.pass()
  assert.equal(none.ops('read'), 1)
  const closed = scene(t)
  closed.mark('11', 120)
  closed.db().prepare("UPDATE momentum_book SET status='exit_sent'").run()
  await closed.pass()
  assert.equal(closed.ops('read'), 1, 'the mark of a row the book has exited never suppresses the read')
  const future = scene(t)
  future.mark('11', 120, AT + 60_000)
  await future.pass()
  assert.equal(future.ops('read'), 1, 'a mark stamped in the future is not fresh')
})

// T3 checker BLOCKER 1: the book writes `at: now` every pass, but its close
// comes from the scan's cached daily bars (up to 24 h old). A far close with a
// fresh write time and a 20-hour-old bar is a 20-hour-old price.
test('the mark\'s age is the price\'s (bar stamp), not the book\'s write time: a day-old close written just now forces the read', async t => {
  const old = scene(t)
  old.mark('11', 110, AT - 20 * 3_600_000, AT)          // far (20.4 short), written now, bar 20 h old
  old.broker['11'].bid = 130.5; old.broker['11'].ask = 130.6   // the real price has passed the trigger
  const out = await old.pass()
  assert.equal(out.accounts['11'].prefiltered, 0, 'an old price is never a reason to skip')
  assert.equal(old.row().state, 'CONFIRMED', 'the authoritative read runs and the partial closes')
  assert.equal(old.ops('close'), 1)
  const unstamped = scene(t)
  unstamped.mark('11', 110, null, AT)                   // no bar stamp: its price's age is unknown
  await unstamped.pass()
  assert.equal(unstamped.ops('read'), 1, 'a mark without a bar stamp cannot prove its age')
  const fresh = scene(t)
  fresh.mark('11', 110, AT - 60_000, AT)                // the same far close, bar a minute old
  await fresh.pass()
  assert.equal(fresh.ops('read'), 0, 'control: a fresh bar far from the trigger still skips')
})

test('prefilterVerdict names why it did or did not skip', () => {
  const v = mark => prefilterVerdict({ plan: BUY, ledgerOpen: true, mark, nowMs: AT })
  assert.deepEqual(v({ c: 127.8, at: AT, bt: AT - 60_000 }), { skip: true, reason: 'mark_far_from_trigger', mark: 127.8, markAt: AT - 60_000 })
  assert.equal(v({ c: 127.95, at: AT, bt: AT }).reason, 'mark_near_or_beyond_trigger')
  assert.equal(v({ c: 0, at: AT, bt: AT }).reason, 'no_mark')
  assert.equal(v({ c: 120, at: AT - 16 * 60_000, bt: AT - 16 * 60_000 }).reason, 'mark_stale')
  // The checker's case: written now, bar 20 h old.
  const day = v({ c: 110, at: AT, bt: AT - 20 * 3_600_000 })
  assert.equal(day.skip, false); assert.equal(day.reason, 'mark_stale'); assert.equal(day.markAgeMs, 72_000_000)
  assert.equal(v({ c: 110, at: AT }).reason, 'mark_price_age_unknown', 'no bar stamp: the write time is not the price\'s age')
  assert.equal(v({ c: 110, at: AT, bt: 29 }).reason, 'mark_price_age_unknown', 'a bar index is not an epoch')
  assert.equal(v({ c: 110, at: AT, bt: AT + 60_000 }).reason, 'mark_stale', 'a bar stamped ahead of this clock is not fresh')
  assert.equal(prefilterVerdict({ plan: BUY, ledgerOpen: false, mark: { c: 120, at: AT, bt: AT }, nowMs: AT }).reason, 'lifecycle_not_open_in_ledger')
})

test('at most one authoritative check per plan per 60 s', async t => {
  const s = scene(t)
  await s.pass()
  assert.equal(s.ops('read'), 1)
  s.clock += 59_000
  const again = await s.pass()
  assert.equal(s.ops('read'), 1); assert.equal(again.accounts['11'].rateLimited, 1)
  s.clock += 2_000
  await s.pass()
  assert.equal(s.ops('read'), 2)
})

test('accounts are isolated: own plans, own credentials; one account without credentials does not stop another', async t => {
  for (const host of HOSTS) {
    const s = scene(t, { accounts: ['11', '22'], host })
    const byAccount = s.credsFor
    s.credsFor = id => id === '11' ? null : byAccount(id)
    const out = await s.pass()
    assert.equal(out.accounts['11'].error, 'no_credentials')
    assert.equal(out.ok, false, 'a plan left unmanaged is a failed pass')
    assert.equal(s.calls.filter(c => c[1] === '11').length, 0, `${host}: nothing sent for the account without credentials`)
    assert.equal(s.calls.filter(c => c[1] === '22').length, 2, `${host}: the other account read and quoted`)
    assert.equal(s.row('11').state, 'ARMED'); assert.equal(s.row('22').state, 'ARMED')
    // BLOCKER 2: the record the pass just wrote is fresh, but it could not
    // act on …11 — so a trigger there is not available; …22's still is.
    const record = readMomentumPartialPass(s.db())
    const on11 = partialPassForAccount(s.db(), record, '11', AT), on22 = partialPassForAccount(s.db(), record, '22', AT)
    assert.equal(on11.fresh, true); assert.equal(on11.available, false); assert.equal(on11.accountError, 'no_credentials')
    assert.match(on11.why, /could not act on this account — no_credentials/)
    assert.equal(on22.available, true); assert.equal(on22.why, null)
  }
})

test('NIT 4: an unreadable loop interval falls back to five minutes instead of throwing into the cockpit', () => {
  const unreadable = { prepare: () => { throw Error('SQLITE_BUSY: database is locked') } }
  const f = partialPassFreshness(unreadable, { at: new Date(AT - 60_000).toISOString() }, AT)
  assert.equal(f.maxAgeMs, 15 * 60_000); assert.equal(f.fresh, true)
})

test('a pass that could not read its plans is available on no account', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const record = { at: new Date(AT).toISOString(), ok: false, errors: ['plan_read: SQLITE_CORRUPT'], accounts: {} }
  const p = partialPassForAccount(db, record, '11', AT)
  assert.equal(p.fresh, true); assert.equal(p.available, false)
  assert.match(p.why, /could not read its plans — plan_read: SQLITE_CORRUPT/)
  assert.equal(partialPassForAccount(db, { ...record, ok: false, errors: ['scale_out_record: busy'] }, '11', AT).available, true,
    'a failure that does not stop the triggers being watched leaves them available')
})

test('the per-account time budget defers the remaining plans, visibly', async t => {
  const s = scene(t)
  const out = await s.pass({ config: { accountBudgetMs: 0 } })
  assert.equal(out.accounts['11'].deferredBudget, 1)
  assert.equal(s.calls.length, 0)
})

test('one scale_out per proven partial: written with the deal, never again across passes and a restart', async t => {
  const dbPath = join(tempDir('t3-scaleout-'), 'agent.db')
  const s = scene(t, { dbPath })
  s.broker['11'].bid = 130.5; s.broker['11'].ask = 130.6
  const out = await s.pass()
  assert.equal(s.row().state, 'CONFIRMED')
  assert.equal(out.scaleOutsRecorded.length, 1)
  const events = () => s.db().prepare("SELECT * FROM position_events WHERE trade_id=7 AND kind='scale_out'").all()
  assert.equal(events().length, 1)
  const [e] = events()
  assert.equal(e.source, 'momentum_partial'); assert.equal(e.account_id, '11'); assert.equal(e.position_id, '33')
  assert.equal(e.price_at, 130.5); assert.equal(e.from_value, BUY.volume); assert.equal(e.to_value, BUY.runnerVolume)
  assert.equal(e.state_to, 'scaled_out')
  const detail = JSON.parse(e.detail_json)
  assert.deepEqual([detail.dealId, detail.volume, detail.price], ['9001', BUY.closeVolume, 130.5])
  assert.equal(s.row().scale_out_event_id, e.id)
  s.clock += 120_000
  await s.pass(); await s.pass()
  assert.equal(events().length, 1, 'later passes write nothing')
  s.reopen()
  s.clock += 120_000
  const after = await s.pass()
  assert.equal(events().length, 1, 'a restart writes nothing')
  assert.equal(after.scaleOutsRecorded.length, 0)
  // The journal's 90-day retention sweep deletes the row; the plan's marker
  // still says it was journaled, so it is not written again with a new date.
  s.db().prepare("DELETE FROM position_events WHERE trade_id=7 AND kind='scale_out'").run()
  s.clock += 120_000
  await s.pass()
  assert.equal(events().length, 0, 'a pruned event is not re-recorded as a new scale-out')
  // NIT 1: a journaled plan is filtered in SQL, not read and parsed each loop.
  let planReads = 0
  const real = s.db()
  const spy = new Proxy(real, { get(target, prop) {
    if (prop === 'prepare') return sql => { if (/^SELECT \* FROM momentum_partial_plans WHERE account_id=\?/.test(sql)) planReads++; return target.prepare(sql) }
    const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v
  } })
  assert.deepEqual(recordPartialScaleOuts(spy), { written: [], pending: [] })
  assert.equal(planReads, 0, 'the journaled plan is not read')
})

test('AWAITING_BIND plus a rank exit (the book\'s legacy close) becomes BIND_ABANDONED, with no plan and no broker call', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const creds = { host: 'demo.ctraderapi.com', accountId: '11', ready: true, clientId: 'c', clientSecret: 's', accessToken: 't' }
  db.prepare("INSERT INTO accounts(account_id,trader_login,is_live,enabled,mode) VALUES('11','1',0,1,'active')").run()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true, bookExitCadence: 'every_pass' }))
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: null, cadence: 'loop' }))
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: {}, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: '11' }, { getState, setState })
  db.prepare(`INSERT INTO trades(id,symbol,side,status,account_id,origin,risk_event_id,entry_price,sl_price,tp_price,volume,label_strategy,ctrader_position_id)
    VALUES(7,'ETHUSD','BUY','open','11','bot_market_dispatch',1,100,90,140.4,1,'tsmom_long','33')`).run()
  db.prepare(`INSERT INTO momentum_book(trade_id,account_id,symbol,position_id,side,entry_price,stop,status,entered_at)
    VALUES(7,'11','ETHUSD','33','long',100,90,'open',?)`).run(new Date(AT - 5 * 86400000).toISOString())
  db.prepare(`INSERT INTO momentum_shadow(symbol,action,side,rank_pct,conviction,price,timeframe,universe,applied,at)
    VALUES('ETHUSD','exit','long',0.1,9,100,'1d',20,0,?)`).run(new Date(AT).toISOString())
  // The intent T4's deferred bind writes when the fill is not yet confirmed:
  // the book owns the position, no partial plan is registered.
  db.exec(`CREATE TABLE momentum_target_intents (account_id TEXT NOT NULL, trade_id INTEGER NOT NULL, risk_event_id INTEGER NOT NULL,
    proposal_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'PREPARED', position_id TEXT,
    plan_json TEXT, fill_json TEXT, PRIMARY KEY(account_id,trade_id))`)
  db.prepare("INSERT INTO momentum_target_intents(account_id,trade_id,risk_event_id,proposal_json,created_at_ms,state) VALUES('11',7,1,'{}',?,'AWAITING_BIND')").run(AT - 60_000)
  // Before the exit: the pass leaves a waiting bind alone.
  const before = await runMomentumPartialPass(db, { credsFor: () => creds, now: () => AT })
  assert.equal(before.abandonedBinds.length, 0)
  assert.equal(db.prepare('SELECT state FROM momentum_target_intents').get().state, 'AWAITING_BIND')
  // The book's rank exit: no plan, so the legacy close runs.
  let closes = 0
  const out = await runMomentumBook(db, { accounts: [{ accountId: '11', isLive: false }], credsFor: () => creds, now: AT,
    deps: { phasesOn: () => true, positionVolume: async () => 10000, bars: async () => [], symbolIdFor: async () => null, equity: () => 100000,
      close: async (_c, order) => { closes++; assert.equal(order.volume, 10000); return { ok: true } } } })
  assert.equal(closes, 1); assert.equal(out.exits, 1)
  assert.equal(db.prepare('SELECT status FROM momentum_book WHERE trade_id=7').get().status, 'exit_sent')
  let adapters = 0
  const pass = await runMomentumPartialPass(db, { credsFor: () => creds, now: () => AT + 1000, deps: { adapterFor: () => { adapters++ } } })
  assert.deepEqual(pass.abandonedBinds, [{ accountId: '11', tradeId: 7, reason: 'book_row_exit_sent' }])
  const intent = db.prepare('SELECT * FROM momentum_target_intents').get()
  assert.equal(intent.state, 'BIND_ABANDONED'); assert.equal(intent.reason, 'bind_abandoned: book_row_exit_sent')
  assert.equal(intent.resolved_at, AT + 1000)
  assert.equal(JSON.parse(intent.evidence_json).source, 'ledger')
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='momentum_partial_plans'").get().n, 0, 'no plan registered')
  assert.equal(adapters, 0)
  // Terminal and still visible: a later pass changes nothing.
  await runMomentumPartialPass(db, { credsFor: () => creds, now: () => AT + 2000 })
  assert.equal(db.prepare('SELECT state FROM momentum_target_intents').get().state, 'BIND_ABANDONED')
})

test('a closed trade or a recorded close also abandons a waiting bind; an open one does not', async t => {
  const db = new Database(':memory:'); t.after(() => db.close())
  db.exec(`CREATE TABLE trades(id INTEGER, account_id TEXT, status TEXT);
    CREATE TABLE position_events(id INTEGER PRIMARY KEY, account_id TEXT, trade_id INTEGER, kind TEXT, source TEXT, at TEXT);
    CREATE TABLE momentum_target_intents(account_id TEXT, trade_id INTEGER, state TEXT)`)
  db.prepare("INSERT INTO trades VALUES (1,'11','closed'),(2,'11','open'),(3,'11','open')").run()
  db.prepare("INSERT INTO position_events(account_id,trade_id,kind,source,at) VALUES ('11',3,'loss_cap_close','loss_cap','2026-09-25')").run()
  db.prepare("INSERT INTO momentum_target_intents VALUES ('11',1,'AWAITING_BIND'),('11',2,'AWAITING_BIND'),('11',3,'AWAITING_BIND')").run()
  const out = await runMomentumPartialPass(db, { now: () => AT })
  assert.deepEqual(out.abandonedBinds.map(b => [b.tradeId, b.reason]), [[1, 'trade_closed'], [3, 'close_recorded']])
  assert.deepEqual(db.prepare('SELECT trade_id, state FROM momentum_target_intents ORDER BY trade_id').all().map(r => r.state),
    ['BIND_ABANDONED', 'AWAITING_BIND', 'BIND_ABANDONED'])
})

test('end to end on the real adapter and the fake broker: an accepted close is recovered by a later pass, one close, one scale_out', async t => {
  const ENV = ['EXEC_ENGINE', 'EXEC_URL', 'EXEC_URL_DEMO', 'EXEC_URL_LIVE', 'EXEC_SECRET', 'EXEC_FALLBACK']
  for (const host of HOSTS) {
    const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]))
    const broker = await startFakeBroker({ accounts: ['4001'], symbols: { 22: { digits: 2 } } })
    for (const k of ['EXEC_URL_DEMO', 'EXEC_URL_LIVE']) delete process.env[k]
    Object.assign(process.env, { EXEC_ENGINE: 'cpp', EXEC_URL: broker.url, EXEC_SECRET: 'sekret', EXEC_FALLBACK: '0' })
    invalidateSidecarSession()
    t.after(async () => {
      invalidateSidecarSession(); await broker.close()
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    })
    broker.setQuote(22, { bid: 99.9, ask: 100 })
    const pos = broker.open('4001', { symbolId: 22, tradeSide: 'BUY', volume: 10000, relativeStopLoss: 1_000_000, relativeTakeProfit: 4_040_000 })
    const positionId = String(pos.positionId), identity = { host, accountId: '4001', symbolId: '22' }
    const db = initDB(':memory:'); t.after(() => db.close())
    db.prepare(`INSERT INTO trades(id,symbol,side,status,account_id,origin,risk_event_id,entry_price,sl_price,tp_price,volume,label_strategy,ctrader_position_id)
      VALUES(7,'ETHUSD','BUY','open','4001','bot_market_dispatch',1,100,90,140.4,1,'tsmom_long',?)`).run(positionId)
    registerPartialPlan(db, { accountId: '4001', tradeId: 7, positionId, plan: BUY, evidenceId: 'fixture:7', identity })
    const creds = { ...identity, ready: true, clientId: 'c', clientSecret: 's', accessToken: 't' }
    const transports = {
      now: () => broker.nowMs, readCredentials: () => creds,
      reconcile: async (_h, _ci, _cs, _at, account) => broker.reconcile(account),
      quote: async (c, symbolId) => broker.spot(c.accountId, symbolId),
      deals: async (_h, _ci, _cs, _at, account, pid, to) => broker.positionDeals(account, pid, { toTimestamp: to }),
    }
    const adapterFor = (d, ref) => {
      const a = makeMomentumPartialBroker(d, ref, transports)
      a.readOwnership = () => ({ accountId: '4001', tradeId: 7, positionId, status: 'open', owner: 'momentum_book',
        guardActive: false, entry: 100, initialRisk: 10, side: 'BUY' })
      return a
    }
    const pass = () => runMomentumPartialPass(db, { credsFor: () => creds, now: () => broker.nowMs, deps: { adapterFor } })
    broker.setQuote(22, { bid: 130.4, ask: 130.5 })
    broker.closeAnswer({ reply: 'accepted', fill: 'deferred' })
    await pass()
    assert.equal(readPartialPlan(db, '4001', 7).state, 'SENDING', host)
    broker.tick(30_000); broker.fillDeferred(); broker.tick(31_000)
    await pass()
    assert.equal(readPartialPlan(db, '4001', 7).state, 'CONFIRMED', host)
    assert.equal(broker.callsFor('close').length, 1, host)
    assert.equal(db.prepare("SELECT count(*) n FROM position_events WHERE trade_id=7 AND kind='scale_out'").get().n, 1, host)
    broker.tick(61_000); await pass()
    assert.equal(broker.callsFor('close').length, 1, host)
  }
})

// ---------------------------------------------------------------------------
// Wiring pin (failure modes #2 and #4). Parsed, not pattern-matched: comments
// are not in the syntax tree, so an explanatory comment naming the function
// cannot satisfy it. acorn is eslint's parser (root devDependency tree).
// ---------------------------------------------------------------------------
test('loop.js calls the pass once, after the momentum book, in its own try/catch, gated by nothing that gates the book', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true })
  const calls = {}
  const walk = (node, chain) => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') (calls[node.callee.name] ||= []).push({ node, chain })
    const next = ['IfStatement', 'TryStatement', 'FunctionDeclaration', 'ConditionalExpression', 'LogicalExpression'].includes(node.type) ? [...chain, node] : chain
    for (const k of Object.keys(node)) {
      const v = node[k]
      if (k === 'handler' && node.type === 'TryStatement') { walk(v, [...chain, { type: 'CatchOf', of: node }]); continue }
      if (Array.isArray(v)) v.forEach(c => walk(c, next))
      else if (v && typeof v.type === 'string') walk(v, next)
    }
  }
  walk(ast, [])
  const pass = calls.runMomentumPartialPass || []
  const book = calls.runMomentumBook || []
  assert.equal(pass.length, 1, 'exactly one call of runMomentumPartialPass in loop.js')
  assert.equal(book.length, 1)
  const p = pass[0], b = book[0]
  assert.ok(p.node.start > b.node.start, 'after the momentum book')
  const fnOf = x => x.chain.filter(n => n.type === 'FunctionDeclaration').at(-1)
  assert.equal(fnOf(p), fnOf(b), 'in the same loop function')
  const ifsOf = x => new Set(x.chain.filter(n => n.type === 'IfStatement' || n.type === 'ConditionalExpression' || n.type === 'LogicalExpression'))
  const shared = [...ifsOf(p)].filter(n => ifsOf(b).has(n))
  assert.deepEqual(shared.map(n => src.slice(n.test?.start ?? n.start, n.test?.end ?? n.end).slice(0, 60)), [],
    'no condition that gates the momentum book (symbols, scan switch, weekend quiet, ctraderCreds) gates the partial pass')
  const ownTry = p.chain.filter(n => n.type === 'TryStatement').at(-1)
  const bookTry = b.chain.filter(n => n.type === 'TryStatement').at(-1)
  assert.ok(ownTry && ownTry !== bookTry && ownTry.handler, 'its own try/catch, not the book\'s')
  assert.ok(!p.chain.some(n => n.type === 'CatchOf'), 'not inside a catch block')
  const beats = (calls.hbeat || []).filter(h => h.node.arguments[1]?.value === 'momentum_partial')
  const inCatch = h => h.chain.some(n => n.type === 'CatchOf' && n.of === ownTry)
  assert.ok(beats.some(h => h.chain.includes(ownTry) && !inCatch(h)), 'beats on the success path, after the pass')
  assert.ok(beats.some(h => inCatch(h) && h.node.arguments[2]?.type === 'Literal' && h.node.arguments[2].value === false), 'beats failed in its catch')
})

test('the pass record is the heartbeat effect and is written every pass', async t => {
  const { CONTROLLERS } = await import('./heartbeat.js')
  assert.equal(CONTROLLERS.momentum_partial.effect.key, MOMENTUM_PARTIAL_PASS_KEY)
  assert.equal(CONTROLLERS.momentum_partial.tiedToLoop, true)
  const db = initDB(':memory:'); t.after(() => db.close())
  await runMomentumPartialPass(db, { now: () => AT })
  await runMomentumPartialPass(db, { now: () => AT + 300_000 })
  assert.equal(readMomentumPartialPass(db).at, new Date(AT + 300_000).toISOString())
})
