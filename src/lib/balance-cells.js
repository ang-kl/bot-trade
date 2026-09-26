// V3 WEB-3. Display text for OBSERVED broker balances and floating P&L on the
// Performance page (rolling 24-hour table and timeframe ledger). Every line is
// either an observed amount with its currency and read time, or the reason it
// is missing. Nothing here computes, carries or fills a balance, and a missing
// edge is never drawn as zero.
import { missingBalanceLabel, unknownCurrencyLabel, utcStamp } from '../../agent/shared/balance-carry.js'

const fixed = v => Number(v).toFixed(2)
const plus = v => `${v > 0 ? '+' : ''}${fixed(v)}`
const finite = v => typeof v === 'number' && Number.isFinite(v)
const ccyOk = c => typeof c === 'string' && /^[A-Z]{3}$/.test(c)
// Which accounts were not read at this edge, so a gap that holds a total open
// names its account (e.g. one disabled later) rather than only a count.
const notRead = ids => Array.isArray(ids) && ids.length
  ? ` Not read: account${ids.length === 1 ? '' : 's'} ${ids.map(String).join(', ')}.` : ''

// V3 WEB-8-m. A ledger edge the stored reads left open can be answered by the
// balance the broker reported after a stored deal or cashflow (deal-balances.js).
// Its time is that event's close — possibly weeks before the edge — not a read
// at the edge, so it is worded as what it is. A real read keeps its wording.
const EVENT_NOUN = { broker_deal: 'deal', broker_cashflow: 'cashflow', broker_statement: 'statement deal' }
const readWhen = (oldestAt, newestAt) => oldestAt === newestAt ? `read ${utcStamp(oldestAt)}` : `oldest read ${utcStamp(oldestAt)}, newest ${utcStamp(newestAt)}`
const eventWhen = (source, t) => {
  const noun = EVENT_NOUN[source]
  if (!t) return `reported after a stored ${noun}, held until the next stored event · ${source}`
  return t.oldestAt === t.newestAt
    ? `reported after the ${noun} at ${utcStamp(t.oldestAt)}, held until the next stored event · ${source}`
    : `reported after the ${noun}s, oldest ${utcStamp(t.oldestAt)}, newest ${utcStamp(t.newestAt)}, each held until the next stored event · ${source}`
}

const readTitle = (g, noun = 'balance') => {
  if (g.oldestAt == null) return ''
  const head = `${g.currency} broker ${noun}${g.accounts > 1 ? ` (sum of ${g.accounts} accounts)` : ''}`
  const sources = Array.isArray(g.sources) ? g.sources : []
  const events = sources.filter(s => EVENT_NOUN[s])
  if (!events.length) return `${head} · ${readWhen(g.oldestAt, g.newestAt)}${sources.length ? ` · ${sources.join(', ')}` : ''}`
  // Reads and deal-proven balances in one group (All accounts): each worded
  // by its own kind, with its own times.
  const times = g.sourceTimes && typeof g.sourceTimes === 'object' ? g.sourceTimes : {}
  const reads = sources.filter(s => !EVENT_NOUN[s])
  const readTimes = reads.map(s => times[s]).filter(t => t && Number.isSafeInteger(t.oldestAt) && Number.isSafeInteger(t.newestAt))
  const parts = []
  if (reads.length) {
    parts.push(readTimes.length
      ? `${readWhen(Math.min(...readTimes.map(t => t.oldestAt)), Math.max(...readTimes.map(t => t.newestAt)))} · ${reads.join(', ')}`
      : reads.join(', '))
  }
  for (const s of events) parts.push(eventWhen(s, times[s]))
  return `${head} · ${parts.join(' · ')}`
}

// V3 WEB-8-m. The accounts at this edge whose stored deal and cashflow
// balances could not be read: said in words, so a failed read is never
// passed off as the reads' own gap (owner principle 6).
const dealUnread = ids => Array.isArray(ids) && ids.length
  ? ` Deal balances unread for account${ids.length === 1 ? '' : 's'} ${ids.map(String).join(', ')}: the broker balances stored on deals and cashflows could not be read, so this edge was not checked against them.` : ''

function validGroupSet(set) {
  return !!set && Array.isArray(set.groups) && set.groups.every(g => g && ccyOk(g.currency)
    && Number.isSafeInteger(g.accounts) && g.accounts > 0 && (g.value == null || finite(g.value)))
    && Number.isSafeInteger(set.unknownCurrencyAccounts ?? 0)
}

/** Lines for one balance edge (a currencyGroups result from the server).
 * `withCurrency` prints the code on a lone group too (the all-accounts view). */
export function balanceLines(set, { money = fixed, withCurrency = false, unavailable = 'balance history unavailable' } = {}) {
  if (!validGroupSet(set)) return [{ key: 'na', text: '—', title: unavailable, missing: true }]
  const lines = set.groups.map(g => g.value != null
    ? { key: g.currency, text: `${set.groups.length > 1 || withCurrency ? `${g.currency} ` : ''}${money(g.value)}`, title: readTitle(g), missing: false, currency: g.currency, value: g.value }
    : { key: g.currency, text: `${set.groups.length > 1 || withCurrency ? `${g.currency} ` : ''}${missingBalanceLabel(g)}`,
      title: `${g.currency}: ${missingBalanceLabel(g)}.${notRead(g.missingAccounts)}${dealUnread(g.dealBalanceUnreadAccounts)} A missing broker balance is not zero and is never estimated.`, missing: true, currency: g.currency, value: null })
  // Accounts in no currency group (V3 WEB-3m): no recorded broker deposit
  // currency, so no balance of theirs is added to any currency's total.
  if (set.unknownCurrencyAccounts > 0) {
    const n = set.unknownCurrencyAccounts, label = unknownCurrencyLabel(set.unknownReason)
    lines.push({ key: 'unknown', missing: true,
      text: lines.length ? `${n} acct ${label}` : n === 1 ? label : `${label} (${n} accounts)`,
      title: `${n} account${n === 1 ? ' has' : 's have'} ${set.unknownReason === 'account_not_registered' ? 'no registration' : 'no recorded broker deposit currency'}, so ${n === 1 ? 'it is' : 'they are'} in no currency total.${notRead(set.unknownAccounts)}` })
  }
  if (!lines.length) return [{ key: 'none', text: '—', title: 'No registered account in this scope', missing: true }]
  return lines
}

/** Floating P&L text for one hour: the last broker reading in the hour, per
 * currency. Null when no currency has a complete reading (nothing to show). */
export function floatingText(set, { signed = plus } = {}) {
  if (!validGroupSet(set)) return null
  const shown = set.groups.filter(g => g.value != null)
  if (!shown.length) return null
  const lone = set.groups.length === 1 && !set.unknownCurrencyAccounts
  const text = shown.map(g => `${lone ? '' : `${g.currency} `}${signed(g.value)}`).join(' · ')
  const open = set.groups.filter(g => g.value == null)
  const missing = open.map(g => `${g.currency} ${missingBalanceLabel(g)}${notRead(g.missingAccounts)}`)
  // A currency with no complete reading is marked ON SCREEN as "USD 1/2 read",
  // not only in the tooltip (V3 WEB-3m, checker N4): no sum is made for it,
  // and the gap is visible where the other currencies' figures are.
  const marks = open.map(g => ` · ${g.currency} ${g.observedAccounts ?? 0}/${g.accounts} read`).join('')
  const title = [...shown.map(g => readTitle(g, 'floating P&L')), ...missing, set.unknownCurrencyAccounts ? `${set.unknownCurrencyAccounts} account(s) ${unknownCurrencyLabel(set.unknownReason)}, in no currency.${notRead(set.unknownAccounts)}` : null]
    .filter(Boolean).join(' · ')
  return { text: `(${text} float)${marks}`, title: `Last broker floating (unrealised) P&L reading in this hour; not in the realised figure or the balance columns. ${title}` }
}

/** V3 WEB-8-m. One sentence for the ledger when the stored deal and cashflow
 * balances could not be read — for the whole report (carry.dealBalances) or
 * for an account at any edge — or null when nothing was hidden. Words, not
 * colour: the page states the failed read instead of showing only the reads'
 * "not stored before …" label. */
export function dealBalanceReadNote(windows) {
  const list = Array.isArray(windows) ? windows : []
  const failed = list.some(w => w?.carry?.dealBalances === 'deal_balance_read_failed')
  const ids = new Set()
  for (const w of list) {
    for (const side of ['in', 'out']) {
      for (const g of w?.carry?.[side]?.groups ?? []) for (const id of g?.dealBalanceUnreadAccounts ?? []) ids.add(String(id))
    }
  }
  if (!failed && !ids.size) return null
  const named = `account${ids.size === 1 ? '' : 's'} ${[...ids].sort().join(', ')}`
  // The whole report's read failed, or only some accounts' (the rest were read).
  const scope = failed
    ? `for this report${ids.size ? ` (${named})` : ''}, so no carry edge was checked against them`
    : `for ${named}, so ${ids.size === 1 ? 'that account’s' : 'those accounts’'} carry edges were not checked against them`
  return `Deal balances unread: the broker balances stored on deals and cashflows could not be read ${scope}. An edge the stored reads do not answer shows only the reads' own reason (such as “not stored before …”), not a balance the deals might prove; it is not zero and nothing is estimated.`
}

/** Ledger carry text for copy/paste and the phone card (one line). */
export function carryText(w, side, { money = fixed } = {}) {
  const set = w?.carry?.[side]
  const lines = balanceLines(set, { money, withCurrency: false, unavailable: w?.carry?.reason ? `unavailable: ${w.carry.reason}` : 'balance history unavailable' })
  return lines.map(l => l.text).join(' · ')
}
