// Tests for chart-render.js (self-contained HTML) and annotate.js
// (deterministic lines; Gemini strictly gated on GEMINI_API_KEY).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderChartHtml } from './chart-render.js'
import { buildAnnotation, geminiCommentary } from '../services/annotate.js'

// Synthetic uptrend: 60 bars climbing steadily, hourly.
function trendBars(n = 60) {
  const bars = []
  for (let i = 0; i < n; i++) {
    const o = 100 + i
    bars.push({ t: 1700000000000 + i * 3_600_000, o, h: o + 1.2, l: o - 0.8, c: o + 0.9, v: 1000 + i })
  }
  return bars
}

const overlays = {
  sma20: trendBars().map((b, i) => (i >= 19 ? b.c - 0.5 : null)),
  sma50: trendBars().map((b, i) => (i >= 49 ? b.c - 2 : null)),
  sma200: trendBars().map(() => null),
  vwap: trendBars().map(b => b.c - 1),
  fvg: [{ dir: 'bull', top: 112, bottom: 110, fromIdx: 10, filledIdx: null }],
  vp: {
    rows: [{ price: 120, volume: 500, pct: 40 }, { price: 130, volume: 700, pct: 60 }],
    pocPrice: 130, vahPrice: 140, valPrice: 118,
  },
}

test('renderChartHtml is self-contained (no external http(s) assets)', () => {
  const html = renderChartHtml({ symbol: 'XAUUSD', timeframe: '1h', bars: trendBars(), overlays, filename: 'chart-XAUUSD-1h-1.html' })
  assert.ok(!/src\s*=\s*["']https?:/.test(html), 'no external src')
  assert.ok(!/href\s*=\s*["']https?:/.test(html), 'no external href')
  assert.ok(!/url\(\s*["']?https?:/.test(html), 'no external css url()')
  assert.ok(html.includes('<svg'), 'inline svg present')
})

test('candles, overlays, FVG, VP and annotation all render', () => {
  const html = renderChartHtml({
    symbol: 'XAUUSD', timeframe: '1h', bars: trendBars(), overlays,
    annotation: { lines: ['SMA stack bullish.', 'Price above VWAP.'], commentary: null },
  })
  assert.ok((html.match(/<rect/g) || []).length >= 60, 'candle bodies rendered')
  assert.ok((html.match(/<polyline/g) || []).length >= 2, 'overlay polylines rendered')
  assert.ok(html.includes('FVG bull'), 'FVG zone labelled in words')
  assert.ok(html.includes('POC 130'), 'volume-profile POC line labelled')
  assert.ok(html.includes('SMA stack bullish.'), 'annotation lines rendered')
  // colour-blind rule: only blue/orange hues appear
  const hexes = new Set(html.match(/#[0-9a-fA-F]{6}/g))
  for (const h of hexes) assert.ok(['#2563eb', '#c2410c', '#ffffff', '#111827', '#1f2937', '#e5e7eb', '#6b7280', '#9ca3af'].includes(h.toLowerCase()), `unexpected colour ${h}`)
})

test('renderChartHtml escapes symbol text', () => {
  const html = renderChartHtml({ symbol: '<script>x</script>', timeframe: '1h', bars: trendBars(5), overlays: {} })
  assert.ok(!html.includes('<script>x'), 'symbol escaped')
})

test('buildAnnotation reads sanely on trending bars', () => {
  const bars = trendBars()
  const full = {
    ...overlays,
    sma200: bars.map(b => b.c - 5), // force a full bullish stack
    avwap: bars.map(b => b.c + 2),  // price below anchored vwap
  }
  const { lines } = buildAnnotation(null, { symbol: 'XAUUSD', timeframe: '1h', bars, overlays: full })
  const text = lines.join(' | ')
  assert.ok(text.includes('SMA stack bullish'), `bullish stack read: ${text}`)
  assert.ok(/Price above VWAP/.test(text), 'above vwap in words')
  assert.ok(/Price below anchored VWAP/.test(text), 'below avwap in words')
  assert.ok(/1 unfilled fair-value gap/.test(text), 'fvg count read')
  assert.ok(/Volume POC 130/.test(text), 'vp read')
  assert.ok(/no setup|signal/.test(text), 'per-strategy one-liner present')
  // no red/green words as sole state carriers; lines are plain sentences
  for (const l of lines) assert.equal(typeof l, 'string')
})

test('geminiCommentary never calls the network without GEMINI_API_KEY', async () => {
  const origFetch = globalThis.fetch
  const origKey = process.env.GEMINI_API_KEY
  delete process.env.GEMINI_API_KEY
  let calls = 0
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({}) } }
  try {
    const out = await geminiCommentary(['line one'], { symbol: 'XAUUSD', timeframe: '1h' })
    assert.equal(out, null, 'returns null without key')
    assert.equal(calls, 0, 'fetch NOT invoked without the env var')
  } finally {
    globalThis.fetch = origFetch
    if (origKey !== undefined) process.env.GEMINI_API_KEY = origKey
  }
})

test('geminiCommentary is null-safe on API failure when key set', async () => {
  const origFetch = globalThis.fetch
  const origKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = 'test-key'
  globalThis.fetch = async () => { throw new Error('network down') }
  try {
    const out = await geminiCommentary(['line one'], {})
    assert.equal(out, null)
  } finally {
    globalThis.fetch = origFetch
    if (origKey !== undefined) process.env.GEMINI_API_KEY = origKey
    else delete process.env.GEMINI_API_KEY
  }
})
