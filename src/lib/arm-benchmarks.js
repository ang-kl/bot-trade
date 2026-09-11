// PR-F (owner principle 6): Tune's "Apply selection" / "Arm the bot" wrote
// the backtest stats behind the arming to `arm_benchmarks_json`
// (POST /actions/arm-benchmarks) so the live results could later be compared
// against them — the route comment calls it the "reality gap". The write had
// a reader on the agent (GET /state/arm-benchmarks) but NO reader on the
// site: the value was written and never shown, so the control was half-wired.
// This shapes that GET's body for display — the agent's own fields, nothing
// computed on the client.

/**
 * @param {{benchmarks: Record<string,{profitFactor?:number|null,expectancyPct?:number|null,trades?:number}>|null}|null} body
 * @returns {{ status: 'not_read'|'none'|'stored', rows: Array<{key:string,symbol:string,tf:string,profitFactor:string,expectancyPct:string,trades:string}> }}
 */
export function describeArmBenchmarks(body) {
  if (!body || typeof body !== 'object' || !('benchmarks' in body)) return { status: 'not_read', rows: [] }
  const b = body.benchmarks
  if (!b || typeof b !== 'object' || Object.keys(b).length === 0) return { status: 'none', rows: [] }
  const fmt = (v, d) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d))
  const rows = Object.entries(b).map(([key, r]) => {
    const [symbol, tf] = String(key).split('|')
    return {
      key, symbol: symbol || key, tf: tf || '?',
      profitFactor: fmt(r?.profitFactor, 2),
      expectancyPct: r?.expectancyPct == null ? '—' : fmt(r.expectancyPct, 2) + '%',
      trades: r?.trades == null ? '—' : String(r.trades),
    }
  }).sort((a, b2) => a.key.localeCompare(b2.key))
  return { status: 'stored', rows }
}

export function armBenchmarksLine(body) {
  const { status, rows } = describeArmBenchmarks(body)
  if (status === 'not_read') return 'arm-time benchmarks: not read'
  if (status === 'none') return 'arm-time benchmarks: none stored (nothing has been applied from a backtest yet)'
  return `arm-time benchmarks (stored at Apply, ${rows.length} pair${rows.length === 1 ? '' : 's'}): ` +
    rows.map(r => `${r.symbol} ${r.tf} PF ${r.profitFactor} · exp ${r.expectancyPct} · ${r.trades} trades`).join(' · ')
}
