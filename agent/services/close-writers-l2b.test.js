// node --test agent/services/close-writers-l2b.test.js
//
// V3 L2b — the close-side writer fixes of the lifecycle spec (§7): W10, W12,
// W13, W16 and W17. Every test here drives the writer or reader that was
// wrong with the input that exposed it, and asserts the stored row — the
// shape each defect had was a record that said something the broker, the
// market or the rule never said.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { shapeDeals, persistDeals, keepKnownDealFields } from './broker-history-import.js'
import { parseStatement } from './statement-import.js'
import { rememberLotSize, withBrokerLotSizes } from '../lib/lot-size-registry.js'
import { refreshDealsFor } from './position-capture.js'
import { backfillClosedPnl } from './pnl-backfill.js'
import { buildPositionRecord } from './position-history.js'
import { reclassifyBrokerCloses, movedStops } from './reconciler.js'
import { exitKind } from './trade-plans.js'
import { replayExit, toBarTuple, normaliseBars } from '../lib/exit-replay.js'
import { decodeTrendbars } from '../lib/ctrader-ws.js'
import { persistRiskEvent } from './risk.js'
import { scoreRefusedOpportunities, rescoreNoBarsRefusals, RESCORE_NOTE_PREFIX } from './refusal-ledger.js'
import { postmortemExemption, pendingLessons, runLossPostmortems } from './loss-postmortem.js'
import { findIncompleteCloses, countFlatExemptCloses } from './close-completeness.js'
import { goalTable } from './goal-table.js'

const fresh = () => initDB(':memory:')
const NOW = Date.parse('2026-09-25T12:00:00Z')
const HOUR = 3_600_000

// ─── W10: deal writers keep what is known, and the API writers store lots ───

function apiClosingDeal({ dealId, positionId, symbolId = 1, volume = 15_000_000, ms = NOW - HOUR, entry = 1.1, exit = 1.12, gross = 200, swap = -5, commission = -3 }) {
  return {
    dealId, positionId, symbolId, tradeSide: 2, volume, executionTimestamp: ms, executionPrice: exit,
    closePositionDetail: { entryPrice: entry, grossProfit: gross, swap, commission, moneyDigits: 2 },
  }
}
const NAMES_ONLY = { 1: { symbolName: 'EURUSD' } }  // what pnl-backfill / position-capture hand shapeDeals

// One statement deal (Deals section, the export's own columns), the same fill
// the API reports as deal 316000001.
const STATEMENT = [
  'Deals',
  'Deal ID,Order ID,Symbol,Opening Direction,Closing Direction,Opening time (UTC+8),Closing Time (UTC+8),Entry price,Closing price,Closing Quantity,Commissions,Pips,Net USD,Channel,Balance USD',
  'DID316000001,356000001,EURUSD,Buy,Sell,25 Sep 2026 17:00:00.000,25 Sep 2026 19:00:00.000,1.1,1.12,1.5 Lots,-0.03,20,1.92,openapi,1 000.00',
].join('\n')

test('W10: the boot seed no longer blanks the gross and swap an API read stored', () => {
  const db = fresh()
  persistDeals(db, shapeDeals([apiClosingDeal({ dealId: 316000001, positionId: 900 })], NAMES_ONLY, '47790949'))
  const api = db.prepare("SELECT gross_pnl, swap, lots FROM broker_deals WHERE deal_id = '316000001'").get()
  assert.deepEqual([api.gross_pnl, api.swap, api.lots], [2, -0.05, null], 'precondition: the API read carries gross and swap, no lots')

  const seed = parseStatement(STATEMENT).map(r => ({ ...r, account_id: '47790949' }))
  assert.equal(seed[0].gross_pnl, null, 'precondition: a statement breaks out no gross')
  persistDeals(db, seed)
  const after = db.prepare("SELECT gross_pnl, swap, lots, commission, net_pnl FROM broker_deals WHERE deal_id = '316000001'").get()
  assert.equal(after.gross_pnl, 2, 'the seed carried NULL gross — the stored figure stays')
  assert.equal(after.swap, -0.05, 'and the stored swap')
  assert.equal(after.lots, 1.5, 'the seed\'s own lots land')
  assert.equal(after.net_pnl, 1.92, 'a value the new read carries still wins')
})

test('W10: an API read with no lot size no longer blanks the statement\'s lots', () => {
  const db = fresh()
  persistDeals(db, parseStatement(STATEMENT).map(r => ({ ...r, account_id: '47790949' })))
  persistDeals(db, shapeDeals([apiClosingDeal({ dealId: 316000001, positionId: 900 })], NAMES_ONLY, '47790949'))
  const row = db.prepare("SELECT lots, gross_pnl, symbol FROM broker_deals WHERE deal_id = '316000001'").get()
  assert.equal(row.lots, 1.5)
  assert.equal(row.gross_pnl, 2, 'and the API\'s gross fills the statement\'s gap')
  assert.equal(row.symbol, 'EURUSD')
})

test('W10: a "#id" placeholder never replaces a stored symbol name; a real name does', () => {
  const db = fresh()
  persistDeals(db, shapeDeals([apiClosingDeal({ dealId: 5, positionId: 901 })], NAMES_ONLY, '47790949'))
  persistDeals(db, shapeDeals([apiClosingDeal({ dealId: 5, positionId: 901 })], {}, '47790949'))
  assert.equal(db.prepare("SELECT symbol FROM broker_deals WHERE deal_id = '5'").get().symbol, 'EURUSD')
  assert.equal(keepKnownDealFields({ symbol: 'GBPUSD' }, { symbol: 'EURUSD' }).symbol, 'GBPUSD', 'a real new name is not a placeholder')
  assert.equal(keepKnownDealFields({ symbol: '#7' }, { symbol: '#7' }).symbol, '#7')
})

test('W10: a deal twice in one batch keeps what its first copy wrote', () => {
  const db = fresh()
  const [row] = shapeDeals([apiClosingDeal({ dealId: 6, positionId: 902 })], NAMES_ONLY, '47790949')
  persistDeals(db, [row, { ...row, gross_pnl: null, swap: null }])
  const got = db.prepare("SELECT gross_pnl, swap FROM broker_deals WHERE deal_id = '6'").get()
  assert.deepEqual([got.gross_pnl, got.swap], [2, -0.05])
})

test('W10: withBrokerLotSizes reads only a broker-declared lot size, never the table guess', () => {
  const db = fresh()
  rememberLotSize(db, 'EURUSD', 10_000_000)
  const meta = withBrokerLotSizes(db, { 1: { symbolName: 'EURUSD' }, 2: { symbolName: 'XAUUSD' }, 3: { symbolName: 'US500', lotSize: 100 } })
  assert.equal(meta[1].lotSize, 10_000_000)
  assert.equal(meta[2].lotSize, undefined, 'never declared by the broker → no lot size, so the deal stores NULL lots')
  assert.equal(meta[3].lotSize, 100, 'a lot size already given is kept')
  assert.deepEqual(withBrokerLotSizes(db, null), null)
})

test('W10: the position capture\'s deal read stores lots from the broker\'s declaration', async () => {
  const db = fresh()
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, XAUUSD: 2 }))
  rememberLotSize(db, 'EURUSD', 10_000_000)
  db.prepare(`INSERT INTO trades (symbol, side, status, opened_at, closed_at_ms, ctrader_position_id, account_id)
              VALUES ('EURUSD', 'BUY', 'closed', ?, ?, '903', '47790949')`).run(new Date(NOW - 3 * HOUR).toISOString(), NOW - HOUR)
  const getDeals = async () => ({ deal: [apiClosingDeal({ dealId: 7, positionId: 903 }), apiClosingDeal({ dealId: 8, positionId: 903, symbolId: 2, volume: 300 })] })
  const r = await refreshDealsFor(db, { accountId: '47790949', positionId: '903', getDeals, now: NOW })
  assert.equal(r.persisted, 2)
  assert.equal(db.prepare("SELECT lots FROM broker_deals WHERE deal_id = '7'").get().lots, 1.5, '15,000,000 / 10,000,000')
  assert.equal(db.prepare("SELECT lots FROM broker_deals WHERE deal_id = '8'").get().lots, null, 'no declaration → NULL, not a guess')
})

test('W10: the P&L backfill\'s deal receipt stores lots from the broker\'s declaration', async () => {
  const db = fresh()
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1 }))
  rememberLotSize(db, 'EURUSD', 10_000_000)
  db.prepare(`INSERT INTO trades (symbol, side, status, ctrader_position_id, net_pnl) VALUES ('EURUSD', 'BUY', 'closed', '904', NULL)`).run()
  const deals = [apiClosingDeal({ dealId: 9, positionId: 904, ms: NOW - HOUR })]
  const getDeals = async (t0, t1) => ({ deal: deals.filter(d => d.executionTimestamp >= t0 && d.executionTimestamp < t1) })
  await backfillClosedPnl(db, {}, { getDeals, now: NOW })
  assert.equal(db.prepare("SELECT lots FROM broker_deals WHERE deal_id = '9'").get()?.lots, 1.5)
})

// ─── W17: the identity readers read the CLOSED row ─────────────────────────

test('W17: the position record is built from the closed row, not a newer duplicate', () => {
  const db = fresh()
  const ins = db.prepare(`INSERT INTO trades (symbol, side, status, net_pnl, opened_at, closed_at_ms, ctrader_position_id, account_id, close_reason)
                          VALUES ('EURUSD', 'BUY', ?, ?, ?, ?, '905', '47790949', ?)`)
  const closed = ins.run('closed', 48, new Date(NOW - 4 * HOUR).toISOString(), NOW - HOUR, 'take_profit').lastInsertRowid
  ins.run('rejected', null, new Date(NOW).toISOString(), null, 'repaired: duplicate row')
  ins.run('open', null, new Date(NOW).toISOString(), null, null)
  const rec = buildPositionRecord(db, { accountId: '47790949', positionId: '905' })
  assert.equal(rec.record.trade_id, Number(closed))
})

test('W17: the capture\'s deal window is the closed row\'s life, not a newer duplicate\'s', async () => {
  const db = fresh()
  const ins = db.prepare(`INSERT INTO trades (symbol, side, status, opened_at, closed_at_ms, ctrader_position_id, account_id)
                          VALUES ('EURUSD', 'BUY', ?, ?, ?, '906', '47790949')`)
  ins.run('closed', new Date(NOW - 10 * 24 * HOUR).toISOString(), NOW - 9 * 24 * HOUR)
  ins.run('rejected', new Date(NOW).toISOString(), null)
  const asked = []
  await refreshDealsFor(db, { accountId: '47790949', positionId: '906', getDeals: async (t0, t1) => { asked.push([t0, t1]); return { deal: [] } }, now: NOW })
  assert.ok(asked.length > 0)
  assert.ok(asked[0][0] < NOW - 10 * 24 * HOUR, 'the window starts before the closed row opened')
  assert.ok(Math.max(...asked.map(a => a[1])) < NOW - 8 * 24 * HOUR, 'and ends after it closed, not at the duplicate\'s "now"')
})

// ─── W12: the reclassifier reads moved stops ───────────────────────────────

const GENERIC = 'closed at the broker (manual close or broker-side SL/TP fill)'
function brokerClose(db, { side = 'BUY', entry = 100, exit, sl = 95, tp = 120, currentSl, brokerSl }) {
  const id = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, exit_price, sl_price, tp_price, close_reason, opened_at, closed_at)
                         VALUES ('X', ?, 'closed', ?, ?, ?, ?, ?, '2026-09-25 00:00:00', '2026-09-25 06:00:00')`)
    .run(side, entry, exit, sl, tp, GENERIC).lastInsertRowid
  if (currentSl !== undefined || brokerSl !== undefined) {
    db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, broker_sl, status)
                VALUES ('X', ?, ?, ?, ?, ?, 'closed')`).run(id, side, entry, currentSl ?? null, brokerSl ?? null)
  }
  return id
}
const reasonOf = (db, id) => db.prepare('SELECT close_reason FROM trades WHERE id = ?').get(id).close_reason

test('W12: an exit at a stop trailed into profit is a stop fill, read as a trail exit', () => {
  const db = fresh()
  const id = brokerClose(db, { exit: 104.99, currentSl: 105 })
  reclassifyBrokerCloses(db)
  const r = reasonOf(db, id)
  assert.match(r, /^stop loss hit — broker-side fill at a stop moved after entry and locked/)
  assert.equal(exitKind(r), 'trail')
})

test('W12: an exit at a stop tightened but still below entry is a stop fill', () => {
  const db = fresh()
  const id = brokerClose(db, { exit: 97, currentSl: 97 })
  reclassifyBrokerCloses(db)
  const r = reasonOf(db, id)
  assert.equal(r, 'stop loss hit — broker-side fill at a stop moved after entry (reclassified from the broker exit price)')
  assert.equal(exitKind(r), 'stop')
})

test('W12: an exit through a moved stop is judged against the moved stop, not the entry stop', () => {
  const db = fresh()
  const id = brokerClose(db, { exit: 104, currentSl: 105 })        // 104 is above the entry stop 95
  reclassifyBrokerCloses(db)
  assert.match(reasonOf(db, id), /^stopped beyond the SL/)
  const short = brokerClose(db, { side: 'SELL', entry: 100, sl: 105, tp: 80, exit: 96.5, brokerSl: 96 })
  reclassifyBrokerCloses(db)
  assert.match(reasonOf(db, short), /^stopped beyond the SL/, 'a short through its lowered stop')
})

test('W12: a position with no entry stop but a stop added later is not "unprotected"', () => {
  const db = fresh()
  const id = brokerClose(db, { sl: null, exit: 98, brokerSl: 98 })
  reclassifyBrokerCloses(db)
  const r = reasonOf(db, id)
  assert.doesNotMatch(r, /NO STOP LOSS/)
  assert.match(r, /^stop loss hit/)
})

test('W12: with no moved stop on record the old judgement stands, and a manual close stays generic', () => {
  const db = fresh()
  const manual = brokerClose(db, { exit: 103 })
  const sameStop = brokerClose(db, { exit: 103, currentSl: 95, brokerSl: 95 })  // a monitor that never moved it
  const naked = brokerClose(db, { sl: null, exit: 90 })
  reclassifyBrokerCloses(db)
  assert.equal(reasonOf(db, manual), GENERIC)
  assert.equal(reasonOf(db, sameStop), GENERIC)
  assert.match(reasonOf(db, naked), /NO STOP LOSS/)
  assert.deepEqual(movedStops({ sl_price: 95, moved_current_sl: 95, moved_broker_sl: null }), [])
})

test('W12: the newest monitor row for the trade supplies the moved stop', () => {
  const db = fresh()
  const id = brokerClose(db, { exit: 101, currentSl: 99 })
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, status) VALUES ('X', ?, 'BUY', 100, 101, 'closed')`).run(id)
  reclassifyBrokerCloses(db)
  assert.match(reasonOf(db, id), /locked at or beyond entry/)
})

// ─── W13: the refusal scorer reads the broker's bar shape ──────────────────

const T0 = Date.parse('2026-09-01T10:00:00Z')
// A trendbar payload exactly as cTrader sends it: prices in 1e-5 points off `low`.
function payload(bars) {
  return { trendbar: bars.map(([t, o, h, l, c]) => ({
    utcTimestampInMinutes: Math.round(t / 60_000), low: Math.round(l * 1e5),
    deltaOpen: Math.round((o - l) * 1e5), deltaHigh: Math.round((h - l) * 1e5), deltaClose: Math.round((c - l) * 1e5), volume: 10,
  })) }
}
// The loop's pmFetch returns decodeTrendbars' OBJECTS. Hourly bars ending at
// endMs; before `hitAt` they range ±0.002 around 1.1, at `hitAt` one bar
// reaches 1.112 (above a 1.11 target, nowhere near a 1.095 stop).
function brokerFetch({ hitAt = null, calls = [] } = {}) {
  return async (symbol, tf, count, endMs) => {
    calls.push({ symbol, tf, count, endMs })
    const bars = []
    const last = Math.floor(endMs / HOUR) * HOUR
    for (let t = last - (count - 1) * HOUR; t <= last; t += HOUR) {
      bars.push(hitAt != null && t === hitAt ? [t, 1.1, 1.112, 1.099, 1.111] : [t, 1.1, 1.102, 1.098, 1.1])
    }
    return decodeTrendbars(payload(bars))
  }
}

test('W13: bars shaped as the broker sends them are the same bars to the replay', () => {
  const objs = decodeTrendbars(payload([[T0, 1.1, 1.102, 1.098, 1.101]]))
  assert.equal(Array.isArray(objs[0]), false, 'precondition: the fetch returns objects')
  assert.deepEqual(toBarTuple(objs[0]).slice(0, 5), [T0, 1.1, 1.102, 1.098, 1.101])
  const tuples = [[T0, 1.1, 1.102, 1.098, 1.1], [T0 + HOUR, 1.1, 1.112, 1.099, 1.111]]
  const trade = { side: 'BUY', entry: 1.1, sl: 1.095, tp: 1.11, openedAtMs: T0 }
  assert.deepEqual(replayExit(normaliseBars(decodeTrendbars(payload(tuples))), trade), replayExit(tuples, trade))
  assert.deepEqual(replayExit(decodeTrendbars(payload(tuples)), trade), replayExit(tuples, trade), 'replayExit reads objects itself')
  assert.equal(replayExit(decodeTrendbars(payload(tuples)), trade).reason, 'target')
})

test('W13: a refusal scored from the broker\'s own bar objects is scored, not "no_bars"', async () => {
  const db = fresh()
  const id = persistRiskEvent(db, { symbol: 'EURUSD', side: 'BUY', entry: 1.1, sl: 1.095, tp1: 1.11, strategy: 'donchian_breakout', timeframe: '1h', accountId: 'A1' },
    { approved: false, veto_reason: 'bad_rr 2.0<3', checks: {} })
  db.prepare('UPDATE risk_events SET created_at = ? WHERE id = ?').run(new Date(T0).toISOString().replace('T', ' ').slice(0, 19), id)
  await scoreRefusedOpportunities(db, brokerFetch({ hitAt: T0 + 5 * HOUR }), { nowMs: T0 + 4 * 86_400_000 })
  const row = db.prepare('SELECT outcome, r_reached, bars_used FROM refusal_scores').get()
  assert.equal(row.outcome, 'target')
  assert.equal(row.r_reached, 2)
  assert.ok(row.bars_used > 0)
})

// A refusal_scores row exactly as the defect stored it.
function noBarsRow(db, { key, symbol = 'EURUSD', tf = '1h', firstMs, side = 'BUY', entry = 1.1, sl = 1.095, tp = 1.11, scoredAt = '2026-09-10T00:00:00.000Z' }) {
  db.prepare(`INSERT INTO refusal_scores (opportunity_key, account_id, symbol, side, strategy, timeframe, reason_key, reason,
      entry, sl, tp, first_at, last_at, refusals, horizon_min, scored_at, outcome, r_reached, exit_at, bars_used, note)
    VALUES (?, 'A1', ?, ?, 'donchian_breakout', ?, 'bad_rr', 'bad_rr 2.0<3', ?, ?, ?, ?, ?, 1, 2880, ?, 'no_bars', NULL, NULL, 0, 'no bars stored')`)
    .run(key, symbol, side, tf, entry, sl, tp, new Date(firstMs).toISOString().replace('T', ' ').slice(0, 19), new Date(firstMs).toISOString().replace('T', ' ').slice(0, 19), scoredAt)
}
const scoreOf = (db, key) => db.prepare('SELECT * FROM refusal_scores WHERE opportunity_key = ?').get(key)

test('W13: the no_bars rows are corrected in place, one bar read per group, scored_at kept', async () => {
  const db = fresh()
  noBarsRow(db, { key: 'e3', firstMs: T0 + 2 * HOUR })
  noBarsRow(db, { key: 'e2', firstMs: T0 + HOUR })
  noBarsRow(db, { key: 'e1', firstMs: T0 })
  noBarsRow(db, { key: 'g1', symbol: 'GBPUSD', firstMs: T0 - 10 * HOUR })
  const calls = []
  const out = await rescoreNoBarsRefusals(db, brokerFetch({ hitAt: T0 + 5 * HOUR, calls }), { nowMs: NOW, maxFetches: 1 })
  assert.equal(calls.length, 1, 'one read served the whole EURUSD group')
  assert.deepEqual([calls[0].symbol, calls[0].tf, calls[0].count], ['EURUSD', '1h', 400])
  assert.equal(out.rescored, 3)
  for (const k of ['e1', 'e2', 'e3']) {
    const r = scoreOf(db, k)
    assert.equal(r.outcome, 'target', k)
    assert.equal(r.scored_at, '2026-09-10T00:00:00.000Z', 'scored_at is kept: the window that counted it still counts it')
    assert.ok(r.note.startsWith(RESCORE_NOTE_PREFIX) && /was no_bars/.test(r.note), 'the correction says what it corrected')
  }
  assert.equal(scoreOf(db, 'g1').outcome, 'no_bars', 'the other group waits for its own read')
  assert.equal(out.left, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM refusal_scores').get().n, 4, 'nothing deleted')

  const second = await rescoreNoBarsRefusals(db, brokerFetch({ calls }), { nowMs: NOW, maxFetches: 3 })
  assert.equal(second.rescored, 1); assert.equal(second.left, 0)
  assert.equal(scoreOf(db, 'g1').outcome, 'time_cap')
  const third = await rescoreNoBarsRefusals(db, brokerFetch({ calls }), { nowMs: NOW, maxFetches: 3 })
  assert.equal(third.fetches, 0, 'the pass ends: nothing left, nothing re-read')
})

test('W13: a row this read does not reach back to waits and is scored by a later pass anchored on it', async () => {
  const db = fresh()
  noBarsRow(db, { key: 'new', firstMs: T0 })
  noBarsRow(db, { key: 'old', firstMs: T0 - 30 * 24 * HOUR })       // 400 hourly bars reach ~16.7 days back
  const calls = []
  await rescoreNoBarsRefusals(db, brokerFetch({ calls }), { nowMs: NOW, maxFetches: 1 })
  assert.equal(scoreOf(db, 'new').outcome, 'time_cap')
  assert.equal(scoreOf(db, 'old').outcome, 'no_bars', 'not scored from bars that begin after it')
  assert.equal(scoreOf(db, 'old').note, 'no bars stored')
  await rescoreNoBarsRefusals(db, brokerFetch({ calls }), { nowMs: NOW, maxFetches: 1 })
  assert.equal(scoreOf(db, 'old').outcome, 'time_cap')
  assert.equal(calls.length, 2)
})

test('W13: a failed read settles only its anchor as fetch_failed and stops the pass', async () => {
  const db = fresh()
  noBarsRow(db, { key: 'a', firstMs: T0 })
  noBarsRow(db, { key: 'b', symbol: 'GBPUSD', firstMs: T0 - HOUR })
  let calls = 0
  const out = await rescoreNoBarsRefusals(db, async () => { calls++; throw new Error('WS down') }, { nowMs: NOW, maxFetches: 3 })
  assert.equal(calls, 1)
  assert.equal(out.stopped, 'fetch_failed')
  assert.equal(scoreOf(db, 'a').outcome, 'fetch_failed')
  assert.match(scoreOf(db, 'a').note, /WS down/)
  assert.equal(scoreOf(db, 'b').outcome, 'no_bars')
})

test('W13: a row re-scored once is never picked again, even when the market truly printed nothing', async () => {
  const db = fresh()
  noBarsRow(db, { key: 'empty', firstMs: T0 })
  let calls = 0
  await rescoreNoBarsRefusals(db, async () => { calls++; return [] }, { nowMs: NOW, maxFetches: 3 })
  assert.equal(calls, 1)
  const r = scoreOf(db, 'empty')
  assert.equal(r.outcome, 'no_bars')
  assert.ok(r.note.startsWith(RESCORE_NOTE_PREFIX))
})

// ─── W16: the flat-close postmortem exemption ──────────────────────────────

function closedTrade(db, { net, ageH = 60, id = null }) {
  return db.prepare(`INSERT INTO trades (${id != null ? 'id, ' : ''}symbol, side, status, closed_at_ms, closed_at, net_pnl, entry_price, exit_price, sl_price, opened_at)
                     VALUES (${id != null ? '?, ' : ''}'EURUSD', 'BUY', 'closed', ?, ?, ?, 1.1, 1.1, 1.09, ?)`)
    .run(...(id != null ? [id] : []), NOW - ageH * HOUR, new Date(NOW - ageH * HOUR).toISOString().replace('T', ' ').slice(0, 19), net, new Date(NOW - (ageH + 2) * HOUR).toISOString()).lastInsertRowid
}

test('W16: the exemption is stated once — exactly flat is exempt, unknown is not', () => {
  assert.equal(postmortemExemption({ net_pnl: 0 })?.key, 'flat_zero_pnl')
  assert.equal(postmortemExemption({ net_pnl: '0' })?.key, 'flat_zero_pnl')
  assert.equal(postmortemExemption({ net_pnl: null }), null, 'NULL is unknown, not flat')
  assert.equal(postmortemExemption({ net_pnl: -0.01 }), null)
  assert.equal(postmortemExemption(null), null)
})

test('W16: a flat close is no longer counted as a stuck close; it is counted as exempt', () => {
  const db = fresh()
  const flat = closedTrade(db, { net: 0 })
  const loss = closedTrade(db, { net: -5 })
  const ids = findIncompleteCloses(db, { now: NOW }).map(r => r.id)
  assert.ok(!ids.includes(Number(flat)), 'the flat close is not incomplete')
  assert.ok(ids.includes(Number(loss)), 'a real close with no postmortem still is')
  assert.equal(countFlatExemptCloses(db, { now: NOW }), 1)
  closedTrade(db, { net: 0, ageH: 1 })
  assert.equal(countFlatExemptCloses(db, { now: NOW }), 1, 'same grace window as the incomplete list')
})

test('W16: the close_completeness goal names the exempt closes instead of counting them missing', async () => {
  const db = fresh()
  closedTrade(db, { net: 0 })
  const g = (await goalTable(db, { now: NOW })).goals.find(x => x.id === 'close_completeness')
  assert.equal(g.current, 0)
  assert.equal(g.verdict, 'on_track')
  assert.match(g.note, /1 closed exactly flat carry no postmortem — exempt/)
  assert.doesNotMatch(g.note, /missing a postmortem/)
})

test('W16: the sweep and the pending list apply the same exemption', async () => {
  const db = fresh()
  const flat = closedTrade(db, { net: 0, ageH: 3 })
  const asked = []
  const r = await runLossPostmortems(db, async (sym) => { asked.push(sym); return [] }, { now: NOW })
  assert.equal(r.examined, 0, 'the sweep never selects a flat close')
  const p = pendingLessons(db, { now: NOW }).rows.find(x => x.tradeId === Number(flat))
  assert.equal(p?.state, 'ineligible')
  assert.match(p.note, /closed exactly flat/)
})
