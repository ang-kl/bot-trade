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

// ---------------------------------------------------------------------------
// WHY THERE IS A STATUS FUNCTION AS WELL AS A REPORT (2026-08-22).
//
// The report above is written to the BOOT LOG, and a boot log is only a
// diagnostic for whoever can read it. Measured the same day: the Railway
// connector dropped, #743 deployed and ran, and the lines it prints —
// the ones that answer "which variable is actual" and "is the env value
// being ignored" — were unreadable from here. A diagnostic out of reach of
// the person asking the question is failure mode #3 wearing a different hat.
//
// So the same facts are computed once, here, and served over HTTP as well.
// Still names only: `stored`/`envIgnored` are booleans derived from values
// that never leave this function.
// ---------------------------------------------------------------------------

/**
 * The three slots env only ever SEEDS: once agent_state holds a value, the
 * stored copy wins and the env var is inert. Kept beside the resolver so the
 * two cannot drift — index.js seeds exactly these keys.
 */
export const ENV_SEEDED_STATE_KEYS = Object.freeze({
  accessToken: 'ctrader_access_token',
  refreshToken: 'ctrader_refresh_token',
  accountId: 'ctrader_account_id',
})

/**
 * Per-slot resolution status, including whether the env value is being
 * ignored in favour of a stored one.
 *
 * @param {object} opts
 * @param {object} [opts.env] process.env by default
 * @param {(key:string)=>string|undefined|null} [opts.stored] agent_state reader
 * @returns {Array<{kind:string, chosen:string|null, names:string[],
 *   conflict:boolean, stateKey:string|null, stored:boolean|null,
 *   envIgnored:boolean}>}
 */
export function ctraderEnvStatus({ env = process.env, stored = () => undefined } = {}) {
  return ctraderEnvReport(env).map(r => {
    const stateKey = ENV_SEEDED_STATE_KEYS[r.kind] ?? null
    if (!stateKey) return { ...r, stateKey: null, stored: null, envIgnored: false }
    const storedValue = stored(stateKey)
    const has = Boolean(storedValue)
    const envValue = ctraderEnv(r.kind, env)
    // IGNORED means specifically: env holds something, the database holds
    // something ELSE, and the database copy is the one in use. Env holding
    // the same value is not being ignored — it is simply redundant.
    return {
      ...r,
      stateKey,
      stored: has,
      envIgnored: Boolean(envValue) && has && String(storedValue) !== String(envValue),
    }
  })
}
