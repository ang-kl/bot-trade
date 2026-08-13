// ---------------------------------------------------------------------------
// agent/lib/contracts.js — instrument contract sizes + account-size tiers
// ---------------------------------------------------------------------------
// Contract size = how many units of the base asset a "1 lot" order represents.
// Used to convert SL distance (price) into USD loss per lot, which drives
// risk-based position sizing.
//
// For USD-quoted instruments, USD loss per lot = priceDistance * contractSize.
// For USD-base pairs (USDJPY, USDCHF etc) the loss lands in the quote currency,
// so it must be divided by the current price to express it in USD — without
// that conversion a JPY-quoted distance overstates the loss ~150× and sizing
// collapses to zero. Crosses (neither leg USD) have no conversion rate
// available here and report unknown, which the risk manager vetoes.
//
// There is NO hardcoded instrument universe. The risk manager decides whether
// a trade is affordable on the user's balance + leverage. The tier label is
// purely informational for the dashboard.
// ---------------------------------------------------------------------------

const CONTRACT_SIZE = {
  // Metals (troy ounces per lot — cTrader convention)
  XAUUSD: 100,
  XAGUSD: 5000,
  // 100, not 50 — measured. Two closed XPTUSD deals imply $100.00 per dollar
  // of platinum per lot; 50 would imply $50.00. The half-size entry sized
  // every platinum position at twice the intended risk (−$817.11 on one).
  XPTUSD: 100,
  XPDUSD: 100,
  // Energies
  SPOTCRUDE: 1000,
  WTI: 1000,
  BRENT: 1000,
  NATGAS: 10000,
  // Softs / agricultural
  COCOA: 10,
  COFFEE: 37500,
  SUGAR: 112000,
  COTTON: 50000,
  WHEAT: 5000,
  CORN: 5000,
  SOYBEAN: 5000,
  // Base metals
  COPPER: 25000,
  // Indices — cTrader typically gives 1 unit = $1/point per lot
  US30: 1, US500: 1, NAS100: 1, GER40: 1, UK100: 1,
  FRA40: 1, SPA35: 1, CN50: 1, VIX: 1, SDY: 1, HK50: 1, AUS200: 1,
  // MEASURED FROM FILLS, NOT ASSUMED (13-08-2026). See the QUOTE_CCY note:
  // JPN225 was carried as `contractSize 1, quote USD` on an assumption that
  // this broker settles index CFDs in USD. Nine closed JPN225 deals on the
  // 28 Jul–13 Aug statement imply $0.638 of P&L per index point per lot.
  // `1 × USD` would imply exactly $1.000. `100 JPY ÷ ~157 JPY/USD` = $0.637.
  // The contract is 100 yen a point, not one dollar a point.
  JPN225: 100,
  // Currency indices. USDX and EURX were in neither table, so contractSize
  // fell through to 1 and the quote to USD: the sizer valued a point at $1
  // when USDX pays $100 and EURX pays €100 (~$115). It therefore bought
  // ~100× the intended size. EURX lost $2,535.41 in two minutes on 22 lots
  // and USDX $1,090.00 on 100 lots — both on the same statement.
  USDX: 100, EURX: 100, JPYX: 100,
  // Crypto
  BTCUSD: 1, ETHUSD: 1, XRPUSD: 1, SOLUSD: 1, LTCUSD: 1, ADAUSD: 1,
  DOGEUSD: 1, BNBUSD: 1,
}

const DEFAULT_FX_CONTRACT = 100_000 // 1 lot = 100k units base ccy

// Instrument classification — drives the dynamic-sizing display (each type
// has a wildly different $-per-lot, which is WHY lots must be computed per
// instrument, never set as one global number).
const TYPE_BY_SYMBOL = {
  XAUUSD: 'metal', XAGUSD: 'metal', XPTUSD: 'metal', XPDUSD: 'metal',
  SPOTCRUDE: 'energy', WTI: 'energy', BRENT: 'energy', NATGAS: 'energy',
  COCOA: 'agri', COFFEE: 'agri', SUGAR: 'agri', COTTON: 'agri',
  WHEAT: 'agri', CORN: 'agri', SOYBEAN: 'agri',
  COPPER: 'metal',
  US30: 'index', US500: 'index', NAS100: 'index', GER40: 'index',
  UK100: 'index', JPN225: 'index', FRA40: 'index', SPA35: 'index',
  CN50: 'index', VIX: 'index', SDY: 'index', HK50: 'index', AUS200: 'index',
  BTCUSD: 'crypto', ETHUSD: 'crypto', XRPUSD: 'crypto', SOLUSD: 'crypto',
  LTCUSD: 'crypto', ADAUSD: 'crypto', DOGEUSD: 'crypto', BNBUSD: 'crypto',
}

/**
 * Classify a symbol: metal / energy / agri / index / crypto / equity
 * (broker ".US" suffix) / fx / fx (USD-base) / fx cross / other.
 */
export function instrumentType(symbol) {
  const s = (symbol || '').toUpperCase()
  if (TYPE_BY_SYMBOL[s]) return TYPE_BY_SYMBOL[s]
  if (/\.[A-Z]{2,3}$/.test(s)) return 'equity'
  if (s.length === 6 && /^[A-Z]{6}$/.test(s)) {
    if (s.endsWith('USD')) return 'fx'
    if (s.startsWith('USD')) return 'fx (USD-base)'
    return 'fx cross'
  }
  return 'other'
}

/**
 * Lookup the contract size for a symbol. Returns the default FX size for
 * any 6-letter pair not explicitly listed; otherwise 1.
 */
export function contractSize(symbol) {
  const s = (symbol || '').toUpperCase()
  if (CONTRACT_SIZE[s] != null) return CONTRACT_SIZE[s]
  if (s.length === 6 && /^[A-Z]{6}$/.test(s)) return DEFAULT_FX_CONTRACT
  return 1
}

// ---------------------------------------------------------------------------
// Quote currency for instruments that are NOT six-letter FX pairs.
//
// Owner, 2026-08-03: "The TP and SL is in hundreds of thousands when I dont
// have such balance." Measured on the live book of account 46130058, every
// one of eleven positions had been sized to a stop loss of ≈3,900 IN ITS OWN
// QUOTE CURRENCY — US30 3,886 (USD, right), 0003.HK 3,620 (HKD, ≈$464),
// 0016.HK 3,896 (HKD, ≈$500), GER40 3,707 (EUR, ≈$4,278). The uniform 3,900
// across currencies IS the bug: `fxQuoteCurrency` returned null for anything
// without six letters and `usdLossPerLot` read null as "USD", so the
// conversion was skipped entirely. A JPY-quoted JPN225 reported 155× its real
// risk; Hong Kong names 7.8×.
//
// This is NOT a display bug. risk.js:443 sizes positions through the same
// function, so the overstated per-lot loss bought ~1/7.8th of the intended
// lots on HK names — under-risked, but not the budget the owner set.
//
// ONLY instruments whose quote currency is actually known are listed. An
// unlisted symbol keeps today's USD assumption rather than guessing, because
// a wrong currency here mis-sizes real money in whichever direction it errs.
// ---------------------------------------------------------------------------
// CORRECTED 07-08-2026 — JPN225 was 'JPY' and it cost 158× on every trade.
//
// The premise "indices are quoted in the local currency of their market" is
// true of the QUOTE and false of the SETTLEMENT on this broker's index CFDs.
// Three real fills say so, and the JPY reading is not merely wrong, it is
// physically impossible:
//
//   trade 641  vol 72.54  pnl -9,171.76  → USD: 126.4 pts adverse
//                                          JPY: 20,000 pts = 32% of the index
//   trade      vol 51.51  pnl -2,681.29  → USD:  52.1 pts
//                                          JPY:  8,224 pts = 12.9%, in 45 min
//   trade      vol 74.59  pnl -1,315.92  → USD:  17.6 pts
//                                          JPY:  2,790 pts =  4.4%
//
// The HK share CFDs in the same file reconcile PERFECTLY under HKD (0016.HK
// modelled 539 USD against 563.16 realised), so this is not "the conversion
// is broken". It is one hand-entered currency, wrong, for four years of
// nobody checking. Share CFDs settle in the share's currency; this broker's
// index CFDs settle in USD.
//
// The real lesson is not the value — it is that this table is hand-written at
// all while the broker publishes quoteAssetId on every symbol. Until that is
// wired (see services/sizing-parity.js and the follow-up it names), entries
// here are HYPOTHESES, and sizing-parity.js is the thing that tests them
// against realised broker P&L instead of trusting them.
const QUOTE_CCY = {
  // JPN225 IS YEN-QUOTED. THE EVIDENCE ARRIVED (13-08-2026).
  //
  // This said `JPN225: 'USD'` under the note that the broker settles index
  // CFDs in USD "despite the local-currency quote", and told the next reader
  // that sizing-parity.js would settle it once the symbol had traded. It has
  // traded: nine closed deals on the 28 Jul–13 Aug statement imply $0.638 of
  // P&L per point per lot. USD settlement at contractSize 1 implies exactly
  // $1.000; 100 JPY a point at ~157 JPY/USD implies $0.637. The measurement
  // is not close to the assumption, and it is not a rounding argument.
  //
  // The old pair understated nothing — `1 × USD` OVERSTATES risk per lot
  // versus `100 × JPY`, so it sized JPN225 too SMALL, not too large. That
  // matters for honesty about the loss: JPN225's −$9,171.76 is not a
  // valuation-understatement story like EURX and USDX. It is a large adverse
  // move on a position the risk budget genuinely permitted, and the fix for
  // that lives in the R:R floor and the stop, not here.
  JPN225: 'JPY',
  JPYX: 'JPY',
  // EURX is a EUR-denominated currency index: 100 EUR a point, ~$115 at
  // EURUSD 1.1525, which is exactly what its one closed deal implies.
  // USDX is dollar-denominated, so it needs no conversion — but it did need
  // a contract size, and had neither.
  EURX: 'EUR', USDX: 'USD',
  // STILL UNVERIFIED, and now with a cautionary example attached: these carry
  // the same shape of assumption JPN225 just failed. They are NOT changed
  // here — "probably the same" is not evidence, and JPN225 shows a wrong
  // correction is as costly as a wrong original. sizing-parity.js will say,
  // once each has traded, and GER40's eight deals already imply $1.153 =
  // 1 × EURUSD, which is consistent with the EUR entry below.
  GER40: 'EUR', FRA40: 'EUR', SPA35: 'EUR', SPAIN35: 'EUR',
  ITALY40: 'EUR', NETH25: 'EUR', EUSTX: 'EUR', EUSTX50: 'EUR',
  UK100: 'GBP',
  SWISS20: 'CHF',
  AUS200: 'AUD',
  HK50: 'HKD',
  // Explicitly USD, so the map states it rather than relying on the fallback.
  US30: 'USD', US500: 'USD', NAS100: 'USD', US2000: 'USD', USTEC: 'USD',
  VIX: 'USD', SDY: 'USD', CN50: 'USD',
}

/**
 * The quote currency of a symbol, or null when we do not know and are
 * deliberately treating it as USD-denominated.
 *
 * Order matters:
 *  1. The explicit QUOTE_CCY map — the only place a non-USD non-FX
 *     instrument's currency is declared.
 *  2. Venue suffixes. Hong Kong share CFDs (`0003.HK`) trade in HKD and US
 *     share CFDs (`TSLA.US`) in USD.
 *  3. Other known non-FX symbols → null. NATGAS, COFFEE and COTTON are six
 *     uppercase letters but are NOT currency pairs (treating them as crosses
 *     vetoed their sizing as usd_per_lot_unknown).
 *  4. The six-letter FX pattern.
 */
// Runtime overrides, highest priority of all. A wrong entry in QUOTE_CCY
// mis-sizes every trade on that symbol by the FX rate, and today that took a
// code change and a deploy to correct — which is why JPN225 stayed wrong long
// enough to produce a 9,171.76 loss on a 45,211 account. `null` for a symbol
// means "no conversion, treat as USD" and is a legitimate override, so the
// map distinguishes ABSENT from SET-TO-NULL.
let QUOTE_CCY_OVERRIDES = new Map()

/**
 * Replace the override map (from `symbol_quote_ccy_json` at boot, or an
 * operator action). Values must be a 3-letter code or null; anything else is
 * dropped rather than stored, because a malformed currency here is the exact
 * failure this exists to fix.
 *
 * @param {Record<string,string|null>|null} raw
 * @returns {string[]} the symbols actually applied
 */
export function setQuoteCurrencyOverrides(raw) {
  const next = new Map()
  for (const [sym, ccy] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const s = String(sym).toUpperCase().trim()
    if (!s) continue
    if (ccy === null) { next.set(s, null); continue }
    const c = String(ccy).toUpperCase().trim()
    if (/^[A-Z]{3}$/.test(c)) next.set(s, c)
  }
  QUOTE_CCY_OVERRIDES = next
  return [...next.keys()]
}

/** What is currently overridden — for the Risk page and the parity readout. */
export function quoteCurrencyOverrides() {
  return Object.fromEntries(QUOTE_CCY_OVERRIDES)
}

export function fxQuoteCurrency(symbol) {
  const s = (symbol || '').toUpperCase()
  if (QUOTE_CCY_OVERRIDES.has(s)) return QUOTE_CCY_OVERRIDES.get(s)
  if (QUOTE_CCY[s] != null) return QUOTE_CCY[s]
  if (s.endsWith('.HK')) return 'HKD'
  if (s.endsWith('.US')) return 'USD'
  if (CONTRACT_SIZE[s] != null) return null
  if (s.length === 6 && /^[A-Z]{6}$/.test(s)) return s.slice(3)
  return null
}

/**
 * Currency → USD conversion from a live rates map ({ SYMBOL: price } — the
 * scan's freshest closes). GBP via GBPUSD (multiply), JPY via USDJPY
 * (divide). Returns NaN when no conversion path exists — callers veto,
 * never guess.
 *
 * THREE HOPS, NOT ONE (production 02-08-2026). The direct/inverse pair is
 * only present when the USD major itself is on the watchlist. Measured on
 * production: 654 entries vetoed `insufficient_equity … usd_per_lot_unknown`
 * in two days — EURJPY (269), AUDPLN (268), EURGBP (100) — because USDJPY,
 * USDPLN and GBPUSD are not scanned symbols, so the map never held them.
 * Those were sized-out, not risk-rejected: a conversion gap silently became
 * a trading halt on three otherwise-valid instruments.
 *
 * So when the direct pair is missing, derive the rate TRANSITIVELY through
 * any scanned pair that carries the currency alongside one whose USD rate IS
 * known — EURJPY quoted in JPY with a known EUR→USD gives
 * JPY→USD = (EUR→USD) ÷ price(EURJPY). Only one hop is taken, and only
 * through a directly-resolvable leg, so a rate is never chained through
 * another derived rate (compounding two stale closes is how a sizing error
 * becomes an over-sized position).
 */
export function usdRate(currency, rates) {
  const c = (currency || '').toUpperCase()
  if (c === 'USD') return 1
  if (!rates || typeof rates !== 'object') return NaN
  const directPair = (cur) => {
    const d = Number(rates[`${cur}USD`])
    if (Number.isFinite(d) && d > 0) return d
    const inv = Number(rates[`USD${cur}`])
    if (Number.isFinite(inv) && inv > 0) return 1 / inv
    return NaN
  }
  const own = directPair(c)
  if (Number.isFinite(own)) return own
  // One transitive hop through a cross that carries this currency.
  for (const [sym, raw] of Object.entries(rates)) {
    const s = String(sym).toUpperCase()
    if (s.length !== 6 || !/^[A-Z]{6}$/.test(s)) continue
    const base = s.slice(0, 3)
    const quote = s.slice(3)
    if (base !== c && quote !== c) continue
    const other = base === c ? quote : base
    if (other === c) continue
    const otherRate = other === 'USD' ? 1 : directPair(other)
    if (!Number.isFinite(otherRate) || otherRate <= 0) continue
    const price = Number(raw)
    if (!Number.isFinite(price) || price <= 0) continue
    // base=c: price is OTHER per 1 C → C→USD = price × (OTHER→USD)
    // quote=c: price is C per 1 OTHER → C→USD = (OTHER→USD) ÷ price
    const derived = base === c ? price * otherRate : otherRate / price
    if (Number.isFinite(derived) && derived > 0) return derived
  }
  return NaN
}

/**
 * USD loss per lot given a price-level distance. Exact for USD-quoted symbols
 * (XXXUSD, indices, commodities). For USD-base pairs (USDJPY, USDCHF …) the
 * raw loss is in the quote currency; pass the current `price` so it can be
 * converted back to USD (loss ÷ price). CROSSES (EURGBP, GBPJPY …) convert
 * their quote-currency loss through `rates` — the scan's live closes of the
 * USD majors (GBP via GBPUSD, JPY via USDJPY …). Returns NaN only when no
 * conversion path exists, so the risk manager vetoes instead of mis-sizing.
 */
export function usdLossPerLot(symbol, priceDistance, price, rates = null) {
  const quote = fxQuoteCurrency(symbol)
  const lossInQuote = Math.abs(priceDistance) * contractSize(symbol)
  if (quote == null || quote === 'USD') return lossInQuote
  const base = symbol.toUpperCase().slice(0, 3)
  if (base === 'USD' && Number.isFinite(price) && price > 0) {
    return lossInQuote / price
  }
  // Cross (or USD-base without a price): convert the quote currency to USD
  // via the live rates map.
  const rate = usdRate(quote, rates)
  if (Number.isFinite(rate)) return lossInQuote * rate
  return NaN
}

/**
 * Notional exposure (USD) for a position. Used to compute margin required:
 *   margin = notional / leverage
 *
 * Exact for USD-quoted (EURUSD, XAUUSD, BTCUSD, US30, etc) and for USD-base
 * pairs (USDJPY etc — notional is simply volume × contract size in USD).
 * Crosses (no USD leg) fall back to quote-currency notional, which is only
 * an approximation for the margin headroom check.
 */
export function notionalUsd(symbol, volumeLots, price, rates = null) {
  const quote = fxQuoteCurrency(symbol)
  if (quote != null && quote !== 'USD') {
    const base = symbol.toUpperCase().slice(0, 3)
    // 1 lot of USDXXX = contractSize USD of notional, no price term needed.
    if (base === 'USD') return Math.abs(volumeLots) * contractSize(symbol)
    // Cross: the price term yields QUOTE-currency notional (GBPJPY → JPY);
    // convert to USD via the live rates or the margin gate overstates a
    // JPY-quoted position ~150× and falsely vetoes on margin.
    const rate = usdRate(quote, rates)
    if (Number.isFinite(rate)) {
      return Math.abs(volumeLots) * contractSize(symbol) * Math.abs(price) * rate
    }
    // No rate — fall through to the quote-notional approximation (legacy).
  }
  return Math.abs(volumeLots) * contractSize(symbol) * Math.abs(price)
}

// ---------------------------------------------------------------------------
// Account-size tiers — purely informational label for the dashboard. The risk
// manager does NOT gate instruments by tier; affordability is checked via
// the risk budget + margin headroom.
// ---------------------------------------------------------------------------

export const TIERS = [
  { name: 'micro',    maxBalance: 500,       note: 'Tight risk budget — small lots only' },
  { name: 'small',    maxBalance: 2000,      note: 'Modest risk budget' },
  { name: 'standard', maxBalance: 10000,     note: 'Comfortable sizing across products' },
  { name: 'full',     maxBalance: Infinity,  note: 'Full flexibility' },
]

export function tierForBalance(balance) {
  const b = Number(balance) || 0
  for (const t of TIERS) {
    if (b <= t.maxBalance) return t
  }
  return TIERS[TIERS.length - 1]
}
