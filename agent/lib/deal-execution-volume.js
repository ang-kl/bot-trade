// Codex · №11,919 · 2026-10-07; codex-footprint: executed-volume-contract.
// ProtoOADeal.volume is the requested quantity. It never proves a fill.
import { executedDeal } from './position-deal-history.js'

export const EXECUTED_VOLUME_CONTRACT = 1
export const VOLUME_BOUNDARY_KEY = 'executed_volume_contract_1_trade_boundary'
export function positiveBrokerQuantity(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
export function closingExecutedQuantity(deal) {
  if (!executedDeal(deal)) return null
  const filled = positiveBrokerQuantity(deal.filledVolume)
  const closed = positiveBrokerQuantity(deal.closePositionDetail?.closedVolume)
  return filled != null && filled === closed ? closed : null
}
export function prospectiveVolumeTrade(db, tradeId) {
  // A failed/missing boundary is not permission to rewrite retained history.
  try {
    const raw = db.prepare('SELECT value FROM agent_state WHERE key = ?').get(VOLUME_BOUNDARY_KEY)?.value
    if (raw == null || !/^\d+$/.test(String(raw))) return false
    const boundary = Number(raw), id = Number(tradeId)
    return Number.isSafeInteger(boundary) && Number.isSafeInteger(id) && id > boundary
  } catch { return false }
}
