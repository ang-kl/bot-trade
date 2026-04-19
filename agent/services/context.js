// ---------------------------------------------------------------------------
// agent/services/context.js — Memory & context for Claude prompts
// ---------------------------------------------------------------------------
// Reads DB state to build a "daily brief" and "scan delta" that get injected
// into every scan/analysis prompt, so Claude accumulates awareness across loops.

import { getState, setState } from '../db.js'

// ---------------------------------------------------------------------------
// buildContextBrief(db) — accumulated context injected into scan prompts
// ---------------------------------------------------------------------------

export function buildContextBrief(db) {
  const lines = []

  // 1. Loop meta
  const loopCount = getState(db, 'loop_count') || '0'
  const lastScanAt = getState(db, 'last_scan_at')
  const errorsToday = getState(db, 'errors_today') || '0'
  const armed = getState(db, 'armed') === 'true'
  lines.push(`Loop #${loopCount} | Armed: ${armed} | Errors today: ${errorsToday}`)
  if (lastScanAt) lines.push(`Last scan: ${lastScanAt}`)

  // 2. Previous scan biases (the "memory" of what we saw last time)
  const prevBrief = getState(db, 'context_scan_brief')
  if (prevBrief) {
    lines.push('')
    lines.push('## Previous scan biases')
    lines.push(prevBrief)
  }

  // 3. Recent signal flips (last 24h) — shows which symbols are changing direction
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const flips = db.prepare(
      `SELECT symbol, bias, flip_from, confidence, recorded_at
       FROM signals WHERE flipped = 1 AND recorded_at > ? ORDER BY recorded_at DESC LIMIT 10`
    ).all(cutoff)
    if (flips.length > 0) {
      lines.push('')
      lines.push('## Signal flips (last 24h)')
      for (const f of flips) {
        lines.push(`- ${f.symbol}: ${f.flip_from} → ${f.bias} (conf ${f.confidence}) at ${f.recorded_at}`)
      }
    }
  } catch {}

  // 4. Active positions — the agent should know what's already on
  try {
    const positions = db.prepare(
      `SELECT symbol, side, entry_price, current_sl, current_tp, thesis_status, last_check_action
       FROM monitored_positions WHERE status = 'active'`
    ).all()
    if (positions.length > 0) {
      lines.push('')
      lines.push('## Open positions')
      for (const p of positions) {
        lines.push(`- ${p.side} ${p.symbol} @ ${p.entry_price} | SL ${p.current_sl} TP ${p.current_tp} | ${p.thesis_status || 'monitoring'} | last action: ${p.last_check_action || 'none'}`)
      }
    }
  } catch {}

  // 5. Today's trade results
  try {
    const todayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00'
    const trades = db.prepare(
      `SELECT symbol, side, gross_pnl, net_pnl, close_reason
       FROM trades WHERE status = 'closed' AND closed_at > ? ORDER BY closed_at DESC`
    ).all(todayStart)
    if (trades.length > 0) {
      const totalPnl = trades.reduce((sum, t) => sum + (t.net_pnl || 0), 0)
      const wins = trades.filter(t => (t.net_pnl || 0) > 0).length
      lines.push('')
      lines.push(`## Today's closed trades (${trades.length})`)
      lines.push(`Net P&L: ${totalPnl.toFixed(2)} | Wins: ${wins}/${trades.length}`)
      for (const t of trades.slice(0, 5)) {
        lines.push(`- ${t.side} ${t.symbol}: ${(t.net_pnl || 0) >= 0 ? '+' : ''}${(t.net_pnl || 0).toFixed(2)} (${t.close_reason || '?'})`)
      }
    }
  } catch {}

  // 6. Regime snapshots (latest per symbol)
  try {
    const regimes = db.prepare(
      `SELECT r.symbol, r.regime, r.trend_direction, r.atr_pct
       FROM regimes r
       INNER JOIN (SELECT symbol, MAX(computed_at) AS max_at FROM regimes GROUP BY symbol) latest
       ON r.symbol = latest.symbol AND r.computed_at = latest.max_at
       ORDER BY r.symbol`
    ).all()
    if (regimes.length > 0) {
      lines.push('')
      lines.push('## Market regimes')
      for (const r of regimes) {
        lines.push(`- ${r.symbol}: ${r.regime}${r.trend_direction ? ` (${r.trend_direction})` : ''} ATR% ${(r.atr_pct || 0).toFixed(2)}`)
      }
    }
  } catch {}

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// buildScanDelta(db, newScans) — computes what changed vs. previous scan
// ---------------------------------------------------------------------------

export function buildScanDelta(db, newScans) {
  const prevJson = getState(db, 'context_prev_scans')
  if (!prevJson) return null

  let prev
  try { prev = JSON.parse(prevJson) } catch { return null }

  const prevMap = {}
  for (const s of prev) prevMap[s.symbol] = s

  const deltas = []
  for (const scan of newScans) {
    const old = prevMap[scan.symbol]
    if (!old) {
      deltas.push(`${scan.symbol}: NEW — ${scan.bias} (${scan.confidence}/10)`)
      continue
    }
    const parts = []
    if (old.bias !== scan.bias) parts.push(`bias ${old.bias}→${scan.bias}`)
    const confDiff = (scan.confidence || 0) - (old.confidence || 0)
    if (Math.abs(confDiff) >= 2) parts.push(`conf ${old.confidence}→${scan.confidence} (${confDiff > 0 ? '+' : ''}${confDiff})`)
    if (parts.length > 0) deltas.push(`${scan.symbol}: ${parts.join(', ')}`)
  }

  return deltas.length > 0 ? deltas.join('\n') : null
}

// ---------------------------------------------------------------------------
// persistScanContext(db, scans) — save current scan state for next delta
// ---------------------------------------------------------------------------

export function persistScanContext(db, scans) {
  const brief = scans.map(s =>
    `${s.symbol}: ${s.bias} (${s.confidence}/10) — ${s.thesis || 'no thesis'}`
  ).join('\n')

  setState(db, 'context_scan_brief', brief)
  setState(db, 'context_prev_scans', JSON.stringify(
    scans.map(s => ({ symbol: s.symbol, bias: s.bias, confidence: s.confidence }))
  ))
}
