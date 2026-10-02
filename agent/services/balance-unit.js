// ---------------------------------------------------------------------------
// agent/services/balance-unit.js — WHAT UNIT is this account's balance in?
//
// C·1 (owner 02-10-2026: "should be SGD"). Several money figures are stored
// under keys named `..._usd` and printed with a "$" even when the broker's
// deposit currency is SGD: the broker's NATIVE balance goes in unchanged
// (…3489 is SGD 51.41, …7342 is SGD 3,102.80 — read from the broker's trader
// response and its asset list by account-money.js). This module answers the
// one question the labels need, from that verified evidence and nothing else.
//
// LABELS ONLY. It never converts, never changes a stored value, never changes
// what the risk engine reads. A unit it cannot verify is `null`, and a label
// built from it says "currency unverified" rather than inventing a symbol.
// ---------------------------------------------------------------------------
import { accountMoney } from './account-money.js'

// A deposit currency does not change with a balance reading's age, so a stale
// observation still names the unit; only a missing or invalid one does not.
const UNIT_MAX_AGE_MS = 365 * 24 * 3_600_000

/**
 * @returns {{currency: string|null, usdComparable: boolean|null, source: 'broker_verified'|'unverified'}}
 *   usdComparable — true for a verified USD account, false for a verified
 *   other currency, null when the currency is not verified.
 */
export function balanceUnit(db, accountId) {
  let currency = null
  try {
    const m = accountMoney(db, accountId, { maxAgeMs: UNIT_MAX_AGE_MS })
    const c = m?.observation?.currency
    currency = typeof c === 'string' && /^[A-Z]{3}$/.test(c) ? c : null
  } catch { currency = null }
  return { currency, usdComparable: currency == null ? null : currency === 'USD', source: currency ? 'broker_verified' : 'unverified' }
}

/** "SGD 51.41", "$51.41" (verified USD), or "51.41 (currency unverified)". */
export function moneyLabel(amount, unit, digits = 2) {
  if (!(typeof amount === 'number' && Number.isFinite(amount))) return '?'
  const n = amount.toFixed(digits)
  if (!unit || unit.currency == null) return `${n} (currency unverified)`
  return unit.currency === 'USD' ? `$${n}` : `${unit.currency} ${n}`
}
