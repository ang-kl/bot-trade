// ---------------------------------------------------------------------------
// agent/services/account-currency.js — the UNIT the risk engine sizes in.
//
// C·1 PR-2 (owner, 03-10-2026, № 10,777·B·5: "rate table"). Two cTrader
// accounts (…3489, …7342) hold SGD; the broker's native balance is stored
// unchanged under `acct:<id>:account_balance_usd`, and PR-1 (#1195) labelled
// it honestly without converting it. Everything downstream of that number —
// the per-trade budget, the lot size, the margin cap, the daily loss cap —
// is arithmetic in USD: `usdLossPerLot` is USD, `notionalUsd` is USD, the
// floors in the risk config are USD. So on an SGD account every one of those
// figures was a USD formula fed an SGD number: the size and the caps were in
// the wrong unit by the USDSGD rate (about 1.3×), silently.
//
// THE SOURCE IS THE FX RATE TABLE, NOTHING ELSE. fx-rates.js accumulates the
// freshest close per symbol with a 26-hour usability window, and already
// refuses to size a cross whose conversion leg is missing or stale. This
// module applies the SAME rule to the account's own currency: the USD value
// of an SGD balance comes from USDSGD (or SGDUSD) in that table, with its age
// attached; when neither is there, or both are stale, the answer is
// `refused: 'fx_rate_unavailable'` — the sizing path then vetoes, the margin
// pool does not dispatch, the loss cap blocks. NO RATE IS GUESSED, DEFAULTED
// OR HARDCODED. Sizing on an assumed 1.0 is exactly the defect being fixed;
// sizing on a guessed 1.3 would be the same defect with a better excuse.
//
// USD ACCOUNTS ARE UNTOUCHED. A broker-verified USD account is `identity`:
// rate 1, no table read, the native number passed through as-is, and no new
// field on the gate's checks. An account whose deposit currency is NOT
// verified (no broker asset-list evidence yet) is also identity — that is
// the behaviour it had before this module existed — and is labelled
// `currencySource: 'unverified'` so a reader can see that the unit is an
// assumption, not a measurement. Refusing there would halt every account on
// a fresh database, which is not the owner's order.
//
// RATE DIRECTION. `rate` is always USD PER ONE UNIT of the account currency
// (SGD → ~0.78), so `usd = native × rate` and `native = usd ÷ rate`. A
// USDSGD close (SGD per USD) is inverted once; an SGDUSD close is used as is.
// No transitive hop: the account currency's own USD leg or nothing — the
// leg refresher (fx-legs.js) keeps that leg fresh from the broker on purpose.
// ---------------------------------------------------------------------------
import { getState } from '../db.js'
import { readFxTable, RATE_MAX_AGE_MS } from './fx-rates.js'
import { balanceUnit } from './balance-unit.js'

/** The refusal every consumer reports — the gate's veto head, the pool's reason, the view's field. */
export const FX_RATE_UNAVAILABLE = 'fx_rate_unavailable'

/**
 * Which rate converts `currency` to USD right now, and how old it is.
 * Reads the persistent table only (timestamps are needed for the age).
 *
 * @returns {{rate:number, symbol:string, price:number, ageMs:number}|null}
 */
export function accountUsdLeg(db, currency, now = Date.now()) {
  const c = String(currency || '').toUpperCase()
  if (!/^[A-Z]{3}$/.test(c) || c === 'USD') return null
  let table
  try { table = readFxTable(db) } catch { table = {} }
  const candidates = []
  for (const [symbol, invert] of [[`${c}USD`, false], [`USD${c}`, true]]) {
    const row = table?.[symbol]
    const p = Number(row?.p)
    const t = Number(row?.t)
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(t)) continue
    const ageMs = now - t
    if (ageMs < 0 || ageMs > RATE_MAX_AGE_MS) continue
    candidates.push({ rate: invert ? 1 / p : p, symbol, price: p, ageMs })
  }
  if (!candidates.length) return null
  // The fresher leg wins when both directions are on record.
  candidates.sort((a, b) => a.ageMs - b.ageMs)
  return candidates[0]
}

/**
 * The conversion the risk engine must apply to this account's native money.
 *
 * @returns {{
 *   accountId: string|null,
 *   currency: string|null,            broker-verified deposit currency, null when unverified
 *   currencySource: 'broker_verified'|'unverified',
 *   conversion: 'identity'|'fx_table'|'refused',
 *   rate: number|null,                USD per 1 unit of `currency`; 1 for identity; null when refused
 *   rateSymbol: string|null,          the table entry used (USDSGD / SGDUSD)
 *   ratePrice: number|null,           that entry's close as recorded
 *   rateAgeMs: number|null, rateAgeMin: number|null, rateMaxAgeMs: number,
 *   refused: null|'fx_rate_unavailable',
 *   detail: string|null,
 * }}
 */
export function accountCurrencyConversion(db, accountId = null, { now = Date.now() } = {}) {
  const resolved = accountId != null ? String(accountId) : (safeState(db, 'ctrader_account_id') || null)
  let unit
  try { unit = balanceUnit(db, resolved) } catch { unit = { currency: null, source: 'unverified' } }
  const currency = unit?.currency ?? null
  const base = {
    accountId: resolved, currency, currencySource: currency ? 'broker_verified' : 'unverified',
    conversion: 'identity', rate: 1, rateSymbol: null, ratePrice: null,
    rateAgeMs: null, rateAgeMin: null, rateMaxAgeMs: RATE_MAX_AGE_MS, refused: null, detail: null,
  }
  // USD, or not verified: the native number IS the sizing number, as before.
  if (currency == null || currency === 'USD') {
    return currency == null ? { ...base, detail: 'deposit currency not broker-verified; native money read as USD (unchanged behaviour)' } : base
  }
  const leg = accountUsdLeg(db, currency, now)
  if (!leg) {
    return {
      ...base, conversion: 'refused', rate: null, refused: FX_RATE_UNAVAILABLE,
      detail: `no ${currency}USD or USD${currency} close in the FX rate table within ${RATE_MAX_AGE_MS / 3_600_000} h — the ${currency} balance cannot be valued in USD, nothing is sized on an assumed rate`,
    }
  }
  return {
    ...base, conversion: 'fx_table', rate: leg.rate, rateSymbol: leg.symbol, ratePrice: leg.price,
    rateAgeMs: leg.ageMs, rateAgeMin: Math.round(leg.ageMs / 60_000),
    detail: `${currency}→USD ${leg.rate.toPrecision(6)} via ${leg.symbol} ${leg.price} (${Math.round(leg.ageMs / 60_000)} min old)`,
  }
}

/** native → USD under a conversion; null when refused or the amount is not a number. */
export function usdFromNative(amount, conv) {
  if (amount == null || !Number.isFinite(Number(amount))) return null
  if (!conv || conv.conversion === 'identity') return Number(amount)
  if (conv.conversion !== 'fx_table' || !(Number(conv.rate) > 0)) return null
  return Number(amount) * Number(conv.rate)
}

/** USD → native under a conversion; null when refused or the amount is not a number. */
export function nativeFromUsd(amountUsd, conv) {
  if (amountUsd == null || !Number.isFinite(Number(amountUsd))) return null
  if (!conv || conv.conversion === 'identity') return Number(amountUsd)
  if (conv.conversion !== 'fx_table' || !(Number(conv.rate) > 0)) return null
  return Number(amountUsd) / Number(conv.rate)
}

/**
 * The balance the risk engine may size against, IN USD, with its provenance.
 * `balance` is the native number the caller already read (getAccountBalance
 * or the raw `acct:<id>:account_balance_usd` key) — this never re-reads it,
 * so the owner-scoping rules of that read are untouched.
 *
 * A null native balance converts to null without a refusal (there is
 * nothing to convert); a stamped 0 is 0 in every currency. A refused
 * conversion of a positive balance is `balanceUsd: null` with `refused` set
 * — the caller must treat that as "cannot size", never as "no balance".
 */
export function sizingBalanceUsd(db, accountId = null, { balance = null, now = Date.now() } = {}) {
  const conv = accountCurrencyConversion(db, accountId, { now })
  const native = balance != null && Number.isFinite(Number(balance)) ? Number(balance) : null
  if (native == null) return { ...conv, nativeBalance: null, balanceUsd: null }
  if (conv.conversion === 'identity') return { ...conv, nativeBalance: native, balanceUsd: native }
  if (native === 0) return { ...conv, nativeBalance: 0, balanceUsd: 0 }
  if (conv.conversion === 'refused') return { ...conv, nativeBalance: native, balanceUsd: null }
  return { ...conv, nativeBalance: native, balanceUsd: native * conv.rate }
}

/** The fields a view or a checks row carries for a NON-identity conversion. */
export function conversionView(conv) {
  if (!conv) return null
  return {
    currency: conv.currency,
    currencySource: conv.currencySource,
    conversion: conv.conversion,
    rate: conv.rate != null ? Number(Number(conv.rate).toPrecision(8)) : null,
    rateSymbol: conv.rateSymbol,
    ratePrice: conv.ratePrice,
    rateAgeMin: conv.rateAgeMin,
    rateMaxAgeHours: conv.rateMaxAgeMs / 3_600_000,
    refused: conv.refused,
    detail: conv.detail,
  }
}

/**
 * The non-USD deposit currencies of the registered accounts — what the FX
 * leg refresher must keep priced in addition to the watchlist's quote
 * currencies. From the broker asset-list evidence only (deposit-currencies.js
 * rule): an unverified account demands nothing.
 */
export function accountDepositCurrencies(db) {
  const out = new Set()
  try {
    for (const row of db.prepare('SELECT account_id FROM accounts WHERE enabled = 1').all()) {
      const c = balanceUnit(db, String(row.account_id)).currency
      if (c && c !== 'USD') out.add(c)
    }
  } catch { /* no registry → nothing demanded */ }
  return out
}

function safeState(db, key) {
  try { return getState(db, key) } catch { return null }
}
