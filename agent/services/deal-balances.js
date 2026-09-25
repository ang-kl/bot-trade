// ---------------------------------------------------------------------------
// agent/services/deal-balances.js — the broker's own balance after each deal
// and cashflow, and the windows it can prove a balance for (V3 WEB-8,
// 8,989-A row 7).
//
// WHY. The ledger's carry in / carry out need the account balance at each
// window edge. account_history holds observed broker balances only since
// 2026-09-22 ~17:26 UTC, so every edge before that read "unavailable", while
// the broker had been handing us the balance all along and we threw it away:
// every closing deal's closePositionDetail carries `balance` (the account
// balance after that close) and `balanceVersion`; every cashflow item carries
// the same pair; and the committed cTrader statements carry a "Balance <CCY>"
// column per deal. broker_deals and account_cashflows now keep them
// (persistDeals, parseStatement, recordCashflowWindow).
//
// NEVER INVENTED. A balance is read at a window edge E only when the stored
// events PROVE it held at E. The ledger's windows are [from, to)
// (performance-populations.js: `t < w.from || t >= w.to`), so an event timed
// exactly at E belongs to the window that STARTS at E, and the balance at E
// is the one before it — carry out of one window and carry in of the next
// read the same figure:
//   A = the last stored event (closing deal or cashflow) strictly before E,
//   B = the first stored event at or after E,
//   and B's stored balance equals A's balance plus B's own money to the cent
//   (and, where both carry the broker's balanceVersion, B's is A's + 1).
// Then nothing else changed the balance between A and B, so it was A's at E.
// Any unrecorded change between them — a deposit before cashflows were
// stored, an opening charge, a deal we never stored — breaks that equality
// and the edge reads NOT PROVABLE with the reason. Nothing is interpolated,
// carried past its proof, derived from trade P&L or defaulted: an edge is
// either the broker's own balance with the events that prove it, or a
// labelled gap.
//
// Measured on the three committed statements (agent/seed-statements, 683
// deals, 31-07 → 21-08-2026): 680 of 680 consecutive links reconcile to the
// cent, so every edge between an account's first and last statement deal is
// provable (deal-balances.test.js pins it).
//
// The evidence shape matches the ledger carry's edge evidence ({status,
// value, currency, at, source} or {status: 'not_stored', reason}), so an
// edge before account_history begins can be answered from here. The ledger's
// carry does not call this reader yet: that fallback (when its own reader
// returns before_balance_history) is a follow-up on WEB-3; until then this
// serves GET /state/deal-balances only.
// ---------------------------------------------------------------------------

const HOSTS = { 0: 'demo.ctraderapi.com', 1: 'live.ctraderapi.com' }
// Money is compared to the cent: a 2-digit account's balance changes only in
// whole cents, and a deal's stored net is rounded to the cent (shapeDeals).
const CENT_TOLERANCE = 0.005 + 1e-9

/**
 * Money in the broker's integer units scaled by moneyDigits, or null when the
 * broker did not give a usable number. Never a default scale: a missing
 * moneyDigits is "not given", not "2".
 */
export function brokerAmount(value, digits) {
  if (!Number.isInteger(digits) || digits < 0 || digits > 10) return null
  if (value == null || !/^-?\d+$/.test(String(value))) return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n / 10 ** digits : null
}

/** The broker's balanceVersion (a non-negative integer), or null. */
export function brokerVersion(value) {
  if (value == null || !/^\d+$/.test(String(value))) return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

/**
 * The instant a stored time names, as the interval it is known to within.
 * `2026-09-01 10:00:00` (the API writer's form, UTC, whole seconds) is
 * [10:00:00.000, 10:00:00.999]; a time with milliseconds is exact. A time
 * with no zone is UTC, this codebase's convention. Unreadable → null.
 */
export function eventTime(text) {
  const m = String(text ?? '').trim()
    .match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?$/)
  if (!m) return null
  const ms = Date.parse(`${m[1]}T${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] || 'Z'}`)
  if (!Number.isFinite(ms)) return null
  const resolution = m[3] ? 10 ** (3 - m[3].length) : 1000
  return { earliest: ms, latest: ms + resolution - 1 }
}

/** What a stored event without a balance means, and whether it can come back. */
export const BALANCE_GAP_LABELS = Object.freeze({
  stored_before_balance_capture: 'Stored before the broker balance was kept (V3 WEB-8). Recoverable only by re-reading the deal or cashflow while the broker still retains it; broker retention is not measured.',
  broker_returned_no_balance: 'The broker read of this deal or cashflow carried no usable balance. Not recoverable from that read.',
  statement_has_no_balance: 'The statement this deal came from has no Balance column. Not recoverable from that file.',
})

const missingLabel = (e) => e.source == null ? 'stored_before_balance_capture'
  : e.source === 'statement' ? 'statement_has_no_balance' : 'broker_returned_no_balance'
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const ref = (e) => ({ kind: e.kind, id: e.id })

/**
 * Whether the balance after A provably held until B. `{ proof }` or
 * `{ reason, ... }`; never throws.
 */
function linkProof(A, B, currency) {
  for (const e of [A, B]) {
    if (e.balance == null) return { reason: 'event_without_balance', event: ref(e), eventLabel: missingLabel(e) }
    if (e.currency != null && e.currency !== currency) return { reason: 'observation_currency_mismatch', event: ref(e), eventCurrency: e.currency }
  }
  if (B.delta == null) return { reason: 'event_without_money', event: ref(B) }
  const unexplained = B.balance - (A.balance + B.delta)
  if (Math.abs(unexplained) > CENT_TOLERANCE) {
    return { reason: 'balance_chain_break', from: ref(A), to: ref(B), unexplained: Math.round(unexplained * 100) / 100 }
  }
  if (A.version != null && B.version != null) {
    if (B.version !== A.version + 1) return { reason: 'balance_version_gap', from: ref(A), to: ref(B), versions: [A.version, B.version] }
    return { proof: 'balance_version_consecutive' }
  }
  return { proof: 'balance_arithmetic' }
}

/**
 * Reader over one database snapshot, cached per account.
 * `currencyByAccount` is the depositCurrencies() map (the unit of every money
 * figure the account recorded); an account without a recorded currency reads
 * with that reason, never a default.
 */
export function dealBalanceReader(db, { currencyByAccount } = {}) {
  if (!currencyByAccount || typeof currencyByAccount !== 'object') throw new TypeError('dealBalanceReader needs currencyByAccount')
  const hosts = new Map(db.prepare('SELECT account_id, is_live FROM accounts ORDER BY account_id').all()
    .map(a => [String(a.account_id), HOSTS[a.is_live ? 1 : 0]]))
  const dealSql = db.prepare(`SELECT deal_id, closed_at, net_pnl, balance, balance_version, balance_currency, balance_source
    FROM broker_deals WHERE account_id = ?`)
  const cashflowSql = db.prepare(`SELECT event_id, at_ms, currency, delta, balance, balance_version, balance_source
    FROM account_cashflows WHERE account_id = ? AND host = ?`)
  const cache = new Map()

  function account(accountId) {
    const id = String(accountId)
    if (cache.has(id)) return cache.get(id)
    const host = hosts.get(id) ?? null
    const currency = currencyByAccount[id]?.currency ?? null
    const currencyReason = currency ? null : currencyByAccount[id]?.reason || 'deposit_currency_not_recorded'
    const events = []
    let unplaced = 0
    if (host) {
      for (const d of dealSql.iterate(id)) {
        const t = eventTime(d.closed_at)
        if (!t) { unplaced++; continue }
        events.push({ kind: 'deal', id: String(d.deal_id), ...t, delta: finite(d.net_pnl), balance: finite(d.balance),
          version: brokerVersion(d.balance_version), currency: d.balance_currency ?? null, source: d.balance_source ?? null })
      }
      for (const c of cashflowSql.iterate(id, host)) {
        if (!Number.isSafeInteger(c.at_ms)) { unplaced++; continue }
        events.push({ kind: 'cashflow', id: String(c.event_id), earliest: c.at_ms, latest: c.at_ms, delta: finite(c.delta),
          balance: finite(c.balance), version: brokerVersion(c.balance_version), currency: c.currency ?? null, source: c.balance_source ?? null })
      }
    }
    // Time order; within one instant the broker's own balanceVersion, then the
    // id. A wrong order inside a tie can only break a proof, never make one.
    events.sort((a, b) => a.earliest - b.earliest
      || (a.version != null && b.version != null ? a.version - b.version : 0)
      || (a.kind === b.kind ? Number(a.id) - Number(b.id) : a.kind === 'deal' ? -1 : 1))
    const out = { accountId: id, host, registered: host != null, currency, currencyReason, events, unplaced }
    cache.set(id, out)
    return out
  }

  /** The balance proven at edge `atMs`, or why it cannot be. */
  function at(accountId, atMs) {
    const a = account(accountId)
    if (!Number.isSafeInteger(atMs)) return { status: 'not_stored', reason: 'invalid_edge' }
    if (!a.registered) return { status: 'not_stored', reason: 'account_not_registered' }
    if (!a.currency) return { status: 'not_stored', reason: a.currencyReason }
    const ev = a.events
    const withBalance = ev.filter(e => e.balance != null)
    if (!withBalance.length) return { status: 'not_stored', reason: 'no_balance_evidence_stored' }
    const storedFrom = withBalance[0].latest, storedThrough = withBalance.at(-1).earliest
    // [from, to): an event that may be at E or later is on B's side.
    let j = ev.findIndex(e => e.earliest >= atMs)
    if (j < 0) j = ev.length
    const A = ev[j - 1], B = ev[j]
    if (!A) return { status: 'not_stored', reason: 'before_first_stored_event', storedFrom }
    // The edge falls inside the second a whole-second close time names: that
    // close may be just before the edge or at/after it, so which balance held
    // at the edge is not known. Any event that may be at or after the edge
    // counts, not only the last one. (A close stamped to a second that STARTS
    // at the edge is provably at/after it, so it is B, not ambiguous.)
    for (let k = j - 1; k >= 0 && ev[k].earliest > atMs - 1000; k--) {
      if (ev[k].latest >= atMs) return { status: 'not_stored', reason: 'edge_inside_event_time', event: ref(ev[k]) }
    }
    if (!B) return { status: 'not_stored', reason: 'after_last_stored_event', storedThrough }
    const link = linkProof(A, B, a.currency)
    if (!link.proof) return { status: 'not_stored', ...link }
    return {
      status: 'observed', value: A.balance, currency: a.currency, at: A.latest, ageMs: atMs - A.latest,
      source: A.kind === 'cashflow' ? 'broker_cashflow' : A.source === 'statement' ? 'broker_statement' : 'broker_deal',
      basis: 'broker_post_event_balance_reconciled_to_next_event', proof: link.proof,
      event: ref(A), provenUntil: B.earliest, nextEvent: ref(B),
    }
  }

  /** Counts that say what is stored, what is missing and why, per account. */
  function coverage(accountId) {
    const a = account(accountId)
    const deals = { total: 0, withBalance: 0, bySource: {}, withoutBalance: {} }
    const cashflows = { total: 0, withBalance: 0, withoutBalance: {} }
    const links = { reconciled: 0, versionConsecutive: 0, arithmeticOnly: 0, breaks: 0, versionGaps: 0, notCheckable: 0 }
    for (const e of a.events) {
      const c = e.kind === 'deal' ? deals : cashflows
      c.total++
      if (e.balance != null) {
        c.withBalance++
        if (e.kind === 'deal') deals.bySource[e.source] = (deals.bySource[e.source] ?? 0) + 1
      } else {
        const label = missingLabel(e)
        c.withoutBalance[label] = (c.withoutBalance[label] ?? 0) + 1
      }
    }
    for (let i = 1; i < a.events.length; i++) {
      const p = a.currency ? linkProof(a.events[i - 1], a.events[i], a.currency) : { reason: 'no_currency' }
      if (p.proof) {
        links.reconciled++
        if (p.proof === 'balance_version_consecutive') links.versionConsecutive++
        else links.arithmeticOnly++
      } else if (p.reason === 'balance_chain_break') links.breaks++
      else if (p.reason === 'balance_version_gap') links.versionGaps++
      else links.notCheckable++
    }
    const withBalance = a.events.filter(e => e.balance != null)
    return {
      accountId: a.accountId, registered: a.registered, currency: a.currency, currencyReason: a.currencyReason,
      deals, cashflows, unplacedEvents: a.unplaced, links,
      firstBalanceAt: withBalance.length ? new Date(withBalance[0].latest).toISOString() : null,
      lastBalanceAt: withBalance.length ? new Date(withBalance.at(-1).earliest).toISOString() : null,
    }
  }

  return { account, at, coverage, accountIds: () => [...hosts.keys()] }
}

/**
 * GET /state/deal-balances: per account, the stored balance evidence and its
 * gaps, and optionally the balance proven at the requested edges.
 */
export function dealBalanceReport(db, { accountId = null, edges = [], currencyByAccount } = {}) {
  const reader = dealBalanceReader(db, { currencyByAccount })
  const ids = accountId == null ? reader.accountIds() : [String(accountId)]
  return {
    basis: 'broker_post_event_balance_reconciled_to_next_event',
    rule: 'Windows are [from, to): the balance at an edge is the one before any event at the edge. It is read only when the first stored event at or after the edge reconciles to the cent with the last one before it (and its balanceVersion is the next one, where both carry it). Anything else is a labelled gap.',
    labels: BALANCE_GAP_LABELS,
    accounts: ids.map(id => ({
      ...reader.coverage(id),
      edges: edges.map(e => ({ edge: new Date(e).toISOString(), ...reader.at(id, e) })),
    })),
  }
}
