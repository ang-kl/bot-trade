// ---------------------------------------------------------------------------
// src/lib/conn-hash.js — what a URL fragment is allowed to reconfigure.
//
// THE INCIDENT, 2026-08-06. The owner was logged out twice and could not save
// a Min R:R change. The agent log named the cause precisely:
//
//   [auth] 401 GET /state/risk-config — stale/unknown token risk-minRR…
//
// That message prints `token.slice(0, 10)`, and `risk-minRR` is exactly ten
// characters. The browser had sent a DOM ELEMENT ID as its bearer token.
//
// `risk-minRR` is what Field.jsx renders for the Min R:R field
// (`id={`risk-${anchor}`}`), so it is also what lands in `location.hash` when
// an in-page anchor is followed. The old parser treated ANY `=`-free fragment
// as a shorthand secret and wrote it straight over the stored session token:
//
//   } else if (raw) {
//     secret = decodeURIComponent(raw)   // "the entire hash IS the secret"
//   }
//   if (secret) localStorage.setItem(LS_SECRET, secret.trim())
//
// So navigating to a form field signed the operator out. Silently, and at the
// exact moment they were trying to change a risk limit.
//
// THE RULE NOW. A fragment may carry a credential, but it must LOOK like one.
// Session tokens are `sess_` + 48 hex (index.js addSession) and the agent
// secrets are 64-hex; anchors are lowercase words with hyphens. Those two sets
// do not overlap, so shape is enough to tell them apart, and a fragment that
// fails the test is left alone rather than guessed at.
//
// The explicit `#agent=…&secret=…` form is untouched: it names its fields, so
// there is nothing to infer and no anchor can be mistaken for it.
// ---------------------------------------------------------------------------

/**
 * Does this string look like a credential this app issues?
 *
 * Deliberately NARROW. The cost of a false negative is that a hand-typed
 * shorthand link stops working and the operator uses the Connect page — mildly
 * annoying. The cost of a false positive is the incident above: a silent
 * logout, mid-edit, on a risk screen. Those are not close, so the test only
 * admits the two shapes the system actually mints.
 */
export function looksLikeSecret(value) {
  const s = String(value || '').trim()
  if (!s) return false
  if (/^sess_[0-9a-f]{16,}$/i.test(s)) return true   // browser session token
  if (/^[0-9a-f]{32,}$/i.test(s)) return true        // AGENT_SECRET / _READ
  return false
}

/**
 * What, if anything, a fragment should reconfigure.
 *
 * @param {string} hash        `location.hash`, with or without the leading '#'
 * @returns {{url: string|null, secret: string|null, ignored: string|null}}
 *   `ignored` names a fragment that was deliberately NOT treated as a secret,
 *   so the caller can leave the address bar alone — rewriting it would break
 *   the anchor the user just clicked, which is a second bug on top of the
 *   first.
 */
export function parseConnHash(hash) {
  const raw = String(hash || '').replace(/^#/, '')
  if (!raw) return { url: null, secret: null, ignored: null }

  if (raw.includes('=')) {
    // NAMED FORM. Unambiguous by construction — it says which field is which.
    let params
    try { params = new URLSearchParams(raw) } catch { return { url: null, secret: null, ignored: null } }
    const url = params.get('agent')
    const secret = params.get('secret')
    // A named `secret=` is trusted even if it fails looksLikeSecret: the
    // operator spelled out their intent, and a self-hosted deployment may use
    // a secret shaped differently from the ones this app mints.
    return { url: url ? url.trim() : null, secret: secret ? secret.trim() : null, ignored: null }
  }

  let decoded = raw
  try { decoded = decodeURIComponent(raw) } catch { /* keep the raw form */ }
  if (looksLikeSecret(decoded)) return { url: null, secret: decoded.trim(), ignored: null }

  // AN ANCHOR, A DEEP LINK, OR A TYPO. Not a credential, and nothing to do.
  return { url: null, secret: null, ignored: decoded }
}
