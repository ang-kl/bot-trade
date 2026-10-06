import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from './db.js'
import { getCtraderCreds, getSymbolMap } from './lib/ctrader-creds.js'
import { runMonitorPhase } from './loop.js'
const held = await import(process.env.HELD_PRICE_MODULE_SOURCE || new URL('./services/held-prices.js', import.meta.url))

// Exercise the actual main-loop quote selection, real refresh adapter and
// real monitor/SQLite writes. Only broker quote I/O and the clock are supplied.
const source = readFileSync(process.env.HELD_PRICE_LOOP_SOURCE || new URL('./loop.js', import.meta.url), 'utf8')
const start = source.indexOf('// 4. MONITOR PHASE')
const end = source.indexOf('// V3 M1: the first slow-monitor pass', start)
assert.ok(start > 0 && end > start)
const block = source.slice(start, end).replace(/await import\('\.\/services\/held-prices\.js'\)/g, 'await loadHeld()')
const actualPhase = new (Object.getPrototypeOf(async function () {}).constructor)(
  'db', 's', 'openPositions', 'phase', 'getState', 'getCtraderCreds', 'getSymbolMap',
  'runMonitorPhase', 'client', 'skipLlmMonitor', 'log', 'loadHeld', block)

process.env.CTRADER_CLIENT_ID = 'fixture-app'
process.env.CTRADER_CLIENT_SECRET = 'fixture-only'
const NOW = Date.parse('2026-10-07T00:00:00Z')
const created = new Date(NOW - 1000).toISOString()
const risk = 28.18 - 27.83967261904762
const quote = (accountId, symbolId, price, timestamp = NOW) => ({
  ctidTraderAccountId: accountId, symbolId, bid: Math.round(price * 100000),
  ask: Math.round(price * 100000), timestamp,
})

function fixture(t, specs = [{ account: '11' }]) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  setState(db, 'ctrader_access_token', 'fixture-token')
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'ctrader_is_live', 'false')
  setState(db, 'symbol_id_map', JSON.stringify({ 'DOW.US': 7 }))
  for (const [account, live, id] of [['11', 0, 7], ['22', 1, 9]]) {
    db.prepare('INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, ?, 1, ?)').run(account, account, live, 'active')
    setState(db, `symbol_id_map:${account}`, JSON.stringify({ accountId: account,
      builtAt: new Date(NOW - 1000).toISOString(), map: { 'DOW.US': id } }))
  }
  setState(db, 'last_scan_results', JSON.stringify({ at: new Date(NOW - 3600000).toISOString(),
    scans: [{ symbol: 'DOW.US', price: 28.51 }] }))
  const positions = specs.map(({ account, ...extra }) => {
    const id = db.prepare(`INSERT INTO monitored_positions
      (account_id, symbol, side, entry_price, current_sl, current_tp, initial_risk, source, status, strategy, created_at)
      VALUES (?, 'DOW.US', 'BUY', 28.18, 27.83967261904762, 30.089375, ?, 'external', 'active', 'vp_value', ?)`)
      .run(account, risk, created).lastInsertRowid
    const pos = db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(id)
    Object.assign(pos, extra)
    return pos
  })
  const s = {
    updatePositionMetrics: db.prepare('UPDATE monitored_positions SET mfe_r=?, mae_r=?, be_moved=?, scaled_out=? WHERE id=?'),
    updatePositionCheck: db.prepare('UPDATE monitored_positions SET last_check_action=?, last_check_reasoning=?, last_check_at=?, thesis_status=? WHERE id=?'),
    stampPositionExitMarks: db.prepare('UPDATE monitored_positions SET time_cap_trail_at=COALESCE(time_cap_trail_at,?), bank_partial_at=COALESCE(bank_partial_at,?) WHERE id=?'),
  }
  return { db, s, positions, row: id => db.prepare('SELECT * FROM monitored_positions WHERE id=?').get(id) }
}

async function run(f, quotes, { now = () => NOW } = {}) {
  const reads = []
  const readQuote = async (creds, id) => {
    reads.push({ accountId: String(creds.accountId), host: creds.host, symbolId: String(id) })
    return (typeof quotes === 'function' ? quotes(creds, id) : quotes[`${creds.accountId}:${id}`]) ?? null
  }
  const loadHeld = async () => ({ ...held,
    refreshHeldPrices: (creds, map, symbols) => held.refreshHeldPrices(creds, map, symbols, {
      getSpot: async id => { const q = await readQuote(creds, id); return q && { bid: q.bid / 100000, ask: q.ask / 100000 } },
    }),
    refreshHeldPositionPrices: (db, positions) => held.refreshHeldPositionPrices(db, positions, { readQuote, now }),
    heldPositionPrice: (pos, prices) => held.heldPositionPrice(pos, prices, { now }),
  })
  await actualPhase(f.db, f.s, f.positions, () => {}, getState, getCtraderCreds, getSymbolMap,
    runMonitorPhase, null, () => true, () => {}, loadHeld)
  return reads
}

test('failed held quote cannot seed a post-entry peak or trail from an old scan', async t => {
  const f = fixture(t)
  await run(f, {})
  const row = f.row(f.positions[0].id)
  assert.equal(row.mfe_r, 0)
  assert.equal(row.mae_r, 0)
  assert.equal(row.last_check_action, 'HOLD')
  assert.equal(row.current_sl, 27.83967261904762)
  assert.equal(row.current_tp, 30.089375)
})

test('same name on demo/live accounts uses each account host and own broker id', async t => {
  const f = fixture(t, [{ account: '11' }, { account: '22' }])
  const reads = await run(f, { '11:7': quote('11', 7, 28.51), '22:9': quote('22', 9, 28.13) })
  assert.deepEqual(reads.sort((a, b) => a.accountId.localeCompare(b.accountId)), [
    { accountId: '11', host: 'demo.ctraderapi.com', symbolId: '7' },
    { accountId: '22', host: 'live.ctraderapi.com', symbolId: '9' },
  ])
  assert.ok(f.row(f.positions[0].id).mfe_r > 0.96)
  assert.equal(f.row(f.positions[1].id).mfe_r, 0)
  assert.ok(f.row(f.positions[1].id).mae_r < -0.14)
})

for (const [name, make] of [
  ['pre-entry', () => quote('11', 7, 28.51, NOW - 2000)],
  ['expired', () => quote('11', 7, 28.51, NOW - 6000)],
  ['future', () => quote('11', 7, 28.51, NOW + 1)],
  ['foreign account', () => quote('22', 7, 28.51)],
  ['foreign symbol', () => quote('11', 9, 28.51)],
  ['undated', () => ({ ...quote('11', 7, 28.51), timestamp: undefined })],
]) test(`${name} broker quote cannot mutate MFE or produce a price-based exit`, async t => {
  const f = fixture(t)
  await run(f, { '11:7': make() })
  assert.equal(f.row(f.positions[0].id).mfe_r, 0)
  assert.equal(f.row(f.positions[0].id).last_check_action, 'HOLD')
})

test('unregistered position cannot borrow the primary account price', async t => {
  const f = fixture(t, [{ account: '99' }])
  assert.deepEqual(await run(f, { '11:7': quote('11', 7, 28.51) }), [])
  assert.equal(f.row(f.positions[0].id).mfe_r, 0)
})

test('fresh owned post-entry quote retains the existing managed trail and TP', async t => {
  const f = fixture(t)
  await run(f, { '11:7': quote('11', 7, 28.51) })
  const row = f.row(f.positions[0].id)
  assert.ok(Math.abs(row.mfe_r - (28.51 - 28.18) / risk) < 1e-10)
  assert.equal(row.last_check_action, 'EXT:MOVE_SL')
  assert.match(row.last_check_reasoning, /managed_trail.*0\.5R/)
  assert.equal(row.current_tp, 30.089375)
})

test('shared account/symbol quote is read once but cannot precede a newer position', async t => {
  const f = fixture(t, [{ account: '11' }, { account: '11', created_at: new Date(NOW + 1).toISOString() }])
  assert.equal((await run(f, { '11:7': quote('11', 7, 28.51) })).length, 1)
  assert.ok(f.row(f.positions[0].id).mfe_r > 0.96)
  assert.equal(f.row(f.positions[1].id).mfe_r, 0)
})

test('unproven or mismatched own map never triggers a primary-map quote', async t => {
  const f = fixture(t)
  setState(f.db, 'symbol_id_map:11', JSON.stringify({ accountId: '22', builtAt: created, map: { 'DOW.US': 7 } }))
  assert.deepEqual(await run(f, { '11:7': quote('11', 7, 28.51) }), [])
  assert.equal(f.row(f.positions[0].id).mfe_r, 0)
})

test('expired own map cannot borrow the shared primary map', async t => {
  const f = fixture(t)
  setState(f.db, 'symbol_id_map:11', JSON.stringify({ accountId: '11',
    builtAt: new Date(NOW - 24 * 3600000).toISOString(), map: { 'DOW.US': 7 } }))
  assert.deepEqual(await run(f, { '11:7': quote('11', 7, 28.51) }), [])
  assert.equal(f.row(f.positions[0].id).mfe_r, 0)
})

for (const [name, change] of [
  ['one-sided', q => ({ ...q, ask: null })],
  ['crossed', q => ({ ...q, ask: q.bid - 1 })],
]) test(`${name} prices do not become excursions`, async t => {
  const f = fixture(t)
  await run(f, { '11:7': change(quote('11', 7, 28.51)) })
  assert.equal(f.row(f.positions[0].id).mfe_r, 0)
  assert.equal(f.row(f.positions[0].id).mae_r, 0)
})

test('quotes that expire before consumption cannot seed MFE', async t => {
  const f = fixture(t)
  let calls = 0
  await run(f, { '11:7': quote('11', 7, 28.51) }, { now: () => ++calls <= 1 ? NOW : NOW + 6000 })
  assert.equal(f.row(f.positions[0].id).mfe_r, 0)
})

test('missing price preserves the existing expired time-cap exit', async t => {
  const f = fixture(t, [{ account: '11', time_cap_at: '2026-10-01T00:00:00Z' }])
  await run(f, {})
  const row = f.row(f.positions[0].id)
  assert.equal(row.mfe_r, 0)
  assert.equal(row.last_check_action, 'EXT:FULL_EXIT')
  assert.match(row.last_check_reasoning, /time_cap/)
  assert.equal(row.current_sl, 27.83967261904762)
  assert.equal(row.current_tp, 30.089375)
})

test('later monitor batches refresh after earlier work ages its quotes out', async t => {
  const f = fixture(t, Array.from({ length: 6 }, () => ({ account: '11' })))
  let at = NOW, completed = 0
  const update = f.s.updatePositionCheck
  f.s.updatePositionCheck = { run(...args) {
    const result = update.run(...args)
    // Advance a virtual clock at the real first batch's last persistence.
    // No sleep, broker action or LLM request is needed to model its elapsed work.
    if (++completed === 4) at += 6000
    return result
  } }
  const reads = await run(f, (creds, id) => quote(creds.accountId, id, 28.51, at), { now: () => at })
  assert.equal(completed, 6)
  for (const pos of f.positions) {
    assert.ok(f.row(pos.id).mfe_r > 0.96, 'later positions consumed their own batch fresh quote')
    assert.equal(f.row(pos.id).last_check_action, 'EXT:MOVE_SL')
  }
  assert.equal(reads.length, 2, 'one deduplicated owned quote per monitor batch')
})

test('a later batch failed refresh cannot reuse the preceding batch quote', async t => {
  const f = fixture(t, Array.from({ length: 6 }, () => ({ account: '11' })))
  let completed = 0
  const update = f.s.updatePositionCheck
  f.s.updatePositionCheck = { run(...args) { ++completed; return update.run(...args) } }
  const reads = await run(f, (creds, id) => completed < 4 ? quote(creds.accountId, id, 28.51) : null)
  assert.equal(completed, 6)
  assert.ok(f.row(f.positions[0].id).mfe_r > 0.96)
  for (const pos of f.positions.slice(4)) {
    assert.equal(f.row(pos.id).mfe_r, 0)
    assert.equal(f.row(pos.id).last_check_action, 'HOLD')
  }
  assert.equal(reads.length, 2)
})
