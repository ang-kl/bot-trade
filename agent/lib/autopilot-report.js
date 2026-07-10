// Autopilot evaluation report — the owner's requirement: every GO/NO-GO
// proposal must be a downloadable HTML chart WITH its reasoning spelled out.
// Self-contained (inline SVG equity curves, no external assets), saved in
// the same persistent reports dir as backtest runs, blue/orange only.

import fs from 'node:fs'
import path from 'node:path'
import { reportsDir, reportFilename, sgDateStamp } from './backtest-report.js'

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const num = v => (v == null ? '—' : String(v))

// Plain-words pass/fail reasoning — mirrors the GO gates the verdict used.
export function explainVerdict(v) {
  const pf = v.pf ?? (v.losses === 0 && v.trades ? Infinity : 0)
  const lines = [
    { ok: v.trades >= 10, text: `${v.trades} trades — need at least 10 to trust the numbers` },
    { ok: pf >= 1.1, text: `profit factor ${pf === Infinity ? '∞ (no losing trades)' : num(v.pf)} — need 1.1 or better` },
    { ok: (v.total ?? 0) > 0, text: `total ${num(v.total)}% after costs — must be positive` },
  ]
  if (v.wfActive != null && v.wfActive >= 2) {
    lines.push({ ok: v.wfPositive * 2 > v.wfActive, text: `walk-forward ${v.wfPositive} of ${v.wfActive} segments positive — need a majority` })
  }
  if (v.wfWorstMddPct != null && v.wfWorstMddPct > 10) {
    lines.push({ ok: false, text: `one walk-forward segment drew down ${v.wfWorstMddPct}% — over the 10% catastrophe cap` })
  }
  return lines
}

// Tiny inline equity sparkline — cumulative % per trade, zero line dashed.
export function equitySvg(points, w = 220, h = 48) {
  if (!points || points.length < 2) return '<span class="dim">not enough trades to chart</span>'
  const min = Math.min(0, ...points)
  const max = Math.max(0, ...points)
  const span = max - min || 1
  const x = i => (i / (points.length - 1)) * (w - 4) + 2
  const y = v => h - 4 - ((v - min) / span) * (h - 8)
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const zero = y(0).toFixed(1)
  const up = points[points.length - 1] >= 0
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="equity curve, ends ${up ? 'positive' : 'negative'}">` +
    `<line x1="2" y1="${zero}" x2="${w - 2}" y2="${zero}" stroke="currentColor" stroke-opacity="0.25" stroke-dasharray="3 3"/>` +
    `<path d="${d}" fill="none" stroke="${up ? 'var(--blue)' : 'var(--orange)'}" stroke-width="1.6"/>` +
    `<text x="${w - 3}" y="10" text-anchor="end" font-size="9" fill="currentColor" opacity="0.8">${points[points.length - 1]}%</text></svg>`
}

const MARK = { go: '✓ GO', thin: '△ GO (thin)', 'no-go': '✗ NO-GO' }

export function renderAutopilotReport(verdicts, meta = {}, filename = '') {
  const byStrategy = {}
  for (const v of verdicts) (byStrategy[v.strategy] ||= []).push(v)
  const sections = Object.entries(byStrategy).map(([strat, rows]) => {
    const items = rows
      .sort((a, b) => (a.state === 'go' ? 0 : a.state === 'thin' ? 1 : 2) - (b.state === 'go' ? 0 : b.state === 'thin' ? 1 : 2))
      .map(v => `<details ${v.state === 'go' ? 'open' : ''}>
        <summary><span class="${v.state === 'go' ? 'v-go' : v.state === 'thin' ? 'v-thin' : 'v-nogo'}">${MARK[v.state] || esc(v.state)}</span>
          <strong>${esc(v.symbol)} ${esc(v.timeframe)}</strong> <span class="dim">${v.entryMode === 'touch' ? 'touch-fill (pending order)' : 'close-confirmed'}</span>
          · ${num(v.trades)} trades · PF ${num(v.pf)} · ${num(v.total)}% · wf ${esc(v.wf || '—')}</summary>
        <div class="body">
          ${equitySvg(v.equity)}
          <ul>${explainVerdict(v).map(l => `<li>${l.ok ? '✓' : '✗'} ${esc(l.text)}</li>`).join('')}</ul>
        </div>
      </details>`).join('\n')
    return `<section><h2>${esc(strat)}</h2>${items || '<p class="dim">no combos evaluated</p>'}</section>`
  }).join('\n')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autopilot evaluation ${esc(filename)}</title>
<style>
  :root { --ink:#1e293b; --dim:#64748b; --line:#e2e8f0; --blue:#2563eb; --orange:#c2410c; --bg:#fff; }
  @media (prefers-color-scheme: dark) { :root { --ink:#e2e8f0; --dim:#94a3b8; --line:#334155; --blue:#60a5fa; --orange:#fb923c; --bg:#0f172a; } }
  body { font: 15px/1.5 system-ui, sans-serif; color: var(--ink); background: var(--bg); margin: 2rem auto; max-width: 860px; padding: 0 1rem; }
  h1 { font-size: 1.25rem; } h2 { font-size: 1.05rem; margin: 1.5rem 0 .4rem; }
  .dim { color: var(--dim); }
  details { border-bottom: 1px solid var(--line); padding: .3rem 0; }
  summary { cursor: pointer; }
  .body { padding: .4rem 0 .4rem 1.4rem; display: flex; gap: 1rem; align-items: flex-start; flex-wrap: wrap; }
  ul { margin: 0; padding-left: 1.1rem; }
  .v-go { color: var(--blue); font-weight: 700; }
  .v-thin { color: var(--orange); font-weight: 700; }
  .v-nogo { color: var(--orange); font-weight: 700; text-decoration: underline dotted; }
</style></head><body>
<h1>Autopilot evaluation ${esc(filename)}</h1>
<p class="dim">Run at ${esc(meta.ranAt || '?')} · ${verdicts.length} strategy×symbol×timeframe combos · marks: ✓ GO (blue) · △ thin (orange) · ✗ NO-GO (orange dotted). Each row opens to its equity curve and the exact pass/fail reasoning.</p>
${meta.errors?.length ? `<p class="dim">⚠ ${meta.errors.length} combos could not be evaluated (data errors) — absence here is not a verdict.</p>` : ''}
${sections}
</body></html>`
}

export function saveAutopilotReport(verdicts, meta = {}, now = new Date()) {
  const dir = reportsDir()
  fs.mkdirSync(dir, { recursive: true })
  // autopilot- prefix keeps these distinct from manual backtest reports while
  // sharing the same persistent serial folder.
  const base = reportFilename(
    fs.readdirSync(dir).filter(n => n.startsWith('autopilot-')).map(n => n.replace(/^autopilot-/, '')),
    now,
  )
  const filename = `autopilot-${base}`
  void sgDateStamp // (re-exported path retained for callers/tests)
  const html = renderAutopilotReport(verdicts, meta, filename)
  fs.writeFileSync(path.join(dir, filename), html)
  return { filename, html }
}
