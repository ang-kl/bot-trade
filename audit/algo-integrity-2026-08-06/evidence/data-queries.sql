-- Read-only queries that would complete the BLOCKED sections of the
-- Algorithmic Decision Integrity audit. Frozen SHA 0e6465158337c40d70952334b685551c7afdd289.
-- SELECT only. Nothing here writes, and nothing here can place an order.

-- === §10 OPPORTUNITY AND VETO FUNNEL ======================================
-- Gross skip rows per stage/reason. NOTE: these are ROWS, not opportunities —
-- see 07-opportunity-and-veto-funnel.md on why this is not a conversion rate.
SELECT stage, reason, account_id, COUNT(*) AS rows_
FROM decision_log
WHERE created_at >= datetime('now', '-30 days')
GROUP BY stage, reason, account_id
ORDER BY rows_ DESC;

-- The unit correction: collapse to a UNIQUE OPPORTUNITY identity before any rate.
SELECT COUNT(DISTINCT account_id || '|' || symbol || '|' || strategy || '|' ||
              COALESCE(side,'') || '|' || COALESCE(timeframe,'')) AS unique_opportunities,
       COUNT(*) AS raw_rows
FROM decision_log
WHERE created_at >= datetime('now', '-30 days');

-- First blocking reason per opportunity (§10 requires first AND all applicable).
SELECT account_id, symbol, strategy, MIN(created_at) AS first_seen,
       (SELECT reason FROM decision_log d2
         WHERE d2.account_id = d1.account_id AND d2.symbol = d1.symbol
           AND d2.strategy = d1.strategy
         ORDER BY d2.created_at LIMIT 1) AS first_blocking_reason
FROM decision_log d1
WHERE created_at >= datetime('now', '-30 days')
GROUP BY account_id, symbol, strategy;

-- === §12 TRADE MANAGEMENT AND PROFIT RETENTION ============================
-- MAE / MFE / realised R by strategy and exit reason.
SELECT strategy, exit_reason, COUNT(*) AS n,
       AVG(mae) AS avg_mae, AVG(mfe) AS avg_mfe, AVG(realised_r) AS avg_r,
       AVG(CASE WHEN mfe > 0 THEN realised_r / mfe END) AS avg_mfe_capture
FROM trades
WHERE closed_at IS NOT NULL AND closed_at >= datetime('now', '-90 days')
GROUP BY strategy, exit_reason;

-- Ratchet lag: threshold crossing to broker acknowledgement.
SELECT position_id, event, created_at, broker_ack_at,
       (julianday(broker_ack_at) - julianday(created_at)) * 86400.0 AS lag_sec
FROM position_events
WHERE event IN ('trail_tightened','breakeven_moved','ratchet')
  AND broker_ack_at IS NOT NULL
ORDER BY lag_sec DESC;

-- Amendments per position — the over-management proxy.
SELECT position_id, COUNT(*) AS amendments
FROM position_events WHERE event LIKE '%amend%'
GROUP BY position_id ORDER BY amendments DESC;

-- === §11 RISK OF RUIN =====================================================
-- Trade sequence for bootstrap / Monte Carlo resampling.
SELECT account_id, strategy, symbol, opened_at, closed_at, realised_pnl, risk_amount
FROM trades WHERE closed_at IS NOT NULL ORDER BY closed_at;

-- Concurrent exposure at each open — the correlated-cluster input.
SELECT t1.id, t1.symbol, t1.opened_at,
       (SELECT COUNT(*) FROM trades t2
         WHERE t2.account_id = t1.account_id AND t2.opened_at <= t1.opened_at
           AND (t2.closed_at IS NULL OR t2.closed_at > t1.opened_at)) AS concurrent
FROM trades t1;

-- === §12 P&L LINEAGE (H12) ================================================
-- Closed trades with no realised P&L — the unknown_daily_pnl blocker's source.
SELECT id, account_id, symbol, strategy, closed_at
FROM trades WHERE closed_at IS NOT NULL AND realised_pnl IS NULL
ORDER BY closed_at;

-- Trades with no risk-approval lineage.
SELECT id, account_id, symbol, strategy, opened_at
FROM trades WHERE risk_event_id IS NULL AND opened_at >= datetime('now','-30 days');

-- === §14 PENDING-ORDER LIFECYCLE ==========================================
SELECT status, COUNT(*) FROM pending_orders GROUP BY status;
SELECT id, account_id, symbol, strategy, status, created_at
FROM pending_orders
WHERE account_id IS NULL OR strategy IS NULL OR risk_event_id IS NULL;

-- === §6 CONNECTIVITY (F-CONN-01) ==========================================
SELECT account_id, trader_login, is_live, enabled FROM accounts;
SELECT value FROM agent_state WHERE key = 'cpp_exec_health_json';
SELECT value FROM agent_state WHERE key = 'account_auth_watch_json';
SELECT value FROM agent_state WHERE key = 'ctrader_is_live';
