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
  try {
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
  } finally { s.close() }
})

test('a row is NEVER enriched from another account\'s snapshot', async () => {
  // Broker position ids are unique per account, not globally — reading across
  // accounts would put one account's money on another's row, which is worse
  // than the blank it replaces.
  const s = await server()
  try {
    openPosition(s.db, { symbol: 'EURNOK', accountId: '46130058', ctid: '999' })
    setState(s.db, 'acct:47790949:broker_snapshot_cache_json',
      snapshot([{ positionId: '999', pnl: 1000, currentPrice: 5 }]))

    const rows = bySymbol(await positions(s))
    assert.equal(rows.EURNOK.live_pnl, null, 'a foreign snapshot must not fill this row')
  } finally { s.close() }
})

test('an account with no cache of its own still falls back to the shared one', async () => {
  // A database written before per-account caching, or an account whose first
  // snapshot has not landed yet. The global key is the old behaviour, kept.
  const s = await server()
  try {
    openPosition(s.db, { symbol: 'GBPAUD', accountId: '47790949', ctid: '234873274' })
    // Claude · № 14,009 13-Oct (owner: Codex P2 #7 "Fix #7 strict"): the shared
    // cache stands in only when it NAMES this account; an unnamed one does not.
    setState(s.db, 'broker_snapshot_cache_json', JSON.stringify({
      account: { accountId: 47790949, positions: [{ positionId: '234873274', pnl: 41.97, currentPrice: 1.91436 }] },
      fetchedAt: '2026-08-04T07:00:00.000Z',
    }))

    const rows = bySymbol(await positions(s))
    assert.equal(rows.GBPAUD.live_pnl, 41.97)
  } finally { s.close() }
})

test('an unattributed row reads the shared cache — it has no account to prefer', async () => {
  const s = await server()
  try {
    openPosition(s.db, { symbol: 'USDZAR', accountId: null, ctid: '234848347' })
    setState(s.db, 'broker_snapshot_cache_json',
      snapshot([{ positionId: '234848347', pnl: 7.25, currentPrice: 18.2 }]))

    const rows = bySymbol(await positions(s))
    assert.equal(rows.USDZAR.live_pnl, 7.25)
  } finally { s.close() }
})

test('a malformed cache leaves the row blank rather than breaking the list', async () => {
  // The positions list is how the operator sees open exposure. A bad cache
  // must cost the enrichment, never the rows.
  const s = await server()
  try {
    openPosition(s.db, { symbol: 'EURNOK', accountId: '46130058', ctid: '1' })
    setState(s.db, 'acct:46130058:broker_snapshot_cache_json', '{not json')

    const body = await positions(s)
    assert.equal((body.positions || []).length, 1)
    assert.equal(bySymbol(body).EURNOK.live_pnl, null)
  } finally { s.close() }
})

test('the P&L timestamp comes from the SAME cache the number did', async () => {
  // Two caches refresh at different moments. Stamping one account's number
  // with another's fetch time is how a stale figure looks current.
  const s = await server()
  try {
    openPosition(s.db, { symbol: 'EURNOK', accountId: '46130058', ctid: '5' })
    setState(s.db, 'broker_snapshot_cache_json', JSON.stringify({
      account: { positions: [] }, fetchedAt: '2026-08-04T01:00:00.000Z',
    }))
    setState(s.db, 'acct:46130058:broker_snapshot_cache_json', JSON.stringify({
      account: { positions: [{ positionId: '5', pnl: -1 }] }, fetchedAt: '2026-08-04T07:30:00.000Z',
    }))

    assert.equal(bySymbol(await positions(s)).EURNOK.live_pnl_at, '2026-08-04T07:30:00.000Z')
  } finally { s.close() }
})

// Claude · № 13,904 13-Oct (owner: audit fix "1 Lots from broker"; claude-builder).
// Production 13-10: SHOP.US on 46130058 opened 9.5 lots; the broker closed 4.8
// at 19:46 UTC and holds 4.7, but the row read 9.5 — `volume` is the trade's
// opened volume. The broker's current lots now ride beside it.
test('each row carries the broker\'s current lots beside the opened volume, and says which it is', async () => {
  const s = await server()
  try {
    // origin: an order this system sent (NASA-3, № 14,343: only those read as sent lots).
    const t = s.db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id, volume, origin) VALUES ('EURUSD', 'buy', 'open', '46130058', '240732790', 1, 'bot_market_dispatch')`).run().lastInsertRowid
    s.db.prepare(`INSERT INTO monitored_positions (trade_id, symbol, side, status, account_id, entry_price, current_sl, current_tp, broker_volume_units)
      VALUES (?, 'EURUSD', 'buy', 'active', '46130058', 1.1, 1.0, 1.3, 50000)`).run(t)
    openPosition(s.db, { symbol: 'NZDUSD', accountId: '46130058', ctid: '1' })
    const rows = bySymbol(await positions(s))
    assert.equal(rows.EURUSD.current_lots, 0.5, 'the broker holds 50,000 units: half a lot')
    assert.equal(rows.EURUSD.opened_lots, 1)
    assert.equal(rows.EURUSD.volume, 1, 'volume stays the opened volume the TP ladder splits')
    assert.equal(rows.EURUSD.lots_source, 'broker_reconcile')
    assert.equal(rows.NZDUSD.current_lots, null, 'no broker reading yet: not known, never the opened figure')
    assert.equal(rows.NZDUSD.lots_source, 'opened_record')
  } finally { s.close(); s.db.close() }
})

// Claude · № 13,991 13-Oct (owner: Codex P2 #4 on #1348 "Snapshot first, reconciler next"; claude-builder).
// Source: /actions/broker-positions caches each account's snapshot with the
// broker's lots per position (actions.js `lots: toLots(td.volume, meta)`); a
// partial close after the last reconcile shows there first.
test('current lots: the reconciler reading first, the account snapshot when there is none', async () => {
  const s = await server()
  try {
    const ins = (sym, ctid, units) => {
      const t = s.db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id, volume, origin) VALUES (?, 'buy', 'open', '46130058', ?, 9.5, 'bot_market_dispatch')`).run(sym, ctid).lastInsertRowid
      s.db.prepare(`INSERT INTO monitored_positions (trade_id, symbol, side, status, account_id, entry_price, current_sl, current_tp, broker_volume_units)
        VALUES (?, ?, 'buy', 'active', '46130058', 1.1, 1.0, 1.3, ?)`).run(t, sym, units)
    }
    ins('SHOP.US', '501', null)       // not reconciled yet
    ins('EURUSD', '502', 950000)      // reconciler read 9.5 lots; the broker since closed half
    ins('GBPUSD', '503', 50000)       // not in the snapshot
    setState(s.db, 'acct:46130058:broker_snapshot_cache_json', snapshot([
      { positionId: 501, lots: 4.7 }, { positionId: 502, lots: 4.75 },
    ]))
    const rows = bySymbol(await positions(s))
    assert.equal(rows['SHOP.US'].current_lots, 4.7)
    assert.equal(rows['SHOP.US'].lots_source, 'broker_snapshot')
    // Claude · № 14,009 13-Oct (owner: Codex P2 #6, "by freshness; if the
    // reconciler stamps no time, reconciler first"): broker_volume_units carries
    // no reading time, so a cached snapshot (kept when a later fetch fails) is
    // not known to be newer; the reconciler's reading wins when present.
    assert.equal(rows.EURUSD.current_lots, 9.5, 'the reconciler reading wins: the snapshot\'s age is unknown against it')
    assert.equal(rows.EURUSD.lots_source, 'broker_reconcile')
    assert.equal(rows.GBPUSD.current_lots, 0.5)
    assert.equal(rows.GBPUSD.lots_source, 'broker_reconcile')
    assert.equal(rows.EURUSD.opened_lots, 9.5)
  } finally { s.close(); s.db.close() }
})

test('a snapshot with no usable lots is not a reading', async () => {
  const s = await server()
  try {
    // No reconciler reading yet, so the snapshot is the only source consulted.
    const t = s.db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id, volume) VALUES ('EURUSD', 'buy', 'open', '46130058', '601', 1)`).run().lastInsertRowid
    s.db.prepare(`INSERT INTO monitored_positions (trade_id, symbol, side, status, account_id, entry_price, current_sl, current_tp, broker_volume_units)
      VALUES (?, 'EURUSD', 'buy', 'active', '46130058', 1.1, 1.0, 1.3, NULL)`).run(t)
    // Each pass reads its own URL: the route's response cache is keyed by URL.
    for (const [i, lots] of [null, true, '4.7', 0, -1].entries()) {
      setState(s.db, 'acct:46130058:broker_snapshot_cache_json', snapshot([{ positionId: 601, lots }]))
      const rows = bySymbol(await fetch(s.url(`/state/positions?account=all&pass=${i}`)).then(r => r.json()))
      assert.equal(rows.EURUSD.current_lots, null, `snapshot lots ${JSON.stringify(lots)} is not a reading`)
      assert.equal(rows.EURUSD.lots_source, 'opened_record')
    }
    setState(s.db, 'acct:46130058:broker_snapshot_cache_json', snapshot([{ positionId: 601, lots: 0.25 }]))
    const live = bySymbol(await fetch(s.url('/state/positions?account=all&pass=live')).then(r => r.json()))
    assert.equal(live.EURUSD.current_lots, 0.25, 'control: a real snapshot reading is used on this same path')
    assert.equal(live.EURUSD.lots_source, 'broker_snapshot')
  } finally { s.close(); s.db.close() }
})

// Claude · № 13,996 13-Oct (owner: Codex P2 #5 on #1348 "Own snapshot for lots AND P&L"; claude-builder).
// Source: actions.js writes acct:<id>:broker_snapshot_cache_json per account and
// the shared key from the SELECTED account (`{ account: sel }`, sel.accountId).
// Position ids can repeat across the demo and live servers, so another
// account's snapshot is never this row's evidence.
const namedSnapshot = (accountId, positions) => JSON.stringify({
  account: { accountId, positions }, fetchedAt: '2026-10-13T02:00:00.000Z',
})

test('an account\'s own EMPTY snapshot is authoritative: no lots or P&L from the shared one', async () => {
  const s = await server()
  try {
    const t = s.db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id, volume) VALUES ('EURUSD', 'buy', 'open', '42993489', '777', 1)`).run().lastInsertRowid
    s.db.prepare(`INSERT INTO monitored_positions (trade_id, symbol, side, status, account_id, entry_price, current_sl, current_tp, broker_volume_units)
      VALUES (?, 'EURUSD', 'buy', 'active', '42993489', 1.1, 1.0, 1.3, 50000)`).run(t)
    setState(s.db, 'acct:42993489:broker_snapshot_cache_json', namedSnapshot(42993489, []))
    setState(s.db, 'broker_snapshot_cache_json', namedSnapshot(46130058, [{ positionId: 777, lots: 9, pnl: 123 }]))
    const rows = bySymbol(await positions(s))
    assert.equal(rows.EURUSD.live_pnl, null, 'the selected account\'s position 777 is not this one')
    assert.equal(rows.EURUSD.current_lots, 0.5, 'its own reconciler reading, not the foreign 9 lots')
    assert.equal(rows.EURUSD.lots_source, 'broker_reconcile')
    // A shared cache that names no account (written before it carried one) is
    // still not used over an own snapshot that exists.
    setState(s.db, 'broker_snapshot_cache_json', snapshot([{ positionId: 777, lots: 9, pnl: 123 }]))
    const legacy = bySymbol(await fetch(s.url('/state/positions?account=all&pass=legacy')).then(r => r.json()))
    assert.equal(legacy.EURUSD.live_pnl, null)
    assert.equal(legacy.EURUSD.current_lots, 0.5)
  } finally { s.close(); s.db.close() }
})

test('with no cache of its own, the shared snapshot is used only when it is this account\'s', async () => {
  const s = await server()
  try {
    openPosition(s.db, { symbol: 'GBPAUD', accountId: '47790949', ctid: '888' })
    openPosition(s.db, { symbol: 'AUDCAD', accountId: '46130058', ctid: '889' })
    setState(s.db, 'broker_snapshot_cache_json', namedSnapshot(46130058, [
      { positionId: 888, lots: 3, pnl: 5 }, { positionId: 889, lots: 2, pnl: 6 },
    ]))
    const rows = bySymbol(await positions(s))
    assert.equal(rows.GBPAUD.live_pnl, null, 'the shared snapshot names another account')
    assert.equal(rows.GBPAUD.current_lots, null)
    assert.equal(rows.AUDCAD.live_pnl, 6, 'the shared snapshot is this account\'s own')
    assert.equal(rows.AUDCAD.current_lots, 2)
  } finally { s.close(); s.db.close() }
})

test('an unnamed shared snapshot enriches no attributed account without a cache of its own', async () => {
  const s = await server()
  try {
    openPosition(s.db, { symbol: 'GBPAUD', accountId: '47790949', ctid: '991' })
    openPosition(s.db, { symbol: 'AUDCAD', accountId: '46130058', ctid: '992' })
    setState(s.db, 'broker_snapshot_cache_json', snapshot([
      { positionId: 991, lots: 3, pnl: 5 }, { positionId: 992, lots: 2, pnl: 6 },
    ]))
    const rows = bySymbol(await positions(s))
    assert.equal(rows.GBPAUD.live_pnl, null)
    assert.equal(rows.GBPAUD.current_lots, null)
    assert.equal(rows.AUDCAD.live_pnl, null)
    assert.equal(rows.AUDCAD.current_lots, null)
  } finally { s.close(); s.db.close() }
})

// Claude · № 14,292 13-Oct (owner: NASA-3, Opened lots "Sent lots, labelled";
// claude-builder). Source: docs/nasa-baseline-2026-10-13.md B2 — opened_lots
// read trades.volume, which a keeper or general partial rewrites to the
// residual. Opened lots is now the broker-recorded fill, else the lots sent
// while no reduction is on record, else unknown; each says which.
test('opened lots: the recorded fill, the sent lots labelled, never the residual after a partial', async () => {
  const s = await server()
  try {
    const row = (symbol, ctid, volume, filled = null, source = null, scaled = 0, origin = 'bot_market_dispatch') => {
      const t = s.db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id, volume, filled_volume, filled_volume_source, origin)
        VALUES (?, 'buy', 'open', '42993489', ?, ?, ?, ?, ?)`).run(symbol, ctid, volume, filled, source, origin).lastInsertRowid
      s.db.prepare(`INSERT INTO monitored_positions (trade_id, symbol, side, status, account_id, entry_price, current_sl, current_tp, scaled_out)
        VALUES (?, ?, 'buy', 'active', '42993489', 1.1, 1.0, 1.3, ?)`).run(t, symbol, scaled)
    }
    row('EURUSD', '11', 0.1, 0.2, 'broker_opening_deals', 1)
    row('GBPUSD', '12', 0.3)
    row('AUDUSD', '13', 0.05, null, null, 1)
    row('NZDUSD', '14', 0.4, null, null, 0, 'reconciler_adopted')
    const rows = bySymbol(await positions(s))
    assert.deepEqual([rows.EURUSD.opened_lots, rows.EURUSD.opened_lots_source], [0.2, 'broker_opening_deals'])
    assert.deepEqual([rows.GBPUSD.opened_lots, rows.GBPUSD.opened_lots_source], [0.3, 'sent_order'])
    assert.deepEqual([rows.AUDUSD.opened_lots, rows.AUDUSD.opened_lots_source], [null, 'unknown_after_partial'],
      'the 0.05 left after a partial is not what was opened')
    assert.deepEqual([rows.NZDUSD.opened_lots, rows.NZDUSD.opened_lots_source], [null, 'unknown'],
      'an adopted row\'s volume is the broker\'s, not an order this system sent (Codex P2 on #1359)')
  } finally { s.close(); s.db.close() }
})
