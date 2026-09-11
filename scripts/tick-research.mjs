#!/usr/bin/env node
// scripts/tick-research.mjs — P4: replay the recorded segments through
// tick_momentum_breakout with executable prices and costs, one trial per
// parameter set, and write the trial ledger entries as JSON (importable
// with POST /actions/tick-trials or read by hand).
//   node scripts/tick-research.mjs <segments dir> [--stage-a] [--params '{"rangeEvents":256}']
//        [--sim '{"latencyMs":250,"slippage":1,"commissionPerSide":0}'] [--symbol <id>] [--out trials.json]
// --stage-a runs the plan's twelve N × efficiency combinations with the
// other settings frozen (research-profile.json); everything else is one
// trial. Every symbol in the segments is replayed separately; a trial's
// summary is per symbol (copies across accounts are one exposure, not
// independent samples, so accounts are never summed here).
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { readSegment, toQuoteEvents, FORMAT_VERSION } from '../agent/lib/tick-segment.js'
import { simulate } from '../agent/lib/tick-replay-sim.js'
import { normalizeParams } from '../agent/lib/tick-strategy.js'
import { trialIdFor } from '../agent/services/tick-research.js'

const args = process.argv.slice(2)
const target = args.find(a => !a.startsWith('--'))
if (!target) { console.error('usage: tick-research.mjs <segments dir> [--stage-a] [--params json] [--sim json] [--include-test] [--symbol id] [--out file]'); process.exit(2) }
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const stageA = args.includes('--stage-a')
const paramsArg = opt('--params') ? JSON.parse(opt('--params')) : {}
const simArg = opt('--sim') ? JSON.parse(opt('--sim')) : {}
// Plan §7: the test block is WITHHELD on every research run; the owner's one
// confirmation run passes --include-test (recorded on the trial's sim).
if (args.includes('--include-test')) simArg.includeTest = true
const onlySymbol = opt('--symbol') ? Number(opt('--symbol')) : null
const outFile = opt('--out')

const files = statSync(target).isDirectory()
  ? readdirSync(target).filter(f => f.startsWith('seg-') && f.endsWith('.tks')).sort().map(f => join(target, f))
  : [target]
const bySymbol = new Map()
let events = 0, torn = 0, firstMs = null, lastMs = null
for (const f of files) {
  const seg = readSegment(readFileSync(f))
  if (!seg.header) continue
  if (seg.truncated) torn++
  for (const ev of toQuoteEvents(seg)) {
    if (ev.gap) { for (const list of bySymbol.values()) list.push({ gapMarker: true }); continue }
    if (ev.repeat) { const list = bySymbol.get(ev.symbolId); if (list) list.push({ seq: ev.seq, recvMs: ev.recvMs, bid: null, ask: null, changed: false }); continue }
    if (ev.invalid) continue
    if (onlySymbol != null && ev.symbolId !== onlySymbol) continue
    const list = bySymbol.get(ev.symbolId) || []
    list.push({ seq: ev.seq, recvMs: ev.recvMonoNs / 1e6, bid: ev.bid, ask: ev.ask, snapshot: ev.quality.snapshot, crossed: ev.quality.crossed, changed: true })
    bySymbol.set(ev.symbolId, list)
    events++
    if (firstMs == null || ev.recvMonoNs / 1e6 < firstMs) firstMs = ev.recvMonoNs / 1e6
    if (lastMs == null || ev.recvMonoNs / 1e6 > lastMs) lastMs = ev.recvMonoNs / 1e6
  }
}
// A gap marker invalidates continuity: the sim sees it as a crossed (invalid) quote, which the strategy treats as a warm-up reset.
for (const list of bySymbol.values()) for (const q of list) if (q.gapMarker) Object.assign(q, { seq: 0, recvMs: 0, bid: 1, ask: 0, crossed: true, snapshot: false, changed: true })

const grid = stageA
  ? [128, 256, 512, 1024].flatMap(N => [0.25, 0.4, 0.55].map(E => ({ rangeEvents: N, momentumEvents: N / 4, minEfficiency: E })))
  : [paramsArg]
const manifestBase = { files: files.map(f => basename(f)), events, symbols: [...bySymbol.keys()], torn, fromMs: firstMs, toMs: lastMs, decoderVersion: FORMAT_VERSION }
const trials = []
for (const g of grid) {
  const params = normalizeParams({ ...paramsArg, ...g })
  for (const [symbolId, list] of bySymbol) {
    const r = simulate(list, params, simArg)
    const trial = { strategyId: r.strategyId, strategyVersion: r.strategyVersion, profileHash: r.profileHash, params: r.params, sim: r.sim, manifest: { ...manifestBase, symbolId, symbolEvents: list.length }, summary: r.summary, blocks: r.blocks, rejected: r.rejected }
    trial.trialId = trialIdFor(trial)
    trials.push(trial)
  }
}
const out = JSON.stringify({ generatedAt: new Date().toISOString(), stageA, trials }, null, 1)
if (outFile) { writeFileSync(outFile, out + '\n'); console.error(`${trials.length} trial(s) written to ${outFile}`) } else process.stdout.write(out + '\n')
