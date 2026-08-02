// Presentation helpers for the workspace history page (A5's UI half).
// Separate from the component so the labelling — which is where the honesty
// lives — is testable without a DOM.

/** Turn a stored action_log path into something a person reads. */
export function actionLabel(path) {
  const p = String(path || '')
  if (p.startsWith('/phase/')) return `Switch: ${p.slice('/phase/'.length)}`
  if (p.startsWith('/controller/')) {
    const [, , controller, event] = p.split('/')
    return `Controller: ${controller} ${event || ''}`.trim()
  }
  if (p.startsWith('/')) return p.replace(/^\//, '').replace(/-/g, ' ')
  return p || '—'
}

/**
 * How a row relates to the account being viewed.
 *
 * The distinction that matters: a row with NO account stamp is included in a
 * scoped read by convention, and it is NOT this account's action — it either
 * predates stamping or is genuinely global (a master switch, a controller
 * event). Rendering both the same way would let a global flip read as
 * something done to this account.
 */
export function rowOrigin(row, viewedAccountId) {
  const id = row?.account_id ?? row?.accountId ?? null
  if (id == null || id === '') return { kind: 'shared', label: 'all accounts / pre-stamping' }
  if (viewedAccountId != null && String(id) !== String(viewedAccountId)) {
    return { kind: 'other', label: `account ${id}` }
  }
  return { kind: 'own', label: `account ${id}` }
}

/** Short relative age from a SQLite space-form or ISO timestamp. */
export function ago(stamp, nowMs = Date.now()) {
  if (!stamp) return '—'
  const raw = String(stamp).replace(' ', 'T')
  const t = Date.parse(raw.endsWith('Z') || raw.includes('+') ? raw : `${raw}Z`)
  if (!Number.isFinite(t)) return '—'
  const mins = Math.floor((nowMs - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 48) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/**
 * A backtest row's headline result, or the honest reason there isn't one.
 *
 * An errored run is NOT a zero — it is an absence of evidence about that
 * symbol, and showing it as "0 trades, 0% win" would put a failed fetch into
 * the same column as a genuinely flat result.
 */
export function backtestResult(row) {
  if (row?.error) return { ok: false, text: `failed: ${String(row.error).slice(0, 80)}` }
  const trades = Number(row?.trades)
  if (!Number.isFinite(trades)) return { ok: false, text: 'no result recorded' }
  if (trades === 0) return { ok: true, text: 'no trades in the window' }
  const wr = Number(row?.win_rate_pct)
  const pf = row?.profit_factor
  return {
    ok: true,
    text: `${trades} trades · ${Number.isFinite(wr) ? `${wr.toFixed(1)}% win` : 'win rate —'} · `
      + `PF ${pf == null ? '∞ / —' : Number(pf).toFixed(2)}`,
  }
}

/** Copy-to-clipboard form for the whole page. */
export function toText({ scope, log, backtests }) {
  return [
    `Workspace history — ${scope || 'unknown scope'}`,
    '',
    `Actions (${log.length})`,
    ...log.map(r => `${r.at} · ${actionLabel(r.path)} · ${r.account_id ?? 'all accounts'}`),
    '',
    `Backtests (${backtests.length})`,
    ...backtests.map(r => `${r.ran_at} · ${r.symbol} ${r.timeframe} ${r.strategy} · ${backtestResult(r).text}`),
  ].join('\n')
}
