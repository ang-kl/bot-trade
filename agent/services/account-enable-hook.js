// ---------------------------------------------------------------------------
// agent/services/account-enable-hook.js
//
// Claude · № 15,286 17-Oct (audit finding A; claude-builder). The account
// writers (registry, capabilities, arming, the account-list push) call this
// after any transition that leaves an account ENABLED; boot (index.js)
// registers the declared strategy policy here.
//
// A hook, not an import, on purpose: importing stage-matrix.js from the
// account writers put it on the research modules' import graph (the isolation
// test refuses it) and created an async module cycle that crashed V8 in
// report-unavailable.test.js. This module imports nothing.
// ---------------------------------------------------------------------------
let hook = null

export function setAccountEnableHook(fn) {
  hook = typeof fn === 'function' ? fn : null
}

/** Never throws; the enable itself must not fail for a policy write. */
export function runAccountEnableHook(db, reason) {
  if (!hook) return null
  try {
    return hook(db, { reason })
  } catch (err) {
    console.log(`[accounts] enable hook failed (${reason}): ${err?.message || err}`)
    return null
  }
}
