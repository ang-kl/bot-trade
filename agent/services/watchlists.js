// Per-account watchlists — read, write, diff, copy.
//
// UNTIL NOW THERE WAS EXACTLY ONE WATCHLIST. `autopilot_symbols_json` is a
// single global key that every consumer reads, and dispatch loops all
// autopilot accounts over that same symbol list — so every enabled account
// traded the same instruments, and "copy the watchlist to another account"
// was not an operation the system could express.
//
// THE MIGRATION IS DELIBERATELY INERT. A per-account list only exists once
// something writes one. Until then `readWatchlist` returns the global list
// for every account, byte-for-byte what the old code returned, so arming
// this changes nothing about what trades. That matters: these symbols feed
// the dispatch path, and a migration that silently re-scoped a live trading
// universe would be a much bigger event than a UI feature.
//
// Key: acct:<id>:autopilot_symbols_json  (see account-registry.acctKey)
import { getState, setState } from '../db.js'
import { getEnabledAccounts } from './account-registry.js'

export const WATCHLIST_KEY = 'autopilot_symbols_json'
export const LEGACY_KEY = 'watchlist_json'
export const acctWatchlistKey = (accountId) => `acct:${accountId}:${WATCHLIST_KEY}`

const parse = (raw) => {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : null
  } catch { return null }
}

/**
 * Normalize one entry to the shape every consumer expects. A bare string is
 * legal on the wire and has always meant "enabled".
 */
export function normalizeItem(s) {
  if (typeof s === 'string') return { symbol: s.toUpperCase().trim(), enabled: true }
  return { ...s, symbol: String(s?.symbol || '').toUpperCase().trim(), enabled: s?.enabled !== false }
}

/**
 * The watchlist an account actually trades.
 *
 * Resolution order — per-account, then global, then the legacy key. The
 * fallback is what keeps this inert: an account with no list of its own sees
 * exactly what it saw before this file existed.
 *
 * @param {*} db
 * @param {string|number|null} accountId  null → the global list only
 */
export function readWatchlist(db, accountId = null) {
  if (accountId != null && accountId !== '') {
    const own = parse(getState(db, acctWatchlistKey(String(accountId))))
    if (own) return own.map(normalizeItem)
  }
  const global = parse(getState(db, WATCHLIST_KEY)) || parse(getState(db, LEGACY_KEY))
  return (global || []).map(normalizeItem)
}

/** True when this account has its OWN list rather than inheriting the global one. */
export function hasOwnWatchlist(db, accountId) {
  if (accountId == null || accountId === '') return false
  return parse(getState(db, acctWatchlistKey(String(accountId)))) != null
}

/**
 * Write an account's own list. Writing is what ends the inheritance — from
 * here on this account diverges from the global list, deliberately.
 */
export function writeWatchlist(db, accountId, items) {
  if (accountId == null || accountId === '') throw new Error('writeWatchlist needs an accountId')
  if (!Array.isArray(items)) throw new Error('writeWatchlist needs an array')
  const clean = items.map(normalizeItem).filter(i => i.symbol)
  setState(db, acctWatchlistKey(String(accountId)), JSON.stringify(clean))
  return clean
}

// Fields that travel WITH a symbol when it is copied. A copy that moved only
// the ticker would silently reset the destination's sizing and thresholds to
// defaults — the symbol would look transferred and behave differently.
export const CARRIED_FIELDS = [
  'enabled', 'group', 'maxVolume', 'autoTradeThreshold', 'allowed_styles', 'override_bias',
  'strategies',
]

const carried = (item) => {
  const out = { symbol: item.symbol }
  for (const f of CARRIED_FIELDS) if (item[f] !== undefined) out[f] = item[f]
  return out
}

/** Stable comparison of the fields that actually affect behaviour. */
function settingsEqual(a, b) {
  return CARRIED_FIELDS.every(f => JSON.stringify(a?.[f] ?? null) === JSON.stringify(b?.[f] ?? null))
}

/**
 * Compare two accounts' lists.
 *
 * Three buckets rather than two, because "present in both" is not the same
 * as "the same": a symbol can exist on both sides with a different lot cap or
 * conviction threshold, and that difference is exactly what a compare view
 * exists to surface.
 */
export function diffWatchlists(a, b) {
  const bySym = (list) => new Map(list.map(i => [i.symbol, i]))
  const A = bySym(a), B = bySym(b)
  const onlyA = [], onlyB = [], differs = [], same = []
  for (const [sym, ia] of A) {
    const ib = B.get(sym)
    if (!ib) onlyA.push(ia)
    else if (settingsEqual(ia, ib)) same.push(ia)
    else differs.push({ symbol: sym, source: ia, destination: ib })
  }
  for (const [sym, ib] of B) if (!A.has(sym)) onlyB.push(ib)
  return { onlyA, onlyB, differs, same }
}

/**
 * Copy chosen symbols from one account to others.
 *
 * `mode: 'merge'` adds/overwrites just those symbols and leaves the rest of
 * the destination alone. `mode: 'replace'` makes the destination exactly the
 * chosen set — destructive, so the caller must ask for it explicitly.
 *
 * Returns a per-destination report of what actually changed, because "copied"
 * with no numbers is not something an operator can check.
 */
export function copyWatchlist(db, { from, to, symbols = null, mode = 'merge' } = {}) {
  if (from == null || from === '') throw new Error('copy needs a source account')
  const targets = (Array.isArray(to) ? to : [to]).filter(t => t != null && t !== '')
  if (!targets.length) throw new Error('copy needs at least one destination account')
  if (targets.some(t => String(t) === String(from))) throw new Error('cannot copy an account onto itself')
  if (mode !== 'merge' && mode !== 'replace') throw new Error(`unknown copy mode '${mode}'`)

  const source = readWatchlist(db, from)
  const wanted = symbols == null
    ? source
    : source.filter(i => symbols.map(s => String(s).toUpperCase()).includes(i.symbol))
  if (!wanted.length) throw new Error('no matching symbols on the source watchlist')

  const results = []
  for (const acct of targets) {
    // A destination that has never had its own list is INHERITING the shared
    // one. Merging into it keeps everything it currently trades and adds the
    // chosen symbols — nothing stops trading, which is the safe outcome for a
    // live account. But it also ends the inheritance permanently: from here
    // the account no longer follows edits to the shared list. That is inherent
    // to owning a list at all, and it is reported rather than left to be
    // discovered later when a symbol added globally fails to appear.
    const inherited = !hasOwnWatchlist(db, acct)
    const before = readWatchlist(db, acct)
    let next
    if (mode === 'replace') {
      next = wanted.map(carried)
    } else {
      const byS = new Map(before.map(i => [i.symbol, i]))
      for (const i of wanted) byS.set(i.symbol, { ...byS.get(i.symbol), ...carried(i) })
      next = [...byS.values()]
    }
    writeWatchlist(db, acct, next)
    const beforeSyms = new Set(before.map(i => i.symbol))
    results.push({
      accountId: String(acct),
      inherited,
      added: wanted.filter(i => !beforeSyms.has(i.symbol)).map(i => i.symbol),
      updated: wanted.filter(i => beforeSyms.has(i.symbol)).map(i => i.symbol),
      removed: mode === 'replace'
        ? before.filter(i => !wanted.some(w => w.symbol === i.symbol)).map(i => i.symbol)
        : [],
      total: next.length,
    })
  }
  return { from: String(from), mode, copied: wanted.length, results }
}

/**
 * Every symbol ANY enabled account may trade.
 *
 * The universe consumers — the guardian's spot stream, the burn-in candidate
 * pool, the pending-signal retry sweep, the ATR baseline refresh — must cover
 * the union, not one account's list. If account B watches a symbol A does not,
 * that symbol still needs ticks and still needs its queued signals retried;
 * scoping those to a single account would leave B's instruments unwatched
 * while B was still trading them.
 *
 * With no per-account lists this returns exactly the shared list, so it is a
 * drop-in for the old global read.
 */
export function readTradableUnion(db, accountIds = null) {
  let ids = accountIds
  if (!ids) {
    try {
      // Every ENABLED account, not just the actively-trading ones: a
      // `manage_only` account still holds positions that need ticks and
      // still needs its trailing stops fed.
      ids = getEnabledAccounts(db).map(a => a.account_id)
    } catch { ids = [] }
  }
  const byS = new Map()
  for (const item of readWatchlist(db, null)) byS.set(item.symbol, item)
  for (const id of ids) {
    for (const item of readWatchlist(db, id)) {
      // First writer wins on settings; membership is what the union is for.
      if (!byS.has(item.symbol)) byS.set(item.symbol, item)
    }
  }
  return [...byS.values()]
}

/**
 * May this account trade this symbol?
 *
 * The per-account gate. Returns { ok, reason } so the caller can record WHY
 * rather than skipping silently — the lesson from the stage-matrix gate,
 * which blocked every dispatch for a day while writing only to stdout.
 */
export function accountMayTrade(db, accountId, symbol) {
  const sym = String(symbol || '').toUpperCase()
  const item = readWatchlist(db, accountId).find(i => i.symbol === sym)
  if (!item) return { ok: false, reason: `${sym} is not on account ${accountId}'s watchlist` }
  if (item.enabled === false) return { ok: false, reason: `${sym} is disabled on account ${accountId}'s watchlist` }
  return { ok: true, reason: null, item }
}

/**
 * Which strategies may trade THIS symbol.
 *
 * `item.strategies` is a NARROWING filter over the globally-armed set, never a
 * widening one. A symbol row cannot arm a strategy the operator has disarmed
 * globally — that would be a back door for an unproven edge to reach capital
 * without anyone deciding to let it, which is exactly the reason fvg_retrace
 * ships disarmed in the registry. So: intersection, always.
 *
 * Unset / empty / not-an-array means "follow the global set", which is what
 * every existing row means today — so this is inert until someone picks.
 *
 * @param {string[]} globalArmed  enabledStrategies(...).map(s => s.key)
 */
export function resolveSymbolStrategies(item, globalArmed) {
  const armed = Array.isArray(globalArmed) ? globalArmed : []
  const picked = item?.strategies
  if (!Array.isArray(picked) || picked.length === 0) return armed
  const want = new Set(picked.map(k => String(k)))
  return armed.filter(k => want.has(k))
}

/**
 * May this strategy trade this symbol on this account?
 *
 * Enforced at DISPATCH rather than at scan time, because the scan has no
 * account in scope — two accounts can pick different strategies for the same
 * symbol, so there is no single answer to narrow the scan by. The cost is one
 * wasted compute per suppressed signal; the alternative is a scan that is
 * wrong for whichever account it did not pick.
 *
 * Returns { ok, reason } so the skip can be recorded, never dropped silently.
 */
export function symbolAllowsStrategy(item, strategy, globalArmed) {
  const key = String(strategy || '')
  if (!key) return { ok: true, reason: null }
  const picked = item?.strategies
  // No per-symbol choice → the global set already decided; nothing to add.
  if (!Array.isArray(picked) || picked.length === 0) return { ok: true, reason: null }
  const allowed = resolveSymbolStrategies(item, globalArmed)
  if (allowed.includes(key)) return { ok: true, reason: null }
  // Say WHICH of the two rules refused, because the fixes are different: a
  // globally-disarmed strategy is fixed in Tune > Strategies, a
  // symbol-excluded one on the symbol's own row.
  const globallyOff = !(Array.isArray(globalArmed) ? globalArmed : []).includes(key)
  return {
    ok: false,
    reason: globallyOff
      ? `${key} is not armed globally`
      : `${key} is not one of ${item.symbol}'s ${picked.length} chosen strategies`,
  }
}
