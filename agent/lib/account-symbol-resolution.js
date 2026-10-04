// The exact requested names and their account-owned resolution. A changed
// unresolved request asks the existing bounded refresher for one newer list;
// a fresh list that still lacks the name is evidence, not an alias invitation.
import { getState, setState } from '../db.js'

export const ACCOUNT_SYMBOL_RESOLUTION_KEY = 'account_symbol_resolution_json'
const read = db => { try { return JSON.parse(getState(db, ACCOUNT_SYMBOL_RESOLUTION_KEY) || '{}') || {} } catch { return {} } }

export function recordSymbolResolution(db, resolution, now = Date.now()) {
  const key = `${resolution.side}:${resolution.purpose}`
  const records = read(db)
  const { checkedAt: _checkedAt, ...previous } = records[key] ?? {}
  if (JSON.stringify(previous) === JSON.stringify(resolution)) return
  records[key] = { ...resolution, checkedAt: now }
  setState(db, ACCOUNT_SYMBOL_RESOLUTION_KEY, JSON.stringify(records))
}

export function unresolvedAccountSymbols(db, { accountId, host, builtAt, now = Date.now() }) {
  const records = Object.values(read(db)).filter(r => r && String(r.accountId) === String(accountId) && r.host === host
    && Number.isSafeInteger(r.checkedAt) && r.checkedAt <= now + 3600_000 && Array.isArray(r.unresolved))
  const names = [...new Set(records.flatMap(r => r.unresolved.map(s => s.name).filter(n => typeof n === 'string')))].sort()
  const built = Date.parse(builtAt)
  const refreshRequested = records.some(r => r.unresolved.length && (!Number.isFinite(built) || r.checkedAt > built))
  return { names, refreshRequested }
}
