import { getState } from '../db.js'

// Read-only handoff contract. Nothing here sets this key or changes the
// notification master. Transfer needs cpp-verify delivery/observer acceptance.
export function independentWatchdogOwns(db, kind) {
  return ['service_liveness', 'missing_sl', 'missing_tp'].includes(kind)
    && getState(db, 'watchdog_incident_owner') === 'cpp-verify'
}
