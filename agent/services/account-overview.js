import { accountMoney } from './account-money.js'
import { readAccountSnapshot, RISK_DISPLAY_SNAPSHOT_MAX_AGE_MS } from './account-snapshot.js'

const number = n => typeof n === 'number' && Number.isFinite(n) ? n : null
const stamp = s => typeof s === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(s) ? Date.parse(s) : NaN

// One cheap, read-only view of the existing per-account caches. No broker I/O,
// trade/history scan, credential payload or synthetic freshness on page refresh.
export function accountOverview(db, { nowMs = Date.now() } = {}) {
  const maxAgeMs = RISK_DISPLAY_SNAPSHOT_MAX_AGE_MS
  const fresh = t => Number.isFinite(t) && t <= nowMs && nowMs - t < maxAgeMs
  const accounts = db.prepare('SELECT account_id,is_live,enabled FROM accounts ORDER BY account_id').all().map(row => {
    const accountId = String(row.account_id), host = row.is_live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
    const money = accountMoney(db, accountId, { now: nowMs, maxAgeMs })
    const ownMoney = money.observation?.host === host && money.status === 'fresh'
    const currency = ownMoney ? money.observation.currency : null
    const balance = ownMoney ? number(money.observation.balance) : null
    const reading = readAccountSnapshot(db, accountId, { nowMs, maxAgeMs, expectedCurrency: currency })
    const a = reading.snapshot?.account
    const owned = !!a && a.host === host && currency != null && a.currency === currency
    // A reconciled empty position list establishes zero floating without a
    // separate unrealised-P&L request (the broker producer returns early).
    const pnlReceivedAt = owned ? stamp(a.positions?.length === 0 ? reading.fetchedAt : a.pnlReceivedAt) : NaN
    const balanceReceivedAt = owned ? stamp(a.balanceReceivedAt) : NaN
    const positions = owned && Array.isArray(a.positions) ? a.positions : null
    const complete = positions && fresh(pnlReceivedAt) && positions.every(p => p.pnlSource === 'broker' && number(p.netPnl) != null)
    const openPnl = complete ? positions.reduce((s, p) => s + p.netPnl, 0) : null
    // Use the balance observed with this snapshot for its equity, rather than
    // combining a newer deposit reading with an older position snapshot.
    const snapshotBalance = owned && fresh(balanceReceivedAt) ? number(a.health?.balance) : null
    const equity = snapshotBalance != null && openPnl != null ? snapshotBalance + openPnl : null
    const margin = owned ? number(a.health?.usedMargin) : null
    return { accountId, isLive: !!row.is_live, enabled: !!row.enabled, host, currency, balance, equity, openPnl,
      freeMargin: equity != null && margin != null ? equity - margin : null,
      balanceReceivedAt: ownMoney ? money.observation.receivedAt : null,
      pnlReceivedAt: Number.isFinite(pnlReceivedAt) ? pnlReceivedAt : null,
      snapshotAt: owned ? reading.fetchedAt : null, maxAgeMs,
      status: equity != null ? 'fresh' : balance != null ? 'partial' : money.status,
      reason: equity != null ? null : !owned ? reading.reason || 'owned_currency_snapshot_required' : 'complete_fresh_broker_pnl_required',
      positions: (positions || []).map(p => ({ accountId, positionId: p.positionId, symbolId: p.symbolId,
        symbol: p.symbol, side: p.side, volume: p.rawVolume, lots: p.lots,
        entry: p.entry, sl: p.sl, tp: p.tp, price: p.currentPrice,
        netPnl: complete ? number(p.netPnl) : null, pnlSource: complete ? 'broker' : null })),
    }
  })
  return { asOfMs: nowMs, accounts, source: 'account_owned_broker_cache', moneyScope: 'native_currency' }
}
