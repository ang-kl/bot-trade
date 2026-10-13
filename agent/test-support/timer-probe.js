// agent/test-support/timer-probe.js — does importing a module leave a timer,
// interval or immediate armed?
//
// Claude · № 14,078+ 13-Oct (owner: NASA programme step 4, "a timer detector
// proven on supported runtimes"; claude-builder). Finding C2 of
// doc/bot-trade-NASA-assessment-2026-10-13.md: the isolation test counted
// Timeout objects in process._getActiveHandles(), which on Node 22 (CI) and
// Node 20 (the production image) returns NONE of them — a module that armed
// an interval read 0. Measured 13-10 on Node 22.22.2: a ref'd interval,
// an unref'd interval and a pending immediate gave _getActiveHandles 0/0/0;
// process.getActiveResourcesInfo() saw the ref'd interval and the immediate
// but not the unref'd interval.
//
// So the probe counts at the source: in a fresh process it wraps
// setTimeout / setInterval / setImmediate (the globals AND node:timers, whose
// ESM bindings are re-synced) before the import, and reports every timer the
// module created that is still pending after a settle — cleared timers and
// one-shots that already fired are not counted. getActiveResourcesInfo()'s
// delta is reported beside it as a second, independent reading.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const PRELOAD = `
import timers from 'node:timers'
import { syncBuiltinESMExports } from 'node:module'
const live = new Map(); let seq = 0
const wrap = (name, oneShot) => {
  const orig = timers[name]
  const f = function (cb, ...rest) {
    const id = ++seq
    const run = typeof cb === 'function' ? function (...a) { if (oneShot) live.delete(id); return cb.apply(this, a) } : cb
    const h = orig.call(this, run, ...rest)
    live.set(id, { kind: name, h })
    if (h && typeof h === 'object') h.__probeId = id
    return h
  }
  globalThis[name] = timers[name] = f
}
const unwrap = (name) => {
  const orig = timers[name]
  globalThis[name] = timers[name] = function (h) { if (h && h.__probeId) live.delete(h.__probeId); return orig.call(this, h) }
}
wrap('setTimeout', true); wrap('setInterval', false); wrap('setImmediate', true)
unwrap('clearTimeout'); unwrap('clearInterval'); unwrap('clearImmediate')
syncBuiltinESMExports()
globalThis.__probeLive = live
`

/**
 * Import `modPath` in a fresh `node` and return { created, resources, kinds }:
 *   created   — timers the import created that are still pending (the verdict)
 *   resources — getActiveResourcesInfo() Timeout+Immediate delta (second reading)
 * `node` is the runtime binary (default: this one). Throws if the child fails:
 * a probe that could not run has not shown the module is clean.
 */
export function probeImportTimers(modPath, { node = process.execPath, cwd = process.cwd(), settleMs = 20 } = {}) {
  const url = pathToFileURL(modPath).href
  const script = `${PRELOAD}
const count = () => process.getActiveResourcesInfo().filter(x => x === 'Timeout' || x === 'Immediate').length
const before = count(); const startSeq = globalThis.__probeLive.size
await import(${JSON.stringify(url)})
await new Promise(r => setTimeout(r, ${Number(settleMs)}))
const mine = [...globalThis.__probeLive.values()].filter(t => t.h !== undefined)
// the settle timer above fired and removed itself; anything left was the module's
const kinds = mine.map(t => t.kind)
console.log(JSON.stringify({ created: kinds.length - startSeq, kinds, resources: Math.max(0, count() - before) }))
process.exit(0)`
  const out = execFileSync(node, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8', timeout: 30_000 })
  return JSON.parse(out.trim().split('\n').pop())
}
