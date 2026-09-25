// agent/lib/request-actor.js — PR-Q1 (V3 P6/P7, review 25-09-2026): who
// asked. POST /actions/tick-validation hard-coded actor 'owner', so a
// validation import that "Claude on the owner's word" performed was recorded
// as the owner's own. The record must say who the CALLER was.
//
// Two facts, never mixed up:
//   * the CREDENTIAL — set by the server's own auth middleware (index.js
//     stamps `req.authCredential`), never read from the request: a device
//     session is minted only by the Telegram login code sent to the owner, so
//     it is the owner's device; the master AGENT_SECRET is held by whoever was
//     given it (the owner, or an agent working on the owner's word), so it
//     names nobody by itself;
//   * the DECLARED name — `body.actor` or the `X-Actor` header, optional,
//     recorded as declared. It can never claim the bot's own actors (`auto:*`
//     is the readiness pass, which the entry-mode setters treat differently)
//     or a repo file (`config/*`) or another service's (`tick-validation:*`).
export const RESERVED_ACTOR_PREFIXES = Object.freeze(['auto:', 'config/', 'tick-validation:'])
export const ACTOR_MAX = 80
const CREDENTIAL_ACTOR = Object.freeze({
  device_session: 'owner (device session)',
  agent_secret: 'agent-secret holder (undeclared)',
})

/**
 * { ok: true, actor, credential, declared } or { ok: false, status: 400,
 * body } for a declared name that is malformed or reserved. `actor` is the
 * string written to the record: `<declared> via <credential>` when a name
 * was declared, the credential's own reading otherwise, and
 * 'unattributed (no credential stamped)' when the route runs without the
 * auth middleware (tests, or a future mount that forgot it) — never 'owner'
 * by default.
 */
export function actorFromRequest(req) {
  const credential = typeof req?.authCredential === 'string' ? req.authCredential : null
  const rawHeader = req?.headers?.['x-actor']
  const raw = req?.body && typeof req.body === 'object' && req.body.actor != null ? req.body.actor : rawHeader
  let declared = null
  if (raw != null && raw !== '') {
    const s = String(raw).trim()
    const refuse = (error, why) => ({ ok: false, status: 400, body: { ok: false, error, actor: s.slice(0, ACTOR_MAX), where: `${why}. actor is optional: a name of 1-${ACTOR_MAX} printable characters that says who is acting (for example "claude on the owner's word"); the credential that authenticated the request is recorded beside it either way` } })
    const control = [...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    if (!s || s.length > ACTOR_MAX || control) return refuse('bad_actor', 'the declared actor is empty, too long or carries control characters')
    const low = s.toLowerCase()
    if (RESERVED_ACTOR_PREFIXES.some(p => low.startsWith(p))) return refuse('reserved_actor', `"${s.slice(0, 20)}" names one of the bot's own actors (${RESERVED_ACTOR_PREFIXES.join(', ')}), which a request cannot claim`)
    declared = s
  }
  const credentialReading = credential ? (CREDENTIAL_ACTOR[credential] || credential) : null
  const actor = declared
    ? `${declared} via ${credential || 'no credential stamped'}`
    : (credentialReading || 'unattributed (no credential stamped)')
  return { ok: true, actor, credential, declared }
}
