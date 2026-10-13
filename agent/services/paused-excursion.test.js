// Claude · № 13,282 11-Oct (owner "record from now on and fill in the history
// from bars", ordered № 13,277·D·2; claude-builder)
//
// MAE/MFE on PAUSED rows — the momentum book's own positions, which the
// monitor skips. Real SQLite, the real account-owned quote path
// (held-prices.js) and the real wiring in loop.js; only broker I/O and the
// clock are supplied.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { refreshHeldPositionPrices } from './held-prices.js'
import {
  backfillPlan, excursionFromBars, recordPausedExcursions, resetPausedExcursionState,
  rAtPrice, sideOf, BACKFILL_RETRY_MS, MAX_BACKFILL_ATTEMPTS, MAX_HOUR_BARS,
} from './paused-excursion.js'

process.env.CTRADER_CLIENT_ID = 'fixture-app'
process.env.CTRADER_CLIENT_SECRET = 'fixture-only'

const HOUR = 3_600_000
const MIN = 60_000
// Shaped on UNH.US row 1667 (11-10): a SHORT book row, entry 376.46, 1R 28.15.
const ENTRY_AT = Date.parse('2026-09-18T13:31:52Z')
const NOW = Date.parse('2026-10-11T13:00:00Z')

function fixture(t, { rows = [{}] } = {}) {
  resetPausedExcursionState()
  const db = initDB(':memory:')
  t.after(() => { db.close(); resetPausedExcursionState() })
  setState(db, 'ctrader_access_token', 'fixture-token')
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'ctrader_is_live', 'false')
  db.prepare('INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, ?)').run('11', '11', 'active')
  setState(db, 'symbol_id_map:11', JSON.stringify({ accountId: '11', builtAt: new Date(NOW - 1000).toISOString(), map: { 'UNH.US': 77 } }))
  const ids = rows.map(r => db.prepare(`INSERT INTO monitored_positions
      (account_id, symbol, side, entry_price, current_sl, initial_risk, source, status, strategy, paused, mfe_r, mae_r, created_at)
      VALUES (?, 'UNH.US', ?, 376.46, 391.97, 28.15, 'preopen', 'active', 'tsmom_long', ?, ?, ?, ?)`)
    .run(r.account ?? '11', r.side ?? 'short', r.paused ?? 1, r.mfe ?? 0, r.mae ?? 0, r.created ?? '2026-09-18 13:31:52').lastInsertRowid)
  const row = id => db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(id)
  return { db, ids, row }
}

const quoteAt = price => async (creds, symbolId) => ({
  ctidTraderAccountId: Number(creds.accountId), symbolId: Number(symbolId),
  bid: Math.round(price * 100000), ask: Math.round(price * 100000), timestamp: NOW,
})
const pricesWith = price => (db, rows, o) => refreshHeldPositionPrices(db, rows, { ...o, readQuote: quoteAt(price) })

// Bars the broker would answer: a pre-entry spike, then the trade's own path.
function barsFor(calls) {
  return async (target, period, count, endMs) => {
    calls.push({ symbolId: target.symbolId, accountId: target.accountId, period, count, endMs })
    if (period === '1m') return [
      { t: ENTRY_AT - 52_000, o: 376, h: 340, l: 330, c: 376 }, // starts BEFORE the row: never counts
      { t: ENTRY_AT + 8_000, o: 376.5, h: 380.0, l: 370.0, c: 372 },
      { t: ENTRY_AT + 68_000, o: 372, h: 373, l: 368.0, c: 369 },
      { t: Date.parse('2026-09-18T14:00:00Z'), o: 369, h: 370, l: 368, c: 369 }, // the hour bars' own: not a minute bar's
    ]
    return [
      { t: Date.parse('2026-09-18T14:00:00Z'), o: 369, h: 392.0, l: 365.0, c: 380 },
      { t: Date.parse('2026-09-25T15:00:00Z'), o: 380, h: 381, l: 348.31, c: 350 },
      { t: Date.parse('2026-10-01T15:00:00Z'), o: 350, h: NaN, l: 340, c: 345 }, // invalid: counted, not used
    ]
  }
}

test('pure: sides, R at a price, and an unknown side is not measured', () => {
  assert.equal(sideOf({ side: 'BUY' }), 'long')
  assert.equal(sideOf({ side: 'long' }), 'long')
  assert.equal(sideOf({ side: 'sell' }), 'short', 'lower-case sell is a short (currentR would read it as a long)')
  assert.equal(sideOf({ side: 'SHORT' }), 'short')
  assert.equal(sideOf({ side: 'flat' }), null)
  const pos = { side: 'short', entry_price: 376.46, initial_risk: 28.15 }
  assert.ok(Math.abs(rAtPrice(pos, 348.31) - 1) < 1e-9, 'a short is +1R one risk below its entry')
  assert.equal(rAtPrice({ ...pos, side: '?' }, 348.31), null)
  assert.equal(rAtPrice({ ...pos, initial_risk: 0 }, 348.31), null)
  assert.equal(rAtPrice(pos, null), null)
})

test('pure: bars before the row never count; highs and lows map to the right side; invalid bars are counted', () => {
  const short = { side: 'short', entry_price: 100, initial_risk: 10 }
  const bars = [
    { t: 0, h: 200, l: 1 },        // before fromMs
    { t: 10, h: 105, l: 90 },      // short: MFE +1R (low), MAE -0.5R (high)
    { t: 20, h: 'x', l: 95 },      // invalid
  ]
  const s = excursionFromBars(short, bars, 10)
  assert.deepEqual([s.mfeR, s.maeR, s.bars, s.invalidBars, s.firstBarMs, s.lastBarMs], [1, -0.5, 1, 1, 10, 10])
  const l = excursionFromBars({ ...short, side: 'long' }, bars, 10)
  assert.deepEqual([l.mfeR, l.maeR], [0.5, -1], 'a long reads its MFE off the high and its MAE off the low')
  assert.equal(excursionFromBars(short, bars, 1000), null, 'nothing at or after the row: no figure, not a zero')
})

test('pure: the plan covers the entry hour in minutes and the rest in hours, capped and labelled', () => {
  const p = backfillPlan(ENTRY_AT, NOW)
  assert.equal(p.firstFullHour, Date.parse('2026-09-18T14:00:00Z'))
  assert.equal(p.minutes.endMs, p.firstFullHour)
  assert.equal(p.minutes.count, 30, '28m08s of the entry hour → 29 minute bars plus one')
  assert.equal(p.hours.fromMs, p.firstFullHour)
  assert.equal(p.hours.capped, false)
  const old = backfillPlan(NOW - (MAX_HOUR_BARS + 10) * HOUR, NOW)
  assert.equal(old.hours.count, MAX_HOUR_BARS)
  assert.equal(old.hours.capped, true)
  const fresh = backfillPlan(NOW - 20 * MIN, NOW)
  assert.equal(fresh.hours, null, 'inside its first hour a row needs minute bars only')
  assert.equal(backfillPlan(NOW, NOW), null)
})

test('a paused book row gets its history from bars and its live R, once; an unpaused row is left to the monitor', async t => {
  const { db, ids: [paused, monitored], row } = fixture(t, { rows: [{}, { paused: 0 }] })
  const calls = []
  const out = await recordPausedExcursions(db, { fetchBars: barsFor(calls), refreshPrices: pricesWith(378.9), now: () => NOW })
  await out.backfill
  assert.equal(out.rows, 1, 'only the paused row is selected')
  const r = row(paused)
  // Bars: low 348.31 → +1.00R; high 392.0 → (376.46-392)/28.15 = -0.552R.
  // The 330 low that STARTS before the row is never counted (it would read +1.65R).
  assert.ok(Math.abs(r.mfe_r - 1) < 1e-9, `MFE ${r.mfe_r}`)
  assert.ok(Math.abs(r.mae_r - (376.46 - 392) / 28.15) < 1e-9, `MAE ${r.mae_r}`)
  const stamp = JSON.parse(r.excursion_backfill_json)
  assert.equal(stamp.source, 'broker_bid_bars')
  assert.equal(stamp.coverage, 'full')
  assert.equal(stamp.minuteBars, 2)
  assert.equal(stamp.hourBars, 2)
  assert.equal(stamp.invalidBars, 1)
  assert.deepEqual(calls.map(c => [c.period, c.accountId, c.symbolId]), [['1m', '11', 77], ['1h', '11', 77]],
    'bars come from the row\'s OWN account and its own symbol id')
  assert.deepEqual([row(monitored).mfe_r, row(monitored).mae_r, row(monitored).excursion_backfill_json], [0, 0, null])

  // The next pass: no second history fetch, and the live quote only widens.
  const again = await recordPausedExcursions(db, { fetchBars: barsFor(calls), refreshPrices: pricesWith(340), now: () => NOW })
  assert.equal(again.backfill, null)
  assert.equal(calls.length, 2, 'the history is fetched once per row')
  assert.ok(Math.abs(row(paused).mfe_r - (376.46 - 340) / 28.15) < 1e-9, 'a deeper live low widens MFE')
  const later = await recordPausedExcursions(db, { fetchBars: barsFor(calls), refreshPrices: pricesWith(376), now: () => NOW + 2 * BACKFILL_RETRY_MS })
  assert.equal(later.backfill, null, 'a stamped row is never fetched again, however long after')
  assert.equal(calls.length, 2)
  assert.ok(Math.abs(row(paused).mfe_r - (376.46 - 340) / 28.15) < 1e-9, 'a price back near entry never narrows it')
})

test('the record only ever widens: an existing deeper figure survives a shallower history', async t => {
  const { db, ids: [id], row } = fixture(t, { rows: [{ mfe: 2.5, mae: -0.9 }] })
  const out = await recordPausedExcursions(db, { fetchBars: barsFor([]), refreshPrices: pricesWith(378.9), now: () => NOW })
  await out.backfill
  assert.deepEqual([row(id).mfe_r, row(id).mae_r], [2.5, -0.9])
  assert.ok(row(id).excursion_backfill_json, 'the history is still stamped as done')
})

test('a planned segment answered with no bar is partial and retried, up to the attempt limit (Codex P2 on #1321)', async t => {
  const { db, ids: [id], row } = fixture(t)
  const calls = []
  let minuteAnswer = []
  const full = barsFor([])
  const fetchBars = async (target, period, count, endMs) => {
    calls.push(period)
    return period === '1m' ? minuteAnswer : full(target, period, count, endMs)
  }
  let clock = NOW
  const pass = async () => { const o = await recordPausedExcursions(db, { fetchBars, refreshPrices: async () => new Map(), now: () => clock }); return o.backfill ? (await o.backfill)[0] : null }

  const first = await pass()
  assert.equal(first.status, 'partial_retry')
  let stamp = JSON.parse(row(id).excursion_backfill_json)
  assert.deepEqual([stamp.missing, stamp.coverage, stamp.final, stamp.attempts], [['1m'], 'partial', false, 1],
    'an empty entry hour is named, never labelled full')
  assert.ok(Math.abs(row(id).mfe_r - 1) < 1e-9, 'the hours that did answer are recorded meanwhile')

  clock += BACKFILL_RETRY_MS - 1
  assert.equal(await pass(), null, 'not retried inside the interval')
  clock += 1
  minuteAnswer = [{ t: ENTRY_AT + 8_000, o: 376, h: 377, l: 330, c: 331 }]
  const second = await pass()
  assert.equal(second.status, 'filled', 'the segment answered on retry: complete')
  stamp = JSON.parse(row(id).excursion_backfill_json)
  assert.deepEqual([stamp.missing, stamp.coverage, stamp.final, stamp.attempts], [[], 'full', true, 2])
  assert.ok(Math.abs(row(id).mfe_r - (376.46 - 330) / 28.15) < 1e-9, 'the retried minute low is now in the record')
  clock += 2 * BACKFILL_RETRY_MS
  assert.equal(await pass(), null, 'a complete stamp is never fetched again')
})

test('a segment that never answers stops being asked after the attempt limit', async t => {
  const { db, ids: [id], row } = fixture(t)
  let minuteCalls = 0
  const full = barsFor([])
  const fetchBars = async (target, period, count, endMs) => period === '1m' ? (minuteCalls++, []) : full(target, period, count, endMs)
  let clock = NOW
  for (let i = 0; i < MAX_BACKFILL_ATTEMPTS + 2; i++) {
    const o = await recordPausedExcursions(db, { fetchBars, refreshPrices: async () => new Map(), now: () => clock })
    await o.backfill
    clock += BACKFILL_RETRY_MS
  }
  assert.equal(minuteCalls, MAX_BACKFILL_ATTEMPTS)
  const stamp = JSON.parse(row(id).excursion_backfill_json)
  assert.deepEqual([stamp.missing, stamp.coverage, stamp.final, stamp.attempts], [['1m'], 'partial', true, MAX_BACKFILL_ATTEMPTS])
})

test('a stamp written after this pass read the row is never overwritten (compare-and-set)', async t => {
  const { db, ids: [id], row } = fixture(t)
  const stale = db.prepare('SELECT * FROM monitored_positions WHERE id = ?').all(id)
  const other = JSON.stringify({ final: true, coverage: 'full', attempts: 1, missing: [] })
  db.prepare('UPDATE monitored_positions SET excursion_backfill_json = ? WHERE id = ?').run(other, id)
  const out = await recordPausedExcursions(db, { rows: stale, fetchBars: barsFor([]), refreshPrices: async () => new Map(), now: () => NOW })
  const [result] = await out.backfill
  assert.equal(result.status, 'row_changed')
  assert.equal(row(id).excursion_backfill_json, other)
  assert.deepEqual([row(id).mfe_r, row(id).mae_r], [0, 0])
})

test('a failed fetch stamps nothing and retries only after the retry interval', async t => {
  const { db, ids: [id], row } = fixture(t)
  let n = 0
  const failing = async () => { n++; throw new Error('broker timeout') }
  let clock = NOW
  const pass = () => recordPausedExcursions(db, { fetchBars: failing, refreshPrices: async () => new Map(), now: () => clock })
  await (await pass()).backfill
  assert.equal(n, 1)
  assert.equal(row(id).excursion_backfill_json, null)
  assert.deepEqual([row(id).mfe_r, row(id).mae_r], [0, 0], 'a failure writes no figure')
  clock = NOW + BACKFILL_RETRY_MS - 1
  assert.equal((await pass()).backfill, null, 'not retried inside the interval')
  clock = NOW + BACKFILL_RETRY_MS
  await (await pass()).backfill
  assert.equal(n, 2, 'retried once the interval has passed')
})

test('no account-owned symbol map: no fetch at all, and no other account\'s map is borrowed', async t => {
  const { db, ids: [id], row } = fixture(t, { rows: [{ account: '22' }] })
  const calls = []
  const out = await recordPausedExcursions(db, { fetchBars: barsFor(calls), refreshPrices: pricesWith(340), now: () => NOW })
  const results = await out.backfill
  assert.equal(results[0].status, 'no_owned_symbol')
  assert.equal(calls.length, 0)
  assert.deepEqual([row(id).mfe_r, row(id).mae_r], [0, 0], 'no owned quote either: nothing recorded')
})

test('a slow broker never holds the pass: the history runs detached while the live R is written', async t => {
  const { db, ids: [id], row } = fixture(t)
  const never = () => new Promise(() => {})
  const out = await recordPausedExcursions(db, { fetchBars: never, refreshPrices: pricesWith(348.31), now: () => NOW })
  assert.equal(out.backfillStarted, 1)
  assert.equal(out.live, 1)
  assert.ok(Math.abs(row(id).mfe_r - 1) < 1e-9, 'the live quote landed although the bars never answered')
  const second = await recordPausedExcursions(db, { fetchBars: never, refreshPrices: pricesWith(348.31), now: () => NOW + 2 * BACKFILL_RETRY_MS })
  assert.equal(second.backfill, null, 'a second history run never starts beside one still in flight')
})

test('a row unpaused or closed in between is not written', async t => {
  const { db, ids: [id], row } = fixture(t)
  const rows = db.prepare('SELECT * FROM monitored_positions WHERE id = ?').all(id)
  db.prepare('UPDATE monitored_positions SET paused = 0 WHERE id = ?').run(id)
  const out = await recordPausedExcursions(db, { rows, fetchBars: barsFor([]), refreshPrices: pricesWith(340), now: () => NOW })
  const [result] = await out.backfill
  assert.equal(result.status, 'row_changed')
  assert.equal(out.live, 0)
  assert.deepEqual([row(id).mfe_r, row(id).mae_r, row(id).excursion_backfill_json], [0, 0, null])
})

test('wiring: the main loop runs it after the monitor pass, and never lets it fail the loop', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const monitorPass = src.indexOf("stampFirst('slowMonitor'")
  const call = src.indexOf('await recordPausedExcursions(db, { log })')
  assert.ok(monitorPass > 0, 'fixture check: the monitor pass marker exists')
  assert.ok(call > monitorPass, 'called after the monitor pass')
  assert.equal(src.split('recordPausedExcursions(').length - 1, 1, 'one call site')
  const window = src.slice(monitorPass, call + 60)
  assert.match(window, /try\s*\{\s*const \{ recordPausedExcursions \} = await import\('\.\/services\/paused-excursion\.js'\)/)
  assert.match(src.slice(call, call + 200), /\}\s*catch \(err\) \{/)
})

// Codex rounds 1–2 on #1356 (owner: "Fix in this PR", then "Separate
// columns"): a paused short at entry 376.46 (risk 28.15) quoted 376.00 /
// 376.50. mfe_r/mae_r stay on the mid (376.25: +0.0075R, the managed trail's
// input, unchanged); the exit side (the ask, 376.50: -0.0014R) goes to
// mfe_exit_r/mae_exit_r.
test('the live-quote pass keeps mfe_r on the mid and records the exit side (the ask for a short) in its own columns', async t => {
  const { db, ids: [id], row } = fixture(t, { rows: [{ side: 'short' }] })
  const spread = (db, rows, o) => refreshHeldPositionPrices(db, rows, { ...o, readQuote: async (creds, symbolId) => ({
    ctidTraderAccountId: Number(creds.accountId), symbolId: Number(symbolId), bid: 37_600_000, ask: 37_650_000, timestamp: NOW }) })
  const out = await recordPausedExcursions(db, { fetchBars: barsFor([]), refreshPrices: spread, now: () => NOW, perPass: 0 }) // the live pass alone
  assert.equal(out.backfillStarted, 0)
  assert.equal(out.live, 1)
  assert.ok(row(id).mfe_r > 0.007 && row(id).mfe_r < 0.008, `mid unchanged: ${row(id).mfe_r}`)
  assert.equal(row(id).mae_r, 0)
  assert.equal(row(id).mfe_exit_r, 0, 'no favourable excursion at the ask')
  assert.ok(row(id).mae_exit_r < 0 && row(id).mae_exit_r > -0.002, `adverse at the ask: ${row(id).mae_exit_r}`)
  assert.equal(row(id).exit_excursion_from, new Date(NOW).toISOString())
})

// Codex P2 on #1356 (owner: "Guard every write"): a paused row closed while
// the quote refresh is in flight gets neither column written.
test('a paused row closed during the quote refresh is not widened in either column', async t => {
  const { db, ids: [id], row } = fixture(t, { rows: [{ side: 'short' }] })
  const closeThenQuote = async (db2, rows, o) => {
    db.prepare("UPDATE monitored_positions SET status = 'closed' WHERE id = ?").run(id)
    return refreshHeldPositionPrices(db2, rows, { ...o, readQuote: async (creds, symbolId) => ({
      ctidTraderAccountId: Number(creds.accountId), symbolId: Number(symbolId), bid: 37_600_000, ask: 37_650_000, timestamp: NOW }) })
  }
  const out = await recordPausedExcursions(db, { fetchBars: barsFor([]), refreshPrices: closeThenQuote, now: () => NOW, perPass: 0 })
  assert.equal(out.live, 0)
  assert.deepEqual([row(id).mfe_r, row(id).mfe_exit_r, row(id).mae_exit_r, row(id).exit_excursion_from], [0, null, null, null])
})

test('a paused row unpaused during the quote refresh is left to the monitors: neither column written by the paused pass', async t => {
  const { db, ids: [id], row } = fixture(t, { rows: [{ side: 'short' }] })
  const unpauseThenQuote = async (db2, rows, o) => {
    db.prepare('UPDATE monitored_positions SET paused = 0 WHERE id = ?').run(id)
    return refreshHeldPositionPrices(db2, rows, { ...o, readQuote: async (creds, symbolId) => ({
      ctidTraderAccountId: Number(creds.accountId), symbolId: Number(symbolId), bid: 37_600_000, ask: 37_650_000, timestamp: NOW }) })
  }
  const out = await recordPausedExcursions(db, { fetchBars: barsFor([]), refreshPrices: unpauseThenQuote, now: () => NOW, perPass: 0 })
  assert.equal(out.live, 0)
  assert.deepEqual([row(id).mfe_exit_r, row(id).mae_exit_r, row(id).exit_excursion_from], [null, null, null])
})
