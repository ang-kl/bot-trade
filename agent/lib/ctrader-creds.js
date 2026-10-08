// ---------------------------------------------------------------------------
// agent/lib/ctrader-creds.js — single source for cTrader credential assembly
// and the symbol→symbolId map, both previously copy-pasted across loop.js and
// routes/actions.js.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { ctraderEnv } from './ctrader-env.js'
import { admitEntry } from '../services/entry-mode.js'
import { reserveEntry, redeemPermit, markSent, resolveIntent } from '../services/entry-ledger.js'

// Once this DB grant has a stored token, source-bound snapshots cannot
// resurrect an older env seed if that stored authentication is removed.
const storedTokenSources = new WeakSet()

/** Read credentials for one registered account; unknown never falls back. */
export function credsForRegisteredAccount(db, accountId) {
  const row = db.prepare('SELECT account_id, is_live FROM accounts WHERE account_id = ?').get(String(accountId))
  return row ? getCtraderCreds(db, { accountId: row.account_id, isLive: Number(row.is_live) === 1 }) : null
}

/**
 * Assemble cTrader connection credentials from env + agent state.
 * `accountOverride` ({accountId, isLive}) supports multi-account autopilot.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{accountId?: string|number, isLive?: boolean}} [accountOverride]
 * @returns {{host: string, clientId: string|undefined, clientSecret: string|undefined, accessToken: string|null, accountId: string|null, ready: boolean}}
 */
export function getCtraderCreds(db, accountOverride, { producerId = null, basis = null } = {}) {
  const clientId = ctraderEnv('clientId')
  const clientSecret = ctraderEnv('clientSecret')
  const storedAccessToken = getState(db, 'ctrader_access_token')
  const accessToken = storedAccessToken || ctraderEnv('accessToken')
  const accountId = accountOverride?.accountId || getState(db, 'ctrader_account_id') || ctraderEnv('accountId')
  const isLive = accountOverride
    ? !!accountOverride.isLive
    : getState(db, 'ctrader_is_live') === 'true'

  // 5A: the exec guard (halt kill switch, max order volume) travels WITH the
  // credentials so exec-engine.placeOrder can enforce it on the js path too —
  // previously only the C++ sidecar's order_guard saw these knobs.
  let execGuard = null
  try { execGuard = JSON.parse(getState(db, 'exec_guard_json') || 'null') } catch { /* unreadable → no guard */ }

  // M2: the enabled-account roster from the registry, restricted to accounts
  // on the SAME live/demo side as these creds (one sidecar session = one
  // host). ensureSidecarSession forwards it so the sidecar pre-authorizes
  // every enabled account in one push. Primary always leads; single-account
  // registries produce a one-entry roster, which the sidecar treats exactly
  // like the legacy single-account push.
  let accountIds = null
  try {
    const rows = db.prepare(
      'SELECT account_id FROM accounts WHERE enabled = 1 AND is_live = ? ORDER BY account_id'
    ).all(isLive ? 1 : 0).map(r => String(r.account_id))
    if (accountId != null) {
      const primary = String(accountId)
      accountIds = [primary, ...rows.filter(id => id !== primary)]
    } else if (rows.length) {
      accountIds = rows
    }
  } catch { /* accounts table may predate this — roster stays null */ }

  return withCtraderTokenSource(db, {
    host: isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com',
    // F-RISK-01: this was COMPUTED at :23-25, used at :43 and :53, and then
    // dropped on the floor. `sameSideAccountIds` reads `baseCreds?.isLive`, so
    // it evaluated `!!undefined === false` on every call and selected the DEMO
    // side unconditionally — including for live credentials, which then swept
    // demo accounts and silently DROPPED any second live account from the loss
    // cap and profit ratchet.
    isLive,
    clientId,
    clientSecret,
    accessToken,
    accountId,
    accountIds,
    execGuard: execGuard && typeof execGuard === 'object' ? execGuard : null,
    // P1b (11-09-2026): the entry fence travels with the credentials the same
    // way the exec guard does, so exec-engine.placeOrder can re-check it at
    // the last Node boundary. Absent producerId = a non-producing caller
    // (reads, reconcile, amends): no fence attached. P2a: the intent ledger
    // rides the same way (attachEntryFence).
    ...(producerId ? entryFenceFor(db, accountId, { producerId, basis }) : {}),
    ready: !!(clientId && clientSecret && accessToken && accountId),
  })
}

/** Bind only an internally assembled snapshot of this DB's broker grant. */
export function withCtraderTokenSource(db, creds) {
  if (typeof creds?.resolveAccessToken === 'function') return creds
  const { accessToken, clientId, clientSecret } = creds
  const storedAccessToken = getState(db, 'ctrader_access_token')
  if (storedAccessToken) storedTokenSources.add(db)
  const sourceApp = clientId === ctraderEnv('clientId') && clientSecret === ctraderEnv('clientSecret')
  return {
    ...creds,
    // Resolve at the queued send boundary; spreads retain this callback.
    // Explicit token/app overrides stay explicit. No account/host/roster
    // replacement and no mutation of the captured object is allowed.
    resolveAccessToken: (caller) => {
      if (caller && (caller.accessToken !== accessToken || caller.clientId !== clientId || caller.clientSecret !== clientSecret)) return caller.accessToken
      // An explicit other-app snapshot cannot borrow this DB grant. A
      // canonical app change must not pair its new token with the old app.
      if (!sourceApp) return caller?.accessToken ?? accessToken
      if (clientId !== ctraderEnv('clientId') || clientSecret !== ctraderEnv('clientSecret')) throw new Error('current cTrader application changed')
      const current = getState(db, 'ctrader_access_token')
      if (current) storedTokenSources.add(db)
      // Stored-auth removal cannot revive an older environment token.
      // Failed DB reads propagate instead of using the captured snapshot.
      const resolved = current || (!storedTokenSources.has(db) ? ctraderEnv('accessToken') : null)
      if (typeof resolved !== 'string' || !resolved.trim()) throw new Error('current cTrader access token unavailable')
      return resolved
    },
  }
}

// P2a: one gateway instance id per Node process — the ledger records which
// process redeemed a permit, so a restart between redeem and send is legible.
export const GATEWAY_INSTANCE = `node:${process.pid}:${Date.now().toString(36)}`

// WP-A (25-09-2026): `basis` defaults to null — admitEntry and reserveEntry
// derive it from the registered producer (lib/entry-producers.js), so a tick
// producer is never admitted as 'bar' by omission.
function entryFenceFor(db, accountId, { producerId, basis = null }) {
  const id = accountId != null ? String(accountId) : null
  return {
    producerId,
    entryAdmission: () => admitEntry(db, { accountId: id, producerId, basis }),
    entryLedger: {
      reserve: (o = {}) => reserveEntry(db, { accountId: id, producerId, basis, gatewayInstance: GATEWAY_INSTANCE, ...o }),
      redeem: (permitId) => redeemPermit(db, permitId),
      markSent: (intentId, o = {}) => markSent(db, intentId, o),
      resolve: (intentId, o = {}) => resolveIntent(db, intentId, o),
    },
  }
}

/**
 * P2a: the same fence + ledger for credentials a caller builds by hand
 * (loop.js autoTrade, the closed-market path). One rule, one place — a
 * hand-built creds object without this cannot place an entry once the
 * sidecar requires permits.
 */
export function attachEntryFence(db, creds, { producerId, basis = null }) {
  if (!producerId) return creds
  return { ...creds, ...entryFenceFor(db, creds?.accountId, { producerId, basis }) }
}

/**
 * V3 L2a (W5/W6, 25-09-2026): bind ONE order's context to the intent the
 * send reserves. exec-engine.placeOrder reserves the intent itself (through
 * `creds.entryLedger.reserve`), so the producer never sees its id and the
 * row it writes cannot name it. This wraps `reserve` for one order only:
 *   - `riskEventId` is written onto the intent row (entry_intents.risk_event_id),
 *     the approval the producer holds in hand;
 *   - `onReserved(intentId)` runs once the reservation succeeded, BEFORE
 *     anything is sent, so the caller can stamp the id on its own row.
 * A throwing `onReserved` never blocks the order: the link is a record, the
 * order is money. Creds with no ledger (no producerId, a test double) are
 * returned unchanged — exactly the order path they had.
 */
export function bindEntryIntent(creds, { riskEventId = null, onReserved = null } = {}) {
  const L = creds?.entryLedger
  if (!L || typeof L.reserve !== 'function') return creds
  const rid = riskEventId != null && Number.isFinite(Number(riskEventId)) ? Number(riskEventId) : null
  return {
    ...creds,
    entryLedger: {
      ...L,
      reserve: (o = {}) => {
        const r = L.reserve(rid != null ? { ...o, riskEventId: rid } : o)
        if (r?.ok && r.intentId && typeof onReserved === 'function') {
          try { onReserved(r.intentId, r) } catch { /* the link never blocks the send */ }
        }
        return r
      },
    },
  }
}

/**
 * Parse the stored symbol→symbolId map. Returns {} on missing or corrupt
 * state instead of throwing (a bad write must not take down every consumer).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Record<string, number>}
 */
export function getSymbolMap(db, creds = null) {
  // Codex · №12,171 · 2026-10-08; codex-footprint: selection is not map provenance.
  const accountId = creds?.accountId ?? getState(db, 'ctrader_account_id')
  if (accountId != null) return getAccountSymbolMap(db, accountId)?.map ?? {}
  // Unlinked read-only/legacy fixtures. Broker callers pass their account.
  const json = getState(db, 'symbol_id_map')
  if (!json) return {}
  try { return JSON.parse(json) } catch { return {} }
}

/**
 * The requested account's verified map, refreshed through its own broker
 * request when missing/stale. The legacy selected-account mirror is never
 * a source of account identity; it is updated only for the still-selected
 * account after a successful owned read.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<typeof getCtraderCreds>} creds
 * @returns {Promise<Record<string, number>>}
 */
export async function ensureSymbolMap(db, creds, deps = {}) {
  // Codex · №12,171 · 2026-10-08; codex-footprint: bind list/cache to the requested account.
  if (creds?.accountId == null) return {}
  const own = getAccountSymbolMap(db, creds.accountId)
  if (accountSymbolMapIsFresh(own, deps.now ?? Date.now())) {
    mirrorSelectedMap(db, creds.accountId, own.map)
    return own.map
  }
  if (!creds.ready) return own?.map ?? {}
  const map = await fetchAccountSymbolMap(db, creds, deps)
  // This is a selected-account mirror only. An awaited read for another
  // account, or one completing after selection changed, cannot replace it.
  mirrorSelectedMap(db, creds.accountId, map)
  return map
}

function mirrorSelectedMap(db, accountId, map) {
  if (Object.keys(map).length > 0 && String(getState(db, 'ctrader_account_id')) === String(accountId)) {
    setState(db, 'symbol_id_map', JSON.stringify(map))
  }
}

// ---------------------------------------------------------------------------
// PER-ACCOUNT SYMBOL IDS (03-09-2026). `symbol_id_map` is built once from the
// primary account and was applied to every account. cTrader symbol ids are
// per environment: measured 03-09 07:24 SGT, the momentum book read LLY.US at
// 6.56 and GD.US at 11.52 on ACCT-LIVE-1 (the demos: 1,159.32 and 363.69) —
// the ids the map held for those names belong to other instruments on the
// live account — and placed a live buy limit at 6.56. Every dispatch path now
// resolves the id from the ACCOUNT's own symbol list, fetched from that
// account and cached under `symbol_id_map:<accountId>`. The global map is
// retained only for unlinked legacy fixtures. A linked account whose own
// list cannot be verified is refused instead of trusting selection as proof
// of the global map's origin: a wrong instrument is worse than no order.
// ---------------------------------------------------------------------------

export const ACCOUNT_SYMBOL_MAP_TTL_MS = 24 * 3600_000

export function accountSymbolMapKey(accountId) { return `symbol_id_map:${String(accountId)}` }

/**
 * Is a stored account map young enough that resolveSymbolId answers from it
 * without re-reading the account's list? Past ACCOUNT_SYMBOL_MAP_TTL_MS, or
 * with no parseable builtAt, it is re-read. One predicate, shared with the
 * entry-hours gate (V3 S-8), so the gate judges the id this function places.
 */
export function accountSymbolMapIsFresh(own, now = Date.now()) {
  return !!(own && own.builtAt && (now - Date.parse(own.builtAt)) < ACCOUNT_SYMBOL_MAP_TTL_MS)
}

/** A stored map stamped by its account's writer: { map, builtAt }, otherwise null. */
export function getAccountSymbolMap(db, accountId) {
  if (accountId == null) return null
  const json = getState(db, accountSymbolMapKey(accountId))
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed.map !== 'object' || parsed.map == null || Array.isArray(parsed.map)) return null
    if (parsed.accountId == null || String(parsed.accountId) !== String(accountId)) return null
    return { map: parsed.map, builtAt: parsed.builtAt || null }
  } catch { return null }
}

/**
 * Fetch the account's own symbol list and persist it. Throws on a failed fetch.
 *
 * V3 K2 — the one writer of `symbol_id_map:<accountId>` reads THIS account's
 * list (`perAccount`: never the host-shared cache, which answers with whichever
 * account on the host was read first) and refuses a response that names
 * another account: nothing is written, the stored map stays as it was. The
 * record carries `accountId` — proof it came from that account's own read —
 * so a map written before K2 is recognisable and re-read once
 * (services/account-symbol-maps.js). `deps.now` (epoch ms, as resolveSymbolId
 * already takes it) dates `builtAt`; absent, the wall clock, as before.
 */
export async function fetchAccountSymbolMap(db, creds, deps = {}) {
  if (creds?.accountId == null || String(creds.accountId).trim() === '') throw new Error('account_identity_missing')
  const list = deps.wsGetSymbolsList ?? (await import('./ctrader-ws.js')).wsGetSymbolsList
  const { host, clientId, clientSecret, accessToken, accountId } = creds
  const data = await list(host, clientId, clientSecret, accessToken, accountId, undefined, { perAccount: true })
  if (data?.ctidTraderAccountId != null && String(data.ctidTraderAccountId) !== String(accountId)) {
    throw new Error(`account_identity_mismatch: the symbol list for …${String(accountId).slice(-4)} names …${String(data.ctidTraderAccountId).slice(-4)}`)
  }
  const map = {}
  for (const s of (data?.symbol || [])) {
    if (s.symbolName && s.symbolId != null) {
      const name = String(s.symbolName).toUpperCase(), id = Number(s.symbolId)
      if (!Number.isSafeInteger(id) || id <= 0 || (map[name] != null && Number(map[name]) !== id)) {
        throw new Error('account_symbol_list_invalid')
      }
      map[name] = s.symbolId
    }
  }
  if (Object.keys(map).length > 0) {
    const { setState } = await import('../db.js')
    const builtAt = new Date(Number.isFinite(deps.now) ? deps.now : Date.now()).toISOString()
    setState(db, accountSymbolMapKey(accountId), JSON.stringify({ builtAt, accountId: String(accountId), map }))
  }
  return map
}

/**
 * The broker symbol id for `symbol` ON THIS ACCOUNT.
 * @returns {Promise<{id:number|null, source:'account'|'account-stale'|'global'|'unverified'|'none', reason?:string}>}
 */
export async function resolveSymbolId(db, creds, symbol, deps = {}) {
  const key = String(symbol || '').toUpperCase()
  if (!key) return { id: null, source: 'none', reason: 'no symbol' }
  const acct = creds?.accountId != null ? String(creds.accountId) : null
  const short = acct ? `…${acct.slice(-4)}` : 'n/a'
  const notListed = (source) => ({ id: null, source, reason: `symbol_not_on_account: ${symbol} is not in ${short}'s symbol list` })
  let fetchErr = null
  if (acct) {
    const own = getAccountSymbolMap(db, acct)
    const now = deps.now ?? Date.now()
    const fresh = accountSymbolMapIsFresh(own, now)
    if (fresh) return own.map[key] != null ? { id: own.map[key], source: 'account' } : notListed('account')
    // A fetch needs a broker link: credentials on the creds AND a primary
    // account recorded (no primary = no linked broker = a test fixture; the
    // fixtures hand-build creds and must never reach the network).
    const canFetch = creds.ready !== false && creds.clientId && creds.accessToken && creds.host && getState(db, 'ctrader_account_id') != null
    if (canFetch) {
      try {
        const m = await fetchAccountSymbolMap(db, creds, deps)
        if (Object.keys(m).length > 0) return m[key] != null ? { id: m[key], source: 'account' } : notListed('account')
        fetchErr = 'empty symbol list'
      } catch (e) { fetchErr = e?.message || String(e) }
    }
    if (own) return own.map[key] != null ? { id: own.map[key], source: 'account-stale' } : notListed('account-stale')
    // A linked broker read that failed identity/availability verification
    // cannot be downgraded into permission to use the unowned legacy mirror.
    if (canFetch) return { id: null, source: 'unverified', reason: `symbol_map_unverified: no symbol list for ${short}${fetchErr ? ` (${fetchErr})` : ''} and no verified account cache` }
  }
  // The global map belongs to the account it was built from.
  const primary = getState(db, 'ctrader_account_id')
  if (acct == null || primary == null || String(primary) === acct) {
    const g = getSymbolMap(db)
    return g[key] != null
      ? { id: g[key], source: 'global' }
      : { id: null, source: 'global', reason: `symbol_id_unknown: ${symbol} is not in symbol_id_map — call POST /actions/symbol-map to register it` }
  }
  return {
    id: null, source: 'unverified',
    reason: `symbol_map_unverified: no symbol list for ${short}${fetchErr ? ` (${fetchErr})` : ''} and the global map belongs to …${String(primary).slice(-4)}`,
  }
}
