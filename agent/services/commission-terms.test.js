// Claude · № 13,794 13-Oct (task #44 step 1; claude-builder).
//
// Grounding of the expected values:
//  - Field scales and enum numbers: spotware/openapi-proto-messages
//    OpenApiModelMessages.proto (ProtoOASymbol fields 14/15/21-23/31/32,
//    ProtoOACommissionType, ProtoOAMinCommissionType).
//  - Deal figures: the broker's own deals as imported into broker_deals
//    (47790949 AUDUSD 324398847 and GBPUSD 323632842; 43097342 USDSGD
//    324214333; 46130058 SGDJPY 321439415), 12-10-2026.
//  - The $3.50 per lot per side: measured on 52 of 52 FX deals on 47790949.
//    That those terms are what the broker STATES in its symbol record is
//    not known here: it is read in production by the refresh route.
//  - Agreement tolerance (one cent on the deal) is self-derived.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import { recordDepositCurrency } from './account-money.js'
import { upsertAccount } from './account-registry.js'
import {
  decodeCommissionTerms, modelledPerLotPerSideUsd, modelledSideUsd, storeCommissionTerms, readCommissionTerms,
  commissionTermsCheck, symbolsToRead, commissionTermsKey,
} from './commission-terms.js'
import actionsRouter from '../routes/actions.js'
import stateRouter from '../routes/state.js'

const NOW = Date.parse('2026-10-13T00:00:00Z')

function deal(db, { id, account, symbol, lots, entry, close = entry, commission, closedAt = '2026-10-12 10:00:00', position = `p-${id}` }) {
  db.prepare(`INSERT INTO broker_deals (deal_id, position_id, account_id, symbol, side, lots, entry_price, close_price, closed_at, commission)
    VALUES (?, ?, ?, ?, 'BUY', ?, ?, ?, ?, ?)`).run(id, position, account, symbol, lots, entry, close, closedAt, commission)
}
function usdDeposit(db, accountId, currency = 'USD') {
  assert.equal(recordDepositCurrency(db, { accountId, host: 'demo.ctraderapi.com', depositAssetId: '1', currency, receivedAt: NOW }), true)
}

test('decode: the proto scales — x10^8 for per-lot and per-million, x10^5 for percentage', () => {
  const perLot = decodeCommissionTerms({ symbolId: 5, commissionType: 2, preciseTradingCommissionRate: 350_000_000, lotSize: 10_000_000 })
  assert.equal(perLot.commissionTypeName, 'USD_PER_LOT')
  assert.equal(perLot.rate, 3.5)
  assert.equal(perLot.lotUnits, 100_000)
  const pct = decodeCommissionTerms({ symbolId: 6, commissionType: 'PERCENTAGE_OF_VALUE', preciseTradingCommissionRate: '2000' })
  assert.equal(pct.commissionType, 3)
  assert.equal(pct.rate, 0.02)                         // percent
  const min = decodeCommissionTerms({ commissionType: 2, preciseTradingCommissionRate: 2_000_000, preciseMinCommission: 3_000_000, minCommissionType: 'CURRENCY' })
  assert.equal(min.minCommission, 0.03)
  assert.equal(min.minCommissionType, 1)
  assert.equal(min.minCommissionAsset, 'USD')          // the proto's default
  assert.equal(decodeCommissionTerms({ commissionType: 'QUOTE_CCY_PER_LOT', preciseTradingCommissionRate: 100_000_000 }).commissionType, 4)
})

test('decode: never guesses — absent rate, unknown type, deprecated fields', () => {
  const absentType = decodeCommissionTerms({ preciseTradingCommissionRate: 3_500_000_000 })
  assert.equal(absentType.commissionType, 1, 'the proto default applies when the field is absent')
  assert.equal(absentType.commissionTypeStated, false)
  assert.equal(decodeCommissionTerms({ commissionType: 9, preciseTradingCommissionRate: 1 }).commissionType, null)
  assert.equal(decodeCommissionTerms({ commissionType: 'SOMETHING', preciseTradingCommissionRate: 1 }).rate, null)
  const deprecatedOnly = decodeCommissionTerms({ commissionType: 2, commission: 350 })
  assert.equal(deprecatedOnly.rate, null, 'the deprecated amount has no documented scale')
  assert.equal(deprecatedOnly.raw.commission, 350)
  assert.equal(decodeCommissionTerms({ commissionType: 2, preciseTradingCommissionRate: true }).rate, null)
  assert.equal(decodeCommissionTerms({ commissionType: 2, preciseTradingCommissionRate: '' }).rate, null)
  assert.equal(decodeCommissionTerms({ commissionType: 2, preciseTradingCommissionRate: -5 }).rate, null)
})

test('modelled: per lot is flat, per million follows the base currency, crosses are not guessed', () => {
  const perLot = { commissionType: 2, rate: 3.5 }
  assert.equal(modelledPerLotPerSideUsd(perLot, { symbol: 'AUDUSD', price: 0.69718 }).usd, 3.5)
  const perMillion = { commissionType: 1, rate: 35 }
  assert.equal(modelledPerLotPerSideUsd(perMillion, { symbol: 'USDJPY', price: 147, lotUnits: 100_000 }).usd, 3.5)
  assert.ok(Math.abs(modelledPerLotPerSideUsd(perMillion, { symbol: 'AUDUSD', price: 0.69718, lotUnits: 100_000 }).usd - 2.44013) < 1e-6)
  assert.equal(modelledPerLotPerSideUsd(perMillion, { symbol: 'EURGBP', price: 0.8558, lotUnits: 100_000 }).reason, 'base_currency_usd_price_unknown')
  assert.equal(modelledPerLotPerSideUsd(perMillion, { symbol: 'USDJPY', price: 147 }).reason, 'lot_units_unknown')
  assert.equal(modelledPerLotPerSideUsd({ commissionType: 4, rate: 3 }, { symbol: 'EURGBP', price: 0.85 }).reason, 'quote_currency_not_usd')
  assert.equal(modelledPerLotPerSideUsd({ commissionType: 3, rate: 0.02 }, { symbol: 'AUDUSD', price: 0.7, lotUnits: 100_000 }).usd, 14)
  assert.equal(modelledPerLotPerSideUsd({ commissionType: 2, rate: null }, { symbol: 'AUDUSD' }).reason, 'rate_not_stated')
  assert.equal(modelledPerLotPerSideUsd(null, { symbol: 'AUDUSD' }).reason, 'terms_unknown')
})

test('store: only this account, only named symbols, earlier symbols kept', () => {
  const db = initDB(':memory:')
  const names = { 101: 'AUDUSD', 102: 'GBPUSD' }
  assert.deepEqual(storeCommissionTerms(db, '47790949', { ctidTraderAccountId: 43097342, symbol: [{ symbolId: 101, commissionType: 2, preciseTradingCommissionRate: 350_000_000 }] }, names, { now: NOW }),
    { stored: 0, refused: 'response_names_another_account' })
  assert.equal(getState(db, commissionTermsKey('47790949')), null)
  const one = storeCommissionTerms(db, '47790949', { ctidTraderAccountId: 47790949, symbol: [{ symbolId: 101, commissionType: 2, preciseTradingCommissionRate: 350_000_000 }, { symbolId: 999 }] }, names, { now: NOW })
  assert.equal(one.stored, 1)
  assert.deepEqual(one.unnamed, [999])
  storeCommissionTerms(db, '47790949', { symbol: [{ symbolId: 102, commissionType: 2, preciseTradingCommissionRate: 350_000_000 }] }, names, { now: NOW })
  assert.deepEqual(Object.keys(readCommissionTerms(db, '47790949').symbols).sort(), ['AUDUSD', 'GBPUSD'])
  setState(db, commissionTermsKey('46130058'), JSON.stringify({ accountId: '47790949', symbols: { AUDUSD: {} } }))
  assert.equal(readCommissionTerms(db, '46130058'), null, 'a record stamped for another account is not read')
})

test('check: the broker deals of 47790949 agree with $3.50 a lot a side, and not with $35 per million', () => {
  const db = initDB(':memory:')
  usdDeposit(db, '47790949')
  deal(db, { id: '324398847', account: '47790949', symbol: 'AUDUSD', lots: 0.69, entry: 0.69718, close: 0.69566, commission: -4.84 })
  deal(db, { id: '323632842', account: '47790949', symbol: 'GBPUSD', lots: 0.08, entry: 1.32757, close: 1.32448, commission: -0.56 })
  const names = { 101: 'AUDUSD', 102: 'GBPUSD' }
  const rec = s => ({ symbolId: s, commissionType: 2, preciseTradingCommissionRate: 350_000_000, lotSize: 10_000_000 })
  storeCommissionTerms(db, '47790949', { symbol: [rec(101), rec(102)] }, names, { now: NOW })
  const ok = commissionTermsCheck(db, '47790949', { days: 30, now: NOW })
  assert.equal(ok.depositCurrency, 'USD')
  const aud = ok.symbols.find(s => s.symbol === 'AUDUSD')
  assert.equal(aud.brokerPerLotPerSide.max, 3.5072)    // 4.84 / 0.69 / 2
  assert.equal(aud.compared, true)
  assert.equal(aud.agrees, true)
  assert.equal(ok.symbols.find(s => s.symbol === 'GBPUSD').agrees, true)

  const perMillion = s => ({ symbolId: s, commissionType: 1, preciseTradingCommissionRate: 3_500_000_000, lotSize: 10_000_000 })
  storeCommissionTerms(db, '47790949', { symbol: [perMillion(101), perMillion(102)] }, names, { now: NOW })
  const off = commissionTermsCheck(db, '47790949', { days: 30, now: NOW })
  assert.equal(off.symbols.find(s => s.symbol === 'AUDUSD').agrees, false, 'per-million at 0.697 models 2.44, the broker charged 3.51')
})

test('check: a non-USD deposit shows both figures and does not compare; no terms says so', () => {
  const db = initDB(':memory:')
  usdDeposit(db, '43097342', 'SGD')
  deal(db, { id: '324214333', account: '43097342', symbol: 'USDSGD', lots: 0.02, entry: 1.28014, close: 1.27839, commission: -0.18 })
  storeCommissionTerms(db, '43097342', { symbol: [{ symbolId: 7, commissionType: 2, preciseTradingCommissionRate: 350_000_000 }] }, { 7: 'USDSGD' }, { now: NOW })
  const r = commissionTermsCheck(db, '43097342', { days: 30, now: NOW })
  const s = r.symbols[0]
  assert.equal(s.compared, false)
  assert.equal(s.agrees, null)
  // Claude · № 14,270 13-Oct (NASA-4 "A"): without the deal's own rates the
  // reason names what is missing, not only the currency.
  assert.equal(s.reason, 'deposit_rate_not_reported')
  assert.equal(s.brokerPerLotPerSide.currency, 'SGD')
  assert.equal(s.brokerPerLotPerSide.max, 4.5)

  const db2 = initDB(':memory:')
  usdDeposit(db2, '46130058')
  deal(db2, { id: '321439415', account: '46130058', symbol: 'SGDJPY', lots: 0.12, entry: 124.004, close: 123.122, commission: 0 })
  const none = commissionTermsCheck(db2, '46130058', { days: 30, now: NOW })
  assert.equal(none.symbols[0].reason, 'terms_not_recorded')
  assert.equal(none.symbols[0].brokerPerLotPerSide.max, 0, 'this account was charged nothing on FX')
  assert.equal(none.symbols[0].compared, false)
})

test('check: deals outside the window and other accounts are not counted', () => {
  const db = initDB(':memory:')
  usdDeposit(db, '47790949')
  deal(db, { id: 'a', account: '47790949', symbol: 'AUDUSD', lots: 1, entry: 0.7, commission: -7 })
  deal(db, { id: 'b', account: '47790949', symbol: 'AUDUSD', lots: 1, entry: 0.7, commission: -70, closedAt: '2026-08-01 00:00:00' })
  deal(db, { id: 'c', account: '46130058', symbol: 'AUDUSD', lots: 1, entry: 0.7, commission: -70 })
  const r = commissionTermsCheck(db, '47790949', { days: 30, now: NOW })
  assert.equal(r.symbols[0].deals, 1)
  assert.equal(r.symbols[0].brokerPerLotPerSide.max, 3.5)
})

test('symbolsToRead: own map only, not-listed and over-cap are named', () => {
  const db = initDB(':memory:')
  deal(db, { id: 'a', account: '47790949', symbol: 'AUDUSD', lots: 1, entry: 0.7, commission: -7 })
  deal(db, { id: 'b', account: '47790949', symbol: 'ZZZ', lots: 1, entry: 1, commission: 0 })
  const r = symbolsToRead(db, '47790949', { AUDUSD: 101, GBPUSD: 102 }, { days: 30, extra: [' gbpUsd '], now: NOW })
  assert.deepEqual(r.ids, [101, 102])
  assert.deepEqual(r.notListed, ['ZZZ'])
  const big = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`S${String(i).padStart(2, '0')}`, i + 1]))
  const capped = symbolsToRead(db, '1', big, { extra: Object.keys(big), now: NOW })
  assert.equal(capped.ids.length, 60)
  assert.equal(capped.overCap.length, 10)
})

// Claude · № 13,807 13-Oct (Codex P2s on #1344, ordered after № 13,799; claude-builder).
test('check: the broker minimum per side (46979908 LLY.US and DOW.US deals, USD deposit)', () => {
  const db = initDB(':memory:')
  usdDeposit(db, '46979908')
  // Broker deals, 46979908: LLY.US 0.1 lots charged 0.04 (where $0.02 a
  // share gives 0.004: the minimum applied on both sides); DOW.US 1.2 lots
  // charged 0.04 (0.024 a side, rounded to the cent).
  deal(db, { id: '322439606', account: '46979908', symbol: 'LLY.US', lots: 0.1, entry: 1150.77, close: 1153.04, commission: -0.04 })
  deal(db, { id: '323718041', account: '46979908', symbol: 'DOW.US', lots: 1.2, entry: 28.4, close: 28.4, commission: -0.04 })
  const rec = (s, min) => ({ symbolId: s, commissionType: 2, preciseTradingCommissionRate: 2_000_000, preciseMinCommission: min, minCommissionAsset: 'USD', lotSize: 100 })
  const names = { 31: 'LLY.US', 32: 'DOW.US' }
  storeCommissionTerms(db, '46979908', { symbol: [rec(31, 2_000_000), rec(32, 2_000_000)] }, names, { now: NOW })
  const r = commissionTermsCheck(db, '46979908', { days: 30, now: NOW })
  const lly = r.symbols.find(s => s.symbol === 'LLY.US')
  assert.equal(lly.sample[0].modelledDealUsd, 0.04, 'the $0.02 minimum on each side')
  assert.equal(lly.agrees, true)
  assert.equal(r.symbols.find(s => s.symbol === 'DOW.US').agrees, true)
  // A minimum stated in another currency declines the model, never converts.
  storeCommissionTerms(db, '46979908', { symbol: [{ ...rec(31, 2_000_000), minCommissionAsset: 'EUR' }] }, names, { now: NOW })
  const eur = commissionTermsCheck(db, '46979908', { days: 30, now: NOW }).symbols.find(s => s.symbol === 'LLY.US')
  assert.equal(eur.compared, false)
  assert.equal(eur.reason, 'min_commission_not_usd')
})

test('check: a binding minimum on a position closed in parts is not compared', () => {
  // Self-derived arrangement of a per-trade minimum (help.ctrader.com
  // ProtoOASymbol: minimum commission is per trade) against broker_deals'
  // one-row-per-closing-deal shape.
  const db = initDB(':memory:')
  usdDeposit(db, '46979908')
  const rec = { symbolId: 31, commissionType: 2, preciseTradingCommissionRate: 2_000_000, preciseMinCommission: 2_000_000, minCommissionAsset: 'USD', lotSize: 100 }
  storeCommissionTerms(db, '46979908', { symbol: [rec, { ...rec, symbolId: 32 }] }, { 31: 'LLY.US', 32: 'JPM.US' }, { now: NOW })
  // One position, two closing rows: the minimum binds on each.
  deal(db, { id: 'a1', position: 'P1', account: '46979908', symbol: 'LLY.US', lots: 0.05, entry: 1150, close: 1152, commission: -0.03 })
  deal(db, { id: 'a2', position: 'P1', account: '46979908', symbol: 'LLY.US', lots: 0.05, entry: 1150, close: 1154, commission: -0.03 })
  // One position closed in parts where the minimum does not bind (100 lots at 0.02).
  deal(db, { id: 'b1', position: 'P2', account: '46979908', symbol: 'JPM.US', lots: 100, entry: 300, close: 301, commission: -4 })
  deal(db, { id: 'b2', position: 'P2', account: '46979908', symbol: 'JPM.US', lots: 100, entry: 300, close: 302, commission: -4 })
  const r = commissionTermsCheck(db, '46979908', { days: 30, now: NOW })
  const lly = r.symbols.find(s => s.symbol === 'LLY.US')
  assert.equal(lly.compared, false)
  assert.equal(lly.reason, 'min_commission_split_position')
  const jpm = r.symbols.find(s => s.symbol === 'JPM.US')
  assert.equal(jpm.compared, true, 'a minimum that does not bind changes nothing')
  assert.equal(jpm.agrees, true)
  // No position id: a binding minimum cannot be proven to be one trade.
  const db2 = initDB(':memory:')
  usdDeposit(db2, '46979908')
  storeCommissionTerms(db2, '46979908', { symbol: [rec] }, { 31: 'LLY.US' }, { now: NOW })
  deal(db2, { id: 'c1', position: null, account: '46979908', symbol: 'LLY.US', lots: 0.1, entry: 1150, close: 1153, commission: -0.04 })
  assert.equal(commissionTermsCheck(db2, '46979908', { days: 30, now: NOW }).symbols[0].reason, 'min_commission_position_unknown')
})

test('check: a QUOTE_CURRENCY minimum is in the quote currency, used only when that is USD', () => {
  // Proto (ProtoOAMinCommissionType): QUOTE_CURRENCY = 2. The asset field
  // defaults to "USD" when omitted, so it cannot name the currency here.
  const base = { commissionType: 2, rate: 3.5, minCommission: 5 }
  assert.equal(modelledSideUsd({ ...base, minCommissionType: 2, minCommissionAsset: 'USD' }, { symbol: 'GBPJPY', price: 190, lots: 0.01 }).reason, 'min_commission_quote_currency_not_usd')
  assert.equal(modelledSideUsd({ ...base, minCommissionType: 2, minCommissionAsset: 'USD' }, { symbol: 'LLY.US', price: 1150, lots: 0.01 }).reason, 'min_commission_quote_currency_not_usd', 'a quote currency not read from the name is not assumed')
  assert.equal(modelledSideUsd({ ...base, minCommissionType: 2, minCommissionAsset: 'USD' }, { symbol: 'AUDUSD', price: 0.7, lots: 0.01 }).usd, 5)
  assert.equal(modelledSideUsd({ ...base, minCommissionType: 1, minCommissionAsset: 'USD' }, { symbol: 'GBPJPY', price: 190, lots: 0.01 }).usd, 5)
  assert.equal(modelledSideUsd({ ...base, minCommissionType: null, minCommissionAsset: 'USD' }, { symbol: 'AUDUSD', price: 0.7, lots: 0.01 }).reason, 'min_commission_type_unknown')
  assert.equal(modelledSideUsd({ ...base, minCommission: 0, minCommissionType: 2 }, { symbol: 'GBPJPY', price: 190, lots: 1 }).usd, 3.5, 'no minimum: nothing to read')
})

test('check: each side is priced at its own price — opening at entry, closing at close', () => {
  // Self-derived: a per-million rate on a pair that moved 0.70 -> 0.80. The
  // broker's own FX terms on these accounts are not known to be per-million
  // (the live refresh reads them); this pins the arithmetic Codex named.
  const db = initDB(':memory:')
  usdDeposit(db, '47790949')
  deal(db, { id: 'x1', account: '47790949', symbol: 'AUDUSD', lots: 1, entry: 0.70, close: 0.80, commission: -7.5 })
  storeCommissionTerms(db, '47790949', { symbol: [{ symbolId: 101, commissionType: 1, preciseTradingCommissionRate: 5_000_000_000, lotSize: 10_000_000 }] }, { 101: 'AUDUSD' }, { now: NOW })
  const s = commissionTermsCheck(db, '47790949', { days: 30, now: NOW }).symbols[0]
  assert.equal(s.sample[0].modelledDealUsd, 7.5)   // 3.50 at 0.70 + 4.00 at 0.80
  assert.equal(s.agrees, true)
})

async function serve(t, deps) {
  const saved = { id: process.env.CTRADER_CLIENT_ID, secret: process.env.CTRADER_CLIENT_SECRET }
  process.env.CTRADER_CLIENT_ID = 'c'; process.env.CTRADER_CLIENT_SECRET = 's'
  const db = initDB(':memory:')
  const token = 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  setState(db, 'device_sessions', JSON.stringify({ [token]: Date.now() + 60_000 }))
  // The selected account is another one: the route must act for the one named.
  setState(db, 'ctrader_account_id', '46130058')
  setState(db, 'ctrader_access_token', 'test-access')
  const app = express(); app.use(express.json())
  app.use('/actions', actionsRouter(db, deps)); app.use('/state', stateRouter(db))
  const server = app.listen(0)
  t.after(() => {
    server.close(); db.close()
    if (saved.id === undefined) delete process.env.CTRADER_CLIENT_ID; else process.env.CTRADER_CLIENT_ID = saved.id
    if (saved.secret === undefined) delete process.env.CTRADER_CLIENT_SECRET; else process.env.CTRADER_CLIENT_SECRET = saved.secret
  })
  const request = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: r.status, data: await r.json() }
  }
  return { db, request }
}

test('route: refresh reads this account through its own map and records; the check reads it back', async t => {
  const calls = []
  let answerAs = 47790949
  const { db, request } = await serve(t, {
    commissionTermsTransport: {
      wsSymbolsByIds: async (host, id, secret, token, accountId, ids) => {
        calls.push({ accountId: String(accountId), ids })
        return { ctidTraderAccountId: answerAs, symbol: ids.map(s => ({ symbolId: s, commissionType: 2, preciseTradingCommissionRate: 350_000_000, lotSize: 10_000_000 })) }
      },
    },
  })
  upsertAccount(db, { accountId: '47790949', isLive: false })
  upsertAccount(db, { accountId: '46130058', isLive: false })
  usdDeposit(db, '47790949')
  deal(db, { id: '324398847', account: '47790949', symbol: 'AUDUSD', lots: 0.69, entry: 0.69718, commission: -4.84, closedAt: new Date(Date.now() - 86_400_000).toISOString().replace('T', ' ').slice(0, 19) })

  assert.equal((await request('/actions/commission-terms/refresh', {})).status, 400)
  assert.equal((await request('/actions/commission-terms/refresh', { accountId: '99' })).status, 404)
  assert.equal((await request('/actions/commission-terms/refresh', { accountId: '47790949' })).status, 409, 'no own symbol map: nothing is read')
  // The shared map names a different id: it must not be used.
  setState(db, 'symbol_id_map', JSON.stringify({ AUDUSD: 555 }))
  // A map past its 24-hour freshness is refused: nothing read, nothing written.
  setState(db, 'symbol_id_map:47790949', JSON.stringify({ accountId: '47790949', builtAt: new Date(Date.now() - 25 * 3_600_000).toISOString(), map: { AUDUSD: 101, GBPUSD: 102 } }))
  const stale = await request('/actions/commission-terms/refresh', { accountId: '47790949' })
  assert.equal(stale.status, 409)
  assert.equal(stale.data.error, 'account_symbol_map_stale')
  assert.equal(calls.length, 0)
  setState(db, 'symbol_id_map:47790949', JSON.stringify({ accountId: '47790949', builtAt: new Date().toISOString(), map: { AUDUSD: 101, GBPUSD: 102 } }))

  const ok = await request('/actions/commission-terms/refresh', { accountId: '47790949' })
  assert.equal(ok.status, 200)
  assert.equal(ok.data.stored, 1)
  assert.deepEqual(calls, [{ accountId: '47790949', ids: [101] }])

  const check = await request('/state/commission-terms?account=47790949')
  assert.equal(check.status, 200)
  assert.equal(check.data.symbols[0].agrees, true)
  assert.equal((await request('/state/commission-terms')).status, 400)

  answerAs = 46130058
  const foreign = await request('/actions/commission-terms/refresh', { accountId: '47790949', symbols: ['GBPUSD'] })
  assert.equal(foreign.status, 502)
  assert.equal(foreign.data.error, 'response_names_another_account')
  assert.deepEqual(Object.keys(readCommissionTerms(db, '47790949').symbols), ['AUDUSD'])
})

// Claude · № 14,270 13-Oct (owner: NASA-4 "A", capture the broker's per-deal
// conversion rate; claude-builder). Grounding: deal 324214333 on 43097342 (SGD
// deposit), USDSGD 0.02 lots, entry 1.28014, close 1.27839, charged SGD 0.18
// (broker_deals, 12-10). Terms $3.50 a lot a side (measured on 47790949). For
// USDSGD the base is USD, so the broker's marginRate (Base/Deposit) is the
// USD/SGD rate at each deal, and baseToUsdConversionRate is 1. The rates on
// this deal are set to its own prices: that the broker reports exactly these
// is NOT known here (self-derived); the live read after deploy says.
function rates(db, id, r) {
  db.prepare(`UPDATE broker_deals SET open_margin_rate=?, open_base_usd_rate=?, close_margin_rate=?, close_base_usd_rate=? WHERE deal_id=?`)
    .run(r.openMargin ?? null, r.openBaseUsd ?? null, r.closeMargin ?? null, r.closeBaseUsd ?? null, id)
}

test('NASA-4: an SGD deposit is compared through each side\'s own broker rate (43097342 USDSGD 324214333)', () => {
  const db = initDB(':memory:')
  usdDeposit(db, '43097342', 'SGD')
  deal(db, { id: '324214333', account: '43097342', symbol: 'USDSGD', lots: 0.02, entry: 1.28014, close: 1.27839, commission: -0.18 })
  rates(db, '324214333', { openMargin: 1.28014, openBaseUsd: 1, closeMargin: 1.27839, closeBaseUsd: 1 })
  storeCommissionTerms(db, '43097342', { symbol: [{ symbolId: 7, commissionType: 2, preciseTradingCommissionRate: 350_000_000 }] }, { 7: 'USDSGD' }, { now: NOW })
  const s = commissionTermsCheck(db, '43097342', { days: 30, now: NOW }).symbols[0]
  assert.equal(s.compared, true, JSON.stringify(s))
  assert.equal(s.agrees, true)
  assert.equal(s.reason, null)
  const d = s.sample[0]
  assert.equal(d.modelledDealUsd, 0.14)
  assert.equal(d.modelledDealDeposit, 0.1791, '0.07 × 1.28014 + 0.07 × 1.27839')
  assert.deepEqual(d.depositPerUsd, { open: 1.2801, close: 1.2784, source: 'broker_deal_rate' })
  // Charged as if in USD (0.14) would disagree: the conversion is measured.
  db.prepare("UPDATE broker_deals SET commission=-0.14 WHERE deal_id='324214333'").run()
  assert.equal(commissionTermsCheck(db, '43097342', { days: 30, now: NOW }).symbols[0].agrees, false)
})

test('NASA-4: one side without a broker rate is not compared and says so', () => {
  const db = initDB(':memory:')
  usdDeposit(db, '42993489', 'SGD')
  deal(db, { id: '1', account: '42993489', symbol: 'USDSGD', lots: 0.02, entry: 1.28, close: 1.28, commission: -0.18 })
  rates(db, '1', { closeMargin: 1.28, closeBaseUsd: 1 })
  storeCommissionTerms(db, '42993489', { symbol: [{ symbolId: 7, commissionType: 2, preciseTradingCommissionRate: 350_000_000 }] }, { 7: 'USDSGD' }, { now: NOW })
  const s = commissionTermsCheck(db, '42993489', { days: 30, now: NOW }).symbols[0]
  assert.equal(s.compared, false); assert.equal(s.agrees, null); assert.equal(s.reason, 'deposit_rate_not_reported')
})

test('NASA-4: a cross is priced from the deal\'s own Base/USD rate; a USD deposit reads ratio 1', () => {
  const db = initDB(':memory:')
  usdDeposit(db, '46979908')
  // EURGBP, $35 per million: 0.1 lots = 10,000 EUR = 11,700 USD at 1.17 → $0.4095 a side.
  deal(db, { id: '9', account: '46979908', symbol: 'EURGBP', lots: 0.1, entry: 0.8558, close: 0.8560, commission: -0.82 })
  rates(db, '9', { openMargin: 1.17, openBaseUsd: 1.17, closeMargin: 1.17, closeBaseUsd: 1.17 })
  storeCommissionTerms(db, '46979908', { symbol: [{ symbolId: 8, commissionType: 1, preciseTradingCommissionRate: 3_500_000_000, lotSize: 10_000_000 }] }, { 8: 'EURGBP' }, { now: NOW })
  const s = commissionTermsCheck(db, '46979908', { days: 30, now: NOW }).symbols[0]
  assert.equal(s.compared, true, JSON.stringify(s)); assert.equal(s.agrees, true)
  assert.equal(s.sample[0].modelledDealUsd, 0.819)
  assert.deepEqual(s.usdDepositRatio, { n: 2, maxAbsDiffFrom1: 0 })
  // Without the deal's rate the cross is still not guessed.
  rates(db, '9', {})
  assert.equal(commissionTermsCheck(db, '46979908', { days: 30, now: NOW }).symbols[0].reason, 'base_currency_usd_price_unknown')
})
