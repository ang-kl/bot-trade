#!/usr/bin/env node
// scripts/v3-final-acceptance.mjs — V3 R2 (P8d, corrected): grades one P8
// final-acceptance step from GET bodies an operator SAVED to files. It never
// contacts a service (the scripts/tick-shadow-preflight.mjs pattern): the
// evaluators are agent/services/final-acceptance.js, pure functions.
//
// SAVED BODIES. A directory holds one file per GET /state/<route> body, named
// <route>.json or <route>.<anything>.json (several samples of one route sort by
// their own `at`), e.g. tick-segments.json, tick-recorder.0935.json,
// protection-audit.json, entry-intents.json. A gateway's own /health is saved
// as gateway-health.<side>.json (side cpp_exec or cpp_exec_demo). Any file for
// /state/storage, or any body shaped like it, is REFUSED (exit 2): it runs a
// synchronous dbstat walk that held Node's event loop for 20.99 s in
// production and is not an input to any step.
//
// Steps and their inputs:
//   freeze    --start DIR [--fields F.json] [--end DIR --end-fields F.json] [--changes C.json]   (T0)
//             fields file: { originMainSha, railwayDeployments: { cpp-exec, cpp-acct, cpp-verify,
//             cpp-scan-tick, cpp-scan-timeframe }, partialTpPolicyVersion, caps: { maxOpenPositions, bookMax },
//             tickValidationSha256 }. The sha of agent/config/tick-validation.json is computed from
//             this checkout ONLY for a start-only freeze (labelled "computed at evaluation <ISO>");
//             with --end the start value comes from the start fields file and nothing else — save
//             the start run's --out and carry its manifest.start.fields.tickValidationSha256 into
//             the start fields file, or the drift in it reads NOT_VERIFIABLE (not captured)
//   drill     --before DIR --after DIR [--side cpp_exec_demo|cpp_exec]                           (T1, T1b)
//             save the after tick-segments body once the heartbeat has listed the new boot (the
//             R1 manifest's lastListing.bootId is the new one): a restart's losses are classed at
//             that first listing, and judged by the policy of the boot BEFORE the restart
//   retention --samples DIR [--side …] [--allow-open-segment-over-cap]                         (T2)
//   capacity  --samples DIR --stage STAGE.json                                                   (T3)
//   e2e       --dir DIR --from ISO --to ISO [--gate DIR] [--deadline-ms N] [--waive calendars]   (T4)
//   soak      --report SOAK.json [--required-seconds N] [--rss-bound-mib N]                       (P8d)
//   report    --steps A.json,B.json,… [--rollback R.json] [--cost C.json]                        (T5)
// Common: --out FILE writes the result there as well as to stdout.
// Exit: 0 PASS, 1 FAIL, 3 NOT_VERIFIABLE, 2 usage or refused input.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fa from '../agent/services/final-acceptance.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const EXIT = { [fa.VERDICT.PASS]: 0, [fa.VERDICT.FAIL]: 1, [fa.VERDICT.NOT_VERIFIABLE]: 3 }

class UsageError extends Error {}

export function parseArgs(argv) {
  const [step, ...rest] = argv
  const o = { step, waive: [] }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument ${a}`)
    const key = a.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())
    if (key === 'allowOpenSegmentOverCap') { o[key] = true; continue }
    if (i + 1 >= rest.length) throw new UsageError(`${a} needs a value`)
    const v = rest[++i]
    if (key === 'waive') o.waive.push(v)
    else o[key] = v
  }
  return o
}

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new UsageError(`${file}: ${e.message}`) }
}

/**
 * One directory of saved bodies → { routes: { '/state/x': [bodies, oldest first] }, gatewayHealth: { side: body } }.
 * Refuses /state/storage by name or by shape.
 */
export function loadDir(dir) {
  if (!dir) throw new UsageError('a directory of saved GET bodies is required')
  let names
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')).sort() } catch (e) { throw new UsageError(`${dir}: ${e.message}`) }
  const routes = {}, gatewayHealth = {}
  for (const n of names) {
    const path = join(dir, n)
    if (!statSync(path).isFile()) continue
    const parts = basename(n, '.json').split('.')
    const body = readJson(path)
    if (parts[0] === 'gateway-health') {
      if (!fa.SIDES[parts[1]]) throw new UsageError(`${path}: gateway-health.<side>.json needs a side (${Object.keys(fa.SIDES).join(' or ')})`)
      gatewayHealth[parts[1]] = body
      continue
    }
    const route = `/state/${parts[0]}`
    fa.assertNotStorage(route, body, path)
    ;(routes[route] ||= []).push(body)
  }
  for (const r of Object.keys(routes)) routes[r].sort((a, b) => (fa.bodyAtMs(a) ?? 0) - (fa.bodyAtMs(b) ?? 0))
  return { routes, gatewayHealth }
}
const last = (list) => (Array.isArray(list) && list.length ? list[list.length - 1] : null)
/** One body per route (the newest), except the routes a step reads as samples. */
function latest(routes, keepAll = []) {
  const out = {}
  for (const [r, list] of Object.entries(routes)) out[r] = keepAll.includes(r) ? list : last(list)
  return out
}

function tickValidationSha() {
  return createHash('sha256').update(readFileSync(join(ROOT, 'agent/config/tick-validation.json'))).digest('hex')
}

/**
 * One side of a freeze. `computeSha`: whether the tick-validation sha may be
 * read from this checkout when the fields file does not carry it. Never for
 * the START of a start-and-end evaluation: the checkout is read now, at the
 * end, so a start value computed from it equals the end value by
 * construction and a change during the trial would be hidden.
 */
function freezeSide(dirOpt, fieldsOpt, { computeSha, evaluatedAt, side }) {
  const { routes } = loadDir(dirOpt)
  const fromBodies = fa.freezeFieldsFromBodies({
    runtimeManifest: last(routes['/state/runtime-manifest']), entryEngines: last(routes['/state/entry-engines']), tickRecorder: last(routes['/state/tick-recorder']),
  })
  const fields = fieldsOpt ? readJson(fieldsOpt) : {}
  const sources = {}
  const merged = { ...fromBodies }
  for (const k of Object.keys(fromBodies)) sources[k] = 'saved GET body'
  const conflicts = []
  for (const [k, v] of Object.entries(fields)) {
    if (k.startsWith('_')) continue
    if (merged[k] != null && JSON.stringify(merged[k]) !== JSON.stringify(v)) conflicts.push({ field: k, body: merged[k], fieldsFile: v })
    merged[k] = v
    sources[k] = 'operator fields file'
  }
  if (merged.tickValidationSha256 == null) {
    if (computeSha) { merged.tickValidationSha256 = tickValidationSha(); sources.tickValidationSha256 = `computed at evaluation ${evaluatedAt} from this checkout's agent/config/tick-validation.json` }
    else sources.tickValidationSha256 = `not captured: the ${side} fields file carries no tickValidationSha256, and it is never computed from the checkout at evaluation time for the ${side} of a start-and-end freeze`
  }
  return { fields: merged, sources, conflicts }
}

export function runStep(o, { evaluatedAt = new Date().toISOString() } = {}) {
  switch (o.step) {
    case 'freeze': {
      const start = freezeSide(o.start, o.fields, { computeSha: !o.end, evaluatedAt, side: 'start' })
      const end = o.end ? freezeSide(o.end, o.endFields, { computeSha: true, evaluatedAt, side: 'end' }) : null
      const changes = o.changes ? readJson(o.changes) : []
      const r = fa.freezeManifest(start.fields, { end: end?.fields ?? null, changes: Array.isArray(changes) ? changes : changes?.changes ?? [] })
      return { ...r, manifest: { start, end } }
    }
    case 'drill': {
      const b = loadDir(o.before), a = loadDir(o.after)
      const before = { ...latest(b.routes, ['/state/tick-recorder']), gatewayHealth: b.gatewayHealth }
      const after = { ...latest(a.routes, ['/state/tick-recorder']), gatewayHealth: a.gatewayHealth }
      return fa.recorderDrill(before, after, o.side ? { sides: [o.side] } : {})
    }
    case 'retention': {
      const { routes } = loadDir(o.samples)
      return fa.retentionCheck({ segments: routes['/state/tick-segments'] || [], recorder: routes['/state/tick-recorder'] || [] },
        { ...(o.side ? { sides: [o.side] } : {}), allowOpenSegmentOverCap: o.allowOpenSegmentOverCap === true })
    }
    case 'capacity': {
      if (!o.stage) throw new UsageError('capacity needs --stage STAGE.json')
      const { routes } = loadDir(o.samples)
      return fa.capacityStage(routes['/state/tick-recorder'] || [], readJson(o.stage))
    }
    case 'e2e': {
      if (!o.from || !o.to) throw new UsageError('e2e needs --from and --to (ISO times)')
      const d = loadDir(o.dir)
      const bodies = latest(d.routes, ['/state/protection-audit'])
      const gate = o.gate ? latest(loadDir(o.gate).routes) : null
      return fa.e2eTrace(bodies, { window: { from: o.from, to: o.to }, gate, deadlineMs: o.deadlineMs != null ? Number(o.deadlineMs) : null, waive: o.waive })
    }
    case 'soak': {
      if (!o.report) throw new UsageError('soak needs --report SOAK.json')
      const rep = readJson(o.report)
      return fa.soakVerdict(rep.report && rep.kind === 'v3-recorder-soak' ? rep.report : rep, {
        ...(o.requiredSeconds ? { requiredSeconds: Number(o.requiredSeconds) } : {}), rssBoundMiB: o.rssBoundMib != null ? Number(o.rssBoundMib) : null,
      })
    }
    case 'report': {
      if (!o.steps) throw new UsageError('report needs --steps A.json,B.json,…')
      const steps = {}
      for (const f of String(o.steps).split(',').filter(Boolean)) {
        const r = readJson(f)
        const key = r.step === 'T1' && /T1b/i.test(basename(f)) ? 'T1b' : r.step
        if (!fa.FINAL_STEPS.includes(key)) throw new UsageError(`${f}: step ${r.step} is not one of ${fa.FINAL_STEPS.join(', ')}`)
        steps[key] = r
      }
      return fa.finalReport({ steps, rollback: o.rollback ? readJson(o.rollback) : null, cost: o.cost ? readJson(o.cost) : null })
    }
    default:
      throw new UsageError(`unknown step ${o.step ?? '(none)'}: freeze, drill, retention, capacity, e2e, soak or report`)
  }
}

function main() {
  let o
  try {
    o = parseArgs(process.argv.slice(2))
    if (!o.step || o.step === '--help' || o.step === 'help') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'))
      return
    }
    const evaluatedAt = new Date().toISOString()
    const result = { evaluatorVersion: fa.EVALUATOR_VERSION, evaluatedAt, ...runStep(o, { evaluatedAt }) }
    const text = `${JSON.stringify(result, null, 2)}\n`
    if (o.out) writeFileSync(o.out, text)
    process.stdout.write(text)
    process.exitCode = EXIT[result.verdict] ?? 3
  } catch (e) {
    if (e instanceof UsageError || e instanceof fa.StorageBodyRefused) { console.error(e.message); process.exitCode = 2; return }
    throw e
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
