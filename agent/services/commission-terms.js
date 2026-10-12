// ---------------------------------------------------------------------------
// agent/services/commission-terms.js — each account's commission terms, as
// the broker states them, and a check of those terms against the account's
// own deals.
//
// Claude · № 13,794 13-Oct (task #44 step 1, owner "Each account's broker
// rate"; claude-builder). The breakeven rule's commission comes from the
// repo's tick-shadow-sim.json schedule (FX 0.35 bps of notional). The broker
// charged a flat $3.50 per lot per side on 52 of 52 FX deals on 47790949,
// while 46130058's FX deals carry no commission at all. So the cost is
// per account, and the schedule cannot know it.
//
// This step only READS and RECORDS. The broker's own symbol record
// (ProtoOASymbol, spotware/openapi-proto-messages OpenApiModelMessages.proto)
// carries:
//   commissionType               1 USD_PER_MILLION_USD, 2 USD_PER_LOT,
//                                3 PERCENTAGE_OF_VALUE, 4 QUOTE_CCY_PER_LOT
//   preciseTradingCommissionRate x 10^8 for non-percentage types, x 10^5
//                                for PERCENTAGE_OF_VALUE
//   preciseMinCommission         x 10^8, in minCommissionAsset
//   minCommissionType            1 CURRENCY, 2 QUOTE_CURRENCY
//   commission, minCommission    deprecated; kept raw, never used
// Nothing here is read by the risk gate. Using a verified rate in the
// breakeven rule is a later, separate change.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { verifiedDepositCurrency } from './data-feed-report.js'

export const COMMISSION_TYPES = Object.freeze({ 1: 'USD_PER_MILLION_USD', 2: 'USD_PER_LOT', 3: 'PERCENTAGE_OF_VALUE', 4: 'QUOTE_CCY_PER_LOT' })
const TYPE_BY_NAME = Object.freeze({ USD_PER_MILLION_USD: 1, USD_PER_LOT: 2, PERCENTAGE_OF_VALUE: 3, QUOTE_CCY_PER_LOT: 4 })
const MIN_TYPE_BY_NAME = Object.freeze({ CURRENCY: 1, QUOTE_CURRENCY: 2 })
// The proto's defaults: an absent field means this value, per the proto.
const DEFAULT_COMMISSION_TYPE = 1
const DEFAULT_MIN_COMMISSION_TYPE = 1
const DEFAULT_MIN_COMMISSION_ASSET = 'USD'
// Measured, not assumed: on 47790949 consecutive balance versions moved by
// the closing deal's net P&L and did not move at the open, so a closing
// deal's commission is both sides.
export const CLOSING_DEAL_SIDES = 2
const MAX_SYMBOLS = 60

export const commissionTermsKey = accountId => `commission_terms:${String(accountId)}`

// Protobuf int64 can arrive as a JSON decimal string; blank, boolean and
// negative values are not amounts.
function int64(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return null
}
function enumOf(v, byName, fallback) {
  if (v == null) return { value: fallback, stated: false }
  if (typeof v === 'number' && Number.isInteger(v)) return { value: v, stated: true }
  if (typeof v === 'string' && Object.hasOwn(byName, v)) return { value: byName[v], stated: true }
  return { value: null, stated: true }
}

/**
 * One ProtoOASymbol record → its commission terms. Never guesses: a missing
 * precise rate is `rate: null`, and a type outside the proto's enum is
 * `commissionType: null`.
 */
export function decodeCommissionTerms(record) {
  const t = enumOf(record?.commissionType, TYPE_BY_NAME, DEFAULT_COMMISSION_TYPE)
  const commissionType = t.value != null && COMMISSION_TYPES[t.value] ? t.value : null
  const precise = int64(record?.preciseTradingCommissionRate)
  const rate = precise == null || commissionType == null ? null
    : commissionType === 3 ? precise / 1e5 : precise / 1e8
  const m = enumOf(record?.minCommissionType, MIN_TYPE_BY_NAME, DEFAULT_MIN_COMMISSION_TYPE)
  const preciseMin = int64(record?.preciseMinCommission)
  return {
    symbolId: record?.symbolId != null ? Number(record.symbolId) : null,
    commissionType,
    commissionTypeName: commissionType != null ? COMMISSION_TYPES[commissionType] : null,
    commissionTypeStated: t.stated,
    rate,                                   // USD, quote ccy, or percent, by type
    minCommission: preciseMin != null ? preciseMin / 1e8 : null,
    minCommissionType: m.value === 1 || m.value === 2 ? m.value : null,
    minCommissionAsset: typeof record?.minCommissionAsset === 'string' && record.minCommissionAsset ? record.minCommissionAsset : DEFAULT_MIN_COMMISSION_ASSET,
    // Units per lot from the same broker answer (lotSize is in cents of
    // units): a per-million rate needs the lot's notional.
    lotUnits: int64(record?.lotSize) > 0 ? int64(record.lotSize) / 100 : null,
    raw: {
      commissionType: record?.commissionType ?? null,
      preciseTradingCommissionRate: record?.preciseTradingCommissionRate ?? null,
      preciseMinCommission: record?.preciseMinCommission ?? null,
      minCommissionType: record?.minCommissionType ?? null,
      minCommissionAsset: record?.minCommissionAsset ?? null,
      commission: record?.commission ?? null,           // deprecated
      minCommission: record?.minCommission ?? null,     // deprecated
    },
  }
}

/** The stored terms of one account, or null. A record stamped for another account is not this account's. */
export function readCommissionTerms(db, accountId) {
  if (accountId == null || String(accountId).trim() === '') return null
  try {
    const rec = JSON.parse(getState(db, commissionTermsKey(accountId)) || 'null')
    if (!rec || String(rec.accountId) !== String(accountId) || typeof rec.symbols !== 'object' || rec.symbols == null) return null
    return rec
  } catch { return null }
}

/**
 * Record the broker's answer for `accountId`. The response must name this
 * account (or name none); one naming another account writes nothing.
 * Symbols already on record and not in this answer are kept.
 *
 * @param {{ctidTraderAccountId?: number|string, symbol?: object[]}} response  SYMBOL_BY_ID_RES
 * @param {{[symbolId: string]: string}} namesById  this account's own id → name
 */
export function storeCommissionTerms(db, accountId, response, namesById, { now = Date.now() } = {}) {
  const id = String(accountId)
  if (response?.ctidTraderAccountId != null && String(response.ctidTraderAccountId) !== id) {
    return { stored: 0, refused: 'response_names_another_account' }
  }
  const prev = readCommissionTerms(db, id)
  const symbols = { ...(prev?.symbols || {}) }
  const at = new Date(now).toISOString()
  let stored = 0
  const unnamed = []
  for (const rec of response?.symbol || []) {
    const name = namesById?.[String(rec?.symbolId)]
    if (!name) { unnamed.push(rec?.symbolId ?? null); continue }
    symbols[name] = { ...decodeCommissionTerms(rec), at }
    stored++
  }
  if (stored) setState(db, commissionTermsKey(id), JSON.stringify({ accountId: id, at, symbols }))
  return { stored, unnamed, refused: null }
}

/** FX and metal pairs written as six letters: base, then quote. */
function pairOf(symbol) {
  const m = /^([A-Z]{3})([A-Z]{3})$/.exec(String(symbol || ''))
  return m ? { base: m[1], quote: m[2] } : null
}

/**
 * The modelled commission for ONE lot, ONE side, in USD, at `price`, from
 * the broker's terms. Null with a reason when a conversion the terms need is
 * not known here: never a guessed rate.
 */
export function modelledPerLotPerSideUsd(terms, { symbol, price, lotUnits }) {
  if (!terms || terms.commissionType == null) return { usd: null, reason: 'terms_unknown' }
  if (terms.rate == null) return { usd: null, reason: 'rate_not_stated' }
  const pair = pairOf(symbol)
  const p = Number(price)
  const units = Number(lotUnits)
  let usd = null
  switch (terms.commissionType) {
    case 2: usd = terms.rate; break
    case 1: {
      if (!(units > 0)) return { usd: null, reason: 'lot_units_unknown' }
      // Notional in USD needs the base currency's USD price.
      const baseUsd = pair?.base === 'USD' ? 1 : pair?.quote === 'USD' && p > 0 ? p : null
      if (baseUsd == null) return { usd: null, reason: 'base_currency_usd_price_unknown' }
      usd = terms.rate * units * baseUsd / 1e6
      break
    }
    case 4:
      if (pair?.quote !== 'USD') return { usd: null, reason: 'quote_currency_not_usd' }
      usd = terms.rate
      break
    case 3:
      if (!(units > 0) || !(p > 0)) return { usd: null, reason: 'lot_units_or_price_unknown' }
      if (pair?.quote !== 'USD') return { usd: null, reason: 'quote_currency_not_usd' }
      usd = terms.rate / 100 * units * p
      break
    default: return { usd: null, reason: 'terms_unknown' }
  }
  return { usd, reason: null }
}

/**
 * Compare the stored terms with this account's own closing deals. Read only.
 * Per symbol: the broker's charge per lot per side (|commission| / lots / 2,
 * in the deposit currency), and the terms' modelled charge at the deal's
 * entry price. They are compared only when the deposit currency is
 * broker-verified USD; otherwise both are shown and `compared` is false.
 */
export function commissionTermsCheck(db, accountId, { days = 30, now = Date.now() } = {}) {
  const id = String(accountId)
  const terms = readCommissionTerms(db, id)
  const deposit = verifiedDepositCurrency(db, id)
  const since = new Date(now - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19)
  const deals = db.prepare(`SELECT deal_id, symbol, lots, entry_price, commission, closed_at FROM broker_deals
    WHERE account_id = ? AND closed_at >= ? AND lots > 0 AND commission IS NOT NULL ORDER BY closed_at`).all(id, since)
  const bySymbol = new Map()
  for (const d of deals) {
    if (!bySymbol.has(d.symbol)) bySymbol.set(d.symbol, [])
    bySymbol.get(d.symbol).push(d)
  }
  const symbols = []
  for (const [symbol, rows] of [...bySymbol.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const t = terms?.symbols?.[symbol] ?? null
    const lotUnits = t?.lotUnits ?? null
    const perDeal = rows.map(d => {
      const broker = Math.abs(Number(d.commission)) / Number(d.lots) / CLOSING_DEAL_SIDES
      const modelled = modelledPerLotPerSideUsd(t, { symbol, price: d.entry_price, lotUnits })
      return { dealId: d.deal_id, lots: d.lots, brokerPerLotPerSide: round(broker), modelledUsd: modelled.usd == null ? null : round(modelled.usd), reason: modelled.reason }
    })
    const brokerVals = perDeal.map(x => x.brokerPerLotPerSide)
    const modelVals = perDeal.map(x => x.modelledUsd).filter(v => v != null)
    const compared = deposit === 'USD' && modelVals.length === perDeal.length && perDeal.length > 0
    symbols.push({
      symbol,
      deals: rows.length,
      terms: t ? { commissionTypeName: t.commissionTypeName, rate: t.rate, minCommission: t.minCommission, minCommissionAsset: t.minCommissionAsset, at: t.at } : null,
      lotUnits,
      brokerPerLotPerSide: { min: round(Math.min(...brokerVals)), max: round(Math.max(...brokerVals)), currency: deposit },
      modelledPerLotPerSideUsd: modelVals.length ? { min: round(Math.min(...modelVals)), max: round(Math.max(...modelVals)) } : null,
      compared,
      // Broker charges round to the cent: a deal of 0.01 lots charged 0.08
      // reads 4.00 a lot a side against a true 3.50. Agreement is judged
      // within the cent on the deal's own size.
      agrees: compared ? perDeal.every(x => Math.abs(x.brokerPerLotPerSide - x.modelledUsd) * x.lots * CLOSING_DEAL_SIDES <= 0.01 + 1e-9) : null,
      reason: t == null ? 'terms_not_recorded' : deposit !== 'USD' ? `deposit_currency_${deposit ?? 'unverified'}` : modelVals.length !== perDeal.length ? perDeal.find(x => x.reason)?.reason ?? null : null,
      sample: perDeal.slice(-5),
    })
  }
  return {
    accountId: id,
    days,
    depositCurrency: deposit,
    termsRecordedAt: terms?.at ?? null,
    termsSymbols: terms ? Object.keys(terms.symbols).length : 0,
    closingDealSides: CLOSING_DEAL_SIDES,
    symbols,
    note: 'Read only. The risk gate does not read these terms yet.',
  }
}

function round(v) { return Number.isFinite(v) ? Math.round(v * 10_000) / 10_000 : null }

/**
 * The symbols to read for one account: its closing deals in the window,
 * plus any asked for, resolved through this account's own symbol map.
 */
export function symbolsToRead(db, accountId, ownMap, { days = 30, extra = [], now = Date.now() } = {}) {
  const since = new Date(now - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19)
  const fromDeals = db.prepare('SELECT DISTINCT symbol FROM broker_deals WHERE account_id = ? AND closed_at >= ? AND symbol IS NOT NULL').all(String(accountId), since).map(r => r.symbol)
  const wanted = [...new Set([...fromDeals, ...extra.map(s => String(s).trim()).filter(Boolean)])].sort()
  const ids = [], namesById = {}, notListed = [], overCap = []
  for (const name of wanted) {
    const sid = ownMap?.[name]
    if (sid == null) { notListed.push(name); continue }
    if (ids.length >= MAX_SYMBOLS) { overCap.push(name); continue }
    ids.push(Number(sid)); namesById[String(sid)] = name
  }
  return { ids, namesById, notListed, overCap }
}
