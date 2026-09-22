import { recordAccountHistory } from './account-history.js'
import { getState, setState } from '../db.js'
import { RISK_DISPLAY_SNAPSHOT_MAX_AGE_MS } from './account-snapshot.js'

// Native broker money is not USD unless the broker's deposit asset says so.
// These observations are deliberately separate from the legacy risk inputs:
// replacing a missing USD input can remove a percentage loss cap. The risk
// migration needs its own missing-conversion policy and review.
const key = id => `acct:${id}:money_observation_json`
const currencyKey = id => `acct:${id}:deposit_currency_evidence_json`
const idOf = value => value != null && /^[1-9]\d*$/.test(String(value)) ? String(value) : null
const hostOf = value => ['demo.ctraderapi.com', 'live.ctraderapi.com'].includes(value) ? value : null
const currencyOf = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null
const read = (db, k) => { try { return JSON.parse(getState(db, k) || 'null') } catch { return null } }

/** Store only a broker asset-list resolution, never a registry/default hint. */
export function recordDepositCurrency(db, { accountId, host, depositAssetId, currency, receivedAt = Date.now() }) {
  const id = idOf(accountId), asset = idOf(depositAssetId), route = hostOf(host), ccy = currencyOf(currency)
  if (!id || !asset || !route || !ccy || !Number.isFinite(receivedAt)) return false
  setState(db, currencyKey(id), JSON.stringify({ accountId: id, host: route,
    depositAssetId: asset, currency: ccy, receivedAt, source: 'broker_asset_list' }))
  return true
}

/** Capture the existing trader response; this function performs no broker I/O. */
export function recordAccountMoney(db, { accountId, host, trader, balance, receivedAt = Date.now() }) {
  const id = idOf(accountId), route = hostOf(host), asset = idOf(trader?.depositAssetId)
  if (!id || !route || !Number.isFinite(receivedAt)) return false
  if (trader?.ctidTraderAccountId != null && idOf(trader.ctidTraderAccountId) !== id) return false
  const previous = read(db, key(id))
  if (previous?.host === route && Number.isFinite(previous.receivedAt) && previous.receivedAt > receivedAt) return false
  const metadata = read(db, currencyKey(id))
  const currencyVerified = !!asset && metadata?.accountId === id && metadata?.host === route
    && metadata?.depositAssetId === asset && currencyOf(metadata?.currency) != null
    && Number.isFinite(metadata?.receivedAt)
  const amount = typeof balance === 'number' && Number.isFinite(balance) && balance >= 0 ? balance : null
  const evidence = { version: 1, accountId: id, host: route, source: 'broker_trader',
    sourceTimestamp: null, receivedAt, depositAssetId: asset,
    moneyDigits: Number.isInteger(trader?.moneyDigits) ? trader.moneyDigits : null,
    balance: amount, currency: currencyVerified ? metadata.currency : null,
    currencyObservedAt: currencyVerified ? metadata.receivedAt : null,
    currencySource: currencyVerified ? metadata.source : null,
    reason: amount == null ? 'balance_unavailable' : currencyVerified ? null : 'deposit_currency_unverified' }
  setState(db, key(id), JSON.stringify(evidence))
  recordAccountHistory(db, evidence)
  return evidence
}

/** Read-only display contract. Never converts, borrows or renews an observation. */
export function accountMoney(db, accountId, { now = Date.now(), maxAgeMs = RISK_DISPLAY_SNAPSHOT_MAX_AGE_MS } = {}) {
  const id = idOf(accountId)
  const unavailable = reason => ({ accountId: id, status: 'unavailable', reason, observation: null })
  if (!id) return unavailable('account_required')
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return unavailable('invalid_freshness_policy')
  const observation = read(db, key(id))
  if (!observation || observation.version !== 1 || observation.accountId !== id || !hostOf(observation.host)
    || !Number.isFinite(observation.receivedAt)) return unavailable('money_observation_missing_or_invalid')
  const ageMs = now - observation.receivedAt
  if (ageMs < 0 || (observation.currencyObservedAt != null && observation.currencyObservedAt > now)) return unavailable('money_observation_future')
  if (observation.balance != null && (typeof observation.balance !== 'number' || !Number.isFinite(observation.balance) || observation.balance < 0)) return unavailable('money_observation_invalid')
  if (!observation.reason && (observation.balance == null || !currencyOf(observation.currency))) return unavailable('money_observation_invalid')
  const stale = ageMs >= maxAgeMs
  return { accountId: id, status: stale ? 'stale' : observation.reason ? 'unverified' : 'fresh',
    reason: stale ? 'money_observation_stale' : observation.reason, ageMs, maxAgeMs, observation,
    // A native, verified USD balance needs no FX conversion. No other amount
    // is exposed under this unit; historical legacy scalar keys remain outside.
    balanceUsd: !stale && !observation.reason && observation.currency === 'USD' ? observation.balance : null }
}
