// agent/lib/llm-switch.js — one place that answers "may we call a model?"
//
// Owner (09-08-2026): "i want the trading bot to runs 24/7 without credit from
// AI needed."
//
// It already does. Nothing in the scan, the entry decision, the risk gate,
// sizing or any stop/target adjustment calls a model — the only LLM consumers
// are the position monitor, the weekend watch, and two on-demand UI helpers.
// So this module does not make the bot survive without AI; it makes the bot
// STOP PRETENDING TO TRY.
//
// THE DIFFERENCE MATTERS, and it is the whole reason this exists. With an
// exhausted balance the monitor still fires ~1,900 times a day, each call
// throwing a 401 into loop.js's catch, each throw incrementing a failure
// streak, raising a Telegram alert and leaving `api_anthropic_last_ok` stale.
// The operator then reads a panel full of red that describes a decision they
// made on purpose. That is the same defect as a controller stuck in ERROR
// (#694): an alarm that cannot be cleared teaches you to stop reading alarms.
//
// Disabled is therefore a FIRST-CLASS STATE, not an error state: the call is
// never attempted, no failure is recorded, and the health signal says "off"
// rather than "broken".
//
// TWO WAYS TO SET IT, on purpose:
//   · env `LLM_DISABLED=1` — survives a wiped database, needs a redeploy.
//   · state key `llm_disabled` — flippable at runtime without a restart.
// Either one alone disables. Nothing here can ENABLE what the env has turned
// off, so the env is the durable brake and the state key is the fast one.

/** Values that count as "yes, disabled". Anything else is enabled. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'disabled'])

/**
 * Pure verdict: is the LLM layer switched off?
 *
 * `Number(null)` is 0 and `Boolean('false')` is true — both traps this
 * function has to survive, because the state key arrives as a string from
 * SQLite and the env arrives as a string from the process. So the test is an
 * explicit membership check on a normalised string, never a coercion.
 *
 * @param {string|null|undefined} stateValue value of the `llm_disabled` key
 * @param {object} [env] process env (injected for tests)
 * @returns {boolean}
 */
export function llmDisabledFrom(stateValue, env = process.env) {
  const norm = (v) => TRUTHY.has(String(v ?? '').trim().toLowerCase())
  return norm(env?.LLM_DISABLED) || norm(stateValue)
}

/**
 * DB-backed convenience for the call sites.
 *
 * A read failure returns FALSE — enabled. That direction is deliberate and it
 * is the opposite of the fail-safe used elsewhere in this codebase: a
 * SQLITE_BUSY must not silently switch off position review. Losing the second
 * opinion because a read blipped is a worse outcome than one wasted API call,
 * and the env brake still holds regardless of the database.
 */
export function llmDisabled(db, getState, env = process.env) {
  let raw = null
  try { raw = getState(db, 'llm_disabled') } catch { raw = null }
  return llmDisabledFrom(raw, env)
}

/**
 * The boot line, as a value rather than a side effect.
 *
 * Extracted so it can be TESTED BY CALLING IT. The first version of this lived
 * inline in index.js and its tests matched the source text — and an unanchored
 * substring match survives `if (cond && false)`, so a banner that could never
 * print would have kept the suite green. CLAUDE.md #1 and #2 in one line of
 * code.
 *
 * Returns null when the LLM is enabled: an enabled agent must print nothing,
 * or the banner becomes noise and stops being read.
 */
export function llmBootBannerLine(db, getState, env = process.env) {
  const why = llmDisabledReason(db, getState, env)
  if (!why) return null
  return `[agent] LLM: DISABLED by ${why} — no LLM calls will be attempted `
    + '(position monitor, weekend watch, cockpit explain, screener search, Re-Risk). '
    + 'Deterministic trading is unaffected; API keys are untouched.'
}

/** Where the switch was set, for the health panel. null when enabled. */
export function llmDisabledReason(db, getState, env = process.env) {
  const norm = (v) => TRUTHY.has(String(v ?? '').trim().toLowerCase())
  if (norm(env?.LLM_DISABLED)) return 'LLM_DISABLED env var'
  let raw = null
  try { raw = getState(db, 'llm_disabled') } catch { raw = null }
  if (norm(raw)) return 'llm_disabled state key'
  return null
}

/**
 * THE ONE ANSWER TO "MAY WE CALL A MODEL?" — the switch OR the daily ceiling.
 *
 * Kept as a third function rather than folded into `llmDisabled` because the
 * two are different in kind and the difference is operationally load-bearing:
 * the switch is a standing decision, the cap is a condition that clears itself
 * at midnight UTC. A panel that showed them as one state would leave the owner
 * unable to tell "I turned this off" from "it spent its allowance today", and
 * only one of those is worth acting on.
 *
 * Async because the spend read pulls in the pricing table; every call site here
 * is already async.
 */
export async function llmBlocked(db, getState, env = process.env) {
  if (llmDisabled(db, getState, env)) {
    return { blocked: true, kind: 'switch', reason: llmDisabledReason(db, getState, env) }
  }
  try {
    const { spendCapState } = await import('../services/llm-spend.js')
    const s = spendCapState(db)
    if (s.exceeded) {
      return {
        blocked: true,
        kind: 'spend_cap',
        reason: `daily LLM spend cap reached — $${s.spent.toFixed(2)} of $${s.cap.toFixed(2)} (resets ${s.day} 00:00 UTC)`,
      }
    }
  } catch {
    // Same fail-open direction as the state read above: an unreadable ledger
    // must not silence position review.
  }
  return { blocked: false, kind: null, reason: null }
}
