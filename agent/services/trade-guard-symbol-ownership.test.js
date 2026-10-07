// Codex · №11,737 · 2026-10-07; codex-footprint: guard-symbol-2026-10-07.
// Exercise the real account-scoped guard; only broker transports are stubbed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { runTradeGuards } from './trade-guard.js'

async function run(symbolId, { short = false, partial = false } = {}) {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1 }))
  const guard = partial
    ? { takeProfits: [{ price: 1.102, lots: 0.01 }] }
    : { trailing: { on: true, distancePips: 5 } }
  const side = short ? 'SELL' : 'BUY'
  const sl = short ? 1.105 : 1.095
  const id = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at, account_id)
    VALUES ('EURUSD', ?, 1.1, 0.02, '8', 'autopilot', 'open', datetime('now'), '42')`).run(side).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, thesis, initial_risk, source, status, account_id, guard_json)
    VALUES ('EURUSD', ?, ?, 1.1, ?, 1.12, 't', 1, 'autopilot', 'active', '42', ?)`).run(id, side, sl, JSON.stringify(guard))
  const calls = { quotes: [], metadata: [], amends: [], closes: [] }
  const creds = { accountId: '42', host: 'owned-host', clientId: 'c', clientSecret: 's', accessToken: 't' }
  try {
    const summary = await runTradeGuards(db, creds, {
      exec: {
        reconcile: async () => ({ position: [{ positionId: 8, price: 1.1, stopLoss: sl, takeProfit: 1.12, tradeData: { symbolId } }] }),
        amendPosition: async (_creds, args) => { calls.amends.push(args); return { protection: { stopLoss: args.stopLoss } } },
        closePosition: async (_creds, args) => { calls.closes.push(args); return {} },
      },
      ws: { wsGetLastCloses: async (host, _c, _s, _t, account, ids) => {
        calls.quotes.push({ host, account, ids })
        // ID 1 names another instrument on this account, with another pip unit.
        return { 1: short ? 0.8 : 1.5, 77: short ? 1.0975 : 1.1025 }
      } },
      sizing: { getVolumeMeta: async (host, _c, _s, _t, account, id) => {
        calls.metadata.push({ host, account, id })
        return id === 77 ? { pipPosition: 4, digits: 5, lotSize: 100000 } : { pipPosition: 2, digits: 2, lotSize: 100 }
      } },
      notify: () => {},
    })
    return { summary, calls }
  } finally { db.close() }
}

for (const short of [false, true]) test(`guard calculates the ${short ? 'short' : 'long'} stop from the owned broker symbol, not the selected-account map`, async () => {
  const { summary, calls } = await run(short ? '77' : 77, { short })
  assert.equal(summary.slMoves, 1, JSON.stringify(summary))
  assert.deepEqual(calls.quotes, [{ host: 'owned-host', account: '42', ids: [77] }])
  assert.deepEqual(calls.metadata, [{ host: 'owned-host', account: '42', id: 77 }])
  assert.equal(calls.amends[0].stopLoss, short ? 1.098 : 1.102)
  assert.equal(calls.amends[0].expectedSymbolId, 77)
  assert.equal(calls.amends[0].expectedDirection, short ? -1 : 1)
  assert.equal(calls.amends[0].takeProfit, 1.12)
  assert.equal(calls.amends[0].ratchetOnly, true)
})

test('guard partial profit uses the owned symbol quote and lot units', async () => {
  const { summary, calls } = await run(77, { partial: true })
  assert.equal(summary.partialCloses, 1, JSON.stringify(summary))
  assert.deepEqual(calls.quotes[0].ids, [77])
  assert.equal(calls.metadata[0].id, 77)
  assert.equal(calls.closes[0].volume, 1000)
})

test('a missing or malformed broker symbol refuses both stop and partial actions without fallback', async () => {
  for (const id of [undefined, null, '', ' ', true, false, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const partial of [false, true]) {
      const { summary, calls } = await run(id, { partial })
      assert.equal(summary.refused, 1, `symbol=${String(id)}, partial=${partial}: ${JSON.stringify(summary)}`)
      assert.match(summary.errors.join(' '), /broker symbol/i)
      assert.deepEqual(calls, { quotes: [], metadata: [], amends: [], closes: [] })
    }
  }
})
