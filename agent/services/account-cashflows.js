const EXTERNAL = new Set([0, 1, 30, 31, 32, 33, 36, 37])
const ADJUSTMENT = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 27, 28, 29, 34, 35])
const id = n => n != null && /^[1-9]\d*$/.test(String(n)) ? String(n) : null
function decoded(value, digits) {
  if (!Number.isInteger(digits) || digits < 0 || digits > 10 || value == null || !/^-?\d+$/.test(String(value))) throw new Error('cashflow_money_invalid')
  const n = Number(value)
  if (!Number.isSafeInteger(n)) throw new Error('cashflow_money_precision_unavailable')
  return n / 10 ** digits
}

/** Atomic: a malformed item cannot leave a supposedly complete partial window. */
export function recordCashflowWindow(db, { accountId, host, currency, from, to, response, receivedAt = Date.now() }) {
  if (!id(accountId) || !['demo.ctraderapi.com', 'live.ctraderapi.com'].includes(host) || !/^[A-Z]{3}$/.test(currency || '')
    || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to - from > 604800_000
    || !Number.isSafeInteger(receivedAt) || to > receivedAt || String(response?.ctidTraderAccountId) !== String(accountId)
    || response.error || response.errorCode || response.hasMore
    || !(response.depositWithdraw == null || Array.isArray(response.depositWithdraw)) || (response.depositWithdraw || []).length > 10_000) throw new Error('cashflow_response_invalid')
  const rows = (response.depositWithdraw || []).map(r => {
    const at = Number(r.changeBalanceTimestamp), type = Number(r.operationType)
    if (!id(r.balanceHistoryId) || !Number.isSafeInteger(at) || at < from || at > to || r.operationType == null || !Number.isSafeInteger(type)) throw new Error('cashflow_item_invalid')
    return { id: id(r.balanceHistoryId), at, type, delta: decoded(r.delta, r.moneyDigits),
      kind: EXTERNAL.has(type) ? 'external' : ADJUSTMENT.has(type) ? 'adjustment' : 'unclassified' }
  })
  db.transaction(() => {
    const insert = db.prepare(`INSERT INTO account_cashflows (account_id,host,event_id,at_ms,currency,delta,operation_type,kind,received_ms)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,host,event_id) DO NOTHING`)
    for (const r of rows) {
      const old = db.prepare('SELECT at_ms,currency,delta,operation_type FROM account_cashflows WHERE account_id=? AND host=? AND event_id=?').get(String(accountId),host,r.id)
      if (old && (old.at_ms !== r.at || old.currency !== currency || old.delta !== r.delta || old.operation_type !== r.type)) throw new Error('cashflow_duplicate_conflict')
      insert.run(String(accountId),host,r.id,r.at,currency,r.delta,r.type,r.kind,receivedAt)
    }
    // Compact only overlapping/touching, proven intervals in the same units.
    // A collector running all day must not add an ever-growing row per poll.
    const windows = db.prepare(`SELECT from_ms,to_ms,received_ms FROM account_cashflow_windows
      WHERE account_id=? AND host=? AND currency=?`).all(String(accountId),host,currency)
    windows.push({ from_ms: from, to_ms: to, received_ms: receivedAt })
    windows.sort((a, b) => a.from_ms - b.from_ms)
    const merged = []
    for (const window of windows) {
      const last = merged.at(-1)
      if (last && last.to_ms >= window.from_ms) {
        last.to_ms = Math.max(last.to_ms, window.to_ms)
        last.received_ms = Math.max(last.received_ms, window.received_ms)
      } else merged.push({ ...window })
    }
    db.prepare('DELETE FROM account_cashflow_windows WHERE account_id=? AND host=? AND currency=?').run(String(accountId),host,currency)
    const insertWindow = db.prepare('INSERT INTO account_cashflow_windows (account_id,host,currency,from_ms,to_ms,received_ms) VALUES (?,?,?,?,?,?)')
    for (const w of merged) insertWindow.run(String(accountId),host,currency,w.from_ms,w.to_ms,w.received_ms)
  })()
  return { events: rows.length, from, to }
}
