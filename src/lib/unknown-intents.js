// src/lib/unknown-intents.js — the Unknowns block's readers and posters
// (PR-E, owner principle 4, 11-09-2026). Pure functions over the server's
// own record: GET /state/entry-intents (ledgerView) lists every open intent
// with a redacted account id; this picks the UNKNOWN ones, ages them, and
// posts an operator's resolution or the origin backfill through the poster
// it is handed (agentPost in the component, a recorder in the spec).
//
// Lives in lib/ so the component module exports components only, and so the
// posting contract is testable without a DOM.

export const RESOLVE_STATES = Object.freeze(['FILLED', 'REJECTED'])
export const MIN_REASON_LEN = 3

/** Age as the server would print it — whole units, never a fake precision. */
export function ageLabel(fromIso, now = Date.now()) {
  const t = Date.parse(fromIso || '')
  if (!Number.isFinite(t)) return 'age unknown'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${m - h * 60} min`
}

/** m5: does a redacted account id (…last4) fall under the panel's scope ('all' or one account id)? */
export function inScope(redactedAccountId, scope) {
  if (scope == null || scope === '' || scope === 'all') return true
  const tail = String(scope).slice(-4)
  return String(redactedAccountId || '').slice(-4) === tail
}

/** The UNKNOWN intents of a ledger view under the panel's scope, oldest first, ready to render. */
export function unknownRows(view, now = Date.now(), { scope = 'all' } = {}) {
  const open = Array.isArray(view?.open) ? view.open : []
  return open.filter(r => r && r.state === 'UNKNOWN' && inScope(r.accountId, scope))
    .sort((a, b) => (Date.parse(a.createdAt || '') || 0) - (Date.parse(b.createdAt || '') || 0))
    .map(r => ({
      id: r.id,
      account: String(r.accountId || '').slice(-4),
      symbol: r.symbol || (r.symbolId != null ? `#${r.symbolId}` : '—'),
      side: r.side || '—',
      age: ageLabel(r.createdAt, now),
      errorCode: r.errorCode || '—',
      producerId: r.producerId || null,
    }))
}

/** The same rule the route applies (operatorResolve): a state and a reason of at least three characters. */
export function validateResolve({ state, reason } = {}) {
  if (!RESOLVE_STATES.includes(state)) return { ok: false, reason: `state must be one of ${RESOLVE_STATES.join(', ')}` }
  if (!reason || String(reason).trim().length < MIN_REASON_LEN) return { ok: false, reason: `a reason of at least ${MIN_REASON_LEN} characters is required` }
  return { ok: true }
}

/**
 * POST /actions/entry-intents/:id/resolve with { state, reason }. Refuses
 * locally on the route's own rule so a click with no reason never reaches
 * the server; the server's answer ({ ok, from, to } or { ok:false, reason })
 * is returned as-is — the caller re-fetches the ledger rather than assuming.
 */
export async function resolveUnknownIntent(post, id, { state, reason } = {}) {
  const v = validateResolve({ state, reason })
  if (!v.ok) return { ok: false, reason: v.reason, posted: false }
  if (!id) return { ok: false, reason: 'no intent id', posted: false }
  const r = await post(`/actions/entry-intents/${encodeURIComponent(String(id))}/resolve`, { state, reason: String(reason).trim() })
  return { ...(r && typeof r === 'object' ? r : { ok: false, reason: 'no reply' }), posted: true }
}

/**
 * POST /actions/backfill-trade-origin. DRY RUN unless apply is true — the
 * route's own default; the block shows the plan's counts first and applies
 * on a second, explicit click.
 */
export async function runOriginBackfill(post, { apply = false } = {}) {
  const r = await post('/actions/backfill-trade-origin', apply ? { apply: true } : {})
  return r && typeof r === 'object' ? r : { ok: false, error: 'no reply' }
}

/** One line for the backfill reply: mode, rows, per-origin counts, written. */
export function backfillSummary(r) {
  if (!r) return ''
  if (r.error) return `backfill failed: ${r.error}`
  const counts = r.counts && typeof r.counts === 'object' ? Object.entries(r.counts).map(([k, n]) => `${k} ${n}`).join(', ') : ''
  if (r.mode === 'rollback') return `rollback${r.dryRun ? ' (dry run)' : ''}: ${r.dryRun ? `${r.wouldClear ?? 0} would clear` : `${r.cleared ?? 0} cleared`}`
  const head = r.dryRun ? `plan: ${r.rows ?? 0} row(s) would be written` : `applied: ${r.written ?? 0} of ${r.rows ?? 0} row(s) written`
  return counts ? `${head} — ${counts}` : head
}
