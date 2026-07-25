// symbol-click-spec §2 — URL/history helpers + the §2.5 toast, shared by
// SymbolTarget and the cockpit itself (separate file so fast-refresh works).
export function openCockpit(positionId, { replace = false } = {}) {
  const url = new URL(window.location.href)
  url.searchParams.set('trade', String(positionId))
  if (replace) window.history.replaceState({ tc: 1 }, '', url)
  else window.history.pushState({ tc: 1 }, '', url)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function closeCockpit() {
  const url = new URL(window.location.href)
  if (url.searchParams.has('trade')) window.history.back()
}

export function toast(msg) {
  const el = document.createElement('div')
  el.textContent = msg
  el.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:99;background:var(--gls,rgba(10,14,28,.9));color:var(--sb,#9aa8cc);border:1px solid var(--gbd,rgba(140,165,255,.22));border-radius:8px;padding:6px 14px;font-size:11px'
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2000)
}

