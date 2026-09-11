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
// PR-H: the decoding and the grid live in agent/services/tick-research-run.js,
// shared with POST /actions/tick-research — this script is the "beside the
// spool" path for segments the keeper cannot reach.
import { writeFileSync } from 'node:fs'
import { listSegments, loadSegments, runTrials } from '../agent/services/tick-research-run.js'

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

const files = listSegments(target)
if (!files.length) { console.error(`no seg-*.tks segment at ${target}`); process.exit(2) }
const loaded = loadSegments(files, { onlySymbol })
const trials = runTrials(loaded, { stageA, params: paramsArg, sim: simArg })
const out = JSON.stringify({ generatedAt: new Date().toISOString(), stageA, trials }, null, 1)
if (outFile) { writeFileSync(outFile, out + '\n'); console.error(`${trials.length} trial(s) written to ${outFile}`) } else process.stdout.write(out + '\n')
