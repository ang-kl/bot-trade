import { credsForRegisteredAccount } from '../lib/ctrader-creds.js'
import { normPosId } from '../lib/pos-id.js'

export function protectionPositionId(value) {
  const raw = String(value ?? '').trim()
  if (!/^[1-9]\d*(?:\.0+)?$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('a valid broker positionId is required')
  }
  return normPosId(raw)
}

// Protection must never route an unknown or ambiguous identity to the selected
// account. An explicit account also permits an owner to protect an untracked
// broker position; local attribution is a separate decision.
export function protectionCredentials(db, { positionId, accountId = null }) {
  const id = protectionPositionId(positionId)
  let account = accountId == null ? null : String(accountId).trim()
  const accountSource = accountId == null ? 'position_record' : 'body'
  if (accountId == null) {
    const matches = db.prepare(`
      SELECT t.account_id FROM trades t
       WHERE t.ctrader_position_id = ?
      UNION
      SELECT mp.account_id FROM monitored_positions mp JOIN trades t ON t.id = mp.trade_id
       WHERE t.ctrader_position_id = ?
    `).all(id, id)
    if (matches.length !== 1 || !matches[0].account_id) {
      throw new Error('explicit account is required: protection position ownership is missing or ambiguous')
    }
    account = String(matches[0].account_id)
  }
  if (!account || account === 'all' || account === '_all') throw new Error('one registered account is required for protection')
  const creds = credsForRegisteredAccount(db, account)
  if (!creds || String(creds.accountId) !== account) throw new Error('a registered account is required for protection; no selected-account fallback')
  return { ...creds, accountSource }
}

export function protectionCallback(accountId, positionId, tp) {
  if (accountId == null || !/^[1-9]\d*$/.test(String(accountId)) || !Number.isFinite(Number(tp)) || Number(tp) <= 0) return null
  try {
    const data = `prottp|${accountId}|${protectionPositionId(positionId)}|${Number(tp)}`
    return Buffer.byteLength(data, 'utf8') <= 64 ? data : null
  } catch { return null }
}

export function parseProtectionCallback(parts) {
  if (parts[0] !== 'prottp' || ![3, 4].includes(parts.length)) throw new Error('Invalid protection button')
  const scoped = parts.length === 4
  const accountId = scoped ? parts[1] : null
  if (scoped && !/^[1-9]\d*$/.test(accountId)) throw new Error('Invalid protection button account')
  const positionId = protectionPositionId(parts[scoped ? 2 : 1])
  const tp = Number(parts[scoped ? 3 : 2])
  if (!Number.isFinite(tp) || tp <= 0) throw new Error('Invalid protection button target')
  return { accountId, positionId, tp }
}
