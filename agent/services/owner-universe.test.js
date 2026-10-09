// Codex · №12,473 · 2026-10-09; codex-footprint: real SQLite + controlled broker catalogue.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { initDB, setState, getState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { readWatchlist, writeWatchlist, acctWatchlistKey } from './watchlists.js'
import { applyOwnerUniverse, removeHkWatchlistRows, classifyCatalogue, stockMetadataVerdict, receiptKey } from './owner-universe.js'
import { wsGetAccountInstrumentCatalogue, PT, _setWebSocketForTests } from '../lib/ctrader-ws.js'
import { reserveEntry } from './entry-ledger.js'
import { catalogueKey } from '../lib/owner-instrument-policy.js'
const ids = ['46130058', '42993489']
function fresh() { const db = initDB(':memory:'); for (const id of ids) upsertAccount(db, { accountId: id, isLive: id === ids[1] }); return db }
function catalogue(id, offset = 0) {
  const wrap = extra => ({ ctidTraderAccountId: Number(id), ...extra })
  return {
    assetClasses: wrap({ assetClass: [{ id: 1, name: 'Indices' }, { id: 2, name: 'Stocks' }] }),
    categories: wrap({ symbolCategory: [{ id: 1, assetClassId: 1, name: 'Global Indices' }, { id: 2, assetClassId: 2, name: 'Hong Kong' }, { id: 3, assetClassId: 2, name: 'Singapore' }, { id: 4, assetClassId: 2, name: 'Japan' }] }),
    symbols: wrap({ symbol: [
      { symbolName: 'HK50', symbolId: offset + 1, symbolCategoryId: 1 },
      { symbolName: 'GER40', symbolId: offset + 2, symbolCategoryId: 1 },
      { symbolName: '9618.HK', symbolId: offset + 3, symbolCategoryId: 2 },
      { symbolName: 'D05.SG', description: 'DBS Group', symbolId: offset + 4, symbolCategoryId: 3 },
      { symbolName: 'HSI.HK', symbolId: offset + 5, symbolCategoryId: 1 },
      { symbolName: '7203.JP', symbolId: offset + 6, symbolCategoryId: 4 },
      { symbolName: 'RETIRED', symbolId: offset + 7, symbolCategoryId: 1, enabled: false },
    ] }),
  }
}
const detail = { scheduleTimeZone: 'Asia/Singapore', schedule: [{ startSecond: 118800, endSecond: 144000 }], commission: 2000, commissionType: 1 }
const credentials = (_db, id) => ({ ready: true, accountId: id, host: id === ids[0] ? 'demo.test' : 'live.test' })
const details = async (c, symbols) => ({ ctidTraderAccountId: c.accountId, symbol: symbols.map(symbolId => ({ ...detail, symbolId })) })
test('classify only this broker account, exclude HK shares, retain HK indices and refuse duplicate IDs', () => {
  const data = catalogue(ids[0]), c = classifyCatalogue(ids[0], data)
  assert.deepEqual(c.indices.map(x => x.symbol), ['GER40','HK50','HSI.HK'])
  assert.deepEqual(c.excluded, ['9618.HK'])
  assert.equal(c.available, 7); assert.equal(c.unclassified, 0)
  assert.deepEqual(c.stockCategories, ['Hong Kong', 'Singapore', 'Japan'])
  assert.deepEqual(c.stockCandidates.map(x => x.symbol), ['D05.SG'])
  assert.throws(() => classifyCatalogue(ids[1], data), /identity_or_shape/)
  data.symbols.symbol.push({ ...data.symbols.symbol[0], symbolName: 'OTHER' })
  assert.throws(() => classifyCatalogue(ids[0], data), /identity_conflict/)
})
test('all registered lists receive their own available indices/stocks; concurrent edits, settings and modes survive; durable no-replay', async () => {
  const db = fresh(); let calls = 0
  try {
    setState(db, 'autopilot_symbols_json', JSON.stringify([{ symbol: 'EURUSD', enabled: true, maxVolume: 0.1 }, { symbol: '9618.HK', enabled: true }]))
    // A disabled account is not activated by an instrument addition.
    db.prepare('UPDATE accounts SET enabled = 0 WHERE account_id = ?').run(ids[1])
    const accountsBefore = db.prepare('SELECT * FROM accounts ORDER BY account_id').all()
    const args = { credentials, details, catalogue: async c => {
      calls++
      if (c.accountId === ids[0]) writeWatchlist(db, c.accountId, [{ symbol: 'HK50', enabled: false, maxVolume: 0.07, strategies: ['pin'] }, { symbol: 'OWNER.US', enabled: true }])
      return catalogue(c.accountId, c.accountId === ids[0] ? 0 : 100)
    } }
    const rows = await applyOwnerUniverse(db, args)
    assert.equal(rows.length, 2); assert.equal(calls, 2)
    for (const id of ids) {
      const own = JSON.parse(getState(db, `symbol_id_map:${id}`))
      assert.equal(own.accountId, id); assert.equal(own.map.GER40, id === ids[0] ? 2 : 102)
      const list = readWatchlist(db, id)
      for (const name of ['HK50','GER40','HSI.HK','D05.SG']) assert.ok(list.some(x => x.symbol === name), `${id} ${name}`)
      assert.ok(!list.some(x => ['9618.HK','7203.JP','RETIRED'].includes(x.symbol)))
      assert.equal(JSON.parse(getState(db, receiptKey(id))).state, 'applied')
    }
    assert.deepEqual(readWatchlist(db, ids[0]).find(x => x.symbol === 'HK50'), { symbol: 'HK50', enabled: false, maxVolume: 0.07, strategies: ['pin'] })
    assert.ok(readWatchlist(db, ids[0]).some(x => x.symbol === 'OWNER.US'))
    assert.deepEqual(db.prepare('SELECT * FROM accounts ORDER BY account_id').all(), accountsBefore)
    assert.deepEqual(await applyOwnerUniverse(db, args), []); assert.equal(calls, 2)
  } finally { db.close() }
})
test('removal covers disabled/legacy lists and only unsent permits; retained positions and broker-pending orders survive', () => {
  const db = fresh()
  try {
    for (const key of ['autopilot_symbols_json','watchlist_json',...ids.map(acctWatchlistKey)]) setState(db, key, JSON.stringify([{ symbol: '9618.HK', enabled: false }, { symbol: 'HK50', enabled: true, maxVolume: 0.2 }]))
    const draft = reserveEntry(db, { accountId: ids[0], producerId: 'route_manual_order', symbol: 'EURUSD', symbolId: 1, side: 'BUY' })
    const resting = reserveEntry(db, { accountId: ids[0], producerId: 'route_manual_order', symbol: 'GBPUSD', symbolId: 2, side: 'BUY' })
    db.prepare("UPDATE entry_intents SET symbol = '9618.HK'").run()
    db.prepare("UPDATE entry_intents SET state = 'ACCEPTED', broker_order_id = '1234' WHERE id = ?").run(resting.intentId)
    db.prepare('UPDATE accounts SET enabled = 0').run()
    db.prepare("INSERT INTO trades(symbol, status, sl_price, tp_price, ctrader_position_id) VALUES ('9618.HK','open',90,110,'123')").run()
    const before = db.prepare('SELECT * FROM trades').all()
    const out = removeHkWatchlistRows(db)
    assert.equal(out.lists.length, 4)
    assert.equal(out.unsubmittedReleased, 1)
    assert.equal(out.brokerPending.length, 1)
    assert.equal(out.brokerPending[0].id, resting.intentId)
    assert.equal(db.prepare('SELECT state FROM entry_intents WHERE id = ?').get(draft.intentId).state, 'RELEASED')
    assert.equal(db.prepare('SELECT state FROM entry_intents WHERE id = ?').get(resting.intentId).state, 'ACCEPTED')
    for (const key of ['autopilot_symbols_json','watchlist_json',...ids.map(acctWatchlistKey)]) assert.deepEqual(JSON.parse(getState(db,key)), [{ symbol:'HK50',enabled:true,maxVolume:0.2 }])
    assert.deepEqual(db.prepare('SELECT * FROM trades').all(), before)
    assert.equal(removeHkWatchlistRows(db).lists.length, 0)
  } finally { db.close() }
})
test('conflicting broker account or read failure never expands that account or leaks raw error text', async () => {
  const db = fresh(); const logs = []
  try {
    setState(db, 'autopilot_symbols_json', '["EURUSD"]')
    const results = await applyOwnerUniverse(db, { credentials, details, log: x => logs.push(x), catalogue: async c => { if(c.accountId === ids[0]) throw new Error('SECRET-DO-NOT-LOG'); return catalogue(ids[0]) } })
    assert.ok(results.every(x => x.state === 'blocked'))
    assert.ok(!logs.join('').includes('SECRET-DO-NOT-LOG'))
    for (const id of ids) { assert.equal(getState(db, catalogueKey(id)), null); assert.equal(getState(db, acctWatchlistKey(id)), null) }
  } finally { db.close() }
})
test('bad stock schedules/costs are explicit refusals, not guessed; proven indices still added', async () => {
  assert.equal(stockMetadataVerdict({ ...detail, commission: '2000', commissionType: 'USD_PER_MILLION_USD' }), null)
  assert.equal(stockMetadataVerdict({ ...detail, commission: '' }), 'commission_terms_unverified')
  assert.equal(stockMetadataVerdict({ ...detail, commission: undefined }), 'commission_terms_unverified')
  assert.equal(stockMetadataVerdict({ ...detail, commission: -1 }), 'commission_terms_unverified')
  assert.equal(stockMetadataVerdict({ ...detail, scheduleTimeZone: 'Asia/Tokyo' }), 'utc8_schedule_unverified')
  const db = fresh()
  try {
    const rows = await applyOwnerUniverse(db, { credentials, catalogue: async c => catalogue(c.accountId), details: async (c,s) => ({ ctidTraderAccountId: c.accountId, symbol: s.map(symbolId => ({ symbolId, ...detail, commission: undefined })) }) })
    for (const r of rows) { assert.deepEqual(r.stocks, []); assert.deepEqual(r.refusedStocks, [{ symbol:'D05.SG',reason:'commission_terms_unverified' }]); assert.ok(r.indices.includes('HK50')) }
  } finally { db.close() }
})
test('real catalogue adapter requests only this account, no shared cache; total timeout closes socket', async () => {
  const frames = []
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState=1; Socket.last=this; setImmediate(() => this.emit('open')) }
    send(raw) {
      const m=JSON.parse(raw); frames.push(m); const data=catalogue(ids[0])
      const answer = { [PT.APP_AUTH_REQ]: [PT.APP_AUTH_RES,{}], [PT.ACCOUNT_AUTH_REQ]: [PT.ACCOUNT_AUTH_RES,{ctidTraderAccountId:Number(ids[0])}], [PT.ASSET_CLASS_LIST_REQ]: [PT.ASSET_CLASS_LIST_RES,data.assetClasses], [PT.SYMBOL_CATEGORY_REQ]: [PT.SYMBOL_CATEGORY_RES,data.categories], [PT.SYMBOLS_LIST_REQ]: [PT.SYMBOLS_LIST_RES,data.symbols] }[m.payloadType]
      setImmediate(() => this.emit('message',Buffer.from(JSON.stringify({ payloadType:answer[0],payload:answer[1] }))))
    }
    close() { this.closed=true;this.readyState=3 }
  }
  _setWebSocketForTests(Socket)
  try {
    const r=await wsGetAccountInstrumentCatalogue('demo.test','cid','secret','token',ids[0],1000)
    assert.deepEqual(r,catalogue(ids[0])); assert.equal(frames.length,5)
    assert.ok(frames.slice(1).every(x=>x.payload.ctidTraderAccountId===Number(ids[0])))
    assert.equal(Socket.last.closed,true)
  } finally { _setWebSocketForTests(null) }
  class Silent extends EventEmitter { constructor(){super();this.readyState=1;Silent.last=this;setImmediate(()=>this.emit('open'))} send(){} close(){this.closed=true;this.readyState=3} }
  _setWebSocketForTests(Silent)
  try { await assert.rejects(wsGetAccountInstrumentCatalogue('demo.test','cid','secret','token',ids[0],20),/timeout/);assert.equal(Silent.last.closed,true) } finally { _setWebSocketForTests(null) }
})
