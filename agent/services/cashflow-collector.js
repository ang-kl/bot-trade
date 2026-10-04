// Reporting-only broker reads, independent of scan/entry and UI refreshes.
// One account, one <=7-day interval per tick; persisted coverage is the cursor.
import { getState, setState, ACCOUNT_HISTORY_SUMMARY_EXPRS } from '../db.js'
import { credsForRegisteredAccount } from '../lib/ctrader-creds.js'
import { tokenRefusedAccounts } from '../lib/token-refused.js'
import { wsGetCashflowHistory } from '../lib/ctrader-ws.js'
import { accountMoney } from './account-money.js'
import { ACCOUNT_HISTORY_RETENTION_DAYS } from './account-history.js'
import { recordCashflowWindow } from './account-cashflows.js'
import { beat } from './heartbeat.js'

const WEEK = 604800_000
export const CASHFLOW_POLL_MS = 30_000
const statusKey = id => `acct:${id}:cashflow_collection_json`
const readStatus = (db, id) => { try { return JSON.parse(getState(db, statusKey(id)) || 'null') } catch { return null } }

const CASHFLOW_ERRORS = new Set(['cashflow_read_timeout', 'cashflow_identity_changed', 'cashflow_response_invalid',
  'cashflow_item_invalid', 'cashflow_money_invalid', 'cashflow_money_precision_unavailable', 'cashflow_duplicate_conflict'])
const BROKER_CODES = new Set(['CH_ACCESS_TOKEN_INVALID', 'ACCOUNT_NOT_AUTHORIZED', 'NOT_LOGGED_IN', 'NO_SUCH_SESSION',
  'CANT_ROUTE_REQUEST', 'REQUEST_FREQUENCY_EXCEEDED', 'REQUEST_FREQUENCY_LIMIT_EXCEEDED', 'INVALID_REQUEST', 'BAD_REQUEST'])
const STORAGE_CODES = new Set(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', 'SQLITE_FULL', 'SQLITE_IOERR', 'SQLITE_CORRUPT'])

// Allowlisted categories only: never retain a broker description, token, URL
// or arbitrary error message in the account receipt or logs.
function failureDetails(error, phase) {
  const message = typeof error?.message === 'string' ? error.message : ''
  if (CASHFLOW_ERRORS.has(message)) return { reason: message }
  if (STORAGE_CODES.has(error?.code)) return {
    reason: ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED'].includes(error.code) ? 'cashflow_database_busy' : 'cashflow_storage_failed',
    storageCode: error.code,
  }
  if (/^cTrader WS queued_timeout after \d+ms/.test(message)) return { reason: 'cashflow_queue_timeout' }
  if (/^cTrader WS timeout after \d+ms/.test(message)) return { reason: 'cashflow_read_timeout' }
  if (/^cTrader WS (error:|closed\b)/.test(message)) return { reason: 'cashflow_transport_failed' }
  const code = message.match(/^cTrader error: ([A-Z_]+)\b/)?.[1]
  if (code && BROKER_CODES.has(code)) return { reason: 'cashflow_broker_rejected', brokerCode: code }
  return { reason: phase === 'persist' ? 'cashflow_persistence_failed' : 'cashflow_read_failed' }
}

// The observation's currency, spelled EXACTLY as idx_account_history_summary
// indexes it (db.js). Written as a bare json_extract(observation_json, ...) the
// two scans below could not use that covering index: SQLite read and parsed the
// ~2 KB JSON of every retained row (90 days, one per minute, per account), and
// the profiler (02-10-2026, CPU_PROFILE_PHASES=starting,scan,monitor) put 27.1 s
// of the first loop's 69.6 s scan phase inside this function, synchronously, at
// every boot. The expression comes from the same constant that builds the index,
// so the two cannot drift apart; INDEXED BY makes a dropped or renamed index a
// loud error ("no such index"), and the plan test pins that the scan stays
// COVERING (a drifted spelling would still use the index, but read every row).
// A malformed row now reads as "no currency", never throws.
const CURRENCY = ACCOUNT_HISTORY_SUMMARY_EXPRS[0]
export const CASHFLOW_WINDOW_SQL = Object.freeze({
  // Latest observation of another host or currency inside the retention window.
  changed: `SELECT MAX(received_ms) at FROM account_history INDEXED BY idx_account_history_summary
    WHERE account_id=? AND received_ms>=? AND received_ms<=?
    AND (host<>? OR (${CURRENCY} IS NOT NULL AND ${CURRENCY}<>?))`,
  // First and last observation of this host and currency since then.
  span: `SELECT MIN(received_ms) first, MAX(received_ms) last FROM account_history INDEXED BY idx_account_history_summary
    WHERE account_id=? AND host=? AND received_ms>=? AND received_ms<=? AND ${CURRENCY}=?`,
})

/** Earliest hole in retained observations, never a cursor guessed from a failure. */
export function nextCashflowWindow(db, { accountId, host, currency, now }) {
  const cutoff = now - ACCOUNT_HISTORY_RETENTION_DAYS * 86400_000
  // Do not label an earlier currency/host regime with today's currency.
  const changed = db.prepare(CASHFLOW_WINDOW_SQL.changed).get(accountId, cutoff, now, host, currency).at
  const span = db.prepare(CASHFLOW_WINDOW_SQL.span)
    .get(accountId, host, Math.max(cutoff, changed == null ? cutoff : changed + 1), now, currency)
  if (span.first == null || span.last <= span.first) return null
  const windows = db.prepare(`SELECT from_ms,to_ms FROM account_cashflow_windows
    WHERE account_id=? AND host=? AND currency=? AND to_ms>=? AND from_ms<=? ORDER BY from_ms`)
    .all(accountId, host, currency, span.first, span.last)
  let from = span.first
  for (const w of windows) {
    if (w.from_ms > from) return { from, to: Math.min(w.from_ms, from + WEEK, span.last) }
    from = Math.max(from, w.to_ms)
    if (from >= span.last) return null
  }
  return { from, to: Math.min(from + WEEK, span.last) }
}

export function makeCashflowCollector(db, { getCreds = credsForRegisteredAccount, read = wsGetCashflowHistory,
  clock = Date.now, timeoutMs = 5000, log = console.log } = {}) {
  let running = false, stopped = false
  const save = (id, value) => setState(db, statusKey(id), JSON.stringify(value))
  const poll = async () => {
    if (running || stopped) return { skipped: stopped ? 'stopped' : 'in_flight' }
    running = true
    let task, timer, accountId, state
    let phase = 'prepare'
    const now = clock()
    try {
      const rows = db.prepare('SELECT account_id FROM accounts ORDER BY account_id').all()
      const cursor = getState(db, 'cashflow_collection_account_cursor')
      const start = rows.findIndex(r => String(r.account_id) === cursor)
      const ordered = rows.slice(start + 1).concat(rows.slice(0, start + 1))
      const refused = tokenRefusedAccounts(db)
      let candidate
      for (const row of ordered) {
        const id = String(row.account_id), creds = getCreds(db, id), money = accountMoney(db, id, { now })
        const previous = readStatus(db, id)
        const reason = refused.has(id) ? 'token_refused' : !creds?.ready || String(creds.accountId) !== id ? 'credentials_unavailable'
          : money.status !== 'fresh' || money.observation.host !== creds.host ? 'currency_or_account_evidence_unavailable' : null
        if (reason) { save(id, { accountId: id, status: 'blocked', reason, checkedAt: now, lastSuccessAt: previous?.lastSuccessAt ?? null }); continue }
        const { host, currency } = money.observation
        const window = nextCashflowWindow(db, { accountId: id, host, currency, now })
        if (!window) { save(id, { ...previous, accountId: id, host, currency, status: 'caught_up', reason: null, checkedAt: now }); continue }
        candidate = { id, creds, host, currency, window, previous }; break
      }
      if (!candidate) return { skipped: 'no_uncovered_observations' }
      const { id, creds, host, currency, window, previous } = candidate
      accountId = id
      state = { accountId, host, currency, status: 'reading', reason: null, checkedAt: now, lastAttemptAt: now,
        lastSuccessAt: previous?.lastSuccessAt ?? null, requested: window }
      save(accountId, state)
      // Advance fairness even when this account fails; retry its same hole next round.
      setState(db, 'cashflow_collection_account_cursor', accountId)
      const deadline = now + timeoutMs
      phase = 'read'
      task = Promise.resolve().then(() => read(host, creds.clientId, creds.clientSecret, creds.accessToken, accountId, window.from, window.to, timeoutMs))
      // A misbehaving transport that never settles holds this lock even after
      // our deadline. No next tick can create overlapping broker reads.
      task.finally(() => { running = false }).catch(() => {})
      const response = await Promise.race([task, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('cashflow_read_timeout')), timeoutMs)
      })])
      if (stopped) return { skipped: 'stopped' }
      if (clock() >= deadline) throw new Error('cashflow_read_timeout')
      const current = getCreds(db, accountId), money = accountMoney(db, accountId, { now: clock() })
      if (!current?.ready || String(current.accountId) !== accountId || current.host !== host
        || money.status !== 'fresh' || money.observation.host !== host || money.observation.currency !== currency
        || tokenRefusedAccounts(db).has(accountId)) throw new Error('cashflow_identity_changed')
      phase = 'persist'
      const result = recordCashflowWindow(db, { accountId, host, currency, ...window, response, receivedAt: clock() })
      // balanceConflicts (V3 WEB-8): events whose stored broker balance this
      // read disagreed with. The first stays stored; the count is kept and
      // logged so the disagreement is visible, not silent.
      state = { ...state, status: 'success', lastSuccessAt: clock(), completed: window, events: result.events,
        balanceConflicts: result.balanceConflicts }
      phase = 'status'
      save(accountId, state)
      log(`[cashflow-collector] account=${accountId} host=${host} currency=${currency} from=${window.from} to=${window.to} events=${result.events} balanceConflicts=${result.balanceConflicts}`)
      return { accountId, ...result }
    } catch (error) {
      // Never copy a transport error that might contain request credentials.
      const details = failureDetails(error, phase)
      const { reason } = details
      if (!stopped && accountId) {
        try { save(accountId, { ...state, status: 'failed', ...details, phase, checkedAt: clock() }) }
        catch (statusError) { log(`[cashflow-collector] account=${accountId} status_write_failed=${failureDetails(statusError, 'status').reason}`) }
        log(`[cashflow-collector] account=${accountId} failed=${reason} phase=${phase}${details.brokerCode ? ` brokerCode=${details.brokerCode}` : ''}${details.storageCode ? ` storageCode=${details.storageCode}` : ''}`)
      }
      return { accountId, error: reason }
    } finally { clearTimeout(timer); if (!task) running = false }
  }
  return { poll, stop: () => { stopped = true } }
}

export function startCashflowCollector(db) {
  const collector = makeCashflowCollector(db)
  const tick = async () => {
    const result = await collector.poll()
    if (result.skipped === 'in_flight' || result.skipped === 'stopped') return
    beat(db, 'cashflow_collection', { ok: !result.error, error: result.error ?? null })
  }
  const timer = setInterval(() => { void tick().catch(() => {}) }, CASHFLOW_POLL_MS)
  timer.unref?.()
  // Let protection establish its broker sessions first after a restart.
  return () => { clearInterval(timer); collector.stop() }
}
