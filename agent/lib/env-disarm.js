// ---------------------------------------------------------------------------
// agent/lib/env-disarm.js — refuse to trade from the staging environment.
//
// 26-08-2026, the token war: production and the staging clone share ONE
// cTrader OAuth grant, so every refresh by one invalidates the other's access
// token. After #770 gave both sides reactive refresh, they invalidated each
// other within seconds and every controller stalled. The owner ordered the
// staging agent stopped ("stop it") — and because staging auto-deploys every
// merge to main, stopping its deployment by hand only lasts until the next
// merge. This guard is the durable version: the code itself refuses to arm
// when it finds itself booted into the staging environment, so the very
// deploy that would revive staging boots it inert instead.
//
// Two checks, both from Railway-injected variables: the staging environment's
// ID (pinned exactly — production 7bc0dfc6… can never match), and the
// environment NAME "staging" so a recreated staging environment with a fresh
// ID is still caught. Anything else — production, local dev, tests, CI —
// sees both empty and arms normally: the guard can only ever bite an
// environment that Railway itself labels as staging.
//
// Escape hatch: ALLOW_STAGING_TRADING=1 re-arms without a code change, for
// the day staging gets its OWN OAuth grant and is safe to run again.
// ---------------------------------------------------------------------------

const STAGING_ENVIRONMENT_ID = '373ac7e0-c627-4c83-908b-ef8e042e2fc6'

/**
 * Returns a human-readable reason the agent must stay disarmed in this
 * environment, or null when it is safe to arm. Pass an env object in tests;
 * defaults to process.env.
 */
export function disarmReason(env = process.env) {
  if (env.ALLOW_STAGING_TRADING === '1') return null
  if (env.RAILWAY_ENVIRONMENT_ID === STAGING_ENVIRONMENT_ID) {
    return `staging environment ${STAGING_ENVIRONMENT_ID} — shares the production cTrader grant; trading and token refresh disabled (set ALLOW_STAGING_TRADING=1 only after staging has its own grant)`
  }
  if ((env.RAILWAY_ENVIRONMENT_NAME || '').toLowerCase() === 'staging') {
    return `environment named "${env.RAILWAY_ENVIRONMENT_NAME}" — shares the production cTrader grant; trading and token refresh disabled (set ALLOW_STAGING_TRADING=1 only after staging has its own grant)`
  }
  return null
}
