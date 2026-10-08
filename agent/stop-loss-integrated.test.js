// Codex · №12,183 · 2026-10-08; codex-footprint: fixtures retain account-owned writer provenance.
// node --test agent/stop-loss-integrated.test.js
//
// The integrated stop-loss suite (02-10-2026, PR-3; owner: "Integrated testing
// for stop-loss ensuring MAE & Chandeliers are also tested work"). The REAL
// executeBrokerAction, exec-engine, stop policy, controller and trailing
// registry against a STATEFUL sidecar+broker model (test-support/
// stop-broker-model.js): an amend that replaces protection, a broker that
// trails a stop server-side, a policy the broker can refuse. Single steps are
// pinned in stop-amend-rail.test.js; this file pins the SEQUENCES — what the
// broker ends up holding after the ladder, the trail, the Chandelier and the
// controller have all had their turn — and runs each under both answers to the
// plan's four unknowns (omitted flags reset/preserve; trailing distance from
// the amend/the entry), so a default that turns out wrong live cannot break
// an invariant silently.
//
// The Chandelier legs (fast tick and slow pass) are in services/
// stop-loss-chandelier-integrated.test.js: loop.js memoises its prepared
// statements for the first db, and the two files need different symbol maps.
//
// loop.js memoises its prepared statements for the FIRST db it is handed, so
// every test here shares one db on purpose.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from './db.js'
import { prepareStatements, executeBrokerAction } from './loop.js'
import { startStopBrokerModel, COOLDOWN_MS } from './test-support/stop-broker-model.js'
import { setStopPolicy, resetTrailingRegistry, isTrailing, stopPolicyStats, resetStopPolicyStats } from './lib/stop-policy.js'
import { runStopPolicyPass, resetStopPolicyController } from './services/stop-policy-controller.js'
import { invalidateSidecarSession } from './lib/exec-engine.js'

const ENV_KEYS = ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'EXEC_ENGINE', 'EXEC_URL', 'EXEC_URL_DEMO', 'EXEC_URL_LIVE', 'EXEC_SECRET', 'EXEC_FALLBACK']
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
const ACCOUNT = '42'
let model = null

const db = (() => {
  const d = initDB(':memory:')
  setState(d, 'ctrader_account_id', ACCOUNT)
  setState(d, 'ctrader_access_token', 'fixture')
  d.prepare(`INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES (?, 0, 1, 'active')`).run(ACCOUNT)
  setState(d, `symbol_id_map:${ACCOUNT}`, JSON.stringify({ accountId: String(ACCOUNT), map: {}, builtAt: new Date().toISOString() }))
  return d
})()
const s = prepareStatements(db)

before(() => {
  process.env.CTRADER_CLIENT_ID = 'fixture'
  process.env.CTRADER_CLIENT_SECRET = 'fixture'
  process.env.EXEC_ENGINE = 'cpp'
  delete process.env.EXEC_URL_DEMO
  delete process.env.EXEC_URL_LIVE
  process.env.EXEC_SECRET = 'sekret'
  process.env.EXEC_FALLBACK = '0'
})
after(() => { for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] } })

async function useModel(opts) {
  if (model) await model.close()
  model = await startStopBrokerModel({ account: ACCOUNT, ...opts })
  process.env.EXEC_URL = model.url
  invalidateSidecarSession()
  return model
}
beforeEach(() => { setStopPolicy(null); resetTrailingRegistry(); resetStopPolicyController(); resetStopPolicyStats() })
after(async () => { if (model) await model.close() })

/** A broker position plus the bot's rows for it (trade + monitored position). */
function openPosition({ side = 'BUY', entry = 100, sl = 95, tp = 110, book = false, trigger = 1 } = {}) {
  const bp = model.open({ tradeSide: side, entry, stopLoss: sl, takeProfit: tp, trigger })
  const tradeId = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, status, ctrader_position_id, account_id, opened_at)
    VALUES ('EURUSD', ?, ?, 0.01, 'open', ?, ?, datetime('now'))`).run(side, entry, String(bp.positionId), ACCOUNT).lastInsertRowid
  const id = db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, status, account_id, source)
    VALUES ('EURUSD', ?, ?, ?, ?, ?, 'active', ?, 'autopilot')`).run(tradeId, side, entry, sl, tp, ACCOUNT).lastInsertRowid
  if (book) {
    db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entered_at, status)
      VALUES (?, ?, 'EURUSD', ?, 'long', ?, ?, datetime('now'), 'open')`).run(tradeId, ACCOUNT, String(bp.positionId), entry, sl)
    db.prepare('UPDATE monitored_positions SET paused = 1 WHERE trade_id = ?').run(tradeId)
  }
  return { bp, row: () => db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(id), tradeId }
}
const move = (pos, newSL, reason = 'ladder') => executeBrokerAction(db, s, pos.row(), { action: 'MOVE_SL', newSL, reason }, 'position_manager')

const COMBOS = [
  { omittedFlags: 'preserve', trailingAnchor: 'amend' },
  { omittedFlags: 'reset', trailingAnchor: 'amend' },
  { omittedFlags: 'preserve', trailingAnchor: 'entry' },
  { omittedFlags: 'reset', trailingAnchor: 'entry' },
]
const label = c => `omittedFlags=${c.omittedFlags}, trailing anchored to the ${c.trailingAnchor === 'entry' ? 'entry' : 'amend'}`

// ---------------------------------------------------------------------------
// The rig must be able to go red: a plain amend with no policy fields RESETS
// the trigger under 'reset', which is the whole reason the policy is stamped at
// one chokepoint. If this test ever passed with the flags kept, every
// "Opposite after the ladder" assertion below would prove nothing.
// ---------------------------------------------------------------------------
test('rig self-check: an amend that omits the policy fields resets them when the broker does that, and the model is not lenient', async () => {
  await useModel({ omittedFlags: 'reset' })
  const p = model.open({ entry: 100, stopLoss: 95, takeProfit: 110, trigger: 2, trailing: true })
  await fetch(`${model.url}/amend`, { method: 'POST', body: JSON.stringify({ positionId: p.positionId, stopLoss: 96, takeProfit: 110 }) })
  assert.equal(model.position(p.positionId).trigger, 1, 'the trigger fell back to TRADE')
  assert.equal(model.position(p.positionId).trailing, false, 'the trailing flag was cleared')
  await fetch(`${model.url}/amend`, { method: 'POST', body: JSON.stringify({ positionId: p.positionId, stopLoss: 97 }) })
  assert.equal(model.position(p.positionId).takeProfit, null, 'a plain amend with no target REPLACES it with none')
})

for (const combo of COMBOS) {
  test(`ladder sequence (${label(combo)}): Opposite on every amend, trailing only once the stop locks profit, the target survives every step`, async () => {
    await useModel(combo)
    const pos = openPosition({ entry: 100, sl: 95, tp: 110 })
    for (const [newSL, wantTrailing] of [[97, false], [100, true], [102, true], [103, true]]) {
      const out = await move(pos, newSL)
      assert.equal(out.error, undefined, JSON.stringify(out))
      const held = model.position(pos.bp.positionId)
      assert.equal(held.stopLoss, newSL, `stop ${newSL} held`)
      assert.equal(held.trigger, 2, `Opposite after the move to ${newSL}`)
      assert.equal(held.takeProfit, 110, `the target survives the move to ${newSL}`)
      assert.equal(held.trailing, wantTrailing, `trailing ${wantTrailing} after the move to ${newSL}`)
      assert.equal(out.protection?.verified, true, 'the sidecar read the broker back')
      assert.equal(out.policy?.readback, 'confirmed')
    }
    assert.ok(isTrailing(ACCOUNT, pos.bp.positionId), 'the bot recorded that it asked the broker to trail this position')
  })

  test(`broker trails ahead of the bot (${label(combo)}): a stale decision never loosens the stop, the stored stop becomes the broker's`, async () => {
    await useModel(combo)
    const pos = openPosition({ entry: 100, sl: 95, tp: 130 })
    await move(pos, 101)
    model.price(7, { bid: 106, ask: 106.02 }) // the broker trails the stop up on its own
    const brokerStop = model.position(pos.bp.positionId).stopLoss
    assert.ok(brokerStop > 101, `the broker moved the stop to ${brokerStop} without the bot`)
    const out = await move(pos, 102, 'stale ladder decision')
    assert.equal(out.error, undefined)
    assert.equal(out.unchanged, true, 'the broker already held a tighter stop')
    assert.equal(model.position(pos.bp.positionId).stopLoss, brokerStop, 'the stop did not move back')
    assert.equal(pos.row().current_sl, brokerStop, 'the stored stop is the broker\'s')
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM position_events WHERE trade_id = ? AND kind = 'sl_moved' AND to_value = 102`).get(pos.tradeId).n, 0, 'a move that never happened is not journalled')
    assert.equal(model.position(pos.bp.positionId).takeProfit, 130)
  })

  test(`random walk (${label(combo)}): over 120 steps of price and stale bot decisions the broker stop never loosens, stays Opposite and keeps its target`, async () => {
    await useModel(combo)
    const pos = openPosition({ entry: 100, sl: 95, tp: 200 })
    let seed = 20261002
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
    let price = 100, floor = 95
    for (let i = 0; i < 120; i++) {
      price = Math.max(96, price + (rnd() - 0.45) * 2)
      model.price(7, { bid: price, ask: price + 0.02 })
      if (rnd() < 0.5) {
        const stored = pos.row().current_sl
        // a decision from the STORED stop, possibly looser than the broker's now
        const target = stored + rnd() * Math.max(0.01, price - stored - 0.5)
        if (target < price - 0.3) await move(pos, Math.round(target * 1e4) / 1e4, `step ${i}`)
      }
      const held = model.position(pos.bp.positionId)
      assert.ok(held.stopLoss >= floor - 1e-9, `step ${i}: the stop ${held.stopLoss} loosened below ${floor}`)
      floor = held.stopLoss
      assert.equal(held.takeProfit, 200, `step ${i}: the target survived`)
      if (held.stopLoss !== 95) assert.equal(held.trigger, 2, `step ${i}: Opposite once the bot has amended`)
    }
    assert.ok(floor > 95, 'the stop moved during the walk')
  })
}

// ---------------------------------------------------------------------------
// The controller (existing positions) and the amend path agree on one result.
// ---------------------------------------------------------------------------
const credsFor = () => ({ ready: true, accountId: ACCOUNT, isLive: false, host: 'demo.ctraderapi.com', clientId: 'fixture', clientSecret: 'fixture', accessToken: 'fixture' })

test('controller: a Trade-trigger position is stamped Opposite once, the stop and target do not move, and the next pass finds it compliant', async () => {
  await useModel()
  const pos = openPosition({ entry: 100, sl: 95, tp: 110, trigger: 1 })
  const p1 = await runStopPolicyPass(db, credsFor(), { nowMs: 1_800_000_000_000 })
  assert.equal(p1.stamped, 1, JSON.stringify(p1))
  const held = model.position(pos.bp.positionId)
  assert.equal(held.trigger, 2)
  assert.equal(held.stopLoss, 95, 'the stop level did not move')
  assert.equal(held.takeProfit, 110, 'the target did not move')
  assert.equal(held.trailing, false, 'a stop below entry is never trailed')
  const before = model.amends.length
  const p2 = await runStopPolicyPass(db, credsFor(), { nowMs: 1_800_000_000_000 + 7 * 3_600_000 })
  assert.equal(p2.compliant, 1, 're-asked after the recheck window: already compliant')
  assert.equal(model.amends.length, before, 'a compliant position is not amended')
})

test('controller: a position whose stop already locks profit is also asked to trail, a momentum-book row is stamped Opposite only', async () => {
  await useModel()
  const locked = openPosition({ entry: 100, sl: 101, tp: 120, trigger: 1 })
  const book = openPosition({ entry: 100, sl: 101, tp: 120, trigger: 1, book: true })
  await runStopPolicyPass(db, credsFor(), { nowMs: 1_800_000_000_000 })
  await runStopPolicyPass(db, credsFor(), { nowMs: 1_800_000_000_000 + 61_000 })
  assert.equal(model.position(locked.bp.positionId).trailing, true)
  assert.equal(model.position(book.bp.positionId).trigger, 2, 'the book row is Opposite too')
  assert.equal(model.position(book.bp.positionId).trailing, false, 'but never broker-trailed: the book trails by its own rule')
})

// ---------------------------------------------------------------------------
// The broker refuses the policy fields: the STOP still goes through.
// ---------------------------------------------------------------------------
test('broker refuses the policy fields: the stop is applied without them, the refusal is recorded, the cooldown holds, nothing is marked trailed', async () => {
  await useModel({ refuseFlags: true })
  const pos = openPosition({ entry: 100, sl: 95, tp: 110 })
  const out = await move(pos, 101)
  assert.equal(out.error, undefined, 'a refused policy never fails the stop')
  assert.equal(model.position(pos.bp.positionId).stopLoss, 101, 'the stop moved')
  assert.equal(model.position(pos.bp.positionId).takeProfit, 110)
  assert.equal(model.position(pos.bp.positionId).trigger, 1, 'the broker kept Trade: the flags were refused')
  assert.equal(out.policy.applied, false)
  assert.ok(out.policy.refused, 'the refusal is on the outcome')
  assert.equal(isTrailing(ACCOUNT, pos.bp.positionId), false, 'a refused trailing request is not recorded as a trail')
  const again = await move(pos, 102)
  assert.equal(again.policy.skipped, 'cooldown', 'inside the cooldown the flags are not retried')
  assert.equal(model.position(pos.bp.positionId).stopLoss, 102, 'and the stop still moves')
  const { counts } = stopPolicyStats()
  assert.equal(counts.refused, 1, 'the refusal is counted for GET /state/stop-policy')
  assert.equal(counts.cooldown, 1, 'the cooldown skip is counted')
  assert.equal(counts.applied, 0, 'nothing was applied')
  model.tick(COOLDOWN_MS + 1)
  await move(pos, 103)
  assert.equal(stopPolicyStats().counts.refused, 2, 'after the cooldown the broker is asked again')
})

test('kill switch: with the policy off no amend carries a policy field and the controller sends nothing', async () => {
  await useModel()
  setStopPolicy({ enabled: false })
  const pos = openPosition({ entry: 100, sl: 95, tp: 110 })
  await move(pos, 101)
  const sent = model.amendRequests().at(-1)
  assert.equal('stopLossTriggerMethod' in sent, false)
  assert.equal('trailingStopLoss' in sent, false)
  const before = model.amendRequests().length
  const pass = await runStopPolicyPass(db, credsFor(), { nowMs: 1_800_000_000_000 })
  assert.equal(model.amendRequests().length, before, 'the controller stamped nothing')
  assert.equal(pass.stamped ?? 0, 0)
})
