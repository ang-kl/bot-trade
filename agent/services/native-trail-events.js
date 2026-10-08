// Codex · №12,073 · 2026-10-08; codex-footprint: confirmed-trail.
// Consume proof produced by the native read/amend/read transaction. Old
// amend_ok strings and policy-only stamps cannot prove a stop-level move.
import { getAccountSymbolMap, accountSymbolMapIsFresh } from '../lib/ctrader-creds.js'
import { recordPositionEvent } from './position-events.js'

const positiveId = x => typeof x === 'number' && Number.isSafeInteger(x) && x > 0
const positivePrice = x => typeof x === 'number' && Number.isFinite(x) && x > 0
const direction = x => ['long','buy'].includes(String(x).toLowerCase()) ? 1
  : ['short','sell'].includes(String(x).toLowerCase()) ? -1 : 0
const utcMillis = raw => {
  if (typeof raw !== 'string' || !raw.trim()) return NaN
  const s=raw.replace(' ','T')
  return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(s)?s:s+'Z')
}

export function recordNativeTrailDecision(db, { side, bootId, entry }) {
  if (entry.component !== 'trail' || entry.kind !== 'amend_ok' || typeof side.isLive !== 'boolean'
    || typeof bootId !== 'string' || !bootId || !positiveId(entry.seq) || !positiveId(entry.tsMs)) return false
  let proof
  try {
    if (typeof entry.detail !== 'string' || entry.detail.length > 500) return false
    const match = /^pos=([1-9]\d*) sl=\S+ amend_readback proof=(\{.*\})$/.exec(entry.detail || '')
    if (!match) return false
    proof = JSON.parse(match[2])
    if (String(proof.positionId) !== match[1]) return false
  } catch { return false }
  if (proof.v !== 1 || proof.source !== 'broker_reconcile' || proof.confirmation !== 'amend_readback'
    || proof.stopMoved !== true || ![1,-1].includes(proof.direction)
    || ![proof.accountId,proof.positionId,proof.symbolId,proof.beforeCheckedAtMs,proof.afterCheckedAtMs].every(positiveId)
    || proof.accountId !== entry.accountId || proof.symbolId !== entry.symbolId
    || ![proof.entryPrice,proof.beforeStopLoss,proof.afterStopLoss].every(positivePrice)
    || (proof.afterStopLoss-proof.beforeStopLoss)*proof.direction <= 0
    || proof.beforeCheckedAtMs > proof.afterCheckedAtMs || proof.afterCheckedAtMs > entry.tsMs) return false
  const accountId=String(proof.accountId),positionId=String(proof.positionId)
  const account=db.prepare('SELECT is_live FROM accounts WHERE account_id=?').get(accountId)
  if (!account || account.is_live !== Number(side.isLive)) return false
  const rows=db.prepare(`SELECT mp.trade_id,mp.symbol,mp.side,mp.entry_price,
      t.side AS trade_side,t.entry_price AS trade_entry,t.opened_at,t.closed_at,t.status
    FROM monitored_positions mp JOIN trades t ON t.id=mp.trade_id
    WHERE mp.account_id=? AND t.account_id=? AND t.ctrader_position_id=?`).all(accountId,accountId,positionId)
  // A duplicate/reversed/unstamped episode stays raw and unattributed.
  if (rows.length !== 1) return false
  const row=rows[0],opened=utcMillis(row.opened_at),closed=utcMillis(row.closed_at)
  if (direction(row.side)!==proof.direction || direction(row.trade_side)!==proof.direction
    || row.entry_price!==proof.entryPrice || row.trade_entry!==proof.entryPrice
    || !Number.isFinite(opened) || proof.beforeCheckedAtMs < opened
    || (row.status==='closed' && (!Number.isFinite(closed) || proof.afterCheckedAtMs > closed))) return false
  const own=getAccountSymbolMap(db,accountId)
  if (!accountSymbolMapIsFresh(own) || own.map[String(row.symbol).toUpperCase()] !== proof.symbolId) return false
  const recorded=recordPositionEvent(db,{accountId,positionId,tradeId:row.trade_id,symbol:row.symbol,
    kind:'trail_tightened',fromValue:proof.beforeStopLoss,toValue:proof.afterStopLoss,atMs:proof.afterCheckedAtMs,
    source:'cpp_trail_engine',detail:{nativeSide:side.name,nativeBootId:bootId,nativeSeq:entry.seq,
      nativeAtMs:entry.tsMs,host:side.isLive?'live.ctraderapi.com':'demo.ctraderapi.com',movement:proof}})
  // The caller's transaction rolls the native row back too, retaining its
  // retryable source cursor. No acknowledgement of a failed journal write.
  if (!recorded) throw new Error('native_trail_journal_write_failed')
  return true
}
