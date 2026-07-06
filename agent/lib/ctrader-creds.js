// ---------------------------------------------------------------------------
// agent/lib/ctrader-creds.js — single source for cTrader credential assembly
// and the symbol→symbolId map, both previously copy-pasted across loop.js and
// routes/actions.js.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

/**
 * Assemble cTrader connection credentials from env + agent state.
 * `accountOverride` ({accountId, isLive}) supports multi-account autopilot.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{accountId?: string|number, isLive?: boolean}} [accountOverride]
 * @returns {{host: string, clientId: string|undefined, clientSecret: string|undefined, accessToken: string|null, accountId: string|null, ready: boolean}}
 */
export function getCtraderCreds(db, accountOverride) {
  const clientId = process.env.CTRADER_CLIENT_ID || process.env.cTrader_Client_ID
  const clientSecret = process.env.CTRADER_CLIENT_SECRET || process.env.cTrader_Client_Secret
  const accessToken = getState(db, 'ctrader_access_token')
    || process.env.CTRADER_ACCESS_TOKEN || process.env.cTrader_Access_Token
  const accountId = accountOverride?.accountId || getState(db, 'ctrader_account_id')
    || process.env.CTRADER_ACCOUNT_ID || process.env.cTrader_Account_ID
  const isLive = accountOverride
    ? !!accountOverride.isLive
    : getState(db, 'ctrader_is_live') === 'true'

  return {
    host: isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com',
    clientId,
    clientSecret,
    accessToken,
    accountId,
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
