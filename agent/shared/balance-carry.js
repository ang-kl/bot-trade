// V3 WEB-3. Report-only grouping of observed broker balances, shared by the
// server (hourly activity, /perf-ledger) and the Performance page. Pure: no
// database, no clock, no broker.
//
// Money is per deposit currency and never summed across currencies (8,989-A
// default WEB-5). A currency total exists only when EVERY account of that
// currency has an observation at the edge; otherwise the total is null and
// the reason is kept. The accounts that were NOT read are named
// (missingAccounts / unknownAccounts) so a gap that keeps a total open — an
// account disabled later, say — says which account it is instead of only
// "n/m accounts read".
//
// ONE POOLING RULE (V3 WEB-3m): an account's currency group is its RECORDED
// broker deposit currency — the populations report's currencyByAccount, the
// map WEB-7's pools read through reportCurrency — passed in as the entry's
// `currency`. An observation's own stamp never chooses the group: it is
// re-checked against the recorded currency, and a read stamped in another
// currency is not summed (observation_currency_mismatch), as populationStats
// re-checks every contributing account. An account with no recorded currency
// belongs to no currency, so while one exists no all-accounts total is stated.
const CCY = /^[A-Z]{3}$/
// The WEB-8 reasons (an older ledger edge the stored deal and cashflow
// balances could not prove) follow the WEB-3 ones; the WEB-3 order is unchanged.
const REASON_ORDER = ['before_balance_history', 'no_balance_stored', 'no_observation_near_edge', 'observation_currency_mismatch',
  'no_floating_reading', 'account_not_registered', 'deposit_currency_evidence_mismatch', 'deposit_currency_not_recorded',
  'event_without_balance', 'balance_chain_break', 'balance_version_gap', 'event_without_money', 'edge_inside_event_time',
  'after_last_stored_event']
const firstReason = reasons => REASON_ORDER.find(r => reasons.has(r)) ?? [...reasons][0] ?? null

/** entries: [{ accountId, currency, currencyReason?, storedFrom, evidence }],
 * `currency` being the account's RECORDED deposit currency (null when none),
 * evidence { status: 'observed', value, currency, at, source } or
 * { status: 'not_stored', reason }. A ledger edge's not_stored evidence may
 * carry `dealBalance: { status: 'unavailable' }` (V3 WEB-8-m): the stored deal
 * and cashflow balances could not be read, so the edge was never checked
 * against them. Such accounts are named per group (dealBalanceUnreadAccounts)
 * so the page can say so in words instead of showing only the reads' reason. */
export function currencyGroups(entries) {
  const groups = new Map()
  let unknownCurrencyAccounts = 0
  const unknownReasons = new Set(), unknownAccounts = []
  for (const e of entries || []) {
    const ev = e?.evidence
    const read = ev?.status === 'observed' && typeof ev.value === 'number' && Number.isFinite(ev.value)
      && typeof ev.currency === 'string' && CCY.test(ev.currency)
    const currency = typeof e?.currency === 'string' && CCY.test(e.currency) ? e.currency : null
    const observed = read && ev.currency === currency
    const id = e?.accountId != null ? String(e.accountId) : null
    if (!currency) {
      unknownCurrencyAccounts++
      unknownReasons.add(ev?.status === 'not_stored' && ev.reason ? ev.reason : e?.currencyReason || 'deposit_currency_not_recorded')
      if (id) unknownAccounts.push(id)
      continue
    }
    if (!groups.has(currency)) groups.set(currency, { currency, accounts: 0, observed: 0, sum: 0, oldestAt: null, newestAt: null,
      storedFrom: null, storedFromKnown: true, sources: new Set(), times: new Map(), reasons: new Set(), missing: [], dealUnread: [] })
    const g = groups.get(currency)
    g.accounts++
    if (Number.isSafeInteger(e.storedFrom)) g.storedFrom = g.storedFrom == null ? e.storedFrom : Math.max(g.storedFrom, e.storedFrom)
    else g.storedFromKnown = false
    if (observed) {
      g.observed++; g.sum += ev.value
      if (Number.isSafeInteger(ev.at)) {
        g.oldestAt = g.oldestAt == null ? ev.at : Math.min(g.oldestAt, ev.at)
        g.newestAt = g.newestAt == null ? ev.at : Math.max(g.newestAt, ev.at)
        // Per source too (V3 WEB-8-m): a read's time is a read at the edge,
        // a deal's is the close the broker reported the balance after, so
        // the page words each by what it is.
        if (ev.source) {
          const t = g.times.get(ev.source)
          g.times.set(ev.source, t ? { oldestAt: Math.min(t.oldestAt, ev.at), newestAt: Math.max(t.newestAt, ev.at) } : { oldestAt: ev.at, newestAt: ev.at })
        }
      }
      if (ev.source) g.sources.add(ev.source)
    } else {
      g.reasons.add(read ? 'observation_currency_mismatch' : ev?.reason || 'not_stored'); if (id) g.missing.push(id)
      if (id && ev?.dealBalance?.status === 'unavailable') g.dealUnread.push(id)
    }
  }
  const list = [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map(g => {
    const complete = g.observed === g.accounts
    return { currency: g.currency, accounts: g.accounts, observedAccounts: g.observed,
      value: complete ? g.sum : null, oldestAt: complete ? g.oldestAt : null, newestAt: complete ? g.newestAt : null,
      sources: [...g.sources].sort(), sourceTimes: complete ? Object.fromEntries([...g.times].sort(([a], [b]) => a.localeCompare(b))) : {},
      storedFrom: g.storedFromKnown ? g.storedFrom : null,
      reason: complete ? null : firstReason(g.reasons), missingAccounts: [...g.missing].sort(),
      dealBalanceUnreadAccounts: [...g.dealUnread].sort() }
  })
  const single = list.length === 1 && unknownCurrencyAccounts === 0 ? list[0] : null
  return { total: single ? single.value : null, currency: single ? single.currency : null,
    groups: list, unknownCurrencyAccounts, unknownAccounts: unknownAccounts.sort(), unknownReason: firstReason(unknownReasons) }
}

/** Ledger carry for one scope from report.balanceEdges (server-built).
 * `currencyOf(accountId)` names the account's recorded deposit currency:
 * reportLedger passes `id => reportCurrency(report, id)`, WEB-7's reader of the
 * report's currencyByAccount. Without it no account has a currency, so no
 * carry is pooled (never a guess, never a second reader). */
export function ledgerCarry(balanceEdges, windowKey, accountId = 'all', currencyOf = null) {
  const unavailable = reason => ({ carryIn: null, carryOut: null, carryCurrency: null,
    carry: { status: 'unavailable', reason, in: null, out: null } })
  if (!balanceEdges || balanceEdges.status !== 'complete' || !balanceEdges.windows) return unavailable(balanceEdges?.reason || 'balance_history_unavailable')
  const accounts = (balanceEdges.accounts || []).filter(a => accountId === 'all' || a.accountId === String(accountId))
  if (!accounts.length) return unavailable('account_not_registered')
  const edges = balanceEdges.windows[windowKey] || {}
  const recorded = id => { const c = typeof currencyOf === 'function' ? currencyOf(id) : null; return typeof c === 'string' && CCY.test(c) ? c : null }
  const side = k => currencyGroups(accounts.map(a => ({ accountId: a.accountId, currency: recorded(a.accountId),
    storedFrom: a.historyStartsAt, evidence: edges[a.accountId]?.[k] ?? { status: 'not_stored', reason: 'no_balance_stored' } })))
  const inside = side('in'), outside = side('out')
  // dealBalances: 'read', 'off' or 'deal_balance_read_failed' (V3 WEB-8-m) —
  // carried so a failed read of the stored deal balances is stated on the
  // page, not hidden behind the reads' own "not stored before" label.
  return { carryIn: inside.total, carryOut: outside.total, carryCurrency: inside.currency ?? outside.currency,
    carry: { status: 'observed_broker_balance', maxAgeMs: balanceEdges.maxAgeMs ?? null,
      dealBalances: balanceEdges.dealBalances ?? null, in: inside, out: outside } }
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
  if (group.reason === 'observation_currency_mismatch') return `read not in ${group.currency || 'the recorded currency'}${partial}`
  if (group.reason === 'no_floating_reading') return `no floating read${partial}`
  // V3 WEB-8: an older edge whose stored deal/cashflow balances do not prove
  // a balance. Each names what cannot be recovered; none is ever estimated.
  if (group.reason === 'event_without_balance') return `deal or cashflow stored without its balance${partial}`
  if (group.reason === 'balance_chain_break') return `not provable: unrecorded balance change${partial}`
  if (group.reason === 'balance_version_gap') return `not provable: balance version gap${partial}`
  if (group.reason === 'event_without_money') return `not provable: deal stored without its money${partial}`
  if (group.reason === 'edge_inside_event_time') return `not provable: a close in the edge's second${partial}`
  if (group.reason === 'after_last_stored_event') return `not provable: no later deal or cashflow stored${partial}`
  return `not stored${partial}`
}

/** Short label for accounts in no currency group (V3 WEB-3m), by reason. */
export function unknownCurrencyLabel(reason) {
  if (reason === 'account_not_registered') return 'not registered'
  if (reason === 'deposit_currency_evidence_mismatch') return 'currency evidence not for this host'
  return 'currency not recorded'
}
