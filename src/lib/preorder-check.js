// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// The Trade page's pre-order check: what it asks GET /state/preorder, where
// the manual pad sends its order, and how a check's answer is read back.
// Pure — every function here is exercised by src/lib/preorder-check.test.js;
// the page only wires them to buttons.
//
// THE CHECK IS ASKED ONCE PER TAP. It is a dry run of the risk gate (and, for
// the pad, one broker price read), so it is never polled: createCheckRunner
// issues exactly one request per call and none while one is in flight.

const SINGLE = (id) => id != null && String(id) !== '' && String(id) !== 'all'

/** GET path for a scanner signal's check. The row's own account, when it names one. */
export function scanCheckPath({ scanId, accountId = null }) {
  const q = new URLSearchParams({ scanId: String(scanId) })
  if (SINGLE(accountId)) q.set('account', String(accountId))
  return `/state/preorder?${q.toString()}`
}

/**
 * Where the pad's order goes. TODAY: the primary broker account, as before —
 * no `account` is sent and the confirm says "primary". Routing the pad to the
 * account the page shows is the owner's call (decision D2,
 * docs/plan-ui-and-strategy-review-2026-09-26.md:590 "ASK-FIRST if orders
 * route to the viewed account"), so it stays off until the owner says so.
 * `routeToViewed: true` is that switch: the account the page shows, when it
 * shows ONE account, is sent as `account` and named by the confirm. The dry
 * run always checks the account the order would actually reach.
 * Claude · № 12,957 10-Oct (ordered № 12,954; D2 kept ask-first; claude-builder)
 *
 * @param {{viewedAccountId: string|number|null, broker: {accountId?: string|number|null, traderLogin?: string|number|null}|null, routeToViewed?: boolean}} p
 */
export const ROUTE_PAD_TO_VIEWED_ACCOUNT = false

export function padDestination({ viewedAccountId, broker, routeToViewed = ROUTE_PAD_TO_VIEWED_ACCOUNT }) {
  if (routeToViewed && SINGLE(viewedAccountId)) {
    const id = String(viewedAccountId)
    const login = broker?.accountId != null && String(broker.accountId) === id ? (broker.traderLogin ?? null) : null
    return { routed: true, accountId: id, traderLogin: login }
  }
  return {
    routed: false,
    accountId: broker?.accountId != null && String(broker.accountId) !== '' ? String(broker.accountId) : null,
    traderLogin: broker?.traderLogin ?? null,
  }
}

/** The pad's inputs, normalised the way the route reads them. */
export function padInputs(order) {
  return {
    symbol: String(order?.symbol || '').toUpperCase().trim(),
    side: String(order?.side || '').toUpperCase(),
    lots: order?.lots === '' || order?.lots == null ? null : Number(order.lots),
    sl: order?.sl === '' || order?.sl == null ? null : Number(order.sl),
    tp: order?.tp === '' || order?.tp == null ? null : Number(order.tp),
  }
}

/** The POST /actions/manual-order body: the pad's fields, plus `account` when the order is routed. */
export function manualOrderBody({ order, destination }) {
  const p = padInputs(order)
  return {
    symbol: p.symbol,
    side: p.side,
    lots: p.lots ? p.lots : undefined,
    sl: p.sl,
    tp: p.tp ? p.tp : undefined,
    ...(destination?.routed ? { account: String(destination.accountId) } : {}),
  }
}

/** GET path for the pad's check — the same fields, the same account, as the order it would send. */
export function manualCheckPath({ order, destination }) {
  const p = padInputs(order)
  const q = new URLSearchParams()
  if (destination?.routed) q.set('account', String(destination.accountId))
  q.set('symbol', p.symbol)
  q.set('side', p.side)
  if (p.lots) q.set('lots', String(p.lots))
  if (p.sl != null) q.set('sl', String(p.sl))
  if (p.tp) q.set('tp', String(p.tp))
  return `/state/preorder?${q.toString()}`
}

/** Identity of the inputs a check answered: a check speaks for these inputs only. */
export function checkKey({ order, destination }) {
  return manualCheckPath({ order, destination })
}

/** Size and money at risk from a check, for the confirm text; null when the check gave none. */
export function checkSummary(result) {
  const n = result?.ok ? result.numbers : null
  if (!n || n.volume == null) return null
  return { volume: n.volume, moneyAtRisk: n.moneyAtRisk ?? null, currency: n.currency || null, approved: !!result.approved }
}

/**
 * One GET per run(), and none while one is in flight. `get` is agentGet.
 * Returns the answer, or `{ ok: false, error }` when the request failed.
 */
export function createCheckRunner(get) {
  let inFlight = null
  return {
    run(path) {
      if (inFlight) return inFlight
      inFlight = Promise.resolve()
        .then(() => get(path))
        .catch(e => ({ ok: false, error: String(e?.message || e) }))
        .finally(() => { inFlight = null })
      return inFlight
    },
    busy: () => inFlight != null,
  }
}

const fmt = (v, dp = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: dp }))
const money = (v, ccy) => (v == null ? '—' : `${ccy ? `${ccy} ` : ''}${fmt(v, 2)}`)

/** "Ready" or the first block, in words — never colour alone. */
export function verdictLine(result) {
  if (!result) return null
  if (result.error) return `Check failed — ${result.error}`
  if (result.cannotCheck) return result.cannotCheck.replace(/^cannot check:/, 'Cannot check:')
  if (!result.ok) return 'Check failed'
  if (!result.firstBlock) return 'Ready — the risk gate would approve this order now'
  return `Blocked — ${result.firstBlock.label || result.firstBlock.reason}`
}

/** The check's figures as label/value lines, in the order the card shows them. */
export function preorderLines(result) {
  if (!result?.ok) return []
  const n = result.numbers || {}
  const s = result.strategy || {}
  const ms = n.marginShare
  const last = s.last20
  const allowed = { record: 'evidence (its record)', pinned: 'owner pin', shadow: 'shadow (not admitted)', off: 'evidence gate off', momentum_account: 'momentum account', unlabelled: 'unlabelled', not_consulted: 'not consulted (manual order)' }
  return [
    ['Size', n.volume == null ? '—' : `${fmt(n.volume)} lots${n.volumeBasis === 'risk_budget_before_veto' ? ' (sized before the veto)' : ''}`],
    ['Money at risk', money(n.moneyAtRisk, n.currency)],
    ["Share of today's stop left", n.dailyStopUncapped ? 'no daily stop in force'
      : n.shareOfStopLeft == null ? (n.dailyStopLeft == null ? '—' : `— of ${money(n.dailyStopLeft, n.currency)} left`)
        : `${fmt(n.shareOfStopLeft, 1)}% of ${money(n.dailyStopLeft, n.currency)} left`],
    ['Margin share', ms ? `${ms.pctOfHeadroom == null ? '—' : `${fmt(ms.pctOfHeadroom, 1)}%`} of ${money(ms.headroomUsd, n.currency)} headroom${ms.maxPctOfHeadroom != null ? ` (max ${fmt(ms.maxPctOfHeadroom, 1)}%)` : ''}` : '—'],
    ['Open / cap', `${n.openPositions ?? '—'} / ${n.maxPositions ?? '—'}`],
    ['R:R / floor', `${n.rr == null ? '—' : fmt(n.rr)} / ${n.rrFloor == null ? '—' : fmt(n.rrFloor)}`],
    [`Last 20${s.key ? ` (${s.key})` : ''}`, !last ? '—' : !last.n ? 'no closes yet'
      : `${last.n} closes · win ${last.winRatePct == null ? '—' : `${fmt(last.winRatePct, 1)}%`} · PF ${last.profitFactor == null ? 'no losses' : fmt(last.profitFactor)}`],
    ['Allowed by', allowed[s.allowedBy] || s.allowedBy || '—'],
  ]
}
