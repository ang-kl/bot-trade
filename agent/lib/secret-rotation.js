// ---------------------------------------------------------------------------
// agent/lib/secret-rotation.js — rotating the secret must mean what it says.
//
// MEASURED 24-08-2026, minutes after the owner rotated AGENT_SECRET over a
// suspected credential exposure: a device-session token minted two days
// earlier still answered 200. Fourteen live sessions survived the rotation.
//
// The mechanism: Telegram-code logins mint tokens into `device_sessions`
// (agent_state), and authMiddleware validates them against THAT MAP with
// their own 90-day expiry — AGENT_SECRET never enters the check. Yet the
// login-confirmation Telegram message tells the owner "If this was not you
// ... revoke by rotating AGENT_SECRET." The one action the documentation
// offered for a compromise did not touch the sessions a compromiser would
// actually hold. Failure mode #3, wearing the owner's own panic button.
//
// THE SWEEP: boot compares a hash of the live secret against the hash stored
// at the previous boot. A mismatch means the owner rotated — every device
// session is cleared, durably, before the server starts answering. Sessions
// die on the very next request, and re-login costs one Telegram code.
//
// Only a HASH is stored. The secret itself must not land in agent_state,
// where every backup and debug dump of the database would carry it.
//
// First boot (no stored hash) stores and clears nothing: an empty or
// migrated database must not read as "rotation happened".
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'

const HASH_KEY = 'agent_secret_hash'
const SESSIONS_KEY = 'device_sessions'

export const hashSecret = (secret) =>
  createHash('sha256').update(String(secret)).digest('hex')

/**
 * Run at boot, after the DB opens and before the server listens.
 *
 * @returns {{rotated: boolean, cleared: number}} whether a rotation was
 *   detected and how many device sessions were revoked by it.
 */
export function secretRotationSweep(db, secret, { getState, setState }) {
  const now = hashSecret(secret)
  const prev = getState(db, HASH_KEY)
  if (prev === now) return { rotated: false, cleared: 0 }

  let cleared = 0
  if (prev) {
    // A real rotation, not a first boot: count what dies, then clear.
    try { cleared = Object.keys(JSON.parse(getState(db, SESSIONS_KEY) || '{}')).length } catch { cleared = 0 }
    setState(db, SESSIONS_KEY, '{}')
  }
  setState(db, HASH_KEY, now)
  return { rotated: !!prev, cleared }
}
