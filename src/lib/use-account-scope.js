// useAccountScope — every component that renders account-dependent data
// DECLARES what it is showing, and the declaration is what makes the dot, the
// register and the lint possible.
//
// Owner, 2026-08-03: "if the component doesn't tied to the account, it must be
// flagged or fail to get the data/computed table must also flagged with reason
// as a logged register to be build".
//
// WHY A DECLARATION AND NOT A DETECTOR. The two failures that started this
// work were both invisible to inspection:
//
//   · the Go-Live Gate card showed six per-account panels, all six drawing the
//     same 245 pooled trades, one of them labelled LIVE;
//   · the per-position loss cap ran with scope:'all' and swept exactly one
//     account, while a USDZAR position ran to -$2,186 against an $800 cap.
//
// Neither was caught by reading the screen, because a wrong number and a right
// number look identical. A component cannot be checked against an intention it
// never stated — so it states one.
//
// S2 scope: the hook and the dot. No behaviour changes, nothing is hidden, and
// no component is required to call this yet. S4 adopts it across the pages and
// S6 turns the lint on; turning the lint on before adoption would just make
// the build red on day one.

import { useMemo } from 'react'
import { selectedAccountId } from './selected-account.js'

/** The three honest answers to "whose data is this?" */
export const MODES = Object.freeze({
  /** Must be filtered to the selected account. The default. */
  ACCOUNT: 'account',
  /** Deliberately account-independent — stage settings, market data, health. */
  GLOBAL: 'global',
  /** Deliberately spans accounts — the "All accounts" roll-up. */
  PORTFOLIO: 'portfolio',
})

const VALID_MODES = new Set(Object.values(MODES))

/**
 * State → dot tone. FOUR tones, per the owner's decision on 2026-08-03:
 * blue = ok, grey = declared global, amber = below 100%, red = failed.
 *
 * Blue rather than green is not a style choice. The owner is red/green
 * colour-blind and `npm run check:no-green` fails the build on green tokens.
 */
export const TONE_BY_STATE = Object.freeze({
  ok: 'blue',
  global: 'grey',
  portfolio: 'grey',
  partial: 'amber',
  unscoped: 'amber',
  failed: 'red',
})

/**
 * Derive the scope state from a route payload. PURE — no React, no globals —
 * so the rules are testable without rendering anything, which is the half that
 * actually needs pinning.
 *
 * @param {object} arg
 * @param {string} arg.id           stable component id, the register key
 * @param {string} arg.mode         'account' | 'global' | 'portfolio'
 * @param {object|null} arg.payload the route response; reads its `scope` block
 * @param {boolean} arg.failed      the fetch itself failed
 * @param {string|null} arg.error   why it failed
 * @param {number|null} arg.covers  optional override: attributable fraction 0-100
 * @param {string|null} arg.selected the account the sidebar is on
 * @returns {{id, mode, state, tone, reason, pct, total, attributable, accountId}}
 */
export function deriveScopeState({
  id,
  mode = MODES.ACCOUNT,
  payload = null,
  failed = false,
  error = null,
  covers = null,
  selected = null,
} = {}) {
  const out = {
    id,
    mode,
    state: 'ok',
    tone: 'blue',
    reason: null,
    pct: null,
    total: null,
    attributable: null,
    accountId: null,
  }

  // A typo in the mode must not read as a healthy component. It is the same
  // failure the whole mechanism exists to catch, one level up.
  if (!VALID_MODES.has(mode)) {
    return { ...out, state: 'unscoped', tone: 'amber', mode: MODES.ACCOUNT, reason: `unknown mode "${mode}"` }
  }

  // A FAILED FETCH IS RED EVEN FOR A GLOBAL COMPONENT. "I could not load this"
  // is not made acceptable by the data being account-independent — during the
  // 2026-07-29 broker outage a panel that went quiet read as "all clear", and
  // silence at exactly the wrong moment is worse than never having built it.
  if (failed) {
    return { ...out, state: 'failed', tone: 'red', reason: error || 'fetch failed' }
  }

  const sc = payload?.scope || null
  out.accountId = sc?.account ?? payload?.accountId ?? selected ?? null

  if (mode === MODES.GLOBAL || mode === MODES.PORTFOLIO) {
    return {
      ...out,
      state: mode,
      tone: 'grey',
      reason: mode === MODES.GLOBAL
        ? 'declared global — these figures apply to every account'
        : 'declared portfolio — spans every enabled account',
    }
  }

  // mode === 'account' from here.

  // A component that claims per-account data from a route that cannot scope is
  // the Go-Live-card class exactly. Naming the route makes it actionable
  // instead of a mood.
  if (!sc) {
    return {
      ...out,
      state: 'unscoped',
      tone: 'amber',
      reason: 'renders account data but the route reported no scope',
    }
  }

  const pct = covers != null ? covers : sc.coverage?.pct
  out.total = sc.coverage?.total ?? null
  out.attributable = sc.coverage?.attributable ?? null

  // null pct is UNKNOWN, never healthy — scopeCoverage() degrades to null when
  // its query throws, and a coverage signal that fails OPEN is the failure it
  // exists to catch.
  if (pct == null) {
    return { ...out, state: 'unscoped', tone: 'amber', reason: 'coverage unknown' }
  }

  out.pct = pct

  // Below 100% is amber WITH THE NUMBER (owner's decision). "87% of 253 rows
  // attributable" is the sentence that would have caught the morning card; a
  // colour on its own would not have.
  if (pct < 100) {
    return {
      ...out,
      state: 'partial',
      tone: 'amber',
      reason: out.total != null
        ? `${pct}% of ${out.total.toLocaleString()} rows attributable to this account`
        : `${pct}% attributable`,
    }
  }

  return { ...out, state: 'ok', tone: 'blue', reason: null }
}

/**
 * The React wrapper. Thin on purpose — every rule lives in deriveScopeState.
 *
 * @example
 *   const scope = useAccountScope({ id: 'perf.strategy-matrix', mode: 'account', payload: data })
 *   <ScopeDot scope={scope} />
 */
export function useAccountScope({ id, mode = MODES.ACCOUNT, payload = null, failed = false, error = null, covers = null } = {}) {
  const selected = selectedAccountId()
  return useMemo(
    () => deriveScopeState({ id, mode, payload, failed, error, covers, selected: selected ?? null }),
    [id, mode, payload, failed, error, covers, selected],
  )
}
