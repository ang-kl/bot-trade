#!/usr/bin/env node
// scripts/tick-research.mjs — P4: replay the recorded segments through
// tick_momentum_breakout with executable prices and costs, one trial per
// parameter set, and write the trial ledger entries as JSON (importable
// with POST /actions/tick-trials or read by hand).
//   node scripts/tick-research.mjs <segments dir> [--stage-a] [--params '{"rangeEvents":256}']
//        [--sim '{"latencyMs":250,"slippage":1,"commissionPerSide":0}'] [--symbol <id>]
//        [--max-segments <n>] [--out trials.json]
// --stage-a runs the plan's twelve N × efficiency combinations with the
// other settings frozen (research-profile.json); everything else is one
// trial. Every symbol in the segments is replayed separately; a trial's
// summary is per symbol (copies across accounts are one exposure, not
// independent samples, so accounts are never summed here).
// PR-H: the decoding and the grid live in agent/services/tick-research-run.js,
// shared with POST /actions/tick-research — this script is the "beside the
// spool" path for segments the keeper cannot reach.
// PR-EX (20-09-2026): --max-segments <n> replays the n OLDEST segments in the
// directory and nothing else, the same bound the route takes as
// { "maxSegments": n } and validated by the same maxSegmentsFrom — so the two
// paths cannot drift on what "a subset" means. It is the route's answer to a
// spool over the keeper's record cap; here it is simply a smaller run.
import { writeFileSync } from 'node:fs'
import { listSegments, replayFiles, researchPlan, maxSegmentsFrom, includeTestRefusal } from '../agent/services/tick-research-run.js'
import { loadThresholds } from '../agent/services/tick-validation.js'
import { loadRepoSchedule } from '../agent/lib/tick-cost-schedule.js'

const args = process.argv.slice(2)
const target = args.find(a => !a.startsWith('--'))
if (!target) { console.error('usage: tick-research.mjs <segments dir> [--stage-a] [--params json] [--sim json] [--include-test --profile <hash>] [--symbol id] [--max-segments n] [--out file]'); process.exit(2) }
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const stageA = args.includes('--stage-a')
const paramsArg = opt('--params') ? JSON.parse(opt('--params')) : {}
const simArg = opt('--sim') ? JSON.parse(opt('--sim')) : {}
// Plan §7: the test block is WITHHELD on every research run; the owner's one
// confirmation run passes --include-test (recorded on the trial's sim).
// PR-Q1: with --include-test the script obeys the route's rule — exactly one
// declared profile (--profile <16 or 64 hex> agreeing with --params), never
// --stage-a. Its output imports through POST /actions/tick-trials, which
// records the opening (client_import, unverified) and refuses a second one.
if (args.includes('--include-test')) simArg.includeTest = true
const profileArg = opt('--profile')
{
  const refused = includeTestRefusal({ stageA, params: paramsArg, sim: simArg, profileHash: profileArg ?? undefined })
  if (refused) { console.error(`${refused.body.error}: ${refused.body.where}`); process.exit(2) }
}
const onlySymbol = opt('--symbol') ? Number(opt('--symbol')) : null
const outFile = opt('--out')

// A flag with NO VALUE is refused, never read as absent. Checker,
// 20-09-2026: `opt()` returns args[i+1], so `--max-segments` typed last gave
// undefined and the script replayed the WHOLE directory with no stderr line
// and exit 0 — the operator who mistypes gets exactly the full run they were
// trying to avoid.
const boundedArg = opt('--max-segments')
if (args.includes('--max-segments') && (boundedArg == null || boundedArg.startsWith('--'))) {
  console.error('--max-segments needs a value: the number of segments to replay, oldest first')
  process.exit(2)
}
const bounded = maxSegmentsFrom(boundedArg == null ? {} : { maxSegments: Number(boundedArg) })
if (bounded.refuse) { console.error(`${bounded.refuse.body.error}: ${bounded.refuse.body.where}`); process.exit(2) }
const available = listSegments(target)
if (!available.length) { console.error(`no seg-*.tks segment at ${target}`); process.exit(2) }
// listSegments sorts lexicographically and seg-<13-digit-ms>-<6-digit index>
// makes that chronological ascending, so the first n are the OLDEST n — the
// same end of the list the route's admit keeps and the segment sync pulls.
const files = bounded.value == null ? available : available.slice(0, bounded.value)
if (bounded.value != null) console.error(`replaying ${files.length} of ${available.length} segment(s) (--max-segments ${bounded.value}, oldest first)`)
// ONE PATH, not two that must be kept in step. Checker, 20-09-2026: this
// script called loadSegments + runTrials directly and so never reached the
// three lines in `replayFiles` that write the bound onto the manifest —
// measured on the same directory, the same two-file slice and the same
// settings, the route produced trial id 932c7a86ea1c82effd67 and this script
// 088c4dff91b8292437fa. A trial produced here by --max-segments 2 was
// indistinguishable from an unbounded run (the half-truth the route had just
// closed), and the SAME evidence content-keyed differently depending on which
// door made it, so the content-keyed dedupe stopped recognising a re-run.
// Both 413 texts recommend this door, so it is not a backwater.
//
// The cost schedule defaults in exactly as `researchPlan` does it for the
// route. There is no keeper database here, so no symbol is CLASSIFIED and
// `runTrials` strips the schedule back to `costs: null` per symbol — the same
// uncharged trial this script always produced, and the same one the route
// produces for an unclassified symbol.
const plan = researchPlan({
  stageA, params: paramsArg, sim: simArg,
  ...(profileArg == null ? {} : { profileHash: profileArg }),
  ...(onlySymbol == null ? {} : { symbol: onlySymbol }),
  ...(bounded.value == null ? {} : { maxSegments: bounded.value }),
}, { costSchedule: loadRepoSchedule() })
plan.segmentsAvailable = available.length
plan.segmentsDropped = available.length - files.length
const replayed = replayFiles(files, plan, loadThresholds().replay)
if (!replayed) { console.error(`the ${files.length} segment file(s) at ${target} decoded to no valid quote event`); process.exit(2) }
const trials = replayed.trials.map(t => t.trial)
const out = JSON.stringify({ generatedAt: new Date().toISOString(), stageA, trials }, null, 1)
if (outFile) { writeFileSync(outFile, out + '\n'); console.error(`${trials.length} trial(s) written to ${outFile}`) } else process.stdout.write(out + '\n')
