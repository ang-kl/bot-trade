// ---------------------------------------------------------------------------
// agent/services/declared-strategy-policy.js
//
// Claude · № 15,286 17-Oct (owner: "A: OFF policy on runtime enable";
// independent audit finding A / Codex P1 on #1392; claude-builder).
//
// The repo's declared strategy policy (config/strategy-pins.json: `_all`,
// `_off`, `_reseed_all`, per-id keys) is applied by seedStrategyPinsFromConfig,
// and only at boot. An account ENABLED at runtime (the registry route, a
// selection, an unarchive, an arm, an account-list push) follows the global
// list until the next restart — and the global list can carry a strategy the
// owner switched off (16-10 18:54Z the nightly autopilot re-armed ema_pullback
// globally). So every enable transition applies the same seed, now.
//
// The seed is seed-once per account and entry (strategy_pins_seeded_json): an
// account already seeded is untouched, so a later owner cell or guard disarm
// stands. Never throws; the enable itself must not fail for a policy read.
// ---------------------------------------------------------------------------
import { getState, setState } from '../db.js'
import { seedStrategyPinsFromConfig } from './stage-matrix.js'

export function applyDeclaredStrategyPolicy(db, { reason = 'account enabled', log = (m) => console.log(m), file = null } = {}) {
  try {
    const out = seedStrategyPinsFromConfig(db, { getState, setState }, { log, ...(file ? { file } : {}) })
    if (out.error) log(`[accounts] declared strategy policy not applied (${reason}): ${out.error}`)
    else if (out.applied.length || out.off?.length) log(`[accounts] declared strategy policy (${reason}): ${out.applied.length} pinned on, ${out.off?.length || 0} switched off`)
    return out
  } catch (err) {
    log(`[accounts] declared strategy policy failed (${reason}): ${err?.message || err}`)
    return { error: String(err?.message || err), applied: [], off: [], unchanged: [], skipped: [] }
  }
}
