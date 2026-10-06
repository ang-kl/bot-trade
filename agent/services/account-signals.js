// Read-only presentation of the SAME shared scans the entry dispatcher uses.
// Watchlist membership means applicability, never broker approval or a fill.
import { getState } from '../db.js'
import { listAccounts } from './account-registry.js'
import { readWatchlist, symbolAllowsStrategy } from './watchlists.js'
import { effectivePhases } from './account-phases.js'
import { tradeStageGate } from './stage-matrix.js'
import { enabledStrategies } from './strategies.js'

export function accountSignals(db, snapshot, { accountId = 'all', lastScanAt = null } = {}) {
  const scans = Array.isArray(snapshot?.scans) ? snapshot.scans : []
  const accounts = listAccounts(db).filter(a => a.mode !== 'archived' && (accountId === 'all' || String(a.account_id) === String(accountId)))
  const armed = enabledStrategies(db, getState).map(s => s.key)
  // Restrict to the current retained batch. The three foreign-key joins are
  // proof of use; account/symbol/time proximity alone is never proof.
  const receipts = lastScanAt ? db.prepare(`
    SELECT s.symbol, s.strategy, s.timeframe, s.bias, t.account_id, t.id AS trade_id,
      t.status, t.ctrader_position_id, t.opened_at
    FROM (SELECT id, account_id, symbol, side, status, analysis_id, ctrader_position_id, opened_at
      FROM trades ORDER BY id DESC LIMIT 200) t
    JOIN analyses a ON a.id=t.analysis_id JOIN scans s ON s.id=a.scan_id
    WHERE s.scanned_at=? AND a.symbol=s.symbol AND a.strategy=s.strategy
      AND json_extract(CASE WHEN json_valid(a.synthesis) THEN a.synthesis ELSE '{}' END, '$.timeframe')=s.timeframe
      AND lower(a.consensus_bias)=lower(s.bias)
      AND t.symbol=s.symbol AND t.account_id IS NOT NULL
      AND ((lower(s.bias)='long' AND lower(t.side) IN ('buy','long'))
        OR (lower(s.bias)='short' AND lower(t.side) IN ('sell','short')))
    ORDER BY t.id DESC LIMIT 200`).all(lastScanAt) : []
  const key = (sc, id) => JSON.stringify([String(id), sc.symbol, sc.strategy, sc.timeframe, sc.bias])
  const entries = new Map()
  for (const r of receipts) if (!entries.has(key(r, r.account_id))) entries.set(key(r, r.account_id), r)
  const rows = []
  for (const a of accounts) {
    const id = String(a.account_id), phases = effectivePhases(db, id)
    const stageVerdicts = new Map()
    const watch = new Map(readWatchlist(db, id).filter(w => w.enabled).map(w => [w.symbol, w]))
    for (const sc of scans) {
      const item = watch.get(sc.symbol)
      if (!item) continue
      const off = ['scan', 'analyze', 'autotrade'].find(p => !phases[p])
      const stageKey = JSON.stringify([sc.strategy, sc.filters_failed || []])
      if (!stageVerdicts.has(stageKey)) stageVerdicts.set(stageKey, tradeStageGate(db, getState, { strategy: sc.strategy, filtersFailed: sc.filters_failed, accountId: id }))
      const gate = stageVerdicts.get(stageKey)
      const symbolGate = symbolAllowsStrategy(item, sc.strategy, armed)
      const reason = off ? `${off} off for this account` : !gate.ok ? gate.reason : !symbolGate.ok ? symbolGate.reason : null
      const receipt = entries.get(key(sc, id))
      rows.push({ ...sc, account_id: id,
        accountLabel: `${a.is_live ? 'Live' : 'Demo'} ${a.trader_login || id} · ${id}`,
        eligibility: reason ? 'scan_only' : 'candidate', reason,
        entry: receipt ? { accountId: id, tradeId: receipt.trade_id, status: receipt.status,
          positionId: receipt.ctrader_position_id ?? null, at: receipt.opened_at } : null })
    }
  }
  return { accountId, rows, lastScanAt, source: 'shared_scan_account_watchlist',
    receiptCoverage: 'latest_200_trades_exact_current_batch_links',
    note: 'Shared scans feed strategy selection and per-account entry gates. Candidates are not approvals; a recorded trade requires a scan → analysis → account trade link (latest 200 trade rows checked).' }
}
