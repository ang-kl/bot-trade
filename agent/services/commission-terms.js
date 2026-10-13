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
export function modelledPerLotPerSideUsd(terms, { symbol, price, lotUnits, baseUsdRate = null }) {
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
      // Notional in USD needs the base currency's USD price. Claude · № 14,270
      // 13-Oct (owner: NASA-4 "A"; claude-builder): where the pair does not
      // give it, the deal's own baseToUsdConversionRate (broker-stated at the
      // deal) does; never a guessed rate.
      const baseUsd = pair?.base === 'USD' ? 1 : pair?.quote === 'USD' && p > 0 ? p : rate(baseUsdRate)
      if (baseUsd == null) return { usd: null, reason: 'base_currency_usd_price_unknown' }
      usd = terms.rate * units * baseUsd / 1e6
      break
    }
    case 4:
      if (pair?.quote !== 'USD') return { usd: null, reason: 'quote_currency_not_usd' }
      usd = terms.rate
      break
    case 3:
      if (pair?.quote !== 'USD' && rate(baseUsdRate) != null && units > 0) {
        // Value in USD = units × the deal's own Base/USD rate (№ 14,270).
        usd = terms.rate / 100 * units * rate(baseUsdRate)
        break
      }
      if (!(units > 0) || !(p > 0)) return { usd: null, reason: 'lot_units_or_price_unknown' }
      if (pair?.quote !== 'USD') return { usd: null, reason: 'quote_currency_not_usd' }
      usd = terms.rate / 100 * units * p
      break
    default: return { usd: null, reason: 'terms_unknown' }
  }
  return { usd, reason: null }
}

/**
 * The modelled commission for ONE side of a deal of `lots`, in USD: the
 * per-lot charge at that side's price times the lots, raised to the broker's
 * per-trade minimum. Claude · № 13,807 13-Oct (Codex P2 on #1344, ordered
 * after № 13,799; owner "Apply it per side"; claude-builder): the minimum is
 * applied only when it is stated in USD; one stated in another currency
 * declines the model rather than convert at a guessed rate. Measured on
 * 46979908 (USD deposit): LLY.US 0.1 lots was charged 0.04 where $0.02 a
 * share gives 0.004 — a ~$0.02 per-side minimum applied.
 */
export function modelledSideUsd(terms, { symbol, price, lotUnits, lots, baseUsdRate = null }) {
  const perLot = modelledPerLotPerSideUsd(terms, { symbol, price, lotUnits, baseUsdRate })
  if (perLot.usd == null) return perLot
  const n = Number(lots)
  if (!(n > 0)) return { usd: null, reason: 'lots_unknown' }
  let usd = perLot.usd * n
  if (terms.minCommission != null && terms.minCommission > 0) {
    // Claude · № 13,810 13-Oct (Codex P2 on #1344, owner "Decline unless
    // quote is USD"; claude-builder): the proto's minCommissionType says
    // which currency the minimum is in. QUOTE_CURRENCY is the pair's quote
    // currency, whatever the asset field says (an omitted asset defaults to
    // "USD"), so a GBPJPY minimum is in JPY. Used only when that is USD.
    if (terms.minCommissionType === 2) {
      if (pairOf(symbol)?.quote !== 'USD') return { usd: null, reason: 'min_commission_quote_currency_not_usd' }
    } else if (terms.minCommissionType === 1) {
      if (terms.minCommissionAsset !== 'USD') return { usd: null, reason: 'min_commission_not_usd' }
    } else {
      return { usd: null, reason: 'min_commission_type_unknown' }
    }
    if (terms.minCommission > usd) return { usd: terms.minCommission, reason: null, minBinding: true }
  }
  return { usd, reason: null, minBinding: false }
}

/**
 * Compare the stored terms with this account's own closing deals. Read only.
 * Per deal, in money: the broker's charge (|commission| of the closing deal,
 * which covers both sides) against the terms' opening side at the entry
 * price plus closing side at the close price (Claude · № 13,807, Codex P2 on
 * #1344, owner "Price each side separately"). The per-lot-per-side figures
 * are shown too. They are compared only when the deposit currency is
 * broker-verified USD; otherwise both are shown and `compared` is false.
 */
export function commissionTermsCheck(db, accountId, { days = 30, now = Date.now() } = {}) {
  const id = String(accountId)
  const terms = readCommissionTerms(db, id)
  const deposit = verifiedDepositCurrency(db, id)
  const since = new Date(now - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19)
  const deals = db.prepare(`SELECT deal_id, position_id, symbol, lots, entry_price, close_price, commission, closed_at,
      open_margin_rate, open_base_usd_rate, close_margin_rate, close_base_usd_rate, quote_deposit_rate FROM broker_deals
    WHERE account_id = ? AND closed_at >= ? AND lots > 0 AND commission IS NOT NULL ORDER BY closed_at`).all(id, since)
  // Claude · № 13,829 13-Oct (Codex P2 on #1344, ordered after № 13,828;
  // owner "Decline when it binds"; claude-builder): the broker's minimum is
  // per trade, and broker_deals keeps one row per CLOSING deal. A position
  // closed in parts would have its opening minimum counted once per row, so
  // a binding minimum on such a position is not compared. An opening filled
  // in several deals is not visible in this table; that limit is stated.
  const closingRows = new Map()
  for (const r of db.prepare('SELECT position_id, COUNT(*) AS n FROM broker_deals WHERE account_id = ? AND position_id IS NOT NULL GROUP BY position_id').all(id)) {
    closingRows.set(String(r.position_id), r.n)
  }
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
      const brokerDeal = Math.abs(Number(d.commission))
      const open = modelledSideUsd(t, { symbol, price: d.entry_price, lotUnits, lots: d.lots, baseUsdRate: d.open_base_usd_rate })
      const close = modelledSideUsd(t, { symbol, price: d.close_price, lotUnits, lots: d.lots, baseUsdRate: d.close_base_usd_rate })
      const binding = open.minBinding || close.minBinding
      const rowsForPosition = d.position_id != null ? closingRows.get(String(d.position_id)) ?? 1 : null
      const splitReason = !binding ? null : rowsForPosition == null ? 'min_commission_position_unknown' : rowsForPosition > 1 ? 'min_commission_split_position' : null
      const modelledDeal = !splitReason && open.usd != null && close.usd != null ? open.usd + close.usd : null
      // Claude · № 14,270 13-Oct (owner: NASA-4 "A"; claude-builder). Each
      // side in the deposit currency at that side's own broker rate:
      // marginRate (Base/Deposit) ÷ baseToUsdConversionRate (Base/USD) =
      // deposit per USD at the deal. A USD deposit needs none (1).
      const openRate = depositPerUsd(deposit, d.open_margin_rate, d.open_base_usd_rate)
      const closeRate = depositPerUsd(deposit, d.close_margin_rate, d.close_base_usd_rate)
      const rateReason = deposit != null && deposit !== 'USD' && (openRate == null || closeRate == null) ? 'deposit_rate_not_reported' : null
      let modelledDeposit = modelledDeal == null || rateReason ? null : open.usd * openRate + close.usd * closeRate
      // Claude · № 14,347 13-Oct (Codex P2 follow-up from #1358; claude-builder).
      // QUOTE_CCY_PER_LOT on a non-USD quote: the charge is in the quote
      // currency, converted at each side's own broker rate — at the close the
      // broker's quoteToDepositConversionRate, at the open marginRate ÷ the
      // entry price (Base/Deposit ÷ Quote/Base = Deposit per Quote).
      const quote = t?.commissionType === 4 && open.reason === 'quote_currency_not_usd' && close.reason === 'quote_currency_not_usd'
        ? quoteCurrencyDeposit(t, d, { openUsd: openRate, closeUsd: closeRate, rowsForPosition }) : null
      if (quote) modelledDeposit = quote.deposit
      return {
        dealId: d.deal_id, lots: d.lots,
        brokerDeal: round(brokerDeal),
        brokerPerLotPerSide: round(brokerDeal / Number(d.lots) / CLOSING_DEAL_SIDES),
        modelledDealUsd: modelledDeal == null ? null : round(modelledDeal),
        modelledDealDeposit: modelledDeposit == null ? null : round(modelledDeposit),
        ...(quote ? { quoteToDeposit: quote.rates } : {}),
        depositPerUsd: { open: round(openRate), close: round(closeRate), source: deposit === 'USD' ? 'usd_deposit' : 'broker_deal_rate' },
        // On a USD deposit the broker's own ratio must read 1: a check of how
        // the two rate fields are read, against the broker's deals.
        usdDepositRatio: deposit === 'USD' ? ratioOrNull(d.open_margin_rate, d.open_base_usd_rate, d.close_margin_rate, d.close_base_usd_rate) : null,
        reason: quote ? quote.reason : (open.reason ?? close.reason ?? splitReason ?? rateReason ?? null),
      }
    })
    const brokerVals = perDeal.map(x => x.brokerPerLotPerSide)
    const modelled = perDeal.filter(x => x.modelledDealDeposit != null)
    const compared = deposit != null && modelled.length === perDeal.length && perDeal.length > 0
    const ratios = perDeal.flatMap(x => x.usdDepositRatio ?? [])
    symbols.push({
      symbol,
      deals: rows.length,
      terms: t ? { commissionTypeName: t.commissionTypeName, rate: t.rate, minCommission: t.minCommission, minCommissionAsset: t.minCommissionAsset, at: t.at } : null,
      lotUnits,
      brokerPerLotPerSide: { min: round(Math.min(...brokerVals)), max: round(Math.max(...brokerVals)), currency: deposit },
      compared,
      // Broker charges round to the cent on each side, so a deal's two sides
      // can differ from the model by up to a cent in all.
      agrees: compared ? perDeal.every(x => Math.abs(x.brokerDeal - x.modelledDealDeposit) <= 0.01 + 1e-9) : null,
      reason: t == null ? 'terms_not_recorded' : deposit == null ? 'deposit_currency_unverified' : modelled.length !== perDeal.length ? perDeal.find(x => x.reason)?.reason ?? null : null,
      usdDepositRatio: ratios.length ? { n: ratios.length, maxAbsDiffFrom1: round(Math.max(...ratios.map(v => Math.abs(v - 1)))) } : null,
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
function rate(v) { const n = typeof v === 'number' ? v : NaN; return Number.isFinite(n) && n > 0 ? n : null }
/** № 14,347: a QUOTE_CCY_PER_LOT charge in the deposit currency, or the reason not. */
function quoteCurrencyDeposit(t, d, { openUsd = null, closeUsd = null, rowsForPosition = null } = {}) {
  const out = (deposit, reason, rates = null) => ({ deposit, reason, rates })
  if (t.rate == null) return out(null, 'rate_not_stated')
  const lots = Number(d.lots)
  if (!(lots > 0)) return out(null, 'lots_unknown')
  const entry = rate(d.entry_price), close = rate(d.close_price)
  const open = rate(d.open_margin_rate) != null && entry != null ? rate(d.open_margin_rate) / entry : null
  const closeStated = rate(d.quote_deposit_rate)
  const closeDerived = rate(d.close_margin_rate) != null && close != null ? rate(d.close_margin_rate) / close : null
  const shut = closeStated ?? closeDerived
  const rates = { open: round(open), close: round(shut), closeSource: closeStated != null ? 'broker_quote_to_deposit' : 'margin_rate_over_price',
    // The two broker readings of one rate at the close, as a check of the open-side derivation.
    closeDerivedOverStated: closeStated != null && closeDerived != null ? round(closeDerived / closeStated) : null }
  if (open == null || shut == null) return out(null, 'quote_deposit_rate_not_reported', rates)
  let openSide = t.rate * lots * open, closeSide = t.rate * lots * shut
  // Claude · № 14,434 13-Oct (Codex P2 on #1361; claude-builder). The per-trade
  // minimum is applied per side in its own currency (spotware
  // ProtoOAMinCommissionType): QUOTE_CURRENCY is the charge's own currency and
  // takes the same side rate; CURRENCY in USD takes that side's deposit-per-USD
  // rate. Any other currency declines rather than convert at a guessed rate,
  // and a binding minimum on a position closed in parts is not compared.
  if (t.minCommission != null && t.minCommission > 0) {
    let minOpen, minClose
    if (t.minCommissionType === 2) {
      minOpen = t.minCommission * open; minClose = t.minCommission * shut
    } else if (t.minCommissionType === 1) {
      if (t.minCommissionAsset !== 'USD') return out(null, 'min_commission_not_usd', rates)
      if (rate(openUsd) == null || rate(closeUsd) == null) return out(null, 'deposit_rate_not_reported', rates)
      minOpen = t.minCommission * openUsd; minClose = t.minCommission * closeUsd
    } else {
      return out(null, 'min_commission_type_unknown', rates)
    }
    const binding = minOpen > openSide || minClose > closeSide
    if (binding && rowsForPosition !== 1) {
      return out(null, rowsForPosition == null ? 'min_commission_position_unknown' : 'min_commission_split_position', rates)
    }
    openSide = Math.max(openSide, minOpen); closeSide = Math.max(closeSide, minClose)
  }
  return out(openSide + closeSide, null, rates)
}
function depositPerUsd(deposit, marginRate, baseUsdRate) {
  if (deposit === 'USD') return 1
  const m = rate(marginRate), b = rate(baseUsdRate)
  return m != null && b != null ? m / b : null
}
function ratioOrNull(...pairs) {
  const out = []
  for (let i = 0; i < pairs.length; i += 2) { const m = rate(pairs[i]), b = rate(pairs[i + 1]); if (m != null && b != null) out.push(m / b) }
  return out
}

/**
 * The symbols to read for one account: its closing deals in the window,
 * plus any asked for, resolved through this account's own symbol map.
 */
export function symbolsToRead(db, accountId, ownMap, { days = 30, extra = [], now = Date.now() } = {}) {
  const since = new Date(now - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19)
  const fromDeals = db.prepare('SELECT DISTINCT symbol FROM broker_deals WHERE account_id = ? AND closed_at >= ? AND symbol IS NOT NULL').all(String(accountId), since).map(r => r.symbol)
  // Claude · № 13,856 13-Oct (Codex P2 on #1344, ordered after № 13,855; owner "Upper-case requested
  // names"; claude-builder): account symbol maps are keyed by the upper-cased
  // broker name (ctrader-creds.js fetchAccountSymbolMap), so a typed name is
  // upper-cased before it is looked up.
  const wanted = [...new Set([...fromDeals, ...extra.map(s => String(s).trim().toUpperCase()).filter(Boolean)])].sort()
  const ids = [], namesById = {}, notListed = [], overCap = []
  for (const name of wanted) {
    const sid = ownMap?.[name]
    if (sid == null) { notListed.push(name); continue }
    if (ids.length >= MAX_SYMBOLS) { overCap.push(name); continue }
    ids.push(Number(sid)); namesById[String(sid)] = name
  }
  return { ids, namesById, notListed, overCap }
}
