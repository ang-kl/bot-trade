// Self-contained HTML report of a backtest run, saved server-side under
// reportsDir() (persistent volume when DB_PATH is set, else cwd) and offered
// to the browser as a download. One file per run, named by Singapore date +
// per-day serial: 2026-0709_00.html.
//
// Verdict logic MIRRORS src/pages/Tune.jsx verdictFor() — if one changes,
// change the other. Colours are blue/orange only (owner is red-green
// colour-blind); verdicts always carry a word + shape, never hue alone.

import fs from 'node:fs'
import path from 'node:path'

const GO_MIN_TRADES = 10

export function verdictFor(r) {
  if (!r || r.error) return null
  if (!r.trades) return { state: 'no-go', label: 'NO-GO' }
  const pfVal = r.profitFactor ?? (r.losses === 0 ? Infinity : 0)
  const edge = [pfVal >= 1.1, r.totalProfitPct > 0]
  if (r.wfActive != null && r.wfActive >= 2) edge.push(r.wfPositive * 2 > r.wfActive)
  if (r.wfWorstMddPct != null && r.wfWorstMddPct > 10) edge.push(false)
  const edgeOk = edge.every(Boolean)
  if (edgeOk && r.trades >= GO_MIN_TRADES) return { state: 'go', label: 'GO' }
  if (edgeOk) return { state: 'thin', label: 'GO (thin)' }
  return { state: 'no-go', label: 'NO-GO' }
}

// Date part of the filename, in the owner's timezone (Singapore).
export function sgDateStamp(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).reduce((o, x) => ((o[x.type] = x.value), o), {})
  return `${p.year}-${p.month}${p.day}` // 2026-0709
}

// Next free serial for today given the names already in the folder.
export function reportFilename(existingNames, d = new Date()) {
  const stamp = sgDateStamp(d)
  const re = new RegExp(`^${stamp}_(\\d{2,})\\.html$`)
  let max = -1
  for (const n of existingNames) {
    const m = re.exec(n)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${stamp}_${String(max + 1).padStart(2, '0')}.html`
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const num = v => (v == null ? '—' : String(v))

// The run's own name — passed through from the strategy registry so the
// report reflects the strategy that ACTUALLY ran. Falls back to the key (and
// a couple of known labels) so older payloads without strategyName still read
// correctly instead of every non-cup run mislabelling as fib.
const KNOWN_STRATEGY_LABELS = {
  fib_618_fade: 'Fib 61.8% fade',
  cup_handle: 'Cup & Handle (breakout, long-only)',
  ema_pullback: 'EMA trend-pullback',
  donchian_breakout: 'Range breakout',
  rsi_meanrev: 'RSI mean-reversion',
  vwap_trend: 'VWAP trend-pullback',
  vp_value: 'Volume-profile rotation',
}
function strategyLabel(payload) {
  return payload.strategyName || KNOWN_STRATEGY_LABELS[payload.strategy] || payload.strategy || 'Fib 61.8% fade'
}

const VERDICT_MARK = { go: '✓', thin: '△', 'no-go': '✗' }
const VERDICT_CLASS = { go: 'v-go', thin: 'v-thin', 'no-go': 'v-nogo' }

function tfRow(tf, r) {
  if (r.error) {
    return `<tr><td>${esc(tf)}</td><td class="v-err" colspan="8">error: ${esc(r.error)}</td></tr>`
  }
  const v = verdictFor(r)
  const pf = r.profitFactor ?? (r.losses === 0 && r.trades ? '∞' : null)
  const wf = r.wfActive != null ? `${num(r.wfPositive)}/${num(r.wfActive)}` : '—'
  return `<tr>
    <td>${esc(tf)}</td>
    <td class="${VERDICT_CLASS[v.state]}">${VERDICT_MARK[v.state]} ${esc(v.label)}</td>
    <td>${num(r.trades)}</td>
    <td>${num(r.winRatePct)}%</td>
    <td>${num(pf)}</td>
    <td>${num(r.totalProfitPct)}%</td>
    <td>${num(r.maxDrawdownPct)}%</td>
    <td>${wf}</td>
    <td>${num(r.barsUsed)}</td>
  </tr>`
}

export function renderBacktestReport(payload, filename = '') {
  const symbols = payload.symbols || {}
  const filters = ['rsiFilter', 'vwapFilter', 'fvgFilter', 'sessionFilter'].filter(k => payload[k]).map(k => k.replace('Filter', '').toUpperCase())
  const sections = Object.entries(symbols).map(([sym, data]) => {
    if (data.error) {
      return `<section><h2>${esc(sym)}</h2><p class="v-err">✗ ${esc(data.error)}</p></section>`
    }
    const rows = Object.entries(data.results || {}).map(([tf, r]) => tfRow(tf, r)).join('\n')
    return `<section>
      <h2>${esc(sym)}</h2>
      <div class="scroll"><table>
        <thead><tr><th>TF</th><th>Verdict</th><th>Trades</th><th>Win rate</th><th>PF</th><th>Total</th><th>Max DD</th><th>WF +/act</th><th>Bars</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`
  }).join('\n')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Backtest ${esc(filename || payload.ranAt || '')}</title>
<style>
  :root { --ink:#1e293b; --dim:#64748b; --line:#e2e8f0; --blue:#2563eb; --orange:#c2410c; --bg:#ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e2e8f0; --dim:#94a3b8; --line:#334155; --blue:#60a5fa; --orange:#fb923c; --bg:#0f172a; }
  }
  body { font: 15px/1.5 system-ui, sans-serif; color: var(--ink); background: var(--bg); margin: 2rem auto; max-width: 900px; padding: 0 1rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin: 1.6rem 0 .4rem; }
  .meta { color: var(--dim); }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 640px; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--dim); font-weight: 600; }
  .v-go   { color: var(--blue);   font-weight: 700; }
  .v-thin { color: var(--orange); font-weight: 700; }
  .v-nogo { color: var(--orange); font-weight: 700; text-decoration: underline dotted; }
  .v-err  { color: var(--dim); font-style: italic; }
  footer { margin-top: 2rem; color: var(--dim); font-size: .85rem; }
</style></head><body>
<h1>Backtest report ${esc(filename)}</h1>
<p class="meta">Strategy: ${esc(strategyLabel(payload))} · entries: ${esc(payload.entryMode === 'touch' ? 'TOUCH-FILL (resting limit at the level)' : 'close-confirmed (market at next open)')} · run at ${esc(payload.ranAt || '?')} · ${num(payload.bars)} bars requested · filters: ${filters.length ? esc(filters.join(', ')) : 'none'}</p>
<p class="meta">Verdict marks: ✓ GO (blue) · △ GO thin evidence (orange) · ✗ NO-GO (orange, dotted underline)</p>
${sections}
<footer>${esc(payload.strategy || 'fib_618_fade')} walk-forward backtest on real broker bars — generated by the bot-trade agent.</footer>
</body></html>`
}

// Where reports live. On Railway the app dir is EPHEMERAL (wiped every
// redeploy) which reset the per-day serial and caused browser "-2" filename
// collisions — so when DB_PATH points into the persistent volume we keep
// reports next to the database. Local dev (no DB_PATH) falls back to cwd.
// The report routes in agent/routes/state.js MUST read the same directory.
export function reportsDir(baseDir = process.cwd()) {
  const root = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : baseDir
  return path.join(root, 'backtest-results')
}

// Render + write under reportsDir(). Returns { filename, html }.
// Write failures are the caller's concern (a full disk must not sink the run).
export function saveBacktestReport(payload, baseDir = process.cwd(), now = new Date()) {
  const dir = reportsDir(baseDir)
  fs.mkdirSync(dir, { recursive: true })
  const filename = reportFilename(fs.readdirSync(dir), now)
  const html = renderBacktestReport(payload, filename)
  fs.writeFileSync(path.join(dir, filename), html)
  return { filename, html }
}
