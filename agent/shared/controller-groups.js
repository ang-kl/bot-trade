// Revision 3 section 13: presentation only. Keys and switch semantics stay put.
export const CONTROLLER_GROUPS = [
  { key: 'services', label: 'Services and market data', names: ['main_loop', 'cpp_exec', 'cpp_exec_demo', 'hours_refresh', 'fx_legs_refresh', 'atr_refresh'] },
  { key: 'scanning', label: 'Scanning and strategies', names: ['autopilot', 'pending_signals', 'edge_watchdog', 'fundable_universe'] },
  { key: 'risk', label: 'Account risk and admission', names: ['adaptive_breaker', 'equity_stop', 'performance_breaker', 'weekend_loss_flag'] },
  { key: 'protection', label: 'Execution and position protection', names: ['fast_monitor', 'protection_band', 'order_monitor', 'trade_guards', 'profit_keeper', 'loss_guardian', 'guardian', 'weekend_bank', 'closed_market_sweep', 'momentum_partial'] },
  { key: 'verification', label: 'Verification and account records', names: ['protection_audit', 'log_inspector', 'decision_audit', 'minute_review', 'pnl_reconcile', 'cross_side_equity', 'equity_snapshot', 'cashflow_collection', 'broker_readings', 'order_lifecycle', 'position_capture'] },
  { key: 'research', label: 'Research and reports', names: ['burn_in', 'weekend_watch', 'daily_report'] },
]
export const RETIRED_CONTROLLERS = ['pending_orders']
const serviceLabels = { cpp_exec: 'cpp-acct (live gateway)', cpp_exec_demo: 'cpp-exec (demo gateway)' }
export const needsAttention = row => ['stalled', 'error', 'warn'].includes(row.status) || row.consecutive_failures > 0

export function groupControllers(rows) {
  if (!Array.isArray(rows)) return null
  const known = new Set([...CONTROLLER_GROUPS.flatMap(g => g.names), ...RETIRED_CONTROLLERS])
  const shaped = rows.map(r => ({ ...r, label: serviceLabels[r.name] || r.label || r.name }))
  const retired = shaped.filter(r => r.retired || r.status === 'retired' || RETIRED_CONTROLLERS.includes(r.name))
  const active = shaped.filter(r => !retired.includes(r))
  return {
    groups: CONTROLLER_GROUPS.map(g => ({ ...g, rows: active.filter(r => g.names.includes(r.name)) })),
    retired,
    unmapped: active.filter(r => !known.has(r.name)),
    exceptions: active.filter(needsAttention),
  }
}
