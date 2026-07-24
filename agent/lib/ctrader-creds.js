// ---------------------------------------------------------------------------
// agent/lib/ctrader-creds.js — single source for cTrader credential assembly
// and the symbol→symbolId map, both previously copy-pasted across loop.js and
// routes/actions.js.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { ctraderEnv } from './ctrader-env.js'

/**
 * Assemble cTrader connection credentials from env + agent state.
 * `accountOverride` ({accountId, isLive}) supports multi-account autopilot.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{accountId?: string|number, isLive?: boolean}} [accountOverride]
 * @returns {{host: string, clientId: string|undefined, clientSecret: string|undefined, accessToken: string|null, accountId: string|null, ready: boolean}}
 */
export function getCtraderCreds(db, accountOverride) {
  const clientId = ctraderEnv('clientId')
  const clientSecret = ctraderEnv('clientSecret')
  const accessToken = getState(db, 'ctrader_access_token') || ctraderEnv('accessToken')
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

  return {
    host: isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com',
    clientId,
    clientSecret,
    accessToken,
    accountId,
    accountIds,
    execGuard: execGuard && typeof execGuard === 'object' ? execGuard : null,
    ready: !!(clientId && clientSecret && accessToken && accountId),
  }
}

/**
 * Parse the stored symbol→symbolId map. Returns {} on missing or corrupt
 * state instead of throwing (a bad write must not take down every consumer).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Record<string, number>}
 */
export function getSymbolMap(db) {
  const json = getState(db, 'symbol_id_map')
  if (!json) return {}
  try { return JSON.parse(json) } catch { return {} }
}

/**
 * Like getSymbolMap, but self-healing: when the map is missing/empty and
 * credentials are ready, download the broker's light symbol list, persist
 * the map, and return it. Removes the "link account before anything else"
 * ordering requirement (a DB wipe or fresh boot no longer breaks charts,
 * backtests, or streams).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<typeof getCtraderCreds>} creds
 * @returns {Promise<Record<string, number>>}
 */
export async function ensureSymbolMap(db, creds) {
  const existing = getSymbolMap(db)
  if (Object.keys(existing).length > 0) return existing
  if (!creds?.ready) return existing
  const { wsGetSymbolsList } = await import('./ctrader-ws.js')
  const { host, clientId, clientSecret, accessToken, accountId } = creds
  const data = await wsGetSymbolsList(host, clientId, clientSecret, accessToken, accountId)
  const map = {}
  for (const s of (data.symbol || [])) {
    if (s.symbolName && s.symbolId != null) map[String(s.symbolName).toUpperCase()] = s.symbolId
  }
  if (Object.keys(map).length > 0) {
    const { setState } = await import('../db.js')
    setState(db, 'symbol_id_map', JSON.stringify(map))
  }
  return map
}
