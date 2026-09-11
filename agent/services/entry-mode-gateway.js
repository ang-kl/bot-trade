// ---------------------------------------------------------------------------
// agent/services/entry-mode-gateway.js — what happens AFTER an entry-mode
// switch is written: the gateway learns the new epoch now, not on the next
// probe (AUDIT 11-09-2026, plan §3.1 / §3.6, TM-10).
//
// Extracted from POST /actions/entry-mode in PR-G (owner principle 2) so the
// human route and the bot's readiness pass (entry-mode-auto.js) bind the
// epoch the same way: the guard push carries every account's epoch and the
// sidecar's reply echoes what it bound — the acknowledgement (WARMING →
// STABLE for an active mode); the VPO tier is disarmed on the same breath for
// any mode but TIME_BASED so the old arming and its standing permits cannot
// fire after the switch; a push that fails leaves the account BLOCKED with
// entries stopped — visibly, never a silent fall-back.
//
// `deps` is injectable so the behaviour is testable without a sidecar; the
// defaults are the production modules, loaded lazily (the routes module is
// heavy and imports this one).
// ---------------------------------------------------------------------------
import { engineStatusFor, markEntryModeBlocked } from './entry-mode.js'

async function defaultDeps() {
  const [{ sideForAccount, sideCreds }, { syncExecGuard }, execMod, { pushVpoDisarm }, { credsForAccountId }] = await Promise.all([
    import('./heartbeat.js'),
    import('./exec-guard-sync.js'),
    import('../lib/exec-engine.js'),
    import('./vpo-feeder.js'),
    import('../routes/actions.js'),
  ])
  return { sideForAccount, sideCreds, syncExecGuard, execMod, execBaseFor: execMod.execBaseFor, pushVpoDisarm, credsForAccountId, markEntryModeBlocked }
}

/**
 * Push the guard (force) for the account's side, disarm the VPO tier unless
 * the new mode is TIME_BASED, and mark the account BLOCKED when the push is
 * not made. Returns `{ gateway, status }` — `gateway` is what the route has
 * always answered, `status` the record re-read after the push.
 */
export async function bindEntryModeGateway(db, accountId, mode, { epoch = null, deps = null } = {}) {
  const id = String(accountId)
  const want = String(mode).toUpperCase()
  let gateway = null
  try {
    const d = deps || await defaultDeps()
    const side = d.sideForAccount(db, d.execMod, id)
    const creds = side ? await d.sideCreds(db, side) : null
    if (side && creds?.ready) {
      const sync = await d.syncExecGuard(db, d.execMod, side, { reportedGuard: null, creds, force: true })
      gateway = { side: side.name, pushed: sync.pushed, acked: sync.acked || [], error: sync.error || null }
      if (sync.error || !sync.pushed) d.markEntryModeBlocked(db, id, sync.error || 'guard push not made')
      if (want !== 'TIME_BASED') {
        const acctCreds = d.credsForAccountId(db, id)
        gateway.vpoDisarm = await d.pushVpoDisarm(db, id, d.execBaseFor(acctCreds?.ready ? acctCreds : creds), { reason: `entry_mode ${want}`, epoch })
      }
    } else {
      gateway = { side: side?.name || null, pushed: false, error: 'no credentials for the account\'s side' }
      d.markEntryModeBlocked(db, id, gateway.error)
    }
  } catch (err) {
    gateway = { pushed: false, error: err.message }
  }
  return { gateway, status: engineStatusFor(db, id) }
}
