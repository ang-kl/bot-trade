// ---------------------------------------------------------------------------
// agent/services/context.js — Memory & context for Claude prompts
// ---------------------------------------------------------------------------
// Reads DB state to build a "daily brief" and "scan delta" that get injected
// into every scan/analysis prompt, so Claude accumulates awareness across loops.

import { setState } from '../db.js'

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
