import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB, setState } from '../db.js'
import {
  PROPOSABLE, clampProposal, parseAssessment, buildPrompt, buildContext,
  runReassessment, loadLastAssessment, markApplied,
} from './risk-reassess.js'

const CTX = {
  balanceUsd: 1000, leverage: 200, openPositions: 0, includeWatchlist: false,
  watchlist: [], watchlistCount: 0,
  stats: { closedTrades: 9, winRatePct: 44.4, avgWinUsd: 40, avgLossUsd: -60, worstLossUsd: -1013, netUsd: -200 },
  current: { perTradeRiskPct: 0.05, maxOpenPositions: 5, dailyLossLimit: 300, minRR: 1.5 },
}

test('clampProposal holds the envelope — a model cannot ask for 90% per trade', () => {
  const c = clampProposal('perTradeRiskPct', 0.9)
  assert.equal(c.value, PROPOSABLE.perTradeRiskPct.max)
  assert.equal(c.clamped, true)
})

test('clampProposal rounds ints and rejects nonsense', () => {
  assert.equal(clampProposal('maxOpenPositions', 3.7).value, 4)
  assert.equal(clampProposal('maxOpenPositions', 'lots'), null)
  assert.equal(clampProposal('maxOpenPositions', null), null)
  assert.equal(clampProposal('notAKey', 1), null)
})

test('a percent written as 2 is read as 0.02 only when that lands in range', () => {
  // 2 → 0.02, inside 0.0025..0.03, so the intent is unambiguous.
  assert.deepEqual(clampProposal('perTradeRiskPct', 2), { value: 0.02, clamped: false })
  // 50 → 0.5, OUTSIDE the per-trade envelope, so it must clamp honestly to the
  // max rather than be creatively reinterpreted.
  assert.equal(clampProposal('perTradeRiskPct', 50).value, PROPOSABLE.perTradeRiskPct.max)
  assert.equal(clampProposal('perTradeRiskPct', 50).clamped, true)
})

test('parseAssessment keeps good proposals, names the rejects, drops no-ops', () => {
  const out = parseAssessment(JSON.stringify({
    summary: 'Small account, thin sample. Cut size.',
    warnings: ['only 9 closed trades'],
    proposals: [
      { key: 'perTradeRiskPct', value: 0.01, reason: 'survival on $1k' },
      { key: 'maxOpenPositions', value: 3, reason: 'fewer concurrent bets' },
      { key: 'minRR', value: 1.5, reason: 'unchanged' },        // no-op → dropped
      { key: 'leverage', value: 500, reason: 'not allowed' },    // not proposable
      { key: 'dailyLossPct', value: 'aggressive' },              // unusable
    ],
  }), CTX)

  assert.deepEqual(out.proposals.map(p => p.key), ['perTradeRiskPct', 'maxOpenPositions'])
  assert.equal(out.proposals[0].current, 0.05)
  assert.equal(out.proposals[0].proposed, 0.01)
  assert.equal(out.proposals[0].label, 'Risk per trade')
  assert.deepEqual(out.rejected.map(r => r.key), ['leverage', 'dailyLossPct'])
  assert.equal(out.warnings.length, 1)
})

test('parseAssessment tolerates a fenced code block', () => {
  const out = parseAssessment('```json\n{"summary":"ok","proposals":[]}\n```', CTX)
  assert.equal(out.summary, 'ok')
  assert.deepEqual(out.proposals, [])
})

test('the prompt EXCLUDES instruments when the watchlist is not requested', () => {
  const p = buildPrompt({ ...CTX, includeWatchlist: false })
  assert.match(p, /DELIBERATELY EXCLUDED/)
  assert.doesNotMatch(p, /BTCUSD/)
})

test('the prompt INCLUDES the watchlist when requested, and says how many', () => {
  const p = buildPrompt({
    ...CTX, includeWatchlist: true, watchlist: ['BTCUSD', 'EURUSD'], watchlistCount: 2,
  })
  assert.match(p, /2 symbols/)
  assert.match(p, /BTCUSD, EURUSD/)
})

test('an empty watchlist is stated, never invented', () => {
  const p = buildPrompt({ ...CTX, includeWatchlist: true, watchlist: [], watchlistCount: 0 })
  assert.match(p, /Empty\./)
  assert.match(p, /do not invent/i)
})

test('the prompt carries no credentials', () => {
  const p = buildPrompt({ ...CTX, includeWatchlist: true, watchlist: ['BTCUSD'], watchlistCount: 1 })
  for (const bad of ['API_KEY', 'accessToken', 'clientSecret', 'Bearer ']) {
    assert.ok(!p.includes(bad), `prompt must not contain ${bad}`)
  }
})

// --- end to end, with a fake model ----------------------------------------

// THE REAL SCHEMA, via initDB — not a hand-written table.
//
// The first version of this file created its own `trades` table with a
// `pnl_usd` column. That column does not exist in production (db.js declares
// gross_pnl and net_pnl), so tradeStats threw on every real database, the broad
// catch reported "0 closed trades", and the test passed anyway because it had
// invented the column the code was querying. A test that builds its own schema
// cannot catch a schema mismatch. This one uses initDB against a temp file, so
// the query runs against exactly the columns the agent has.
function seedDb() {
  const dir = mkdtempSync(join(tmpdir(), 'risk-reassess-'))
  const db = initDB(join(dir, 'test.db'))
  setState(db, 'account_balance_usd', '1000')
  setState(db, 'watchlist_json', '["BTCUSD","EURUSD","XAUUSD"]')
  const t = db.prepare(
    `INSERT INTO trades (symbol, side, status, net_pnl, gross_pnl, account_id)
     VALUES (?, 'BUY', 'closed', ?, ?, ?)`
  )
  t.run('EURUSD', 40, 42, '46130058')
  t.run('GBPUSD', -60, -58, '46130058')
  t.run('NAS100', -1013, -1010, '46130058')
  return db
}

function fakeModel(answer) {
  return async () => ({
    provider: 'openai', model: 'gpt-5.6-luna',
    messages: { async create() { return { content: [{ type: 'text', text: answer }], model: 'gpt-5.6-luna' } } },
  })
}

test('runReassessment stores a PROPOSAL and applies nothing', async () => {
  const db = seedDb()
  const answer = JSON.stringify({
    summary: 'Cut size.', warnings: [],
    proposals: [{ key: 'perTradeRiskPct', value: 0.01, reason: 'thin sample' }],
  })
  const configBefore = db.prepare("SELECT value FROM agent_state WHERE key='risk_config_json'").get()?.value ?? null
  const result = await runReassessment(db,
    { provider: 'openai', model: 'gpt-5.6-luna', includeWatchlist: true, accountId: '46130058' },
    { createClient: fakeModel(answer), now: () => new Date('2026-07-30T00:30:00Z') })

  assert.equal(result.watchlistCount, 3, 'the run records the watchlist symbol count')
  assert.equal(result.at, '2026-07-30T00:30:00.000Z')
  assert.equal(result.includeWatchlist, true)
  assert.equal(result.applied, false)
  assert.equal(result.proposals.length, 1)
  // The crucial assertion: a reassessment does not change the risk config.
  // (The real schema seeds a risk_config_json row, so compare the VALUE — an
  // absence check would pass for the wrong reason.)
  assert.equal(configBefore, db.prepare("SELECT value FROM agent_state WHERE key='risk_config_json'").get()?.value ?? null)
  // ...and it is readable back for the "last run" panel.
  assert.equal(loadLastAssessment(db).at, result.at)
})

test('a run without the watchlist reports zero symbols', async () => {
  const db = seedDb()
  const result = await runReassessment(db,
    { provider: 'openai', model: 'm', includeWatchlist: false },
    { createClient: fakeModel('{"summary":"s","proposals":[]}'), now: () => new Date('2026-07-30T00:00:00Z') })
  assert.equal(result.watchlistCount, 0)
  assert.equal(result.includeWatchlist, false)
})

test('an unknown balance refuses to run rather than guess one', async () => {
  const db = seedDb()
  db.prepare("DELETE FROM agent_state WHERE key='account_balance_usd'").run()
  db.prepare("DELETE FROM agent_state WHERE key LIKE 'acct:%account_balance_usd'").run()
  await assert.rejects(
    () => runReassessment(db, { provider: 'openai', model: 'm' },
      { createClient: fakeModel('{"summary":"s","proposals":[]}') }),
    /balance is unknown/)
})

test('markApplied records which keys went in', async () => {
  const db = seedDb()
  await runReassessment(db, { provider: 'openai', model: 'm' },
    { createClient: fakeModel('{"summary":"s","proposals":[{"key":"minRR","value":2,"reason":"r"}]}'),
      now: () => new Date('2026-07-30T00:00:00Z') })
  const after = markApplied(db, ['minRR'], new Date('2026-07-30T00:05:00Z'))
  assert.equal(after.applied, true)
  assert.deepEqual(after.appliedKeys, ['minRR'])
  assert.equal(after.appliedAt, '2026-07-30T00:05:00.000Z')
})

test('buildContext exposes only the proposable keys as "current"', () => {
  const db = seedDb()
  const ctx = buildContext(db, { accountId: '46130058', includeWatchlist: true })
  assert.deepEqual(Object.keys(ctx.current).sort(), Object.keys(PROPOSABLE).sort())
  assert.equal(ctx.stats.closedTrades, 3)
  assert.equal(ctx.stats.worstLossUsd, -1013)
  assert.equal(ctx.watchlistCount, 3)
})
