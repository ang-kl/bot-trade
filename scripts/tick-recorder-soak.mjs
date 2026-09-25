#!/usr/bin/env node
// scripts/tick-recorder-soak.mjs — V3 R2 (P8d, corrected): the recorder soak.
//
// Builds scripts/tick-recorder-soak-driver.cpp against the gateway's own
// recorder source (cpp-exec/src/tick_recorder.cpp, compiled here, from
// scripts/, so no gateway watch pattern fires) and the LD_PRELOAD fault shim
// (scripts/tick-recorder-soak-faults.c), runs it, and grades the report with
// agent/services/final-acceptance.js soakVerdict. Local only: it never
// contacts a broker, a gateway or production.
//
// THE SOAK (tick plan §16, :283): 20 symbols × 100 events/s with short 10×
// bursts, for 24 h, with faults at scripted times — a free-space drop below
// the reserve (twice), EIO and short writes, a failed fsync, a failed rename
// across a seal, an unwritable spool across a segment open, a slow disk, a
// reconnect and an unwritable directory. A size-limited mount (--mount-size,
// --mount-inodes; needs mount permission) adds ENOSPC-by-filler and inode
// exhaustion. A fault that cannot be applied on this host is reported as not
// applied, never as passed.
//
// WHERE IT RUNS. The 24 h run needs a host that stays up 24 h with a
// dedicated mount of at least 4 GiB plus the recorder's reserve (H-P8-6):
// this container's disk sits above the recorder's 85 % stop, so with
// --probe real every write would be refused. The default scripted probe
// models a healthy 64 GiB mount; --probe real measures the mount itself.
//
// The source hash of every compiled file goes into the evidence, because
// this build is outside cpp-exec's Makefile and CI and can drift from the
// gateway's.
//
// Usage:
//   node scripts/tick-recorder-soak.mjs [--duration 86400] [--dir DIR] [--out docs/evidence/v3-recorder-soak-<date>.json]
//     [--symbols 20] [--rate 100] [--burst-factor 10] [--burst-every 60] [--burst-len 5]
//     [--segment-bytes 67108864] [--cap-bytes 2147483648] [--fsync-every-ms 5000] [--budget-every-ms 2000]
//     [--probe scripted|real] [--faults "atS:kind,..."]
//     [--no-shim] [--mount-size BYTES] [--mount-inodes N] [--rss-bound-mib N] [--keep]
//   --keep needs --dir: without --dir the work directory is a temp dir removed at exit, so
//   --keep alone is refused (exit 2) rather than silently ignored.
// Exit: 0 PASS, 1 FAIL, 3 NOT_VERIFIABLE (a run shorter than 24 h is at best NOT_VERIFIABLE), 2 setup error.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { hostname, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { soakVerdict, VERDICT, SOAK_FULL_SECONDS } from '../agent/services/final-acceptance.js'
import { tempDir } from '../agent/test-support/temp-dir.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const SOAK_SOURCES = Object.freeze([
  'cpp-exec/src/tick_recorder.cpp', 'cpp-exec/src/tick_recorder.hpp', 'cpp-exec/src/spsc_ring.hpp',
  'cpp-exec/src/json.hpp', 'cpp-exec/src/log.hpp',
  'scripts/tick-recorder-soak-driver.cpp', 'scripts/tick-recorder-soak-faults.c',
])
const EXIT = { [VERDICT.PASS]: 0, [VERDICT.FAIL]: 1, [VERDICT.NOT_VERIFIABLE]: 3 }

export function soakArgs(argv) {
  const o = { duration: SOAK_FULL_SECONDS, symbols: 20, rate: 100, burstFactor: 10, burstEvery: 60, burstLen: 5,
    segmentBytes: 64 * 1024 * 1024, capBytes: 2 * 1024 ** 3, probe: 'scripted', shim: true, keep: false,
    // The recorder's production intervals (RecorderConfig): the fault holds are sized from them.
    fsyncEveryMs: 5000, budgetEveryMs: 2000 }
  const num = (v, k) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error(`--${k} needs a positive number`); return n }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i] }
    if (a === '--duration') o.duration = num(v(), 'duration')
    else if (a === '--dir') o.dir = v()
    else if (a === '--out') o.out = v()
    else if (a === '--symbols') o.symbols = num(v(), 'symbols')
    else if (a === '--rate') o.rate = num(v(), 'rate')
    else if (a === '--burst-factor') o.burstFactor = num(v(), 'burst-factor')
    else if (a === '--burst-every') o.burstEvery = num(v(), 'burst-every')
    else if (a === '--burst-len') o.burstLen = num(v(), 'burst-len')
    else if (a === '--segment-bytes') o.segmentBytes = num(v(), 'segment-bytes')
    else if (a === '--cap-bytes') o.capBytes = num(v(), 'cap-bytes')
    else if (a === '--fsync-every-ms') o.fsyncEveryMs = num(v(), 'fsync-every-ms')
    else if (a === '--budget-every-ms') o.budgetEveryMs = num(v(), 'budget-every-ms')
    else if (a === '--probe') { o.probe = v(); if (!['scripted', 'real'].includes(o.probe)) throw new Error('--probe is scripted or real') }
    else if (a === '--faults') o.faults = v()
    else if (a === '--no-shim') o.shim = false
    else if (a === '--mount-size') o.mountSize = num(v(), 'mount-size')
    else if (a === '--mount-inodes') o.mountInodes = num(v(), 'mount-inodes')
    else if (a === '--rss-bound-mib') o.rssBoundMiB = num(v(), 'rss-bound-mib')
    else if (a === '--keep') o.keep = true
    else if (a === '--help' || a === '-h') o.help = true
    else throw new Error(`unknown option ${a}`)
  }
  if (o.keep && !o.dir) throw new Error('--keep needs --dir DIR: without it the work directory is a temp dir removed at exit, so nothing would be kept')
  return o
}

/**
 * The default fault plan, placed by fraction of the run so a 60 s smoke run
 * and the 24 h soak exercise the same faults. Each fault is held long enough
 * to meet the call it breaks: a seal or a segment open (rename, unwritable)
 * 1.5 segments at the base rate; a free-space fault 2.5 of the recorder's
 * probe intervals; a failed fsync 1.5 fsync intervals. (The first smoke run
 * held a 1.2 s probe fault against a 2 s probe interval: the recorder never
 * probed inside it, and the driver now reports such a fault as never met.)
 */
export function defaultFaultPlan({ duration, segmentBytes, symbols, rate, mount = false, budgetEveryMs = 2000, fsyncEveryMs = 5000 }) {
  const segS = segmentBytes / (symbols * rate * 40)
  // The start rounds DOWN and the end UP (to 0.1 s), so a hold is never shorter than asked.
  const at = (s, up) => (up ? Math.ceil(s * 10) : Math.floor(s * 10)) / 10
  const short = Math.max(1, Math.min(30, duration * 0.02))
  const segHold = Math.max(2, 1.5 * segS)
  const probeHold = Math.max(short, 2.5 * budgetEveryMs / 1000)
  const fsyncHold = Math.max(short, 1.5 * fsyncEveryMs / 1000)
  // [kind, hold seconds, the entry that ends it (null: an instant)]
  const items = [
    ['probe_low', probeHold, 'probe_ok'], ['eio_write', Math.min(short, 2), 'none'], ['short_write', Math.min(short, 1), 'none'],
    ['rename_fail', segHold, 'none'], ['unwritable', segHold, 'none'], ['slow', short, 'none'], ['eio_fsync', fsyncHold, 'none'],
    ['probe_low', probeHold, 'probe_ok'], ['reconnect', 0, null], ['chmod_ro', short, 'restore'],
    ...(mount ? [['exhaust_inodes', short, 'free_inodes']] : []),
  ]
  // One at a time, spread evenly between 5 % and 90 % of the run: an overlap
  // (a reconnect inside a reserve pause) is a different scenario, and its
  // effects would be charged to the wrong fault.
  const from = duration * 0.05, until = duration * 0.9
  const gap = Math.max(0.5, (until - from - items.reduce((a, [, len]) => a + len, 0)) / items.length)
  const plan = []
  let t = from
  for (const [kind, len, restore] of items) {
    plan.push(`${at(t, false).toFixed(1)}:${kind}`)
    if (restore) plan.push(`${at(t + len, true).toFixed(1)}:${restore}`)
    t = at(t + len, true) + gap
  }
  return plan.join(',')
}

export function sourceHashes(root = ROOT) {
  const files = SOAK_SOURCES.map(rel => ({ file: rel, sha256: createHash('sha256').update(readFileSync(join(root, rel))).digest('hex') }))
  const all = createHash('sha256')
  for (const f of files) all.update(`${f.file}\0${f.sha256}\n`)
  return { sourceSha256: all.digest('hex'), files }
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts })
  return { code: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message || null }
}

async function main() {
  let o
  try { o = soakArgs(process.argv.slice(2)) } catch (e) { console.error(e.message); process.exitCode = 2; return }
  if (o.help) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n')); return }
  const work = o.dir ? join(o.dir, `soak-${Date.now()}`) : tempDir('tick-soak-')
  mkdirSync(work, { recursive: true })
  let mounted = false
  const notes = []
  const spoolParent = join(work, 'mnt')
  try {
    const cxx = run('g++', ['--version']).code === 0 ? 'g++' : 'clang++'
    const driver = join(work, 'soak-driver'), shim = join(work, 'soak-faults.so')
    const b1 = run(cxx, ['-std=c++20', '-O2', '-pthread', '-I', join(ROOT, 'cpp-exec/src'), join(ROOT, 'scripts/tick-recorder-soak-driver.cpp'), join(ROOT, 'cpp-exec/src/tick_recorder.cpp'), '-o', driver, '-ldl'])
    if (b1.code !== 0) { console.error(`driver build failed:\n${b1.stderr}`); process.exitCode = 2; return }
    let shimBuilt = false
    if (o.shim) {
      const b2 = run('cc', ['-shared', '-fPIC', '-O2', '-o', shim, join(ROOT, 'scripts/tick-recorder-soak-faults.c'), '-ldl'])
      shimBuilt = b2.code === 0
      if (!shimBuilt) notes.push(`fault shim not built: ${b2.stderr.trim().split('\n')[0] || b2.error}`)
    }
    mkdirSync(spoolParent, { recursive: true })
    if (o.mountSize) {
      const opt = [`size=${Math.floor(o.mountSize)}`, ...(o.mountInodes ? [`nr_inodes=${Math.floor(o.mountInodes)}`] : [])].join(',')
      const m = run('mount', ['-t', 'tmpfs', '-o', opt, 'tick-soak', spoolParent])
      mounted = m.code === 0
      notes.push(mounted ? `size-limited tmpfs mounted (${opt})` : `size-limited mount refused on this host: ${(m.stderr || m.error || '').trim()}`)
    }
    const faults = o.faults ?? defaultFaultPlan({ duration: o.duration, segmentBytes: o.segmentBytes, symbols: o.symbols, rate: o.rate, mount: mounted, budgetEveryMs: o.budgetEveryMs, fsyncEveryMs: o.fsyncEveryMs })
    const spool = join(spoolParent, 'spool')
    const driverArgs = ['--spool', spool, '--duration', String(o.duration), '--symbols', String(o.symbols), '--rate', String(o.rate),
      '--burst-factor', String(o.burstFactor), '--burst-every', String(o.burstEvery), '--burst-len', String(o.burstLen),
      '--segment-bytes', String(Math.floor(o.segmentBytes)), '--cap-bytes', String(Math.floor(o.capBytes)), '--probe', o.probe,
      '--fsync-every-ms', String(Math.floor(o.fsyncEveryMs)), '--budget-every-ms', String(Math.floor(o.budgetEveryMs)),
      '--faults', faults, '--samples-out', join(work, 'samples.jsonl')]
    const env = { ...process.env, ...(shimBuilt ? { LD_PRELOAD: shim } : {}) }
    const startedAt = new Date().toISOString()
    const r = run(driver, driverArgs, { env, timeout: (o.duration + 600) * 1000 })
    let report = null
    try { report = JSON.parse(r.stdout.trim().split('\n').pop()) } catch { notes.push(`driver produced no report (exit ${r.code}${r.signal ? `, ${r.signal}` : ''}): ${r.stderr.trim().slice(0, 500)}`) }
    let disk = null
    try { const s = statfsSync(spoolParent); disk = { totalBytes: Number(s.blocks) * Number(s.bsize), availBytes: Number(s.bavail) * Number(s.bsize), freeInodes: Number(s.ffree) } } catch { disk = null }
    const verdict = soakVerdict(report, { rssBoundMiB: o.rssBoundMiB ?? null })
    const evidence = {
      kind: 'v3-recorder-soak', startedAt, finishedAt: new Date().toISOString(),
      host: { hostname: hostname(), kernel: release(), node: process.version, compiler: cxx, mounted, disk },
      ...sourceHashes(), command: { driverArgs, shim: shimBuilt, probe: o.probe }, notes,
      driverExit: r.code, verdict: { verdict: verdict.verdict, reason: verdict.reason, checks: verdict.checks }, report,
    }
    if (o.out) writeFileSync(o.out, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(JSON.stringify({ ...evidence, report: report ? { config: report.config, faults: report.faults, final: report.final } : null }, null, 2))
    process.exitCode = EXIT[verdict.verdict] ?? 3
  } finally {
    if (mounted) run('umount', [spoolParent])
    if (!o.keep && o.dir && existsSync(work)) rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
