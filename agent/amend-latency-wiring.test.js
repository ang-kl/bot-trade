// node --test agent/amend-latency-wiring.test.js
//
// V3 M5 (P1/P4-6) — the WIRING half of amend latency: the paths that have no
// injectable amend of their own.
//   · executeBrokerAction reaches the broker through a module-level import, so
//     its MOVE_SL amend is exercised end to end against a stub gateway
//     (EXEC_ENGINE=cpp → POST /amend), not read from source;
//   · the runner-leg amend needs a live symbol lookup to be reached, so it is
//     pinned from source, comments stripped (failure mode #2);
//   · the fast monitor hands executeBrokerAction the due time it answered, so
//     the amend is recorded as ONE composite with its lateness;
//   · the manual route stamps its amends 'manual'.
// The per-module paths (book, guardian, keeper, trade guard, protect, restore,
// suggest, restrategize) are pinned in their own test files.
//
// loop.js memoises its prepared statements for the FIRST db it is handed, so
// every test here shares one db on purpose.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import express from 'express'
import { initDB, setState } from './db.js'
import { prepareStatements, executeBrokerAction, stampExitMarks } from './loop.js'
import { runFastMonitor, POSITION_WORK_KEY } from './services/fast-monitor.js'
import actionsRouter from './routes/actions.js'
import { _resetAmendLatencyForTests, _amendLatencyStateForTests } from './services/protection-latency.js'

const ENV_KEYS = ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'EXEC_ENGINE', 'EXEC_URL', 'EXEC_URL_DEMO', 'EXEC_URL_LIVE', 'EXEC_SECRET', 'EXEC_FALLBACK']
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

// The stub gateway: /connect always succeeds; /amend answers `nextAmend`.
let server
let requests = []
let nextAmend = { status: 200, body: '{}' }
before(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: raw })
      const resp = req.url === '/amend' ? nextAmend : { status: 200, body: '{}' }
      res.writeHead(resp.status, { 'content-type': 'application/json' })
      res.end(resp.body)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.CTRADER_CLIENT_ID = 'fixture'
  process.env.CTRADER_CLIENT_SECRET = 'fixture'
  process.env.EXEC_ENGINE = 'cpp'
  process.env.EXEC_URL = `http://127.0.0.1:${server.address().port}`
  delete process.env.EXEC_URL_DEMO
  delete process.env.EXEC_URL_LIVE
  process.env.EXEC_SECRET = 'sekret'
  process.env.EXEC_FALLBACK = '0' // a refused amend must not wander onto the WS path
})
after(() => {
  server.close()
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
})

const db = (() => {
  const d = initDB(':memory:')
  // Account 42: the executor's account (primary, demo). Its symbol list is
  // fresh and EMPTY, so the digits lookup answers "unknown" without a socket.
  setState(d, 'ctrader_account_id', '42')
  setState(d, 'ctrader_access_token', 'fixture')
  d.prepare(`INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES ('42', 0, 1, 'active')`).run()
  setState(d, 'symbol_id_map:42', JSON.stringify({ map: {}, builtAt: new Date().toISOString() }))
  // Account 1: the fast monitor's account, with its own symbol list.
  d.prepare(`INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES ('1', 0, 1, 'active')`).run()
  setState(d, 'symbol_id_map:1', JSON.stringify({ map: { EURUSD: 1, GBPUSD: 2 }, builtAt: new Date().toISOString() }))
  return d
})()
const s = prepareStatements(db)

function brokerPosition(positionId, { sl = 1.05, tp = 1.2 } = {}) {
  const tradeId = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, status, ctrader_position_id, account_id, opened_at)
    VALUES ('EURUSD', 'BUY', 1.1, 0.01, 'open', ?, '42', datetime('now'))`).run(String(positionId)).lastInsertRowid
  const id = db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, status, account_id, source)
    VALUES ('EURUSD', ?, 'long', 1.1, ?, ?, 'active', '42', 'autopilot')`).run(tradeId, sl, tp).lastInsertRowid
  return db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(id)
}

test('executeBrokerAction MOVE_SL: the amend the gateway answered is recorded with its round trip and, from the fast monitor, its lateness', async () => {
  _resetAmendLatencyForTests()
  requests = []
  nextAmend = { status: 200, body: '{}' }
  const pos = brokerPosition(9301)
  const evaluatedAtMs = Date.now()
  const out = await executeBrokerAction(db, s, pos, { action: 'MOVE_SL', newSL: 1.1, reason: 'test trail' }, 'fast_monitor',
    { dueAtMs: evaluatedAtMs - 30_000, evaluatedAtMs })
  assert.equal(out.error, undefined, JSON.stringify(out))
  assert.match(out.summary, /^SL → 1\.10000/)
  const amend = requests.find(r => r.url === '/amend')
  assert.ok(amend, 'the amend reached the gateway')
  assert.deepEqual(JSON.parse(amend.body), { positionId: 9301, stopLoss: 1.1, takeProfit: 1.2, ctidTraderAccountId: 42 }, 'the payload is what it always was')
  const { amends } = _amendLatencyStateForTests()
  assert.equal(amends.length, 1, 'one amend sent, one amend timed')
  const e = amends[0]
  assert.deepEqual([e.path, e.source, e.account, e.positionId, e.outcome], ['broker_action.move_sl', 'fast_monitor', '…42', '9301', 'ok'])
  assert.ok(e.ms >= 0 && e.ackAtMs >= e.sentAtMs)
  assert.equal(e.latenessMs, 30_000)
  assert.ok(Number.isFinite(e.compositeMs) && e.compositeMs >= 30_000 + e.ms, 'due → broker answer as one figure')
})

test('executeBrokerAction MOVE_SL: a gateway refusal is recorded with its broker code, the executor still reports it, and no due time means no composite', async () => {
  _resetAmendLatencyForTests()
  nextAmend = { status: 400, body: 'TRADING_BAD_STOPS: stop 1.1 is too close to 1.10012' }
  const pos = brokerPosition(9302)
  const out = await executeBrokerAction(db, s, pos, { action: 'MOVE_SL', newSL: 1.1, reason: 'test trail' }, 'position_manager')
  assert.match(out.error, /TRADING_BAD_STOPS/, 'the caller sees the refusal exactly as before')
  assert.equal(db.prepare('SELECT current_sl FROM monitored_positions WHERE id = ?').get(pos.id).current_sl, 1.05, 'nothing recorded as moved')
  const [e] = _amendLatencyStateForTests().amends
  assert.deepEqual([e.path, e.source, e.outcome, e.errorCode], ['broker_action.move_sl', 'position_manager', 'error', 'TRADING_BAD_STOPS'])
  assert.equal(e.compositeMs, undefined)
  assert.ok(!JSON.stringify(e).includes('1.10012'), 'no price from the message')
})

test('the runner-leg amend goes through the same recorder (source pin, comments stripped)', () => {
  const src = readFileSync(new URL('./loop.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
  const start = src.indexOf("if (action === 'PARTIAL_EXIT')")
  const end = src.indexOf('return { summary: `closed ', start)
  assert.ok(start > 0 && end > start, 'PARTIAL_EXIT branch not found — re-anchor')
  const branch = src.slice(start, end)
  assert.match(branch, /measureAmend\(amendMeta\('broker_action\.runner_leg'\), \(\) => execAmendPosition\(/)
  assert.equal((branch.match(/execAmendPosition\(/g) || []).length, 1, 'no second, untimed amend in the branch')
  const whole = src.slice(src.indexOf('export async function executeBrokerAction'), src.indexOf('export function stampExitMarks'))
  assert.equal((whole.match(/execAmendPosition\(/g) || []).length, (whole.match(/measureAmend\(amendMeta\('broker_action\.[a-z_]+'\), \(\) => execAmendPosition\(/g) || []).length,
    'every amend in the executor is timed')
})

// ---------------------------------------------------------------------------
// The fast monitor: the due time it answered travels with the action.
// ---------------------------------------------------------------------------
function capPosition(symbol) {
  // A winner past its time cap with its stop below breakeven → MOVE_SL (the
  // PR-J time-cap trail), the same shape exit-asymmetry.test.js drives.
  db.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, current_tp, initial_risk, status, source, strategy, time_cap_at, created_at)
    VALUES (?, 'BUY', 1.1, 1.095, NULL, 0.0050, 'active', 'autopilot', 'fib_618_fade', ?, datetime('now','-20 hours'))
  `).run(symbol, new Date(Date.now() - 3 * 3_600_000).toISOString())
  return db.prepare('SELECT id FROM monitored_positions WHERE symbol = ? ORDER BY id DESC').get(symbol).id
}

test('the fast monitor hands executeBrokerAction the due time it answered; lateness is kept only when the gap began with an evaluation', async () => {
  _resetAmendLatencyForTests()
  db.prepare(`UPDATE monitored_positions SET status = 'closed'`).run()
  const T = Date.now()
  const seen = capPosition('EURUSD')
  capPosition('GBPUSD')
  // EURUSD was last evaluated a while ago and fell due 45 s before this pass;
  // GBPUSD has no receipt (first sighting).
  setState(db, POSITION_WORK_KEY, JSON.stringify({ version: 1, positions: [
    { accountId: '1', positionId: seen, nextDueAt: new Date(T - 45_000).toISOString(), lastOutcome: 'evaluated', state: 'not_due' },
  ] }))
  const calls = []
  const out = await runFastMonitor(db, { ready: true, host: 'demo.ctraderapi.com', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '1' }, {
    exec: { sidecarQuotes: async () => null },
    ws: {
      wsGetTrendbarsBatch: async () => ({ '1m': [] }),
      wsGetSpotOnce: async () => ({ bid: 1.1099, ask: 1.1101 }),
    },
    loop: {
      prepareStatements: () => s,
      executeBrokerAction: async (_db, _s, pos, eval_, source, timing) => { calls.push({ symbol: pos.symbol, action: eval_.action, source, timing }); return { summary: 'ok' } },
      stampExitMarks,
    },
    now: () => T,
  })
  assert.equal(out.checked, 2, JSON.stringify(out))
  const bySym = Object.fromEntries(calls.map(c => [c.symbol, c]))
  assert.equal(bySym.EURUSD.action, 'MOVE_SL')
  assert.equal(bySym.EURUSD.source, 'fast_monitor')
  assert.deepEqual(bySym.EURUSD.timing, { dueAtMs: T - 45_000, evaluatedAtMs: T }, 'the carried nextDueAt, read before it is re-armed')
  assert.deepEqual(bySym.GBPUSD.timing, { dueAtMs: null, evaluatedAtMs: T }, 'a first sighting has no due time to be late against')
  const { lateness, excluded } = _amendLatencyStateForTests()
  assert.deepEqual(lateness, [[T, 45_000]])
  assert.equal(excluded.first_seen, 1)
})

// ---------------------------------------------------------------------------
// The manual route: POST /actions/position-protect is stamped 'manual'.
// ---------------------------------------------------------------------------
test('POST /actions/position-protect: the amend is timed with source "manual"', async (t) => {
  _resetAmendLatencyForTests()
  const tradeId = db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id) VALUES ('EURUSD', 'long', 'open', '42', '700')`).run().lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, status, account_id, current_sl, current_tp) VALUES ('EURUSD', ?, 'active', '42', 1.05, 1.2)`).run(tradeId)
  const sent = []
  const app = express()
  app.use(express.json())
  app.use('/actions', actionsRouter(db, { positionProtection: {
    readPosition: async () => ({ positionId: '700', stopLoss: 1.05, takeProfit: 1.2 }),
    amend: async (_c, args) => { sent.push(args); return {} },
  } }))
  const srv = await new Promise(resolve => { const x = app.listen(0, '127.0.0.1', () => resolve(x)) })
  t.after(() => new Promise(resolve => srv.close(resolve)))
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/actions/position-protect`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: '42', positionId: '700', tp: 1.21 }),
  })
  assert.equal(res.status, 200, await res.text())
  assert.equal(sent.length, 1)
  const [e] = _amendLatencyStateForTests().amends
  assert.deepEqual([e.path, e.source, e.account, e.positionId, e.outcome], ['position_protect', 'manual', '…42', '700', 'ok'])
})
