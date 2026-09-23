import { accountMoney, recordAccountMoney } from './account-money.js'
import { recordAccountHistory } from './account-history.js'
import { observeBrokerReads } from '../lib/broker-read-observer.js'

const started = new WeakMap(), MAX_SKEW_MS = 60_000
const id = value => /^[1-9]\d*$/.test(String(value)) ? String(value) : null
const amount = value => /^-?\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null

/** Retain existing reads, without asking the broker or changing risk inputs. */
export function makeBrokerHistoryRecorder(db, { clock = Date.now } = {}) {
  const cache = new Map()
  return event => {
    const accountId = id(event.accountId), now = clock(), at = event.receivedAt
    if (!accountId || !Number.isSafeInteger(at) || at > now || now - at > 180_000) return false
    const account = db.prepare('SELECT is_live FROM accounts WHERE account_id=?').get(accountId)
    const host = account?.is_live === 1 ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
    if (!account) { cache.delete(accountId); return false }
    if (event.host !== host || (!cache.has(accountId) && cache.size >= 512)) return false
    const payload = event.payload
    if (!payload || payload.error || payload.errorCode) return false
    const previous = cache.get(accountId)
    const state = previous?.host === host ? previous : { host }
    const common = { accountId, host, receivedAt: at }
    if (event.kind === 'trader') {
      const trader = payload.trader, digits = trader?.moneyDigits ?? 2, balance = amount(trader?.balance)
      if (id(payload.ctidTraderAccountId) !== accountId || id(trader?.ctidTraderAccountId) !== accountId
        || !Number.isInteger(digits) || digits < 0 || digits > 10 || balance == null || balance < 0) return false
      recordAccountMoney(db, { ...common, trader, balance: balance / 10 ** digits })
    } else if (event.kind === 'reconcile' || event.kind === 'protection') {
      const protection = event.kind === 'protection'
      if (protection ? payload.ok !== true || payload.source !== 'broker_reconcile' || id(payload.accountId) !== accountId
        : id(payload.ctidTraderAccountId) !== accountId) return false
      const positions = protection ? payload.positions : payload.position
      if (positions != null && !Array.isArray(positions)) return false
      const rows = positions || [], ids = rows.map(p => id(p.positionId))
      if (rows.length > 512 || ids.some(p => !p) || new Set(ids).size !== rows.length
        || (protection && payload.openCount !== rows.length)) return false
      if (state.reconcile?.at > at) return false
      const exposure = rows.map(p => ({ positionId: id(p.positionId), symbolId: id(p.tradeData?.symbolId ?? p.symbolId),
        volume: amount(p.tradeData?.volume), side: p.tradeData?.tradeSide === 1 ? 'BUY' : p.tradeData?.tradeSide === 2 ? 'SELL' : null }))
      const evidence = { source: protection ? 'cpp_verify' : 'broker_reconcile', observedAt: new Date(at).toISOString(),
        missingSL: rows.filter(p => !(Number(p.stopLoss) > 0)).length,
        missingTP: rows.filter(p => !(Number(p.takeProfit) > 0)).length }
      if (protection && (evidence.missingSL !== payload.missingSl || evidence.missingTP !== payload.missingTp)) return false
      state.reconcile = { at, ids, exposure, protection: evidence }
      const money = accountMoney(db, accountId, { now: at })
      recordAccountHistory(db, { ...common, source: 'broker_reconcile',
        currency: money.observation?.host === host ? money.observation.currency : null,
        openPositions: rows.length, exposure, exposureComplete: exposure.every(p => p.symbolId && p.volume != null && p.side), protection: evidence,
        balanceReceivedAt: null })
    } else if (event.kind === 'pnl') {
      const digits = payload.moneyDigits, rows = payload.positionUnrealizedPnL ?? []
      if (id(payload.ctidTraderAccountId) !== accountId || !Number.isInteger(digits) || digits < 0 || digits > 10
        || !Array.isArray(rows) || rows.length > 512 || rows.some(p => !id(p.positionId) || amount(p.netUnrealizedPnL) == null)
        || new Set(rows.map(p => id(p.positionId))).size !== rows.length || state.pnl?.at > at) return false
      const money = accountMoney(db, accountId, { now: at })
      state.pnl = { at, ids: rows.map(p => id(p.positionId)), net: rows.reduce((sum, p) => sum + amount(p.netUnrealizedPnL) / 10 ** digits, 0),
        currency: money.status === 'fresh' && money.observation.host === host ? money.observation.currency : null,
        depositAssetId: money.status === 'fresh' && money.observation.host === host ? money.observation.depositAssetId : null }
      if (!Number.isFinite(state.pnl.net)) return false
    } else return false
    cache.set(accountId, state)
    // Compose only independently dated, near-contemporaneous evidence from
    // this host/account. Partial position P&L cannot masquerade as zero equity.
    const money = accountMoney(db, accountId, { now, maxAgeMs: MAX_SKEW_MS }), balance = money.observation
    const rec = state.reconcile, pnl = state.pnl
    if (!rec || !pnl || money.status !== 'fresh' || balance.host !== host) return true
    const latest = Math.max(rec.at, pnl.at, balance.receivedAt), earliest = Math.min(rec.at, pnl.at, balance.receivedAt)
    const complete = pnl.currency === balance.currency && pnl.depositAssetId === balance.depositAssetId
      && latest - earliest <= MAX_SKEW_MS && now - earliest <= MAX_SKEW_MS
      && rec.ids.length === pnl.ids.length && rec.ids.every(p => pnl.ids.includes(p))
    if (!complete) return true
    return recordAccountHistory(db, { accountId, host, source: 'broker_equity', receivedAt: latest,
      currency: balance.currency, balance: balance.balance, openPnl: pnl.net, equity: balance.balance + pnl.net,
      balanceReceivedAt: balance.receivedAt, pnlReceivedAt: pnl.at, equitySource: 'balance_plus_broker_pnl',
      openPositions: rec.ids.length, exposure: rec.exposure, exposureComplete: rec.exposure.every(p => p.symbolId && p.volume != null && p.side),
      protection: rec.protection })
  }
}

export function startBrokerHistoryRecording(db) {
  if (started.has(db)) return started.get(db)
  const stop = observeBrokerReads(makeBrokerHistoryRecorder(db))
  const close = () => { stop(); started.delete(db) }
  started.set(db, close)
  return close
}
