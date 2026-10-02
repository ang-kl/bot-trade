import test from 'node:test'
import assert from 'node:assert/strict'
import {
  observePosition, wilderAtr, foldExcursion, recordObserve, observeIntervalMs,
  chandelierSinceEntry, decideAdjust, shouldSendChandelierAdjust, sinceEntryTrailSpec,
  recordAmendReceipt, receiptFromBrokerOutcome, receiptFromTrailMove, OBSERVE_STATE_KEY,
  heldBarsSince, positionOpenedAtMs, noteMid, freshMid, maeChandelierView, activeMonitoredIds,
} from './mae-chandelier-observe.js'

function barsFrom(closes) {
  return closes.map(c => ({ h: c + 1, l: c - 1, c }))
}

test('interval stays on the monitor clock and never below one second', () => {
  assert.equal(observeIntervalMs({}), 3000)
  assert.equal(observeIntervalMs({ FAST_MONITOR_MS: '250' }), 1000)
  assert.equal(observeIntervalMs({ FAST_MONITOR_MS: '5000' }), 5000)
})

test('a long that has not paid is recorded and may not amend', () => {
  const bars = barsFrom(Array.from({ length: 30 }, (_, i) => 100 + i))
  const reading = observePosition({
    side: 'LONG', entry: 120, price: 112, sl: 110, bars,
  })
  assert.equal(reading.mayAmend, false)
  assert.equal(reading.mae, 8)
  assert.ok(reading.maeOverRisk > 0.7)
  assert.equal(reading.reason, 'observe_only')
  assert.equal(JSON.stringify(reading).includes('"mayAmend":true'), false)
})

test('22-session chandelier and since-entry chandelier are not the same high', () => {
  const bars = []
  for (let i = 0; i < 22; i++) bars.push({ h: 200, l: 190, c: 195 })
  for (let i = 0; i < 5; i++) bars.push({ h: 110, l: 100, c: 105 })
  const atr = wilderAtr(bars, 22)
  assert.ok(atr > 0)
  const since = chandelierSinceEntry(bars, 22, 1, atr, 3)
  const book = observePosition({ side: 'LONG', entry: 108, price: 104, sl: 100, bars })
  assert.ok(book.chandelier22 > since)
  assert.equal(book.mayAmend, false)
})

test('fold keeps the worst heat and never raises mayAmend', () => {
  const folded = foldExcursion({ mae: 2, mfe: 1 }, { mae: 5, mfe: 0.5, mayAmend: true })
  assert.equal(folded.mae, 5)
  assert.equal(folded.mfe, 1)
  assert.equal(folded.mayAmend, false)
})

test('tighten is allowed only when the since-entry line is tighter and still behind price', () => {
  const bars = barsFrom(Array.from({ length: 30 }, () => 100))
  bars[29] = { h: 110, l: 100, c: 108 }
  const yes = decideAdjust({ side: 'LONG', entry: 100, price: 120, sl: 90, bars, openedAtMs: 0 })
  assert.equal(yes.mayAmend, true)
  assert.equal(yes.adjust.action, 'MOVE_SL')
  assert.ok(yes.adjust.sl > 90)
  assert.equal(yes.adjust.newSL, yes.adjust.sl)
  assert.ok(yes.adjust.sl < 120)
  const no = decideAdjust({ side: 'LONG', entry: 100, price: 95, sl: 99, bars, openedAtMs: 0 })
  assert.equal(no.mayAmend, false)
})
test('external is recorded and not sent; missing digits drop the trail spec', () => {
  const reading = { adjust: { action: 'MOVE_SL', sl: 104 } }
  assert.equal(shouldSendChandelierAdjust({ source: 'external' }, reading), false)
  assert.equal(shouldSendChandelierAdjust({ source: 'bot' }, reading), true)
  assert.equal(shouldSendChandelierAdjust({ source: 'bot' }, { adjust: null }), false)
  const bars = barsFrom(Array.from({ length: 30 }, () => 100))
  assert.equal(sinceEntryTrailSpec({ positionId: 1, accountId: 2, symbolId: 3, side: 'LONG', entry: 100, bars, digits: undefined }), null)
  const spec = sinceEntryTrailSpec({ positionId: 1, accountId: 2, symbolId: 3, side: 'LONG', entry: 100, bars, digits: 5, currentSl: 90 })
  assert.equal(spec.digits, 5)
  assert.equal(spec.peakPrice, 100)
  assert.ok(spec.trailDistance > 0)
})

test('a receipt is accepted only when the broker returns a summary', async () => {
  const store = new Map()
  const io = { read: (_db, key) => store.get(key) || null, write: (_db, key, value) => store.set(key, value) }
  const refused = receiptFromBrokerOutcome('9', 104, { error: 'INVALID_REQUEST' })
  assert.equal(refused.sent, false)
  assert.equal(refused.broker, 'INVALID_REQUEST')
  const accepted = receiptFromBrokerOutcome('9', 104, { summary: 'SL → 104.00000' })
  assert.equal(accepted.sent, true)
  await recordAmendReceipt({}, accepted, 0, io)
  const saved = JSON.parse(store.get(OBSERVE_STATE_KEY))
  assert.equal(saved.receipts.length, 1)
  assert.equal(saved.receipts[0].broker, 'SL → 104.00000')
  assert.equal(saved.mayAmend, false)
})

test('a trail read-back is a broker ack only when the stop actually moved', () => {
  assert.equal(receiptFromTrailMove('9', undefined, 104), null)
  assert.equal(receiptFromTrailMove('9', 104, 104), null)
  const moved = receiptFromTrailMove('9', 100, 104)
  assert.equal(moved.sent, true)
  assert.equal(moved.broker, 'trail lastSl 104')
})

test('state write keeps a tighten flag and the heat', async () => {
  const store = new Map()
  const db = {}
  const io = {
    read: (_db, key) => store.get(key) || null,
    write: (_db, key, value) => store.set(key, value),
  }
  await recordObserve(db, [{ id: '242243012', symbol: 'MA.US', mae: 18.89, mfe: 6.34, mayAmend: true }], 0, io)
  const saved = JSON.parse(store.get(OBSERVE_STATE_KEY))
  assert.equal(saved.mode, 'observe_and_tighten')
  assert.equal(saved.positions['242243012'].mayAmend, true)
  assert.equal(saved.positions['242243012'].mae, 18.89)
})

// 02-10-2026 (№ 10,436): the reading runs AFTER the exit verdict, on a HOLD,
// and never waits on the broker for bars — placed before the verdict it held
// every exit up to 8 s (fast-monitor-m7-differential went red: +3.7 s, +5 s).
test('fast monitor: the Chandelier reading follows the HOLD verdict and its bar fetch is never awaited', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./fast-monitor.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  const hold = src.indexOf("if (eval_.action === 'HOLD') {")
  const call = src.indexOf('await maeChandelierTick(db, s, pos, mid, routeOf(pos, receipt.accountId), creds, deps, loopMod)')
  const verdict = src.indexOf('const eval_ = evaluatePosition(pos, {')
  assert.ok(verdict > 0 && hold > verdict && call > hold, 'the reading sits inside the HOLD branch, after the verdict')
  assert.equal(src.split('maeChandelierTick(').length - 1, 4, 'one definition, the HOLD call site, and the two no-quote recordings')
  const helper = src.slice(src.indexOf('function maeBarsFor('), src.indexOf('async function maeChandelierTick('))
  assert.ok(helper.includes('wsGetTrendbarsBatch') && !/await\s/.test(helper), 'the bar fetch runs in the background')
})

test('a receipt carries what the sidecar confirmed: sent, unchanged, confirmed read-back and the stop-policy outcome', () => {
  // sent and read back by the sidecar's ratchet
  const sent = receiptFromBrokerOutcome('9', 104, {
    summary: 'SL → 104.00000',
    protection: { verified: true, stopLoss: 104, takeProfit: 110 },
    policy: { applied: true, readback: 'confirmed', refused: null, skipped: null },
  })
  assert.equal(sent.sent, true)
  assert.equal(sent.confirmed, true)
  assert.equal(sent.heldSl, 104)
  assert.deepEqual(sent.policy, { applied: true, readback: 'confirmed', refused: false, skipped: null })
  // the broker already held a tighter stop (broker-side trailing): an answer, not a send, not a failure
  const kept = receiptFromBrokerOutcome('9', 104, {
    summary: 'SL kept 105.00000 (broker already tighter than 104.00000)', unchanged: true,
    protection: { verified: true, stopLoss: 105 },
  })
  assert.equal(kept.sent, false)
  assert.equal(kept.unchanged, true)
  assert.equal(kept.heldSl, 105)
  // the broker refused the policy flags and the stop still went through without them
  const refused = receiptFromBrokerOutcome('9', 104, { summary: 'SL → 104.00000', policy: { applied: false, readback: 'unverified', refused: { errorCode: 'INVALID_REQUEST' }, skipped: null } })
  assert.equal(refused.sent, true)
  assert.equal(refused.policy.refused, true)
  // no read-back, no policy block: the old shapes are unchanged
  const plain = receiptFromBrokerOutcome('9', 104, { summary: 'SL → 104.00000' })
  assert.equal('confirmed' in plain, false)
  assert.equal('policy' in plain, false)
  assert.equal('unchanged' in plain, false)
})


// 03-10-2026 (owner: "fix since-entry first"; "no excuse like incomplete").
test('since entry uses only the bars that began after the fill, not the whole fetched window', () => {
  // 30 hourly bars: the first 20 (before the fill) peaked at 150, the last 10 (after it) at 110.
  const H = 3_600_000
  const bars = Array.from({ length: 30 }, (_, i) => ({ t: i * H, h: i < 20 ? 150 : 110, l: 100, c: 105 }))
  const openedAtMs = 19.5 * H
  assert.equal(heldBarsSince(bars, openedAtMs).length, 10, 'only bars that began after the fill')
  const r = decideAdjust({ side: 'LONG', entry: 105, price: 120, sl: 90, bars, openedAtMs })
  // 110 - 3 x ATR must sit below the 22-bar-wide 150 - 3 x ATR the old index-0 cut gave.
  const old = decideAdjust({ side: 'LONG', entry: 105, price: 120, sl: 90, bars, openedAtMs: -1 })
  assert.ok(r.chandelierSinceEntry < old.chandelierSinceEntry, `since-entry ${r.chandelierSinceEntry} must be below the whole-window ${old.chandelierSinceEntry}`)
  assert.equal(r.heldBars, 10)
})

test('a trade with no completed bar since the fill still gets a level from its own entry and price', () => {
  const H = 3_600_000
  const bars = Array.from({ length: 30 }, (_, i) => ({ t: i * H, h: 101, l: 99, c: 100 }))
  const r = decideAdjust({ side: 'LONG', entry: 100, price: 110, sl: 90, bars, openedAtMs: 40 * H })
  assert.equal(r.heldBars, 0)
  assert.ok(r.chandelierSinceEntry > 0 && r.chandelierSinceEntry < 110)
  assert.equal(r.mayAmend, true, 'level above the 90 stop and below the price')
  const short = decideAdjust({ side: 'SHORT', entry: 100, price: 90, sl: 110, bars, openedAtMs: 40 * H })
  assert.equal(short.mayAmend, true)
  assert.ok(short.adjust.sl > 90 && short.adjust.sl < 110)
})

test('an unknown open time is named, never guessed, and cannot amend', () => {
  const bars = barsFrom(Array.from({ length: 30 }, () => 100))
  const r = decideAdjust({ side: 'LONG', entry: 100, price: 120, sl: 90, bars })
  assert.equal(r.reason, 'entry_time_unknown')
  assert.equal(r.mayAmend, false)
  assert.equal(r.adjust, null)
})

test('a missing quote is named by market state: closed is expected, open is a counted defect', () => {
  const closed = decideAdjust({ side: 'LONG', entry: 100, price: null, sl: 90, bars: null, marketOpen: false })
  assert.equal(closed.reason, 'market_closed')
  const open = decideAdjust({ side: 'LONG', entry: 100, price: null, sl: 90, bars: null, marketOpen: true })
  assert.equal(open.reason, 'quote_missing_market_open')
  assert.equal(decideAdjust({ side: 'LONG', entry: null, price: 100, sl: 90 }).reason, 'entry_price_missing')
  assert.equal(decideAdjust({ side: '', entry: 100, price: 100, sl: 90 }).reason, 'direction_missing')
  for (const r of [closed, open]) assert.equal(r.mayAmend, false)
  const view = maeChandelierView({}, () => JSON.stringify({ positions: { a: { reason: 'quote_missing_market_open' }, b: { reason: 'market_closed' }, c: { reason: 'entry_time_unknown' } } }))
  assert.equal(view.summary.quoteMissingMarketOpen, 1)
  assert.equal(view.summary.entryTimeUnknown, 1)
})

test('open time comes from the trade fill, else the row stamp, as UTC', () => {
  const db = { prepare: () => ({ get: id => (id === 5 ? { opened_at: '2026-10-02 13:31:00' } : undefined) }) }
  assert.equal(positionOpenedAtMs(db, { trade_id: 5, created_at: '2026-10-02 15:00:00' }), Date.parse('2026-10-02T13:31:00Z'))
  assert.equal(positionOpenedAtMs(db, { trade_id: 9, created_at: '2026-10-02 15:00:00' }), Date.parse('2026-10-02T15:00:00Z'))
  assert.equal(positionOpenedAtMs(db, { created_at: null }), null)
})

test('the slow pass reads the fast monitor\'s fresh mid before calling a position quote-less', () => {
  noteMid('p1', 101.5, 1_000)
  assert.equal(freshMid('p1', 1_000 + 30_000), 101.5)
  assert.equal(freshMid('p1', 1_000 + 61_000), null, 'older than a minute is not a price')
  assert.equal(freshMid('never', 1_000), null)
})

test('wiring: the bar fetch uses the position\'s own host and keys the cache by symbol name', async () => {
  const { readFileSync } = await import('node:fs')
  const strip = f => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  const fast = strip('./fast-monitor.js')
  const helper = fast.slice(fast.indexOf('function maeBarsFor('), fast.indexOf('async function maeChandelierTick('))
  assert.ok(helper.includes('wsGetTrendbarsBatch(route.host'), 'the position\'s own host, not the selected account\'s')
  assert.ok(helper.includes('route.symbolId'), 'the position\'s own symbol id space')
  assert.ok(helper.includes('console.warn'), 'a failed fetch is logged, not swallowed')
  assert.equal(fast.split('maeChandelierTick(db, s, pos, null,').length - 1, 2, 'both no-quote paths record a named reading')
  assert.ok(fast.includes('if (!isPreFill(pos)) await maeChandelierTick(db, s, pos, null, routeOf('), 'the sidecar-priced no-quote path records one')
  const loop = strip('../loop.js')
  assert.ok(loop.includes("cachedBars(String(pos.symbol || '').toUpperCase())"), 'the slow pass reads the same name-keyed cache')
  assert.ok(loop.includes('openedAtMs: positionOpenedAtMs(db, pos)'), 'the slow pass cuts at the open time')
  assert.ok(fast.includes('openedAtMs: positionOpenedAtMs(db, pos)'), 'the fast pass cuts at the open time')
})

test('recording a reading drops the rows of positions that are no longer open', async () => {
  let stored = JSON.stringify({ positions: { 1: { id: '1', symbol: 'A' }, 2: { id: '2', symbol: 'B' } } })
  const db = { prepare: () => ({ all: () => [{ id: 1 }, { id: 3 }] }) }
  await recordObserve(db, [{ id: '3', symbol: 'C', mayAmend: false }], Date.now(), { read: () => stored, write: (_d, _k, v) => { stored = v } })
  assert.deepEqual(Object.keys(JSON.parse(stored).positions).sort(), ['1', '3'], 'row 2 (closed) is gone, 1 and the new 3 stay')
})

test('an unreadable monitored table drops nothing', async () => {
  assert.equal(activeMonitoredIds({ prepare: () => { throw new Error('no table') } }), null)
  let stored = JSON.stringify({ positions: { 1: { id: '1' } } })
  await recordObserve({ prepare: () => { throw new Error('no table') } }, [{ id: '2', mayAmend: false }], Date.now(), { read: () => stored, write: (_d, _k, v) => { stored = v } })
  assert.deepEqual(Object.keys(JSON.parse(stored).positions).sort(), ['1', '2'])
})
