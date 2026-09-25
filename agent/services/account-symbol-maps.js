// ---------------------------------------------------------------------------
// agent/services/account-symbol-maps.js — V3 K2: every registered account's
// OWN symbol map, read daily whether or not the account ever trades.
//
// Until K2, `symbol_id_map:<accountId>` was built only lazily, when an order
// resolved a symbol (ctrader-creds.js resolveSymbolId → fetchAccountSymbolMap).
// An account that never trades (manage-only, scan off, an empty balance) never
// got one, so every reader of an account's own ids stayed empty for it: K1's
// scope tier and the calendar-coverage read (which then names the account
// "missing" for good), the cross-side reconcile's position names, the scanner
// comparisons. A repair nothing calls (CLAUDE.md failure mode #4).
//
// The bound (about 7 reads a day for 7 accounts):
//   - one pass every PASS_MS (5 min), at most ONE ProtoOASymbolsListReq a pass;
//   - only for an account whose map is missing, unreadable, empty, undated,
//     at least REFRESH_AGE_MS (23 h) old, or not proven to be its own list
//     (a map written before K2 may have come through the host-shared cache —
//     ctrader-ws.js wsGetSymbolsList — so it is re-read once). 23 h is an hour
//     inside resolveSymbolId's 24 h TTL, so an order never pays for the read;
//   - between two attempts on one account at least MIN_GAP_MS (30 min); after
//     a failure the gap doubles per consecutive failure up to MAX_BACKOFF_MS
//     (6 h); at most MAX_READS_PER_DAY (3) broker reads per account per UTC
//     day. A healthy roster therefore costs one read per account per day, a
//     failing one at most three.
// The attempt record is persisted (RECEIPT_KEY), so a restart — every merge
// restarts Node — neither resets the backoff and the daily cap nor re-reads a
// map that is still fresh. The first pass runs PASS_MS after boot, not in it.
//
// Read-only at the broker: no order, amend, cancel or subscription. The only
// writes are the map, through fetchAccountSymbolMap (the one writer; it
// refuses a list that names another account and writes nothing then), and
// this service's receipt. A failed read never deletes the stored map: a stale
// map stays readable, with its age, and the failure is recorded beside it.
//
// No read for an account the broker token was REFUSED for (B7, #953 —
// lib/token-refused.js), like every other periodic per-account broker reader:
// each such read answers CH_ACCESS_TOKEN_INVALID, and an auth error fires the
// reactive OAuth refresh, which re-pushes credentials to both sidecars and
// tears the live broker session down (measured 18-09-2026). The account stays
// due, shown `blocked: 'token_refused'`, nothing is counted against its daily
// cap, and it is read on the first pass after the refusal clears.
//
// No read for a DISABLED account either (accounts.enabled = 0), shown
// `blocked: 'account_disabled'`. B7's refused set is recorded only for the
// accounts a sidecar tries, and a sidecar tries only enabled ones
// (getCtraderCreds' roster), so a disabled account the token was never
// granted for could never be marked refused: each of its reads would fire the
// reactive refresh unguarded. Reading only enabled accounts keeps every read
// inside B7's cover — the roster the account-equity sweep and the equity
// snapshot already read. Re-enabled, it is read on the next pass.
//
// Owner principle 1: the account roster and each host come from
// registeredCalendarAccounts (routing only); every account gets the same rule.
// ---------------------------------------------------------------------------
import { getState, setState } from '../db.js'
import { accountSymbolMapKey, credsForRegisteredAccount, fetchAccountSymbolMap, ACCOUNT_SYMBOL_MAP_TTL_MS } from '../lib/ctrader-creds.js'
import { registeredCalendarAccounts } from './watchdog-calendar-refresh.js'
import { disarmReason } from '../lib/env-disarm.js'
import { tokenRefusedAccounts } from '../lib/token-refused.js'

export const SYMBOL_MAP_RECEIPT_KEY = 'account_symbol_map_refresh_json'
export const SYMBOL_MAP_PASS_MS = 5 * 60_000
export const SYMBOL_MAP_REFRESH_AGE_MS = ACCOUNT_SYMBOL_MAP_TTL_MS - 3600_000
export const SYMBOL_MAP_MIN_GAP_MS = 30 * 60_000
export const SYMBOL_MAP_MAX_BACKOFF_MS = 6 * 3600_000
export const SYMBOL_MAP_MAX_READS_PER_DAY = 3
const MAX_ACCOUNTS = 64, DAY_MS = 86400_000, FUTURE_SLACK_MS = 3600_000
// Missing coverage is worse than old coverage: never-built maps lead.
const DUE_RANK = { missing: 0, unreadable: 0, empty: 0, undated: 1, unproven_source: 2, stale: 3 }

const readJson = (db, key) => { try { return JSON.parse(getState(db, key) || 'null') } catch { return null } }
const utcDay = ms => new Date(ms).toISOString().slice(0, 10)
const iso = ms => new Date(ms).toISOString()

/**
 * What is stored for one account: present / missing / unreadable, when it was
 * built, how many names, and whether it is PROVEN to be this account's own
 * list (the `accountId` fetchAccountSymbolMap stamps since K2).
 */
export function accountSymbolMapRecord(db, accountId, now = Date.now()) {
  const raw = getState(db, accountSymbolMapKey(accountId))
  if (raw == null) return { status: 'missing', builtAt: null, ageMs: null, size: 0, ownList: false }
  let parsed = null
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  if (!parsed || typeof parsed.map !== 'object' || parsed.map == null || Array.isArray(parsed.map)) {
    return { status: 'unreadable', builtAt: null, ageMs: null, size: 0, ownList: false }
  }
  const builtAt = typeof parsed.builtAt === 'string' ? parsed.builtAt : null
  const t = Date.parse(builtAt)
  return {
    status: 'present', builtAt, ageMs: Number.isFinite(t) ? now - t : null, size: Object.keys(parsed.map).length,
    ownList: parsed.accountId != null && String(parsed.accountId) === String(accountId),
  }
}

/** Why this map needs a read now, or null when it does not. */
export function symbolMapDueReason(record) {
  if (record.status !== 'present') return record.status
  if (record.size === 0) return 'empty'
  // An undated map, or one dated more than an hour ahead (a skewed or bad
  // write), would otherwise never age into a refresh.
  if (record.ageMs == null || record.ageMs < -FUTURE_SLACK_MS) return 'undated'
  if (record.ageMs >= SYMBOL_MAP_REFRESH_AGE_MS) return 'stale'
  if (!record.ownList) return 'unproven_source'
  return null
}

function backoffMs(failures) {
  return Math.min(SYMBOL_MAP_MAX_BACKOFF_MS, SYMBOL_MAP_MIN_GAP_MS * 2 ** Math.max(0, failures - 1))
}

/** Why a due account must wait, and until when; null when it may be read now. */
function waitFor(state, now) {
  const readsToday = state?.day === utcDay(now) ? Number(state.readsToday) || 0 : 0
  if (readsToday >= SYMBOL_MAP_MAX_READS_PER_DAY) return { blocked: 'daily_cap', notBefore: (Math.floor(now / DAY_MS) + 1) * DAY_MS }
  const last = Date.parse(state?.lastAttemptAt)
  if (Number.isFinite(last)) {
    const failures = Number(state.consecutiveFailures) || 0
    const gap = failures > 0 ? backoffMs(failures) : SYMBOL_MAP_MIN_GAP_MS
    if (now - last < gap) return { blocked: 'backoff', notBefore: last + gap }
  }
  return null
}

function registered(db) {
  const enabled = new Set(db.prepare('SELECT account_id FROM accounts WHERE enabled = 1').all().map(r => String(r.account_id)))
  return [...registeredCalendarAccounts(db).values()]
    .sort((a, b) => a.accountId.localeCompare(b.accountId)).slice(0, MAX_ACCOUNTS)
    .map(a => ({ ...a, enabled: enabled.has(a.accountId) }))
}

/**
 * The refresher's view per registered account: the stored map, whether and
 * why it is due, whether it must wait (a disabled account, a refused token,
 * the daily cap or the backoff) and the last attempt's outcome. Pure reads;
 * the coverage read (calendar-coverage.js) shows it per account.
 */
export function accountSymbolMapRefreshView(db, { now = Date.now() } = {}) {
  const receipt = readJson(db, SYMBOL_MAP_RECEIPT_KEY)
  const refused = tokenRefusedAccounts(db)
  const accounts = registered(db).map(({ accountId, host, enabled }) => {
    const record = accountSymbolMapRecord(db, accountId, now)
    const state = receipt?.accounts?.[accountId] ?? null
    const dueReason = symbolMapDueReason(record)
    // Neither a disabled account nor a refused token has a known end: no
    // notBefore, re-checked every pass.
    const wait = !dueReason ? null
      : !enabled ? { blocked: 'account_disabled', notBefore: null }
        : refused.has(accountId) ? { blocked: 'token_refused', notBefore: null }
          : waitFor(state, now)
    return {
      accountId, host, enabled, map: record, due: dueReason != null, dueReason,
      blocked: wait?.blocked ?? null, notBefore: wait?.notBefore != null ? iso(wait.notBefore) : null,
      lastAttemptAt: state?.lastAttemptAt ?? null, lastResult: state?.lastResult ?? null, lastError: state?.lastError ?? null,
      consecutiveFailures: Number(state?.consecutiveFailures) || 0,
      readsToday: state?.day === utcDay(now) ? Number(state.readsToday) || 0 : 0,
    }
  })
  const at = Date.parse(receipt?.at)
  return {
    at: receipt?.at ?? null, ageMs: Number.isFinite(at) ? now - at : null, pass: receipt?.pass ?? null,
    passEveryMs: SYMBOL_MAP_PASS_MS, refreshAgeMs: SYMBOL_MAP_REFRESH_AGE_MS, maxReadsPerAccountDay: SYMBOL_MAP_MAX_READS_PER_DAY,
    accounts,
  }
}

// Read-modify-write of the receipt: `pass` always, one account's state when
// an attempt was made; accounts no longer registered are dropped. Bookkeeping
// never breaks a pass.
function writeReceipt(db, now, pass, attempt = null) {
  try {
    const previous = readJson(db, SYMBOL_MAP_RECEIPT_KEY)
    const keep = new Set(registered(db).map(a => a.accountId))
    const accounts = Object.fromEntries(Object.entries(previous?.accounts ?? {}).filter(([id]) => keep.has(id)))
    if (attempt) accounts[attempt.accountId] = attempt.state
    setState(db, SYMBOL_MAP_RECEIPT_KEY, JSON.stringify({ at: iso(now), pass, accounts }))
  } catch { /* observation bookkeeping only */ }
  return pass
}

export function createAccountSymbolMapRefresh(db, deps = {}) {
  const clock = deps.now ?? Date.now
  const credentials = deps.credentials ?? (id => credsForRegisteredAccount(db, id))
  // The one writer of an account's map; `now` dates its builtAt.
  const fetchMap = deps.fetchMap ?? ((c, now) => fetchAccountSymbolMap(db, c, { ...(deps.fetchDeps ?? {}), now }))
  let running = false
  return async function refresh() {
    const now = clock()
    if (disarmReason(deps.env)) return writeReceipt(db, now, { result: 'skipped', reason: 'environment_disarmed' })
    if (running) return writeReceipt(db, now, { result: 'skipped', reason: 'in_flight' })
    // No primary recorded = no linked broker (resolveSymbolId's rule): nothing
    // here may reach the network then.
    if (getState(db, 'ctrader_account_id') == null) return writeReceipt(db, now, { result: 'skipped', reason: 'broker_not_linked' })
    running = true
    try {
      const view = accountSymbolMapRefreshView(db, { now })
      const due = view.accounts.filter(a => a.due), ready = due.filter(a => !a.blocked)
      // Due but every one waiting (disabled, a refused token, the cap, the backoff) is
      // not "nothing due": the label follows the counts.
      if (!ready.length) return writeReceipt(db, now, { result: due.length ? 'waiting' : 'nothing_due', due: due.length, waiting: due.length })
      // Never-built maps first; then the account attempted longest ago (never
      // attempted first), so one failing account cannot starve the rest.
      const pick = ready.sort((a, b) => (DUE_RANK[a.dueReason] ?? 9) - (DUE_RANK[b.dueReason] ?? 9)
        || (Date.parse(a.lastAttemptAt) || 0) - (Date.parse(b.lastAttemptAt) || 0)
        || a.accountId.localeCompare(b.accountId))[0]
      const previous = readJson(db, SYMBOL_MAP_RECEIPT_KEY)?.accounts?.[pick.accountId] ?? null
      const c = credentials(pick.accountId)
      let outcome, brokerRead = false
      if (!c?.ready || String(c.accountId) !== pick.accountId || c.host !== pick.host) {
        outcome = { result: 'credentials_unavailable', error: null, size: null }
      } else {
        brokerRead = true
        try {
          const size = Object.keys(await fetchMap(c, now) ?? {}).length
          outcome = size > 0 ? { result: 'built', error: null, size } : { result: 'empty_symbol_list', error: null, size: 0 }
        } catch (e) {
          const message = String(e?.message || e).slice(0, 200)
          outcome = { result: /^account_identity_mismatch/.test(message) ? 'account_identity_mismatch' : 'read_failed', error: message, size: null }
        }
      }
      const built = outcome.result === 'built', day = utcDay(now)
      const readsBefore = previous?.day === day ? Number(previous.readsToday) || 0 : 0
      const state = {
        lastAttemptAt: iso(now), lastResult: outcome.result, lastError: outcome.error, size: outcome.size,
        dueReason: pick.dueReason,
        consecutiveFailures: built ? 0 : (Number(previous?.consecutiveFailures) || 0) + 1,
        day, readsToday: readsBefore + (brokerRead ? 1 : 0),
      }
      return writeReceipt(db, now, {
        result: built ? 'refreshed' : 'failed', accountId: pick.accountId, dueReason: pick.dueReason,
        outcome: outcome.result, brokerRead, due: due.length, waiting: due.length - ready.length,
      }, { accountId: pick.accountId, state })
    } catch (e) {
      return writeReceipt(db, now, { result: 'error', reason: String(e?.message || e).slice(0, 200) })
    } finally { running = false }
  }
}

export function startAccountSymbolMapRefresh(db, deps = {}) {
  if (disarmReason(deps.env)) return () => {}
  const refresh = createAccountSymbolMapRefresh(db, deps)
  const timer = (deps.setInterval ?? setInterval)(() => { refresh().catch(() => {}) }, SYMBOL_MAP_PASS_MS)
  timer.unref?.()
  return () => (deps.clearInterval ?? clearInterval)(timer)
}
