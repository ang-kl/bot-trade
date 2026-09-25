// The ONE reader of each registered account's broker deposit currency for the
// reports (V3 WEB-7; moved here by V3 WEB-3m so the balance reader can use it
// without importing the report worker module). The populations report ships
// its output as `currencyByAccount`, and every per-currency money figure on
// the Performance page keys its currency on it through reportCurrency: the
// gradients' pools, the ledger carry, the hourly balance and floating columns
// and the live floating subtotal (owner default 25-09: money per currency,
// never summed across currencies).
//
// Moved verbatim from agent/services/performance-populations.js, which
// re-exports it; the body is unchanged.

/** Each registered account's broker deposit currency, from the asset-list
 * evidence account-money.js records (recordDepositCurrency), and only when
 * that evidence is for this account on its own host. A cTrader account's
 * deposit asset is fixed, so this names the unit of every P&L it recorded.
 * Missing or mismatched evidence is null with its reason — never a default. */
export function depositCurrencies(db) {
  const evidence = db.prepare('SELECT value FROM agent_state WHERE key = ?')
  const out = {}
  for (const row of db.prepare('SELECT account_id, is_live FROM accounts ORDER BY account_id').all()) {
    const id = String(row.account_id ?? '').trim()
    if (!/^[1-9]\d*$/.test(id)) continue
    let ev = null
    try { ev = JSON.parse(evidence.get(`acct:${id}:deposit_currency_evidence_json`)?.value || 'null') } catch { ev = null }
    const host = row.is_live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
    const ok = ev?.accountId === id && ev.host === host && /^[A-Z]{3}$/.test(ev.currency || '') && Number.isFinite(ev.receivedAt)
    out[id] = ok
      ? { currency: ev.currency, source: ev.source || 'broker_asset_list', observedAt: new Date(ev.receivedAt).toISOString() }
      : { currency: null, reason: ev ? 'deposit_currency_evidence_mismatch' : 'deposit_currency_not_recorded' }
  }
  return out
}
