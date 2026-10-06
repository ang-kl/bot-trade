// ---------------------------------------------------------------------------
// agent/services/trail-status-view.js — what the C++ TrailEngine on one
// gateway holds RIGHT NOW (07-10-2026, Claude · № 11,596·D·1, ordered
// № 11,583·D·1; claude-builder).
//
// GET /state/trail-status?account=<id> answers from this. The engine's set is
// one per gateway — every account on that side — so this is a SIDE's view,
// reached through one account's credentials (host, roster). Read-only. The
// engine answers {enabled:false} when TRAIL_TICK_ENABLED is unset; a non-cpp
// exec mode never reaches it; `execMode` says which, so a reader can tell
// "off" from "down" from "not asked".
//
// Why it exists: the since-entry Chandelier trail was verified on 06-10 as
// "Not Verifiable" engine-side — Node pushes specs, nothing outside the
// gateway's own secret could read back what it held. This closes that gap
// for the owner, the website and the verifier alike.
// ---------------------------------------------------------------------------

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} accountId  registered account, or null for the selected one
 * @returns {Promise<{status:number, body:object}>}
 */
export async function trailStatusView(db, accountId, deps = {}) {
  const credsLib = deps.credsLib ?? await import('../lib/ctrader-creds.js')
  const exec = deps.exec ?? await import('../lib/exec-engine.js')
  const id = accountId != null && accountId !== '' ? String(accountId) : null
  if (id && !/^[1-9]\d*$/.test(id)) return { status: 400, body: { error: 'explicit registered account required' } }
  const creds = id ? credsLib.credsForRegisteredAccount(db, id) : credsLib.getCtraderCreds(db)
  if (id && !creds) return { status: 400, body: { error: 'explicit registered account required' } }
  if (!creds?.ready) {
    return { status: 503, body: { error: 'no broker credentials', account: creds?.accountId != null ? String(creds.accountId) : null } }
  }
  const execMode = exec.execEngineMode()
  const status = execMode === 'cpp'
    ? await exec.getTrailStatus(creds, { timeoutMs: deps.timeoutMs ?? 5_000 })
    : { enabled: false }
  return {
    status: 200,
    body: {
      account: String(creds.accountId),
      side: creds.isLive ? 'live' : 'demo',
      execMode,
      // The last refused push to this gateway, named (exec-engine.js), or null.
      lastPushRefusal: typeof exec.lastTrailConfigRefusal === 'function' ? exec.lastTrailConfigRefusal(creds) : null,
      ...(status && typeof status === 'object' ? status : { enabled: false }),
    },
  }
}
