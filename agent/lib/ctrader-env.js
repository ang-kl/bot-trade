// ---------------------------------------------------------------------------
// agent/lib/ctrader-env.js — spelling-tolerant cTrader env var lookup.
//
// Users configure hosts with every imaginable spelling (CTRADER_CLIENT_ID,
// cTrader_ClientID, cTrader_Client_ID, cTrader_Secret, ...). Env vars are
// case-sensitive, so instead of chasing spellings we normalize every key
// (lowercase, separators stripped) and match against known aliases.
//
// Dependency-free on purpose: imported by both the agent and the Vercel
// serverless proxy (api/ctrader.js), which must not pull in better-sqlite3.
// ---------------------------------------------------------------------------

const ALIASES = {
  clientId:     ['ctraderclientid'],
  clientSecret: ['ctraderclientsecret', 'ctradersecret'],
  accessToken:  ['ctraderaccesstoken'],
  refreshToken: ['ctraderrefreshtoken'],
  accountId:    ['ctraderaccountid'],
  isLive:       ['ctraderislive'],
}

/**
 * Find a cTrader env value by kind, tolerant of any capitalization and
 * underscore/dash placement in the variable name.
 *
 * @param {'clientId'|'clientSecret'|'accessToken'|'refreshToken'|'accountId'|'isLive'} kind
 * @returns {string|undefined}
 */
export function ctraderEnv(kind) {
  const targets = ALIASES[kind] || []
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue
    const norm = key.toLowerCase().replace(/[_-]/g, '')
    if (targets.includes(norm)) return value
  }
  return undefined
}
