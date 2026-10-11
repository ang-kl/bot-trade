// node --test agent/services/bar-form-research-core.test.js
// Claude · № 13,096 11-Oct (ordered № 13,093; claude-builder), plan step 8.
// The streaming core against REAL encoded segments (lib/tick-segment.js
// encoders, the recorder's own format): bars per form across segment
// boundaries, calibration of N, the gap semantics shared with the tick
// research loader, and the per-cell evaluation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeHeader, encodeRecord, FLAGS, KIND } from '../lib/tick-segment.js'
import { processSegments, evaluateSeries, checkAfterEvaluation, quotesFromSegment, splitRuns, regimeAt, formsFrom, timeframeLabel, strategiesFor, RECORDER_ONLY_GAPS, EXCLUDED_STRATEGIES } from './bar-form-research-core.js'
import { RECORDER_ONLY_GAPS as TICK_RESEARCH_RECORDER_ONLY_GAPS } from './tick-research-run.js'
import { timeBars } from '../lib/tick-bars.js'

const P = 100_000
const T0 = 1_760_000_040_000 - (1_760_000_040_000 % 60_000) // a minute boundary
const quote = (recvMs, seq, symbolId, bid, ask, flags = FLAGS.BID_PRESENT | FLAGS.ASK_PRESENT | FLAGS.BID_CHANGED, gen = 1) => encodeRecord({ recvMs, seq, symbolId, bid: Math.round(bid * P), ask: Math.round(ask * P), flags, kind: KIND.QUOTE, generation: gen })
const gap = (recvMs, reasonCode, count) => encodeRecord({ recvMs, seq: 0, symbolId: 0, bid: count, ask: reasonCode, flags: 0, kind: KIND.GAP, generation: 1 })

/** A segment: symbol 1 ticks every 2 s with a slow sine, symbol 2 every 10 s. */
function segment(startMs, seconds, { seq0 = 1, withGap = null } = {}) {
  const parts = [encodeHeader({ environment: 'demo', generation: 1, startedMs: startMs, feedId: 'test' })]
  let seq = seq0
  for (let s = 0; s < seconds; s += 2) {
    const t = startMs + s * 1000
    const p = 100 + Math.sin((t - T0) / 120_000) * 0.5 + ((s / 2) % 3) * 0.01
    parts.push(quote(t, seq++, 1, p, p + 0.02))
    if (s % 10 === 0) { const b = 50 + Math.cos((t - T0) / 300_000) * 0.3; parts.push(quote(t, seq++, 2, b, b + 0.03)) }
    if (withGap && s === withGap.atSecond) parts.push(gap(t, withGap.code, 5))
  }
  return { buf: Buffer.concat(parts), nextSeq: seq }
}

function writeSegments(dir, specs) {
  return specs.map((sp, i) => { const name = `seg-${String(sp.start).padStart(13, '0')}-${String(i).padStart(6, '0')}.tks`; const f = join(dir, name); writeFileSync(f, segment(sp.start, sp.seconds, sp).buf); return f })
}
const CFG = { timeBarsMs: [15_000, 60_000], tickBarsNominalMs: [60_000], maxSilenceMs: 900_000, pauseBetweenSegmentsMs: 0, calibrationSegments: 1, computeWindowBars: 300, designFloorMs: { rsi2_reversion: 3_600_000 } }

test('the gap vocabulary is the tick research loader\'s, and tsmom is excluded', () => {
  assert.deepEqual([...RECORDER_ONLY_GAPS].sort(), [...TICK_RESEARCH_RECORDER_ONLY_GAPS].sort())
  assert.deepEqual([...EXCLUDED_STRATEGIES], ['tsmom_long'])
  assert.ok(!strategiesFor().some(s => s.key === 'tsmom_long')); assert.deepEqual(strategiesFor(['rsi_meanrev', 'nope']).map(s => s.key), ['rsi_meanrev'])
  assert.deepEqual(formsFrom(CFG).map(f => f.form), ['time_15000ms', 'time_60000ms', 'tick_approx_60000ms'])
  assert.deepEqual([timeframeLabel(15_000), timeframeLabel(60_000), timeframeLabel(300_000), timeframeLabel(3_600_000)], ['15s', '1m', '5m', '1h'])
})

test('quotesFromSegment: normalised quotes per symbol; every gap is a marker for every symbol; only a continuity gap resets the warm-up', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bfr-core-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const [a] = writeSegments(dir, [{ start: T0, seconds: 120, withGap: { atSecond: 60, code: 3 } }]) // reconnect at +60 s
  const r = quotesFromSegment(a)
  assert.equal(r.bySymbol.size, 2); assert.equal(r.gapsByReason.reconnect, 1); assert.equal(r.warmupResets, 1)
  assert.equal(r.bySymbol.get(1).filter(q => q.gapMarker).length, 1); assert.equal(r.bySymbol.get(2).filter(q => q.gapMarker).length, 1)
  assert.equal(r.bySymbol.get(1)[0].bid, Math.round((100 + Math.sin(0) * 0.5) * P))
  const [b] = writeSegments(dir, [{ start: T0 + 200_000, seconds: 120, withGap: { atSecond: 60, code: 1 } }]) // queue_overflow
  const r2 = quotesFromSegment(b)
  // A recorder-only gap resets no warm-up but IS a hole for the bars (Codex P1 on #1310).
  assert.equal(r2.gapsByReason.queue_overflow, 1); assert.equal(r2.warmupResets, 0); assert.deepEqual(r2.bySymbol.get(1).filter(q => q.gapMarker).map(q => q.recorderOnly), [true])
  assert.equal(quotesFromSegment(b, { symbolIds: new Set([2]) }).bySymbol.size, 1)
})

test('processSegments over local files: bars continue across segment boundaries, N is calibrated from the prefix, the manifest counts; a pulled segment is deleted, a local one kept', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bfr-core-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  // Three contiguous 10-minute segments.
  const files = writeSegments(dir, [{ start: T0, seconds: 600 }, { start: T0 + 600_000, seconds: 600 }, { start: T0 + 1_200_000, seconds: 600 }])
  const progress = []
  const { series, manifest } = await processSegments({ names: files, destDir: dir, cfg: CFG, onProgress: p => progress.push(p) })
  assert.equal(manifest.processed, 3); assert.equal(manifest.local, 3); assert.equal(manifest.pulled, 0); assert.deepEqual(manifest.symbols, [1, 2])
  assert.equal(progress.length, 3); assert.ok(files.every(f => existsSync(f)), 'local files are never deleted')
  const s1 = series.get(1)
  const m1 = s1.find(f => f.form === 'time_60000ms')
  // 30 minutes of quotes: minute 0 partial, the last minute open → 28 closed valid bars, one invalid (partial), continuous across the two boundaries.
  // The calibration prefix (segment 1 = minutes 0–9) is EXCLUDED from every evaluated series (amendment area 2):
  // 30 minutes of quotes → minutes 10–28 closed (19 bars), minute 29 open; the partial first bucket is in the excluded prefix.
  const valid = m1.all.filter(b => !b.invalid)
  assert.equal(manifest.calibrationSegmentsExcluded, 1); assert.equal(manifest.calibrationCutMs, T0 + 598_000)
  assert.equal(valid.length, 19); assert.deepEqual(m1.all.filter(b => b.invalid), []); assert.equal(m1.excludedForCalibration, 10)
  assert.equal(m1.runs.length, 1, 'no hole at a segment boundary')
  assert.equal(valid[0].t, T0 + 600_000); assert.equal(valid[0].v, 30, 'a minute holds 30 changed quotes of symbol 1')
  // Against a one-shot build of the same quotes: identical bars after the cut (resume is lossless).
  const all = files.flatMap(f => [...quotesFromSegment(f).bySymbol.get(1)])
  const once = timeBars(all, { barMs: 60_000, maxSilenceMs: CFG.maxSilenceMs })
  assert.deepEqual(valid.map(b => [b.t, b.o, b.h, b.l, b.c, b.v]), once.bars.filter(b => b.t > manifest.calibrationCutMs).map(b => [b.t, b.o, b.h, b.l, b.c, b.v]))
  // Calibration: N from the first segment's median ticks per minute = 30; tick bars then ≈ 1 minute, and carry no nominal time label.
  const tk = s1.find(f => f.form === 'tick_approx_60000ms')
  assert.equal(tk.n, 30); assert.equal(manifest.calibration[1][60_000].n, 30); assert.match(manifest.calibration[1][60_000].basis, /first 1 segment\(s\); those segments are excluded/)
  assert.equal(tk.timeframe, 'tick'); assert.equal(tk.nominalTimeframe, '1m'); assert.equal(tk.excludedForCalibration, 0, 'the prefix quotes never became tick bars')
  assert.ok(tk.all.filter(b => !b.invalid).length >= 18 && tk.all.every(b => b.t > manifest.calibrationCutMs))
  // Symbol 2 ticks every 10 s: 6 per minute.
  assert.equal(series.get(2).find(f => f.form === 'tick_approx_60000ms').n, 6)
})

test('processSegments pulls through the injected function, deletes the pulled file, records a failed pull and stops on abort', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bfr-core-')), src = mkdtempSync(join(tmpdir(), 'bfr-src-')); t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }) })
  const files = writeSegments(src, [{ start: T0, seconds: 300 }, { start: T0 + 300_000, seconds: 300 }, { start: T0 + 600_000, seconds: 300 }])
  const names = files.map(f => f.split('/').pop())
  const pulled = []
  const pull = async (name, destDir) => { if (name === names[1]) return { ok: false, error: 'sidecar 503' }; const p = join(destDir, name); writeFileSync(p, segment(T0 + names.indexOf(name) * 300_000, 300).buf); pulled.push(p); return { ok: true, path: p } }
  const r = await processSegments({ names, pull, destDir: dir, cfg: CFG })
  assert.equal(r.manifest.pulled, 2); assert.deepEqual(r.manifest.failed, [{ name: names[1], error: 'sidecar 503' }])
  assert.ok(pulled.every(p => !existsSync(p)), 'pulled segments are deleted after processing')
  let n = 0
  const r2 = await processSegments({ names, pull, destDir: dir, cfg: CFG, abort: () => ++n > 1 })
  assert.equal(r2.manifest.aborted, true); assert.equal(r2.manifest.processed, 1)
  assert.equal((await processSegments({ names: ['seg-x.tks'], destDir: dir, cfg: CFG })).manifest.failed[0].error, 'no pull function and not a local file')
})

test('splitRuns and regimeAt', () => {
  assert.deepEqual(splitRuns([{ t: 1 }, { t: 2 }, { t: 3, invalid: 'gap' }, { t: 4 }]).map(r => r.length), [2, 1])
  const rows = [{ ms: 1000, regime: 'ranging' }, { ms: 5000, regime: 'trending' }]
  assert.equal(regimeAt(rows, 4999), 'ranging'); assert.equal(regimeAt(rows, 5000), 'trending'); assert.equal(regimeAt(rows, 999), 'unknown')
  assert.equal(regimeAt(rows, 5000 + 7 * 3_600_000), 'unknown', 'a reading older than six hours is no reading'); assert.equal(regimeAt([], 1), 'unknown')
})

test('evaluateSeries: one cell per symbol × form × strategy; design floor refused by name; INSUFFICIENT under the floor; NO_BARS; sub-minute and tick notes; R figures and regime split', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bfr-core-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const files = writeSegments(dir, [{ start: T0, seconds: 3600 }, { start: T0 + 3_600_000, seconds: 3600 }])
  const { series } = await processSegments({ names: files, destDir: dir, cfg: CFG })
  const { cells, summary } = evaluateSeries({ series, symbolNames: { 1: 'AAA', 2: 'BBB' }, strategies: ['rsi2_reversion', 'donchian_breakout', 'vwap_trend'], cfg: CFG, minSample: 3, regimes: { AAA: [{ ms: T0, regime: 'ranging' }] }, backtestOpts: { minConviction: 0, minRr: 1 } })
  assert.equal(cells.length, 2 * 3 * 3); assert.equal(summary.cells, 18)
  const rsi15 = cells.find(c => c.symbol === 'AAA' && c.strategy === 'rsi2_reversion' && c.form === 'time_15000ms')
  assert.equal(rsi15.verdict, 'REFUSED_DESIGN_FLOOR'); assert.match(rsi15.note, /refused by design floor/)
  assert.ok(cells.every(c => c.strategy !== 'rsi2_reversion' || c.verdict === 'REFUSED_DESIGN_FLOOR'), 'every form here is under rsi2\'s 1h floor')
  const d15 = cells.find(c => c.symbol === 'AAA' && c.strategy === 'donchian_breakout' && c.form === 'time_15000ms')
  assert.ok(['OK', 'INSUFFICIENT'].includes(d15.verdict)); assert.ok(d15.bars > 200 && d15.bars <= 240, 'the second hour only: the calibration hour is excluded'); assert.equal(d15.excludedForCalibration, 240); assert.match(d15.note || '', /sub-minute|under the 3 floor|^$/)
  assert.equal(typeof d15.rStats.usable, 'number'); assert.ok(d15.stats); assert.ok(d15.byHalf.first && d15.byHalf.second)
  assert.ok(Object.keys(d15.byRegime).every(k => ['ranging', 'unknown'].includes(k)))
  const tick = cells.find(c => c.symbol === 'BBB' && c.form === 'tick_approx_60000ms' && c.strategy === 'vwap_trend')
  assert.match(tick.note || '', /label 'tick'.*nominal 1m.*bar speed/); assert.equal(tick.timeframe, 'tick'); assert.equal(tick.nominalTimeframe, '1m')
  assert.ok(summary.byVerdict.REFUSED_DESIGN_FLOOR === 6)
  assert.ok(Array.isArray(summary.leaderboard))
  // A floor above every cell's trades: every replayed cell reads INSUFFICIENT, never OK.
  const strict = evaluateSeries({ series, symbolNames: { 1: 'AAA', 2: 'BBB' }, strategies: ['donchian_breakout', 'vwap_trend'], cfg: CFG, minSample: 1_000_000, backtestOpts: { minConviction: 0, minRr: 1 } })
  assert.ok(strict.cells.length > 0 && strict.cells.every(c => c.verdict === 'INSUFFICIENT'), 'no cell may read OK under an unreachable floor')
  assert.match(strict.cells[0].note, /under the 1000000 floor/)
  // No bars at all for a symbol → NO_BARS, never a figure.
  const empty = evaluateSeries({ series: new Map([[9, [{ kind: 'time', ms: 60_000, form: 'time_60000ms', timeframe: '1m', all: [], runs: [], n: null }]]]), strategies: ['vwap_trend'], cfg: CFG, minSample: 3 })
  assert.equal(empty.cells[0].verdict, 'NO_BARS')
})

test('amendment area 1: the loop measures itself and stops on the first breach (memory, runtime, pull rate, temp bytes), recording observed values', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bfr-core-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const files = writeSegments(dir, [{ start: T0, seconds: 120 }, { start: T0 + 120_000, seconds: 120 }, { start: T0 + 240_000, seconds: 120 }])
  const limits = { workerMemoryMb: 1, maxRuntimeMs: 3_600_000, maxTempBytes: 1 << 30, maxPullsPerMinute: 30 }
  const mem = await processSegments({ names: files, destDir: dir, cfg: CFG, limits, memoryRssBytes: () => 2 * 1024 * 1024 })
  assert.equal(mem.manifest.aborted, true); assert.equal(mem.manifest.breach.limit, 'workerMemoryMb'); assert.equal(mem.manifest.breach.observed, 2); assert.equal(mem.manifest.processed, 0)
  let clock = 1_000_000
  const rt = await processSegments({ names: files, destDir: dir, cfg: CFG, limits: { ...limits, workerMemoryMb: 4096, maxRuntimeMs: 5 }, now: () => (clock += 10), memoryRssBytes: () => 1 })
  assert.equal(rt.manifest.breach.limit, 'maxRuntimeMs'); assert.ok(rt.manifest.observed.runtimeMs >= 5)
  // Pull rate: three pulls inside a minute against a limit of 2 → the third aborts, and its file is removed.
  const src = files
  const pull = async (name, destDir) => { const p = join(destDir, name.split('/').pop()); writeFileSync(p, segment(T0, 60).buf); return { ok: true, path: p } }
  const pr = await processSegments({ names: src.map(f => 'seg-' + f.split('seg-').pop()), pull, destDir: dir, cfg: CFG, limits: { ...limits, workerMemoryMb: 4096, maxPullsPerMinute: 2 }, memoryRssBytes: () => 1 })
  assert.equal(pr.manifest.breach.limit, 'maxPullsPerMinute'); assert.equal(pr.manifest.breach.observed, 3); assert.equal(pr.manifest.observed.maxPullsPerMinute, 3); assert.equal(pr.manifest.processed, 2)
  const tb = await processSegments({ names: src.map(f => 'seg-' + f.split('seg-').pop()).slice(0, 1), pull, destDir: dir, cfg: CFG, limits: { ...limits, workerMemoryMb: 4096, maxTempBytes: 10 }, memoryRssBytes: () => 1 })
  assert.equal(tb.manifest.breach.limit, 'maxTempBytes'); assert.ok(tb.manifest.observed.maxTempBytes > 10)
  // No limits: nothing measured against, nothing aborted.
  assert.equal((await processSegments({ names: files, destDir: dir, cfg: CFG })).manifest.breach, null)
})

test('a segment that opens with a gap marks every symbol already holding bars (Codex P1 on #1311), with the leading gap counted', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bfr-core-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = writeSegments(dir, [{ start: T0, seconds: 300 }])[0]
  // Segment B: a reconnect gap BEFORE its first quote, then quotes for symbol 1 only.
  const parts = [encodeHeader({ environment: 'demo', generation: 1, startedMs: T0 + 300_000, feedId: 'test' }), gap(T0 + 300_000, 3, 5)]
  for (let s2 = 0; s2 < 300; s2 += 2) parts.push(quote(T0 + 300_000 + s2 * 1000, 1000 + s2, 1, 100 + s2 * 0.001, 100.02 + s2 * 0.001))
  const b = join(dir, 'seg-0000000000002-000000.tks'); writeFileSync(b, Buffer.concat(parts))
  assert.equal(quotesFromSegment(b).leadingGaps, 1); assert.equal(quotesFromSegment(a).leadingGaps, 0)
  const { series, manifest } = await processSegments({ names: [a, b], destDir: dir, cfg: { ...CFG, calibrationSegments: 1 } })
  assert.equal(manifest.leadingGapSegments, 1)
  // Symbol 1: no minute-bar run spans the boundary (the hole marks the open bar and the next).
  const s1 = series.get(1).find(f => f.form === 'time_60000ms')
  assert.equal(s1.runs.some(run => run.some(x => x.t < T0 + 300_000) && run.some(x => x.t >= T0 + 300_000)), false)
  // The same gap without the leading-gap rule would have let the bar open at the end of A resume into B: the first bar of B is invalid.
  const firstB = s1.all.find(x => x.t >= T0 + 300_000)
  assert.ok(firstB == null || firstB.invalid === 'gap' || firstB.t > T0 + 300_000 + 60_000 || s1.excludedForCalibration > 0)
})

test('Codex P1s on #1312: the symbol cap holds in the loop; a breach reached by the last segment is recorded; the retained cache is measured in aggregate under keepCache; the evaluation phase is checked', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bfr-core-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const files = writeSegments(dir, [{ start: T0, seconds: 300 }, { start: T0 + 300_000, seconds: 300 }])
  // Symbol cap: two symbols in the feed, one allowed → the second is omitted and counted, never built.
  const capped = await processSegments({ names: files, destDir: dir, cfg: CFG, maxSymbols: 1 })
  assert.deepEqual(capped.manifest.symbols, [1]); assert.equal(capped.manifest.symbolsOmitted, 1); assert.deepEqual(capped.manifest.symbolsOmittedSample, [2]); assert.equal(capped.series.size, 1)
  // A cross-check symbol is reserved under the cap (Codex P2 on #1313): with cap 1 and symbol 2 named, symbol 1 (seen first) is the one omitted.
  const reservedRun = await processSegments({ names: files, destDir: dir, cfg: CFG, maxSymbols: 1, crossCheckSymbolIds: [2] })
  assert.deepEqual(reservedRun.manifest.symbols, [2]); assert.deepEqual(reservedRun.manifest.symbolsOmittedSample, [1]); assert.ok(reservedRun.crossCheckBars[2]?.length > 0)
  // Reserved ids never exceed the cap (Codex P2 on #1314): cap 1 with both symbols reserved admits only the first seen.
  const over = await processSegments({ names: files, destDir: dir, cfg: CFG, maxSymbols: 1, crossCheckSymbolIds: [1, 2] })
  assert.equal(over.series.size, 1); assert.equal(over.manifest.symbolsOmitted, 1)
  // Final-segment breach: memory crosses the limit only on the check after the last segment.
  let calls = 0
  const late = await processSegments({ names: files, destDir: dir, cfg: CFG, limits: { workerMemoryMb: 1, maxRuntimeMs: 3_600_000, maxTempBytes: 1 << 30, maxPullsPerMinute: 30 }, memoryRssBytes: () => (++calls >= 3 ? 2 * 1024 * 1024 : 1) })
  assert.equal(late.manifest.processed, 2, 'both segments processed before the breach was reached'); assert.equal(late.manifest.breach.limit, 'workerMemoryMb'); assert.equal(late.manifest.aborted, true)
  // Aggregate cache: two pulled segments kept on disk exceed a limit each alone fits under.
  const src = files.map(f => 'seg-' + f.split('seg-').pop())
  const pull = async (name, destDir) => { const p = join(destDir, name); writeFileSync(p, segment(T0 + src.indexOf(name) * 300_000, 300).buf); return { ok: true, path: p } }
  const one = statSync(join(dir, src[0].replace('seg-', 'seg-'))).size
  const kept = await processSegments({ names: src, pull, destDir: dir, cfg: CFG, keepCache: true, limits: { workerMemoryMb: 4096, maxRuntimeMs: 3_600_000, maxTempBytes: Math.floor(one * 1.5), maxPullsPerMinute: 30 }, memoryRssBytes: () => 1 })
  assert.equal(kept.manifest.breach.limit, 'maxTempBytes'); assert.ok(kept.manifest.breach.observed > one); assert.equal(kept.manifest.observed.cacheBytes, kept.manifest.breach.observed)
  const streamed = await processSegments({ names: src, pull, destDir: dir, cfg: CFG, keepCache: false, limits: { workerMemoryMb: 4096, maxRuntimeMs: 3_600_000, maxTempBytes: Math.floor(one * 1.5), maxPullsPerMinute: 30 }, memoryRssBytes: () => 1 })
  assert.equal(streamed.manifest.breach, null, 'streaming keeps one file on disk: under the same limit')
  // Evaluation phase: a memory breach after evaluateSeries is a breach.
  const m = { observed: { maxRssBytes: 0, runtimeMs: 0 }, breach: null, aborted: false }
  checkAfterEvaluation(m, { limits: { workerMemoryMb: 1 }, startedMs: 0, now: () => 10, memoryRssBytes: () => 3 * 1024 * 1024 })
  assert.equal(m.breach.limit, 'workerMemoryMb'); assert.equal(m.breach.phase, 'evaluation'); assert.equal(m.aborted, true)
  const ok = { observed: { maxRssBytes: 0, runtimeMs: 0 }, breach: null, aborted: false }
  checkAfterEvaluation(ok, { limits: { workerMemoryMb: 1, maxRuntimeMs: 100 }, startedMs: 0, now: () => 10, memoryRssBytes: () => 1 })
  assert.equal(ok.breach, null)
})
