// Step1Matrix — Decision Matrix
// 3x5 quant matrix of minion votes + per-symbol consensus.
// Terminal/command aesthetic: monospace, no emojis, no Badge/Card, no rounded corners.

import { useState, useEffect, useCallback } from 'react'
import { agentGet, agentPost, agentConfigured } from '../../lib/agent-api.js'
import { fmtAgo } from '../../lib/time.js'
import { isTradingNow, msUntilOpen, fmtDuration } from '../../lib/trading-hours.js'
import { fmtMoney, readPriceCache, pipDist } from '../../lib/trade-utils.js'
import { dispatch as dispatchMinions, MINIONS } from '../../../agent/lib/minions.js'
import { ROWS, COLS, COL_LABELS, classifyVotes } from '../../lib/matrix-map.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseReports(raw) {
  if (!raw) return []
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return [] }
}

function preFlightChecks(latest, currentPrice, marketOpen, symbol) {
  const checks = []
  const bias = latest.consensus_bias
  const conv = latest.overall_conviction || 0
  const entry = latest.entry_price
  const sl = latest.sl_price
  const tp = latest.tp1_price

  checks.push({ label: 'Bias', ok: bias === 'long' || bias === 'short' })
  checks.push({ label: 'Conv>=8', ok: conv >= 8 })
  checks.push({ label: 'Entry', ok: !!entry })
  checks.push({ label: 'SL', ok: !!sl })
  checks.push({ label: 'TP', ok: !!tp })

  const open = marketOpen
  const ms = !open ? msUntilOpen(symbol) : 0
  const mktDetail = open ? 'OPEN' : `CLOSED ${fmtDuration(ms)}`
  checks.push({ label: 'Mkt', ok: open, detail: mktDetail })

  return checks
}

function cellColor(long, short) {
  if (long === 0 && short === 0) return 'text-[var(--color-muted)]'
  if (long > short) return 'text-[var(--color-up)]'
  if (short > long) return 'text-[var(--color-down)]'
  return 'text-[var(--color-muted)]'
}

function cellText(long, short) {
  if (long === 0 && short === 0) return '--'
  return `${long}L ${short}S`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Step1Matrix({ role, activity }) {
  const [analyses, setAnalyses] = useState([])
  const [actionBusy, setActionBusy] = useState({})
  const [expanded, setExpanded] = useState({})

  const load = useCallback(() => {
    if (!agentConfigured(role)) return
    agentGet('/state/analyses/latest', role)
      .then(r => setAnalyses(r?.analyses || []))
      .catch(() => {})
  }, [role])

  useEffect(() => {
    load()
    const iv = setInterval(load, 30_000)
    return () => clearInterval(iv)
  }, [load])

  // Force re-render every 60s for relative timestamps
  const [, setTick] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(iv)
  }, [])

  const priceCache = readPriceCache()

  // ── Group by symbol, take latest per symbol ──
  const bySymbol = {}
  for (const a of analyses) {
    if (!bySymbol[a.symbol]) bySymbol[a.symbol] = []
    bySymbol[a.symbol].push(a)
  }
  const symbols = Object.entries(bySymbol).map(([symbol, rows]) => ({
    symbol,
    rows: rows.slice(0, 15),
    latest: rows[0],
  })).sort((a, b) => {
    const aActive = a.latest.consensus_bias !== 'skip' && a.latest.consensus_bias !== 'neutral'
    const bActive = b.latest.consensus_bias !== 'skip' && b.latest.consensus_bias !== 'neutral'
    if (aActive !== bActive) return aActive ? -1 : 1
    return (b.latest.overall_conviction || 0) - (a.latest.overall_conviction || 0)
  })

  // ── Build aggregate matrix from ALL active symbol reports ──
  const allReports = []
  for (const { latest } of symbols) {
    const reports = parseReports(latest.minion_reports)
    for (const r of reports) allReports.push(r)
  }
  const matrix = classifyVotes(allReports)

  // ── Actions ──
  const dismissAnalysis = async (analysisId) => {
    setActionBusy(prev => ({ ...prev, [analysisId]: true }))
    try {
      await agentPost('/actions/dismiss-analysis', { analysisId }, role)
      load()
    } catch (e) { console.error(e) }
    setActionBusy(prev => ({ ...prev, [analysisId]: false }))
  }

  const executeAnalysis = async (analysisId) => {
    if (!window.confirm('Execute this trade? This will place a real order.')) return
    setActionBusy(prev => ({ ...prev, [analysisId]: true }))
    try {
      await agentPost('/actions/execute-trade', { analysisId }, role)
      load()
    } catch (e) { console.error(e) }
    setActionBusy(prev => ({ ...prev, [analysisId]: false }))
  }

  if (symbols.length === 0) {
    return (
      <section className="font-mono text-[12px] text-[var(--color-muted)] p-4">
        {'>'}_ STEP 1  DECISION MATRIX -- no analyses in last 24h
      </section>
    )
  }

  const totalScans = analyses.length

  // ── Render ──
  return (
    <section className="font-mono text-[12px]">
      {/* Header */}
      <div className="flex items-baseline gap-4 px-2 py-1 text-[var(--color-text)]">
        <span className="font-bold text-[13px]">
          {'>'}_ STEP 1  DECISION MATRIX
        </span>
        <span className="text-[var(--color-muted)]">
          [{symbols.length} symbols]
        </span>
        <span className="text-[var(--color-muted)]">
          [{totalScans} scans/24h]
        </span>
      </div>

      {/* Separator */}
      <div className="px-2 text-[var(--color-muted)] select-none" aria-hidden>
        {'------------------------------------------------------------------------'}
      </div>

      {/* 3x5 Matrix */}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr>
              <td className="px-2 py-1 text-[var(--color-muted)] w-[120px]"></td>
              {COLS.map(col => (
                <td key={col} className="px-2 py-1 text-[var(--color-muted)] text-center font-bold whitespace-nowrap">
                  {(COL_LABELS[col] || col).toUpperCase()}
                </td>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map(row => (
              <tr key={row}>
                <td className="px-2 py-0.5 text-[var(--color-muted)] font-bold">{row}</td>
                {COLS.map(col => {
                  const cell = matrix[row]?.[col] || { long: 0, short: 0 }
                  return (
                    <td key={col}
                      className={`px-2 py-0.5 text-center whitespace-nowrap ${cellColor(cell.long, cell.short)}`}
                    >
                      {cellText(cell.long, cell.short)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Separator */}
      <div className="px-2 text-[var(--color-muted)] select-none" aria-hidden>
        {'------------------------------------------------------------------------'}
      </div>

      {/* Per-symbol rows */}
      <div className="mt-1">
        {symbols.map(({ symbol, rows, latest }) => {
          const isActive = latest.consensus_bias !== 'skip' && latest.consensus_bias !== 'neutral'
          const reports = parseReports(latest.minion_reports)
          const mm = priceCache[symbol] || {}
          const currentPrice = mm.currentPrice ?? mm.price ?? mm.vwap ?? null
          const marketOpen = isTradingNow(symbol)
          const conv = latest.overall_conviction || 0
          const bias = latest.consensus_bias
          const isExpanded = !!expanded[symbol]

          if (!isActive) {
            // SKIP row — collapsed one-liner
            return (
              <div key={symbol} className="px-2 py-0.5 text-[var(--color-muted)]">
                <span className="font-bold text-[var(--color-text)]">{symbol}</span>
                {'   '}
                <span>SKIP</span>
                {'  '}
                <span>{conv}/10</span>
                {'  --'}
                <br />
                <span className="ml-4">
                  {rows.length} scan{rows.length !== 1 ? 's' : ''}, no setup.
                  {' Last: '}{fmtAgo(latest.analyzed_at) || '--'}.
                  {' Conv '}{conv}/10.
                </span>
              </div>
            )
          }

          // Active row
          const entry = latest.entry_price
          const sl = latest.sl_price
          const tp = latest.tp1_price
          const timeCap = latest.time_cap_minutes
          const checks = preFlightChecks(latest, currentPrice, marketOpen, symbol)
          const allPass = checks.every(c => c.ok)
          const pFmt = (p) => p ? fmtMoney(p, p > 100 ? 2 : 5) : '--'
          const slPips = pipDist(entry, sl, symbol)
          const tpPips = pipDist(entry, tp, symbol)

          const biasUpper = (bias || '--').toUpperCase()
          const biasColor = bias === 'long'
            ? 'text-[var(--color-up)]'
            : bias === 'short'
              ? 'text-[var(--color-down)]'
              : 'text-[var(--color-muted)]'

          return (
            <div key={symbol} className="px-2 py-1 border-t border-[var(--color-border)]">
              {/* Main line */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <span className="font-bold text-[13px] text-[var(--color-text)]">{symbol}</span>
                <span className={`font-bold ${biasColor}`}>{biasUpper}</span>
                <span className="text-[var(--color-text)]">{conv}/10</span>
                {entry && (
                  <span className="text-[var(--color-text)]">
                    E:{pFmt(entry)}
                  </span>
                )}
                {sl && (
                  <span className="text-[var(--color-down)]">
                    SL:{pFmt(sl)}
                    {slPips != null && <span className="opacity-60">({Math.abs(slPips).toFixed(0)}p)</span>}
                  </span>
                )}
                {tp && (
                  <span className="text-[var(--color-up)]">
                    TP:{pFmt(tp)}
                    {tpPips != null && <span className="opacity-60">({Math.abs(tpPips).toFixed(0)}p)</span>}
                  </span>
                )}
                {timeCap && (
                  <span className="text-[var(--color-muted)]">{timeCap}m</span>
                )}

                {/* Action buttons */}
                <span className="ml-auto flex items-center gap-1">
                  {allPass && (
                    <button
                      type="button"
                      disabled={actionBusy[latest.id]}
                      onClick={() => executeAnalysis(latest.id)}
                      className="px-1.5 py-0 text-[11px] font-bold text-[var(--color-up)] border border-[var(--color-up)] hover:bg-[var(--color-up)] hover:text-[var(--color-bg)] disabled:opacity-40"
                    >
                      EXEC
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={actionBusy[latest.id]}
                    onClick={() => dismissAnalysis(latest.id)}
                    className="px-1.5 py-0 text-[11px] text-[var(--color-muted)] border border-[var(--color-border)] hover:text-[var(--color-down)] hover:border-[var(--color-down)] disabled:opacity-40"
                  >
                    x
                  </button>
                  <button
                    type="button"
                    onClick={() => setExpanded(prev => ({ ...prev, [symbol]: !prev[symbol] }))}
                    className="px-1.5 py-0 text-[11px] text-[var(--color-muted)] border border-[var(--color-border)] hover:text-[var(--color-text)]"
                  >
                    {isExpanded ? '-' : '+'}
                  </button>
                </span>
              </div>

              {/* Minion votes summary (always visible) */}
              <div className="text-[11px] text-[var(--color-muted)] ml-2 mt-0.5">
                {reports.slice(0, 6).map((r, i) => (
                  <span key={r.minionId || i}>
                    {i > 0 && ' | '}
                    <span className={
                      r.bias === 'long' ? 'text-[var(--color-up)]'
                      : r.bias === 'short' ? 'text-[var(--color-down)]'
                      : ''
                    }>
                      {r.minionId || r.name}:{(r.bias || 'skip').toUpperCase()} {r.conviction}
                    </span>
                  </span>
                ))}
              </div>

              {/* Pre-flight checks */}
              <div className="text-[11px] text-[var(--color-muted)] ml-2 mt-0.5">
                {checks.map((c, i) => {
                  const ok = c.ok
                  const cls = ok ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'
                  const tag = ok ? 'ok' : (c.detail || 'FAIL')
                  return (
                    <span key={i}>
                      {i > 0 && ' '}
                      <span className={cls}>
                        {c.label}[{tag}]
                      </span>
                    </span>
                  )
                })}
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="ml-2 mt-1 border-l border-[var(--color-border)] pl-2">
                  {/* Strategy & synthesis */}
                  {latest.strategy && (
                    <div className="text-[11px] text-[var(--color-text)] mb-0.5">
                      Strategy: {latest.strategy}
                    </div>
                  )}
                  {latest.consensus_summary && (
                    <div className="text-[11px] text-[var(--color-muted)] mb-1">
                      {latest.consensus_summary}
                    </div>
                  )}

                  {/* Full minion reports */}
                  {reports.length > 0 && (
                    <table className="w-full text-[11px] mb-1">
                      <thead>
                        <tr className="text-[var(--color-muted)] text-left">
                          <td className="pr-2 py-0.5 font-bold">Minion</td>
                          <td className="pr-2 py-0.5 font-bold">Bias</td>
                          <td className="pr-2 py-0.5 font-bold text-right">Conv</td>
                          <td className="pr-2 py-0.5 font-bold text-right">Entry</td>
                          <td className="pr-2 py-0.5 font-bold text-right">SL</td>
                          <td className="pr-2 py-0.5 font-bold text-right">TP</td>
                          <td className="pr-2 py-0.5 font-bold">Report</td>
                        </tr>
                      </thead>
                      <tbody>
                        {reports.map((r, i) => {
                          const rBiasColor = r.bias === 'long' ? 'text-[var(--color-up)]'
                            : r.bias === 'short' ? 'text-[var(--color-down)]'
                            : 'text-[var(--color-muted)]'
                          const rFmt = (p) => p ? fmtMoney(p, p > 100 ? 2 : 5) : '--'
                          return (
                            <tr key={r.minionId || i} className="border-t border-[var(--color-border)]">
                              <td className="pr-2 py-0.5 text-[var(--color-text)] whitespace-nowrap">
                                {r.name || r.minionId}
                              </td>
                              <td className={`pr-2 py-0.5 font-bold ${rBiasColor}`}>
                                {(r.bias || 'skip').toUpperCase()}
                              </td>
                              <td className="pr-2 py-0.5 text-right text-[var(--color-text)]">
                                {r.conviction}/10
                              </td>
                              <td className="pr-2 py-0.5 text-right text-[var(--color-text)]">
                                {rFmt(r.entry)}
                              </td>
                              <td className="pr-2 py-0.5 text-right text-[var(--color-down)]">
                                {rFmt(r.sl)}
                              </td>
                              <td className="pr-2 py-0.5 text-right text-[var(--color-up)]">
                                {rFmt(r.tp1)}
                              </td>
                              <td className="pr-2 py-0.5 text-[var(--color-muted)] max-w-[300px] truncate" title={r.translated_report || r.report}>
                                {r.translated_report || r.report || '--'}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}

                  {/* Risk note */}
                  {latest.risk_note && (
                    <div className="text-[11px] text-[var(--color-down)] mt-0.5">
                      Risk: {latest.risk_note}
                    </div>
                  )}

                  {/* Invalidation */}
                  {latest.invalidation_trigger && (
                    <div className="text-[11px] text-[var(--color-muted)] mt-0.5">
                      Invalidation: {latest.invalidation_trigger}
                    </div>
                  )}

                  {/* Revision history */}
                  {rows.length > 1 && (
                    <div className="text-[11px] text-[var(--color-muted)] mt-1">
                      {rows.length} revision{rows.length !== 1 ? 's' : ''}.
                      {' Latest: '}{fmtAgo(latest.analyzed_at) || '--'}.
                      {' Oldest: '}{fmtAgo(rows[rows.length - 1].analyzed_at) || '--'}.
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
