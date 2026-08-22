// ---------------------------------------------------------------------------
// agent/lib/ctrader-env.js — spelling-tolerant cTrader env var lookup.
//
// Users configure hosts with every imaginable spelling (CTRADER_CLIENT_ID,
// cTrader_ClientID, cTrader_Client_ID, cTrader_Secret, ...). Env vars are
// case-sensitive, so instead of chasing spellings we normalize every key
// (lowercase, separators stripped) and match against known aliases.
//
// Dependency-free on purpose: imported by both the agent and the Vercel
// serverless proxy (api/ctrader.js, retired 2026-08-22), which must not pull
// in better-sqlite3. The constraint outlives the file: this module is still
// imported by browser-facing code paths.
//
// WHY THERE IS A REPORT AS WELL AS A LOOKUP (2026-08-22). The owner asked
// "I have so many cTrader variables, which one is actual?" and nothing in the
// system could answer: the lookup returned a value and named nothing. Worse,
// two spellings of the same slot — `CTRADER_CLIENT_SECRET` and
// `CTRADER_SECRET` are BOTH accepted for the client secret — resolved by
// whichever `Object.entries(process.env)` happened to yield first. That is a
// silent, arbitrary choice between two different secrets, and the only
// symptom is an "Access denied" from Spotware that names nothing either.
//
// So: selection is now DETERMINISTIC (candidates sorted by key), and
// ctraderEnvReport() states which variable filled each slot and whether any
// slot had candidates that disagree. Values are never returned by the report
// or logged — only names, and a boolean for "these disagree".
// ---------------------------------------------------------------------------

const ALIASES = {
  clientId:     ['ctraderclientid'],
  clientSecret: ['ctraderclientsecret', 'ctradersecret'],
  accessToken:  ['ctraderaccesstoken'],
  refreshToken: ['ctraderrefreshtoken'],
  accountId:    ['ctraderaccountid'],
  isLive:       ['ctraderislive'],
}

/** Every env var name this lookup understands, for diagnostics. */
export const CTRADER_ENV_KINDS = Object.keys(ALIASES)

const normalize = (key) => String(key).toLowerCase().replace(/[_-]/g, '')

/**
 * All env entries matching one kind, sorted by variable name.
 *
 * SORTED, not enumeration-ordered: `Object.entries(process.env)` yields
 * insertion order, so with two matching variables the winner depended on the
 * order the platform happened to set them — the same config could resolve
 * differently on two boots. Sorting makes the choice reproducible, which is
 * the minimum a credential lookup owes its operator.
 *
 * @returns {Array<[string, string]>} [name, value] pairs
 */
function matchesFor(kind, env = process.env) {
  const targets = ALIASES[kind] || []
  const found = []
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue
    if (targets.includes(normalize(key))) found.push([key, value])
  }
  return found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

/**
 * Find a cTrader env value by kind, tolerant of any capitalization and
 * underscore/dash placement in the variable name.
 *
 * @param {'clientId'|'clientSecret'|'accessToken'|'refreshToken'|'accountId'|'isLive'} kind
 * @returns {string|undefined}
 */
export function ctraderEnv(kind, env = process.env) {
  const found = matchesFor(kind, env)
  return found.length ? found[0][1] : undefined
}

/**
 * Which variable filled each slot, and whether anything is ambiguous.
 *
 * NAMES ONLY — no values, ever. This is written to the boot log, and a
 * credential that reaches a log is a credential that has leaked. `conflict`
 * is the one bit of value-derived information it exposes: whether the
 * candidates for a slot disagree with each other, which is the whole point.
 *
 * @returns {Array<{kind:string, chosen:string|null, names:string[], conflict:boolean}>}
 */
export function ctraderEnvReport(env = process.env) {
  return CTRADER_ENV_KINDS.map(kind => {
    const found = matchesFor(kind, env)
    const distinct = new Set(found.map(([, v]) => v))
    return {
      kind,
      chosen: found.length ? found[0][0] : null,
      names: found.map(([k]) => k),
      conflict: distinct.size > 1,
    }
  })
}
