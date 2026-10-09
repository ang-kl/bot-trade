// Codex · №12,472 · 2026-10-09; codex-footprint: owner HK-share exclusion.
// New exposure only. Never used by amend/close/protection or held-position feeds.
import { getState } from '../db.js'
export const OWNER_UNIVERSE_VERSION = 'hk-exclusion-utc8-2026-10-09-v1'
export const catalogueKey = id => `owner_universe_catalogue:${String(id)}`
export function readOwnedCatalogue(db, id) {
  if (id == null) return null
  try {
    const v = JSON.parse(getState(db, catalogueKey(id)) || 'null')
    return v?.accountId === String(id) ? v : null
  } catch { return null }
}
export function excludedInstrumentFilter(db, id) {
  const own = readOwnedCatalogue(db, id)
  const indices = new Set((own?.indices || []).map(x => x.symbol))
  const excluded = new Set(own?.excluded || [])
  return raw => {
    const symbol = String(raw || '').trim().toUpperCase()
    return !indices.has(symbol) && (excluded.has(symbol) || /\.HK$/.test(symbol))
  }
}
export function ownerInstrumentVerdict(db, { accountId, symbol, symbolId } = {}) {
  let name = String(symbol || '').trim().toUpperCase()
  let map = null
  try {
    const own = JSON.parse(getState(db, `symbol_id_map:${String(accountId)}`) || 'null')
    if (own?.accountId === String(accountId)) map = own.map
  } catch { /* no account identity is inferred from the selected map */ }
  if (symbolId != null && map && typeof map === 'object') {
    const names = Object.entries(map).filter(([, id]) => Number(id) === Number(symbolId)).map(([n]) => n.toUpperCase())
    if (names.length > 1 || (names.length === 1 && name && names[0] !== name) || (name && map[name] != null && Number(map[name]) !== Number(symbolId))) return { ok: false, reason: 'owner_symbol_identity_conflict' }
    if (!name && names.length === 1) name = names[0]
  }
  if (!name) return { ok: false, reason: 'owner_symbol_identity_unverified' }
  return excludedInstrumentFilter(db, accountId)(name)
    ? { ok: false, reason: 'owner_hk_share_excluded', symbol: name }
    : { ok: true, symbol: name }
}
