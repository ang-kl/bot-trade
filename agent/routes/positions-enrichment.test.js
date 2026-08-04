// node --test agent/routes/positions-enrichment.test.js
//
// Owner, 04-08-2026, with a screenshot of OPEN NOW — FLOATING: "computation of
// summation and individual P/L and TP/SL missing again."
//
// THE BUG. POST /actions/broker-positions snapshots every registered account,
// then cached exactly ONE of them — the selected account — under the global
// key `broker_snapshot_cache_json`. GET /state/positions enriched every row
// from that single cache, so a position on any other account matched nothing
// and rendered P&L, price and the daily bar as "—".
//
// Measured on production the same day: of 21 open positions, only the 6 on
// account 47790949 (the selected one) carried numbers. Every row on 46130058
// and 43097342 was blank — including the whole floating table the owner was
// looking at, which is why the header summed to "—" as well.
//
// "Again" is the tell. Which rows went blank moved with the account picker, so
// it looked intermittent rather than like the scoping bug it is. These tests
// pin the scoping, not the symptom.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'

function server() {
  const db = initDB(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({
      db, close: () => s.close(),
      url: (p) => `http://127.0.0.1:${s.address().port}${p}`,
    }))
  })
}

/** An open position on `accountId`, linked to a trade carrying the broker id. */
function openPosition(db, { symbol, accountId, ctid }) {
  const t = db.prepare(
    `INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id, volume)
     VALUES (?, 'buy', 'open', ?, ?, 1000)`
  ).run(symbol, accountId, ctid).lastInsertRowid
  db.prepare(
    `INSERT INTO monitored_positions (trade_id, symbol, side, status, account_id, entry_price, current_sl, current_tp)
     VALUES (?, ?, 'buy', 'active', ?, 1.1, 1.0, 1.3)`
  ).run(t, symbol, accountId)
}

const snapshot = (positions) => JSON.stringify({
  account: { positions }, fetchedAt: '2026-08-04T07:00:00.000Z',
})

const positions = (s) => fetch(s.url('/state/positions?account=all')).then(r => r.json())
const bySymbol = (body) => Object.fromEntries((body.positions || []).map(p => [p.symbol, p]))

test('EVERY account\'s rows carry P&L, not just the selected account\'s', async () => {
  const s = await server()
  openPosition(s.db, { symbol: 'EURNOK', accountId: '46130058', ctid: '234866453' })
  openPosition(s.db, { symbol: 'NZDUSD', accountId: '47790949', ctid: '234873267' })
  setState(s.db, 'acct:46130058:broker_snapshot_cache_json',
    snapshot([{ positionId: '234866453', pnl: -12.5, currentPrice: 11.1 }]))
  setState(s.db, 'acct:47790949:broker_snapshot_cache_json',
    snapshot([{ positionId: '234873267', pnl: -35.7, currentPrice: 0.58679 }]))

  const rows = bySymbol(await positions(s))
  assert.equal(rows.EURNOK.live_pnl, -12.5, 'the non-selected account is the one that used to read "—"')
  assert.equal(rows.NZDUSD.live_pnl, -35.7)
  assert.equal(rows.EURNOK.live_price, 11.1)
  s.close()
})

test('a row is NEVER enriched from another account\'s snapshot', async () => {
  // Broker position ids are unique per account, not globally — reading across
  // accounts would put one account's money on another's row, which is worse
  // than the blank it replaces.
  const s = await server()
  openPosition(s.db, { symbol: 'EURNOK', accountId: '46130058', ctid: '999' })
  setState(s.db, 'acct:47790949:broker_snapshot_cache_json',
    snapshot([{ positionId: '999', pnl: 1000, currentPrice: 5 }]))

  const rows = bySymbol(await positions(s))
  assert.equal(rows.EURNOK.live_pnl, null, 'a foreign snapshot must not fill this row')
  s.close()
})

test('an account with no cache of its own still falls back to the shared one', async () => {
  // A database written before per-account caching, or an account whose first
  // snapshot has not landed yet. The global key is the old behaviour, kept.
  const s = await server()
  openPosition(s.db, { symbol: 'GBPAUD', accountId: '47790949', ctid: '234873274' })
  setState(s.db, 'broker_snapshot_cache_json',
    snapshot([{ positionId: '234873274', pnl: 41.97, currentPrice: 1.91436 }]))

  const rows = bySymbol(await positions(s))
  assert.equal(rows.GBPAUD.live_pnl, 41.97)
  s.close()
})

test('an unattributed row reads the shared cache — it has no account to prefer', async () => {
  const s = await server()
  openPosition(s.db, { symbol: 'USDZAR', accountId: null, ctid: '234848347' })
  setState(s.db, 'broker_snapshot_cache_json',
    snapshot([{ positionId: '234848347', pnl: 7.25, currentPrice: 18.2 }]))

  const rows = bySymbol(await positions(s))
  assert.equal(rows.USDZAR.live_pnl, 7.25)
  s.close()
})

test('a malformed cache leaves the row blank rather than breaking the list', async () => {
  // The positions list is how the operator sees open exposure. A bad cache
  // must cost the enrichment, never the rows.
  const s = await server()
  openPosition(s.db, { symbol: 'EURNOK', accountId: '46130058', ctid: '1' })
  setState(s.db, 'acct:46130058:broker_snapshot_cache_json', '{not json')

  const body = await positions(s)
  assert.equal((body.positions || []).length, 1)
  assert.equal(bySymbol(body).EURNOK.live_pnl, null)
  s.close()
})

test('the P&L timestamp comes from the SAME cache the number did', async () => {
  // Two caches refresh at different moments. Stamping one account's number
  // with another's fetch time is how a stale figure looks current.
  const s = await server()
  openPosition(s.db, { symbol: 'EURNOK', accountId: '46130058', ctid: '5' })
  setState(s.db, 'broker_snapshot_cache_json', JSON.stringify({
    account: { positions: [] }, fetchedAt: '2026-08-04T01:00:00.000Z',
  }))
  setState(s.db, 'acct:46130058:broker_snapshot_cache_json', JSON.stringify({
    account: { positions: [{ positionId: '5', pnl: -1 }] }, fetchedAt: '2026-08-04T07:30:00.000Z',
  }))

  assert.equal(bySymbol(await positions(s)).EURNOK.live_pnl_at, '2026-08-04T07:30:00.000Z')
  s.close()
})
