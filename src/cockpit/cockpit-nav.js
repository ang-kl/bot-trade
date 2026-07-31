// symbol-click-spec §2 — URL/history helpers + the §2.5 toast, shared by
// SymbolTarget and the cockpit itself (separate file so fast-refresh works).

// The URL stays the single source of truth for WHICH position is open (so deep
// links and history work per §2). This side table carries the broker facts the
// clicking surface already holds, so the cockpit can render the real
// instrument instead of the reference mock. It is deliberately in-memory only:
// a reload has no entry, and the cockpit then says so rather than dressing
// mock numbers up as live ones. Retire this once the /api/positions/:id/cockpit
// endpoint exists (PR open question Q3).
const bound = new Map()

export function bindPosition(positionId, position) {
  if (positionId != null && position) bound.set(String(positionId), position)
}
export function boundPosition(positionId) {
  return positionId == null ? null : bound.get(String(positionId)) || null
}

// PHASE 1 (cockpit live-wiring prompt): the URL used to carry only the broker
// position id, with account/db/trade identity in the in-memory Map above — so
// a RELOAD kept the least durable id and lost every durable one. The deep link
// now carries all four; the identity object rides alongside the legacy
// positional arg so every existing call site keeps working unchanged.
export function openCockpit(positionId, { replace = false, accountId = null, dbPositionId = null, tradeId = null } = {}) {
  const url = new URL(window.location.href)
  url.searchParams.set('trade', String(positionId))
  // Only stamped when known — an absent param stays honestly absent rather
  // than becoming the string "null" a reload would then trust.
  if (accountId != null) url.searchParams.set('tacct', String(accountId))
  if (dbPositionId != null) url.searchParams.set('tdb', String(dbPositionId))
  if (tradeId != null) url.searchParams.set('ttr', String(tradeId))
  if (replace) window.history.replaceState({ tc: 1 }, '', url)
  else window.history.pushState({ tc: 1 }, '', url)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** The identity a deep link carries, for the cockpit's own fetch. */
export function urlIdentity() {
  const q = new URL(window.location.href).searchParams
  return {
    brokerPositionId: q.get('trade'),
    accountId: q.get('tacct'),
    dbPositionId: q.get('tdb'),
    tradeId: q.get('ttr'),
  }
}

export function closeCockpit() {
  const url = new URL(window.location.href)
  if (url.searchParams.has('trade')) window.history.back()
}
// (identity params ride and die with ?trade= via history navigation)

export function toast(msg) {
  const el = document.createElement('div')
  el.textContent = msg
  el.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:99;background:var(--gls,rgba(10,14,28,.9));color:var(--sb,#9aa8cc);border:1px solid var(--gbd,rgba(140,165,255,.22));border-radius:8px;padding:6px 14px;font-size:11px'
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2000)
}

