// PR-F (owner principle 4, "every trade has a reason" / §3.5 of the plan):
// twelve attribution endpoints were served by the agent and read by no page.
// The Reasons page reads them. This module is the page's pure half — the
// endpoint roster and a generic shaper that renders EACH BODY WITH ITS OWN
// FIELDS: scalars as a summary, nested objects as sub-summaries, arrays of
// objects as a table whose columns are the rows' own keys. Nothing here
// computes a number the agent did not send (no totals, no rates, no
// averages) — a page that added its own arithmetic would be a second,
// unaudited attribution.

export const REASON_ENDPOINTS = [
  { key: 'entry-intents', path: '/state/entry-intents', title: 'Entry intents', why: 'every entry the bot meant to make, with its resolution — UNKNOWN rows are the ones principle 4 forbids after four weeks' },
  { key: 'trade-plans', path: '/state/trade-plans', title: 'Trade plans', why: 'the plan written at entry (strategy, risk event, targets) per trade' },
  { key: 'unknown-pnl', path: '/state/unknown-pnl', title: 'Unknown P&L', why: 'closed rows whose money is not yet resolved from the broker' },
  { key: 'unresolvable-plan', path: '/state/unresolvable-plan', title: 'Unresolvable plan', why: 'rows past the resolution horizon and what writing them off would cost' },
  { key: 'trade-consistency', path: '/state/trade-consistency', title: 'Trade consistency', why: 'trades whose recorded P&L disagrees with their price move (failure mode #6)' },
  { key: 'attribution', path: '/state/attribution', title: 'Attribution', why: 'P&L by strategy / origin on the viewed account' },
  { key: 'refusal-cost', path: '/state/refusal-cost', title: 'Refusal cost', why: 'what the vetoed entries would have done — the refusal ledger' },
  { key: 'exit-counterfactual', path: '/state/exit-counterfactual', title: 'Exit counterfactual', why: 'what a different exit rule would have returned on the same trades' },
  { key: 'exit-price-suspects', path: '/state/exit-price-suspects', title: 'Exit price suspects', why: 'closes whose recorded exit price looks wrong against the broker' },
  { key: 'open-duplicates', path: '/state/open-duplicates', title: 'Open duplicates', why: 'more than one open row for one broker position' },
  { key: 'go-live-readiness', path: '/state/go-live-readiness', title: 'Go-live readiness', why: 'the evidence checks, each with its own verdict' },
  { key: 'phase-audit', path: '/state/phase-audit', title: 'Phase audit', why: 'the viewed account\'s phase switches against what the loop actually did' },
  // V3 L1: every account (the body's scope.account says 'all'); a 503 is
  // shown as the error it is, never as zero flags. 35 rules and up to four
  // stages per account do not fit the default 25 rows, and the default cut
  // hid STK-02..STK-11 from the page — so this block shows 64 rows, and its
  // per-stage summary renders as a table rather than "4 fields".
  { key: 'order-lifecycle', path: '/state/order-lifecycle?account=all', title: 'Order lifecycle', why: 'pre-order, order and close records that failed to store or are incomplete, and anything stuck with no resolver', maxRows: 64, keyedTables: ['summary'] },
]

const isScalar = v => v == null || ['string', 'number', 'boolean'].includes(typeof v)
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v)

export function fmtCell(v) {
  if (v == null) return '—'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 1 ? 4 : 2)
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.length ? v.map(fmtCell).join(', ') : '[]'
  return JSON.stringify(v)
}

/**
 * Split a body into renderable parts, in the body's own key order.
 * `keyedTables` names objects whose every value is itself an object (a
 * per-stage summary): each renders as a table, one row per key, the key in
 * a leading `key` column — the body's own fields, reshaped, nothing computed.
 * @returns {{ scalars: Array<[string,string]>, objects: Array<{key, scalars}>, tables: Array<{key, columns:string[], rows:object[], total:number}>, lists: Array<[string,string]> }}
 */
export function shapeBody(body, { maxRows = 25, keyedTables = [] } = {}) {
  const out = { scalars: [], objects: [], tables: [], lists: [] }
  if (!isObj(body)) return out
  for (const [k, v] of Object.entries(body)) {
    if (isScalar(v)) out.scalars.push([k, fmtCell(v)])
    else if (isObj(v) && keyedTables.includes(k) && Object.values(v).length && Object.values(v).every(isObj)) {
      const rows = Object.entries(v).map(([kk, x]) => ({ key: kk, ...x }))
      const columns = [...new Set(rows.slice(0, maxRows).flatMap(r => Object.keys(r)))]
      out.tables.push({ key: k, columns, rows: rows.slice(0, maxRows), total: rows.length })
    } else if (isObj(v)) {
      const scalars = Object.entries(v).filter(([, x]) => isScalar(x)).map(([kk, x]) => [kk, fmtCell(x)])
      const nested = Object.entries(v).filter(([, x]) => !isScalar(x))
      out.objects.push({ key: k, scalars, nested: nested.map(([kk, x]) => [kk, Array.isArray(x) ? `${x.length} item${x.length === 1 ? '' : 's'}` : `${Object.keys(x).length} field${Object.keys(x).length === 1 ? '' : 's'}`]) })
    } else if (Array.isArray(v)) {
      if (v.length && v.every(isObj)) {
        const columns = [...new Set(v.slice(0, maxRows).flatMap(r => Object.keys(r)))]
        out.tables.push({ key: k, columns, rows: v.slice(0, maxRows), total: v.length })
      } else out.lists.push([k, v.length ? v.map(fmtCell).join(', ') : 'empty'])
    }
  }
  return out
}

/** The per-block read state: 'ok' | 'error' with the agent's own message. */
export function blockState(result) {
  if (result && result.ok) return { status: 'ok', body: result.body }
  const msg = result?.error ?? 'not read'
  return { status: 'error', message: /401|unauthori[sz]ed|bearer/i.test(String(msg)) ? `not read — ${msg} (the state routes need the bearer token)` : `not read — ${msg}` }
}

// These five routes intentionally report across the ledger regardless of the
// viewed account. Other routes must identify their actual returned scope.
const portfolioReports = new Set(['entry-intents', 'trade-plans', 'unknown-pnl', 'unresolvable-plan', 'refusal-cost'])
const nullableAllReports = new Set(['go-live-readiness', 'exit-price-suspects', 'exit-counterfactual'])
export function reasonScope(def, result) {
  if (!result?.ok || !isObj(result.body)) return undefined
  const body = result.body
  const account = body.accountId ?? (isObj(body.scope) ? body.scope.account : undefined)
  if (/^[1-9]\d*$/.test(String(account))) return String(account)
  if (account === 'all' || body.scope === 'all') return 'all'
  if (def.key === 'phase-audit' && typeof body.scope === 'string') {
    const id = /^account ([1-9]\d*)(?: |$)/.exec(body.scope)?.[1]
    if (id) return id
    if (/^all accounts(?: |$)/.test(body.scope)) return 'all'
  }
  if (nullableAllReports.has(def.key) && Object.hasOwn(body, 'accountId') && body.accountId === null) return 'all'
  if (portfolioReports.has(def.key)) return 'all'
  return undefined
}
