// agent/services/bar-form-research-worker.js — the bar-form research job's
// CPU half in a worker thread (Claude · № 13,095 11-Oct, plan step 8): pull
// one segment at a time, build the bar forms, replay the strategies, post
// the cells back. No database here; the main thread persists the result.
// `workerData.abortFlag` is an Int32Array over a SharedArrayBuffer the main
// thread sets to 1 on abort; the loop polls it between segments.
import { parentPort, workerData } from 'node:worker_threads'
import { processSegments, evaluateSeries } from './bar-form-research-core.js'
import { pullSegment } from './tick-segments.js'

const flag = workerData.abortFlag ? new Int32Array(workerData.abortFlag) : null
const abort = () => !!flag && Atomics.load(flag, 0) === 1

try {
  const { sides = [], secret = '', timeoutMs = 20_000, ...stream } = workerData.stream
  // One pull per segment, each side in turn until one serves it.
  const pull = async (name, destDir) => {
    let last = null
    for (const side of sides) { const r = await pullSegment({ base: side.base, secret, timeoutMs }, name, destDir); if (r.ok) return r; last = r.error || 'pull failed' }
    return { ok: false, error: last || 'no side reachable' }
  }
  const { series, manifest, crossCheckBars } = await processSegments({ ...stream, pull, abort, onProgress: p => parentPort.postMessage({ progress: p }) })
  // limits ride in `stream.limits`; the loop above records observed values and the first breach in the manifest.
  const { cells, summary } = evaluateSeries({ series, ...workerData.evaluate })
  parentPort.postMessage({ ok: true, manifest, cells, summary, crossCheckBars })
} catch (err) {
  parentPort.postMessage({ ok: false, error: err?.message || String(err) })
}
