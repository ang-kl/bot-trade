// node --test agent/services/telegram-chart.test.js
//
// /chart command — all deps injected, so no network, no sibling modules
// (indicators/chart-render/annotate may not even exist when this runs).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleChartCommand } from './telegram-control.js'

// Fixtures -------------------------------------------------------------------

function makeBars(n = 30) {
  const bars = []
  for (let i = 0; i < n; i++) {
    const o = 1.1 + i * 0.001
    bars.push({ t: 1700000000000 + i * 3_600_000, o, h: o + 0.002, l: o - 0.002, c: o + 0.001, v: 100 + i })
  }
  return bars
}

// Records the pipeline order + every payload so assertions can inspect them.
function makeDeps(overrides = {}) {
  const calls = []
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chart-'))
  const deps = {
    calls,
    tmp,
    getSymbolMap: () => ({ EURUSD: 1, XAUUSD: 41 }),
    fetchBars: async (args) => { calls.push(['fetchBars', args]); return makeBars() },
    indicators: {
      smaSeries: (bars, p) => { calls.push(['sma' + p]); return bars.map(() => 1.1) },
      vwapSeries: (bars) => { calls.push(['vwap']); return bars.map(() => 1.1) },
      findFvgZones: () => { calls.push(['fvg']); return [] },
      volumeProfile: (bars, opts) => { calls.push(['vp', opts]); return { rows: [], pocPrice: 1.1, vahPrice: 1.11, valPrice: 1.09 } },
    },
    annotate: {
      buildAnnotation: async (db, args) => { calls.push(['annotate', args]); return { lines: ['SMA stack: up', 'price above vwap'] } },
      geminiCommentary: async (lines, ctx) => { calls.push(['gemini', ctx]); return 'steady uptrend' },
    },
    renderChartHtml: (args) => { calls.push(['render', args]); return '<svg>chart</svg>' },
    reportsDir: () => tmp,
    sendDocument: async (args) => { calls.push(['sendDocument', args]); return { ok: true } },
    ...overrides,
  }
  return deps
}

// Arg parsing ----------------------------------------------------------------

test('defaults timeframe to 1h and uppercases the symbol', async () => {
  const deps = makeDeps()
  const res = await handleChartCommand({}, {}, 'eurusd', deps)
  assert.equal(res.ok, true)
  const fetchArgs = deps.calls.find(c => c[0] === 'fetchBars')[1]
  assert.equal(fetchArgs.symbol, 'EURUSD')
  assert.equal(fetchArgs.timeframe, '1h')
  assert.equal(fetchArgs.symbolId, 1)
})

test('parses explicit timeframe and the +ai flag in any position', async () => {
  const deps = makeDeps()
  process.env.GEMINI_API_KEY = 'test-key'
  try {
    const res = await handleChartCommand({}, {}, 'EURUSD +ai 4h', deps)
    assert.equal(res.ok, true)
    assert.equal(deps.calls.find(c => c[0] === 'fetchBars')[1].timeframe, '4h')
    const gem = deps.calls.find(c => c[0] === 'gemini')
    assert.ok(gem, 'gemini commentary was requested')
    assert.deepEqual(gem[1], { symbol: 'EURUSD', timeframe: '4h' })
    assert.match(res.caption, /AI: steady uptrend/)
  } finally { delete process.env.GEMINI_API_KEY }
})

test('no +ai flag means gemini is never called even with a key present', async () => {
  const deps = makeDeps()
  process.env.GEMINI_API_KEY = 'test-key'
  try {
    await handleChartCommand({}, {}, 'EURUSD 4h', deps)
    assert.equal(deps.calls.find(c => c[0] === 'gemini'), undefined)
  } finally { delete process.env.GEMINI_API_KEY }
})

test('missing symbol yields a usage reply, nothing sent', async () => {
  const deps = makeDeps()
  const res = await handleChartCommand({}, {}, '', deps)
  assert.equal(res.ok, false)
  assert.match(res.reply, /Usage: \/chart/)
  assert.equal(deps.calls.length, 0)
})

// Pipeline -------------------------------------------------------------------

test('pipeline runs bars -> overlays -> annotation -> render -> sendDocument in order', async () => {
  const deps = makeDeps()
  const res = await handleChartCommand({}, {}, 'EURUSD 1h', deps)
  assert.equal(res.ok, true)
  const order = deps.calls.map(c => c[0])
  const idx = (n) => order.indexOf(n)
  assert.ok(idx('fetchBars') < idx('sma20'), 'bars before overlays')
  assert.ok(idx('sma200') < idx('annotate'), 'overlays before annotation')
  assert.ok(idx('annotate') < idx('render'), 'annotation before render')
  assert.ok(idx('render') < idx('sendDocument'), 'render before send')
  // default overlay set: sma20/50/200, vwap, fvg, vp session
  for (const k of ['sma20', 'sma50', 'sma200', 'vwap', 'fvg', 'vp']) assert.ok(idx(k) >= 0, k + ' computed')
  assert.equal(deps.calls.find(c => c[0] === 'vp')[1].type, 'session')
  // render received the overlays + annotation
  const renderArgs = deps.calls.find(c => c[0] === 'render')[1]
  assert.ok(renderArgs.overlays.sma20 && renderArgs.overlays.vp)
  assert.deepEqual(renderArgs.annotation.lines, ['SMA stack: up', 'price above vwap'])
})

test('filename shape chart-EURUSD-1h-<serial>.html, saved to reportsDir', async () => {
  const deps = makeDeps()
  const res = await handleChartCommand({}, {}, 'EURUSD', deps)
  assert.match(res.filename, /^chart-EURUSD-1h-\d+\.html$/)
  assert.ok(fs.existsSync(path.join(deps.tmp, res.filename)), 'file written to reportsDir')
  // serial increments on the next chart in the same folder
  const res2 = await handleChartCommand({}, {}, 'EURUSD', deps)
  const serial = f => Number(f.match(/-(\d+)\.html$/)[1])
  assert.equal(serial(res2.filename), serial(res.filename) + 1)
})

test('sendDocument gets the html as a Buffer with the caption', async () => {
  const deps = makeDeps()
  await handleChartCommand({}, {}, 'EURUSD', deps)
  const sent = deps.calls.find(c => c[0] === 'sendDocument')[1]
  assert.ok(Buffer.isBuffer(sent.buffer))
  assert.equal(sent.buffer.toString(), '<svg>chart</svg>')
  assert.match(sent.caption, /SMA stack: up/)
})

test('caption is capped at 1024 chars', async () => {
  const deps = makeDeps({
    annotate: {
      buildAnnotation: async () => ({ lines: Array.from({ length: 60 }, (_, i) => `line ${i} `.repeat(10)) }),
      geminiCommentary: async () => null,
    },
  })
  const res = await handleChartCommand({}, {}, 'EURUSD', deps)
  assert.equal(res.ok, true)
  assert.ok(res.caption.length <= 1024, `caption ${res.caption.length} > 1024`)
  const sent = deps.calls.find(c => c[0] === 'sendDocument')[1]
  assert.ok(sent.caption.length <= 1024)
})

// Errors ---------------------------------------------------------------------

test('unknown symbol gets a polite reply and no pipeline work', async () => {
  const deps = makeDeps()
  const res = await handleChartCommand({}, {}, 'NOPE 1h', deps)
  assert.equal(res.ok, false)
  assert.match(res.reply, /don't know the symbol "NOPE"/)
  assert.equal(deps.calls.find(c => c[0] === 'fetchBars'), undefined)
  assert.equal(deps.calls.find(c => c[0] === 'sendDocument'), undefined)
})

test('empty bars gets a polite reply, no throw', async () => {
  const deps = makeDeps({ fetchBars: async () => [] })
  const res = await handleChartCommand({}, {}, 'EURUSD', deps)
  assert.equal(res.ok, false)
  assert.match(res.reply, /No bars/)
})

test('a pipeline throw is caught and reported, never escapes', async () => {
  const deps = makeDeps({ renderChartHtml: () => { throw new Error('render exploded') } })
  const res = await handleChartCommand({}, {}, 'EURUSD', deps)
  assert.equal(res.ok, false)
  assert.match(res.reply, /Chart failed: render exploded/)
})
