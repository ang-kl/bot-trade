#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/v3-p1p4-acceptance.mjs — the P1/P4 read-only acceptance harness
// (V3 M3, P1/P4-3). NOT deployed; run from any machine that holds the
// read-tier token.
//
//   AGENT_SECRET_READ=… node scripts/v3-p1p4-acceptance.mjs [--out FILE] [--hours N]
//   AGENT_SECRET_READ=… node scripts/v3-p1p4-acceptance.mjs --once
//   node scripts/v3-p1p4-acceptance.mjs --grade FILE [--from ISO] [--to ISO] [--json]
//
// WHAT IT DOES. GET only, with the READ token (never the write token: it
// refuses to start with only AGENT_SECRET set). It samples
//   /health              every 30 s  (cheap; carries the V3 M1 boot record)
//   /state/heartbeats    every 60 s, every 30 s for 6 min after a restart
//   /state/entry-engines every 60 s, every 30 s for 6 min after a restart
//   /actions/goal-table  every 5 min — the targets only (the limits and the
//                        owner's confirmation stamp); nothing is computed
//   /state/goal-table    OFF by default; --goal-table-every-min N opts in.
//                        MEASURED 25-09 16:11:43Z: one read took 12,520 ms
//                        (route-timings) and the 100 ms lag probe recorded a
//                        12,431 ms stall ending the same millisecond the
//                        response finished (16:11:55.463Z) — the table is a
//                        synchronous main-thread block, and nothing else
//                        reads that route (the UI reads /state/goal-tracker).
//                        Polled every 5 min it would put a 12 s stall in every
//                        window it grades, so it follows the review's
//                        alternative, "read /health instead": the limits come
//                        from /actions/goal-table (1-4 ms) and the four rows'
//                        inputs from /health and /state/heartbeats. When opted
//                        in, each read is recorded and a stall overlapping it
//                        is annotated (never removed)
//   /state/route-timings every 5 min
//   /state/runtime-manifest every 5 min (the two sidecars' boot ids)
// and appends one compact JSON line per request to --out (default
// ./v3-p1p4-acceptance.jsonl). A restart is an uptime reset, a commit change
// or a boot-record change. After each restart's recovery deadline it reads
// the attribution evidence once (action_log; the cockpit journal of every
// position whose SL/TP changed) and records it. It prints each boot's grade
// when its startup window closes, the whole grade every hour, and again on
// exit (Ctrl-C). The grade is agent/services/p1p4-grade.js — every limit is
// PROPOSED until the owner confirms it, and the header says so.
//
// The token goes into the Authorization header and nowhere else: not a URL,
// not a record, not a log line (any echo of it in an error is scrubbed).
// ---------------------------------------------------------------------------
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import {
  compactHealth, compactHeartbeats, compactEntryEngines, compactGoalTargets, compactGoalTable, compactRouteTimings, compactManifest,
  classifyResponse, splitBoots, recoverySamples, changedPositionKeys, gradeRun, formatGrade, p1p4LimitsFromTargets, toMs,
} from '../agent/services/p1p4-grade.js'

export const DEFAULT_BASE = 'https://sg-trade.up.railway.app'
export const DEFAULT_OUT = 'v3-p1p4-acceptance.jsonl'

/** Sampling cadence per kind (ms). */
export const CADENCE = Object.freeze({
  health: 30_000, heartbeats: 60_000, entryEngines: 60_000,
  goalTargets: 300_000, routeTimings: 300_000, manifest: 300_000,
  // The full table is a synchronous main-thread block: 12,520 ms and a
  // 12,431 ms event-loop stall on one read (25-09 16:11:43Z; 13,271 ms at
  // 14:25Z; 1,900 ms in the review). OFF unless --goal-table-every-min opts
  // in: the limits come from goalTargets above, which computes nothing.
  goalTable: Infinity,
})
/** After a detected restart: heartbeats and entry-engines every 30 s for this long (the recovery window plus a minute). */
export const RECOVERY_DENSE_MS = 6 * 60_000
const DENSE_MS = 30_000

export const ROUTES = Object.freeze({
  health: '/health', heartbeats: '/state/heartbeats', entryEngines: '/state/entry-engines',
  goalTargets: '/actions/goal-table', goalTable: '/state/goal-table', routeTimings: '/state/route-timings', manifest: '/state/runtime-manifest',
})
const COMPACT = { health: compactHealth, heartbeats: compactHeartbeats, entryEngines: compactEntryEngines, goalTargets: compactGoalTargets, goalTable: compactGoalTable, routeTimings: compactRouteTimings, manifest: compactManifest }

/** Replace every occurrence of the token in `text`. */
export function scrub(text, token) {
  const s = String(text ?? '')
  return token ? s.split(token).join('[redacted]') : s
}

/**
 * A GET-only reader. There is no method parameter on purpose: nothing here
 * can send anything but GET.
 */
export function makeReader({ base = DEFAULT_BASE, token, fetchImpl = globalThis.fetch, timeoutMs = 20_000, now = Date.now } = {}) {
  const root = String(base).replace(/\/+$/, '')
  return async function get(path) {
    const t = now()
    try {
      const res = await fetchImpl(`${root}${path}`, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
      const text = await res.text()
      const cls = classifyResponse({ status: res.status, bodyText: text })
      let body = null
      if (cls === 'ok') { try { body = JSON.parse(text) } catch { body = null } }
      return { t, ms: now() - t, status: res.status, cls, body, bodyText: cls === 'ok' ? null : scrub(text.slice(0, 300), token) }
    } catch (err) {
      // The harness's own deadline is not a gateway error: a main thread
      // blocked past it looks exactly like this (classifyResponse, 'timeout').
      const timedOut = err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError'
      return { t, ms: now() - t, status: null, cls: classifyResponse({ error: err, timedOut }), body: null, error: scrub(String(err?.message || err).slice(0, 200), token) }
    }
  }
}

/** One JSONL record for one request. */
export function recordOf(kind, route, r) {
  const data = r.cls === 'ok' && r.body ? COMPACT[kind]?.(r.body) ?? null : null
  return {
    t: r.t, kind, route, status: r.status, cls: r.cls, ms: r.ms, data,
    ...(r.error ? { error: r.error } : {}),
    ...(r.cls !== 'ok' && r.bodyText ? { bodyText: r.bodyText } : {}),
  }
}

/** Read a JSONL file of records; unreadable lines are counted, not fatal. */
export function readSamples(file) {
  if (!existsSync(file)) return { samples: [], bad: 0 }
  let bad = 0
  const samples = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { samples.push(JSON.parse(line)) } catch { bad++ }
  }
  return { samples, bad }
}

/**
 * Collect the attribution evidence for one boot's recovery, GET-only: the
 * action_log rows in the window, and the cockpit journal (position_events,
 * including the native trail engine's polled amends) of every still-open
 * position whose SL/TP changed. A journal read that failed is left undefined
 * so the grader reports Not Verifiable rather than "unexplained".
 */
export async function collectEvidence(get, boot, samples, limits, { maxJournals = 20 } = {}) {
  const { preHb, postHb } = recoverySamples(boot, limits, samples)
  const fromMs = (preHb?.t ?? boot.bootAtMs) - 60_000
  const untilMs = (postHb?.t ?? boot.bootAtMs + limits.recoverySec * 1000) + 60_000
  const inWindow = (at) => { const t = toMs(at); return t != null && t >= fromMs && t <= untilMs }
  const out = { bootAtMs: boot.bootAtMs, window: { fromMs, toMs: untilMs }, actionLog: { ok: false, rows: [] }, journals: {}, journalsOk: true, reads: [] }
  // account=all: without it the route answers for the SELECTED account only
  // (account-scope.js requestedAccount), and another account's entry-mode
  // change would read as unexplained. Newest first, so the read covers the
  // window only when it reaches back past its start or returned every row.
  const AL_LIMIT = 1000
  const al = await get(`/state/action-log?account=all&limit=${AL_LIMIT}`)
  out.reads.push(recordOf('evidence', '/state/action-log', al))
  if (al.cls === 'ok' && Array.isArray(al.body?.rows)) {
    const rows = al.body.rows
    const oldest = rows.length ? Math.min(...rows.map(r => toMs(r.at) ?? Infinity)) : null
    const covers = rows.length < AL_LIMIT || (oldest != null && oldest <= fromMs)
    out.actionLog = covers
      ? { ok: true, rows: rows.filter(r => inWindow(r.at)).slice(0, 200).map(r => ({ at: r.at, method: r.method, path: r.path, account_id: r.account_id ?? null, body: String(r.body ?? '').slice(0, 300) })) }
      : { ok: false, rows: [], reason: `the newest ${AL_LIMIT} rows do not reach back to the window start` }
  }
  const changed = preHb && postHb ? changedPositionKeys(preHb, postHb).filter(c => !c.closed && !c.opened) : []
  if (changed.length) {
    const pos = await get('/state/positions?account=all')
    out.reads.push(recordOf('evidence', '/state/positions', pos))
    const byBroker = new Map((pos.cls === 'ok' && Array.isArray(pos.body?.positions) ? pos.body.positions : [])
      .filter(p => p.ctrader_position_id != null).map(p => [`${p.account_id}:${p.ctrader_position_id}`, p]))
    for (const c of changed.slice(0, maxJournals)) {
      const p = byBroker.get(c.key)
      if (!p) { out.journalsOk = false; continue }
      // The cockpit snapshot also draws bars through the broker's historical
      // limiter (state.js cockpit route); one daily bar over one hour is the
      // smallest request it accepts. Only the journal is kept.
      const r = await get(`/state/position/${encodeURIComponent(p.id)}/cockpit?account=${encodeURIComponent(p.account_id)}&timeframe=1d&lookback=1`)
      out.reads.push(recordOf('evidence', '/state/position/:id/cockpit', r))
      if (r.cls === 'ok' && Array.isArray(r.body?.journal)) {
        // Journal events up to the READ, not only to the post sample: the
        // native trail poll's "last seen" map is in memory (profit-keeper.js
        // lastSeenTrailSl), so an amend the sidecar made while Node was down
        // is journalled (cpp_trail_engine) at the first keeper pass after
        // boot, which can land after the post sample.
        const readAt = r.t + (r.ms ?? 0)
        out.window.journalsToMs = Math.max(out.window.journalsToMs ?? untilMs, readAt)
        out.journals[c.key] = r.body.journal.filter(e => { const t = toMs(e.at); return t != null && t >= fromMs && t <= Math.max(untilMs, readAt) }).slice(-20).map(e => ({ at: e.at, kind: e.kind, from: e.from ?? null, to: e.to ?? null, source: e.source ?? null }))
      } else out.journalsOk = false
    }
    if (changed.length > maxJournals) out.journalsOk = false
  }
  // The reads' own records are kept for the platform/app classification; the bodies are not.
  out.reads = out.reads.map(({ t, route, status, cls, ms }) => ({ t, route, status, cls, ms }))
  return out
}

/**
 * The sampling loop. Injected fetch/clock/sleep make it testable; `rounds`
 * bounds it (tests), `untilMs` ends it (--hours). Returns the samples taken.
 */
export async function runHarness({
  base = DEFAULT_BASE, token, out = DEFAULT_OUT, fetchImpl = globalThis.fetch, now = Date.now,
  sleep = (ms) => delay(ms), log = (line) => console.log(line), write = (line) => appendFileSync(out, `${line}\n`),
  untilMs = Infinity, rounds = Infinity, prior = [], signal = null, gradeEveryMs = 3_600_000, cadence = CADENCE,
} = {}) {
  if (!token) throw new Error('AGENT_SECRET_READ is not set: the harness reads with the read-tier token only')
  const get = makeReader({ base, token, fetchImpl, now })
  const samples = [...prior]
  // A kind whose cadence is not a finite number is never read (goalTable by default).
  const due = Object.fromEntries(Object.keys(cadence).map(k => [k, Number.isFinite(cadence[k]) ? 0 : Infinity]))
  const evidenceDone = new Set(samples.filter(s => s.kind === 'evidence').map(s => Math.round(Number(s.data?.bootAtMs) / 60_000)))
  const printedStartup = new Set()
  let lastGradeAt = now()
  let denseUntil = 0
  let warnedAuth = false
  const push = (rec) => { samples.push(rec); write(JSON.stringify(rec)) }
  const limitsNow = () => {
    const gt = [...samples].reverse().find(s => (s.kind === 'goalTargets' || s.kind === 'goalTable') && s.data?.targets)
    return p1p4LimitsFromTargets(gt?.data.targets).limits
  }
  for (let round = 0; round < rounds; round++) {
    if (signal?.aborted || now() >= untilMs) break
    for (const kind of Object.keys(cadence)) {
      const t = now()
      if (t < due[kind]) continue
      const r = await get(ROUTES[kind])
      const rec = recordOf(kind, ROUTES[kind], r)
      push(rec)
      const dense = (kind === 'heartbeats' || kind === 'entryEngines') && t < denseUntil
      due[kind] = t + (dense ? DENSE_MS : cadence[kind])
      if (kind === 'health' && rec.data && rec.data.authenticated === false && !warnedAuth) {
        warnedAuth = true
        log('[p1p4] /health answered unauthenticated — the read token was not accepted; boot records and heartbeats will be missing')
      }
      if (kind === 'health' && rec.cls === 'platform') log(`[p1p4] platform gateway error on /health (${rec.status ?? rec.error}) — classified apart, not an app failure`)
      if (kind === 'health' && rec.data) {
        const boots = splitBoots(samples)
        const b = boots[boots.length - 1]
        if (b.restartObserved && b.firstT === rec.t) {
          log(`[p1p4] restart detected (${b.reasons.join(', ')}): boot ${b.bootAtMs ? new Date(b.bootAtMs).toISOString() : '?'} commit ${b.commit ?? '?'}`)
          denseUntil = (b.bootAtMs ?? t) + RECOVERY_DENSE_MS
          due.heartbeats = 0
          due.entryEngines = 0
          due.manifest = 0
        }
      }
    }
    // Evidence once per observed restart, after its recovery sample exists.
    const limits = limitsNow()
    for (const b of splitBoots(samples)) {
      const key = Math.round(Number(b.bootAtMs) / 60_000)
      if (!b.restartObserved || b.bootAtMs == null || evidenceDone.has(key)) continue
      const { postHb, deadline } = recoverySamples(b, limits, samples)
      if (!postHb && now() < deadline + 240_000) continue
      evidenceDone.add(key)
      const ev = await collectEvidence(get, b, samples, limits)
      push({ t: now(), kind: 'evidence', route: null, status: null, cls: 'ok', ms: null, data: ev })
    }
    // Each boot's startup+recovery grade once its window has closed; the whole run hourly.
    for (const b of splitBoots(samples)) {
      const key = Math.round(Number(b.bootAtMs) / 60_000)
      if (b.bootAtMs == null || printedStartup.has(key) || now() < b.bootAtMs + limits.startupWindowMin * 60_000 + 30_000) continue
      printedStartup.add(key)
      const g = gradeRun(samples)
      const gb = g.boots.find(x => x.bootAt && Math.abs(Date.parse(x.bootAt) - b.bootAtMs) < 60_000)
      if (gb) log(formatGrade({ ...g, boots: [{ ...gb, steady: { ...gb.steady, criteria: [], verdict: '(hourly)' } }] }))
    }
    if (now() - lastGradeAt >= gradeEveryMs) { lastGradeAt = now(); log(formatGrade(gradeRun(samples))) }
    const next = Math.min(...Object.values(due))
    const wait = Math.max(250, next - now())
    if (round + 1 < rounds && now() + wait < untilMs) await sleep(wait)
  }
  return samples
}

function parseArgs(argv) {
  const a = { flags: new Set(), values: {} }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (!k.startsWith('--')) continue
    const name = k.slice(2)
    if (['once', 'json', 'help'].includes(name)) a.flags.add(name)
    else a.values[name] = argv[++i]
  }
  return a
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.flags.has('help')) {
    console.log('usage: AGENT_SECRET_READ=… node scripts/v3-p1p4-acceptance.mjs [--base URL] [--out FILE] [--hours N] [--goal-table-every-min N] | --once | --grade FILE [--from ISO] [--to ISO] [--json]')
    return
  }
  if (args.values.grade) {
    const { samples, bad } = readSamples(resolve(args.values.grade))
    const g = gradeRun(samples, { fromMs: toMs(args.values.from), toMs: toMs(args.values.to) })
    console.log(args.flags.has('json') ? JSON.stringify(g, null, 2) : formatGrade(g))
    if (bad) console.log(`(${bad} unreadable line(s) skipped)`)
    return
  }
  const token = process.env.AGENT_SECRET_READ
  if (!token) {
    console.error(process.env.AGENT_SECRET ? 'refusing: only AGENT_SECRET is set — this harness reads with AGENT_SECRET_READ and never uses the write token' : 'AGENT_SECRET_READ is not set')
    process.exitCode = 2
    return
  }
  const base = args.values.base || process.env.AGENT_URL || DEFAULT_BASE
  const out = resolve(args.values.out || DEFAULT_OUT)
  if (args.flags.has('once')) {
    const samples = await runHarness({ base, token, out, rounds: 1, log: (l) => { if (l.startsWith('[p1p4]')) console.log(l) } }) // the full grade is printed once, below
    for (const s of samples) console.log(`${s.kind.padEnd(13)} ${String(s.status ?? '—').padEnd(4)} ${s.cls.padEnd(9)} ${s.ms ?? '—'} ms ${s.route}`)
    console.log(formatGrade(gradeRun(samples)))
    return
  }
  const { samples: prior, bad } = readSamples(out)
  if (prior.length) console.log(`[p1p4] continuing ${out}: ${prior.length} earlier record(s)${bad ? `, ${bad} unreadable` : ''}`)
  const hours = Number(args.values.hours)
  const untilMs = Number.isFinite(hours) && hours > 0 ? Date.now() + hours * 3_600_000 : Infinity
  const ac = new AbortController()
  const stop = () => ac.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  console.log(`[p1p4] sampling ${base} GET-only → ${out} (limits are PROPOSED until the owner confirms them)`)
  const every = Number(args.values['goal-table-every-min'])
  const cadence = Number.isFinite(every) && every > 0 ? { ...CADENCE, goalTable: every * 60_000 } : CADENCE
  const samples = await runHarness({ base, token, out, prior, untilMs, cadence, signal: ac.signal, sleep: (ms) => delay(ms, undefined, { signal: ac.signal }).catch(() => {}) })
  console.log(formatGrade(gradeRun(samples)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => { console.error(`[p1p4] ${scrub(err?.message || err, process.env.AGENT_SECRET_READ)}`); process.exitCode = 1 })
}
