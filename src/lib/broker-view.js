// A delayed response must belong to the same uninterrupted viewing session.
// A -> B -> A must not accept the first A request after returning to A.
export function createBrokerViewGuard(readAccount) {
  let scope = null
  return () => {
    const id = String(readAccount() ?? '')
    const changed = scope?.id !== id
    if (changed) scope = { id, live: false }
    const captured = scope
    return { id, changed, single: /^[1-9]\d*$/.test(id),
      current: () => scope === captured && String(readAccount() ?? '') === id,
      matches: account => String(account?.accountId) === id,
      markLive: () => { captured.live = true },
      acceptsCache: () => !captured.live && scope === captured && String(readAccount() ?? '') === id }
  }
}
