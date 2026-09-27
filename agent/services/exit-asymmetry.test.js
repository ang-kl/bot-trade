// node --test agent/services/exit-asymmetry.test.js
//
// PR-J (11-09-2026, owner: "finish the outstanding") — the WIRING half of the
// exit-asymmetry change. position-manager.test.js and managed-exit.test.js pin
// the decisions; this file pins that the decisions reach a real position:
// the stamps are columns that exist, the monitor persists them, the revert
// switches are reachable from the running system through a route, and the loss
// guardian's own hard cap still behaves where it applies.
//
// The measurement that ordered it (five broker statements, 95 bot deals,
// 09–11 Sep): winners' median move +0.39% against losers' −0.76%, avg win ÷
// avg loss 0.72 at a 51% win rate, realised R:R ≈ 1.01, 34 of 95 closed inside
// an hour — and ten closed in one batch at 21:31 SGT by the time cap after
// 17–21h held, several of them in profit.
//
// A rule that decides correctly and is never persisted is failure mode #4.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import actionsRouter from '../routes/actions.js'
import { loadManagedExit, MANAGED_EXIT_DEFAULTS } from './managed-exit.js'
import { decideLossGuardian, DEFAULT_LOSS_GUARDIAN } from './loss-guardian.js'
import { runFastMonitor } from './fast-monitor.js'
import { evaluatePosition } from './position-manager.js'
import { buildIntention } from './cockpit-intention.js'
import { readFileSync } from 'node:fs'
import { prepareStatements, stampExitMarks } from '../loop.js'

const CREDS = { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }

// ---------------------------------------------------------------------------
// The stamps are real columns
// ---------------------------------------------------------------------------

test('monitored_positions carries both PR-J stamps', () => {
  const db = initDB(':memory:')
  const cols = new Set(db.prepare('PRAGMA table_info(monitored_positions)').all().map(c => c.name))
  assert.ok(cols.has('time_cap_trail_at'), 'the cap-trail stamp must be a column, not an in-memory hope')
  assert.ok(cols.has('bank_partial_at'), 'the bank stamp must be a column')
})

// loop.js memoises its prepared statements for the FIRST db it is handed, so
// every test below shares one db on purpose — two would silently write through
// the first one's statements.
const wireDb = (() => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, GBPUSD: 2, NZDUSD: 3, USDCAD: 4, USDJPY: 5 }))
  return db
})()
const wireStmts = prepareStatements(wireDb)

function addPosition(symbol, { entry, sl, capHoursAgo = 3 }) {
  wireDb.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, current_tp, initial_risk, status, source,
       strategy, time_cap_at, created_at)
    VALUES (?, 'BUY', ?, ?, NULL, 0.0050, 'active', 'autopilot',
            'fib_618_fade', ?, datetime('now','-20 hours'))
  `).run(symbol, entry, sl, new Date(Date.now() - capHoursAgo * 3_600_000).toISOString())
  return wireDb.prepare('SELECT id FROM monitored_positions WHERE symbol = ?').get(symbol).id
}

/**
 * `outcome` is what the executor returns. Injected because the stamps are now
 * written FROM the outcome (checker M4) — an errored or skipped broker action
 * must leave the rule armed, and that cannot be tested against a real socket.
 */
function deps(priceBySymbolId, outcome = { summary: 'ok' }) {
  const calls = []
  const d = {
    ws: {
      wsGetTrendbarsBatch: async () => ({ '1m': [] }),
      wsGetSpotOnce: async (_h, _i, _s, _t, _a, symbolId) => {
        const p = priceBySymbolId[symbolId]
        return p == null ? null : { bid: p - 0.0001, ask: p + 0.0001 }
      },
    },
    loop: {
      prepareStatements: () => wireStmts,
      executeBrokerAction: async (_db, _s, pos, eval_) => { calls.push({ pos, eval_ }); return outcome },
      stampExitMarks,
    },
    now: () => Date.now(),
  }
  d.calls = calls
  return d
}

test('the stamp statement keeps the FIRST mark — a mark a later pass can overwrite is not a mark', () => {
  const id = addPosition('AUDUSD', { entry: 1.1, sl: 1.095 })
  wireStmts.stampPositionExitMarks.run('2026-09-11T10:00:00.000Z', null, id)
  wireStmts.stampPositionExitMarks.run('2026-09-11T11:00:00.000Z', '2026-09-11T11:00:00.000Z', id)
  const row = wireDb.prepare('SELECT time_cap_trail_at, bank_partial_at FROM monitored_positions WHERE id = ?').get(id)
  assert.equal(row.time_cap_trail_at, '2026-09-11T10:00:00.000Z', 'the first cap stamp stands')
  assert.equal(row.bank_partial_at, '2026-09-11T11:00:00.000Z', 'a mark not yet set is still settable')
  wireDb.prepare('DELETE FROM monitored_positions WHERE id = ?').run(id)
})

// ---------------------------------------------------------------------------
// End to end through a real evaluator: the 21:31 batch, one position of it
// ---------------------------------------------------------------------------

test('a WINNER past its time cap is trailed and stamped, not closed', async () => {
  // +2R (entry 1.1000, risk 0.0050, price 1.1100) 3h past the cap: exactly the
  // shape of the ten positions closed in the 21:31 batch while in profit.
  addPosition('EURUSD', { entry: 1.1000, sl: 1.0950 })
  const out = await runFastMonitor(wireDb, CREDS, deps({ 1: 1.1100 }))
  assert.equal(out.checked, 1)
  const row = wireDb.prepare('SELECT * FROM monitored_positions WHERE symbol = ?').get('EURUSD')
  assert.equal(row.status, 'active', 'the winner is still open')
  assert.ok(row.time_cap_trail_at, 'and the pass is stamped in the DB, not just in the verdict')
  assert.match(row.last_check_action, /MOVE_SL/)
  assert.match(row.last_check_reasoning, /time_cap_trailing/)
})

test('fix-the-exits BB: a winner whose stop already sits past breakeven is HELD at its cap and the hold is stamped in the DB', async () => {
  // Stop at +0.5R already (1.1025 on a 0.0050 risk), price +1R: the cap's
  // trail (breakeven floor 1.1000, peak − 1.5R = 1.0975) is looser, so there
  // is nothing to tighten. Before BB this closed as time_cap_expired.
  addPosition('NZDUSD', { entry: 1.1000, sl: 1.1025 })
  const d = deps({ 3: 1.1050 })
  await runFastMonitor(wireDb, CREDS, d)
  const row = wireDb.prepare('SELECT * FROM monitored_positions WHERE symbol = ?').get('NZDUSD')
  assert.equal(row.status, 'active', 'still open')
  assert.equal(d.calls.length, 0, 'nothing was sent to the broker')
  assert.match(row.last_check_action, /HOLD/)
  assert.match(row.last_check_reasoning, /time_cap_held/)
  assert.ok(row.time_cap_trail_at, 'the hold is stamped in the DB so the cap is not re-decided every pass')
  wireDb.prepare('DELETE FROM monitored_positions WHERE id = ?').run(row.id)
})

test('stampExitMarks: a HOLD carrying a mark is stamped without an outcome; a broker action still needs one', () => {
  const id = addPosition('USDCAD', { entry: 1.3, sl: 1.295 })
  const pos = { id }
  assert.equal(stampExitMarks(wireStmts, pos, { action: 'MOVE_SL', updates: { time_cap_trail_at: 'x' } }, null), false, 'an action with no outcome stamps nothing')
  assert.equal(stampExitMarks(wireStmts, pos, { action: 'HOLD', updates: {} }, null), false, 'a HOLD with no mark stamps nothing')
  assert.equal(stampExitMarks(wireStmts, pos, { action: 'HOLD', updates: { time_cap_trail_at: '2026-09-18T07:00:00.000Z' } }, null), true)
  assert.equal(wireDb.prepare('SELECT time_cap_trail_at FROM monitored_positions WHERE id = ?').get(id).time_cap_trail_at, '2026-09-18T07:00:00.000Z')
  wireDb.prepare('DELETE FROM monitored_positions WHERE id = ?').run(id)
})

test('a LOSER past its time cap still gets the close verdict, with the unchanged reason', async () => {
  addPosition('GBPUSD', { entry: 1.3000, sl: 1.2950 })
  // EURUSD is quoted null this pass (its market "closed"), so only the loser
  // is evaluated.
  await runFastMonitor(wireDb, CREDS, deps({ 2: 1.2975 })) // −0.5R
  const row = wireDb.prepare('SELECT * FROM monitored_positions WHERE symbol = ?').get('GBPUSD')
  assert.match(row.last_check_action, /FULL_EXIT/)
  assert.match(row.last_check_reasoning, /time_cap_expired \(/)
  assert.equal(row.time_cap_trail_at, null, 'nothing is stamped on the close path')
})

// ---------------------------------------------------------------------------
// The revert switches are reachable from the running system
// ---------------------------------------------------------------------------

function server() {
  const db = initDB(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const srv = app.listen(0, () => resolve({
      db, close: () => srv.close(),
      url: (p) => `http://127.0.0.1:${srv.address().port}${p}`,
    }))
  })
}
const post = (h, body) => fetch(h.url('/actions/managed-exit'), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json())

test('POST /actions/managed-exit reverts either half without a deploy', async () => {
  const h = await server()
  try {
    let res = await post(h, { timeCapHoldWinners: false })
    assert.equal(res.ok, true)
    assert.equal(res.effective.timeCapHoldWinners, false)
    assert.equal(loadManagedExit(h.db).timeCapHoldWinners, false)
    // ...and it is the EFFECTIVE policy that comes back, not an echo of the
    // patch: the untouched half is still at the ordered default.
    assert.equal(res.effective.takeFractionAtR, MANAGED_EXIT_DEFAULTS.takeFractionAtR)

    res = await post(h, { takeFractionAtR: 1.0 })
    assert.equal(res.effective.takeFractionAtR, 1.0)
    assert.equal(res.effective.timeCapHoldWinners, false, 'the earlier revert survives the second POST')

    // And back on again — a switch that only goes one way is not a switch.
    res = await post(h, { timeCapHoldWinners: true, takeFractionAtR: 0.5 })
    assert.equal(res.effective.timeCapHoldWinners, true)
    assert.equal(res.effective.takeFractionAtR, 0.5)
  } finally { h.close() }
})

test('the route starts from what is STORED — an unrelated knob is not dropped (failure mode #5)', async () => {
  const h = await server()
  try {
    setState(h.db, 'managed_exit_json', JSON.stringify({ trailR: 0.75, takeAtRFamilies: ['trend'], on: true }))
    const res = await post(h, { timeCapHoldWinners: false })
    assert.equal(res.stored.trailR, 0.75, 'the trail distance must survive an unrelated POST')
    assert.deepEqual(res.stored.takeAtRFamilies, ['trend'])
    assert.equal(res.effective.trailR, 0.75)
  } finally { h.close() }
})

// ---------------------------------------------------------------------------
// No double-fire with the loss guardian
// ---------------------------------------------------------------------------

test('PR-J/M2: the guardian takes its hard cap BACK once the position manager has held the position', () => {
  // The deferral (hardening 6d) was justified by "the position-manager's cap
  // always closes". After PR-J it does not, so a held position would have had
  // NO time-based owner for up to 72 hours. The caller decides by the stamp;
  // these three cases are the decision function's side of it.
  const cfg = { ...DEFAULT_LOSS_GUARDIAN, maxHoldHours: 4 }
  const ctx = { side: 'BUY', entry: 1.10, price: 1.11, currentSl: 1.095, atr: 0.002, digits: 5, ageHours: 20 }

  // Cap still going to close it → the guardian defers, as before.
  assert.equal(decideLossGuardian(cfg, { ...ctx, hasOwnTimeCap: true }).action, null)
  // Cap fired and HELD it, so the caller stops claiming an owner → it closes.
  const held = decideLossGuardian(cfg, { ...ctx, hasOwnTimeCap: false })
  assert.equal(held.action?.close, true)
  assert.equal(held.rule, 'time_cap')
})

test('PR-J/M2: the guardian\'s caller reads the stamp, not just the cap', () => {
  // The wiring half: `hasOwnTimeCap` must be false once time_cap_trail_at is
  // set, or the decision above is never reached for a held position. Source
  // pin (comments stripped) — the query and the call site are in a loop over
  // broker rows that cannot be reached without a socket.
  const src = readFileSync(new URL('./loss-guardian.js', import.meta.url), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(src, /mp\.time_cap_trail_at/, 'the guardian must SELECT the stamp')
  assert.match(src, /hasOwnTimeCap: r\.time_cap_at != null && r\.time_cap_trail_at == null/,
    'a held position must no longer count as having an owner')
})

// ---------------------------------------------------------------------------
// CHECKER M4 — a stamp is a record of something that HAPPENED.
// ---------------------------------------------------------------------------

test('PR-J/M4: a broker ERROR leaves the rule armed — nothing stamped, next pass re-decides', async () => {
  addPosition('NZDUSD', { entry: 0.6000, sl: 0.5950 })
  const d = deps({ 3: 0.6100 }, { error: 'MARKET_CLOSED' })
  await runFastMonitor(wireDb, CREDS, d)
  const row = wireDb.prepare('SELECT * FROM monitored_positions WHERE symbol = ?').get('NZDUSD')
  assert.equal(d.calls.length, 1, 'the action was attempted')
  assert.match(d.calls[0].eval_.reason, /time_cap_trailing/)
  assert.equal(row.time_cap_trail_at, null, 'a refused amend must not disarm the rule')
  assert.match(row.last_check_reasoning, /broker_error/)
})

test('PR-J/M4: a SKIPPED action leaves the rule armed too', async () => {
  addPosition('USDCAD', { entry: 1.3000, sl: 1.2950 })
  const d = deps({ 4: 1.3100 }, { skipped: true, reason: 'partial_below_min_volume' })
  await runFastMonitor(wireDb, CREDS, d)
  const row = wireDb.prepare('SELECT * FROM monitored_positions WHERE symbol = ?').get('USDCAD')
  assert.equal(d.calls.length, 1, 'the action was attempted — not a vacuous pass')
  assert.equal(row.time_cap_trail_at, null, 'an intent-only pass stamps nothing')
})

test('PR-J/M4: a SUCCESSFUL action stamps, and only then', async () => {
  addPosition('USDJPY', { entry: 150.00, sl: 149.50 })
  const d = deps({ 5: 151.00 }, { summary: 'SL → 150.00000' })
  await runFastMonitor(wireDb, CREDS, d)
  const row = wireDb.prepare('SELECT * FROM monitored_positions WHERE symbol = ?').get('USDJPY')
  assert.equal(d.calls.length, 1)
  assert.ok(row.time_cap_trail_at, 'the stop moved, so the hold is on record')
})

test('PR-J/M4: a bank partial the broker cannot size falls back to the FULL exit it replaced', () => {
  // Below the minimum lot (or floored to zero by the step), the pre-PR-J rule
  // closed the whole position. Skipping it silently would leave the smallest
  // positions never banking at all — the LLY margin-hostage case, reintroduced.
  // The decision carries the instruction; the executor acts on it.
  const rules = { bankTriggerR: 1, bankFraction: 0.5, partialTriggerR: Infinity, runnerTriggerR: Infinity }
  const pos = {
    id: 1, symbol: 'TEST', side: 'long', entry_price: 100, current_sl: 99, current_tp: null,
    initial_risk: 1, mfe_r: 0, mae_r: 0, be_moved: 0, scaled_out: 0,
    invalidation_trigger: null, time_cap_at: null, created_at: new Date().toISOString(),
  }
  const out = evaluatePosition(pos, { currentPrice: 101, rules })
  assert.equal(out.action, 'PARTIAL_EXIT')
  assert.equal(out.fallbackFullExitIfUnfillable, true, 'the executor is told what an unfillable partial means')

  const exec = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(exec, /if \(eval_\.fallbackFullExitIfUnfillable\) \{/, 'the executor must honour it')
  assert.match(exec, /action: 'FULL_EXIT',\n\s+exitFraction: 1,/, 'and fall back to the whole close')
  // And the plain ladder partial keeps its old behaviour: it is skipped.
  const ladder = evaluatePosition(
    { ...pos, id: 2 },
    { currentPrice: 101, rules: { bankTriggerR: 0, partialTriggerR: 1, partialFraction: 0.5, runnerTriggerR: 2.5 } },
  )
  assert.equal(ladder.action, 'PARTIAL_EXIT')
  assert.equal(ladder.fallbackFullExitIfUnfillable, undefined, 'only the bank take asked for a full exit')
})

// ---------------------------------------------------------------------------
// CHECKER M5 — the cockpit must not promise an exit the code will not make
// (owner principle 6: the website shows no fake result).
// ---------------------------------------------------------------------------

test('PR-J/M5: a HELD position no longer advertises an armed "full exit" at its cap', () => {
  const db = initDB(':memory:')
  const tid = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, opened_at, ctrader_position_id, status, strategy, conviction)
    VALUES ('EURUSD','long',100,0.5,datetime('now'),'900001','open','rsi2_reversion',0.8)`).run().lastInsertRowid
  const mk = (stamp) => db.prepare(`INSERT INTO monitored_positions
      (symbol, trade_id, side, entry_price, current_sl, current_tp, initial_risk, account_id, status,
       thesis, time_cap_at, time_cap_trail_at, strategy, source, last_check_action, last_check_at, thesis_status)
    VALUES ('EURUSD',?, 'long',100,98,106,2,'ACC_A','active','t','2026-07-31T08:00:00Z',?,'rsi2_reversion','autopilot','HOLD','2026-07-31T04:55:00Z','intact')`)
    .run(tid, stamp).lastInsertRowid
  const fetch_ = (id) => db.prepare(`SELECT mp.*, t.volume AS volume, t.ctrader_position_id AS ctrader_position_id,
      t.strategy AS trade_strategy, t.conviction AS conviction, t.analysis_id AS analysis_id
      FROM monitored_positions mp LEFT JOIN trades t ON t.id = mp.trade_id WHERE mp.id = ?`).get(id)
  const NOW = Date.parse('2026-07-31T10:00:00Z') // past the cap

  const held = buildIntention(db, fetch_(mk('2026-07-31T08:00:05Z')), { price: 101 }, '2026-07-31T09:59:00Z', 'rev1', NOW)
  const heldCards = held.armedActions.filter(a => a.kind === 'time_cap_exit')
  assert.equal(heldCards.length, 0, 'a held position must not promise a full exit at its cap')
  const backstop = held.armedActions.find(a => a.kind === 'time_cap_backstop')
  assert.ok(backstop, 'it advertises the backstop instead')
  assert.match(backstop.trigger, /held past its time cap/)
  assert.ok(backstop.eta > '2026-07-31T08:00:00Z', 'and its eta is the backstop time, not the cap time')
  const heldInv = held.invalidation.find(i => i.kind === 'time_cap')
  assert.equal(heldInv.state, 'answered', 'met-and-answered, not a close pending')

  // An UNHELD position past its cap still reports the rule as it stands, and
  // says what the rule will actually do.
  const unheld = buildIntention(db, fetch_(mk(null)), { price: 101 }, '2026-07-31T09:59:00Z', 'rev1', NOW)
  const card = unheld.armedActions.find(a => a.kind === 'time_cap_exit')
  assert.ok(card)
  assert.match(card.trigger, /full exit if the position is below \+0R, otherwise held/)
  assert.equal(unheld.invalidation.find(i => i.kind === 'time_cap').state, 'met')
})
