// V3 WEB-3. Report-only grouping of observed broker balances, shared by the
// server (hourly activity, /perf-ledger) and the Performance page. Pure: no
// database, no clock, no broker.
//
// Money is per deposit currency and never summed across currencies (8,989-A
// default WEB-5). A currency total exists only when EVERY account of that
// currency has an observation at the edge; otherwise the total is null and
// the reason is kept. An account whose currency was never stored could belong
// to any currency, so while one exists no all-accounts total is stated.
const REASON_ORDER = ['before_balance_history', 'no_balance_stored', 'no_observation_near_edge', 'no_floating_reading']
const firstReason = reasons => REASON_ORDER.find(r => reasons.has(r)) ?? [...reasons][0] ?? null

/** entries: [{ accountId, currency, storedFrom, evidence }], evidence being
 * { status: 'observed', value, currency, at, source } or
 * { status: 'not_stored', reason }. */
export function currencyGroups(entries) {
  const groups = new Map()
  let unknownCurrencyAccounts = 0
  const unknownReasons = new Set()
  for (const e of entries || []) {
    const ev = e?.evidence
    const observed = ev?.status === 'observed' && typeof ev.value === 'number' && Number.isFinite(ev.value)
      && typeof ev.currency === 'string' && /^[A-Z]{3}$/.test(ev.currency)
    const currency = observed ? ev.currency : typeof e?.currency === 'string' && /^[A-Z]{3}$/.test(e.currency) ? e.currency : null
    if (!currency) { unknownCurrencyAccounts++; unknownReasons.add(ev?.reason || 'not_stored'); continue }
    if (!groups.has(currency)) groups.set(currency, { currency, accounts: 0, observed: 0, sum: 0, oldestAt: null, newestAt: null,
      storedFrom: null, storedFromKnown: true, sources: new Set(), reasons: new Set() })
    const g = groups.get(currency)
    g.accounts++
    if (Number.isSafeInteger(e.storedFrom)) g.storedFrom = g.storedFrom == null ? e.storedFrom : Math.max(g.storedFrom, e.storedFrom)
    else g.storedFromKnown = false
    if (observed) {
      g.observed++; g.sum += ev.value
      if (Number.isSafeInteger(ev.at)) {
        g.oldestAt = g.oldestAt == null ? ev.at : Math.min(g.oldestAt, ev.at)
        g.newestAt = g.newestAt == null ? ev.at : Math.max(g.newestAt, ev.at)
      }
      if (ev.source) g.sources.add(ev.source)
    } else g.reasons.add(ev?.reason || 'not_stored')
  }
  const list = [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map(g => {
    const complete = g.observed === g.accounts
    return { currency: g.currency, accounts: g.accounts, observedAccounts: g.observed,
      value: complete ? g.sum : null, oldestAt: complete ? g.oldestAt : null, newestAt: complete ? g.newestAt : null,
      sources: [...g.sources].sort(), storedFrom: g.storedFromKnown ? g.storedFrom : null,
      reason: complete ? null : firstReason(g.reasons) }
  })
  const single = list.length === 1 && unknownCurrencyAccounts === 0 ? list[0] : null
  return { total: single ? single.value : null, currency: single ? single.currency : null,
    groups: list, unknownCurrencyAccounts, unknownReason: firstReason(unknownReasons) }
}

/** Ledger carry for one scope from report.balanceEdges (server-built). */
export function ledgerCarry(balanceEdges, windowKey, accountId = 'all') {
  const unavailable = reason => ({ carryIn: null, carryOut: null, carryCurrency: null,
    carry: { status: 'unavailable', reason, in: null, out: null } })
  if (!balanceEdges || balanceEdges.status !== 'complete' || !balanceEdges.windows) return unavailable(balanceEdges?.reason || 'balance_history_unavailable')
  const accounts = (balanceEdges.accounts || []).filter(a => accountId === 'all' || a.accountId === String(accountId))
  if (!accounts.length) return unavailable('account_not_registered')
  const edges = balanceEdges.windows[windowKey] || {}
  const side = k => currencyGroups(accounts.map(a => ({ accountId: a.accountId, currency: a.currency,
    storedFrom: a.historyStartsAt, evidence: edges[a.accountId]?.[k] ?? { status: 'not_stored', reason: 'no_balance_stored' } })))
  const inside = side('in'), outside = side('out')
  return { carryIn: inside.total, carryOut: outside.total, carryCurrency: inside.currency ?? outside.currency,
    carry: { status: 'observed_broker_balance', maxAgeMs: balanceEdges.maxAgeMs ?? null, in: inside, out: outside } }
}

const pad = n => String(n).padStart(2, '0')
/** '22-09 17:26 UTC' — the day, month and minute a stored history begins. */
export function utcStamp(ms) {
  if (!Number.isSafeInteger(ms)) return null
  const d = new Date(ms)
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

/** Short, honest label for a missing edge. Never a zero. */
export function missingBalanceLabel(group) {
  if (!group) return 'not stored'
  const partial = group.observedAccounts > 0 && group.observedAccounts < group.accounts
    ? ` (${group.observedAccounts}/${group.accounts} accounts read)` : ''
  if (group.reason === 'before_balance_history' && group.storedFrom != null) return `not stored before ${utcStamp(group.storedFrom)}${partial}`
  if (group.reason === 'no_observation_near_edge') return `no broker read near edge${partial}`
  if (group.reason === 'no_floating_reading') return `no floating read${partial}`
  return `not stored${partial}`
}
