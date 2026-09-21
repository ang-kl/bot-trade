// Keep the opposite broker side's local ledger current without changing the
// selected trading account. The old loop read only that side's equity, leaving
// closed live positions permanently active whenever demo was selected.
import { getCtraderCreds, getAccountSymbolMap } from '../lib/ctrader-creds.js'
import { wsReconcile } from '../lib/ctrader-ws.js'
import { tokenRefusedAccounts } from '../lib/token-refused.js'
import { getEnabledAccounts, setAccountState } from './account-registry.js'
import { reconcilePositions } from './reconciler.js'

export async function reconcileCrossSideAccounts(db, baseCreds, deps = {}) {
  if (!baseCreds?.ready) return []
  const accounts = getEnabledAccounts(db).filter(a => (a.is_live === 1) !== !!baseCreds.isLive)
  const refused = tokenRefusedAccounts(db)
  const read = deps.readSnapshot ?? wsReconcile
  const credentials = deps.getCreds ?? getCtraderCreds
  return Promise.all(accounts.map(async account => {
    const accountId = String(account.account_id)
    if (refused.has(accountId)) return { accountId, skipped: 'token_refused' }
    try {
      const creds = credentials(db, { accountId, isLive: account.is_live === 1 })
      if (!creds?.ready) throw new Error('credentials unavailable')
      // A cached/empty sidecar response is insufficient evidence for closing
      // local rows. Ask the broker directly, on this account's own host, with
      // one bounded attempt. Failures leave every ledger row unchanged.
      const snapshot = await read(creds.host, creds.clientId, creds.clientSecret,
        creds.accessToken, accountId, 5_000, 0)
      if (!snapshot || String(snapshot.ctidTraderAccountId) !== accountId || snapshot.error ||
          snapshot.errorCode || (snapshot.position != null && !Array.isArray(snapshot.position)) ||
          (snapshot.order != null && !Array.isArray(snapshot.order))) {
        throw new Error('broker snapshot missing, malformed or belongs to another account')
      }
      // ProtoJSON may omit empty repeated fields; identity above distinguishes
      // a confirmed empty account from a missing response.
      const positions = snapshot.position ?? []
      const orders = snapshot.order ?? []
      if (positions.some(p => !p || !/^[1-9]\d*$/.test(String(p.positionId))) ||
          orders.some(o => !o || !/^[1-9]\d*$/.test(String(o.orderId)))) {
        throw new Error('broker snapshot contains an unidentified position or order')
      }
      // The legacy order table has a global order_id primary key. Until it
      // supports composite identities, never transfer another account's row
      // through syncBrokerOrders' upsert (including an unowned legacy row).
      const existingOrder = db.prepare('SELECT account_id FROM broker_orders WHERE order_id = ?')
      for (const order of orders) {
        const existing = existingOrder.get(String(order.orderId))
        if (existing && String(existing.account_id) !== accountId) {
          throw new Error(`broker order ${order.orderId} conflicts with another account's ledger row`)
        }
      }
      const ownMap = getAccountSymbolMap(db, accountId)?.map ?? {}
      const names = new Map(Object.entries(ownMap).map(([name, id]) => [String(id), name]))
      const named = rows => rows.map(row => {
        const name = names.get(String(row.tradeData?.symbolId))
        if (!name) throw new Error(`account symbol map missing symbol ${row.tradeData?.symbolId ?? '?'}`)
        return { ...row, symbolName: name }
      })
      const namedPositions = named(positions)
      const namedOrders = named(orders)
      const result = db.transaction(() => reconcilePositions(db, namedPositions, namedOrders,
        (key, value) => setAccountState(db, accountId, key, value), { accountId }))()
      return { accountId, result }
    } catch (error) {
      return { accountId, error: error?.message || String(error) }
    }
  }))
}
