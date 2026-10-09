// Codex · №12,473 · 2026-10-09; codex-footprint: owner-approved account universe.
// One bounded application of the owner's 9-Oct order, not a monitoring job.
// Never changes account/strategy/risk settings, profiles, broker orders or stops.
import { getState, setState } from '../db.js'
import { listAccounts } from './account-registry.js'
import { readWatchlist, writeWatchlist, hasOwnWatchlist, WATCHLIST_KEY, LEGACY_KEY, acctWatchlistKey, normalizeItem } from './watchlists.js'
import { credsForRegisteredAccount, fetchAccountSymbolMap } from '../lib/ctrader-creds.js'
import { tokenRefusedAccounts } from '../lib/token-refused.js'
import { OWNER_UNIVERSE_VERSION, catalogueKey, excludedInstrumentFilter, ownerInstrumentVerdict } from '../lib/owner-instrument-policy.js'
export const receiptKey = id => `owner_universe_receipt:${OWNER_UNIVERSE_VERSION}:${id}`
const parse = raw => { try { return JSON.parse(raw || 'null') } catch { return null } }
const iso = now => new Date(now).toISOString()
const STOCK_CAP = 24, ACCOUNT_CAP = 64
const STOCK_ZONES = new Set(['Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Taipei', 'Asia/Shanghai', 'Asia/Chongqing'])
function owned(response, accountId, field) {
  if (String(response?.ctidTraderAccountId || '') !== String(accountId) || !Array.isArray(response?.[field])) throw new Error(`catalogue_${field}_identity_or_shape`)
  return response[field]
}
export function classifyCatalogue(accountId, data) {
  const classes = new Map(owned(data.assetClasses, accountId, 'assetClass').map(x => [String(x.id), String(x.name || '')]))
  const categories = new Map(owned(data.categories, accountId, 'symbolCategory').map(x => [String(x.id), x]))
  const symbols = owned(data.symbols, accountId, 'symbol')
  const out = { accountId: String(accountId), indices: [], excluded: [], stockCandidates: [], available: symbols.length, unclassified: 0, stockCategories: [] }
  const names = new Set(), ids = new Set()
  for (const s of symbols) {
    const name = String(s.symbolName || '').trim().toUpperCase(), id = Number(s.symbolId)
    if (!name || !Number.isSafeInteger(id) || id <= 0 || names.has(name) || ids.has(id)) throw new Error('catalogue_symbol_identity_conflict')
    names.add(name); ids.add(id)
    const cat = categories.get(String(s.symbolCategoryId)), ac = classes.get(String(cat?.assetClassId)) || ''
    const category = String(cat?.name || ''), label = `${ac} ${category}`
    if (!ac) out.unclassified++
    const stock = /\b(stocks?|shares?|equities|equity)\b/i.test(ac)
    const index = /\b(indices|indexes|index)\b/i.test(ac) || (!stock && /\b(indices|indexes)\b/i.test(category))
    if (stock && !out.stockCategories.includes(category)) out.stockCategories.push(category)
    const hk = /\.HK$/.test(name) || /hong[ -]?kong|\bHK\b/i.test(category)
    if (hk && !index) out.excluded.push(name)
    if (s.enabled === false) continue
    const row = { symbol: name, symbolId: id, category, assetClass: ac, description: String(s.description || '') }
    if (index) out.indices.push(row)
    else if (stock && !hk && /singapore|malaysia|taiwan|shanghai|shenzhen|mainland|\bchina\b/i.test(label)) out.stockCandidates.push(row)
  }
  out.indices.sort((a, b) => a.symbol.localeCompare(b.symbol))
  // Prefer the owner's Singapore shortlist; keep other UTC+8 candidates
  // bounded. Actual exchange schedule and cost terms are required below.
  const preferred = /\b(DBS|OCBC|UOB|Singtel|SGX)\b|ST Engineering|Singapore Exchange/i
  out.stockCandidates.sort((a, b) => Number(preferred.test(b.description + ' ' + b.symbol)) - Number(preferred.test(a.description + ' ' + a.symbol)) || a.symbol.localeCompare(b.symbol))
  return out
}
export function stockMetadataVerdict(detail) {
  const schedule = detail?.schedule
  if (!STOCK_ZONES.has(detail?.scheduleTimeZone) || !Array.isArray(schedule) || !schedule.length || !schedule.every(x => Number.isInteger(x.startSecond) && Number.isInteger(x.endSecond) && x.startSecond >= 0 && x.endSecond <= 604800 && x.endSecond > x.startSecond)) return 'utc8_schedule_unverified'
  // Protobuf int64 amounts may be JSON decimal strings; blank/null/bool is never zero.
  const amount = typeof detail.commission === 'number' || (typeof detail.commission === 'string' && /^\d+(?:\.\d+)?$/.test(detail.commission)) ? Number(detail.commission) : NaN
  const types = { USD_PER_MILLION_USD: 1, USD_PER_LOT: 2, PERCENTAGE_OF_VALUE: 3, QUOTE_CURRENCY_PER_LOT: 4 }
  const type = typeof detail.commissionType === 'number' ? detail.commissionType : types[detail.commissionType]
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(type) || type < 1 || type > 4) return 'commission_terms_unverified'
  return null
}
// Physical removal includes disabled account lists and the legacy fallback.
// Entry guards already apply even if this cleanup encounters malformed JSON.
export function removeHkWatchlistRows(db, { now = Date.now(), log = () => {} } = {}) {
  const accounts = listAccounts(db)
  const targets = [{ key: WATCHLIST_KEY, id: null }, { key: LEGACY_KEY, id: null }, ...accounts.map(a => ({ key: acctWatchlistKey(a.account_id), id: a.account_id }))]
  const result = { at: iso(now), version: OWNER_UNIVERSE_VERSION, lists: [], unsubmittedReleased: 0, brokerPending: [] }
  db.transaction(() => {
    for (const { key, id } of targets) {
      const raw = parse(getState(db, key)); if (!Array.isArray(raw)) continue
      const policyExcluded = excludedInstrumentFilter(db, id)
      const catalogued = parse(getState(db, catalogueKey(id)))?.excluded || []
      const excluded = symbol => policyExcluded(symbol) && (/^\d+\.HK$/.test(symbol) || catalogued.includes(symbol))
      const gone = raw.filter(x => excluded(normalizeItem(x).symbol)).map(x => normalizeItem(x).symbol)
      if (!gone.length) continue
      setState(db, key, JSON.stringify(raw.filter(x => !excluded(normalizeItem(x).symbol))))
      result.lists.push({ accountId: id, removed: gone })
    }
    for (const row of db.prepare("SELECT id, account_id, symbol, symbol_id, state, broker_order_id, permit_expires_at FROM entry_intents WHERE state IN ('RESERVED','DISPATCHING','SENT','UNKNOWN','ACCEPTED')").all()) {
      const v = ownerInstrumentVerdict(db, { accountId: row.account_id, symbol: row.symbol, symbolId: row.symbol_id })
      if (v.reason !== 'owner_hk_share_excluded') continue
      if (row.state === 'RESERVED') {
        db.prepare("UPDATE entry_intents SET state = 'RELEASED', error_code = ?, resolution_source = 'owner_policy', resolved_at = ?, updated_at = ? WHERE id = ? AND state = 'RESERVED'").run(v.reason, iso(now), iso(now), row.id)
        result.unsubmittedReleased++
      } else result.brokerPending.push(row) // no broker cancellation or inferred outcome
    }
    const key = `owner_universe_removal:${OWNER_UNIVERSE_VERSION}:${now}`
    if (result.lists.length || result.unsubmittedReleased || result.brokerPending.length) setState(db, key, JSON.stringify(result))
  }).immediate()
  log(`[owner-universe] removal ${JSON.stringify(result)}`)
  return result
}
async function readCatalogue(creds) {
  const { wsGetAccountInstrumentCatalogue } = await import('../lib/ctrader-ws.js')
  return wsGetAccountInstrumentCatalogue(creds.host, creds.clientId, creds.clientSecret, creds.resolveAccessToken?.(creds) ?? creds.accessToken, creds.accountId)
}
async function readDetails(creds, ids) {
  const { wsGetSymbolById } = await import('../lib/ctrader-ws.js')
  return wsGetSymbolById(creds.host, creds.clientId, creds.clientSecret, creds.resolveAccessToken?.(creds) ?? creds.accessToken, creds.accountId, ids, 10_000, { maxRetries: 0, recoverAuth: false })
}
export async function applyOwnerUniverse(db, { now = Date.now, catalogue = readCatalogue, details = readDetails, credentials = credsForRegisteredAccount, log = () => {} } = {}) {
  const results = []
  for (const account of listAccounts(db).slice(0, ACCOUNT_CAP)) {
    const id = String(account.account_id), key = receiptKey(id)
    if (getState(db, key)) continue // durable one-shot claim: never replay on restart
    const rec = { accountId: id, version: OWNER_UNIVERSE_VERSION, at: iso(now()), state: 'started' }
    setState(db, key, JSON.stringify(rec))
    try {
      if (tokenRefusedAccounts(db).has(id)) throw new Error('account_token_refused')
      const creds = credentials(db, id)
      if (!creds?.ready || String(creds.accountId) !== id) throw new Error('account_access_unavailable')
      const data = await catalogue(creds)
      const classified = classifyCatalogue(id, data)
      const stockCandidates = classified.stockCandidates.slice(0, STOCK_CAP)
      const stocks = [], refusedStocks = []
      if (stockCandidates.length) {
        try {
          const response = await details(credentials(db, id), stockCandidates.map(s => s.symbolId))
          const rows = owned(response, id, 'symbol')
          for (const s of stockCandidates) {
            const matches = rows.filter(d => Number(d.symbolId) === s.symbolId)
            const d = matches.length === 1 ? matches[0] : null
            const reason = stockMetadataVerdict(d)
            if (reason) refusedStocks.push({ symbol: s.symbol, reason })
            else stocks.push({ ...s, scheduleTimeZone: d.scheduleTimeZone, schedule: d.schedule, commission: d.commission, commissionType: d.commissionType, minCommission: d.minCommission ?? null, minCommissionType: d.minCommissionType ?? null, minCommissionAsset: d.minCommissionAsset ?? null })
          }
        } catch { for (const s of stockCandidates) refusedStocks.push({ symbol: s.symbol, reason: 'stock_details_read_failed' }) }
      }
      // Reuse the single account-map writer with the already-owned response;
      // no second network read and no cross-account/selected-map copy.
      await fetchAccountSymbolMap(db, creds, { wsGetSymbolsList: async () => data.symbols, now: now() })
      db.transaction(() => {
        // Read the list AFTER awaits so concurrent owner edits are preserved.
        if (!listAccounts(db).some(a => String(a.account_id) === id)) throw new Error('account_removed_during_read')
        const inherited = !hasOwnWatchlist(db, id)
        const available = [...classified.indices, ...stocks]
        setState(db, catalogueKey(id), JSON.stringify({ accountId: id, at: iso(now()), version: OWNER_UNIVERSE_VERSION, indices: classified.indices, excluded: classified.excluded, stocks }))
        const before = readWatchlist(db, id)
        const have = new Set(before.map(x => x.symbol)), added = available.filter(x => !have.has(x.symbol))
        const next = writeWatchlist(db, id, [...before, ...added.map(s => ({ symbol: s.symbol, enabled: true, group: classified.indices.includes(s) ? 'Indices' : 'UTC+8 Stocks' }))])
        Object.assign(rec, { state: 'applied', completedAt: iso(now()), availableSymbolCount: classified.available, unclassifiedSymbolCount: classified.unclassified, stockCategories: classified.stockCategories, inheritedBefore: inherited, added: added.map(s => s.symbol), indices: classified.indices.map(s => s.symbol), stocks: stocks.map(s => s.symbol), refusedStocks, stockCandidates: classified.stockCandidates.length, stockCandidatesBeyondCap: Math.max(0, classified.stockCandidates.length - STOCK_CAP), total: next.length, excluded: classified.excluded, disabledRetained: next.filter(x => x.enabled === false && available.some(s => s.symbol === x.symbol)).map(x => x.symbol) })
        setState(db, key, JSON.stringify(rec))
      }).immediate()
    } catch (e) {
      // No exception text can echo credentials; use a bounded known vocabulary.
      const reason = /^(account_|catalogue_)[a-z_]+$/.test(e?.message || '') ? e.message : 'catalogue_read_failed'
      Object.assign(rec, { state: 'blocked', reason, completedAt: iso(now()) })
      setState(db, key, JSON.stringify(rec))
    }
    results.push(rec)
    log(`[owner-universe] account ${JSON.stringify(rec)}`)
  }
  return results
}
