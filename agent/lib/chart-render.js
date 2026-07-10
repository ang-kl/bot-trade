// ---------------------------------------------------------------------------
// agent/lib/chart-render.js — server-side chart snapshot as a SELF-CONTAINED
// HTML file (inline SVG, zero external assets — Telegram documents and the
// reports dir must render offline).
//
// Colour constraint (owner is red-green colour-blind): candles/overlays use
// ONLY blue (#2563eb) and orange (#c2410c). Up/down is ALSO carried by shape:
// up candles are hollow (fill none), down candles are solid — never hue alone.
// Dark/light follows prefers-color-scheme via CSS variables.
// ---------------------------------------------------------------------------

const BLUE = '#2563eb'
const ORANGE = '#c2410c'

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const fmt = (n) => (Number.isFinite(n) ? (Math.abs(n) >= 1000 ? n.toFixed(2) : n.toPrecision(6).replace(/\.?0+$/, '')) : '')

/**
 * Render a chart snapshot.
 * @param {object} p
 * @param {string} p.symbol
 * @param {string} p.timeframe
 * @param {Array<{t,o,h,l,c,v}>} p.bars
 * @param {object} [p.overlays] — {sma20?, sma50?, sma200?, ema20?, ema50?, vwap?, avwap?: Array<number|null>, fvg?: zones[], vp?: profile}
 * @param {object} [p.annotation] — {lines: string[], commentary?: string|null}
 * @param {string} [p.filename] — shown in the footer (traceability)
 * @returns {string} full HTML document
 */
export function renderChartHtml({ symbol, timeframe, bars, overlays = {}, annotation = null, filename = '' }) {
  const W = 960, H = 480
  const padL = 8, padR = 64, padT = 16, padB = 24
  // Volume-profile histogram docks on the right inside the plot; reserve a
  // slice of plot width for it when present so candles don't hide under it.
  const vp = overlays.vp && Array.isArray(overlays.vp.rows) && overlays.vp.rows.length ? overlays.vp : null
  const vpW = vp ? 140 : 0
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const n = bars.length

  // y-scale spans highs/lows plus any overlay values so nothing clips.
  let lo = Infinity, hi = -Infinity
  for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h }
  for (const key of ['sma20', 'sma50', 'sma200', 'ema20', 'ema50', 'vwap', 'avwap']) {
    for (const v of overlays[key] || []) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) { lo = (lo || 0) - 1; hi = (hi || 0) + 1 }
  const pad = (hi - lo) * 0.04
  lo -= pad; hi += pad

  const x = (i) => padL + ((i + 0.5) / n) * plotW
  const y = (p) => padT + (1 - (p - lo) / (hi - lo)) * plotH
  const cw = Math.max(1, Math.min(9, (plotW / n) * 0.65))

  const parts = []

  // FVG zones first (under candles). Orange 15% fill + dotted border per
  // contract; label carries direction in WORDS (colour-blind rule).
  for (const z of overlays.fvg || []) {
    const x0 = x(z.fromIdx) - cw / 2
    const x1 = z.filledIdx != null ? x(z.filledIdx) : padL + plotW
    const yT = y(z.top), yB = y(z.bottom)
    parts.push(`<rect x="${x0.toFixed(1)}" y="${yT.toFixed(1)}" width="${(x1 - x0).toFixed(1)}" height="${(yB - yT).toFixed(1)}" fill="${ORANGE}" fill-opacity="0.15" stroke="${ORANGE}" stroke-dasharray="3,3" stroke-width="1"/>`)
    parts.push(`<text x="${(x0 + 3).toFixed(1)}" y="${(yT + 11).toFixed(1)}" class="lbl">FVG ${z.dir}${z.filledIdx != null ? ' (filled)' : ''}</text>`)
  }

  // Candles: blue up (hollow), orange down (solid) — shape + hue.
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    const up = b.c >= b.o
    const col = up ? BLUE : ORANGE
    const cx = x(i)
    parts.push(`<line x1="${cx.toFixed(1)}" y1="${y(b.h).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(b.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`)
    const yo = y(Math.max(b.o, b.c)), h = Math.max(1, Math.abs(y(b.o) - y(b.c)))
    parts.push(`<rect x="${(cx - cw / 2).toFixed(1)}" y="${yo.toFixed(1)}" width="${cw.toFixed(1)}" height="${h.toFixed(1)}" fill="${up ? 'none' : col}" stroke="${col}" stroke-width="1"/>`)
  }

  // Overlay polylines. Distinguished by dash PATTERN (not hue) since only
  // two hues are allowed: slower averages get longer dashes.
  const lineStyles = {
    sma20: { col: BLUE, dash: '' }, sma50: { col: BLUE, dash: '6,3' }, sma200: { col: BLUE, dash: '12,4' },
    ema20: { col: ORANGE, dash: '' }, ema50: { col: ORANGE, dash: '6,3' },
    vwap: { col: BLUE, dash: '2,2' }, avwap: { col: ORANGE, dash: '2,2' },
  }
  const legend = []
  for (const [key, st] of Object.entries(lineStyles)) {
    const series = overlays[key]
    if (!Array.isArray(series)) continue
    const pts = []
    for (let i = 0; i < n; i++) if (series[i] != null) pts.push(`${x(i).toFixed(1)},${y(series[i]).toFixed(1)}`)
    if (pts.length < 2) continue
    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${st.col}" stroke-width="1.5"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>`)
    legend.push(key.toUpperCase())
  }

  // Volume profile: horizontal blue bars docked right; POC labelled in words.
  if (vp) {
    const maxV = Math.max(...vp.rows.map(r => r.volume), 1)
    const x1 = padL + plotW
    for (const r of vp.rows) {
      const w = (r.volume / maxV) * vpW
      parts.push(`<rect x="${(x1 - w).toFixed(1)}" y="${(y(r.price) - 2).toFixed(1)}" width="${w.toFixed(1)}" height="4" fill="${BLUE}" fill-opacity="0.45"/>`)
    }
    if (vp.pocPrice != null) {
      parts.push(`<line x1="${padL}" y1="${y(vp.pocPrice).toFixed(1)}" x2="${x1}" y2="${y(vp.pocPrice).toFixed(1)}" stroke="${ORANGE}" stroke-width="1" stroke-dasharray="8,3"/>`)
      parts.push(`<text x="${(x1 - vpW).toFixed(1)}" y="${(y(vp.pocPrice) - 4).toFixed(1)}" class="lbl">POC ${fmt(vp.pocPrice)}</text>`)
    }
  }

  // Right axis: 5 price ticks.
  for (let k = 0; k <= 4; k++) {
    const p = lo + ((hi - lo) * k) / 4
    parts.push(`<text x="${padL + plotW + 6}" y="${(y(p) + 4).toFixed(1)}" class="lbl">${fmt(p)}</text>`)
  }

  const annLines = (annotation?.lines || []).map(l => `<li>${esc(l)}</li>`).join('\n')
  const commentary = annotation?.commentary ? `<p class="commentary">${esc(annotation.commentary)}</p>` : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(symbol)} ${esc(timeframe)} chart</title>
<style>
  :root { --bg: #ffffff; --fg: #1f2937; --muted: #6b7280; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111827; --fg: #e5e7eb; --muted: #9ca3af; } }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
  svg { max-width: 100%; height: auto; display: block; }
  .lbl { font: 10px system-ui, sans-serif; fill: var(--muted); }
  ul { padding-left: 1.2em; } li { margin: 2px 0; }
  .commentary { border-left: 3px solid ${BLUE}; padding-left: 10px; color: var(--muted); }
  footer { color: var(--muted); font-size: 11px; margin-top: 12px; }
</style>
</head>
<body>
<h1 style="font-size:18px;margin:0 0 8px">${esc(symbol)} · ${esc(timeframe)}${legend.length ? ` · ${legend.join(' / ')}` : ''}</h1>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Candlestick chart of ${esc(symbol)} ${esc(timeframe)}">
${parts.join('\n')}
</svg>
${annLines ? `<h2 style="font-size:15px;margin:14px 0 4px">Reading</h2>\n<ul>\n${annLines}\n</ul>` : ''}
${commentary}
<footer>${esc(filename)}${filename ? ' · ' : ''}generated ${new Date().toISOString()}</footer>
</body>
</html>`
}
