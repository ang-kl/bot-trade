#!/usr/bin/env node
// scripts/tick-replay.mjs — P3b: replay the sidecar's sealed tick segments
// as plan §4 QuoteEvents (JSON lines) — the research/replayer input.
//   node scripts/tick-replay.mjs <segment.tks | directory> [--summary] [--names id=NAME,...]
// A directory is read in name order (segments sort by start time). Gap
// markers are emitted as {"gap":true,...}; a torn tail is reported to
// stderr, never bridged.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readSegment, toQuoteEvents } from '../agent/lib/tick-segment.js'

const args = process.argv.slice(2)
const target = args.find(a => !a.startsWith('--'))
if (!target) { console.error('usage: tick-replay.mjs <segment.tks | directory> [--summary] [--names id=NAME,...]'); process.exit(2) }
const summary = args.includes('--summary')
const namesArg = args.find(a => a.startsWith('--names='))
const symbolNames = {}
if (namesArg) for (const pair of namesArg.slice(8).split(',')) { const [id, name] = pair.split('='); if (id && name) symbolNames[Number(id)] = name }

const files = statSync(target).isDirectory()
  ? readdirSync(target).filter(f => f.startsWith('seg-') && (f.endsWith('.tks') || f.endsWith('.torn'))).sort().map(f => join(target, f))
  : [target]
let events = 0, gaps = 0, invalid = 0, torn = 0, repeats = 0
const perSymbol = new Map()
let firstMs = null, lastMs = null
for (const f of files) {
  const seg = readSegment(readFileSync(f))
  if (!seg.header) { console.error(`${f}: not a tick segment`); continue }
  if (seg.truncated) { torn++; console.error(`${f}: torn tail after ${seg.records.length} record(s)`) }
  for (const ev of toQuoteEvents(seg, { symbolNames })) {
    if (ev.gap) gaps++
    else if (ev.repeat) repeats++
    else if (ev.invalid) invalid++
    else {
      events++
      const p = perSymbol.get(ev.symbol) || { events: 0, changed: 0 }
      p.events++; if (ev.changedMask) p.changed++
      perSymbol.set(ev.symbol, p)
      if (firstMs == null || ev.recvMonoNs / 1e6 < firstMs) firstMs = ev.recvMonoNs / 1e6
      if (lastMs == null || ev.recvMonoNs / 1e6 > lastMs) lastMs = ev.recvMonoNs / 1e6
    }
    if (!summary) process.stdout.write(JSON.stringify(ev, (_k, v) => typeof v === 'bigint' ? Number(v) : v) + '\n')
  }
}
if (summary) {
  const spanS = firstMs != null && lastMs != null ? Math.max(1, (lastMs - firstMs) / 1000) : 0
  console.log(JSON.stringify({ files: files.length, events, repeats, gaps, invalid, torn, spanSeconds: Math.round(spanS), eventsPerSec: spanS ? +(events / spanS).toFixed(3) : null, perSymbol: Object.fromEntries(perSymbol) }, null, 2))
}
