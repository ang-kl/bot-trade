// NEW-1 (integrated plan 26-09-2026): every page this harness loads is marked
// as a SYNTHETIC presence, so the trace's tabs are counted apart from the
// owner's visible tabs (agent/services/client-presence.js) instead of
// inflating them — the M3 record had 9 and 8 "visible tabs" that were trace
// loads. Two marks, both read by src/lib/agent-api.js syntheticPresenceTag():
//   · `?synthetic=trace` on the page URL (kept through the trace's reload);
//   · `sessionStorage.synthetic_presence = 'trace'` from the init script, so
//     an in-app navigation that drops the query string still carries it.
export const SYNTHETIC_TAG = 'trace'

/** The page URL with the harness flag set (an existing query is kept). */
export function withSynthetic(url, tag = SYNTHETIC_TAG) {
  const u = new URL(url)
  u.searchParams.set('synthetic', tag)
  return u.toString()
}

/** Init-script statement that marks the tab synthetic for its whole session. */
export function syntheticInit(tag = SYNTHETIC_TAG) {
  return `try{sessionStorage.setItem('synthetic_presence',${JSON.stringify(tag)})}catch(e){}`
}
