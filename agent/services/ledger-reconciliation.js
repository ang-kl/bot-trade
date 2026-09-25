// ---------------------------------------------------------------------------
// agent/services/ledger-reconciliation.js — the ledger against the broker,
// per account, in that account's own currency (V3 B2, P5b-2).
//
// GET /state/ledger-reconciliation?account=<id|all> builds this on the report
// worker (performance-populations.js kind 'ledger-reconciliation'): it reads
// trades, broker_deals and position_lifecycle_evidence and writes nothing.
//
// MONEY IS NEVER SUMMED ACROSS CURRENCIES (owner default 25-09-2026). Every
// money figure is one account's, in that account's deposit currency; the
// `byCurrency` block pools accounts through THE one currency source and THE
// one pooling rule on main (B2-m, after V3 WEB-5): each account's currency is
// reportCurrency over depositCurrencies() (deposit-currencies.js), and each
// class's money is pooled by poolByCurrency / splitByCurrency, whose
// populationStats re-checks that every contributing account is recorded in
// that currency and marks a partly priced pool partial. An account whose
// currency is not recorded is listed in `unpooledAccounts`, never pooled.
// A class with no priced position has no money figure (null), never a zero.
// Counts may be added; money may not.
//
// EVERY POSITION GETS ONE CLASS, and the class says what it rests on:
//   basis 'broker_lifecycle'  — the broker's complete position history was
//                               read (a verdict row): agrees, filled,
//                               fragment_resolved, money_disagrees,
//                               money_bearing_fragment, unpriced,
//                               ledger_row_open, open_at_broker,
//                               empty_at_broker, never_filled,
//                               opening_not_retained, permanently_unsupported;
//   basis 'retained_receipts' — only the deals retained in broker_deals, whose
//                               completeness is NOT proven:
//                               agrees_on_receipts, differs_on_receipts,
//                               unpriced_with_receipts;
//   basis 'none'              — no receipt yet: ledger_only_before_receipts
//                               (closed before the loop kept receipts) or
//                               ledger_only_awaiting_receipt (the sweep's);
//   broker side               — broker_only (deals, no ledger row on the
//                               account) and broker_deals_on_rejected_row.
// Rows with no account are their own section: each position's probe on
// every enabled account, and the one account that holds it — or none.
// ---------------------------------------------------------------------------

import { normPosId } from '../lib/pos-id.js'
import { depositCurrencies } from './deposit-currencies.js'
import { poolByCurrency, reportCurrency } from '../shared/performance-populations.js'
import { findDuplicateTrades } from './trade-integrity.js'
import { VERDICTS, NO_ACCOUNT_PROBED_SQL } from './position-lifecycle-evidence.js'

/** Before this, deal receipts were written only by the manual import. */
export const RECEIPTS_SINCE = '2026-07-28T00:00:00Z'
const LIST_MAX = 50
/** The duplicate audit reads closes in this window only (findDuplicateTrades's
 * own default, passed explicitly and echoed on each account's block), while
 * the rest of the report covers all time. */
export const DUPLICATES_WINDOW_DAYS = 90
const TOL = 0.011
const r2 = v => v == null ? null : Math.round(v * 100) / 100
const ms = v => {
  if (v == null || v === '') return NaN
  const raw = String(v).replace(' ', 'T')
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`)
}

export const CLASS_BASIS = Object.freeze({
  // Every verdict but `unreadable` (not a verdict about the position). This
  // includes `no_ledger_row`: a position read under it may have gained a
  // ledger row since, and the report says so (ledgerChangedSinceRead).
  ...Object.fromEntries(Object.keys(VERDICTS).filter(v => v !== 'unreadable').map(v => [v, 'broker_lifecycle'])),
  agrees_on_receipts: 'retained_receipts',
  differs_on_receipts: 'retained_receipts',
  unpriced_with_receipts: 'retained_receipts',
  ledger_only_before_receipts: 'none',
  ledger_only_awaiting_receipt: 'none',
  broker_only: 'broker_receipts',
  broker_deals_on_rejected_row: 'broker_receipts',
})
/** Classes that need nobody's attention: listed as counts only. */
const QUIET = new Set(['agrees', 'filled', 'fragment_resolved', 'agrees_on_receipts'])

// Each money figure carries the count of positions it prices (ledgerPriced,
// brokerPriced, pricedBoth for the delta): a figure over fewer positions than
// the class holds is partial, and one over none is null — never a zero.
function emptyClass() {
  return { positions: 0, rows: 0, writtenOff: 0, ledgerNet: null, ledgerPriced: 0, brokerNet: null, brokerPriced: 0, delta: null, pricedBoth: 0 }
}
const addMoney = (sum, v) => r2((sum ?? 0) + v)
// The three money figures of a class and the count each is priced over.
const CLASS_MONEY = Object.freeze([['ledgerNet', 'ledgerPriced'], ['brokerNet', 'brokerPriced'], ['delta', 'pricedBoth']])

/**
 * Per currency, per class: THE pooling rule (poolByCurrency → splitByCurrency
 * → populationStats), once per money figure, keyed by the one currency reader
 * `currencyOf` (reportCurrency over depositCurrencies()). Counts (positions,
 * rows, written-off rows) are added only over the accounts the rule pooled.
 * Accounts in no currency are returned as `unpooledAccounts`; their money
 * stays in their own account section.
 */
export function poolClassesByCurrency(accounts, currencyOf) {
  const byCurrency = {}
  for (const s of accounts) {
    const c = currencyOf(s.accountId)
    if (c) (byCurrency[c] ??= { accountIds: [], classes: {} }).accountIds.push(s.accountId)
  }
  const unpooledAccounts = accounts.filter(s => !currencyOf(s.accountId)).map(s => s.accountId)
  const names = [...new Set(accounts.flatMap(s => Object.keys(s.classes)))].sort()
  for (const cls of names) {
    const holders = accounts.filter(s => s.classes[cls])
    for (const [net, priced] of CLASS_MONEY) {
      const { moneyByCurrency } = poolByCurrency(holders.map(s => ({ accountId: s.accountId, recordedNet: s.classes[cls][net],
        closedN: s.classes[cls].positions, pricedN: s.classes[cls][priced] })), currencyOf)
      for (const pool of moneyByCurrency) {
        const t = byCurrency[pool.currency].classes[cls] ??= (() => {
          const inPool = holders.filter(s => pool.accountIds.includes(s.accountId))
          return { positions: pool.closedN, rows: inPool.reduce((n, s) => n + s.classes[cls].rows, 0),
            writtenOff: inPool.reduce((n, s) => n + s.classes[cls].writtenOff, 0) }
        })()
        t[net] = pool.recordedNet == null ? null : r2(pool.recordedNet)
        t[priced] = pool.pricedN
        t[`${net}MoneyState`] = pool.moneyState
      }
    }
  }
  return { byCurrency, unpooledAccounts }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ accountId?: string|null }} [options] a registered account id, or
 *   'all' / null for every registered account.
 */
export function buildLedgerReconciliation(db, { accountId = null } = {}) {
  // THE one currency source (deposit-currencies.js), read once per report and
  // through reportCurrency, as every per-currency figure on main reads it.
  const currencies = { currencyByAccount: depositCurrencies(db) }
  const currencyOf = id => reportCurrency(currencies, id)
  // Owner principle 1: only routing reads the demo/live flag. The report needs
  // none of it — each probe names the host it read from.
  const registered = db.prepare('SELECT account_id, enabled FROM accounts ORDER BY account_id').all()
    .filter(a => /^[1-9]\d*$/.test(String(a.account_id)))
  const wanted = accountId == null || accountId === 'all' ? registered : registered.filter(a => String(a.account_id) === String(accountId))
  if (!wanted.length) throw new RangeError('account not registered')
  const noAccountPids = new Set(db.prepare(`SELECT ctrader_position_id AS pid FROM trades WHERE account_id IS NULL AND ctrader_position_id IS NOT NULL`)
    .all().map(r => normPosId(r.pid)).filter(Boolean))
  let dupes = null
  try { dupes = findDuplicateTrades(db, { scope: null, windowDays: DUPLICATES_WINDOW_DAYS }) } catch { dupes = null }

  const accounts = wanted.map(a => accountSection(db, String(a.account_id), {
    enabled: Number(a.enabled) === 1, currency: currencyOf(a.account_id),
    currencyEvidence: currencies.currencyByAccount[String(a.account_id)] ?? null,
    noAccountPids, dupes,
  }))

  // Pool per recorded currency only, by the one pooling rule.
  const { byCurrency, unpooledAccounts: unpooled } = poolClassesByCurrency(accounts, currencyOf)
  const counts = {}
  for (const s of accounts) for (const [cls, v] of Object.entries(s.classes)) counts[cls] = (counts[cls] || 0) + v.positions

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: accountId == null || accountId === 'all' ? 'all' : String(accountId),
    moneyPolicy: 'per account in its deposit currency; pooled only within one recorded currency by the one pooling rule (poolByCurrency); never summed across currencies; a partly priced pool is marked partial',
    receiptsSince: RECEIPTS_SINCE,
    classBasis: CLASS_BASIS,
    verdictMeaning: Object.fromEntries(Object.entries(VERDICTS).map(([k, v]) => [k, v.meaning])),
    // Position counts per class over the accounts in scope. Counts only.
    positionCounts: counts,
    accounts,
    byCurrency,
    unpooledAccounts: unpooled,
    noAccount: noAccountSection(db, registered),
  }
}

function accountSection(db, accountId, { enabled, currency, currencyEvidence, noAccountPids, dupes }) {
  // Ledger positions: closed rows (any status but rejected/cancelled count as
  // holders; rejected twins are kept for the broker-side classes).
  const ledger = new Map()
  for (const r of db.prepare(`SELECT id, status, net_pnl, closed_at, ctrader_position_id AS pid, COALESCE(pnl_unresolvable, 0) AS written_off
      FROM trades WHERE account_id = ? AND ctrader_position_id IS NOT NULL`).all(accountId)) {
    const pid = normPosId(r.pid)
    if (!/^[1-9]\d*$/.test(pid || '')) continue
    const p = ledger.get(pid) ?? { pid, rows: [], holders: [] }
    p.rows.push(r)
    if (!['rejected', 'cancelled'].includes(r.status)) p.holders.push(r)
    ledger.set(pid, p)
  }
  const receipts = new Map()
  for (const d of db.prepare(`SELECT position_id AS pid, COUNT(*) AS n, ROUND(SUM(net_pnl), 2) AS net, SUM(net_pnl IS NULL) AS unpriced
      FROM broker_deals WHERE account_id = ? AND position_id IS NOT NULL GROUP BY position_id`).all(accountId)) {
    const pid = normPosId(d.pid)
    if (pid) receipts.set(pid, { n: Number(d.n), net: Number(d.unpriced) > 0 ? null : r2(Number(d.net)) })
  }
  const evidence = new Map()
  for (const e of db.prepare(`SELECT position_id AS pid, verdict, reason, broker_net, ledger_net, read_at, source FROM position_lifecycle_evidence
      WHERE account_id = ?`).all(accountId)) evidence.set(normPosId(e.pid), e)

  const classes = {}, lists = {}
  const add = (cls, entry, { rows = 0, writtenOff = 0, ledgerNet = null, brokerNet = null } = {}) => {
    const c = classes[cls] ??= emptyClass()
    c.positions++; c.rows += rows; c.writtenOff += writtenOff
    if (ledgerNet != null) { c.ledgerNet = addMoney(c.ledgerNet, ledgerNet); c.ledgerPriced++ }
    if (brokerNet != null) { c.brokerNet = addMoney(c.brokerNet, brokerNet); c.brokerPriced++ }
    if (ledgerNet != null && brokerNet != null) { c.delta = addMoney(c.delta, ledgerNet - brokerNet); c.pricedBoth++ }
    if (!QUIET.has(cls)) {
      const list = lists[cls] ??= []
      if (list.length < LIST_MAX) list.push(entry)
    }
  }
  const receiptsMs = ms(RECEIPTS_SINCE)
  for (const p of ledger.values()) {
    const closed = p.holders.filter(r => r.status === 'closed')
    if (!closed.length || closed.length !== p.holders.length) {
      // Still open locally (or no holder at all): not reconcilable yet, unless
      // the broker already has deals on a rejected-only position.
      if (!p.holders.length && receipts.has(p.pid)) {
        const rc = receipts.get(p.pid)
        add('broker_deals_on_rejected_row', { positionId: p.pid, tradeIds: p.rows.map(r => r.id), brokerNet: rc.net, receipts: rc.n },
          { rows: p.rows.length, brokerNet: rc.net })
      }
      continue
    }
    const priced = closed.filter(r => r.net_pnl != null)
    const ledgerNet = priced.length ? r2(priced.reduce((s, r) => s + Number(r.net_pnl), 0)) : null
    const writtenOff = closed.filter(r => Number(r.written_off) === 1).length
    const ev = evidence.get(p.pid)
    const rc = receipts.get(p.pid)
    let cls, brokerNet = null, why = null, readAt = null
    if (ev && ev.verdict !== 'unreadable') {
      cls = ev.verdict; brokerNet = ev.broker_net != null ? Number(ev.broker_net) : null; why = ev.reason; readAt = ev.read_at
    } else if (rc) {
      brokerNet = rc.net
      cls = ledgerNet == null ? 'unpriced_with_receipts' : brokerNet != null && Math.abs(ledgerNet - brokerNet) <= TOL ? 'agrees_on_receipts' : 'differs_on_receipts'
    } else {
      const lastClose = Math.max(...closed.map(r => ms(r.closed_at)).filter(Number.isFinite))
      cls = Number.isFinite(lastClose) && lastClose < receiptsMs ? 'ledger_only_before_receipts' : 'ledger_only_awaiting_receipt'
    }
    const entry = { positionId: p.pid, tradeIds: closed.map(r => r.id), ledgerNet, brokerNet,
      delta: ledgerNet != null && brokerNet != null ? r2(ledgerNet - brokerNet) : null, writtenOff,
      ...(why ? { reason: String(why).slice(0, 300), readAt } : {}),
      ...(ev && ev.verdict !== 'unreadable' && ((ev.ledger_net != null && ledgerNet != null && Math.abs(Number(ev.ledger_net) - ledgerNet) > TOL)
        // Read when no row on this account held the position; one does now.
        || ev.verdict === 'no_ledger_row')
        ? { ledgerChangedSinceRead: true } : {}) }
    add(cls, entry, { rows: closed.length, writtenOff, ledgerNet, brokerNet })
  }
  // The broker's side: receipts no ledger row on this account holds.
  for (const [pid, rc] of receipts) {
    if (ledger.has(pid) || noAccountPids.has(pid)) continue
    add('broker_only', { positionId: pid, brokerNet: rc.net, receipts: rc.n }, { brokerNet: rc.net })
  }
  // Duplicate candidates on this account, re-classed by broker evidence.
  let duplicates = null
  // A read that failed (findDuplicateTrades's early answer carries no money
  // split) leaves the block unavailable (null), never a zero.
  if (Array.isArray(dupes?.extraByAccount)) {
    const mine = dupes.groups.filter(g => String(g.accountId) === accountId)
    const money = dupes.extraByAccount.find(b => String(b.accountId) === accountId)
    duplicates = {
      // Closes in the last `windowDays` only — not all time like the classes.
      windowDays: dupes.windowDays,
      groups: mine.length,
      byClassification: mine.reduce((o, g) => ({ ...o, [g.classification]: (o[g.classification] || 0) + 1 }), {}),
      extraRows: money?.rows ?? 0,
      extraNet: money?.pnl ?? 0,
      brokerDistinctRows: mine.filter(g => g.classification === 'broker_distinct').reduce((s, g) => s + g.count, 0),
    }
  }
  return {
    accountId, enabled,
    currency: currency ?? null,
    ...(currency ? { currencySource: currencyEvidence?.source ?? null } : { currencyReason: currencyEvidence?.reason ?? 'deposit_currency_not_recorded' }),
    classes,
    positions: lists,
    duplicates,
  }
}

/**
 * Rows with no account: each position probed on every enabled account (demo
 * and live hosts). Money is listed per row and never totalled — the row has
 * no account, so it has no currency. The rows listed here are exactly the
 * rows the sweep probes (NO_ACCOUNT_PROBED_SQL, shared), so a row reads
 * `probing` only while a probe is still due, never for ever.
 */
function noAccountSection(db, registered) {
  const enabled = registered.filter(a => Number(a.enabled) === 1).map(a => String(a.account_id))
  const rows = db.prepare(`SELECT id, status, symbol, side, net_pnl, opened_at, closed_at, ctrader_position_id AS pid FROM trades t
    WHERE ${NO_ACCOUNT_PROBED_SQL} ORDER BY id LIMIT 200`).all()
  const probe = db.prepare('SELECT account_id, verdict, reason, host, broker_net, symbol_id, opening_side, read_at FROM position_lifecycle_evidence WHERE position_id = ?')
  const out = rows.map(r => {
    const pid = normPosId(r.pid)
    const probes = /^[1-9]\d*$/.test(pid || '') ? probe.all(pid) : []
    const byAccount = Object.fromEntries(probes.map(p => [String(p.account_id), p]))
    const status = enabled.map(a => {
      const p = byAccount[a]
      const state = !p || p.verdict === 'unreadable' || p.verdict === 'permanently_unsupported' ? 'unknown'
        : p.verdict === 'empty_at_broker' ? 'empty' : 'holds'
      return { accountId: a, state, verdict: p?.verdict ?? 'not_probed', host: p?.host ?? null, readAt: p?.read_at ?? null }
    })
    const holds = status.filter(s => s.state === 'holds'), unknown = status.filter(s => s.state === 'unknown')
    let verdict
    if (!pid) verdict = 'no_position_id'
    else if (!enabled.length) verdict = 'no_enabled_account'
    else if (holds.length > 1) verdict = 'held_by_several_accounts'
    else if (unknown.length) verdict = 'probing'
    else if (holds.length === 1) verdict = 'held_by_one_account'
    else verdict = 'no_enabled_account_holds_it'
    const holder = holds.length === 1 && verdict === 'held_by_one_account' ? byAccount[holds[0].accountId] : null
    return {
      tradeId: r.id, positionId: pid, status: r.status, symbol: r.symbol, side: r.side, netPnl: r.net_pnl, closedAt: r.closed_at,
      verdict,
      // Attribution is NOT written (the owner's decision): the report names
      // the one account that holds the lifecycle, with what the broker shows.
      ...(holder ? { heldBy: { accountId: holds[0].accountId, verdict: holder.verdict, brokerNet: holder.broker_net, symbolId: holder.symbol_id,
        openingSide: holder.opening_side, sideMatches: holder.opening_side == null ? null : holder.opening_side === r.side } } : {}),
      probes: status,
    }
  })
  return { enabledAccounts: enabled, rows: out, currency: null, moneyPolicy: 'per row only: a row with no account has no currency' }
}
