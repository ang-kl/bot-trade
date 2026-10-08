// Codex · №11,919 · 2026-10-07; codex-footprint: executed-volume-contract.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { shapeDeals, persistDeals, reconcileTradePricesToBroker } from './broker-history-import.js'
import { buildPositionRecord, capturePosition } from './position-history.js'
import { backfillClosedPnl } from './pnl-backfill.js'
import { walFilename } from '../test-support/wal-writer-race.js'

const meta = { 1: { symbolName: 'GER40', lotSize: 100_000 } }
const close = (id, filled = 70_000, closed = filled, price = 20) => ({
  dealId: id, positionId: 900, symbolId: 1, tradeSide: 2, dealStatus: 3,
  volume: 140_000, filledVolume: filled, executionTimestamp: 1000 + id,
  executionPrice: price, closePositionDetail: { closedVolume: closed,
    entryPrice: 10, grossProfit: 200, swap: -5, commission: -3, moneyDigits: 2 },
})

// Codex · №12,013 · 2026-10-08; codex-footprint: immutable receipt reread provenance.
// Real importer + downstream reader, with a complete account-owned position.
function receiptPosition(db) {
  const risk = db.prepare("INSERT INTO risk_events(symbol,side,approved,proposal_json) VALUES ('GER40','BUY',1,?)")
    .run(JSON.stringify({ direction_reason: 'higher-timeframe uptrend, pullback into value' }))
  db.prepare(`INSERT INTO trades(id,symbol,side,status,volume,entry_price,exit_price,sl_price,tp_price,
    opened_at,closed_at,closed_at_ms,hold_duration_ms,close_reason,strategy,ctrader_position_id,
    account_id,risk_event_id,origin,commission,swap,gross_pnl,net_pnl,realised_rr,conviction)
    VALUES(1,'GER40','BUY','closed',1.4,10,20,9,23,?, ?,2010,1010,'take_profit','vwap_trend',
      '900','11',?,'scan_dispatch',-0.03,-0.05,2,1.92,10,7)`)
    .run(new Date(1000).toISOString(), new Date(2010).toISOString(), risk.lastInsertRowid)
  db.exec(`INSERT INTO trade_plans(trade_id,account_id,symbol,side,strategy,family,timeframe,
    planned_entry,planned_sl,planned_tp,planned_r,risk_dist,exit_rule)
    VALUES(1,'11','GER40','BUY','vwap_trend','trend','H1',10,9,23,13,1,'trail_after_1r')`)
}

test('a narrower reread keeps validated volume and the complete downstream position', () => {
  const db = initDB(':memory:')
  try {
    receiptPosition(db)
    persistDeals(db, shapeDeals([close(2)], meta, '11'))
    const before = buildPositionRecord(db, { accountId: '11', positionId: '900' })
    assert.deepEqual(before.missing, [])
    assert.equal(before.record.volume, 0.7)
    const narrower = close(2)
    delete narrower.filledVolume
    delete narrower.closePositionDetail.closedVolume
    assert.equal(shapeDeals([narrower], meta, '11')[0].volume_contract, 0)
    persistDeals(db, shapeDeals([narrower], meta, '11'))
    const after = buildPositionRecord(db, { accountId: '11', positionId: '900' })
    assert.deepEqual(after, before)
    assert.deepEqual(db.prepare('SELECT volume_contract,lots,requested_lots FROM broker_deals').get(),
      { volume_contract: 1, lots: 0.7, requested_lots: 1.4 })
    const capture = capturePosition(db, { accountId: '11', positionId: '900' })
    assert.equal(capture.ok, true)
    assert.equal(capture.stream, 'history')
  } finally { db.close() }
})

// Codex · №12,020 · 2026-10-08; codex-footprint: known proof versus absent lot conversion.
test('validated wire quantity stays unsized until a complete reread supplies declared lot metadata', () => {
  const db = initDB(':memory:')
  try {
    receiptPosition(db)
    const namesOnly = { 1: { symbolName: 'GER40' } }
    persistDeals(db, shapeDeals([close(2)], namesOnly, '11'))
    assert.deepEqual(db.prepare('SELECT lots,volume_contract FROM broker_deals').get(), { lots: null, volume_contract: 1 })
    assert.ok(buildPositionRecord(db, { accountId: '11', positionId: '900' }).missing.includes('volume'))
    const narrower = close(2)
    delete narrower.filledVolume
    persistDeals(db, shapeDeals([narrower], namesOnly, '11'))
    assert.deepEqual(db.prepare('SELECT lots,volume_contract FROM broker_deals').get(), { lots: null, volume_contract: 1 })
    assert.ok(buildPositionRecord(db, { accountId: '11', positionId: '900' }).missing.includes('volume'))
    persistDeals(db, shapeDeals([close(2)], meta, '11'))
    const after = buildPositionRecord(db, { accountId: '11', positionId: '900' })
    assert.deepEqual(after.missing, [])
    assert.equal(after.record.volume, 0.7)
  } finally { db.close() }
})

test('malformed or individually missing executed fields cannot erase an earlier validated receipt', () => {
  const db = initDB(':memory:')
  try {
    persistDeals(db, shapeDeals([close(2)], meta, '11'))
    const expected = db.prepare('SELECT lots,volume_contract,gross_pnl,swap,commission,net_pnl FROM broker_deals').get()
    for (const field of ['filledVolume', 'closedVolume']) {
      for (const value of [undefined, null, '', ' ', false, true, 0, -1, 1.5, '7x', Number.MAX_SAFE_INTEGER + 1]) {
        const narrower = close(2)
        if (field === 'filledVolume') narrower[field] = value
        else narrower.closePositionDetail[field] = value
        const shaped = shapeDeals([narrower], meta, '11')
        assert.equal(shaped[0].lots, null)
        assert.equal(shaped[0].volume_contract, 0)
        persistDeals(db, shaped)
        assert.deepEqual(db.prepare('SELECT lots,volume_contract,gross_pnl,swap,commission,net_pnl FROM broker_deals').get(), expected)
      }
    }
  } finally { db.close() }
})

test('partial closes keep the executed-weighted whole quantity after mixed complete and narrower rereads', () => {
  const db = initDB(':memory:')
  try {
    receiptPosition(db)
    const first = close(2, 30_000, 30_000, 20), last = close(3, 110_000, 110_000, 30)
    persistDeals(db, shapeDeals([first, last], meta, '11'))
    const before = buildPositionRecord(db, { accountId: '11', positionId: '900' })
    assert.deepEqual(before.missing, [])
    assert.ok(Math.abs(before.record.volume - 1.4) < 1e-12)
    const narrower = structuredClone(last)
    delete narrower.filledVolume
    persistDeals(db, shapeDeals([first, narrower], meta, '11'))
    assert.deepEqual(buildPositionRecord(db, { accountId: '11', positionId: '900' }), before)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM broker_deals').get().n, 2)
  } finally { db.close() }
})

test('same-batch rereads retain the strongest quantity proof without promoting unknown receipts', () => {
  const db = initDB(':memory:')
  try {
    const narrower = close(2)
    delete narrower.filledVolume
    persistDeals(db, shapeDeals([narrower, close(2), narrower], meta, '11'))
    assert.deepEqual(db.prepare('SELECT lots,volume_contract FROM broker_deals').get(), { lots: 0.7, volume_contract: 1 })
    const unknown = close(3)
    delete unknown.filledVolume
    persistDeals(db, shapeDeals([unknown, unknown], meta, '11'))
    assert.deepEqual(db.prepare("SELECT lots,volume_contract FROM broker_deals WHERE deal_id='3'").get(), { lots: null, volume_contract: 0 })
    assert.ok(buildPositionRecord(db, { accountId: '11', positionId: '900' }).missing.includes('volume'))
  } finally { db.close() }
})

test('an unvalidated reread cannot pair a new requested quantity with an old validated contract', () => {
  const db = initDB(':memory:')
  try {
    persistDeals(db, shapeDeals([close(2)], meta, '11'))
    const row = shapeDeals([close(2)], meta, '11')[0]
    row.lots = row.requested_lots
    row.volume_contract = null // an older/statement writer has no executed-quantity proof
    persistDeals(db, [row])
    assert.deepEqual(db.prepare('SELECT lots,volume_contract,requested_lots FROM broker_deals').get(),
      { lots: 0.7, volume_contract: 1, requested_lots: 1.4 })
  } finally { db.close() }
})

test('narrow rereads with a conflicting owner or position roll back every receipt in the batch', () => {
  const db = initDB(':memory:')
  try {
    persistDeals(db, shapeDeals([close(2)], meta, '11'))
    const before = db.prepare('SELECT * FROM broker_deals').all()
    const narrower = close(2)
    delete narrower.filledVolume
    assert.throws(() => persistDeals(db, shapeDeals([close(3), narrower], meta, '22')), /identity conflicts/)
    const other = structuredClone(narrower)
    other.positionId = 901
    assert.throws(() => persistDeals(db, shapeDeals([close(3), other], meta, '11')), /identity conflicts/)
    assert.deepEqual(db.prepare('SELECT * FROM broker_deals').all(), before)
  } finally { db.close() }
})

test('actual adapter uses closing quantity rather than requested quantity, retaining native costs', () => {
  const rows = shapeDeals([close(2), close(3)], meta, '11')
  assert.equal(rows.reduce((s, r) => s + r.lots, 0), 1.4)
  assert.equal(rows[0].requested_lots, 1.4)
  assert.equal(rows[0].volume_contract, 1)
  assert.equal(rows[0].net_pnl, 1.92)
})

test('actual adapter refuses missing, coercible, fractional, unsafe and mixed-reversal quantities', () => {
  for (const filled of [undefined, null, '', ' ', false, true, 0, -1, 1.5, '7x', Number.MAX_SAFE_INTEGER + 1]) {
    const d = close(2); d.filledVolume = filled
    assert.equal(shapeDeals([d], meta, '11')[0].lots, null, String(filled))
  }
  assert.equal(shapeDeals([close(2, 140_000, 70_000)], meta, '11')[0].lots, null)
  const notExecuted = close(2); notExecuted.dealStatus = 'REJECTED'
  assert.equal(shapeDeals([notExecuted], meta, '11')[0].lots, null)
  assert.equal(shapeDeals([close(2, '70000', '70000')], meta, '11')[0].lots, 0.7)
})

test('revisiting a retained legacy deal cannot rewrite its lots, prices, money or certify its old quantity', () => {
  const db = initDB(':memory:')
  try {
    db.exec("INSERT INTO broker_deals (deal_id,position_id,account_id,symbol,lots,entry_price,close_price,net_pnl) VALUES ('2','900','11','GER40',4.2,9,18,1.23)")
    const before = db.prepare('SELECT lots,entry_price,close_price,net_pnl FROM broker_deals').get()
    persistDeals(db, shapeDeals([close(2)], meta, '11'))
    assert.deepEqual(db.prepare('SELECT lots,entry_price,close_price,net_pnl FROM broker_deals').get(), before)
    assert.equal(db.prepare('SELECT volume_contract FROM broker_deals').get().volume_contract, null)
  } finally { db.close() }
})

test('new partial-close receipts produce executed-lots-weighted prices and preserve requested plan quantity', () => {
  const db = initDB(':memory:')
  try {
    db.exec("INSERT INTO trades(id,symbol,side,status,volume,entry_price,exit_price,ctrader_position_id,account_id) VALUES (1,'GER40','BUY','closed',1.4,10,20,'900','11')")
    persistDeals(db, shapeDeals([close(2, 30_000, 30_000, 20), close(3, 110_000, 110_000, 30)], meta, '11'))
    const out = reconcileTradePricesToBroker(db)
    assert.equal(out.error, undefined)
    assert.equal(db.prepare('SELECT volume FROM trades WHERE id=1').get().volume, 1.4)
    assert.ok(Math.abs(db.prepare('SELECT exit_price FROM trades WHERE id=1').get().exit_price - (0.3 * 20 + 1.1 * 30) / 1.4) < 1e-8)
  } finally { db.close() }
})

test('a smaller actual fill retains its requested trade quantity separately and does not count duplicate deals twice', () => {
  const db = initDB(':memory:')
  try {
    db.exec("INSERT INTO trades(id,symbol,side,status,volume,entry_price,exit_price,ctrader_position_id,account_id) VALUES (1,'GER40','BUY','closed',1.4,10,20,'900','11')")
    const d = close(2)
    persistDeals(db, shapeDeals([d,d], meta, '11'))
    reconcileTradePricesToBroker(db)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM broker_deals').get().n,1)
    assert.deepEqual(db.prepare('SELECT volume,requested_volume FROM trades').get(),{volume:0.7,requested_volume:1.4})
    const out = buildPositionRecord(db,{accountId:'11',positionId:'900'}).record
    assert.equal(out.volume,0.7)
    assert.equal(out.requested_volume,1.4)
  } finally { db.close() }
})

test('legacy or mixed close receipts cannot become a certified whole-position volume through capture', () => {
  const db = initDB(':memory:')
  try {
    db.exec("INSERT INTO trades(id,symbol,side,status,volume,ctrader_position_id,account_id) VALUES (1,'GER40','BUY','closed',1.4,'900','11')")
    db.exec("INSERT INTO broker_deals(deal_id,position_id,account_id,symbol,lots) VALUES ('2','900','11','GER40',4.2)")
    const result = buildPositionRecord(db, { accountId: '11', positionId: '900' })
    assert.equal(result.record.volume, null)
    assert.ok(result.missing.includes('volume'))
    const capture = capturePosition(db, { accountId: '11', positionId: '900' })
    assert.equal(capture.ok, false)
  } finally { db.close() }
})

test('new receipts cannot bypass the retained-trade boundary, which does not move on restart', () => {
  const db = initDB(':memory:')
  try {
    db.exec("INSERT INTO trades(id,symbol,side,status,volume,entry_price,exit_price,ctrader_position_id,account_id) VALUES (1,'GER40','BUY','closed',4.2,9,18,'900','11')")
    db.prepare("UPDATE agent_state SET value='1' WHERE key='executed_volume_contract_1_trade_boundary'").run()
    const before = db.prepare('SELECT * FROM trades WHERE id=1').get()
    persistDeals(db, shapeDeals([close(2), close(3)], meta, '11'))
    reconcileTradePricesToBroker(db)
    assert.deepEqual(db.prepare('SELECT * FROM trades WHERE id=1').get(), before)
    // Repeat the exact INSERT OR IGNORE startup contract after newer trades.
    db.exec("INSERT INTO trades(id,symbol,side,status) VALUES(2,'X','BUY','open')")
    db.exec("INSERT OR IGNORE INTO agent_state(key,value) SELECT 'executed_volume_contract_1_trade_boundary',CAST(COALESCE(MAX(id),0) AS TEXT) FROM trades")
    assert.equal(db.prepare("SELECT value FROM agent_state WHERE key='executed_volume_contract_1_trade_boundary'").get().value, '1')
  } finally { db.close() }
})

test('actual upgrade stamps the pre-release high-watermark once and preserves legacy facts across restart', () => {
  const file = walFilename()
  let db = initDB(file)
  db.exec("INSERT INTO trades(id,symbol,side,status,volume,net_pnl) VALUES(10,'GER40','BUY','closed',4.2,1.23)")
  // Simulate the exact pre-contract DB: no watermark and legacy deal tags.
  db.exec("DELETE FROM agent_state WHERE key='executed_volume_contract_1_trade_boundary'")
  db.close()
  db = initDB(file)
  try {
    assert.equal(db.prepare("SELECT value FROM agent_state WHERE key='executed_volume_contract_1_trade_boundary'").get().value, '10')
    assert.deepEqual(db.prepare('SELECT volume,net_pnl FROM trades WHERE id=10').get(), { volume: 4.2, net_pnl: 1.23 })
    db.exec("INSERT INTO trades(id,symbol,side,status) VALUES(11,'X','BUY','open')")
  } finally { db.close() }
  db = initDB(file)
  try { assert.equal(db.prepare("SELECT value FROM agent_state WHERE key='executed_volume_contract_1_trade_boundary'").get().value, '10') }
  finally { db.close() }
})

test('conflicting account or position identity rolls back the receipt batch, retaining the original owner', () => {
  const db = initDB(':memory:')
  try {
    persistDeals(db, shapeDeals([close(2)], meta, '11'))
    const before = db.prepare('SELECT * FROM broker_deals').get()
    assert.throws(() => persistDeals(db, shapeDeals([close(2)], meta, '22')), /identity conflicts/)
    const other = close(2); other.positionId = 901
    assert.throws(() => persistDeals(db, shapeDeals([other], meta, '11')), /identity conflicts/)
    assert.deepEqual(db.prepare('SELECT * FROM broker_deals').get(), before)
  } finally { db.close() }
})

test('retained complete history can be rechecked without rebuilding it from legacy volume', () => {
  const db = initDB(':memory:')
  try {
    db.exec("INSERT INTO trades(id,symbol,side,status,volume,ctrader_position_id,account_id) VALUES(1,'GER40','BUY','closed',4.2,'900','11')")
    db.exec("UPDATE agent_state SET value='1' WHERE key='executed_volume_contract_1_trade_boundary'")
    db.exec(`INSERT INTO position_history(account_id,ctrader_position_id,trade_id,symbol,direction,direction_reason,strategy,origin,
      planned_entry,planned_sl,risk_dist,realised_r,entry_price,exit_price,volume,opened_at_ms,closed_at_ms,hold_ms,gross_pnl,commission,swap,net_pnl,
      close_reason,sl_moves,tp_moves,scale_outs,events_json,sources_json)
      VALUES('11','900',1,'GER40','long','retained','vwap_trend','scan_dispatch',9,8,1,9,9,18,4.2,100,1000,900,2,-0.7,-0.07,1.23,
      'broker_close',0,0,0,'[]','{}')`)
    const before = db.prepare('SELECT * FROM position_history').get()
    const out = capturePosition(db, { accountId: '11', positionId: '900' })
    assert.equal(out.ok, true)
    assert.equal(out.retained, true)
    assert.deepEqual(db.prepare('SELECT * FROM position_history').get(), before)
  } finally { db.close() }
})

test('backfill weights every actual close, protects pre-release exits and refuses a missing close price', async () => {
  for (const kind of ['prospective', 'retained', 'missing-price']) {
    const db = initDB(':memory:')
    try {
      const now = Date.parse('2026-10-07T13:00:00Z')
      db.exec("INSERT INTO trades(id,symbol,side,status,volume,entry_price,exit_price,net_pnl,pnl_price_mismatch,ctrader_position_id,account_id) VALUES(1,'GER40','BUY','closed',1.4,10,18,1.23,1,'900','11')")
      db.exec("UPDATE trades SET opened_at='2026-10-07 12:58:00',closed_at='2026-10-07 12:59:00' WHERE id=1")
      if (kind === 'retained') db.exec("UPDATE agent_state SET value='1' WHERE key='executed_volume_contract_1_trade_boundary'")
      const closes = [close(2,30_000,30_000,20), close(3,110_000,110_000,30)]
      closes.forEach((d,i) => { d.executionTimestamp = now - 60_000 + i })
      if (kind === 'missing-price') delete closes[1].executionPrice
      const open = { dealId:1,positionId:900,symbolId:1,tradeSide:1,dealStatus:2,volume:200_000,filledVolume:140_000,executionTimestamp:now-120_000,executionPrice:10 }
      await backfillClosedPnl(db, {accountId:'11'}, { accountId:'11',strictAccount:true,now,getDeals:async()=>({ deal:[open,...closes],hasMore:false }) })
      const row = db.prepare('SELECT exit_price,volume,net_pnl FROM trades WHERE id=1').get()
      assert.equal(row.net_pnl,1.23)
      assert.equal(row.volume,1.4)
      if (kind === 'prospective') assert.ok(Math.abs(row.exit_price-(0.3*20+1.1*30)/1.4)<1e-8)
      else assert.equal(row.exit_price,18,kind)
    } finally { db.close() }
  }
})
