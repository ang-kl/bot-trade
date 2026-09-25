// V3 WEB-3. Display text for OBSERVED broker balances and floating P&L on the
// Performance page (rolling 24-hour table and timeframe ledger). Every line is
// either an observed amount with its currency and read time, or the reason it
// is missing. Nothing here computes, carries or fills a balance, and a missing
// edge is never drawn as zero.
import { missingBalanceLabel, utcStamp } from '../../agent/shared/balance-carry.js'

const fixed = v => Number(v).toFixed(2)
const plus = v => `${v > 0 ? '+' : ''}${fixed(v)}`
const finite = v => typeof v === 'number' && Number.isFinite(v)
const ccyOk = c => typeof c === 'string' && /^[A-Z]{3}$/.test(c)
// Which accounts were not read at this edge, so a gap that holds a total open
// names its account (e.g. one disabled later) rather than only a count.
const notRead = ids => Array.isArray(ids) && ids.length
  ? ` Not read: account${ids.length === 1 ? '' : 's'} ${ids.map(String).join(', ')}.` : ''

const readTitle = (g, noun = 'balance') => {
  if (g.oldestAt == null) return ''
  const when = g.oldestAt === g.newestAt ? `read ${utcStamp(g.oldestAt)}` : `oldest read ${utcStamp(g.oldestAt)}, newest ${utcStamp(g.newestAt)}`
  return `${g.currency} broker ${noun}${g.accounts > 1 ? ` (sum of ${g.accounts} accounts)` : ''} · ${when}${g.sources?.length ? ` · ${g.sources.join(', ')}` : ''}`
}

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
      title: `${g.currency}: ${missingBalanceLabel(g)}.${notRead(g.missingAccounts)} A missing broker balance is not zero and is never estimated.`, missing: true, currency: g.currency, value: null })
  if (set.unknownCurrencyAccounts > 0) lines.push({ key: 'unknown', missing: true,
    text: lines.length ? `${set.unknownCurrencyAccounts} acct not stored`
      : set.unknownCurrencyAccounts === 1 ? 'not stored' : `not stored (${set.unknownCurrencyAccounts} accounts)`,
    title: `${set.unknownCurrencyAccounts} account${set.unknownCurrencyAccounts === 1 ? ' has' : 's have'} no stored broker balance, so its currency is unknown and it is in no total.${notRead(set.unknownAccounts)}` })
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
  const missing = set.groups.filter(g => g.value == null).map(g => `${g.currency} ${missingBalanceLabel(g)}${notRead(g.missingAccounts)}`)
  const title = [...shown.map(g => readTitle(g, 'floating P&L')), ...missing, set.unknownCurrencyAccounts ? `${set.unknownCurrencyAccounts} account(s) with no stored reading.${notRead(set.unknownAccounts)}` : null]
    .filter(Boolean).join(' · ')
  return { text: `(${text} float)`, title: `Last broker floating (unrealised) P&L reading in this hour; not in the realised figure or the balance columns. ${title}` }
}

/** Ledger carry text for copy/paste and the phone card (one line). */
export function carryText(w, side, { money = fixed } = {}) {
  const set = w?.carry?.[side]
  const lines = balanceLines(set, { money, withCurrency: false, unavailable: w?.carry?.reason ? `unavailable: ${w.carry.reason}` : 'balance history unavailable' })
  return lines.map(l => l.text).join(' · ')
}
