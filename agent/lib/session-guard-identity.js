// Codex · №12,710 · 2026-10-09; codex-footprint: owned-session-guard-contract.
// The guard's row, broker snapshot and returned stop must name one episode.
import { sideDirection } from './stop-policy.js'

export const guardId = value => (typeof value === 'number' || (typeof value === 'string' && /^[1-9]\d*$/.test(value)))
  && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null
const price = value => typeof value === 'number' && Number.isFinite(value) && value > 0

export function readGuardPosition(db, id) {
  const row = db.prepare(`SELECT mp.*, t.account_id AS linked_account, t.ctrader_position_id AS broker_position,
    t.symbol AS linked_symbol, t.side AS linked_side, t.entry_price AS linked_entry, t.status AS linked_status
    FROM monitored_positions mp JOIN trades t ON t.id=mp.trade_id WHERE mp.id=?`).get(id)
  if (!row || row.status !== 'active' || row.paused === 1 || row.source === 'external' || row.be_moved
    || row.linked_status !== 'open' || !price(row.entry_price) || !(row.initial_risk > 0)) return null
  const accountId = guardId(row.linked_account), positionId = guardId(row.broker_position)
  const direction = sideDirection(row.side), symbol = String(row.symbol || '').toUpperCase()
  if (!accountId || !positionId || !direction || !symbol
    || (row.account_id != null && guardId(row.account_id) !== accountId)
    || String(row.linked_symbol || '').toUpperCase() !== symbol || sideDirection(row.linked_side) !== direction
    || (row.linked_entry != null && row.linked_entry !== row.entry_price)) return null
  return { row, identity: { rowId: row.id, tradeId: row.trade_id, accountId, positionId,
    symbol, direction, entryPrice: row.entry_price } }
}

export function sameGuardIdentity(a, b) {
  return !!a && !!b && ['rowId','tradeId','accountId','positionId','symbol','direction','entryPrice']
    .every(key => a[key] === b[key])
}

export function brokerGuardIdentity(identity, rec, resolvedId) {
  const symbolId = guardId(resolvedId)
  if (!symbolId || (rec?.ctidTraderAccountId != null && guardId(rec.ctidTraderAccountId) !== identity.accountId)
    || !Array.isArray(rec?.position)) return null
  const matches = rec.position.filter(p => guardId(p?.positionId) === identity.positionId)
  if (matches.length !== 1) return null
  const p = matches[0], side = p.tradeData?.tradeSide
  const direction = [1,'1','BUY'].includes(side) ? 1 : [2,'2','SELL'].includes(side) ? -1 : 0
  if ((p.ctidTraderAccountId != null && guardId(p.ctidTraderAccountId) !== identity.accountId)
    || guardId(p.tradeData?.symbolId) !== symbolId || direction !== identity.direction
    || !price(p.price) || p.price !== identity.entryPrice
    || (p.stopLoss != null && p.stopLoss !== 0 && !price(p.stopLoss))) return null
  return { ...identity, symbolId, beforeStopLoss: price(p.stopLoss) ? p.stopLoss : null }
}

export function guardReadback(identity, result, requestedStop, mode) {
  const unknown = { kind: 'unverified' }
  if (!result || result.error || result.rawError || result.ok === false || result.skipped || result.alreadyClosed) return unknown
  // A JS execution-event position can establish held protection, not the
  // native transaction's actor/movement proof. Keep its truthful bookkeeping.
  if (mode !== 'cpp') {
    const observed = brokerGuardIdentity(identity, { position: [result.position] }, identity.symbolId)
    const held = result.position?.stopLoss
    return observed && price(held) && (held-requestedStop)*identity.direction >= 0
      ? { kind: 'observed', stopLoss: held } : unknown
  }
  const p = result.protection, m = p?.movement
  const unchanged = result.unchanged === true
  const confirmation = unchanged ? 'already_tighter_snapshot' : 'amend_readback'
  if (p?.verified !== true || p.source !== 'broker_reconcile' || p.confirmation !== confirmation
    || m?.v !== 1 || m.source !== 'broker_reconcile' || m.confirmation !== confirmation
    || m.accountId !== identity.accountId || m.positionId !== identity.positionId
    || m.symbolId !== identity.symbolId || m.direction !== identity.direction || m.entryPrice !== identity.entryPrice
    || ![m.beforeCheckedAtMs,m.afterCheckedAtMs].every(n => typeof n === 'number' && guardId(n))
    || m.afterCheckedAtMs < m.beforeCheckedAtMs || p.checkedAtMs !== m.afterCheckedAtMs
    || !price(p.stopLoss) || p.stopLoss !== m.afterStopLoss
    || (p.stopLoss-requestedStop)*identity.direction < 0) return unknown
  if (unchanged) return m.stopMoved === false && m.beforeStopLoss === m.afterStopLoss
    ? { kind: 'unchanged', stopLoss: p.stopLoss } : unknown
  if (result.unchanged !== false) return unknown
  const installed = m.beforeStopLoss === null && m.stopMoved === false
  const tightened = price(m.beforeStopLoss) && (m.afterStopLoss-m.beforeStopLoss)*identity.direction > 0 && m.stopMoved === true
  return installed || tightened ? { kind: 'moved', stopLoss: p.stopLoss, beforeStopLoss: m.beforeStopLoss, movement: m } : unknown
}
